// カーブ（スカラーチャンネル）の cubic Hermite 補間。グラフエディタのベジェ・タンジェント編集、
// 再生(seekToFrame)、書き出しベイクで共有する純粋関数群。値の単位はチャンネル依存（度/m/0..1）。

/** 解決済みキー。inT/outT は「値/フレーム」のスロープ（ハンドル長は区間長で自動）。 */
export type CurveKey = { f: number; v: number; inT: number; outT: number };

/** Catmull-Rom 中心差分スロープ（値/フレーム）。端は片側差分。 */
export function autoTangent(vPrev: number, vNext: number, fPrev: number, fNext: number): number {
  const df = fNext - fPrev;
  if (df <= 0) return 0;
  return (vNext - vPrev) / df;
}

/** {f,v} の並び（フレーム昇順）から、各キーの自動タンジェント付き CurveKey を作る。 */
export function resolveAutoKeys(points: { f: number; v: number }[]): CurveKey[] {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return [{ f: points[0].f, v: points[0].v, inT: 0, outT: 0 }];
  const out: CurveKey[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let t: number;
    if (i === 0) t = (points[1].v - p.v) / Math.max(1e-6, points[1].f - p.f);
    else if (i === n - 1) t = (p.v - points[i - 1].v) / Math.max(1e-6, p.f - points[i - 1].f);
    else t = autoTangent(points[i - 1].v, points[i + 1].v, points[i - 1].f, points[i + 1].f);
    out.push({ f: p.f, v: p.v, inT: t, outT: t });
  }
  return out;
}

/** フレーム昇順の CurveKey 配列から frame の値を Hermite 補間で求める。範囲外はクランプ。 */
export function sampleCurve(keys: CurveKey[], frame: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1 || frame <= keys[0].f) return keys[0].v;
  if (frame >= keys[n - 1].f) return keys[n - 1].v;
  // 区間を二分探索
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].f <= frame) lo = mid; else hi = mid;
  }
  const k0 = keys[lo], k1 = keys[hi];
  const dt = k1.f - k0.f;
  if (dt <= 0) return k1.v;
  const t = (frame - k0.f) / dt;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  // タンジェントは値/フレーム → 値/単位t へ（×dt）
  const m0 = k0.outT * dt;
  const m1 = k1.inT * dt;
  return h00 * k0.v + h10 * m0 + h01 * k1.v + h11 * m1;
}
