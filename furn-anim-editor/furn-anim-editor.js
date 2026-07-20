// furn-anim-editor.js — 家具インタラクションのポーズ編集（F1: 静止ポーズ）。
// 家具カテゴリ単位のアンカー（NPC全体の位置/向き）＋ IK（腰/頭/手足）でポーズを作り、
// 本物の .vrma（1フレーム）として保存 → furniture-anims.json v2 でアクションに割当。
// 生活プレビュー（room-editor）とゲームの在宅NPCが同じデータを再生する。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { categorize } from '../lib/room-gen.js';
import { solveTwoBoneIK, solveSpineIK } from '../lib/pose-kit.js';
import { createAnimTimeline } from '../lib/anim-timeline.js';

const KIT_DIR = '../models/kenney_furniture-kit/Models/GLTF format/';
const SCALE = 1.5;   // ゲーム内装と同縮尺
const CATS = ['bed', 'sofa', 'armchair', 'chair', 'deskChair', 'bench', 'toilet', 'bath', 'kitchenUnit', 'diningTable'];

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit, gizmo, gizmoProxy;
let furniture = null, catModels = [], modelIdx = 0;
let vrm = null, hipsRestY = 1, restPose = null;
let timeline = null;   // lib/anim-timeline.js（ポーズキー＋表情トラック）
let curHandle = 'anchor';
let hipPins = null;    // 腰ドラッグ中の手足ピン留め位置（腰IK用）
let dragPoles = null;  // ドラッグ中の肘/膝ポールベクタ（曲がる方向をドラッグ開始時に固定＝逆曲がり防止）
const handles = new Map();   // name -> sphere mesh
const loader = new GLTFLoader();
const clock = new THREE.Clock();

function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
const nb = (name) => vrm.humanoid.getNormalizedBoneNode(name);

// ── 家具ロード（カテゴリ内のモデルを切替表示）──
async function loadFurniture() {
  if (furniture) { scene.remove(furniture); furniture = null; }
  const name = catModels[modelIdx];
  if (!name) { $('model-name').textContent = '（モデルなし）'; return; }
  const gltf = await loader.loadAsync(KIT_DIR.split('/').map(encodeURIComponent).join('/') + encodeURIComponent(name) + '.glb');
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  furniture = new THREE.Group();
  furniture.add(obj);
  furniture.scale.setScalar(SCALE);
  scene.add(furniture);
  $('model-name').textContent = `${name}（${modelIdx + 1}/${catModels.length}）`;
}
function setCategory(cat) {
  catModels = window._kitNames.filter((n) => categorize(n) === cat);
  modelIdx = 0;
  loadFurniture().catch((e) => setStatus('家具読込失敗: ' + e.message));
}

// ── NPC（ken）──
async function loadNpc() {
  const bundle = await (await fetch('../npc/ken.npc.json')).json();
  const l = new GLTFLoader();
  l.register((p) => new VRMLoaderPlugin(p));
  const gltf = await l.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  vrm = gltf.userData.vrm;
  vrm.scene.position.set(0, 0, 0.9);   // 家具の手前に立たせる
  scene.add(vrm.scene);
  hipsRestY = nb('hips').position.y;
  // リセット用に正規化ボーンの初期状態を保存
  restPose = {};
  for (const name of Object.keys(vrm.humanoid.humanBones)) {
    const b = nb(name);
    if (b) restPose[name] = { q: b.quaternion.clone(), p: name === 'hips' ? b.position.clone() : null };
  }
  timeline?.refreshBsList();
}
function resetPose() {
  for (const [name, r] of Object.entries(restPose)) {
    const b = nb(name);
    if (!b) continue;
    b.quaternion.copy(r.q);
    if (r.p) b.position.copy(r.p);
  }
}

// ── ハンドルとIK ──
const HANDLE_DEFS = {
  anchor: { color: 0xffe060, bone: null, rotate: true },
  hips: { color: 0xff8040, bone: 'hips', rotate: true },
  head: { color: 0x60c0ff, bone: 'head', rotate: false },
  handL: { color: 0x80ff80, bone: 'leftHand', rotate: false },
  handR: { color: 0x80ff80, bone: 'rightHand', rotate: false },
  footL: { color: 0xff80c0, bone: 'leftFoot', rotate: false },
  footR: { color: 0xff80c0, bone: 'rightFoot', rotate: false },
};
function makeHandles() {
  for (const [name, def] of Object.entries(HANDLE_DEFS)) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(name === 'anchor' ? 0.06 : 0.045, 12, 10),
      new THREE.MeshBasicMaterial({ color: def.color, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 10;
    m.userData.handle = name;
    scene.add(m);
    handles.set(name, m);
  }
}
function syncHandles() {   // ドラッグ中以外はボーン位置へ追従
  for (const [name, def] of Object.entries(HANDLE_DEFS)) {
    if (gizmo.dragging && name === curHandle) continue;
    const m = handles.get(name);
    if (name === 'anchor') m.position.copy(vrm.scene.position).y += 0.02;
    else def.bone && nb(def.bone)?.getWorldPosition(m.position);
  }
}
function selectHandle(name) {
  curHandle = name;
  for (const id of Object.keys(HANDLE_DEFS)) { const b = $('h-' + id); if (b) b.className = id === name ? 'on' : 'sub'; }
  const def = HANDLE_DEFS[name];
  const m = handles.get(name);
  gizmoProxy.position.copy(m.position);
  if (name === 'anchor') gizmoProxy.quaternion.setFromEuler(new THREE.Euler(0, vrm.scene.rotation.y, 0));
  else if (def.bone) nb(def.bone).getWorldQuaternion(gizmoProxy.quaternion);
  gizmo.attach(gizmoProxy);
  if (!def.rotate && gizmo.mode === 'rotate') setGizmoMode('translate');
  setStatus(`操作対象: ${name}（${def.rotate ? '移動/回転' : '移動のみ'}）`);
}
function setGizmoMode(m) {
  if (m === 'rotate' && !HANDLE_DEFS[curHandle].rotate) return;
  gizmo.setMode(m);
  if (m === 'rotate') { gizmo.showX = curHandle !== 'anchor'; gizmo.showZ = curHandle !== 'anchor'; gizmo.showY = true; }
  else { gizmo.showX = true; gizmo.showY = true; gizmo.showZ = true; }
}
const _v1 = new THREE.Vector3(), _q1 = new THREE.Quaternion();
function limbOf(h) {   // ハンドル名 → IKチェーン
  const side = h.endsWith('L') ? 'left' : 'right';
  return h.startsWith('hand')
    ? { root: nb(side + 'UpperArm'), mid: nb(side + 'LowerArm'), end: nb(side + 'Hand') }
    : { root: nb(side + 'UpperLeg'), mid: nb(side + 'LowerLeg'), end: nb(side + 'Foot') };
}
// 現在の曲がり方向（root-end線に対するmidの張り出し）。伸び切りは解剖学的既定: 膝=体の前 / 肘=体の後ろ
function capturePoles() {
  dragPoles = {};
  // 体の前方は左右脚ボーンの位置から推定（モデルの向き・VRM0/1に依存しない）
  let fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(vrm.scene.getWorldQuaternion(new THREE.Quaternion()));
  const lL = nb('leftUpperLeg'), lR = nb('rightUpperLeg');
  if (lL && lR) {
    const side = lL.getWorldPosition(new THREE.Vector3()).sub(lR.getWorldPosition(new THREE.Vector3()));
    const f = new THREE.Vector3().crossVectors(side, new THREE.Vector3(0, 1, 0));
    if (f.lengthSq() > 1e-8) fwd = f.normalize();
  }
  for (const h of ['handL', 'handR', 'footL', 'footR']) {
    const limb = limbOf(h);
    if (!limb.root || !limb.mid || !limb.end) continue;
    const r = limb.root.getWorldPosition(new THREE.Vector3());
    const e = limb.end.getWorldPosition(new THREE.Vector3());
    const axis = e.clone().sub(r).normalize();
    const bend = limb.mid.getWorldPosition(new THREE.Vector3()).sub(r);   // root→mid
    bend.addScaledVector(axis, -bend.dot(axis));                          // root-end線への直交成分＝曲がり方向
    // ほぼ伸び切り(2cm未満)なら既定方向: 膝=前 / 肘=後ろ
    dragPoles[h] = bend.lengthSq() > 0.0004 ? bend.normalize() : (h.startsWith('foot') ? fwd.clone() : fwd.clone().negate());
  }
}
function applyHandle() {   // ギズモ操作をアンカー/IKへ反映
  if (!vrm) return;
  const name = curHandle;
  if (name === 'anchor') {
    vrm.scene.position.copy(gizmoProxy.position).setY(Math.max(0, gizmoProxy.position.y - 0.02));
    const e = new THREE.Euler().setFromQuaternion(gizmoProxy.quaternion, 'YXZ');
    vrm.scene.rotation.set(0, e.y, 0);
    return;
  }
  const target = gizmoProxy.position;
  if (name === 'hips') {
    const hips = nb('hips');
    if (gizmo.mode === 'rotate') {
      const pq = hips.parent.getWorldQuaternion(_q1).invert();
      hips.quaternion.copy(pq.multiply(gizmoProxy.quaternion));
    } else {
      hips.position.copy(hips.parent.worldToLocal(_v1.copy(target)));
    }
    // 腰IK: ピン留めした手足へ四肢を再解決（腰を下げると脚が曲がって屈む）
    if (hipPins) {
      vrm.scene.updateMatrixWorld(true);
      for (const [h, pin] of Object.entries(hipPins)) {
        const limb = limbOf(h);
        if (!limb.root || !limb.mid || !limb.end) continue;
        limb.poleVector = dragPoles?.[h] || null;
        const r = solveTwoBoneIK(limb, pin);
        limb.root.quaternion.copy(r.rootQuat);
        limb.mid.quaternion.copy(r.midQuat);
      }
    }
    return;
  }
  if (name === 'head') {
    const chain = ['spine', 'chest', 'upperChest', 'neck'].map(nb).filter(Boolean);
    solveSpineIK(chain, nb('head'), target, { iterations: 6, maxStepDeg: 10 });
    return;
  }
  const limb = limbOf(name);
  if (!limb.root || !limb.mid || !limb.end) return;
  limb.poleVector = dragPoles?.[name] || null;
  const r = solveTwoBoneIK(limb, target);
  limb.root.quaternion.copy(r.rootQuat);
  limb.mid.quaternion.copy(r.midQuat);
}

// ── 保存（1フレームVRMA＋anims.json v2）──
async function b64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  return btoa(s);
}
async function savePose() {
  if (!vrm || !furniture) { setStatus('家具とNPCの読込を待ってください'); return; }
  const cat = $('cat-sel').value, action = $('action-sel').value;
  const file = `furn_${cat}_${action}.vrma`;
  // タイムラインをVRMA化（キー未作成なら現在ポーズを1キー化＝静止ポーズとして保存）
  if (!timeline.tl.keys.length) timeline.addKey();
  const blob = timeline.buildBlob();
  if (!blob) return;
  try {
    let r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'vrma', filename: file, content: await b64(blob), encoding: 'base64' }) });
    if (!r.ok) throw new Error('vrma保存失敗: ' + r.status);
    // anims.json v2: {action: {vrma, cat, anchor}}（既存のstring形式は温存）
    let anims = {};
    try { anims = await (await fetch('../npc/furniture-anims.json?t=' + Date.now())).json() || {}; } catch { /* 初回 */ }
    anims[action] = {
      vrma: file, cat,
      anchor: {
        pos: [Number(vrm.scene.position.x.toFixed(3)), Number(vrm.scene.position.y.toFixed(3)), Number(vrm.scene.position.z.toFixed(3))],
        ry: Number(vrm.scene.rotation.y.toFixed(3)),
      },
    };
    r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'npc', filename: 'furniture-anims.json', content: JSON.stringify(anims, null, 1) }) });
    setStatus(r.ok ? `保存: vrma/${file} ＋ ${action} に割当（アンカー含む）` : 'anims.json保存失敗: ' + r.status);
  } catch (e) { setStatus(String(e.message || e)); }
}
async function loadAssignment() {
  const action = $('action-sel').value;
  let anims = {};
  try { anims = await (await fetch('../npc/furniture-anims.json?t=' + Date.now())).json() || {}; } catch { /* なし */ }
  const a = anims[action];
  if (!a || typeof a === 'string') { setStatus('このアクションに家具アニメ割当はありません'); return; }
  if (a.cat && a.cat !== $('cat-sel').value) { $('cat-sel').value = a.cat; setCategory(a.cat); }
  vrm.scene.position.fromArray(a.anchor?.pos || [0, 0, 0.9]);
  vrm.scene.rotation.set(0, a.anchor?.ry || 0, 0);
  try {
    const res = await fetch('../vrma/' + encodeURIComponent(a.vrma));
    if (!res.ok) throw new Error('vrmaが見つかりません');
    const al = new GLTFLoader();
    al.register((p) => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync(URL.createObjectURL(await res.blob()));
    const clip = createVRMAnimationClip(ag.userData.vrmAnimations[0], vrm);
    timeline.importClip(clip);   // キー化してタイムラインで再編集
    setStatus(`読み込み: ${a.vrma}（${timeline.tl.keys.length}キー — 再編集できます）`);
  } catch (e) { setStatus('vrma読込失敗: ' + e.message); }
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
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(2.2, 1.8, 2.6);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dl = new THREE.DirectionalLight(0xfff2dd, 1.5);
  dl.position.set(3, 6, 2);
  scene.add(dl);
  scene.add(new THREE.GridHelper(8, 16, 0x33415e, 0x222c44));
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0.7, 0);
  gizmoProxy = new THREE.Object3D();
  scene.add(gizmoProxy);
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.8);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    // ドラッグ開始時: 肘/膝の曲がり方向を固定（逆曲がり防止）。腰は手足のピン留めも
    if (e.value && vrm) {
      capturePoles();
      if (curHandle === 'hips') {
        hipPins = {};
        for (const [h, bone] of [['handL', 'leftHand'], ['handR', 'rightHand'], ['footL', 'leftFoot'], ['footR', 'rightFoot']]) {
          const b = nb(bone);
          if (b) hipPins[h] = b.getWorldPosition(new THREE.Vector3());
        }
      }
    } else if (!e.value) { hipPins = null; dragPoles = null; }
  });
  gizmo.addEventListener('objectChange', applyHandle);
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

  // タイムライン（anim-editorと共用モジュール）
  timeline = createAnimTimeline({
    els: {
      canvas: $('tl-canvas'), grip: $('tl-grip'), info: $('tl-info'), play: $('btn-play'),
      dur: $('tl-dur'), loop: $('cb-loop'), bsSel: $('bs-sel'), bsVal: $('bs-val'), bsValTxt: $('bs-val-txt'),
    },
    getVrm: () => vrm,
    getHipsRestY: () => hipsRestY,
    setStatus,
  });
  $('btn-key').addEventListener('click', () => timeline.addKey());
  $('btn-key-del').addEventListener('click', () => timeline.delKey());
  $('btn-insert').addEventListener('click', () => timeline.insertTime(0.5));
  $('btn-bs-key').addEventListener('click', () => timeline.addBsKey());

  // UI
  for (const c of CATS) { const o = document.createElement('option'); o.value = c; o.textContent = c; $('cat-sel').appendChild(o); }
  $('cat-sel').addEventListener('change', () => setCategory($('cat-sel').value));
  $('btn-prev-model').addEventListener('click', () => { if (catModels.length) { modelIdx = (modelIdx - 1 + catModels.length) % catModels.length; loadFurniture(); } });
  $('btn-next-model').addEventListener('click', () => { if (catModels.length) { modelIdx = (modelIdx + 1) % catModels.length; loadFurniture(); } });
  for (const name of Object.keys(HANDLE_DEFS)) $('h-' + name)?.addEventListener('click', () => selectHandle(name));
  $('btn-mode').addEventListener('click', () => setGizmoMode(gizmo.mode === 'translate' ? 'rotate' : 'translate'));
  $('btn-reset').addEventListener('click', () => { resetPose(); setStatus('ポーズを初期化しました'); });
  $('btn-save').addEventListener('click', () => savePose());
  $('btn-load').addEventListener('click', () => loadAssignment());
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'KeyR') setGizmoMode(gizmo.mode === 'translate' ? 'rotate' : 'translate');
    if (e.code === 'KeyK') timeline.addKey();
    if (e.code === 'KeyE') timeline.addBsKey();
    if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
    if (e.code === 'Delete' || e.code === 'Backspace') timeline.delKey();
  });
  renderer.domElement.addEventListener('click', (e) => {   // ハンドル球クリックで選択
    if (gizmo.dragging) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...handles.values()], false)[0];
    if (hit) selectHandle(hit.object.userData.handle);
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 家具一覧＋NPC
  const all = await (await fetch('../models/manifest.json')).json();
  window._kitNames = all.filter((f) => f.includes('kenney_furniture-kit')).map((f) => f.split('/').pop().replace(/\.glb$/i, ''));
  setCategory(CATS[0]);
  await loadNpc();
  makeHandles();
  selectHandle('anchor');
  timeline.draw();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    timeline.update(dt);
    if (vrm) { vrm.update(dt); syncHandles(); }
    renderer.render(scene, camera);
  });
  setStatus('アンカーで家具に合わせ→IKでポーズ→K(キー追加)で動きを作成→保存（キー無しなら静止ポーズ保存）');
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
