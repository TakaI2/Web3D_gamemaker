// stage-editor.js — 俯瞰ビューで public/models/ のモデルをマウス配置し stage.json を保存。
// スケールは Model Editor の設定値(selection.json scales)準拠。位置・回転をエディタで調整。
// swing-catch が stage.json を読んで静的な置物として配置する。

import * as THREE from 'https://esm.sh/three@0.184.0';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { generate, sampleSpline } from '../lib/city-gen.js';

const ROOM = 30;                 // swing-catch のアリーナ床（X,Z）
const $ = (id) => document.getElementById(id);
function toast(m) { const el = $('toast'); el.textContent = m; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200); }

let renderer, scene, camera, controls, ground, stageGroup;
let modelFiles = [];
const scales = new Map();
const templates = new Map();      // file -> 正規化テンプレートGroup（底面中心が原点・未スケール）
const items = [];                 // { file, x, y, z, ry, scale, mesh }
let currentModel = null;          // パレットで選択中のモデル
let selected = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function modelURL(file) {
  return new URL('../models/' + file.split('/').map(encodeURIComponent).join('/'), window.location.href).href;
}

// ── サムネ生成（小型レンダラで1枚ずつ）──
const THUMB = 120;
let thumbR, thumbScene, thumbCam;
function initThumb() {
  thumbR = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  thumbR.setSize(THUMB, THUMB); thumbR.setClearColor(0x222a38, 1); thumbR.outputColorSpace = THREE.SRGBColorSpace;
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const d = new THREE.DirectionalLight(0xffffff, 1.4); d.position.set(2, 3, 2.5); thumbScene.add(d);
  thumbCam = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
}
function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; for (const x of m) { for (const k in x) { const v = x[k]; if (v && v.isTexture) v.dispose(); } x.dispose(); } }
  });
}
async function renderThumb(file) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelURL(file));
  const obj = gltf.scene; thumbScene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = (maxDim * 0.5) / Math.tan((40 * Math.PI / 180) / 2) * 1.5;
  thumbCam.position.set(dist * 0.6, dist * 0.5, dist * 0.9);
  thumbCam.near = dist / 100; thumbCam.far = dist * 100; thumbCam.updateProjectionMatrix(); thumbCam.lookAt(0, 0, 0);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL('image/png');
  thumbScene.remove(obj); disposeObject(obj);
  return url;
}
function buildPalette() {
  const el = $('palette'); el.innerHTML = '';
  for (const file of modelFiles) {
    const cell = document.createElement('div'); cell.className = 'tcell'; cell.dataset.file = file;
    const nm = file.replace(/^.*\//, '').replace(/\.glb$/i, '');
    cell.innerHTML = `<img alt="${nm}"><div class="nm" title="${file}">${nm}</div>`;
    cell.onclick = () => { currentModel = file; document.querySelectorAll('.tcell').forEach(c => c.classList.toggle('sel', c.dataset.file === file)); };
    el.appendChild(cell);
  }
}
async function generatePaletteThumbs() {
  initThumb();
  for (const file of modelFiles) {
    const img = document.querySelector(`.tcell[data-file="${CSS.escape(file)}"] img`);
    try { const u = await renderThumb(file); if (img) img.src = u; } catch { if (img) img.alt = '×'; }
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function ensureTemplate(file, forceScale) {
  if (templates.has(file)) return templates.get(file);
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelURL(file));
  const obj = gltf.scene;
  _box.setFromObject(obj);
  _box.getCenter(_v); _box.getSize(_v2);
  const maxDim = Math.max(_v2.x, _v2.y, _v2.z) || 1;
  const scale = forceScale != null ? forceScale : (scales.get(file) || (1.5 / maxDim));   // キットタイルは 1 固定
  obj.position.set(-_v.x, -_box.min.y, -_v.z);   // 底面中心を原点へ
  const group = new THREE.Group(); group.add(obj);
  const tpl = { group, scale, size: { x: _v2.x, y: _v2.y, z: _v2.z } };   // size=素bbox（footprint用）
  templates.set(file, tpl);
  return tpl;
}

async function placeModel(file, x, z, ry = 0, y = 0) {
  const tpl = await ensureTemplate(file);
  const mesh = tpl.group.clone(true);
  mesh.scale.setScalar(tpl.scale);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  stageGroup.add(mesh);
  const item = { file, x, y, z, ry, scale: tpl.scale, mesh };
  mesh.userData.item = item;
  items.push(item);
  buildItemList();
  return item;
}

function removeItem(item) {
  stageGroup.remove(item.mesh);
  const i = items.indexOf(item); if (i >= 0) items.splice(i, 1);
  if (selected === item) selectItem(null);
  buildItemList();
}

// ── 選択・プロパティ ──
function selectItem(item) {
  selected = item;
  $('props').style.display = item ? 'block' : 'none';
  $('props-hint').style.display = item ? 'none' : 'block';
  $('sel-name').textContent = item ? item.file.replace(/^.*\//, '').replace(/\.glb$/i, '') : '未選択';
  if (!item) return;
  setSlider('px', item.x); setSlider('pz', item.z); setSlider('py', item.y); setSlider('ry', item.ry * 180 / Math.PI);
  highlightList();
}
function setSlider(id, v) { $(id).value = String(v); $(id + '-v').textContent = (+v).toFixed(id === 'ry' ? 0 : 1); }

function applyProps() {
  if (!selected) return;
  selected.x = parseFloat($('px').value); $('px-v').textContent = selected.x.toFixed(1);
  selected.z = parseFloat($('pz').value); $('pz-v').textContent = selected.z.toFixed(1);
  selected.y = parseFloat($('py').value); $('py-v').textContent = selected.y.toFixed(1);
  const deg = parseFloat($('ry').value); $('ry-v').textContent = deg.toFixed(0);
  selected.ry = deg * Math.PI / 180;
  selected.mesh.position.set(selected.x, selected.y, selected.z);
  selected.mesh.rotation.y = selected.ry;
}

function buildItemList() {
  const el = $('item-list'); el.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'w'; b.textContent = it.file.replace(/^.*\//, '').replace(/\.glb$/i, '');
    b.style.textAlign = 'left'; b.dataset.sel = (it === selected) ? '1' : '';
    if (it === selected) b.classList.add('prim');
    b.onclick = () => selectItem(it);
    el.appendChild(b);
  });
}
function highlightList() { buildItemList(); }

// ── マウス操作（左ドラッグ：視点回転[OrbitControls] / 左クリック：配置・選択 / 右クリック：削除）──
let downX = 0, downY = 0;
function setRay(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}
function pickInstance() {
  const hit = raycaster.intersectObjects(stageGroup.children, true);
  if (!hit.length) return null;
  let n = hit[0].object; while (n && !n.userData.item) n = n.parent;
  return n ? n.userData.item : null;
}
function onDown(e) { downX = e.clientX; downY = e.clientY; if (mode === 'city') cityOnDown(e); }
function onUp(e) {
  if (mode === 'city') return cityOnUp(e);
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;   // ドラッグは回転扱い
  setRay(e);
  const it = pickInstance();
  if (it) { selectItem(it); return; }
  const gh = raycaster.intersectObject(ground);
  if (gh.length && currentModel) placeModel(currentModel, gh[0].point.x, gh[0].point.z).then((x) => selectItem(x));
}
function onContext(e) {
  if (mode === 'city') return cityOnContext(e);
  e.preventDefault();
  setRay(e);
  const it = pickInstance();
  if (it) removeItem(it);
}

// ── 保存/読込（複数ステージ: public/stages/<id>.stage.json）──
function clearStage() { for (const it of [...items]) removeItem(it); }

function stageData() { return { version: 1, room: ROOM, items: items.map(i => ({ model: i.file, x: i.x, y: i.y, z: i.z, ry: i.ry, scale: i.scale })) }; }

async function save() {
  const id = ($('stage-id').value || '').trim();
  if (!id) { toast('ステージIDを入力してください'); return; }
  const filename = id + '.stage.json';
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'stage', filename, content: stageData() }) });
    if (r.ok) { const j = await r.json(); toast(`保存: ${j.path}（${items.length}個）`); await populateStageSelect(filename); return; }
  } catch { /* noop */ }
  // フォールバック: ダウンロード
  const blob = new Blob([JSON.stringify(stageData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  toast('ダウンロードしました（サーバー保存不可）');
}

async function loadStageFile(file) {
  clearStage();
  try { const r = await fetch('../stages/' + file); if (r.ok) { const j = await r.json(); for (const it of (j.items || [])) await placeModel(it.model, it.x, it.z, it.ry || 0, it.y || 0); } }
  catch { /* noop */ }
}

// 旧 models/stage.json を取り込む（移行用）
async function importLegacy() {
  clearStage();
  try { const r = await fetch('../models/stage.json'); if (r.ok) { const j = await r.json(); for (const it of (j.items || [])) await placeModel(it.model, it.x, it.z, it.ry || 0, it.y || 0); toast('現行 stage.json を取り込みました'); } else toast('現行 stage.json がありません'); }
  catch { toast('取込失敗'); }
}

async function populateStageSelect(current) {
  const sel = $('stage-select');
  let files = [];
  try { const r = await fetch('../stages/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  sel.innerHTML = '<option value="">(新規)</option>';
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.stage\.json$/, ''); sel.appendChild(o); }
  if (current && files.includes(current)) sel.value = current;
  sel.onchange = async () => {
    const f = sel.value;
    if (!f) { clearStage(); $('stage-id').value = ''; return; }
    $('stage-id').value = f.replace(/\.stage\.json$/, '');
    await loadStageFile(f);
  };
  return files;
}

// ============================================================
// 都市モード（プロシージャル）— スプライン道路/線路 → 生成 → .city.json 保存
// ============================================================
const ROAD_DIR = 'kenney_city-kit-roads/Models/GLB format/';
const SUB_DIR  = 'kenney_city-kit-suburban_20/Models/GLB format/';
const TILESET = { straight: ROAD_DIR + 'road-straight.glb', bend: ROAD_DIR + 'road-bend.glb', tee: ROAD_DIR + 'road-intersection.glb', cross: ROAD_DIR + 'road-crossroad.glb', end: ROAD_DIR + 'road-end.glb' };
const BUILDING_KIT = 'abcdefghijklmnopqrstu'.split('').map(c => SUB_DIR + 'building-type-' + c + '.glb');
const cityWorld = { cell: 1, chunkCells: 16, grid: { cols: 64, rows: 64 }, origin: [-32, 0, -32], bounds: [-32, -32, 32, 32] };

let mode = 'prop';
const splines = [];          // { id, kind:'road'|'rail', points:[[x,z]], closed, handles:[] }
let activeSpline = null;
let cityGroup, railGroup, splineGroup, gridHelper;
let dragHandle = null;       // { spline, index }
let lastCity = null;         // { chunks, rails }
let _sid = 0;
const HANDLE_GEO = new THREE.SphereGeometry(0.5, 12, 8);

function setMode(m) {
  mode = m;
  $('prop-panel').style.display = m === 'prop' ? '' : 'none';
  $('city-panel').style.display = m === 'city' ? '' : 'none';
  $('prop-topbar').style.display = m === 'prop' ? 'flex' : 'none';
  $('city-topbar').style.display = m === 'city' ? 'flex' : 'none';
  $('btn-mode').textContent = m === 'prop' ? '都市モード' : '配置モード';
  stageGroup.visible = m === 'prop';
  cityGroup.visible = railGroup.visible = splineGroup.visible = (m === 'city');
  resizeGround(m === 'city' ? cityWorld.grid.cols * cityWorld.cell : ROOM);
}
function resizeGround(S) {
  ground.geometry.dispose(); ground.geometry = new THREE.PlaneGeometry(S, S);
  if (gridHelper) scene.remove(gridHelper);
  gridHelper = new THREE.GridHelper(S, S, 0x5577aa, 0x3a4660); scene.add(gridHelper);
}

function newSpline(kind) {
  activeSpline = { id: 's' + (++_sid), kind, points: [], closed: $('spline-closed').checked, handles: [] };
  splines.push(activeSpline);
  buildSplineList();
  toast(kind === 'road' ? '道路: 地面クリックで制御点追加' : '線路: 地面クリックで制御点追加');
}
function buildSplineList() {
  const el = $('spline-list'); el.innerHTML = '';
  splines.forEach((sp) => {
    const b = document.createElement('button'); b.className = 'w';
    b.textContent = `${sp.kind === 'road' ? '道路' : '線路'} ${sp.id}（${sp.points.length}点）${sp === activeSpline ? ' ◀' : ''}`;
    if (sp === activeSpline) b.classList.add('prim');
    b.onclick = () => { activeSpline = sp; buildSplineList(); };
    el.appendChild(b);
  });
}
function rebuildSplineViz() {
  splineGroup.clear();
  for (const sp of splines) {
    sp.handles = [];
    sp.points.forEach((p, i) => {
      const mk = new THREE.Mesh(HANDLE_GEO, new THREE.MeshBasicMaterial({ color: sp.kind === 'road' ? 0x66ccff : 0xffaa44 }));
      mk.position.set(p[0], 0.3, p[1]); mk.userData.handle = { spline: sp, index: i };
      splineGroup.add(mk); sp.handles.push(mk);
    });
    if (sp.points.length >= 2) {
      const poly = sampleSpline(sp.points, sp.closed, 12);
      const pts = poly.map(q => new THREE.Vector3(q.x, 0.25, q.z));
      splineGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: sp.kind === 'road' ? 0x66ccff : 0xffaa44 })));
    }
  }
  buildSplineList();
}

function authoredFromUI() {
  return {
    seed: parseInt($('city-seed').value) || 1337,
    params: { suburbSpacing: parseInt($('city-spacing').value) || 2, suburbSetback: 0.15, rySign: parseInt($('city-rysign').value) || -1 },
    splines: splines.map(s => ({ id: s.id, kind: s.kind, closed: s.closed, points: s.points.map(p => p.slice()) })),
  };
}
async function regenerate() {
  const authored = authoredFromUI();
  const rySign = authored.params.rySign;
  for (const f of Object.values(TILESET)) { try { await ensureTemplate(f, 1); } catch (e) { console.warn('タイル読込失敗', f, e); } }
  for (const f of BUILDING_KIT) { try { await ensureTemplate(f, 1); } catch { /* 欠けは無視 */ } }
  const kit = BUILDING_KIT.filter(f => templates.has(f));
  const ctx = {
    tileset: TILESET, tileScale: 1, rySign, buildingKit: kit,
    footprint: (m) => (templates.get(m)?.size) || { x: 1, y: 1, z: 1 },
    buildingScale: () => 1,
    rail: { width: cityWorld.cell * 0.7, height: 0.35, step: cityWorld.cell },
  };
  lastCity = generate(authored, cityWorld, ctx);
  renderCity(lastCity);
  const items = lastCity.chunks.reduce((n, c) => n + c.items.length, 0);
  $('city-stats').textContent = `チャンク ${lastCity.chunks.length} / 配置 ${items} / 線路 ${lastCity.rails.length} セグ`;
}
function renderCity(city) {
  cityGroup.clear(); railGroup.clear();
  for (const ch of city.chunks) {
    for (const it of ch.items) {
      const tpl = templates.get(it.model); if (!tpl) continue;
      const mesh = tpl.group.clone(true);
      mesh.scale.setScalar(it.scale || 1);
      mesh.position.set(it.x, it.y || 0, it.z);
      mesh.rotation.y = it.ry || 0;
      cityGroup.add(mesh);
    }
  }
  const bedMat = new THREE.MeshStandardMaterial({ color: 0x4a4f5c, roughness: 0.85 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0ad, roughness: 0.5, metalness: 0.3 });
  for (const s of city.rails) {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(s.width, s.height, s.len), bedMat);
    bed.position.set(s.x, s.height / 2, s.z); bed.rotation.y = s.ry; railGroup.add(bed);
    for (const off of [-s.width * 0.3, s.width * 0.3]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.12, 0.06, s.len), railMat);
      rail.position.set(s.x + Math.cos(s.ry) * off, s.height + 0.03, s.z - Math.sin(s.ry) * off);
      rail.rotation.y = s.ry; railGroup.add(rail);
    }
  }
}

function cityData() {
  const a = authoredFromUI();
  return {
    version: 3, kind: 'city', seed: a.seed, world: cityWorld,
    kits: { roads: ROAD_DIR.replace(/\/$/, ''), suburban: SUB_DIR.replace(/\/$/, ''), downtown: 'city_GLB format' },
    authored: { splines: a.splines, params: a.params },
    chunks: lastCity ? lastCity.chunks : [],
    rails: lastCity ? lastCity.rails : [],
  };
}
async function saveCity() {
  const id = ($('city-id').value || '').trim();
  if (!id) { toast('都市IDを入力してください'); return; }
  if (!lastCity) { toast('先に「生成」してください'); return; }
  const filename = id + '.city.json';
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'city', filename, content: cityData() }) });
    if (r.ok) { const j = await r.json(); toast(`保存: ${j.path}`); await populateCitySelect(filename); return; }
  } catch { /* noop */ }
  const blob = new Blob([JSON.stringify(cityData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  toast('ダウンロードしました');
}
async function populateCitySelect(current) {
  const sel = $('city-select'); let files = [];
  try { const r = await fetch('../cities/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  sel.innerHTML = '<option value="">(新規)</option>';
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.city\.json$/, ''); sel.appendChild(o); }
  if (current && files.includes(current)) sel.value = current;
  sel.onchange = async () => { const f = sel.value; if (!f) return; $('city-id').value = f.replace(/\.city\.json$/, ''); await loadCityFile(f); };
  return files;
}
async function loadCityFile(file) {
  try {
    const r = await fetch('../cities/' + file); if (!r.ok) return;
    const j = await r.json();
    splines.length = 0; _sid = 0;
    for (const s of (j.authored?.splines || [])) splines.push({ id: s.id || ('s' + (++_sid)), kind: s.kind, closed: !!s.closed, points: (s.points || []).map(p => p.slice()), handles: [] });
    activeSpline = splines[splines.length - 1] || null;
    if (j.seed != null) $('city-seed').value = j.seed;
    const pr = j.authored?.params || {};
    if (pr.suburbSpacing) { $('city-spacing').value = pr.suburbSpacing; $('city-spacing-v').textContent = pr.suburbSpacing; }
    if (pr.rySign) $('city-rysign').value = String(pr.rySign);
    rebuildSplineViz();
    await regenerate();
  } catch (e) { console.warn('都市読込失敗', e); }
}

// 都市モードのポインタ操作
function cityOnDown(e) {
  if (e.button !== 0) return;
  setRay(e);
  const hs = splineGroup.children.filter(o => o.userData.handle);
  const hit = raycaster.intersectObjects(hs, false);
  if (hit.length) { dragHandle = hit[0].object.userData.handle; controls.enabled = false; }
}
function cityOnMove(e) {
  if (!dragHandle) return;
  setRay(e);
  const gh = raycaster.intersectObject(ground);
  if (gh.length) { dragHandle.spline.points[dragHandle.index] = [gh[0].point.x, gh[0].point.z]; rebuildSplineViz(); }
}
function cityOnUp(e) {
  if (e.button !== 0) return;
  if (dragHandle) { dragHandle = null; controls.enabled = true; regenerate(); return; }
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;   // ドラッグ=視点回転
  setRay(e);
  const hs = splineGroup.children.filter(o => o.userData.handle);
  if (raycaster.intersectObjects(hs, false).length) return;   // ハンドルクリックは追加しない
  const gh = raycaster.intersectObject(ground);
  if (gh.length && activeSpline) { activeSpline.points.push([gh[0].point.x, gh[0].point.z]); rebuildSplineViz(); }
}
function cityOnContext(e) {
  e.preventDefault(); setRay(e);
  const hs = splineGroup.children.filter(o => o.userData.handle);
  const hit = raycaster.intersectObjects(hs, false);
  if (hit.length) { const h = hit[0].object.userData.handle; h.spline.points.splice(h.index, 1); rebuildSplineViz(); regenerate(); }
}

// ── init ──
async function init() {
  const app = $('app');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x223047);
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 38, 30);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;     // 地面より下に回り込まない
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY };   // 右は削除用に空ける（左ドラッグで回転）

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xfff4e0, 1.5); dl.position.set(10, 20, 8); scene.add(dl);

  // 床（配置用レイ対象）＋ グリッド
  ground = new THREE.Mesh(new THREE.PlaneGeometry(ROOM, ROOM), new THREE.MeshStandardMaterial({ color: 0x2f3a52, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  gridHelper = new THREE.GridHelper(ROOM, ROOM, 0x5577aa, 0x3a4660); scene.add(gridHelper);
  stageGroup = new THREE.Group(); scene.add(stageGroup);
  cityGroup = new THREE.Group(); railGroup = new THREE.Group(); splineGroup = new THREE.Group();
  scene.add(cityGroup); scene.add(railGroup); scene.add(splineGroup);

  // モデル一覧 + スケール
  try { const r = await fetch('../models/manifest.json'); if (r.ok) modelFiles = await r.json(); } catch { /* noop */ }
  try { const r = await fetch('../models/selection.json'); if (r.ok) { const j = await r.json(); if (j.scales) for (const k in j.scales) scales.set(k, j.scales[k]); } } catch { /* noop */ }
  modelFiles = (modelFiles || []).filter(f => /\.glb$/i.test(f)).sort();
  buildPalette();
  generatePaletteThumbs();   // サムネを順次生成（非同期）

  // ステージ一覧を読み、あれば先頭を表示、無ければ旧 stage.json を取り込んで継続
  const files = await populateStageSelect();
  if (files.length) { $('stage-select').value = files[0]; $('stage-id').value = files[0].replace(/\.stage\.json$/, ''); await loadStageFile(files[0]); }
  else { await importLegacy(); }

  $('btn-save').onclick = save;
  $('btn-new').onclick = () => { clearStage(); $('stage-id').value = ''; $('stage-select').value = ''; };
  $('btn-import').onclick = importLegacy;
  $('btn-del').onclick = () => { if (selected) removeItem(selected); };
  for (const id of ['px', 'pz', 'py', 'ry']) $(id).oninput = applyProps;
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointermove', (e) => { if (mode === 'city') cityOnMove(e); });
  renderer.domElement.addEventListener('contextmenu', onContext);
  // 都市モード配線
  $('btn-mode').onclick = () => setMode(mode === 'prop' ? 'city' : 'prop');
  $('btn-spline-road').onclick = () => newSpline('road');
  $('btn-spline-rail').onclick = () => newSpline('rail');
  $('btn-regen').onclick = () => regenerate();
  $('btn-city-save').onclick = saveCity;
  $('city-spacing').oninput = () => { $('city-spacing-v').textContent = $('city-spacing').value; };
  await populateCitySelect();
  setMode('prop');
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

init();
