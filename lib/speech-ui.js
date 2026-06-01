// speech-ui.js — セリフ表示の DOM オーバーレイ（フレームワーク非依存・素JS）
// 設計: .tmp/design.md §6
//
// ・画面下部のセリフウィンドウ（話者名＋タイピング送り、複数NPCはキュー共有）
// ・各NPC頭上の吹き出し（短文・追従）
// 3D描画とは独立。投影（ワールド→画面）は呼び出し側が getScreenPos で供給する
// （このモジュールは Three.js に依存しない）。
//
// 使い方:
//   const ui = createSpeechUI();
//   ui.showBottom('lily', 'こんにちは', 8);     // 下部ウィンドウへ
//   ui.setBubble(npc, 'やぁ', 8);               // 頭上吹き出し
//   // 毎フレーム:
//   ui.update(dt, (npc) => ({ x, y, visible })); // 画面座標(px)を返すコールバック

const BOTTOM_HOLD_MS = 1200;   // 下部ウィンドウ：送り完了後の保持時間
const BUBBLE_HOLD_MS = 1200;   // 吹き出し：送り完了後の保持時間
const FADE_MS = 300;           // フェードアウト時間

const CSS = `
.sc-dialog{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
  width:min(720px,80vw);background:rgba(10,12,20,0.72);border:1px solid rgba(255,255,255,0.18);
  border-radius:12px;padding:12px 18px;color:#eee;font-family:system-ui,sans-serif;
  z-index:3000;opacity:0;transition:opacity ${FADE_MS}ms;pointer-events:none;}
.sc-dialog.show{opacity:1;}
.sc-dialog .name{display:block;font-size:13px;font-weight:700;color:#9fd0ff;margin-bottom:4px;}
.sc-dialog .msg{display:block;font-size:16px;line-height:1.5;white-space:pre-wrap;min-height:1.5em;}
.sc-bubble{position:fixed;transform:translate(-50%,-100%);max-width:200px;
  background:rgba(20,22,32,0.85);border:1px solid rgba(255,255,255,0.22);border-radius:10px;
  padding:5px 10px;color:#fff;font-family:system-ui,sans-serif;font-size:13px;line-height:1.3;
  z-index:2900;opacity:0;transition:opacity 150ms;pointer-events:none;white-space:pre-wrap;text-align:center;}
.sc-bubble.show{opacity:1;}
.sc-bubble::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);
  border:6px solid transparent;border-top-color:rgba(20,22,32,0.85);}
`;

function injectCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('sc-speech-ui-css')) return;
  const s = document.createElement('style');
  s.id = 'sc-speech-ui-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function createSpeechUI(opts = {}) {
  const dom = opts.dom || (typeof document !== 'undefined' ? document.body : null);
  if (!dom) return stub();
  injectCss();

  // ── 下部ウィンドウ ──
  const box = document.createElement('div');
  box.className = 'sc-dialog';
  box.innerHTML = '<span class="name"></span><span class="msg"></span>';
  dom.appendChild(box);
  const nameEl = box.querySelector('.name');
  const msgEl = box.querySelector('.msg');

  const queue = [];
  let cur = null;          // { speaker, text, interval }
  let elapsed = 0;         // 現在行の経過 ms
  let phase = 'idle';      // 'idle' | 'typing' | 'hold' | 'fade'

  function nextBottom() {
    cur = queue.shift() || null;
    elapsed = 0;
    if (!cur) { phase = 'idle'; box.classList.remove('show'); return; }
    nameEl.textContent = cur.speaker || '';
    msgEl.textContent = '';
    box.classList.add('show');
    phase = 'typing';
  }

  function updateBottom(dtMs) {
    if (phase === 'idle') { if (queue.length) nextBottom(); return; }
    elapsed += dtMs;
    if (phase === 'typing') {
      const n = Math.floor(elapsed / cur.interval);
      const full = cur.text.length;
      msgEl.textContent = cur.text.slice(0, Math.min(n, full));
      if (n >= full) { phase = 'hold'; elapsed = 0; }
    } else if (phase === 'hold') {
      // 次が待っていれば早めに送る
      if (queue.length || elapsed >= BOTTOM_HOLD_MS) { phase = 'fade'; elapsed = 0; box.classList.remove('show'); }
    } else if (phase === 'fade') {
      if (elapsed >= FADE_MS) nextBottom();
    }
  }

  // ── 頭上吹き出し ──
  const bubbles = new Map();   // npc -> { el, ttl }

  function setBubble(npc, text, cps = 8) {
    let b = bubbles.get(npc);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'sc-bubble';
      dom.appendChild(el);
      b = { el, ttl: 0 };
      bubbles.set(npc, b);
    }
    b.el.textContent = text;
    b.ttl = (text.length / Math.max(1, cps)) * 1000 + BUBBLE_HOLD_MS;
    b.el.classList.add('show');
  }

  function clearBubble(npc) {
    const b = bubbles.get(npc);
    if (b) { b.ttl = 0; b.el.classList.remove('show'); }
  }

  function updateBubbles(dtMs, getScreenPos) {
    for (const [npc, b] of bubbles) {
      if (b.ttl > 0) {
        b.ttl -= dtMs;
        if (b.ttl <= 0) b.el.classList.remove('show');
      }
      const pos = typeof getScreenPos === 'function' ? getScreenPos(npc) : null;
      if (b.ttl > 0 && pos && pos.visible) {
        b.el.style.display = '';
        b.el.style.left = pos.x + 'px';
        b.el.style.top = pos.y + 'px';
      } else {
        b.el.style.display = 'none';
      }
    }
  }

  return {
    showBottom(speaker, text, cps = 8) {
      if (!text) return;
      queue.push({ speaker, text, interval: 1000 / Math.max(1, cps) });
      if (phase === 'idle') nextBottom();
    },
    setBubble,
    clearBubble,
    update(dt, getScreenPos) {
      const dtMs = dt * 1000;
      updateBottom(dtMs);
      updateBubbles(dtMs, getScreenPos);
    },
    dispose() {
      box.remove();
      for (const [, b] of bubbles) b.el.remove();
      bubbles.clear();
    },
  };
}

// document 非対応環境（保険）
function stub() {
  return { showBottom() {}, setBubble() {}, clearBubble() {}, update() {}, dispose() {} };
}
