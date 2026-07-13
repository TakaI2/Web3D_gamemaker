// entry-editor.js — 建物GLBに「玄関(door)/窓(window)/光点(light)/窓発光(glow)」マーカーを打つエディタ。
// 座標は plateau-fly のベイク済みテンプレートと同じ「モデルのワールド行列適用後ローカル空間」。
// 保存: public/models/building-entries.json = { "<GLB相対パス>": [{kind,pos:[x,y,z], color?, ry?, size?:[w,h]}] }
//   light: 夜に光る点（屋上ランプ・街灯の発光位置）。color 省略=ゲーム側で自動配色
//   glow : 夜に光る窓矩形（光漏れ）。ry=面の向き（Yヨー）、size=[幅,高さ]。窓入口としても機能
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';

const ENTRIES_FILE = 'building-entries.json';
let renderer, scene, camera, orbit;
let modelObj = null, currentPath = null;
let entries = {};            // relPath -> [{kind,pos}]
const markerGroup = new THREE.Group();
let selectedMarker = null;

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

const loader = new GLTFLoader();
async function loadModel(relPath) {
  if (modelObj) { scene.remove(modelObj); modelObj = null; }
  markerGroup.clear(); selectedMarker = null;
  currentPath = relPath;
  const url = '../models/' + relPath.split('/').map(encodeURIComponent).join('/');
  const gltf = await loader.loadAsync(url);
  modelObj = gltf.scene;
  modelObj.updateMatrixWorld(true);   // ベイク空間＝そのまま表示（センタリングしない）
  scene.add(modelObj);
  const bb = new THREE.Box3().setFromObject(modelObj);
  const c = bb.getCenter(new THREE.Vector3()), r = bb.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  orbit.target.copy(c);
  camera.position.set(c.x + r * 1.6, c.y + r * 1.2, c.z + r * 1.6);
  orbit.update();
  for (const m of (entries[relPath] || [])) addMarkerMesh(m);
  setStatus(`${relPath}（マーカー ${(entries[relPath] || []).length}個）`);
}

function markerColor(kind) {
  return kind === 'door' ? 0xff9440 : kind === 'light' ? 0xffe060 : kind === 'glow' ? 0xfff0a0 : 0x50d8ff;
}
function addMarkerMesh(def) {
  let s;
  if (def.kind === 'glow') {
    // 発光窓＝面の向き(ry)に沿った矩形。両面表示で選択しやすく
    s = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: markerColor(def.kind), depthTest: false, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    s.scale.set(def.size?.[0] ?? 0.3, def.size?.[1] ?? 0.4, 1);
    s.rotation.y = def.ry || 0;
  } else {
    s = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshBasicMaterial({ color: markerColor(def.kind), depthTest: false, transparent: true, opacity: 0.95 }));
    if (def.kind === 'light' && def.color) s.material.color.set(def.color);
  }
  s.renderOrder = 10;
  s.position.fromArray(def.pos);
  s.userData.def = def;
  markerGroup.add(s);
  return s;
}
const KIND_LABEL = { door: '玄関', window: '窓', light: '光点', glow: '窓発光' };
function selectMarker(m) {
  if (selectedMarker) selectedMarker.material.opacity = selectedMarker.userData.def.kind === 'glow' ? 0.55 : 0.95;
  selectedMarker = m;
  if (m) m.material.opacity = m.userData.def.kind === 'glow' ? 0.9 : 0.4;
  // 選択した窓発光のサイズを入力欄へ反映（そのまま編集できる）
  if (m && m.userData.def.kind === 'glow') {
    $('glow-opts').style.display = 'flex';
    $('glow-w').value = String(m.userData.def.size?.[0] ?? 0.3);
    $('glow-h').value = String(m.userData.def.size?.[1] ?? 0.4);
  }
  setStatus(m ? `選択: ${KIND_LABEL[m.userData.def.kind] || m.userData.def.kind}（削除ボタンで除去）` : '選択解除');
}

function onClick(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  // マーカー優先
  const mh = ray.intersectObjects(markerGroup.children, false)[0];
  if (mh) { selectMarker(mh.object); return; }
  if (!modelObj || !currentPath) return;
  const hit = ray.intersectObject(modelObj, true)[0];
  if (!hit) { selectMarker(null); return; }
  const kind = $('marker-kind').value;
  const def = { kind, pos: [Number(hit.point.x.toFixed(3)), Number(hit.point.y.toFixed(3)), Number(hit.point.z.toFixed(3))] };
  if (kind === 'light' && $('light-color').value) def.color = $('light-color').value;
  if (kind === 'glow') {
    // クリック面の法線（水平成分）から向きを決め、面から少し浮かせる
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
    n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1); else n.normalize();
    def.ry = Number(Math.atan2(n.x, n.z).toFixed(3));
    def.size = [Number($('glow-w').value) || 0.3, Number($('glow-h').value) || 0.4];
    def.pos = [Number((hit.point.x + n.x * 0.008).toFixed(3)), Number(hit.point.y.toFixed(3)), Number((hit.point.z + n.z * 0.008).toFixed(3))];
  }
  (entries[currentPath] = entries[currentPath] || []).push(def);
  selectMarker(addMarkerMesh(def));
  setStatus(`${KIND_LABEL[kind] || kind} を追加（計 ${entries[currentPath].length}個）`);
}

function deleteSelected() {
  if (!selectedMarker || !currentPath) return;
  const def = selectedMarker.userData.def;
  const arr = entries[currentPath] || [];
  const i = arr.indexOf(def);
  if (i >= 0) arr.splice(i, 1);
  markerGroup.remove(selectedMarker);
  selectedMarker = null;
  setStatus('マーカーを削除しました');
}

async function saveEntries() {
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'models', filename: ENTRIES_FILE, content: JSON.stringify(entries, null, 1) }) });
    setStatus(r.ok ? `保存しました: models/${ENTRIES_FILE}` : '保存失敗: ' + r.status);
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2030);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.02, 200);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xfff2dd, 1.5); dl.position.set(4, 8, 3); scene.add(dl);
  scene.add(new THREE.GridHelper(10, 20, 0x33415e, 0x222c44));
  scene.add(markerGroup);
  orbit = new OrbitControls(camera, renderer.domElement);
  camera.position.set(3, 3, 5);

  // 既存マーカー読込
  try { entries = await (await fetch('../models/' + ENTRIES_FILE)).json(); } catch { entries = {}; }

  // 建物モデル一覧（plateau-fly が使う city / suburban キット）＋街灯（光点調整用）
  const all = await (await fetch('../models/manifest.json')).json();
  const list = all.filter((f) =>
    (f.startsWith('city_GLB format/') && /\/building-[\w-]+\.glb$/.test('/' + f) && !f.includes('low-detail')) ||
    (f.includes('kenney_city-kit-suburban') && /building-type-[a-u]\.glb$/.test(f)) ||
    /kenney_city-kit-roads.*light-curved\.glb$/.test(f));
  const sel = $('model-list');
  for (const f of list) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = (entries[f]?.length ? '● ' : '') + f.split('/').pop().replace('.glb', '');
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => loadModel(sel.value).catch((e) => setStatus('読込失敗: ' + e.message)));
  renderer.domElement.addEventListener('click', onClick);
  $('btn-del').addEventListener('click', deleteSelected);
  $('btn-save').addEventListener('click', saveEntries);
  // 種別に応じたオプション表示＋選択中の窓発光サイズ編集
  const syncKindOpts = () => {
    const k = $('marker-kind').value;
    $('light-opts').style.display = k === 'light' ? 'flex' : 'none';
    $('glow-opts').style.display = (k === 'glow' || (selectedMarker && selectedMarker.userData.def.kind === 'glow')) ? 'flex' : 'none';
  };
  $('marker-kind').addEventListener('change', syncKindOpts);
  const onGlowSize = () => {
    if (!selectedMarker || selectedMarker.userData.def.kind !== 'glow') return;
    const def = selectedMarker.userData.def;
    def.size = [Math.max(0.05, Number($('glow-w').value) || 0.3), Math.max(0.05, Number($('glow-h').value) || 0.4)];
    selectedMarker.scale.set(def.size[0], def.size[1], 1);
  };
  $('glow-w').addEventListener('input', onGlowSize);
  $('glow-h').addEventListener('input', onGlowSize);
  window.addEventListener('keydown', (e) => { if (e.code === 'Delete') deleteSelected(); });
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  if (list.length) { sel.value = list[0]; loadModel(list[0]); }
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  setStatus('建物を選び、面をクリックして玄関/窓マーカーを設置');
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
