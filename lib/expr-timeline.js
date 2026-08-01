// expr-timeline.js — VRM表情（ブレンドシェイプ）のタイムライン。純粋関数＋薄い適用ヘルパ。
// ar-vampire のエネミーエディタで編集し、vamp-enemy.json に保存 → ゲーム側で同じ再生をする。
//
// トラック形式（vamp-enemy.json の states.<state>.expr）:
//   { "dur": 2.0, "loop": true, "keys": [ { "t": 0, "v": { "happy": 0.2 } },
//                                         { "t": 1.0, "v": { "happy": 1, "aa": 0.4 } } ] }
//   ・t は秒。keys は時刻昇順（sampleExpr 側でも並べ替える）
//   ・v は「表情名 → 重み(0..1)」。キー間は線形補間、書かれていない表情は 0 に向かう
//
//   const w = sampleExpr(track, tSec);      // → { happy: 0.6, aa: 0.2 }
//   applyExpr(vrm, w, allNames);            // VRM へ適用（登場しない表情は 0 に戻す）

/** キーに登場する表情名をすべて集める */
export function exprNamesOf(track) {
  const set = new Set();
  for (const k of (track?.keys || [])) for (const n of Object.keys(k.v || {})) set.add(n);
  return [...set];
}

/** 時刻 t（秒）での重みを返す。キー間は線形補間。 */
export function sampleExpr(track, t) {
  const keys = (track?.keys || []).slice().sort((a, b) => a.t - b.t);
  if (!keys.length) return {};
  const dur = track.dur || (keys[keys.length - 1].t || 1);
  let tt = t;
  if (track.loop && dur > 0) tt = ((t % dur) + dur) % dur;
  else tt = Math.max(0, Math.min(dur, t));

  if (tt <= keys[0].t) return { ...keys[0].v };
  if (tt >= keys[keys.length - 1].t) {
    // ループ時は最後のキー→最初のキーへ戻す補間（つながりを滑らかに）
    if (track.loop && keys.length > 1) {
      const a = keys[keys.length - 1], b = keys[0];
      const span = Math.max(1e-6, dur - a.t + b.t);
      return lerpV(a.v, b.v, (tt - a.t) / span);
    }
    return { ...keys[keys.length - 1].v };
  }
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= tt) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  return lerpV(a.v, b.v, (tt - a.t) / span);
}

function lerpV(va, vb, u) {
  const out = {};
  for (const n of new Set([...Object.keys(va || {}), ...Object.keys(vb || {})])) {
    const x = va?.[n] ?? 0, y = vb?.[n] ?? 0;
    out[n] = x + (y - x) * u;
  }
  return out;
}

/**
 * VRM へ適用。managed に含まれる表情のうち weights に無いものは 0 にする
 * （前フレームの表情が残り続けないように）。
 */
export function applyExpr(vrm, weights, managed) {
  const em = vrm?.expressionManager;
  if (!em) return;
  const names = managed && managed.length ? managed : Object.keys(weights || {});
  for (const n of names) {
    const w = weights?.[n];
    try { em.setValue(n, Math.max(0, Math.min(1, w ?? 0))); } catch { /* 未対応の表情名は無視 */ }
  }
}

/** VRM が持つ表情名の一覧（エディタのUI用） */
export function listExpressions(vrm) {
  const em = vrm?.expressionManager;
  if (!em) return [];
  const out = [];
  for (const e of (em.expressions || [])) {
    const n = e?.expressionName ?? e?.name;
    if (n) out.push(n);
  }
  return out;
}
