// sheen-util.js — 布マテリアルの光沢色の正規化。依存なし（CPU布=WebGL / GPU布=WebGPU の双方から使う）。
//
// three の sheen は sheenColor を乗算するため、sheenColor が黒だと
// sheen 強度をいくら上げても見た目が変わらない（＝スライダーが効かない）。
// 保存データに '#000000' が入っている個体（JOY_vamp 等）があるので、黒は「未指定」とみなして白へ寄せる。
export function normalizeSheenColor(v) {
  if (v == null) return 0xffffff;
  if (typeof v === 'number') return v === 0 ? 0xffffff : v;
  const s = String(v).trim().toLowerCase();
  return (s === '#000000' || s === '#000' || s === 'black') ? 0xffffff : v;
}
