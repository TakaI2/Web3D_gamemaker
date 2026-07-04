// ragdoll-editor.js — ラグドール調整エディタ（WebGPU）。
// 対象NPCを選び、崩す/戻す・グラブ点固定・関節と骨の可視化・関節ごとの回転制限(maxBend)を即時調整し、
// ragdoll.json として保存する。lib/vrm-ragdoll.js を再利用。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import {
  createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery,
  setBoneMaxBend, listBoneLimits, disposeRagdoll, applyRagdollImpulse,
} from '../lib/vrm-ragdoll.js';

// ── 状態 ───────────────────────────────────────────────
let renderer, scene, camera, controls;
let vrm = null, mixer = null, action = null, ragdoll = null;
let currentId = 'custom';
const clock = new THREE.Clock();

// 可視化
let vizGroup = null, jointMeshes = [], boneLines = null;
let vizOn = true;
const jointMat = new THREE.MeshBasicMaterial({ color: 0x44ddff, depthTest: false });
const pinMat   = new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false });
const jointGeo = new THREE.SphereGeometry(0.03, 8, 6);

// 回転制限コーンの可視化（選択中の関節1つ）
let limitViz = null;       // LineSegments（コーンのワイヤ）
let limitBone = null;      // 表示対象の関節名（スライダー選択で切替）
const LIMIT_RIM = 28;      // コーン外周の分割数
const _axis = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3(), _tip = new THREE.Vector3();

// ピン
const pins = new Set();
const pinPos = {};      // bone -> THREE.Vector3（ピンの目標位置＝真の状態）
const pinHandles = {};  // bone -> THREE.Mesh（移動ギズモで掴むハンドル）
let gizmo = null;       // TransformControls
const handleGeo = new THREE.SphereGeometry(0.05, 10, 8);
const handleMat = new THREE.MeshBasicMaterial({ color: 0xff8833, depthTest: false });
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const PIN_CANDIDATES = ['head', 'hips', 'chest', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot',
  'leftLowerArm', 'rightLowerArm', 'leftLowerLeg', 'rightLowerLeg'];

// 設定（保存対象）
let cfg = { boneMaxBend: {}, params: { gravity: -22, stiffness: 1.0, iterations: 8, foldLimit: 0.6, drag: 0.015, limitDamp: 0.4, selfCollision: true, bodyScale: 1.0, rigidBones: ['leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg'] } };

const status = (msg) => { const el = document.getElementById('status'); if (el) el.textContent = msg; };
const showError = (m) => { document.getElementById('error-detail').textContent = String(m); document.getElementById('error-msg').classList.add('visible'); };

// ── NPC バンドル読込 ───────────────────────────────────
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function fetchBundle(filename) {
  const cands = [];
  try { const b = import.meta.env && import.meta.env.BASE_URL; if (b) cands.push(b + 'npc/' + filename); } catch { /* noop */ }
  cands.push(new URL('./npc/' + filename, import.meta.url).href);
  cands.push(new URL('../npc/' + filename, import.meta.url).href);
  for (const url of cands) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 次へ */ } }
  return null;
}

async function loadVrmFromBlobUrl(url, vrmaUrl) {
  // 既存を破棄
  teardownModel();
  const loader = new GLTFLoader();
  // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
  loader.register((p) => new VRMLoaderPlugin(p, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
  }));
  const gltf = await loader.loadAsync(url);
  vrm = gltf.userData.vrm;
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);

  // VRMA（アイドル）
  mixer = null; action = null;
  if (vrmaUrl) {
    try {
      const al = new GLTFLoader();
      al.register((p) => new VRMAnimationLoaderPlugin(p));
      const ag = await al.loadAsync(vrmaUrl);
      const anims = ag.userData.vrmAnimations;
      if (anims && anims.length) {
        const clip = createVRMAnimationClip(anims[0], vrm);
        mixer = new THREE.AnimationMixer(vrm.scene);
        action = mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
        mixer.update(0);
      }
    } catch (e) { console.warn('VRMA 読込失敗', e); }
  }
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);

  setupRagdoll();
  status(`読込: ${currentId}`);
}

async function loadBundle(b) {
  if (!b || !b.vrm) { status('VRM が見つかりません'); return; }
  const vrmUrl = URL.createObjectURL(dataURIToBlob(b.vrm));
  const vrmaUrl = b.vrma ? URL.createObjectURL(dataURIToBlob(b.vrma)) : null;
  await loadVrmFromBlobUrl(vrmUrl, vrmaUrl);
}

function teardownModel() {
  if (ragdoll) { disposeRagdoll(ragdoll); ragdoll = null; }
  if (vrm) { scene.remove(vrm.scene); vrm = null; }
  mixer = null; action = null;
  pins.clear();
  if (vizGroup) { scene.remove(vizGroup); vizGroup = null; jointMeshes = []; boneLines = null; }
  clearPinHandles();
}

// ── ラグドール構築 ─────────────────────────────────────
function setupRagdoll() {
  ragdoll = createRagdoll(vrm, { ...cfg.params, boneMaxBend: cfg.boneMaxBend });
  ragdoll.active = false;
  buildLimitUI();
  buildParamUI();
  buildPinUI();
  buildViz();
  const btn = document.getElementById('btn-ragdoll');
  btn.textContent = '崩す（ラグドール ON）'; btn.classList.remove('on');
}

function toggleRagdoll() {
  if (!ragdoll) return;
  const btn = document.getElementById('btn-ragdoll');
  if (!ragdoll.active && !ragdoll.recovering) {
    vrm.scene.updateMatrixWorld(true);
    setRagdollActive(ragdoll, true);
    btn.textContent = '戻す（ラグドール OFF）'; btn.classList.add('on');
  } else {
    setRagdollActive(ragdoll, false);   // 復帰ブレンド開始
    btn.textContent = '崩す（ラグドール ON）'; btn.classList.remove('on');
  }
}

// 剛体ボーン（ラグドール化しない）の選択を反映してラグドールを作り直す
function rebuildRigid() {
  const r = [];
  if (document.getElementById('chk-rigid-shoulder').checked) r.push('leftShoulder', 'rightShoulder');
  if (document.getElementById('chk-rigid-legroot').checked) r.push('leftUpperLeg', 'rightUpperLeg');
  cfg.params.rigidBones = r;
  if (!vrm) return;
  const wasActive = ragdoll && ragdoll.active;
  setupRagdoll();
  if (wasActive) {
    vrm.scene.updateMatrixWorld(true);
    setRagdollActive(ragdoll, true);
    const btn = document.getElementById('btn-ragdoll');
    btn.textContent = '戻す（ラグドール OFF）'; btn.classList.add('on');
  }
}

function reDrop() {
  if (!ragdoll) return;
  // 即時リセット（ブレンドなし）：アイドル/レスト姿勢へ戻してから再スナップ落下
  ragdoll.active = false; ragdoll.recovering = false;
  if (mixer) { mixer.setTime(0); } else { for (const d of ragdoll.bones) { d.node.quaternion.copy(d.restLocalQuat); if (d.bone === 'hips') d.node.position.copy(d.restLocalPos); } }
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);
  setRagdollActive(ragdoll, true);
  // ピン位置とハンドルを取り直す
  for (const b of pins) { ensurePinPos(b); if (pinHandles[b]) pinHandles[b].position.copy(pinPos[b]); }
  const btn = document.getElementById('btn-ragdoll');
  btn.textContent = '戻す（ラグドール OFF）'; btn.classList.add('on');
}

// 被弾反応の確認用：ラグドールが非アクティブなら起こしてから、ランダムな部位へ水平インパルス。
const IMPULSE_BONES = ['chest', 'hips', 'head', 'leftHand', 'rightHand', 'leftUpperArm', 'rightUpperArm'];
function kickImpulse() {
  if (!ragdoll || !vrm) return;
  if (!ragdoll.active) {
    vrm.scene.updateMatrixWorld(true);
    setRagdollActive(ragdoll, true);
    const btn = document.getElementById('btn-ragdoll');
    btn.textContent = '戻す（ラグドール OFF）'; btn.classList.add('on');
  }
  const ang = Math.random() * Math.PI * 2;
  const dir = new THREE.Vector3(Math.cos(ang), 0.25, Math.sin(ang)).normalize().multiplyScalar(0.22);
  const bone = IMPULSE_BONES[Math.floor(Math.random() * IMPULSE_BONES.length)];
  applyRagdollImpulse(ragdoll, dir, ragdoll.idxOf[bone] != null ? bone : 'chest');
  status(`インパルス → ${bone}`);
}

// ── 可視化 ─────────────────────────────────────────────
function buildViz() {
  vizGroup = new THREE.Group();
  vizGroup.renderOrder = 999;
  jointMeshes = ragdoll.particles.map(() => {
    const m = new THREE.Mesh(jointGeo, jointMat);
    m.renderOrder = 1000; m.frustumCulled = false;
    vizGroup.add(m);
    return m;
  });
  const segPos = new Float32Array(ragdoll.constraints.length * 2 * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(segPos, 3).setUsage(THREE.DynamicDrawUsage));
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthTest: false });
  boneLines = new THREE.LineSegments(g, lineMat);
  boneLines.renderOrder = 1000; boneLines.frustumCulled = false;
  vizGroup.add(boneLines);

  // 回転制限コーン（選択関節のみ。外周リム＋母線をワイヤで描く）
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(256 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const limMat = new THREE.LineBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.85, depthTest: false });
  limitViz = new THREE.LineSegments(lg, limMat);
  limitViz.renderOrder = 1002; limitViz.frustumCulled = false; limitViz.visible = false;
  vizGroup.add(limitViz);
  limitBone = null;

  scene.add(vizGroup);
}

// 選択中の関節の回転制限コーンを線で描く。
// 軸 = 親骨の延長方向(B-A)、半角 hi = restAngle + maxBend。子骨の向きはこのコーン内に制限される
// （方位角＝コーン周りの回転は自由なので、横方向にも曲がるのが分かる）。
function updateLimitViz() {
  if (!limitViz) return;
  const show = vizOn && ragdoll && ragdoll.active && limitBone;
  limitViz.visible = !!show;
  if (!show) return;
  const L = ragdoll.angleLimits.find((x) => x.bone === limitBone);
  if (!L) { limitViz.visible = false; return; }
  const A = ragdoll.particles[L.a].pos, B = ragdoll.particles[L.b].pos, C = ragdoll.particles[L.c].pos;
  _axis.copy(B).sub(A);
  if (_axis.lengthSq() < 1e-9) { limitViz.visible = false; return; }
  _axis.normalize();
  const len = Math.max(0.05, B.distanceTo(C));
  let hi = L.restAngle + L.maxBend;
  hi = Math.min(Math.PI, Math.max(0.02, hi));
  // 軸に直交する基底 u, v
  _u.set(1, 0, 0); if (Math.abs(_axis.x) > 0.9) _u.set(0, 1, 0);
  _u.crossVectors(_axis, _u).normalize();
  _v.crossVectors(_axis, _u).normalize();
  const cosh = Math.cos(hi) * len, sinh = Math.sin(hi) * len;
  const pos = limitViz.geometry.getAttribute('position');
  const arr = pos.array;
  const tips = [];
  for (let i = 0; i < LIMIT_RIM; i++) {
    const ph = (i / LIMIT_RIM) * Math.PI * 2;
    _tip.copy(_axis).multiplyScalar(cosh)
      .addScaledVector(_u, Math.cos(ph) * sinh)
      .addScaledVector(_v, Math.sin(ph) * sinh).add(B);
    tips.push(_tip.clone());
  }
  let k = 0;
  const put = (p) => { arr[k++] = p.x; arr[k++] = p.y; arr[k++] = p.z; };
  for (let i = 0; i < LIMIT_RIM; i++) { put(tips[i]); put(tips[(i + 1) % LIMIT_RIM]); }   // 外周リム
  const step = Math.max(1, Math.floor(LIMIT_RIM / 8));
  for (let i = 0; i < LIMIT_RIM; i += step) { put(B); put(tips[i]); }                       // 母線
  limitViz.geometry.setDrawRange(0, k / 3);
  pos.needsUpdate = true;
}

function updateViz() {
  if (!vizGroup) return;
  const show = vizOn && ragdoll && ragdoll.active;
  vizGroup.visible = show;
  if (!show) return;
  const ps = ragdoll.particles;
  for (let i = 0; i < ps.length; i++) {
    jointMeshes[i].position.copy(ps[i].pos);
    jointMeshes[i].material = pins.has(ps[i].bone) ? pinMat : jointMat;
  }
  const pos = boneLines.geometry.getAttribute('position');
  let k = 0;
  for (const c of ragdoll.constraints) {
    const a = ps[c.i].pos, b = ps[c.j].pos;
    pos.array[k++] = a.x; pos.array[k++] = a.y; pos.array[k++] = a.z;
    pos.array[k++] = b.x; pos.array[k++] = b.y; pos.array[k++] = b.z;
  }
  pos.needsUpdate = true;
}

// ── ピン UI ────────────────────────────────────────────
function ensurePinPos(bone) {
  const idx = ragdoll.idxOf[bone];
  if (idx == null) return;
  if (!pinPos[bone]) pinPos[bone] = new THREE.Vector3();
  pinPos[bone].copy(ragdoll.particles[idx].pos);
}

// ピンの移動ハンドル（移動ギズモで掴む）を生成し、ギズモをアタッチ
function addPinHandle(bone) {
  let h = pinHandles[bone];
  if (!h) {
    h = new THREE.Mesh(handleGeo, handleMat);
    h.renderOrder = 1001; h.frustumCulled = false;
    h.userData.pinBone = bone;
    pinHandles[bone] = h; scene.add(h);
  }
  h.position.copy(pinPos[bone]);
  if (gizmo) gizmo.attach(h);
}

function removePinHandle(bone) {
  const h = pinHandles[bone];
  if (!h) return;
  if (gizmo && gizmo.object === h) gizmo.detach();
  scene.remove(h);
  delete pinHandles[bone];
}

function clearPinHandles() {
  if (gizmo) gizmo.detach();
  for (const b of Object.keys(pinHandles)) { scene.remove(pinHandles[b]); delete pinHandles[b]; }
}

// キャンバスのクリックでハンドルを選択 → ギズモを付け替え
function pickHandle(ev) {
  if (!gizmo || gizmo.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(Object.values(pinHandles), false);
  if (hits.length) gizmo.attach(hits[0].object);
}

function buildPinUI() {
  const host = document.getElementById('pin-list');
  host.innerHTML = '';
  for (const bone of PIN_CANDIDATES) {
    if (ragdoll.idxOf[bone] == null) continue;
    const row = document.createElement('div');
    row.className = 'pin-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `pin-${bone}`;
    cb.onchange = () => {
      if (cb.checked) { ensurePinPos(bone); pins.add(bone); addPinHandle(bone); }
      else { pins.delete(bone); removePinHandle(bone); }
    };
    const lab = document.createElement('label');
    lab.htmlFor = cb.id; lab.textContent = bone;
    row.append(cb, lab);
    host.appendChild(row);
  }
}

// ── 関節制限 UI ────────────────────────────────────────
function buildLimitUI() {
  const host = document.getElementById('limits');
  host.innerHTML = '';
  for (const { bone, deg } of listBoneLimits(ragdoll)) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label'); lab.textContent = bone;
    const range = document.createElement('input');
    range.type = 'range'; range.min = '5'; range.max = '180'; range.step = '1'; range.value = String(Math.round(deg));
    const val = document.createElement('span'); val.className = 'val'; val.textContent = `${Math.round(deg)}°`;
    const select = () => { limitBone = bone; };
    range.onfocus = select;
    range.onpointerdown = select;
    lab.onclick = select;
    range.oninput = () => {
      const d = Number(range.value);
      val.textContent = `${d}°`;
      cfg.boneMaxBend[bone] = d;
      setBoneMaxBend(ragdoll, bone, d);
      limitBone = bone;
    };
    lab.style.cursor = 'pointer';
    row.append(lab, range, val);
    host.appendChild(row);
  }
}

function resetLimits() {
  cfg.boneMaxBend = {};
  // 既定値で作り直し（角度制限を既定へ戻す）。姿勢は維持されないので落とし直し前提。
  const wasActive = ragdoll.active;
  setupRagdoll();
  if (wasActive) reDrop();
  status('回転制限を既定値にリセット');
}

// ── 全体パラメータ UI（rd.opts を即時編集） ─────────────
function buildParamUI() {
  const host = document.getElementById('params');
  host.innerHTML = '';
  const sc = document.getElementById('chk-selfcol'); if (sc) sc.checked = !!ragdoll.opts.selfCollision;
  const defs = [
    { key: 'gravity', label: '重力', min: -40, max: 0, step: 1 },
    { key: 'stiffness', label: '硬さ', min: 0, max: 1, step: 0.05 },
    { key: 'iterations', label: '反復', min: 1, max: 16, step: 1 },
    { key: 'foldLimit', label: '折れ抑制', min: 0.2, max: 1, step: 0.02 },
    { key: 'drag', label: '空気抵抗', min: 0, max: 0.2, step: 0.005 },
    { key: 'limitDamp', label: '制限減衰', min: 0, max: 1, step: 0.05 },
    { key: 'bodyScale', label: '体の太さ', min: 0.5, max: 1.6, step: 0.05 },
  ];
  for (const d of defs) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('label'); lab.textContent = d.label;
    const range = document.createElement('input');
    range.type = 'range'; range.min = String(d.min); range.max = String(d.max); range.step = String(d.step);
    range.value = String(ragdoll.opts[d.key]);
    const val = document.createElement('span'); val.className = 'val'; val.textContent = String(ragdoll.opts[d.key]);
    range.oninput = () => {
      const v = Number(range.value);
      val.textContent = d.step < 1 ? v.toFixed(2) : String(v);
      ragdoll.opts[d.key] = v;       // 走行中に即反映（updateRagdoll が rd.opts を毎回参照）
      cfg.params[d.key] = v;
    };
    row.append(lab, range, val);
    host.appendChild(row);
  }
}

// ── 保存 / 読込 ────────────────────────────────────────
async function saveConfig() {
  const filename = `${currentId}.ragdoll.json`;
  const content = { version: 1, id: currentId, boneMaxBend: cfg.boneMaxBend, params: cfg.params };
  try {
    const r = await fetch('../api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'ragdoll', filename, content }),
    });
    const j = await r.json();
    status(j.ok ? `保存: ${j.path}` : '保存失敗');
    populateRagdollSelect(filename);
  } catch (e) { status('保存失敗: ' + e); }
}

async function loadConfigFile(filename) {
  try {
    const r = await fetch('../ragdoll/' + filename);
    if (!r.ok) { status('読込失敗'); return; }
    const j = await r.json();
    cfg = { boneMaxBend: j.boneMaxBend || {}, params: { ...cfg.params, ...(j.params || {}) } };
    if (vrm) { const wasActive = ragdoll && ragdoll.active; setupRagdoll(); if (wasActive) reDrop(); }
    status(`読込: ${filename}`);
  } catch (e) { status('読込失敗: ' + e); }
}

async function populateNpcSelect() {
  const sel = document.getElementById('npc-select');
  let files = [];
  try { const r = await fetch('../npc/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  for (const f of files) {
    const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.npc\.json$/, '');
    sel.appendChild(o);
  }
  sel.onchange = async () => {
    if (!sel.value) return;
    currentId = sel.value.replace(/\.npc\.json$/, '');
    status('読込中...');
    const b = await fetchBundle(sel.value);
    await loadBundle(b);
  };
}

async function populateRagdollSelect(selectName) {
  const sel = document.getElementById('ragdoll-select');
  let files = [];
  try { const r = await fetch('../ragdoll/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  sel.innerHTML = '<option value="">-- 保存済みを読込 --</option>';
  for (const f of files) {
    const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.ragdoll\.json$/, '');
    if (f === selectName) o.selected = true;
    sel.appendChild(o);
  }
}

// ── レンダリング ───────────────────────────────────────
let fpsFrames = 0, fpsLast = performance.now();
function updateFps() {
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 500) {
    const fps = Math.round(fpsFrames / ((now - fpsLast) / 1000));
    fpsFrames = 0; fpsLast = now;
    const el = document.getElementById('fps-counter'); if (el) el.textContent = `${fps} FPS`;
  }
}

function render() {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  if (vrm) {
    if (ragdoll && ragdoll.active) {
      // ハンドル（ギズモで動かす）位置を真のピン位置へ反映
      for (const b of pins) { const h = pinHandles[b]; if (h && pinPos[b]) pinPos[b].copy(h.position); }
      const env = { floorY: 0 };
      if (pins.size) env.pins = [...pins].map((b) => ({ bone: b, pos: pinPos[b] })).filter((p) => p.pos);
      updateRagdoll(ragdoll, dt, env);
    } else {
      if (mixer) mixer.update(dt);                       // アニメ姿勢を書く
      if (ragdoll && ragdoll.recovering) updateRagdollRecovery(ragdoll, dt);   // freeze→アニメへ補間
    }
    vrm.update(dt);
  }
  updateViz();
  updateLimitViz();
  controls.update();
  updateFps();
  renderer.render(scene, camera);
}

// ── 初期化 ─────────────────────────────────────────────
async function init() {
  const app = document.getElementById('app');
  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  app.appendChild(renderer.domElement);
  await renderer.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10121c);
  camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, 1.1, 3.4);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.95, 0);
  controls.enableDamping = true;

  // 移動ギズモ（ピンを掴んで動かす）。ドラッグ中は OrbitControls を止める。
  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.setSize(0.7);
  gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);
  renderer.domElement.addEventListener('pointerdown', pickHandle);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xfff6e6, 1.6); key.position.set(3, 6, 4); scene.add(key);
  scene.add(new THREE.GridHelper(10, 20, 0x445588, 0x223344));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // UI 配線
  document.getElementById('btn-ragdoll').onclick = toggleRagdoll;
  document.getElementById('btn-redrop').onclick = reDrop;
  document.getElementById('btn-impulse').onclick = kickImpulse;
  document.getElementById('chk-rigid-shoulder').onchange = rebuildRigid;
  document.getElementById('chk-rigid-legroot').onchange = rebuildRigid;
  document.getElementById('chk-viz').onchange = (e) => { vizOn = e.target.checked; };
  document.getElementById('chk-selfcol').onchange = (e) => {
    cfg.params.selfCollision = e.target.checked;
    if (ragdoll) ragdoll.opts.selfCollision = e.target.checked;
  };
  document.getElementById('btn-reset-limits').onclick = () => { if (ragdoll) resetLimits(); };
  document.getElementById('btn-save').onclick = saveConfig;
  document.getElementById('btn-load').onclick = () => {
    const sel = document.getElementById('ragdoll-select');
    if (sel.value) loadConfigFile(sel.value);
  };
  document.getElementById('btn-vrm').onclick = () => document.getElementById('vrm-file').click();
  document.getElementById('vrm-file').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    currentId = f.name.replace(/\.vrm$/i, '');
    status('読込中...');
    await loadVrmFromBlobUrl(URL.createObjectURL(f), null);
    e.target.value = '';
  };

  await populateNpcSelect();
  await populateRagdollSelect();

  renderer.setAnimationLoop(render);
  status('NPC または VRM を読み込んでください');
}

init().catch((e) => { console.error(e); showError(e && e.message ? e.message : e); });
