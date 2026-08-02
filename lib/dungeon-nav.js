// dungeon-nav.js — お屋敷グリッド上の経路探索（純粋関数・three非依存）。
// 壁は「セル境界(エッジ)」に立つので、単純なセル通行判定では抜けてしまう。
// ここでは「セルの通行可否」＋「エッジの遮断」の両方を見る A* を提供する。
// 多層（2階/地下）対応：ノードは (x, z, level)。階段は links で階をまたぐ。
//
//   const nav = buildNav(mansion);
//   const path = findPath(nav, {x,z,level}, {x,z,level});   // → [{x,z,level}, ...]。到達不能なら null

/** mansion(generateEstate の戻り値) から通行データを作る */
export function buildNav(mn) {
  const W = mn.w, D = mn.d;
  const grids = mn.grids || [mn.grid];
  const blocked = new Set();   // 遮断エッジ（"level:x|z"）
  for (const s of mn.shell) {
    if (!s.wall) continue;
    if (s.model === 'doorway') continue;   // 扉は通れる（窓・壁は塞ぐ）
    blocked.add((s.level || 0) + ':' + s.x + '|' + s.z);
  }
  // 階段リンク：入口(基準階) ⇄ 中間 ⇄ 着地(上階)。中間セルは基準階のノードとして扱う
  const links = new Map();       // "level:x,z" → [{x,z,level}]
  const stairCells = new Map();  // "x,z" → stair（傾斜床の判定用）
  const addLink = (a, b) => {
    const k = a.level + ':' + a.x + ',' + a.z;
    if (!links.has(k)) links.set(k, []);
    links.get(k).push(b);
  };
  const midCells = new Set();   // 階段の中間セル＝通常の4方向移動では通らせない（リンク経由のみ）
  for (const st of (mn.stairs || [])) {
    const base = st.base || 0;
    const c0 = { x: st.x, z: st.z, level: base };
    const c1 = { x: st.x + st.dx, z: st.z + st.dz, level: base };
    const c2 = { x: st.x + 2 * st.dx, z: st.z + 2 * st.dz, level: base + 1 };
    stairCells.set(c0.x + ',' + c0.z, st);
    stairCells.set(c1.x + ',' + c1.z, st);
    midCells.add(c1.x + ',' + c1.z);
    addLink(c0, c1); addLink(c1, c0);
    addLink(c1, c2); addLink(c2, c1);
  }
  return { w: W, d: D, levels: grids.length, grids, grid: grids[0], blocked, links, stairCells, midCells };
}

export function passable(nav, x, z, level = 0) {
  if (x < 0 || z < 0 || x >= nav.w || z >= nav.d) return false;
  // 階段の中間セルは「平地の通路」としては通行不可（登坂はリンクで表現。
  // これを許すと1階のつもりのNPCが坂で持ち上がって階違いになり、詰まる）
  if (nav.midCells && nav.midCells.has(x + ',' + z)) return false;
  if (nav.doorSolid && nav.doorSolid.has(x + ',' + z)) return false;   // 閉じた扉（ゲーム側が開閉を管理）
  const g = nav.grids[Math.max(0, Math.min(nav.levels - 1, level))];
  return g[z * nav.w + x] !== 0;
}
/** (x,z) から (x+dx,z+dz) へ同一階で進めるか（セル可否＋間のエッジ） */
export function canStep(nav, x, z, dx, dz, level = 0) {
  const nx = x + dx, nz = z + dz;
  if (!passable(nav, nx, nz, level)) return false;
  return !nav.blocked.has(level + ':' + (x + dx * 0.5) + '|' + (z + dz * 0.5));
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** A*（4方向＋階段リンク。壁はエッジで遮断）。from/to は {x,z,level} セル座標 */
export function findPath(nav, from, to) {
  const W = nav.w, D = nav.d, L = nav.levels;
  const sx = Math.round(from.x), sz = Math.round(from.z), sl = Math.max(0, Math.min(L - 1, from.level || 0));
  const tx = Math.round(to.x), tz = Math.round(to.z), tl = Math.max(0, Math.min(L - 1, to.level || 0));
  // 階段の中間セルに立っている場合も探索は許す（そこからはリンクで出られる）
  const onStair = (x, z) => nav.stairCells && nav.stairCells.has(x + ',' + z);
  if ((!passable(nav, sx, sz, sl) && !onStair(sx, sz)) || (!passable(nav, tx, tz, tl) && !onStair(tx, tz))) return null;
  if (sx === tx && sz === tz && sl === tl) return [{ x: tx, z: tz, level: tl }];

  const N = W * D * L;
  const idx = (x, z, l) => (l * D + z) * W + x;
  const g = new Float32Array(N).fill(Infinity);
  const f = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const open = [];
  const si = idx(sx, sz, sl), ti = idx(tx, tz, tl);
  const h = (i) => {
    const l = (i / (W * D)) | 0, r = i % (W * D), x = r % W, z = (r / W) | 0;
    return Math.abs(x - tx) + Math.abs(z - tz) + Math.abs(l - tl) * 2;
  };
  g[si] = 0; f[si] = h(si); open.push(si);

  let guard = 0;
  while (open.length && guard++ < 400000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === ti) {
      const out = [];
      for (let i = ti; i !== -1; i = prev[i]) {
        const l = (i / (W * D)) | 0, r = i % (W * D);
        out.push({ x: r % W, z: (r / W) | 0, level: l });
      }
      return out.reverse();
    }
    const cl = (cur / (W * D)) | 0, cr = cur % (W * D), cx = cr % W, cz = (cr / W) | 0;
    const push = (ni, cost) => {
      const ng = g[cur] + cost;
      if (ng >= g[ni]) return;
      g[ni] = ng; f[ni] = ng + h(ni); prev[ni] = cur;
      if (!open.includes(ni)) open.push(ni);
    };
    for (const [dx, dz] of DIRS) {
      if (!canStep(nav, cx, cz, dx, dz, cl)) continue;
      push(idx(cx + dx, cz + dz, cl), 1);
    }
    const lk = nav.links.get(cl + ':' + cx + ',' + cz);
    if (lk) for (const n of lk) push(idx(n.x, n.z, n.level), 1);
  }
  return null;
}

/** 2点間に遮蔽が無いか（視線判定）。別の階は見えない。セル格子上を DDA で辿ってエッジ遮断を見る */
export function hasLineOfSight(nav, ax, az, bx, bz, levelA = 0, levelB = levelA) {
  if ((levelA || 0) !== (levelB || 0)) return false;
  const lv = levelA || 0;
  let x = Math.round(ax), z = Math.round(az);
  const tx = Math.round(bx), tz = Math.round(bz);
  let guard = 0;
  while ((x !== tx || z !== tz) && guard++ < 512) {
    const dx = tx - x, dz = tz - z;
    const stepX = Math.abs(dx) >= Math.abs(dz) && dx !== 0;
    const sx = stepX ? Math.sign(dx) : 0, sz = stepX ? 0 : Math.sign(dz);
    if (sx === 0 && sz === 0) break;
    if (!canStep(nav, x, z, sx, sz, lv)) return false;
    x += sx; z += sz;
  }
  return true;
}
