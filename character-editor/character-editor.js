// character-editor.js — VRM NPC のステートに表情・視線・行動を設定し .npc.json(v2) を書き出すエディタ
// 設計: .tmp/character_editor_design.md（フェーズ4）
// プレビューは実ランタイム（vrm-ragdoll / vrm-cloth / npc-state-machine）でマント付き表示。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation?deps=three@0.184.0,@pixiv/three-vrm@3.4.0';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse }
  from '../lib/vrm-ragdoll.js';

const STATES = ['idle', 'alert', 'attack', 'downed', 'recovering'];
const STATE_LABEL = { idle: '通常 (idle)', alert: '警戒 (alert)', attack: '攻撃 (attack)', downed: 'ダウン (downed)', recovering: '復帰 (recovering)' };
const EXPR_PRESETS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const BEHAVIOR_FIELDS = [
  { key: 'aggressiveOnRecover', label: '復帰後に攻撃', type: 'bool' },
  { key: 'sightRange',  label: '検知距離', type: 'num', step: 0.5 },
  { key: 'loseRange',   label: '見失い距離', type: 'num', step: 0.5 },
  { key: 'detectChance', label: '検知確率/秒', type: 'num', step: 0.05 },
  { key: 'approachAccel', label: '接近加速', type: 'num', step: 0.5 },
  { key: 'recoverDelaySec', label: '崩れ時間(秒)', type: 'num', step: 0.5 },
];
const LOOK_DURATION = 1.5;
const HEAD_FWD = new THREE.Vector3(0, 0, 1);
const HEAD_MAX_ANGLE = Math.PI * 0.6;
const HEAD_LOOK_TAU = 0.6;
const NPC_FILES = ['megu.npc.json', 'lily.npc.json', 'ayu.npc.json'];

function defaultCharacter() {
  return {
    schemaVersion: 1,
    displayName: '',
    behavior: { aggressiveOnRecover: false, sightRange: 0, loseRange: 14, detectChance: 0.6, approachAccel: 5, recoverDelaySec: 2.5 },
    defaultState: 'idle',
    states: {
      idle:       { expression: {},                 lookAtEye: 1.0, lookAtHead: 0.35 },
      alert:      { expression: { surprised: 0.8 }, lookAtEye: 1.0, lookAtHead: 0.6 },
      attack:     { expression: { angry: 1.0 },     lookAtEye: 1.0, lookAtHead: 0.8 },
      downed:     { expression: { sad: 0.4 },       lookAtEye: 0.0, lookAtHead: 0.0 },
      recovering: { expression: {},                 lookAtEye: 1.0, lookAtHead: 0.3 },
    },
  };
}

// ── globals ───────────────────────────────────────────────
let renderer, scene, camera, controls;
let bundle = null;             // 読み込んだ .npc.json（書き出しのベース）
let vrm = null, mixer = null, action = null, cloth = null, ragdoll = null;
let characterDef = defaultCharacter();
let exprNames = [];            // この VRM が持つ表情プリセット名
let editorState = 'idle';      // プレビュー中の状態
let mode = 'preview';          // 'preview' | 'sim'
let simHeld = false;
let recoverTimer = 0;
let tlClock = 0, tlFps = 30, tlDuration = 0;
let headLookW = 0, blinkT = 2, blinkDur = 0;

const timer = new THREE.Timer();
timer.connect(document);

// 再利用 temp
const _hPos = new THREE.Vector3(), _hDir = new THREE.Vector3(), _hFwd = new THREE.Vector3();
const _hqCur = new THREE.Quaternion(), _hqPar = new THREE.Quaternion(), _hqDelta = new THREE.Quaternion(), _hqDes = new THREE.Quaternion();
const _center = new THREE.Vector3();

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── バンドル取得 / 読込 ────────────────────────────────────
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
async function fetchBundle(filename) {
  const cands = [];
  try { const b = import.meta.env && import.meta.env.BASE_URL; if (b) cands.push(b + 'npc/' + filename); } catch { /* noop */ }
  cands.push(new URL('./npc/' + filename, import.meta.url).href);
  cands.push(new URL('../npc/' + filename, import.meta.url).href);
  for (const url of cands) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* next */ } }
  return null;
}

function disposeCurrent() {
  if (cloth) { cloth.dispose(); cloth = null; }
  if (vrm) { scene.remove(vrm.scene); vrm = null; }
  mixer = null; action = null; ragdoll = null;
}

async function loadBundleObject(b) {
  disposeCurrent();
  bundle = b;

  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(b.vrm)));
  vrm = gltf.userData.vrm;
  vrm.scene.position.set(0, 0, 0);
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });

  if (b.vrma) {
    const al = new GLTFLoader();
    al.register(p => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync(URL.createObjectURL(dataURIToBlob(b.vrma)));
    const anims = ag.userData.vrmAnimations;
    if (anims && anims.length) {
      const clip = createVRMAnimationClip(anims[0], vrm);
      mixer = new THREE.AnimationMixer(vrm.scene);
      action = mixer.clipAction(clip); action.setLoop(THREE.LoopRepeat, Infinity).play();
    }
  }
  tlFps = b.timeline?.fps ?? 30;
  tlDuration = b.timeline?.durationFrames ?? 0;

  ragdoll = createRagdoll(vrm, { gravity: -9, boundsMargin: 0.4 });

  if (b.cloth) {
    try { cloth = createVRMCloth({ renderer, scene, vrm, cloth: b.cloth, basePos: new THREE.Vector3(0, 0, 0), floorY: 0, timeline: b.timeline }); }
    catch (e) { console.warn('cloth 生成失敗', e); }
  }

  // character 定義（既存があれば取り込み、無ければ既定）
  characterDef = b.character ? mergeCharacter(b.character) : defaultCharacter();
  characterDef.displayName = characterDef.displayName || b.name || '';

  // この VRM が持つ表情名
  exprNames = EXPR_PRESETS.filter(n => hasExpression(n));

  controls.target.set(0, 1.0, 0);
  controls.update();
  selectState('idle');
  buildBehaviorPanel();
  toast(`${b.name || 'NPC'} を読み込みました`);
}

function mergeCharacter(c) {
  const d = defaultCharacter();
  const out = { schemaVersion: 1, displayName: c.displayName || '', behavior: Object.assign(d.behavior, c.behavior), defaultState: c.defaultState || 'idle', states: {} };
  for (const s of STATES) out.states[s] = Object.assign({}, d.states[s], c.states && c.states[s]);
  return out;
}

function hasExpression(name) {
  const em = vrm && vrm.expressionManager;
  if (!em) return false;
  try { return !!em.getExpression(name); } catch { return true; }
}

// ── 表情・視線の適用 ──────────────────────────────────────
function applyVisual(dir, dt) {
  const em = vrm.expressionManager;
  if (em) {
    for (const n of exprNames) em.setValue(n, (dir.expression && dir.expression[n]) ?? 0);
    if (blinkT <= 0 && blinkDur <= 0) { blinkDur = 0.12; blinkT = 2.5 + Math.random() * 3.5; }
    blinkT -= dt;
    let bw = 0;
    if (blinkDur > 0) { blinkDur -= dt; bw = Math.sin((1 - Math.max(0, blinkDur) / 0.12) * Math.PI); }
    em.setValue('blink', dir.state === 'downed' ? 0 : bw);
  }
  const targetHeadW = dir.lookAtHead || 0;
  headLookW += (targetHeadW - headLookW) * (1 - Math.exp(-dt / HEAD_LOOK_TAU));
  if (headLookW > 0.01) applyHeadLook(headLookW);
  if (vrm.lookAt) vrm.lookAt.target = dir.lookAtEye > 0.5 ? camera : null;
}

function applyHeadLook(weight) {
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  if (!head) return;
  head.updateWorldMatrix(true, false);
  head.getWorldPosition(_hPos);
  _hDir.copy(camera.position).sub(_hPos);
  if (_hDir.lengthSq() < 1e-8) return;
  _hDir.normalize();
  head.getWorldQuaternion(_hqCur);
  _hFwd.copy(HEAD_FWD).applyQuaternion(_hqCur).normalize();
  const ang = _hFwd.angleTo(_hDir);
  if (ang < 1e-4) return;
  let w = weight;
  if (ang > HEAD_MAX_ANGLE) w *= HEAD_MAX_ANGLE / ang;
  _hqDelta.setFromUnitVectors(_hFwd, _hDir);
  _hqDes.identity().slerp(_hqDelta, w).multiply(_hqCur);
  if (head.parent) { head.parent.getWorldQuaternion(_hqPar); head.quaternion.copy(_hqPar.invert().multiply(_hqDes)); }
  else head.quaternion.copy(_hqDes);
}

function clothFrame(dt) {
  if (action) return Math.floor(action.time * tlFps);
  if (tlDuration) { if (!ragdoll.active) tlClock += dt; return Math.floor(tlClock * tlFps) % tlDuration; }
  return null;
}

// ── プレビュー更新 ────────────────────────────────────────
function update(dt) {
  if (!vrm) return;

  if (mode === 'sim') {
    const env = { floorY: 0 };
    if (simHeld) { env.pinBone = 'chest'; env.pinPos = controls.target; }   // 掴み: 注視点へピン
    let dirState = 'idle';
    if (ragdoll.active) {
      dirState = 'downed';
      updateRagdoll(ragdoll, dt, env);
      if (!simHeld) { recoverTimer -= dt; if (recoverTimer <= 0) setRagdollActive(ragdoll, false); }
    } else if (ragdoll.recovering) {
      dirState = 'recovering';
      if (mixer) mixer.update(dt);
      updateRagdollRecovery(ragdoll, dt);
      if (!ragdoll.recovering) { mode = 'preview'; selectState('idle'); }
    } else {
      if (mixer) mixer.update(dt);
    }
    const st = characterDef.states[dirState];
    const dir = { state: dirState, expression: st.expression, lookAtEye: st.lookAtEye, lookAtHead: st.lookAtHead };
    if (dirState === 'downed' && !simHeld && recoverTimer <= LOOK_DURATION) { dir.lookAtEye = 1; dir.lookAtHead = 0.7; }
    applyVisual(dir, dt);
  } else {
    const st = characterDef.states[editorState];
    if (editorState === 'downed') {
      if (!ragdoll.active && !ragdoll.recovering) setRagdollActive(ragdoll, true);
      if (ragdoll.active) updateRagdoll(ragdoll, dt, { floorY: 0 });
    } else {
      if (ragdoll.active) setRagdollActive(ragdoll, false);
      if (ragdoll.recovering) updateRagdollRecovery(ragdoll, dt);
      else if (mixer) mixer.update(dt);
    }
    applyVisual({ state: editorState, expression: st.expression, lookAtEye: st.lookAtEye, lookAtHead: st.lookAtHead }, dt);
  }

  vrm.update(dt);
  if (cloth) cloth.update(dt, clothFrame(dt));
}

function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 30);
  controls.update();
  update(dt);
  renderer.render(scene, camera);
}

// ── UI ────────────────────────────────────────────────────
function selectState(name) {
  editorState = name;
  mode = 'preview';
  document.querySelectorAll('.state-btn').forEach(b => b.classList.toggle('active', b.dataset.state === name));
  document.getElementById('state-title').textContent = STATE_LABEL[name];
  buildExprPanel();
  buildLookPanel();
}

function buildStateList() {
  const el = document.getElementById('state-list');
  el.innerHTML = '';
  for (const s of STATES) {
    const b = document.createElement('button');
    b.className = 'state-btn'; b.dataset.state = s; b.textContent = STATE_LABEL[s];
    b.onclick = () => selectState(s);
    el.appendChild(b);
  }
}

function buildExprPanel() {
  const el = document.getElementById('expr-panel');
  el.innerHTML = '';
  const st = characterDef.states[editorState];
  if (!exprNames.length) { el.innerHTML = '<div class="hint">この VRM に編集可能な表情プリセットが見つかりません。</div>'; return; }
  for (const name of exprNames) {
    const row = document.createElement('div'); row.className = 'row';
    const cur = st.expression[name] ?? 0;
    row.innerHTML = `<label>${name}</label><input type="range" min="0" max="1" step="0.05" value="${cur}"><span class="val">${cur.toFixed(2)}</span>`;
    const slider = row.querySelector('input'); const val = row.querySelector('.val');
    slider.oninput = () => {
      const v = parseFloat(slider.value); val.textContent = v.toFixed(2);
      if (v <= 0) delete st.expression[name]; else st.expression[name] = v;
    };
    el.appendChild(row);
  }
}

function buildLookPanel() {
  const el = document.getElementById('look-panel');
  el.innerHTML = '';
  const st = characterDef.states[editorState];
  // 視線(目) ON/OFF
  const r1 = document.createElement('div'); r1.className = 'row';
  r1.innerHTML = `<label>視線(目)で見る</label><input type="checkbox" ${st.lookAtEye > 0.5 ? 'checked' : ''}>`;
  r1.querySelector('input').onchange = (e) => { st.lookAtEye = e.target.checked ? 1 : 0; };
  el.appendChild(r1);
  // 顔(頭) 追従強度
  const r2 = document.createElement('div'); r2.className = 'row';
  r2.innerHTML = `<label>顔(頭)の追従</label><input type="range" min="0" max="1" step="0.05" value="${st.lookAtHead}"><span class="val">${st.lookAtHead.toFixed(2)}</span>`;
  const s2 = r2.querySelector('input'); const v2 = r2.querySelector('.val');
  s2.oninput = () => { const v = parseFloat(s2.value); v2.textContent = v.toFixed(2); st.lookAtHead = v; };
  el.appendChild(r2);
}

function buildBehaviorPanel() {
  const el = document.getElementById('behavior-panel');
  el.innerHTML = '';
  const b = characterDef.behavior;
  for (const f of BEHAVIOR_FIELDS) {
    const row = document.createElement('div'); row.className = 'row';
    if (f.type === 'bool') {
      row.innerHTML = `<label>${f.label}</label><input type="checkbox" ${b[f.key] ? 'checked' : ''}>`;
      row.querySelector('input').onchange = (e) => { b[f.key] = e.target.checked; };
    } else {
      row.innerHTML = `<label>${f.label}</label><input type="number" step="${f.step}" value="${b[f.key]}">`;
      row.querySelector('input').onchange = (e) => { b[f.key] = parseFloat(e.target.value); };
    }
    el.appendChild(row);
  }
}

function startSim(held) {
  if (!vrm) return;
  mode = 'sim';
  simHeld = held;
  if (!ragdoll.active) {
    setRagdollActive(ragdoll, true);
    applyRagdollImpulse(ragdoll, new THREE.Vector3((Math.random() - 0.5), 0.2, (Math.random() - 0.5)).multiplyScalar(0.3), 'chest');
  }
  recoverTimer = (characterDef.behavior.recoverDelaySec ?? 2.5) + LOOK_DURATION;
}

async function exportBundle() {
  if (!bundle) { toast('先に NPC を読み込んでください'); return; }
  const out = Object.assign({}, bundle);
  out.version = 2;
  out.character = characterDef;
  const filename = `${bundle.name || 'character'}.npc.json`;

  // 開発サーバーの public/npc/ へ保存を試みる（本番等でエンドポイントが無ければダウンロードへ）
  try {
    const r = await fetch('../api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'npc', filename, content: out }),
    });
    if (r.ok) { const j = await r.json(); toast(`保存しました: ${j.path}`); return; }
  } catch { /* エンドポイント無し → ダウンロードへフォールバック */ }

  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('.npc.json をダウンロードしました（サーバー保存不可のため）');
}

// public/npc/ の一覧をドロップダウンに反映（manifest が無ければ既定リストにフォールバック）
async function populateNpcSelect(current) {
  const sel = document.getElementById('npc-select');
  if (!sel) return;
  let files = [];
  try { const r = await fetch('../npc/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  if (!files.length) files = NPC_FILES.slice();
  sel.innerHTML = '';
  for (const f of files) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f.replace(/\.npc\.json$/, '');
    sel.appendChild(o);
  }
  if (current && files.includes(current)) sel.value = current;
  sel.onchange = async () => {
    const b = await fetchBundle(sel.value);
    if (b) await loadBundleObject(b);
  };
}

// public/timeline/ の VRMA モーション一覧をドロップダウンへ
async function populateMotionSelect() {
  const sel = document.getElementById('motion-select');
  if (!sel) return;
  let files = [];
  try { const r = await fetch('../timeline/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  sel.innerHTML = '';
  if (!files.length) { const o = document.createElement('option'); o.textContent = '(モーション無し)'; o.value = ''; sel.appendChild(o); return; }
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.vrma$/, ''); sel.appendChild(o); }
}

// 選択中の VRMA モーションを VRM に適用して1回再生（終了で idle へ戻す）
async function playMotion(file) {
  if (!vrm || !mixer || !file) return;
  try {
    const al = new GLTFLoader();
    al.register(p => new VRMAnimationLoaderPlugin(p));
    const url = new URL('../timeline/' + file, window.location.href).href;
    const gltf = await al.loadAsync(url);
    const anims = gltf.userData.vrmAnimations;
    if (!anims || !anims.length) { toast('VRMA の読込に失敗'); return; }
    const clip = createVRMAnimationClip(anims[0], vrm);
    const act = mixer.clipAction(clip);
    act.reset(); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true;
    if (action) action.stop();
    mode = 'preview'; editorState = 'idle';
    if (ragdoll && ragdoll.active) setRagdollActive(ragdoll, false);
    act.play();
    const onFin = (e) => {
      if (e.action !== act) return;
      mixer.removeEventListener('finished', onFin);
      act.stop();
      if (action) { action.reset(); action.play(); }
    };
    mixer.addEventListener('finished', onFin);
    toast('モーション再生: ' + file.replace(/\.vrma$/, ''));
  } catch (e) { console.error(e); toast('モーション再生失敗'); }
}

function setupUI() {
  buildStateList();
  document.getElementById('btn-play-motion').onclick = () => {
    const sel = document.getElementById('motion-select');
    if (sel && sel.value) playMotion(sel.value);
  };
  document.getElementById('btn-sim-hit').onclick = () => startSim(false);
  document.getElementById('btn-sim-grab').onclick = () => startSim(true);
  document.getElementById('btn-sim-release').onclick = () => { simHeld = false; if (ragdoll && ragdoll.active) { recoverTimer = (characterDef.behavior.recoverDelaySec ?? 2.5) + LOOK_DURATION; } };
  document.getElementById('btn-export').onclick = exportBundle;
  const fi = document.getElementById('file-input');
  document.getElementById('btn-load').onclick = () => fi.click();
  fi.onchange = async () => { const f = fi.files[0]; if (!f) return; const j = JSON.parse(await f.text()); await loadBundleObject(j); };
}

// ── init ──────────────────────────────────────────────────
async function init() {
  const app = document.getElementById('app');
  if (!navigator.gpu) { toast('WebGPU 非対応のブラウザです'); return; }

  renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a3242);

  camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, 1.1, 3.2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const key = new THREE.DirectionalLight(0xfff6e6, 1.6); key.position.set(3, 6, 4); scene.add(key);
  const grid = new THREE.GridHelper(10, 20, 0x445, 0x334); scene.add(grid);
  try {
    const hdr = await new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg');
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  } catch (e) { console.warn('HDR 失敗', e); }

  setupUI();

  await populateNpcSelect(null);
  await populateMotionSelect();
  const sel = document.getElementById('npc-select');
  const first = (sel && sel.value) || NPC_FILES[0];
  const b = await fetchBundle(first);
  if (b) await loadBundleObject(b);
  else toast('npc/ の NPC が見つかりません。ファイル…で指定してください。');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(render);
}

init().catch(e => { console.error(e); toast('初期化に失敗: ' + e); });
