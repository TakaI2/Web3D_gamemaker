// entry-editor.js — 建物GLBに「玄関(door)/窓(window)」の進入マーカーを打つエディタ。
// 座標は plateau-fly のベイク済みテンプレートと同じ「モデルのワールド行列適用後ローカル空間」。
// 保存: public/models/building-entries.json = { "<GLB相対パス>": [{kind,pos:[x,y,z]}] }
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

function markerColor(kind) { return kind === 'door' ? 0xff9440 : 0x50d8ff; }
function addMarkerMesh(def) {
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), new THREE.MeshBasicMaterial({ color: markerColor(def.kind), depthTest: false, transparent: true, opacity: 0.95 }));
  s.renderOrder = 10;
  s.position.fromArray(def.pos);
  s.userData.def = def;
  markerGroup.add(s);
  return s;
}
function selectMarker(m) {
  if (selectedMarker) selectedMarker.material.opacity = 0.95;
  selectedMarker = m;
  if (m) m.material.opacity = 0.4;
  setStatus(m ? `選択: ${m.userData.def.kind}（削除ボタンで除去）` : '選択解除');
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
  const def = { kind: $('marker-kind').value, pos: [Number(hit.point.x.toFixed(3)), Number(hit.point.y.toFixed(3)), Number(hit.point.z.toFixed(3))] };
  (entries[currentPath] = entries[currentPath] || []).push(def);
  selectMarker(addMarkerMesh(def));
  setStatus(`${def.kind} を追加（計 ${entries[currentPath].length}個）`);
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

  // 建物モデル一覧（plateau-fly が使う city / suburban キット）
  const all = await (await fetch('../models/manifest.json')).json();
  const list = all.filter((f) =>
    (f.startsWith('city_GLB format/') && /\/building-[\w-]+\.glb$/.test('/' + f) && !f.includes('low-detail')) ||
    (f.includes('kenney_city-kit-suburban') && /building-type-[a-u]\.glb$/.test(f)));
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
  window.addEventListener('keydown', (e) => { if (e.code === 'Delete') deleteSelected(); });
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  if (list.length) { sel.value = list[0]; loadModel(list[0]); }
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  setStatus('建物を選び、面をクリックして玄関/窓マーカーを設置');
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
