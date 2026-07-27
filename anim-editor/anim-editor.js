// anim-editor.js — VRMアニメーション編集の単独エディタ（本体エディタのアニメ機能を切り離し）。
// VRM読込 → IKポージング（腰=手足ピン留め/頭=SpineIK/手足=TwoBoneIK+ポール固定・関節FK）
// → タイムライン（lib/anim-timeline.js 共用: ポーズキー+表情トラック）→ .vrma 書き出し/読み込み。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { solveTwoBoneIK, solveSpineIK } from '../lib/pose-kit.js';
import { createAnimTimeline } from '../lib/anim-timeline.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit, gizmo, gizmoProxy;
let vrm = null, hipsRestY = 1, restPose = null;
let timeline = null;
let curHandle = 'hips';
let fkBone = null;
let jointsOn = false;
let hipPins = null, dragPoles = null;
const handles = new Map();
const jointDots = new Map();
const clock = new THREE.Clock();

const HANDLE_DEFS = {
  hips: { color: 0xff8040, bone: 'hips', rotate: true },
  head: { color: 0x60c0ff, bone: 'head', rotate: false },
  handL: { color: 0x80ff80, bone: 'leftHand', rotate: false },
  handR: { color: 0x80ff80, bone: 'rightHand', rotate: false },
  footL: { color: 0xff80c0, bone: 'leftFoot', rotate: false },
  footR: { color: 0xff80c0, bone: 'rightFoot', rotate: false },
};
const FK_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

const nb = (name) => vrm?.humanoid?.getNormalizedBoneNode(name);
const bsNames = () => vrm?.expressionManager ? vrm.expressionManager.expressions.map((e) => e.expressionName) : [];
function limbOf(h) {
  const side = h.endsWith('L') ? 'left' : 'right';
  return h.startsWith('hand')
    ? { root: nb(side + 'UpperArm'), mid: nb(side + 'LowerArm'), end: nb(side + 'Hand') }
    : { root: nb(side + 'UpperLeg'), mid: nb(side + 'LowerLeg'), end: nb(side + 'Foot') };
}

// ── VRM読込 ──
async function loadVrmBlob(blob, label) {
  if (vrm) { scene.remove(vrm.scene); vrm = null; }
  const l = new GLTFLoader();
  l.register((p) => new VRMLoaderPlugin(p));
  const gltf = await l.loadAsync(URL.createObjectURL(blob));
  vrm = gltf.userData.vrm;
  try { VRMUtils.rotateVRM0(vrm); } catch { /* VRM1は不要 */ }   // VRM0/1の正面向きを統一
  scene.add(vrm.scene);
  hipsRestY = nb('hips').position.y;
  restPose = {};
  for (const name of Object.keys(vrm.humanoid.humanBones)) {
    const b = nb(name);
    if (b) restPose[name] = { q: b.quaternion.clone(), p: name === 'hips' ? b.position.clone() : null };
  }
  buildJointDots();
  selectHandle('hips');
  timeline.refreshBsList();
  setStatus(`読み込み: ${label}（表情 ${bsNames().length}種）`);
}
function resetPose() {
  if (!restPose) return;
  for (const [name, r] of Object.entries(restPose)) {
    const b = nb(name);
    if (!b) continue;
    b.quaternion.copy(r.q);
    if (r.p) b.position.copy(r.p);
  }
  if (vrm?.expressionManager) for (const nm of bsNames()) vrm.expressionManager.setValue(nm, 0);
}

// ── IK/FK ──
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
    const bend = limb.mid.getWorldPosition(new THREE.Vector3()).sub(r);
    bend.addScaledVector(axis, -bend.dot(axis));
    dragPoles[h] = bend.lengthSq() > 0.0004 ? bend.normalize() : (h.startsWith('foot') ? fwd.clone() : fwd.clone().negate());
  }
}
function makeHandles() {
  for (const [name, def] of Object.entries(HANDLE_DEFS)) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10),
      new THREE.MeshBasicMaterial({ color: def.color, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 10;
    m.userData.handle = name;
    scene.add(m);
    handles.set(name, m);
  }
}
function syncHandles() {
  for (const [name, def] of Object.entries(HANDLE_DEFS)) {
    if (gizmo.dragging && name === curHandle) continue;
    const b = nb(def.bone);
    if (b) b.getWorldPosition(handles.get(name).position);
  }
  for (const [name, dot] of jointDots) {
    dot.visible = jointsOn;
    if (jointsOn) nb(name)?.getWorldPosition(dot.position);
  }
}
function buildJointDots() {
  for (const [, d] of jointDots) scene.remove(d);
  jointDots.clear();
  for (const name of FK_BONES) {
    if (!nb(name)) continue;
    const d = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: 0xbb99ff, depthTest: false, transparent: true, opacity: 0.85 }));
    d.renderOrder = 9;
    d.visible = false;
    d.userData.fk = name;
    scene.add(d);
    jointDots.set(name, d);
  }
}
function selectHandle(name) {
  curHandle = name;
  fkBone = null;
  for (const id of Object.keys(HANDLE_DEFS)) { const b = $('h-' + id); if (b) b.className = id === name ? 'on' : 'sub'; }
  const def = HANDLE_DEFS[name];
  const m = handles.get(name);
  gizmoProxy.position.copy(m.position);
  if (def.bone) nb(def.bone).getWorldQuaternion(gizmoProxy.quaternion);
  gizmo.setSpace('world');
  gizmo.attach(gizmoProxy);
  if (!def.rotate && gizmo.mode === 'rotate') gizmo.setMode('translate');
  setStatus(`操作対象: ${name}（${def.rotate ? '移動/回転' : '移動のみ'}）`);
}
function selectFk(name) {
  curHandle = 'fk';
  fkBone = nb(name);
  for (const id of Object.keys(HANDLE_DEFS)) { const b = $('h-' + id); if (b) b.className = 'sub'; }
  gizmo.setMode('rotate');
  gizmo.setSpace('local');
  gizmo.attach(fkBone);
  setStatus(`関節FK: ${name}（回転）`);
}
const _v1 = new THREE.Vector3(), _q1 = new THREE.Quaternion();
function applyHandle() {
  if (!vrm || curHandle === 'fk') return;
  const name = curHandle;
  const target = gizmoProxy.position;
  if (name === 'hips') {
    const hips = nb('hips');
    if (gizmo.mode === 'rotate') {
      const pq = hips.parent.getWorldQuaternion(_q1).invert();
      hips.quaternion.copy(pq.multiply(gizmoProxy.quaternion));
    } else {
      hips.position.copy(hips.parent.worldToLocal(_v1.copy(target)));
    }
    if (hipPins) {   // 腰IK: ピン留めした手足へ四肢を再解決
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

// ── VRMA入出力 ──
async function b64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  return btoa(s);
}
async function saveVrma() {
  const blob = timeline.buildBlob();
  if (!blob) return;
  const name = ($('save-name').value || 'anim').replace(/[^\w\-]/g, '') + '.vrma';
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'vrma', filename: name, content: await b64(blob), encoding: 'base64' }) });
    setStatus(r.ok ? `保存しました: vrma/${name}` : '保存失敗: ' + r.status);
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}
function downloadVrma() {
  const blob = timeline.buildBlob();
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ($('save-name').value || 'anim').replace(/[^\w\-]/g, '') + '.vrma';
  a.click();
}
async function importVrma() {
  if (!vrm) { setStatus('先にVRMモデルを読み込んでください'); return; }
  const file = $('vrma-sel').value;
  if (!file) { setStatus('VRMAを選択してください（一覧が空の場合はサーバ起動を確認してリロード）'); return; }
  setStatus('VRMA読込中…');
  const res = await fetch('../vrma/' + encodeURIComponent(file));
  if (!res.ok) throw new Error('取得失敗 HTTP ' + res.status + '（サーバ起動を確認）');
  const al = new GLTFLoader();
  al.register((p) => new VRMAnimationLoaderPlugin(p));
  const ag = await al.loadAsync(URL.createObjectURL(await res.blob()));
  const clip = createVRMAnimationClip(ag.userData.vrmAnimations[0], vrm);
  timeline.importClip(clip);
  setStatus(`キー化: ${file}（${timeline.tl.keys.length}キー / ${timeline.tl.dur}s）— 編集して別名保存できます`);
}

// ── キャラライト調整: CityFly夜間の「キャラ専用補助光」を実物のVRMで調整して保存 ──
function setupCharLight(sceneAmb, sceneDir) {
  // CityFlyと同一構成: キャラ追従の前後2灯PointLight（位置・距離・減衰も同値＝見た目が一致する）
  const clDir = new THREE.PointLight(0xcfd8ff, 0, 7, 1.2);
  clDir.position.set(0.35, 1.7, 0.7);
  scene.add(clDir);
  const clAmb = new THREE.PointLight(0xb8c4dd, 0, 6, 1.2);
  clAmb.position.set(-0.3, 1.5, -0.8);
  scene.add(clAmb);
  let night = false;
  const cfg = { dirI: 1.9, ambI: 0.85, dirC: '#cfd8ff', ambC: '#b8c4dd' };
  const syncUI = () => {
    $('cl-dir').value = String(cfg.dirI); $('cl-dir-val').textContent = cfg.dirI.toFixed(2);
    $('cl-amb').value = String(cfg.ambI); $('cl-amb-val').textContent = cfg.ambI.toFixed(2);
    $('cl-dirc').value = cfg.dirC; $('cl-ambc').value = cfg.ambC;
  };
  const apply = () => {   // 夜プレビュー中だけ補助光ON＝ゲームの真夜中(nightF=1)相当
    clDir.intensity = night ? cfg.dirI : 0;
    clAmb.intensity = night ? cfg.ambI : 0;
    clDir.color.set(cfg.dirC);
    clAmb.color.set(cfg.ambC);
    sceneAmb.intensity = night ? 0.10 : 0.85;      // 夜の街の暗さを再現
    sceneDir.intensity = night ? 0.10 : 1.4;
    scene.background.set(night ? 0x0a0e1a : 0x1a2030);
  };
  fetch('../npc/char-light.json').then((r) => r.json()).then((j) => { Object.assign(cfg, j); syncUI(); apply(); }).catch(() => syncUI());
  $('btn-night').addEventListener('click', () => { night = !night; $('btn-night').className = night ? 'on' : 'sub'; apply(); });
  $('cl-dir').addEventListener('input', () => { cfg.dirI = parseFloat($('cl-dir').value); syncUI(); apply(); });
  $('cl-amb').addEventListener('input', () => { cfg.ambI = parseFloat($('cl-amb').value); syncUI(); apply(); });
  $('cl-dirc').addEventListener('input', () => { cfg.dirC = $('cl-dirc').value; apply(); });
  $('cl-ambc').addEventListener('input', () => { cfg.ambC = $('cl-ambc').value; apply(); });
  $('btn-cl-save').addEventListener('click', async () => {
    try {
      const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'npc', filename: 'char-light.json', content: JSON.stringify(cfg, null, 1) }) });
      setStatus(r.ok ? '保存しました: npc/char-light.json（CityFlyをリロードで反映）' : '保存失敗: ' + r.status);
    } catch (e) { setStatus('保存失敗: ' + e.message); }
  });
}

// ── 初期化 ──
async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;   // CityFlyと同じトーンマップ（キャラライト調整の見た目を一致させる）
  renderer.toneMappingExposure = 1.0;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2030);
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(1.6, 1.5, 2.4);
  const amb = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(amb);
  const dl = new THREE.DirectionalLight(0xfff2dd, 1.4);
  dl.position.set(3, 6, 2);
  scene.add(dl);
  scene.add(new THREE.GridHelper(6, 12, 0x33415e, 0x222c44));
  setupCharLight(amb, dl);   // キャラライト調整（夜プレビュー＋char-light.json保存）
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0.9, 0);
  gizmoProxy = new THREE.Object3D();
  scene.add(gizmoProxy);
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.75);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
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

  // タイムライン（共用モジュール）
  timeline = createAnimTimeline({
    els: {
      canvas: $('tl-canvas'), grip: $('tl-grip'), info: $('tl-info'), play: $('btn-play'),
      dur: $('tl-dur'), loop: $('cb-loop'), bsSel: $('bs-sel'), bsVal: $('bs-val'), bsValTxt: $('bs-val-txt'),
    },
    getVrm: () => vrm,
    getHipsRestY: () => hipsRestY,
    setStatus,
  });

  // UI
  for (const name of Object.keys(HANDLE_DEFS)) $('h-' + name)?.addEventListener('click', () => selectHandle(name));
  $('btn-joints').addEventListener('click', () => { jointsOn = !jointsOn; $('btn-joints').className = jointsOn ? 'on' : 'sub'; });
  $('btn-mode').addEventListener('click', () => {
    if (curHandle === 'fk') return;
    if (!HANDLE_DEFS[curHandle]?.rotate && gizmo.mode === 'translate') return;
    gizmo.setMode(gizmo.mode === 'translate' ? 'rotate' : 'translate');
  });
  $('btn-reset').addEventListener('click', () => { resetPose(); setStatus('ポーズを初期化しました'); });
  $('btn-key').addEventListener('click', () => timeline.addKey());
  $('btn-key-del').addEventListener('click', () => timeline.delKey());
  $('btn-insert').addEventListener('click', () => timeline.insertTime(0.5));
  $('btn-bs-key').addEventListener('click', () => timeline.addBsKey());
  $('btn-save').addEventListener('click', saveVrma);
  $('btn-dl').addEventListener('click', downloadVrma);
  $('btn-vrma-import').addEventListener('click', () => importVrma().catch((e) => setStatus('VRMA読込失敗: ' + e.message)));
  $('btn-flip').addEventListener('click', () => { if (vrm) { vrm.scene.rotation.y += Math.PI; setStatus('モデルを180°反転しました'); } });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'KeyR') $('btn-mode').click();
    if (e.code === 'KeyK') timeline.addKey();
    if (e.code === 'KeyE') timeline.addBsKey();
    if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
    if (e.code === 'Delete' || e.code === 'Backspace') timeline.delKey();
  });
  renderer.domElement.addEventListener('click', (e) => {
    if (gizmo.dragging || !vrm) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hs = ray.intersectObjects([...handles.values()], false)[0];
    if (hs) { selectHandle(hs.object.userData.handle); return; }
    if (jointsOn) {
      const hj = ray.intersectObjects([...jointDots.values()].filter((d) => d.visible), false)[0];
      if (hj) selectFk(hj.object.userData.fk);
    }
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    timeline.draw();
  });

  // VRM / VRMA 一覧
  try {
    const vrms = await (await fetch('../vrm/manifest.json')).json();
    for (const f of vrms) { const o = document.createElement('option'); o.value = f; o.textContent = f; $('vrm-sel').appendChild(o); }
  } catch { /* manifest無し */ }
  try {
    const vrmas = await (await fetch('../vrma/manifest.json')).json();
    for (const f of vrmas) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.vrma$/i, ''); $('vrma-sel').appendChild(o); }
  } catch { /* manifest無し */ }
  $('btn-vrm-load').addEventListener('click', async () => {
    const f = $('vrm-sel').value;
    if (!f) return;
    setStatus('VRM読込中…');
    loadVrmBlob(await (await fetch('../vrm/' + encodeURIComponent(f))).blob(), f).catch((e) => setStatus('VRM読込失敗: ' + e.message));
  });
  $('btn-vrm-file').addEventListener('click', () => $('vrm-file').click());
  $('vrm-file').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadVrmBlob(f, f.name).catch((err) => setStatus('VRM読込失敗: ' + err.message));
  });

  makeHandles();
  timeline.draw();
  if ($('vrm-sel').options.length) { $('vrm-sel').selectedIndex = 0; $('btn-vrm-load').click(); }
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    timeline.update(dt);
    if (vrm) { vrm.update(dt); syncHandles(); }
    renderer.render(scene, camera);
  });
  setStatus('VRMを読み込み→IKでポーズ→K(キー追加)→再生/保存。VRMA読込で既存アニメの再編集も可');
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
