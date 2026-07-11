// room-editor.js — kenney_furniture-kit で部屋（外殻＋家具）をプロシージャル生成し、
// ギズモで手動調整して public/rooms/*.room.json に保存するエディタ。
// 生成は lib/room-gen.js（決定的・セル座標）。実寸は floorFull の bbox から TILE を実測して換算。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { generateRoom, generateHouse, ROOM_TYPES, categorize } from '../lib/room-gen.js';

const KIT_DIR = '../models/kenney_furniture-kit/Models/GLTF format/';

let renderer, scene, camera, orbit, gizmo;
let roomGroup = null;        // 生成された外殻＋家具（再生成で全入替）
const manualGroup = new THREE.Group();   // パレット追加分（再生成でも保持）
let TILE = 1;                // floorFull の一辺（実測）
let FLOOR_T = 0;             // 床タイルの厚み（実測）。家具・壁は床の「上面」に載せる
let FLOOR_H = 2.5;           // 1階分の高さ＝壁の高さ＋床厚（実測）
let unitMode = false;        // ユニット編集モード（部屋を隠して複合パーツを組む）
const unitGroup = new THREE.Group();
const unitDefs = new Map();  // name -> ユニット定義
let selected = null;         // 選択中の家具 Group
let kitNames = [];           // kit の全モデル名（新規GLBも含む＝ジェネレータへ渡すと自動でカテゴリ参加）
let roomParams = { type: 'living', w: 7, d: 6, seed: 1, windowRate: 0.35 };

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

// ── モデルキャッシュ（底面中心へ正規化したテンプレを clone して使う）──
const loader = new GLTFLoader();
const cache = new Map();   // name -> { tpl:Group, size:Vector3 }
async function getModel(name) {
  if (cache.has(name)) return cache.get(name);
  const url = KIT_DIR.split('/').map(encodeURIComponent).join('/') + encodeURIComponent(name) + '.glb';
  const gltf = await loader.loadAsync(url);
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);   // 底面中心＝原点
  const tpl = new THREE.Group(); tpl.add(obj);
  const entry = { tpl, size };
  cache.set(name, entry);
  return entry;
}

// アイテム1個を配置（cell座標→実寸）。userData.item に定義を保持（保存/選択用）
async function spawnItem(parent, item, selectable) {
  if (item.unit) return spawnUnit(parent, item, selectable);
  const entry = await getModel(item.model);
  const g = entry.tpl.clone(true);
  const isFloor = item.model.startsWith('floor');
  let y = (item.level || 0) * FLOOR_H + (isFloor ? 0 : FLOOR_T);   // 家具・壁は床の上面へ（床内部への沈み込み防止）
  if (item.stackOn) { try { y += (await getModel(item.stackOn)).size.y; } catch { /* 台なし */ } }
  g.position.set(item.x * TILE, y + (item.y || 0), item.z * TILE);
  g.rotation.y = item.ry || 0;
  g.userData.item = item;
  g.userData.selectable = selectable;
  parent.add(g);
  return g;
}

// ── ユニット（複合パーツ）: サブエディタで組んだモデル群を1つの塊として配置 ──
async function getUnitDef(name) {
  if (unitDefs.has(name)) return unitDefs.get(name);
  const def = await (await fetch('../rooms/' + encodeURIComponent(name) + '.unit.json')).json();
  unitDefs.set(name, def);
  return def;
}
async function spawnUnit(parent, item, selectable) {
  const def = await getUnitDef(item.unit);
  const g = new THREE.Group();
  for (const c of (def.items || [])) {
    const e = await getModel(c.model);
    const m = e.tpl.clone(true);
    m.position.set(c.x, c.y || 0, c.z);
    m.rotation.y = c.ry || 0;
    g.add(m);
  }
  g.position.set(item.x * TILE, (item.level || 0) * FLOOR_H + FLOOR_T, item.z * TILE);
  g.rotation.y = item.ry || 0;
  g.userData.item = item;
  g.userData.selectable = selectable;
  parent.add(g);
  return g;
}
function setRoomVisible(v) { if (roomGroup) roomGroup.visible = v; manualGroup.visible = v; }
async function enterUnitMode(name) {
  unitMode = true;
  setRoomVisible(false);
  unitGroup.visible = true;
  unitGroup.clear();
  detachGizmo();
  setGizmoMode(gizmoMode);   // ユニット中は移動にY軸も出す（机の上にPCを載せる等）
  if (name) {
    const def = await getUnitDef(name);
    for (const c of (def.items || [])) {
      const e = await getModel(c.model);
      const m = e.tpl.clone(true);
      m.position.set(c.x, c.y || 0, c.z);
      m.rotation.y = c.ry || 0;
      m.userData.item = { model: c.model };
      m.userData.selectable = true;
      unitGroup.add(m);
    }
    $('unit-name').value = name;
    $('unit-place').value = def.tags?.place || '';
    for (const o of $('unit-rooms').options) o.selected = (def.tags?.rooms || []).includes(o.value);
  }
  $('unit-tags').style.display = '';
  $('btn-unit-exit').style.display = '';
  orbit.target.set(0, 0.8, 0); orbit.update();
  setStatus('ユニット編集モード: パレットから追加 → G/R/上下も可 → ユニット保存（名前は保存欄）');
}
function exitUnitMode() {
  unitMode = false;
  unitGroup.visible = false;
  detachGizmo();
  setGizmoMode(gizmoMode);
  $('unit-tags').style.display = 'none';
  $('btn-unit-exit').style.display = 'none';
  setRoomVisible(true);
  setStatus('部屋編集に戻りました');
}
async function saveUnit() {
  const name = ($('unit-name').value || $('save-name').value || 'unit').replace(/[^\w\-]/g, '');
  const itemsU = unitGroup.children.filter((c) => c.userData.item).map((c) => ({ model: c.userData.item.model, x: c.position.x, y: c.position.y, z: c.position.z, ry: c.rotation.y }));
  if (!itemsU.length) { setStatus('ユニットが空です（ユニット編集モードで組んでから保存）'); return; }
  const cx = itemsU.reduce((s, i) => s + i.x, 0) / itemsU.length;   // 原点合わせ: XZ重心→0 / 最下点→0
  const cz = itemsU.reduce((s, i) => s + i.z, 0) / itemsU.length;
  const y0 = Math.min(...itemsU.map((i) => i.y));
  for (const i of itemsU) { i.x -= cx; i.z -= cz; i.y -= y0; }
  // タグ（出現部屋・位置）とフットプリント（bbox実寸→セル数）
  const tags = { rooms: [...$('unit-rooms').selectedOptions].map((o) => o.value), place: $('unit-place').value };
  const bb = new THREE.Box3().setFromObject(unitGroup);
  const fp = [Math.max(1, Math.ceil((bb.max.x - bb.min.x) / TILE - 0.15)), Math.max(1, Math.ceil((bb.max.z - bb.min.z) / TILE - 0.15))];
  const def = { format: 'unit', version: 1, name, tags, fp, items: itemsU };
  unitDefs.set(name, def);
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'room', filename: name + '.unit.json', content: JSON.stringify(def, null, 1) }) });
    setStatus(r.ok ? `ユニット保存: rooms/${name}.unit.json` : 'ユニット保存失敗: ' + r.status);
    refreshUnitList();
  } catch (e) { setStatus('ユニット保存失敗: ' + e.message); }
}
async function placeUnit() {
  const name = $('unit-list').value;
  if (!name) { setStatus('ユニットがありません（新規作成→保存）'); return; }
  if (unitMode) exitUnitMode();
  const item = { unit: name, x: (roomParams.w - 1) / 2, z: (roomParams.d - 1) / 2, ry: 0 };
  const g = await spawnUnit(manualGroup, item, true);
  selectObject(g);
}
async function refreshUnitList() {
  try {
    const files = await (await fetch('../rooms/manifest.json')).json();
    const sel = $('unit-list');
    sel.innerHTML = '';
    for (const f of files.filter((x) => x.endsWith('.unit.json'))) {
      const name = f.replace(/\.unit\.json$/, '');
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
      getUnitDef(name).catch(() => { /* 破損は無視 */ });   // 定義も先読み（生成時のタグ配置に使う）
    }
  } catch { /* 開発サーバ以外 */ }
}
function unitsForGen() {   // ジェネレータへ渡すユニット一覧（読み込み済み定義のみ）
  return [...unitDefs.values()].map((d) => ({ name: d.name, fp: d.fp || [1, 1], tags: d.tags || {} }));
}

// モデルのワールド寸法（ry を90°単位に丸めて bbox を回転）
function worldSize(g) {
  const size = cache.get(g.userData.item.model)?.size || { x: TILE, z: TILE };
  const q = Math.round(g.rotation.y / (Math.PI / 2)) & 1;
  return q ? { x: size.z, z: size.x } : { x: size.x, z: size.z };
}
// 実寸パック: run=列を隙間なく詰めて壁に背面を揃える（キッチン） / flush=アンカーへ横づけ（スピーカー等）
function packAndFlush() {
  const groups = [...roomGroup.children].filter((c) => c.userData.item);
  const byId = new Map();
  for (const g of groups) if (g.userData.item.id != null) byId.set(g.userData.item.id, g);
  const runs = new Map();
  for (const g of groups) { const r = g.userData.item.run; if (r) { if (!runs.has(r.id)) runs.set(r.id, []); runs.get(r.id).push(g); } }
  for (const arr of runs.values()) {
    arr.sort((a, b) => a.userData.item.run.idx - b.userData.item.run.idx);
    const { dir, back } = arr[0].userData.item.run;
    let edge = null;
    for (const g of arr) {
      const s = worldSize(g);
      const along = Math.abs(dir[0]) * s.x + Math.abs(dir[1]) * s.z;
      const across = Math.abs(dir[0]) * s.z + Math.abs(dir[1]) * s.x;
      if (edge === null) edge = (dir[0] ? g.position.x : g.position.z) - along / 2;
      const c = edge + along / 2;
      if (dir[0]) g.position.x = c; else g.position.z = c;
      edge += along;
      if (back != null && dir[0]) g.position.z = back * TILE + across / 2;   // 背面を壁ラインへ
    }
  }
  for (const g of groups) {
    const f = g.userData.item.flush;
    if (!f) continue;
    const t = byId.get(f.target);
    if (!t) continue;
    const st = worldSize(t), sg = worldSize(g);
    const ext = (Math.abs(f.dir[0]) * (st.x + sg.x) + Math.abs(f.dir[1]) * (st.z + sg.z)) / 2;
    g.position.x = t.position.x + f.dir[0] * ext;
    g.position.z = t.position.z + f.dir[1] * ext;
  }
}

// ── 部屋の構築（roomGroup を作り直す）。pack=生成直後のみ実寸詰め（読込時は保存位置を尊重）──
async function buildRoom(data, pack = false) {
  if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }
  roomGroup = new THREE.Group();
  scene.add(roomGroup);
  detachGizmo();
  if ([...data.shell, ...data.items].some((i) => (i.level || 0) > 0)) FLOOR_H = (await getModel('wall')).size.y + FLOOR_T;   // 1階分＝壁の高さ＋床厚（実測）
  const jobs = [];
  for (const s of data.shell) jobs.push(spawnItem(roomGroup, s, false));
  for (const it of data.items) jobs.push(spawnItem(roomGroup, it, true));
  await Promise.all(jobs);
  if (pack) packAndFlush();
  // 部屋の中心へカメラターゲット
  orbit.target.set((data.w - 1) / 2 * TILE, 0.8, (data.d - 1) / 2 * TILE);
  orbit.update();
  setStatus(`${data.type} ${data.w}×${data.d} seed=${data.seed} / 家具 ${data.items.length}＋手動 ${manualGroup.children.length}`);
}

function regenerate() {
  roomParams.type = $('room-type').value;
  roomParams.w = parseInt($('room-w').value);
  roomParams.d = parseInt($('room-d').value);
  roomParams.seed = parseInt($('room-seed').value) || 1;
  roomParams.windowRate = parseInt($('room-win').value) / 100;
  roomParams.floors = parseInt($('room-floors').value) || 1;
  const data = roomParams.type === 'house'
    ? generateHouse({ ...roomParams, available: kitNames, units: unitsForGen() })
    : generateRoom({ ...roomParams, available: kitNames, units: unitsForGen() });
  buildRoom(data, true).catch((e) => setStatus('生成失敗: ' + e.message));
}

// ── 選択とギズモ ──
function detachGizmo() { if (gizmo) gizmo.detach(); selected = null; }
function selectObject(g) {
  selected = g;
  gizmo.attach(g);
  setStatus(`選択: ${g.userData.item?.model || '?'}（G移動 / R回転 / Delete削除）`);
}
function onCanvasClick(e) {
  if (gizmo.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const targets = [];
  if (unitMode) {
    for (const c of unitGroup.children) if (c.userData.selectable) targets.push(c);
  } else {
    if (roomGroup) for (const c of roomGroup.children) if (c.userData.selectable) targets.push(c);
    for (const c of manualGroup.children) targets.push(c);
  }
  const hits = ray.intersectObjects(targets, true);
  if (!hits.length) { detachGizmo(); setStatus('選択解除'); return; }
  let o = hits[0].object;
  while (o && !o.userData.item) o = o.parent;
  if (o) selectObject(o);
}

// ── パレット追加 ──
// ── サムネイル: 各モデルをオフスクリーンWebGLで1枚ずつ描いてパレットに並べる（起動後に順次生成）──
let thumbR = null, thumbScene = null, thumbCam = null;
function initThumbRenderer() {
  thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbR.setSize(64, 64);
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(2, 3, 2); thumbScene.add(dl);
  thumbCam = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
}
async function makeThumb(name) {
  const e = await getModel(name);
  const c = e.tpl.clone(true);
  thumbScene.add(c);
  const r = Math.max(e.size.x, e.size.y, e.size.z) || 1;   // 斜め上から全体が収まる距離
  thumbCam.position.set(r * 1.4, r * 1.1, r * 1.4);
  thumbCam.lookAt(0, e.size.y * 0.45, 0);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL();
  thumbScene.remove(c);
  return url;
}
function buildThumbPalette() {
  initThumbRenderer();
  const groups = new Map();
  for (const n of kitNames) {
    const cat = categorize(n) || 'shell';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  const box = $('thumbs');
  const queue = [];
  for (const cat of [...groups.keys()].sort()) {
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = cat; box.appendChild(h);
    for (const n of groups.get(cat)) {
      const img = document.createElement('img');
      img.title = n; img.alt = n;
      img.addEventListener('click', () => { addFromPalette(n).catch((e) => setStatus('追加失敗: ' + e.message)); });
      box.appendChild(img);
      queue.push({ n, img });
    }
  }
  const step = () => {   // 1枚ずつ順次生成（起動を固めない）
    const job = queue.shift();
    if (!job) return;
    makeThumb(job.n).then((url) => { job.img.src = url; }).catch(() => { /* 失敗はプレースホルダのまま */ })
      .finally(() => setTimeout(step, 10));
  };
  step();
}

// ── ギズモモード（移動/回転）。回転はY軸リングのみ・移動はXZ（ユニット編集中はYも）──
let gizmoMode = 'translate';
function setGizmoMode(m) {
  gizmoMode = m;
  gizmo.setMode(m);
  if (m === 'rotate') { gizmo.showX = false; gizmo.showZ = false; gizmo.showY = true; }
  else { gizmo.showX = true; gizmo.showZ = true; gizmo.showY = unitMode; }
}

async function addFromPalette(name) {
  if (!name) return;
  if (unitMode) {   // ユニット編集モード: 作業台の原点に追加（メートル座標のまま組む）
    const e = await getModel(name);
    const m = e.tpl.clone(true);
    m.userData.item = { model: name };
    m.userData.selectable = true;
    unitGroup.add(m);
    selectObject(m);
    return;
  }
  const item = { model: name, x: (roomParams.w - 1) / 2, z: (roomParams.d - 1) / 2, ry: 0 };
  const g = await spawnItem(manualGroup, item, true);
  selectObject(g);
}

function deleteSelected() {
  if (!selected) return;
  const g = selected;
  detachGizmo();
  if (g.parent) g.parent.remove(g);
  setStatus('削除しました');
}

// ── 保存 / 読込 ──
function collectItems(group) {
  const out = [];
  for (const c of group.children) {
    if (!c.userData.item) continue;
    const it = { ...c.userData.item };
    it.x = c.position.x / TILE; it.z = c.position.z / TILE; it.ry = c.rotation.y;
    delete it.y;
    out.push(it);
  }
  return out;
}
async function saveRoom() {
  const name = ($('save-name').value || 'room').replace(/[^\w\-]/g, '');
  const items = roomGroup ? collectItems(roomGroup).filter((i) => !i.wall && i.model !== 'floorFull' && !i.model.startsWith('wall')) : [];
  const shell = roomGroup ? collectItems(roomGroup).filter((i) => i.wall || i.model === 'floorFull' || i.model.startsWith('wall')) : [];
  const json = { format: 'room', version: 1, params: roomParams, shell, items, manual: collectItems(manualGroup) };
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'room', filename: name + '.room.json', content: JSON.stringify(json, null, 1) }) });
    setStatus(r.ok ? `保存しました: rooms/${name}.room.json` : '保存失敗: ' + r.status);
    refreshLoadList();
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}
async function refreshLoadList() {
  try {
    const files = await (await fetch('../rooms/manifest.json')).json();
    const sel = $('load-list');
    sel.innerHTML = '';
    for (const f of files.filter((x) => x.endsWith('.room.json'))) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.room\.json$/, ''); sel.appendChild(o); }
  } catch { /* 開発サーバ以外 */ }
}
async function loadRoom() {
  const f = $('load-list').value;
  if (!f) return;
  try {
    const j = await (await fetch('../rooms/' + f)).json();
    roomParams = j.params || roomParams;
    $('room-type').value = roomParams.type; $('room-w').value = roomParams.w; $('room-d').value = roomParams.d;
    $('room-seed').value = roomParams.seed; $('room-win').value = Math.round((roomParams.windowRate ?? 0.35) * 100);
    syncLabels();
    manualGroup.clear();
    await buildRoom({ shell: j.shell, items: j.items, w: roomParams.w, d: roomParams.d, type: roomParams.type, seed: roomParams.seed });
    for (const m of (j.manual || [])) await spawnItem(manualGroup, m, true);
    setStatus(`読み込み: ${f}`);
  } catch (e) { setStatus('読み込み失敗: ' + e.message); }
}

function syncLabels() {
  $('room-w-val').textContent = $('room-w').value;
  $('room-d-val').textContent = $('room-d').value;
  $('room-win-val').textContent = (parseInt($('room-win').value) / 100).toFixed(2);
}

// ── 初期化 ──
async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2030);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(7, 8, 12);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.6); key.position.set(6, 10, 4); scene.add(key);
  const grid = new THREE.GridHelper(40, 40, 0x33415e, 0x222c44);
  grid.position.y = -0.01; scene.add(grid);
  scene.add(manualGroup);

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.maxPolarAngle = Math.PI * 0.495;
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.showY = false;   // 家具は床の上をXZ移動が基本
  gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

  // UI
  for (const t of [...ROOM_TYPES, 'house']) { const o = document.createElement('option'); o.value = t; o.textContent = t === 'house' ? 'house（家まるごと）' : t; $('room-type').appendChild(o); }
  $('room-type').value = roomParams.type;
  for (const ev of ['room-w', 'room-d', 'room-win']) $(ev).addEventListener('input', syncLabels);
  syncLabels();
  $('btn-gen').addEventListener('click', regenerate);
  $('btn-dice').addEventListener('click', () => { $('room-seed').value = 1 + ((Math.random() * 99999) | 0); regenerate(); });
  $('btn-move').addEventListener('click', () => setGizmoMode('translate'));
  $('btn-rot').addEventListener('click', () => setGizmoMode('rotate'));
  $('btn-del').addEventListener('click', deleteSelected);
  $('btn-save').addEventListener('click', saveRoom);
  $('btn-load').addEventListener('click', loadRoom);
  renderer.domElement.addEventListener('click', onCanvasClick);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'KeyG') setGizmoMode('translate');
    else if (e.code === 'KeyR') setGizmoMode('rotate');
    else if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected();
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // パレット（キットの全モデルをカテゴリ別サムネイルで表示。新規GLBも自動で載る）
  try {
    const all = await (await fetch('../models/manifest.json')).json();
    kitNames = all.filter((f) => f.includes('kenney_furniture-kit')).map((f) => f.split('/').pop().replace(/\.glb$/i, ''));
    buildThumbPalette();
  } catch { /* manifest無し */ }

  // ユニットUI
  scene.add(unitGroup);
  unitGroup.visible = false;
  for (const t of ['any', ...ROOM_TYPES]) { const o = document.createElement('option'); o.value = t; o.textContent = t; $('unit-rooms').appendChild(o); }
  $('btn-unit-new').addEventListener('click', () => { enterUnitMode(null).catch((e) => setStatus('失敗: ' + e.message)); });
  $('btn-unit-edit').addEventListener('click', () => { const n = $('unit-list').value; if (n) enterUnitMode(n).catch((e) => setStatus('失敗: ' + e.message)); });
  $('btn-unit-save').addEventListener('click', saveUnit);
  $('btn-unit-place').addEventListener('click', () => { placeUnit().catch((e) => setStatus('配置失敗: ' + e.message)); });
  $('btn-unit-exit').addEventListener('click', exitUnitMode);

  // TILE / 床厚 実測 → 初回生成
  const floor = await getModel('floorFull');
  TILE = Math.max(floor.size.x, floor.size.z) || 1;
  FLOOR_T = floor.size.y || 0;
  console.log('TILE =', TILE, 'FLOOR_T =', FLOOR_T);
  refreshLoadList();
  refreshUnitList();
  regenerate();
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
}

init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
