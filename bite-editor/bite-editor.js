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
import { createRagdoll, updateRagdoll, setRagdollActive, applyRagdollImpulse, disposeRagdoll } from '../lib/vrm-ragdoll.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';

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
    cloth: null, ragdoll: null, gripMarkers: null,
    spawn: new THREE.Vector3(spawnX, 0, 0), baseQuat: new THREE.Quaternion() };
}
// ラグドール物理プレビュー（被食モード=ragdoll のとき）
const RAGDOLL_BOUNDS = { min: new THREE.Vector3(-4, 0, -4), max: new THREE.Vector3(4, 8, 4) };
const _nudgeV = new THREE.Vector3();
let ragdollOn = false, ragLastFrame = -1;
const player = makeChar('player', -0.45);
const npc = makeChar('npc', 0.45);

// ── 設定（bite-align）────────────────────────────────────────────
const cfg = {
  player: { mouthBone: 'head', mouthOffset: [0, -0.03, 0.09] },
  npc:    { biteBone: 'neck',  biteOffset: [-0.03, 0.02, 0.03], mode: 'anim' },   // mode: 'anim'|'ragdoll'
  align:  { pos: [0, 0, 0.02], rotDeg: [0, 180, 0], lock: true, blendIn: 0.15, blendOut: 0.2 },
  anim:   { playerVrma: '', victimVrma: '', fps: FPS, trimIn: 0, trimOut: 0, loopVictim: true, sound: '' },
};

// ── キーフレーム（口/噛点/アラインをタイムラインで変化。cloth-preview 風。線形補間）──
const tracks = { mouthOffset: [], biteOffset: [], alignPos: [], alignRot: [] };  // 各: [{f:frame, v:[x,y,z]}] 昇順
const KEY_GROUPS = { mouth: ['mouthOffset'], bite: ['biteOffset'], align: ['alignPos', 'alignRot'] };
let lastKeyFrame = -1;

function curFrame() { return Math.round(playTime * FPS); }
function trackTarget(name) {
  if (name === 'mouthOffset') return { arr: cfg.player.mouthOffset, sync: () => syncOffsetSliders('mouth') };
  if (name === 'biteOffset')  return { arr: cfg.npc.biteOffset,     sync: () => syncOffsetSliders('bite') };
  if (name === 'alignPos')    return { arr: cfg.align.pos,          sync: syncAlignSliders };
  return { arr: cfg.align.rotDeg, sync: syncAlignSliders };   // alignRot（度）
}
function sampleTrack(track, frame) {
  if (!track.length) return null;
  if (frame <= track[0].f) return track[0].v.slice();
  const last = track[track.length - 1];
  if (frame >= last.f) return last.v.slice();
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (frame >= a.f && frame <= b.f) { const t = (frame - a.f) / Math.max(1, b.f - a.f); return [0, 1, 2].map(k => a.v[k] + (b.v[k] - a.v[k]) * t); }
  }
  return last.v.slice();
}
function upsertKey(track, f, v) {
  const idx = track.findIndex(k => k.f === f);
  if (idx >= 0) track[idx].v = v; else { track.push({ f, v }); track.sort((a, b) => a.f - b.f); }
}
function removeNearestKey(track, f) {
  if (!track.length) return;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < track.length; i++) { const d = Math.abs(track[i].f - f); if (d < bd) { bd = d; bi = i; } }
  track.splice(bi, 1);
}
// スライダー/ギズモ編集を、そのトラックに既にキーがあれば現フレームへ反映（オートキー）
function autoKey(name) { if (tracks[name].length) upsertKey(tracks[name], curFrame(), trackTarget(name).arr.slice()); }
// 現フレームのキー値を cfg（＋スライダー）へ反映。キー無しトラックは触らない（＝静的値のまま編集可）
function applyTracksAt(frame) {
  for (const name of Object.keys(tracks)) {
    const v = sampleTrack(tracks[name], frame);
    if (!v) continue;
    const t = trackTarget(name);
    for (let i = 0; i < 3; i++) t.arr[i] = v[i];
    t.sync();
  }
}
function setKeyGroup(g) { const f = curFrame(); for (const n of KEY_GROUPS[g]) upsertKey(tracks[n], f, trackTarget(n).arr.slice()); lastKeyFrame = -1; refreshKeyLabels(); showToast(`キー: ${g} @${f}`); }
function delKeyGroup(g) { const f = curFrame(); for (const n of KEY_GROUPS[g]) removeNearestKey(tracks[n], f); lastKeyFrame = -1; refreshKeyLabels(); }
function refreshKeyLabels() {
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = `${tracks[n].length}キー`; };
  set('keys-mouth', 'mouthOffset'); set('keys-bite', 'biteOffset'); set('keys-align', 'alignPos');
}
function serializeTracks() {
  const out = {};
  for (const [n, tr] of Object.entries(tracks)) if (tr.length) out[n] = tr.map(k => ({ f: k.f, v: k.v.slice() }));
  return Object.keys(out).length ? out : null;
}
function loadTracks(src) {
  for (const n of Object.keys(tracks)) tracks[n] = [];
  if (src && typeof src === 'object') {
    for (const n of Object.keys(tracks)) {
      const tr = src[n];
      if (Array.isArray(tr)) tracks[n] = tr.filter(k => k && Number.isFinite(k.f) && Array.isArray(k.v)).map(k => ({ f: Math.round(k.f), v: k.v.slice(0, 3) })).sort((a, b) => a.f - b.f);
    }
  }
  lastKeyFrame = -1;
  refreshKeyLabels();
}

// ── 小突き（ラグドール被食時。指定フレームでボーンにインパルス。ragdoll-editor 相当）──
const NUDGE_BONES = ['chest', 'hips', 'head', 'neck', 'leftHand', 'rightHand', 'leftUpperArm', 'rightUpperArm', 'leftLowerLeg', 'rightLowerLeg'];
let biteNudges = [];   // [{f, bone, dir:[x,y,z], strength}]
function refreshNudgeList() {
  const sel = document.getElementById('nudge-list'); if (!sel) return;
  biteNudges.sort((a, b) => a.f - b.f);
  sel.innerHTML = '';
  for (const [i, n] of biteNudges.entries()) {
    const o = document.createElement('option'); o.value = String(i);
    o.textContent = `f${n.f}  ${n.bone}  (${n.dir.map(x => x.toFixed(1)).join(',')})×${n.strength}`;
    sel.appendChild(o);
  }
}
function addNudge() {
  const bone = document.getElementById('nudge-bone').value || 'chest';
  const dir = ['x', 'y', 'z'].map(a => parseFloat(document.getElementById('nudge-' + a).value) || 0);
  const strength = parseFloat(document.getElementById('nudge-str').value) || 1;
  biteNudges.push({ f: curFrame(), bone, dir, strength });
  refreshNudgeList(); showToast(`小突き ${bone} @${curFrame()}`);
}
function delNudge() {
  const i = parseInt(document.getElementById('nudge-list').value);
  if (Number.isFinite(i)) { biteNudges.splice(i, 1); refreshNudgeList(); }
}
function loadNudges(src) {
  biteNudges = Array.isArray(src) ? src.map(n => ({ f: Math.round(n.f) || 0, bone: n.bone || 'chest', dir: Array.isArray(n.dir) ? n.dir.slice(0, 3) : [0, 0, 0], strength: n.strength || 1 })) : [];
  refreshNudgeList();
}

// ── タイムライン canvas（cloth-preview 風。キー/nudge を可視化・クリックでシーク・ドラッグで移動）──
const TL_ROWS = [['mouthOffset', '口'], ['biteOffset', '噛点'], ['alignPos', 'align位'], ['alignRot', 'align角'], ['nudge', '小突き']];
const TL_HEADER = 56, TL_RULER = 18, TL_ROWH = 22;
let _tlDrag = null, tlPxF = 8, tlScroll = 0, tlUserZoom = false;
function tlKeysOf(key) { return key === 'nudge' ? biteNudges : tracks[key]; }
function tlFit(cssW) { return Math.max(2, (cssW - TL_HEADER) / Math.max(1, totalFrames())); }
function tlClampScroll(cssW) { const tf = totalFrames(), vis = (cssW - TL_HEADER) / tlPxF; tlScroll = Math.max(0, Math.min(Math.max(0, tf - vis), tlScroll)); }
function tlF2X(f) { return TL_HEADER + (f - tlScroll) * tlPxF; }
function tlX2F(x) { return tlScroll + (x - TL_HEADER) / tlPxF; }
function drawTimeline() {
  const cv = document.getElementById('tl-canvas'); if (!cv) return;
  const cssW = cv.clientWidth || 320, cssH = cv.clientHeight || 120;
  if (cv.width !== cssW || cv.height !== cssH) { cv.width = cssW; cv.height = cssH; }
  if (!tlUserZoom) { tlPxF = tlFit(cssW); tlScroll = 0; }
  const ctx = cv.getContext('2d'); const tf = totalFrames();
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#0d0f22'; ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = 'rgba(60,200,150,0.08)'; ctx.fillRect(tlF2X(cfg.anim.trimIn), 0, Math.max(0, cfg.anim.trimOut - cfg.anim.trimIn) * tlPxF, cssH);
  ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
  const step = Math.max(1, Math.round(55 / tlPxF / 5) * 5);   // 目盛りは約55px間隔（5の倍数）
  for (let f = 0; f <= tf; f += step) { const x = tlF2X(f); if (x < TL_HEADER - 1 || x > cssW) continue; ctx.strokeStyle = '#20203a'; ctx.beginPath(); ctx.moveTo(x, TL_RULER); ctx.lineTo(x, cssH); ctx.stroke(); }
  for (const [i, [key, label]] of TL_ROWS.entries()) {
    const y0 = TL_RULER + i * TL_ROWH, yc = y0 + TL_ROWH / 2;
    if (y0 > cssH) break;
    ctx.strokeStyle = '#20203a'; ctx.beginPath(); ctx.moveTo(TL_HEADER, y0); ctx.lineTo(cssW, y0); ctx.stroke();
    ctx.fillStyle = key === 'nudge' ? '#ffb066' : '#5fd0ff';
    for (const k of tlKeysOf(key)) { const x = tlF2X(k.f); if (x < TL_HEADER - 5 || x > cssW + 5) continue; ctx.beginPath(); ctx.moveTo(x, yc - 5); ctx.lineTo(x + 5, yc); ctx.lineTo(x, yc + 5); ctx.lineTo(x - 5, yc); ctx.closePath(); ctx.fill(); }
  }
  // ヘッダ列（ラベル）を目盛りの上に描く
  ctx.fillStyle = '#12142a'; ctx.fillRect(0, 0, TL_HEADER, cssH);
  ctx.fillStyle = '#99a'; ctx.font = '11px system-ui';
  for (const [i, [, label]] of TL_ROWS.entries()) { const yc = TL_RULER + i * TL_ROWH + TL_ROWH / 2; if (yc < cssH) ctx.fillText(label, 6, yc); }
  // ルーラー（フレーム番号）
  ctx.fillStyle = '#1b1b30'; ctx.fillRect(TL_HEADER, 0, cssW - TL_HEADER, TL_RULER);
  ctx.fillStyle = '#7a7aa0';
  for (let f = 0; f <= tf; f += step) { const x = tlF2X(f); if (x < TL_HEADER || x > cssW - 6) continue; ctx.fillText(String(f), x + 2, TL_RULER / 2); }
  ctx.strokeStyle = '#2a2a44'; ctx.beginPath(); ctx.moveTo(TL_HEADER, 0); ctx.lineTo(TL_HEADER, cssH); ctx.stroke();
  const px = tlF2X(curFrame());
  if (px >= TL_HEADER) { ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, cssH); ctx.stroke(); ctx.lineWidth = 1; }
}
function tlHit(x, y) {
  const ri = Math.floor((y - TL_RULER) / TL_ROWH); if (ri < 0 || ri >= TL_ROWS.length) return null;
  const key = TL_ROWS[ri][0], yc = TL_RULER + ri * TL_ROWH + TL_ROWH / 2;
  for (const k of tlKeysOf(key)) { if (Math.abs(x - tlF2X(k.f)) <= 6 && Math.abs(y - yc) <= 8) return { key, entry: k }; }
  return null;
}
function tlSeekX(x) {
  const tf = totalFrames();
  let f = Math.max(0, Math.min(tf, Math.round(tlX2F(x))));
  playing = false; playTime = f / FPS; lastKeyFrame = -1; updateFrameLabel(); updatePlayButtons();
  const sc = document.getElementById('scrub'); if (sc) sc.value = String(f);
  return f;
}
function setupTimelineCanvas() {
  const cv = document.getElementById('tl-canvas'); if (!cv) return;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    const rect = cv.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = tlHit(x, y);
    if (e.button === 2) {   // 右クリック=キー削除
      if (hit) { const arr = tlKeysOf(hit.key); const i = arr.indexOf(hit.entry); if (i >= 0) arr.splice(i, 1); if (hit.key === 'nudge') refreshNudgeList(); else { lastKeyFrame = -1; refreshKeyLabels(); } }
      return;
    }
    if (hit) { _tlDrag = { kind: 'key', hit }; tlSeekX(tlF2X(hit.entry.f)); }
    else { _tlDrag = { kind: 'scrub' }; tlSeekX(x); }
    cv.setPointerCapture?.(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!_tlDrag) return;
    const x = e.clientX - cv.getBoundingClientRect().left;
    if (_tlDrag.kind === 'scrub') tlSeekX(x);
    else { const f = tlSeekX(x); _tlDrag.hit.entry.f = f; if (_tlDrag.hit.key === 'nudge') refreshNudgeList(); else { lastKeyFrame = -1; refreshKeyLabels(); } }
  });
  const end = () => { if (_tlDrag && _tlDrag.kind === 'key' && _tlDrag.hit.key !== 'nudge') tracks[_tlDrag.hit.key].sort((a, b) => a.f - b.f); _tlDrag = null; };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', () => { tlUserZoom = false; });   // ダブルクリックで全体フィット
  cv.addEventListener('wheel', e => {   // ホイール=拡大縮小 / Shift(または横)=移動
    e.preventDefault();
    const x = e.clientX - cv.getBoundingClientRect().left;
    tlUserZoom = true;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { tlScroll += (e.deltaX || e.deltaY) / tlPxF; }
    else { const fAt = tlX2F(x); tlPxF = Math.max(1, Math.min(80, tlPxF * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); tlScroll = fAt - (x - TL_HEADER) / tlPxF; }
    tlClampScroll(cv.clientWidth);
  }, { passive: false });
  // 高さリサイズ（上端ハンドルをドラッグ）
  const bar = document.getElementById('timeline-bar'), handle = document.getElementById('tl-resize');
  if (bar && handle) {
    let sy = 0, sh = 0, drag = false;
    handle.addEventListener('pointerdown', e => { drag = true; sy = e.clientY; sh = bar.offsetHeight; handle.setPointerCapture?.(e.pointerId); e.preventDefault(); });
    handle.addEventListener('pointermove', e => { if (!drag) return; bar.style.height = Math.max(70, Math.min(460, sh + (sy - e.clientY))) + 'px'; });
    handle.addEventListener('pointerup', () => { drag = false; });
  }
}

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
  if (char.cloth) { try { char.cloth.dispose(); } catch { /* noop */ } char.cloth = null; }
  if (char.ragdoll) { try { disposeRagdoll(char.ragdoll); } catch { /* noop */ } char.ragdoll = null; }
  if (char.gripMarkers) { for (const m of char.gripMarkers) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } char.gripMarkers = null; }
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
    if (char === npc) {
      // ragdoll-editor の調整値(../ragdoll/<name>.ragdoll.json)があれば取り込む（暴れ防止）
      let ragOpts = { boundsMargin: 0.4, rigidBones: ['leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg'] };
      try {
        const rr = await fetch('../ragdoll/' + encodeURIComponent(name || '') + '.ragdoll.json');
        if (rr.ok) { const j = await rr.json(); ragOpts = { ...(j.params || {}), boneMaxBend: j.boneMaxBend || {}, boundsMargin: 0.4 }; showToast(`ラグドール設定: ${name}`); }
      } catch { /* 無ければ既定 */ }
      try { char.ragdoll = createRagdoll(vrm, ragOpts); } catch (e) { console.warn('ragdoll生成失敗:', e); char.ragdoll = null; }
    }
    populateBoneSelects();
    if (char === npc && !document.getElementById('ba-name').value) document.getElementById('ba-name').value = char.name;
    showToast(`${char.slot === 'player' ? 'プレイヤー' : 'NPC'} 読み込み: ${char.name}`);
  } finally { URL.revokeObjectURL(url); }
}

async function importBundleInto(char, bundle, name, opts = {}) {
  if (!bundle || !bundle.vrm) { showToast('VRMを含まないファイルです', 'error'); return; }
  await loadVRMInto(char, new File([dataURIToBlob(bundle.vrm)], `${name}.vrm`), name);
  // マント（cloth）があれば装着。ゲームと同じ lib/vrm-cloth。
  if (bundle.cloth && char.vrm) {
    try { char.cloth = createVRMCloth({ renderer, scene, vrm: char.vrm, cloth: bundle.cloth, basePos: char.spawn, floorY: 0, timeline: bundle.timeline }); applyClothSettings(); }
    catch (e) { console.warn('マント生成失敗:', e); char.cloth = null; }
  }
  // bundle に biteAlign が埋め込まれていれば読む（互換）。BiteAlign復元中は上書きしない。
  if (!opts.skipBiteAlign && char === npc && bundle.biteAlign) applyConfig(bundle.biteAlign);
}

// キャラ名(npc.json のベース名)から復元。BiteAlign 読込で両キャラを揃えるのに使う。
async function loadCharByName(char, name) {
  if (!name) return;
  try {
    const r = await fetch('../npc/' + encodeURIComponent(name) + '.npc.json');
    if (!r.ok) throw new Error('npc.json取得失敗');
    await importBundleInto(char, await r.json(), name, { skipBiteAlign: true });
    const sel = document.getElementById(char === player ? 'player-npc' : 'npc-npc');
    if (sel) sel.value = name + '.npc.json';
  } catch (e) { console.warn('キャラ復元失敗:', name, e); }
}

// BiteAlign(bite.json) を読み込む: 両キャラ本体→アライン設定→VRMA の順で復元。
async function loadBiteAlign(c) {
  if (c && c.player && c.player.target && player.name !== c.player.target) await loadCharByName(player, c.player.target);
  if (c && c.target && npc.name !== c.target) await loadCharByName(npc, c.target);
  applyConfig(c);
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

// ── ラグドール物理プレビュー（被食モード=ragdoll。噛点を口へ固定して垂らし、nudge を小突く）──
function frameCrossed(f, prev, cur) {
  if (prev <= cur) return f > prev && f <= cur;
  return f > prev || f <= cur;   // ループ折返し
}
function updateVictimRagdoll(dt) {
  if (!npc.ragdoll) return;
  const env = { floorY: 0, bounds: RAGDOLL_BOUNDS };
  if (mouthAnchorWorld(_mPos, _mQuat)) { env.pinBone = cfg.npc.biteBone || 'neck'; env.pinPos = _mPos; }
  updateRagdoll(npc.ragdoll, dt, env);
  npc.vrm.update(dt);
  const cf = curFrame();
  for (const n of biteNudges) {
    if (!frameCrossed(n.f, ragLastFrame, cf)) continue;
    const bone = (npc.ragdoll.idxOf[n.bone] != null) ? n.bone : 'chest';
    _nudgeV.set(n.dir[0] || 0, n.dir[1] || 0, n.dir[2] || 0).multiplyScalar(n.strength || 1);
    applyRagdollImpulse(npc.ragdoll, _nudgeV, bone);
  }
  ragLastFrame = cf;
}
function setRagdollPreview(on) {
  ragdollOn = !!on && cfg.npc.mode === 'ragdoll' && !!npc.ragdoll;
  const btn = document.getElementById('btn-ragdoll');
  if (btn) { btn.classList.toggle('toggle-on', ragdollOn); btn.textContent = ragdollOn ? '物理 ON' : '物理'; }
  if (npc.ragdoll) setRagdollActive(npc.ragdoll, ragdollOn);
  if (ragdollOn) ragLastFrame = curFrame();
  else if (npc.vrm) restNpc();
}

// マントのグラブ点（グリップ）をシーンに可視化。緑=非アクティブ, 黄=アクティブ。
function updateGripMarkers() {
  for (const c of [player, npc]) {
    const pts = (c.cloth && c.cloth.gripPoints) ? c.cloth.gripPoints() : [];
    if (!c.gripMarkers) c.gripMarkers = [];
    while (c.gripMarkers.length < pts.length) {
      const mk = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshBasicMaterial({ color: 0x44ffaa, transparent: true, opacity: 0.9, depthTest: false }));
      mk.renderOrder = 20; scene.add(mk); c.gripMarkers.push(mk);
    }
    for (let i = 0; i < c.gripMarkers.length; i++) {
      const mk = c.gripMarkers[i];
      if (i < pts.length) { mk.visible = true; mk.position.copy(pts[i].pos); mk.material.color.setHex(pts[i].active ? 0xffdd44 : 0x44ffaa); }
      else mk.visible = false;
    }
  }
}

// マントの硬さ/風をスライダー値で両キャラへ適用（顔に被る時は硬く・風を弱く）
function applyClothSettings() {
  const stEl = document.getElementById('cloth-stiff'), wdEl = document.getElementById('cloth-wind');
  const st = stEl ? parseFloat(stEl.value) : 0.3, wd = wdEl ? parseFloat(wdEl.value) : 0.5;
  for (const c of [player, npc]) if (c.cloth) { try { c.cloth.setStiffness(st); c.cloth.setWind(wd); } catch { /* noop */ } }
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
    autoKey('mouthOffset');
  } else if (editTarget === 'bite' && npc.vrm) {
    const node = boneNode(npc, 'bite'); if (!node) return;
    node.getWorldPosition(_bonePos); node.getWorldQuaternion(_boneQuat); _boneInv.copy(_boneQuat).invert();
    _sp.copy(handleBite.position).sub(_bonePos).applyQuaternion(_boneInv);
    cfg.npc.biteOffset = [_sp.x, _sp.y, _sp.z];
    syncOffsetSliders('bite');
    autoKey('biteOffset');
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
  if (c.npc) { cfg.npc.biteBone = c.npc.biteBone || cfg.npc.biteBone; if (Array.isArray(c.npc.biteOffset)) cfg.npc.biteOffset = c.npc.biteOffset.slice(); cfg.npc.mode = c.npc.mode || 'anim'; }
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
    cfg.anim.sound = c.anim.sound || '';
  }
  // UI 反映
  populateBoneSelects();
  syncOffsetSliders('mouth'); syncOffsetSliders('bite'); syncAlignSliders();
  document.getElementById('cb-loop-victim').checked = cfg.anim.loopVictim;
  { const s = document.getElementById('anim-sound'); if (s) s.value = cfg.anim.sound || ''; }
  loadTracks(c.tracks);   // キーフレーム（あれば）
  loadNudges(c.nudges);   // 小突き（あれば）
  { const s = document.getElementById('victim-mode'); if (s) s.value = cfg.npc.mode || 'anim'; }
  // アニメも読み込む
  if (cfg.anim.playerVrma) { document.getElementById('anim-player').value = cfg.anim.playerVrma; loadVrmaInto(player, cfg.anim.playerVrma).catch(e => console.warn(e)); }
  if (cfg.anim.victimVrma) { document.getElementById('anim-victim').value = cfg.anim.victimVrma; loadVrmaInto(npc, cfg.anim.victimVrma).catch(e => console.warn(e)); }
}

function buildConfigJson() {
  const out = {
    format: 'bite-align', version: 1,
    target: npc.name || '',
    player: { target: player.name || '', mouthBone: cfg.player.mouthBone, mouthOffset: cfg.player.mouthOffset.slice() },
    npc: { biteBone: cfg.npc.biteBone, biteOffset: cfg.npc.biteOffset.slice(), mode: cfg.npc.mode },
    align: { pos: cfg.align.pos.slice(), rotEuler: cfg.align.rotDeg.slice(), lock: cfg.align.lock, blendIn: cfg.align.blendIn, blendOut: cfg.align.blendOut },
    anim: { playerVrma: cfg.anim.playerVrma, victimVrma: cfg.anim.victimVrma, fps: FPS, trimIn: cfg.anim.trimIn, trimOut: cfg.anim.trimOut, loopVictim: cfg.anim.loopVictim, sound: cfg.anim.sound },
  };
  const tr = serializeTracks();
  if (tr) out.tracks = tr;   // 口/噛点/アラインのキーフレーム
  if (biteNudges.length) out.nudges = biteNudges.map(n => ({ f: n.f, bone: n.bone, dir: n.dir.slice(), strength: n.strength }));
  return out;
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
  fillManifest('/audio/manifest.json', 'anim-sound', f => f);

  document.getElementById('anim-player').addEventListener('change', e => { if (e.target.value) loadVrmaInto(player, e.target.value).catch(err => showToast(err.message, 'error')); });
  document.getElementById('anim-victim').addEventListener('change', e => { if (e.target.value) loadVrmaInto(npc, e.target.value).catch(err => showToast(err.message, 'error')); });
  document.getElementById('cb-loop-victim').addEventListener('change', e => { cfg.anim.loopVictim = e.target.checked; });
  // 効果音: 選択で保存対象に、▶で試聴/停止
  let _sndPreview = null;
  document.getElementById('anim-sound').addEventListener('change', e => { cfg.anim.sound = e.target.value; if (_sndPreview) { _sndPreview.pause(); _sndPreview = null; } });
  document.getElementById('anim-sound-play').addEventListener('click', () => {
    if (_sndPreview) { _sndPreview.pause(); _sndPreview = null; return; }
    if (!cfg.anim.sound) { showToast('効果音を選択してください', 'warn'); return; }
    _sndPreview = new Audio('/audio/' + encodeURIComponent(cfg.anim.sound));
    _sndPreview.play().catch(() => showToast('再生失敗', 'error'));
    _sndPreview.onended = () => { _sndPreview = null; };
  });

  // 再生
  document.getElementById('btn-play').addEventListener('click', play);
  document.getElementById('btn-pause').addEventListener('click', pause);
  document.getElementById('cb-loop').addEventListener('change', e => { loop = e.target.checked; });
  const spd = document.getElementById('speed'), spdV = document.getElementById('speed-val');
  spd.addEventListener('input', () => { speed = parseFloat(spd.value); spdV.textContent = `${speed.toFixed(2)}×`; });
  document.getElementById('scrub').addEventListener('input', e => { playing = false; playTime = (parseInt(e.target.value) || 0) / FPS; updatePlayButtons(); updateFrameLabel(); });
  setupTimelineCanvas();
  document.getElementById('btn-in').addEventListener('click', () => { cfg.anim.trimIn = Math.min(Math.round(playTime * FPS), cfg.anim.trimOut - 1); updateTrimLabel(); });
  document.getElementById('btn-out').addEventListener('click', () => { cfg.anim.trimOut = Math.max(Math.round(playTime * FPS), cfg.anim.trimIn + 1); updateTrimLabel(); });
  document.getElementById('btn-trim-reset').addEventListener('click', () => { cfg.anim.trimIn = 0; cfg.anim.trimOut = totalFrames(); updateTrimLabel(); });

  // 口 / 噛みつき点
  document.getElementById('mouth-bone').addEventListener('change', e => { cfg.player.mouthBone = e.target.value; });
  document.getElementById('bite-bone').addEventListener('change', e => { cfg.npc.biteBone = e.target.value; });
  document.getElementById('edit-mouth').addEventListener('click', () => { editTarget = 'mouth'; attachGizmo(); });
  document.getElementById('edit-bite').addEventListener('click', () => { editTarget = 'bite'; attachGizmo(); });
  for (const [i, ax] of ['x', 'y', 'z'].entries()) {
    bindSlider(`mouth-${ax}`, v => { cfg.player.mouthOffset[i] = v; autoKey('mouthOffset'); }, v => v.toFixed(3));
    bindSlider(`bite-${ax}`, v => { cfg.npc.biteOffset[i] = v; autoKey('biteOffset'); }, v => v.toFixed(3));
  }
  for (const g of ['mouth', 'bite', 'align']) {
    document.getElementById('key-' + g)?.addEventListener('click', () => setKeyGroup(g));
    document.getElementById('unkey-' + g)?.addEventListener('click', () => delKeyGroup(g));
  }
  // 被食モード / 小突き（ラグドール時）
  document.getElementById('victim-mode')?.addEventListener('change', e => { cfg.npc.mode = e.target.value; if (cfg.npc.mode !== 'ragdoll') setRagdollPreview(false); });
  document.getElementById('btn-ragdoll')?.addEventListener('click', () => setRagdollPreview(!ragdollOn));
  { const sel = document.getElementById('nudge-bone'); if (sel) for (const b of NUDGE_BONES) { const o = document.createElement('option'); o.value = b; o.textContent = b; sel.appendChild(o); } }
  document.getElementById('nudge-add')?.addEventListener('click', addNudge);
  document.getElementById('nudge-del')?.addEventListener('click', delNudge);
  // マント物理（プレビュー）
  bindSlider('cloth-stiff', () => applyClothSettings(), v => v.toFixed(2));
  bindSlider('cloth-wind', () => applyClothSettings(), v => v.toFixed(2));

  // アライン
  const snapBtn = document.getElementById('btn-snap');
  snapBtn.addEventListener('click', () => { snap = !snap; snapBtn.classList.toggle('snap-on', snap); snapBtn.textContent = snap ? '● Snap ON' : '○ Snap OFF'; if (!snap) restNpc(); });
  for (const [i, ax] of ['x', 'y', 'z'].entries()) bindSlider(`al-${ax}`, v => { cfg.align.pos[i] = v; autoKey('alignPos'); }, v => v.toFixed(3));
  for (const [i, ax] of ['rx', 'ry', 'rz'].entries()) bindSlider(`al-${ax}`, v => { cfg.align.rotDeg[i] = v; autoKey('alignRot'); }, v => String(Math.round(v)));

  // BiteAlign 読込 / 保存
  document.getElementById('ba-select').addEventListener('change', async e => {
    if (!e.target.value) return;
    try { const r = await fetch('/bitealign/' + e.target.value); if (!r.ok) throw new Error('取得失敗'); await loadBiteAlign(await r.json()); showToast(`読込: ${e.target.value}`); }
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
  const ragPreview = ragdollOn && cfg.npc.mode === 'ragdoll' && npc.vrm && npc.ragdoll;

  applyPoseAt(playTime);
  if (player.vrm) player.vrm.update(dt);
  if (!ragPreview && npc.vrm) npc.vrm.update(dt);   // ラグドール中は VRMA で上書きしない

  // キーフレーム値を cfg へ反映（フレーム変化時のみ＝編集中の上書きを防ぐ）
  const kf = curFrame();
  if (kf !== lastKeyFrame) { applyTracksAt(kf); lastKeyFrame = kf; }

  // アライン / ラグドール物理
  if (ragPreview) updateVictimRagdoll(dt);
  else if (snap) applySnap(); else restNpc();

  // マント（クロス）
  const cf = curFrame();
  if (player.cloth) player.cloth.update(dt, cf);
  if (npc.cloth) npc.cloth.update(dt, cf);
  updateGripMarkers();

  anchorFollow();
  updateGap();
  drawTimeline();
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
