// entry-editor.js — 建物GLBに「玄関(door)/窓(window)/光点(light)/窓発光(glow)/看板(sign)」マーカーを打つエディタ。
// 座標は city-fly のベイク済みテンプレートと同じ「モデルのワールド行列適用後ローカル空間」。
// 保存: public/models/building-entries.json = { "<GLB相対パス>": [{kind,pos:[x,y,z], color?, ry?, size?:[w,h]}] }
//   light: 夜に光る点（屋上ランプ・街灯の発光位置）。color 省略=ゲーム側で自動配色。blink=点滅周期(秒・省略で常時点灯)
//   glow : 夜に光る窓矩形（光漏れ）。ry=面の向き（Yヨー）、size=[幅,高さ]。窓入口としても機能
//   sign : 広告看板の矩形。rot=[rx,ry,rz]、size=[幅,高さ]、set=public/advertise/<セット名>/ のフォルダ名。
//          そのフォルダ内の uv*.png が、街に建った同型建物へ個体ごとに振り分けられる（ゲーム側は1枚のアトラスへ統合）。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';

const ENTRIES_FILE = 'building-entries.json';
let renderer, scene, camera, orbit;
let modelObj = null, currentPath = null;
let entries = {};            // relPath -> [{kind,pos}]
const markerGroup = new THREE.Group();
let selectedMarker = null;
let gizmo = null, gizmoMode = 'translate', justDragged = false, shiftDown = false;
const ROT_SNAP = Math.PI / 4;   // Shift押下中の回転刻み（45度）
let signManifest = {};       // セット名 -> ["uv1.png", ...]（advertise/manifest.json）
let texVer = 0;              // 画像再読込用のキャッシュバスター
const texCache = new Map();
const SIGN_PLACEHOLDER = 0xffcc44;
const r3 = (v) => Number(v.toFixed(3));

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
  if ($('sign-set')) { $('sign-set').value = nextSetName(); updateSignFiles(); }   // 次に置く看板の既定セット名
  setStatus(`${relPath}（マーカー ${(entries[relPath] || []).length}個）`);
}

function modelBase() {   // モデルのファイル名（例 building-a）
  return currentPath ? currentPath.split('/').pop().replace(/\.glb$/i, '') : '';
}
function nextSetName() {   // 次に置く看板の既定セット名＝<モデル名>-<通し番号>（例 building-f-2）
  const base = modelBase();
  if (!base) return '';
  const n = (entries[currentPath] || []).filter((e) => e.kind === 'sign').length + 1;
  return base + '-' + n;
}
const defaultSet = () => nextSetName();
function signTexture(set) {   // プレビューはセットの1枚目。ゲームでは個体ごとにこの中から振り分けられる
  const files = signManifest[set] || [];
  if (!files.length) return null;
  const key = set + '/' + files[0] + '?v=' + texVer;
  let t = texCache.get(key);
  if (!t) {
    t = new THREE.TextureLoader().load('../advertise/' + encodeURIComponent(set) + '/' + encodeURIComponent(files[0]) + '?v=' + texVer);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, t);
  }
  return t;
}
function applySignTex(mesh) {
  const t = signTexture(mesh.userData.def.set || '');
  mesh.material.map = t || null;
  mesh.material.color.set(t ? 0xffffff : SIGN_PLACEHOLDER);
  mesh.material.needsUpdate = true;
}
async function refreshManifest() {
  try { signManifest = await (await fetch('../advertise/manifest.json', { cache: 'no-store' })).json() || {}; }
  catch { signManifest = {}; }
  updateSignFiles();
}
function updateSignFiles() {
  const el = $('sign-files');
  if (!el) return;
  const set = ($('sign-set').value || '').trim();
  const files = signManifest[set] || [];
  el.textContent = files.length ? 'advertise/' + set + '/ : ' + files.join(', ') : 'advertise/' + (set || '(セット名未入力)') + '/ は空です';
}
function reloadTextures() {
  texVer++; texCache.clear();
  for (const m of markerGroup.children) if (m.userData.def.kind === 'sign') applySignTex(m);
}
function markerColor(kind) {
  return kind === 'door' ? 0xff9440 : kind === 'light' ? 0xffe060 : kind === 'glow' ? 0xfff0a0 : 0x50d8ff;
}
const baseOpacity = (k) => (k === 'glow' ? 0.55 : k === 'sign' ? 1 : 0.95);
const selOpacity = (k) => (k === 'glow' ? 0.9 : k === 'sign' ? 1 : 0.4);
function addMarkerMesh(def) {
  let s;
  if (def.kind === 'sign') {
    // 看板＝面に貼る矩形。テクスチャ未作成のうちは placeholder 色で置いておける
    s = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: SIGN_PLACEHOLDER, transparent: true, side: THREE.DoubleSide }));
    s.scale.set(def.size?.[0] ?? 0.6, def.size?.[1] ?? 0.25, 1);
    const r = def.rot || [0, def.ry || 0, 0];
    s.rotation.set(r[0], r[1], r[2]);
  } else if (def.kind === 'glow') {
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
  if (def.kind === 'sign') applySignTex(s);
  markerGroup.add(s);
  return s;
}
// ── 移動/回転ギズモ（TransformControls）──
function ensureGizmo() {
  if (gizmo) return gizmo;
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.7);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (!e.value) justDragged = true;   // ドラッグ終了直後のクリックでマーカーを増やさない
  });
  gizmo.addEventListener('objectChange', syncFromGizmo);
  applySnap();
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);   // r169以降は helper を add する
  return gizmo;
}
function applySnap() {   // Shiftを押している間だけ45度スナップ（three.js の TransformControls 例と同じ流儀）
  if (gizmo) gizmo.setRotationSnap(shiftDown ? ROT_SNAP : null);
}
function syncFromGizmo() {
  const m = selectedMarker;
  if (!m) return;
  const def = m.userData.def;
  def.pos = [r3(m.position.x), r3(m.position.y), r3(m.position.z)];
  if (def.kind === 'sign') def.rot = [r3(m.rotation.x), r3(m.rotation.y), r3(m.rotation.z)];
  else if (def.kind === 'glow') def.ry = r3(m.rotation.y);
}
function setGizmoMode(mode) {
  gizmoMode = mode;
  if (mode === 'off') { if (gizmo) gizmo.detach(); return; }
  ensureGizmo().setMode(mode);
  if (selectedMarker) gizmo.attach(selectedMarker);
}
const KIND_LABEL = { door: '玄関', window: '窓', light: '光点', glow: '窓発光', sign: '看板' };
function selectMarker(m) {
  if (selectedMarker) selectedMarker.material.opacity = baseOpacity(selectedMarker.userData.def.kind);
  selectedMarker = m;
  if (m) m.material.opacity = selOpacity(m.userData.def.kind);
  if (m && gizmoMode !== 'off') ensureGizmo().attach(m);
  else if (gizmo) gizmo.detach();
  if (m && m.userData.def.kind === 'sign') {
    $('sign-opts').style.display = 'flex';
    $('sign-w').value = String(m.userData.def.size?.[0] ?? 0.6);
    $('sign-h').value = String(m.userData.def.size?.[1] ?? 0.25);
    $('sign-set').value = m.userData.def.set || '';
    updateSignFiles();
  }
  // 選択した窓発光のサイズを入力欄へ反映（そのまま編集できる）
  if (m && m.userData.def.kind === 'glow') {
    $('glow-opts').style.display = 'flex';
    $('glow-w').value = String(m.userData.def.size?.[0] ?? 0.3);
    $('glow-h').value = String(m.userData.def.size?.[1] ?? 0.4);
  }
  // 選択した光点の色/点滅も同様に編集できる
  if (m && m.userData.def.kind === 'light') {
    $('light-opts').style.display = 'flex';
    $('light-color').value = m.userData.def.color || '';
    $('light-blink').value = String(m.userData.def.blink ?? 0);
  }
  setStatus(m ? `選択: ${KIND_LABEL[m.userData.def.kind] || m.userData.def.kind}（Deleteキー / 削除ボタンで除去）` : '選択解除');
}

function onClick(e) {
  if (justDragged) { justDragged = false; return; }   // ギズモ操作の離しはクリック扱いしない
  if (gizmo && gizmo.dragging) return;
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
  if (kind === 'light') {
    if ($('light-color').value) def.color = $('light-color').value;
    const bl = Number($('light-blink').value);
    if (bl > 0) def.blink = Number(bl.toFixed(2));
  }
  if (kind === 'sign') {
    // クリック面の法線（水平成分）を正面にして、面から少し浮かせる
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 0, 1);
    n.y = 0;
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1); else n.normalize();
    def.rot = [0, r3(Math.atan2(n.x, n.z)), 0];
    def.size = [Number($('sign-w').value) || 0.6, Number($('sign-h').value) || 0.25];
    def.set = $('sign-auto').checked ? nextSetName() : (($('sign-set').value || '').trim() || nextSetName());
    def.pos = [r3(hit.point.x + n.x * 0.012), r3(hit.point.y), r3(hit.point.z + n.z * 0.012)];
  }
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
  // 看板は置いた時点で白紙テンプレを作る（そのセットにまだ画像が無い場合だけ。既にあれば流用する）
  if (kind === 'sign' && !(signManifest[def.set] || []).length) {
    makeTemplate({ set: def.set, w: def.size[0], h: def.size[1] }).catch((e) => setStatus('テンプレ自動作成に失敗: ' + e.message));
  }
}

function deleteSelected() {
  if (!selectedMarker || !currentPath) return;
  const def = selectedMarker.userData.def;
  const arr = entries[currentPath] || [];
  const i = arr.indexOf(def);
  if (i >= 0) arr.splice(i, 1);
  markerGroup.remove(selectedMarker);
  if (gizmo) gizmo.detach();
  selectedMarker = null;
  setStatus('マーカーを削除しました');
}

async function makeTemplate(opt = {}) {   // 矩形の縦横比に合わせた白紙PNGを advertise/<セット名>/uvN.png として作る
  const set = opt.set || ($('sign-set').value || '').trim() || defaultSet();
  if (!set) { setStatus('セット名を入力してください'); return; }
  const w = Math.max(0.05, Number(opt.w ?? $('sign-w').value) || 0.6);
  const h = Math.max(0.05, Number(opt.h ?? $('sign-h').value) || 0.25);
  const long = Number($('sign-res').value) || 512;
  const q4 = (v) => Math.max(16, Math.round(v / 4) * 4);   // 4の倍数に丸める
  const px = w >= h ? long : q4(long * w / h);
  const py = w >= h ? q4(long * h / w) : long;
  const cv = document.createElement('canvas'); cv.width = px; cv.height = py;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, px, py);
  g.strokeStyle = '#c8ccd4'; g.lineWidth = 2; g.strokeRect(1, 1, px - 2, py - 2);
  const name = 'uv' + ((signManifest[set] || []).length + 1) + '.png';
  try {
    const r = await fetch('../api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'advertise', filename: set + '/' + name, content: cv.toDataURL('image/png').split(',')[1], encoding: 'base64' }),
    });
    if (!r.ok) { setStatus('テンプレ作成失敗: ' + r.status); return; }
    await refreshManifest();
    reloadTextures();
    setStatus('作成: public/advertise/' + set + '/' + name + '（' + px + 'x' + py + '）— ペイントソフトで編集して「画像を再読込」');
  } catch (e) { setStatus('テンプレ作成失敗: ' + e.message); }
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
  await refreshManifest();   // advertise/<セット名>/*.png の一覧

  // 建物モデル一覧（city-fly が使う city / suburban キット）＋街灯（光点調整用）
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
  renderer.domElement.addEventListener('pointerdown', () => {
    // 幅×高やセット名の入力欄にフォーカスが残っていると Delete が文字削除に食われるので外す
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
  });
  renderer.domElement.addEventListener('click', onClick);
  $('btn-del').addEventListener('click', deleteSelected);
  $('btn-save').addEventListener('click', saveEntries);
  // 種別に応じたオプション表示＋選択中の窓発光サイズ編集
  const syncKindOpts = () => {
    const k = $('marker-kind').value;
    $('light-opts').style.display = (k === 'light' || (selectedMarker && selectedMarker.userData.def.kind === 'light')) ? 'flex' : 'none';
    $('glow-opts').style.display = (k === 'glow' || (selectedMarker && selectedMarker.userData.def.kind === 'glow')) ? 'flex' : 'none';
    $('sign-opts').style.display = (k === 'sign' || (selectedMarker && selectedMarker.userData.def.kind === 'sign')) ? 'flex' : 'none';
  };
  $('marker-kind').addEventListener('change', syncKindOpts);
  // 選択中の光点の色/点滅を書き換え（新規設置の既定値も兼ねる）
  const onLightOpts = () => {
    if (!selectedMarker || selectedMarker.userData.def.kind !== 'light') return;
    const def = selectedMarker.userData.def;
    if ($('light-color').value) { def.color = $('light-color').value; selectedMarker.material.color.set(def.color); }
    else { delete def.color; selectedMarker.material.color.set(markerColor('light')); }
    const bl = Number($('light-blink').value);
    if (bl > 0) def.blink = Number(bl.toFixed(2));
    else { delete def.blink; selectedMarker.material.opacity = 0.4; }   // 点滅解除時に暗いまま固まらない
  };
  $('light-color').addEventListener('change', onLightOpts);
  $('light-blink').addEventListener('input', onLightOpts);
  const onGlowSize = () => {
    if (!selectedMarker || selectedMarker.userData.def.kind !== 'glow') return;
    const def = selectedMarker.userData.def;
    def.size = [Math.max(0.05, Number($('glow-w').value) || 0.3), Math.max(0.05, Number($('glow-h').value) || 0.4)];
    selectedMarker.scale.set(def.size[0], def.size[1], 1);
  };
  $('glow-w').addEventListener('input', onGlowSize);
  $('glow-h').addEventListener('input', onGlowSize);
  // 看板: 選択中の矩形サイズ／セット名の編集（新規設置の既定値も兼ねる）
  const onSignOpts = () => {
    updateSignFiles();
    if (!selectedMarker || selectedMarker.userData.def.kind !== 'sign') return;
    const def = selectedMarker.userData.def;
    def.size = [Math.max(0.05, Number($('sign-w').value) || 0.6), Math.max(0.05, Number($('sign-h').value) || 0.25)];
    selectedMarker.scale.set(def.size[0], def.size[1], 1);
    const set = ($('sign-set').value || '').trim();
    if (set) { def.set = set; applySignTex(selectedMarker); }
  };
  $('sign-w').addEventListener('input', onSignOpts);
  $('sign-h').addEventListener('input', onSignOpts);
  $('sign-set').addEventListener('input', onSignOpts);
  $('btn-tex-new').addEventListener('click', () => makeTemplate());
  $('btn-tex-reload').addEventListener('click', async () => {
    await refreshManifest();
    reloadTextures();
    setStatus('看板画像を読み直しました');
  });
  // ギズモ切替（ボタン＋ G=移動 / R=回転 / Esc=解除）
  const gzBtns = { translate: $('btn-gz-move'), rotate: $('btn-gz-rot'), off: $('btn-gz-off') };
  const syncGzBtns = () => {
    for (const [m, b] of Object.entries(gzBtns)) b.style.background = (m === gizmoMode) ? '#2b4a80' : '#24314f';
  };
  for (const [m, b] of Object.entries(gzBtns)) b.addEventListener('click', () => { setGizmoMode(m); syncGzBtns(); });
  syncGzBtns();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && !shiftDown) { shiftDown = true; applySnap(); }
    if (e.target instanceof HTMLInputElement) return;   // 入力欄の編集中は文字削除を優先
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.code === 'KeyG') { setGizmoMode('translate'); syncGzBtns(); }
    else if (e.code === 'KeyR') { setGizmoMode('rotate'); syncGzBtns(); }
    else if (e.code === 'Escape') { setGizmoMode('off'); syncGzBtns(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') { shiftDown = false; applySnap(); } });
  window.addEventListener('blur', () => { shiftDown = false; applySnap(); });   // Alt+Tab等でShiftが押しっぱなし扱いにならないように
  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  if (list.length) { sel.value = list[0]; loadModel(list[0]); }
  renderer.setAnimationLoop(() => {
    // 明滅プレビュー（ゲームと同じサイン波のゆっくり明滅）
    const t = performance.now() / 1000;
    for (const m of markerGroup.children) {
      const def = m.userData.def;
      if (def.kind !== 'light' || !(def.blink > 0)) continue;
      const br = 0.5 - 0.5 * Math.cos((t / def.blink) * Math.PI * 2);   // 0→1→0
      m.material.opacity = (m === selectedMarker ? 0.4 : 0.95) * (0.1 + 0.9 * br);
    }
    renderer.render(scene, camera);
  });
  setStatus('建物を選び、面をクリックしてマーカーを設置（看板はセット名を決めて「テンプレ作成」）');
}
// 自動テスト用の覗き口（city-fly の __fly と同じ流儀）
window.__ee = {
  get gizmo() { return gizmo; }, get camera() { return camera; }, get selected() { return selectedMarker; },
  get markers() { return markerGroup.children; }, get entries() { return entries; },
};
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
