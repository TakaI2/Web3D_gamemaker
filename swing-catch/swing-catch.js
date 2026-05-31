// swing-catch.js — FPS視点で飛行オブジェクトをキャッチ・振り回し・吹っ飛ばすサンドボックス
// Three.js v0.184 via esm.sh CDN (WebGPU)
// 設計: .tmp/grab_game_design.md

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { Octree }  from 'https://esm.sh/three@0.184.0/examples/jsm/math/Octree.js';
import { Capsule } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Capsule.js';

// ── アリーナ ───────────────────────────────────────────────────
const ROOM = { x: 14, y: 9, z: 14 };   // 内寸（床 y=0、天井 y=ROOM.y）

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
let worldOctree    = null;
let playerCollider = null;
let playerOnFloor  = false;

// ── プレイヤー状態 ─────────────────────────────────────────────
const playerVel = new THREE.Vector3();
let   playerYaw   = Math.PI;
let   playerPitch = 0;
const keysDown    = {};
let   isLocked    = false;

// ── ゲーム状態 ─────────────────────────────────────────────────
const objects     = [];   // 飛行オブジェクト
const projectiles = [];   // 発射体
let   grabbed     = null;  // 掴み中のオブジェクト（1個）
const handAnchor  = new THREE.Vector3();

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
const raycaster = new THREE.Raycaster();
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
  };

  // 床・天井（プレイ域より少し大きめ）
  box(0, -t / 2,          0, ROOM.x + t * 2, t, ROOM.z + t * 2, mFloor);
  box(0, ROOM.y + t / 2,  0, ROOM.x + t * 2, t, ROOM.z + t * 2, mCeiling);
  // 四方の壁（内面がプレイ域境界に一致）
  box( hx + t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall);
  box(-hx - t / 2, ROOM.y / 2, 0, t, ROOM.y, ROOM.z + t * 2, mWall);
  box(0, ROOM.y / 2,  hz + t / 2, ROOM.x + t * 2, ROOM.y, t, mWall);
  box(0, ROOM.y / 2, -hz - t / 2, ROOM.x + t * 2, ROOM.y, t, mWall);

  scene.add(group);
  worldOctree = new Octree();
  worldOctree.fromGraphNode(group);
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

function randRange(min, max) { return min + Math.random() * (max - min); }

function randomDir() {
  // 一様ランダム方向（球面）
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
}

function spawnObject() {
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
    obj.mesh.geometry.dispose();
    obj.mesh.material.dispose();
  }
  objects.length = 0;
  grabbed = null;
}

function setObjectCount(n) {
  clearObjects();
  for (let i = 0; i < n; i++) spawnObject();
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

function tryGrab() {
  if (grabbed) return;
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = GRAB_RANGE;
  const meshes = objects.map(o => o.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return;
  const obj = hits[0].object.userData.obj;
  if (!obj) return;
  obj.grabbed = true;
  grabbed = obj;
  updateCrosshair();
}

function release() {
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
  if (!isLocked) return;

  const speedDelta = dt * (playerOnFloor ? PLAYER_SPEED : PLAYER_SPEED * 0.4);
  const fwd   = new THREE.Vector3(-Math.sin(playerYaw), 0, -Math.cos(playerYaw));
  const right = new THREE.Vector3( Math.cos(playerYaw), 0, -Math.sin(playerYaw));

  if (keysDown['KeyW'] || keysDown['ArrowUp'])    playerVel.addScaledVector(fwd,    speedDelta);
  if (keysDown['KeyS'] || keysDown['ArrowDown'])  playerVel.addScaledVector(fwd,   -speedDelta);
  if (keysDown['KeyA'] || keysDown['ArrowLeft'])  playerVel.addScaledVector(right, -speedDelta);
  if (keysDown['KeyD'] || keysDown['ArrowRight']) playerVel.addScaledVector(right,  speedDelta);

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
  if (el) el.classList.toggle('grabbing', !!grabbed);
}

function setupControls() {
  const canvas = renderer.domElement;

  canvas.addEventListener('click', () => {
    if (!isLocked) canvas.requestPointerLock();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === canvas;
    const overlay = document.getElementById('lock-overlay');
    if (overlay) overlay.style.display = isLocked ? 'none' : 'flex';
    if (!isLocked) release();   // ロック解除時は掴みも解放
  });

  document.addEventListener('mousemove', (e) => {
    if (!isLocked) return;
    const sens = 0.002;
    playerYaw   -= e.movementX * sens;
    playerPitch -= e.movementY * sens;
    playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
    camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!isLocked) return;       // 最初のクリックはロック取得のみ
    if (e.button === 0)      tryGrab();
    else if (e.button === 2) fireProjectile();
  });

  window.addEventListener('mouseup', (e) => {
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
  renderer.render(scene, camera);
}

// ============================================================
// 初期化
// ============================================================

async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.1;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12141f);
  scene.fog = new THREE.FogExp2(0x12141f, 0.02);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0xfff4e0, 1.6);
  key.position.set(4, 10, 6);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x404050, 0.7));
  const center = new THREE.PointLight(0xffffff, 1.2, 30);
  center.position.set(0, ROOM.y - 1, 0);
  scene.add(center);

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
  document.getElementById('loading').style.display = 'none';
});
