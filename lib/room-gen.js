// room-gen.js — kenney_furniture-kit で部屋（外殻＋家具）を決定的に生成する純関数ジェネレータ。
// 座標は「セル」単位（1セル=床タイル1枚）。実寸換算はランタイム側（floorFull の bbox を実測）。
// three 非依存・副作用なし。関連: lib/city-gen.js, lib/kenney-buildings.js
//
// 設計:
// - カタログ: モデル名を接頭辞ルールで「カテゴリ」に自動分類（新モデルを kit に足しても同じパターンで配置される）
// - ルール表: カテゴリ単位で記述（wall/corner/center/free ＋ attach=他の家具アンカーへの吸着）
// - attach: 「ナイトスタンドはベッドの真横」「スピーカーはTV台の横」「椅子はテーブルに密着して正対」など
//   部屋の広さ・形に依らず相対位置と向きを固定する仕組み

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[(rng() * arr.length) | 0];
const irange = (rng, min, max) => min + ((rng() * (max - min + 1)) | 0);

// ── カテゴリ自動分類（上から順に最初にマッチした規則を採用）。新しいGLBを置くだけで同カテゴリの配置パターンに乗る ──
export const AUTO_CATEGORY = [
  [/^wall|^floor|^doorway|^stairs|^paneling$|^ceilingFan$/, null],   // 外殻・非家具は対象外
  [/^bed/, 'bed'],
  [/^cabinetBed/, 'nightstand'],
  [/^cabinetTelevision/, 'tvStand'],
  [/^television/, 'tv'],
  [/^speaker/, 'speaker'],
  [/^loungeSofa|^loungeDesignSofa/, 'sofa'],
  [/^loungeChair|^loungeDesignChair/, 'armchair'],
  [/^tableCoffee/, 'coffeeTable'],
  [/^table/, 'diningTable'],
  [/^chairDesk$/, 'deskChair'],
  [/^chair|^stool/, 'chair'],
  [/^desk/, 'desk'],
  [/^bookcase|^books$/, 'bookcase'],
  [/^lamp(Round|Square)Floor$/, 'floorLamp'],
  [/^lamp/, 'lamp'],
  [/^rug/, 'rug'],
  [/^plant|^pottedPlant$/, 'plant'],
  [/^kitchen/, 'kitchenUnit'],
  [/^bathroomSink/, 'bathSink'],
  [/^bathroomCabinet/, 'bathStorage'],
  [/^bathroomMirror$/, 'bathMirror'],
  [/^toilet/, 'toilet'],
  [/^bathtub$|^shower/, 'bath'],
  [/^washer|^dryer$/, 'laundry'],
  [/^trashcan$/, 'trash'],
  [/^cardboardBox/, 'box'],
  [/^sideTable/, 'sideTable'],
  [/^bench/, 'bench'],
  [/^coatRack/, 'coatRack'],
  [/^computerScreen$/, 'screen'],
  [/^computer|^laptop$|^radio$|^toaster$|^pillow|^bear$/, 'clutter'],
];
export function categorize(name) {
  for (const [re, cat] of AUTO_CATEGORY) if (re.test(name)) return cat;
  return 'misc';
}

// 既知の kit モデル一覧（available 未指定時の既定）。新モデルは editor から available で渡せば自動参加
const KNOWN = 'bathroomCabinet bathroomCabinetDrawer bathroomMirror bathroomSink bathroomSinkSquare bathtub bear bedBunk bedDouble bedSingle bench benchCushion benchCushionLow bookcaseClosed bookcaseClosedDoors bookcaseClosedWide bookcaseOpen bookcaseOpenLow books cabinetBed cabinetBedDrawer cabinetBedDrawerTable cabinetTelevision cabinetTelevisionDoors cardboardBoxClosed cardboardBoxOpen chair chairCushion chairDesk chairModernCushion chairModernFrameCushion chairRounded coatRack coatRackStanding computerKeyboard computerMouse computerScreen desk deskCorner dryer hoodLarge hoodModern kitchenBar kitchenBarEnd kitchenBlender kitchenCabinet kitchenCabinetCornerInner kitchenCabinetCornerRound kitchenCabinetDrawer kitchenCabinetUpper kitchenCabinetUpperCorner kitchenCabinetUpperDouble kitchenCabinetUpperLow kitchenCoffeeMachine kitchenFridge kitchenFridgeBuiltIn kitchenFridgeLarge kitchenFridgeSmall kitchenMicrowave kitchenSink kitchenStove kitchenStoveElectric lampRoundFloor lampRoundTable lampSquareCeiling lampSquareFloor lampSquareTable lampWall laptop loungeChair loungeChairRelax loungeDesignChair loungeDesignSofa loungeDesignSofaCorner loungeSofa loungeSofaCorner loungeSofaLong loungeSofaOttoman pillow pillowBlue pillowBlueLong pillowLong plantSmall1 plantSmall2 plantSmall3 pottedPlant radio rugDoormat rugRectangle rugRound rugRounded rugSquare shower showerRound sideTable sideTableDrawers speaker speakerSmall stoolBar stoolBarSquare table tableCloth tableCoffee tableCoffeeGlass tableCoffeeGlassSquare tableCoffeeSquare tableCross tableCrossCloth tableGlass tableRound televisionAntenna televisionModern televisionVintage toaster toilet toiletSquare trashcan washer washerDryerStacked'.split(' ');

// フットプリント（セル [幅,奥行]・向き0基準）。未登録は [1,1]
const FP = {
  bedDouble: [2, 2], bedSingle: [1, 2], bedBunk: [1, 2],
  loungeSofa: [2, 1], loungeSofaLong: [3, 1], loungeDesignSofa: [2, 1], loungeSofaCorner: [2, 2], loungeDesignSofaCorner: [2, 2],
  desk: [2, 1], deskCorner: [2, 2],
  cabinetTelevision: [2, 1], cabinetTelevisionDoors: [2, 1],
  table: [2, 1], tableCloth: [2, 1], tableCross: [2, 1], tableCrossCloth: [2, 1], tableGlass: [2, 1],
  bathtub: [1, 2], bookcaseClosedWide: [2, 1],
  rugRectangle: [2, 2], rugRound: [2, 2], rugRounded: [2, 2],
};
const fpOf = (model) => FP[model] || [1, 1];

// ── 部屋タイプ別ルール（cat=カタログ参照 / attach=アンカー吸着）──
const RULES = {
  bedroom: [
    { cat: 'bed', place: 'wall', count: [1, 1] },
    { cat: 'nightstand', attach: { to: 'bed', side: 'flank' }, count: [1, 2] },   // ベッドの真横・同じ向き
    { cat: 'bookcase', place: 'wall', count: [0, 2] },
    { cat: 'desk', place: 'wall', count: [0, 1], with: [{ cat: 'deskChair', side: 'front', face: 'anchor' }] },
    { cat: 'floorLamp', place: 'corner', count: [1, 1] },
    { cat: 'rug', place: 'center', count: [1, 1], occupy: false },
    { cat: 'plant', place: 'corner', count: [0, 2] },
  ],
  living: [
    { cat: 'sofa', place: 'wall', count: [1, 1] },
    { cat: 'rug', place: 'center', count: [1, 1], occupy: false },
    { cat: 'coffeeTable', attach: { to: 'sofa', side: 'front', gap: 0 }, count: [1, 1] },   // ソファ正面に密着気味
    { cat: 'tvStand', place: 'wall', count: [1, 1], with: [{ cat: 'tv', stackOn: true }] },
    { cat: 'speaker', attach: { to: 'tvStand', side: 'flank' }, count: [1, 2] },            // TV台の真横
    { cat: 'armchair', place: 'wall', count: [0, 2] },
    { cat: 'bookcase', place: 'wall', count: [0, 1] },
    { cat: 'floorLamp', place: 'corner', count: [1, 1] },
    { cat: 'plant', place: 'corner', count: [0, 2] },
  ],
  kitchen: [
    { kitchenRun: true },
    { cat: 'diningTable', place: 'center', count: [1, 1], chairs: true },
    { cat: 'trash', place: 'corner', count: [1, 1] },
    { cat: 'plant', place: 'corner', count: [0, 1] },
  ],
  bathroom: [
    { cat: 'bath', place: 'wall', count: [1, 1], fallbackFree: true },   // 湯舟は必ず出す（壁が無理なら自由配置）
    { cat: 'toilet', place: 'wall', count: [1, 1] },
    { cat: 'bathSink', place: 'wall', count: [1, 1] },
    { cat: 'bathStorage', place: 'wall', count: [0, 1] },
    { cat: 'laundry', place: 'wall', count: [0, 1] },
    { cat: 'rug', place: 'center', count: [1, 1], occupy: false },
  ],
  corridor: [   // 廊下: 家具は控えめ（コート掛け・ドアマット・観葉植物）
    { cat: 'coatRack', place: 'wall', count: [0, 1] },
    { cat: 'rug', place: 'center', count: [0, 1], occupy: false },
    { cat: 'plant', place: 'corner', count: [0, 1] },
  ],
  office: [
    { cat: 'desk', place: 'wall', count: [1, 1], with: [{ cat: 'deskChair', side: 'front', face: 'anchor' }, { cat: 'screen', stackOn: true }] },
    { cat: 'bookcase', place: 'wall', count: [1, 3] },
    { cat: 'sideTable', place: 'wall', count: [0, 1] },
    { cat: 'floorLamp', place: 'corner', count: [1, 1] },
    { cat: 'plant', place: 'corner', count: [0, 2] },
    { cat: 'box', place: 'corner', count: [0, 2] },
  ],
};
const KITCHEN_RUN = ['kitchenFridge', 'kitchenCabinet', 'kitchenSink', 'kitchenCabinetDrawer', 'kitchenStove', 'kitchenCabinet', 'kitchenCabinetDrawer'];

const SIDE = [
  { dx: 0, dz: -1, ry: 0 },
  { dx: 1, dz: 0, ry: -Math.PI / 2 },
  { dx: 0, dz: 1, ry: Math.PI },
  { dx: -1, dz: 0, ry: Math.PI / 2 },
];

export function generateRoom(opts = {}) {
  const type = RULES[opts.type] ? opts.type : 'living';
  const w = Math.max(3, Math.min(14, opts.w || 6));
  const d = Math.max(3, Math.min(14, opts.d || 5));
  const seed = opts.seed ?? 1;
  const windowRate = opts.windowRate ?? 0.35;
  const rng = mulberry32((seed * 2654435761) >>> 0);

  // カタログ構築: 既知＋available（新規GLB）をカテゴリへ自動分類
  const catalog = {};
  for (const name of new Set([...KNOWN, ...(opts.available || [])])) {
    const cat = categorize(name);
    if (!cat) continue;
    (catalog[cat] = catalog[cat] || []).push(name);
  }

  const shell = [];
  const items = [];
  const anchors = {};   // cat -> [{cx,cz,ry,fw,fd}] 配置済みアンカー（attach の吸着先）
  const occ = new Uint8Array(w * d);
  const at = (x, z) => occ[z * w + x];
  const setOcc = (x, z, v) => { occ[z * w + x] = v; };

  // noShell: 家モード用（外殻・ドア・ゾーンは house 側が作る。reserved でドア前セル等を予約して家具付けだけ行う）
  if (opts.reserved) for (const c of opts.reserved) { if (c.x >= 0 && c.z >= 0 && c.x < w && c.z < d) occ[c.z * w + c.x] = 2; }
  let doorEdge = null;
  let zones = null;
  if (!opts.noShell) {
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) shell.push({ model: 'floorFull', x, z, ry: 0 });

  const edges = [];
  for (let x = 0; x < w; x++) { edges.push({ side: 0, x, z: 0 }); edges.push({ side: 2, x, z: d - 1 }); }
  for (let z = 0; z < d; z++) { edges.push({ side: 3, x: 0, z }); edges.push({ side: 1, x: w - 1, z }); }
  doorEdge = pick(rng, edges.filter((e) => e.side === 2));
  for (const e of edges) {
    const s = SIDE[e.side];
    let model = 'wall';
    if (e === doorEdge) model = rng() < 0.5 ? 'wallDoorway' : 'wallDoorwayWide';
    else if (rng() < windowRate) model = rng() < 0.5 ? 'wallWindow' : 'wallWindowSlide';
    shell.push({ model, x: e.x + s.dx * 0.5, z: e.z + s.dz * 0.5, ry: s.ry, wall: true });
  }
  shell.push({ model: 'wallCorner', x: -0.5, z: -0.5, ry: 0, wall: true });
  shell.push({ model: 'wallCorner', x: w - 0.5, z: -0.5, ry: -Math.PI / 2, wall: true });
  shell.push({ model: 'wallCorner', x: w - 0.5, z: d - 0.5, ry: Math.PI, wall: true });
  shell.push({ model: 'wallCorner', x: -0.5, z: d - 0.5, ry: Math.PI / 2, wall: true });
  setOcc(doorEdge.x, doorEdge.z, 2);
  if (doorEdge.z - 1 >= 0) setOcc(doorEdge.x, doorEdge.z - 1, 2);

  // 浴室のゾーン分割: 3×4以上なら北側2行=湯舟ゾーン、南側=洗い場（トイレ・洗面台）。間に仕切り壁＋ドア
  if (type === 'bathroom' && w >= 3 && d >= 4) {
    const splitZ = 2;
    zones = { bath: { z0: 0, z1: splitZ - 1 }, wash: { z0: splitZ, z1: d - 1 } };
    const doorX = irange(rng, 0, w - 1);
    for (let x = 0; x < w; x++) shell.push({ model: x === doorX ? 'wallDoorway' : 'wall', x, z: splitZ - 0.5, ry: Math.PI, wall: true });
    setOcc(doorX, splitZ - 1, 2); setOcc(doorX, splitZ, 2);   // 仕切りドアの前後は空ける
  }
  }   // ← !opts.noShell（外殻生成ここまで）
  const zoneOf = (cat) => {
    if (!zones) return null;
    if (cat === 'bath') return zones.bath;
    if (['toilet', 'bathSink', 'bathStorage', 'laundry', 'rug'].includes(cat)) return zones.wash;
    return null;
  };

  const canPlace = (x, z, fw, fd) => {
    if (x < 0 || z < 0 || x + fw > w || z + fd > d) return false;
    for (let dz = 0; dz < fd; dz++) for (let dx = 0; dx < fw; dx++) if (at(x + dx, z + dz)) return false;
    return true;
  };
  const mark = (x, z, fw, fd) => { for (let dz = 0; dz < fd; dz++) for (let dx = 0; dx < fw; dx++) setOcc(x + dx, z + dz, 1); };
  const shuffled = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const wallSlots = (fpW, fpD) => {
    const out = [];
    for (let x = 0; x < w; x++) { out.push({ side: 0, x, z: 0 }); out.push({ side: 2, x, z: d - 1 }); }
    for (let z = 0; z < d; z++) { out.push({ side: 3, x: 0, z }); out.push({ side: 1, x: w - 1, z }); }
    const res = [];
    for (const c of out) {
      const alongX = c.side === 0 || c.side === 2;
      const fw = alongX ? fpW : fpD, fd = alongX ? fpD : fpW;
      const x = c.side === 1 ? c.x - (fw - 1) : c.x;
      const z = c.side === 2 ? c.z - (fd - 1) : c.z;
      res.push({ x, z, fw, fd, ry: SIDE[c.side].ry });
    }
    return shuffled(res);
  };

  // 配置確定: items へ登録し、アンカー（吸着先）として記録
  const commit = (cat, model, x, z, fw, fd, ry, extra) => {
    const cx = x + (fw - 1) / 2, cz = z + (fd - 1) / 2;
    const id = items.length;
    items.push({ id, model, x: cx, z: cz, ry, cat, ...(extra || {}) });
    (anchors[cat] = anchors[cat] || []).push({ id, cx, cz, ry, fw, fd });
    return { id, cx, cz, ry, fw, fd };
  };

  // アンカーの横(flank)/正面(front)の隣接セルを計算。向きはアンカー基準で固定
  // forward = (sin ry, cos ry) / flank = (cos ry, -sin ry)。壁付けアンカーは軸平行なので extent は |成分|×寸法
  const attachSpots = (a, side, gap = 0) => {
    const fx = Math.sin(a.ry), fz = Math.cos(a.ry);
    const lx = Math.cos(a.ry), lz = -Math.sin(a.ry);
    const extAlong = (vx, vz) => Math.abs(vx) * a.fw + Math.abs(vz) * a.fd;
    const spots = [];
    if (side === 'flank') {
      const off = extAlong(lx, lz) / 2 + 0.5;
      spots.push({ x: a.cx + lx * off, z: a.cz + lz * off, ry: a.ry, flush: { target: a.id, dir: [Math.sign(Math.round(lx)), Math.sign(Math.round(lz))] } });
      spots.push({ x: a.cx - lx * off, z: a.cz - lz * off, ry: a.ry, flush: { target: a.id, dir: [-Math.sign(Math.round(lx)), -Math.sign(Math.round(lz))] } });
    } else {   // front
      const off = extAlong(fx, fz) / 2 + 0.5 + gap;
      spots.push({ x: a.cx + fx * off, z: a.cz + fz * off, ry: a.ry });
    }
    return spots;
  };

  const tryPlaceAt = (model, spot, faceAnchor) => {
    const ix = Math.round(spot.x), iz = Math.round(spot.z);
    if (!canPlace(ix, iz, 1, 1)) return null;
    mark(ix, iz, 1, 1);
    const ry = faceAnchor ? spot.ry + Math.PI : spot.ry;
    return commit(categorize(model) || 'misc', model, ix, iz, 1, 1, ry, spot.flush ? { flush: spot.flush } : null);   // flush=実寸で横づけ（ランタイム）
  };

  // with: 直近に置いたアンカーへの付属（前面の椅子・台上のスタック）
  const applyWith = (withList, slotAnchor, baseModel) => {
    for (const wsp of withList || []) {
      const models = catalog[wsp.cat] || [];
      if (!models.length) continue;
      const model = pick(rng, models);
      if (wsp.stackOn) {
        items.push({ id: items.length, model, x: slotAnchor.cx, z: slotAnchor.cz, ry: slotAnchor.ry, stackOn: baseModel, cat: wsp.cat });
        continue;
      }
      for (const spot of attachSpots(slotAnchor, wsp.side || 'front')) {
        if (tryPlaceAt(model, spot, wsp.face === 'anchor')) break;
      }
    }
  };

  // テーブルの椅子: 矩形の4辺すべての隣接セルに、テーブル中心へ正対させて置く
  const placeChairsAround = (a) => {
    const models = catalog.chair || [];
    if (!models.length) return;
    const chair = pick(rng, models);
    const spots = [];
    for (let i = 0; i < a.fw; i++) { spots.push({ x: a.cx - (a.fw - 1) / 2 + i, z: a.cz - (a.fd - 1) / 2 - 1 }); spots.push({ x: a.cx - (a.fw - 1) / 2 + i, z: a.cz + (a.fd - 1) / 2 + 1 }); }
    for (let j = 0; j < a.fd; j++) { spots.push({ x: a.cx - (a.fw - 1) / 2 - 1, z: a.cz - (a.fd - 1) / 2 + j }); spots.push({ x: a.cx + (a.fw - 1) / 2 + 1, z: a.cz - (a.fd - 1) / 2 + j }); }
    for (const s of shuffled(spots)) {
      if (rng() < 0.25) continue;   // 少し間引いて生活感
      const ix = Math.round(s.x), iz = Math.round(s.z);
      if (!canPlace(ix, iz, 1, 1)) continue;
      mark(ix, iz, 1, 1);
      const ry = Math.atan2(a.cx - ix, a.cz - iz);   // テーブル中心へ正対（forward=(sin,cos)）
      commit('chair', chair, ix, iz, 1, 1, ry);
    }
  };

  const placeSpec = (spec) => {
    const models = spec.models || catalog[spec.cat] || [];
    if (!models.length) return;
    const n = irange(rng, spec.count[0], spec.count[1]);
    for (let k = 0; k < n; k++) {
      const model = pick(rng, models);
      const [fpW, fpD] = fpOf(model);
      const zb = zoneOf(spec.cat);   // 浴室分割時のゾーン制約（bath=北 / 洗い場=南）
      const zlo = zb ? zb.z0 : 0, zhi = zb ? zb.z1 : d - 1;
      let placed = null;
      if (spec.attach) {
        // 吸着: 対象カテゴリの配置済みアンカーの横/前だけを試す（部屋の広さに依らず密着）
        for (const a of shuffled(anchors[spec.attach.to] || [])) {
          for (const spot of shuffled(attachSpots(a, spec.attach.side, spec.attach.gap || 0))) {
            placed = tryPlaceAt(model, spot, spec.attach.face === 'anchor');
            if (placed) break;
          }
          if (placed) break;
        }
      } else if (spec.place === 'wall') {
        for (const s of wallSlots(fpW, fpD)) {
          if (s.z < zlo || s.z + s.fd - 1 > zhi) continue;   // ゾーン外は不可
          if (!canPlace(s.x, s.z, s.fw, s.fd)) continue;
          if (spec.occupy !== false) mark(s.x, s.z, s.fw, s.fd);
          placed = commit(spec.cat, model, s.x, s.z, s.fw, s.fd, s.ry);
          break;
        }
        if (!placed && spec.fallbackFree) {   // 湯舟など「必ず出す」もの
          for (let t = 0; t < 30 && !placed; t++) {
            const x = irange(rng, 0, Math.max(0, w - fpW)), z = irange(rng, zlo, Math.max(zlo, zhi - fpD + 1));
            if (!canPlace(x, z, fpW, fpD)) continue;
            mark(x, z, fpW, fpD);
            placed = commit(spec.cat, model, x, z, fpW, fpD, 0);
          }
        }
      } else if (spec.place === 'corner') {
        for (const [x, z] of shuffled([[0, zlo], [w - 1, zlo], [0, zhi], [w - 1, zhi]])) {
          if (!canPlace(x, z, 1, 1)) continue;
          mark(x, z, 1, 1);
          placed = commit(spec.cat, model, x, z, 1, 1, rng() * Math.PI * 2);
          break;
        }
      } else {   // center / free（ゾーン内）
        const zd = zhi - zlo + 1;
        const cx = Math.floor((w - fpW) / 2), cz = zlo + Math.floor((zd - fpD) / 2);
        const tries = spec.place === 'center' ? [[cx, cz]] : [];
        for (let t = 0; t < 14; t++) tries.push([irange(rng, 0, Math.max(0, w - fpW)), irange(rng, zlo, Math.max(zlo, zhi - fpD + 1))]);
        for (const [x, z] of tries) {
          if (spec.occupy !== false && !canPlace(x, z, fpW, fpD)) continue;
          if (spec.occupy !== false) mark(x, z, fpW, fpD);
          placed = commit(spec.cat, model, x, z, fpW, fpD, 0);
          break;
        }
      }
      if (!placed) break;
      if (spec.with) applyWith(spec.with, placed, model);
      if (spec.chairs) placeChairsAround(placed);
    }
  };

  const placeKitchenRun = () => {
    // 北壁の「連続した空き区間」の最長を探し、そこへ隙間なく並べる（run=ランタイムで実寸パック）
    let best = { x0: 0, len: 0 };
    let x0 = -1;
    for (let x = 0; x <= w; x++) {
      const free = x < w && canPlace(x, 0, 1, 1);
      if (free && x0 < 0) x0 = x;
      if ((!free || x === w) && x0 >= 0) { if (x - x0 > best.len) best = { x0, len: x - x0 }; x0 = -1; }
    }
    const n = Math.min(best.len, KITCHEN_RUN.length);
    for (let i = 0; i < n; i++) {
      mark(best.x0 + i, 0, 1, 1);
      commit('kitchenUnit', KITCHEN_RUN[i], best.x0 + i, 0, 1, 1, 0, { run: { id: 'kitchen', idx: i, dir: [1, 0], back: -0.5 } });
    }
  };

  // ユーザー製ユニット（複合パーツ）を最優先で配置: タグ {rooms:[...], place} が部屋タイプに合えば置く
  for (const u of (opts.units || [])) {
    const tg = u.tags || {};
    if (!tg.place) continue;   // 配置タグなし＝手動専用
    if (tg.rooms && tg.rooms.length && !tg.rooms.includes('any') && !tg.rooms.includes(type)) continue;
    const [fw0, fd0] = u.fp || [1, 1];
    let done = false;
    if (tg.place === 'wall') {
      for (const s of wallSlots(fw0, fd0)) {
        if (!canPlace(s.x, s.z, s.fw, s.fd)) continue;
        mark(s.x, s.z, s.fw, s.fd);
        items.push({ id: items.length, unit: u.name, x: s.x + (s.fw - 1) / 2, z: s.z + (s.fd - 1) / 2, ry: s.ry, cat: 'unit' });
        done = true; break;
      }
    } else if (tg.place === 'corner') {
      for (const [x, z] of shuffled([[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]])) {
        if (!canPlace(x, z, fw0, fd0)) continue;
        mark(x, z, fw0, fd0);
        items.push({ id: items.length, unit: u.name, x: x + (fw0 - 1) / 2, z: z + (fd0 - 1) / 2, ry: 0, cat: 'unit' });
        done = true; break;
      }
    } else {   // center / free
      const tries = tg.place === 'center' ? [[Math.floor((w - fw0) / 2), Math.floor((d - fd0) / 2)]] : [];
      for (let t = 0; t < 14; t++) tries.push([irange(rng, 0, Math.max(0, w - fw0)), irange(rng, 0, Math.max(0, d - fd0))]);
      for (const [x, z] of tries) {
        if (!canPlace(x, z, fw0, fd0)) continue;
        mark(x, z, fw0, fd0);
        items.push({ id: items.length, unit: u.name, x: x + (fw0 - 1) / 2, z: z + (fd0 - 1) / 2, ry: 0, cat: 'unit' });
        done = true; break;
      }
    }
    if (!done) continue;
  }

  for (const spec of RULES[type]) {
    if (spec.kitchenRun) placeKitchenRun();
    else placeSpec(spec);
  }

  return { shell, items, door: doorEdge ? { side: doorEdge.side, i: doorEdge.x } : null, w, d, type, seed };
}

// ── 家まるごと生成: BSP分割→タイプ割当→外周壁＋共有内壁→ドア接続→部屋ごとに家具付け ──
// 廊下モード(d>=9 または 2階建て): 中央の横帯=廊下。玄関(西端)→廊下→全部屋が廊下に面する。
// 2階建て(floors:2): 同じ廊下位置の別レイアウトを上に積み、廊下東端の階段で接続（2階の床は階段部分が穴）。
export function generateHouse(opts = {}) {
  const floors = opts.floors === 2 ? 2 : 1;
  return generateHouseCorridor(opts, floors);   // house は常に廊下つき（玄関→廊下→各部屋）
}

// 廊下つきレイアウト（1〜2階）
function generateHouseCorridor(opts, floors) {
  const W = Math.max(8, Math.min(22, opts.w || 14));
  const D = Math.max(7, Math.min(22, opts.d || 10));
  const seed = opts.seed ?? 1;
  const windowRate = opts.windowRate ?? 0.35;
  const cz = Math.max(3, Math.min(D - 4, (D / 2) | 0));   // 廊下の行（全階共通＝階段室が揃う）
  // 階段室(2階建てのみ): 北ゾーン東端の 2×cz スライス。南端が廊下に接続、北端に階段、残りが踊り場
  const stairHole = floors === 2 ? [{ x: W - 1, z: 0 }, { x: W - 1, z: 1 }] : null;

  const shell = [];
  const items = [];
  const roomsMeta = [];

  for (let level = 0; level < floors; level++) {
    const rng = mulberry32(((seed * 2654435761) ^ (level * 0x9e3779b9)) >>> 0);
    // 縦割りのみのBSP → ゾーン内の全部屋が廊下に面する
    const rooms = [];
    const splitV = (x0, w, z0, d) => {
      if (w <= 6) { rooms.push({ x0, z0, w, d }); return; }
      const cut = irange(rng, 3, w - 3);
      splitV(x0, cut, z0, d); splitV(x0 + cut, w - cut, z0, d);
    };
    splitV(0, floors === 2 ? W - 2 : W, 0, cz);   // 北ゾーン（2階建ては東端2列を階段室に確保）
    splitV(0, W, cz + 1, D - cz - 1);             // 南ゾーン
    if (floors === 2) rooms.push({ x0: W - 2, z0: 0, w: 2, d: cz, type: 'stairwell' });
    const corridor = { x0: 0, z0: cz, w: W, d: 1, type: 'corridor' };
    rooms.push(corridor);
    rooms.forEach((r, i) => { r.idx = i; });

    // タイプ割当: 1F=最大living→大きめkitchen→最小bathroom→残りbedroom/office。2F=最小bathroom＋bedroom/office
    const area = (r) => r.w * r.d;
    const plain = rooms.filter((r) => r !== corridor);               // 壁・ドア生成対象（階段室含む）
    const sorted = plain.filter((r) => !r.type).sort((a, b) => area(b) - area(a));   // タイプ未定のみ割当
    if (level === 0) {
      sorted[0].type = 'living';
      if (sorted.length > 1) sorted[1].type = 'kitchen';
      if (sorted.length > 2) sorted[sorted.length - 1].type = 'bathroom';
    } else if (sorted.length) {
      sorted[sorted.length - 1].type = 'bathroom';
    }
    let bedn = 0;
    for (const r of plain) if (!r.type) r.type = (bedn++ === 0 || rng() < 0.7) ? 'bedroom' : 'office';

    // 床＋外周壁（2Fは階段セルの床を抜く。玄関は1F西端の廊下行）
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      if (level > 0 && stairHole && stairHole.some((c) => c.x === x && c.z === z)) continue;   // 吹き抜け（階段の真上）
      shell.push({ model: 'floorFull', x, z, ry: 0, level });
    }
    for (let x = 0; x < W; x++) {
      shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x, z: -0.5, ry: 0, wall: true, level });
      shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x, z: D - 0.5, ry: Math.PI, wall: true, level });
    }
    for (let z = 0; z < D; z++) {
      const west = (level === 0 && z === cz) ? 'wallDoorwayWide' : (rng() < windowRate ? 'wallWindow' : 'wall');
      shell.push({ model: west, x: -0.5, z, ry: Math.PI / 2, wall: true, level });
      shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x: W - 0.5, z, ry: -Math.PI / 2, wall: true, level });
    }
    shell.push({ model: 'wallCorner', x: -0.5, z: -0.5, ry: 0, wall: true, level });
    shell.push({ model: 'wallCorner', x: W - 0.5, z: -0.5, ry: -Math.PI / 2, wall: true, level });
    shell.push({ model: 'wallCorner', x: W - 0.5, z: D - 0.5, ry: Math.PI, wall: true, level });
    shell.push({ model: 'wallCorner', x: -0.5, z: D - 0.5, ry: Math.PI / 2, wall: true, level });

    // 廊下との境界壁＋各部屋のドア（境界中央）
    const doorAt = new Map();
    const reserve = (r, lx, lz) => { if (!doorAt.has(r.idx)) doorAt.set(r.idx, []); doorAt.get(r.idx).push({ x: lx, z: lz }); };
    for (const r of plain) {
      const north = r.z0 + r.d === cz;   // 北ゾーン（廊下の上側）
      const doorX = r.x0 + (r.w >> 1);
      const lineZ = north ? cz - 0.5 : cz + 0.5;
      for (let x = r.x0; x < r.x0 + r.w; x++) {
        shell.push({ model: x === doorX ? 'wallDoorway' : 'wall', x, z: lineZ, ry: north ? Math.PI : 0, wall: true, level });
      }
      reserve(r, doorX - r.x0, north ? r.d - 1 : 0);   // 部屋側ドア前
      reserve(corridor, doorX, 0);                      // 廊下側
    }
    // ゾーン内の部屋間の縦壁
    for (const zone of [{ z0: 0, d: cz }, { z0: cz + 1, d: D - cz - 1 }]) {
      const zr = plain.filter((r) => r.z0 === zone.z0).sort((a, b) => a.x0 - b.x0);
      for (let i = 1; i < zr.length; i++) {
        const bx = zr[i].x0;
        for (let z = zone.z0; z < zone.z0 + zone.d; z++) shell.push({ model: 'wall', x: bx - 0.5, z, ry: Math.PI / 2, wall: true, level });
      }
    }
    // 玄関前を予約
    if (level === 0) reserve(corridor, 0, 0);

    // 家具付け（部屋ごとに独立シード）→ オフセット合成
    for (const r of rooms) {
      if (r.type === 'stairwell') {   // 階段室: 家具なし。1Fの北端に階段、残りは踊り場（2Fは吹き抜け＋踊り場）
        if (level === 0) items.push({ id: items.length, model: 'stairsOpen', x: W - 1, z: 0.5, ry: 0, cat: 'stairs', level });
        roomsMeta.push({ type: r.type, x0: r.x0, z0: r.z0, w: r.w, d: r.d, level });
        continue;
      }
      const sub = generateRoom({ type: r.type, w: r.w, d: r.d, seed: (seed * 31 + r.idx * 101 + level * 7919) >>> 0, noShell: true, reserved: doorAt.get(r.idx) || [], available: opts.available, units: opts.units });
      const base = items.length;
      for (const it of sub.items) {
        const c = { ...it, id: it.id + base, x: it.x + r.x0, z: it.z + r.z0, room: r.idx, level };
        if (c.flush) c.flush = { ...c.flush, target: c.flush.target + base };
        if (c.run) c.run = { ...c.run, id: c.run.id + '_' + level + '_' + r.idx, back: c.run.back + r.z0 };
        items.push(c);
      }
      roomsMeta.push({ type: r.type, x0: r.x0, z0: r.z0, w: r.w, d: r.d, level });
    }
  }

  return { shell, items, rooms: roomsMeta, w: W, d: D, type: 'house', seed, floors };
}

// 廊下なしの従来レイアウト（小さい家・1階のみ）
function generateHouseLegacy(opts) {
  const W = Math.max(8, Math.min(22, opts.w || 14));
  const D = Math.max(7, Math.min(22, opts.d || 10));
  const seed = opts.seed ?? 1;
  const windowRate = opts.windowRate ?? 0.35;
  const rng = mulberry32((seed * 2654435761 + 17) >>> 0);

  // 1) BSP分割（最小辺3・目標面積24以下）
  const rooms = [];
  const splitRect = (r) => {
    const area = r.w * r.d;
    const canW = r.w >= 7, canD = r.d >= 7;   // 3+3+仕切り側の余裕
    if (area <= 24 || (!canW && !canD)) { rooms.push(r); return; }
    const vert = canW && (!canD || r.w >= r.d ? true : rng() < 0.5);
    if (vert) {
      const cut = irange(rng, 3, r.w - 4);
      splitRect({ x0: r.x0, z0: r.z0, w: cut, d: r.d });
      splitRect({ x0: r.x0 + cut, z0: r.z0, w: r.w - cut, d: r.d });
    } else {
      const cut = irange(rng, 3, r.d - 4);
      splitRect({ x0: r.x0, z0: r.z0, w: r.w, d: cut });
      splitRect({ x0: r.x0, z0: r.z0 + cut, w: r.w, d: r.d - cut });
    }
  };
  splitRect({ x0: 0, z0: 0, w: W, d: D });
  rooms.forEach((r, i) => { r.idx = i; });

  // 2) タイプ割当: 南辺接触の最大=living(玄関)。最小=bathroom。living隣接の大きめ=kitchen。残=bedroom/office
  const area = (r) => r.w * r.d;
  const south = rooms.filter((r) => r.z0 + r.d === D);
  const living = (south.length ? south : rooms).reduce((a, b) => (area(b) > area(a) ? b : a));
  living.type = 'living';
  const rest = rooms.filter((r) => r !== living).sort((a, b) => area(a) - area(b));
  if (rest.length) rest[0].type = 'bathroom';
  const adj = (a, b) => {   // 共有境界セル列（ドア候補）を返す
    const cells = [];
    if (a.x0 + a.w === b.x0 || b.x0 + b.w === a.x0) {   // 縦境界
      const x = a.x0 + a.w === b.x0 ? a.x0 + a.w : b.x0 + b.w;
      const z0 = Math.max(a.z0, b.z0), z1 = Math.min(a.z0 + a.d, b.z0 + b.d);
      for (let z = z0; z < z1; z++) cells.push({ vert: true, x, z });
    } else if (a.z0 + a.d === b.z0 || b.z0 + b.d === a.z0) {
      const z = a.z0 + a.d === b.z0 ? a.z0 + a.d : b.z0 + b.d;
      const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x0 + a.w, b.x0 + b.w);
      for (let x = x0; x < x1; x++) cells.push({ vert: false, x, z });
    }
    return cells;
  };
  for (const r of rest.slice(1)) {
    if (!r.type && adj(r, living).length && area(r) >= 12) { r.type = 'kitchen'; break; }
  }
  if (!rooms.some((r) => r.type === 'kitchen') && rest.length > 1) rest[rest.length - 1].type = 'kitchen';
  let bedn = 0;
  for (const r of rooms) if (!r.type) r.type = (bedn++ === 0 || rng() < 0.7) ? 'bedroom' : 'office';

  // 3) 外周壁＋玄関、共有内壁＋全域木ドア
  const shell = [];
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) shell.push({ model: 'floorFull', x, z, ry: 0 });
  const entX = living.x0 + ((living.w / 2) | 0);   // 玄関=livingの南辺中央
  for (let x = 0; x < W; x++) {
    shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x, z: -0.5, ry: 0, wall: true });
    shell.push({ model: x === entX ? 'wallDoorwayWide' : (rng() < windowRate ? 'wallWindow' : 'wall'), x, z: D - 0.5, ry: Math.PI, wall: true });
  }
  for (let z = 0; z < D; z++) {
    shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x: -0.5, z, ry: Math.PI / 2, wall: true });
    shell.push({ model: rng() < windowRate ? 'wallWindow' : 'wall', x: W - 0.5, z, ry: -Math.PI / 2, wall: true });
  }
  shell.push({ model: 'wallCorner', x: -0.5, z: -0.5, ry: 0, wall: true });
  shell.push({ model: 'wallCorner', x: W - 0.5, z: -0.5, ry: -Math.PI / 2, wall: true });
  shell.push({ model: 'wallCorner', x: W - 0.5, z: D - 0.5, ry: Math.PI, wall: true });
  shell.push({ model: 'wallCorner', x: -0.5, z: D - 0.5, ry: Math.PI / 2, wall: true });

  // 全域木（livingからBFS）でドアを決める
  const doorAt = new Map();   // "roomIdx" -> [{x,z}] 部屋内のドア前予約セル
  const reserve = (r, x, z) => { (doorAt.get(r.idx) || doorAt.set(r.idx, []).get(r.idx)).push({ x: x - r.x0, z: z - r.z0 }); };
  const visited = new Set([living.idx]);
  const queue = [living];
  const treeDoors = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const other of rooms) {
      if (visited.has(other.idx)) continue;
      const cells = adj(cur, other);
      if (!cells.length) continue;
      visited.add(other.idx);
      queue.push(other);
      treeDoors.push({ a: cur, b: other, cell: cells[(cells.length / 2) | 0] });
    }
  }
  // 内壁: 部屋ペアごとの境界を1回だけ。全域木のドアセルは wallDoorway
  const doorKey = new Set(treeDoors.map((t) => `${t.cell.vert ? 'v' : 'h'}_${t.cell.x}_${t.cell.z}`));
  const seen = new Set();
  for (const a of rooms) for (const b of rooms) {
    if (a.idx >= b.idx) continue;
    const key = a.idx + '_' + b.idx;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const c of adj(a, b)) {
      const isDoor = doorKey.has(`${c.vert ? 'v' : 'h'}_${c.x}_${c.z}`);
      if (c.vert) shell.push({ model: isDoor ? 'wallDoorway' : 'wall', x: c.x - 0.5, z: c.z, ry: Math.PI / 2, wall: true });
      else shell.push({ model: isDoor ? 'wallDoorway' : 'wall', x: c.x, z: c.z - 0.5, ry: Math.PI, wall: true });
    }
  }
  // ドア前セルを両側の部屋で予約
  for (const t of treeDoors) {
    const c = t.cell;
    const cells = c.vert ? [{ x: c.x - 1, z: c.z }, { x: c.x, z: c.z }] : [{ x: c.x, z: c.z - 1 }, { x: c.x, z: c.z }];
    for (const p of cells) for (const r of [t.a, t.b]) {
      if (p.x >= r.x0 && p.z >= r.z0 && p.x < r.x0 + r.w && p.z < r.z0 + r.d) {
        if (!doorAt.has(r.idx)) doorAt.set(r.idx, []);
        doorAt.get(r.idx).push({ x: p.x - r.x0, z: p.z - r.z0 });
      }
    }
  }
  { // 玄関前も予約
    if (!doorAt.has(living.idx)) doorAt.set(living.idx, []);
    doorAt.get(living.idx).push({ x: entX - living.x0, z: D - 1 - living.z0 });
  }

  // 4) 部屋ごとに家具付け（独立シード）→部屋原点へオフセット、id/flush/run を全体一意に
  const items = [];
  for (const r of rooms) {
    const sub = generateRoom({ type: r.type, w: r.w, d: r.d, seed: (seed * 31 + r.idx * 101) >>> 0, noShell: true, reserved: doorAt.get(r.idx) || [], available: opts.available });
    const base = items.length;
    for (const it of sub.items) {
      const c = { ...it, id: it.id + base, x: it.x + r.x0, z: it.z + r.z0, room: r.idx };
      if (c.flush) c.flush = { ...c.flush, target: c.flush.target + base };
      if (c.run) c.run = { ...c.run, id: c.run.id + '_' + r.idx, back: c.run.back + r.z0 };
      items.push(c);
    }
  }

  return { shell, items, rooms: rooms.map((r) => ({ type: r.type, x0: r.x0, z0: r.z0, w: r.w, d: r.d })), w: W, d: D, type: 'house', seed };
}

export const ROOM_TYPES = Object.keys(RULES);
