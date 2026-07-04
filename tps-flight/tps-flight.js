// tps-flight.js — サイキッカー空中アクション（TPS）。swing-catch ベース。
// Three.js v0.184 (WebGPU)。設計: .tmp/design.md
//
// 構成: プレイヤー=可視VRM(Joy_reborn) を飛行操作。球面カメラ＋スプリング追従。
//       状態別 VRMA を crossFade、マント(lib/vrm-cloth)は timeline の grip グループを状態ごとに切替。
//       浮遊オブジェクトを目の前へ引き寄せ(グラブ)・前方へ射出(ショット)。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { positionWorld, mix, color } from 'https://esm.sh/three@0.184.0/tsl';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { createMeshFx } from '../lib/fx-mesh.js';
import { createTornado } from '../lib/fx-tornado.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse, disposeRagdoll } from '../lib/vrm-ragdoll.js';

// ── アリーナ ───────────────────────────────────────────────────
const ROOM = { x: 30, y: 30, z: 30 };

// ── 飛行パラメータ（UIで一部上書き）─────────────────────────────
const flight = {
  accel:    32,    // 加速度
  drag:     2.4,   // 速度減衰（exp(-drag*dt)）
  maxSpeed: 9,     // 速度上限（NPC同等の体感。UIの「速度」スライダー＝最大m/s）
  turn:     8,     // 体の向きの追従速度
};
// プレイヤーキャラは ?npc= で切替（既定 Joy_reborn）。UIのキャラ選択から変更可。
const PLAYER_NPC = new URLSearchParams(location.search).get('npc') || 'Joy_reborn.npc.json';
// 体向き補正：VRMの正面が逆に焼かれている個体だけ180°回す（既定0、Joy_rebornのみπ）。
const NPC_FACE_OFFSET = { 'Joy_reborn.npc.json': Math.PI };
const FACE_OFFSET = NPC_FACE_OFFSET[PLAYER_NPC] ?? 0;

// ── カメラ（UIで上書き・localStorage保存）───────────────────────
const cam = {
  dist:   4.0,
  height: 1.2,    // 注視点の高さ（プレイヤー原点からのオフセット）
  follow: 8.0,    // スプリング追従の速さ
  fov:    70,
  sens:   1.0,    // マウス感度倍率
};
const CAM_PITCH_MIN = -1.25, CAM_PITCH_MAX = 1.35;
const MOUSE_SENS_BASE = 0.0024;

// ── グラブ / ショット ───────────────────────────────────────────
const GRAB_RANGE       = 40;
const GRAB_FRONT_DIST  = 1.9;   // 体の前方アンカー距離（実際はさらに掴んだ物の半径を加算）
const GRAB_FRONT_Y     = 1.0;   // アンカーの高さ（原点から）

// ── NPC（swing-catch 流用）──
const NPC_RADIUS        = 0.55;   // 当たり/掴み判定の体半径
const NPC_CENTER_Y      = 1.0;    // 飛行時の判定中心の高さ（root からのオフセット）
const NPC_RECOVER_DELAY = 2.5;    // 被弾→ラグドール継続時間(秒)
const LOOK_DURATION     = 1.5;    // 復帰前に見つめる時間(秒)
const RAGDOLL_IMPULSE   = 0.3;    // 命中時の速度キック
const ARENA_BOUNDS = {
  min: new THREE.Vector3(-ROOM.x / 2, 0, -ROOM.z / 2),
  max: new THREE.Vector3( ROOM.x / 2, ROOM.y, ROOM.z / 2),
};
const HEAD_FWD       = new THREE.Vector3(0, 0, 1);   // VRM の顔正面（+Z）
const HEAD_MAX_ANGLE = Math.PI * 0.6;
const HEAD_LOOK_TAU  = 0.6;
const GRAB_STIFFNESS   = 60;
const GRAB_DAMPING     = 6;
const SHOT_SPEED       = 34;
const MAX_OBJ_SPEED    = 40;
const HOLD_TURN        = 18;     // グラブ中に体(=掴んだ物)をマウス方向へ向ける速さ（振り回し）
const THROW_BOOST      = 1.6;    // 離したときの投擲ブースト（振り回した速度に乗算）
const MAX_CHARGE_TIME  = 1.5;    // ラージショット最大チャージ秒
const LARGE_MIN_LEVEL  = 0.25;   // 最小チャージ量（軽く押しただけでも出る）
const TAP_THRESHOLD    = 0.18;   // これ未満で離したら通常ショット（cas1_L1）。超えたらチャージ→ラージ。
const AFK_DELAY        = 3;       // 無操作がこの秒数続いたら放置モーション（drain0→drain1ループ）

// ── 物理ステップ ───────────────────────────────────────────────
const STEP_HZ = 120, MAX_STEPS_FRAME = 5;
let timeSinceLastStep = 0;

// ── プレイヤー初期位置（空中）──────────────────────────────────
const PLAYER_SPAWN = new THREE.Vector3(0, ROOM.y * 0.5, ROOM.z / 2 - 4);

// ── globals ─────────────────────────────────────────────────────
let renderer, scene, camera;
const objects     = [];
const projectiles = [];
let   grabbed     = null;

const keysDown = {};
let   isLocked = false;

// プレイヤー（VRM）
const player = {
  vrm: null, cloth: null, mixer: null,
  states: {}, current: null,
  pos: PLAYER_SPAWN.clone(),
  vel: new THREE.Vector3(),
  yaw: Math.PI,            // 体の向き（faceDir = (sin,0,cos)）
  fwdY: 0,                 // カメラ前方ベクトルのY成分（降下判定用。下向き=負）
  oneShot: null,           // { name, until } 一発再生（grab/shot）
  charging: false,         // RMB長押しでラージショットをチャージ中
  chargeT: 0,              // チャージ経過秒
  wrapping: false,         // 左クリック長押し中（掴む対象なし）。wrap を再生→最後で保持
  afk: null,               // 放置モーション状態（null / 'drain0' / 'drain1'）
  idleT: 0,                // 無操作の経過秒
  ready: false,
};
const DESCEND_SIN = 0.3;   // 前進方向がこれ以上下を向いていたら「降下」とみなす（約17°）

// NPC リスト：サイキッカー(kind:'psychic'・浮遊) ＋ 一般人モブ(kind:'mob'・地上で逃げまどう)
const npcs = [];

// ── 一般人モブ（地上で逃げまどう）──
const MOB_CHAR       = 'ken.npc.json';
const MOB_WALK_VRMA  = 'Catwalk_Walk_Forward.vrma';   // 地上ロコモーション（ルートモーションは除去して足踏み）
const MOB_WALK_SPEED = 1.6;     // うろつき速度(m/s)
const MOB_RUN_SPEED  = 4.4;     // 逃走速度(m/s)
const MOB_FLEE_RADIUS = 7.5;    // プレイヤーがこの距離内なら逃げる
const MOB_STEER_TAU  = 0.45;    // 速度の追従時定数
const DEFAULT_MOB_COUNT = 4;
const mobAssets = { ready: false, bundle: null, vrmBlobUrl: null, walkAnim: null, faceOff: 0 };

// カメラ状態（球面 + スプリング現在値）
let camYaw = Math.PI, camPitch = 0.15;
const camPosCur    = new THREE.Vector3();
const camTargetCur = new THREE.Vector3();
const frontAnchor  = new THREE.Vector3();

// 再利用テンポラリ
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();
const _npcC  = new THREE.Vector3();
const _grabV = new THREE.Vector3();
const _force = new THREE.Vector3();
const _hPos = new THREE.Vector3(), _hDir = new THREE.Vector3(), _hFwd = new THREE.Vector3();
const _hqCur = new THREE.Quaternion(), _hqPar = new THREE.Quaternion(), _hqDelta = new THREE.Quaternion(), _hqDes = new THREE.Quaternion();
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);

const timer = new THREE.Timer();
timer.connect(document);

let fpsFrameCount = 0, fpsLastTime = performance.now();

// ============================================================
// アリーナ構築（swing-catch 流用：床のみ表示・壁/天井は不可視の境界）
// ============================================================
function buildArena() {
  const group = new THREE.Group();
  const mFloor = new THREE.MeshStandardMaterial({ color: 0x2a2e44, roughness: 0.95 });
  const mWall  = new THREE.MeshStandardMaterial({ color: 0x3a3f5e, roughness: 0.9 });
  const hx = ROOM.x / 2, hz = ROOM.z / 2, t = 0.5;
  const box = (x, y, z, w, h, d, mat, vis = true) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z); mesh.visible = vis; group.add(mesh); return mesh;
  };
  box(0, -t / 2, 0, ROOM.x + t * 2, t, ROOM.z + t * 2, mFloor);                 // 床（表示）
  box(0, ROOM.y + t / 2, 0, ROOM.x + t * 2, t, ROOM.z + t * 2, mWall, false);   // 天井
  box( hx + t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall, false);
  box(-hx - t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall, false);
  box(0, ROOM.y / 2,  hz + t / 2, ROOM.x + t * 2, ROOM.y, t, mWall, false);
  box(0, ROOM.y / 2, -hz - t / 2, ROOM.x + t * 2, ROOM.y, t, mWall, false);
  scene.add(group);
}

// ============================================================
// 浮遊オブジェクト（swing-catch 流用）
// ============================================================
const SHAPES = [
  { make: () => new THREE.IcosahedronGeometry(0.42, 2), radius: 0.42 },
  { make: () => new THREE.BoxGeometry(0.7, 0.7, 0.7),   radius: 0.6 },
  { make: () => new THREE.OctahedronGeometry(0.55, 0),  radius: 0.55 },
  { make: () => new THREE.DodecahedronGeometry(0.5, 0), radius: 0.5 },
];
const modelTemplates = [];
const MODEL_TARGET_SIZE = 1.4;
const RESTITUTION = 0.92;

function randRange(min, max) { return min + Math.random() * (max - min); }
function randomDir() {
  const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
}
function clampSpeed(vel, max = MAX_OBJ_SPEED) { const s = vel.length(); if (s > max) vel.multiplyScalar(max / s); }

function prepTemplate(gltfScene, scale) {
  const box = new THREE.Box3().setFromObject(gltfScene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = (scale && scale > 0) ? scale : (MODEL_TARGET_SIZE / maxDim);
  gltfScene.position.sub(center);
  const group = new THREE.Group(); group.add(gltfScene); group.scale.setScalar(s);
  return { group, radius: Math.max(0.3, maxDim * s * 0.5) };
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

async function loadStage() {
  let stageItems = [];
  try { const r = await fetch('../models/stage.json'); if (r.ok) { const j = await r.json(); stageItems = j.items || []; } } catch { /* 無ければ空 */ }
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
        obj.position.set(-c.x, -box.min.y, -c.z);
        tpl = new THREE.Group(); tpl.add(obj); cache.set(it.model, tpl);
      }
      const mesh = tpl.clone(true);
      mesh.scale.setScalar(it.scale || 1);
      mesh.position.set(it.x, it.y || 0, it.z);
      mesh.rotation.y = it.ry || 0;
      decor.add(mesh);
    } catch (e) { console.warn('ステージ置物の読込失敗:', it.model, e); }
  }
  scene.add(decor);
}

function spawnModelObject(idx) {
  const tpl = (idx != null) ? modelTemplates[idx] : modelTemplates[Math.floor(Math.random() * modelTemplates.length)];
  const mesh = tpl.group.clone(true);
  const r = tpl.radius;
  const hx = ROOM.x / 2 - r - 0.3, hz = ROOM.z / 2 - r - 0.3;
  const pos = new THREE.Vector3(randRange(-hx, hx), randRange(r + 1, ROOM.y - r - 1), randRange(-hz, hz));
  mesh.position.copy(pos);
  scene.add(mesh);
  const obj = { mesh, radius: r, pos, vel: randomDir().multiplyScalar(randRange(3, 6)), spin: randomDir().multiplyScalar(randRange(0.5, 1.5)), grabbed: false, isGLB: true };
  mesh.userData.obj = obj; objects.push(obj); return obj;
}

function spawnObject() {
  if (modelTemplates.length) return spawnModelObject();
  const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
  const col = new THREE.Color().setHSL(Math.random(), 0.72, 0.56);
  const mesh = new THREE.Mesh(shape.make(), new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.1 }));
  const r = shape.radius, hx = ROOM.x / 2 - r - 0.3, hz = ROOM.z / 2 - r - 0.3;
  const pos = new THREE.Vector3(randRange(-hx, hx), randRange(r + 1, ROOM.y - r - 1), randRange(-hz, hz));
  mesh.position.copy(pos); scene.add(mesh);
  const obj = { mesh, radius: r, pos, vel: randomDir().multiplyScalar(randRange(3, 6)), spin: randomDir().multiplyScalar(randRange(0.5, 2.0)), grabbed: false };
  mesh.userData.obj = obj; objects.push(obj); return obj;
}

function clearObjects() {
  for (const obj of objects) {
    scene.remove(obj.mesh);
    if (!obj.isGLB) { obj.mesh.geometry.dispose(); obj.mesh.material.dispose(); }
  }
  objects.length = 0; grabbed = null;
}

function setObjectCount(n) {
  clearObjects();
  if (modelTemplates.length) {
    for (let i = 0; i < modelTemplates.length && i < n; i++) spawnModelObject(i);
    for (let i = modelTemplates.length; i < n; i++) spawnModelObject();
  } else {
    for (let i = 0; i < n; i++) spawnObject();
  }
}

function bounceAxis(obj, key, lo, hi) {
  if (obj.pos[key] < lo)      { obj.pos[key] = lo; if (obj.vel[key] < 0) obj.vel[key] = -obj.vel[key] * RESTITUTION; }
  else if (obj.pos[key] > hi) { obj.pos[key] = hi; if (obj.vel[key] > 0) obj.vel[key] = -obj.vel[key] * RESTITUTION; }
}
function clampInside(obj) {
  const r = obj.radius;
  obj.pos.x = Math.min(ROOM.x / 2 - r, Math.max(-ROOM.x / 2 + r, obj.pos.x));
  obj.pos.y = Math.min(ROOM.y - r, Math.max(r, obj.pos.y));
  obj.pos.z = Math.min(ROOM.z / 2 - r, Math.max(-ROOM.z / 2 + r, obj.pos.z));
}

function stepObjects(dt) {
  for (const obj of objects) {
    if (obj.grabbed) {
      _v1.copy(frontAnchor).sub(obj.pos).multiplyScalar(GRAB_STIFFNESS);
      _v1.addScaledVector(obj.vel, -GRAB_DAMPING);
      obj.vel.addScaledVector(_v1, dt);
      clampSpeed(obj.vel);
      obj.pos.addScaledVector(obj.vel, dt);
      clampInside(obj);
    } else {
      obj.pos.addScaledVector(obj.vel, dt);
      const r = obj.radius;
      bounceAxis(obj, 'x', -ROOM.x / 2 + r, ROOM.x / 2 - r);
      bounceAxis(obj, 'y', r, ROOM.y - r);
      bounceAxis(obj, 'z', -ROOM.z / 2 + r, ROOM.z / 2 - r);
    }
  }
}

// ── 爆発エフェクト（public/fx/explosion.fx.json）を着弾で一発再生。プールで使い回す。──
const EXPLOSION_POOL = 12, EXPLOSION_LIFE = 1.2, EXPLOSION_BURST = 2;
let explosionReady = false;
const explosions = [];   // { fx, until }

async function loadExplosion() {
  let spec;
  try { spec = await (await fetch('../fx/explosion.fx.json')).json(); } catch { return; }
  if (!Array.isArray(spec.layers)) return;
  // ゲーム用：連続発生を止めてバースト駆動、粒数を絞る（性能）
  for (const l of spec.layers) { if (l.type === 'particle') { l.spawnRate = 0; if (l.maxParticles == null) l.maxParticles = 24; } }
  for (let i = 0; i < EXPLOSION_POOL; i++) {
    try { const fx = createMeshFx(spec); fx.setEmitting(false); scene.add(fx.object3D); explosions.push({ fx, until: 0 }); }
    catch (e) { console.warn('爆発プール生成失敗', e); break; }
  }
  explosionReady = explosions.length > 0;
}

function spawnExplosion(pos) {
  if (!explosionReady) return;
  let slot = explosions.find(e => e.until <= 0);
  if (!slot) { slot = explosions[0]; for (const e of explosions) if (e.until < slot.until) slot = e; }   // 空きが無ければ最古を再利用
  slot.fx.object3D.position.copy(pos);
  slot.fx.object3D.visible = true;
  slot.fx.burst(EXPLOSION_BURST);
  slot.until = EXPLOSION_LIFE;
}

function updateExplosions(dt) {
  for (const e of explosions) {
    if (e.until <= 0) continue;
    e.fx.update(dt);
    e.until -= dt;
    if (e.until <= 0) e.fx.object3D.visible = false;
  }
}

function stepProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.pos.addScaledVector(p.vel, dt); p.ttl -= dt;
    const outOfBounds = Math.abs(p.pos.x) > ROOM.x / 2 || p.pos.y < 0 || p.pos.y > ROOM.y || Math.abs(p.pos.z) > ROOM.z / 2;
    let dead = p.ttl <= 0 || outOfBounds;
    if (outOfBounds) spawnExplosion(p.pos);   // 地面・壁・天井に着弾 → 爆発
    if (!dead) {
      for (const obj of objects) {
        const rr = p.radius + obj.radius;
        if (p.pos.distanceToSquared(obj.pos) <= rr * rr) {
          _hitDir.copy(obj.pos).sub(p.pos); if (_hitDir.lengthSq() < 1e-8) _hitDir.copy(p.vel); _hitDir.normalize();
          obj.vel.addScaledVector(_hitDir, p.power ?? 18); clampSpeed(obj.vel);
          spawnExplosion(p.pos);               // オブジェクト着弾 → 爆発
          if (!p.big) { dead = true; break; }   // ラージショットは貫通（複数を吹き飛ばす）
        }
      }
    }
    // NPC 命中：未発動ならラグドール発動、発動中なら追加の撃力（掴み中は自弾で当てない）。
    // 通常弾は最初の1体で消滅、ラージショットは貫通して複数を巻き込む。
    if (!dead) {
      for (const m of npcs) {
        if (m.grabbed || m.clothGrabbed) continue;
        npcCenter(m, _npcC);
        const rr = p.radius + NPC_RADIUS;
        if (p.pos.distanceToSquared(_npcC) > rr * rr) continue;
        _hitDir.copy(p.vel).normalize();
        const imp = RAGDOLL_IMPULSE * (p.big ? 2.2 : 1);
        if (m.ragdoll.active) applyRagdollImpulse(m.ragdoll, _hitDir.clone().multiplyScalar(imp), 'hips');
        else hitNpc(m, _hitDir, imp);
        if (!p.big) { dead = true; break; }
      }
    }
    if (dead) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); projectiles.splice(i, 1); }
    else p.mesh.position.copy(p.pos);
  }
}

function physicsStep(dt) {
  stepObjects(dt);
  stepProjectiles(dt);
  for (const obj of objects) {
    obj.mesh.rotation.x += obj.spin.x * dt; obj.mesh.rotation.y += obj.spin.y * dt; obj.mesh.rotation.z += obj.spin.z * dt;
  }
}
function syncObjectMeshes() { for (const obj of objects) obj.mesh.position.copy(obj.pos); }

// ============================================================
// プレイヤー（Joy_reborn）＋ アニメ状態機械
// ============================================================
const FADE = 0.16;

// 状態 → timeline ファイル（vrma 参照は timeline 内）/ loop
const STATE_DEFS = {
  idle:      { tl: 'Joy_reborn_Fly_idle',   loop: true  },
  fwd:       { tl: 'Joy_reborn_Fly_f',      loop: true  },
  frontDown: { tl: 'Joy_reborn_front_down', loop: true  },   // 前進＋降下
  back:     { tl: 'Joy_reborn_Fly_back',   loop: true  },
  left:     { tl: 'Joy_reborn_Fly_L',      loop: true  },
  right:    { tl: 'Joy_reborn_Fly_R',      loop: true  },
  grabMove: { tl: 'Joy_reborn_Fly_f2',     loop: true  },
  grab:     { tl: 'Joy_reborn_capcher1',   loop: false },
  wrap:     { tl: 'Joy_reborn_wrap',       loop: false },   // 左クリックで掴む対象が無いとき。最後で停止保持
  shot:     { tl: 'Joy_reborn_cas1_L1',    loop: false },
  throw:    { tl: 'Joy_reborn_throw',      loop: false },
  largeLoad: { tl: 'Joy_reborn_large_shot_load', loop: true  },   // RMB長押し＝チャージ
  large:     { tl: 'Joy_reborn_large_shot',      loop: false },   // RMB解放＝ラージショット
  drain0:    { tl: 'Joy_reborn_drain_0',         loop: false },   // 放置3秒で一度だけ再生
  drain1:    { tl: 'Joy_reborn_drain_1',         loop: true  },   // その後ループ（入力まで）
};

function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ルートモーション除去：hips(=唯一の position トラック)の水平(X,Z)をフレーム0で固定。
// 位置はゲーム側(player.pos)が制御するため、アニメ由来の平行移動をなくす（縦Yの上下動は残す）。
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (!t.name.endsWith('.position')) continue;
    const v = t.values;
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
}

async function loadPlayer() {
  const bundle = await (await fetch('../npc/' + PLAYER_NPC)).json();
  // VRM
  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  const vrm = gltf.userData.vrm;
  vrm.scene.position.copy(player.pos);
  vrm.scene.rotation.y = player.yaw + FACE_OFFSET;
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
  player.vrm = vrm;
  player.mixer = new THREE.AnimationMixer(vrm.scene);

  // マント（cloth）。floorY を無効化して空中でも落ちないように。初期 timeline は idle。
  if (bundle.cloth) {
    try {
      player.cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: player.pos, floorY: -1e9 });
    } catch (e) { console.warn('マント生成失敗:', e); }
  }

  // 状態ごとの VRMA クリップ／アクションをロード
  for (const [name, def] of Object.entries(STATE_DEFS)) {
    try {
      const tl = await (await fetch('../timeline/' + def.tl + '.timeline.json')).json();
      const vrmaName = tl.vrma;
      if (!vrmaName) { console.warn('timeline に vrma 参照がありません:', def.tl); continue; }
      const vres = await fetch('../vrma/' + encodeURIComponent(vrmaName));
      if (!vres.ok) { console.warn('VRMA 取得失敗:', vrmaName); continue; }
      const al = new GLTFLoader();
      al.register(p => new VRMAnimationLoaderPlugin(p));
      const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
      const anims = ag.userData.vrmAnimations;
      if (!anims?.length) { console.warn('VRMA にアニメがありません:', vrmaName); continue; }
      const clip = createVRMAnimationClip(anims[0], vrm);
      stripRootMotion(clip);   // アニメのルートモーション(平行移動)を除去
      const action = player.mixer.clipAction(clip);
      action.setLoop(def.loop ? THREE.LoopRepeat : THREE.LoopOnce, def.loop ? Infinity : 1);
      action.clampWhenFinished = !def.loop;
      // トリム（再生区間）。timeline の trimIn/trimOut を反映。未設定なら全体。
      const fps = tl.fps || 30;
      const total = Math.max(1, Math.round(clip.duration * fps));
      const tin  = Number.isFinite(tl.trimIn)  ? Math.max(0, Math.min(tl.trimIn, total - 1)) : 0;
      const tout = Number.isFinite(tl.trimOut) ? Math.max(tin + 1, Math.min(tl.trimOut, total)) : total;
      const speed = (Number.isFinite(tl.speed) && tl.speed > 0) ? tl.speed : 1;   // 再生速度（cloth-preview で保存）
      player.states[name] = { action, timeline: tl, fps, dur: clip.duration, loop: def.loop, trimIn: tin, trimOut: tout, total, speed };
      await createStateEffects(player.states[name], tl);   // timeline の effect トラックを準備
    } catch (e) { console.warn('状態ロード失敗:', name, e); }
  }

  // 初期状態 = idle
  const idle = player.states.idle;
  if (idle) {
    idle.action.play(); idle.action.setEffectiveWeight(1);
    player.current = 'idle';
    if (player.cloth) player.cloth.setTimeline(idle.timeline);
  }
  player.ready = true;
}

function setState(name) {
  if (!player.states[name] || player.current === name) return;
  if (player.current && player.states[player.current]) hideStateEffects(player.states[player.current]);
  const prev = player.current ? player.states[player.current].action : null;
  const next = player.states[name];
  next.effLastFrame = -1;   // 効果の発火追跡をリセット（状態頭から）
  next.action.reset();
  next.action.setEffectiveTimeScale(next.speed || 1);   // 再生速度（timeline.json の speed）
  next.action.setEffectiveWeight(1);
  next.action.enabled = true;
  if (next.trimIn > 0) next.action.time = next.trimIn / next.fps;   // トリム開始から再生
  next.action.play();
  if (prev && prev !== next.action) prev.crossFadeTo(next.action, FADE, false);
  player.current = name;
  if (player.cloth) player.cloth.setTimeline(next.timeline);
}

// 入力＋保持状況から望ましい状態を決定
function desiredState() {
  if (player.oneShot) return player.oneShot.name;
  const moving = keysDown['KeyW'] || keysDown['ArrowUp'] || keysDown['KeyS'] || keysDown['ArrowDown']
              || keysDown['KeyA'] || keysDown['ArrowLeft'] || keysDown['KeyD'] || keysDown['ArrowRight'];
  if (player.wrapping && !moving && player.states.wrap) return 'wrap';   // 左クリック保持中＆非移動時のみ（移動中は移動モーション）
  if (player.charging && player.chargeT >= TAP_THRESHOLD) return 'largeLoad';   // 閾値超過の長押しだけ溜めモーション
  if (isHolding()) return moving ? 'grabMove' : 'idle';
  const fwd = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwd && player.fwdY < -DESCEND_SIN)          return 'frontDown';   // 前進＋降下
  if (fwd)                                        return 'fwd';
  if (keysDown['KeyS'] || keysDown['ArrowDown'])  return 'back';
  if (keysDown['KeyA'] || keysDown['ArrowLeft'])  return 'left';
  if (keysDown['KeyD'] || keysDown['ArrowRight']) return 'right';
  if (player.afk === 'drain0' && player.states.drain0) return 'drain0';   // 放置3秒→一度だけ
  if (player.afk === 'drain1' && player.states.drain1) return 'drain1';   // 続けてループ
  return 'idle';
}

function triggerOneShot(name) {
  const st = player.states[name];
  if (!st) return;
  // 一発再生の継続時間 = トリム区間長(秒) ÷ 速度（速いほど短く終わる）
  const playDur = (st.trimOut - st.trimIn) / st.fps;
  player.oneShot = { name, until: Math.max(0.05, playDur / (st.speed || 1)) };
  st.action.reset();
  if (st.trimIn > 0) st.action.time = st.trimIn / st.fps;   // 同状態再トリガ時もトリム開始から
  st.action.setEffectiveTimeScale(st.speed || 1);
  setState(name);
}

// 操作があったら放置タイマー/モーションを解除（カーソル移動・キー・クリック）
function resetIdle() {
  player.idleT = 0;
  player.afk = null;
}

// 放置(AFK)検出：無操作が AFK_DELAY 秒続いたら drain0 を一度→drain1 ループ。
function updateAfk(dt) {
  const moving = keysDown['KeyW'] || keysDown['ArrowUp'] || keysDown['KeyS'] || keysDown['ArrowDown']
              || keysDown['KeyA'] || keysDown['ArrowLeft'] || keysDown['KeyD'] || keysDown['ArrowRight'];
  if (!isLocked || moving || player.oneShot || player.charging || player.wrapping || isHolding()) { resetIdle(); return; }
  player.idleT += dt;
  if (!player.afk && player.idleT >= AFK_DELAY && player.states.drain0) player.afk = 'drain0';
  // drain0 を最後まで再生し終えたら drain1 ループへ
  if (player.afk === 'drain0' && player.current === 'drain0') {
    const st = player.states.drain0;
    if (st && st.action.time >= st.dur - 1e-3) player.afk = 'drain1';
  }
}

// 現在状態の再生時刻をトリム区間に収める。未トリム状態は何もしない。
// ループ=区間内で折返し / 単発=末尾(trimOut)で保持。フルクリップのまま時刻だけ制御するので
// cloth に渡すフレーム番号は元の timeline と一致し、grip 範囲/gripPos と整合する。
function applyTrim() {
  const st = player.states[player.current];
  if (!st || (st.trimIn <= 0 && st.trimOut >= st.total)) return;
  const inT = st.trimIn / st.fps, outT = st.trimOut / st.fps;
  const a = st.action;
  let changed = false;
  if (a.time >= outT) {
    if (st.loop) { const span = Math.max(1e-3, outT - inT); a.time = inT + ((a.time - inT) % span); }
    else a.time = outT;   // 単発は末尾で保持
    changed = true;
  } else if (a.time < inT - 1e-4) { a.time = inT; changed = true; }
  if (changed) player.mixer.update(0);   // クランプ後の時刻で再サンプル
}

// ── timeline の effect トラック再生（FXエディタで配置した効果をアニメと同期して発生）──
const D2R = THREE.MathUtils.degToRad;
const _efPos = new THREE.Vector3(), _efQuat = new THREE.Quaternion(), _efTmpQ = new THREE.Quaternion();
const _efOff = new THREE.Vector3(), _efE = new THREE.Euler(), _EF_UP = new THREE.Vector3(0, 1, 0);
const _fxSpecCache = new Map();

async function loadFxSpec(name) {
  if (_fxSpecCache.has(name)) return _fxSpecCache.get(name);
  let spec = null;
  try { const j = await (await fetch('../fx/' + name + '.fx.json')).json(); if (Array.isArray(j.layers)) spec = j; } catch { /* 無し */ }
  _fxSpecCache.set(name, spec);
  return spec;
}

// effect トラックから fx インスタンスを生成（custom:*=メッシュVFX / tornado / 粒子）
async function makeEffectFx(track) {
  const preset = track.preset || 'fire';
  if (preset.startsWith('custom:')) {
    const spec = await loadFxSpec(preset.slice(7));
    return spec ? createMeshFx(spec) : null;
  }
  if (preset === 'tornado') {
    const p = track.params || {};
    return createTornado({ color: p.color, timeScale: p.timeScale, parabolStrength: p.parabolStrength, parabolOffset: p.parabolOffset, parabolAmplitude: p.parabolAmplitude, scale: p.scale });
  }
  const cfg = cloneFxConfig(FX_PRESETS[preset] || FX_PRESETS.fire);
  const pr = track.params || {};
  if (pr.colorStart) cfg.color.start = pr.colorStart;
  if (pr.colorEnd) cfg.color.end = pr.colorEnd;
  if (pr.spawnRate != null) cfg.spawnRate = pr.spawnRate;
  if (pr.sizeStart != null) cfg.size.start = pr.sizeStart;
  if (pr.sizeEnd != null) cfg.size.end = pr.sizeEnd;
  return createFxSystem(cfg);
}

// 状態の timeline から effect を生成してシーンに配置（非表示で待機）
async function createStateEffects(st, tl) {
  st.effects = [];
  st.effLastFrame = -1;
  for (const trk of (tl.tracks || [])) {
    if (trk.kind !== 'effect') continue;
    try {
      const fx = await makeEffectFx(trk);
      if (!fx) continue;
      fx.setEmitting(false);
      fx.object3D.visible = false;
      scene.add(fx.object3D);
      st.effects.push({ track: trk, fx });
    } catch (e) { console.warn('効果生成失敗:', trk, e); }
  }
}

// 発生位置：bone=プレイヤーのボーン追従 / world=キャラのルート相対（位置＋体の向き）
function computeEffectTransform(trk, obj) {
  const pos = trk.pos || [0, 0, 0], rot = trk.rot || [0, 0, 0];
  _efE.set(D2R(rot[0]), D2R(rot[1]), D2R(rot[2]));
  if (trk.anchor === 'bone' && player.vrm) {
    const node = player.vrm.humanoid?.getNormalizedBoneNode(trk.bone);
    if (node) {
      node.updateWorldMatrix(true, false);
      node.getWorldPosition(_efPos); node.getWorldQuaternion(_efQuat);
      obj.quaternion.copy(_efQuat).multiply(_efTmpQ.setFromEuler(_efE));
      obj.position.copy(_efOff.set(pos[0], pos[1], pos[2]).applyQuaternion(_efQuat)).add(_efPos);
      return;
    }
  }
  _efQuat.setFromAxisAngle(_EF_UP, player.yaw + FACE_OFFSET);
  obj.quaternion.copy(_efQuat).multiply(_efTmpQ.setFromEuler(_efE));
  obj.position.copy(_efOff.set(pos[0], pos[1], pos[2]).applyQuaternion(_efQuat)).add(player.pos);
}

function driveStateEffects(st, frame, dt) {
  if (!st || !st.effects || !st.effects.length) return;
  let prev = st.effLastFrame;
  if (frame < prev) prev = frame - 1;   // ループ折返し時は取りこぼしを避けるだけ
  for (const ef of st.effects) {
    const trk = ef.track;
    computeEffectTransform(trk, ef.fx.object3D);
    if (trk.mode === 'range') {
      ef.fx.setEmitting(frame >= (trk.start ?? 0) && frame <= (trk.end ?? 0));
    } else if (trk.frame > prev && trk.frame <= frame) {
      ef.fx.object3D.visible = true;
      ef.fx.burst(trk.count || 10);   // 発射フレームを跨いだ瞬間に一発
    }
    ef.fx.update(dt);
  }
  st.effLastFrame = frame;
}

function hideStateEffects(st) {
  if (!st || !st.effects) return;
  for (const ef of st.effects) { ef.fx.setEmitting(false); ef.fx.object3D.visible = false; }
}

function updatePlayerAnim(dt) {
  if (!player.ready) return;
  updateAfk(dt);
  // 一発再生の終了判定
  if (player.oneShot) {
    player.oneShot.until -= dt;
    if (player.oneShot.until <= 0) player.oneShot = null;
  }
  // チャージ蓄積（上限まで）
  if (player.charging) player.chargeT = Math.min(MAX_CHARGE_TIME, player.chargeT + dt);
  setState(desiredState());
  player.mixer.update(dt);
  applyTrim();   // トリム区間 [trimIn,trimOut] に再生時刻をクランプ（ループ=折返し / 単発=末尾保持）
  player.vrm.update(dt);
  // 現在状態の timeline フレーム（元番号）。マント grip と effect の同期に使う。
  const cst = player.states[player.current];
  const curFrame = cst ? Math.floor(cst.action.time * cst.fps) : 0;
  if (player.cloth && cst) player.cloth.update(dt, curFrame);
  if (cst) driveStateEffects(cst, curFrame, dt);   // FXエディタで配置した effect をアニメと同期して発生
}

// ── NPC（1体。swing-catch の挙動：浮遊移動＋掴める/撃てる＋ラグドール復帰）──
// プレイヤーと別キャラ。camera.position → player.pos に置換。ステート/セリフ/オーラは省略。
const NPC_CHAR = (PLAYER_NPC === 'megu.npc.json') ? 'lily.npc.json' : 'megu.npc.json';

async function loadNpc() {
  let bundle;
  try { bundle = await (await fetch('../npc/' + NPC_CHAR)).json(); } catch { return; }
  if (!bundle?.vrm) return;
  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  const vrm = gltf.userData.vrm;
  const pos = new THREE.Vector3(3.5, ROOM.y * 0.5, -3);
  vrm.scene.position.copy(pos);
  scene.add(vrm.scene); vrm.scene.updateMatrixWorld(true);

  let mixer = null, action = null;
  try {
    const vres = await fetch('../vrma/' + encodeURIComponent('idle.vrma'));
    if (vres.ok) {
      const al = new GLTFLoader();
      al.register(p => new VRMAnimationLoaderPlugin(p));
      const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
      const anims = ag.userData.vrmAnimations;
      if (anims?.length) {
        const clip = createVRMAnimationClip(anims[0], vrm);
        stripRootMotion(clip);
        mixer = new THREE.AnimationMixer(vrm.scene);
        action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity).play();
        action.time = Math.random() * (clip.duration || 1);
      }
    }
  } catch (e) { console.warn('NPC idle 読込失敗:', e); }

  const ragdoll = createRagdoll(vrm, { gravity: -6, boundsMargin: 0.4 });

  let cloth = null;
  if (bundle.cloth) { try { cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: pos, floorY: 0, timeline: bundle.timeline }); } catch (e) { console.warn('NPC マント失敗:', e); } }

  npcs.push({
    vrm, ragdoll, mixer, action, cloth, pos, kind: 'psychic',
    faceOff: NPC_FACE_OFFSET[NPC_CHAR] ?? 0,
    tlFps: bundle.timeline?.fps ?? 30,
    vel: randomDir().multiplyScalar(randRange(2, 4)),
    grabbed: false, clothGrabbed: false, grabBone: 'chest', recoverTimer: 0,
    idleMode: 'drift', idleTimer: randRange(3, 6), bobPhase: Math.random() * 10, dashTarget: new THREE.Vector3(),
    headLookW: 0,
  });
}

// ── 一般人モブ：素材を一度だけ用意（VRM blob ＋ 歩行VRMA）──
async function prepareMobAssets() {
  try {
    const bundle = await (await fetch('../npc/' + MOB_CHAR)).json();
    if (!bundle?.vrm) return false;
    mobAssets.bundle    = bundle;
    mobAssets.vrmBlobUrl = URL.createObjectURL(dataURIToBlob(bundle.vrm));
    mobAssets.faceOff   = NPC_FACE_OFFSET[MOB_CHAR] ?? 0;
    try {
      const vres = await fetch('../vrma/' + encodeURIComponent(MOB_WALK_VRMA));
      if (vres.ok) {
        const al = new GLTFLoader(); al.register(p => new VRMAnimationLoaderPlugin(p));
        const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
        mobAssets.walkAnim = ag.userData.vrmAnimations?.[0] ?? null;
      }
    } catch (e) { console.warn('モブ歩行VRMA失敗:', e); }
    mobAssets.ready = true;
    return true;
  } catch (e) { console.warn('モブ素材準備失敗:', e); return false; }
}

async function spawnMob() {
  if (!mobAssets.ready) return false;
  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
  const gltf = await loader.loadAsync(mobAssets.vrmBlobUrl);
  const vrm = gltf.userData.vrm;
  const pos = new THREE.Vector3(randRange(-ROOM.x/2 + 2, ROOM.x/2 - 2), 0, randRange(-ROOM.z/2 + 2, ROOM.z/2 - 2));
  vrm.scene.position.copy(pos);
  scene.add(vrm.scene); vrm.scene.updateMatrixWorld(true);
  let mixer = null, action = null;
  if (mobAssets.walkAnim) {
    const clip = createVRMAnimationClip(mobAssets.walkAnim, vrm);
    stripRootMotion(clip);
    mixer = new THREE.AnimationMixer(vrm.scene);
    action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity).play();
    action.time = Math.random() * (clip.duration || 1);
  }
  const ragdoll = createRagdoll(vrm, { gravity: -12, boundsMargin: 0.4 });
  npcs.push({
    vrm, ragdoll, mixer, action, cloth: null, pos, kind: 'mob',
    faceOff: mobAssets.faceOff, tlFps: 30,
    vel: new THREE.Vector3(), grabbed: false, clothGrabbed: false, grabBone: 'chest', recoverTimer: 0,
    headLookW: 0, scared: false, wanderTimer: 0, wanderDirX: 0, wanderDirZ: 0,
  });
  return true;
}

function mobCount() { let n = 0; for (const m of npcs) if (m.kind === 'mob') n++; return n; }

function removeMob() {
  for (let i = npcs.length - 1; i >= 0; i--) {
    const m = npcs[i];
    if (m.kind !== 'mob' || m.grabbed || m.clothGrabbed) continue;   // 掴まれている個体は残す
    scene.remove(m.vrm.scene);
    try { disposeRagdoll(m.ragdoll); } catch { /* helper無しなら無視 */ }
    m.vrm.scene.traverse(o => { if (o.isMesh) { o.geometry?.dispose(); const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const mm of ms) mm?.dispose(); } });
    npcs.splice(i, 1);
    return true;
  }
  return false;
}

// スライダーで台数を増減（最新値へ1体ずつ収束）。VRM読込が重いので逐次処理。
let mobDesired = 0, mobReconciling = false;
async function reconcileMobs() {
  if (mobReconciling) return;
  mobReconciling = true;
  try {
    while (mobCount() !== mobDesired) {
      if (mobCount() < mobDesired) { if (!await spawnMob()) break; }
      else { if (!removeMob()) break; }
    }
  } finally { mobReconciling = false; }
}
function setMobCount(n) { mobDesired = Math.max(0, n | 0); reconcileMobs(); }

function grabbedNpc() { for (const m of npcs) if (m.grabbed || m.clothGrabbed) return m; return null; }

function npcCenter(m, out) {
  const rd = m.ragdoll;
  if (rd.active && rd.idxOf.hips != null) out.copy(rd.particles[rd.idxOf.hips].pos);
  else { out.copy(m.pos); out.y += NPC_CENTER_Y; }
  return out;
}

// 照準レイに最も近い NPC 関節（飛行中=ボーン位置 / ラグドール中=粒子位置）。{bone, along}|null
function nearestNpcJoint(m) {
  const rd = m.ragdoll;
  const orig = raycaster.ray.origin, dir = raycaster.ray.direction;
  let best = null, bestAlong = Infinity;
  for (const p of rd.particles) {
    if (rd.active) _grabV.copy(p.pos);
    else { const node = m.vrm.humanoid?.getNormalizedBoneNode(p.bone); if (!node) continue; node.getWorldPosition(_grabV); }
    _grabV.sub(orig);
    const along = _grabV.dot(dir);
    if (along < 0 || along > GRAB_RANGE) continue;
    const perp2 = _grabV.lengthSq() - along * along;
    if (perp2 < 0.25 && along < bestAlong) { bestAlong = along; best = p.bone; }
  }
  return best ? { bone: best, along: bestAlong } : null;
}

// 照準レイに最も近いマント頂点（CPU読み戻し必須）。{index, along}|null
function nearestNpcCloth(m) {
  if (!m.cloth || !m.cloth.cpuReady) return null;
  const cp = m.cloth.cpuPositions;
  const orig = raycaster.ray.origin, dir = raycaster.ray.direction;
  let best = -1, bestAlong = Infinity;
  for (let i = 0; i < m.cloth.vertexCount; i++) {
    _grabV.set(cp[i*3], cp[i*3+1], cp[i*3+2]).sub(orig);
    const along = _grabV.dot(dir);
    if (along < 0 || along > GRAB_RANGE) continue;
    const perp2 = _grabV.lengthSq() - along * along;
    if (perp2 < 0.16 && along < bestAlong) { bestAlong = along; best = i; }
  }
  return best >= 0 ? { index: best, along: bestAlong } : null;
}

function grabNpcBody(m, bone) {
  m.grabbed = true;
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true);
  m.grabBone = bone || 'chest';
  updateCrosshair();
}
function grabNpcCloth(m, idx) {
  if (!m.cloth) return;
  m.cloth.grab(idx, frontAnchor);
  m.clothGrabbed = true;
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true);
  updateCrosshair();
}
function releaseNpc(m) {
  if (m.clothGrabbed) { m.cloth.releaseGrab(); m.clothGrabbed = false; }
  m.grabbed = false;
  m.recoverTimer = NPC_RECOVER_DELAY + LOOK_DURATION;
  updateCrosshair();
}
function hitNpc(m, dir, impulse = RAGDOLL_IMPULSE) {
  if (m.ragdoll.active) return;
  setRagdollActive(m.ragdoll, true);
  applyRagdollImpulse(m.ragdoll, dir.clone().multiplyScalar(impulse), 'chest');
  m.recoverTimer = NPC_RECOVER_DELAY + LOOK_DURATION;
}
function onNpcRecovered(m) {
  if (m.kind === 'mob') {
    // 倒れた地点（ラグドール hips の床位置）から立ち上がって再びうろつく
    const rd = m.ragdoll;
    if (rd.idxOf.hips != null) { const hp = rd.particles[rd.idxOf.hips].pos; m.pos.set(hp.x, 0, hp.z); }
    m.pos.x = Math.min(ROOM.x/2 - NPC_RADIUS, Math.max(-ROOM.x/2 + NPC_RADIUS, m.pos.x));
    m.pos.z = Math.min(ROOM.z/2 - NPC_RADIUS, Math.max(-ROOM.z/2 + NPC_RADIUS, m.pos.z));
    m.vel.set(0, 0, 0); m.wanderTimer = 0; m.scared = false;
    return;
  }
  m.vel.copy(randomDir()).multiplyScalar(randRange(2, 4));
  m.idleMode = 'drift'; m.idleTimer = randRange(3, 6);
}

// 一般人モブの地上挙動：プレイヤーが近いと反対方向へ逃走、遠いとランダムにうろつく。
function updateMobGround(m, dt) {
  _force.copy(player.pos).sub(m.pos); _force.y = 0;
  const dist = _force.length();
  let dx, dz, speed;
  if (dist < MOB_FLEE_RADIUS) {
    m.scared = true;
    const inv = dist > 1e-3 ? 1 / dist : 0;
    dx = -_force.x * inv; dz = -_force.z * inv;   // プレイヤーと反対方向
    speed = MOB_RUN_SPEED;
  } else {
    m.scared = false;
    m.wanderTimer -= dt;
    if (m.wanderTimer <= 0 || (m.wanderDirX === 0 && m.wanderDirZ === 0)) {
      const a = Math.random() * Math.PI * 2;
      m.wanderDirX = Math.cos(a); m.wanderDirZ = Math.sin(a);
      m.wanderTimer = randRange(1.5, 4);
    }
    dx = m.wanderDirX; dz = m.wanderDirZ;
    speed = MOB_WALK_SPEED;
  }
  // 壁回避：枠に近いと中央へ寄せる
  const mg = 2.5;
  if (m.pos.x < -ROOM.x/2 + mg) dx += 1; else if (m.pos.x > ROOM.x/2 - mg) dx -= 1;
  if (m.pos.z < -ROOM.z/2 + mg) dz += 1; else if (m.pos.z > ROOM.z/2 - mg) dz -= 1;
  const dl = Math.hypot(dx, dz) || 1;
  const tvx = dx / dl * speed, tvz = dz / dl * speed;
  const k = 1 - Math.exp(-dt / MOB_STEER_TAU);
  m.vel.x += (tvx - m.vel.x) * k; m.vel.z += (tvz - m.vel.z) * k; m.vel.y = 0;
  m.pos.addScaledVector(m.vel, dt); m.pos.y = 0;
  m.pos.x = Math.min(ROOM.x/2 - NPC_RADIUS, Math.max(-ROOM.x/2 + NPC_RADIUS, m.pos.x));
  m.pos.z = Math.min(ROOM.z/2 - NPC_RADIUS, Math.max(-ROOM.z/2 + NPC_RADIUS, m.pos.z));
  m.vrm.scene.position.copy(m.pos);
  faceNpcMove(m, dt);
  if (m.action) {
    const sp = Math.hypot(m.vel.x, m.vel.z);
    m.action.timeScale = Math.max(0.4, Math.min(2.2, sp / MOB_WALK_SPEED));   // 速いほど足を速く
  }
}

// 頭をプレイヤーへ向ける（weight 0-1）。mixer/ラグドール後・vrm.update 前に呼ぶ。
function applyNpcHeadLook(m, weight) {
  if (weight <= 0) return;
  const head = m.vrm.humanoid?.getNormalizedBoneNode('head');
  if (!head) return;
  head.updateWorldMatrix(true, false);
  head.getWorldPosition(_hPos);
  _hDir.copy(player.pos).setY(player.pos.y + 1.2).sub(_hPos);
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

// idle 挙動：float(静止ふわふわ)/drift(緩い巡航)/dash(地点へ素早く)を3〜6秒で切替
function updateNpcIdle(m, dt) {
  m.idleTimer -= dt;
  if (m.idleTimer <= 0) {
    m.idleMode = ['float', 'drift', 'dash'][Math.floor(Math.random() * 3)];
    m.idleTimer = randRange(3, 6);
    if (m.idleMode === 'dash') {
      m.dashTarget.set(randRange(-ROOM.x/2 + 1, ROOM.x/2 - 1), randRange(1.2, ROOM.y - 2), randRange(-ROOM.z/2 + 1, ROOM.z/2 - 1));
    } else if (m.idleMode === 'drift') {
      const d = randomDir(); d.y *= 0.4; m.vel.copy(d.normalize()).multiplyScalar(3);
    }
  }
  const k = 1 - Math.exp(-dt / 0.6);
  if (m.idleMode === 'float') {
    m.vel.x += (0 - m.vel.x) * k; m.vel.z += (0 - m.vel.z) * k;
    m.bobPhase += dt; m.vel.y = Math.sin(m.bobPhase * 1.6) * 0.35;
  } else if (m.idleMode === 'dash') {
    _force.copy(m.dashTarget).sub(m.pos);
    const dist = _force.length();
    if (dist < 0.6) { m.vel.multiplyScalar(1 - k); }
    else { _force.multiplyScalar(7 / dist); m.vel.x += (_force.x - m.vel.x) * k; m.vel.y += (_force.y - m.vel.y) * k; m.vel.z += (_force.z - m.vel.z) * k; }
  } else {
    if (m.vel.lengthSq() < 1.0) { const d = randomDir(); d.y *= 0.4; m.vel.copy(d.normalize()).multiplyScalar(3); }
  }
}

// 進行方向へ体を向ける（VRM 前方 +Z＋faceOff）。低速時は維持。
function faceNpcMove(m, dt) {
  const sp2 = m.vel.x * m.vel.x + m.vel.z * m.vel.z;
  if (sp2 < 0.09) return;
  const targetYaw = Math.atan2(m.vel.x, m.vel.z) + m.faceOff;
  let diff = targetYaw - m.vrm.scene.rotation.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  m.vrm.scene.rotation.y += diff * (1 - Math.exp(-dt / 0.4));
}

function updateNpcs(dt) {
  for (const m of npcs) updateOneNpc(m, dt);
}

function updateOneNpc(m, dt) {
  const rd = m.ragdoll;
  const held = m.grabbed || m.clothGrabbed;

  if (rd.active) {
    const env = { floorY: 0, bounds: ARENA_BOUNDS };
    if (m.grabbed)          { env.pinBone = m.grabBone || 'chest'; env.pinPos = frontAnchor; }
    else if (m.clothGrabbed) { env.tetherBone = 'chest'; env.tetherPos = frontAnchor; env.tetherStrength = 0.03; }
    updateRagdoll(rd, dt, env);
    if (!held) { m.recoverTimer -= dt; if (m.recoverTimer <= 0) setRagdollActive(rd, false); }
  } else if (rd.recovering) {
    if (m.mixer) m.mixer.update(dt);
    updateRagdollRecovery(rd, dt);
    if (!rd.recovering) onNpcRecovered(m);
  } else {
    if (m.mixer) m.mixer.update(dt);
    if (m.kind === 'mob') {
      updateMobGround(m, dt);
    } else {
      updateNpcIdle(m, dt);
      m.pos.addScaledVector(m.vel, dt);
      bounceAxis(m, 'x', -ROOM.x/2 + NPC_RADIUS, ROOM.x/2 - NPC_RADIUS);
      bounceAxis(m, 'y', 0.2, ROOM.y - 1.8);
      bounceAxis(m, 'z', -ROOM.z/2 + NPC_RADIUS, ROOM.z/2 - NPC_RADIUS);
      m.vrm.scene.position.copy(m.pos);
      faceNpcMove(m, dt);
    }
  }

  // 頭をプレイヤーへゆるく（サイキッカーの飛行中のみ。モブは逃走中で前向きのため無し）
  const targetHeadW = (m.kind === 'mob' || held || rd.active) ? 0 : 0.55;
  m.headLookW += (targetHeadW - m.headLookW) * (1 - Math.exp(-dt / HEAD_LOOK_TAU));
  if (m.headLookW > 0.01) applyNpcHeadLook(m, m.headLookW);

  m.vrm.update(dt);
  if (m.cloth) {
    if (m.clothGrabbed) m.cloth.moveGrab(frontAnchor);
    let frame = null;
    if (m.action && !rd.active) frame = Math.floor(m.action.time * m.tlFps);
    m.cloth.update(dt, frame);
    m.cloth.refresh();   // マント掴み用に CPU 位置を読み戻し
  }
}

// ============================================================
// 飛行移動
// ============================================================
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function camForwardRight() {
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  _fwd.set(cp * Math.sin(camYaw), sp, cp * Math.cos(camYaw)).normalize();
  _right.set(-_fwd.z, 0, _fwd.x).normalize();   // 水平右（cross(forward, up)）
}

function updateFlight(dt) {
  if (!player.ready) return;
  camForwardRight();
  player.fwdY = _fwd.y;   // 前進方向の上下（降下判定用）
  _move.set(0, 0, 0);
  const fwdPressed = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwdPressed)                                 _move.add(_fwd);
  if (keysDown['KeyS'] || keysDown['ArrowDown'])  _move.sub(_fwd);
  if (keysDown['KeyD'] || keysDown['ArrowRight']) _move.add(_right);
  if (keysDown['KeyA'] || keysDown['ArrowLeft'])  _move.sub(_right);

  if (_move.lengthSq() > 1e-6) {
    _move.normalize();
    player.vel.addScaledVector(_move, flight.accel * dt);
  }
  // 体の向き
  const holding = isHolding();
  if (holding) {
    // グラブ中：体(=掴んだ物)をマウス方向(カメラ水平正面=camYaw)へ素早く向ける＝振り回し
    player.yaw = lerpAngle(player.yaw, camYaw, Math.min(1, HOLD_TURN * dt));
  } else if (fwdPressed) {
    // 前進キーを押したときだけカメラ正面へ（カーソル移動だけ／横移動では向けない）
    const targetYaw = Math.atan2(_fwd.x, _fwd.z);
    player.yaw = lerpAngle(player.yaw, targetYaw, Math.min(1, flight.turn * dt));
  }
  // 減衰 + 速度制限
  player.vel.multiplyScalar(Math.exp(-flight.drag * dt));
  clampSpeed(player.vel, flight.maxSpeed);

  player.pos.addScaledVector(player.vel, dt);
  // アリーナ内に収める（壁で停止）
  const m = 0.6;
  for (const [k, lo, hi] of [['x', -ROOM.x / 2 + m, ROOM.x / 2 - m], ['y', m, ROOM.y - m], ['z', -ROOM.z / 2 + m, ROOM.z / 2 - m]]) {
    if (player.pos[k] < lo) { player.pos[k] = lo; if (player.vel[k] < 0) player.vel[k] = 0; }
    else if (player.pos[k] > hi) { player.pos[k] = hi; if (player.vel[k] > 0) player.vel[k] = 0; }
  }

  player.vrm.scene.position.copy(player.pos);
  player.vrm.scene.rotation.y = player.yaw + FACE_OFFSET;

  // 前方アンカー（グラブ吸着点）。掴んだ物が大きいほど前へ離す（自キャラに埋まらないように）。
  const reach = GRAB_FRONT_DIST + (grabbed ? grabbed.radius : 0);
  if (holding) {
    // グラブ中はカメラの3D前方へ吸着＝マウスで上下左右に振り回せる（掴んだ物がスプリングで遅れて追従し勢いがつく）
    frontAnchor.copy(_fwd).multiplyScalar(reach).add(player.pos);
  } else {
    frontAnchor.set(Math.sin(player.yaw), 0, Math.cos(player.yaw)).multiplyScalar(reach).add(player.pos);
  }
  frontAnchor.y += GRAB_FRONT_Y;
}

// ============================================================
// TPS カメラ（球面 + スプリング追従）
// ============================================================
function updateCamera(dt) {
  camForwardRight();
  _desiredTarget.copy(player.pos); _desiredTarget.y += cam.height;
  _desiredPos.copy(_desiredTarget).addScaledVector(_fwd, -cam.dist);
  // 床より下に潜らない
  if (_desiredPos.y < 0.4) _desiredPos.y = 0.4;
  const k = 1 - Math.exp(-cam.follow * dt);
  camPosCur.lerp(_desiredPos, k);
  camTargetCur.lerp(_desiredTarget, k);
  camera.position.copy(camPosCur);
  camera.lookAt(camTargetCur);
}

// ============================================================
// グラブ / ショット
// ============================================================
function resolveObj(o) { let n = o; while (n) { if (n.userData && n.userData.obj) return n.userData.obj; n = n.parent; } return null; }
function isHolding() { return !!grabbed || !!grabbedNpc(); }
function updateCrosshair() { const el = document.getElementById('crosshair'); if (el) el.classList.toggle('grabbing', isHolding()); }

function tryGrab() {
  if (grabbed || grabbedNpc()) return true;
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = GRAB_RANGE;
  const hits = raycaster.intersectObjects(objects.map(o => o.mesh), true);
  const obj = hits.length ? resolveObj(hits[0].object) : null;
  let kind = obj ? 'obj' : null;
  let dist = obj ? hits[0].distance : Infinity;
  let clothIdx = -1, grabBone = null, targetNpc = null;
  // 全 NPC の本体（関節）/マントを判定し、最も手前を採用
  for (const m of npcs) {
    const jb = nearestNpcJoint(m);
    if (jb && jb.along < dist) { kind = 'body'; dist = jb.along; grabBone = jb.bone; targetNpc = m; }
    const cl = nearestNpcCloth(m);
    if (cl && cl.along < dist) { kind = 'cloth'; dist = cl.along; clothIdx = cl.index; targetNpc = m; }
  }
  if (kind === 'cloth')      grabNpcCloth(targetNpc, clothIdx);
  else if (kind === 'body')  grabNpcBody(targetNpc, grabBone);
  else if (kind === 'obj' && obj) { obj.grabbed = true; grabbed = obj; updateCrosshair(); }
  if (kind) triggerOneShot('grab');
  return !!kind;
}

// 左クリックで掴む対象が無いとき：wrap を再生（最後で停止保持）。LMB解放で解除。
function startWrap() { if (player.states.wrap) player.wrapping = true; }
function endWrap()   { player.wrapping = false; }
function release() {
  const m = grabbedNpc();
  if (m) { releaseNpc(m); triggerOneShot('throw'); return; }   // NPC も振り回して放り投げ
  if (!grabbed) return;
  // 振り回した速度をブーストして投擲（swing-catch のぶん投げ）
  grabbed.grabbed = false;
  grabbed.vel.multiplyScalar(THROW_BOOST);
  clampSpeed(grabbed.vel);
  grabbed = null; updateCrosshair();
  triggerOneShot('throw');
}
// 右クリック押下＝チャージ開始（溜めモーションは閾値超過後に desiredState が出す）
function startCharge() {
  if (player.charging) return;
  player.charging = true;
  player.chargeT = 0;
}

// 通常ショット（短タップ）：従来どおり cas1_L1 ＋ 小弾／抱えた物を前方へ射出。
function normalShot() {
  camForwardRight();
  if (grabbed) {
    grabbed.grabbed = false;
    grabbed.vel.copy(_fwd).multiplyScalar(SHOT_SPEED);
    grabbed = null; updateCrosshair();
  } else {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 2), new THREE.MeshStandardMaterial({ color: 0xffe070, roughness: 0.3, metalness: 0.3, emissive: 0x554400 }));
    const pos = frontAnchor.clone();
    mesh.position.copy(pos); scene.add(mesh);
    projectiles.push({ mesh, radius: 0.18, pos, vel: _fwd.clone().multiplyScalar(SHOT_SPEED), ttl: 3.0, power: 18 });
  }
  triggerOneShot('shot');
}

// 右クリック解放：短タップ=通常ショット / 長押し=ラージショット（チャージ量で大きさ・速度・威力増）
function fireLargeShot() {
  if (!player.charging) return;
  player.charging = false;
  if (player.chargeT < TAP_THRESHOLD) { normalShot(); return; }
  const level = Math.max(LARGE_MIN_LEVEL, Math.min(1, player.chargeT / MAX_CHARGE_TIME));
  camForwardRight();
  const radius = 0.3 + level * 0.6;            // 0.3〜0.9
  const speed  = SHOT_SPEED * (0.9 + level * 0.7);
  const power  = 18 + level * 50;              // 命中時の押し出し
  const mesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 2),
    new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.25, metalness: 0.3, emissive: 0x662200, emissiveIntensity: 1.5 }),
  );
  const pos = frontAnchor.clone();
  mesh.position.copy(pos); scene.add(mesh);
  projectiles.push({ mesh, radius, pos, vel: _fwd.clone().multiplyScalar(speed), ttl: 3.5, power, big: true });
  triggerOneShot('large');
}

// ============================================================
// 入力（ポインタロック）
// ============================================================
function setupControls() {
  const canvas = renderer.domElement;
  canvas.addEventListener('click', () => { if (!isLocked) canvas.requestPointerLock(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas;
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = isLocked ? 'none' : 'flex';
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = isLocked ? 'none' : 'flex';
    if (!isLocked) { release(); player.charging = false; player.wrapping = false; }   // ロック解除でチャージ/wrapも中断
  });

  document.addEventListener('mousemove', (e) => {
    if (!isLocked) return;
    // カメラ回転(マウス移動)では放置モーションを解除しない（キー入力・クリックのみで解除）
    const s = MOUSE_SENS_BASE * cam.sens;
    camYaw   -= e.movementX * s;
    camPitch -= e.movementY * s;
    camPitch  = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch));
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!isLocked) return;
    resetIdle();
    if (e.button === 0) { if (!tryGrab()) startWrap(); }   // 掴む対象なし→wrap
    else if (e.button === 2) startCharge();   // 右クリック長押し＝チャージ
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) { release(); endWrap(); }
    else if (e.button === 2) fireLargeShot();  // 右クリック解放＝ラージショット
  });

  document.addEventListener('keydown', (e) => { keysDown[e.code] = true; if (isLocked) resetIdle(); });
  document.addEventListener('keyup',   (e) => { keysDown[e.code] = false; });
  document.getElementById('ui')?.addEventListener('mousedown', () => { if (isLocked) document.exitPointerLock(); });
}

// ============================================================
// カメラ調整 UI（localStorage 保存）
// ============================================================
function loadCamPrefs() {
  try {
    const j = JSON.parse(localStorage.getItem('tps-cam') || '{}');
    for (const k of ['dist', 'height', 'follow', 'fov', 'sens']) if (Number.isFinite(j[k])) cam[k] = j[k];
  } catch { /* noop */ }
}
function saveCamPrefs() {
  try { localStorage.setItem('tps-cam', JSON.stringify({ dist: cam.dist, height: cam.height, follow: cam.follow, fov: cam.fov, sens: cam.sens })); } catch { /* noop */ }
}

function setupUI() {
  const bind = (id, fmt, apply) => {
    const sl = document.getElementById(id), vl = document.getElementById(id + '-val');
    if (!sl) return;
    const run = () => { const v = parseFloat(sl.value); if (vl) vl.textContent = fmt(v); apply(v); };
    sl.addEventListener('input', run); run();
  };
  bind('cam-dist',   v => v.toFixed(1), v => { cam.dist = v; saveCamPrefs(); });
  bind('cam-height', v => v.toFixed(2), v => { cam.height = v; saveCamPrefs(); });
  bind('cam-follow', v => v.toFixed(1), v => { cam.follow = v; saveCamPrefs(); });
  bind('cam-fov',    v => v.toFixed(0), v => { cam.fov = v; if (camera) { camera.fov = v; camera.updateProjectionMatrix(); } saveCamPrefs(); });
  bind('cam-sens',   v => v.toFixed(1), v => { cam.sens = v; saveCamPrefs(); });
  bind('fly-speed',  v => v.toFixed(0), v => { flight.maxSpeed = v; flight.accel = v * 3.5; });   // スライダー値＝最大m/s（永続化しない＝既定はNPC同等）
  bind('obj-count',  v => v.toFixed(0), v => { setObjectCount(v | 0); });
  bind('mob-count',  v => v.toFixed(0), v => { setMobCount(v | 0); });   // 一般人モブの台数

  // localStorage 値をスライダーへ反映
  const set = (id, v) => { const sl = document.getElementById(id); if (sl) { sl.value = v; sl.dispatchEvent(new Event('input')); } };
  set('cam-dist', cam.dist); set('cam-height', cam.height); set('cam-follow', cam.follow); set('cam-fov', cam.fov); set('cam-sens', cam.sens); set('fly-speed', flight.maxSpeed);

  // キャラ選択（public/npc から。変更で ?npc= 付きリロード）
  const npcSel = document.getElementById('npc-select');
  if (npcSel) {
    fetch('../npc/manifest.json').then(r => r.ok ? r.json() : []).then(files => {
      for (const f of files) {
        if (!f.endsWith('.npc.json')) continue;
        const o = document.createElement('option');
        o.value = f; o.textContent = f.replace(/\.npc\.json$/, '');
        if (f === PLAYER_NPC) o.selected = true;
        npcSel.appendChild(o);
      }
    }).catch(() => {});
    npcSel.addEventListener('change', () => { location.search = '?npc=' + encodeURIComponent(npcSel.value); });
  }
}

// ============================================================
// レンダリング
// ============================================================
function updateFPS() {
  fpsFrameCount++;
  const now = performance.now(), el = now - fpsLastTime;
  if (el >= 500) {
    const fps = Math.round(fpsFrameCount / (el / 1000));
    const c = document.getElementById('fps-counter'); if (c) c.textContent = `${fps} FPS`;
    fpsFrameCount = 0; fpsLastTime = now;
  }
}

function render() {
  timer.update();
  updateFPS();
  const dt = Math.min(timer.getDelta(), 1 / 30);

  if (isLocked) updateFlight(dt);
  updatePlayerAnim(dt);
  updateNpcs(dt);
  updateExplosions(dt);
  updateCamera(dt);

  const tps = 1 / STEP_HZ; let steps = 0; timeSinceLastStep += dt;
  while (timeSinceLastStep >= tps && steps < MAX_STEPS_FRAME) { physicsStep(tps); timeSinceLastStep -= tps; steps++; }
  if (steps >= MAX_STEPS_FRAME) timeSinceLastStep = 0;
  syncObjectMeshes();

  renderer.render(scene, camera);
}

// ============================================================
// 初期化
// ============================================================
async function init() {
  const app = document.getElementById('app');
  const loading = document.getElementById('loading');
  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');

  renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd8ef);
  scene.fog = new THREE.FogExp2(0xcfe3f5, 0.008);

  loadCamPrefs();
  camera = new THREE.PerspectiveCamera(cam.fov, window.innerWidth / window.innerHeight, 0.05, 600);

  // 空（グラデーションのスカイドーム）
  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  const skyT = positionWorld.normalize().y.mul(0.5).add(0.5).clamp(0, 1);
  skyMat.colorNode = mix(color(0xeaf4fb), color(0x3f86d4), skyT);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMat);
  sky.frustumCulled = false; scene.add(sky);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const keyLight = new THREE.DirectionalLight(0xfff6e6, 1.5);
  keyLight.position.set(5, 12, 6); scene.add(keyLight);
  try {
    const hdr = await new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg');
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  } catch (e) { console.warn('HDR 環境マップ読み込み失敗:', e); }

  buildArena();

  // カメラ初期値
  camPosCur.copy(player.pos).add(new THREE.Vector3(0, cam.height, -cam.dist));
  camTargetCur.copy(player.pos);

  // 浮遊オブジェクト
  await loadSelectedModels();
  setObjectCount(8);
  loadStage().catch(e => console.warn('ステージ読み込み失敗:', e));

  // プレイヤー
  try { await loadPlayer(); }
  catch (e) { console.error('プレイヤー読み込み失敗:', e); }

  // NPC（サイキッカー1体）
  loadNpc().catch(e => console.warn('NPC 読み込み失敗:', e));
  // 一般人モブ（地上で逃げまどう）。素材を用意してから既定数スポーン。
  prepareMobAssets().then(ok => { if (ok) setMobCount(DEFAULT_MOB_COUNT); }).catch(e => console.warn('モブ準備失敗:', e));
  // 着弾爆発（explosion.fx.json）プール
  loadExplosion().catch(e => console.warn('爆発読み込み失敗:', e));

  setupUI();
  setupControls();

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
});
