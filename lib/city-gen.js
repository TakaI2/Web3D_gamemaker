// city-gen.js — プロシージャル都市生成の“純ロジック”（THREE非依存・決定的）。
// スプライン(道路/線路) と ゾーン/シード から、グリッドにラスタライズした道路タイル配置・
// 沿道の建物配置・線路のボックスセグメントを算出し、チャンク単位のベイク済みデータ(items[])を返す。
// エディタ(WebGL) と ランタイム(WebGPU) の両方がこのモジュールで“同じ結果”を生成できる（デュアルTHREE回避のためTHREE不使用）。
//
// 座標系: world(col,row) の中心 = origin + ((col+0.5)*cell, 0, (row+0.5)*cell)。ry はラジアン。
// 方向ビット: N=1(row-1,-Z) / E=2(col+1,+X) / S=4(row+1,+Z) / W=8(col-1,-X)。

// ── 決定的乱数（mulberry32）＋セルハッシュ ──
export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t += 0x6D2B79F5; t = t >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashCell(seed, col, row) {
  let h = (seed >>> 0) ^ Math.imul(col | 0, 0x9E3779B1) ^ Math.imul(row | 0, 0x85EBCA77);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE3D);
  return (h ^ (h >>> 16)) >>> 0;
}

// ── Catmull-Rom スプライン（一様・純math）。points=[[x,z],...] → 密なポリライン[{x,z}] ──
export function sampleSpline(points, closed = false, segSamples = 12) {
  const p = points.map((q) => ({ x: q[0], z: q[1] }));
  if (p.length < 2) return p.slice();
  const pts = p.slice();
  const get = (i) => {
    if (closed) return pts[(i % pts.length + pts.length) % pts.length];
    return pts[Math.max(0, Math.min(pts.length - 1, i))];
  };
  const out = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < segSamples; s++) {
      const t = s / segSamples, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  if (!closed) out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

// 弧長で等間隔リサンプル（接線付き）。poly=[{x,z}] → [{x,z,tx,tz}] （step 間隔）
export function resampleByStep(poly, step) {
  if (poly.length < 2) return poly.map((q) => ({ x: q.x, z: q.z, tx: 1, tz: 0 }));
  const out = [];
  let acc = 0, next = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / segLen, tz = dz / segLen;
    while (next <= acc + segLen) {
      const u = (next - acc) / segLen;
      out.push({ x: a.x + dx * u, z: a.z + dz * u, tx, tz });
      next += step;
    }
    acc += segLen;
  }
  const last = poly[poly.length - 1], prev = poly[poly.length - 2];
  const ldx = last.x - prev.x, ldz = last.z - prev.z, ll = Math.hypot(ldx, ldz) || 1;
  out.push({ x: last.x, z: last.z, tx: ldx / ll, tz: ldz / ll });
  return out;
}

// ── グリッド座標変換 ──
export function cellCenter(world, col, row) {
  return { x: world.origin[0] + (col + 0.5) * world.cell, z: world.origin[2] + (row + 0.5) * world.cell };
}
export function worldToCell(world, x, z) {
  return { col: Math.floor((x - world.origin[0]) / world.cell), row: Math.floor((z - world.origin[2]) / world.cell) };
}
function inGrid(world, col, row) { return col >= 0 && row >= 0 && col < world.grid.cols && row < world.grid.rows; }

// ── 道路タイルの向き（ビットマスク回転）──
// 既定接続マスク（タイルの素の向きで繋がっている辺）。実アセットの向きに合わせて微調整可。
const TILE_DEF = { straight: 5 /*N|S*/, bend: 3 /*N|E*/, tee: 7 /*N|E|S*/, cross: 15, end: 4 /*S*/ };
function rotMaskCW(m) { return ((m << 1) | (m >> 3)) & 15; }   // N→E→S→W（時計回り90°）
function rotToMatch(def, target) { let m = def; for (let k = 0; k < 4; k++) { if (m === target) return k; m = rotMaskCW(m); } return 0; }
function popcount(m) { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; }
// bitmask → { type, k(回転ステップ) }
function tileForMask(mask) {
  const c = popcount(mask);
  if (c >= 4) return { type: 'cross', k: 0 };
  if (c === 3) return { type: 'tee', k: rotToMatch(TILE_DEF.tee, mask) };
  if (c === 2) {
    if (mask === 5 || mask === 10) return { type: 'straight', k: rotToMatch(TILE_DEF.straight, mask) };
    return { type: 'bend', k: rotToMatch(TILE_DEF.bend, mask) };
  }
  if (c === 1) return { type: 'end', k: rotToMatch(TILE_DEF.end, mask) };
  return { type: 'straight', k: 0 };   // 孤立点は直線扱い
}

const DIRS = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];   // [dc,dr,bit] N,E,S,W

// ── 道路ラスタライズ: 全 road スプライン → 道路セル集合 → タイル種別/ry を確定 ──
// 返り値: { roadSet:Set('c_r'), items:[{model,x,y,z,ry,scale,kind:'road',col?}] }
export function rasterizeRoads(splines, world, ctx) {
  const rySign = ctx.rySign ?? -1;   // 回転方向（見た目が反転していたら +1 に）
  const roadSet = new Set();
  const step = world.cell * 0.5;
  for (const sp of splines) {
    if (sp.kind !== 'road' || !sp.points || sp.points.length < 2) continue;
    const poly = sampleSpline(sp.points, !!sp.closed, 12);
    const rs = resampleByStep(poly, step);
    for (const s of rs) {
      const { col, row } = worldToCell(world, s.x, s.z);
      if (inGrid(world, col, row)) roadSet.add(col + '_' + row);
    }
  }
  const items = [];
  for (const key of roadSet) {
    const [col, row] = key.split('_').map(Number);
    let mask = 0;
    for (const [dc, dr, bit] of DIRS) if (roadSet.has((col + dc) + '_' + (row + dr))) mask |= bit;
    const { type, k } = tileForMask(mask);
    const model = ctx.tileset[type] || ctx.tileset.straight;
    const c = cellCenter(world, col, row);
    items.push({ model, x: c.x, y: 0, z: c.z, ry: k * (Math.PI / 2) * rySign, scale: ctx.tileScale || 1, kind: 'road' });
  }
  return { roadSet, items };
}

// ── 沿道の建物配置（Phase1: 住宅キットを道路隣接セルへ、道路向きで） ──
// ctx.buildingKit:[modelPath], ctx.footprint(model)->{x,y,z}(素サイズ), ctx.buildingScale(model)->scalar
export function placeBuildings(roadSet, world, seed, params, ctx) {
  const items = [];
  const kit = ctx.buildingKit || [];
  if (!kit.length) return items;
  const spacing = Math.max(1, params.suburbSpacing || 2);
  const setback = params.suburbSetback ?? 0.15;
  const used = new Set();   // 建物占有セル
  for (const key of roadSet) {
    const [rc, rr] = key.split('_').map(Number);
    for (const [dc, dr] of DIRS) {
      const bc = rc + dc, br = rr + dr;
      if (!inGrid(world, bc, br)) continue;
      const bkey = bc + '_' + br;
      if (roadSet.has(bkey) || used.has(bkey)) continue;
      // 間隔（frontage に沿って spacing 間隔で間引く。決定的）
      const rnd = mulberry32(hashCell(seed, bc, br));
      if (((bc + br) % spacing) !== 0) continue;
      if (rnd() < 0.15) continue;   // まばらに空き地
      used.add(bkey);
      const model = kit[Math.floor(rnd() * kit.length)] || kit[0];
      const fp = (ctx.footprint && ctx.footprint(model)) || { x: 1, y: 1, z: 1 };
      const scale = (ctx.buildingScale && ctx.buildingScale(model)) || 1;
      const cc = cellCenter(world, bc, br);
      // 道路方向（建物→道路）へ正面(+Z)を向ける。setback で道路側へ少し寄せる。
      const ry = Math.atan2(-dc, -dr);   // 道路は (-dc,-dr) 方向（建物から見て）
      const push = (0.5 - setback) * world.cell;
      const x = cc.x + (-dc) * push, z = cc.z + (-dr) * push;
      const col = { hx: fp.x * scale / 2, hy: fp.y * scale / 2, hz: fp.z * scale / 2, walkTop: true };
      items.push({ model, x, y: 0, z, ry, scale, kind: 'building', col });
    }
  }
  return items;
}

// ── 線路（ボックスポリゴン。実アセット未用意のため手続き生成） ──
// rail スプライン → 連続セグメントのボックス [{x,y,z,ry,len,width,height,col}]。app が BoxGeometry で描画。
export function buildRailSegments(splines, world, opts = {}) {
  const width = opts.width ?? world.cell * 0.7;
  const height = opts.height ?? 0.35;
  const step = opts.step ?? world.cell;
  const segs = [];
  for (const sp of splines) {
    if (sp.kind !== 'rail' || !sp.points || sp.points.length < 2) continue;
    const poly = sampleSpline(sp.points, !!sp.closed, 14);
    const rs = resampleByStep(poly, step);
    for (let i = 0; i < rs.length - 1; i++) {
      const a = rs[i], b = rs[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      const ry = Math.atan2(dx, dz);   // セグメントの向き（長さ方向=+Z 基準）
      segs.push({ x: cx, y: 0, z: cz, ry, len: len + 0.02, width, height,
        col: { hx: width / 2, hy: height / 2, hz: (len + 0.02) / 2, walkTop: true } });
    }
  }
  return segs;
}

// ── チャンク割当（items を chunkCells 単位でまとめる） ──
export function assignChunks(items, world) {
  const cc = world.chunkCells || 16;
  const map = new Map();
  for (const it of items) {
    const { col, row } = worldToCell(world, it.x, it.z);
    const ck = Math.floor(col / cc), cr = Math.floor(row / cc);
    const id = ck + '_' + cr;
    let ch = map.get(id);
    if (!ch) {
      const minX = world.origin[0] + ck * cc * world.cell, minZ = world.origin[2] + cr * cc * world.cell;
      ch = { id, cell: [ck, cr], bounds: [minX, minZ, minX + cc * world.cell, minZ + cc * world.cell], items: [] };
      map.set(id, ch);
    }
    ch.items.push(it);
  }
  return [...map.values()];
}

// ── 総合生成: authored → { chunks, rails } ──
export function generate(authored, world, ctx) {
  const seed = (authored.seed ?? 1337) >>> 0;
  const splines = authored.splines || [];
  const { roadSet, items: roadItems } = rasterizeRoads(splines, world, ctx);
  const buildingItems = placeBuildings(roadSet, world, seed, authored.params || {}, ctx);
  const rails = buildRailSegments(splines, world, ctx.rail || {});
  const chunks = assignChunks(roadItems.concat(buildingItems), world);
  return { chunks, rails };
}
