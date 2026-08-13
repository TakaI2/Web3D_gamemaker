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
import { holdTool, applyMainTransform, applyGrip } from '../lib/vrm-tool.js';
import { solveTwoBoneIK } from '../lib/pose-kit.js';
import { createActionRunner } from '../lib/vrm-action.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit, gizmo;
let vrm = null, mixer = null, action = null, animDur = 1;
let toolObj = null, held = null, subMarker = null, playing = false;
let runner = null, biteMarker = null, tableMesh = null, mouthMark = null;
let elbowArrow = null, lastPlay = null, scrubDur = 1;
const anchorMarks = {};   // mouth / inspect → 頭に付けたマーカー（ギズモで編集）
let gizmoTarget = 'tool';   // 'tool' | 'sub'
const clock = new THREE.Clock();
const _elDir = new THREE.Vector3();
const def = { name: 'rifle', ref: { proc: 'rifle' }, scale: 1, main: { bone: 'rightHand', pos: [0, 0, 0], rotDeg: [0, 0, 0] }, sub: null };
let POSES = ['Firing Rifle.vrma', 'Run Forward.vrma', 'Catwalk_Walk_Forward.vrma', 'Dying.vrma'];   // vrma/manifest.json で全件に置換

const nb = (n) => vrm?.humanoid?.getNormalizedBoneNode(n);

let npcName = 'soldier';
async function loadVrm(file = 'soldier.vrm') {
  if (vrm) { scene.remove(vrm.scene); vrm = null; }
  if (action) { action.stop(); action = null; }
  mixer = null; playing = false;
  const pb = $('btn-pose-play'); if (pb) { pb.textContent = '▶ 再生'; pb.className = ''; }
  const ps = $('pose-sel'); if (ps) ps.value = '';
  const l = new GLTFLoader();
  l.register((p) => new VRMLoaderPlugin(p));
  const gltf = await l.loadAsync('../vrm/' + encodeURIComponent(file));
  vrm = gltf.userData.vrm;
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
  npcName = file.replace(/\.vrm$/i, '');
  runner = createActionRunner(vrm);
  // このキャラのアンカー保存があれば復元（新形式 {mouth,inspect} / 旧形式 {fwd,up} 両対応）
  try {
    const mj = await (await fetch('../bitealign/' + npcName + '.mouth.json?t=' + Date.now())).json();
    if (mj?.mouth?.pos) {
      runner.anchors.mouth = mj.mouth;
      if (mj.inspect?.pos) runner.anchors.inspect = mj.inspect;
    } else if (mj && typeof mj.fwd === 'number') {
      runner.anchors.mouth.pos = [0, mj.up ?? -0.025, mj.fwd];   // 旧形式は概算変換（正面+Z想定）
    }
  } catch { /* 既定値のまま */ }
  buildAnchorMarks();
  if (toolObj) attachNow();   // 道具を新しいキャラへ持ち替え
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
  applyGrip(vrm, (def.main.bone || 'rightHand').startsWith('left') ? 'left' : 'right', def.grip ?? 0.8);
  buildSubMarker();
  buildBiteMarker();
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
function buildAnchorMarks() {
  for (const k of Object.keys(anchorMarks)) { const m = anchorMarks[k]; if (m && m.parent) m.parent.remove(m); delete anchorMarks[k]; }
  if (!vrm || !runner) return;
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  if (!head) return;
  for (const [key, color] of [['mouth', 0xff4d7a], ['inspect', 0x55ccee]]) {
    const a = runner.anchors[key];
    if (!a) continue;
    const g = new THREE.Group();
    const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
    const dir = new THREE.Mesh(new THREE.ConeGeometry(0.007, 0.028, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }));
    dir.rotation.x = Math.PI / 2; dir.position.z = 0.024;   // +Z=かぶりつき面が向く方向
    s1.renderOrder = dir.renderOrder = 12;
    g.add(s1, dir);
    g.position.fromArray(a.pos || [0, 0, 0]);
    const r = a.rotDeg || [0, 0, 0];
    g.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
    head.add(g);
    anchorMarks[key] = g;
  }
}
function buildBiteMarker() {
  if (biteMarker && biteMarker.parent) biteMarker.parent.remove(biteMarker);
  biteMarker = null;
  if (!def.bite || !toolObj) return;
  biteMarker = new THREE.Group();
  const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff9030, depthTest: false, transparent: true, opacity: 0.95 }));
  const dir = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.03, 8),
    new THREE.MeshBasicMaterial({ color: 0xffcc66, depthTest: false }));
  dir.rotation.x = Math.PI / 2; dir.position.z = 0.026;   // +Z=かぶりつき法線（口へ向く面）
  s1.renderOrder = dir.renderOrder = 11;
  biteMarker.add(s1, dir);
  biteMarker.position.fromArray(def.bite.pos || [0, 0, 0]);
  const r = def.bite.rotDeg || [0, 0, 0];
  biteMarker.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
  toolObj.add(biteMarker);
}
function setGizmoTarget(t) {
  gizmoTarget = t;
  $('g-tool').className = t === 'tool' ? 'on' : '';
  $('g-sub').className = t === 'sub' ? 'on' : '';
  $('g-bite').className = t === 'bite' ? 'on' : '';
  $('g-amouth').className = t === 'amouth' ? 'on' : '';
  $('g-ainspect').className = t === 'ainspect' ? 'on' : '';
  if (t === 'tool' && toolObj) gizmo.attach(toolObj);
  else if (t === 'sub' && subMarker) gizmo.attach(subMarker);
  else if (t === 'bite' && biteMarker) gizmo.attach(biteMarker);
  else if (t === 'amouth' && anchorMarks.mouth) gizmo.attach(anchorMarks.mouth);
  else if (t === 'ainspect' && anchorMarks.inspect) gizmo.attach(anchorMarks.inspect);
  else gizmo.detach();
}
function writeBack() {   // ギズモ操作 → def へ
  if (gizmoTarget === 'tool' && toolObj) {
    def.main.pos = toolObj.position.toArray().map((n) => +n.toFixed(4));
    def.main.rotDeg = [toolObj.rotation.x, toolObj.rotation.y, toolObj.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
  } else if (gizmoTarget === 'sub' && subMarker && def.sub) {
    def.sub.pos = subMarker.position.toArray().map((n) => +n.toFixed(4));
    def.sub.rotDeg = [subMarker.rotation.x, subMarker.rotation.y, subMarker.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
  } else if (gizmoTarget === 'bite' && biteMarker && def.bite) {
    def.bite.pos = biteMarker.position.toArray().map((n) => +n.toFixed(4));
    def.bite.rotDeg = [biteMarker.rotation.x, biteMarker.rotation.y, biteMarker.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
  } else if ((gizmoTarget === 'amouth' || gizmoTarget === 'ainspect') && runner) {
    const key = gizmoTarget === 'amouth' ? 'mouth' : 'inspect';
    const mk = anchorMarks[key];
    if (mk && runner.anchors[key]) {
      runner.anchors[key].pos = mk.position.toArray().map((n) => +n.toFixed(4));
      runner.anchors[key].rotDeg = [mk.rotation.x, mk.rotation.y, mk.rotation.z].map((n) => +(n * 180 / Math.PI).toFixed(1));
    }
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
    $('cb-bite').checked = !!def.bite;
    $('tool-grip').value = def.grip ?? 0.8;
    $('tool-grip-v').textContent = (def.grip ?? 0.8).toFixed(2);
    if (def.ref?.proc) { $('tool-src').value = 'proc:' + def.ref.proc; $('glb-name').value = ''; }
    else if (def.ref?.file) $('glb-name').value = def.ref.file;
    await loadToolObj();
    pvToUI();
    setStatus('読込: ' + name + '.tool.json');
  } catch (e) { setStatus('読込失敗: ' + e.message); }
}

// ── アクション確認: 台に物を置き、IKで拾う/眺める/食べる ──
const PV_KEYS = ['durReach', 'durBring', 'durOut', 'biteCycle'];
function ensureVerbs() {
  def.verbs = def.verbs || {};
  def.verbs.common = def.verbs.common || {};
  def.verbs.eat = def.verbs.eat || {};
  return def.verbs;
}
function pvToUI() {   // 実効値（既定＋上書き）をUIへ
  if (!runner) return;
  const eff = runner.prm ? runner.prm() : {};
  for (const k of PV_KEYS) { const el = $('pv-' + k); if (el) el.value = eff[k] ?? ''; }
  $('pv-bites').value = def.verbs?.eat?.bites ?? 3;
  const eh = eff.elbow || [0, -1, 0.35];
  $('pv-el0').value = eh[0]; $('pv-el1').value = eh[1]; $('pv-el2').value = eh[2];
}
function uiToPv() {   // UI → def.verbs（保存対象）
  const v = ensureVerbs();
  for (const k of PV_KEYS) { const el = $('pv-' + k); if (el && el.value !== '') v.common[k] = +el.value; }
  v.eat.bites = Math.max(1, Math.round(+$('pv-bites').value || 3));
  v.common.elbow = [+$('pv-el0').value || 0, +$('pv-el1').value || 0, +$('pv-el2').value || 0];
}
function tableH() { return +$('act-h').value; }
function updateTable() {
  $('act-h-v').textContent = tableH().toFixed(2) + 'm';
  if (tableMesh) { scene.remove(tableMesh); tableMesh = null; }
  const h = tableH();
  if (h > 0.03) {
    tableMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, h, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x6b5636, roughness: 0.8 }));
    tableMesh.position.set(0.18, h / 2, 0.52);
    scene.add(tableMesh);
  }
}
function placeObjectOnTable() {
  if (!toolObj) return;
  if (held) { held.release(); held = null; }
  toolObj.rotation.set(0, 0, 0);
  toolObj.scale.setScalar(def.scale || 1);
  toolObj.visible = true;
  scene.add(toolObj);
  toolObj.position.set(0, 0, 0);
  toolObj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(toolObj);
  toolObj.position.set(0.18, tableH() - box.min.y + 0.005, 0.52);
  toolObj.updateMatrixWorld(true);
}
function startAction(verb) {
  if (!runner || !toolObj) return;
  runner.stop();
  runner.paused = false;
  $('act-pause').textContent = '⏸';
  uiToPv();
  placeObjectOnTable();
  lastPlay = { verbRaw: verb, object: toolObj, def,
    preTick: () => { if (!mixer) vrm.humanoid.resetNormalizedPose(); },
    onDone: () => setStatus('アクション完了: ' + verb + '（スライダーでスクラブ可）') };
  runner.play(verb, lastPlay);
  scrubDur = runner.totalDur ? runner.totalDur() : 4;
  setStatus('アクション: ' + verb);
}
let demoOn = false;
function demoCycle() {
  if (!demoOn || !runner || !toolObj) return;
  placeObjectOnTable();
  runner.play('eatReturn', { object: toolObj, def, bites: 2, onDone: () => {
    if (demoOn) setTimeout(demoCycle, 700);   // 一息おいてもう一巡
  } });
}
function toggleDemo() {
  demoOn = !demoOn;
  $('act-demo').className = demoOn ? 'on' : '';
  if (demoOn) { setStatus('一連デモ: 取る→食べる→置く（もう一度押すと停止）'); demoCycle(); }
  else { if (runner) runner.stop(); setStatus('デモ停止'); }
}
function resetAction() {
  demoOn = false; $('act-demo').className = '';
  if (runner) runner.stop();
  if (toolObj) { toolObj.visible = true; toolObj.scale.setScalar(def.scale || 1); }
  attachNow();
  setStatus('通常表示に戻しました');
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
  $('tool-grip').addEventListener('input', () => {
    def.grip = +$('tool-grip').value;
    $('tool-grip-v').textContent = def.grip.toFixed(2);
    if (held) applyGrip(vrm, (def.main.bone || 'rightHand').startsWith('left') ? 'left' : 'right', def.grip);
  });
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

  // NPC一覧
  try {
    const vlist = await (await fetch('../vrm/manifest.json')).json();
    for (const f of vlist) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.vrm$/i, ''); $('npc-sel').appendChild(o); }
    $('npc-sel').value = 'soldier.vrm';
  } catch { const o = document.createElement('option'); o.value = 'soldier.vrm'; o.textContent = 'soldier'; $('npc-sel').appendChild(o); }
  $('npc-sel').addEventListener('change', async () => {
    demoOn = false; $('act-demo').className = '';
    if (runner) runner.stop();
    setStatus('VRM読込中…');
    await loadVrm($('npc-sel').value);
    setStatus('キャラ切替: ' + npcName);
  });
  await loadVrm('soldier.vrm');
  $('g-amouth').addEventListener('click', () => setGizmoTarget('amouth'));
  $('g-ainspect').addEventListener('click', () => setGizmoTarget('ainspect'));
  $('btn-mouth-save').addEventListener('click', async () => {
    const body = { dir: 'bitealign', filename: npcName + '.mouth.json',
      content: JSON.stringify({ mouth: runner.anchors.mouth, inspect: runner.anchors.inspect }, null, 1) };
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    setStatus(r && r.ok ? 'アンカー保存: bitealign/' + npcName + '.mouth.json' : 'アンカー保存失敗');
  });
  $('cb-bite').addEventListener('change', () => {
    if ($('cb-bite').checked) def.bite = def.bite || { pos: [0, 0.01, -0.05], rotDeg: [0, 180, 0] };
    else def.bite = null;
    buildBiteMarker();
    setGizmoTarget(def.bite ? 'bite' : 'tool');
  });
  $('g-bite').addEventListener('click', () => setGizmoTarget('bite'));
  $('act-h').addEventListener('input', updateTable);
  updateTable();
  $('act-pickup').addEventListener('click', () => startAction('pickup'));
  $('act-inspect').addEventListener('click', () => startAction('inspect'));
  $('act-eat').addEventListener('click', () => startAction('eat'));
  $('act-reset').addEventListener('click', resetAction);
  $('act-demo').addEventListener('click', toggleDemo);
  $('act-pause').addEventListener('click', () => {
    if (!runner) return;
    runner.paused = !runner.paused;
    $('act-pause').textContent = runner.paused ? '▶' : '⏸';
  });
  $('act-scrub').addEventListener('input', () => {
    if (!runner || !lastPlay) return;
    demoOn = false; $('act-demo').className = '';
    placeObjectOnTable();
    runner.seek((+$('act-scrub').value) * scrubDur, lastPlay);
    $('act-pause').textContent = '▶';
  });
  for (const id of ['pv-durReach', 'pv-durBring', 'pv-durOut', 'pv-inspectDist', 'pv-bites', 'pv-biteCycle', 'pv-el0', 'pv-el1', 'pv-el2']) {
    $(id)?.addEventListener('change', () => { uiToPv(); setStatus('アクション調整を反映（保存で .tool.json へ）'); });
  }
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
      // アニメ未再生時は毎フレーム基準ポーズへ戻す（IKの積算防止＝mixerのリセットと同じ役割）
      if (runner && runner.active && !mixer) vrm.humanoid.resetNormalizedPose();   // pause中も毎フレーム基準へ戻してから dt=0 のIKを適用（積算防止）
      if (runner && runner.active) runner.update(dt);
      else {
        applySubIK();
        if (held) applyGrip(vrm, (def.main.bone || 'rightHand').startsWith('left') ? 'left' : 'right', def.grip ?? 0.8);
      }
      // 肘ヒントの黄矢印（肩から）
      if (runner && runner.active) {
        if (!elbowArrow) {
          elbowArrow = new THREE.ArrowHelper(new THREE.Vector3(0, -1, 0), new THREE.Vector3(), 0.3, 0xffe060, 0.07, 0.045);
          elbowArrow.line.material.depthTest = false; elbowArrow.cone.material.depthTest = false;
          elbowArrow.renderOrder = 12;
          scene.add(elbowArrow);
        }
        const side = (def.main?.bone || 'rightHand').startsWith('left') ? 'left' : 'right';
        const sh = vrm.humanoid.getNormalizedBoneNode(side + 'UpperArm');
        if (sh) {
          sh.getWorldPosition(elbowArrow.position);
          const eh = runner.prm().elbow;
          const sgn = side === 'left' ? -1 : 1;
          _elDir.set(sgn * eh[0], eh[1], eh[2]).normalize();   // 体の向きは概ね+Z想定の簡易表示
          elbowArrow.setDirection(_elDir);
        }
        elbowArrow.visible = true;
        $('act-phase').textContent = runner.phase || '-';
        if (!runner.paused && lastPlay) {
          // 再生中はスクラブつまみを進行に同期（概算）
          const cur = +$('act-scrub').value;
          $('act-scrub').value = Math.min(1, cur + dt / scrubDur);
        }
      } else if (elbowArrow) { elbowArrow.visible = false; $('act-phase').textContent = '-'; }
      vrm.update(dt);
    }
    renderer.render(scene, camera);
  });
  setStatus('道具をギズモで手に合わせ→（添え手ON→球を移動）→保存。ポーズ確認で構え姿勢に');
  window.__toolDbg = { get vrm() { return vrm; }, get def() { return def; }, get toolObj() { return toolObj; }, get held() { return held; }, get runner() { return runner; }, camera, orbit, attachNow, buildSubMarker, startAction, THREE };
}
init().catch((e) => { setStatus('初期化失敗: ' + e.message); console.error(e); });
