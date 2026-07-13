// lib/terrain.js — 編集可能ハイトマップ地形（map-editor と plateau-fly で共用）。
// three は引数注入（エディタ=WebGL / ゲーム=WebGPU の両ビルドで同一コードを使うため）。
// データ: { size(一辺m・原点中心), res(頂点数/辺), heights:Float32Array, colors:Uint8Array(RGB) }
// メッシュ: 8×8チャンク分割＝ブラシ編集時に触れたチャンクだけ更新

export const CHUNKS = 8;

export function makeTerrainData({ size = 6400, res = 257, base = 0 } = {}) {
  const heights = new Float32Array(res * res).fill(base);
  const colors = new Uint8Array(res * res * 3).fill(150);
  return { size, res, heights, colors };
}

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
// 値ノイズfbm（決定的）。丘陵〜山地の初期地形
export function noiseTerrain(data, { seed = 1, amp = 260, freq = 4, octaves = 4, plateau = 0.35 } = {}) {
  const { res, heights } = data;
  const rng = mulberry(seed);
  const P = 64, grid = new Float32Array((P + 1) * (P + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const sample = (u, v) => {   // 0..P の格子を双線形＋smoothstep
    const iu = Math.floor(u), iv = Math.floor(v);
    const fu = u - iu, fv = v - iv;
    const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
    const g = (a, b) => grid[((b % (P + 1)) * (P + 1)) + (a % (P + 1))];
    return g(iu, iv) * (1 - su) * (1 - sv) + g(iu + 1, iv) * su * (1 - sv) + g(iu, iv + 1) * (1 - su) * sv + g(iu + 1, iv + 1) * su * sv;
  };
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      let h = 0, a = 1, f = freq, norm = 0;
      for (let o = 0; o < octaves; o++) {
        h += sample(i / (res - 1) * f, j / (res - 1) * f) * a;
        norm += a; a *= 0.5; f *= 2.1;
      }
      h /= norm;
      h = Math.max(0, h - plateau) / (1 - plateau);   // 低地を平らに（街を置ける場所を作る）
      heights[j * res + i] = h * h * amp;
    }
  }
}

export function heightAt(data, x, z) {   // ワールドm → 双線形補間
  const { size, res, heights } = data;
  const fx = ((x / size) + 0.5) * (res - 1), fz = ((z / size) + 0.5) * (res - 1);
  const i = Math.max(0, Math.min(res - 2, Math.floor(fx))), j = Math.max(0, Math.min(res - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fz - j));
  const h00 = heights[j * res + i], h10 = heights[j * res + i + 1];
  const h01 = heights[(j + 1) * res + i], h11 = heights[(j + 1) * res + i + 1];
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

// ブラシ。mode: 'raise'(amount±) | 'smooth' | 'flatten'。戻り値=変更範囲（頂点index矩形）
export function sculpt(data, x, z, radius, amount, mode = 'raise') {
  const { size, res, heights } = data;
  const cell = size / (res - 1);
  const ci = ((x / size) + 0.5) * (res - 1), cj = ((z / size) + 0.5) * (res - 1);
  const r = radius / cell;
  const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(res - 1, Math.ceil(ci + r));
  const j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(res - 1, Math.ceil(cj + r));
  let target = 0;
  if (mode === 'flatten') target = heightAt(data, x, z);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - ci, j - cj) / r;
      if (d >= 1) continue;
      const w = Math.exp(-d * d * 3);   // ガウス減衰
      const k = j * res + i;
      if (mode === 'raise') heights[k] += amount * w;
      else if (mode === 'flatten') heights[k] += (target - heights[k]) * Math.min(1, Math.abs(amount) * 0.15) * w;
      else {   // smooth: 4近傍平均へ寄せる
        const il = Math.max(0, i - 1), ir = Math.min(res - 1, i + 1), ju = Math.max(0, j - 1), jd = Math.min(res - 1, j + 1);
        const avg = (heights[j * res + il] + heights[j * res + ir] + heights[ju * res + i] + heights[jd * res + i]) / 4;
        heights[k] += (avg - heights[k]) * Math.min(1, Math.abs(amount) * 0.2) * w;
      }
    }
  }
  return { i0, i1, j0, j1 };
}

export function paint(data, x, z, radius, rgb) {
  const { size, res, colors } = data;
  const cell = size / (res - 1);
  const ci = ((x / size) + 0.5) * (res - 1), cj = ((z / size) + 0.5) * (res - 1);
  const r = radius / cell;
  const i0 = Math.max(0, Math.floor(ci - r)), i1 = Math.min(res - 1, Math.ceil(ci + r));
  const j0 = Math.max(0, Math.floor(cj - r)), j1 = Math.min(res - 1, Math.ceil(cj + r));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (Math.hypot(i - ci, j - cj) > r) continue;
      const k = (j * res + i) * 3;
      colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2];
    }
  }
  return { i0, i1, j0, j1 };
}

const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const AUTO_COLOR_DEFAULT = { flat: '#8a7a5f', hill: '#4f7f47', steep: '#7d7d7d', flatMax: 80, hillMin: 120, steepSlope: 0.55 };
// 自動配色: 平地=茶 / 山=緑 / 急斜面=灰（しきい値は帯で補間）
export function autoColorize(data, rules = AUTO_COLOR_DEFAULT) {
  const { size, res, heights, colors } = data;
  const cell = size / (res - 1);
  const cFlat = hex2rgb(rules.flat), cHill = hex2rgb(rules.hill), cSteep = hex2rgb(rules.steep);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const il = Math.max(0, i - 1), ir = Math.min(res - 1, i + 1), ju = Math.max(0, j - 1), jd = Math.min(res - 1, j + 1);
      const slope = Math.hypot(heights[j * res + ir] - heights[j * res + il], heights[jd * res + i] - heights[ju * res + i]) / ((ir - il + jd - ju) * cell * 0.5) / 2;
      const h = heights[k];
      const t = Math.max(0, Math.min(1, (h - rules.flatMax) / Math.max(1, rules.hillMin - rules.flatMax)));
      let r = cFlat[0] + (cHill[0] - cFlat[0]) * t, g = cFlat[1] + (cHill[1] - cFlat[1]) * t, b = cFlat[2] + (cHill[2] - cFlat[2]) * t;
      const s = Math.max(0, Math.min(1, (slope - rules.steepSlope) / 0.25));
      r += (cSteep[0] - r) * s; g += (cSteep[1] - g) * s; b += (cSteep[2] - b) * s;
      const n = (mulNoise(i, j) - 0.5) * 14;   // わずかな色ムラ
      const o = k * 3;
      colors[o] = Math.max(0, Math.min(255, r + n));
      colors[o + 1] = Math.max(0, Math.min(255, g + n));
      colors[o + 2] = Math.max(0, Math.min(255, b + n));
    }
  }
}
function mulNoise(i, j) { let t = ((i * 73856093) ^ (j * 19349663)) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

// メッシュ化（8×8チャンク）。返り値の refreshRegion({i0,i1,j0,j1}) で部分更新
export function createTerrainMesh(THREE, data) {
  const { size, res } = data;
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const per = (res - 1) / CHUNKS;   // チャンクあたりセル数
  const chunks = [];
  const toWorld = (i) => (i / (res - 1) - 0.5) * size;
  for (let cj = 0; cj < CHUNKS; cj++) {
    for (let ci = 0; ci < CHUNKS; ci++) {
      const i0 = ci * per, j0 = cj * per, n = per + 1;
      const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), idx = [];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = true;
      group.add(mesh);
      chunks.push({ mesh, geo, i0, j0, n });
    }
  }
  const fillChunk = (ch) => {
    const { geo, i0, j0, n } = ch;
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gi = Math.min(res - 1, i0 + i), gj = Math.min(res - 1, j0 + j);
        const k = (j * n + i) * 3, src = gj * res + gi;
        pos[k] = toWorld(gi); pos[k + 1] = data.heights[src]; pos[k + 2] = toWorld(gj);
        col[k] = data.colors[src * 3] / 255; col[k + 1] = data.colors[src * 3 + 1] / 255; col[k + 2] = data.colors[src * 3 + 2] / 255;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  };
  const refreshAll = () => chunks.forEach(fillChunk);
  const refreshRegion = (rg) => {
    for (const ch of chunks) {
      if (ch.i0 > rg.i1 || ch.i0 + ch.n - 1 < rg.i0 || ch.j0 > rg.j1 || ch.j0 + ch.n - 1 < rg.j0) continue;
      fillChunk(ch);
    }
  };
  refreshAll();
  return { group, data, refreshAll, refreshRegion, heightAt: (x, z) => heightAt(data, x, z) };
}

// ── 保存/読込（heights=Uint16量子化のbase64, colors=RGBのbase64）──
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function serializeTerrain(data) {
  const { size, res, heights, colors } = data;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  if (!(hMax > hMin)) hMax = hMin + 1;
  const q = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) q[i] = Math.round((heights[i] - hMin) / (hMax - hMin) * 65535);
  return { size, res, hMin, hMax, heights: b64(new Uint8Array(q.buffer)), colors: b64(colors) };
}
export function deserializeTerrain(t) {
  const data = makeTerrainData({ size: t.size, res: t.res });
  const q = new Uint16Array(unb64(t.heights).buffer);
  for (let i = 0; i < q.length; i++) data.heights[i] = t.hMin + q[i] / 65535 * (t.hMax - t.hMin);
  data.colors.set(unb64(t.colors));
  return data;
}

// ── 道路スプラインのサンプリング（Catmull-Rom・距離適応）──
// 制御点間隔に応じてサンプル数を変える: 手描きの疎な点(200m)は滑らかに、
// OSM取込の密な点(20-40m)はほぼ1:1（グラフのノード爆発を防ぐ）
export function sampleRoadPoints(points, closed = false, step = 20) {
  const pts = points.map((q) => ({ x: q[0], z: q[1] }));
  if (pts.length < 2) return pts;
  const get = (i) => closed ? pts[((i % pts.length) + pts.length) % pts.length] : pts[Math.max(0, Math.min(pts.length - 1, i))];
  const out = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const n = Math.max(1, Math.min(12, Math.round(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step)));
    for (let s = 0; s < n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  if (!closed) out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  return out;
}

// ── 道路スプライン → グラフ（.map.json roads: [{points:[[x,z]...], closed}]）──
// サンプル点を0.5m格子キーでマージ＝制御点を吸着させた場所が交差点ノードになる。
// 戻り値は純データ: nodes Map(id -> {x, z, adj:Set<id>}), edges [[idA, idB], ...]
export function buildRoadGraph(roads, { step = 20 } = {}) {
  const nodes = new Map();
  const qz = (v) => Math.round(v * 2) / 2;
  const key = (x, z) => qz(x) + '_' + qz(z);
  const addNode = (x, z) => {
    const k = key(x, z);
    if (!nodes.has(k)) nodes.set(k, { x: qz(x), z: qz(z), adj: new Set() });
    return k;
  };
  const edges = [], seen = new Set();
  const link = (a, b) => {
    if (a === b) return;
    const ek = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(ek)) return;
    seen.add(ek);
    edges.push([a, b]);
    nodes.get(a).adj.add(b);
    nodes.get(b).adj.add(a);
  };
  for (const r of roads || []) {
    if (!r.points || r.points.length < 2) continue;
    const pts = sampleRoadPoints(r.points, !!r.closed, step);
    let prev = null;
    for (const p of pts) {
      const k = addNode(p.x, p.z);
      if (prev) link(prev, k);
      prev = k;
    }
    if (r.closed && pts.length > 2) link(prev, key(pts[0].x, pts[0].z));
  }
  return { nodes, edges };
}
