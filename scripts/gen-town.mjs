// gen-town.mjs — 町マップの汎用プロシージャル生成。
//   node scripts/gen-town.mjs <preset名>     例: node scripts/gen-town.mjs arden
//
// gen-floz-map.mjs は「フローゼ専用」で川筋・稜線・鉄道の線形が全部ハードコードだった。
// こちらは TOWNS のプリセット（＋シード）だけで別の町ができるように一般化したもの。
//   ・山     稜線チェーンの本数/向き/高さをシードから生成
//   ・川     山の斜面から海まで最急降下で自動生成（蛇行あり・支流は本流に合流）
//   ・鉄道   駅数と蛇行量を指定。線形は自動、高さ（地上/高架/川越え/勾配制限）も自動
//   ・道路   大通り格子→街路→路地。川・海・急斜面で自動クリップ、大通りの川越えは橋
//   ・建物   道路網に沿って自動配置し、川/海/急斜面/橋/線路/公園に被る分を除外
//
// 川の水面は「矩形プレーンの集合」ではなく、経路に沿った**リボン**として出力する
// （rivers[].points に1点ずつ水位を持たせる＝下流へ向かって傾斜する水面になる）。海は従来どおり矩形。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTerrainData, heightAt, autoColorize, serializeTerrain, b64, buildRoadGraph } from '../lib/terrain.js';
import { generateBuildings, instanceId } from '../lib/kenney-buildings.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ═══════════ プリセット ═══════════
// 方位はどの町も 北=-Z(山) / 南=+Z(海)。x方向の山は east/west で有無を切り替える。
const TOWNS = {
  arden: {
    name: 'arden',
    label: 'アルデン',
    seed: 31415926,
    size: 6400, res: 257,
    coast: { base: 1350, wobble: 420 },          // 海岸線のZ（xごとにノイズで揺れる）
    mountains: {
      north: true, west: true, east: false,      // 東は開けた丘陵（flozとの差）
      peaks: [14, 10, 10], height: [200, 820], radius: [230, 500], foothills: 18,
    },
    rivers: { count: 3, width: [12, 66], minLen: 900 },
    rail: { stations: 5, meander: 340, elevated: 700, baseZ: -120 },
    roads: { avenueX: 760, avenueZ: 620, streetSpacing: [135, 200], xPad: 260, zTop: -1700 },
    wharf: { enabled: true, w: 820, d: 300 },
    buildings: { seed: 77712345, spacing: 12 },
  },
};

const CFG = TOWNS[process.argv[2] || 'arden'];
if (!CFG) { console.error('プリセットがありません:', process.argv[2], '/ 使えるのは:', Object.keys(TOWNS).join(', ')); process.exit(1); }
const SIZE = CFG.size, RES = CFG.res, HALF = SIZE / 2, SEED = CFG.seed;

// ── 決定的ノイズ ──
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(a, b) { let h = (a * 374761393 + b * 668265263) ^ SEED; h = (h ^ (h >>> 13)) * 1274126177; return (h ^ (h >>> 16)) >>> 0; }
function vnoise(u, v) {
  const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const r = (a, b) => (hash2(a, b) >>> 8) / 16777216;
  const a = r(i, j), b = r(i + 1, j), c = r(i, j + 1), d = r(i + 1, j + 1);
  return (a + (b - a) * su) + ((c + (d - c) * su) - (a + (b - a) * su)) * sv;
}
function fbm(x, z, freq, oct = 3) {
  let v = 0, amp = 0.5, f = freq / SIZE;
  for (let o = 0; o < oct; o++) { v += vnoise(x * f, z * f) * amp; amp *= 0.5; f *= 2; }
  return v;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);

// ═══════════ 1) 地形 ═══════════
const T = makeTerrainData({ size: SIZE, res: RES });
const coastZ = (x) => CFG.coast.base + (fbm(x, 777, 1.5) - 0.5) * CFG.coast.wobble;
const peaks = [];
{
  const rng = mulberry(SEED + 99);
  const M = CFG.mountains;
  const chain = (x0, z0, x1, z1, n, jit, px, pz) => {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      peaks.push({
        x: x0 + (x1 - x0) * t + (rng() - 0.5) * 2 * jit * px,
        z: z0 + (z1 - z0) * t + (rng() - 0.5) * 2 * jit * pz,
        h: M.height[0] + (M.height[1] - M.height[0]) * (0.2 + 0.8 * rng()),
        r: M.radius[0] + (M.radius[1] - M.radius[0]) * rng(),
      });
    }
  };
  if (M.north) chain(-HALF + 500, -HALF + 1000, HALF - 500, -HALF + 800, M.peaks[0], 330, 0, 1);
  if (M.west)  chain(-HALF + 600, -HALF + 1200, -HALF + 700, HALF - 2000, M.peaks[1], 290, 1, 0);
  if (M.east)  chain(HALF - 600, -HALF + 1200, HALF - 700, HALF - 2000, M.peaks[2], 290, 1, 0);
  for (let i = 0; i < M.foothills; i++) {   // 山裾の小丘（前山）
    const side = rng();
    let x, z;
    if (side < 0.55) { x = -2300 + rng() * 4600; z = -1750 - rng() * 350; }
    else if (side < 0.8 && M.west) { x = -2250 - rng() * 200; z = -1500 + rng() * 2300; }
    else { x = (M.east ? 2250 : -1400 + rng() * 2800) + (M.east ? rng() * 200 : 0); z = -1600 + rng() * 1400; }
    peaks.push({ x, z, h: 100 + rng() * 150, r: 150 + rng() * 140 });
  }
}
function mountainAt(x, z) {
  let m = 0;
  for (const p of peaks) {
    const d2 = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z);
    if (d2 < p.r * p.r * 9) { const v = p.h * Math.exp(-d2 / (p.r * p.r)); if (v > m) m = v; }
  }
  return m;
}
function baseHeight(x, z) {
  const cz = coastZ(x);
  const t = clamp((z + 1500) / (cz + 1500), 0, 1);
  let h = 90 * Math.pow(1 - t, 1.35) + 2;
  if (z > cz) h = 2 - (z - cz) * 0.027;
  const seaTaper = clamp((cz - z + 500) / 1000, 0.12, 1);
  const m = mountainAt(x, z) * seaTaper;
  h += m;
  h += (fbm(x, z, 6) - 0.5) * (6 + m * 0.3);
  return h;
}
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    T.heights[j * RES + i] = baseHeight(x, z);
  }
}
const origHeights = T.heights.slice();
const origData = { size: SIZE, res: RES, heights: origHeights };
const oh = (x, z) => heightAt(origData, x, z);

// ═══════════ 2) 川（山の斜面から海まで最急降下で自動生成）═══════════
// 「地形を作ってから水を流す」ので、川筋は必ず谷を通る。水位は下流へ単調に下がるので
// 出力したリボンはそのまま傾斜した水面になる。
const riverMask = new Uint8Array(RES * RES);
const rivers = [];        // 出力用 {points:[[x,z,w,wl]...]}
const riverSamples = [];  // 判定用 {x,z,w,wl}
{
  const rng = mulberry(SEED + 1234);
  const STEP = 26;                     // 1歩の距離(m)
  const inBounds = (x, z) => Math.abs(x) < HALF - 60 && Math.abs(z) < HALF - 60;
  const traced = [];
  // 水源候補: 標高が高く、海から遠い点をシードから選ぶ
  const sources = [];   // 候補は多めに出して、実際に海へ届いたものだけ採用する
  for (let tries = 0; tries < 20000 && sources.length < CFG.rivers.count * 12; tries++) {
    const x = (rng() - 0.5) * (SIZE - 1200), z = -HALF + 300 + rng() * (HALF * 0.9);
    const h = oh(x, z);
    if (h < 150 || h > 700) continue;
    if (sources.some((s) => Math.hypot(s.x - x, s.z - z) < 650)) continue;   // 水源同士を離す（候補は多めに）
    sources.push({ x, z });
  }
  const nearTraced = (x, z, skip) => {   // 既存の川に近いか（合流判定）
    for (let ti = 0; ti < traced.length; ti++) {
      if (ti === skip) continue;
      for (const s of traced[ti]) if (Math.hypot(s.x - x, s.z - z) < s.w / 2 + 30) return true;
    }
    return false;
  };
  const why = { 短い: 0, 内陸で停止: 0, 採用: 0 };
  for (const src of sources) {
    if (traced.length >= CFG.rivers.count) break;
    const pts = [{ x: src.x, z: src.z }];
    let dirX = 0, dirZ = 1;   // とりあえず南（海）向きに出発
    let joined = false, reachedSea = false, edge = false, uphill = 0;
    for (let step = 0; step < 900; step++) {
      const c = pts[pts.length - 1];
      const hc = oh(c.x, c.z);
      let bx = 0, bz = 0, bestScore = Infinity, bestH = Infinity;
      // 進行方向±75°の扇で最も低い先を選ぶ（真後ろへ戻らない＝谷を素直に下る）
      for (let k = -5; k <= 5; k++) {
        const a = Math.atan2(dirX, dirZ) + (k / 5) * (Math.PI * 75 / 180);
        const nx = c.x + Math.sin(a) * STEP, nz = c.z + Math.cos(a) * STEP;
        if (!inBounds(nx, nz)) { edge = true; continue; }
        // 蛇行: 位置ノイズで左右にわずかなバイアスを掛ける（真っ直ぐ落ちるのを防ぐ）
        // 蛇行の強さは扇状地の勾配(26mあたり0.8m程度)より小さくする。大きいとノイズの窪みに
        // はまって内陸で止まり、川が1本も海に届かなくなる（実際にそうなった）
        const wob = (fbm(nx * 2.2, nz * 2.2, 9) - 0.5) * 1.4;
        const h = oh(nx, nz);
        // 南（海）へ引く。扇のスコアだけだと尾根伝いに東西へ流れて地図の端に貼り付く
        const score = h + Math.abs(k) * 0.22 + wob - 2.6 * (nz - c.z) / STEP;
        if (score < bestScore) { bestScore = score; bx = nx; bz = nz; bestH = h; }
      }
      if (bestScore === Infinity) break;      // 全方向が地図外
      // 窪地・鞍部: 少しの登り返しは許して越えさせる（掘るので実際には谷になる）。続くようなら打ち切り
      if (bestH > hc + 0.6) { if (++uphill > 20) break; } else uphill = 0;
      dirX = bx - c.x; dirZ = bz - c.z;
      const dl = Math.hypot(dirX, dirZ) || 1; dirX /= dl; dirZ /= dl;
      pts.push({ x: bx, z: bz });
      if (nearTraced(bx, bz, traced.length)) { joined = true; break; }   // 本流に合流
      if (bestH < 1.0 || bz > coastZ(bx) + 60) { reachedSea = true; break; }   // 海に到達
      if (edge && (Math.abs(bx) > HALF - 200 || Math.abs(bz) > HALF - 200)) break;   // 端に沿って走らせない
    }
    // 海にも本流にも届かず内陸で止まった川は捨てる（端に沿った溝になるのを防ぐ）
    if (!reachedSea && !joined) { why.内陸で停止++; continue; }
    if (pts.length * STEP < CFG.rivers.minLen) { why.短い++; continue; }
    for (let pass = 0; pass < 6; pass++) {   // 平滑化（カクつきを取る。蛇行そのものは残る）
      for (let i = 1; i < pts.length - 1; i++) {
        pts[i].x = (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4;
        pts[i].z = (pts[i - 1].z + pts[i].z * 2 + pts[i + 1].z) / 4;
      }
    }
    // 川幅（下流ほど広い）と水位（下流へ単調に低下＝傾斜した水面）
    const [wMin, wMax] = CFG.rivers.width;
    {
      let wl = Infinity, cut = -1;
      for (let i = 0; i < pts.length; i++) {
        const target = oh(pts[i].x, pts[i].z) - 2.4;
        const dropPerStep = 0.04 * STEP;   // 最低でもこれだけは下る（逆流しない）
        wl = Math.min(wl === Infinity ? target : wl - dropPerStep, target);
        pts[i].wl = wl;
        if (wl <= 0 && cut < 0) cut = i;   // ここで海面に達した＝河口
      }
      if (cut >= 0) pts.splice(cut + 3);   // 河口の少し先で打ち切り（海面下を延々と掘らない）
      if (pts.length < 12) continue;
      for (let i = 0; i < pts.length; i++) {
        const t = i / (pts.length - 1);
        pts[i].w = wMin + (wMax - wMin) * Math.pow(t, 0.75) * (joined ? 0.7 : 1);
        pts[i].wl = Math.max(0, pts[i].wl);   // 海面で頭打ち＝河口はフラットに繋がる
      }
    }
    traced.push(pts); why.採用++;
  }
  console.log('川の追跡: 水源候補', sources.length, '→', JSON.stringify(why));
  // 地形を掘る＋出力
  for (const pts of traced) {
    for (const s of pts) {
      const depth = 2.2 + s.w * 0.06, bed = s.wl - depth;
      const inner = s.w / 2 + 6, R = s.w / 2 + 34;
      const i0 = clamp(Math.floor(((s.x - R) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), i1 = clamp(Math.ceil(((s.x + R) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      const j0 = clamp(Math.floor(((s.z - R) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), j1 = clamp(Math.ceil(((s.z + R) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
          const d = Math.hypot(x - s.x, z - s.z);
          if (d >= R) continue;
          const orig = origHeights[j * RES + i];
          const target = d <= inner ? bed : bed + smooth((d - inner) / (R - inner)) * (orig - bed);
          if (target < T.heights[j * RES + i]) { T.heights[j * RES + i] = target; riverMask[j * RES + i] = 1; }
        }
      }
    }
    rivers.push({ points: pts.map((s) => [Math.round(s.x), Math.round(s.z), +s.w.toFixed(1), +s.wl.toFixed(2)]) });
    riverSamples.push(...pts);
  }
}
// 海（矩形。近景マテリアルの範囲を絞るため分割）
const water = [];
for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 2; iz++) {
  water.push({ x: -2400 + ix * 1600, z: CFG.coast.base + 470 + iz * 820, w: 1600, d: 820, level: 0 });
}

// ── 共通ヘルパ ──
const RCELL = 64, RHASH = new Map();
for (const s of riverSamples) {
  const k = Math.floor(s.x / RCELL) + '_' + Math.floor(s.z / RCELL);
  if (!RHASH.has(k)) RHASH.set(k, []);
  RHASH.get(k).push(s);
}
function riverAt(x, z) {
  let best = null, bd = 1e9;
  const cx = Math.floor(x / RCELL), cz = Math.floor(z / RCELL);
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const a = RHASH.get((cx + i) + '_' + (cz + j));
    if (!a) continue;
    for (const s of a) { const d = Math.hypot(x - s.x, z - s.z) - (s.w / 2 + 16); if (d < bd) { bd = d; best = s; } }
  }
  return { d: bd, s: best };
}
const hAt = (x, z) => heightAt(T, x, z);
const slopeAt = (x, z) => Math.max(Math.abs(hAt(x + 16, z) - hAt(x - 16, z)), Math.abs(hAt(x, z + 16) - hAt(x, z - 16))) / 32;
function cityOk(x, z) {
  const h = hAt(x, z);
  if (h < 1.5 || h > 95) return false;
  if (z > coastZ(x) - 110) return false;
  return slopeAt(x, z) < 0.42;
}

// ═══════════ 2.5) 埠頭（本流の河口の東側に自動配置）═══════════
let WHARF = null;
if (CFG.wharf.enabled && rivers.length) {
  let mouth = null;   // 一番海に近い川の終点
  for (const r of rivers) { const p = r.points[r.points.length - 1]; if (!mouth || p[1] > mouth[1]) mouth = p; }
  const cz0 = coastZ(mouth[0]);
  const x0 = clamp(mouth[0] + 140, -HALF + 400, HALF - 400 - CFG.wharf.w);
  WHARF = { x0, x1: x0 + CFG.wharf.w, z0: Math.round(cz0 - 70), z1: Math.round(cz0 - 70 + CFG.wharf.d), h: 2.6 };
  for (let j = 0; j < RES; j++) {
    for (let i = 0; i < RES; i++) {
      const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
      if (x < WHARF.x0 || x > WHARF.x1 || z < WHARF.z0 - 60 || z > WHARF.z1) continue;
      const idx = j * RES + i;
      if (z >= WHARF.z0) T.heights[idx] = WHARF.h;
      else T.heights[idx] = T.heights[idx] + (WHARF.h - T.heights[idx]) * smooth((z - (WHARF.z0 - 60)) / 60);
    }
  }
}
const wharfMidX = WHARF ? Math.round((WHARF.x0 + WHARF.x1) / 2) : 0;
const inWharf = (x, z) => !!WHARF && ((x > WHARF.x0 - 10 && x < WHARF.x1 + 10 && z > WHARF.z0 - 45 && z < WHARF.z1)
  || (z > WHARF.z0 - 330 && z <= WHARF.z0 && Math.abs(x - wharfMidX) < 25));

// ═══════════ 3) 鉄道（駅数・蛇行量は設定。線形と高さは自動）═══════════
const railSamples = [];
const stations = [];
{
  const R = CFG.rail;
  const rng = mulberry(SEED + 555);
  const phase = rng() * Math.PI * 2, phase2 = rng() * Math.PI * 2;
  const x0 = -HALF + 250, x1 = HALF - 250;
  for (let x = x0; x <= x1; x += 10) {
    const t = (x - x0) / (x1 - x0);
    // 蛇行: 波長の違う2つの正弦＋地形ノイズ。まっすぐな路線にしない
    const z = R.baseZ + Math.sin(t * Math.PI * 2.2 + phase) * R.meander
      + Math.sin(t * Math.PI * 5.3 + phase2) * R.meander * 0.35
      + (fbm(x, 4242, 3) - 0.5) * R.meander * 0.5;
    railSamples.push({ x, z });
  }
  for (let pass = 0; pass < 4; pass++) for (let i = 1; i < railSamples.length - 1; i++) railSamples[i].z = (railSamples[i - 1].z + railSamples[i].z * 2 + railSamples[i + 1].z) / 4;
  {   // 端は山裾で打ち切り（終端駅が山麓になる）
    let s0 = 0, s1 = railSamples.length - 1;
    while (s0 < s1 && hAt(railSamples[s0].x, railSamples[s0].z) > 55) s0++;
    while (s1 > s0 && hAt(railSamples[s1].x, railSamples[s1].z) > 55) s1--;
    railSamples.splice(s1 + 1);
    railSamples.splice(0, s0);
  }
  for (const s of railSamples) {
    const ter = hAt(s.x, s.z);
    let y = ter + 0.5;                                             // 郊外=地上
    if (Math.abs(s.x) <= R.elevated) y = Math.max(y, ter + 8);     // 中心部=高架
    const rv = riverAt(s.x, s.z);
    if (rv.d < 40) y = Math.max(y, (rv.s ? rv.s.wl : 0) + 7);      // 川越え
    s.y = y;
  }
  for (let pass = 0; pass < 2; pass++) {   // 勾配5%制限
    for (let i = 1; i < railSamples.length; i++) railSamples[i].y = Math.max(railSamples[i].y, railSamples[i - 1].y - 0.5);
    for (let i = railSamples.length - 2; i >= 0; i--) railSamples[i].y = Math.max(railSamples[i].y, railSamples[i + 1].y - 0.5);
  }
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < railSamples.length - 1; i++) railSamples[i].y = (railSamples[i - 1].y + railSamples[i].y * 2 + railSamples[i + 1].y) / 4;
  // 駅は使える区間を等分した位置に置く（中央は必ず中央駅）
  const n = Math.max(2, R.stations);
  const nameOf = (i) => {
    if (i === (n - 1) / 2) return CFG.label + 'セントラル';
    const west = i < (n - 1) / 2;
    const order = west ? Math.round((n - 1) / 2 - i) : Math.round(i - (n - 1) / 2);
    return (west ? '西' : '東') + CFG.label + (order > 1 ? order : '');
  };
  for (let i = 0; i < n; i++) {
    const idx = Math.round((railSamples.length - 1) * (i + 0.5) / n);
    const s = railSamples[idx];
    stations.push({ x: Math.round(s.x), z: Math.round(s.z), name: nameOf(i) });
  }
}
const rails = [{ points: railSamples.map((s) => [Math.round(s.x), Math.round(s.z), +s.y.toFixed(2)]), gauge: 5.2, stations }];
// 線路敷の判定（道路・建物の両方で使う）。線路→道路→建物の順に作り、後段が前段を避ける。
const RAIL_HALF = 9;          // 線路敷の半幅(m)
const CROSS_SPACING = 340;    // 踏切の間隔(m)
const RAILCELL = 64, RAILHASH = new Map();
for (const s of railSamples) {
  const k = Math.floor(s.x / RAILCELL) + '_' + Math.floor(s.z / RAILCELL);
  if (!RAILHASH.has(k)) RAILHASH.set(k, []);
  RAILHASH.get(k).push(s);
}
function railAt(x, z) {   // 最寄りの線路サンプルとの距離
  let best = null, bd = 1e9;
  const cx = Math.floor(x / RAILCELL), cz = Math.floor(z / RAILCELL);
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const a = RAILHASH.get((cx + i) + '_' + (cz + j));
    if (!a) continue;
    for (const s of a) { const d = Math.hypot(x - s.x, z - s.z); if (d < bd) { bd = d; best = s; } }
  }
  return { d: bd, s: best };
}
const crossings = [];   // 踏切（一定間隔。ここだけ道路が線路を跨げる）
{
  let acc = CROSS_SPACING;
  for (let i = 1; i < railSamples.length; i++) {
    const a = railSamples[i - 1], b = railSamples[i];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    if (acc < CROSS_SPACING) continue;
    if (b.y - hAt(b.x, b.z) > 5) continue;                                  // 高架区間に踏切は作らない
    if (stations.some((st) => Math.hypot(b.x - st.x, b.z - st.z) < 90)) continue;   // 駅構内は避ける
    acc = 0;
    crossings.push({ x: b.x, z: b.z });
  }
}
function railBlocks(x, z) {   // ここに道路を敷けないか（線路敷。高架の下と踏切は通せる）
  const r = railAt(x, z);
  if (!r.s || r.d > RAIL_HALF) return false;
  if (r.s.y - hAt(x, z) > 5) return false;                                  // 高架の下はくぐれる
  for (const c of crossings) if (Math.hypot(x - c.x, z - c.z) < 26) return false;   // 踏切
  return true;
}

// ═══════════ 4) 道路網 ═══════════
const RD = CFG.roads;
const X_MIN = -HALF + RD.xPad, X_MAX = HALF - RD.xPad;
const Z_MIN = RD.zTop, Z_MAX = Math.round(CFG.coast.base - 180);
const NS_ART = [], EW_ART = [];
{
  const rng = mulberry(SEED + 31);
  for (let x = X_MIN + RD.avenueX * 0.6; x < X_MAX; x += RD.avenueX) NS_ART.push(Math.round(x + (rng() - 0.5) * RD.avenueX * 0.2));
  for (let z = Z_MIN + RD.avenueZ * 0.7; z < Z_MAX; z += RD.avenueZ) EW_ART.push(Math.round(z + (rng() - 0.5) * RD.avenueZ * 0.2));
}
const segs = [];
for (const x of NS_ART) segs.push({ x1: x, z1: Z_MIN, x2: x, z2: Z_MAX, kind: 'avenue' });
for (const z of EW_ART) segs.push({ x1: X_MIN, z1: z, x2: X_MAX, z2: z, kind: 'avenue' });
const XB = [X_MIN, ...NS_ART, X_MAX].sort((a, b) => a - b);
const ZB = [Z_MIN, ...EW_ART, Z_MAX].sort((a, b) => a - b);
function targetSpacing(cx, cz) {
  const dc = Math.hypot(cx, cz);
  let t = dc < 800 ? RD.streetSpacing[0] : dc < 1600 ? (RD.streetSpacing[0] + RD.streetSpacing[1]) / 2 : RD.streetSpacing[1];
  for (const S of stations) if (Math.hypot(cx - S.x, cz - S.z) < 520) t = Math.min(t, RD.streetSpacing[0] * 0.9);
  return t;
}
for (let ci = 0; ci < XB.length - 1; ci++) {
  for (let cj = 0; cj < ZB.length - 1; cj++) {
    const x0 = XB[ci], x1 = XB[ci + 1], z0 = ZB[cj], z1 = ZB[cj + 1];
    const cw = x1 - x0, ch = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (!cityOk(cx, cz) && !cityOk(x0 + cw * 0.25, cz) && !cityOk(x1 - cw * 0.25, cz)) continue;
    const rng = mulberry(hash2(ci + 11, cj + 29));
    const tSp = targetSpacing(cx, cz);
    const kx = Math.max(0, Math.round(cw / tSp) - 1), kz = Math.max(0, Math.round(ch / tSp) - 1);
    const sx = [], sz = [];
    for (let i = 1; i <= kx; i++) { const x = Math.round(x0 + (cw * i) / (kx + 1) + (rng() - 0.5) * tSp * 0.36); sx.push(x); segs.push({ x1: x, z1: z0, x2: x, z2: z1, kind: 'street' }); }
    for (let j = 1; j <= kz; j++) { const z = Math.round(z0 + (ch * j) / (kz + 1) + (rng() - 0.5) * tSp * 0.36); sz.push(z); segs.push({ x1: x0, z1: z, x2: x1, z2: z, kind: 'street' }); }
    const dc = Math.hypot(cx, cz);
    const nearSta = stations.some((S) => Math.hypot(cx - S.x, cz - S.z) < 520);
    const minB = nearSta ? 78 : dc < 900 ? 95 : dc < 1700 ? 85 : 105;
    const xs2 = [x0, ...sx, x1].sort((a, b) => a - b), zs2 = [z0, ...sz, z1].sort((a, b) => a - b);
    const subdivide = (bx0, bz0, bx1, bz1, depth) => {
      const bw = bx1 - bx0, bh = bz1 - bz0;
      if (depth > 3 || Math.max(bw, bh) < minB * 1.6) return;
      if (bw >= bh) {
        const x = Math.round(bx0 + bw * (0.38 + rng() * 0.24));
        if (rng() < 0.3 && depth > 0) {   // 袋小路
          const span = 0.5 + rng() * 0.3;
          if (rng() < 0.5) segs.push({ x1: x, z1: bz0, x2: x, z2: Math.round(bz0 + bh * span), kind: 'alley' });
          else segs.push({ x1: x, z1: Math.round(bz1 - bh * span), x2: x, z2: bz1, kind: 'alley' });
          return;
        }
        segs.push({ x1: x, z1: bz0, x2: x, z2: bz1, kind: 'alley' });
        subdivide(bx0, bz0, x, bz1, depth + 1); subdivide(x, bz0, bx1, bz1, depth + 1);
      } else {
        const z = Math.round(bz0 + bh * (0.38 + rng() * 0.24));
        if (rng() < 0.3 && depth > 0) {
          const span = 0.5 + rng() * 0.3;
          if (rng() < 0.5) segs.push({ x1: bx0, z1: z, x2: Math.round(bx0 + bw * span), z2: z, kind: 'alley' });
          else segs.push({ x1: Math.round(bx1 - bw * span), z1: z, x2: bx1, z2: z, kind: 'alley' });
          return;
        }
        segs.push({ x1: bx0, z1: z, x2: bx1, z2: z, kind: 'alley' });
        subdivide(bx0, bz0, bx1, z, depth + 1); subdivide(bx0, z, bx1, bz1, depth + 1);
      }
    };
    for (let i = 0; i < xs2.length - 1; i++) for (let j = 0; j < zs2.length - 1; j++) subdivide(xs2[i], zs2[j], xs2[i + 1], zs2[j + 1], 0);
  }
}
if (WHARF) {   // 埠頭の周回路＋海岸大通りからの接続路
  const { x0, x1, z0, z1 } = WHARF;
  segs.push({ x1: x0 + 50, z1: z0 + 50, x2: x1 - 50, z2: z0 + 50, kind: 'street' });
  segs.push({ x1: x0 + 50, z1: z1 - 60, x2: x1 - 50, z2: z1 - 60, kind: 'street' });
  segs.push({ x1: x0 + 50, z1: z0 + 50, x2: x0 + 50, z2: z1 - 60, kind: 'street' });
  segs.push({ x1: x1 - 50, z1: z0 + 50, x2: x1 - 50, z2: z1 - 60, kind: 'street' });
  segs.push({ x1: wharfMidX, z1: z0 - 300, x2: wharfMidX, z2: z0 + 50, kind: 'street' });
}
// クリップ: 10m刻みで 地形OK/川/不可 を判定 → OK区間へ分割。大通りの短い川越えは橋
const bridges = [];
const pieces = [];
for (const sg of segs) {
  const vert = sg.x1 === sg.x2;
  const len = Math.abs(vert ? sg.z2 - sg.z1 : sg.x2 - sg.x1);
  const n = Math.max(2, Math.round(len / 10));
  const cls = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = sg.x1 + (sg.x2 - sg.x1) * t, z = sg.z1 + (sg.z2 - sg.z1) * t;
    const rv = riverAt(x, z);
    cls.push(rv.d <= 6 ? 1 : railBlocks(x, z) ? 2 : (cityOk(x, z) || inWharf(x, z)) ? 0 : 2);
  }
  if (sg.kind === 'avenue') {
    let i = 0;
    while (i <= n) {
      if (cls[i] !== 1) { i++; continue; }
      let j2 = i;
      while (j2 <= n && cls[j2] === 1) j2++;
      const runLen = (j2 - i) * 10;
      const before = i > 0 ? cls[i - 1] : 2, after = j2 <= n ? cls[j2] : 2;
      if (runLen < 240 && before === 0 && after === 0) {
        const tm = (i + j2 - 1) / 2 / n;
        const mx = sg.x1 + (sg.x2 - sg.x1) * tm, mz = sg.z1 + (sg.z2 - sg.z1) * tm;
        const rv = riverAt(mx, mz);
        const dirX = vert ? 0 : 1, dirZ = vert ? 1 : 0;
        const bl = runLen + 36;
        const e1x = mx - dirX * (bl / 2 + 12), e1z = mz - dirZ * (bl / 2 + 12);
        const e2x = mx + dirX * (bl / 2 + 12), e2z = mz + dirZ * (bl / 2 + 12);
        const kindB = (rv.s ? rv.s.w : 20) < 25 ? 'flat' : 'arch';
        const wl = rv.s ? rv.s.wl : 0;
        const deckY = +(Math.max(hAt(e1x, e1z), hAt(e2x, e2z), wl + (kindB === 'arch' ? 4 : 2.4)) + 0.35).toFixed(2);
        bridges.push({ x: Math.round(mx), z: Math.round(mz), dx: dirX, dz: dirZ, len: Math.round(bl), w: kindB === 'arch' ? 13 : 8, kind: kindB, deckY, wl: +wl.toFixed(2), bedY: +(wl - (2.2 + (rv.s ? rv.s.w : 20) * 0.06)).toFixed(2) });
        for (let k = i; k < j2; k++) cls[k] = 0;
      }
      i = j2;
    }
  }
  let i = 0;
  while (i <= n) {
    if (cls[i] !== 0) { i++; continue; }
    let j2 = i;
    while (j2 <= n && cls[j2] === 0) j2++;
    const t0 = i / n, t1 = Math.min(1, (j2 - 1) / n);
    const px1 = Math.round(sg.x1 + (sg.x2 - sg.x1) * t0), pz1 = Math.round(sg.z1 + (sg.z2 - sg.z1) * t0);
    const px2 = Math.round(sg.x1 + (sg.x2 - sg.x1) * t1), pz2 = Math.round(sg.z1 + (sg.z2 - sg.z1) * t1);
    if (Math.hypot(px2 - px1, pz2 - pz1) >= (sg.kind === 'alley' ? 60 : 80)) pieces.push({ x1: px1, z1: pz1, x2: px2, z2: pz2, kind: sg.kind });
    i = j2;
  }
}
// 大通りの端150mは通常街路へ（road-split で車線を合流させる遷移点）
{
  const out = [];
  for (const p of pieces) {
    const len = Math.hypot(p.x2 - p.x1, p.z2 - p.z1);
    if (p.kind !== 'avenue' || len < 520) { out.push(p); continue; }
    const ux = (p.x2 - p.x1) / len, uz = (p.z2 - p.z1) / len, TAPER = 150;
    const ax = Math.round(p.x1 + ux * TAPER), az = Math.round(p.z1 + uz * TAPER);
    const bx = Math.round(p.x2 - ux * TAPER), bz = Math.round(p.z2 - uz * TAPER);
    out.push({ x1: p.x1, z1: p.z1, x2: ax, z2: az, kind: 'street' });
    out.push({ x1: ax, z1: az, x2: bx, z2: bz, kind: 'avenue' });
    out.push({ x1: bx, z1: bz, x2: p.x2, z2: p.z2, kind: 'street' });
  }
  pieces.length = 0; pieces.push(...out);
}
// 駅前ロータリー（八角形の環道＋接続腕）
const rotaries = [];
{
  const R_ROT = 24;
  for (const st of stations) {
    const sx = st.x, sz = st.z + 90;   // 駅の少し南（線路をまたがない）
    if (!cityOk(sx, sz)) continue;
    const findV = (dir) => {
      let best = null;
      for (const p of pieces) {
        if (Math.abs(p.x1 - p.x2) > 0.01) continue;
        const x = p.x1;
        if ((x - sx) * dir <= R_ROT + 6 || (x - sx) * dir > 170) continue;
        const z0 = Math.min(p.z1, p.z2), z1 = Math.max(p.z1, p.z2);
        if (sz < z0 + 5 || sz > z1 - 5) continue;
        if (best == null || Math.abs(x - sx) < Math.abs(best - sx)) best = x;
      }
      return best;
    };
    const findH = (dir) => {
      let best = null;
      for (const p of pieces) {
        if (Math.abs(p.z1 - p.z2) > 0.01) continue;
        const z = p.z1;
        if ((z - sz) * dir <= R_ROT + 6 || (z - sz) * dir > 170) continue;
        const x0 = Math.min(p.x1, p.x2), x1 = Math.max(p.x1, p.x2);
        if (sx < x0 + 5 || sx > x1 - 5) continue;
        if (best == null || Math.abs(z - sz) < Math.abs(best - sz)) best = z;
      }
      return best;
    };
    const east = findV(1), west = findV(-1), north = findH(-1), south = findH(1);
    if ((east ? 1 : 0) + (west ? 1 : 0) + (north ? 1 : 0) + (south ? 1 : 0) < 2) continue;
    if (east) pieces.push({ x1: sx + R_ROT, z1: sz, x2: east, z2: sz, kind: 'street' });
    if (west) pieces.push({ x1: west, z1: sz, x2: sx - R_ROT, z2: sz, kind: 'street' });
    if (north) pieces.push({ x1: sx, z1: north, x2: sx, z2: sz - R_ROT, kind: 'street' });
    if (south) pieces.push({ x1: sx, z1: sz + R_ROT, x2: sx, z2: south, kind: 'street' });
    rotaries.push({ x: sx, z: sz, r: R_ROT });
  }
}
// ピース同士の交点を制御点にして折れ線化
const EPS = 0.01;
const roads = [];
for (const a of pieces) {
  const vert = Math.abs(a.x1 - a.x2) < EPS;
  const ts = new Set([vert ? a.z1 : a.x1, vert ? a.z2 : a.x2]);
  for (const b of pieces) {
    if (b === a) continue;
    const bv = Math.abs(b.x1 - b.x2) < EPS;
    if (vert === bv) continue;
    if (vert) {
      const bx0 = Math.min(b.x1, b.x2), bx1 = Math.max(b.x1, b.x2);
      const az0 = Math.min(a.z1, a.z2), az1 = Math.max(a.z1, a.z2);
      if (a.x1 >= bx0 - EPS && a.x1 <= bx1 + EPS && b.z1 >= az0 - EPS && b.z1 <= az1 + EPS) ts.add(b.z1);
    } else {
      const bz0 = Math.min(b.z1, b.z2), bz1 = Math.max(b.z1, b.z2);
      const ax0 = Math.min(a.x1, a.x2), ax1 = Math.max(a.x1, a.x2);
      if (b.x1 >= ax0 - EPS && b.x1 <= ax1 + EPS && a.z1 >= bz0 - EPS && a.z1 <= bz1 + EPS) ts.add(b.x1);
    }
  }
  const sorted = [...ts].sort((p, q) => p - q);
  roads.push({ kind: a.kind, points: sorted.map((t) => (vert ? [a.x1, t] : [t, a.z1])) });
}
for (const ro of rotaries) {
  const pts = [];
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push([Math.round(ro.x + Math.cos(a) * ro.r), Math.round(ro.z + Math.sin(a) * ro.r)]); }
  roads.push({ kind: 'street', closed: true, points: pts });
}

// ═══════════ 5) 植生 ═══════════
const ROADCELL = 24, roadHash = new Set();
{
  const g0 = buildRoadGraph(roads);
  for (const [aId, bId] of g0.edges) {
    const A = g0.nodes.get(aId), B = g0.nodes.get(bId);
    const L = Math.hypot(B.x - A.x, B.z - A.z), n = Math.max(1, Math.round(L / 12));
    for (let i = 0; i <= n; i++) {
      const x = A.x + (B.x - A.x) * i / n, z = A.z + (B.z - A.z) * i / n;
      roadHash.add(Math.floor(x / ROADCELL) + '_' + Math.floor(z / ROADCELL));
    }
  }
}
const nearRoad = (x, z) => {
  const cx = Math.floor(x / ROADCELL), cz = Math.floor(z / ROADCELL);
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (roadHash.has((cx + i) + '_' + (cz + j))) return true;
  return false;
};
const FRES = 400, FCELL = 16;
const forest = new Uint8Array(FRES * FRES);
for (let j = 0; j < FRES; j++) {
  for (let i = 0; i < FRES; i++) {
    const x = (i + 0.5) * FCELL - HALF, z = (j + 0.5) * FCELL - HALF;
    const h = hAt(x, z);
    if (h < 1.5 || z > coastZ(x) - 60) continue;
    if (nearRoad(x, z)) continue;
    const slope = slopeAt(x, z);
    let den = 0;
    const mf = clamp((h - 130) / 110, 0, 1) * clamp((1.15 - slope) / 1.0, 0, 1);
    if (mf > 0) den = 130 * mf * (0.55 + 0.45 * fbm(x, z, 5));
    const rv = riverAt(x, z);
    if (rv.d > -4 && rv.d < 34 && h < 110) den = Math.max(den, 46 * (0.5 + 0.5 * fbm(x + 999, z, 7)));
    forest[j * FRES + i] = Math.round(clamp(den, 0, 255));
  }
}

// ═══════════ 6) 建物 ═══════════
const added = [];
{
  const models = ['building-a', 'building-c', 'building-e', 'building-g', 'building-b', 'building-f'];
  const offs = [[60, 62], [-60, 62], [62, -60], [-62, -60], [180, 62], [-180, -62]];
  const rng = mulberry(SEED + 7);
  for (const st of stations) {   // 駅前に中層ビル
    if (!cityOk(st.x, st.z + 90)) continue;
    offs.forEach((o, i) => added.push({ kit: 'city', model: models[i], tier: 'mid', x: st.x + o[0], z: st.z + 90 + o[1], ry: Math.floor(rng() * 4) * Math.PI / 2, s: 1 }));
  }
  if (WHARF) {   // 埠頭の工業建物
    const IND = ['building-e', 'building-g', 'building-k', 'building-i', 'building-q'];
    let ii = 0;
    const put = (x, z, ry) => added.push({ kit: 'industrial', model: IND[ii++ % IND.length], tier: 'mid', x: Math.round(x), z: Math.round(z), ry, s: 1 });
    const w = WHARF.x1 - WHARF.x0;
    for (let k = 0; k < 6; k++) put(WHARF.x0 + 60 + w * k / 6, WHARF.z0 + 82, Math.PI);
    for (let k = 0; k < 4; k++) put(WHARF.x0 + 110 + w * k / 4, WHARF.z0 + 18, 0);
    for (let k = 0; k < 5; k++) put(WHARF.x0 + 70 + w * k / 5, WHARF.z1 - 32, 0);
  }
}
const g = buildRoadGraph(roads);
const genEdges = g.edges.map(([aId, bId]) => { const A = g.nodes.get(aId), B = g.nodes.get(bId); return [A.x, 0, A.z, B.x, 0, B.z]; });
const BLD_PARAMS = { spacing: CFG.buildings.spacing };
const gen = generateBuildings(genEdges, { seed: CFG.buildings.seed, ...BLD_PARAMS });

// ═══════════ 7) 公園 ═══════════
const parks = [];
const parkRects = [];
{
  const RPC = 32, RP = new Map();
  for (const e of genEdges) {
    const L = Math.hypot(e[3] - e[0], e[5] - e[2]), n = Math.max(1, Math.round(L / 10));
    for (let i = 0; i <= n; i++) {
      const x = e[0] + (e[3] - e[0]) * i / n, z = e[2] + (e[5] - e[2]) * i / n;
      const k = Math.floor(x / RPC) + '_' + Math.floor(z / RPC);
      if (!RP.has(k)) RP.set(k, []);
      RP.get(k).push([x, z]);
    }
  }
  const roadDist = (x, z) => {
    let bd = 1e9;
    const cx = Math.floor(x / RPC), cz = Math.floor(z / RPC);
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const a = RP.get((cx + i) + '_' + (cz + j));
      if (!a) continue;
      for (const p of a) { const d = Math.hypot(x - p[0], z - p[1]); if (d < bd) bd = d; }
    }
    return bd;
  };
  const rngP = mulberry(SEED + 55);
  for (let gz = Z_MIN; gz <= Z_MAX && parks.length < 90; gz += 60) {
    for (let gx = X_MIN; gx <= X_MAX && parks.length < 90; gx += 60) {
      const x = gx + Math.round((rngP() - 0.5) * 30), z = gz + Math.round((rngP() - 0.5) * 30);
      if (Math.hypot(x, z) < 1000) continue;
      if (!cityOk(x, z) || riverAt(x, z).d < 30 || z > coastZ(x) - 150) continue;
      let near = false;
      for (const s of railSamples) if (Math.hypot(x - s.x, z - s.z) < 42) { near = true; break; }
      if (near) continue;
      const rd = roadDist(x, z);
      if (rd < 24 || rd > 70) continue;
      const half = Math.round(Math.min(rd - 15, 28));
      if (half < 14) continue;
      for (const p of parks) if (Math.hypot(x - p._cx, z - p._cz) < 190) { near = true; break; }
      if (near) continue;
      parks.push({ _cx: x, _cz: z, points: [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]], fountain: rngP() < 0.55 ? 'round' : 'square' });
      parkRects.push([x - half - 3, x + half + 3, z - half - 3, z + half + 3]);
    }
  }
  for (const p of parks) { delete p._cx; delete p._cz; }
}
const removed = [];
// 建物のフットプリント（ランタイム city-fly.js の TARGET_FOOT と同じ値）。
// 中心からの距離だけで判定すると、一辺26mの塔が線路や橋の上に載る（実際に載っていた）
const TIER_FOOT = { tower: 26, mid: 15, house: 10 };
for (const it of gen.instances) {
  const foot = (TIER_FOOT[it.tier] || 12) * 0.55;   // 建物の半径ぶん判定を広げる
  const rv = riverAt(it.x, it.z);
  let bad = rv.d < foot || hAt(it.x, it.z) < 1.6 || slopeAt(it.x, it.z) > 0.5 || it.z > coastZ(it.x) - 90;
  if (!bad && WHARF && it.z > WHARF.z0 - 50 && it.x > WHARF.x0 - 20 && it.x < WHARF.x1 + 20) bad = true;
  if (!bad) for (const br of bridges) {   // 橋桁の上＋取り付け道路（坂）の範囲
    const alo = (it.x - br.x) * br.dx + (it.z - br.z) * br.dz;
    const per = -(it.x - br.x) * br.dz + (it.z - br.z) * br.dx;
    if (Math.abs(alo) < br.len / 2 + 30 + foot && Math.abs(per) < br.w / 2 + 6 + foot) { bad = true; break; }
  }
  if (!bad && railAt(it.x, it.z).d < RAIL_HALF + foot) bad = true;   // 線路敷（高架でも真下は空ける）
  if (!bad) for (const st of stations) if (Math.hypot(it.x - st.x, it.z - st.z) < 44) { bad = true; break; }
  if (!bad) for (const r of parkRects) if (it.x > r[0] && it.x < r[1] && it.z > r[2] && it.z < r[3]) { bad = true; break; }
  if (!bad) for (const ro of rotaries) if (Math.hypot(it.x - ro.x, it.z - ro.z) < ro.r + 14) { bad = true; break; }
  if (bad) removed.push(instanceId(it));
}

// ═══════════ 出力 ═══════════
autoColorize(T);
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    const h = T.heights[j * RES + i], o = (j * RES + i) * 3, cz = coastZ(x);
    if (WHARF && h > 1 && z > WHARF.z0 - 8 && z < WHARF.z1 + 4 && x > WHARF.x0 - 4 && x < WHARF.x1 + 4) {
      T.colors[o] = 148; T.colors[o + 1] = 150; T.colors[o + 2] = 154;   // 埠頭=コンクリ
    } else if (h < 0 && z > cz - 400) {
      const t = clamp(-h / 42, 0, 1);
      T.colors[o] = 180 - 128 * t; T.colors[o + 1] = 170 - 106 * t; T.colors[o + 2] = 140 - 62 * t;
    } else if (z > cz - 260 && h < 4.5) {
      T.colors[o] = 198; T.colors[o + 1] = 182; T.colors[o + 2] = 142;   // 砂浜
    } else if (riverMask[j * RES + i]) {
      T.colors[o] = 118; T.colors[o + 1] = 110; T.colors[o + 2] = 88;    // 川床
    }
  }
}
const out = {
  format: 'city-map', version: 1, name: CFG.name,
  terrain: serializeTerrain(T),
  roads, osmRoads: false,
  bridges, rails, parks, rotaries,
  port: WHARF ? {
    rect: [WHARF.x0, WHARF.z0, WHARF.x1, WHARF.z1], h: WHARF.h,
    containers: [{ x0: WHARF.x0 + 90, x1: WHARF.x0 + 350, z: WHARF.z1 - 25 }, { x0: WHARF.x0 + 480, x1: WHARF.x1 - 60, z: WHARF.z1 - 25 }],
    ship: { x: Math.round((WHARF.x0 + WHARF.x1) / 2), z: WHARF.z1, len: 150 },
  } : null,
  buildings: { seed: CFG.buildings.seed, removed, moved: {}, added, params: BLD_PARAMS },
  water,
  rivers,   // ★ 経路リボン（点ごとに幅と水位。下流へ傾斜する水面）
  forest: { cell: FCELL, res: FRES, yOff: 0, model: 'fantasy_GLB format/tree-high-round.glb', treeH: 20, data: b64(forest) },
};
const dest = path.join(root, 'public', 'maps', CFG.name + '.map.json');
fs.writeFileSync(dest, JSON.stringify(out));

// ═══════════ 検証ログ ═══════════
let hMin = 1e9, hMax = -1e9; for (const h of T.heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
let fCells = 0; for (const d of forest) if (d > 0) fCells++;
let roadKm = 0; for (const e of genEdges) roadKm += Math.hypot(e[3] - e[0], e[5] - e[2]) / 1000;
console.log('wrote:', dest, (fs.statSync(dest).size / 1024).toFixed(0) + 'KB');
console.log('terrain h:', hMin.toFixed(1), '..', hMax.toFixed(1));
console.log('roads:', roads.length, 'splines /', roadKm.toFixed(1) + 'km →', g.nodes.size, 'nodes /', g.edges.length, 'edges');
console.log('rivers:', rivers.map((r) => `${r.points.length}点 ${Math.round(r.points.length * 26)}m 幅${r.points[0][2]}→${r.points.at(-1)[2]}m 水位${r.points[0][3]}→${r.points.at(-1)[3]}m`).join(' / ') || 'なし');
console.log('rails:', railSamples.length, 'サンプル / 駅', stations.length, stations.map((s) => s.name).join(','));
console.log('bridges:', bridges.length, bridges.map((b) => b.kind + '@' + b.x + ',' + b.z).join(' '));
console.log('buildings:', gen.instances.length, 'auto (removed', removed.length, ') + added', added.length, '/ zones', JSON.stringify(gen.zones));
console.log('rotaries:', rotaries.length, '/ parks:', parks.length, '/ forest cells:', fCells, '/ wharf:', WHARF ? `${WHARF.x0}..${WHARF.x1}` : 'なし');
{   // 除外条件の自己検証（0でなければ TIER_FOOT の見積りか判定式のバグ）
  const rmSet = new Set(removed);
  let onRail = 0, onBridge = 0;
  for (const it of gen.instances) {
    if (rmSet.has(instanceId(it))) continue;
    const foot = (TIER_FOOT[it.tier] || 12) * 0.5;
    if (railAt(it.x, it.z).d < 6 + foot) { onRail++; continue; }
    for (const br of bridges) {
      const alo = (it.x - br.x) * br.dx + (it.z - br.z) * br.dz;
      const per = -(it.x - br.x) * br.dz + (it.z - br.z) * br.dx;
      if (Math.abs(alo) < br.len / 2 + foot && Math.abs(per) < br.w / 2 + foot) { onBridge++; break; }
    }
  }
  console.log('検証: 線路に載った建物', onRail, '/ 橋に載った建物', onBridge, '/ 踏切', crossings.length);
}
