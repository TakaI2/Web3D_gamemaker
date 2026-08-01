// dungeon-gen.js — 欧州のお屋敷（マナーハウス）レイアウト生成。純粋関数・three非依存。
//
// 構成：
//   ・外周を「大回廊」(既定6m=3セル)がぐるりと取り巻く
//   ・回廊の外側の壁には等間隔の窓、内側の壁には等間隔の部屋入口が並ぶ
//   ・内側ブロックは等間隔の部屋＋脇廊下(既定4m=2セル)。中央は広間
//   ・回廊の柱に燭台、扉と扉の間の壁に絵画（額縁つき）
//
//   const mn = generateMansion({ w: 40, d: 34, seed: 1 });
//   mn.grid[z*w+x]  0=壁体 1=部屋 2=脇廊下 3=大回廊 4=広間
//   mn.shell        [{model:'floor'|'wall'|'doorway'|'window', x,z,ry, wall?, ceil?, tall?}]
//   mn.items        [{model:'pillar'|'lantern'|'painting', x,z,ry, cat, y?}]
//   mn.spawn/goal   {x,z}

import { generateRoom } from './room-gen.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SOLID = 0, ROOM = 1, CORR = 2, GALLERY = 3, HALL = 4;
const WALKABLE = (v) => v !== SOLID;

// 北/東/南/西。ry は room-gen と同じ「壁の長辺がX＝ry0（北壁）」規約
const SIDE = [
  { dx: 0, dz: -1, ry: 0 },
  { dx: 1, dz: 0, ry: -Math.PI / 2 },
  { dx: 0, dz: 1, ry: Math.PI },
  { dx: -1, dz: 0, ry: Math.PI / 2 },
];

export function generateMansion(opts = {}) {
  const G = opts.galleryW ?? 3;        // 大回廊の幅（セル）＝6m
  const CW = opts.corridorW ?? 2;      // 脇廊下の幅＝4m
  const RW = opts.roomW ?? 6;          // 部屋の一辺（セル）
  const winStep = opts.windowStep ?? 3;
  const rng = mulberry32((((opts.seed ?? 1) * 2654435761) >>> 0));

  // 内側ブロックが「部屋 RW ＋ 廊下 CW」の繰り返しで割り切れるようサイズを決める
  const nx = Math.max(2, opts.roomsX ?? 3), nz = Math.max(2, opts.roomsZ ?? 3);
  const innerW = nx * RW + (nx - 1) * CW;
  const innerD = nz * RW + (nz - 1) * CW;
  const W = innerW + G * 2 + 2;   // +2 = 内外の壁ぶんの余白セル
  const D = innerD + G * 2 + 2;

  const grid = new Uint8Array(W * D);
  const at = (x, z) => (x < 0 || z < 0 || x >= W || z >= D) ? SOLID : grid[z * W + x];
  const set = (x, z, v) => { if (x >= 0 && z >= 0 && x < W && z < D) grid[z * W + x] = v; };

  // ── 1. 大回廊（外周リング）。外壁1セル内側から G セルぶん ──
  for (let z = 1; z < D - 1; z++) for (let x = 1; x < W - 1; x++) {
    const inRing = (x < 1 + G) || (x >= W - 1 - G) || (z < 1 + G) || (z >= D - 1 - G);
    if (inRing) set(x, z, GALLERY);
  }

  // ── 2. 内側ブロック：等間隔の部屋＋脇廊下 ──
  const ix0 = 1 + G + 1, iz0 = 1 + G + 1;   // 内側ブロックの左上（回廊と部屋の間に壁1セル）
  const rooms = [];
  for (let rz = 0; rz < nz; rz++) for (let rx = 0; rx < nx; rx++) {
    const x0 = ix0 + rx * (RW + CW), z0 = iz0 + rz * (RW + CW);
    const isHall = (nx >= 3 && nz >= 3 && rx === (nx >> 1) && rz === (nz >> 1));   // 中央は広間
    const type = isHall ? HALL : ROOM;
    for (let z = z0; z < z0 + RW; z++) for (let x = x0; x < x0 + RW; x++) set(x, z, type);
    rooms.push({ id: rooms.length, x0, z0, w: RW, d: RW, cx: x0 + (RW >> 1), cz: z0 + (RW >> 1), type, rx, rz });
  }
  // 脇廊下（部屋と部屋の隙間を通す）
  for (let rz = 0; rz < nz; rz++) for (let rx = 0; rx < nx - 1; rx++) {
    const x0 = ix0 + rx * (RW + CW) + RW, z0 = iz0 + rz * (RW + CW);
    for (let z = z0; z < z0 + RW; z++) for (let x = x0; x < x0 + CW; x++) set(x, z, CORR);
  }
  for (let rz = 0; rz < nz - 1; rz++) for (let rx = 0; rx < nx; rx++) {
    const x0 = ix0 + rx * (RW + CW), z0 = iz0 + rz * (RW + CW) + RW;
    for (let z = z0; z < z0 + CW; z++) for (let x = x0; x < x0 + RW; x++) set(x, z, CORR);
  }
  // 廊下の交差部
  for (let rz = 0; rz < nz - 1; rz++) for (let rx = 0; rx < nx - 1; rx++) {
    const x0 = ix0 + rx * (RW + CW) + RW, z0 = iz0 + rz * (RW + CW) + RW;
    for (let z = z0; z < z0 + CW; z++) for (let x = x0; x < x0 + CW; x++) set(x, z, CORR);
  }
  // 脇廊下の端を大回廊へ接続（袋小路にしない）
  for (let rx = 0; rx < nx - 1; rx++) {
    const x0 = ix0 + rx * (RW + CW) + RW;
    for (let x = x0; x < x0 + CW; x++) { for (let z = 1 + G; z < iz0; z++) set(x, z, CORR); for (let z = iz0 + innerD; z < D - 1 - G; z++) set(x, z, CORR); }
  }
  for (let rz = 0; rz < nz - 1; rz++) {
    const z0 = iz0 + rz * (RW + CW) + RW;
    for (let z = z0; z < z0 + CW; z++) { for (let x = 1 + G; x < ix0; x++) set(x, z, CORR); for (let x = ix0 + innerW; x < W - 1 - G; x++) set(x, z, CORR); }
  }

  // ── 3. 床（天井高：回廊/広間=2段、部屋・廊下=1.5段相当の2段、狭い脇廊下=1段） ──
  const shell = [], items = [];
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const c = at(x, z);
    if (c === SOLID) continue;
    const ceil = (c === GALLERY || c === HALL) ? 2 : (c === ROOM ? 2 : 1);
    shell.push({ model: 'floor', x, z, ry: 0, level: 0, ceil, cell: c });
  }

  // ── 4. 壁：①歩ける↔壁体 ②部屋の囲い（部屋⇄回廊/廊下）──
  const enclosure = (x, z) => {   // 同じ囲いなら壁不要（回廊と脇廊下は地続き）
    const c = at(x, z);
    if (c === ROOM || c === HALL) return 'r' + roomIdAt(x, z);
    if (c === SOLID) return 'solid';
    return 'open';
  };
  function roomIdAt(x, z) { for (const r of rooms) if (x >= r.x0 && x < r.x0 + r.w && z >= r.z0 && z < r.z0 + r.d) return r.id; return -1; }

  const edgeSeen = new Set();
  const wallRecs = [];
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    if (!WALKABLE(at(x, z))) continue;
    for (const s of SIDE) {
      const nx2 = x + s.dx, nz2 = z + s.dz;
      if (enclosure(x, z) === enclosure(nx2, nz2)) continue;   // 同じ囲い＝壁不要
      const mx = x + s.dx * 0.5, mz = z + s.dz * 0.5;
      const key = mx + '|' + mz;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      const outer = !WALKABLE(at(nx2, nz2));
      const tall = at(x, z) === GALLERY || at(x, z) === HALL || at(x, z) === ROOM;
      // ax,az=этот側セル / bx,bz=反対側セル（どちらが部屋かは順序で変わるので両方持つ）
      wallRecs.push({ model: 'wall', x: mx, z: mz, ry: s.ry, wall: true, level: 0, tall, outer, cellA: at(x, z), cellB: at(nx2, nz2), ax: x, az: z, bx: nx2, bz: nz2 });
    }
  }

  // ── 5. 部屋の入口：回廊/廊下に面した辺の中央を扉に（回廊側を優先＝入口が回廊に並ぶ）──
  for (const r of rooms) {
    let best = null, bestScore = -Infinity;
    for (const w of wallRecs) {
      // 壁の片側が этот部屋、もう片側が回廊/脇廊下 のものだけ扉候補
      const aIn = roomIdAt(w.ax, w.az) === r.id, bIn = roomIdAt(w.bx, w.bz) === r.id;
      if (!aIn && !bIn) continue;
      const other = aIn ? at(w.bx, w.bz) : at(w.ax, w.az);
      if (other !== GALLERY && other !== CORR) continue;
      const rx = aIn ? w.ax : w.bx, rz = aIn ? w.az : w.bz;
      // 辺の中央ほど高得点。回廊に面していれば強く優先（入口が大回廊に整列する）
      const score = (other === GALLERY ? 1000 : 0) - (Math.abs(rx - r.cx) + Math.abs(rz - r.cz));
      if (score > bestScore) { bestScore = score; best = w; }
    }
    if (best) { best.model = 'doorway'; best.door = true; best.roomId = r.id; }
  }

  // ── 6. 外壁の窓（等間隔）＋回廊内側の絵画 ──
  for (const w of wallRecs) {
    if (w.model !== 'wall') continue;
    if (w.outer && w.cellA === GALLERY) {
      // 外周に面した回廊の壁 → 等間隔で窓
      const along = (Math.abs(Math.sin(w.ry)) < 0.5) ? w.ax : w.az;
      if (along % winStep === 1) w.model = 'window';
    }
  }
  shell.push(...wallRecs);

  // 回廊の内側の壁（部屋の外壁）で扉でない箇所に絵画を等間隔で
  let pIdx = 0;
  for (const w of wallRecs) {
    if (w.model !== 'wall' || w.outer) continue;
    const galA = w.cellA === GALLERY, galB = w.cellB === GALLERY;
    if (!galA && !galB) continue;
    const along = (Math.abs(Math.sin(w.ry)) < 0.5) ? w.ax : w.az;
    if (along % 3 !== 0) continue;
    // 回廊側セルの方向（絵はこちらを向く）
    const gx = galA ? w.ax : w.bx, gz = galA ? w.az : w.bz;
    const nx3 = Math.sign(gx - w.x), nz3 = Math.sign(gz - w.z);
    items.push({ model: 'painting', x: w.x, z: w.z, ry: Math.atan2(nx3, nz3), cat: 'painting', y: 1.7, id: pIdx++, nx: nx3, nz: nz3 });
  }

  // ── 7. 回廊の柱＋燭台：通路を塞がないよう「内側の壁ぎわ」に等間隔で立てる ──
  const addPillar = (x, z) => {
    if (at(x, z) !== GALLERY) return;
    items.push({ model: 'pillar', x, z, ry: 0, cat: 'pillar', toCeil: true });   // 天井まで伸ばす
    items.push({ model: 'lantern', x, z, ry: 0, cat: 'lantern', y: 2.2 });
  };
  const edgeN = G, edgeS = D - 1 - G, edgeW = G, edgeE = W - 1 - G;   // 回廊の内側端の列/行
  for (let x = G; x <= W - 1 - G; x += 4) { addPillar(x, edgeN); addPillar(x, edgeS); }
  for (let z = G + 4; z <= D - 1 - G - 4; z += 4) { addPillar(edgeW, z); addPillar(edgeE, z); }

  // ── 7.5 内装 ──
  // (a) 各部屋の家具は RoomEditor の generateRoom(noShell) をそのまま使って見繕う
  const ROOM_MIX = ['living', 'bedroom', 'office', 'living', 'bedroom', 'kitchen', 'office', 'living', 'bathroom'];
  for (const r of rooms) {
    const type = r.type === HALL ? 'living' : ROOM_MIX[r.id % ROOM_MIX.length];
    let sub = null;
    try { sub = generateRoom({ type, w: r.w, d: r.d, seed: (opts.seed ?? 1) * 31 + r.id, noShell: true }); } catch { /* 家具なしでも続行 */ }
    for (const it of (sub?.items || [])) {
      if (it.unit) continue;   // ユニットは未対応
      items.push({ ...it, x: r.x0 + it.x, z: r.z0 + it.z, cat: it.cat || 'furn', furn: true });
    }
  }
  // (b) 大回廊：腰板（壁の下半分）／長絨毯／シャンデリア／要所に鉢植え・ベンチ
  for (const w of wallRecs) {
    if (w.cellA !== GALLERY && w.cellB !== GALLERY) continue;
    if (w.model === 'doorway') continue;
    const gx = (w.cellA === GALLERY) ? w.ax : w.bx, gz = (w.cellA === GALLERY) ? w.az : w.bz;
    items.push({ model: 'paneling', x: w.x, z: w.z, ry: Math.atan2(Math.sign(gx - w.x), Math.sign(gz - w.z)), cat: 'paneling', wainscot: true });
  }
  for (let z = 1; z < D - 1; z++) for (let x = 1; x < W - 1; x++) {
    if (at(x, z) !== GALLERY) continue;
    const mid = (x === 1 + (G >> 1)) || (x === W - 2 - (G >> 1)) || (z === 1 + (G >> 1)) || (z === D - 2 - (G >> 1));
    if (mid) items.push({ model: 'rug', x, z, ry: 0, cat: 'rug' });                    // 回廊中央に長絨毯
    if (mid && (x + z) % 6 === 0) items.push({ model: 'chandelier', x, z, ry: 0, cat: 'chandelier', ceil: 2 });
  }
  for (const r of rooms) {   // 部屋の入口脇に鉢植え（回廊側）
    const dw = wallRecs.find((w) => w.door && w.roomId === r.id);
    if (!dw) continue;
    const gx = (at(dw.ax, dw.az) === GALLERY) ? dw.ax : dw.bx, gz = (at(dw.ax, dw.az) === GALLERY) ? dw.az : dw.bz;
    if (at(gx, gz) !== GALLERY) continue;
    items.push({ model: 'plant', x: gx, z: gz, ry: 0, cat: 'plant' });
  }

  // ── 8. スポーン（回廊の角）とゴール（対角の回廊角） ──
  const spawn = { x: 1 + (G >> 1), z: 1 + (G >> 1) };
  const goal = { x: W - 2 - (G >> 1), z: D - 2 - (G >> 1) };

  return { w: W, d: D, floors: 1, grid, rooms, shell, items, spawn, goal, seed: opts.seed ?? 1, galleryW: G };
}

/** 歩けるセルか（AI/当たり判定の共有ヘルパ） */
export function walkable(dg, x, z) {
  if (x < 0 || z < 0 || x >= dg.w || z >= dg.d) return false;
  return dg.grid[z * dg.w + x] !== SOLID;
}
