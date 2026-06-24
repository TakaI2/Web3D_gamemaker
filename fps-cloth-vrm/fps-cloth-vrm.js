// fps-cloth-vrm.js
// FPS プレイヤー + VRM NPC + マント布シミュ + タイムライン再生
// Three.js v0.184 WebGPU + TSL

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float, vec3,
  triNoise3D, time, frontFacing,
  cross, transformNormalToView,
} from 'https://esm.sh/three@0.184.0/tsl';
import { Octree }  from 'https://esm.sh/three@0.184.0/examples/jsm/math/Octree.js';
import { Capsule } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Capsule.js';
import { GLTFLoader }             from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader }         from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse, disposeRagdoll }
  from '../lib/vrm-ragdoll.js';

// ── Player constants ──────────────────────────────────────────
const PLAYER_SPEED  = 20;
const GRAVITY_ACCEL = 25;
const JUMP_VEL      = 10;
const RESPAWN_Y     = -8;

// NPC#0（ライブ布シミュを行う最前列中央）のワールド座標。階段(z=-3始まり)寄りに配置。
const NPC_POSITION = new THREE.Vector3(0, 0, -1);

// 群衆：NPC#0 以外の 9 体（静止ポーズのクローン + 静止マント）の配置。階段前の床に2列。
const CROWD_POSITIONS = [
  [-6, 0, -1], [-3, 0, -1], [3, 0, -1], [6, 0, -1],          // 前列（NPC#0 と同じ z、中央は NPC#0）
  [-6, 0, 1.4], [-3, 0, 1.4], [0, 0, 1.4], [3, 0, 1.4], [6, 0, 1.4], // 後列
];
const crowdNPCs = [];  // NPC#0 以外。各要素は独立した状態 { vrm, mixer, simData, colliders, anchorMap, ... }
let cachedBundle     = null;   // 事前ロードした NPC バンドル（体数スライダで追加生成に再利用）
let desiredNPCTotal  = 10;     // スライダで指定された目標体数（NPC#0 含む）
let spawnLoopRunning = false;  // 追加生成ループの多重起動ガード

// ── 布シミュ定数 ──────────────────────────────────────────────
const MAX_COLLIDERS = 8;

// ── シーングローバル ─────────────────────────────────────────
let renderer, scene, camera;
let worldOctree  = null;
const timer = new THREE.Timer();
timer.connect(document);

// ── プレイヤー状態 ───────────────────────────────────────────
let playerCollider = null;
let playerOnFloor  = false;
const playerVel    = new THREE.Vector3();
let playerYaw      = Math.PI;   // +Z 方向を向く
let playerPitch    = 0;
const keysDown     = {};
let isLocked       = false;
let timeSinceLastStep = 0;
let simTimestamp      = 0;

// ── VRM NPC 状態 ─────────────────────────────────────────────
let currentVRM = null;

// ── VRMA 状態 ────────────────────────────────────────────────
let mixer      = null;
let vrmaClip   = null;
let vrmaAction = null;
let vrmaPlaying = false;

// ── マント状態 ───────────────────────────────────────────────
let mantleData    = null;
let mantleOrigPos = null;
const mantleTransform = { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 };

const leftGripSet  = new Set();
const rightGripSet = new Set();
const anchorMap    = new Map();   // vertexIdx → { boneName, boneNode, localOffset }

// ── シミュレーション状態 ─────────────────────────────────────
let simRunning = false;
let simData    = null;

// ── 共有 uniform ─────────────────────────────────────────────
let stiffnessUniform;
let dampeningUniform;
let windUniform;
let floorYUniform;       // 布の床当たり判定の床 Y（ステージ床 = 0）

// ── コライダー ───────────────────────────────────────────────
const colliders       = [];
const colliderDataArr = new Float32Array(MAX_COLLIDERS * 4);
let colliderCountUniform = null;
let colliderDataBuffer   = null;
// 読み込んだ cloth.json のコライダー設定 [{ boneName, r, offset:[x,y,z] }]
let savedColliderData    = null;

// ── ラグドール / 発射体 ───────────────────────────────────────
let npcRagdoll = null;               // NPC#0 のラグドール（grab ライクにトグル）
const projectiles = [];              // 発射体 { mesh, pos, vel, radius, ttl }
const RAGDOLL_ENV = { floorY: 0 };   // NPC 足元の床 Y（このステージは y=0）
const PROJECTILE_SPEED  = 40;
const PROJECTILE_RADIUS = 0.12;
const PROJECTILE_TTL    = 4.0;
const RAGDOLL_IMPULSE   = 0.3;       // 命中時の速度キック量（調整可）
const _projDir = new THREE.Vector3();

// ── ハンドグラブポイント ─────────────────────────────────────
const handGrabPoints = {
  left:  { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), active: false },
  right: { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), active: false },
};

// ── タイムライン状態（再生専用） ─────────────────────────────
const tlState = {
  fps:           30,
  durationFrames: 90,
  currentFrame:  0,
  grip: {
    left:  [],   // [{start, end}]
    right: [],
  },
  blendShape: new Map(),  // name → Map<frame, value>
};

// ── FPS カウンター ───────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ── テンポラリ ───────────────────────────────────────────────
const _anchorTmp      = new THREE.Vector3();
const _anchorBoneQuat = new THREE.Quaternion();
const _anchorWorldOff = new THREE.Vector3();
const _colliderTmp    = new THREE.Vector3();
const _colliderQuat   = new THREE.Quaternion();
const _colliderOff    = new THREE.Vector3();

// フラスタムカリング用
const clothFrustum    = new THREE.Frustum();
const clothProjMatrix = new THREE.Matrix4();

// ============================================================
// Level
// ============================================================

function buildLevel() {
  const group = new THREE.Group();

  const mFloor    = new THREE.MeshStandardMaterial({ color: 0x4a7c3a, roughness: 0.95 });
  const mPlatform = new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 0.85 });
  const mStair    = new THREE.MeshStandardMaterial({ color: 0xaa9a80, roughness: 0.80 });
  const mWall     = new THREE.MeshStandardMaterial({ color: 0x6a7080, roughness: 0.90 });
  const mColumn   = new THREE.MeshStandardMaterial({ color: 0x9090a0, roughness: 0.70, metalness: 0.2 });

  const box = (x, y, z, w, h, d, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };

  box(0, -0.25, 2.5,  22, 0.5, 11, mFloor);
  box(-11, 1.5, 2.5, 0.3,  3, 11, mWall);
  box( 11, 1.5, 2.5, 0.3,  3, 11, mWall);

  const S1 = { count: 5, rise: 0.5, tread: 0.8, zStart: -3, yStart: 0, width: 16 };
  for (let i = 0; i < S1.count; i++) {
    const h  = (i + 1) * S1.rise;
    const cy = S1.yStart + h / 2;
    const cz = S1.zStart - (i + 0.5) * S1.tread;
    box(0, cy, cz, S1.width, h, S1.tread, mStair);
  }

  box(0, 2.25, -12, 16, 0.5, 10, mPlatform);
  box(-8, 4.0, -12, 0.3, 3, 10, mWall);
  box( 8, 4.0, -12, 0.3, 3, 10, mWall);
  for (const px of [-6, -3, 3, 6]) {
    box(px, 3.75, -7.5, 0.4, 2.5, 0.4, mColumn);
  }
  const midLight = new THREE.PointLight(0xfff0cc, 1.5, 18);
  midLight.position.set(0, 5.0, -12);
  scene.add(midLight);

  const S2 = { count: 5, rise: 0.5, tread: 0.8, zStart: -17, yStart: 2.5, width: 14 };
  for (let i = 0; i < S2.count; i++) {
    const h  = (i + 1) * S2.rise;
    const cy = S2.yStart + h / 2;
    const cz = S2.zStart - (i + 0.5) * S2.tread;
    box(0, cy, cz, S2.width, h, S2.tread, mStair);
  }

  box(0, 4.75, -26, 14, 0.5, 10, mPlatform);
  box(-7, 7.0, -26, 0.3, 4, 10, mWall);
  box( 7, 7.0, -26, 0.3, 4, 10, mWall);
  box(0, 7.0, -31, 14, 4, 0.3, mWall);
  for (const px of [-5, 0, 5]) {
    box(px, 6.5, -22, 0.4, 3, 0.4, mColumn);
  }
  const hiLight = new THREE.PointLight(0xccddff, 1.5, 18);
  hiLight.position.set(0, 7.5, -26);
  scene.add(hiLight);

  scene.add(group);
  worldOctree = new Octree();
  worldOctree.fromGraphNode(group);
}

// ============================================================
// Player physics
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

  if (keysDown['KeyW'] || keysDown['ArrowUp'])    playerVel.addScaledVector(fwd,   speedDelta);
  if (keysDown['KeyS'] || keysDown['ArrowDown'])  playerVel.addScaledVector(fwd,  -speedDelta);
  if (keysDown['KeyA'] || keysDown['ArrowLeft'])  playerVel.addScaledVector(right, -speedDelta);
  if (keysDown['KeyD'] || keysDown['ArrowRight']) playerVel.addScaledVector(right,  speedDelta);

  // モバイル：仮想ジョイスティック移動（上=前進）
  if (touchMode) {
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

  if (playerCollider.end.y < RESPAWN_Y) {
    playerCollider.set(
      new THREE.Vector3(0, 0.35, 4),
      new THREE.Vector3(0, 1.0,  4),
      0.35,
    );
    playerVel.set(0, 0, 0);
  }

  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
}

// ============================================================
// Controls
// ============================================================

// ── タッチ操作（モバイル）。#joystick-base が在る時だけ有効化＝PCでは無害 ──
const JOYSTICK_MAX = 60;
const touchMove   = { active: false, id: -1, startX: 0, startY: 0 };
const touchLook   = { active: false, id: -1, prevX: 0, prevY: 0 };
const joystickVec = { x: 0, y: 0 };
let   touchMode   = false;

function setupTouchControls() {
  const joystickBase  = document.getElementById('joystick-base');
  const joystickStick = document.getElementById('joystick-stick');
  if (!joystickBase || !joystickStick) return;   // ジョイスティックDOMが無い（PC版）なら何もしない
  touchMode = true;
  isLocked  = true;                              // モバイルは pointer lock 無しで操作可能に
  const overlay = document.getElementById('lock-overlay');
  if (overlay) overlay.style.display = 'none';
  const jumpBtn = document.getElementById('jump-btn');
  const canvas  = renderer.domElement;
  if (jumpBtn) jumpBtn.style.display = 'flex';
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e) => {
    const isLeft = e.clientX < window.innerWidth / 2;
    if (isLeft) {
      if (touchMove.active) return;
      touchMove.active = true; touchMove.id = e.pointerId;
      touchMove.startX = e.clientX; touchMove.startY = e.clientY;
      joystickBase.style.left = `${e.clientX - 70}px`;
      joystickBase.style.top  = `${e.clientY - 70}px`;
      joystickBase.style.display = 'block';
      joystickStick.style.transform = 'translate(0px, 0px)';
    } else {
      if (touchLook.active) return;
      touchLook.active = true; touchLook.id = e.pointerId;
      touchLook.prevX = e.clientX; touchLook.prevY = e.clientY;
    }
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (touchMove.active && e.pointerId === touchMove.id) {
      const dx = e.clientX - touchMove.startX, dy = e.clientY - touchMove.startY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const clamped = Math.min(dist, JOYSTICK_MAX);
        const nx = dx / dist, ny = dy / dist;
        joystickVec.x = nx * (clamped / JOYSTICK_MAX);
        joystickVec.y = ny * (clamped / JOYSTICK_MAX);
        joystickStick.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`;
      }
    }
    if (touchLook.active && e.pointerId === touchLook.id) {
      const sens = 0.005;
      playerYaw   -= (e.clientX - touchLook.prevX) * sens;
      playerPitch -= (e.clientY - touchLook.prevY) * sens;
      playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
      camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
      touchLook.prevX = e.clientX; touchLook.prevY = e.clientY;
    }
  });

  const endTouch = (e) => {
    if (touchMove.active && e.pointerId === touchMove.id) {
      touchMove.active = false; touchMove.id = -1;
      joystickVec.x = 0; joystickVec.y = 0;
      joystickBase.style.display = 'none';
      joystickStick.style.transform = 'translate(0px, 0px)';
    }
    if (touchLook.active && e.pointerId === touchLook.id) { touchLook.active = false; touchLook.id = -1; }
  };
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);

  jumpBtn?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (playerOnFloor) playerVel.y = JUMP_VEL;
  });
}

function setupControls() {
  const canvas = renderer.domElement;
  canvas.addEventListener('click', () => { if (!touchMode) canvas.requestPointerLock(); });

  // 右クリックで球を発射（命中で NPC をラグドール化）
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    if (!isLocked) return;
    if (e.button === 2) fireProjectile();
  });

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas;
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = isLocked ? 'none' : 'flex';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isLocked) return;
    const sens   = 0.002;
    playerYaw   -= e.movementX * sens;
    playerPitch -= e.movementY * sens;
    playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
    camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
  });

  document.addEventListener('keydown', (e) => {
    keysDown[e.code] = true;
    if (e.code === 'Space' && playerOnFloor) playerVel.y = JUMP_VEL;
    if (e.code === 'KeyR') recoverRagdoll();
  });
  document.addEventListener('keyup', (e) => { keysDown[e.code] = false; });

  document.getElementById('ui')?.addEventListener('mousedown', () => {
    if (isLocked) document.exitPointerLock();
  });
}

// ============================================================
// Toast
// ============================================================

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type} visible`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3500);
}

// 起動時ローディングの進捗バー＋ステータス文言を更新し、下のトーストにも何を読み込み中か表示する。
function setLoadProgress(frac, label) {
  const fill   = document.getElementById('load-bar-fill');
  const status = document.getElementById('load-status');
  if (fill)   fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  if (status && label) status.textContent = label;
  if (label) showToast(label);
}

// ============================================================
// 発射体 / ラグドール トリガー
// ============================================================

function fireProjectile() {
  camera.getWorldDirection(_projDir);
  const geo  = new THREE.IcosahedronGeometry(PROJECTILE_RADIUS, 2);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xffe070, roughness: 0.3, metalness: 0.3, emissive: 0x554400 });
  const mesh = new THREE.Mesh(geo, mat);
  const pos  = camera.position.clone().addScaledVector(_projDir, 0.4);
  const vel  = _projDir.clone().multiplyScalar(PROJECTILE_SPEED);
  mesh.position.copy(pos);
  scene.add(mesh);
  projectiles.push({ mesh, pos, vel, radius: PROJECTILE_RADIUS, ttl: PROJECTILE_TTL });
}

// ラグドールへ命中処理：未発動なら発動、発動済みなら追加の撃力。戻り値＝今回ダウンしたか。
function applyHitToRagdoll(ragdoll, boneName, dir) {
  if (!ragdoll) return false;
  const firstDown = !ragdoll.active;
  if (firstDown) setRagdollActive(ragdoll, true);
  applyRagdollImpulse(ragdoll, dir.clone().multiplyScalar(RAGDOLL_IMPULSE), boneName);
  return firstDown;
}

// 発射体 p がコライダー群のいずれかに当たっていれば、そのコライダーを返す。
function projectileHitCollider(p, colliderList) {
  for (const c of colliderList) {
    const rr = p.radius + c.r;
    const dx = p.pos.x - c.x, dy = p.pos.y - c.y, dz = p.pos.z - c.z;
    if (dx * dx + dy * dy + dz * dz <= rr * rr) return c;
  }
  return null;
}

// R：倒れている全 NPC（NPC#0＋群衆）を復帰させる。
function recoverRagdoll() {
  let any = false;
  if (npcRagdoll && npcRagdoll.active) { setRagdollActive(npcRagdoll, false); any = true; }
  for (const n of crowdNPCs) {
    if (n.ragdoll && n.ragdoll.active) { setRagdollActive(n.ragdoll, false); any = true; }
  }
  if (any) showToast('NPC 復帰');
}

function stepProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.pos.addScaledVector(p.vel, dt);
    p.ttl -= dt;
    let dead = p.ttl <= 0;

    // NPC#0 への命中
    if (!dead && npcRagdoll) {
      const c = projectileHitCollider(p, colliders);
      if (c) {
        _projDir.copy(p.vel).normalize();
        if (applyHitToRagdoll(npcRagdoll, c.boneName, _projDir)) showToast('NPC ダウン！ R で復帰');
        dead = true;
      }
    }
    // 群衆NPCへの命中（各自の独立コライダー）
    if (!dead) {
      for (const n of crowdNPCs) {
        if (!n.ragdoll) continue;
        const c = projectileHitCollider(p, n.colliders);
        if (c) {
          _projDir.copy(p.vel).normalize();
          applyHitToRagdoll(n.ragdoll, c.boneName, _projDir);
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

// ============================================================
// VRM Loader
// ============================================================

async function loadVRM(file) {
  const loader = new GLTFLoader();
  // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
  loader.register(parser => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }),
  }));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm  = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');

    unloadVRM();
    currentVRM = vrm;

    // NPC 位置に配置
    vrm.scene.position.copy(NPC_POSITION);
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    buildCollidersFromVRM(vrm);
    initHandGrabPoints(vrm);

    // ラグドール構築（生成のみ。発動は被弾トリガー）
    if (npcRagdoll) disposeRagdoll(npcRagdoll);
    npcRagdoll = createRagdoll(vrm);

    document.getElementById('btn-vrma-load').classList.add('loaded');
    document.getElementById('btn-vrma-load').textContent = 'VRMA 読込 ✓ → 変更';
    showToast('VRM NPC 読み込み完了');
    return vrm;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function unloadVRM() {
  if (!currentVRM) return;
  if (npcRagdoll) { disposeRagdoll(npcRagdoll); npcRagdoll = null; }
  unloadVRMA();
  disposeSimulation();
  clearMantle();
  clearColliders();

  scene.remove(currentVRM.scene);
  currentVRM.scene.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose();
    }
  });
  currentVRM = null;
}

// ============================================================
// Collider Manager
// ============================================================

const BONE_COLLIDER_DEFS = [
  { bone: 'head',          r: 0.10 },
  { bone: 'neck',          r: 0.06 },
  { bone: 'chest',         r: 0.14 },
  { bone: 'spine',         r: 0.12 },
  { bone: 'hips',          r: 0.13 },
  { bone: 'leftShoulder',  r: 0.07 },
  { bone: 'rightShoulder', r: 0.07 },
  { bone: 'upperChest',    r: 0.13 },
];

function buildCollidersFromVRM(vrm) {
  clearColliders();
  const tmp  = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  for (const def of BONE_COLLIDER_DEFS) {
    const node = vrm.humanoid?.getNormalizedBoneNode(def.bone);
    if (!node) continue;
    node.getWorldPosition(tmp);
    node.getWorldQuaternion(quat);
    // cloth.json に保存された設定があれば半径・ボーンローカルオフセットを適用（無ければデフォルト）
    const saved = savedColliderData?.find(s => s.boneName === def.bone);
    const r           = saved ? saved.r : def.r;
    const localOffset = (saved && saved.offset) ? new THREE.Vector3(...saved.offset) : new THREE.Vector3();
    const world = tmp.clone().add(localOffset.clone().applyQuaternion(quat));
    addCollider(world.x, world.y, world.z, r, node, def.bone, localOffset);
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  syncColliderDataArr();
}

function addCollider(x, y, z, r, boneNode = null, boneName = null, localOffset = null) {
  colliders.push({ x, y, z, r, boneNode, boneName, localOffset: localOffset ?? new THREE.Vector3() });
}

function clearColliders() {
  colliders.length = 0;
}

// コライダー配列 → Float32Array(x,y,z,r,...) を埋める（CPUのみ。NPC共通で使えるよう純粋関数化）
function fillColliderArr(colliderList, arr) {
  arr.fill(0);
  for (let i = 0; i < colliderList.length; i++) {
    const c = colliderList[i];
    arr[i*4]   = c.x;
    arr[i*4+1] = c.y;
    arr[i*4+2] = c.z;
    arr[i*4+3] = c.r;
  }
}

// NPC#0（グローバル）用：配列を埋めて GPU バッファへ反映
function syncColliderDataArr() {
  fillColliderArr(colliders, colliderDataArr);
  if (colliderDataBuffer) {
    colliderDataBuffer.value.array.set(colliderDataArr);
    colliderDataBuffer.value.needsUpdate = true;
  }
  if (colliderCountUniform) colliderCountUniform.value = colliders.length;
}

function updateBoneColliders() {
  let changed = false;
  for (const c of colliders) {
    if (!c.boneNode) continue;
    c.boneNode.getWorldPosition(_colliderTmp);
    c.boneNode.getWorldQuaternion(_colliderQuat);
    _colliderTmp.add(_colliderOff.copy(c.localOffset).applyQuaternion(_colliderQuat));
    if (c.x === _colliderTmp.x && c.y === _colliderTmp.y && c.z === _colliderTmp.z) continue;
    c.x = _colliderTmp.x;
    c.y = _colliderTmp.y;
    c.z = _colliderTmp.z;
    changed = true;
  }
  if (changed) syncColliderDataArr();
}

// ============================================================
// Hand Grab Points
// ============================================================

function initHandGrabPoints(vrm) {
  const defs = [
    { side: 'left',  boneName: 'leftHand'  },
    { side: 'right', boneName: 'rightHand' },
  ];
  for (const { side, boneName } of defs) {
    const hp = handGrabPoints[side];
    hp.boneNode = vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
    if (!hp.boneNode) continue;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.offset.set(0, 0, 0);
  }
}

function updateHandGrabPoints() {
  for (const side of ['left', 'right']) {
    const hp = handGrabPoints[side];
    if (!hp.boneNode) continue;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.worldPos.add(hp.offset);
    if (simData && hp.active) {
      if (side === 'left') simData.leftGripTargetUniform.value.copy(hp.worldPos);
      else                 simData.rightGripTargetUniform.value.copy(hp.worldPos);
    }
  }
}

// ============================================================
// Mantle Loader
// ============================================================

function applyMantleTransform(origPos, vertexCount, tr, basePos = NPC_POSITION) {
  const out  = new Float32Array(vertexCount * 3);
  const cosY = Math.cos(tr.ry * Math.PI / 180);
  const sinY = Math.sin(tr.ry * Math.PI / 180);
  for (let i = 0; i < vertexCount; i++) {
    const x = origPos[i*3]   * tr.scale;
    const y = origPos[i*3+1] * tr.scale;
    const z = origPos[i*3+2] * tr.scale;
    out[i*3]   = x * cosY - z * sinY + tr.tx + basePos.x;
    out[i*3+1] = y + tr.ty + basePos.y;
    out[i*3+2] = x * sinY + z * cosY + tr.tz + basePos.z;
  }
  return out;
}

function loadMantleJSON(json) {
  if (json.version !== 1 || !json.positions || !json.springs || !json.indices) {
    throw new Error('無効なマントファイルです');
  }
  clearMantle();
  mantleData    = json;
  mantleOrigPos = new Float32Array(json.positions);

  if (json.editorTransform) {
    Object.assign(mantleTransform, json.editorTransform);
  } else {
    Object.assign(mantleTransform, { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 });
  }

  leftGripSet.clear();
  rightGripSet.clear();
  if (json.leftGripIndices)  for (const idx of json.leftGripIndices)  leftGripSet.add(idx);
  if (json.rightGripIndices) for (const idx of json.rightGripIndices) rightGripSet.add(idx);

  // ボーンアンカー復元（VRM 読込済みの場合のみ）
  anchorMap.clear();
  const anchorData = json.anchorAssignments ?? json.pinnedBoneAssignments;
  if (anchorData && currentVRM) {
    for (const entry of anchorData) {
      const { vertexIdx, boneName } = entry;
      const boneNode = currentVRM.humanoid?.getNormalizedBoneNode(boneName);
      if (!boneNode) continue;
      let localOffset;
      if (entry.localOffset) {
        localOffset = new THREE.Vector3(...entry.localOffset);
      } else if (entry.offset) {
        const boneQuat = new THREE.Quaternion();
        boneNode.getWorldQuaternion(boneQuat);
        localOffset = new THREE.Vector3(...entry.offset).applyQuaternion(boneQuat.invert());
      } else { continue; }
      anchorMap.set(vertexIdx, { boneName, boneNode, localOffset });
    }
  }

  // HGP オフセット復元
  if (json.handGrabOffsets) {
    for (const side of ['left', 'right']) {
      const v = json.handGrabOffsets[side];
      if (v) handGrabPoints[side].offset.set(v[0], v[1], v[2]);
    }
  }

  // 球コライダー設定を復元（VRM読込済みなら半径・オフセットを適用して再構築）。
  // buildSimulation が colliderDataArr をスナップショットするので、その前に行う。
  savedColliderData = json.colliders ?? null;
  if (savedColliderData && currentVRM) buildCollidersFromVRM(currentVRM);

  simData = buildSimulation(_buildMantleAnalysis(), primaryCtx());
  colliderDataBuffer   = simData.colliderDataBuffer;
  colliderCountUniform = simData.colliderCountUniform;
  document.getElementById('btn-sim-start').disabled = false;

  showToast(`マント読み込み完了 (${json.vertexCount}頂点 / アンカー:${anchorMap.size})`);
}

function clearMantle() {
  if (simRunning) stopSim();
  disposeSimulation();
  leftGripSet.clear();
  rightGripSet.clear();
  anchorMap.clear();
  mantleData    = null;
  mantleOrigPos = null;
  Object.assign(mantleTransform, { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 });
}

// NPC#0（グローバル状態）を buildSimulation へ渡すための ctx
function primaryCtx() {
  return { anchorMap, leftGripSet, rightGripSet, colliders, colliderDataArr, basePos: NPC_POSITION };
}

function _buildMantleAnalysis() {
  const transformed = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
  const m = mantleData.material ?? {};
  return {
    positions:      transformed,
    vertexCount:    mantleData.vertexCount,
    springs:        mantleData.springs,
    springCount:    mantleData.springs.length / 2,
    indices:        mantleData.indices,
    colorFront:        m.colorFront      ?? '#204080',
    colorBack:         m.colorBack       ?? '#803020',
    roughness:         m.roughness       ?? 1.0,
    sheen:             m.sheen           ?? 1.0,
    sheenRoughness:    m.sheenRoughness  ?? 0.5,
    sheenColor:        m.sheenColor      ?? null,
    opacity:           m.opacity         ?? 0.85,
    quadVertexIds:     mantleData.quadVertexIds     ?? null,
    renderIndices:     mantleData.renderIndices     ?? null,
    renderVertexCount: mantleData.renderVertexCount ?? null,
  };
}

// ============================================================
// Cloth Simulator
// ============================================================

function buildSimulation(analysis, ctx) {
  const { positions, vertexCount, springs, springCount } = analysis;
  const { anchorMap, leftGripSet, rightGripSet, colliders, colliderDataArr, basePos = NPC_POSITION } = ctx;

  const vertexSpringIds = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) {
    vertexSpringIds[springs[s*2]    ].push(s);
    vertexSpringIds[springs[s*2 + 1]].push(s);
  }

  const hasBonePins = anchorMap.size > 0;
  const bonePinTargetArr = new Float32Array(vertexCount * 3);
  if (hasBonePins) {
    const tmp      = new THREE.Vector3();
    const boneQuat = new THREE.Quaternion();
    const worldOff = new THREE.Vector3();
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      boneNode.getWorldPosition(tmp);
      boneNode.getWorldQuaternion(boneQuat);
      worldOff.copy(localOffset).applyQuaternion(boneQuat);
      bonePinTargetArr[idx*3]   = tmp.x + worldOff.x;
      bonePinTargetArr[idx*3+1] = tmp.y + worldOff.y;
      bonePinTargetArr[idx*3+2] = tmp.z + worldOff.z;
    }
  }

  const springListArray = [];
  const vertexParamsArr = new Uint32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    let gripCode = 0;
    if (anchorMap.has(i))        gripCode = 3;
    else if (leftGripSet.has(i)) gripCode = 1;
    else if (rightGripSet.has(i)) gripCode = 2;
    vertexParamsArr[i*4]   = 0;  // isFixed
    vertexParamsArr[i*4+3] = gripCode;
    vertexParamsArr[i*4+1] = vertexSpringIds[i].length;
    vertexParamsArr[i*4+2] = springListArray.length;
    for (const sid of vertexSpringIds[i]) springListArray.push(sid);
  }

  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);
  for (let s = 0; s < springCount; s++) {
    const v0 = springs[s*2], v1 = springs[s*2 + 1];
    springVertIdArr[s*2]   = v0;
    springVertIdArr[s*2+1] = v1;
    const dx = positions[v0*3]   - positions[v1*3];
    const dy = positions[v0*3+1] - positions[v1*3+1];
    const dz = positions[v0*3+2] - positions[v1*3+2];
    springRestLenArr[s] = Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  const vertexPositionBuffer   = instancedArray(positions.slice(), 'vec3').setPBO(true);
  const vertexForceBuffer      = instancedArray(vertexCount, 'vec3');
  const vertexParamsBuffer     = instancedArray(vertexParamsArr, 'uvec4');
  const springListBuffer       = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true);
  const springVertexIdBuffer   = instancedArray(springVertIdArr, 'uvec2').setPBO(true);
  const springRestLengthBuffer = instancedArray(springRestLenArr, 'float');
  const springForceBuffer      = instancedArray(springCount * 3, 'vec3').setPBO(true);

  const useQuadMesh = !!(analysis.quadVertexIds);
  let computeFaceNormals   = null;
  let computeVertexNormals = null;
  let vertexNormalBuffer   = null;

  fillColliderArr(colliders, colliderDataArr);
  const colliderDataBuffer   = instancedArray(colliderDataArr.slice(), 'vec4');
  const colliderCountUniform = uniform(colliders.length);

  const bonePinTargetBuffer = hasBonePins ? instancedArray(bonePinTargetArr, 'vec3') : null;

  const leftGripActiveUniform  = uniform(0);
  const rightGripActiveUniform = uniform(0);
  const leftGripTargetUniform  = uniform(new THREE.Vector3());
  const rightGripTargetUniform = uniform(new THREE.Vector3());

  // Spring forces compute
  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('FCV_Spring');

  // Vertex forces compute
  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;
    const gripCode      = vparams.w;

    If(isFixed, () => { Return(); });

    If(leftGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(1), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(leftGripTargetUniform);
        Return();
      });
    });
    If(rightGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(2), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(rightGripTargetUniform);
        Return();
      });
    });

    if (hasBonePins) {
      If(gripCode.equal(3), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(bonePinTargetBuffer.element(instanceIndex));
        Return();
      });
    }

    const position = vertexPositionBuffer.element(instanceIndex).toVar('pos');
    const force    = vertexForceBuffer.element(instanceIndex).toVar('force');
    force.mulAssign(dampeningUniform);

    const ptrStart = springPointer.toVar('ps');
    const ptrEnd   = ptrStart.add(springCnt).toVar('pe');
    Loop({ start: ptrStart, end: ptrEnd, type: 'uint', condition: '<' }, ({ i }) => {
      const sid    = springListBuffer.element(i).toVar('sid');
      const sf     = springForceBuffer.element(sid);
      const svids  = springVertexIdBuffer.element(sid);
      const factor = select(svids.x.equal(instanceIndex), 1.0, -1.0);
      force.addAssign(sf.mul(factor));
    });

    force.y.subAssign(0.00005);
    const noise     = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    const windForce = noise.mul(windUniform);
    force.z.subAssign(windForce);

    Loop({ start: 0, end: colliderCountUniform, type: 'int', condition: '<' }, ({ i }) => {
      const col      = colliderDataBuffer.element(i).toVar('col');
      const colPos   = col.xyz.toVar('colPos');
      const colR     = col.w.toVar('colR');
      const toVertex = position.add(force).sub(colPos).toVar('toVtx');
      const dist     = toVertex.length().toVar('cvDist');
      const pen      = colR.sub(dist);
      If(pen.greaterThan(0.0), () => {
        const pushDir = toVertex.div(dist.max(0.0001));
        force.addAssign(pushDir.mul(pen).mul(1.2));
      });
    });

    // 床との衝突：予測位置が床を割り込んだら押し戻し＋接地摩擦（マントの床抜け防止）
    const predY    = position.y.add(force.y).toVar('predY');
    const floorPen = floorYUniform.add(float(0.01)).sub(predY).toVar('floorPen');
    If(floorPen.greaterThan(0.0), () => {
      force.y.addAssign(floorPen);
      force.x.mulAssign(float(0.6));
      force.z.mulAssign(float(0.6));
    });

    vertexForceBuffer.element(instanceIndex).assign(force);
    vertexPositionBuffer.element(instanceIndex).addAssign(force);
  })().compute(vertexCount).setName('FCV_Vertex');

  if (!useQuadMesh) {
    // パーティクル直接メッシュ用：コンピュートシェーダーで法線計算（旧形式フォールバック）
    const triangleCount  = analysis.indices.length / 3;
    const triIndicesFlat = new Uint32Array(analysis.indices);
    const vtxTriLists    = Array.from({ length: vertexCount }, () => []);
    for (let t = 0; t < triangleCount; t++) {
      vtxTriLists[triIndicesFlat[t * 3    ]].push(t);
      vtxTriLists[triIndicesFlat[t * 3 + 1]].push(t);
      vtxTriLists[triIndicesFlat[t * 3 + 2]].push(t);
    }
    const vtxTriListArr  = [];
    const vtxTriParamArr = new Uint32Array(vertexCount * 2);
    for (let v = 0; v < vertexCount; v++) {
      vtxTriParamArr[v * 2]     = vtxTriLists[v].length;
      vtxTriParamArr[v * 2 + 1] = vtxTriListArr.length;
      for (const t of vtxTriLists[v]) vtxTriListArr.push(t);
    }
    const triIdxBuffer      = instancedArray(triIndicesFlat, 'uint');
    const faceNormalBuffer  = instancedArray(triangleCount, 'vec3');
    vertexNormalBuffer      = instancedArray(vertexCount,   'vec3');
    const vtxTriParamBuffer = instancedArray(vtxTriParamArr, 'uvec2');
    const vtxTriListBuffer  = instancedArray(new Uint32Array(vtxTriListArr), 'uint');

    computeFaceNormals = Fn(() => {
      const base = instanceIndex.mul(3);
      const i0   = triIdxBuffer.element(base);
      const i1   = triIdxBuffer.element(base.add(1));
      const i2   = triIdxBuffer.element(base.add(2));
      const p0   = vertexPositionBuffer.element(i0).toVar();
      const p1   = vertexPositionBuffer.element(i1).toVar();
      const p2   = vertexPositionBuffer.element(i2).toVar();
      faceNormalBuffer.element(instanceIndex).assign(cross(p1.sub(p0), p2.sub(p0)));
    })().compute(triangleCount).setName('FCV_FaceNormals');

    computeVertexNormals = Fn(() => {
      const vp     = vtxTriParamBuffer.element(instanceIndex).toVar('vtxTriVP');
      const count  = vp.x.toVar('vtxTriCount');
      const offset = vp.y.toVar('vtxTriOffset');
      const n      = vec3(0, 0, 0).toVar('vtxN');
      Loop({ start: offset, end: offset.add(count), type: 'uint', condition: '<' }, ({ i }) => {
        n.addAssign(faceNormalBuffer.element(vtxTriListBuffer.element(i)));
      });
      const len = n.length();
      If(len.greaterThan(0.0001), () => { n.divAssign(len); });
      vertexNormalBuffer.element(instanceIndex).assign(n);
    })().compute(vertexCount).setName('FCV_VertexNormals');
  }

  // 布メッシュ（quad方式 or パーティクル直接方式）
  let clothGeo, posNode;
  if (useQuadMesh) {
    // /cloth と同一構造：レンダー頂点 = 4パーティクルのセル中心、法線もインライン計算
    const rvc       = analysis.renderVertexCount;
    const quadIdArr = new Uint32Array(analysis.quadVertexIds);
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rvc * 3), 3, false));
    clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(quadIdArr, 4, false));
    clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.renderIndices), 1));
    posNode = Fn(({ material }) => {
      const vids      = attribute('vertexIds');
      const v0        = vertexPositionBuffer.element(vids.x).toVar();
      const v1        = vertexPositionBuffer.element(vids.y).toVar();
      const v2        = vertexPositionBuffer.element(vids.z).toVar();
      const v3        = vertexPositionBuffer.element(vids.w).toVar();
      const tangent   = v1.add(v3).sub(v0.add(v2)).normalize();
      const bitangent = v2.add(v3).sub(v0.add(v1)).normalize();
      material.normalNode = transformNormalToView(cross(tangent, bitangent)).toVarying();
      return v0.add(v1).add(v2).add(v3).mul(0.25);
    })();
  } else {
    const vidArr = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) vidArr[i] = i;
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));
    clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.indices), 1));
    posNode = Fn(() =>
      vertexPositionBuffer.element(attribute('vertexId', 'uint'))
    )();
  }

  const opacity = analysis.opacity ?? 0.85;
  const clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:           THREE.DoubleSide,
    transparent:    opacity < 1.0,
    opacity,
    roughness:      analysis.roughness,
    sheen:          analysis.sheen,
    sheenRoughness: analysis.sheenRoughness,
    sheenColor:     analysis.sheenColor ? new THREE.Color(analysis.sheenColor) : undefined,
  });
  clothMat.colorNode = select(
    frontFacing,
    uniform(new THREE.Color(analysis.colorFront)),
    uniform(new THREE.Color(analysis.colorBack)),
  );
  clothMat.positionNode = posNode;
  if (!useQuadMesh && vertexNormalBuffer) {
    clothMat.normalNode = Fn(() =>
      transformNormalToView(vertexNormalBuffer.element(attribute('vertexId', 'uint')))
    )();
  }

  // フラスタム境界球（この NPC の位置を中心に）
  const boundingSphere = new THREE.Sphere(basePos.clone(), 3.0);

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);

  return {
    vertexPositionBuffer, vertexCount,
    computeSpringForces, computeVertexForces,
    computeFaceNormals, computeVertexNormals,
    bonePinTargetBuffer,
    colliderDataBuffer, colliderCountUniform,
    clothMesh, clothGeo, clothMat,
    leftGripActiveUniform, rightGripActiveUniform,
    leftGripTargetUniform, rightGripTargetUniform,
    boundingSphere,
  };
}

function disposeSimulation() {
  if (!simData) return;
  scene.remove(simData.clothMesh);
  simData.clothGeo.dispose();
  simData.clothMat.dispose();
  simData              = null;
  simRunning           = false;
  colliderDataBuffer   = null;
  colliderCountUniform = null;
}

function updateAnchorPositions() {
  if (!simData?.bonePinTargetBuffer || !anchorMap.size) return;
  const arr = simData.bonePinTargetBuffer.value.array;
  for (const [idx, { boneNode, localOffset }] of anchorMap) {
    boneNode.getWorldPosition(_anchorTmp);
    boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(localOffset).applyQuaternion(_anchorBoneQuat);
    arr[idx*3]   = _anchorTmp.x + _anchorWorldOff.x;
    arr[idx*3+1] = _anchorTmp.y + _anchorWorldOff.y;
    arr[idx*3+2] = _anchorTmp.z + _anchorWorldOff.z;
  }
  simData.bonePinTargetBuffer.value.needsUpdate = true;
}

function startSim() {
  if (!mantleData) { showToast('マントを読み込んでください', 'error'); return; }
  if (simRunning)  return;
  if (!simData) {
    simData = buildSimulation(_buildMantleAnalysis(), primaryCtx());
    colliderDataBuffer   = simData.colliderDataBuffer;
    colliderCountUniform = simData.colliderCountUniform;
  }
  simRunning = true;
  timeSinceLastStep = 0;
  document.getElementById('btn-sim-start').disabled = true;
  document.getElementById('btn-sim-stop').disabled  = false;
}

function stopSim() {
  simRunning = false;
  document.getElementById('btn-sim-start').disabled = false;
  document.getElementById('btn-sim-stop').disabled  = true;
}

// ============================================================
// VRMA Player
// ============================================================

async function loadVRMA(file) {
  if (!currentVRM) { showToast('先にVRMを読み込んでください', 'error'); return; }
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrmAnims = gltf.userData.vrmAnimations;
    if (!vrmAnims?.length) throw new Error('VRMAアニメーションデータが見つかりません');

    unloadVRMA();
    vrmaClip   = createVRMAnimationClip(vrmAnims[0], currentVRM);
    mixer      = new THREE.AnimationMixer(currentVRM.scene);
    vrmaAction = mixer.clipAction(vrmaClip);
    vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
    vrmaAction.play();

    tlState.durationFrames = Math.round(vrmaClip.duration * tlState.fps);
    tlState.currentFrame   = 0;
    vrmaPlaying            = true;

    showToast(`VRMA 読み込み完了 — 再生開始 (${tlState.durationFrames}f)`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function unloadVRMA() {
  if (vrmaAction) vrmaAction.stop();
  if (mixer)      mixer.stopAllAction();
  mixer       = null;
  vrmaClip    = null;
  vrmaAction  = null;
  vrmaPlaying = false;
  tlState.currentFrame = 0;
}

// ============================================================
// Timeline (playback only)
// ============================================================

function gripActiveAt(side, frame) {
  return tlState.grip[side].some(r => frame >= r.start && frame <= r.end);
}

function importTimeline(json) {
  if (!Array.isArray(json.tracks)) throw new Error('無効なタイムラインファイルです');
  tlState.grip.left  = [];
  tlState.grip.right = [];
  tlState.blendShape.clear();

  if (json.fps)            tlState.fps            = json.fps;
  if (json.durationFrames) tlState.durationFrames = json.durationFrames;

  for (const track of json.tracks) {
    if (track.kind === 'grip') {
      if (track.side && Array.isArray(track.ranges)) {
        for (const r of track.ranges) tlState.grip[track.side].push({ start: r.start, end: r.end });
      } else if (track.type && Array.isArray(track.frames)) {
        const side = (track.type.includes('Left') || track.type === 'gripLeft') ? 'left' : 'right';
        if (track.type === 'gripLeft' || track.type === 'gripRight') {
          for (const f of track.frames) tlState.grip[side].push({ start: f, end: f });
        }
      }
    } else if (track.kind === 'blendShape') {
      const kfMap = new Map();
      if (Array.isArray(track.keyframes)) {
        for (const { frame, value } of track.keyframes) kfMap.set(frame, value);
      }
      tlState.blendShape.set(track.name, kfMap);
    }
  }

  showToast('タイムライン読み込み完了');
}

function dispatchTimelineEvents(frame) {
  _updateGripState(frame);
  applyBlendShapesAt(frame);
}

function _updateGripState(f) {
  if (!simData) return;
  for (const side of ['left', 'right']) {
    const active = gripActiveAt(side, f);
    const hp     = handGrabPoints[side];
    hp.active    = active;
    if (side === 'left') {
      simData.leftGripActiveUniform.value = active ? 1 : 0;
      if (active && hp.boneNode) simData.leftGripTargetUniform.value.copy(hp.worldPos);
    } else {
      simData.rightGripActiveUniform.value = active ? 1 : 0;
      if (active && hp.boneNode) simData.rightGripTargetUniform.value.copy(hp.worldPos);
    }
  }
}

function applyBlendShapesAt(frame) {
  if (!currentVRM?.expressionManager) return;
  for (const [name, kfMap] of tlState.blendShape) {
    if (kfMap.size === 0) continue;
    const val = interpolateBlendShape(kfMap, frame);
    try { currentVRM.expressionManager.setValue(name, val); } catch (_) { /* ignore */ }
  }
}

function interpolateBlendShape(kfMap, frame) {
  if (kfMap.size === 0) return 0;
  const keys = [...kfMap.keys()].sort((a, b) => a - b);
  if (frame < keys[0])               return 0;
  if (frame > keys[keys.length - 1]) return 0;
  if (frame === keys[keys.length - 1]) return kfMap.get(keys[keys.length - 1]);
  let lo = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame <= keys[i + 1]) { lo = i; break; }
  }
  const f0 = keys[lo], f1 = keys[lo + 1];
  const t  = (frame - f0) / (f1 - f0);
  return kfMap.get(f0) + (kfMap.get(f1) - kfMap.get(f0)) * t;
}

// ============================================================
// NPC Bundle (.npc.json) — VRM + VRMA + Cloth + Timeline を1ファイルで読込
// ============================================================

// base64 データURI（または素のbase64）を Blob に復元する。
// loadVRM / loadVRMA は URL.createObjectURL(Blob) で読むため Blob でそのまま渡せる。
function dataURIToBlob(dataURI) {
  const comma = dataURI.indexOf(',');
  const hasMeta = dataURI.startsWith('data:') && comma >= 0;
  const meta = hasMeta ? dataURI.slice(0, comma) : '';
  const b64  = hasMeta ? dataURI.slice(comma + 1) : dataURI;
  const mime = (meta.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin  = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function markLoaded(btnId, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.add('loaded');
  btn.textContent = label;
}

// バンドルを順番に読み込む：VRM → VRMA → Cloth → Timeline → 布シミュ自動開始。
// VRMA とボーンアンカー復元は currentVRM を要求するため、VRM を必ず先に読む。
async function loadNPCBundle(json) {
  if (json.format !== 'fps-npc-bundle') {
    throw new Error('NPCバンドル形式ではありません (format != "fps-npc-bundle")');
  }
  if (!json.vrm) throw new Error('バンドルに VRM が含まれていません');

  // 1) VRM（必須・最初）
  await loadVRM(dataURIToBlob(json.vrm));
  markLoaded('btn-vrm-load', 'VRM 読込済 → 変更');

  // 2) VRMA（任意・VRM の後）
  if (json.vrma) {
    await loadVRMA(dataURIToBlob(json.vrma));
    markLoaded('btn-vrma-load', 'VRMA 読込済 → 変更');
  }

  // 3) Cloth（任意・VRM の後＝ボーンアンカー復元のため）
  if (json.cloth) {
    loadMantleJSON(json.cloth);
    markLoaded('btn-cloth-load', 'Cloth.json 読込済 → 変更');
  }

  // 4) Timeline（任意）
  if (json.timeline) {
    importTimeline(json.timeline);
    markLoaded('btn-tl-load', 'Timeline.json 読込済 → 変更');
  }

  // 5) 布シミュ自動開始（WebGPU 利用可能 & Cloth 読込時のみ）
  if (json.cloth && navigator.gpu) startSim();

  showToast(`NPC「${json.name ?? '無名'}」読み込み完了`);
}

// ============================================================
// UI Setup
// ============================================================

function setupUI() {
  // NPC Bundle (.npc.json) — 一括読込
  const npcFile = document.getElementById('npc-file');
  npcFile.addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    npcFile.value = '';
    showToast('NPCバンドル読み込み中…');
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        await loadNPCBundle(JSON.parse(ev.target.result));
      } catch (err) {
        showToast(`NPC読み込み失敗: ${err.message}`, 'error');
        console.error(err);
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-npc-load').addEventListener('click', () => npcFile.click());

  // VRM
  const vrmFile = document.getElementById('vrm-file');
  vrmFile.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    vrmFile.value = '';
    showToast('VRM 読み込み中…');
    try {
      await loadVRM(file);
      document.getElementById('btn-vrm-load').classList.add('loaded');
      document.getElementById('btn-vrm-load').textContent = 'VRM 読込済 → 変更';
    } catch (err) { showToast(`VRM 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrm-load').addEventListener('click', () => vrmFile.click());

  // VRMA
  const vrmaFile = document.getElementById('vrma-file');
  vrmaFile.addEventListener('change', async e => {
    const file = e.target.files?.[0]; if (!file) return;
    vrmaFile.value = '';
    showToast('VRMA 読み込み中…');
    try {
      await loadVRMA(file);
      document.getElementById('btn-vrma-load').classList.add('loaded');
      document.getElementById('btn-vrma-load').textContent = 'VRMA 読込済 → 変更';
    } catch (err) { showToast(`VRMA 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrma-load').addEventListener('click', () => vrmaFile.click());

  // Cloth JSON
  const clothFile = document.getElementById('cloth-file');
  clothFile.addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    clothFile.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        loadMantleJSON(JSON.parse(ev.target.result));
        document.getElementById('btn-cloth-load').classList.add('loaded');
        document.getElementById('btn-cloth-load').textContent = 'Cloth.json 読込済 → 変更';
      } catch (err) { showToast(`Cloth 読み込み失敗: ${err.message}`, 'error'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-cloth-load').addEventListener('click', () => clothFile.click());

  // Timeline JSON
  const tlFile = document.getElementById('tl-file');
  tlFile.addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    tlFile.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        importTimeline(JSON.parse(ev.target.result));
        document.getElementById('btn-tl-load').classList.add('loaded');
        document.getElementById('btn-tl-load').textContent = 'Timeline.json 読込済 → 変更';
      } catch (err) { showToast(`タイムライン読み込み失敗: ${err.message}`, 'error'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-tl-load').addEventListener('click', () => tlFile.click());

  // Sim controls
  document.getElementById('btn-sim-start').addEventListener('click', startSim);
  document.getElementById('btn-sim-stop').addEventListener('click', stopSim);

  // Sliders
  const stiffSlider = document.getElementById('stiffness');
  const stiffVal    = document.getElementById('stiffness-val');
  stiffSlider.addEventListener('input', () => {
    const v = parseFloat(stiffSlider.value);
    stiffVal.textContent     = v.toFixed(2);
    stiffnessUniform.value   = v;
  });

  const windSlider = document.getElementById('wind');
  const windVal    = document.getElementById('wind-val');
  windSlider.addEventListener('input', () => {
    const v = parseFloat(windSlider.value);
    windVal.textContent  = v.toFixed(1);
    windUniform.value    = v;
  });

  // NPC 体数（1〜10）。増減でNPCを動的に追加/破棄。
  const npcSlider = document.getElementById('npc-count');
  const npcVal    = document.getElementById('npc-count-val');
  if (npcSlider) {
    npcSlider.addEventListener('input', () => {
      npcVal.textContent = npcSlider.value;
      applyNPCCount(parseInt(npcSlider.value, 10));
    });
  }

  // 設定パネルをタイトルのタップ/クリックで畳む（常時有効＝PC/モバイル両対応）
  const uiPanel = document.getElementById('ui');
  const uiTitle = uiPanel?.querySelector('h3');
  if (uiPanel && uiTitle) {
    const baseTitle = uiTitle.textContent;
    uiTitle.style.cursor = 'pointer';
    let collapsed = false;
    uiTitle.addEventListener('click', () => {
      collapsed = !collapsed;
      for (const sec of uiPanel.querySelectorAll('.ui-section')) {
        sec.style.display = collapsed ? 'none' : '';
      }
      uiTitle.textContent = collapsed ? `${baseTitle} ▸` : baseTitle;
    });
  }

  // Collapsible sections
  for (const id of ['load-toggle', 'sim-toggle']) {
    const toggle = document.getElementById(id);
    const body   = document.getElementById(id.replace('toggle', 'body'));
    if (toggle && body) {
      toggle.addEventListener('click', () => {
        toggle.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
      });
    }
  }
}

// ============================================================
// FPS Counter
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

// ============================================================
// Render Loop
// ============================================================

async function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 20);

  updateFPS();
  updatePlayer(dt);

  RAGDOLL_ENV.frustum = clothFrustum;   // VRM単位カリング用（前フレームの視錐台。1フレーム遅延は許容）
  const ragActive = !!(npcRagdoll && npcRagdoll.active);

  // VRMA 再生（ラグドール中は NPC#0 のアニメを止める）
  if (mixer && vrmaAction && vrmaPlaying && !ragActive) {
    const prevTime = vrmaAction.time;
    mixer.update(dt);

    // ループ折り返し検出（イベント再発火リセット）
    if (vrmaAction.time < prevTime - 0.001) {
      tlState.currentFrame = 0;
    }

    const newFrame = Math.min(
      Math.floor(vrmaAction.time * tlState.fps),
      tlState.durationFrames,
    );
    if (newFrame !== tlState.currentFrame) {
      tlState.currentFrame = newFrame;
      dispatchTimelineEvents(newFrame);
    }
  }

  // ラグドール物理（正規化ボーンを上書き）→ VRM update で実ボーンへ反映
  if (ragActive) updateRagdoll(npcRagdoll, dt, RAGDOLL_ENV);
  // 復帰ブレンド（mixer がアニメ姿勢を書いた後に補間）
  else if (npcRagdoll && npcRagdoll.recovering) updateRagdollRecovery(npcRagdoll, dt);
  // VRM update（表情・ボーン反映）
  if (currentVRM) currentVRM.update(dt);

  // 追加NPC：ボディのアニメ更新（各自のミキサー）。ラグドール中は物理/復帰ブレンドに切替。
  for (const n of crowdNPCs) {
    const rdActive = !!(n.ragdoll && n.ragdoll.active);
    if (n.mixer && vrmaPlaying && !rdActive) n.mixer.update(dt);
    if (rdActive) updateRagdoll(n.ragdoll, dt, RAGDOLL_ENV);
    else if (n.ragdoll && n.ragdoll.recovering) updateRagdollRecovery(n.ragdoll, dt);
    n.vrm.update(dt);
  }

  // タイムラインブレンドシェイプを VRM update 後に適用（NPC#0）
  if (currentVRM && tlState.blendShape.size > 0) {
    applyBlendShapesAt(tlState.currentFrame);
  }

  // ボーン追従（NPC#0 のコライダー・HGP）
  updateBoneColliders();
  updateHandGrabPoints();

  // 発射体（右クリック）の更新＋NPC命中判定
  stepProjectiles(dt);

  // ── 布シミュレーション：NPC#0 と追加NPC を「それぞれ独立に」回す ──
  windUniform.value = parseFloat(document.getElementById('wind').value);
  clothProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  clothFrustum.setFromProjectionMatrix(clothProjMatrix);

  // サブステップ数を共通タイミングで決定（全NPC同数）
  const timePerStep     = 1 / 360;
  const MAX_STEPS_FRAME = 6;
  let stepsThisFrame    = 0;
  timeSinceLastStep += dt;
  while (timeSinceLastStep >= timePerStep && stepsThisFrame < MAX_STEPS_FRAME) {
    stepsThisFrame += 1;
    simTimestamp   += timePerStep;
    timeSinceLastStep -= timePerStep;
  }
  if (stepsThisFrame >= MAX_STEPS_FRAME) timeSinceLastStep = 0;

  // NPC#0
  if (simRunning && simData) {
    updateAnchorPositions();
    if (clothFrustum.intersectsSphere(simData.boundingSphere)) {
      for (let s = 0; s < stepsThisFrame; s++) {
        renderer.compute(simData.computeSpringForces);
        renderer.compute(simData.computeVertexForces);
      }
    }
    if (simData.computeFaceNormals)   renderer.compute(simData.computeFaceNormals);
    if (simData.computeVertexNormals) renderer.compute(simData.computeVertexNormals);
  }

  // 追加NPC（各自の専用バッファ・コライダー・アンカーで独立にシミュ）
  for (const n of crowdNPCs) {
    if (!n.simData) continue;
    updateBoneCollidersForNPC(n);
    updateAnchorPositionsForNPC(n);
    updateGripForNPC(n, tlState.currentFrame);   // タイムラインのgrabを各NPCに適用
    if (clothFrustum.intersectsSphere(n.simData.boundingSphere)) {
      for (let s = 0; s < stepsThisFrame; s++) {
        renderer.compute(n.simData.computeSpringForces);
        renderer.compute(n.simData.computeVertexForces);
      }
    }
    if (n.simData.computeFaceNormals)   renderer.compute(n.simData.computeFaceNormals);
    if (n.simData.computeVertexNormals) renderer.compute(n.simData.computeVertexNormals);
  }

  renderer.render(scene, camera);
}

// ============================================================
// Crowd（追加NPC：それぞれ独立した布シミュを持つ）
// ============================================================

// VRM を1体ロードして指定位置に配置（グローバルには触らない＝NPC#0 と独立）。
async function loadVRMFromBlob(blob, position) {
  const loader = new GLTFLoader();
  // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
  loader.register(p => new VRMLoaderPlugin(p, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
  }));
  const url = URL.createObjectURL(blob);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm  = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');
    vrm.scene.position.copy(position);
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    return vrm;
  } finally { URL.revokeObjectURL(url); }
}

// 指定 VRM 用に VRMA アニメーションクリップを作る（VRMごとにボーンへバインドが必要）。
async function makeVRMAClipFor(vrm, vrmaBlob) {
  const loader = new GLTFLoader();
  loader.register(p => new VRMAnimationLoaderPlugin(p));
  const url = URL.createObjectURL(vrmaBlob);
  try {
    const gltf  = await loader.loadAsync(url);
    const anims = gltf.userData.vrmAnimations;
    if (!anims?.length) return null;
    return createVRMAnimationClip(anims[0], vrm);
  } finally { URL.revokeObjectURL(url); }
}

// このNPC専用に、VRMボーンから球コライダーを構築（保存設定があれば半径/オフセット復元）。
function buildCollidersForNPC(n) {
  n.colliders.length = 0;
  const tmp = new THREE.Vector3(), quat = new THREE.Quaternion();
  for (const def of BONE_COLLIDER_DEFS) {
    const node = n.vrm.humanoid?.getNormalizedBoneNode(def.bone);
    if (!node) continue;
    node.getWorldPosition(tmp);
    node.getWorldQuaternion(quat);
    const saved = n.savedColliderData?.find(s => s.boneName === def.bone);
    const r           = saved ? saved.r : def.r;
    const localOffset = (saved && saved.offset) ? new THREE.Vector3(...saved.offset) : new THREE.Vector3();
    const world = tmp.clone().add(localOffset.clone().applyQuaternion(quat));
    n.colliders.push({ x: world.x, y: world.y, z: world.z, r, boneNode: node, boneName: def.bone, localOffset });
    if (n.colliders.length >= MAX_COLLIDERS) break;
  }
  fillColliderArr(n.colliders, n.colliderDataArr);
}

// このNPCの mantleData から buildSimulation 用の analysis を作る（位置はこのNPCのもの）。
function buildAnalysisForNPC(n) {
  const md = n.mantleData;
  const transformed = applyMantleTransform(n.mantleOrigPos, md.vertexCount, n.mantleTransform, n.basePos);
  const m = md.material ?? {};
  return {
    positions:         transformed,
    vertexCount:       md.vertexCount,
    springs:           md.springs,
    springCount:       md.springs.length / 2,
    indices:           md.indices,
    colorFront:        m.colorFront      ?? '#204080',
    colorBack:         m.colorBack       ?? '#803020',
    roughness:         m.roughness       ?? 1.0,
    sheen:             m.sheen           ?? 1.0,
    sheenRoughness:    m.sheenRoughness  ?? 0.5,
    sheenColor:        m.sheenColor      ?? null,
    opacity:           m.opacity         ?? 0.85,
    quadVertexIds:     md.quadVertexIds     ?? null,
    renderIndices:     md.renderIndices     ?? null,
    renderVertexCount: md.renderVertexCount ?? null,
  };
}

// このNPCのコライダーをボーンに追従させ、GPUバッファへ反映。
function updateBoneCollidersForNPC(n) {
  if (!n.simData) return;
  let changed = false;
  for (const c of n.colliders) {
    if (!c.boneNode) continue;
    c.boneNode.getWorldPosition(_colliderTmp);
    c.boneNode.getWorldQuaternion(_colliderQuat);
    _colliderTmp.add(_colliderOff.copy(c.localOffset).applyQuaternion(_colliderQuat));
    if (c.x === _colliderTmp.x && c.y === _colliderTmp.y && c.z === _colliderTmp.z) continue;
    c.x = _colliderTmp.x; c.y = _colliderTmp.y; c.z = _colliderTmp.z;
    changed = true;
  }
  if (changed) {
    fillColliderArr(n.colliders, n.colliderDataArr);
    n.simData.colliderDataBuffer.value.array.set(n.colliderDataArr);
    n.simData.colliderDataBuffer.value.needsUpdate = true;
  }
}

// このNPCのボーンアンカー目標位置を更新。
function updateAnchorPositionsForNPC(n) {
  if (!n.simData?.bonePinTargetBuffer || !n.anchorMap.size) return;
  const arr = n.simData.bonePinTargetBuffer.value.array;
  for (const [idx, { boneNode, localOffset }] of n.anchorMap) {
    boneNode.getWorldPosition(_anchorTmp);
    boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(localOffset).applyQuaternion(_anchorBoneQuat);
    arr[idx*3]   = _anchorTmp.x + _anchorWorldOff.x;
    arr[idx*3+1] = _anchorTmp.y + _anchorWorldOff.y;
    arr[idx*3+2] = _anchorTmp.z + _anchorWorldOff.z;
  }
  n.simData.bonePinTargetBuffer.value.needsUpdate = true;
}

// このNPCのグリップ（タイムラインのgrab）を更新：手ボーン位置を追従し、grip uniform をON/OFF。
// グリップ範囲はグローバル tlState を共有（全NPC同期再生なので同じフレームで判定）。
function updateGripForNPC(n, frame) {
  if (!n.simData || !n.handGrabPoints) return;
  for (const side of ['left', 'right']) {
    const hp = n.handGrabPoints[side];
    if (!hp.boneNode) continue;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.worldPos.add(hp.offset);
    const active = gripActiveAt(side, frame);
    if (side === 'left') {
      n.simData.leftGripActiveUniform.value = active ? 1 : 0;
      if (active) n.simData.leftGripTargetUniform.value.copy(hp.worldPos);
    } else {
      n.simData.rightGripActiveUniform.value = active ? 1 : 0;
      if (active) n.simData.rightGripTargetUniform.value.copy(hp.worldPos);
    }
  }
}

// 追加NPCを1体生成：VRM + VRMA + 専用の布シミュ（独立したコライダー/アンカー/バッファ）。
async function createCrowdNPC(bundle, position) {
  const vrm = await loadVRMFromBlob(dataURIToBlob(bundle.vrm), position);

  let mixer = null;
  if (bundle.vrma) {
    const clip = await makeVRMAClipFor(vrm, dataURIToBlob(bundle.vrma));
    if (clip) {
      mixer = new THREE.AnimationMixer(vrm.scene);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
  }

  const cloth = bundle.cloth;
  if (!cloth) return { vrm, mixer, simData: null };

  const n = {
    vrm, mixer,
    basePos:        position.clone(),
    mantleData:     cloth,
    mantleOrigPos:  new Float32Array(cloth.positions),
    mantleTransform: cloth.editorTransform ? { ...cloth.editorTransform } : { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 },
    anchorMap:      new Map(),
    leftGripSet:    new Set(cloth.leftGripIndices  ?? []),
    rightGripSet:   new Set(cloth.rightGripIndices ?? []),
    colliders:      [],
    colliderDataArr: new Float32Array(MAX_COLLIDERS * 4),
    savedColliderData: cloth.colliders ?? null,
    simData:        null,
  };

  // ボーンアンカー復元（このNPCのVRMボーンに解決）
  const anchorData = cloth.anchorAssignments ?? cloth.pinnedBoneAssignments;
  if (anchorData) {
    for (const entry of anchorData) {
      const boneNode = vrm.humanoid?.getNormalizedBoneNode(entry.boneName);
      if (!boneNode) continue;
      let localOffset;
      if (entry.localOffset) {
        localOffset = new THREE.Vector3(...entry.localOffset);
      } else if (entry.offset) {
        const q = new THREE.Quaternion();
        boneNode.getWorldQuaternion(q);
        localOffset = new THREE.Vector3(...entry.offset).applyQuaternion(q.invert());
      } else { continue; }
      n.anchorMap.set(entry.vertexIdx, { boneName: entry.boneName, boneNode, localOffset });
    }
  }

  // 手グラブポイント（このNPCの手ボーン + cloth.handGrabOffsets）。タイムラインのgrabで使用。
  n.handGrabPoints = {
    left:  { boneNode: vrm.humanoid?.getNormalizedBoneNode('leftHand')  ?? null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3() },
    right: { boneNode: vrm.humanoid?.getNormalizedBoneNode('rightHand') ?? null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3() },
  };
  if (cloth.handGrabOffsets) {
    for (const side of ['left', 'right']) {
      const v = cloth.handGrabOffsets[side];
      if (v) n.handGrabPoints[side].offset.set(v[0], v[1], v[2]);
    }
  }

  buildCollidersForNPC(n);
  n.simData = buildSimulation(buildAnalysisForNPC(n), {
    anchorMap:       n.anchorMap,
    leftGripSet:     n.leftGripSet,
    rightGripSet:    n.rightGripSet,
    colliders:       n.colliders,
    colliderDataArr: n.colliderDataArr,
    basePos:         n.basePos,
  });
  n.ragdoll = createRagdoll(vrm);
  return n;
}

// megu.npc.json を取得する。dev（vite: public が base 直下）と本番デプロイ（dist に同梱）の
// 両方で動くよう、複数の候補パスを順に試す。
async function fetchNPCBundle() {
  const candidates = [];
  // dev: vite が import.meta.env.BASE_URL を base 文字列に置換（本番のraw配信では undefined）
  try {
    const base = import.meta.env && import.meta.env.BASE_URL;
    if (base) candidates.push(base + 'npc/megu.npc.json');
  } catch { /* import.meta.env 未定義の静的配信では無視 */ }
  // 本番：このモジュールと同梱（dist-fps-cloth-vrm/npc/…）
  candidates.push(new URL('./npc/megu.npc.json', import.meta.url).href);
  // フォールバック：親階層の共有 npc/
  candidates.push(new URL('../npc/megu.npc.json', import.meta.url).href);
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* 次の候補へ */ }
  }
  return null;
}

// 追加NPCを1体破棄（シーンから除去＋ジオメトリ/マテリアル解放）。
function disposeCrowdNPC(n) {
  if (n.ragdoll) disposeRagdoll(n.ragdoll);
  if (n.vrm) {
    scene.remove(n.vrm.scene);
    n.vrm.scene.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.geometry?.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m?.dispose();
      }
    });
  }
  if (n.simData) {
    scene.remove(n.simData.clothMesh);
    n.simData.clothGeo?.dispose();
    n.simData.clothMat?.dispose();
  }
}

// 目標体数（NPC#0 含む 1〜10）に合わせて追加NPCを増減する。
// 減らす分は即座に破棄、増やす分は VRM ロードが非同期なので逐次生成（多重起動を防止しつつ
// スライダの最新値に追従）。
async function applyNPCCount(total, onSpawn = null) {
  desiredNPCTotal = Math.max(1, Math.min(CROWD_POSITIONS.length + 1, total));

  // 減らす（同期・即時）
  let targetCrowd = desiredNPCTotal - 1;
  while (crowdNPCs.length > targetCrowd) disposeCrowdNPC(crowdNPCs.pop());

  // 増やす（非同期・逐次）。生成中に desiredNPCTotal が変わっても最新へ追従。
  if (spawnLoopRunning || !cachedBundle) return;
  spawnLoopRunning = true;
  try {
    while (true) {
      targetCrowd = desiredNPCTotal - 1;
      while (crowdNPCs.length > targetCrowd) disposeCrowdNPC(crowdNPCs.pop());
      if (crowdNPCs.length >= targetCrowd) break;
      const p = CROWD_POSITIONS[crowdNPCs.length];
      try {
        const n = await createCrowdNPC(cachedBundle, new THREE.Vector3(p[0], p[1], p[2]));
        crowdNPCs.push(n);
        if (onSpawn) onSpawn(crowdNPCs.length + 1);   // +1 = NPC#0 を含む現在の体数
      } catch (e) {
        showToast(`NPC追加失敗: ${e.message}`, 'error');
        console.error('[applyNPCCount]', e);
        break;
      }
    }
  } finally {
    spawnLoopRunning = false;
    showToast(`NPC: 計 ${crowdNPCs.length + 1} 体`);
  }
}

// ============================================================
// Init
// ============================================================

async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6a9ab8);
  scene.fog = new THREE.FogExp2(0x6a9ab8, 0.018);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff4cc, 1.8);
  sun.position.set(5, 12, -3);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x8ab8d8, 0x4a8c3a, 0.6));

  // HDR 環境マップ：/cloth と同じ IBL を scene.environment に設定。
  // roughness=1.0 + sheen=1.0 のマント素材はこれが無いと反射光が出ず平坦に見える。
  // 空(background)とフォグはゲームの見た目用にそのまま維持し、環境マップのみ追加する。
  setLoadProgress(0.05, '環境マップ(HDR)を読み込み中…');
  try {
    const hdrTexture = await new UltraHDRLoader().loadAsync(
      'https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg',
    );
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment  = hdrTexture;
  } catch {
    // オフライン時は解析ライトのみで継続
  }

  buildLevel();

  playerCollider = new Capsule(
    new THREE.Vector3(0, 0.35, 4),
    new THREE.Vector3(0, 1.0,  4),
    0.35,
  );
  playerVel.set(0, 0, 0);
  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');

  // 共有 uniform
  stiffnessUniform = uniform(0.2);
  dampeningUniform = uniform(0.99);
  floorYUniform    = uniform(0);
  windUniform      = uniform(1.0);

  setupUI();
  setupControls();
  setupTouchControls();   // モバイル（ジョイスティックDOMが在る場合のみ有効）

  // クリックで開始するオーバレイは PC（pointer lock）用。モバイル（タッチ操作）では出さない。
  const lockOverlay = document.getElementById('lock-overlay');
  if (lockOverlay) lockOverlay.style.display = touchMode ? 'none' : 'flex';

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  // NPC を事前配置：megu.npc.json を自動ロードして NPC#0 を作り、続けて目標体数まで配置する。
  try {
    setLoadProgress(0.12, 'NPCデータ(.npc.json)を取得中…');
    const res = await fetchNPCBundle();
    if (res && res.ok) {
      const bundle = await res.json();
      const initial = parseInt(document.getElementById('npc-count')?.value, 10) || desiredNPCTotal;
      const npcFrac = (count) => 0.15 + 0.85 * (count / initial);
      setLoadProgress(npcFrac(0), `NPC 1/${initial}（モデル/マント）を読み込み中…`);
      await loadNPCBundle(bundle);      // NPC#0（ライブ布シミュ）
      cachedBundle = bundle;            // 体数スライダで追加生成に再利用
      setLoadProgress(npcFrac(1), `NPC 1/${initial} 読み込み完了`);
      // 残りの NPC を目標体数まで生成（各自で独立に布シミュ）。生成ごとに進捗更新。
      await applyNPCCount(initial, (count) => {
        setLoadProgress(npcFrac(count), `NPC ${count}/${initial} を読み込み中…`);
      });
    } else {
      console.warn('NPC事前ロード: megu.npc.json が見つかりません');
    }
  } catch (err) {
    showToast(`NPC事前ロード失敗: ${err.message}`, 'error');
    console.error('NPC事前ロード失敗', err);
  }

  setLoadProgress(1, '準備完了');
  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
}

init().catch(err => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = `初期化失敗: ${err.message}`;
});
