// tool-editor.js — 道具の「持ち方」エディタ。
// VRM（soldier）に道具を持たせ、持ち手ボーンの子としての位置/向き/スケールをギズモで調整して
// public/tools/<名前>.tool.json に保存する。添え手（IK目標）も道具ローカルで指定できる。
// ボーンは正規化リグに統一（lib/vrm-tool.js と同じ規約＝ゲームでそのまま再現される）。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { PROC_TOOLS } from '../lib/tool-models.js';
import { holdTool, applyMainTransform } from '../lib/vrm-tool.js';
import { solveTwoBoneIK } from '../lib/pose-kit.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit, gizmo;
let vrm = null, mixer = null, action = null, animDur = 1;
let toolObj = null, held = null, subMarker = null, playing = false;
let gizmoTarget = 'tool';   // 'tool' | 'sub'
const clock = new THREE.Clock();
const def = { name: 'rifle', ref: { proc: 'rifle' }, scale: 1, main: { bone: 'rightHand', pos: [0, 0, 0], rotDeg: [0, 0, 0] }, sub: null };
let POSES = ['Firing Rifle.vrma', 'Run Forward.vrma', 'Catwalk_Walk_Forward.vrma', 'Dying.vrma'];   // vrma/manifest.json で全件に置換

const nb = (n) => vrm?.humanoid?.getNormalizedBoneNode(n);

async function loadVrm() {
  const l = new GLTFLoader();
  l.register((p) => new VRMLoaderPlugin(p));
  const gltf = await l.loadAsync('../vrm/soldier.vrm');
  vrm = gltf.userData.vrm;
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
}

async function setPose(file) {
  if (action) { action.stop(); action = null; }
  mixer = null;
  if (!file) { vrm.humanoid.resetNormalizedPose(); return; }
  try {
    const al = new GLTFLoader();
    al.register((p) => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync('../vrma/' + encodeURIComponent(file));
    const clip = createVRMAnimationClip(ag.userData.vrmAnimations[0], vrm);
    // その場ポーズ化（移動は除去）
    for (const tr of clip.tracks) if (tr.name.endsWith('.position')) { const v = tr.values; for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; } }
    mixer = new THREE.AnimationMixer(vrm.scene);
    action = mixer.clipAction(clip);
    animDur = clip.duration || 1;
    action.play();
    mixer.setTime(($('pose-time').valueAsNumber || 0) * animDur);
    action.paused = !playing;
    setStatus('ポーズ: ' + file + (playing ? '（再生中）' : '（スライダーで時間を選択）'));
  } catch (e) { setStatus('ポーズ読込失敗: ' + e.message); }
}

async function loadToolObj() {
  if (held) { held.release(); held = null; }
  toolObj = null;
  const glbName = $('glb-name').value.trim();
  if (glbName) {
    const path = window._glbPaths?.get(glbName);
    if (!path) { setStatus('GLBが見つかりません: ' + glbName); return; }
    try {
      const gltf = await new GLTFLoader().loadAsync('../models/' + path.split('/').map(encodeURIComponent).join('/'));
      toolObj = gltf.scene;
      def.ref = { dir: path.slice(0, path.lastIndexOf('/')), file: glbName };
    } catch (e) { setStatus('GLB読込失敗: ' + e.message); return; }
  } else {
    const key = $('tool-src').value.replace('proc:', '');
    toolObj = PROC_TOOLS[key] ? PROC_TOOLS[key]() : PROC_TOOLS.rifle();
    def.ref = { proc: key };
  }
  attachNow();
}
function attachNow() {
  if (!toolObj || !vrm) return;
  def.main.bone = $('main-bone').value;
  def.scale = +$('tool-scale').value || 1;
  held = holdTool(vrm, toolObj, def);
  buildSubMarker();
  setGizmoTarget(gizmoTarget);
  setStatus('装着: ' + (def.ref.proc || def.ref.file) + ' → ' + def.main.bone);
}
function buildSubMarker() {
  if (subMarker && subMarker.parent) subMarker.parent.remove(subMarker);
  subMarker = null;
  if (!def.sub || !toolObj) return;
  subMarker = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff40ff, depthTest: false, transparent: true, opacity: 0.9 }));
  subMarker.renderOrder = 10;
  subMarker.position.fromArray(def.sub.pos || [0, 0, 0]);
  const r = def.sub.rotDeg || [0, 0, 0];
  subMarker.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
  toolObj.add(subMarker);
}
function setGizmoTarget(t) {
  gizmoTarget = t;
  $('g-tool').className = t === 'tool' ? 'on' : '';
  $('g-sub').className = t === 'sub' ? 'on' : '';
  if (t === 'tool' && toolObj) gizmo.attach(toolObj);
  else if (t === 'sub' && subMarker) gizmo.attach(subMarker);
  else gizmo.detach();
}
function writeBack() {   // ギズモ操作 → def へ
  if (gizmoTarget === 'tool' && toolObj) {
    def.main.pos = toolObj.position.toArray().map((n) => +n.toFixed(4));
    def.main.rotDeg = [toolObj.rotation.x, toolObj.rotation.y, toolObj.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
  } else if (gizmoTarget === 'sub' && subMarker && def.sub) {
    def.sub.pos = subMarker.position.toArray().map((n) => +n.toFixed(4));
    def.sub.rotDeg = [subMarker.rotation.x, subMarker.rotation.y, subMarker.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
  }
}

// 添え手IKプレビュー（ゲームと同じ挙動）
const _sp = new THREE.Vector3(), _sq = new THREE.Quaternion(), _pq = new THREE.Quaternion();
function applySubIK() {
  if (!held || !def.sub || !vrm) return;
  const boneName = held.subGrip(_sp, _sq);
  if (!boneName) return;
  const side = boneName.startsWith('left') ? 'left' : 'right';
  const limb = { root: nb(side + 'UpperArm'), mid: nb(side + 'LowerArm'), end: nb(side + 'Hand') };
  if (!limb.root || !limb.mid || !limb.end) return;
  const r = solveTwoBoneIK(limb, _sp);
  if (r) { limb.root.quaternion.copy(r.rootQuat); limb.mid.quaternion.copy(r.midQuat); }
  // 手の向きもグリップに合わせる
  limb.end.updateWorldMatrix(true, false);
  limb.end.parent.getWorldQuaternion(_pq);
  limb.end.quaternion.copy(_pq.invert().multiply(_sq)).normalize();
}

async function save() {
  def.name = $('tool-name').value.trim() || 'tool';
  writeBack();
  const body = { dir: 'tools', filename: def.name + '.tool.json', content: JSON.stringify(def, null, 1) };
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setStatus(r.ok ? '保存: tools/' + def.name + '.tool.json' : '保存失敗: ' + r.status);
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}
async function load() {
  const name = $('tool-name').value.trim();
  try {
    const j = await (await fetch('../tools/' + name + '.tool.json?t=' + Date.now())).json();
    Object.assign(def, j);
    $('tool-scale').value = def.scale || 1;
    $('main-bone').value = def.main?.bone || 'rightHand';
    $('cb-sub').checked = !!def.sub;
    if (def.sub) $('sub-bone').value = def.sub.bone || 'leftHand';
    if (def.ref?.proc) { $('tool-src').value = 'proc:' + def.ref.proc; $('glb-name').value = ''; }
    else if (def.ref?.file) $('glb-name').value = def.ref.file;
    await loadToolObj();
    setStatus('読込: ' + name + '.tool.json');
  } catch (e) { setStatus('読込失敗: ' + e.message); }
}

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x161b28);
  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(1.4, 1.6, 1.8);
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const dl = new THREE.DirectionalLight(0xfff2dd, 1.4);
  dl.position.set(3, 6, 2);
  scene.add(dl);
  scene.add(new THREE.GridHelper(6, 12, 0x33415e, 0x222c44));
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 1.2, 0);
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.7);
  gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
  gizmo.addEventListener('objectChange', writeBack);
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

  // UI
  try {   // vrma 全件をリストへ（よく使う4種を先頭に）
    const all = await (await fetch('../vrma/manifest.json')).json();
    if (Array.isArray(all) && all.length) POSES = [...POSES, ...all.filter((f) => !POSES.includes(f))];
  } catch { /* manifestなしでも既定4種で動く */ }
  for (const f of POSES) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace('.vrma', ''); $('pose-sel').appendChild(o); }
  $('btn-pose-play').addEventListener('click', () => {
    playing = !playing;
    $('btn-pose-play').textContent = playing ? '⏸ 停止' : '▶ 再生';
    $('btn-pose-play').className = playing ? 'on' : '';
    if (action) action.paused = !playing;
    else if (playing && $('pose-sel').value) setPose($('pose-sel').value);
  });
  $('pose-sel').addEventListener('change', () => setPose($('pose-sel').value));
  $('pose-time').addEventListener('input', () => { if (mixer && action) { playing = false; $('btn-pose-play').textContent = '▶ 再生'; $('btn-pose-play').className = ''; mixer.setTime($('pose-time').valueAsNumber * animDur); action.paused = true; } });
  $('tool-src').addEventListener('change', () => { $('glb-name').value = ''; loadToolObj(); });
  $('glb-name').addEventListener('change', () => loadToolObj());
  $('tool-scale').addEventListener('change', () => { if (held) applyMainTransform(toolObj, { ...def, scale: +$('tool-scale').value || 1 }); def.scale = +$('tool-scale').value || 1; });
  $('main-bone').addEventListener('change', () => attachNow());
  $('cb-sub').addEventListener('change', () => {
    if ($('cb-sub').checked) { def.sub = def.sub || { bone: $('sub-bone').value, pos: [0.15, 0.08, 0], rotDeg: [0, 0, 0] }; }
    else def.sub = null;
    buildSubMarker();
    setGizmoTarget(def.sub ? 'sub' : 'tool');
  });
  $('sub-bone').addEventListener('change', () => { if (def.sub) def.sub.bone = $('sub-bone').value; });
  $('g-tool').addEventListener('click', () => setGizmoTarget('tool'));
  $('g-sub').addEventListener('click', () => setGizmoTarget('sub'));
  $('btn-mode').addEventListener('click', () => gizmo.setMode(gizmo.mode === 'translate' ? 'rotate' : 'translate'));
  addEventListener('keydown', (e) => { if (e.code === 'KeyR' && e.target.tagName !== 'INPUT') gizmo.setMode(gizmo.mode === 'translate' ? 'rotate' : 'translate'); });
  $('btn-save').addEventListener('click', save);
  $('btn-load').addEventListener('click', load);
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // GLB一覧（datalist）
  try {
    const all = await (await fetch('../models/manifest.json')).json();
    window._glbPaths = new Map();
    for (const f of all) {
      const name = f.split('/').pop().replace(/\.glb$/i, '');
      if (!window._glbPaths.has(name)) window._glbPaths.set(name, f.replace(/\.glb$/i, '') + '.glb');
      const o = document.createElement('option'); o.value = name; $('glb-list').appendChild(o);
    }
  } catch { /* manifestなしでも動く */ }

  await loadVrm();
  await loadToolObj();
  // 既存の rifle.tool.json があれば読み込む
  try { const r = await fetch('../tools/rifle.tool.json'); if (r.ok) await load(); } catch { /* 初回 */ }

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    if (mixer) {
      mixer.update(playing ? dt : 0);
      if (playing && action) $('pose-time').value = ((action.time % animDur) / animDur).toFixed(3);   // スライダー追従
    }
    if (vrm) {
      applySubIK();
      vrm.update(dt);
    }
    renderer.render(scene, camera);
  });
  setStatus('道具をギズモで手に合わせ→（添え手ON→球を移動）→保存。ポーズ確認で構え姿勢に');
  window.__toolDbg = { get vrm() { return vrm; }, get def() { return def; }, get toolObj() { return toolObj; }, get held() { return held; }, camera, orbit, attachNow, buildSubMarker, THREE };
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
