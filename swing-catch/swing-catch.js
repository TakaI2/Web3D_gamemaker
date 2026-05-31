// swing-catch.js — FPS視点で飛行オブジェクトをキャッチ・振り回し・吹っ飛ばすサンドボックス
// Three.js v0.184 via esm.sh CDN (WebGPU)
// 設計: .tmp/grab_game_design.md

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { Octree }  from 'https://esm.sh/three@0.184.0/examples/jsm/math/Octree.js';
import { Capsule } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Capsule.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation?deps=three@0.184.0,@pixiv/three-vrm@3.4.0';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse }
  from '../lib/vrm-ragdoll.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { positionWorld, mix, color } from 'https://esm.sh/three@0.184.0/tsl';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';

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

// ── Megu（VRM ラグドール）─────────────────────────────────────
const MEGU_COUNT         = 3;      // 出現する NPC 数
const MEGU_RADIUS        = 0.55;   // 当たり/掴み判定の体半径
const MEGU_CENTER_Y      = 1.0;    // 飛行時の判定中心の高さ（root からのオフセット）
const MEGU_RECOVER_DELAY = 2.5;    // 被弾→ラグドール継続時間(秒)
const RAGDOLL_IMPULSE    = 0.3;    // 命中時の速度キック
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
  if (grabbed || grabbedMegu()) return;
  raycaster.setFromCamera(screenCenter, camera);
  raycaster.far = GRAB_RANGE;

  const hits = raycaster.intersectObjects(objects.map(o => o.mesh), false);
  let kind = hits.length ? 'obj' : null;
  let dist = hits.length ? hits[0].distance : Infinity;
  const obj = hits.length ? hits[0].object.userData.obj : null;
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

// バンドルから NPC を1体生成して返す（VRM は個体ごとに別インスタンス）。
async function createMegu(bundle, pos) {
  const loader = new GLTFLoader();
  loader.register(p => new VRMLoaderPlugin(p));
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

  return {
    vrm, ragdoll, mixer, action, cloth, pos,
    tlFps: bundle.timeline?.fps ?? 30,
    tlDuration: bundle.timeline?.durationFrames ?? 0,
    tlClock: 0,                              // アニメ無し(ayu等)用の手グリップ・タイムライン時計
    vel: randomDir().multiplyScalar(randRange(2, 4)),
    grabbed: false, clothGrabbed: false, grabBone: 'chest', grabOffset: new THREE.Vector3(), recoverTimer: 0,
  };
}

async function loadMegus() {
  // public/npc/ の全 NPC を1体ずつ出現させる
  for (const filename of NPC_FILES) {
    const bundle = await fetchBundle(filename);
    if (!bundle || !bundle.vrm) { console.warn('NPC 読み込み失敗:', filename); continue; }
    const pos = new THREE.Vector3(randRange(-5, 5), randRange(1.5, ROOM.y - 2.5), randRange(-5, 5));
    const m = await createMegu(bundle, pos);
    if (m) megus.push(m);
  }
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
  m.recoverTimer = MEGU_RECOVER_DELAY;
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
  updateCrosshair();
}

function grabMeguCloth(m, clothIdx) {
  updateHandAnchor();
  m.cloth.grab(clothIdx, handAnchor);                       // 掴んだマント点を手にピン
  m.clothGrabbed = true;
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true); // 本体もラグドール化して吊り下げ
  updateCrosshair();
}

function releaseMegu(m) {
  if (m.clothGrabbed) { m.cloth.releaseGrab(); m.clothGrabbed = false; }
  m.grabbed = false;
  m.recoverTimer = MEGU_RECOVER_DELAY;   // 離した後もしばらくラグドール（落下）してから復帰＝被弾と同様
  updateCrosshair();
}

function onMeguRecovered(m) {
  m.vel.copy(randomDir()).multiplyScalar(randRange(2, 4));   // 新しい速度で飛行再開
}

// 掴み中の NPC（1体）を返す。無ければ null。
function grabbedMegu() {
  for (const m of megus) if (m.grabbed || m.clothGrabbed) return m;
  return null;
}

function updateMegu(m, dt) {
  const rd = m.ragdoll;
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
    m.pos.addScaledVector(m.vel, dt);
    bounceAxis(m, 'x', -ROOM.x / 2 + MEGU_RADIUS, ROOM.x / 2 - MEGU_RADIUS);
    bounceAxis(m, 'y', 0.2, ROOM.y - 1.8);
    bounceAxis(m, 'z', -ROOM.z / 2 + MEGU_RADIUS, ROOM.z / 2 - MEGU_RADIUS);
    m.vrm.scene.position.copy(m.pos);
  }
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

    // NPC 命中：未発動ならラグドール発動、発動中なら追加の撃力で小突く（倒れていても当たる）
    if (!dead) {
      for (const m of megus) {
        meguCenter(m, _meguC);
        const rr = p.radius + MEGU_RADIUS;
        if (p.pos.distanceToSquared(_meguC) <= rr * rr) {
          _hitDir.copy(p.vel).normalize();
          if (m.ragdoll.active) {
            applyRagdollImpulse(m.ragdoll, _hitDir.clone().multiplyScalar(RAGDOLL_IMPULSE), 'hips');
            if (!m.grabbed && !m.clothGrabbed) m.recoverTimer = MEGU_RECOVER_DELAY;   // 倒れたまま延長
          } else {
            hitMegu(m, _hitDir);
          }
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
  if (el) el.classList.toggle('grabbing', !!grabbed || !!grabbedMegu());
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
  updateMegus(dt);
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
  scene.fog = new THREE.FogExp2(0xcfe3f5, 0.006);     // 薄い空気遠近

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 250);
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
  loadMegus().catch(e => console.warn('Megu 読み込み失敗:', e));
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
