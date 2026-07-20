// map-editor.js — 脱PLATEAU用マップエディタ M1: 地形スカルプト＋ペイント＋保存/読込。
// 地形実装は lib/terrain.js（ゲームと共用）。保存 = public/maps/*.map.json
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import {
  makeTerrainData, noiseTerrain, autoColorize, createTerrainMesh,
  serializeTerrain, deserializeTerrain, sculpt, paint, AUTO_COLOR_DEFAULT, b64, unb64,
} from '../lib/terrain.js';
import { generateBuildings, instanceId, TIER_INFO } from '../lib/kenney-buildings.js';
import { buildRoadGraph, sampleRoadPoints } from '../lib/terrain.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit;
let terrain = null;          // createTerrainMesh の戻り値
let tool = 'raise';          // raise|lower|smooth|flatten|paint
let brushing = false;
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let brushMesh = null;        // ブラシ位置の円リング表示
const clock = new THREE.Clock();

function buildTerrain(data) {
  if (terrain) { scene.remove(terrain.group); terrain = null; }
  terrain = createTerrainMesh(THREE, data);
  scene.add(terrain.group);
  setStatus(`地形 ${data.size}m四方 / ${data.res}×${data.res}`);
  if (town.on) drapeTown();       // 地形を作り直したら町も追従
  if (roadEd.roads.length) renderRoads();   // 道路ラインの高さも追従
  renderVeg();                    // 植生プレビューの高さも追従
  renderParks();                  // 公園プレビューの高さも追従
}

function pickGround(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(terrain.group, true)[0];
  return hit ? hit.point : null;
}

function applyBrush(p, dt, invert) {
  const r = parseFloat($('brush-r').value);
  if (vegEd.on) { paintVeg(p, r, invert); return; }
  const s = parseFloat($('brush-s').value);
  let region = null;
  if (tool === 'paint') {
    const c = $('paint-color').value;
    region = paint(terrain.data, p.x, p.z, r, [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  } else {
    const amt = s * dt * (tool === 'lower' ? -1 : 1) * (invert ? -1 : 1) * 2.2;
    const mode = tool === 'smooth' ? 'smooth' : tool === 'flatten' ? 'flatten' : 'raise';
    region = sculpt(terrain.data, p.x, p.z, r, amt, mode);
  }
  terrain.refreshRegion(region);
}

function setTool(t) {
  tool = t;
  for (const id of ['tool-raise', 'tool-lower', 'tool-smooth', 'tool-flatten', 'tool-paint']) {
    $(id).className = id === 'tool-' + t ? 'on' : 'sub';
  }
}

function acRules() {
  return {
    ...AUTO_COLOR_DEFAULT,
    flatMax: parseFloat($('ac-flat').value),
    hillMin: parseFloat($('ac-hill').value),
    steepSlope: parseFloat($('ac-steep').value) / 100,
  };
}

// ── 道路スプライン編集 ─────────────────────────────────────────
// roads: [{ points:[[x,z]...], closed:false }]。高さは持たない（常に地形からサンプル）
const roadEd = { on: false, roads: [], active: null, sel: null, dragging: false, group: null, handles: [] };
const SNAP_R = 14;   // 他の道路の制御点への吸着距離(m)

function roadSnap(x, z, exceptRoad, exceptIdx) {
  let best = null, bd = SNAP_R * SNAP_R;
  for (const r of roadEd.roads) {
    for (let i = 0; i < r.points.length; i++) {
      if (r === exceptRoad && i === exceptIdx) continue;
      const p = r.points[i];
      const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
  }
  return best ? [best[0], best[1]] : [x, z];
}
// 描画はスケール前提（OSM取込=数百本/数千点）: 全ライン=LineSegments1本、全ハンドル=InstancedMesh1つ、
// 選択中の道路だけ明るいオーバーレイ線。ドラッグ中はオーバーレイのみ更新（確定時に全再構築）
function roadY(x, z) { return terrain.heightAt(x, z) + 1.2; }
function renderRoads() {
  if (roadEd.group) {
    scene.remove(roadEd.group);
    roadEd.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  roadEd.group = new THREE.Group();
  roadEd.handleMap = [];
  roadEd.selInstance = -1;
  const segs = [];
  for (const r of roadEd.roads) {
    if (r.points.length < 2) continue;
    const pts = sampleRoadPoints(r.points, !!r.closed, 20);
    for (let i = 0; i + 1 < pts.length; i++) {
      segs.push(pts[i].x, roadY(pts[i].x, pts[i].z), pts[i].z, pts[i + 1].x, roadY(pts[i + 1].x, pts[i + 1].z), pts[i + 1].z);
    }
  }
  if (segs.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    roadEd.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.8, depthTest: false })));
  }
  let total = 0;
  for (const r of roadEd.roads) total += r.points.length;
  if (total) {
    const hm = new THREE.InstancedMesh(new THREE.SphereGeometry(4.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd060, depthTest: false, transparent: true, opacity: 0.85 }), total);
    hm.renderOrder = 6;
    const m = new THREE.Matrix4();
    let idx = 0;
    for (const r of roadEd.roads) {
      for (let i = 0; i < r.points.length; i++) {
        const p = r.points[i];
        m.makeTranslation(p[0], roadY(p[0], p[1]), p[1]);
        hm.setMatrixAt(idx, m);
        roadEd.handleMap.push({ road: r, idx: i });
        if (roadEd.sel && roadEd.sel.road === r && roadEd.sel.idx === i) roadEd.selInstance = idx;
        idx++;
      }
    }
    roadEd.handleMesh = hm;
    roadEd.group.add(hm);
  } else roadEd.handleMesh = null;
  // 選択点マーカー＋強調線
  roadEd.selMarker = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  roadEd.selMarker.renderOrder = 7;
  roadEd.selMarker.visible = false;
  roadEd.group.add(roadEd.selMarker);
  roadEd.hiLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe060, depthTest: false }));
  roadEd.hiLine.renderOrder = 7;
  roadEd.group.add(roadEd.hiLine);
  updateRoadOverlay();
  scene.add(roadEd.group);
}
function updateRoadOverlay() {   // 選択点マーカー＋選択/作成中の道路の強調線（ドラッグ中はここだけ更新）
  const hi = roadEd.sel?.road || roadEd.active;
  if (roadEd.sel) {
    const p = roadEd.sel.road.points[roadEd.sel.idx];
    if (p) { roadEd.selMarker.visible = true; roadEd.selMarker.position.set(p[0], roadY(p[0], p[1]), p[1]); }
    else roadEd.selMarker.visible = false;
  } else roadEd.selMarker.visible = false;
  if (hi && hi.points.length >= 2) {
    const pts = sampleRoadPoints(hi.points, !!hi.closed, 20);
    const arr = [];
    for (const p of pts) arr.push(p.x, roadY(p.x, p.z) + 0.3, p.z);
    roadEd.hiLine.geometry.dispose();
    roadEd.hiLine.geometry = new THREE.BufferGeometry();
    roadEd.hiLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    roadEd.hiLine.visible = true;
  } else roadEd.hiLine.visible = false;
}
function roadsChanged() {   // 編集確定時: 再描画＋町プレビュー更新
  renderRoads();
  if (town.on) refreshTown().catch(() => { /* noop */ });
}
function setRoadMode(on) {
  roadEd.on = on;
  $('btn-road-mode').className = on ? 'on' : 'sub';
  if (on && bldEd.on) setBldMode(false);
  if (on && waterEd.on) setWaterMode(false);
  if (on && vegEd.on) setVegMode(false);
  if (on && parkEd.on) setParkMode(false);
  brushMesh.visible = false;
  if (!on) { roadEd.active = null; roadEd.sel = null; renderRoads(); }
  setStatus(on ? '道路編集: 「＋新しい道路」→地形をクリックで点を追加 / 点ドラッグで移動 / 右クリックで終了' : '地形ブラシモード');
}
function roadPointerDown(e) {
  if (e.button === 2) { roadEd.active = null; renderRoads(); return true; }   // 右クリック=引き終わり
  if (e.button !== 0) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hh = roadEd.handleMesh ? ray.intersectObject(roadEd.handleMesh)[0] : null;
  if (hh && hh.instanceId != null) {   // 既存点を選択→ドラッグ開始
    roadEd.sel = roadEd.handleMap[hh.instanceId];
    roadEd.selInstance = hh.instanceId;
    roadEd.dragging = true;
    updateRoadOverlay();
    return true;
  }
  const p = pickGround(e);
  if (!p) return true;
  if (!roadEd.active) { setStatus('「＋新しい道路」を押してから点を置いてください（既存の点はドラッグで移動）'); return true; }
  roadEd.active.points.push(roadSnap(p.x, p.z, roadEd.active, -1));
  roadEd.sel = { road: roadEd.active, idx: roadEd.active.points.length - 1 };
  roadsChanged();
  return true;
}
function roadPointerMove(e) {
  if (!roadEd.dragging || !roadEd.sel) return;
  const p = pickGround(e);
  if (!p) return;
  const np = roadSnap(p.x, p.z, roadEd.sel.road, roadEd.sel.idx);
  roadEd.sel.road.points[roadEd.sel.idx] = np;
  // ドラッグ中は軽量更新のみ（ハンドル行列＋強調線）。全ラインは離した時に再構築
  if (roadEd.handleMesh && roadEd.selInstance >= 0) {
    const m = new THREE.Matrix4().makeTranslation(np[0], roadY(np[0], np[1]), np[1]);
    roadEd.handleMesh.setMatrixAt(roadEd.selInstance, m);
    roadEd.handleMesh.instanceMatrix.needsUpdate = true;
  }
  updateRoadOverlay();
}
function roadDeletePoint() {
  const s = roadEd.sel;
  if (!s) return;
  s.road.points.splice(s.idx, 1);
  if (!s.road.points.length) roadEd.roads.splice(roadEd.roads.indexOf(s.road), 1);
  roadEd.sel = null;
  roadsChanged();
}
// OSM道路を編集可能なスプラインとして取り込む（交差点で区切ったポリライン列に変換）
async function importOsmRoads() {
  if (!town.loaded) { setStatus('OSM道路データ読込中…'); await loadTownData(); }
  const key = (x, z) => Math.round(x * 2) / 2 + '_' + Math.round(z * 2) / 2;
  const nodes = new Map();
  const addN = (x, z) => {
    const k = key(x, z);
    if (!nodes.has(k)) nodes.set(k, { x: Math.round(x * 2) / 2, z: Math.round(z * 2) / 2, adj: [] });
    return k;
  };
  const ekey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const eset = new Set();
  for (const s of town.osmEdges) {
    const a = addN(s[0], s[2]), b = addN(s[3], s[5]);
    if (a === b || eset.has(ekey(a, b))) continue;
    eset.add(ekey(a, b));
    nodes.get(a).adj.push(b);
    nodes.get(b).adj.push(a);
  }
  const visited = new Set();
  const added = [];
  const walk = (start, next) => {   // 交差点(度数≠2)から度数2を辿って1本のポリラインに
    const pts = [nodes.get(start)];
    let prev = start, cur = next;
    visited.add(ekey(start, next));
    for (;;) {
      const n = nodes.get(cur);
      pts.push(n);
      if (n.adj.length !== 2) break;
      const nxt = n.adj[0] === prev ? n.adj[1] : n.adj[0];
      if (visited.has(ekey(cur, nxt))) break;
      visited.add(ekey(cur, nxt));
      prev = cur; cur = nxt;
    }
    added.push({ points: pts.map((p) => [p.x, p.z]), closed: false, osm: true });
  };
  for (const [k, n] of nodes) if (n.adj.length !== 2) for (const nb of n.adj) if (!visited.has(ekey(k, nb))) walk(k, nb);
  for (const [k, n] of nodes) for (const nb of n.adj) if (!visited.has(ekey(k, nb))) walk(k, nb);   // 残り＝純ループ
  roadEd.roads.push(...added);
  roadEd.importedOsm = true;
  roadsChanged();
  setStatus(`OSM道路を取り込み: ${added.length}本（点${added.reduce((s, r) => s + r.points.length, 0)}個）。点の移動/削除・道路ごと削除・新規追加が可能`);
}
// 道路沿いの地形を道路の平滑プロファイルへ寄せる（切り盛り）。地形起伏で道が埋まるのを解消
function flattenUnderRoads() {
  const data = terrain.data;
  const R_IN = 10, R_OUT = 28;   // 完全に均す半径 / なじませ半径(m)。地形25m/セルに合わせた値
  let touched = false;
  for (const r of roadEd.roads) {
    if (r.points.length < 2) continue;
    const pts = sampleRoadPoints(r.points, !!r.closed, 10);
    // 現在地形の高さを道路に沿って移動平均＝コブを除いたプロファイル
    const ys = pts.map((p) => terrain.heightAt(p.x, p.z));
    const K = 4;
    const sm = ys.map((_, i) => {
      let s = 0, n = 0;
      for (let k = -K; k <= K; k++) { const j = i + k; if (j >= 0 && j < ys.length) { s += ys[j]; n++; } }
      return s / n;
    });
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x, pz = pts[i].z, ty = sm[i];
      const gx = Math.round((px / data.size + 0.5) * (data.res - 1));
      const gz = Math.round((pz / data.size + 0.5) * (data.res - 1));
      const rr = Math.ceil(R_OUT / (data.size / (data.res - 1)));
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) {
          const ix = gx + dx, iz = gz + dz;
          if (ix < 0 || iz < 0 || ix >= data.res || iz >= data.res) continue;
          const wx = (ix / (data.res - 1) - 0.5) * data.size, wz = (iz / (data.res - 1) - 0.5) * data.size;
          const d = Math.hypot(wx - px, wz - pz);
          if (d > R_OUT) continue;
          const w = d <= R_IN ? 1 : 1 - (d - R_IN) / (R_OUT - R_IN);
          const k = iz * data.res + ix;
          data.heights[k] += (ty - data.heights[k]) * w;
          touched = true;
        }
      }
    }
  }
  if (!touched) { setStatus('均す対象の道路がありません'); return; }
  terrain.refreshAll();
  renderRoads();
  if (town.on) drapeTown();
  setStatus('道路下の地形を均しました（再保存してゲームへ反映）');
}
function roadDeleteRoad() {
  const r = roadEd.sel?.road || roadEd.active;
  if (!r) { setStatus('削除する道路が未選択です（点をクリック）'); return; }
  roadEd.roads.splice(roadEd.roads.indexOf(r), 1);
  if (roadEd.active === r) roadEd.active = null;
  roadEd.sel = null;
  roadsChanged();
}

// ── 町プレビュー: 自作道路（無ければOSM）＋建物を地形にドレープ表示 ──
// 建物=ティア色の箱インポスタ（ゲームの遠景LODと同じ発想）、道路=リボン。ブラシ後に追従。
const town = { on: false, loaded: false, edges: [], insts: [], group: null, roadMesh: null, bldMesh: null };
const TOWN_TIER = { tower: { h: 55, c: 0xa8afb9, foot: 26 }, mid: { h: 18, c: 0xb4b9c4, foot: 15 }, house: { h: 6.5, c: 0xcbc1b2, foot: 10 } };
const TOWN_ROAD_R = 1600;   // ゲームの道路活性半径(CAR_RADIUS)と同じ

async function loadTownData() {
  const files = await (await fetch('../roads/manifest.json')).json();
  const tiles = await Promise.all(files.map((f) => fetch('../roads/' + f).then((r) => r.ok ? r.json() : null).catch(() => null)));
  // 八王子原点の等距円筒近似（ゲームのENU変換と数m以内で一致＝プレビュー用途には十分）
  const lat0 = 35.6664, lon0 = 139.3159;
  const mLat = 111133, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
  const pos = new Map();
  const rawEdges = [], seen = new Set();
  for (const j of tiles) {
    if (!j) continue;
    for (const n of (j.nodes || [])) pos.set(n[0], [(n[1] - lon0) * mLon, -(n[2] - lat0) * mLat]);
    for (const e of (j.edges || [])) {
      const k = e[0] < e[1] ? e[0] + '_' + e[1] : e[1] + '_' + e[0];
      if (!seen.has(k)) { seen.add(k); rawEdges.push(e); }
    }
  }
  const R = Math.min(TOWN_ROAD_R, terrain.data.size / 2 * 0.98);
  town.osmEdges = [];
  for (const [a, b] of rawEdges) {
    const pa = pos.get(a), pb = pos.get(b);
    if (!pa || !pb) continue;
    if (Math.hypot(pa[0], pa[1]) > R || Math.hypot(pb[0], pb[1]) > R) continue;
    town.osmEdges.push([pa[0], 0, pa[1], pb[0], 0, pb[1]]);
  }
  town.loaded = true;
}
function mapRoadEdges() {   // 自作スプライン→建物生成用エッジ（未作成ならnull）
  const g = buildRoadGraph(roadEd.roads);
  if (!g.edges.length) return null;
  return g.edges.map(([a, b]) => { const na = g.nodes.get(a), nb = g.nodes.get(b); return [na.x, 0, na.z, nb.x, 0, nb.z]; });
}
async function refreshTown() {   // 自作道路があればそれを、無ければOSMを使って再生成→建物差分を適用
  const own = mapRoadEdges();
  if (own) town.edges = own;
  else {
    if (!town.loaded) { setStatus('OSM道路データ読込中…（初回のみ）'); await loadTownData(); }
    town.edges = town.osmEdges;
  }
  const raw = generateBuildings(town.edges, { seed: 20260706 }).instances;
  const kept = [], meta = [];
  for (const it of raw) {
    const id = instanceId(it);   // 差分キーは自動配置の元座標から（moved適用前）
    if (bldEd.removed.has(id)) continue;
    const inst = { ...it };
    const mv = bldEd.moved[id];
    if (mv) { inst.x = mv.x; inst.z = mv.z; if (mv.ry != null) inst.ry = mv.ry; }
    kept.push(inst);
    meta.push({ kind: 'auto', id });
  }
  for (let k = 0; k < bldEd.added.length; k++) { kept.push(bldEd.added[k]); meta.push({ kind: 'added', idx: k }); }
  town.insts = kept;
  town.meta = meta;
  bldEd.sel = -1;
  buildTownMeshes();
  updateBldSelMarker();
  setStatus(`町プレビュー: 道路${town.edges.length}本 / 建物${town.insts.length}棟${own ? '（自作道路）' : '（OSM）'}（削除${bldEd.removed.size}/移動${Object.keys(bldEd.moved).length}/追加${bldEd.added.length}）`);
}
function disposeTown() {
  if (!town.group) return;
  scene.remove(town.group);
  town.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  town.group = null; town.roadMesh = null; town.bldMesh = null;
}
function buildTownMeshes() {
  disposeTown();
  town.group = new THREE.Group();
  const rg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  town.roadMesh = new THREE.InstancedMesh(rg, new THREE.MeshLambertMaterial({ color: 0x46484c }), town.edges.length);
  const bg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);   // 底面原点
  town.bldMesh = new THREE.InstancedMesh(bg, new THREE.MeshLambertMaterial({ color: 0xffffff }), town.insts.length);
  town.roadMesh.frustumCulled = town.bldMesh.frustumCulled = false;
  town.group.add(town.roadMesh, town.bldMesh);
  scene.add(town.group);
  const c = new THREE.Color();
  town.insts.forEach((it, i) => town.bldMesh.setColorAt(i, c.set(TOWN_TIER[it.tier].c)));
  if (town.bldMesh.instanceColor) town.bldMesh.instanceColor.needsUpdate = true;
  if (gamePv.on) { town.roadMesh.visible = false; town.bldMesh.visible = false; }   // 実モデル表示中は箱を出さない
  drapeTown();
}
const _tm = new THREE.Matrix4(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3(), _ts = new THREE.Vector3();
const _tUp = new THREE.Vector3(0, 1, 0), _tDir = new THREE.Vector3(), _tRot = new THREE.Matrix4(), _tZero = new THREE.Vector3();
function drapeTown() {   // 現在の地形高さへ道路/建物を追従させる
  if (!town.group) return;
  town.edges.forEach((e, i) => {
    const ya = terrain.heightAt(e[0], e[2]) + 0.6, yb = terrain.heightAt(e[3], e[5]) + 0.6;
    _tDir.set(e[3] - e[0], yb - ya, e[5] - e[2]);
    const len = _tDir.length() || 1;
    _tDir.normalize();
    _tRot.lookAt(_tZero, _tDir, _tUp);
    _tq.setFromRotationMatrix(_tRot);
    _tp.set((e[0] + e[3]) / 2, (ya + yb) / 2, (e[2] + e[5]) / 2);
    _ts.set(7, 1, len);
    _tm.compose(_tp, _tq, _ts);
    town.roadMesh.setMatrixAt(i, _tm);
  });
  town.roadMesh.instanceMatrix.needsUpdate = true;
  town.insts.forEach((it, i) => {
    const t = TOWN_TIER[it.tier];
    const foot = t.foot * (it.s || 1);
    const h = t.h * (0.75 + (((i * 2654435761) >>> 16) & 255) / 255 * 0.55);   // 決定的な高さバラつき
    _tp.set(it.x, terrain.heightAt(it.x, it.z) - 0.5, it.z);
    _tq.setFromAxisAngle(_tUp, it.ry || 0);
    _ts.set(foot, h, foot);
    _tm.compose(_tp, _tq, _ts);
    town.bldMesh.setMatrixAt(i, _tm);
  });
  town.bldMesh.instanceMatrix.needsUpdate = true;
}
async function toggleTown() {
  town.on = !town.on;
  $('btn-town').className = town.on ? 'on' : 'sub';
  if (!town.on) { disposeTown(); setStatus('町プレビューOFF'); return; }
  try { await refreshTown(); }
  catch (e) { setStatus('町プレビュー失敗: ' + e.message); town.on = false; $('btn-town').className = 'sub'; }
}

// ── 建物の差分編集: 自動配置に対する removed(Set<id>) / moved{id:{x,z,ry}} / added[] だけ保存 ──
const bldEd = { on: false, sel: -1, dragging: false, placing: null, removed: new Set(), moved: {}, added: [], marker: null };

function setBldMode(on) {
  bldEd.on = on;
  $('btn-bld-mode').className = on ? 'on' : 'sub';
  if (on) {
    if (roadEd.on) setRoadMode(false);
    if (waterEd.on) setWaterMode(false);
    if (vegEd.on) setVegMode(false);
    if (parkEd.on) setParkMode(false);
    brushMesh.visible = false;
    if (!town.on) toggleTown().catch((e) => setStatus('町プレビュー失敗: ' + e.message));
    setStatus('建物編集: 箱クリック=選択→ドラッグ移動 / R回転 / Del削除 / ＋ボタン→クリック設置');
  } else { bldEd.sel = -1; bldEd.placing = null; updateBldSelMarker(); }
}
function bldTier(i) { return TOWN_TIER[town.insts[i].tier] || TOWN_TIER.house; }
function updateBldSelMarker() {
  if (!bldEd.marker) {
    bldEd.marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, depthTest: false }));
    bldEd.marker.renderOrder = 8;
    scene.add(bldEd.marker);
  }
  const i = bldEd.sel;
  if (i < 0 || !town.insts[i]) { bldEd.marker.visible = false; return; }
  const it = town.insts[i], t = bldTier(i);
  const foot = t.foot * (it.s || 1);
  bldEd.marker.visible = true;
  bldEd.marker.position.set(it.x, terrain.heightAt(it.x, it.z), it.z);
  bldEd.marker.rotation.y = it.ry || 0;
  bldEd.marker.scale.set(foot + 2, t.h + 3, foot + 2);
}
function bldWriteDiff(i) {   // 選択中インスタンスの現在値を差分へ反映
  const it = town.insts[i], m = town.meta[i];
  if (m.kind === 'auto') bldEd.moved[m.id] = { x: Number(it.x.toFixed(2)), z: Number(it.z.toFixed(2)), ry: Number((it.ry || 0).toFixed(3)) };
  else Object.assign(bldEd.added[m.idx], { x: Number(it.x.toFixed(2)), z: Number(it.z.toFixed(2)), ry: Number((it.ry || 0).toFixed(3)) });
}
function bldDrapeOne(i) {   // 1棟だけ行列更新（drapeTownの単体版）
  const it = town.insts[i], t = bldTier(i);
  const foot = t.foot * (it.s || 1);
  const h = t.h * (0.75 + (((i * 2654435761) >>> 16) & 255) / 255 * 0.55);
  _tp.set(it.x, terrain.heightAt(it.x, it.z) - 0.5, it.z);
  _tq.setFromAxisAngle(_tUp, it.ry || 0);
  _ts.set(foot, h, foot);
  _tm.compose(_tp, _tq, _ts);
  town.bldMesh.setMatrixAt(i, _tm);
  town.bldMesh.instanceMatrix.needsUpdate = true;
}
function bldPointerDown(e) {
  if (e.button !== 0) return false;
  const p = pickGround(e);
  if (bldEd.placing) {   // ＋ボタン後のクリック設置
    if (!p) return true;
    const tier = bldEd.placing, info = TIER_INFO[tier];
    const models = info.models();
    bldEd.added.push({ kit: info.kit, model: models[(Math.random() * models.length) | 0], tier, x: p.x, z: p.z, ry: 0, s: 1 });
    bldEd.placing = null;
    refreshTown().then(() => { bldEd.sel = town.insts.length - 1; updateBldSelMarker(); }).catch(() => { /* noop */ });
    return true;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = town.bldMesh ? ray.intersectObject(town.bldMesh)[0] : null;
  if (hit && hit.instanceId != null) {
    bldEd.sel = hit.instanceId;
    bldEd.dragging = true;
    updateBldSelMarker();
    return true;
  }
  bldEd.sel = -1;
  updateBldSelMarker();
  return true;
}
function bldPointerMove(e) {
  if (!bldEd.dragging || bldEd.sel < 0) return;
  const p = pickGround(e);
  if (!p) return;
  const it = town.insts[bldEd.sel];
  it.x = p.x; it.z = p.z;
  bldWriteDiff(bldEd.sel);
  bldDrapeOne(bldEd.sel);
  updateBldSelMarker();
}
function bldRotateSel(delta) {
  if (bldEd.sel < 0) return;
  const it = town.insts[bldEd.sel];
  it.ry = (it.ry || 0) + delta;
  bldWriteDiff(bldEd.sel);
  bldDrapeOne(bldEd.sel);
  updateBldSelMarker();
}
function bldDeleteSel() {
  if (bldEd.sel < 0) return;
  const m = town.meta[bldEd.sel];
  if (m.kind === 'auto') { bldEd.removed.add(m.id); delete bldEd.moved[m.id]; }
  else bldEd.added.splice(m.idx, 1);
  bldEd.sel = -1;
  refreshTown().catch(() => { /* noop */ });
}

// ── 公園編集: 閉じスプライン {points:[[x,z]...], fountain}。中は緑地＋噴水＋ランタン（ゲーム側で実体化）──
const parkEd = { on: false, list: [], active: null, sel: null, dragging: false, group: null, handleMesh: null, handleMap: [], ovr: 1.1 };
function setParkMode(on) {
  parkEd.on = on;
  $('btn-park-mode').className = on ? 'on' : 'sub';
  if (on) {
    if (roadEd.on) setRoadMode(false);
    if (bldEd.on) setBldMode(false);
    if (waterEd.on) setWaterMode(false);
    if (vegEd.on) setVegMode(false);
    brushMesh.visible = false;
    setStatus('公園編集: 「＋新しい公園」→クリックで頂点追加（自動で閉じる） / 頂点ドラッグで移動 / Del削除');
  } else { parkEd.active = null; parkEd.sel = null; renderParks(); }
}
function renderParks() {
  if (parkEd.group) {
    scene.remove(parkEd.group);
    parkEd.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  parkEd.group = new THREE.Group();
  parkEd.handleMap = [];
  for (const pk of parkEd.list) {
    if (pk.points.length < 3) continue;
    const ring = sampleRoadPoints(pk.points, true, 6);
    const hi = pk === (parkEd.sel?.park || parkEd.active);
    // 輪郭（閉じた緑線）
    const arr = [];
    for (const q of ring) arr.push(q.x, terrain.heightAt(q.x, q.z) + 1.2, q.z);
    arr.push(ring[0].x, terrain.heightAt(ring[0].x, ring[0].z) + 1.2, ring[0].z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    parkEd.group.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: hi ? 0x90ffb0 : 0x50c070, depthTest: false, transparent: true, opacity: hi ? 1 : 0.8 })));
    // 半透明の緑地
    const shp = new THREE.Shape();
    shp.moveTo(ring[0].x, ring[0].z);
    for (let i = 1; i < ring.length; i++) shp.lineTo(ring[i].x, ring[i].z);
    const gg = new THREE.ShapeGeometry(shp);
    const posA = gg.attributes.position;
    for (let i = 0; i < posA.count; i++) {
      const gx = posA.getX(i), gz = posA.getY(i);
      posA.setXYZ(i, gx, terrain.heightAt(gx, gz) + 0.6, gz);
    }
    parkEd.group.add(new THREE.Mesh(gg, new THREE.MeshBasicMaterial({ color: 0x2f8f3f, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })));
    // 噴水マーカー（重心）
    let cx = 0, cz = 0;
    for (const q of pk.points) { cx += q[0]; cz += q[1]; }
    cx /= pk.points.length; cz /= pk.points.length;
    const fm = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 2, 12), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.75, depthTest: false }));
    fm.position.set(cx, terrain.heightAt(cx, cz) + 1, cz);
    fm.renderOrder = 6;
    parkEd.group.add(fm);
  }
  // 頂点ハンドル
  let total = 0;
  for (const pk of parkEd.list) total += pk.points.length;
  if (total) {
    const hm = new THREE.InstancedMesh(new THREE.SphereGeometry(4.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0x70e090, depthTest: false, transparent: true, opacity: 0.9 }), total);
    hm.renderOrder = 6;
    const m = new THREE.Matrix4();
    let idx = 0;
    for (const pk of parkEd.list) {
      for (let i = 0; i < pk.points.length; i++) {
        const q = pk.points[i];
        m.makeTranslation(q[0], terrain.heightAt(q[0], q[1]) + 1.2, q[1]);
        hm.setMatrixAt(idx, m);
        parkEd.handleMap.push({ park: pk, idx: i });
        idx++;
      }
    }
    parkEd.handleMesh = hm;
    parkEd.group.add(hm);
  } else parkEd.handleMesh = null;
  scene.add(parkEd.group);
}
function parkPointerDown(e) {
  if (e.button === 2) { parkEd.active = null; renderParks(); return true; }   // 右クリック=引き終わり
  if (e.button !== 0) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hh = parkEd.handleMesh ? ray.intersectObject(parkEd.handleMesh)[0] : null;
  if (hh && hh.instanceId != null) {
    parkEd.sel = parkEd.handleMap[hh.instanceId];
    parkEd.dragging = true;
    $('park-fountain').value = parkEd.sel.park.fountain || 'round';
    renderParks();
    return true;
  }
  const p = pickGround(e);
  if (!p) return true;
  if (!parkEd.active) { setStatus('「＋新しい公園」を押してから頂点を置いてください（既存の頂点はドラッグで移動）'); return true; }
  parkEd.active.points.push([Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);
  parkEd.sel = { park: parkEd.active, idx: parkEd.active.points.length - 1 };
  renderParks();
  return true;
}
function parkPointerMove(e) {
  if (!parkEd.dragging || !parkEd.sel) return;
  const p = pickGround(e);
  if (!p) return;
  parkEd.sel.park.points[parkEd.sel.idx] = [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10];
  renderParks();
}
function parkDeletePoint() {
  const sl = parkEd.sel;
  if (!sl) return;
  sl.park.points.splice(sl.idx, 1);
  if (!sl.park.points.length) parkEd.list.splice(parkEd.list.indexOf(sl.park), 1);
  parkEd.sel = null;
  renderParks();
}
function parkDeletePark() {
  const pk = parkEd.sel?.park || parkEd.active;
  if (!pk) { setStatus('削除する公園が未選択です（頂点をクリック）'); return; }
  parkEd.list.splice(parkEd.list.indexOf(pk), 1);
  if (parkEd.active === pk) parkEd.active = null;
  parkEd.sel = null;
  renderParks();
}

// ── 水面編集: 矩形 {x,z,w,d,level} のリスト。半透明青プレーンで表示 ──
const waterEd = { on: false, list: [], sel: -1, dragging: false, placing: false, group: null };

function setWaterMode(on) {
  waterEd.on = on;
  $('btn-water-mode').className = on ? 'on' : 'sub';
  if (on) {
    if (roadEd.on) setRoadMode(false);
    if (bldEd.on) setBldMode(false);
    if (vegEd.on) setVegMode(false);
    if (parkEd.on) setParkMode(false);
    brushMesh.visible = false;
    setStatus('水面編集: ＋水面→クリック設置 / クリック選択→ドラッグ移動 / スライダ調整 / Del削除');
  } else { waterEd.sel = -1; waterEd.placing = false; }
  renderWater();
}
function renderWater() {
  if (waterEd.group) {
    scene.remove(waterEd.group);
    waterEd.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  waterEd.group = new THREE.Group();
  waterEd.list.forEach((w, i) => {
    const sel = i === waterEd.sel;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: sel ? 0x55b8e8 : 0x3a7fae, transparent: true, opacity: sel ? 0.75 : 0.55, depthWrite: false }),
    );
    m.position.set(w.x, w.level, w.z);
    m.scale.set(w.w, 1, w.d);
    m.renderOrder = 4;
    m.userData.wi = i;
    waterEd.group.add(m);
  });
  scene.add(waterEd.group);
  syncWaterOpts();
}
function syncWaterOpts() {
  const w = waterEd.list[waterEd.sel];
  $('water-opts').style.display = w ? '' : 'none';
  if (!w) return;
  $('water-w').value = String(w.w); $('water-w-val').textContent = String(Math.round(w.w));
  $('water-d').value = String(w.d); $('water-d-val').textContent = String(Math.round(w.d));
  $('water-lv').value = String(w.level); $('water-lv-val').textContent = w.level.toFixed(1);
}
function waterPointerDown(e) {
  if (e.button !== 0) return false;
  const p = pickGround(e);
  if (waterEd.placing) {
    if (!p) return true;
    waterEd.list.push({ x: Math.round(p.x), z: Math.round(p.z), w: 600, d: 450, level: Number((terrain.heightAt(p.x, p.z) + 1).toFixed(1)) });
    waterEd.sel = waterEd.list.length - 1;
    waterEd.placing = false;
    renderWater();
    return true;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = waterEd.group ? ray.intersectObjects(waterEd.group.children, false)[0] : null;
  if (hit) { waterEd.sel = hit.object.userData.wi; waterEd.dragging = true; renderWater(); return true; }
  waterEd.sel = -1;
  renderWater();
  return true;
}
function waterPointerMove(e) {
  if (!waterEd.dragging || waterEd.sel < 0) return;
  const p = pickGround(e);
  if (!p) return;
  const w = waterEd.list[waterEd.sel];
  w.x = Math.round(p.x); w.z = Math.round(p.z);
  const mesh = waterEd.group.children[waterEd.sel];
  if (mesh) mesh.position.set(w.x, w.level, w.z);
}
function waterDeleteSel() {
  if (waterEd.sel < 0) return;
  waterEd.list.splice(waterEd.sel, 1);
  waterEd.sel = -1;
  renderWater();
}

// ── 植生（森）ペイント: セル格子の密度マスク(0-255)を左ドラッグで塗る ──
// 保存 = forest {cell,res,data:base64}。ゲーム側はこの密度を「木の生える確率」として使う
const vegEd = { on: false, cell: 16, res: 0, data: null, mesh: null, dirty: false, lastBuild: 0, yOff: 0, model: '', treeH: 7 };
let vegModelList = null;   // models/manifest.json の .glb 一覧（初回のモーダル表示で取得）
async function fillVegModels() {
  if (!vegModelList) {
    try { vegModelList = (await (await fetch('../models/manifest.json')).json()).filter((f) => f.endsWith('.glb')); }
    catch { vegModelList = []; }
  }
  const filter = $('veg-model-filter').value.trim().toLowerCase();
  const sel = $('veg-model');
  sel.innerHTML = '';
  const d = document.createElement('option');
  d.value = '';
  d.textContent = '既定（tree-large / small ミックス）';
  sel.appendChild(d);
  let n = 0;
  for (const f of vegModelList) {
    if (filter && !f.toLowerCase().includes(filter)) continue;
    if (++n > 400) break;   // 選択肢の上限（絞り込みで探す）
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f.split('/').pop().replace('.glb', '') + '  —  ' + f.split('/')[0];
    sel.appendChild(o);
  }
  sel.value = vegEd.model && [...sel.options].some((o) => o.value === vegEd.model) ? vegEd.model : '';
}
function ensureVeg() {
  const res = Math.ceil(terrain.data.size / vegEd.cell);
  if (!vegEd.data || vegEd.res !== res) { vegEd.data = new Uint8Array(res * res); vegEd.res = res; }
}
function setVegMode(on) {
  vegEd.on = on;
  $('btn-veg-mode').className = on ? 'on' : 'sub';
  if (on) {
    if (roadEd.on) setRoadMode(false);
    if (bldEd.on) setBldMode(false);
    if (waterEd.on) setWaterMode(false);
    if (parkEd.on) setParkMode(false);
    ensureVeg();
    setStatus('植生ペイント: 左ドラッグで塗る / Shift+ドラッグで消す / 半径は地形ブラシと共通');
  } else setStatus('地形ブラシモード');
}
function paintVeg(p, r, erase) {
  ensureVeg();
  const den = erase ? 0 : Math.round(parseFloat($('veg-d').value) * 255);
  const { cell, res, data } = vegEd;
  const half = terrain.data.size / 2;
  const x0 = Math.max(0, Math.floor((p.x - r + half) / cell)), x1 = Math.min(res - 1, Math.floor((p.x + r + half) / cell));
  const z0 = Math.max(0, Math.floor((p.z - r + half) / cell)), z1 = Math.min(res - 1, Math.floor((p.z + r + half) / cell));
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const wx = (cx + 0.5) * cell - half, wz = (cz + 0.5) * cell - half;
      if ((wx - p.x) ** 2 + (wz - p.z) ** 2 <= r * r) data[cz * res + cx] = den;
    }
  }
  vegEd.dirty = true;
}
const _vC = new THREE.Color();
function renderVeg() {   // 塗ったセルに緑のコーン（木のシンボル）を立てる。密度で高さ/色が変わる
  if (vegEd.mesh) {
    scene.remove(vegEd.mesh);
    vegEd.mesh.geometry.dispose(); vegEd.mesh.material.dispose();
    vegEd.mesh = null;
  }
  vegEd.dirty = false;
  vegEd.lastBuild = performance.now();
  if (!vegEd.data) return;
  const { cell, res, data } = vegEd;
  const half = terrain.data.size / 2;
  // セル内のランダム位置に1〜3本（ハッシュ由来＝塗り直しても位置が踊らない。ゲームのランダム配置の雰囲気に合わせる）
  const hash = (a, b) => {
    let n = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) ^ 0x7E9E57;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const spots = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] <= 0) continue;
    const den = data[i] / 255;
    const cx = i % res, cz = (i / res) | 0;
    const n = 1 + Math.round(den * (1 + hash(i, 11)));   // 密度で1〜3本
    for (let k = 0; k < n; k++) {
      spots.push({
        x: (cx + 0.08 + hash(i, k * 2 + 1) * 0.84) * cell - half,
        z: (cz + 0.08 + hash(i, k * 2 + 2) * 0.84) * cell - half,
        den, v: hash(i, k * 2 + 3),
      });
    }
  }
  if (!spots.length) return;
  const geo = new THREE.ConeGeometry(1, 1, 6);
  geo.translate(0, 0.5, 0);   // 底面原点
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), spots.length);
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(0, 0, 0);
  const hAt = terrain.heightAt;
  let shown = 0;
  for (let k = 0; k < spots.length; k++) {
    const t = spots[k];
    // ゲームと同じ急斜面スキップ（CityFlyはここに木を生やさない＝プレビューも正直に消す）
    if (Math.abs(hAt(t.x + 3, t.z) - hAt(t.x - 3, t.z)) > 3.4 || Math.abs(hAt(t.x, t.z + 3) - hAt(t.x, t.z - 3)) > 3.4) {
      m.compose(pos.set(0, -9999, 0), q, sc.set(0, 0, 0));
      mesh.setMatrixAt(k, m);
      continue;
    }
    // 接地=足元範囲の最高点（斜面で根元が埋まらない）
    const rr = cell * 0.25;
    const gy = Math.max(hAt(t.x, t.z), hAt(t.x + rr, t.z), hAt(t.x - rr, t.z), hAt(t.x, t.z + rr), hAt(t.x, t.z - rr));
    pos.set(t.x, gy + vegEd.yOff, t.z);
    const h = vegEd.treeH * (0.6 + 0.5 * t.den) * (0.75 + t.v * 0.5);   // 高さ設定×密度×個体差
    sc.set(cell * (0.2 + t.v * 0.12), h, cell * (0.2 + t.v * 0.12));
    m.compose(pos, q, sc);
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, _vC.setHSL(0.33 + (t.v - 0.5) * 0.04, 0.55, 0.16 + 0.18 * t.den + t.v * 0.06));
    shown++;
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  vegEd.mesh = mesh;
}
function vegClear() {
  if (vegEd.data) vegEd.data.fill(0);
  renderVeg();
  setStatus('植生を全消去しました');
}
function vegHasAny() { return vegEd.data && vegEd.data.some((v) => v > 0); }

// ── 🎮 実モデルプレビュー: CityFlyと同じGLB・同じ正規化で 建物/道路/公園/森 を表示 ──
// スケール式はゲームと同一（建物: TARGET_FOOT/footprint、道路幅7m、生垣1.4m、ランタン2.4m、噴水4.5m）。
// 森の配置は同じアルゴリズムの近似（ゲームの占有グリッドは衝突ボックス由来のため微差あり）。
const gamePv = { on: false, group: null, cache: new Map(), busy: false };
const PV_KIT_DIR = { city: 'city_GLB format/', suburban: 'kenney_city-kit-suburban_20/Models/GLB format/' };
const PV_TARGET_FOOT = { tower: 26, mid: 15, house: 10 };
const PV_ROAD_W = 7.0;
const pvLoader = new GLTFLoader();
function pvLoadModel(rel) {   // rel → Promise<{g(底面0/XZ中心), mat, size}>（キャッシュ）
  if (gamePv.cache.has(rel)) return gamePv.cache.get(rel);
  const pr = (async () => {
    const url = '../models/' + rel.split('/').map(encodeURIComponent).join('/');
    const gltf = await pvLoader.loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const geoms = [];
    let mat = null, best = -1;
    gltf.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const gg = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const a of Object.keys(gg.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv') gg.deleteAttribute(a);
      if (!gg.getAttribute('normal')) gg.computeVertexNormals();
      if (!gg.getAttribute('uv')) gg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(gg.getAttribute('position').count * 2), 2));
      geoms.push(gg);
      const cnt = gg.getAttribute('position').count;
      if (cnt > best) { best = cnt; mat = Array.isArray(o.material) ? o.material[0] : o.material; }
    });
    let g = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
    if (!g) g = geoms.sort((a, b2) => b2.getAttribute('position').count - a.getAttribute('position').count)[0];
    g.computeBoundingBox();
    const b = g.boundingBox;
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);   // 底面0・XZ中心
    return { g, mat, size: b.getSize(new THREE.Vector3()) };
  })();
  gamePv.cache.set(rel, pr);
  return pr;
}
const _pvM = new THREE.Matrix4(), _pvQ = new THREE.Quaternion(), _pvP = new THREE.Vector3(), _pvS = new THREE.Vector3();
const _pvUp = new THREE.Vector3(0, 1, 0), _pvDir = new THREE.Vector3(), _pvRot = new THREE.Matrix4(), _pvZero = new THREE.Vector3();
function pvInst(g0, asset, mats) {   // mats: [{x,y,z,ry,sx,sy,sz}]
  if (!mats.length) return;
  const mesh = new THREE.InstancedMesh(asset.g, asset.mat, mats.length);
  mesh.frustumCulled = false;
  for (let i = 0; i < mats.length; i++) {
    const it = mats[i];
    _pvP.set(it.x, it.y, it.z);
    _pvQ.setFromAxisAngle(_pvUp, it.ry || 0);
    _pvS.set(it.sx, it.sy, it.sz);
    _pvM.compose(_pvP, _pvQ, _pvS);
    mesh.setMatrixAt(i, _pvM);
  }
  g0.add(mesh);
}
async function buildGamePreview() {
  if (!town.on) { town.on = true; $('btn-town').className = 'on'; await refreshTown(); }
  if (gamePv.group) disposeGamePv(true);
  const g0 = new THREE.Group();
  const H = (x, z) => terrain.heightAt(x, z);
  // ── 建物: モデル単位の InstancedMesh（ゲームと同じ正規化） ──
  const byModel = new Map();
  for (const it of town.insts) {
    if (!it.kit || !it.model) continue;
    const k = it.kit + '|' + it.model;
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k).push(it);
  }
  for (const [k, insts] of byModel) {
    const [kit, model] = k.split('|');
    let tpl;
    try { tpl = await pvLoadModel(PV_KIT_DIR[kit] + model + '.glb'); } catch { continue; }
    const foot = Math.max(tpl.size.x, tpl.size.z, 0.1);
    const mats = insts.map((it) => {
      const sc = (PV_TARGET_FOOT[it.tier] || 12) / foot * (it.s || 1);
      return { x: it.x, y: H(it.x, it.z), z: it.z, ry: it.ry || 0, sx: sc, sy: sc, sz: sc };
    });
    pvInst(g0, tpl, mats);
  }
  // ── 道路: road-straight タイルをエッジごとに伸縮（交差点処理は省略） ──
  try {
    const road = await pvLoadModel('kenney_city-kit-roads/Models/GLB format/road-straight.glb');
    const rg = road.g.clone();
    if (road.size.z >= road.size.x) rg.rotateY(Math.PI / 2);   // レーンをZ向きへ（ゲームのnormTile相当）
    rg.computeBoundingBox();
    const rb = rg.boundingBox;
    rg.translate(-(rb.min.x + rb.max.x) / 2, -rb.min.y, -(rb.min.z + rb.max.z) / 2);
    const rw = Math.max(0.01, rb.max.x - rb.min.x), rl = Math.max(0.01, rb.max.z - rb.min.z);
    const mesh = new THREE.InstancedMesh(rg, road.mat, town.edges.length);
    mesh.frustumCulled = false;
    town.edges.forEach((e, i) => {
      const ya = H(e[0], e[2]) + 0.55, yb = H(e[3], e[5]) + 0.55;
      _pvDir.set(e[3] - e[0], yb - ya, e[5] - e[2]);
      const len = _pvDir.length() || 1;
      _pvDir.normalize();
      _pvRot.lookAt(_pvZero, _pvDir, _pvUp);
      _pvQ.setFromRotationMatrix(_pvRot);
      _pvP.set((e[0] + e[3]) / 2, (ya + yb) / 2, (e[2] + e[5]) / 2);
      _pvS.set(PV_ROAD_W / rw, 1, len / rl);
      _pvM.compose(_pvP, _pvQ, _pvS);
      mesh.setMatrixAt(i, _pvM);
    });
    g0.add(mesh);
  } catch { /* 道路タイル無し */ }
  // ── 公園: 生垣＋ゲート＋緑地＋噴水＋ランタン（ゲームのbuildParksと同アルゴリズム） ──
  const parks = parkEd.list.filter((pk) => pk.points.length >= 3);
  if (parks.length) {
    const [hedge, gateM, fR, fS, lant] = await Promise.all([
      pvLoadModel('fantasy_GLB format/hedge.glb'), pvLoadModel('fantasy_GLB format/hedge-gate.glb'),
      pvLoadModel('fantasy_GLB format/fountain-round-detail.glb'), pvLoadModel('fantasy_GLB format/fountain-square-detail.glb'),
      pvLoadModel('fantasy_GLB format/lantern.glb'),
    ]);
    const alignX = (m) => {
      if (m.size.z > m.size.x) {
        const gx = m.g.clone().rotateY(Math.PI / 2);
        gx.computeBoundingBox();
        return { g: gx, mat: m.mat, size: gx.boundingBox.getSize(new THREE.Vector3()) };
      }
      return m;
    };
    const hg = alignX(hedge), gt = alignX(gateM);
    const hs = 1.4 / Math.max(0.01, hg.size.y), gs = 1.4 / Math.max(0.01, gt.size.y), lsc = 2.4 / Math.max(0.01, lant.size.y);
    const hedgeLen = Math.max(0.5, hg.size.x * hs);
    const hMats = [], gMats = [], lMats = [], fMats = { R: [], S: [] };
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x4e8f3e, side: THREE.DoubleSide });
    for (const pk of parks) {
      const ctrl = pk.points.map((q) => ({ x: q[0], z: q[1] }));
      let cx = 0, cz = 0;
      for (const q of ctrl) { cx += q.x; cz += q.z; }
      cx /= ctrl.length; cz /= ctrl.length;
      const dense = sampleRoadPoints(pk.points, true, 2);
      dense.push({ x: dense[0].x, z: dense[0].z });
      const arc = [0];
      for (let i = 1; i < dense.length; i++) arc.push(arc[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
      const L = arc[arc.length - 1];
      if (L < hedgeLen * 3) continue;
      const at = (d, out) => {
        let i = 1;
        while (i < arc.length - 1 && arc[i] < d) i++;
        const t = (d - arc[i - 1]) / Math.max(0.001, arc[i] - arc[i - 1]);
        out.x = dense[i - 1].x + (dense[i].x - dense[i - 1].x) * t;
        out.z = dense[i - 1].z + (dense[i].z - dense[i - 1].z) * t;
        out.tx = dense[i].x - dense[i - 1].x; out.tz = dense[i].z - dense[i - 1].z;
        const tl = Math.hypot(out.tx, out.tz) || 1;
        out.tx /= tl; out.tz /= tl;
      };
      const n = Math.max(3, Math.round(L / hedgeLen));
      const segLen = L / n;
      const smp = {};
      let gateIdx = 0, gateBest = Infinity;
      for (let i = 0; i < n; i++) {
        at((i + 0.5) * segLen, smp);
        for (const e of town.edges) {
          const dx = smp.x - (e[0] + e[3]) / 2, dz = smp.z - (e[2] + e[5]) / 2;
          const d2 = dx * dx + dz * dz;
          if (d2 < gateBest) { gateBest = d2; gateIdx = i; }
        }
      }
      for (let i = 0; i < n; i++) {
        at((i + 0.5) * segLen, smp);
        const it = { x: smp.x, y: H(smp.x, smp.z) - 0.03, z: smp.z, ry: Math.atan2(-smp.tz, smp.tx) };
        if (i === gateIdx) { it.sx = segLen / Math.max(0.01, gt.size.x) * 1.04; it.sy = gs; it.sz = gs; gMats.push(it); }
        else { it.sx = segLen / Math.max(0.01, hg.size.x) * parkEd.ovr; it.sy = hs; it.sz = hs; hMats.push(it); }
      }
      const ring = sampleRoadPoints(pk.points, true, 4);
      const shp = new THREE.Shape();
      shp.moveTo(ring[0].x, ring[0].z);
      for (let i = 1; i < ring.length; i++) shp.lineTo(ring[i].x, ring[i].z);
      const gg = new THREE.ShapeGeometry(shp);
      const posA = gg.attributes.position;
      const nrm = new Float32Array(posA.count * 3);
      for (let i = 0; i < posA.count; i++) {
        const gx = posA.getX(i), gz = posA.getY(i);
        posA.setXYZ(i, gx, H(gx, gz) + 0.12, gz);
        nrm[i * 3 + 1] = 1;
      }
      gg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g0.add(new THREE.Mesh(gg, groundMat));
      const fsc = pk.fountain === 'square' ? 4.5 / Math.max(0.01, Math.max(fS.size.x, fS.size.z)) : 4.5 / Math.max(0.01, Math.max(fR.size.x, fR.size.z));
      (pk.fountain === 'square' ? fMats.S : fMats.R).push({ x: cx, y: H(cx, cz), z: cz, ry: 0, sx: fsc, sy: fsc, sz: fsc });
      for (const q of ctrl) {
        const dx = cx - q.x, dz = cz - q.z;
        const dl = Math.hypot(dx, dz) || 1;
        const lx = q.x + dx / dl * 1.4, lz = q.z + dz / dl * 1.4;
        lMats.push({ x: lx, y: H(lx, lz), z: lz, ry: Math.atan2(dx, dz), sx: lsc, sy: lsc, sz: lsc });
      }
    }
    pvInst(g0, hg, hMats);
    pvInst(g0, gt, gMats);
    pvInst(g0, fR, fMats.R);
    pvInst(g0, fS, fMats.S);
    pvInst(g0, lant, lMats);
  }
  // ── 森: 実樹木モデル（ゲームと同アルゴリズムの近似。道路/建物/水面/公園/急斜面を回避） ──
  await pvBuildForest(g0, H);
  scene.add(g0);
  gamePv.group = g0;
}
async function pvBuildForest(g0, H) {
  const size = terrain.data.size, half = size / 2;
  let rs = 0xF07E57 >>> 0;
  const rnd = () => {
    rs = (rs + 0x6D2B79F5) >>> 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const h2 = (ix, iz) => {
    let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) ^ 0x5F0E57;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, z, w) => {
    const fx = x / w, fz = z / w, ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
    const a = h2(ix, iz), b = h2(ix + 1, iz), c = h2(ix, iz + 1), d = h2(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
  // 占有グリッド（道路/建物/水面/公園）
  const OG = 8, gw = Math.ceil(size / OG) + 4, off = half + OG * 2;
  const occ = new Uint8Array(gw * gw);
  const mark = (x, z, rx, rz) => {
    const x0 = Math.max(0, Math.floor((x - rx + off) / OG)), x1 = Math.min(gw - 1, Math.floor((x + rx + off) / OG));
    const z0 = Math.max(0, Math.floor((z - rz + off) / OG)), z1 = Math.min(gw - 1, Math.floor((z + rz + off) / OG));
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) occ[cz * gw + cx] = 1;
  };
  for (const e of town.edges) {
    const len = Math.hypot(e[3] - e[0], e[5] - e[2]);
    const n = Math.max(1, Math.ceil(len / 4));
    for (let k = 0; k <= n; k++) mark(e[0] + (e[3] - e[0]) * k / n, e[2] + (e[5] - e[2]) * k / n, 13, 13);
  }
  for (const it of town.insts) {
    const foot = (PV_TARGET_FOOT[it.tier] || 12) * (it.s || 1) / 2 + 3;
    mark(it.x, it.z, foot, foot);
  }
  for (const w of waterEd.list) mark(w.x, w.z, w.w / 2 + 4, w.d / 2 + 4);
  const pip = (px, pz, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
      if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const pk of parkEd.list) {
    if (pk.points.length < 3) continue;
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const q of pk.points) { bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); bz0 = Math.min(bz0, q[1]); bz1 = Math.max(bz1, q[1]); }
    for (let cz = Math.max(0, Math.floor((bz0 + off) / OG)); cz <= Math.min(gw - 1, Math.floor((bz1 + off) / OG)); cz++) {
      for (let cx = Math.max(0, Math.floor((bx0 + off) / OG)); cx <= Math.min(gw - 1, Math.floor((bx1 + off) / OG)); cx++) {
        if (pip(cx * OG - off + OG / 2, cz * OG - off + OG / 2, pk.points)) occ[cz * gw + cx] = 1;
      }
    }
  }
  // 候補（ペイント優先・無ければ自動ノイズ）
  const FOREST_CELL = 7, FOREST_MAX = 9000;
  let cand = [];
  if (vegHasAny()) {
    const mres = vegEd.res, mcell = vegEd.cell, data = vegEd.data;
    const perCell = (mcell * mcell) / (FOREST_CELL * FOREST_CELL) * 1.15;
    for (let mz = 0; mz < mres; mz++) {
      for (let mx = 0; mx < mres; mx++) {
        const den = data[mz * mres + mx] / 255;
        if (den <= 0) continue;
        const cx0 = mx * mcell - half, cz0 = mz * mcell - half;
        const v = noise(cx0, cz0, 90) * 0.7 + noise(cx0 + 5555, cz0 - 2222, 28) * 0.3;
        const clump = 0.45 + Math.max(0, Math.min(1, (v - 0.3) / 0.4)) * 1.05;
        let n = perCell * den * clump;
        while (n > 0) {
          if (n < 1 && rnd() >= n) break;
          n -= 1;
          const x = cx0 + rnd() * mcell, z = cz0 + rnd() * mcell;
          if (x < -half + 6 || x > half - 6 || z < -half + 6 || z > half - 6) continue;
          if (occ[Math.floor((z + off) / OG) * gw + Math.floor((x + off) / OG)]) continue;
          cand.push(x, z);
        }
      }
    }
  } else {
    for (const th of [0.56, 0.62, 0.68, 0.74, 0.8]) {
      cand = [];
      rs = 0xF07E57 >>> 0;
      for (let gz = -half + 6; gz < half - 6; gz += FOREST_CELL) {
        for (let gx = -half + 6; gx < half - 6; gx += FOREST_CELL) {
          const d = noise(gx, gz, 130) * 0.75 + noise(gx + 7777, gz - 3333, 34) * 0.25;
          if (d < th) continue;
          const x = gx + (rnd() - 0.5) * FOREST_CELL * 0.9, z = gz + (rnd() - 0.5) * FOREST_CELL * 0.9;
          if (occ[Math.floor((z + off) / OG) * gw + Math.floor((x + off) / OG)]) continue;
          cand.push(x, z);
        }
      }
      if (cand.length / 2 <= FOREST_MAX * 1.5) break;
    }
  }
  const keep = Math.min(1, FOREST_MAX / Math.max(1, cand.length / 2));
  const spots = { L: [], S: [] };
  for (let i = 0; i < cand.length; i += 2) {
    if (rnd() > keep) continue;
    const x = cand[i], z = cand[i + 1];
    if (Math.abs(H(x + 3, z) - H(x - 3, z)) > 3.4 || Math.abs(H(x, z + 3) - H(x, z - 3)) > 3.4) continue;
    const y = Math.max(H(x, z), H(x + 1.5, z), H(x - 1.5, z), H(x, z + 1.5), H(x, z - 1.5));
    (rnd() < 0.72 ? spots.L : spots.S).push({ x, y: y + (vegHasAny() ? vegEd.yOff : -0.2), z, ry: rnd() * Math.PI * 2, s: 0.75 + rnd() * 0.6 });
  }
  const mkMats = (list, base) => list.map((t) => ({ x: t.x, y: t.y, z: t.z, ry: t.ry, sx: base * t.s, sy: base * t.s, sz: base * t.s }));
  if (vegHasAny() && vegEd.model) {
    try {
      const tm = await pvLoadModel(vegEd.model);
      const base = vegEd.treeH / Math.max(0.01, tm.size.y);
      pvInst(g0, tm, mkMats(spots.L.concat(spots.S), base));
      return;
    } catch { /* 既定の木へ */ }
  }
  try {
    const [tL, tS] = await Promise.all([
      pvLoadModel('kenney_city-kit-suburban_20/Models/GLB format/tree-large.glb'),
      pvLoadModel('kenney_city-kit-suburban_20/Models/GLB format/tree-small.glb'),
    ]);
    pvInst(g0, tL, mkMats(spots.L, 7.0 / Math.max(0.01, tL.size.y)));
    pvInst(g0, tS, mkMats(spots.S, 4.2 / Math.max(0.01, tS.size.y)));
  } catch { /* 樹木モデル無し */ }
}
function disposeGamePv(keepState) {
  if (gamePv.group) {
    scene.remove(gamePv.group);
    gamePv.group.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.type === 'ShapeGeometry') o.geometry.dispose(); });
    gamePv.group = null;
  }
  if (!keepState) {
    gamePv.on = false;
    $('btn-gamepv').className = 'sub';
    if (town.roadMesh) town.roadMesh.visible = true;
    if (town.bldMesh) town.bldMesh.visible = true;
    setStatus('実モデル表示OFF');
  }
}

async function saveMap() {
  const name = ($('save-name').value || 'map').replace(/[^\w\-]/g, '');
  const roads = roadEd.roads.filter((r) => r.points.length >= 2);
  const json = {
    format: 'plateau-map', version: 1, name,
    terrain: { ...serializeTerrain(terrain.data), attribution: false },
    roads,
    osmRoads: roads.some((r) => r.osm),   // OSM由来の道路を含む＝出典表記が必要なまま
    buildings: { seed: 20260706, removed: [...bldEd.removed], moved: bldEd.moved, added: bldEd.added },
    water: waterEd.list,
    forest: vegHasAny() ? { cell: vegEd.cell, res: vegEd.res, yOff: vegEd.yOff, model: vegEd.model || undefined, treeH: vegEd.treeH, data: b64(vegEd.data) } : undefined,
    parks: parkEd.list.filter((pk) => pk.points.length >= 3).map((pk) => ({ points: pk.points, fountain: pk.fountain || 'round' })),
    parkCfg: { hedgeOvr: parkEd.ovr },
  };
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'map', filename: name + '.map.json', content: JSON.stringify(json) }) });
    setStatus(r.ok ? `保存しました: maps/${name}.map.json → plateau-fly/?map=${name}` : '保存失敗: ' + r.status);
    refreshLoadList();
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}
async function refreshLoadList() {
  try {
    const files = await (await fetch('../maps/manifest.json')).json();
    const sel = $('load-list');
    sel.innerHTML = '';
    for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.map\.json$/, ''); sel.appendChild(o); }
  } catch { /* 開発サーバ以外 */ }
}
async function loadMap() {
  const f = $('load-list').value;
  if (!f) return;
  try {
    const j = await (await fetch('../maps/' + f)).json();
    buildTerrain(deserializeTerrain(j.terrain));
    roadEd.roads = (j.roads || []).map((r) => ({ points: (r.points || []).map((p) => [p[0], p[1]]), closed: !!r.closed, osm: !!r.osm }));
    roadEd.importedOsm = roadEd.roads.some((r) => r.osm);
    roadEd.active = null; roadEd.sel = null;
    renderRoads();
    const bj = j.buildings || {};
    bldEd.removed = new Set(bj.removed || []);
    bldEd.moved = bj.moved || {};
    bldEd.added = bj.added || [];
    bldEd.sel = -1;
    waterEd.list = (j.water || []).map((w) => ({ x: w.x, z: w.z, w: w.w || 100, d: w.d || 100, level: w.level || 0 }));
    waterEd.sel = -1;
    renderWater();
    parkEd.list = (j.parks || []).map((pk) => ({ points: (pk.points || []).map((q) => [q[0], q[1]]), fountain: pk.fountain || 'round' }));
    parkEd.ovr = j.parkCfg?.hedgeOvr ?? 1.1;
    $('park-ovr').value = String(parkEd.ovr); $('park-ovr-val').textContent = parkEd.ovr.toFixed(2);
    parkEd.active = null; parkEd.sel = null;
    renderParks();
    vegEd.data = null; vegEd.res = 0;
    if (j.forest && j.forest.data) {
      vegEd.cell = j.forest.cell || 16; vegEd.res = j.forest.res; vegEd.data = unb64(j.forest.data);
      vegEd.yOff = j.forest.yOff ?? 0;
      vegEd.model = j.forest.model || '';
      vegEd.treeH = j.forest.treeH || 7;
      $('veg-yoff').value = String(vegEd.yOff); $('veg-yoff-val').textContent = vegEd.yOff.toFixed(1);
      $('veg-h').value = String(vegEd.treeH); $('veg-h-val').textContent = vegEd.treeH.toFixed(1);
    }
    renderVeg();
    if (town.on) await refreshTown();
    $('save-name').value = j.name || f.replace(/\.map\.json$/, '');
    setStatus(`読み込み: ${f}（道路${roadEd.roads.length}本）`);
  } catch (e) { setStatus('読み込み失敗: ' + e.message); }
}

function syncLabels() {
  $('gen-amp-val').textContent = $('gen-amp').value;
  $('brush-r-val').textContent = $('brush-r').value;
  $('brush-s-val').textContent = $('brush-s').value;
  $('ac-flat-val').textContent = $('ac-flat').value;
  $('ac-hill-val').textContent = $('ac-hill').value;
  $('ac-steep-val').textContent = (parseFloat($('ac-steep').value) / 100).toFixed(2);
}

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ec6e6);
  scene.fog = new THREE.Fog(0x9ec6e6, 4000, 12000);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 30000);
  camera.position.set(1800, 1500, 1800);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xfff2dd, 1.6);
  dl.position.set(2000, 3000, 1200);
  scene.add(dl);

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.maxPolarAngle = Math.PI * 0.49;
  orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };   // 左＝ブラシ専用
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // ブラシリング
  brushMesh = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffe080, transparent: true, opacity: 0.8, depthTest: false }),
  );
  brushMesh.renderOrder = 5;
  scene.add(brushMesh);

  // 入力
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (vegEd.on) { if (e.button === 0) brushing = true; return; }   // 植生＝ブラシ扱い
    if (parkEd.on) { parkPointerDown(e); return; }
    if (waterEd.on) { waterPointerDown(e); return; }
    if (bldEd.on) { bldPointerDown(e); return; }
    if (roadEd.on) { roadPointerDown(e); return; }
    if (e.button === 0) brushing = true;
  });
  window.addEventListener('pointerup', () => {
    bldEd.dragging = false;
    waterEd.dragging = false;
    parkEd.dragging = false;
    if (roadEd.dragging) { roadEd.dragging = false; roadsChanged(); }
    if (brushing) {
      if (vegEd.on) renderVeg();              // 植生: 離したら確定描画
      else {
        if (town.on) drapeTown();             // ブラシを離したら町を地形に追従させ直す
        if (roadEd.roads.length) renderRoads(); // 道路ラインの高さも追従
      }
    }
    brushing = false;
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!terrain) return;
    if (!vegEd.on) {   // 植生モードはブラシリング＋塗りのパスをそのまま使う
      if (parkEd.on) { parkPointerMove(e); return; }
      if (waterEd.on) { waterPointerMove(e); return; }
      if (bldEd.on) { bldPointerMove(e); return; }
      if (roadEd.on) { roadPointerMove(e); return; }
    }
    const p = pickGround(e);
    if (p) {
      brushMesh.visible = true;
      brushMesh.position.set(p.x, p.y + 1.5, p.z);
      const r = parseFloat($('brush-r').value);
      brushMesh.scale.set(r, 1, r);
      if (brushing) applyBrush(p, Math.min(clock.getDelta(), 0.05) + 0.016, e.shiftKey);
    } else brushMesh.visible = false;
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (roadEd.on && (e.code === 'Delete' || e.code === 'Backspace')) roadDeletePoint();
    if (roadEd.on && e.code === 'Escape') { roadEd.active = null; roadEd.sel = null; renderRoads(); }
    if (bldEd.on && (e.code === 'Delete' || e.code === 'Backspace')) bldDeleteSel();
    if (bldEd.on && e.code === 'KeyR') bldRotateSel(e.shiftKey ? -Math.PI / 8 : Math.PI / 8);
    if (bldEd.on && e.code === 'Escape') { bldEd.sel = -1; bldEd.placing = null; updateBldSelMarker(); }
    if (waterEd.on && (e.code === 'Delete' || e.code === 'Backspace')) waterDeleteSel();
    if (waterEd.on && e.code === 'Escape') { waterEd.sel = -1; waterEd.placing = false; renderWater(); }
    if (parkEd.on && (e.code === 'Delete' || e.code === 'Backspace')) parkDeletePoint();
    if (parkEd.on && e.code === 'Escape') { parkEd.active = null; parkEd.sel = null; renderParks(); }
  });

  // UI
  for (const id of ['gen-amp', 'brush-r', 'brush-s', 'ac-flat', 'ac-hill', 'ac-steep']) $(id).addEventListener('input', syncLabels);
  syncLabels();
  $('btn-flat').addEventListener('click', () => { const d = makeTerrainData({}); autoColorize(d, acRules()); buildTerrain(d); });
  $('btn-noise').addEventListener('click', () => {
    const d = makeTerrainData({});
    noiseTerrain(d, { seed: parseInt($('gen-seed').value) || 1, amp: parseFloat($('gen-amp').value) });
    autoColorize(d, acRules());
    buildTerrain(d);
  });
  $('btn-autocolor').addEventListener('click', () => { autoColorize(terrain.data, acRules()); terrain.refreshAll(); setStatus('自動配色を適用'); });
  $('tool-raise').addEventListener('click', () => setTool('raise'));
  $('tool-lower').addEventListener('click', () => setTool('lower'));
  $('tool-smooth').addEventListener('click', () => setTool('smooth'));
  $('tool-flatten').addEventListener('click', () => setTool('flatten'));
  $('tool-paint').addEventListener('click', () => setTool('paint'));
  $('btn-town').addEventListener('click', () => { toggleTown().catch((e) => setStatus('町プレビュー失敗: ' + e.message)); });
  $('btn-gamepv').addEventListener('click', () => {
    if (gamePv.busy) return;
    if (gamePv.on) { disposeGamePv(); return; }
    gamePv.busy = true;
    setStatus('実モデル読込中…（初回はGLB取得に数秒）');
    buildGamePreview().then(() => {
      gamePv.on = true;
      $('btn-gamepv').className = 'on';
      if (town.roadMesh) town.roadMesh.visible = false;
      if (town.bldMesh) town.bldMesh.visible = false;
      setStatus('🎮 実モデル表示中（編集を反映するにはもう一度OFF→ON）');
    }).catch((e) => { setStatus('実モデル表示失敗: ' + e.message); console.error(e); })
      .finally(() => { gamePv.busy = false; });
  });
  $('btn-road-mode').addEventListener('click', () => setRoadMode(!roadEd.on));
  $('btn-road-new').addEventListener('click', () => {
    if (!roadEd.on) setRoadMode(true);
    roadEd.active = { points: [], closed: false };
    roadEd.roads.push(roadEd.active);
    roadEd.sel = null;
    renderRoads();
    setStatus('新しい道路: 地形をクリックして点を追加（右クリックで引き終わり）');
  });
  $('btn-road-delpt').addEventListener('click', roadDeletePoint);
  $('btn-road-delroad').addEventListener('click', roadDeleteRoad);
  $('btn-road-import').addEventListener('click', () => {
    if (!roadEd.on) setRoadMode(true);
    importOsmRoads().catch((e) => setStatus('OSM取り込み失敗: ' + e.message));
  });
  $('btn-road-flatten').addEventListener('click', flattenUnderRoads);
  $('btn-water-mode').addEventListener('click', () => setWaterMode(!waterEd.on));
  $('btn-water-add').addEventListener('click', () => {
    if (!waterEd.on) setWaterMode(true);
    waterEd.placing = true;
    setStatus('地形をクリックして水面を設置');
  });
  $('btn-water-del').addEventListener('click', waterDeleteSel);
  for (const [id, key] of [['water-w', 'w'], ['water-d', 'd'], ['water-lv', 'level']]) {
    $(id).addEventListener('input', () => {
      const w = waterEd.list[waterEd.sel];
      if (!w) return;
      w[key] = parseFloat($(id).value);
      $(id + '-val').textContent = key === 'level' ? w.level.toFixed(1) : String(Math.round(w[key]));
      const mesh = waterEd.group.children[waterEd.sel];
      if (mesh) { mesh.position.y = w.level; mesh.scale.set(w.w, 1, w.d); }
    });
  }
  $('btn-park-mode').addEventListener('click', () => setParkMode(!parkEd.on));
  $('btn-park-new').addEventListener('click', () => {
    if (!parkEd.on) setParkMode(true);
    parkEd.active = { points: [], fountain: $('park-fountain').value };
    parkEd.list.push(parkEd.active);
    parkEd.sel = null;
    renderParks();
    setStatus('新しい公園: 地形をクリックして頂点を追加（3点以上で閉じた領域・右クリックで引き終わり）');
  });
  $('btn-park-delpt').addEventListener('click', parkDeletePoint);
  $('btn-park-del').addEventListener('click', parkDeletePark);
  $('park-fountain').addEventListener('change', () => {
    const pk = parkEd.sel?.park || parkEd.active;
    if (pk) pk.fountain = $('park-fountain').value;
  });
  $('park-ovr').addEventListener('input', () => {
    parkEd.ovr = parseFloat($('park-ovr').value);
    $('park-ovr-val').textContent = parkEd.ovr.toFixed(2);
  });
  $('park-ovr').addEventListener('change', () => {   // スライダを離したら実モデル表示を再構築
    if (!gamePv.on || gamePv.busy) return;
    gamePv.busy = true;
    setStatus('生垣を再構築中…');
    buildGamePreview().then(() => setStatus('🎮 実モデル表示中（生垣の重なり ' + parkEd.ovr.toFixed(2) + '）'))
      .catch((e) => setStatus('再構築失敗: ' + e.message))
      .finally(() => { gamePv.busy = false; });
  });
  $('btn-veg-mode').addEventListener('click', () => setVegMode(!vegEd.on));
  $('btn-veg-clear').addEventListener('click', vegClear);
  $('btn-veg-settings').addEventListener('click', () => {
    $('veg-modal').style.display = 'flex';
    fillVegModels().catch(() => { /* noop */ });
  });
  $('veg-model-filter').addEventListener('input', () => { fillVegModels().catch(() => { /* noop */ }); });
  $('veg-model').addEventListener('change', () => { vegEd.model = $('veg-model').value; });
  $('veg-h').addEventListener('input', () => {
    vegEd.treeH = parseFloat($('veg-h').value);
    $('veg-h-val').textContent = vegEd.treeH.toFixed(1);
    vegEd.dirty = true;
  });
  $('btn-veg-modal-close').addEventListener('click', () => { $('veg-modal').style.display = 'none'; });
  $('veg-yoff').addEventListener('input', () => {
    vegEd.yOff = parseFloat($('veg-yoff').value);
    $('veg-yoff-val').textContent = vegEd.yOff.toFixed(1);
    vegEd.dirty = true;   // 8Hz間引きでプレビュー再構築（スライダ連打でも軽い）
  });
  $('veg-d').addEventListener('input', () => { $('veg-d-val').textContent = parseFloat($('veg-d').value).toFixed(2); });
  $('btn-bld-mode').addEventListener('click', () => setBldMode(!bldEd.on));
  $('btn-bld-del').addEventListener('click', bldDeleteSel);
  for (const tier of ['house', 'mid', 'tower']) {
    $('btn-bld-add-' + tier).addEventListener('click', () => {
      if (!bldEd.on) setBldMode(true);
      bldEd.placing = tier;
      setStatus(`地形をクリックして${tier === 'house' ? '住宅' : tier === 'mid' ? '中層ビル' : '高層ビル'}を設置`);
    });
  }
  $('btn-save').addEventListener('click', saveMap);
  $('btn-load').addEventListener('click', loadMap);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 初期地形（ノイズ）
  const d = makeTerrainData({});
  noiseTerrain(d, { seed: 1, amp: 260 });
  autoColorize(d);
  buildTerrain(d);
  refreshLoadList();
  renderer.setAnimationLoop(() => {
    if (vegEd.dirty && performance.now() - vegEd.lastBuild > 150) renderVeg();   // 塗り中は8Hzで再構築
    renderer.render(scene, camera);
  });
  setStatus('左ドラッグで地形を編集（右ドラッグ視点/ホイールズーム）');
}
init();
