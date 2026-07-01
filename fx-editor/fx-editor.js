// fx-editor.js — エフェクト・タイムライン編集
// 地面＋壁の小部屋に NPC を1体置き、timeline(VRMA)を再生しながら
// タイムライン上の任意フレームでエフェクトを発生させ、発生位置をギズモで移動/回転する。
//
// エフェクトは lib/fx-particles.js のプリセット(fire/smoke/spark/frost)を使用。
// 各エフェクトは timeline.json に kind:'effect' トラックとして埋め込む
//   （cloth-preview の importTimeline は未知 kind を無視するため互換）。
//   tps-flight 等はこの effect トラックを読んで再生できる。
//
// エフェクト基準: 'world'（ギズモで置いた絶対位置に固定）/ 'bone'（NPCのボーン追従＝ローカルオフセット）
// 発生種類:       'burst'（指定1フレームで単発）/ 'range'（開始〜終了フレームで持続発生）

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { positionWorld, mix, color, pass } from 'https://esm.sh/three@0.184.0/tsl';
import { bloom } from 'https://esm.sh/three@0.184.0/examples/jsm/tsl/display/BloomNode.js';
import { OrbitControls }    from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader }       from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { createTornado } from '../lib/fx-tornado.js';
import { createMeshFx } from '../lib/fx-mesh.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';

// ── シーングローバル ─────────────────────────────────────────────
let renderer, scene, camera, controls;
const timer = new THREE.Timer();
let currentVRM = null;
let currentCloth = null;        // マント布シミュ（createVRMCloth）。NPCバンドルに cloth があれば生成。
let loadedTimelineJson = null;  // 直近に読み込んだ timeline 生データ（布グリップ再適用用）
const clothParams = { wind: 1.0, stiffness: 0.2 };

// ── VRMA プレイヤー ──────────────────────────────────────────────
let mixer = null, vrmaClip = null, vrmaAction = null;
let vrmaPlaying = false, vrmaLoop = true;
let currentVrmaName = '';   // public/vrma 基準のファイル名。timeline.json に保存。

// ── タイムライン状態 ─────────────────────────────────────────────
const timeline = {
  fps: 30, durationFrames: 90, currentFrame: 0,
  trimIn: 0, trimOut: 90, speed: 1,
};
let lastTlName = '';
let lastBundleName = '';
let otherTracks = [];   // 読み込んだ effect 以外のトラック（grip/blendShape等）を保持して再保存時に温存

// ── エフェクト ───────────────────────────────────────────────────
// ef: { id, preset, mode:'burst'|'range', frame, start, end, anchor:'world'|'bone', bone, pos:[3], rot:[3]deg, count, fx, object3D }
const effects = [];
let selectedEffectId = null;
let nextEffectId = 1;
const PRESET_COLORS = { fire: '#ff8844', smoke: '#9aa0b0', spark: '#ffd060', frost: '#66ccff', tornado: '#ff8b4d' };

// プリセット別の調整パラメータ定義（エディタが汎用的にUIを生成。default は適用前の初期値）
function particleParamDefs(preset) {
  const p = FX_PRESETS[preset];
  return [
    { key: 'colorStart', label: '開始色', type: 'color', default: p.color.start },
    { key: 'colorEnd',   label: '終了色', type: 'color', default: p.color.end },
    { key: 'spawnRate',  label: '発生/秒', type: 'range', min: 0, max: 200, step: 1, default: p.spawnRate },
    { key: 'sizeStart',  label: '開始サイズ', type: 'range', min: 0.02, max: 1.5, step: 0.01, default: p.size.start },
    { key: 'sizeEnd',    label: '終了サイズ', type: 'range', min: 0.02, max: 1.5, step: 0.01, default: p.size.end },
  ];
}
const FX_PARAM_DEFS = {
  tornado: [
    { key: 'color',            label: '色',      type: 'color', default: '#ff8b4d' },
    { key: 'timeScale',        label: '回転速度', type: 'range', min: -1, max: 1, step: 0.01, default: 0.2 },
    { key: 'parabolStrength',  label: '広がり',   type: 'range', min: 0, max: 2, step: 0.01, default: 1 },
    { key: 'parabolOffset',    label: '中心高',   type: 'range', min: 0, max: 1, step: 0.01, default: 0.3 },
    { key: 'parabolAmplitude', label: '太さ',     type: 'range', min: 0, max: 2, step: 0.01, default: 0.2 },
    { key: 'scale',            label: 'サイズ',   type: 'range', min: 0.2, max: 6, step: 0.1, default: 1.5 },
  ],
  fire:  particleParamDefs('fire'),
  smoke: particleParamDefs('smoke'),
  spark: particleParamDefs('spark'),
  frost: particleParamDefs('frost'),
};
function defaultParams(preset) {
  const out = {};
  for (const d of (FX_PARAM_DEFS[preset] || [])) out[d.key] = d.default;
  return out;
}
// 粒子プリセットの config にパラメータを反映
function applyParticleParams(cfg, params) {
  if (params.colorStart != null) cfg.color.start = params.colorStart;
  if (params.colorEnd   != null) cfg.color.end   = params.colorEnd;
  if (params.spawnRate  != null) cfg.spawnRate   = params.spawnRate;
  if (params.sizeStart  != null) cfg.size.start  = params.sizeStart;
  if (params.sizeEnd    != null) cfg.size.end    = params.sizeEnd;
}

// ── Bloom（ポストプロセス。シーン全体・emissive が強く発光）──
let post = null, bloomPass = null;
const bloomParams = { strength: 1.0, radius: 0.1, threshold: 1.0 };

// ── カスタムプリセット（fx-builder が作った *.fx.json）。'custom:<name>' で参照 ──
const customSpecs = new Map();
function isPersistentPreset(preset) { return preset === 'tornado' || preset.startsWith('custom:'); }
const ANCHOR_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

// ── ギズモ（選択エフェクトの発生位置ハンドル）─────────────────────
let gizmo = null;
let handle = null;         // scene 直下に置くワールド空間ハンドル
let gizmoMode = 'translate';

// ── タイムライン Canvas 状態 ─────────────────────────────────────
let tlPxPerFrame = 8;
let tlScrollX = 0;
const HEADER_W = 150;
const ROW_H = 22;
const RULER_H = 24;
const TRIM_HANDLE_W = 9;

// ── FPS ──────────────────────────────────────────────────────────
let fpsFrameCount = 0, fpsLastTime = performance.now();

// ── 再利用テンポラリ ─────────────────────────────────────────────
const _sp = new THREE.Vector3(), _sq = new THREE.Quaternion(), _se = new THREE.Euler();
const _tq = new THREE.Quaternion();   // computeSpawnTransform 内部用（outQuat との別名衝突回避）
const _bonePos = new THREE.Vector3(), _boneQuat = new THREE.Quaternion(), _boneInv = new THREE.Quaternion();
const D2R = THREE.MathUtils.degToRad, R2D = THREE.MathUtils.radToDeg;
const _fv = new THREE.Vector3(), _phDir = new THREE.Vector3();

// ── 物理テスト（弾＝物理ボール。基準点から発射→壁/床でバウンド。着弾で効果・力をテスト）──
const PROOM = { s: 12, h: 3.2 };   // buildRoom と一致（床y=0, 壁±6, 天井3.2）
const physBalls = [];              // { mesh, pos, vel, radius }
const phys = { count: 1, gravity: -4, restitution: 0.5, radius: 0.14, speed: 8, pitch: 0, yaw: 0 };
const PHYS_SPAWN = new THREE.Vector3(0, 1.2, -4);   // 基準点（手前から前方+Zへ）

// ============================================================
// 部屋（地面＋壁）
// ============================================================
function buildRoom() {
  const S = 12, H = 3.2, t = 0.2;
  const group = new THREE.Group();
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2e44, roughness: 0.95 });
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0x343a58, roughness: 0.9, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(S, t, S), floorMat);
  floor.position.y = -t / 2;
  group.add(floor);
  const grid = new THREE.GridHelper(S, S, 0x4488ff, 0x2a3050);
  grid.material.transparent = true; grid.material.opacity = 0.35; grid.position.y = 0.002;
  group.add(grid);
  const wall = (x, z, w) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, H, t), wallMat);
    m.position.set(x, H / 2, z); return m;
  };
  group.add(wall(0, -S / 2, S));
  const back = wall(0, S / 2, S); group.add(back);
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, H, S), wallMat);  left.position.set(-S / 2, H / 2, 0); group.add(left);
  const right = new THREE.Mesh(new THREE.BoxGeometry(t, H, S), wallMat); right.position.set(S / 2, H / 2, 0); group.add(right);
  scene.add(group);
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

async function loadVRM(file) {
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }),
  }));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');
    unloadVRM();
    currentVRM = vrm;
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    populateBoneSelects(vrm);
    document.getElementById('btn-vrma-load').disabled = false;
    document.getElementById('vrma-select').disabled = false;
    showToast('VRM 読み込み完了');
    return vrm;
  } finally { URL.revokeObjectURL(url); }
}

function unloadVRM() {
  if (!currentVRM) return;
  unloadVRMA();
  if (currentCloth) { currentCloth.dispose(); currentCloth = null; }
  scene.remove(currentVRM.scene);
  currentVRM.scene.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose();
    }
  });
  currentVRM = null;
  document.getElementById('btn-vrma-load').disabled = true;
  document.getElementById('vrma-select').disabled = true;
}

async function importNPCBundle(bundle) {
  if (!bundle || !bundle.vrm) { showToast('VRM を含まないファイルです', 'error'); return; }
  const name = bundle.name || 'imported';
  lastBundleName = name;
  await loadVRM(new File([dataURIToBlob(bundle.vrm)], `${name}.vrm`, { type: 'application/octet-stream' }));
  // マント（布）。NPC に cloth があれば着せる。NPCは原点・floorY=0。
  if (bundle.cloth) {
    try {
      currentCloth = createVRMCloth({
        renderer, scene, vrm: currentVRM, cloth: bundle.cloth,
        basePos: new THREE.Vector3(0, 0, 0), floorY: 0,
        wind: clothParams.wind, stiffness: clothParams.stiffness,
      });
      // すでに timeline 読込済みなら、その grip を布へ適用
      if (loadedTimelineJson) currentCloth.setTimeline(loadedTimelineJson);
    } catch (e) { console.warn('マント生成失敗:', e); showToast('マント生成失敗（布データ不正）', 'warn'); }
  }
  const parts = ['VRM', bundle.cloth ? 'マント' : null].filter(Boolean);
  showToast(`NPC読み込み完了（${parts.join(' + ')}）`);
}

function populateBoneSelects(vrm) {
  const present = ANCHOR_BONES.filter(b => vrm.humanoid?.getNormalizedBoneNode(b));
  for (const id of ['add-bone', 'sel-bone']) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const b of present) {
      const o = document.createElement('option'); o.value = b; o.textContent = b; sel.appendChild(o);
    }
    if (present.includes(prev)) sel.value = prev;
    else if (present.includes('rightHand')) sel.value = 'rightHand';
  }
}

// ============================================================
// VRMA プレイヤー（トリム再生）
// ============================================================
// ルートモーション除去：position トラックの水平(X,Z)をフレーム0で固定（NPCを中央に保つ）。
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (!t.name.endsWith('.position')) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
}

async function loadVrmaByName(name) {
  try {
    const res = await fetch('/vrma/' + encodeURIComponent(name));
    if (!res.ok) throw new Error('取得失敗');
    await loadVRMA(new File([await res.blob()], name, { type: 'application/octet-stream' }), name);
    const sel = document.getElementById('vrma-select'); if (sel) sel.value = name;
  } catch (err) { showToast(`VRMA自動読込失敗: ${name}`, 'warn'); console.warn(err); }
}

async function loadVRMA(file, srcName) {
  if (!currentVRM) { showToast('先にVRM/NPCを読み込んでください', 'error'); return; }
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrmAnims = gltf.userData.vrmAnimations;
    if (!vrmAnims?.length) throw new Error('VRMAアニメーションデータが見つかりません');
    unloadVRMA();
    currentVrmaName = srcName || '';
    vrmaClip = createVRMAnimationClip(vrmAnims[0], currentVRM);
    stripRootMotion(vrmaClip);
    mixer = new THREE.AnimationMixer(currentVRM.scene);
    vrmaAction = mixer.clipAction(vrmaClip);
    vrmaAction.timeScale = 1.0;
    vrmaSetLoop(vrmaLoop);
    vrmaAction.play();
    vrmaAction.paused = true;
    timeline.durationFrames = Math.round(vrmaClip.duration * timeline.fps);
    timeline.trimIn = 0; timeline.trimOut = timeline.durationFrames;
    document.getElementById('lbl-duration').textContent = timeline.durationFrames.toString();
    updateTrimLabel();
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-pause').disabled = false;
    renderTimeline();
    showToast(`VRMA 読み込み完了 (${timeline.durationFrames}フレーム)`);
  } finally { URL.revokeObjectURL(url); }
}

function vrmaPlay() {
  if (!mixer || !vrmaAction || vrmaPlaying) return;
  if (timeline.currentFrame < timeline.trimIn || timeline.currentFrame >= timeline.trimOut) vrmaSeek(timeline.trimIn);
  vrmaPlaying = true; vrmaAction.paused = false;
  updatePlayButtons();
}
function vrmaPause() {
  if (!vrmaPlaying) return;
  vrmaPlaying = false; if (vrmaAction) vrmaAction.paused = true;
  updatePlayButtons();
}
function vrmaSeek(frame) {
  const f = Math.max(0, Math.min(frame, timeline.durationFrames));
  timeline.currentFrame = f;
  if (mixer && vrmaAction && vrmaClip) {
    vrmaAction.time = Math.min(f / timeline.fps, vrmaClip.duration);
    mixer.update(0);
  }
  updateFrameLabel();
  renderTimeline();
}
function vrmaSetSpeed(s) { timeline.speed = s; if (vrmaAction) vrmaAction.timeScale = s; }
function vrmaSetLoop(on) {
  vrmaLoop = on;
  if (vrmaAction) { vrmaAction.setLoop(THREE.LoopRepeat, Infinity); vrmaAction.clampWhenFinished = false; }
}
function unloadVRMA() {
  if (vrmaAction) vrmaAction.stop();
  if (mixer) mixer.stopAllAction();
  mixer = null; vrmaClip = null; vrmaAction = null; vrmaPlaying = false;
  document.getElementById('btn-play').disabled = true;
  document.getElementById('btn-pause').disabled = true;
}
function updatePlayButtons() {
  document.getElementById('btn-play').disabled = !mixer || vrmaPlaying;
  document.getElementById('btn-pause').disabled = !mixer || !vrmaPlaying;
}

// ============================================================
// エフェクト
// ============================================================
function makeFx(preset, params) {
  // tornado=TSL VFX / custom:*=fx-builder のメッシュVFX / それ以外=スプライト粒子。
  let fx;
  if (preset === 'tornado') {
    fx = createTornado({
      color: params.color, timeScale: params.timeScale,
      parabolStrength: params.parabolStrength, parabolOffset: params.parabolOffset,
      parabolAmplitude: params.parabolAmplitude, scale: params.scale,
    });
  } else if (preset.startsWith('custom:')) {
    const spec = customSpecs.get(preset);
    fx = spec ? createMeshFx(spec) : createFxSystem(cloneFxConfig(FX_PRESETS.fire));
  } else {
    const cfg = cloneFxConfig(FX_PRESETS[preset] || FX_PRESETS.fire);
    applyParticleParams(cfg, params);
    fx = createFxSystem(cfg);
  }
  fx.setEmitting(false);
  scene.add(fx.object3D);
  return fx;
}

// パラメータをライブ反映（tornado=uniform直接 / 粒子=config再設定）
function applyEffectParam(ef, key, value) {
  ef.params[key] = value;
  if (ef.preset === 'tornado') {
    ef.fx.setParam(key, value);
  } else {
    const cfg = cloneFxConfig(FX_PRESETS[ef.preset] || FX_PRESETS.fire);
    applyParticleParams(cfg, ef.params);
    ef.fx.setConfig(cfg);
  }
}

function createEffect(opts) {
  const preset = opts.preset || 'fire';
  // tornado/custom は持続VFXなので range（期間）固定。単発指定でも range に寄せる。
  const mode = isPersistentPreset(preset) ? 'range' : (opts.mode || 'burst');
  // 調整パラメータ：プリセット既定 ＋ 保存値で上書き
  const params = defaultParams(preset);
  if (opts.params) for (const k in opts.params) if (k in params) params[k] = opts.params[k];
  const ef = {
    id: opts.id ?? nextEffectId,
    preset,
    mode,
    frame: opts.frame ?? timeline.currentFrame,
    start: opts.start ?? timeline.currentFrame,
    end: opts.end ?? Math.min(timeline.durationFrames, timeline.currentFrame + 15),
    anchor: opts.anchor || 'world',
    bone: opts.bone || 'rightHand',
    pos: opts.pos ? opts.pos.slice() : defaultSpawnPos(opts.anchor || 'world'),
    rot: opts.rot ? opts.rot.slice() : [0, 0, 0],
    count: opts.count ?? 24,
    onImpact: !!opts.onImpact,                 // 弾の着弾で発生
    force: opts.force ?? 0,                     // 発生時に物理ボールへ加える力
    forceRadius: opts.forceRadius ?? 2,
    _impactCd: 0,
    params,
    fx: makeFx(preset, params),
  };
  ef.object3D = ef.fx.object3D;
  if (ef.id >= nextEffectId) nextEffectId = ef.id + 1;
  effects.push(ef);
  return ef;
}

// world 基準の初期発生位置（NPC前方・腰高さあたり）/ bone 基準は原点オフセット
function defaultSpawnPos(anchor) {
  return anchor === 'bone' ? [0, 0, 0] : [0, 1.0, 0.4];
}

function removeEffect(id) {
  const i = effects.findIndex(e => e.id === id);
  if (i < 0) return;
  const ef = effects[i];
  scene.remove(ef.object3D);
  ef.fx.dispose();
  effects.splice(i, 1);
  if (selectedEffectId === id) selectEffect(null);
  rebuildFxList();
  renderTimeline();
}

function clearEffects() {
  for (const ef of effects) { scene.remove(ef.object3D); ef.fx.dispose(); }
  effects.length = 0;
  selectEffect(null);
}

function selectedEffect() { return effects.find(e => e.id === selectedEffectId) || null; }

function selectEffect(id) {
  selectedEffectId = id;
  const ef = selectedEffect();
  const editor = document.getElementById('sel-editor');
  document.getElementById('btn-test-fire').disabled = !ef;
  if (!ef) {
    editor.style.display = 'none';
    if (gizmo) gizmo.detach();
    if (handle) handle.visible = false;
    rebuildFxList();
    return;
  }
  editor.style.display = 'block';
  // ハンドルを発生位置へ
  computeSpawnTransform(ef, _sp, _sq);
  handle.position.copy(_sp);
  handle.quaternion.copy(_sq);
  handle.visible = true;
  gizmo.attach(handle);
  gizmo.setMode(gizmoMode);
  syncSelEditor();
  rebuildParamUI(ef);
  rebuildFxList();
}

// 発生位置のワールド変換を算出（anchor に応じて）
function computeSpawnTransform(ef, outPos, outQuat) {
  _se.set(D2R(ef.rot[0]), D2R(ef.rot[1]), D2R(ef.rot[2]));
  if (ef.anchor === 'object' && physBalls.length) {
    outPos.set(ef.pos[0], ef.pos[1], ef.pos[2]).add(physBalls[0].pos);   // 弾に追従（オフセット付き）
    outQuat.setFromEuler(_se);
    return;
  }
  if (ef.anchor === 'bone' && currentVRM) {
    const node = currentVRM.humanoid?.getNormalizedBoneNode(ef.bone);
    if (node) {
      node.updateWorldMatrix(true, false);
      node.getWorldPosition(_bonePos);
      node.getWorldQuaternion(_boneQuat);
      outQuat.copy(_boneQuat).multiply(_tq.setFromEuler(_se));
      outPos.set(ef.pos[0], ef.pos[1], ef.pos[2]).applyQuaternion(_boneQuat).add(_bonePos);
      return;
    }
  }
  outPos.set(ef.pos[0], ef.pos[1], ef.pos[2]);
  outQuat.setFromEuler(_se);
}

// ギズモ操作 → 選択エフェクトの pos/rot（基準相対）へ書き戻し
function onGizmoChange() {
  const ef = selectedEffect();
  if (!ef) return;
  if (ef.anchor === 'bone' && currentVRM) {
    const node = currentVRM.humanoid?.getNormalizedBoneNode(ef.bone);
    if (node) {
      node.getWorldPosition(_bonePos);
      node.getWorldQuaternion(_boneQuat);
      _boneInv.copy(_boneQuat).invert();
      _sp.copy(handle.position).sub(_bonePos).applyQuaternion(_boneInv);
      ef.pos = [_sp.x, _sp.y, _sp.z];
      _sq.copy(_boneInv).multiply(handle.quaternion);
      _se.setFromQuaternion(_sq);
      ef.rot = [R2D(_se.x), R2D(_se.y), R2D(_se.z)];
      syncSelEditor();
      return;
    }
  }
  ef.pos = [handle.position.x, handle.position.y, handle.position.z];
  _se.setFromQuaternion(handle.quaternion);
  ef.rot = [R2D(_se.x), R2D(_se.y), R2D(_se.z)];
  syncSelEditor();
}

// bone 基準の選択ハンドルを毎フレームボーンへ追従（ドラッグ中は除く）
function syncSelectedHandle() {
  if (!handle || !handle.visible || (gizmo && gizmo.dragging)) return;
  const ef = selectedEffect();
  if (!ef || ef.anchor !== 'bone') return;
  computeSpawnTransform(ef, _sp, _sq);
  handle.position.copy(_sp);
  handle.quaternion.copy(_sq);
}

// 単発バーストを prev<frame<=cur の範囲で発火
function fireBurstsBetween(prev, cur) {
  for (const ef of effects) {
    if (ef.mode !== 'burst') continue;
    if (ef.frame > prev && ef.frame <= cur) {
      computeSpawnTransform(ef, _sp, _sq);
      ef.object3D.position.copy(_sp); ef.object3D.quaternion.copy(_sq);
      ef.fx.burst(ef.count);
      applyEffectForce(ef, _sp);   // 発生時に力
    }
  }
}

function updateEffects(dt) {
  const f = timeline.currentFrame;
  for (const ef of effects) {
    if (ef._impactCd > 0) ef._impactCd -= dt;
    if (ef.onImpact) { ef.fx.update(dt); continue; }   // 着弾系は onPhysImpact 側で配置・発生
    computeSpawnTransform(ef, _sp, _sq);
    ef.object3D.position.copy(_sp);
    ef.object3D.quaternion.copy(_sq);
    let emit = ef.mode === 'range' && f >= ef.start && f <= ef.end;
    if (ef.anchor === 'object') emit = physBalls.length ? physBalls[0].vel.lengthSq() > 0.25 : false;   // 弾が動いている間トレイル
    ef.fx.setEmitting(emit);
    ef.fx.update(dt);
  }
}

// ============================================================
// 物理テスト（弾・着弾・力）
// ============================================================
function clearPhysBalls() { for (const b of physBalls) scene.remove(b.mesh); physBalls.length = 0; }

function setPhysBalls(n) {
  clearPhysBalls();
  const geom = new THREE.SphereGeometry(phys.radius, 16, 12);
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0x442200, roughness: 0.4, metalness: 0.2 }));
    const a = n > 1 ? (i / n) * Math.PI * 2 : 0;
    const pos = new THREE.Vector3(Math.cos(a) * (n > 1 ? 1.2 : 0), phys.radius, Math.sin(a) * (n > 1 ? 1.2 : 0)).add(n > 1 ? new THREE.Vector3(0, 0, 0) : PHYS_SPAWN.clone().setY(phys.radius));
    mesh.position.copy(pos);
    scene.add(mesh);
    physBalls.push({ mesh, pos, vel: new THREE.Vector3(), radius: phys.radius });
  }
}

// 基準点から前方(+Z を pitch/yaw で回した向き)へ発射
function launchPhys() {
  if (!physBalls.length) setPhysBalls(phys.count);
  const cp = Math.cos(D2R(phys.pitch)), sp = Math.sin(D2R(phys.pitch)), cy = Math.cos(D2R(phys.yaw)), sy = Math.sin(D2R(phys.yaw));
  _phDir.set(cp * sy, sp, cp * cy).normalize();
  for (const b of physBalls) {
    b.pos.copy(PHYS_SPAWN);
    b.vel.copy(_phDir).multiplyScalar(phys.speed);
    b.vel.x += (Math.random() - 0.5) * phys.speed * 0.08;
    b.vel.y += (Math.random() - 0.5) * phys.speed * 0.04;
    b.mesh.position.copy(b.pos);
  }
}

function updatePhysics(dt) {
  if (!physBalls.length) return;
  const hs = PROOM.s / 2, ceil = PROOM.h, e = phys.restitution;
  for (const b of physBalls) {
    b.vel.y += phys.gravity * dt;
    b.pos.addScaledVector(b.vel, dt);
    const r = b.radius, pre = b.vel.length();
    let hit = false;
    if (b.pos.y < r)        { b.pos.y = r;        if (b.vel.y < 0) { b.vel.y = -b.vel.y * e; b.vel.x *= 0.8; b.vel.z *= 0.8; hit = true; } }
    else if (b.pos.y > ceil - r) { b.pos.y = ceil - r; if (b.vel.y > 0) { b.vel.y = -b.vel.y * e; hit = true; } }
    if (b.pos.x < -hs + r)  { b.pos.x = -hs + r;  if (b.vel.x < 0) { b.vel.x = -b.vel.x * e; hit = true; } }
    else if (b.pos.x > hs - r) { b.pos.x = hs - r; if (b.vel.x > 0) { b.vel.x = -b.vel.x * e; hit = true; } }
    if (b.pos.z < -hs + r)  { b.pos.z = -hs + r;  if (b.vel.z < 0) { b.vel.z = -b.vel.z * e; hit = true; } }
    else if (b.pos.z > hs - r) { b.pos.z = hs - r; if (b.vel.z > 0) { b.vel.z = -b.vel.z * e; hit = true; } }
    if (hit && pre > 1.5) onPhysImpact(b.pos);   // 静止ジッタでは発生させない（一定速度以上のみ）
    b.mesh.position.copy(b.pos);
  }
}

// 着弾：onImpact エフェクトを衝突点で1回発生＋力を適用
function onPhysImpact(point) {
  for (const ef of effects) {
    if (!ef.onImpact || ef._impactCd > 0) continue;
    ef.object3D.position.copy(point);
    ef.object3D.quaternion.identity();
    ef.object3D.visible = true;
    ef.fx.burst(ef.count || 12);
    applyEffectForce(ef, point);
    ef._impactCd = 0.12;   // 連続着弾の多重発火を抑制
  }
}

// エフェクト発生時、範囲内の物理ボールへ中心から外向きの力
function applyEffectForce(ef, center) {
  if (!ef.force || ef.force <= 0) return;
  const R = ef.forceRadius || 2;
  for (const b of physBalls) {
    _fv.copy(b.pos).sub(center);
    const d = _fv.length();
    if (d < R && d > 1e-3) { _fv.multiplyScalar(1 / d); b.vel.addScaledVector(_fv, ef.force * (1 - d / R)); }
  }
}

// ============================================================
// 右パネル：一覧 + 選択エディタ
// ============================================================
function fxLabel(ef) {
  const m = ef.mode === 'burst' ? `@${ef.frame}` : `${ef.start}–${ef.end}`;
  const a = ef.anchor === 'bone' ? ef.bone : 'world';
  return `${ef.preset} ${m} (${a})`;
}

function rebuildFxList() {
  const list = document.getElementById('fx-list');
  list.innerHTML = '';
  if (!effects.length) {
    const e = document.createElement('div'); e.id = 'fx-empty'; e.textContent = 'エフェクトはまだありません';
    list.appendChild(e); return;
  }
  for (const ef of effects) {
    const item = document.createElement('div');
    item.className = 'fx-item' + (ef.id === selectedEffectId ? ' sel' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = PRESET_COLORS[ef.preset] || '#fff';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = fxLabel(ef);
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕';
    del.title = '削除';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeEffect(ef.id); });
    item.appendChild(dot); item.appendChild(nm); item.appendChild(del);
    item.addEventListener('click', () => selectEffect(ef.id));
    list.appendChild(item);
  }
}

function syncSelEditor() {
  const ef = selectedEffect();
  if (!ef) return;
  document.getElementById('sel-preset').value = ef.preset;
  document.getElementById('sel-anchor').value = ef.anchor;
  document.getElementById('sel-bone-row').style.display = ef.anchor === 'bone' ? 'flex' : 'none';
  document.getElementById('sel-bone').value = ef.bone;
  document.getElementById('sel-frame-row').style.display = ef.mode === 'burst' ? 'flex' : 'none';
  document.getElementById('sel-range-row').style.display = ef.mode === 'range' ? 'flex' : 'none';
  document.getElementById('sel-count-row').style.display = ef.mode === 'burst' ? 'flex' : 'none';
  document.getElementById('sel-frame').value = ef.frame;
  document.getElementById('sel-start').value = ef.start;
  document.getElementById('sel-end').value = ef.end;
  document.getElementById('sel-count').value = ef.count;
}

function setGizmoMode(mode) {
  gizmoMode = mode;
  if (gizmo) gizmo.setMode(mode);
  document.getElementById('btn-gz-move').classList.toggle('toggle-on', mode === 'translate');
  document.getElementById('btn-gz-rot').classList.toggle('toggle-on', mode === 'rotate');
}

// プリセット変更時は fx を作り直す
function changePreset(ef, preset) {
  if (ef.preset === preset) return;
  scene.remove(ef.object3D); ef.fx.dispose();
  ef.preset = preset;
  ef.params = defaultParams(preset);
  ef.fx = makeFx(preset, ef.params);
  ef.object3D = ef.fx.object3D;
  if (isPersistentPreset(preset) && ef.mode !== 'range') {
    ef.mode = 'range';
    if (ef.end <= ef.start) ef.end = Math.min(timeline.durationFrames, ef.start + 15);
  }
  syncSelEditor();
  rebuildParamUI(ef);
}

// 選択エフェクトの調整パラメータUI（プリセット別スライダー/カラー）を生成
function rebuildParamUI(ef) {
  const host = document.getElementById('sel-params');
  if (!host) return;
  host.innerHTML = '';
  for (const d of (FX_PARAM_DEFS[ef.preset] || [])) {
    const row = document.createElement('div'); row.className = 'row';
    const lab = document.createElement('label'); lab.textContent = d.label; row.appendChild(lab);
    if (d.type === 'color') {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = ef.params[d.key];
      inp.style.cssText = 'width:40px;height:22px;padding:0;border:1px solid #3a3a60;background:#16162c;cursor:pointer;';
      inp.addEventListener('input', () => applyEffectParam(ef, d.key, inp.value));
      row.appendChild(inp);
    } else {
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = d.min; inp.max = d.max; inp.step = d.step; inp.value = ef.params[d.key];
      inp.style.flex = '1';
      const val = document.createElement('span'); val.className = 'val'; val.textContent = Number(ef.params[d.key]).toFixed(2);
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = v.toFixed(2); applyEffectParam(ef, d.key, v); });
      row.appendChild(inp); row.appendChild(val);
    }
    host.appendChild(row);
  }
}

// ============================================================
// タイムライン Canvas
// ============================================================
function frameToX(frame) { return HEADER_W + frame * tlPxPerFrame - tlScrollX; }
function xToFrame(x) { return Math.round((x - HEADER_W + tlScrollX) / tlPxPerFrame); }
function rowToY(rowIdx) { return RULER_H + rowIdx * ROW_H; }
function maxScrollX() {
  const canvas = document.getElementById('timeline');
  const visible = (canvas?.width ?? 0) - HEADER_W;
  const content = (timeline.durationFrames + 5) * tlPxPerFrame;
  return Math.max(0, content - visible);
}

function renderTimeline() {
  const canvas = document.getElementById('timeline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#08081a'; ctx.fillRect(0, 0, W, H);

  // フレームグリッド
  const startF = Math.max(0, Math.floor(tlScrollX / tlPxPerFrame));
  const endF = Math.ceil((tlScrollX + W - HEADER_W) / tlPxPerFrame);
  for (let f = startF; f <= endF; f++) {
    const x = frameToX(f);
    if (x < HEADER_W) continue;
    if (f % 10 === 0) { ctx.strokeStyle = '#1c1c32'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke(); }
    else if (tlPxPerFrame >= 12 && f % 5 === 0) { ctx.strokeStyle = '#14142a'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke(); }
  }

  // エフェクト行
  effects.forEach((ef, ri) => {
    const y = rowToY(ri);
    const sel = ef.id === selectedEffectId;
    ctx.fillStyle = sel ? '#1a2240' : (ri % 2 === 0 ? '#0d0d20' : '#0f0f25');
    ctx.fillRect(HEADER_W, y, W - HEADER_W, ROW_H);
    ctx.fillStyle = sel ? '#141d38' : '#0a0a18';
    ctx.fillRect(0, y, HEADER_W, ROW_H);

    ctx.fillStyle = PRESET_COLORS[ef.preset] || '#ccc';
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(fxLabel(ef), 6, y + ROW_H - 6);

    ctx.strokeStyle = '#181830'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + ROW_H - 0.5); ctx.lineTo(W, y + ROW_H - 0.5); ctx.stroke();

    const col = PRESET_COLORS[ef.preset] || '#ccc';
    if (ef.mode === 'range') {
      const x0 = Math.max(HEADER_W, frameToX(ef.start));
      const x1 = Math.min(W, frameToX(ef.end + 1));
      if (x1 >= HEADER_W && x0 <= W) {
        ctx.fillStyle = col + '44'; ctx.fillRect(x0, y + 3, x1 - x0, ROW_H - 6);
        ctx.strokeStyle = col; ctx.lineWidth = sel ? 2 : 1.2; ctx.strokeRect(x0, y + 3, x1 - x0, ROW_H - 6);
      }
    } else {
      const x = frameToX(ef.frame);
      if (x >= HEADER_W - 8 && x <= W + 8) {
        const yc = y + ROW_H / 2;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, yc - 6); ctx.lineTo(x + 6, yc); ctx.lineTo(x, yc + 6); ctx.lineTo(x - 6, yc); ctx.closePath(); ctx.fill();
        if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  });

  // ルーラー
  ctx.fillStyle = '#10102a'; ctx.fillRect(0, 0, W, RULER_H);
  const tickEvery = tlPxPerFrame >= 8 ? 10 : tlPxPerFrame >= 4 ? 30 : 60;
  ctx.font = '10px monospace'; ctx.textAlign = 'center';
  for (let f = 0; f <= timeline.durationFrames + tickEvery; f += tickEvery) {
    const x = frameToX(f);
    if (x < HEADER_W || x > W) continue;
    ctx.fillStyle = '#666'; ctx.fillText(f.toString(), x, RULER_H - 5);
    ctx.fillStyle = '#444'; ctx.fillRect(x - 0.5, RULER_H - 14, 1, 9);
  }
  ctx.strokeStyle = '#2a2a44'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(HEADER_W - 0.5, 0); ctx.lineTo(HEADER_W - 0.5, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(W, RULER_H - 0.5); ctx.stroke();

  drawTrim(ctx, W, H);
  drawPlayhead(ctx, W, H);
}

function drawTrim(ctx, W, H) {
  const xIn = frameToX(timeline.trimIn), xOut = frameToX(timeline.trimOut);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  if (xIn > HEADER_W) ctx.fillRect(HEADER_W, RULER_H, Math.min(xIn, W) - HEADER_W, H - RULER_H);
  if (xOut < W) { const x0 = Math.max(xOut, HEADER_W); ctx.fillRect(x0, RULER_H, W - x0, H - RULER_H); }
  ctx.strokeStyle = '#33cc88'; ctx.lineWidth = 1.5;
  if (xIn >= HEADER_W && xIn <= W) { ctx.beginPath(); ctx.moveTo(xIn + 0.5, RULER_H); ctx.lineTo(xIn + 0.5, H); ctx.stroke(); }
  if (xOut >= HEADER_W && xOut <= W) { ctx.beginPath(); ctx.moveTo(xOut - 0.5, RULER_H); ctx.lineTo(xOut - 0.5, H); ctx.stroke(); }
  ctx.fillStyle = '#33cc88';
  if (xIn >= HEADER_W && xIn <= W) { ctx.beginPath(); ctx.moveTo(xIn, RULER_H - 14); ctx.lineTo(xIn + TRIM_HANDLE_W, RULER_H - 14); ctx.lineTo(xIn, RULER_H); ctx.closePath(); ctx.fill(); }
  if (xOut >= HEADER_W && xOut <= W) { ctx.beginPath(); ctx.moveTo(xOut, RULER_H - 14); ctx.lineTo(xOut - TRIM_HANDLE_W, RULER_H - 14); ctx.lineTo(xOut, RULER_H); ctx.closePath(); ctx.fill(); }
}

function drawPlayhead(ctx, W, H) {
  const x = frameToX(timeline.currentFrame);
  if (x < HEADER_W - 1 || x > W + 1) return;
  ctx.strokeStyle = '#ff3333'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.fillStyle = '#ff3333';
  ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8); ctx.closePath(); ctx.fill();
}

function rowAt(offsetX, offsetY) {
  if (offsetX < HEADER_W || offsetY < RULER_H) return null;
  const idx = Math.floor((offsetY - RULER_H) / ROW_H);
  if (idx < 0 || idx >= effects.length) return null;
  const frame = Math.max(0, Math.min(xToFrame(offsetX), timeline.durationFrames));
  return { ef: effects[idx], frame };
}

let _rangeDrag = null;   // { id, startFrame, endFrame }
let _trimDrag = null;
function setupTimelineEvents(canvas) {
  let tlDragging = false, panDrag = null;

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (e.button === 1 || (e.button === 0 && e.altKey)) { e.preventDefault(); panDrag = { startX: x, startScroll: tlScrollX }; return; }

    // ルーラー：トリムハンドル or シーク
    if (y < RULER_H && x >= HEADER_W) {
      const xIn = frameToX(timeline.trimIn), xOut = frameToX(timeline.trimOut), TOL = TRIM_HANDLE_W + 3;
      const dIn = Math.abs(x - xIn), dOut = Math.abs(x - xOut);
      if (dIn <= TOL || dOut <= TOL) { _trimDrag = (dIn <= dOut) ? 'in' : 'out'; return; }
      tlDragging = true;
      vrmaSeek(Math.max(0, Math.min(xToFrame(x), timeline.durationFrames)));
      return;
    }

    if (e.button !== 0) return;
    const hit = rowAt(x, y);
    if (!hit) return;
    selectEffect(hit.ef.id);
    if (hit.ef.mode === 'burst') {
      hit.ef.frame = hit.frame;
      syncSelEditor();
      renderTimeline();
    } else {
      _rangeDrag = { id: hit.ef.id, startFrame: hit.frame, endFrame: hit.frame };
    }
  });

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (panDrag) { tlScrollX = Math.max(0, Math.min(maxScrollX(), panDrag.startScroll - (x - panDrag.startX))); renderTimeline(); return; }
    const f = Math.max(0, Math.min(xToFrame(x), timeline.durationFrames));
    if (_trimDrag) {
      if (_trimDrag === 'in') timeline.trimIn = Math.max(0, Math.min(f, timeline.trimOut - 1));
      else timeline.trimOut = Math.min(timeline.durationFrames, Math.max(f, timeline.trimIn + 1));
      updateTrimLabel(); renderTimeline(); return;
    }
    if (tlDragging) { vrmaSeek(f); return; }
    if (_rangeDrag) {
      _rangeDrag.endFrame = f;
      const ef = effects.find(e2 => e2.id === _rangeDrag.id);
      if (ef) { ef.start = Math.min(_rangeDrag.startFrame, f); ef.end = Math.max(_rangeDrag.startFrame, f); syncSelEditor(); }
      renderTimeline();
    }
  });

  const endDrag = () => { tlDragging = false; _trimDrag = null; panDrag = null; if (_rangeDrag) { _rangeDrag = null; rebuildFxList(); } };
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', endDrag);

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const hit = rowAt(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) removeEffect(hit.ef.id);
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      tlScrollX = Math.max(0, Math.min(maxScrollX(), tlScrollX + (e.shiftKey ? e.deltaY : e.deltaX)));
    } else if (x < HEADER_W) {
      tlScrollX = Math.max(0, tlScrollX + e.deltaY);
    } else {
      const fAt = xToFrame(x); const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      tlPxPerFrame = Math.max(2, Math.min(60, tlPxPerFrame * factor));
      tlScrollX = Math.max(0, fAt * tlPxPerFrame - (x - HEADER_W));
    }
    renderTimeline();
  }, { passive: false });
}

// ── タイムライン リサイズ ──
function setupTimelineResize() {
  const resizer = document.getElementById('timeline-resizer');
  const section = document.getElementById('timeline-section');
  let dragging = false, startY = 0, startH = 0;
  resizer.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startH = section.offsetHeight;
    resizer.classList.add('dragging'); e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const h = Math.max(120, Math.min(window.innerHeight - 160, startH - (e.clientY - startY)));
    section.style.height = h + 'px';
    resizeTimeline(); renderTimeline();
  });
  window.addEventListener('mouseup', () => { dragging = false; resizer.classList.remove('dragging'); });
}

function resizeTimeline() {
  const canvas = document.getElementById('timeline');
  const section = document.getElementById('timeline-section');
  if (!canvas || !section) return;
  canvas.width = section.clientWidth;
  canvas.height = section.clientHeight;
}

// ============================================================
// 保存 / 読み込み（timeline.json に effect トラックを埋め込み）
// ============================================================
function exportTimeline() {
  const tracks = otherTracks.map(t => ({ ...t }));   // effect 以外のトラックを温存
  for (const ef of effects) {
    const t = { kind: 'effect', id: ef.id, preset: ef.preset, mode: ef.mode, anchor: ef.anchor, pos: ef.pos.slice(), rot: ef.rot.slice(), count: ef.count, params: { ...ef.params } };
    if (ef.anchor === 'bone') t.bone = ef.bone;
    if (ef.onImpact) t.onImpact = true;
    if (ef.force) { t.force = ef.force; t.forceRadius = ef.forceRadius; }
    if (ef.mode === 'range') { t.start = ef.start; t.end = ef.end; } else { t.frame = ef.frame; }
    tracks.push(t);
  }
  const out = { version: 2, fps: timeline.fps, durationFrames: timeline.durationFrames, trimIn: timeline.trimIn, trimOut: timeline.trimOut, tracks };
  if (timeline.speed && timeline.speed !== 1) out.speed = timeline.speed;
  if (currentVrmaName) out.vrma = currentVrmaName;
  return out;
}

function importTimeline(json) {
  if (!Array.isArray(json.tracks)) throw new Error('無効なタイムラインファイルです');
  clearEffects();
  otherTracks = [];
  loadedTimelineJson = json;
  if (currentCloth) currentCloth.setTimeline(json);   // マントのグリップ範囲を適用
  if (json.fps) timeline.fps = json.fps;
  if (json.durationFrames && !vrmaClip) timeline.durationFrames = json.durationFrames;
  if (json.vrma) currentVrmaName = json.vrma;
  if (Number.isFinite(json.speed) && json.speed > 0) {
    const sl = document.getElementById('sel-speed'), vl = document.getElementById('sel-speed-val');
    if (sl) sl.value = String(json.speed);
    if (vl) vl.textContent = `${json.speed.toFixed(2).replace(/\.?0+$/, '')}×`;
    vrmaSetSpeed(json.speed);
  }
  timeline.trimIn = Number.isFinite(json.trimIn) ? Math.max(0, Math.min(json.trimIn, timeline.durationFrames)) : 0;
  timeline.trimOut = Number.isFinite(json.trimOut) ? Math.max(timeline.trimIn + 1, Math.min(json.trimOut, timeline.durationFrames)) : timeline.durationFrames;

  for (const t of json.tracks) {
    if (t.kind === 'effect') {
      createEffect({
        id: t.id, preset: t.preset, mode: t.mode || 'burst',
        frame: t.frame, start: t.start, end: t.end,
        anchor: t.anchor || 'world', bone: t.bone,
        pos: Array.isArray(t.pos) ? t.pos : undefined,
        rot: Array.isArray(t.rot) ? t.rot : undefined,
        count: t.count,
        onImpact: t.onImpact, force: t.force, forceRadius: t.forceRadius,
        params: (t.params && typeof t.params === 'object') ? t.params : undefined,
      });
    } else {
      otherTracks.push(t);   // grip/blendShape 等はそのまま温存
    }
  }
  document.getElementById('lbl-duration').textContent = timeline.durationFrames.toString();
  updateTrimLabel();
  rebuildFxList();
  renderTimeline();
}

// ============================================================
// UI
// ============================================================
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'visible' + (type !== 'info' ? ' ' + type : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = ''; }, 2200);
}
function updateFrameLabel() { document.getElementById('lbl-frame').textContent = String(timeline.currentFrame); }
function updateTrimLabel() { document.getElementById('lbl-trim').textContent = `${timeline.trimIn} – ${timeline.trimOut}`; }

function setupUI() {
  // VRM ファイル
  const vrmFile = document.getElementById('vrm-file');
  vrmFile.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return; vrmFile.value = '';
    try { await loadVRM(file); } catch (err) { showToast(`VRM 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrm-load').addEventListener('click', () => vrmFile.click());

  // NPC ドロップダウン
  const npcSelect = document.getElementById('npc-select');
  fetch('../npc/manifest.json').then(r => r.ok ? r.json() : []).then(files => {
    for (const f of files) { if (!f.endsWith('.npc.json')) continue; const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.npc\.json$/, ''); npcSelect.appendChild(o); }
  }).catch(() => {});
  npcSelect.addEventListener('change', async () => {
    if (!npcSelect.value) return;
    showToast('NPC読み込み中…');
    try { const res = await fetch('../npc/' + npcSelect.value); if (!res.ok) throw new Error('取得失敗'); await importNPCBundle(await res.json()); }
    catch (err) { showToast(`NPC読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // VRMA ファイル
  const vrmaFile = document.getElementById('vrma-file');
  vrmaFile.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return; vrmaFile.value = '';
    try { await loadVRMA(file, file.name); } catch (err) { showToast(`VRMA 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrma-load').addEventListener('click', () => vrmaFile.click());

  // VRMA ドロップダウン
  const vrmaSelect = document.getElementById('vrma-select');
  fetch('/vrma/manifest.json').then(r => r.ok ? r.json() : []).then(files => {
    for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.vrma$/, ''); vrmaSelect.appendChild(o); }
  }).catch(() => {});
  vrmaSelect.addEventListener('change', async () => {
    if (!vrmaSelect.value) return;
    showToast('VRMA 読み込み中…');
    try { const res = await fetch('/vrma/' + encodeURIComponent(vrmaSelect.value)); if (!res.ok) throw new Error('取得失敗'); await loadVRMA(new File([await res.blob()], vrmaSelect.value, { type: 'application/octet-stream' }), vrmaSelect.value); }
    catch (err) { showToast(`VRMA 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // TL ドロップダウン
  const tlSelect = document.getElementById('tl-select');
  function populateTlSelect(selectName) {
    fetch('../timeline/manifest.json?ext=timeline.json').then(r => r.ok ? r.json() : []).then(files => {
      tlSelect.innerHTML = '<option value="">-- TL読込 (timeline) --</option>';
      for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.timeline\.json$/, ''); if (f === selectName) o.selected = true; tlSelect.appendChild(o); }
    }).catch(() => {});
  }
  populateTlSelect();
  tlSelect.addEventListener('change', async () => {
    if (!tlSelect.value) return;
    try {
      const res = await fetch('../timeline/' + tlSelect.value); if (!res.ok) throw new Error('取得失敗');
      const j = await res.json();
      // vrma を先に読み込んで尺を確定 → その後 effect/トリムを取り込む
      if (j.vrma && currentVRM) await loadVrmaByName(j.vrma);
      importTimeline(j);
      lastTlName = tlSelect.value.replace(/\.timeline\.json$/, '');
      showToast(`TL読み込み: ${lastTlName}`);
    } catch (err) { showToast(`TL読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // TL 保存
  document.getElementById('btn-tl-save').addEventListener('click', async () => {
    const def = lastTlName || lastBundleName || 'effect';
    const name = prompt('保存名（public/timeline に <名前>.timeline.json で保存）', def);
    if (name === null) return;
    const base = name.trim().replace(/\.timeline\.json$/, '').replace(/[^\w\-]/g, '_');
    if (!base) { showToast('名前が不正です', 'warn'); return; }
    const filename = `${base}.timeline.json`;
    try {
      const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'timeline', filename, content: JSON.stringify(exportTimeline(), null, 2) }) });
      const j = await r.json();
      if (j.ok) { lastTlName = base; showToast(`保存: ${j.path}`); populateTlSelect(filename); }
      else showToast('保存失敗', 'error');
    } catch (e) { showToast(`保存失敗: ${e}`, 'error'); }
  });

  // 再生
  document.getElementById('btn-play').addEventListener('click', vrmaPlay);
  document.getElementById('btn-pause').addEventListener('click', vrmaPause);
  document.getElementById('cb-loop').addEventListener('change', e => vrmaSetLoop(e.target.checked));
  const speedSlider = document.getElementById('sel-speed'), speedVal = document.getElementById('sel-speed-val');
  speedSlider.addEventListener('input', e => { const v = parseFloat(e.target.value); if (speedVal) speedVal.textContent = `${v.toFixed(2).replace(/\.?0+$/, '')}×`; vrmaSetSpeed(v); });

  // マント（布）スライダー
  const windSl = document.getElementById('cloth-wind'), windVal = document.getElementById('cloth-wind-val');
  windSl.addEventListener('input', () => { const v = parseFloat(windSl.value); windVal.textContent = v.toFixed(1); clothParams.wind = v; if (currentCloth) currentCloth.setWind(v); });
  const stiffSl = document.getElementById('cloth-stiffness'), stiffVal = document.getElementById('cloth-stiffness-val');
  stiffSl.addEventListener('input', () => { const v = parseFloat(stiffSl.value); stiffVal.textContent = v.toFixed(2); clothParams.stiffness = v; if (currentCloth) currentCloth.setStiffness(v); });

  // Bloom スライダー（シーン全体）
  const bStr = document.getElementById('bloom-strength'), bStrV = document.getElementById('bloom-strength-val');
  if (bStr) bStr.addEventListener('input', () => { const v = parseFloat(bStr.value); if (bStrV) bStrV.textContent = v.toFixed(2); bloomParams.strength = v; if (bloomPass) bloomPass.strength.value = v; });
  const bRad = document.getElementById('bloom-radius'), bRadV = document.getElementById('bloom-radius-val');
  if (bRad) bRad.addEventListener('input', () => { const v = parseFloat(bRad.value); if (bRadV) bRadV.textContent = v.toFixed(2); bloomParams.radius = v; if (bloomPass) bloomPass.radius.value = v; });
  const bThr = document.getElementById('bloom-threshold'), bThrV = document.getElementById('bloom-threshold-val');
  if (bThr) bThr.addEventListener('input', () => { const v = parseFloat(bThr.value); if (bThrV) bThrV.textContent = v.toFixed(2); bloomParams.threshold = v; if (bloomPass) bloomPass.threshold.value = v; });

  // トリム
  document.getElementById('btn-trim-in').addEventListener('click', () => { timeline.trimIn = Math.min(timeline.currentFrame, timeline.trimOut - 1); updateTrimLabel(); renderTimeline(); });
  document.getElementById('btn-trim-out').addEventListener('click', () => { timeline.trimOut = Math.max(timeline.currentFrame, timeline.trimIn + 1); updateTrimLabel(); renderTimeline(); });
  document.getElementById('btn-trim-reset').addEventListener('click', () => { timeline.trimIn = 0; timeline.trimOut = timeline.durationFrames; updateTrimLabel(); renderTimeline(); });

  // エフェクト追加
  const addAnchor = document.getElementById('add-anchor');
  const boneRow = document.getElementById('bone-row');
  addAnchor.addEventListener('change', () => { boneRow.style.display = addAnchor.value === 'bone' ? 'flex' : 'none'; });
  document.getElementById('btn-add-fx').addEventListener('click', () => {
    const ef = createEffect({
      preset: document.getElementById('add-preset').value,
      mode: document.getElementById('add-mode').value,
      anchor: addAnchor.value,
      bone: document.getElementById('add-bone').value,
      frame: timeline.currentFrame,
      start: timeline.currentFrame,
      end: Math.min(timeline.durationFrames, timeline.currentFrame + 15),
    });
    rebuildFxList();
    selectEffect(ef.id);
    renderTimeline();
    showToast(`エフェクト追加: ${fxLabel(ef)}`);
  });
  document.getElementById('btn-test-fire').addEventListener('click', () => {
    const ef = selectedEffect(); if (!ef) return;
    computeSpawnTransform(ef, _sp, _sq); ef.object3D.position.copy(_sp); ef.object3D.quaternion.copy(_sq);
    ef.fx.burst(ef.count > 0 ? ef.count : 24);
  });

  // 選択エディタ
  document.getElementById('btn-gz-move').addEventListener('click', () => setGizmoMode('translate'));
  document.getElementById('btn-gz-rot').addEventListener('click', () => setGizmoMode('rotate'));
  document.getElementById('sel-preset').addEventListener('change', e => { const ef = selectedEffect(); if (ef) { changePreset(ef, e.target.value); rebuildFxList(); renderTimeline(); } });
  const selAnchor = document.getElementById('sel-anchor');
  selAnchor.addEventListener('change', e => {
    const ef = selectedEffect(); if (!ef) return;
    // 基準切替時は現在のワールド位置を維持するよう pos を再計算
    computeSpawnTransform(ef, _sp, _sq);
    ef.anchor = e.target.value;
    if (ef.anchor === 'bone') ef.pos = [0, 0, 0]; else { ef.pos = [_sp.x, _sp.y, _sp.z]; ef.rot = [0, 0, 0]; }
    selectEffect(ef.id);   // ハンドル再配置 + UI 更新
    rebuildFxList(); renderTimeline();
  });
  document.getElementById('sel-bone').addEventListener('change', e => { const ef = selectedEffect(); if (ef) { ef.bone = e.target.value; selectEffect(ef.id); rebuildFxList(); renderTimeline(); } });
  document.getElementById('sel-frame').addEventListener('change', e => { const ef = selectedEffect(); if (ef) { ef.frame = Math.max(0, Math.min(timeline.durationFrames, parseInt(e.target.value) || 0)); rebuildFxList(); renderTimeline(); } });
  document.getElementById('btn-frame-here').addEventListener('click', () => { const ef = selectedEffect(); if (ef) { ef.frame = timeline.currentFrame; syncSelEditor(); rebuildFxList(); renderTimeline(); } });
  document.getElementById('sel-start').addEventListener('change', e => { const ef = selectedEffect(); if (ef) { ef.start = Math.max(0, Math.min(ef.end, parseInt(e.target.value) || 0)); rebuildFxList(); renderTimeline(); } });
  document.getElementById('sel-end').addEventListener('change', e => { const ef = selectedEffect(); if (ef) { ef.end = Math.max(ef.start, Math.min(timeline.durationFrames, parseInt(e.target.value) || 0)); rebuildFxList(); renderTimeline(); } });
  document.getElementById('sel-count').addEventListener('change', e => { const ef = selectedEffect(); if (ef) ef.count = Math.max(1, parseInt(e.target.value) || 1); });
  document.getElementById('btn-del-fx').addEventListener('click', () => { if (selectedEffectId != null) removeEffect(selectedEffectId); });

  // キーボード: G=移動 / R=回転 / Delete=選択削除
  window.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'g' || e.key === 'G') setGizmoMode('translate');
    else if (e.key === 'r' || e.key === 'R') setGizmoMode('rotate');
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEffectId != null) { removeEffect(selectedEffectId); e.preventDefault(); }
  });
}

// fx-builder が保存した *.fx.json を読み込み、プリセット一覧に追加（'custom:<name>'）
async function loadCustomPresets() {
  let files = [];
  try { files = await (await fetch('../fx/manifest.json')).json(); } catch { return; }
  const addSel = document.getElementById('add-preset'), selSel = document.getElementById('sel-preset');
  for (const f of files) {
    if (!f.endsWith('.fx.json')) continue;
    try {
      const spec = await (await fetch('../fx/' + f)).json();
      const name = f.replace(/\.fx\.json$/, '');
      const key = 'custom:' + name;
      customSpecs.set(key, spec);
      PRESET_COLORS[key] = spec.layers?.[0]?.color || '#88ccff';
      for (const sel of [addSel, selSel]) {
        if (!sel) continue;
        const o = document.createElement('option'); o.value = key; o.textContent = '📦 ' + name; sel.appendChild(o);
      }
    } catch (e) { console.warn('FXプリセット読込失敗:', f, e); }
  }
}

// ============================================================
// Render
// ============================================================
function updateFPS() {
  fpsFrameCount++;
  const now = performance.now(), elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount / (elapsed / 1000));
    document.getElementById('fps-counter').textContent = `${fps} FPS`;
    document.getElementById('fps-toolbar').textContent = `${fps} FPS`;
    fpsFrameCount = 0; fpsLastTime = now;
  }
}

function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 20);
  updateFPS();

  if (mixer && vrmaAction && vrmaPlaying) {
    const inT = timeline.trimIn / timeline.fps, outT = timeline.trimOut / timeline.fps;
    const prevTime = vrmaAction.time;
    mixer.update(dt);
    let curTime = vrmaAction.time, looped = false;
    if (curTime >= outT - 0.0005 || curTime < prevTime - 0.001) {
      if (vrmaLoop) { curTime = inT; vrmaAction.time = inT; looped = true; }
      else { vrmaPlaying = false; curTime = outT; vrmaAction.time = outT; timeline.currentFrame = timeline.trimOut; updatePlayButtons(); }
    }
    const newFrame = Math.min(Math.floor(curTime * timeline.fps), timeline.durationFrames);
    if (newFrame !== timeline.currentFrame) {
      const prev = timeline.currentFrame;
      timeline.currentFrame = newFrame;
      // ループ折返し時は先頭(trimIn)からのバーストを拾う／通常は prev→new 区間
      if (looped) fireBurstsBetween(timeline.trimIn - 1, newFrame);
      else if (newFrame > prev) fireBurstsBetween(prev, newFrame);
      updateFrameLabel();
    }
  }

  renderTimeline();
  if (currentVRM) currentVRM.update(dt);
  if (currentCloth) currentCloth.update(dt, timeline.currentFrame);   // VRM更新後：マントがボーン/グリップ追従＋シミュ
  updatePhysics(dt);   // 物理弾（onImpact 効果より先に）
  updateEffects(dt);
  syncSelectedHandle();
  controls.update();
  if (post) post.render(); else renderer.render(scene, camera);   // bloom ポストプロセス
}

// ============================================================
// Init
// ============================================================
async function init() {
  const app = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!navigator.gpu) { document.getElementById('webgpu-warning').style.display = 'block'; throw new Error('WebGPU 非対応のブラウザです'); }

  // maxStorageBuffersInVertexStage: マント(lib/vrm-cloth)が頂点ステージで位置バッファを読むため必要
  renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.1;
  app.appendChild(renderer.domElement);
  await renderer.init();

  const setRendererSize = () => {
    const w = app.clientWidth, h = app.clientHeight;
    renderer.setSize(w, h);
    if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  };
  setRendererSize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12121f);

  camera = new THREE.PerspectiveCamera(45, app.clientWidth / app.clientHeight, 0.01, 100);
  camera.position.set(0, 1.4, 3.2);

  // 空（淡いグラデのスカイドーム）
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const skyT = positionWorld.normalize().y.mul(0.5).add(0.5).clamp(0, 1);
  skyMat.colorNode = mix(color(0x1a1f33), color(0x0c0c16), skyT);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), skyMat);
  sky.frustumCulled = false; scene.add(sky);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.8); dir.position.set(2, 4, 3); scene.add(dir);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0); controls.update();

  buildRoom();

  // 発生位置ハンドル + ギズモ
  handle = new THREE.Group();
  const hMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), new THREE.MeshBasicMaterial({ color: 0xffdd33, depthTest: false, transparent: true, opacity: 0.9 }));
  hMesh.renderOrder = 999;
  handle.add(hMesh);
  handle.add(new THREE.AxesHelper(0.16));
  handle.visible = false;
  scene.add(handle);

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.setSize(0.8);
  gizmo.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
  gizmo.addEventListener('objectChange', onGizmoChange);
  scene.add(gizmo.getHelper ? gizmo.getHelper() : gizmo);

  // Bloom ポストプロセス（emissive/明るい部分を発光）。失敗時は通常レンダにフォールバック。
  try {
    post = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode();
    bloomPass = bloom(sceneColor, bloomParams.strength, bloomParams.radius, bloomParams.threshold);
    post.outputNode = sceneColor.add(bloomPass);
  } catch (e) { console.warn('Bloom 初期化失敗（通常レンダに切替）:', e); post = null; bloomPass = null; }

  timer.connect(document);

  resizeTimeline();
  renderTimeline();
  setupUI();
  loadCustomPresets();   // fx-builder の *.fx.json をプリセット一覧へ
  setupTimelineEvents(document.getElementById('timeline'));
  setupTimelineResize();

  window.addEventListener('resize', () => { setRendererSize(); resizeTimeline(); renderTimeline(); });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);
  renderer.setAnimationLoop(render);
}

init().catch(err => { console.error(err); const l = document.getElementById('loading'); if (l) l.textContent = `初期化失敗: ${err.message}`; });
