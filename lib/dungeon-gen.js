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
    const ceil = 2;   // 全域2段（脇廊下も回廊と同じ天井高に揃える）
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
      const tall = true;   // 天井が全域2段になったので、壁も全て2段積みで隙間を塞ぐ
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
  // 脇廊下の交差部（辻）の中央にシャンデリア
  for (let rz = 0; rz < nz - 1; rz++) for (let rx = 0; rx < nx - 1; rx++) {
    const x0 = ix0 + rx * (RW + CW) + RW, z0 = iz0 + rz * (RW + CW) + RW;
    items.push({ model: 'chandelier', x: x0 + (CW - 1) / 2, z: z0 + (CW - 1) / 2, ry: 0, cat: 'chandelier', ceil: 2 });
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

// ══════════ 複合レイアウト ══════════

/** レイアウト選択つき生成。
 *  'mansion'=本館のみ / 'annex'=渡り廊下の別棟 / 'floors2'=階段の2階建て / 'basement'=階段の地下棟 */
export function generateEstate(opts = {}) {
  const layout = opts.layout || 'mansion';
  if (layout === 'annex') return composeAnnex(opts);
  if (layout === 'floors2') {
    const seed = opts.seed ?? 1;
    return composeStack(opts, {
      lowerSeed: seed, upperSeed: seed * 13 + 7,
      windowlessLower: false, spawnLevel: 0, goalLevel: 1, layout: 'floors2',
    });
  }
  if (layout === 'manor') return composeManor(opts);
  if (layout === 'basement') {
    const seed = opts.seed ?? 1;
    return composeStack(opts, {
      lowerSeed: seed * 17 + 11, upperSeed: seed,   // 下の階＝地下棟、上の階＝本館
      windowlessLower: true, spawnLevel: 1, goalLevel: 0, layout: 'basement',
    });
  }
  const mn = generateMansion(opts);
  mn.layout = 'mansion';
  return mn;
}

/** 同じ間取り2枚を積み、回廊に直進階段2箇所（対角）で接続する。
 *  floors2＝下がスポーン階・上がゴール / basement＝上が本館スポーン・下が窓なしの地下ゴール */
function composeStack(opts = {}, cfg) {
  const seed = opts.seed ?? 1;
  const L0 = generateMansion({ ...opts, seed: cfg.lowerSeed });
  const L1 = generateMansion({ ...opts, seed: cfg.upperSeed });   // 間取りは寸法から決まるので同一。家具だけ変わる
  if (cfg.windowlessLower) for (const s of L0.shell) if (s.model === 'window') s.model = 'wall';   // 地下は窓なし
  const W = L0.w, D = L0.d, G = L0.galleryW;

  const shell = [], items = [];
  for (const s of L0.shell) shell.push({ ...s, level: 0 });
  for (const it of L0.items) items.push({ ...it, level: 0 });
  const roomIdOff = L0.rooms.length;
  const paintOff = L0.items.filter((i) => i.model === 'painting').length;
  for (const s of L1.shell) shell.push({ ...s, level: 1 });
  for (const it of L1.items) {
    const r = { ...it, level: 1 };
    if (it.model === 'painting') r.id = (it.id || 0) + paintOff;
    items.push(r);
  }
  const rooms = [
    ...L0.rooms.map((r) => ({ ...r, level: 0 })),
    ...L1.rooms.map((r) => ({ ...r, id: r.id + roomIdOff, level: 1 })),
  ];
  const grids = [L0.grid, new Uint8Array(L1.grid)];

  // ── 階段2箇所（西回廊は北向きに、東回廊は南向きに登る）──
  const zMid = D >> 1;
  const stairs = [
    { x: 2, z: zMid + 1, dx: 0, dz: -1, base: 0 },          // 入口セル→2セル先が2階の着地
    { x: W - 3, z: zMid - 1, dx: 0, dz: 1, base: 0 },
  ];
  for (const st of stairs) {
    const cells = [[st.x, st.z], [st.x + st.dx, st.z + st.dz]];   // 入口・中間（=吹き抜けの真下）
    for (const [cx, cz] of cells) {
      grids[1][cz * W + cx] = SOLID;   // 2階側は穴＝上を歩けない
    }
    // 2階の床は「板だけ抜いて」開口に（holeOnly＝屋根の生成は残す。消すと屋根まで穴が開く）
    for (const s of shell) {
      if (s.model !== 'floor' || s.level !== 1) continue;
      if (cells.some(([cx, cz]) => s.x === cx && s.z === cz)) s.holeOnly = true;
    }
    // 階段モデル（2セグメント：入口 0→半階、中間 半階→1階）
    const ry = Math.atan2(st.dx, st.dz);
    items.push({ model: 'stair', x: st.x, z: st.z, ry, cat: 'stair', level: 0, seg: 0 });
    items.push({ model: 'stair', x: st.x + st.dx, z: st.z + st.dz, ry, cat: 'stair', level: 0, seg: 1 });
  }
  // 1階の床は全て「天井なし」（2階の床が天井を兼ねる。階段の吹き抜けは2階床が無いので自然に開く）
  for (const s of shell) if (s.model === 'floor' && s.level === 0) s.noCeil = true;
  // 吹き抜けセルの上階アイテム（絨毯・シャンデリア）は除去：開口の上に浮いて床のように見えてしまう
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const onShaft = stairs.some((st) =>
      [[st.x, st.z], [st.x + st.dx, st.z + st.dz]].some(([cx, cz]) => Math.round(it.x) === cx && Math.round(it.z) === cz));
    if (!onShaft) continue;
    // 上階は絨毯もシャンデリアも除去。下階は宙吊りになるシャンデリアだけ除去（天井が無い）
    if ((it.level || 0) === 1 || it.model === 'chandelier') items.splice(i, 1);
  }

  // スポーンとゴールは階違いに置く＝必ず階段を使う
  const corner = { x: W - 2 - (G >> 1), z: D - 2 - (G >> 1) };
  // 地下（windowlessLower）は部屋の家具を撤去し、タル・木箱を配置（貯蔵庫の風情）
  if (cfg.windowlessLower) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.level || 0) !== 0) continue;
      // 家具に加えて、屋敷の装飾（腰板・絵画）も地下では外す（窓風のパネルに見えてしまう）
      if (it.furn || it.cat === 'paneling' || it.model === 'painting') items.splice(i, 1);
    }
    const rng2 = mulberry32(((seed * 97 + 5) * 2654435761) >>> 0);
    const CELLAR = ['barrels', 'detail-barrel', 'detail-crate', 'detail-crate-ropes', 'detail-crate-small', 'detail-barrel', 'detail-crate'];
    for (const r of L0.rooms) {
      const n = 3 + Math.floor(rng2() * 5);
      for (let i = 0; i < n; i++) {
        const x = r.x0 + 1 + Math.floor(rng2() * (r.w - 2));
        const z = r.z0 + 1 + Math.floor(rng2() * (r.d - 2));
        items.push({ model: CELLAR[Math.floor(rng2() * CELLAR.length)], x, z, ry: Math.floor(rng2() * 4) * Math.PI / 2, cat: 'cellar', level: 0, furn: true });
      }
    }
  }
  const spawn = cfg.spawnLevel === 1 ? { ...L1.spawn, level: 1 } : { ...L0.spawn, level: 0 };
  const goal = { ...corner, level: cfg.goalLevel };
  return {
    w: W, d: D, floors: 2, grid: grids[0], grids, rooms, shell, items, spawn, goal, stairs,
    seed, galleryW: G, layout: cfg.layout,
  };
}

/** 本館(3x3)＋渡り廊下＋別棟(2x2) を1枚のグリッドに合成する */
function composeAnnex(opts = {}) {
  const seed = opts.seed ?? 1;
  const A = generateMansion({ ...opts, seed });
  const B = generateMansion({
    galleryW: opts.galleryW, corridorW: opts.corridorW, roomW: opts.roomW, windowStep: opts.windowStep,
    roomsX: opts.annexRoomsX ?? 2, roomsZ: opts.annexRoomsZ ?? 2, seed: seed * 7 + 3,
  });
  const BR = opts.bridgeLen ?? 4;          // 渡り廊下の長さ（本館外壁と別棟外壁の間のセル数）
  const offX = A.w + BR;                   // B の平行移動量
  let offZ = (A.d >> 1) - (B.d >> 1);      // 回廊中央行を揃える
  let shiftZ = 0;
  if (offZ < 0) { shiftZ = -offZ; offZ = 0; }   // 別棟の方が奥行きが大きい場合は本館側をずらす
  const W = offX + B.w, D = Math.max(A.d + shiftZ, offZ + B.d);

  // ── グリッド合成 ──
  const grid = new Uint8Array(W * D);
  for (let z = 0; z < A.d; z++) for (let x = 0; x < A.w; x++) grid[(z + shiftZ) * W + x] = A.grid[z * A.w + x];
  for (let z = 0; z < B.d; z++) for (let x = 0; x < B.w; x++) grid[(z + offZ) * W + (x + offX)] = B.grid[z * B.w + x];

  // ── レコード平行移動 ──
  const shell = [], items = [];
  for (const s of A.shell) shell.push({ ...s, z: s.z + shiftZ });
  for (const it of A.items) items.push({ ...it, z: it.z + shiftZ });
  const roomIdOff = A.rooms.length;
  const paintOff = A.items.filter((i) => i.model === 'painting').length;
  for (const s of B.shell) {
    const r = { ...s, x: s.x + offX, z: s.z + offZ, zone: 1 };   // zone1=別棟（外装をゾーン別に変えられる）
    if (r.roomId != null) r.roomId += roomIdOff;
    if (r.ax != null) { r.ax += offX; r.az += offZ; r.bx += offX; r.bz += offZ; }
    shell.push(r);
  }
  for (const it of B.items) {
    const r = { ...it, x: it.x + offX, z: it.z + offZ, zone: 1 };
    if (it.model === 'painting') r.id = (it.id || 0) + paintOff;
    items.push(r);
  }
  const rooms = [
    ...A.rooms.map((r) => ({ ...r, z0: r.z0 + shiftZ, cz: r.cz + shiftZ })),
    ...B.rooms.map((r) => ({ ...r, id: r.id + roomIdOff, x0: r.x0 + offX, z0: r.z0 + offZ, cx: r.cx + offX, cz: r.cz + offZ })),
  ];

  // ── 渡り廊下：Aの中央行に2セル幅で通す（大回廊と同じ形式：2段吹き抜け・等間隔窓・腰板・絨毯）──
  const zb0 = (A.d >> 1) + shiftZ - 1, zb1 = zb0 + 1;
  const winStep = opts.windowStep ?? 3;
  for (let x = A.w - 1; x <= offX; x++) {
    for (const z of [zb0, zb1]) {
      grid[z * W + x] = GALLERY;
      shell.push({ model: 'floor', x, z, ry: 0, level: 0, ceil: 2, cell: GALLERY });
      items.push({ model: 'rug', x, z, ry: 0, cat: 'rug' });
    }
    const win = (x % winStep === 1);
    shell.push({ model: win ? 'window' : 'wall', x, z: zb0 - 0.5, ry: 0, wall: true, level: 0, tall: true, outer: true });
    shell.push({ model: win ? 'window' : 'wall', x, z: zb1 + 0.5, ry: Math.PI, wall: true, level: 0, tall: true, outer: true });
    items.push({ model: 'paneling', x, z: zb0 - 0.5, ry: 0, cat: 'paneling', wainscot: true });
    items.push({ model: 'paneling', x, z: zb1 + 0.5, ry: Math.PI, cat: 'paneling', wainscot: true });
    if ((x + zb0) % 6 === 0) items.push({ model: 'chandelier', x, z: zb0, ry: 0, cat: 'chandelier', ceil: 2 });
  }
  // 本館東外壁・別棟西外壁の交差部は壁を取り除いて開放（大回廊がそのまま連続する接続）
  for (let i = shell.length - 1; i >= 0; i--) {
    const s = shell[i];
    if (!s.wall || (s.z !== zb0 && s.z !== zb1)) continue;
    if (s.x === A.w - 1.5 || s.x === offX + 0.5) shell.splice(i, 1);
  }

  const spawn = { ...A.spawn, z: A.spawn.z + shiftZ };
  const goal = { x: B.goal.x + offX, z: B.goal.z + offZ };   // 別棟の奥＝渡り廊下を渡らないと出られない
  return { w: W, d: D, floors: 1, grid, rooms, shell, items, spawn, goal, seed, galleryW: A.galleryW, layout: 'annex' };
}

/** 大屋敷（ステージ構造.txt）: 3層本館(B1/1F/2F)＋南の吹き抜け玄関ホール(大階段/バルコニー/欄干)
 *  ＋書斎＋地下北の回廊→地下牢→2階分吹き抜けの霊廟(水面/ゲート橋/祭壇) */
function composeManor(opts = {}) {
  const seed = opts.seed ?? 1;
  const MB = generateMansion({ ...opts, seed: seed * 17 + 11 });   // B1
  const M1 = generateMansion({ ...opts, seed });                    // 1F
  const M2 = generateMansion({ ...opts, seed: seed * 13 + 7 });    // 2F
  const Wm = M1.w, Dm = M1.d, G = M1.galleryW;
  const CL = 6, PW = 10, PD = 6, C2 = 4, MW = 17, MD = 13;   // 地下北: 廊下/牢/廊下2/霊廟
  const NZ = MD + 1 + C2 + PD + CL;                           // 北拡張の行数
  const HW = 12, HD = 8, SZ = HD + 1;                         // 玄関ホール
  const W = Math.max(Wm, MW + 2), D = NZ + Dm + SZ;
  const cx = W >> 1;
  const grids = [new Uint8Array(W * D), new Uint8Array(W * D), new Uint8Array(W * D)];
  const shell = [], items = [], rooms = [], stairs = [];
  const gset = (l, x, z, v) => { if (x >= 0 && z >= 0 && x < W && z < D) grids[l][z * W + x] = v; };
  const rng = mulberry32(((seed * 131 + 7) * 2654435761) >>> 0);

  // ── 本館3層を (0, NZ) へ ──
  let roomIdOff = 0, paintOff = 0;
  const CELLAR = ['barrels', 'detail-barrel', 'detail-crate', 'detail-crate-ropes', 'detail-crate-small'];
  [MB, M1, M2].forEach((src, L) => {
    for (const sh of src.shell) {
      const r = { ...sh, z: sh.z + NZ, level: L, zone: L };
      if (L === 0 && r.model === 'window') r.model = 'wall';
      if (r.roomId != null) r.roomId += roomIdOff;
      if (r.ax != null) { r.az += NZ; r.bz += NZ; }
      shell.push(r);
    }
    for (const it of src.items) {
      if (L === 0 && (it.furn || it.cat === 'paneling' || it.model === 'painting')) continue;   // 地下は装飾なし
      const r = { ...it, z: it.z + NZ, level: L, zone: L };
      if (it.model === 'painting') { r.id = (it.id || 0) + paintOff; }
      items.push(r);
    }
    paintOff += src.items.filter((i) => i.model === 'painting').length;
    for (const r of src.rooms) rooms.push({ ...r, id: r.id + roomIdOff, z0: r.z0 + NZ, cz: r.cz + NZ, level: L });
    roomIdOff += src.rooms.length;
    for (let z = 0; z < Dm; z++) for (let x = 0; x < Wm; x++) grids[L][(z + NZ) * W + x] = src.grid[z * Wm + x];
    if (L === 0) for (const r of src.rooms) {   // 地下はタル・木箱
      const n = 3 + Math.floor(rng() * 5);
      for (let i = 0; i < n; i++) items.push({ model: CELLAR[Math.floor(rng() * CELLAR.length)], x: r.x0 + 1 + Math.floor(rng() * (r.w - 2)), z: r.z0 + NZ + 1 + Math.floor(rng() * (r.d - 2)), ry: Math.floor(rng() * 4) * Math.PI / 2, cat: 'cellar', level: 0, zone: 0, furn: true });
    }
  });
  for (const sh of shell) if (sh.model === 'floor' && sh.level < 2) sh.noCeil = true;   // 上階の床が天井

  // ── 屋内階段: B1⇄1F×2、1F⇄2F×1（東回廊）──
  const zMidM = NZ + (Dm >> 1);
  const inStairs = [
    { x: 2, z: zMidM + 1, dx: 0, dz: -1, base: 0 },
    { x: Wm - 3, z: zMidM - 1, dx: 0, dz: 1, base: 0 },
    { x: Wm - 3, z: zMidM + 2, dx: 0, dz: 1, base: 1 },
  ];
  const cutShaft = (st, noRail) => {   // 上階側の床を開口し、歩行不可に
    const up = (st.base || 0) + 1;
    for (const [sx2, sz2] of [[st.x, st.z], [st.x + st.dx, st.z + st.dz]]) {
      gset(up, sx2, sz2, SOLID);
      for (const sh of shell) if (sh.model === 'floor' && sh.level === up && sh.x === sx2 && sh.z === sz2) sh.holeOnly = true;
    }
    stairs.push(st);
    items.push({ model: 'stair', x: st.x, z: st.z, ry: Math.atan2(st.dx, st.dz), cat: 'stair', level: st.base, zone: st.base, seg: 0 });
    items.push({ model: 'stair', x: st.x + st.dx, z: st.z + st.dz, ry: Math.atan2(st.dx, st.dz), cat: 'stair', level: st.base, zone: st.base, seg: 1 });
    // 開口の真上に残る吊り物・絨毯を除去（浮いて見える）
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.cat === 'stair') continue;
      const lvl = it.level || 0;
      // 上階の床上に浮く物すべて＋開口の天井位置に吊られる基準階の電灯類
      const strip = lvl === up || (lvl === (st.base || 0) && (it.model === 'chandelier' || it.model === 'lantern'));
      if (!strip) continue;
      const hit = [[st.x, st.z], [st.x + st.dx, st.z + st.dz]].some(([cx2, cz2]) => Math.round(it.x) === cx2 && Math.round(it.z) === cz2);
      if (hit) items.splice(i, 1);
    }
    if (noRail) return;   // 吹き抜け内の大階段はフェンス不要（浮いてしまう）
    // 開口の縁に転落防止のフェンス（着地側だけ開ける）
    const fy = 0;
    for (const [cx2, cz2] of [[st.x, st.z], [st.x + st.dx, st.z + st.dz]]) {
      if (st.dz !== 0) {   // 南北方向の階段：東西の縁
        items.push({ model: 'fence', x: cx2 - 0.5, z: cz2, ry: Math.PI / 2, cat: 'rail', level: up, zone: up, y: fy });
        items.push({ model: 'fence', x: cx2 + 0.5, z: cz2, ry: Math.PI / 2, cat: 'rail', level: up, zone: up, y: fy });
      } else {
        items.push({ model: 'fence', x: cx2, z: cz2 - 0.5, ry: 0, cat: 'rail', level: up, zone: up, y: fy });
        items.push({ model: 'fence', x: cx2, z: cz2 + 0.5, ry: 0, cat: 'rail', level: up, zone: up, y: fy });
      }
    }
    // 入口側の端（着地の反対側）を塞ぐ
    items.push({ model: 'fence', x: st.x - st.dx * 0.5, z: st.z - st.dz * 0.5, ry: st.dz !== 0 ? 0 : Math.PI / 2, cat: 'rail', level: up, zone: up, y: fy });
  };
  for (const st of inStairs) cutShaft(st);

  // ── 玄関ホール（南拡張・吹き抜け）──
  const hx0 = cx - (HW >> 1), hz0 = NZ + Dm;
  const inRing = (x, z) => x < hx0 + 2 || x >= hx0 + HW - 2 || z < hz0 + 2 || z >= hz0 + HD - 2;
  for (let z = hz0; z < hz0 + HD; z++) for (let x = hx0; x < hx0 + HW; x++) {
    gset(1, x, z, GALLERY);
    shell.push({ model: 'floor', x, z, ry: 0, level: 1, zone: 1, ceil: 4, noCeil: inRing(x, z), cell: GALLERY });
    if (inRing(x, z)) { gset(2, x, z, GALLERY); shell.push({ model: 'floor', x, z, ry: 0, level: 2, zone: 2, ceil: 2, cell: GALLERY }); }
    else gset(2, x, z, SOLID);   // 吹き抜け＝2階は歩けない
  }
  // ホール外周壁（1階から屋根まで4段=stack3）。南面は窓＋中央玄関
  for (let x = hx0; x < hx0 + HW; x++) {
    const south = x === cx ? 'doorway' : (x % 3 === 1 ? 'window' : 'wall');
    shell.push({ model: south, x, z: hz0 + HD - 0.5, ry: Math.PI, wall: true, level: 1, zone: 1, stack: 1, outer: true, door: south === 'doorway' });
    shell.push({ model: (x % 3 === 1 ? 'window' : 'wall'), x, z: hz0 + HD - 0.5, ry: Math.PI, wall: true, level: 2, zone: 2, stack: 1, outer: true });
  }
  for (let z = hz0; z < hz0 + HD; z++) {
    for (const L of [1, 2]) {
      shell.push({ model: (z % 3 === 1 ? 'window' : 'wall'), x: hx0 - 0.5, z, ry: Math.PI / 2, wall: true, level: L, zone: L, stack: 1, outer: true });
      shell.push({ model: (z % 3 === 1 ? 'window' : 'wall'), x: hx0 + HW - 0.5, z, ry: -Math.PI / 2, wall: true, level: L, zone: L, stack: 1, outer: true });
    }
  }
  // 本館との境（接続の3セル以外は壁で埋める）
  for (let x = hx0; x < hx0 + HW; x++) {
    if (x >= cx - 1 && x <= cx + 1) continue;
    for (const L of [1, 2]) shell.push({ model: 'wall', x, z: hz0 - 0.5, ry: 0, wall: true, level: L, zone: L, stack: 1, outer: true });
  }
  // 本館との接続（1F/2F とも南外壁を3セル開ける）
  for (const L of [1, 2]) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      gset(L, x, NZ + Dm - 1, GALLERY);
      shell.push({ model: 'floor', x, z: NZ + Dm - 1, ry: 0, level: L, zone: L, ceil: 2, noCeil: L === 1, cell: GALLERY });
    }
    for (let i = shell.length - 1; i >= 0; i--) {
      const sh = shell[i];
      if (sh.wall && sh.level === L && sh.z === NZ + Dm - 1.5 && sh.x >= cx - 1 && sh.x <= cx + 1) shell.splice(i, 1);
    }
  }
  // 接続通路の側壁（通路の左右が素通しにならないように）
  for (const L of [1, 2]) {
    shell.push({ model: 'wall', x: cx - 1.5, z: NZ + Dm - 1, ry: Math.PI / 2, wall: true, level: L, zone: L, stack: 1, outer: true });
    shell.push({ model: 'wall', x: cx + 1.5, z: NZ + Dm - 1, ry: -Math.PI / 2, wall: true, level: L, zone: L, stack: 1, outer: true });
  }
  // 欄干（吹き抜けに面したバルコニー内縁）
  for (let x = hx0 + 2; x < hx0 + HW - 2; x++) {
    if (x !== cx - 1 && x !== cx) items.push({ model: 'fence', x, z: hz0 + 1.5, ry: 0, cat: 'rail', level: 2, zone: 2, y: 0 });   // 大階段の上は開ける
    items.push({ model: 'fence', x, z: hz0 + HD - 2.5, ry: 0, cat: 'rail', level: 2, zone: 2, y: 0 });
  }
  // バルコニーを支える柱（吹き抜け縁に等間隔）
  for (let x = hx0 + 2; x <= hx0 + HW - 3; x += 3) {
    items.push({ model: 'pillar', x: x + 0.2, z: hz0 + 1.7, ry: 0, cat: 'pillar', toCeil: true, level: 1, zone: 1 });
    items.push({ model: 'pillar', x: x + 0.2, z: hz0 + HD - 2.7, ry: 0, cat: 'pillar', toCeil: true, level: 1, zone: 1 });
  }
  for (let z = hz0 + 2; z <= hz0 + HD - 3; z += 3) {
    items.push({ model: 'pillar', x: hx0 + 1.7, z, ry: 0, cat: 'pillar', toCeil: true, level: 1, zone: 1 });
    items.push({ model: 'pillar', x: hx0 + HW - 2.7, z, ry: 0, cat: 'pillar', toCeil: true, level: 1, zone: 1 });
  }
  for (let z = hz0 + 2; z < hz0 + HD - 2; z++) {
    items.push({ model: 'fence', x: hx0 + 1.5, z, ry: Math.PI / 2, cat: 'rail', level: 2, zone: 2, y: 0 });
    items.push({ model: 'fence', x: hx0 + HW - 2.5, z, ry: Math.PI / 2, cat: 'rail', level: 2, zone: 2, y: 0 });
  }
  // 大階段（2列＝幅広）と赤絨毯、吹き抜けシャンデリア
  cutShaft({ x: cx - 1, z: hz0 + 3, dx: 0, dz: -1, base: 1 }, true);
  cutShaft({ x: cx, z: hz0 + 3, dx: 0, dz: -1, base: 1 }, true);
  for (let z = hz0 + 3; z < hz0 + HD; z++) { items.push({ model: 'rug', x: cx - 1, z, ry: 0, cat: 'rug', level: 1, zone: 1 }); items.push({ model: 'rug', x: cx, z, ry: 0, cat: 'rug', level: 1, zone: 1 }); }
  items.push({ model: 'chandelier', x: cx, z: hz0 + 4, ry: 0, cat: 'chandelier', ceil: 4, level: 1, zone: 1 });
  rooms.push({ id: roomIdOff++, x0: hx0, z0: hz0, w: HW, d: HD, cx, cz: hz0 + 5, type: HALL, level: 1 });

  // ── 書斎（1Fの最初の通常部屋）: 家具を本棚ユニットに差し替え ──
  const study = rooms.find((r) => r.level === 1 && r.type === ROOM);
  if (study) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.level || 0) === 1 && it.furn && it.x >= study.x0 && it.x < study.x0 + study.w && it.z >= study.z0 && it.z < study.z0 + study.d) items.splice(i, 1);
    }
    const unit = opts.units && opts.units.bookshelf;
    const FURN_S = 1.4, TILE0 = 2.5;
    const placeUnit = (ux, uz, ry) => {
      for (const c of (unit?.items || [])) {
        const ca = Math.cos(ry), sa = Math.sin(ry);
        const lx = (c.x || 0) * FURN_S / TILE0, lz = (c.z || 0) * FURN_S / TILE0;
        items.push({ model: c.model, x: ux + lx * ca + lz * sa, z: uz - lx * sa + lz * ca, ry: (c.ry || 0) + ry, cat: 'study', level: 1, zone: 1, furn: true });
      }
    };
    if (unit) { placeUnit(study.cx - 1.5, study.z0 + 1, 0); placeUnit(study.cx + 1.5, study.z0 + 1, 0); placeUnit(study.x0 + 1, study.cz, Math.PI / 2); }
    items.push({ model: 'desk', x: study.cx, z: study.cz + 1, ry: Math.PI, cat: 'study', level: 1, zone: 1, furn: true });
    items.push({ model: 'chairDesk', x: study.cx, z: study.cz, ry: 0, cat: 'study', level: 1, zone: 1, furn: true });
  }

  // ── 地下北拡張（level0のみ）──
  const addFloor = (x, z, ceil) => { gset(0, x, z, GALLERY); shell.push({ model: 'floor', x, z, ry: 0, level: 0, zone: 0, ceil: ceil || 2, cell: GALLERY }); };
  const addWall = (x, z, ry, stack) => shell.push({ model: 'wall', x, z, ry, wall: true, level: 0, zone: 0, stack: stack || 1, outer: true });
  // 本館B1北壁を開ける
  for (let x = cx - 1; x <= cx + 1; x++) addFloor(x, NZ, 2);
  for (let i = shell.length - 1; i >= 0; i--) {
    const sh = shell[i];
    if (sh.wall && sh.level === 0 && sh.z === NZ + 0.5 && sh.x >= cx - 1 && sh.x <= cx + 1) shell.splice(i, 1);
  }
  shell.push({ model: 'wall', x: cx - 1.5, z: NZ, ry: Math.PI / 2, wall: true, level: 0, zone: 0, stack: 1, outer: true });
  shell.push({ model: 'wall', x: cx + 1.5, z: NZ, ry: -Math.PI / 2, wall: true, level: 0, zone: 0, stack: 1, outer: true });
  // 回廊（幅3）→ 牢 → 廊下 → 霊廟
  const corr = (z0, z1) => { for (let z = z0; z <= z1; z++) { for (let x = cx - 1; x <= cx + 1; x++) addFloor(x, z, 2); addWall(cx - 1.5, z, Math.PI / 2, 1); addWall(cx + 1.5, z, -Math.PI / 2, 1); } };
  corr(NZ - CL, NZ - 1);                                   // 回廊
  const pz0 = NZ - CL - PD, px0 = cx - (PW >> 1);
  for (let z = pz0; z < pz0 + PD; z++) for (let x = px0; x < px0 + PW; x++) addFloor(x, z, 2);   // 地下牢
  for (let x = px0; x < px0 + PW; x++) {
    if (x < cx - 1 || x > cx + 1) { addWall(x, pz0 - 0.5, 0, 1); addWall(x, pz0 + PD - 0.5, Math.PI, 1); }
  }
  for (let z = pz0; z < pz0 + PD; z++) { addWall(px0 - 0.5, z, Math.PI / 2, 1); addWall(px0 + PW - 0.5, z, -Math.PI / 2, 1); }
  for (let z = pz0; z < pz0 + PD; z++) {   // 鉄柵（視覚のみ）と檻の中のタル
    items.push({ model: 'fence', x: px0 + 1.5, z, ry: Math.PI / 2, cat: 'jail', level: 0, zone: 0, stackN: 4 });
    items.push({ model: 'fence', x: px0 + PW - 2.5, z, ry: Math.PI / 2, cat: 'jail', level: 0, zone: 0, stackN: 4 });
    if (z % 2 === 0) { items.push({ model: 'detail-crate', x: px0, z, ry: rng() * 3, cat: 'jail', level: 0, zone: 0, furn: true }); items.push({ model: 'detail-barrel', x: px0 + PW - 1, z, ry: 0, cat: 'jail', level: 0, zone: 0, furn: true }); }
  }
  rooms.push({ id: roomIdOff++, x0: px0, z0: pz0, w: PW, d: PD, cx, cz: pz0 + (PD >> 1), type: ROOM, level: 0 });
  corr(pz0 - C2, pz0 - 1);                                 // 廊下2

  // ── 霊廟（2階分の高さ・水面・ゲート橋・祭壇）──
  const mx0 = cx - (MW >> 1);
  for (let x = mx0; x < mx0 + MW; x++) { addWall(x, 0.5, 0, 3); if (x < cx - 1 || x > cx + 1) addWall(x, MD + 0.5, Math.PI, 3); }
  for (let z = 1; z <= MD; z++) { addWall(mx0 - 0.5, z, Math.PI / 2, 3); addWall(mx0 + MW - 0.5, z, -Math.PI / 2, 3); }
  for (let z = 1; z <= MD; z++) for (let x = mx0; x < mx0 + MW; x++) {
    const bridge = (x >= cx - 1 && x <= cx + 1 && z >= 6);
    const plaza = (z >= 3 && z <= 5 && x > mx0 && x < mx0 + MW - 1);
    const altar = z <= 2;
    if (bridge || plaza) { addFloor(x, z, 4); }
    else if (altar) { addFloor(x, z, 4); }
    else { items.push({ model: 'water', x, z, ry: 0, cat: 'water', level: 0, zone: 0, y: 0.06 }); shell.push({ model: 'floor', x, z, ry: 0, level: 0, zone: 0, ceil: 4, cell: GALLERY }); }
  }
  for (let z = 7; z <= MD; z += 2) for (let x = cx - 1; x <= cx + 1; x++) items.push({ model: 'gatearch', x, z, ry: 0, cat: 'gate', level: 0, zone: 0 });   // ゲートの列＝橋
  for (let x = mx0 + 2; x < mx0 + MW - 2; x++) items.push({ model: 'stepblock', x, z: 2.6, ry: Math.PI, cat: 'altar', level: 0, zone: 0 });   // 祭壇への段
  items.push({ model: 'stepcorner', x: mx0 + 1, z: 2.6, ry: Math.PI / 2, cat: 'altar', level: 0, zone: 0 });      // 左端コーナー
  items.push({ model: 'stepcorner', x: mx0 + MW - 2, z: 2.6, ry: Math.PI, cat: 'altar', level: 0, zone: 0 });      // 右端（回転で反転）
  for (let x = mx0 + 1; x < mx0 + MW - 1; x++) for (let z = 1; z <= 2; z++) items.push({ model: 'retrofloor', x, z, ry: 0, cat: 'altar', level: 0, zone: 0, y: 1.0 });   // 高台の床
  items.push({ model: 'coffin', x: cx, z: 1.6, ry: 0, cat: 'coffin', level: 0, zone: 0, y: 1.02 });   // 棺（プロシージャル）
  for (const dxp of [3, 6]) for (const sgn of [-1, 1]) {
    items.push({ model: 'pillar', x: cx + dxp * sgn, z: 1.6, ry: 0, cat: 'pillar', toCeil: true, level: 0, zone: 0, y: 1.0 });
  }
  items.push({ model: 'painting', x: cx, z: 0.55, ry: 0, cat: 'painting', y: 2.8, id: paintOff++, nx: 0, nz: 1, big: true, level: 0, zone: 0 });   // 祭壇の大絵画
  items.push({ model: 'chandelier', x: cx, z: 5, ry: 0, cat: 'chandelier', ceil: 4, level: 0, zone: 0 });
  items.push({ model: 'lantern', x: mx0 + 1, z: 4, ry: 0, cat: 'lantern', y: 2.2, level: 0, zone: 0 });
  items.push({ model: 'lantern', x: mx0 + MW - 2, z: 4, ry: 0, cat: 'lantern', y: 2.2, level: 0, zone: 0 });
  rooms.push({ id: roomIdOff++, x0: mx0, z0: 3, w: MW, d: 3, cx, cz: 4, type: HALL, level: 0 });

  const spawn = { x: cx, z: hz0 + HD - 2, level: 1 };
  const goal = { x: cx, z: 4, level: 0 };   // 祭壇の前
  const raised = [{ x0: mx0 + 1, x1: mx0 + MW - 2, z0: 0, z1: 2.45, h: 1.0, rampZ1: 3.4, level: 0 }];   // 祭壇の高台（南側スロープ）
  return { w: W, d: D, floors: 3, grid: grids[0], grids, rooms, shell, items, spawn, goal, stairs, raised, seed, galleryW: G, layout: 'manor' };
}
