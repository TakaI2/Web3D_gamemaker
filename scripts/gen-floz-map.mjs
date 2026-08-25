// gen-floz-map.mjs — 新マップ「floz」を mapplan.txt のルールから決定的に生成する。
// 方位: 北=-Z(山) / 西=-X(山) / 東=+X(山) / 南=+Z(海)。地形257²・6400m。
// 出力: public/maps/floz.map.json（format city-map ＋ bridges 拡張）
// v2: 街路を階層化して高密度に（大通り格子→セル毎の街路→中心部の路地・袋小路）、
//     川・海・山裾で自動クリップ、大通りが川を跨ぐ所は橋サイトとして bridges[] に出力。
//     川/海に被る自動配置建物は同一シード再現で instanceId を removed へ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTerrainData, heightAt, autoColorize, serializeTerrain, b64, buildRoadGraph } from '../lib/terrain.js';
import { generateBuildings, instanceId } from '../lib/kenney-buildings.js';

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
const hash2 = (a, b2) => ((a * 73856093) ^ (b2 * 19349663) ^ SEED) >>> 0;
const P = 96, grid = new Float32Array((P + 1) * (P + 1));
{ const rng = mulberry(SEED); for (let i = 0; i < grid.length; i++) grid[i] = rng(); }
function vnoise(u, v) {
  u = ((u % P) + P) % P; v = ((v % P) + P) % P;
  const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const g = (a, b2) => grid[(b2 % (P + 1)) * (P + 1) + (a % (P + 1))];
  return g(iu, iv) * (1 - su) * (1 - sv) + g(iu + 1, iv) * su * (1 - sv) + g(iu, iv + 1) * (1 - su) * sv + g(iu + 1, iv + 1) * su * sv;
}
function fbm(x, z, freq, oct = 3) {
  let h = 0, a = 1, f = freq, n = 0;
  for (let o = 0; o < oct; o++) { h += vnoise(x / SIZE * P * f + o * 17, z / SIZE * P * f + o * 31) * a; n += a; a *= 0.5; f *= 2.1; }
  return h / n;
}
const clamp = (v, a, b2) => Math.max(a, Math.min(b2, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ── 1) 地形 ──
const T = makeTerrainData({ size: SIZE, res: RES });
const coastZ = (x) => 1500 + (fbm(x, 777, 1.5) - 0.5) * 340;
// 山＝「峰の連なり」: 稜線ポリラインに沿って高低差のある峰(ガウス山)を蛇行配置し、max合成で尾根と鞍部を作る
const peaks = [];
{
  const rng = mulberry(SEED + 99);
  const chain = (x0, z0, x1, z1, n, jit, hLo, hHi, rLo, rHi, px, pz) => {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = x0 + (x1 - x0) * t + (rng() - 0.5) * 2 * jit * px;
      const z = z0 + (z1 - z0) * t + (rng() - 0.5) * 2 * jit * pz;
      const h = hLo + (hHi - hLo) * (0.2 + 0.8 * rng());   // 高い峰・低い峰を混在
      const r = rLo + (rHi - rLo) * rng();
      peaks.push({ x, z, h, r });
    }
  };
  chain(-2700, -2100, 2700, -2450, 15, 330, 260, 780, 260, 470, 0, 1);   // 北の稜線
  chain(-2600, -1950, -2400, 1150, 10, 290, 230, 650, 240, 430, 1, 0);   // 西の稜線
  chain(2550, -1950, 2450, 1100, 10, 290, 230, 630, 240, 430, 1, 0);     // 東の稜線
  for (let i = 0; i < 14; i++) {   // 山裾の小丘（前山）＝裾野の起伏
    const side = rng();
    let x, z;
    if (side < 0.5) { x = -2300 + rng() * 4600; z = -1750 - rng() * 350; }
    else if (side < 0.75) { x = -2250 - rng() * 200; z = -1500 + rng() * 2300; }
    else { x = 2250 + rng() * 200; z = -1500 + rng() * 2300; }
    peaks.push({ x, z, h: 100 + rng() * 130, r: 150 + rng() * 130 });
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

// ── 2) 川（掘り下げ＋水面矩形）──
const RIVERS = [
  { pts: [[-750, -2500], [-950, -2050], [-1250, -1450], [-1550, -800], [-1800, -350]], w: [10, 24], endWl: null },
  { pts: [[-2750, -1100], [-2450, -820], [-2100, -560], [-1800, -350]], w: [8, 20], endWl: null },
  { pts: [[-1800, -350], [-1860, 200], [-1950, 800], [-1900, 1450], [-1870, 2000]], w: [30, 72], endWl: -1.5, main: true },
  { pts: [[420, -1650], [310, -950], [390, -300], [300, 320], [380, 900], [330, 1450], [310, 2000]], w: [26, 58], endWl: -1.5 },   // 中央の川（市街を貫く広め）
  { pts: [[2650, -500], [2520, 150], [2420, 800], [2350, 1400], [2330, 1900]], w: [8, 22], endWl: -1.5 },
];
const origHeights = T.heights.slice();
const riverMask = new Uint8Array(RES * RES);
const water = [];
function samplePath(r) {
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
  let wl = Infinity;
  for (const s of out) { wl = Math.min(wl, heightAt({ size: SIZE, res: RES, heights: origHeights }, s.x, s.z) - 2.5); s.wl = wl; }
  if (r.endWl != null) { const wlEnd = r.endWl, wl0 = out[0].wl; for (const s of out) s.wl = Math.min(s.wl, wl0 + (wlEnd - wl0) * smooth(s.tt * 1.15)); }
  return out;
}
const riverSamples = [];
for (const r of RIVERS) {
  const samples = samplePath(r);
  riverSamples.push(...samples);
  for (const s of samples) {
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
  let chunk = [samples[0]], cs = samples[0];
  const flushChunk = () => {
    if (chunk.length < 2) return;
    const xs = chunk.map((s) => s.x), zs = chunk.map((s) => s.z);
    const w = Math.max(...chunk.map((s) => s.w));
    const level = Math.min(...chunk.map((s) => s.wl)) - 0.1;
    if (level < 0.15 && chunk[0].z > 1200) return;
    water.push({ x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), z: Math.round((Math.min(...zs) + Math.max(...zs)) / 2), w: Math.round(Math.max(...xs) - Math.min(...xs) + w + 4), d: Math.round(Math.max(...zs) - Math.min(...zs) + w + 4), level: +level.toFixed(2) });
    for (const s of chunk) {
      const rr = s.w / 2 + 14;
      const i0 = clamp(Math.floor(((s.x - rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), i1 = clamp(Math.ceil(((s.x + rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      const j0 = clamp(Math.floor(((s.z - rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1), j1 = clamp(Math.ceil(((s.z + rr) / SIZE + 0.5) * (RES - 1)), 0, RES - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
        if (Math.hypot(x - s.x, z - s.z) < rr && T.heights[j * RES + i] > level - 0.8) { T.heights[j * RES + i] = level - 0.8; riverMask[j * RES + i] = 1; }
      }
    }
  };
  for (const s of samples.slice(1)) {
    chunk.push(s);
    if (Math.hypot(s.x - cs.x, s.z - cs.z) > 80) { flushChunk(); chunk = [s]; cs = s; }
  }
  flushChunk();
}
for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 2; iz++) water.push({ x: -2400 + ix * 1600, z: 1970 + iz * 820, w: 1600, d: 820, level: 0 });   // 海（4x2分割=近景マテリアルの範囲を絞る）

// ── 共通ヘルパ（川回廊への距離・地形適性）──
const RCELL = 64, RHASH = new Map();
for (const s of riverSamples) {
  const k = Math.floor(s.x / RCELL) + '_' + Math.floor(s.z / RCELL);
  if (!RHASH.has(k)) RHASH.set(k, []);
  RHASH.get(k).push(s);
}
function riverAt(x, z) {   // 回廊外周までの距離（負=川の中）と最寄りサンプル
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
function cityOk(x, z) {   // 道路・建物を置ける地形か
  const h = hAt(x, z);
  if (h < 1.5 || h > 95) return false;
  if (z > coastZ(x) - 110) return false;
  return slopeAt(x, z) < 0.42;
}

// ── 2.5) 埠頭（中央の川の河口の東側。海へ張り出す平らなコンクリ地盤）──
const WHARF = { x0: 470, x1: 1360, z0: 1420, z1: 1720, h: 2.6 };
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    if (x < WHARF.x0 || x > WHARF.x1 || z < WHARF.z0 - 60 || z > WHARF.z1) continue;
    const idx = j * RES + i;
    if (z >= WHARF.z0) T.heights[idx] = WHARF.h;                                    // 本体=完全フラット
    else T.heights[idx] = T.heights[idx] + (WHARF.h - T.heights[idx]) * smooth((z - (WHARF.z0 - 60)) / 60);   // 北側は緩くすり付け
  }
}
const inWharf = (x, z) => (x > WHARF.x0 - 10 && x < WHARF.x1 + 10 && z > WHARF.z0 - 45 && z < WHARF.z1)
  || (z > 1140 && z <= WHARF.z0 && (Math.abs(x - 620) < 25 || Math.abs(x - 1150) < 25));   // 接続路の回廊

// ── 3) 道路網（大通り格子→セル毎の街路→中心部の路地。川・海・山裾でクリップ、大通りの川越え=橋）──
const NS_ART = [-2050, -1250, -600, 0, 620, 1250, 1850];
const EW_ART = [-1100, -550, 0, 560, 1150];
const X_MIN = -2150, X_MAX = 2150, Z_MIN = -1600, Z_MAX = 1360;
const WS = [-1450, 40], ES = [1700, -40];   // 郊外(将来の駅前)
const segs = [];
for (const x of NS_ART) segs.push({ x1: x, z1: Z_MIN, x2: x, z2: Z_MAX, kind: 'avenue' });
for (const z of EW_ART) segs.push({ x1: X_MIN, z1: z, x2: X_MAX, z2: z, kind: 'avenue' });
// セル毎の街路（間隔はゾーンで変える・ジッタ付き＝隣セルと揃わない入り組み）
const XB = [X_MIN, ...NS_ART, X_MAX].sort((a, b2) => a - b2);
const ZB = [Z_MIN, ...EW_ART, Z_MAX].sort((a, b2) => a - b2);
function targetSpacing(cx, cz) {
  const dc = Math.hypot(cx, cz);
  let t = dc < 800 ? 140 : dc < 1600 ? 165 : 195;
  for (const S of [WS, ES]) if (Math.hypot(cx - S[0], cz - S[1]) < 520) t = Math.min(t, 125);
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
    // 路地: 全域でサブブロックを再帰分割（郊外を一番細かく＝密集感）。30%は袋小路で打ち切り
    const dc = Math.hypot(cx, cz);
    const nearSta = [WS, ES].some((S) => Math.hypot(cx - S[0], cz - S[1]) < 520);
    const minB = nearSta ? 78 : dc < 900 ? 95 : dc < 1700 ? 85 : 105;
    const xs2 = [x0, ...sx, x1].sort((a, b2) => a - b2), zs2 = [z0, ...sz, z1].sort((a, b2) => a - b2);
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
// 埠頭の直線道路（周回＋中通り）と海岸大通り(z=1150)からの接続路
segs.push({ x1: 520, z1: 1470, x2: 1310, z2: 1470, kind: 'street' });
segs.push({ x1: 520, z1: 1660, x2: 1310, z2: 1660, kind: 'street' });
segs.push({ x1: 520, z1: 1470, x2: 520, z2: 1660, kind: 'street' });
segs.push({ x1: 1310, z1: 1470, x2: 1310, z2: 1660, kind: 'street' });
segs.push({ x1: 900, z1: 1470, x2: 900, z2: 1660, kind: 'street' });
segs.push({ x1: 620, z1: 1150, x2: 620, z2: 1470, kind: 'street' });
segs.push({ x1: 1150, z1: 1150, x2: 1150, z2: 1470, kind: 'street' });
// クリップ: 10m刻みで 地形OK/川/不可 を判定 → OK区間へ分割。大通りの短い川越え区間は橋として残す
const bridges = [];
const pieces = [];
for (const sg of segs) {
  const vert = sg.x1 === sg.x2;
  const len = Math.abs(vert ? sg.z2 - sg.z1 : sg.x2 - sg.x1);
  const n = Math.max(2, Math.round(len / 10));
  const cls = [];   // 0=OK 1=川 2=不可
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = sg.x1 + (sg.x2 - sg.x1) * t, z = sg.z1 + (sg.z2 - sg.z1) * t;
    const rv = riverAt(x, z);
    cls.push(rv.d <= 6 ? 1 : (cityOk(x, z) || inWharf(x, z)) ? 0 : 2);
  }
  if (sg.kind === 'avenue') {   // 川区間が240m未満で両側がOKなら橋化（クラスを0に書き戻し＋橋サイト記録）
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
        const deckY = +(Math.max(hAt(e1x, e1z), hAt(e2x, e2z), (rv.s ? rv.s.wl : 0) + (kindB === 'arch' ? 4 : 2.4)) + 0.35).toFixed(2);
        bridges.push({ x: Math.round(mx), z: Math.round(mz), dx: dirX, dz: dirZ, len: Math.round(bl), w: kindB === 'arch' ? 13 : 8, kind: kindB, deckY, wl: +(rv.s ? rv.s.wl : 0).toFixed(2), bedY: +((rv.s ? rv.s.wl : 0) - (2.2 + (rv.s ? rv.s.w : 20) * 0.06)).toFixed(2) });
        for (let k = i; k < j2; k++) cls[k] = 0;
      }
      i = j2;
    }
  }
  let i = 0;   // OK区間→ピース
  while (i <= n) {
    if (cls[i] !== 0) { i++; continue; }
    let j2 = i;
    while (j2 <= n && cls[j2] === 0) j2++;
    const t0 = i / n, t1 = Math.min(1, (j2 - 1) / n);
    const px1 = Math.round(sg.x1 + (sg.x2 - sg.x1) * t0), pz1 = Math.round(sg.z1 + (sg.z2 - sg.z1) * t0);
    const px2 = Math.round(sg.x1 + (sg.x2 - sg.x1) * t1), pz2 = Math.round(sg.z1 + (sg.z2 - sg.z1) * t1);
    const plen = Math.hypot(px2 - px1, pz2 - pz1);
    if (plen >= (sg.kind === 'alley' ? 60 : 80)) pieces.push({ x1: px1, z1: pz1, x2: px2, z2: pz2, kind: sg.kind });
    i = j2;
  }
}
// 大通りの端は150mだけ通常の街路へ落とす（ランタイムが road-split で車線を合流させる遷移点になる）
const pieces1 = [];
for (const p of pieces) {
  const len = Math.hypot(p.x2 - p.x1, p.z2 - p.z1);
  if (p.kind !== 'avenue' || len < 520) { pieces1.push(p); continue; }
  const ux = (p.x2 - p.x1) / len, uz = (p.z2 - p.z1) / len, TAPER = 150;
  const ax = Math.round(p.x1 + ux * TAPER), az = Math.round(p.z1 + uz * TAPER);
  const bx = Math.round(p.x2 - ux * TAPER), bz = Math.round(p.z2 - uz * TAPER);
  pieces1.push({ x1: p.x1, z1: p.z1, x2: ax, z2: az, kind: 'street' });
  pieces1.push({ x1: ax, z1: az, x2: bx, z2: bz, kind: 'avenue' });
  pieces1.push({ x1: bx, z1: bz, x2: p.x2, z2: p.z2, kind: 'street' });
}
pieces.length = 0;
pieces.push(...pieces1);
// ── 3.2) 駅前ロータリー: 八角形の環道＋既存街路への接続腕（腕は交点パスに入れて格子と接続）──
const rotaries = [];
{
  const R_ROT = 24;
  for (const [sx, sz] of [[-1450, 45], [0, -145], [1700, -160]]) {   // 駅前広場（西/中央/東）
    const findV = (dir) => {   // 最寄りの縦ピース（東西の腕の接続先）
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
    const findH = (dir) => {   // 最寄りの横ピース（南北の腕の接続先）
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
    if ((east ? 1 : 0) + (west ? 1 : 0) + (north ? 1 : 0) + (south ? 1 : 0) < 2) continue;   // 2方向以上つながる時だけ
    if (east) pieces.push({ x1: sx + R_ROT, z1: sz, x2: east, z2: sz, kind: 'street' });
    if (west) pieces.push({ x1: west, z1: sz, x2: sx - R_ROT, z2: sz, kind: 'street' });
    if (north) pieces.push({ x1: sx, z1: north, x2: sx, z2: sz - R_ROT, kind: 'street' });
    if (south) pieces.push({ x1: sx, z1: sz + R_ROT, x2: sx, z2: south, kind: 'street' });
    rotaries.push({ x: sx, z: sz, r: R_ROT });
  }
}
// ピース同士の交点/接点を制御点にして折れ線化
const EPS = 0.01;
const roads = [];
for (const a of pieces) {
  const vert = Math.abs(a.x1 - a.x2) < EPS;
  const ts = new Set([vert ? a.z1 : a.x1, vert ? a.z2 : a.x2]);
  for (const b2 of pieces) {
    if (b2 === a) continue;
    const bv = Math.abs(b2.x1 - b2.x2) < EPS;
    if (vert === bv) continue;
    if (vert) {
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
for (const ro of rotaries) {   // 環道（八角形・閉路）。頂点は東西南北＝接続腕の端点と完全一致してノード共有
  const pts = [];
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push([Math.round(ro.x + Math.cos(a) * ro.r), Math.round(ro.z + Math.sin(a) * ro.r)]); }
  roads.push({ kind: 'street', closed: true, points: pts });
}

// ── 3.5) 鉄道（東西複線・郊外=地上/シティセントラル=高架・駅3つ。高さは10mサンプルで焼き込み）──
const RAIL_PTS = [[-2150, -20], [-1750, -30], [-1450, -40], [-1000, -55], [-500, -65], [0, -70], [500, -65], [1100, -75], [1700, -90], [2150, -90]];
const railSamples = [];
for (let i = 0; i < RAIL_PTS.length - 1; i++) {
  const [ax, az] = RAIL_PTS[i], [bx, bz] = RAIL_PTS[i + 1];
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 10));
  for (let k = 0; k < n; k++) railSamples.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n });
}
railSamples.push({ x: RAIL_PTS.at(-1)[0], z: RAIL_PTS.at(-1)[1] });
{   // 端は山裾で打ち切り（地形の高い区間には敷かない＝終端駅が山麓になる）
  let s0 = 0, s1 = railSamples.length - 1;
  while (s0 < s1 && hAt(railSamples[s0].x, railSamples[s0].z) > 55) s0++;
  while (s1 > s0 && hAt(railSamples[s1].x, railSamples[s1].z) > 55) s1--;
  railSamples.splice(s1 + 1);
  railSamples.splice(0, s0);
}
for (const s of railSamples) {
  const ter = hAt(s.x, s.z);
  let y = ter + 0.5;                                            // 郊外=地上
  if (Math.abs(s.x) <= 850) y = Math.max(y, ter + 8);           // 中心=高架
  const rv = riverAt(s.x, s.z);
  if (rv.d < 40) y = Math.max(y, (rv.s ? rv.s.wl : 0) + 7);     // 川越え
  s.y = y;
}
for (let pass = 0; pass < 2; pass++) {   // 勾配5%制限（窪みを埋める・両方向）
  for (let i = 1; i < railSamples.length; i++) railSamples[i].y = Math.max(railSamples[i].y, railSamples[i - 1].y - 0.5);
  for (let i = railSamples.length - 2; i >= 0; i--) railSamples[i].y = Math.max(railSamples[i].y, railSamples[i + 1].y - 0.5);
}
for (let pass = 0; pass < 3; pass++) for (let i = 1; i < railSamples.length - 1; i++) railSamples[i].y = (railSamples[i - 1].y + railSamples[i].y * 2 + railSamples[i + 1].y) / 4;
const stations = [
  { x: -1450, z: -40, name: '西フローゼ' },
  { x: 0, z: -70, name: 'シティセントラル' },
  { x: 1700, z: -90, name: '東フローゼ' },
];
const rails = [{ points: railSamples.map((s) => [Math.round(s.x), Math.round(s.z), +s.y.toFixed(2)]), gauge: 5.2, stations }];

// ── 4) 植生（山＋川沿い。道路の近くは生やさない）──
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

// ── 5) 建物差分（郊外中心の中層ビル追加＋川/海/急斜面/橋に被る自動配置の除外）──
const added = [];
{
  const models = ['building-a', 'building-c', 'building-e', 'building-g', 'building-b', 'building-f'];
  const offs = [[60, 62], [-60, 62], [62, -60], [-62, -60], [180, 62], [-180, -62]];
  const rng = mulberry(SEED + 7);
  for (const [cx, cz] of [WS, ES]) {
    offs.forEach((o, i) => added.push({ kit: 'city', model: models[i], tier: 'mid', x: cx + o[0], z: cz + o[1], ry: Math.floor(rng() * 4) * Math.PI / 2, s: 1 }));
  }
  // 埠頭の工業建物（通常の建物パイプライン=破壊可能）
  const IND = ['building-e', 'building-g', 'building-k', 'building-i', 'building-q'];
  let ii = 0;
  const put = (x, z, ry) => added.push({ kit: 'industrial', model: IND[ii++ % IND.length], tier: 'mid', x, z, ry, s: 1 });
  for (const x of [560, 690, 820, 1000, 1120, 1250]) put(x, 1502, Math.PI);   // 北通り南側
  for (const x of [640, 850, 1080, 1240]) put(x, 1438, 0);                    // 北通り北側
  for (const x of [570, 760, 970, 1170, 1290]) put(x, 1628, 0);               // 海側通り北側
}
const g = buildRoadGraph(roads);
const genEdges = g.edges.map(([aId, bId]) => { const A = g.nodes.get(aId), B = g.nodes.get(bId); return [A.x, 0, A.z, B.x, 0, B.z]; });
const BLD_PARAMS = { spacing: 12 };   // 道路沿いの建物間隔を詰める（ランタイムにも params で渡す）
const gen = generateBuildings(genEdges, { seed: 20260706, ...BLD_PARAMS });

// ── 5.4) 公園（郊外の家々の大きな隙間を検出→生垣公園に。ランタナ buildParks が生垣/ゲート/噴水/ランタンを配置）──
const parks = [];
const parkRects = [];   // 建物除外用の [x0,x1,z0,z1]
{
  const RPC = 32, RP = new Map();   // 道路サンプルの位置ハッシュ（最近傍距離用）
  for (const e2 of genEdges) {
    const L = Math.hypot(e2[3] - e2[0], e2[5] - e2[2]), n = Math.max(1, Math.round(L / 10));
    for (let i = 0; i <= n; i++) {
      const x = e2[0] + (e2[3] - e2[0]) * i / n, z = e2[2] + (e2[5] - e2[2]) * i / n;
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
  for (let gz = -1500; gz <= 1250 && parks.length < 90; gz += 60) {
    for (let gx = -2050; gx <= 2050 && parks.length < 90; gx += 60) {
      const x = gx + Math.round((rngP() - 0.5) * 30), z = gz + Math.round((rngP() - 0.5) * 30);
      if (Math.hypot(x, z) < 1000) continue;                       // 郊外のみ（中心街は高密度のまま）
      if (!cityOk(x, z) || riverAt(x, z).d < 30 || z > coastZ(x) - 150) continue;
      let near = false;
      for (const s of railSamples) if (Math.hypot(x - s.x, z - s.z) < 42) { near = true; break; }
      if (near) continue;
      const rd = roadDist(x, z);
      if (rd < 24 || rd > 70) continue;                            // 区画内側の「大きな隙間」だけ
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
for (const it of gen.instances) {
  const rv = riverAt(it.x, it.z);
  let bad = rv.d < 6 || hAt(it.x, it.z) < 1.6 || slopeAt(it.x, it.z) > 0.5 || it.z > coastZ(it.x) - 90;
  if (!bad && it.z > WHARF.z0 - 50 && it.x > WHARF.x0 - 20 && it.x < WHARF.x1 + 20) bad = true;   // 埠頭は工業建物(added)専用
  if (!bad) for (const br of bridges) {
    const alo = (it.x - br.x) * br.dx + (it.z - br.z) * br.dz;
    const per = -(it.x - br.x) * br.dz + (it.z - br.z) * br.dx;
    if (Math.abs(alo) < br.len / 2 + 12 && Math.abs(per) < 16) { bad = true; break; }
  }
  if (!bad) for (const s of railSamples) if (Math.hypot(it.x - s.x, it.z - s.z) < 14) { bad = true; break; }   // 線路敷
  if (!bad) for (const st2 of stations) if (Math.hypot(it.x - st2.x, it.z - st2.z) < 44) { bad = true; break; } // 駅前広場
  if (!bad) for (const r2 of parkRects) if (it.x > r2[0] && it.x < r2[1] && it.z > r2[2] && it.z < r2[3]) { bad = true; break; }   // 公園内
  if (!bad) for (const ro of rotaries) if (Math.hypot(it.x - ro.x, it.z - ro.z) < ro.r + 14) { bad = true; break; }   // ロータリー

  if (bad) removed.push(instanceId(it));
}

// ── 出力 ──
autoColorize(T);
for (let j = 0; j < RES; j++) {
  for (let i = 0; i < RES; i++) {
    const x = (i / (RES - 1) - 0.5) * SIZE, z = (j / (RES - 1) - 0.5) * SIZE;
    const h = T.heights[j * RES + i], o = (j * RES + i) * 3, cz = coastZ(x);
    if (h > 1 && z > WHARF.z0 - 8 && z < WHARF.z1 + 4 && x > WHARF.x0 - 4 && x < WHARF.x1 + 4) {
      T.colors[o] = 148; T.colors[o + 1] = 150; T.colors[o + 2] = 154;   // 埠頭=コンクリ
    } else if (h < 0 && z > cz - 400) {
      const t = clamp(-h / 42, 0, 1);
      T.colors[o] = 180 - 128 * t; T.colors[o + 1] = 170 - 106 * t; T.colors[o + 2] = 140 - 62 * t;
    } else if (z > cz - 260 && h < 4.5) {
      T.colors[o] = 198; T.colors[o + 1] = 182; T.colors[o + 2] = 142;
    } else if (riverMask[j * RES + i]) {
      T.colors[o] = 118; T.colors[o + 1] = 110; T.colors[o + 2] = 88;
    }
  }
}
const out = {
  format: 'city-map', version: 1, name: 'floz',
  terrain: serializeTerrain(T),
  roads, osmRoads: false,
  bridges,
  rails,
  parks,
  rotaries,
  port: {
    rect: [WHARF.x0, WHARF.z0, WHARF.x1, WHARF.z1], h: WHARF.h,
    containers: [{ x0: 560, x1: 830, z: 1697 }, { x0: 960, x1: 1300, z: 1697 }],
    ship: { x: 900, z: WHARF.z1, len: 150 },
  },
  buildings: { seed: 20260706, removed, moved: {}, added, params: BLD_PARAMS },
  water,
  forest: { cell: FCELL, res: FRES, yOff: 0, model: 'fantasy_GLB format/tree-high-round.glb', treeH: 20, data: b64(forest) },
};
const dest = path.join(root, 'public', 'maps', 'floz.map.json');
fs.writeFileSync(dest, JSON.stringify(out));
// ── 検証 ──
let hMin = 1e9, hMax = -1e9; for (const h of T.heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
let fCells = 0; for (const d of forest) if (d > 0) fCells++;
let roadKm = 0; for (const e of genEdges) roadKm += Math.hypot(e[3] - e[0], e[5] - e[2]) / 1000;
console.log('wrote:', dest, (fs.statSync(dest).size / 1024).toFixed(0) + 'KB');
console.log('terrain h:', hMin.toFixed(1), '..', hMax.toFixed(1));
console.log('roads:', roads.length, 'splines /', roadKm.toFixed(1) + 'km →', g.nodes.size, 'nodes /', g.edges.length, 'edges');
console.log('buildings:', gen.instances.length, 'auto (removed', removed.length, ') + added', added.length, '/ zones', JSON.stringify(gen.zones));
console.log('rotaries:', rotaries.length, '/ bridges:', bridges.length, bridges.map((b2) => b2.kind + '@' + b2.x + ',' + b2.z + ' L' + b2.len).join(' / '));
console.log('water rects:', water.length, '/ forest cells:', fCells, '/ parks:', parks.length);
