// lib/scenario2d.js — 2D紙芝居シナリオプレイヤ（DOMのみ・3D非依存）
// .story.json の script を順に実行する。対応op:
//   say{actor,lines,cps,face}   … メッセージウィンドウ＋顔グラ（face=表情。2D拡張）
//   bg{color,image}             … 背景（image=scenario2d/bg/…。2D拡張。404時はcolorグラデ）
//   bgm.play{name,loop,volume} / bgm.stop{fade} / se{name,volume}
//   delay{duration(ms)} / wait / fade.in{duration(ms)} / fade.out{duration(ms)}
//   その他のop（actor.show等の3D用）は無視して先へ進む＝3D opと同居可能
// 操作: クリック/Space/Enter=送り（表示中は全文表示）、Esc=シナリオごとスキップ
// 話者マスタ: story.actors（[{id,name,color}]）→ 無ければ opts.actors（talks.json形式 {id:{name,color}}）
export function createScenario2D(opts = {}) {
  const basePath = opts.basePath || '../scenario2d';
  const soundPath = opts.soundPath || '../sound';
  const FACE_PX = 96, TYPE_CPS_DEF = 18;

  let els = null, bgm = null;
  const st = { active: false, story: null, idx: 0, onEnd: null, mode: null, line: null, lineQ: [], shown: 0, cps: TYPE_CPS_DEF, fadeT: 0, fadeDur: 0, fadeDir: 0, delayT: 0 };

  function actorOf(id) {
    const list = st.story && Array.isArray(st.story.actors) ? st.story.actors : [];
    const a = list.find((x) => x.id === id);
    if (a && (a.name || a.color)) return { name: a.name || id, color: a.color || '#889' };
    const m = typeof opts.actors === 'function' ? opts.actors() : opts.actors;
    if (m && m[id]) return { name: m[id].name || id, color: m[id].color || '#889' };
    return { name: id, color: '#889' };
  }

  function ensureDom() {
    if (els) return;
    const root = document.createElement('div');
    root.style.cssText = 'position:fixed;inset:0;z-index:45;display:none;background:#000;user-select:none;cursor:pointer;';
    const bg = document.createElement('div');
    bg.style.cssText = 'position:absolute;inset:0;background:linear-gradient(180deg,#0a1024,#1a1030);transition:opacity 0.4s;';
    const bgImg = document.createElement('img');
    bgImg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;';
    const win = document.createElement('div');
    win.style.cssText = 'position:absolute;left:50%;bottom:42px;transform:translateX(-50%);width:min(900px,94vw);'
      + 'background:rgba(8,10,24,0.86);border:1px solid rgba(140,150,255,0.5);border-radius:10px;padding:12px 16px;'
      + 'box-shadow:0 4px 20px rgba(0,0,0,0.6);display:none;gap:14px;align-items:center;';
    const face = document.createElement('div');
    face.style.cssText = `width:${FACE_PX}px;height:${FACE_PX}px;flex:0 0 ${FACE_PX}px;border-radius:8px;overflow:hidden;position:relative;background:#223;`;
    const faceFb = document.createElement('div');
    faceFb.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:900 46px Meiryo,sans-serif;color:#fff;';
    const faceImg = document.createElement('img');
    faceImg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;';
    face.appendChild(faceFb); face.appendChild(faceImg);
    const body = document.createElement('div'); body.style.cssText = 'flex:1;min-width:0;';
    const name = document.createElement('div'); name.style.cssText = 'font:700 15px Meiryo,sans-serif;margin-bottom:5px;';
    const text = document.createElement('div'); text.style.cssText = 'font:17px/1.7 Meiryo,sans-serif;color:#eef;min-height:3.4em;white-space:pre-wrap;';
    const cue = document.createElement('div'); cue.style.cssText = 'position:absolute;right:14px;bottom:8px;color:#9ab;font:12px Meiryo,sans-serif;opacity:0;transition:opacity 0.3s;';
    cue.textContent = '▼';
    body.appendChild(name); body.appendChild(text);
    win.appendChild(face); win.appendChild(body); win.appendChild(cue);
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;right:14px;top:10px;color:#778;font:12px Meiryo,sans-serif;';
    hint.textContent = 'クリック: 次へ ／ Esc: スキップ';
    const fade = document.createElement('div');
    fade.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;';
    root.appendChild(bg); root.appendChild(bgImg); root.appendChild(win); root.appendChild(hint); root.appendChild(fade);
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { e.stopPropagation(); advance(); });
    window.addEventListener('keydown', (e) => {
      if (!st.active) return;
      if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); advance(); }
      else if (e.code === 'Escape') skip();
    });
    els = { root, bg, bgImg, win, faceFb, faceImg, name, text, cue, fade };
  }

  function play(story, o = {}) {
    ensureDom();
    st.active = true; st.story = story; st.idx = 0; st.onEnd = o.onEnd || null;
    st.line = null; st.lineQ = []; st.mode = null; st.fadeDir = 0;
    els.root.style.display = 'block';
    els.win.style.display = 'none';
    els.bgImg.style.display = 'none';
    els.fade.style.opacity = '0';
    try { document.exitPointerLock(); } catch { /* noop */ }
    step();
  }

  function finish() {
    st.active = false;
    if (els) els.root.style.display = 'none';
    stopBgm(400);
    const cb = st.onEnd; st.onEnd = null;
    if (cb) cb();
  }
  function skip() { if (st.active) finish(); }

  function stopBgm(fadeMs) {
    const a = bgm; bgm = null;
    if (!a) return;
    if (!fadeMs) { a.pause(); return; }
    const v0 = a.volume, t0 = performance.now();
    const iv = setInterval(() => {
      const k = 1 - (performance.now() - t0) / fadeMs;
      if (k <= 0) { a.pause(); clearInterval(iv); } else a.volume = v0 * k;
    }, 50);
  }

  function showLine(actorId, face, line, cps) {
    const a = actorOf(actorId);
    els.win.style.display = 'flex';
    els.name.textContent = a.name; els.name.style.color = a.color;
    els.faceFb.textContent = (a.name || '?').slice(0, 1);
    els.faceFb.style.background = a.color;
    els.faceImg.style.display = 'none';
    els.faceImg.onload = () => { els.faceImg.style.display = ''; };
    els.faceImg.onerror = () => { els.faceImg.style.display = 'none'; };   // 仮画像（イニシャル）のまま
    els.faceImg.src = basePath + '/face/' + actorId + '/' + (face || 'normal') + '.png';
    st.line = line; st.shown = 0; st.cps = cps || TYPE_CPS_DEF;
    els.text.textContent = ''; els.cue.style.opacity = '0';
    st.mode = 'typing';
  }

  function step() {   // 次のblocking opまで実行
    while (st.active) {
      const sc = st.story.script || [];
      if (st.lineQ.length) { const q = st.lineQ.shift(); showLine(q.actor, q.face, q.text, q.cps); return; }
      if (st.idx >= sc.length) { finish(); return; }
      const op = sc[st.idx++];
      const kind = op.op;
      if (kind === 'say') {
        const lines = Array.isArray(op.lines) ? op.lines : [String(op.lines || '')];
        for (const t of lines) st.lineQ.push({ actor: op.actor, face: op.face, text: t, cps: op.cps ? op.cps * 2.2 : 0 });   // エディタcps(遅め)→2D体感に補正
      } else if (kind === 'bg') {
        if (op.color) els.bg.style.background = /^#/.test(op.color) ? `linear-gradient(180deg,${op.color},#000)` : op.color;
        els.bgImg.style.display = 'none';
        if (op.image) {
          els.bgImg.onload = () => { els.bgImg.style.display = ''; };
          els.bgImg.onerror = () => { els.bgImg.style.display = 'none'; };   // 仮=グラデ背景のまま
          els.bgImg.src = basePath + '/bg/' + op.image;
        }
      } else if (kind === 'bgm.play') {
        stopBgm(0);
        try { bgm = new Audio(soundPath + '/' + op.name); bgm.loop = op.loop !== false; bgm.volume = op.volume ?? 0.6; bgm.play().catch(() => { /* 自動再生制限 */ }); } catch { /* noop */ }
      } else if (kind === 'bgm.stop') {
        stopBgm(op.fade ?? 500);
      } else if (kind === 'se') {
        try { const a = new Audio(soundPath + '/' + op.name); a.volume = op.volume ?? 1; a.play().catch(() => { /* noop */ }); } catch { /* noop */ }
      } else if (kind === 'delay') {
        st.delayT = (op.duration ?? 500) / 1000; st.mode = 'delay'; return;
      } else if (kind === 'wait') {
        els.cue.style.opacity = '1'; st.mode = 'wait'; return;
      } else if (kind === 'fade.in' || kind === 'fade.out') {
        st.fadeDur = Math.max(0.01, (op.duration ?? 500) / 1000);
        st.fadeT = 0; st.fadeDir = kind === 'fade.in' ? -1 : 1;   // in=黒→透明
        els.fade.style.opacity = kind === 'fade.in' ? '1' : '0';
        st.mode = 'fade'; return;
      }
      // 未対応op（3D用）は読み飛ばし
    }
  }

  function advance() {   // クリック送り
    if (!st.active) return;
    if (st.mode === 'typing') { st.shown = st.line.length; els.text.textContent = st.line; st.mode = 'lineWait'; els.cue.style.opacity = '1'; }
    else if (st.mode === 'lineWait' || st.mode === 'wait') { st.mode = null; step(); }
  }

  function update(dt) {
    if (!st.active) return;
    if (st.mode === 'typing') {
      st.shown = Math.min(st.line.length, st.shown + st.cps * dt);
      els.text.textContent = st.line.slice(0, Math.floor(st.shown));
      if (st.shown >= st.line.length) { st.mode = 'lineWait'; els.cue.style.opacity = '1'; }
    } else if (st.mode === 'delay') {
      st.delayT -= dt;
      if (st.delayT <= 0) { st.mode = null; step(); }
    } else if (st.mode === 'fade') {
      st.fadeT += dt;
      const k = Math.min(1, st.fadeT / st.fadeDur);
      els.fade.style.opacity = String(st.fadeDir > 0 ? k : 1 - k);
      if (k >= 1) { st.mode = null; step(); }
    }
  }

  return { play, update, skip, get active() { return st.active; } };
}
