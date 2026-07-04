// swing-catch.js — FPS視点で飛行オブジェクトをキャッチ・振り回し・吹っ飛ばすサンドボックス
// Three.js v0.184 via esm.sh CDN (WebGPU)
// 設計: .tmp/grab_game_design.md

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { Octree }  from 'https://esm.sh/three@0.184.0/examples/jsm/math/Octree.js';
import { Capsule } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Capsule.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse }
  from '../lib/vrm-ragdoll.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { createNpcStateMachine } from '../lib/npc-state-machine.js';
import { createNpcSpeech } from '../lib/npc-speech.js';
import { createSpeechUI } from '../lib/speech-ui.js';
import { defaultSpeechFile, fetchSpeechSet, buildSpeechCharacter, speechFromLegacyCharacter } from '../lib/speech-set.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { positionWorld, mix, color } from 'https://esm.sh/three@0.184.0/tsl';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';

// ── アリーナ ───────────────────────────────────────────────────
const ROOM = { x: 30, y: 30, z: 30 };   // 内寸（床 y=0、天井 y=ROOM.y）

// ── プレイヤー定数 ─────────────────────────────────────────────
const PLAYER_SPEED  = 20;
const GRAVITY_ACCEL = 25;
const JUMP_VEL      = 9;
const EYE_SPAWN     = new THREE.Vector3(0, 1.6, ROOM.z / 2 - 1.5);

// ── 掴み / スプリング / 投擲 ───────────────────────────────────
const GRAB_DISTANCE = 2.5;    // 手アンカーのカメラ前方距離
const GRAB_RANGE    = 30;     // 掴み可能な最大距離
const MAX_SPEED     = 40;     // 速度上限（破綻防止）

// ── 発射体 ─────────────────────────────────────────────────────
const PROJECTILE_RADIUS = 0.18;
const PROJECTILE_TTL     = 3.0;

// ── 物理ステップ ───────────────────────────────────────────────
const STEP_HZ         = 120;
const MAX_STEPS_FRAME = 5;

// ── Megu（VRM ラグドール）─────────────────────────────────────
const MEGU_COUNT         = 3;      // 出現する NPC 数
const TAUNT_APPROACH     = 18;     // 挑発時の接近加速
const TAUNT_MAX          = 9;      // 挑発接近の最大速度
const MEGU_RADIUS        = 0.55;   // 当たり/掴み判定の体半径
const MEGU_CENTER_Y      = 1.0;    // 飛行時の判定中心の高さ（root からのオフセット）
const MEGU_RECOVER_DELAY = 2.5;    // 被弾→ラグドール継続時間(秒)
const LOOK_DURATION      = 1.5;    // 顔を向け始めてから復帰までの時間(秒)
const RAGDOLL_IMPULSE    = 0.3;    // 命中時の速度キック
// ── セリフ（頭上吹き出し / 衝突 bark）──
const BUBBLE_Y_OFFSET        = 1.6;   // 吹き出しを出す頭上の高さ（判定中心からのオフセット）
const BUBBLE_MAX_DIST        = 25;    // この距離より遠い NPC の吹き出しは隠す(m)
const LANDED_SPEED_THRESHOLD = 4.0;   // landed bark を出す落下速度しきい値(m/s)
const LANDED_MARGIN          = 0.5;   // 床近傍とみなす高さ(m)
// ── フロー戦闘モード（flow-player から ?flow=1 で埋め込み。非フロー時は一切作動しない）──
const FLOW = new URLSearchParams(location.search).get('flow') === '1';
const PLAYER_MAX_HP   = 10;    // 既定の最大HP（battle.lose.hp で上書き）
const DEFEAT_COOLDOWN = 0.5;   // 同一NPCの撃破カウント間隔(秒)
// 敵の攻撃（フェーズ2a）
const MELEE_DMG = 3, BALL_DMG = 1, THROW_DMG = 2, TOUCH_DMG = 1;
const TELEGRAPH_TIME = 1.0, LUNGE_TIME = 0.7;          // 近接：予備動作/踏み込みの時間(秒)
const MELEE_TRIGGER_DIST = 7, MELEE_HIT_RADIUS = 1.6;  // 近接を始める距離 / 命中半径(m)
const TELEGRAPH_SPEED = 4, LUNGE_SPEED = 14;           // 予備動作/踏み込みの速度(m/s)
const MELEE_CD = 3.0, RANGED_CD_MIN = 2.5, RANGED_CD_MAX = 4.0;
const ENEMY_BALL_SPEED = 16, ENEMY_PROJ_TTL = 4, ENEMY_PROJ_RADIUS = 0.18;
const THROW_SPEED = 22, THROW_REACH = 8, HAZARD_TIME = 2.0;
const INVULN = 0.8, PLAYER_HIT_R = 0.5;                // 無敵時間(秒) / プレイヤー被弾半径(m)
const ARENA_BOUNDS = {
  min: new THREE.Vector3(-ROOM.x / 2, 0, -ROOM.z / 2),
  max: new THREE.Vector3( ROOM.x / 2, ROOM.y, ROOM.z / 2),
};

// ── 調整可能パラメータ（UI連動）──────────────────────────────
const params = {
  objectCount:   8,
  stiffness:     60,
  damping:       6,
  releaseBoost:  1.0,
  projSpeed:     40,
  impulse:       18,
  restitution:   0.92,
};

// ── シーン globals ─────────────────────────────────────────────
let renderer, scene, camera;
let speechUI = null;            // セリフ表示（下部ウィンドウ＋頭上吹き出し）
let stageDecor = null;          // 現在のステージ置物グループ（差し替え用）
// フロー戦闘の状態（FLOW 時のみ使用）
let battleCfg   = null;         // flow-config で受け取る戦闘設定
let playerHp    = 0, playerMaxHp = 0;
let defeatCount = 0, defeatTarget = 0;
let battleTime  = 0, lastHitT = -999;
let battleOver  = false;
let battleHud   = null, battleBgm = null, battleVfx = null;
let shakeT      = 0;
const enemyProjectiles = [];   // 敵の弾（プレイヤーのみ対象）
let worldOctree    = null;
let playerCollider = null;
let playerOnFloor  = false;

// ── プレイヤー状態 ─────────────────────────────────────────────
const playerVel = new THREE.Vector3();
let   playerYaw   = Math.PI;
let   playerPitch = 0;
const keysDown    = {};
let   isLocked    = false;
let   touchMode   = false;                 // モバイル: タッチ操作（#joystick-base がある時に有効化）
const joystickVec = { x: 0, y: 0 };
const touchMoveT  = { active: false, id: -1, startX: 0, startY: 0 };
const touchLookT  = { active: false, id: -1, prevX: 0, prevY: 0, downT: 0, moved: false, grabbed: false, timer: 0 };
const JOYSTICK_MAX = 60;

// ── ゲーム状態 ─────────────────────────────────────────────────
const objects     = [];   // 飛行オブジェクト
const projectiles = [];   // 発射体
let   grabbed     = null;  // 掴み中のオブジェクト（1個）
const handAnchor  = new THREE.Vector3();
const megus       = [];    // 複数の VRM NPC（各 { vrm, ragdoll, mixer, action, cloth, pos, vel, grabbed, clothGrabbed, recoverTimer }）

// ── 物理ステップ用 ─────────────────────────────────────────────
let timeSinceLastStep = 0;

// ── FPS カウンタ ───────────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ── 再利用テンポラリ ───────────────────────────────────────────
const _forward = new THREE.Vector3();
const _delta   = new THREE.Vector3();
const _force   = new THREE.Vector3();
const _hitDir  = new THREE.Vector3();
const _meguC   = new THREE.Vector3();
const _grabV   = new THREE.Vector3();
const _bubbleV = new THREE.Vector3();   // 吹き出しのワールド→画面投影用
// 頭の向き追従用テンポラリ
const _hPos    = new THREE.Vector3();
const _hDir    = new THREE.Vector3();
const _hFwd    = new THREE.Vector3();
const _hqCur   = new THREE.Quaternion();
const _hqPar   = new THREE.Quaternion();
const _hqDelta = new THREE.Quaternion();
const _hqDes   = new THREE.Quaternion();
const HEAD_FWD       = new THREE.Vector3(0, 0, 1);   // VRM の顔正面（VRMLookAt.faceFront 既定 = +Z）
const HEAD_MAX_ANGLE = Math.PI * 0.6;                // 顔を向ける最大角（後ろは向きすぎない）
const HEAD_LOOK_TAU  = 0.6;                          // 顔追従の時定数(秒)。大きいほどゆっくり向く
const raycaster = new THREE.Raycaster();
let   meguFrame = 0;   // マント位置読み戻しのスロットル用
const screenCenter = new THREE.Vector2(0, 0);

const timer = new THREE.Timer();
timer.connect(document);

// ============================================================
// アリーナ構築
// ============================================================

function buildArena() {
  const group = new THREE.Group();

  const mFloor   = new THREE.MeshStandardMaterial({ color: 0x2a2e44, roughness: 0.95 });
  const mCeiling = new THREE.MeshStandardMaterial({ color: 0x20243a, roughness: 0.95 });
  const mWall    = new THREE.MeshStandardMaterial({ color: 0x3a3f5e, roughness: 0.9 });

  const hx = ROOM.x / 2;
  const hz = ROOM.z / 2;
  const t  = 0.5;  // 壁厚

  const box = (x, y, z, w, h, d, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  // 床・天井（プレイ域より少し大きめ）
  const floorMesh = box(0, -t / 2, 0, ROOM.x + t * 2, t, ROOM.z + t * 2, mFloor);
  const hidden = [];
  hidden.push(box(0, ROOM.y + t / 2, 0, ROOM.x + t * 2, t, ROOM.z + t * 2, mCeiling));
  // 四方の壁（内面がプレイ域境界に一致）
  hidden.push(box( hx + t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall));
  hidden.push(box(-hx - t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall));
  hidden.push(box(0, ROOM.y / 2,  hz + t / 2, ROOM.x + t * 2, ROOM.y, t, mWall));
  hidden.push(box(0, ROOM.y / 2, -hz - t / 2, ROOM.x + t * 2, ROOM.y, t, mWall));

  scene.add(group);
  worldOctree = new Octree();
  worldOctree.fromGraphNode(group);
  // 床だけ表示。壁・天井は非表示（当たり判定は Octree に残る）。
  for (const m of hidden) m.visible = false;
  void floorMesh;
}

// ============================================================
// 飛行オブジェクト
// ============================================================

const SHAPES = [
  { make: () => new THREE.IcosahedronGeometry(0.42, 2), radius: 0.42 },
  { make: () => new THREE.BoxGeometry(0.7, 0.7, 0.7),   radius: 0.6 },
  { make: () => new THREE.OctahedronGeometry(0.55, 0),  radius: 0.55 },
  { make: () => new THREE.DodecahedronGeometry(0.5, 0), radius: 0.5 },
];

const modelTemplates = [];        // モデルエディタで選択した GLB の正規化テンプレート { group, radius }
const MODEL_TARGET_SIZE = 1.4;    // 飛行体の標準サイズ（最大寸法 m）

function randRange(min, max) { return min + Math.random() * (max - min); }

function randomDir() {
  // 一様ランダム方向（球面）
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
}

// GLB シーンを中心原点に揃え、指定スケール（モデルエディタ設定）or 既定正規化でテンプレート化
function prepTemplate(gltfScene, scale) {
  const box = new THREE.Box3().setFromObject(gltfScene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = (scale && scale > 0) ? scale : (MODEL_TARGET_SIZE / maxDim);   // 未設定は従来正規化
  gltfScene.position.sub(center);          // 中身を原点中心へ
  const group = new THREE.Group();
  group.add(gltfScene);
  group.scale.setScalar(s);
  return { group, radius: Math.max(0.3, maxDim * s * 0.5) };
}

// ステージ置物を静的配置（飛ばない・物理なしの装飾）。stageRef 指定で public/stages/<id>.stage.json、
// 無指定は従来の public/models/stage.json（サンドボックス既定）。
async function loadStage(stageRef) {
  const url = stageRef && /\.stage\.json$/.test(stageRef)
    ? new URL('../stages/' + encodeURIComponent(stageRef), window.location.href).href
    : new URL('../models/stage.json', window.location.href).href;
  let stageItems = [];
  try { const r = await fetch(url); if (r.ok) { const j = await r.json(); stageItems = j.items || []; } } catch { /* 無ければ空 */ }
  if (stageDecor) { scene.remove(stageDecor); stageDecor = null; }
  if (!stageItems.length) return;
  const loader = new GLTFLoader();
  const cache = new Map();
  const decor = new THREE.Group();
  for (const it of stageItems) {
    try {
      let tpl = cache.get(it.model);
      if (!tpl) {
        const url = new URL('../models/' + it.model.split('/').map(encodeURIComponent).join('/'), window.location.href).href;
        const gltf = await loader.loadAsync(url);
        const obj = gltf.scene;
        const box = new THREE.Box3().setFromObject(obj);
        const c = box.getCenter(new THREE.Vector3());
        obj.position.set(-c.x, -box.min.y, -c.z);   // 底面中心を原点へ
        tpl = new THREE.Group(); tpl.add(obj);
        cache.set(it.model, tpl);
      }
      const mesh = tpl.clone(true);
      mesh.scale.setScalar(it.scale || 1);
      mesh.position.set(it.x, it.y || 0, it.z);
      mesh.rotation.y = it.ry || 0;
      mesh.traverse(o => { if (o.isMesh) o.frustumCulled = true; });
      decor.add(mesh);
    } catch (e) { console.warn('ステージ置物の読込失敗:', it.model, e); }
  }
  stageDecor = decor;
  scene.add(decor);
}

async function loadSelectedModels() {
  let list = [], scaleMap = {};
  try { const r = await fetch('../models/selection.json'); if (r.ok) { const j = await r.json(); list = j.models || []; scaleMap = j.scales || {}; } } catch { /* 無ければ空 */ }
  if (!list.length) return;
  const loader = new GLTFLoader();
  for (const file of list) {
    try {
      const url = new URL('../models/' + file.split('/').map(encodeURIComponent).join('/'), window.location.href).href;
      const gltf = await loader.loadAsync(url);
      modelTemplates.push(prepTemplate(gltf.scene, scaleMap[file]));
    } catch (e) { console.warn('モデル読込失敗:', file, e); }
  }
}

// 選択モデルから1体生成（テンプレートを clone）
function spawnModelObject(idx) {
  const tpl = (idx != null) ? modelTemplates[idx] : modelTemplates[Math.floor(Math.random() * modelTemplates.length)];
  const mesh = tpl.group.clone(true);
  const r = tpl.radius;
  const hx = ROOM.x / 2 - r - 0.3, hz = ROOM.z / 2 - r - 0.3;
  const pos = new THREE.Vector3(randRange(-hx, hx), randRange(r + 1, ROOM.y - r - 1), randRange(-hz, hz));
  const vel = randomDir().multiplyScalar(randRange(3, 6));
  const spin = randomDir().multiplyScalar(randRange(0.5, 1.5));
  mesh.position.copy(pos);
  scene.add(mesh);
  const obj = { mesh, radius: r, pos, vel, spin, grabbed: false, isGLB: true };
  mesh.userData.obj = obj;
  objects.push(obj);
  return obj;
}

function spawnObject() {
  if (modelTemplates.length) return spawnModelObject();   // 選択モデルがあればそれを出す
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  const geo   = shape.make();
  const color = new THREE.Color().setHSL(Math.random(), 0.72, 0.56);
  const mat   = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
  const mesh  = new THREE.Mesh(geo, mat);

  const r  = shape.radius;
  const hx = ROOM.x / 2 - r - 0.3;
  const hz = ROOM.z / 2 - r - 0.3;
  const pos = new THREE.Vector3(
    randRange(-hx, hx),
    randRange(r + 1, ROOM.y - r - 1),
    randRange(-hz, hz),
  );
  const vel  = randomDir().multiplyScalar(randRange(3, 6));
  const spin = randomDir().multiplyScalar(randRange(0.5, 2.0));

  mesh.position.copy(pos);
  scene.add(mesh);

  const obj = { mesh, radius: r, pos, vel, spin, grabbed: false };
  mesh.userData.obj = obj;
  objects.push(obj);
  return obj;
}

function clearObjects() {
  for (const obj of objects) {
    scene.remove(obj.mesh);
    // GLB はテンプレートと geometry/material を共有するので dispose しない
    if (!obj.isGLB) { obj.mesh.geometry.dispose(); obj.mesh.material.dispose(); }
  }
  objects.length = 0;
  grabbed = null;
}

function setObjectCount(n) {
  clearObjects();
  if (modelTemplates.length) {
    for (let i = 0; i < modelTemplates.length; i++) spawnModelObject(i);   // 選択モデルを各1体ずつ（全部登場）
    for (let i = modelTemplates.length; i < n; i++) spawnModelObject();     // n が多ければランダムで追加
  } else {
    for (let i = 0; i < n; i++) spawnObject();
  }
}

// 軸ごとの壁反射（free モード）
function bounceAxis(obj, key, lo, hi) {
  if (obj.pos[key] < lo) {
    obj.pos[key] = lo;
    if (obj.vel[key] < 0) obj.vel[key] = -obj.vel[key] * params.restitution;
  } else if (obj.pos[key] > hi) {
    obj.pos[key] = hi;
    if (obj.vel[key] > 0) obj.vel[key] = -obj.vel[key] * params.restitution;
  }
}

// 壁内に位置をクランプ（grabbed モード、反射なし）
function clampInside(obj) {
  const r = obj.radius;
  obj.pos.x = Math.min(ROOM.x / 2 - r, Math.max(-ROOM.x / 2 + r, obj.pos.x));
  obj.pos.y = Math.min(ROOM.y - r,     Math.max(r,               obj.pos.y));
  obj.pos.z = Math.min(ROOM.z / 2 - r, Math.max(-ROOM.z / 2 + r, obj.pos.z));
}

function clampSpeed(vel) {
  const s = vel.length();
  if (s > MAX_SPEED) vel.multiplyScalar(MAX_SPEED / s);
}

// ============================================================
// 掴み / 振り回し / 投擲
// ============================================================

function updateHandAnchor() {
  camera.getWorldDirection(_forward);
  handAnchor.copy(camera.position).addScaledVector(_forward, GRAB_DISTANCE);
}

// レイのヒット対象（GLBの子メッシュ等）から親を辿って飛行オブジェクトを得る
function resolveObj(o) {
  let n = o;
  while (n) { if (n.userData && n.userData.obj) return n.userData.obj; n = n.parent; }
  return null;
}

function tryGrab() {
  if (grabbed || grabbedMegu()) return;
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = GRAB_RANGE;

  const hits = raycaster.intersectObjects(objects.map(o => o.mesh), true);   // GLBは子メッシュにヒットするので再帰
  const obj = hits.length ? resolveObj(hits[0].object) : null;
  let kind = obj ? 'obj' : null;
  let dist = obj ? hits[0].distance : Infinity;
  let target = null, clothIdx = -1, grabBone = null;

  // 全 NPC の本体（関節）/マントを判定し、最も手前を採用
  for (const m of megus) {
    const jb = nearestMeguJoint(m);
    if (jb && jb.along < dist) { kind = 'body'; dist = jb.along; target = m; grabBone = jb.bone; }
    const cl = nearestClothVertex(m);
    if (cl && cl.along < dist) { kind = 'cloth'; dist = cl.along; target = m; clothIdx = cl.index; }
  }

  if (kind === 'cloth') {
    grabMeguCloth(target, clothIdx);
  } else if (kind === 'body') {
    grabMeguBody(target, grabBone);
  } else if (kind === 'obj' && obj) {
    obj.grabbed = true; grabbed = obj; updateCrosshair();
  }
}

function release() {
  const m = grabbedMegu();
  if (m) { releaseMegu(m); return; }
  if (!grabbed) return;
  grabbed.grabbed = false;
  grabbed.vel.multiplyScalar(params.releaseBoost);
  clampSpeed(grabbed.vel);
  grabbed = null;
  updateCrosshair();
}

function fireProjectile() {
  camera.getWorldDirection(_forward);
  const geo  = new THREE.IcosahedronGeometry(PROJECTILE_RADIUS, 2);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xffe070, roughness: 0.3, metalness: 0.3, emissive: 0x554400 });
  const mesh = new THREE.Mesh(geo, mat);
  const pos  = camera.position.clone().addScaledVector(_forward, 0.5);
  const vel  = _forward.clone().multiplyScalar(params.projSpeed);
  mesh.position.copy(pos);
  scene.add(mesh);
  projectiles.push({ mesh, radius: PROJECTILE_RADIUS, pos, vel, ttl: PROJECTILE_TTL });
}

// ============================================================
// Megu（VRM）— 飛行オブジェクトの1体。被弾/掴みでラグドール化。
// ============================================================

function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 出現させる NPC バンドル（public/npc/ の全員）
const NPC_FILES = ['megu.npc.json', 'lily.npc.json', 'ayu.npc.json'];

async function fetchBundle(filename) {
  const candidates = [];
  try {
    const base = import.meta.env && import.meta.env.BASE_URL;
    if (base) candidates.push(base + 'npc/' + filename);
  } catch { /* import.meta.env 未定義の静的配信では無視 */ }
  candidates.push(new URL('./npc/' + filename, import.meta.url).href);
  candidates.push(new URL('../npc/' + filename, import.meta.url).href);
  for (const url of candidates) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* 次の候補へ */ }
  }
  return null;
}

// バンドルから NPC を1体生成して返す（VRM は個体ごとに別インスタンス）。speechData は分離した反応セリフ。
async function createMegu(bundle, pos, speechData) {
  const loader = new GLTFLoader();
  // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
  loader.register(p => new VRMLoaderPlugin(p, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
  }));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  const vrm = gltf.userData.vrm;
  if (!vrm) return null;

  let mixer = null, action = null;
  if (bundle.vrma) {
    const al = new GLTFLoader();
    al.register(p => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrma)));
    const anims = ag.userData.vrmAnimations;
    if (anims && anims.length) {
      const clip = createVRMAnimationClip(anims[0], vrm);
      mixer = new THREE.AnimationMixer(vrm.scene);
      action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity).play();
      action.time = randRange(0, clip.duration || 1);   // 個体ごとにアニメ位相をずらす
    }
  }

  vrm.scene.position.copy(pos);
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);

  const ragdoll = createRagdoll(vrm, { gravity: -6, boundsMargin: 0.4 });

  // マント（GPUクロス）。バンドルに cloth があれば生成し、ボーン追従で一緒に飛ぶ。
  let cloth = null;
  if (bundle.cloth) {
    try { cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: pos, floorY: 0, timeline: bundle.timeline }); }
    catch (e) { console.warn('マント生成失敗:', e); }
  }

  const m = {
    vrm, ragdoll, mixer, action, cloth, pos,
    tlFps: bundle.timeline?.fps ?? 30,
    tlDuration: bundle.timeline?.durationFrames ?? 0,
    tlClock: 0,                              // アニメ無し(ayu等)用の手グリップ・タイムライン時計
    sm: createNpcStateMachine(bundle.character),   // ステートマシン（character 省略時は既定＝検知無効）
    dir: null,                               // 直近のステート出力（表情/視線/attack）
    speech: null,                            // セリフ制御（下で生成）
    prevState: null,                         // ステート変化検知用
    prevCenterY: pos.y, prevVy: 0,           // landed 検出用（中心の鉛直速度推定）
    blinkT: randRange(1, 4), blinkDur: 0,    // 自動まばたき
    headLookW: 0,                            // 顔追従の現在の重み（時定数で目標へ補間）
    idleMode: 'drift', idleTimer: randRange(3, 6), bobPhase: Math.random() * 10, dashTarget: new THREE.Vector3(),

    vel: randomDir().multiplyScalar(randRange(2, 4)),
    grabbed: false, clothGrabbed: false, grabBone: 'chest', grabOffset: new THREE.Vector3(), recoverTimer: 0,
  };
  // セリフ：発話開始時に下部ウィンドウ＋頭上吹き出しへ流す
  const speechChar = buildSpeechCharacter(speechData, (bundle.character && bundle.character.displayName) || '');
  m.speech = createNpcSpeech(vrm, speechChar, {
    onLineStart: (speaker, text, cps) => {
      if (!speechUI) return;
      speechUI.showBottom(speaker, text, cps);
      speechUI.setBubble(m, text, cps);
    },
  });
  return m;
}

async function loadMegus(files) {
  // public/npc/ の NPC を1体ずつ出現させる（フロー戦闘では battle.enemies を使用）
  // enemies の各要素は "lily.npc.json"（規約 speech）か { npc, speech }（speech 上書き）。
  for (const entry of (files || NPC_FILES)) {
    const npcFile = typeof entry === 'string' ? entry : entry.npc;
    const speechFile = (entry && typeof entry === 'object' && entry.speech) || defaultSpeechFile(npcFile);
    const bundle = await fetchBundle(npcFile);
    if (!bundle || !bundle.vrm) { console.warn('NPC 読み込み失敗:', npcFile); continue; }
    let speechData = await fetchSpeechSet(speechFile);
    if (!speechData) speechData = speechFromLegacyCharacter(bundle.character);   // 移行前 npc.json の救済
    const pos = new THREE.Vector3(randRange(-5, 5), randRange(1.5, ROOM.y - 2.5), randRange(-5, 5));
    const m = await createMegu(bundle, pos, speechData);
    if (m) megus.push(m);
  }
}

// ============================================================
// フロー戦闘モード（FLOW 時のみ）
// ============================================================

// 親(flow-player)から戦闘設定を受け取り戦闘開始
function startBattle(cfg) {
  battleCfg = cfg || {};
  playerMaxHp = (cfg && cfg.lose && cfg.lose.hp) || PLAYER_MAX_HP;
  playerHp = playerMaxHp;
  defeatTarget = (cfg && cfg.win && cfg.win.count) || 5;
  defeatCount = 0; battleOver = false; battleTime = 0; lastHitT = -999; shakeT = 0;
  for (const p of enemyProjectiles) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
  enemyProjectiles.length = 0;
  if (cfg && cfg.stage) loadStage(cfg.stage).catch(e => console.warn('ステージ読み込み失敗:', e));
  if (cfg && cfg.bgm) { try { battleBgm = new Audio(new URL('../assets/' + cfg.bgm, import.meta.url).href); battleBgm.loop = true; battleBgm.volume = 0.6; battleBgm.play().catch(() => {}); } catch { /* noop */ } }
  buildBattleHud();
  const enemies = (cfg && Array.isArray(cfg.enemies) && cfg.enemies.length) ? cfg.enemies : NPC_FILES;
  loadMegus(enemies).catch(e => console.warn('戦闘NPC読み込み失敗:', e));
}

function onDefeat(m) {
  if (!FLOW || battleOver) return;
  if (battleTime - (m._lastDefeatT || -999) < DEFEAT_COOLDOWN) return;
  m._lastDefeatT = battleTime;
  defeatCount++;
  updateBattleHud();
  if (defeatTarget > 0 && defeatCount >= defeatTarget) endBattle('win');
}

// プレイヤー被弾（src=当てたNPC or null）。無敵時間・HP・演出・被弾セリフ・敗北判定。
function onPlayerDamaged(amount, src) {
  if (!FLOW || battleOver) return;
  if (battleTime - lastHitT < INVULN) return;
  lastHitT = battleTime;
  playerHp = Math.max(0, playerHp - amount);
  updateBattleHud();
  if (battleVfx) { battleVfx.style.opacity = '1'; setTimeout(() => { if (battleVfx) battleVfx.style.opacity = '0'; }, 60); }
  shakeT = 0.25;
  if (src && src.speech) src.speech.bark('attackHit');   // 当てたNPCがしゃべる
  if (playerHp <= 0) endBattle('lose');
}

// 敵の戦闘コントローラ（FLOW時・移動を担うときtrueを返す）
function updateEnemyCombat(m, dt) {
  const rd = m.ragdoll;
  const held = m.grabbed || m.clothGrabbed;
  if (rd.active || held || (m.dir && m.dir.state === 'downed')) { if (m.combat) m.combat.mode = 'idle'; return false; }
  if (!m.combat) m.combat = { mode: 'idle', t: 0, cd: randRange(1.5, 3.5) };
  const c = m.combat;
  meguCenter(m, _meguC);
  const dist = camera.position.distanceTo(_meguC);

  if (c.mode === 'idle') {
    c.cd -= dt;
    if (c.cd <= 0) {
      if (dist < MELEE_TRIGGER_DIST) { c.mode = 'telegraph'; c.t = TELEGRAPH_TIME; if (m.speech) m.speech.bark('menace'); }
      else { doRanged(m, dist); c.cd = randRange(RANGED_CD_MIN, RANGED_CD_MAX); }
    }
    return false;
  }
  if (c.mode === 'telegraph') {
    approachPlayer(m, dt, TELEGRAPH_SPEED);
    c.t -= dt; if (c.t <= 0) { c.mode = 'lunge'; c.t = LUNGE_TIME; }
    return true;
  }
  if (c.mode === 'lunge') {
    approachPlayer(m, dt, LUNGE_SPEED);
    if (dist < MELEE_HIT_RADIUS) { onPlayerDamaged(MELEE_DMG, m); c.mode = 'idle'; c.cd = MELEE_CD; }
    else { c.t -= dt; if (c.t <= 0) { c.mode = 'idle'; c.cd = MELEE_CD; } }
    return true;
  }
  return false;
}

function approachPlayer(m, dt, speed) {
  _force.copy(camera.position).sub(m.pos);
  const d = _force.length() || 1;
  m.pos.addScaledVector(_force, (speed * dt) / d);
}

// 遠距離：近くに浮遊オブジェクトがあれば50%で投擲、無ければ/残りは弾
function doRanged(m, dist) {
  void dist;
  if (Math.random() < 0.5 && throwObjectAt(m)) return;
  fireEnemyBall(m);
}

function fireEnemyBall(m) {
  meguCenter(m, _meguC);
  _hitDir.copy(camera.position).sub(_meguC).normalize();
  const geo  = new THREE.IcosahedronGeometry(ENEMY_PROJ_RADIUS, 1);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xff5050, emissive: 0x551111, roughness: 0.4 });
  const mesh = new THREE.Mesh(geo, mat);
  const pos  = _meguC.clone().addScaledVector(_hitDir, 0.4);
  mesh.position.copy(pos);
  scene.add(mesh);
  enemyProjectiles.push({ mesh, pos, vel: _hitDir.clone().multiplyScalar(ENEMY_BALL_SPEED), ttl: ENEMY_PROJ_TTL, radius: ENEMY_PROJ_RADIUS, source: m });
}

function throwObjectAt(m) {
  meguCenter(m, _meguC);
  let best = null, bestD = THROW_REACH;
  for (const obj of objects) {
    if (obj.grabbed) continue;
    const d = obj.pos.distanceTo(_meguC);
    if (d < bestD) { bestD = d; best = obj; }
  }
  if (!best) return false;
  _hitDir.copy(camera.position).sub(best.pos).normalize();
  best.vel.copy(_hitDir).multiplyScalar(THROW_SPEED);
  best.thrownBy = m; best.hazardT = HAZARD_TIME;
  return true;
}

// 敵弾の前進・プレイヤー命中・寿命
function stepEnemyProjectiles(dt) {
  for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
    const p = enemyProjectiles[i];
    p.pos.addScaledVector(p.vel, dt);
    p.ttl -= dt;
    let dead = p.ttl <= 0;
    if (!dead && (Math.abs(p.pos.x) > ROOM.x / 2 || p.pos.y < 0 || p.pos.y > ROOM.y || Math.abs(p.pos.z) > ROOM.z / 2)) dead = true;
    if (!dead && !battleOver && p.pos.distanceTo(camera.position) < p.radius + PLAYER_HIT_R) { onPlayerDamaged(BALL_DMG, p.source); dead = true; }
    if (dead) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); enemyProjectiles.splice(i, 1); }
    else p.mesh.position.copy(p.pos);
  }
}

// 浮遊オブジェクトのプレイヤー接触/投擲ヒット
function updateObjectHazards(dt) {
  if (battleOver) return;
  for (const obj of objects) {
    if (obj.grabbed) continue;
    if (obj.hazardT > 0) obj.hazardT -= dt;
    if (obj.pos.distanceTo(camera.position) < obj.radius + PLAYER_HIT_R) {
      const thrown = obj.hazardT > 0;
      onPlayerDamaged(thrown ? THROW_DMG : TOUCH_DMG, thrown ? obj.thrownBy : null);
      _hitDir.copy(obj.pos).sub(camera.position).normalize();
      obj.vel.addScaledVector(_hitDir, 6); clampSpeed(obj.vel);
      obj.hazardT = 0; obj.thrownBy = null;
    }
  }
}

function buildBattleHud() {
  if (!battleHud) {
    battleHud = document.createElement('div');
    battleHud.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:60;display:flex;gap:16px;align-items:center;background:rgba(0,0,0,0.5);color:#fff;font:14px system-ui;padding:8px 16px;border-radius:8px;pointer-events:none;';
    battleHud.innerHTML = '<span id="b-hp"></span><span id="b-def"></span>';
    document.body.appendChild(battleHud);
  }
  if (!battleVfx) {
    battleVfx = document.createElement('div');
    battleVfx.style.cssText = 'position:fixed;inset:0;z-index:55;pointer-events:none;opacity:0;transition:opacity 0.35s;box-shadow:inset 0 0 120px 30px rgba(255,0,0,0.7);';
    document.body.appendChild(battleVfx);
  }
  updateBattleHud();
}
function updateBattleHud() {
  if (!battleHud) return;
  const bars = 20, filled = Math.round((playerHp / Math.max(1, playerMaxHp)) * bars);
  const hp = document.getElementById('b-hp'), df = document.getElementById('b-def');
  if (hp) hp.textContent = `HP ${'■'.repeat(filled)}${'□'.repeat(bars - filled)} ${playerHp}/${playerMaxHp}`;
  if (df) df.textContent = `撃破 ${defeatCount}/${defeatTarget}`;
}

function endBattle(result) {
  if (battleOver) return;
  battleOver = true;
  if (battleBgm) { try { battleBgm.pause(); } catch { /* noop */ } }
  const banner = document.createElement('div');
  banner.textContent = result === 'win' ? 'WIN!' : 'LOSE…';
  banner.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;font:bold 64px system-ui;color:' + (result === 'win' ? '#9fd' : '#f88') + ';background:rgba(0,0,0,0.45);';
  document.body.appendChild(banner);
  setTimeout(() => { try { parent.postMessage({ type: 'flow-result', result }, location.origin); } catch { /* noop */ } }, 1400);
}

// 照準（カメラレイ）に最も近い m のマント頂点を CPU シャドウから探す。{ index, along } or null。
function nearestClothVertex(m) {
  if (!m.cloth || !m.cloth.cpuReady) return null;
  const cp = m.cloth.cpuPositions;
  const orig = raycaster.ray.origin, dir = raycaster.ray.direction;
  let best = -1, bestAlong = Infinity;
  for (let i = 0; i < m.cloth.vertexCount; i++) {
    _grabV.set(cp[i*3], cp[i*3+1], cp[i*3+2]).sub(orig);
    const along = _grabV.dot(dir);
    if (along < 0 || along > GRAB_RANGE) continue;
    const perp2 = _grabV.lengthSq() - along * along;     // レイからの垂直距離^2
    if (perp2 < 0.16 && along < bestAlong) { bestAlong = along; best = i; }   // 0.4m 以内
  }
  return best >= 0 ? { index: best, along: bestAlong } : null;
}

// 当たり/掴み判定の中心（飛行時 = root + 高さ、ラグドール時 = hips 粒子のワールド位置）
function meguCenter(m, out) {
  const rd = m.ragdoll;
  if (rd.active && rd.idxOf.hips != null) out.copy(rd.particles[rd.idxOf.hips].pos);
  else { out.copy(m.pos); out.y += MEGU_CENTER_Y; }
  return out;
}

function hitMegu(m, dir) {
  if (m.ragdoll.active) return;
  setRagdollActive(m.ragdoll, true);
  applyRagdollImpulse(m.ragdoll, dir.clone().multiplyScalar(RAGDOLL_IMPULSE), 'chest');
  m.grabbed = false;
  m.recoverTimer = MEGU_RECOVER_DELAY + LOOK_DURATION;
  onDefeat(m);   // フロー戦闘: 射撃命中で撃破カウント
}

// 照準レイに最も近い m の関節を探す。飛行中はボーンのワールド位置、ラグドール中は粒子位置を使う
// （スキンメッシュのレイキャストは姿勢変化で外れるため、姿勢に追従するこの方式にする）。{ bone, along } or null。
function nearestMeguJoint(m) {
  const rd = m.ragdoll;
  const orig = raycaster.ray.origin, dir = raycaster.ray.direction;
  let best = null, bestAlong = Infinity;
  for (const p of rd.particles) {
    if (rd.active) {
      _grabV.copy(p.pos);
    } else {
      const node = m.vrm.humanoid?.getNormalizedBoneNode(p.bone);
      if (!node) continue;
      node.getWorldPosition(_grabV);
    }
    _grabV.sub(orig);
    const along = _grabV.dot(dir);
    if (along < 0 || along > GRAB_RANGE) continue;
    const perp2 = _grabV.lengthSq() - along * along;
    if (perp2 < 0.25 && along < bestAlong) { bestAlong = along; best = p.bone; }   // 0.5m 以内
  }
  return best ? { bone: best, along: bestAlong } : null;
}

function grabMeguBody(m, bone) {
  m.grabbed = true;
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true);
  m.grabBone = bone || 'chest';   // 掴んだ部位（頭・手・足など）をピン
  if (m.speech) m.speech.bark('grabbed');
  updateCrosshair();
}

function grabMeguCloth(m, clothIdx) {
  updateHandAnchor();
  m.cloth.grab(clothIdx, handAnchor);                       // 掴んだマント点を手にピン
  m.clothGrabbed = true;
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true); // 本体もラグドール化して吊り下げ
  if (m.speech) m.speech.bark('grabbed');
  updateCrosshair();
}

function releaseMegu(m) {
  if (m.clothGrabbed) { m.cloth.releaseGrab(); m.clothGrabbed = false; }
  m.grabbed = false;
  m.recoverTimer = MEGU_RECOVER_DELAY + LOOK_DURATION;   // 離した後もしばらくラグドール（落下）→最後の1秒は見つめる→復帰
  if (m.speech) m.speech.bark('thrown');
  onDefeat(m);   // フロー戦闘: 投擲で撃破カウント
  updateCrosshair();
}

function onMeguRecovered(m) {
  m.vel.copy(randomDir()).multiplyScalar(randRange(2, 4));   // 新しい速度で飛行再開
  m.idleMode = 'drift'; m.idleTimer = randRange(3, 6);
}

// 掴み中の NPC（1体）を返す。無ければ null。
function grabbedMegu() {
  for (const m of megus) if (m.grabbed || m.clothGrabbed) return m;
  return null;
}

// 頭ボーンをカメラ方向へ weight(0-1) で向ける（mixer/ラグドールが頭を設定した後・vrm.update の前に呼ぶ）
function applyHeadLook(m, weight) {
  if (weight <= 0) return;
  const head = m.vrm.humanoid?.getNormalizedBoneNode('head');
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
  if (ang > HEAD_MAX_ANGLE) w *= HEAD_MAX_ANGLE / ang;   // 後ろには向きすぎない
  _hqDelta.setFromUnitVectors(_hFwd, _hDir);
  _hqDes.identity().slerp(_hqDelta, w).multiply(_hqCur);  // delta を w 分 → 望ましいワールド回転
  if (head.parent) {
    head.parent.getWorldQuaternion(_hqPar);
    head.quaternion.copy(_hqPar.invert().multiply(_hqDes));
  } else {
    head.quaternion.copy(_hqDes);
  }
}

// idle 中のサブ挙動を 3〜6秒でランダム切替：float(静止ふわふわ)/drift(緩い巡航)/dash(ランダム地点へ素早く移動)
function updateIdleMovement(m, dt) {
  m.idleTimer -= dt;
  if (m.idleTimer <= 0) {
    const modes = ['float', 'drift', 'dash'];
    m.idleMode = modes[Math.floor(Math.random() * modes.length)];
    m.idleTimer = randRange(3, 6);
    if (m.idleMode === 'dash') {
      m.dashTarget.set(
        randRange(-ROOM.x / 2 + 1, ROOM.x / 2 - 1),
        randRange(1.2, ROOM.y - 2),
        randRange(-ROOM.z / 2 + 1, ROOM.z / 2 - 1),
      );
    } else if (m.idleMode === 'drift') {
      const d = randomDir(); d.y *= 0.4;
      m.vel.copy(d.normalize()).multiplyScalar(3);
    }
  }
  const k = 1 - Math.exp(-dt / 0.6);
  if (m.idleMode === 'float') {
    m.vel.x += (0 - m.vel.x) * k;
    m.vel.z += (0 - m.vel.z) * k;
    m.bobPhase += dt;
    m.vel.y = Math.sin(m.bobPhase * 1.6) * 0.35;        // ふわふわ上下
  } else if (m.idleMode === 'dash') {
    _force.copy(m.dashTarget).sub(m.pos);
    const dist = _force.length();
    if (dist < 0.6) {
      m.vel.multiplyScalar(1 - k);                      // 到着で減速
    } else {
      _force.multiplyScalar(7 / dist);                  // 目標へ約7m/s
      m.vel.x += (_force.x - m.vel.x) * k;
      m.vel.y += (_force.y - m.vel.y) * k;
      m.vel.z += (_force.z - m.vel.z) * k;
    }
  } else { // drift（緩い巡航。速度が落ちたら補充）
    if (m.vel.lengthSq() < 1.0) { const d = randomDir(); d.y *= 0.4; m.vel.copy(d.normalize()).multiplyScalar(3); }
  }
}

// 挑発：プレイヤーの tauntRange(既定10m)以内へ飛来し、近づいたらゆっくり漂う
function updateTauntMovement(m, dt) {
  const range = m.sm.tauntDist || m.sm.behavior.tauntRangeMax || 10;   // 入場時に抽選した目標距離
  _force.copy(camera.position).sub(m.pos);
  const dist = _force.length() || 1;
  if (dist > range) {
    m.vel.addScaledVector(_force, (TAUNT_APPROACH * dt) / dist);
    const sp = m.vel.length(); if (sp > TAUNT_MAX) m.vel.multiplyScalar(TAUNT_MAX / sp);
  } else {
    const k = 1 - Math.exp(-dt / 0.4);
    m.vel.x += (0 - m.vel.x) * k;
    m.vel.z += (0 - m.vel.z) * k;
    m.bobPhase += dt;
    m.vel.y += (Math.sin(m.bobPhase * 1.3) * 0.4 - m.vel.y) * k;   // ふわふわ
  }
}

// プレイヤー（カメラ）の方へ体を向ける
function faceToPlayer(m, dt) {
  const dx = camera.position.x - m.pos.x, dz = camera.position.z - m.pos.z;
  if (dx * dx + dz * dz < 0.04) return;
  const targetYaw = Math.atan2(dx, dz);
  let diff = targetYaw - m.vrm.scene.rotation.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  m.vrm.scene.rotation.y += diff * (1 - Math.exp(-dt / 0.4));
}

// 進行方向へ体を向ける（VRM 前方 +Z）。静止/低速時は向きを維持。
function faceMove(m, dt) {
  const sp2 = m.vel.x * m.vel.x + m.vel.z * m.vel.z;
  if (sp2 < 0.09) return;
  const targetYaw = Math.atan2(m.vel.x, m.vel.z);
  let diff = targetYaw - m.vrm.scene.rotation.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  m.vrm.scene.rotation.y += diff * (1 - Math.exp(-dt / 0.4));
}

function updateMegu(m, dt) {
  const rd = m.ragdoll;
  // ステート更新（表情・視線・attack を決定）
  const held = m.grabbed || m.clothGrabbed;
  meguCenter(m, _meguC);
  m.dir = m.sm ? m.sm.update(dt, {
    ragdollActive: rd.active, ragdollRecovering: rd.recovering,
    held, distanceToPlayer: camera.position.distanceTo(_meguC),
  }) : null;

  // ダウン中、復帰直前の LOOK_DURATION 秒は倒れたまま目＋首でプレイヤーを見る
  if (m.dir && m.dir.state === 'downed' && !held && m.recoverTimer <= LOOK_DURATION) {
    m.dir.lookAtEye = 1.0;
    m.dir.lookAtHead = 0.7;
  }

  // ステート変化を検知してセリフを切替＋落下衝突(landed)を判定
  if (m.speech) {
    const cur = m.dir ? m.dir.state : null;
    if (cur && cur !== m.prevState) { m.speech.onState(cur); m.prevState = cur; }
    // 中心の鉛直速度を推定：ラグドールで高速落下中→床近傍 で landed bark
    const vy = dt > 0 ? (_meguC.y - m.prevCenterY) / dt : 0;
    if (rd.active && !held && m.prevVy < -LANDED_SPEED_THRESHOLD && _meguC.y <= LANDED_MARGIN) {
      m.speech.bark('landed');
    }
    m.prevVy = vy;
    m.prevCenterY = _meguC.y;
  }

  if (rd.active) {
    // 被弾/本体掴み/マント掴みいずれもラグドール。
    const env = { floorY: 0, bounds: ARENA_BOUNDS };
    const held = m.grabbed || m.clothGrabbed;
    if (m.grabbed) {
      // 本体掴み：掴んだ部位（手・足・頭など）を手アンカーにハードピン
      updateHandAnchor(); env.pinBone = m.grabBone || 'chest'; env.pinPos = handAnchor;
    } else if (m.clothGrabbed) {
      // マント掴み：胸を手アンカーへ“緩く”引き寄せ → 本体は吊り下がってぶらぶら
      updateHandAnchor(); env.tetherBone = 'chest'; env.tetherPos = handAnchor; env.tetherStrength = 0.03;
    }
    updateRagdoll(rd, dt, env);
    if (!held) {
      m.recoverTimer -= dt;
      if (m.recoverTimer <= 0) setRagdollActive(rd, false);   // 復帰開始
    }
  } else if (rd.recovering) {
    if (m.mixer) m.mixer.update(dt);
    updateRagdollRecovery(rd, dt);
    if (!rd.recovering) onMeguRecovered(m);
  } else {
    if (m.mixer) m.mixer.update(dt);
    // フロー戦闘: 戦闘コントローラ（近接予備動作/踏み込み中は移動を担う・遠距離は撃つだけ）
    const combatMove = (FLOW && battleCfg && !battleOver) ? updateEnemyCombat(m, dt) : false;
    if (combatMove) {
      bounceAxis(m, 'x', -ROOM.x / 2 + MEGU_RADIUS, ROOM.x / 2 - MEGU_RADIUS);
      bounceAxis(m, 'y', 0.2, ROOM.y - 1.8);
      bounceAxis(m, 'z', -ROOM.z / 2 + MEGU_RADIUS, ROOM.z / 2 - MEGU_RADIUS);
      m.vrm.scene.position.copy(m.pos);
      faceToPlayer(m, dt);
    } else {
      const st = m.dir ? m.dir.state : 'idle';
      if (st === 'attack') {
        // attack：プレイヤー方向へ接近加速
        _force.copy(camera.position).sub(m.pos);
        const d = _force.length() || 1;
        m.vel.addScaledVector(_force, (m.sm.behavior.approachAccel * dt) / d);
        clampSpeed(m.vel);
      } else if (st === 'taunt') {
        updateTauntMovement(m, dt);   // 10m以内へ飛来→ゆっくり
      } else {
        updateIdleMovement(m, dt);    // float / drift / dash を3〜6秒で切替
      }
      m.pos.addScaledVector(m.vel, dt);
      bounceAxis(m, 'x', -ROOM.x / 2 + MEGU_RADIUS, ROOM.x / 2 - MEGU_RADIUS);
      bounceAxis(m, 'y', 0.2, ROOM.y - 1.8);
      bounceAxis(m, 'z', -ROOM.z / 2 + MEGU_RADIUS, ROOM.z / 2 - MEGU_RADIUS);
      m.vrm.scene.position.copy(m.pos);
      if (st === 'taunt' || st === 'attack') faceToPlayer(m, dt);   // 挑発/攻撃中はプレイヤーを向く
      else faceMove(m, dt);                                          // それ以外は進行方向
    }
  }

  // 表情・視線をステート出力から適用（vrm.update の前に設定）
  if (m.dir && m.sm) {
    const em = m.vrm.expressionManager;
    if (em) {
      for (const name of m.sm.expressionNames) em.setValue(name, m.dir.expression[name] ?? 0);
      // フロー戦闘: 予備動作/踏み込み中は怒り表情で威嚇（FLOW時のみ）
      if (FLOW && m.combat && m.combat.mode !== 'idle') { try { em.setValue('angry', 0.9); } catch { /* noop */ } }
      else if (FLOW) { try { em.setValue('angry', m.dir.expression['angry'] ?? 0); } catch { /* noop */ } }
      // 自動まばたき（ダウン中は除く）
      if (m.blinkT <= 0 && m.blinkDur <= 0) { m.blinkDur = 0.12; m.blinkT = randRange(2.5, 6); }
      m.blinkT -= dt;
      let bw = 0;
      if (m.blinkDur > 0) { m.blinkDur -= dt; bw = Math.sin((1 - Math.max(0, m.blinkDur) / 0.12) * Math.PI); }
      em.setValue('blink', m.dir.state === 'downed' ? 0 : bw);
    }
    // 顔をプレイヤーへ。重みを時定数で滑らかに目標へ寄せる＝ゆっくり向く（急に向かない）
    const targetHeadW = m.dir.lookAtHead || 0;
    m.headLookW += (targetHeadW - m.headLookW) * (1 - Math.exp(-dt / HEAD_LOOK_TAU));
    if (m.headLookW > 0.01) applyHeadLook(m, m.headLookW);
    if (m.vrm.lookAt) m.vrm.lookAt.target = m.dir.lookAtEye > 0.5 ? camera : null;   // 視線をプレイヤーへ
  }
  // セリフの口パク＋行表情を適用（state 表情の後＝最後に上書き、vrm.update の前）
  if (m.speech) m.speech.update(dt);
  m.vrm.update(dt);
  if (m.cloth) {
    if (m.clothGrabbed) { updateHandAnchor(); m.cloth.moveGrab(handAnchor); }
    // 手グリップ用フレーム：アニメがあれば action.time、無ければ独自クロック（ラグドール中は凍結）
    let frame = null;
    if (m.action) {
      frame = Math.floor(m.action.time * m.tlFps);
    } else if (m.tlDuration) {
      if (!rd.active) m.tlClock += dt;
      frame = Math.floor(m.tlClock * m.tlFps) % m.tlDuration;
    }
    m.cloth.update(dt, frame);              // ボーン追従＋手グリップでマント更新（vrm.update の後）
  }
  updateMeguAura(m, dt);   // ステート連動の氷オーラ（攻撃/挑発/予備動作中に発生）
}

// ステート連動エフェクト：攻撃/挑発(state machine) または 予備動作/踏み込み(FLOW戦闘) の間だけ
// 足元から氷オーラを立ち上らせる。VRM の scene に子付けして追従。詠唱するまで生成しない（idleは無コスト）。
function updateMeguAura(m, dt) {
  const st = m.dir ? m.dir.state : 'idle';
  const held = m.grabbed || m.clothGrabbed;
  const combatCasting = m.combat && (m.combat.mode === 'telegraph' || m.combat.mode === 'lunge');
  const casting = !m.ragdoll.active && !held && (combatCasting || st === 'attack' || st === 'taunt');
  if (!m.aura) {
    if (!casting) return;
    m.aura = createFxSystem(cloneFxConfig(FX_PRESETS.frost));
    m.aura.object3D.position.set(0, 0.1, 0);   // 足元から立ち上る
    m.vrm.scene.add(m.aura.object3D);
  }
  m.aura.setEmitting(casting);
  m.aura.update(dt);
}

// NPC 頭上の吹き出し用：判定中心+オフセットをワールド→画面(px)へ投影。背面/画面外/遠距離は visible:false。
function npcScreenPos(m) {
  meguCenter(m, _bubbleV);
  _bubbleV.y += BUBBLE_Y_OFFSET;
  const dist = camera.position.distanceTo(_bubbleV);
  _bubbleV.project(camera);
  const visible = _bubbleV.z < 1 && dist <= BUBBLE_MAX_DIST &&
    _bubbleV.x >= -1 && _bubbleV.x <= 1 && _bubbleV.y >= -1 && _bubbleV.y <= 1;
  return {
    x: (_bubbleV.x * 0.5 + 0.5) * window.innerWidth,
    y: (-_bubbleV.y * 0.5 + 0.5) * window.innerHeight,
    visible,
  };
}

function updateMegus(dt) {
  for (const m of megus) updateMegu(m, dt);
  // マント位置の CPU 読み戻しは負荷が高いので毎フレーム1体だけ（ラウンドロビン）
  if (megus.length) {
    const m = megus[meguFrame % megus.length];
    if (m.cloth) m.cloth.refresh();
  }
  meguFrame++;
}

// ============================================================
// 物理ステップ
// ============================================================

function stepObjects(dt) {
  for (const obj of objects) {
    if (obj.grabbed) {
      // スプリング + ダンパでアンカーへ追従
      _force.copy(handAnchor).sub(obj.pos).multiplyScalar(params.stiffness);
      _force.addScaledVector(obj.vel, -params.damping);
      obj.vel.addScaledVector(_force, dt);
      clampSpeed(obj.vel);
      obj.pos.addScaledVector(obj.vel, dt);
      clampInside(obj);
    } else {
      obj.pos.addScaledVector(obj.vel, dt);
      const r = obj.radius;
      bounceAxis(obj, 'x', -ROOM.x / 2 + r, ROOM.x / 2 - r);
      bounceAxis(obj, 'y', r,               ROOM.y - r);
      bounceAxis(obj, 'z', -ROOM.z / 2 + r, ROOM.z / 2 - r);
    }
  }
}

// ── エフェクト（着弾スパーク） ────────────────────────────────
// lib/fx-particles の単発バーストを使い回すプール。被弾点で火花を散らす。
const sparkPool = [];
function spawnSpark(pos) {
  let slot = sparkPool.find((s) => s.idle);
  if (!slot) {
    const fx = createFxSystem(cloneFxConfig(FX_PRESETS.spark));
    scene.add(fx.object3D);
    slot = { fx, idle: true, releaseAt: 0 };
    sparkPool.push(slot);
  }
  slot.fx.object3D.position.copy(pos);
  slot.fx.burst(24);
  slot.idle = false;
  slot.releaseAt = performance.now() + 600;   // 寿命(最大0.4s)経過後にidleへ戻す
}
function updateFx(dt) {
  const now = performance.now();
  for (const s of sparkPool) {
    if (!s.idle) { s.fx.update(dt); if (now >= s.releaseAt) s.idle = true; }
  }
}

function stepProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.pos.addScaledVector(p.vel, dt);
    p.ttl -= dt;

    let dead = p.ttl <= 0;

    // 壁外に出たら消滅
    if (!dead) {
      if (Math.abs(p.pos.x) > ROOM.x / 2 || p.pos.y < 0 || p.pos.y > ROOM.y || Math.abs(p.pos.z) > ROOM.z / 2) {
        dead = true;
      }
    }

    // オブジェクト命中判定（球-球）
    if (!dead) {
      for (const obj of objects) {
        const rr = p.radius + obj.radius;
        if (p.pos.distanceToSquared(obj.pos) <= rr * rr) {
          _hitDir.copy(obj.pos).sub(p.pos);
          if (_hitDir.lengthSq() < 1e-8) _hitDir.copy(p.vel);
          _hitDir.normalize();
          obj.vel.addScaledVector(_hitDir, params.impulse);
          clampSpeed(obj.vel);
          spawnSpark(p.pos);
          dead = true;
          break;
        }
      }
    }

    // NPC 命中：未発動ならラグドール発動、発動中なら追加の撃力で小突く（倒れていても当たる）
    if (!dead) {
      for (const m of megus) {
        meguCenter(m, _meguC);
        const rr = p.radius + MEGU_RADIUS;
        if (p.pos.distanceToSquared(_meguC) <= rr * rr) {
          _hitDir.copy(p.vel).normalize();
          if (m.ragdoll.active) {
            applyRagdollImpulse(m.ragdoll, _hitDir.clone().multiplyScalar(RAGDOLL_IMPULSE), 'hips');
            if (!m.grabbed && !m.clothGrabbed) m.recoverTimer = MEGU_RECOVER_DELAY + LOOK_DURATION;   // 倒れたまま延長
          } else {
            hitMegu(m, _hitDir);
          }
          spawnSpark(p.pos);
          dead = true;
          break;
        }
      }
    }

    if (dead) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      projectiles.splice(i, 1);
    } else {
      p.mesh.position.copy(p.pos);
    }
  }
}

function physicsStep(dt) {
  updateHandAnchor();
  stepObjects(dt);
  stepProjectiles(dt);
  // 見た目の回転
  for (const obj of objects) {
    obj.mesh.rotation.x += obj.spin.x * dt;
    obj.mesh.rotation.y += obj.spin.y * dt;
    obj.mesh.rotation.z += obj.spin.z * dt;
  }
}

function syncObjectMeshes() {
  for (const obj of objects) obj.mesh.position.copy(obj.pos);
}

// ============================================================
// プレイヤー物理（fps-cloth 流用）
// ============================================================

function playerCollisions() {
  const result = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = false;
  if (result) {
    playerOnFloor = result.normal.y > 0;
    if (!playerOnFloor) {
      playerVel.addScaledVector(result.normal, -result.normal.dot(playerVel));
    }
    playerCollider.translate(result.normal.multiplyScalar(result.depth));
  }
}

function updatePlayer(dt) {
  if (!isLocked && !touchMode) return;

  const speedDelta = dt * (playerOnFloor ? PLAYER_SPEED : PLAYER_SPEED * 0.4);
  const fwd   = new THREE.Vector3(-Math.sin(playerYaw), 0, -Math.cos(playerYaw));
  const right = new THREE.Vector3( Math.cos(playerYaw), 0, -Math.sin(playerYaw));

  if (keysDown['KeyW'] || keysDown['ArrowUp'])    playerVel.addScaledVector(fwd,    speedDelta);
  if (keysDown['KeyS'] || keysDown['ArrowDown'])  playerVel.addScaledVector(fwd,   -speedDelta);
  if (keysDown['KeyA'] || keysDown['ArrowLeft'])  playerVel.addScaledVector(right, -speedDelta);
  if (keysDown['KeyD'] || keysDown['ArrowRight']) playerVel.addScaledVector(right,  speedDelta);

  if (touchMode) {   // 仮想ジョイスティック（上=前進）
    playerVel.addScaledVector(fwd,  -joystickVec.y * speedDelta);
    playerVel.addScaledVector(right, joystickVec.x * speedDelta);
  }

  let damping = Math.exp(-4 * dt) - 1;
  if (!playerOnFloor) {
    playerVel.y -= GRAVITY_ACCEL * dt;
    damping *= 0.1;
  }
  playerVel.addScaledVector(playerVel, damping);

  playerCollider.translate(playerVel.clone().multiplyScalar(dt));
  playerCollisions();

  if (playerCollider.end.y < -8) {
    playerCollider.set(
      EYE_SPAWN.clone().setY(EYE_SPAWN.y - 0.65),
      EYE_SPAWN.clone(),
      0.35,
    );
    playerVel.set(0, 0, 0);
  }

  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
}

// ============================================================
// 入力（ポインターロック + マウス + キーボード）
// ============================================================

function updateCrosshair() {
  const el = document.getElementById('crosshair');
  if (el) el.classList.toggle('grabbing', !!grabbed || !!grabbedMegu());
}

function setupControls() {
  const canvas = renderer.domElement;

  canvas.addEventListener('click', () => {
    if (touchMode) return;
    if (!isLocked) canvas.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas;
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = isLocked ? 'none' : 'flex';
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = isLocked ? 'none' : 'flex';   // プレイ中はスライダーパネルを隠す
    if (!isLocked) release();   // ロック解除時は掴みも解放
  });

  document.addEventListener('mousemove', (e) => {
    if (touchMode || !isLocked) return;
    const sens = 0.002;
    playerYaw   -= e.movementX * sens;
    playerPitch -= e.movementY * sens;
    playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
    camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
  });

  canvas.addEventListener('mousedown', (e) => {
    if (touchMode || !isLocked) return;   // 最初のクリックはロック取得のみ
    if (e.button === 0)      tryGrab();
    else if (e.button === 2) fireProjectile();
  });

  window.addEventListener('mouseup', (e) => {
    if (touchMode) return;
    if (e.button === 0) release();
  });

  document.addEventListener('keydown', (e) => {
    keysDown[e.code] = true;
    if (e.code === 'Space' && playerOnFloor) playerVel.y = JUMP_VEL;
  });
  document.addEventListener('keyup', (e) => { keysDown[e.code] = false; });

  // UI 操作中はロック解除してスライダーを触れるように
  document.getElementById('ui')?.addEventListener('mousedown', () => {
    if (isLocked) document.exitPointerLock();
  });
}

// モバイル: タッチ操作（#joystick-base がある時だけ有効＝PC版では無害）
// 左半分=移動ジョイスティック / 右半分=ドラッグで視点・短タップで発射・長押しでグラブ
const TOUCH_GRAB_MS = 320;
function setupTouchControls() {
  const base  = document.getElementById('joystick-base');
  const stick = document.getElementById('joystick-stick');
  if (!base || !stick) return;   // PC（DOM無し）では何もしない
  touchMode = true;
  isLocked  = true;
  const jump = document.getElementById('jump-btn');
  if (jump) jump.style.display = 'flex';
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e) => {
    const isLeft = e.clientX < window.innerWidth / 2;
    if (isLeft) {
      if (touchMoveT.active) return;
      touchMoveT.active = true; touchMoveT.id = e.pointerId; touchMoveT.startX = e.clientX; touchMoveT.startY = e.clientY;
      base.style.left = `${e.clientX - 70}px`; base.style.top = `${e.clientY - 70}px`; base.style.display = 'block';
      stick.style.transform = 'translate(0px, 0px)';
    } else {
      if (touchLookT.active) return;
      touchLookT.active = true; touchLookT.id = e.pointerId; touchLookT.prevX = e.clientX; touchLookT.prevY = e.clientY;
      touchLookT.downT = performance.now(); touchLookT.moved = false; touchLookT.grabbed = false;
      clearTimeout(touchLookT.timer);
      touchLookT.timer = setTimeout(() => {            // 長押し → グラブ
        if (!touchLookT.active) return;
        tryGrab();
        touchLookT.grabbed = !!grabbed || !!grabbedMegu();
      }, TOUCH_GRAB_MS);
    }
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (touchMoveT.active && e.pointerId === touchMoveT.id) {
      const dx = e.clientX - touchMoveT.startX, dy = e.clientY - touchMoveT.startY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const c = Math.min(dist, JOYSTICK_MAX), nx = dx / dist, ny = dy / dist;
        joystickVec.x = nx * (c / JOYSTICK_MAX); joystickVec.y = ny * (c / JOYSTICK_MAX);
        stick.style.transform = `translate(${nx * c}px, ${ny * c}px)`;
      }
    }
    if (touchLookT.active && e.pointerId === touchLookT.id) {
      const sens = 0.005;
      const mdx = e.clientX - touchLookT.prevX, mdy = e.clientY - touchLookT.prevY;
      if (Math.abs(mdx) + Math.abs(mdy) > 3) touchLookT.moved = true;
      playerYaw   -= mdx * sens;
      playerPitch -= mdy * sens;
      playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
      camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
      touchLookT.prevX = e.clientX; touchLookT.prevY = e.clientY;
    }
  });

  const endTouch = (e) => {
    if (touchMoveT.active && e.pointerId === touchMoveT.id) {
      touchMoveT.active = false; touchMoveT.id = -1; joystickVec.x = 0; joystickVec.y = 0;
      base.style.display = 'none'; stick.style.transform = 'translate(0px, 0px)';
    }
    if (touchLookT.active && e.pointerId === touchLookT.id) {
      clearTimeout(touchLookT.timer);
      if (touchLookT.grabbed) release();                                              // グラブ中なら離す＝投擲/解除
      else if (!touchLookT.moved && performance.now() - touchLookT.downT < TOUCH_GRAB_MS) fireProjectile();  // 短タップ＝発射
      touchLookT.active = false; touchLookT.id = -1; touchLookT.grabbed = false; touchLookT.moved = false;
    }
  };
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);

  jump?.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (playerOnFloor) playerVel.y = JUMP_VEL; });
}

// ============================================================
// UI
// ============================================================

function bindSlider(id, key, fmt, onChange) {
  const slider = document.getElementById(id);
  const valEl  = document.getElementById(`${id}-val`);
  if (!slider) return;
  const apply = () => {
    const v = parseFloat(slider.value);
    if (valEl) valEl.textContent = fmt(v);
    if (key) params[key] = v;
    if (onChange) onChange(v);
  };
  slider.addEventListener('input', apply);
  apply();
}

function setupUI() {
  let countTimer = null;
  bindSlider('obj-count', null, v => String(v | 0), (v) => {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      params.objectCount = v | 0;
      setObjectCount(params.objectCount);
    }, 250);
  });
  bindSlider('stiffness',     'stiffness',    v => String(v | 0));
  bindSlider('damping',       'damping',      v => v.toFixed(1));
  bindSlider('release-boost', 'releaseBoost', v => v.toFixed(1));
  bindSlider('proj-speed',    'projSpeed',    v => String(v | 0));
  bindSlider('impulse',       'impulse',      v => String(v | 0));
  bindSlider('restitution',   'restitution',  v => v.toFixed(2));
}

// ============================================================
// レンダリングループ
// ============================================================

function updateFPS() {
  fpsFrameCount++;
  const now     = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount / (elapsed / 1000));
    fpsFrameCount = 0;
    fpsLastTime   = now;
    const el = document.getElementById('fps-counter');
    if (el) el.textContent = `${fps} FPS`;
  }
}

function render() {
  timer.update();
  updateFPS();

  const dt = Math.min(timer.getDelta(), 1 / 30);
  updatePlayer(dt);

  const timePerStep = 1 / STEP_HZ;
  let steps = 0;
  timeSinceLastStep += dt;
  while (timeSinceLastStep >= timePerStep && steps < MAX_STEPS_FRAME) {
    physicsStep(timePerStep);
    timeSinceLastStep -= timePerStep;
    steps++;
  }
  if (steps >= MAX_STEPS_FRAME) timeSinceLastStep = 0;

  syncObjectMeshes();
  updateMegus(dt);
  updateFx(dt);
  if (speechUI) speechUI.update(dt, npcScreenPos);
  if (FLOW && battleCfg) {
    if (!battleOver) { battleTime += dt; updateObjectHazards(dt); }
    stepEnemyProjectiles(dt);
    if (shakeT > 0) { shakeT -= dt; const s = 0.012 * (shakeT / 0.25); camera.rotation.x += (Math.random() - 0.5) * s; camera.rotation.y += (Math.random() - 0.5) * s; }
  }
  renderer.render(scene, camera);
}

// ============================================================
// 初期化
// ============================================================

async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');

  renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },   // マント(GPUクロス)の頂点シェーダで必要
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd8ef);       // 空の色（スカイドームの背後フォールバック）
  scene.fog = new THREE.FogExp2(0xcfe3f5, 0.008);     // 薄い空気遠近

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 600);
  camera.rotation.order = 'YXZ';

  // 空：グラデーションのスカイドーム（天頂=青 → 地平=淡い）
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  const skyT = positionWorld.normalize().y.mul(0.5).add(0.5).clamp(0, 1);   // 0=地平, 1=天頂
  skyMat.colorNode = mix(color(0xeaf4fb), color(0x3f86d4), skyT);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // ライティング：/cloth と同様に HDR 環境マップ(IBL)を主体に。VRM(MToon)用に弱い太陽光を併用。
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xfff6e6, 1.5);
  key.position.set(5, 12, 6);
  scene.add(key);
  try {
    const hdr = await new UltraHDRLoader().loadAsync(
      'https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg',
    );
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;   // IBL（背景は空グラデーションのまま）
  } catch (e) {
    console.warn('HDR 環境マップ読み込み失敗（ライトのみで継続）:', e);
  }

  buildArena();

  playerCollider = new Capsule(
    EYE_SPAWN.clone().setY(EYE_SPAWN.y - 0.65),
    EYE_SPAWN.clone(),
    0.35,
  );
  playerVel.set(0, 0, 0);
  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');

  setObjectCount(params.objectCount);
  // 選択モデル(GLB)を読み込んだら、プリミティブを選択モデルに置き換えて再生成
  loadSelectedModels().then(() => { if (modelTemplates.length) setObjectCount(params.objectCount); })
    .catch(e => console.warn('選択モデル読み込み失敗:', e));
  if (FLOW) {
    // フロー戦闘: 親(flow-player)からの flow-config を待って敵/ステージを出現・戦闘開始
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin) return;
      if (e.data && e.data.type === 'flow-config') startBattle(e.data.battle);
    });
    try { parent.postMessage({ type: 'flow-ready' }, location.origin); } catch { /* noop */ }
  } else {
    loadStage().catch(e => console.warn('ステージ読み込み失敗:', e));   // サンドボックス既定（models/stage.json）
    loadMegus().catch(e => console.warn('Megu 読み込み失敗:', e));
  }
  setupUI();
  setupControls();
  setupTouchControls();   // #joystick-base があれば（モバイル版ビルド）タッチ操作を有効化
  speechUI = createSpeechUI({ dom: document.body });   // セリフ表示（下部ウィンドウ＋頭上吹き出し）

  const lockOverlay = document.getElementById('lock-overlay');
  if (lockOverlay) lockOverlay.style.display = 'flex';

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
}

init().catch((err) => {
  console.error(err);
  const detail = document.getElementById('error-detail');
  if (detail) detail.textContent = String(err);
  document.getElementById('error-msg').classList.add('visible');
  document.getElementById('loading').style.display = 'none';
});
