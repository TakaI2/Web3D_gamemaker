// bite-editor.js — 捕食（噛みつき）アライン調整エディタ
// プレイヤーVRM＋NPC VRM を並べ、ペアのVRMA（噛む側/噛まれる側）を同じ時計で再生しながら、
// 「口アンカー(プレイヤーhead+offset)」と「噛みつき点(NPC neck+offset)」をギズモ/スライダーで調整。
// Snap ON で、NPCのルートを毎フレーム剛体で座り直し、噛みつき点が口アンカーの固定相対位置に来るようロックする。
// 結果は public/bitealign/<name>.bite.json に保存し、tps-flight がキャラごとに読んで再現する想定。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { positionWorld, mix, color } from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls }    from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader }       from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';

// ── シーン ───────────────────────────────────────────────────────
let renderer, scene, camera, controls;
const timer = new THREE.Timer();
const FPS = 30;
const D2R = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;

const HUMANOID_BONES = [
  'head', 'neck', 'upperChest', 'chest', 'spine', 'hips', 'jaw',
  'leftEye', 'rightEye', 'leftShoulder', 'rightShoulder',
];

// ── キャラ（プレイヤー / NPC）────────────────────────────────────
function makeChar(slot, spawnX) {
  return { slot, vrm: null, mixer: null, action: null, clip: null, dur: 0, name: '',
    spawn: new THREE.Vector3(spawnX, 0, 0), baseQuat: new THREE.Quaternion() };
}
const player = makeChar('player', -0.45);
const npc = makeChar('npc', 0.45);

// ── 設定（bite-align）────────────────────────────────────────────
const cfg = {
  player: { mouthBone: 'head', mouthOffset: [0, -0.03, 0.09] },
  npc:    { biteBone: 'neck',  biteOffset: [-0.03, 0.02, 0.03] },
  align:  { pos: [0, 0, 0.02], rotDeg: [0, 180, 0], lock: true, blendIn: 0.15, blendOut: 0.2 },
  anim:   { playerVrma: '', victimVrma: '', fps: FPS, trimIn: 0, trimOut: 0, loopVictim: true },
};

// ── 再生（マスタークロック）──────────────────────────────────────
let playing = false, speed = 1, loop = true, playTime = 0;   // playTime[秒]
let snap = true;
let editTarget = 'mouth';   // ギズモ編集対象 'mouth' | 'bite'

function masterDur() { return Math.max(player.dur, npc.dur); }
function totalFrames() { return Math.max(1, Math.round(masterDur() * FPS)); }

// ── ギズモ / ハンドル ────────────────────────────────────────────
let gizmo = null, handleMouth = null, handleBite = null, gizmoMode = 'translate';

// ── 再利用テンポラリ ─────────────────────────────────────────────
const _mPos = new THREE.Vector3(), _mQuat = new THREE.Quaternion();
const _bPos = new THREE.Vector3(), _bQuat = new THREE.Quaternion();
const _off = new THREE.Vector3(), _desiredPos = new THREE.Vector3(), _desiredQuat = new THREE.Quaternion();
const _euler = new THREE.Euler(), _tq = new THREE.Quaternion();
const _bonePos = new THREE.Vector3(), _boneQuat = new THREE.Quaternion(), _boneInv = new THREE.Quaternion();
const _sp = new THREE.Vector3(), _cur = new THREE.Vector3(), _delta = new THREE.Vector3();

// ── FPS ──────────────────────────────────────────────────────────
let fpsFrames = 0, fpsLast = performance.now();

// ============================================================
// 部屋
// ============================================================
function buildRoom() {
  const S = 8, t = 0.2;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(S, t, S), new THREE.MeshStandardMaterial({ color: 0x2a2e44, roughness: 0.95 }));
  floor.position.y = -t / 2; scene.add(floor);
  const grid = new THREE.GridHelper(S, S, 0x4488ff, 0x2a3050);
  grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.002; scene.add(grid);
}

// ============================================================
// VRM 読み込み
// ============================================================
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function unloadChar(char) {
  if (char.action) char.action.stop();
  if (char.mixer) char.mixer.stopAllAction();
  if (char.vrm) {
    scene.remove(char.vrm.scene);
    char.vrm.scene.traverse(o => {
      if (o.isMesh) { o.geometry?.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m?.dispose(); }
    });
  }
  char.vrm = null; char.mixer = null; char.action = null; char.clip = null; char.dur = 0;
}

async function loadVRMInto(char, file, name) {
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }),
  }));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');
    unloadChar(char);
    char.vrm = vrm; char.name = name || char.slot;
    vrm.scene.position.copy(char.spawn);
    vrm.scene.quaternion.copy(char.baseQuat);
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    populateBoneSelects();
    if (char === npc && !document.getElementById('ba-name').value) document.getElementById('ba-name').value = char.name;
    showToast(`${char.slot === 'player' ? 'プレイヤー' : 'NPC'} 読み込み: ${char.name}`);
  } finally { URL.revokeObjectURL(url); }
}

async function importBundleInto(char, bundle, name) {
  if (!bundle || !bundle.vrm) { showToast('VRMを含まないファイルです', 'error'); return; }
  await loadVRMInto(char, new File([dataURIToBlob(bundle.vrm)], `${name}.vrm`), name);
  // bundle に biteAlign が埋め込まれていれば読む（互換）
  if (char === npc && bundle.biteAlign) applyConfig(bundle.biteAlign);
}

// ============================================================
// VRMA（アニメ）読み込み — キャラ個別 mixer
// ============================================================
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (!t.name.endsWith('.position')) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }   // 水平ルートモーション除去（Yは残す）
  }
}

async function loadVrmaInto(char, name) {
  if (!char.vrm) { showToast('先にVRMを読み込んでください', 'warn'); return; }
  const res = await fetch('/vrma/' + encodeURIComponent(name));
  if (!res.ok) throw new Error('VRMA取得失敗');
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const url = URL.createObjectURL(new File([await res.blob()], name));
  try {
    const gltf = await loader.loadAsync(url);
    const anims = gltf.userData.vrmAnimations;
    if (!anims?.length) throw new Error('VRMAアニメが見つかりません');
    if (char.action) char.action.stop();
    if (char.mixer) char.mixer.stopAllAction();
    char.clip = createVRMAnimationClip(anims[0], char.vrm);
    stripRootMotion(char.clip);
    char.mixer = new THREE.AnimationMixer(char.vrm.scene);
    char.action = char.mixer.clipAction(char.clip);
    char.action.play(); char.action.paused = true;
    char.dur = char.clip.duration;
    if (char === player) cfg.anim.playerVrma = name; else cfg.anim.victimVrma = name;
    onDurationChanged();
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-pause').disabled = false;
    showToast(`VRMA: ${name} (${char.dur.toFixed(2)}s)`);
  } finally { URL.revokeObjectURL(url); }
}

function onDurationChanged() {
  const tf = totalFrames();
  if (cfg.anim.trimOut === 0 || cfg.anim.trimOut > tf) cfg.anim.trimOut = tf;
  const scrub = document.getElementById('scrub');
  scrub.max = String(tf);
  updateTrimLabel();
  updateFrameLabel();
}

// ============================================================
// ボーン / アンカー
// ============================================================
function boneNode(char, which) {
  if (!char.vrm) return null;
  const name = which === 'mouth' ? cfg.player.mouthBone : cfg.npc.biteBone;
  return char.vrm.humanoid?.getNormalizedBoneNode(name) || null;
}

// 口アンカーのワールド pos/quat（head + ローカルoffset）
function mouthAnchorWorld(outPos, outQuat) {
  const node = boneNode(player, 'mouth');
  if (!node) return false;
  node.updateWorldMatrix(true, false);
  node.getWorldPosition(_mPos); node.getWorldQuaternion(_mQuat);
  _off.fromArray(cfg.player.mouthOffset).applyQuaternion(_mQuat);
  outPos.copy(_mPos).add(_off); if (outQuat) outQuat.copy(_mQuat);
  return true;
}
// 噛みつき点のワールド pos/quat（neck + ローカルoffset）
function biteAnchorWorld(outPos, outQuat) {
  const node = boneNode(npc, 'bite');
  if (!node) return false;
  node.updateWorldMatrix(true, false);
  node.getWorldPosition(_bPos); node.getWorldQuaternion(_bQuat);
  _off.fromArray(cfg.npc.biteOffset).applyQuaternion(_bQuat);
  outPos.copy(_bPos).add(_off); if (outQuat) outQuat.copy(_bQuat);
  return true;
}

// ============================================================
// Snap（剛体座り直し）: NPCルートを、噛みつき点が口フレームの固定相対位置に来るよう毎フレーム再配置
// ============================================================
function applySnap() {
  if (!player.vrm || !npc.vrm) return;
  if (!mouthAnchorWorld(_mPos, _mQuat)) return;   // _mPos=口ワールド, _mQuat=口(head)向き
  // 目標: 向き（NPCルート＝口向き×rotDeg）と位置（口ワールド＋口ローカルの寄せ）
  _euler.set(D2R(cfg.align.rotDeg[0]), D2R(cfg.align.rotDeg[1]), D2R(cfg.align.rotDeg[2]), 'YXZ');
  _desiredQuat.copy(_mQuat).multiply(_tq.setFromEuler(_euler));
  _off.fromArray(cfg.align.pos).applyQuaternion(_mQuat);
  _desiredPos.copy(_mPos).add(_off);
  // 1) ルート向きを決める
  npc.vrm.scene.quaternion.copy(_desiredQuat);
  npc.vrm.scene.updateMatrixWorld(true);
  // 2) その向きでの噛みつき点ワールドを読み、ルートを平行移動して目標へ一致
  if (!biteAnchorWorld(_cur)) return;
  _delta.copy(_desiredPos).sub(_cur);
  npc.vrm.scene.position.add(_delta);
  npc.vrm.scene.updateMatrixWorld(true);
}

// Snap OFF 時: NPC を並び位置へ戻す
function restNpc() {
  if (!npc.vrm) return;
  npc.vrm.scene.position.copy(npc.spawn);
  npc.vrm.scene.quaternion.copy(npc.baseQuat);
  npc.vrm.scene.updateMatrixWorld(true);
}

// gap（口と噛みつき点の距離）表示
function updateGap() {
  const el = document.getElementById('gap');
  if (!player.vrm || !npc.vrm) { el.textContent = 'gap: -- cm'; return; }
  const okM = mouthAnchorWorld(_mPos, null), okB = biteAnchorWorld(_bPos, null);
  if (!okM || !okB) { el.textContent = 'gap: -- cm'; return; }
  el.textContent = `gap: ${(_mPos.distanceTo(_bPos) * 100).toFixed(1)} cm`;
}

// ============================================================
// ハンドル追従 / ギズモ
// ============================================================
function anchorFollow() {
  if (gizmo && gizmo.dragging) return;   // ドラッグ中は書き戻し優先
  if (player.vrm && mouthAnchorWorld(_mPos, _mQuat)) { handleMouth.position.copy(_mPos); handleMouth.quaternion.copy(_mQuat); handleMouth.visible = true; }
  else handleMouth.visible = false;
  if (npc.vrm && biteAnchorWorld(_bPos, _bQuat)) { handleBite.position.copy(_bPos); handleBite.quaternion.copy(_bQuat); handleBite.visible = true; }
  else handleBite.visible = false;
}

function attachGizmo() {
  if (!gizmo) return;
  if (editTarget === 'bite' && npc.vrm) gizmo.attach(handleBite);
  else if (player.vrm) gizmo.attach(handleMouth);
  else gizmo.detach();
  document.getElementById('edit-mouth').classList.toggle('toggle-on', editTarget === 'mouth');
  document.getElementById('edit-bite').classList.toggle('toggle-on', editTarget === 'bite');
}

// ギズモ操作 → ボーンローカルオフセットへ書き戻し
function onGizmoChange() {
  if (editTarget === 'mouth' && player.vrm) {
    const node = boneNode(player, 'mouth'); if (!node) return;
    node.getWorldPosition(_bonePos); node.getWorldQuaternion(_boneQuat); _boneInv.copy(_boneQuat).invert();
    _sp.copy(handleMouth.position).sub(_bonePos).applyQuaternion(_boneInv);
    cfg.player.mouthOffset = [_sp.x, _sp.y, _sp.z];
    syncOffsetSliders('mouth');
  } else if (editTarget === 'bite' && npc.vrm) {
    const node = boneNode(npc, 'bite'); if (!node) return;
    node.getWorldPosition(_bonePos); node.getWorldQuaternion(_boneQuat); _boneInv.copy(_boneQuat).invert();
    _sp.copy(handleBite.position).sub(_bonePos).applyQuaternion(_boneInv);
    cfg.npc.biteOffset = [_sp.x, _sp.y, _sp.z];
    syncOffsetSliders('bite');
  }
}

function setGizmoMode(mode) {
  gizmoMode = mode;
  if (gizmo) gizmo.setMode(mode);
}

// ============================================================
// 再生（ペア同期）
// ============================================================
function applyPoseAt(t) {
  // 各キャラを共通クロック t[秒] で評価。NPC(被食)は独立ループ可。
  for (const c of [player, npc]) {
    if (!c.action || !c.clip) continue;
    let tt = t;
    if (c === npc && cfg.anim.loopVictim && c.dur > 0) tt = t % c.dur;
    c.action.time = Math.min(Math.max(0, tt), c.clip.duration);
    c.mixer.update(0);
  }
}

function play() { if (masterDur() <= 0) return; playing = true; updatePlayButtons(); }
function pause() { playing = false; updatePlayButtons(); }
function updatePlayButtons() {
  document.getElementById('btn-play').disabled = playing || masterDur() <= 0;
  document.getElementById('btn-pause').disabled = !playing;
}

// ============================================================
// 設定 <-> UI
// ============================================================
function syncOffsetSliders(which) {
  const arr = which === 'mouth' ? cfg.player.mouthOffset : cfg.npc.biteOffset;
  const p = which === 'mouth' ? 'mouth' : 'bite';
  for (const [i, ax] of ['x', 'y', 'z'].entries()) {
    const sl = document.getElementById(`${p}-${ax}`), vl = document.getElementById(`${p}-${ax}-val`);
    if (sl) sl.value = String(arr[i]); if (vl) vl.textContent = arr[i].toFixed(3);
  }
}
function syncAlignSliders() {
  for (const [i, ax] of ['x', 'y', 'z'].entries()) {
    document.getElementById(`al-${ax}`).value = String(cfg.align.pos[i]);
    document.getElementById(`al-${ax}-val`).textContent = cfg.align.pos[i].toFixed(3);
  }
  for (const [i, ax] of ['rx', 'ry', 'rz'].entries()) {
    document.getElementById(`al-${ax}`).value = String(cfg.align.rotDeg[i]);
    document.getElementById(`al-${ax}-val`).textContent = String(Math.round(cfg.align.rotDeg[i]));
  }
}
function populateBoneSelects() {
  fillBoneSelect('mouth-bone', player, cfg.player.mouthBone);
  fillBoneSelect('bite-bone', npc, cfg.npc.biteBone);
}
function fillBoneSelect(id, char, current) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const present = char.vrm ? HUMANOID_BONES.filter(b => char.vrm.humanoid?.getNormalizedBoneNode(b)) : HUMANOID_BONES;
  sel.innerHTML = '';
  for (const b of present) { const o = document.createElement('option'); o.value = b; o.textContent = b; sel.appendChild(o); }
  if (present.includes(current)) sel.value = current;
}

function applyConfig(c) {
  if (c.player) { cfg.player.mouthBone = c.player.mouthBone || cfg.player.mouthBone; if (Array.isArray(c.player.mouthOffset)) cfg.player.mouthOffset = c.player.mouthOffset.slice(); }
  if (c.npc) { cfg.npc.biteBone = c.npc.biteBone || cfg.npc.biteBone; if (Array.isArray(c.npc.biteOffset)) cfg.npc.biteOffset = c.npc.biteOffset.slice(); }
  if (c.align) {
    if (Array.isArray(c.align.pos)) cfg.align.pos = c.align.pos.slice();
    if (Array.isArray(c.align.rotEuler)) cfg.align.rotDeg = c.align.rotEuler.slice();   // 保存は度
    if (typeof c.align.lock === 'boolean') cfg.align.lock = c.align.lock;
    if (c.align.blendIn != null) cfg.align.blendIn = c.align.blendIn;
    if (c.align.blendOut != null) cfg.align.blendOut = c.align.blendOut;
  }
  if (c.anim) {
    Object.assign(cfg.anim, { fps: c.anim.fps ?? FPS, trimIn: c.anim.trimIn ?? 0, trimOut: c.anim.trimOut ?? 0, loopVictim: c.anim.loopVictim ?? true });
    cfg.anim.playerVrma = c.anim.playerVrma || '';
    cfg.anim.victimVrma = c.anim.victimVrma || '';
  }
  // UI 反映
  populateBoneSelects();
  syncOffsetSliders('mouth'); syncOffsetSliders('bite'); syncAlignSliders();
  document.getElementById('cb-loop-victim').checked = cfg.anim.loopVictim;
  // アニメも読み込む
  if (cfg.anim.playerVrma) { document.getElementById('anim-player').value = cfg.anim.playerVrma; loadVrmaInto(player, cfg.anim.playerVrma).catch(e => console.warn(e)); }
  if (cfg.anim.victimVrma) { document.getElementById('anim-victim').value = cfg.anim.victimVrma; loadVrmaInto(npc, cfg.anim.victimVrma).catch(e => console.warn(e)); }
}

function buildConfigJson() {
  return {
    format: 'bite-align', version: 1,
    target: npc.name || '',
    player: { mouthBone: cfg.player.mouthBone, mouthOffset: cfg.player.mouthOffset.slice() },
    npc: { biteBone: cfg.npc.biteBone, biteOffset: cfg.npc.biteOffset.slice() },
    align: { pos: cfg.align.pos.slice(), rotEuler: cfg.align.rotDeg.slice(), lock: cfg.align.lock, blendIn: cfg.align.blendIn, blendOut: cfg.align.blendOut },
    anim: { playerVrma: cfg.anim.playerVrma, victimVrma: cfg.anim.victimVrma, fps: FPS, trimIn: cfg.anim.trimIn, trimOut: cfg.anim.trimOut, loopVictim: cfg.anim.loopVictim },
  };
}

// ============================================================
// UI
// ============================================================
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'visible' + (type !== 'info' ? ' ' + type : '');
  clearTimeout(showToast._t); showToast._t = setTimeout(() => { el.className = ''; }, 2200);
}
function updateFrameLabel() {
  document.getElementById('frame-lbl').textContent = `${Math.round(playTime * FPS)} / ${totalFrames()}`;
  document.getElementById('scrub').value = String(Math.round(playTime * FPS));
}
function updateTrimLabel() { document.getElementById('trim-lbl').textContent = `${cfg.anim.trimIn}–${cfg.anim.trimOut}`; }

function bindSlider(id, apply, fmt) {
  const sl = document.getElementById(id), vl = document.getElementById(id + '-val');
  sl.addEventListener('input', () => { const v = parseFloat(sl.value); apply(v); if (vl) vl.textContent = fmt(v); });
}

async function fillManifest(url, selId, mapLabel) {
  try {
    const files = await (await fetch(url)).json();
    const sel = document.getElementById(selId);
    for (const f of (Array.isArray(files) ? files : [])) {
      const o = document.createElement('option'); o.value = f; o.textContent = mapLabel(f); sel.appendChild(o);
    }
  } catch { /* 無ければ空 */ }
}

function setupUI() {
  // プレイヤー/NPC 読み込み
  const bindLoad = (char, npcSelId, vrmBtnId, vrmFileId) => {
    const npcSel = document.getElementById(npcSelId);
    npcSel.addEventListener('change', async () => {
      if (!npcSel.value) return;
      try { const r = await fetch('../npc/' + npcSel.value); if (!r.ok) throw new Error('取得失敗'); await importBundleInto(char, await r.json(), npcSel.value.replace(/\.npc\.json$/, '')); }
      catch (e) { showToast(`読み込み失敗: ${e.message}`, 'error'); console.error(e); }
    });
    const file = document.getElementById(vrmFileId);
    document.getElementById(vrmBtnId).addEventListener('click', () => file.click());
    file.addEventListener('change', async e => {
      const f = e.target.files?.[0]; if (!f) return; file.value = '';
      try { await loadVRMInto(char, f, f.name.replace(/\.vrm$/i, '')); } catch (err) { showToast(`VRM失敗: ${err.message}`, 'error'); }
    });
  };
  bindLoad(player, 'player-npc', 'player-vrm-btn', 'player-vrm-file');
  bindLoad(npc, 'npc-npc', 'npc-vrm-btn', 'npc-vrm-file');

  fillManifest('../npc/manifest.json', 'player-npc', f => f.replace(/\.npc\.json$/, ''));
  fillManifest('../npc/manifest.json', 'npc-npc', f => f.replace(/\.npc\.json$/, ''));
  fillManifest('/vrma/manifest.json', 'anim-player', f => f.replace(/\.vrma$/, ''));
  fillManifest('/vrma/manifest.json', 'anim-victim', f => f.replace(/\.vrma$/, ''));
  fillManifest('/bitealign/manifest.json', 'ba-select', f => f.replace(/\.bite\.json$/, ''));

  document.getElementById('anim-player').addEventListener('change', e => { if (e.target.value) loadVrmaInto(player, e.target.value).catch(err => showToast(err.message, 'error')); });
  document.getElementById('anim-victim').addEventListener('change', e => { if (e.target.value) loadVrmaInto(npc, e.target.value).catch(err => showToast(err.message, 'error')); });
  document.getElementById('cb-loop-victim').addEventListener('change', e => { cfg.anim.loopVictim = e.target.checked; });

  // 再生
  document.getElementById('btn-play').addEventListener('click', play);
  document.getElementById('btn-pause').addEventListener('click', pause);
  document.getElementById('cb-loop').addEventListener('change', e => { loop = e.target.checked; });
  const spd = document.getElementById('speed'), spdV = document.getElementById('speed-val');
  spd.addEventListener('input', () => { speed = parseFloat(spd.value); spdV.textContent = `${speed.toFixed(2)}×`; });
  document.getElementById('scrub').addEventListener('input', e => { playing = false; playTime = (parseInt(e.target.value) || 0) / FPS; updatePlayButtons(); updateFrameLabel(); });
  document.getElementById('btn-in').addEventListener('click', () => { cfg.anim.trimIn = Math.min(Math.round(playTime * FPS), cfg.anim.trimOut - 1); updateTrimLabel(); });
  document.getElementById('btn-out').addEventListener('click', () => { cfg.anim.trimOut = Math.max(Math.round(playTime * FPS), cfg.anim.trimIn + 1); updateTrimLabel(); });
  document.getElementById('btn-trim-reset').addEventListener('click', () => { cfg.anim.trimIn = 0; cfg.anim.trimOut = totalFrames(); updateTrimLabel(); });

  // 口 / 噛みつき点
  document.getElementById('mouth-bone').addEventListener('change', e => { cfg.player.mouthBone = e.target.value; });
  document.getElementById('bite-bone').addEventListener('change', e => { cfg.npc.biteBone = e.target.value; });
  document.getElementById('edit-mouth').addEventListener('click', () => { editTarget = 'mouth'; attachGizmo(); });
  document.getElementById('edit-bite').addEventListener('click', () => { editTarget = 'bite'; attachGizmo(); });
  for (const [i, ax] of ['x', 'y', 'z'].entries()) {
    bindSlider(`mouth-${ax}`, v => { cfg.player.mouthOffset[i] = v; }, v => v.toFixed(3));
    bindSlider(`bite-${ax}`, v => { cfg.npc.biteOffset[i] = v; }, v => v.toFixed(3));
  }

  // アライン
  const snapBtn = document.getElementById('btn-snap');
  snapBtn.addEventListener('click', () => { snap = !snap; snapBtn.classList.toggle('snap-on', snap); snapBtn.textContent = snap ? '● Snap ON' : '○ Snap OFF'; if (!snap) restNpc(); });
  for (const [i, ax] of ['x', 'y', 'z'].entries()) bindSlider(`al-${ax}`, v => { cfg.align.pos[i] = v; }, v => v.toFixed(3));
  for (const [i, ax] of ['rx', 'ry', 'rz'].entries()) bindSlider(`al-${ax}`, v => { cfg.align.rotDeg[i] = v; }, v => String(Math.round(v)));

  // BiteAlign 読込 / 保存
  document.getElementById('ba-select').addEventListener('change', async e => {
    if (!e.target.value) return;
    try { const r = await fetch('/bitealign/' + e.target.value); if (!r.ok) throw new Error('取得失敗'); applyConfig(await r.json()); showToast(`読込: ${e.target.value}`); }
    catch (err) { showToast(`読込失敗: ${err.message}`, 'error'); }
  });
  document.getElementById('ba-save').addEventListener('click', saveConfig);

  // キーボード G/R
  window.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'g' || e.key === 'G') setGizmoMode('translate');
    else if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
  });

  // 初期スライダー反映
  syncOffsetSliders('mouth'); syncOffsetSliders('bite'); syncAlignSliders();
  snapBtn.classList.toggle('snap-on', snap);
}

async function saveConfig() {
  const def = (npc.name || 'bite').replace(/[^\w\-]/g, '_');
  const nameInput = document.getElementById('ba-name').value.trim();
  const base = (nameInput || def).replace(/\.bite\.json$/, '').replace(/[^\w\-]/g, '_');
  if (!base) { showToast('保存名が不正です', 'warn'); return; }
  const filename = `${base}.bite.json`;
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'bitealign', filename, content: JSON.stringify(buildConfigJson(), null, 2) }) });
    const j = await r.json();
    if (j.ok) {
      showToast(`保存: ${j.path}`);
      const sel = document.getElementById('ba-select');
      if (![...sel.options].some(o => o.value === filename)) { const o = document.createElement('option'); o.value = filename; o.textContent = base; sel.appendChild(o); }
    } else showToast('保存失敗', 'error');
  } catch (e) { showToast(`保存失敗: ${e}`, 'error'); }
}

// ============================================================
// Render
// ============================================================
function updateFPS() {
  fpsFrames++;
  const now = performance.now(), el = now - fpsLast;
  if (el >= 500) {
    const fps = Math.round(fpsFrames / (el / 1000));
    document.getElementById('fps-counter').textContent = `${fps} FPS`;
    document.getElementById('fps-toolbar').textContent = `${fps} FPS`;
    fpsFrames = 0; fpsLast = now;
  }
}

function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 20);
  updateFPS();

  // マスタークロック前進
  if (playing && masterDur() > 0) {
    const inT = cfg.anim.trimIn / FPS, outT = cfg.anim.trimOut / FPS;
    playTime += dt * speed;
    if (playTime >= outT - 1e-4) { if (loop) playTime = inT; else { playTime = outT; playing = false; updatePlayButtons(); } }
    updateFrameLabel();
  }

  // ポーズ適用（両者を共通クロックで）
  applyPoseAt(playTime);
  if (player.vrm) player.vrm.update(dt);
  if (npc.vrm) npc.vrm.update(dt);

  // アライン
  if (snap) applySnap(); else restNpc();

  anchorFollow();
  updateGap();
  controls.update();
  renderer.render(scene, camera);
}

// ============================================================
// Init
// ============================================================
async function init() {
  const app = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!navigator.gpu) { document.getElementById('webgpu-warning').style.display = 'block'; throw new Error('WebGPU 非対応'); }

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.1;
  app.appendChild(renderer.domElement);
  await renderer.init();

  const resize = () => { const w = app.clientWidth, h = app.clientHeight; renderer.setSize(w, h); if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); } };
  resize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121f);

  camera = new THREE.PerspectiveCamera(38, app.clientWidth / app.clientHeight, 0.01, 100);
  camera.position.set(0, 1.35, 2.6);

  // 空
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const skyT = positionWorld.normalize().y.mul(0.5).add(0.5).clamp(0, 1);
  skyMat.colorNode = mix(color(0x1a1f33), color(0x0c0c16), skyT);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), skyMat);
  sky.frustumCulled = false; scene.add(sky);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.7); dir.position.set(2, 4, 3); scene.add(dir);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.15, 0); controls.update();

  buildRoom();

  // ハンドル（口=緑 / 噛みつき=赤）
  const mkHandle = (col) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 999; g.add(m); g.add(new THREE.AxesHelper(0.08)); g.visible = false; scene.add(g); return g;
  };
  handleMouth = mkHandle(0x33dd66);
  handleBite = mkHandle(0xff4455);

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate'); gizmo.setSize(0.6);
  gizmo.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
  gizmo.addEventListener('objectChange', onGizmoChange);
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

  timer.connect(document);
  setupUI();
  attachGizmo();

  window.addEventListener('resize', resize);
  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);
  renderer.setAnimationLoop(render);
}

init().catch(err => { console.error(err); const l = document.getElementById('loading'); if (l) l.textContent = `初期化失敗: ${err.message}`; });
