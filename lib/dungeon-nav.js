// dungeon-nav.js — お屋敷グリッド上の経路探索（純粋関数・three非依存）。
// 壁は「セル境界(エッジ)」に立つので、単純なセル通行判定では抜けてしまう。
// ここでは「セルの通行可否」＋「エッジの遮断」の両方を見る A* を提供する。
//
//   const nav = buildNav(mansion);
//   const path = findPath(nav, {x,z}, {x,z});   // → [{x,z}, ...] セル座標。到達不能なら null

/** mansion(generateMansion の戻り値) から通行データを作る */
export function buildNav(mn) {
  const W = mn.w, D = mn.d;
  const blocked = new Set();   // 遮断エッジ（中点キー "x|z"）
  for (const s of mn.shell) {
    if (!s.wall) continue;
    if (s.model === 'doorway') continue;   // 扉は通れる（窓・壁は塞ぐ）
    blocked.add(s.x + '|' + s.z);
  }
  return { w: W, d: D, grid: mn.grid, blocked };
}

export function passable(nav, x, z) {
  if (x < 0 || z < 0 || x >= nav.w || z >= nav.d) return false;
  return nav.grid[z * nav.w + x] !== 0;
}
/** (x,z) から (x+dx,z+dz) へ進めるか（セル可否＋間のエッジ） */
export function canStep(nav, x, z, dx, dz) {
  const nx = x + dx, nz = z + dz;
  if (!passable(nav, nx, nz)) return false;
  return !nav.blocked.has((x + dx * 0.5) + '|' + (z + dz * 0.5));
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** A*（4方向。壁はエッジで遮断）。from/to はセル座標 */
export function findPath(nav, from, to) {
  const W = nav.w, D = nav.d;
  const sx = Math.round(from.x), sz = Math.round(from.z);
  const tx = Math.round(to.x), tz = Math.round(to.z);
  if (!passable(nav, sx, sz) || !passable(nav, tx, tz)) return null;
  if (sx === tx && sz === tz) return [{ x: tx, z: tz }];

  const N = W * D;
  const g = new Float32Array(N).fill(Infinity);
  const f = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const open = [];
  const si = sz * W + sx, ti = tz * W + tx;
  const h = (i) => { const x = i % W, z = (i / W) | 0; return Math.abs(x - tx) + Math.abs(z - tz); };
  g[si] = 0; f[si] = h(si); open.push(si);

  let guard = 0;
  while (open.length && guard++ < 200000) {
    // 最小 f を線形探索（格子が小さいので十分速い）
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === ti) {
      const out = [];
      for (let i = ti; i !== -1; i = prev[i]) out.push({ x: i % W, z: (i / W) | 0 });
      return out.reverse();
    }
    const cx = cur % W, cz = (cur / W) | 0;
    for (const [dx, dz] of DIRS) {
      if (!canStep(nav, cx, cz, dx, dz)) continue;
      const ni = (cz + dz) * W + (cx + dx);
      const ng = g[cur] + 1;
      if (ng >= g[ni]) continue;
      g[ni] = ng; f[ni] = ng + h(ni); prev[ni] = cur;
      if (!open.includes(ni)) open.push(ni);
    }
  }
  return null;
}

/** 2点間に遮蔽が無いか（視線判定）。セル格子上を DDA で辿ってエッジ遮断を見る */
export function hasLineOfSight(nav, ax, az, bx, bz) {
  let x = Math.round(ax), z = Math.round(az);
  const tx = Math.round(bx), tz = Math.round(bz);
  let guard = 0;
  while ((x !== tx || z !== tz) && guard++ < 512) {
    const dx = tx - x, dz = tz - z;
    // 残差の大きい軸を優先して1歩進む
    const stepX = Math.abs(dx) >= Math.abs(dz) && dx !== 0;
    const sx = stepX ? Math.sign(dx) : 0, sz = stepX ? 0 : Math.sign(dz);
    if (sx === 0 && sz === 0) break;
    if (!canStep(nav, x, z, sx, sz)) return false;
    x += sx; z += sz;
  }
  return true;
}
