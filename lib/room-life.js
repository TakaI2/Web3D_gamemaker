// lib/room-life.js — 部屋レイアウト上のNPC生活シミュレーション基盤（three非依存）。
// room-editor の生活プレビューとゲーム（在宅NPC）で共用する。
//  - buildLifeData(layout, {tile, sizeOf}): 歩行グリッド(0.5タイル)＋生活スポット＋階段リンク
//  - findPath(life, from, to): レベル間（階段）対応A*。waypoint={x,z,yF}（yF=階の高さ係数0..1）
//  - DAY_SCHEDULE / scheduleAt(hour): 1日の行動表
import { categorize } from './room-gen.js';

const RES = 0.5;   // グリッド解像度（タイル単位）

export const DAY_SCHEDULE = [
  { h: 6.5, spot: 'toilet', action: 'toilet', label: 'トイレ' },
  { h: 6.8, spot: 'kitchen', action: 'cook', label: '朝食づくり' },
  { h: 7.2, spot: 'table', action: 'eat', label: '朝食' },
  { h: 7.8, spot: 'door', action: 'out', label: '出勤（外出中）' },
  { h: 17.8, spot: 'door', action: 'return', label: '帰宅' },
  { h: 18.1, spot: 'kitchen', action: 'cook', label: '夕食づくり' },
  { h: 18.8, spot: 'table', action: 'eat', label: '夕食' },
  { h: 19.6, spot: 'sofa', action: 'sit', label: 'くつろぎ' },
  { h: 22.3, spot: 'bath', action: 'bath', label: '入浴' },
  { h: 23.0, spot: 'bed', action: 'sleep', label: '睡眠' },
];
export function scheduleAt(hour) {
  let cur = DAY_SCHEDULE[DAY_SCHEDULE.length - 1];   // 深夜0時〜最初の予定までは前夜の続き（睡眠）
  for (const e of DAY_SCHEDULE) if (hour >= e.h) cur = e;
  return cur;
}

const catOf = (it) => it.cat || (it.model ? categorize(it.model) : null);

export function buildLifeData(layout, opts = {}) {
  const tile = opts.tile || 1;
  const sizeOf = opts.sizeOf || (() => null);
  // floors未保存の読込データはshellのlevelから導出
  const floors = layout.floors || ((layout.shell || []).some((s) => (s.level || 0) > 0) ? 2 : 1);
  const W = layout.w, D = layout.d;
  const gw = Math.round((W - 1) / RES) + 1;
  const gd = Math.round((D - 1) / RES) + 1;
  const grids = [];
  for (let l = 0; l < floors; l++) grids.push(new Uint8Array(gw * gd).fill(1));
  const idx = (ix, iz) => iz * gw + ix;
  const inG = (ix, iz) => ix >= 0 && iz >= 0 && ix < gw && iz < gd;
  const block = (level, x, z, rx, rz) => {
    const g = grids[level]; if (!g) return;
    const x0 = Math.ceil((x - rx) / RES - 1e-6), x1 = Math.floor((x + rx) / RES + 1e-6);
    const z0 = Math.ceil((z - rz) / RES - 1e-6), z1 = Math.floor((z + rz) / RES + 1e-6);
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) if (inG(ix, iz)) g[idx(ix, iz)] = 0;
  };
  // 内壁（Doorway系モデルは開口＝通行可）。外周壁はグリッド範囲外
  for (const s of layout.shell || []) {
    if (!s.wall || /Doorway/i.test(s.model)) continue;
    const horiz = Math.abs(Math.sin(s.ry || 0)) < 0.5;   // ry 0/π = X方向に伸びる壁
    if (horiz) block(s.level || 0, s.x, s.z, 0.55, 0.3);
    else block(s.level || 0, s.x, s.z, 0.3, 0.55);
  }
  // 家具の占有（stairs/rug は通行可）
  for (const it of layout.items || []) {
    const cat = catOf(it);
    if (cat === 'stairs' || cat === 'rug') continue;
    const s = sizeOf(it);
    if (!s) continue;
    const q = Math.round((it.ry || 0) / (Math.PI / 2)) & 1;
    const hx = (q ? s.z : s.x) / tile / 2, hz = (q ? s.x : s.z) / tile / 2;
    block(it.level || 0, it.x, it.z, Math.max(0.2, hx - 0.05), Math.max(0.2, hz - 0.05));
  }
  // 階段リンク（2階建てのみ）: 南側から昇り、北端で2Fの西隣（踊り場）へ
  let stair = null;
  const st = (layout.items || []).find((i) => catOf(i) === 'stairs' || i.model === 'stairsOpen');
  if (floors === 2 && st) {
    stair = {
      bottom: { x: st.x, z: st.z + 1.4, level: 0 },
      rise: [{ x: st.x, z: st.z + 1.0 }, { x: st.x, z: st.z - 0.4 }],   // この間で yF 0→1
      top: { x: st.x - 1, z: st.z, level: 1 },
    };
  }
  const life = { grids, gw, gd, floors, stair, res: RES, w: W, d: D, tile };
  life.spots = findSpots(layout, sizeOf, tile, life);
  return life;
}

// 生活スポット: 家具カテゴリから「立ち位置＋向き」を決める。無い設備は null
function findSpots(layout, sizeOf, tile, life) {
  const items = layout.items || [];
  const pick = (cats, preferModel) => {
    const hit = items.filter((i) => cats.includes(catOf(i)));
    if (!hit.length) return null;
    if (preferModel) { const p = hit.find((i) => i.model && i.model.startsWith(preferModel)); if (p) return p; }
    return hit[0];
  };
  const front = (it, side) => {   // side: 'front'=+z(正面) / 'right'=+x（ベッド脇）
    const s = sizeOf(it) || { x: tile, z: tile };
    const q = Math.round((it.ry || 0) / (Math.PI / 2)) & 1;
    const half = side === 'right' ? (q ? s.z : s.x) / tile / 2 : (q ? s.x : s.z) / tile / 2;
    const ang = (it.ry || 0) + (side === 'right' ? Math.PI / 2 : 0);
    const dx = Math.sin(ang), dz = Math.cos(ang);
    const p = nearestFree(life, it.level || 0, it.x + dx * (half + 0.45), it.z + dz * (half + 0.45));
    if (!p) return null;
    return { x: p.x, z: p.z, level: it.level || 0, ry: Math.atan2(it.x - p.x, it.z - p.z), item: it };
  };
  const spots = {};
  const bed = pick(['bed']);
  spots.bed = bed ? front(bed, 'right') : null;
  const kit = pick(['kitchenUnit'], 'kitchenStove');
  spots.kitchen = kit ? front(kit, 'front') : null;
  const tbl = pick(['diningTable']);
  spots.table = tbl ? front(tbl, 'front') : null;
  const sofa = pick(['sofa', 'armchair']);
  spots.sofa = sofa ? front(sofa, 'front') : null;
  const bath = pick(['bath']);
  spots.bath = bath ? front(bath, 'front') : null;
  const toilet = pick(['toilet']);
  spots.toilet = toilet ? front(toilet, 'front') : null;
  // 玄関: 1Fの wallDoorwayWide（西壁）。内側に立ち、外(壁側)を向く
  const dw = (layout.shell || []).find((s) => (s.level || 0) === 0 && /DoorwayWide/i.test(s.model || ''));
  if (dw) {
    const inX = dw.x < 0 ? dw.x + 1.3 : dw.x, inZ = dw.z < 0 ? dw.z + 1.3 : dw.z;   // 壁の内側へ
    const p = nearestFree(life, 0, inX, inZ);
    if (p) spots.door = { x: p.x, z: p.z, level: 0, ry: Math.atan2(dw.x - p.x, dw.z - p.z) };
  }
  spots.door = spots.door || null;
  return spots;
}

// 最寄りの歩行可能セル（リング探索）。tile座標を返す
export function nearestFree(life, level, x, z) {
  const g = life.grids[level]; if (!g) return null;
  const cx = Math.round(x / RES), cz = Math.round(z / RES);
  const inG = (ix, iz) => ix >= 0 && iz >= 0 && ix < life.gw && iz < life.gd;
  for (let r = 0; r <= 8; r++) {
    let best = null, bd = Infinity;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // リングのみ
      const ix = cx + dx, iz = cz + dz;
      if (!inG(ix, iz) || !g[iz * life.gw + ix]) continue;
      const d = (ix * RES - x) ** 2 + (iz * RES - z) ** 2;
      if (d < bd) { bd = d; best = { x: ix * RES, z: iz * RES }; }
    }
    if (best) return best;
  }
  return null;
}

// 同一レベル内のA*（8方向・斜めは両直交が空いている時のみ）
function astarGrid(life, level, from, to) {
  const g = life.grids[level]; if (!g) return null;
  const s = nearestFree(life, level, from.x, from.z), e = nearestFree(life, level, to.x, to.z);
  if (!s || !e) return null;
  const gw = life.gw, gd = life.gd;
  const si = Math.round(s.z / RES) * gw + Math.round(s.x / RES);
  const ei = Math.round(e.z / RES) * gw + Math.round(e.x / RES);
  if (si === ei) return [{ x: e.x, z: e.z }];
  const open = [{ i: si, f: 0 }];
  const gScore = new Map([[si, 0]]), came = new Map(), closed = new Set();
  const h = (i) => { const ix = i % gw, iz = (i / gw) | 0, ex = ei % gw, ez = (ei / gw) | 0; return Math.hypot(ix - ex, iz - ez); };
  let guard = 0;
  while (open.length && guard++ < 20000) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;   // グリッドは小さいので線形でOK
    const cur = open.splice(bi, 1)[0].i;
    if (cur === ei) {
      const path = [];
      let c = cur;
      while (c !== undefined) { path.push({ x: (c % gw) * RES, z: ((c / gw) | 0) * RES }); c = came.get(c); }
      return path.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % gw, cz = (cur / gw) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= gw || nz >= gd) continue;
      if (!g[nz * gw + nx]) continue;
      if (dx && dz && (!g[cz * gw + nx] || !g[nz * gw + cx])) continue;   // 角抜け防止
      const ni = nz * gw + nx;
      const ng = gScore.get(cur) + Math.hypot(dx, dz);
      if (ng < (gScore.get(ni) ?? Infinity)) { gScore.set(ni, ng); came.set(ni, cur); open.push({ i: ni, f: ng + h(ni) }); }
    }
  }
  return null;
}

// レベル間対応の経路。waypoint = {x, z, yF}（yF: 0=1F床, 1=2F床。階段区間で補間）
export function findPath(life, from, to) {
  const tag = (arr, yF) => (arr || []).map((p) => ({ x: p.x, z: p.z, yF }));
  if ((from.level || 0) === (to.level || 0)) return tag(astarGrid(life, from.level || 0, from, to), from.level || 0);
  if (!life.stair) return null;
  const st = life.stair, up = (to.level || 0) > (from.level || 0);
  const a = astarGrid(life, from.level || 0, from, up ? st.bottom : st.top);
  const b = astarGrid(life, to.level || 0, up ? st.top : st.bottom, to);
  if (!a || !b) return null;
  const lo = [{ x: st.rise[0].x, z: st.rise[0].z, yF: 0 }], hi = [{ x: st.rise[1].x, z: st.rise[1].z, yF: 1 }];
  const climb = up ? [...lo, ...hi] : [...hi, ...lo];
  return [...tag(a, up ? 0 : 1), ...climb, ...tag(b, up ? 1 : 0)];
}
