// gen-floz-map.mjs — 新マップ「floz」を mapplan.txt のルールから決定的に生成する。
// 方位: 北=-Z(山) / 西=-X(山) / 東=+X(山) / 南=+Z(海)。地形257²・6400m。
// 出力: public/maps/floz.map.json（format city-map = 既存ランタイムでそのまま読める）
// フェーズ1: 地形(三方の山・扇状地・川の掘り下げ・海底)＋水面＋植生＋道路網＋建物差分。
// 鉄道・橋・ロータリーはフェーズ2/3（ランタイム拡張が必要）。計画= .tmp/mapgen_floz_plan.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTerrainData, heightAt, autoColorize, serializeTerrain, b64, buildRoadGraph } from '../lib/terrain.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIZE = 6400, RES = 257, HALF = SIZE / 2;
const SEED = 20260825;

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
const P = 96, grid = new Float32Array((P + 1) * (P + 1));
{ const rng = mulberry(SEED); for (let i = 0; i < grid.length; i++) grid[i] = rng(); }
function vnoise(u, v) {   // 値ノイズ（格子双線形＋smoothstep）
  u = ((u % P) + P) % P; v = ((v % P) + P) % P;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const g = (a, b2) => grid[(b2 % (P + 1)) * (P + 1) + (a % (P + 1))];
  return g(iu, iv) * (1 - su) * (1 - sv) + g(iu + 1, iv) * su * (1 - sv) + g(iu, iv + 1) * (1 - su) * sv + g(iu + 1, iv + 1) * su * sv;
}
function fbm(x, z, freq, oct = 3) {   // 0..1
  let h = 0, a = 1, f = freq, n = 0;
  for (let o = 0; o < oct; o++) { h += vnoise(x / SIZE * P * f + o * 17, z / SIZE * P * f + o * 31) * a; n += a; a *= 0.5; f *= 2.1; }
  return h / n;
}
const clamp = (v, a, b2) => Math.max(a, Math.min(b2, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ── 1) 地形 ──
const T = makeTerrainData({ size: SIZE, res: RES });
const coastZ = (x) => 1500 + (fbm(x, 777, 1.5) - 0.5) * 340;   // うねる海岸線
function baseHeight(x, z) {
  const cz = coastZ(x);
  // 扇状地: 頂点(0,-1500)h90 → 海岸h2。凹型プロファイル
  const t = clamp((z + 1500) / (cz + 1500), 0, 1);
  let h = 90 * Math.pow(1 - t, 1.35) + 2;
  if (z > cz) h = 2 - (z - cz) * 0.027;   // 海底: 沖へ沈み込む(最深≈-45)
  // 三方の山（smoothstepの裾＋fbmで稜線に起伏）
  const mN = Math.pow(smooth((-z - 1900) / 1000), 1.6) * (420 + 260 * fbm(x, -3000, 2.2));
  const seaTaper = clamp((cz - z + 500) / 1000, 0.12, 1);   // 海際は岬状に弱める
  const mW = Math.pow(smooth((-x - 2250) / 800), 1.6) * (380 + 240 * fbm(-3000, z, 2.2)) * seaTaper;
  const mE = Math.pow(smooth((x - 2250) / 800), 1.6) * (360 + 240 * fbm(3000, z, 2.2)) * seaTaper;
  const m = Math.max(mN, mW, mE);
  h += m;
  // ノイズ: 平地は控えめ・山は大きく
  h += (fbm(x, z, 6) - 0.5) * (6 + m * 0.22);
  return h;
}
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    T.heights[j * RES + i] = baseHeight(x, z);
  }
}

// ── 2) 川（掘り下げ＋水面矩形）──
// 各川: 制御点[x,z]と幅[始,終]。水位=元地形-2.5を下流へ単調減少
const RIVERS = [
  { pts: [[-750, -2500], [-950, -2050], [-1250, -1450], [-1550, -800], [-1800, -350]], w: [10, 24], endWl: null },        // 北山から
  { pts: [[-2750, -1100], [-2450, -820], [-2100, -560], [-1800, -350]], w: [8, 20], endWl: null },                        // 西山から
  { pts: [[-1800, -350], [-1860, 200], [-1950, 800], [-1900, 1450], [-1870, 2000]], w: [30, 72], endWl: -1.5, main: true }, // 合流後の本流→海
  { pts: [[2650, -500], [2520, 150], [2420, 800], [2350, 1400], [2330, 1900]], w: [8, 22], endWl: -1.5 },                 // 東の小川→海
];
const origHeights = T.heights.slice();
const riverMask = new Uint8Array(RES * RES);
function samplePath(r) {   // 12m間隔サンプル {x,z,w,wl}
  const segs = [];
  let total = 0;
  for (let i = 0; i < r.pts.length - 1; i++) { const d = Math.hypot(r.pts[i + 1][0] - r.pts[i][0], r.pts[i + 1][1] - r.pts[i][1]); segs.push(d); total += d; }
  const out = [];
  let acc = 0;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const n = Math.max(1, Math.round(segs[i] / 12));
    for (let k = 0; k < n; k++) {
      const t = k / n, tt = (acc + segs[i] * t) / total;
      out.push({ x: r.pts[i][0] + (r.pts[i + 1][0] - r.pts[i][0]) * t, z: r.pts[i][1] + (r.pts[i + 1][1] - r.pts[i][1]) * t, w: r.w[0] + (r.w[1] - r.w[0]) * tt, tt });
    }
    acc += segs[i];
  }
  out.push({ x: r.pts.at(-1)[0], z: r.pts.at(-1)[1], w: r.w[1], tt: 1 });
  // 水位: 元地形-2.5 → 単調減少、指定があれば終端水位へ寄せる
  let wl = Infinity;
  for (const s of out) { wl = Math.min(wl, heightAt({ size: SIZE, res: RES, heights: origHeights }, s.x, s.z) - 2.5); s.wl = wl; }
  if (r.endWl != null) { const wlEnd = r.endWl, wl0 = out[0].wl; for (const s of out) s.wl = Math.min(s.wl, wl0 + (wlEnd - wl0) * smooth(s.tt * 1.15)); }
  return out;
}
const riverSamples = [];   // 植生・色付け用に全サンプル保持
for (const r of RIVERS) {
  const samples = samplePath(r);
  riverSamples.push(...samples);
  for (const s of samples) {   // 掘り下げ: 平底＋スムーズな肩
    const depth = 2.2 + s.w * 0.06, bed = s.wl - depth;
    const inner = s.w / 2 + 6, R = s.w / 2 + 30;
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
  // 水面: 経路を80mチャンクに割った軸平行矩形。回廊の地形は水面下へクランプ（岸あふれ防止）
  let chunk = [samples[0]];
  const flushChunk = () => {
    if (chunk.length < 2) return;
    const xs = chunk.map((s) => s.x), zs = chunk.map((s) => s.z);
    const w = Math.max(...chunk.map((s) => s.w));
    const level = Math.min(...chunk.map((s) => s.wl)) - 0.1;
    if (level < 0.15 && chunk[0].z > 1200) return;   // 海面(0)以下は海の矩形に任せる
    water.push({ x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), z: Math.round((Math.min(...zs) + Math.max(...zs)) / 2), w: Math.round(Math.max(...xs) - Math.min(...xs) + w + 4), d: Math.round(Math.max(...zs) - Math.min(...zs) + w + 4), level: +level.toFixed(2) });
    for (const s of chunk) {   // クランプ
      const rr = s.w / 2 + 14;
      const i0 = clamp(Math.floor(((s.x - rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), i1 = clamp(Math.ceil(((s.x + rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      const j0 = clamp(Math.floor(((s.z - rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), j1 = clamp(Math.ceil(((s.z + rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
        if (Math.hypot(x - s.x, z - s.z) < rr && T.heights[j * RES + i] > level - 0.8) { T.heights[j * RES + i] = level - 0.8; riverMask[j * RES + i] = 1; }
      }
    }
  };
  var water = water || [];
  let cs = samples[0];
  for (const s of samples.slice(1)) {
    chunk.push(s);
    if (Math.hypot(s.x - cs.x, s.z - cs.z) > 80) { flushChunk(); chunk = [s]; cs = s; }
  }
  flushChunk();
}
water.push({ x: 0, z: 2380, w: SIZE, d: 1640, level: 0 });   // 海

// ── 3) 配色 ──
autoColorize(T);
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    const h = T.heights[j * RES + i], o = (j * RES + i) * 3, cz = coastZ(x);
    if (h < 0 && z > cz - 400) {   // 海底: 砂→深い青灰
      const t = clamp(-h / 42, 0, 1);
      T.colors[o] = 180 - 128 * t; T.colors[o + 1] = 170 - 106 * t; T.colors[o + 2] = 140 - 62 * t;
    } else if (z > cz - 260 && h < 4.5) {   // 砂浜
      T.colors[o] = 198; T.colors[o + 1] = 182; T.colors[o + 2] = 142;
    } else if (riverMask[j * RES + i]) {    // 川の河原・川底
      T.colors[o] = 118; T.colors[o + 1] = 110; T.colors[o + 2] = 88;
    }
  }
}

// ── 4) 植生（山＋川沿い）──
const FRES = 400, FCELL = 16;
const forest = new Uint8Array(FRES * FRES);
const hAt = (x, z) => heightAt(T, x, z);
for (let j = 0; j < FRES; j++) {
  for (let i = 0; i < FRES; i++) {
    const x = (i + 0.5) * FCELL - HALF, z = (j + 0.5) * FCELL - HALF;
    const h = hAt(x, z);
    if (h < 1.5 || z > coastZ(x) - 60) continue;
    if (Math.abs(x) < 720 && Math.abs(z) < 720) continue;                       // 中心街
    if (Math.abs(x + 1450) < 340 && Math.abs(z - 40) < 340) continue;           // 西郊外
    if (Math.abs(x - 1700) < 340 && Math.abs(z + 40) < 340) continue;           // 東郊外
    const slope = Math.max(Math.abs(hAt(x + 16, z) - hAt(x - 16, z)), Math.abs(hAt(x, z + 16) - hAt(x, z - 16))) / 32;
    let den = 0;
    const mf = clamp((h - 130) / 110, 0, 1) * clamp((1.15 - slope) / 1.0, 0, 1);
    if (mf > 0) den = 200 * mf * (0.55 + 0.45 * fbm(x, z, 5));
    let nearRiver = false;   // 川沿いの緑地帯
    for (const s of riverSamples) { const d = Math.hypot(x - s.x, z - s.z); if (d > s.w / 2 + 10 && d < s.w / 2 + 48) { nearRiver = true; break; } }
    if (nearRiver && h < 110 && h > 1.5) den = Math.max(den, 62 * (0.5 + 0.5 * fbm(x + 999, z, 7)));
    forest[j * FRES + i] = Math.round(clamp(den, 0, 255));
  }
}

// ── 5) 道路網（直線・90°交差・交差点=制御点共有）──
// 軸平行セグメントを集め、他セグメントとの交点/接点を制御点として折れ線化する
const segs = [];   // {x1,z1,x2,z2,kind}
function districtGrid(cx, cz, lines) { for (const L of lines) segs.push({ x1: cx + L[0], z1: cz + L[1], x2: cx + L[2], z2: cz + L[3], kind: L[4] }); }
// 中心街(原点): 大通り十字＋街路±240/±480＋路地±120(コア内)
{
  const S = 520, lines = [];
  lines.push([0, -S, 0, S, 'avenue'], [-S, 0, S, 0, 'avenue']);
  for (const p of [-480, -240, 240, 480]) { lines.push([p, -S, p, S, 'street'], [-S, p, S, p, 'street']); }
  for (const p of [-120, 120]) { lines.push([p, -240, p, 240, 'alley'], [-240, p, 240, p, 'alley']); }
  districtGrid(0, 0, lines);
}
// 郊外(西/東): 小さな格子
for (const [cx, cz] of [[-1450, 40], [1700, -40]]) {
  const S = 240, lines = [];
  for (const p of [-120, 0, 120]) { lines.push([p, -S, p, S, 'street'], [-S, p, S, p, 'street']); }
  districtGrid(cx, cz, lines);
}
// 軸平行セグメント → 交点付き折れ線
const EPS = 0.01;
const roads = [];
for (const a of segs) {
  const vert = Math.abs(a.x1 - a.x2) < EPS;
  const ts = new Set([vert ? a.z1 : a.x1, vert ? a.z2 : a.x2]);
  for (const b2 of segs) {
    if (b2 === a) continue;
    const bv = Math.abs(b2.x1 - b2.x2) < EPS;
    if (vert === bv) continue;
    if (vert) {   // a=縦線x固定, b=横線z固定
      const bx0 = Math.min(b2.x1, b2.x2), bx1 = Math.max(b2.x1, b2.x2);
      const az0 = Math.min(a.z1, a.z2), az1 = Math.max(a.z1, a.z2);
      if (a.x1 >= bx0 - EPS && a.x1 <= bx1 + EPS && b2.z1 >= az0 - EPS && b2.z1 <= az1 + EPS) ts.add(b2.z1);
    } else {
      const bz0 = Math.min(b2.z1, b2.z2), bz1 = Math.max(b2.z1, b2.z2);
      const ax0 = Math.min(a.x1, a.x2), ax1 = Math.max(a.x1, a.x2);
      if (b2.x1 >= ax0 - EPS && b2.x1 <= ax1 + EPS && a.z1 >= bz0 - EPS && a.z1 <= bz1 + EPS) ts.add(b2.x1);
    }
  }
  const sorted = [...ts].sort((p, q) => p - q);
  roads.push({ kind: a.kind, points: sorted.map((t) => (vert ? [a.x1, t] : [t, a.z1])) });
}
// 接続道路（端点は既存線の端点/線上と正確に一致させて交差点にする）
roads.push({ kind: 'avenue', points: [[-1210, 40], [-880, 20], [-520, 0]] });        // 西郊外→中心
roads.push({ kind: 'avenue', points: [[520, 0], [1000, -20], [1460, -40]] });        // 中心→東郊外
roads.push({ kind: 'street', points: [[0, 520], [0, 1150]] });                       // 中心→海岸通り
roads.push({ kind: 'street', points: [[-1200, 1150], [0, 1150], [2000, 1150]] });    // 海岸通り
roads.push({ kind: 'street', points: [[0, -520], [0, -1150]] });                     // 中心→北の山麓

// ── 6) 建物差分（郊外中心に中層ビルを若干）──
const added = [];
{
  const models = ['building-a', 'building-c', 'building-e', 'building-g', 'building-b', 'building-f'];
  const offs = [[60, 62], [-60, 62], [62, -60], [-62, -60], [180, 62], [-180, -62]];
  const rng = mulberry(SEED + 7);
  for (const [cx, cz] of [[-1450, 40], [1700, -40]]) {
    offs.forEach((o, i) => added.push({ kit: 'city', model: models[i], tier: 'mid', x: cx + o[0], z: cz + o[1], ry: Math.floor(rng() * 4) * Math.PI / 2, s: 1 }));
  }
}

// ── 出力 ──
const out = {
  format: 'city-map', version: 1, name: 'floz',
  terrain: serializeTerrain(T),
  roads, osmRoads: false,
  buildings: { seed: 20260706, removed: [], moved: {}, added },
  water,
  forest: { cell: FCELL, res: FRES, yOff: 0, model: 'fantasy_GLB format/tree-high-round.glb', treeH: 20, data: b64(forest) },
};
const dest = path.join(root, 'public', 'maps', 'floz.map.json');
fs.writeFileSync(dest, JSON.stringify(out));
// ── 検証 ──
const g = buildRoadGraph(roads);
let hMin = 1e9, hMax = -1e9; for (const h of T.heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
let fCells = 0; for (const d of forest) if (d > 0) fCells++;
console.log('wrote:', dest, (fs.statSync(dest).size / 1024).toFixed(0) + 'KB');
console.log('terrain h:', hMin.toFixed(1), '..', hMax.toFixed(1));
console.log('roads:', roads.length, 'splines →', g.nodes.size, 'nodes /', g.edges.length, 'edges');
console.log('water rects:', water.length, '/ forest cells:', fCells, '/ added bld:', added.length);
