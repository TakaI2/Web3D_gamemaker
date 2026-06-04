// stage-editor.js — 俯瞰ビューで public/models/ のモデルをマウス配置し stage.json を保存。
// スケールは Model Editor の設定値(selection.json scales)準拠。位置・回転をエディタで調整。
// swing-catch が stage.json を読んで静的な置物として配置する。

import * as THREE from 'https://esm.sh/three@0.184.0';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';

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

async function ensureTemplate(file) {
  if (templates.has(file)) return templates.get(file);
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(modelURL(file));
  const obj = gltf.scene;
  _box.setFromObject(obj);
  _box.getCenter(_v); _box.getSize(_v2);
  const maxDim = Math.max(_v2.x, _v2.y, _v2.z) || 1;
  const scale = scales.get(file) || (1.5 / maxDim);
  obj.position.set(-_v.x, -_box.min.y, -_v.z);   // 底面中心を原点へ
  const group = new THREE.Group(); group.add(obj);
  const tpl = { group, scale };
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
function onDown(e) { downX = e.clientX; downY = e.clientY; }
function onUp(e) {
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;   // ドラッグは回転扱い
  setRay(e);
  const it = pickInstance();
  if (it) { selectItem(it); return; }
  const gh = raycaster.intersectObject(ground);
  if (gh.length && currentModel) placeModel(currentModel, gh[0].point.x, gh[0].point.z).then((x) => selectItem(x));
}
function onContext(e) {
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
  scene.add(new THREE.GridHelper(ROOM, ROOM, 0x5577aa, 0x3a4660));
  stageGroup = new THREE.Group(); scene.add(stageGroup);

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
  renderer.domElement.addEventListener('contextmenu', onContext);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}

init();
