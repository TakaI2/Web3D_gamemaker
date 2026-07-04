// npc-speech.js — NPC のセリフ制御（フレームワーク非依存・素JS）
// 設計: .tmp/design.md §4
//
// 「いま何をしゃべるか」を決め、口パク（lib/lip-sync.js）と行ごとの表情を VRM に適用する。
// ステート滞在中のセリフ（once/loop）と、瞬間イベントの bark（grabbed/thrown/landed）を扱う。
// 表示テキストは hooks 経由で UI（lib/speech-ui.js）へ通知する。
//
// 使い方:
//   const speech = createNpcSpeech(vrm, bundle.character, {
//     onLineStart: (speaker, text, cps) => speechUI.showBottom(speaker, text, cps),
//   });
//   // ステート変化時:  speech.onState('attack')
//   // イベント時:      speech.bark('grabbed')
//   // 毎フレーム:      speech.update(dt)   ← 状態表情を適用した「後」に呼ぶ（viseme/行表情が最後に勝つ）

import { createLipSync } from './lip-sync.js';

const DEFAULT_CPS = 8;
const DEFAULT_INTERVAL_MS = 1500;   // loop 時の行間インターバル
const BARK_COOLDOWN_MS = 1500;      // 同一イベント bark の最小間隔

// 行（line）を正規化する。文字列 or {text, expression?, weight?, holdMs?}。
function normalizeLine(line) {
  if (typeof line === 'string') return { text: line, expression: null, weight: 1, holdMs: 0 };
  if (line && typeof line === 'object') {
    return {
      text: typeof line.text === 'string' ? line.text : '',
      expression: line.expression || null,
      weight: line.weight != null ? line.weight : 1,
      holdMs: line.holdMs || 0,
    };
  }
  return { text: '', expression: null, weight: 1, holdMs: 0 };
}

export function createNpcSpeech(vrm, characterDef, hooks = {}) {
  const lip = createLipSync(vrm);
  const displayName = (characterDef && characterDef.displayName) || '';

  let clockMs = 0;
  let source = null;       // 'state' | 'event' | null
  let curState = null;     // 直近に通知されたステート（bark 後の復帰に使う）
  let queue = [];          // 正規化済みの行配列
  let lineIdx = 0;
  let mode = 'once';       // 'once' | 'loop'
  let intervalMs = DEFAULT_INTERVAL_MS;
  let cps = DEFAULT_CPS;
  let phase = null;        // 'speaking' | 'hold' | 'interval' | null
  let phaseEnd = 0;        // hold/interval の終了時刻（clockMs 基準）
  let activeExprName = null;
  let activeExprWeight = 0;
  const lastBarkAt = {};

  function getStateSpeech(state) {
    const st = characterDef && characterDef.states && characterDef.states[state];
    const sp = st && st.speech;
    return sp && Array.isArray(sp.lines) && sp.lines.length ? sp : null;
  }

  function clearActiveExpr() {
    if (activeExprName) {
      const em = vrm && vrm.expressionManager;
      if (em) { try { em.setValue(activeExprName, 0); } catch { /* 未定義表情は無視 */ } }
      activeExprName = null;
      activeExprWeight = 0;
    }
  }

  function stop() {
    lip.stop();
    clearActiveExpr();
    source = null;
    queue = [];
    phase = null;
  }

  function startLine(i) {
    clearActiveExpr();
    const line = queue[i];
    if (!line) { stop(); return; }
    lip.play(line.text, cps);
    if (line.expression) { activeExprName = line.expression; activeExprWeight = line.weight; }
    phase = 'speaking';
    if (typeof hooks.onLineStart === 'function') hooks.onLineStart(displayName, line.text, cps);
  }

  function startSpeech(src, sp) {
    const lines = sp.lines.map(normalizeLine).filter(l => l.text);
    if (!lines.length) { stop(); return; }
    source = src;
    queue = lines;
    mode = sp.mode === 'loop' ? 'loop' : 'once';
    intervalMs = sp.intervalMs != null ? sp.intervalMs : DEFAULT_INTERVAL_MS;
    cps = sp.charsPerSecond || DEFAULT_CPS;
    lineIdx = 0;
    startLine(0);
  }

  // bark（イベント）終了後にステート発話へ戻す（loop のみ・downed 以外）。
  function resumeState() {
    source = null;
    const sp = getStateSpeech(curState);
    if (curState && curState !== 'downed' && sp && sp.mode === 'loop') {
      startSpeech('state', sp);
    } else {
      stop();
    }
  }

  function advanceLine() {
    if (source === 'event') { resumeState(); return; }
    // source === 'state'
    if (mode === 'once') {
      lineIdx++;
      if (lineIdx < queue.length) startLine(lineIdx);
      else { clearActiveExpr(); source = null; queue = []; phase = null; lip.stop(); }
    } else {
      // loop: インターバル待機 → 次の行（末尾なら先頭へ循環）
      clearActiveExpr();
      lip.stop();
      phase = 'interval';
      phaseEnd = clockMs + intervalMs;
    }
  }

  return {
    get speaking() { return source !== null; },

    // ステート変化時に呼ぶ。speech が無ければ無発話、同一ステート再通知は無視。
    onState(state) {
      if (state === curState && source === 'state') return;   // 継続中の同一ステートは無視
      curState = state;
      if (state === 'downed') { stop(); return; }              // downed はステート発話を抑制
      const sp = getStateSpeech(state);
      if (!sp) { stop(); return; }
      startSpeech('state', sp);
    },

    // イベント bark（grabbed/thrown/landed）。クールダウン内は無視。現発話に割り込む。
    bark(event) {
      const ev = characterDef && characterDef.events && characterDef.events[event];
      if (!ev || !Array.isArray(ev.lines) || !ev.lines.length) return;
      if (clockMs - (lastBarkAt[event] != null ? lastBarkAt[event] : -Infinity) < BARK_COOLDOWN_MS) return;
      lastBarkAt[event] = clockMs;
      const picked = ev.lines[Math.floor(Math.random() * ev.lines.length)];
      startSpeech('event', { mode: 'once', lines: [picked], charsPerSecond: ev.charsPerSecond });
    },

    // 毎フレーム。状態表情を適用した「後」に呼ぶこと（viseme/行表情を最後に上書き）。
    update(dt) {
      clockMs += dt * 1000;
      lip.update(dt * 1000);

      // 行表情を適用（state 表情の上に乗せる）
      if (activeExprName && source) {
        const em = vrm && vrm.expressionManager;
        if (em) { try { em.setValue(activeExprName, activeExprWeight); } catch { /* 未定義表情は無視 */ } }
      }

      if (!source) return;
      if (phase === 'speaking') {
        if (!lip.playing) { phase = 'hold'; phaseEnd = clockMs + (queue[lineIdx] ? queue[lineIdx].holdMs : 0); }
      } else if (phase === 'hold') {
        if (clockMs >= phaseEnd) advanceLine();
      } else if (phase === 'interval') {
        if (clockMs >= phaseEnd) { lineIdx = (lineIdx + 1) % queue.length; startLine(lineIdx); }
      }
    },

    stop,
  };
}
