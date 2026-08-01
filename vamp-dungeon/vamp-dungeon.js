// vamp-dungeon.js — Vampire Dungeon（Phase 1: ダンジョン生成＋徒歩移動＋壁当たり＋ゴール）
// レンダラは WebGPURenderer（WebGPU が無ければ three が WebGL2 バックエンドへ自動フォールバック。
// どちらでも TSL/ノードマテリアル＝ディソルブ等のFXが動くので、後段フェーズの資産を活かせる）。
// 当たり判定は Octree ではなく「ダンジョンのグリッド」を直接引く。NPCのナビ(Phase2)と同じデータを共有でき、
// 描画は InstancedMesh でまとめられる（数百メッシュ→数ドローコール）。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { pmremTexture } from 'https://esm.sh/three@0.184.0/tsl';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { generateMansion, SOLID } from '../lib/dungeon-gen.js';
import { makePaintingTexture } from '../lib/painting-tex.js';
import { buildNav, findPath, hasLineOfSight, passable } from '../lib/dungeon-nav.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { solveTwoBoneIK } from '../lib/vrm-ik.js';
import { sampleExpr, applyExpr } from '../lib/expr-timeline.js';
import { createRagdoll, setRagdollActive, updateRagdoll, disposeRagdoll } from '../lib/vrm-ragdoll.js';
import { createDissolve } from '../lib/fx-dissolve.js';
import { createNpcSpeech } from '../lib/npc-speech.js';
import { createSpeechUI } from '../lib/speech-ui.js';
import { fetchSpeechSet, buildSpeechCharacter } from '../lib/speech-set.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const e = $('status'); if (e) e.textContent = m; };

// ── 設定 ──
const SCALE = 2.0;                 // 1セル=2m → 大回廊3セル=6m / 脇廊下2セル=4m
const TILE = SCALE;
const WALL_T = 0.18;               // 壁の当たり厚み（見た目の板厚より少し太めに取る）
const NIGHT_SEC = 300;             // 5分耐久（Phase2で勝敗に使用）
const PLAYER_SPEED = 26, GRAVITY = 26, JUMP_V = 7.2;
const EYE_H = 1.55, BODY_R = 0.42;  // 目線の高さ / 体の半径（壁との当たり）
const KIT = '../models/fantasy_GLB format/';
const KIT_FURN = '../models/kenney_furniture-kit/Models/GLTF format/';
// fantasyの壁は長辺がZ・厚みがX。room-gen規約(長辺X)へ合わせるため +90°。
const WALL_RY_OFFSET = Math.PI / 2;

// ── レンダラ / シーン ──
const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
$('app').appendChild(renderer.domElement);

const LIGHTS = { hemi: null, torch: null, moon: null, lamps: [] };   // 観察モードのライティングUIから触る
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05050a);
scene.fog = new THREE.Fog(0x05050a, 6, 42);   // 迷宮の閉塞感＋遠景カットで軽量化
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.02, 120);   // near=2cm：至近の顔が切れないように
scene.add(camera);
LIGHTS.hemi = new THREE.HemisphereLight(0x3a4260, 0x14141c, 0.75); scene.add(LIGHTS.hemi);
// 松明は近距離で白飛びしないよう控えめ＋減衰ゆるめ（decay=1）にして奥まで届かせる
const torch = new THREE.PointLight(0xffcb90, 6.5, 18, 1.0);   // プレイヤーの松明（カメラ追従）
LIGHTS.torch = torch;
// HDR環境マップ（IBL）: これが無いと sheen/roughness の反射が出ず布がのっぺりする。
// ただし scene.environment に入れるとシーン全体へ効き、建物の陰影まで浅くなる
// （WebGPU のノードマテリアルでは envMapIntensity=0 にしても切れない）。
// → シーンには適用せず、マントのマテリアルへ envNode として直接挿す（下の applyCapeEnv）。
let capeEnvNode = null;   // マント専用の環境マップノード（シーンには適用しない）
const hdrReady = new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
  .then((hdr) => { hdr.mapping = THREE.EquirectangularReflectionMapping; capeEnvNode = pmremTexture(hdr); })
  .catch((e) => console.warn('HDR環境マップ読込失敗:', e));
camera.add(torch);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ── モデル読み込み（bottom-center 原点に正規化＝room-editor と同じ規約） ──
const loader = new GLTFLoader();
async function loadPart(dir, name) {
  const url = dir.split('/').map(encodeURIComponent).join('/').replace(/^\.\.%2F|^%2E%2E\//, '../') + encodeURIComponent(name) + '.glb';
  const gltf = await loader.loadAsync(dir + encodeURIComponent(name) + '.glb');
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  return { obj, size, url };
}
// 部材の全メッシュを1つのジオメトリ配列として取り出す（InstancedMesh 化のため）
function collectMeshes(root) {
  const out = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (o.isMesh) out.push({ geo: o.geometry, mat: o.material, mat4: o.matrixWorld.clone() }); });
  return out;
}

// ── ダンジョン ──
let dg = null;
const dungeonGroup = new THREE.Group();
scene.add(dungeonGroup);

async function buildDungeon() {
  setStatus('ダンジョン生成中…');
  dg = generateMansion({ roomsX: 3, roomsZ: 3, seed: (Math.random() * 99999) | 0 });
  buildWallColliders();

  // 抽象名 → 実モデル（キット指定）。部屋の家具は room-gen が返す実名をそのまま使う。
  const MAP = {
    floor: [KIT_FURN, 'floorFull'], wall: [KIT, 'wall'], doorway: [KIT, 'wall-doorway-square'],
    window: [KIT, 'wall-window-round'], pillar: [KIT, 'pillar-stone'], lantern: [KIT, 'lantern'],
    paneling: [KIT_FURN, 'paneling'], rug: [KIT_FURN, 'rugRectangle'],
    chandelier: [KIT_FURN, 'lampSquareCeiling'], plant: [KIT_FURN, 'pottedPlant'],
  };
  const needed = new Set(['floor', 'wall', 'doorway', 'window']);
  for (const it of dg.items) if (it.model !== 'painting') needed.add(it.model);
  const parts = {};
  await Promise.all([...needed].map(async (name) => {
    const [dir, file] = MAP[name] || [KIT_FURN, name];   // 未知＝家具キットの実名
    try { parts[name] = await loadPart(dir, file); } catch (e) { console.warn('モデル読込失敗:', name, e.message); }
  }));
  // 種類ごとに配置行列を集めて InstancedMesh 化
  const buckets = new Map();
  const push = (kind, m) => { if (!buckets.has(kind)) buckets.set(kind, []); buckets.get(kind).push(m); };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(SCALE, SCALE, SCALE), _p = new THREE.Vector3();

  const WALL_H = parts.wall.size.y * SCALE;   // 壁1段の高さ
  const FLOOR_T = (parts.floor ? parts.floor.size.y : 0.05) * SCALE;   // 床タイルの厚み
  wallH = WALL_H;
  for (const s of dg.shell) {
    const isWall = s.model === 'wall' || s.model === 'doorway' || s.model === 'window';
    const ry = (s.ry || 0) + (isWall ? WALL_RY_OFFSET : 0);
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    // 床は厚みぶん沈めて「上面が y=0」になるように（家具や足が床上面に正しく載る）
    _p.set(s.x * TILE, s.model === 'floor' ? -FLOOR_T : 0, s.z * TILE);
    push(s.model, _m.compose(_p, _q, _s).clone());
    if (isWall && s.tall) {   // 広間側は2段積み（天井が高いぶんを塞ぐ）
      _p.set(s.x * TILE, WALL_H, s.z * TILE);
      push('wall', _m.compose(_p, _q, _s).clone());
    }
    // 床の真上に天井（広間=2段ぶん高く / 廊下=1段）
    if (s.model === 'floor') { _p.set(s.x * TILE, (s.ceil || 1) * WALL_H, s.z * TILE); push('ceiling', _m.compose(_p, _q, _s).clone()); }
  }
  const _s2 = new THREE.Vector3();
  const FURN_S = 1.4;   // 家具は建築(2.0)より小さめ＝人のスケールに合わせる
  for (const it of dg.items) {
    if (it.model === 'painting') { addPainting(it); continue; }   // 絵画は額縁＋テクスチャで個別生成
    let y = it.y || 0, sc = SCALE, sy = 1, ox = 0, oz = 0;
    if (it.furn || it.model === 'plant') { sc = FURN_S; }
    else if (it.model === 'rug') { y = 0.02; }                                   // 床とのZ-fight回避
    else if (it.model === 'chandelier') { y = (it.ceil || 2) * wallH - 0.05; sc = FURN_S; }
    else if (it.wainscot) {   // 腰板＝壁の下側だけの帯。壁からわずかに手前へ出す
      y = 0; sy = 0.42;
      ox = Math.sin(it.ry || 0) * 0.07; oz = Math.cos(it.ry || 0) * 0.07;
    }
    if (it.toCeil) sy = 2;
    _p.set(it.x * TILE + ox, y, it.z * TILE + oz);
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.ry || 0);
    _s2.set(sc, sc * sy, sc);
    push(it.model, _m.compose(_p, _q, _s2).clone());
  }

  parts.ceiling = parts.floor;   // 天井は床と同じ部材（バケットだけ分けて観察モードで隠せるように）
  for (const [kind, mats] of buckets) {
    const part = parts[kind]; if (!part || !mats.length) continue;
    for (const sub of collectMeshes(part.obj)) {
      const inst = new THREE.InstancedMesh(sub.geo, sub.mat, mats.length);
      const mm = new THREE.Matrix4();
      for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mm.multiplyMatrices(mats[i], sub.mat4));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      if (kind === 'ceiling' || kind === 'chandelier') inst.userData.overhead = true;   // 俯瞰時に隠す
      dungeonGroup.add(inst);
    }
  }

  // ゴール（金色の柱＋光）
  goalMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 1.6, roughness: 0.3 }));
  goalMesh.position.set(dg.goal.x * TILE, 1.6, dg.goal.z * TILE);
  scene.add(goalMesh);
  const gl = new THREE.PointLight(0xffcc55, 40, 22, 1.4);
  gl.position.copy(goalMesh.position); scene.add(gl);

  // ランタンの淡い光（数を絞る＝負荷対策）
  for (const it of dg.items.filter((i) => i.model === 'lantern').slice(0, 4)) {
    const l = new THREE.PointLight(0xffb060, 10, 10, 1.4);
    l.position.set(it.x * TILE, 2.2, it.z * TILE); scene.add(l); LIGHTS.lamps.push(l);
  }
  buildMoonlight();
  setStatus('');
}
let goalMesh = null, wallH = 2.0;

// 環境マップ(IBL)はマントの質感にだけ使う。scene.environment にすると建物にも効いて
// 陰影が浅く“のっぺり”するうえ、WebGPUのノードマテリアルでは envMapIntensity=0 でも切れない。
// → シーンには一切適用せず、マントのマテリアルにだけ envNode を挿す。
function applyCapeEnv() {
  if (!capeEnvNode || !vamp.cape || !vamp.cape.clothMesh) return;
  vamp.cape.clothMesh.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || m.envNode === capeEnvNode) continue;
      m.envNode = capeEnvNode; m.needsUpdate = true;
    }
  });
}

// ── 月明かり：屋外の夜空＋窓に光る面＋窓際に冷たい光だまり ──
function buildMoonlight() {
  // 屋外（窓の外が真っ暗にならないように）：夜空ドームと地面
  const sky = new THREE.Mesh(new THREE.SphereGeometry(220, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x0d1430, side: THREE.BackSide, fog: false }));
  sky.position.set(dg.w * TILE / 2, 0, dg.d * TILE / 2); scene.add(sky);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x121a26, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(dg.w * TILE / 2, -0.06, dg.d * TILE / 2); scene.add(ground);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 14), new THREE.MeshBasicMaterial({ color: 0xdde7ff, fog: false }));
  moon.position.set(dg.w * TILE / 2 - 150, 90, dg.d * TILE / 2 - 130); scene.add(moon);
  const moonDir = new THREE.DirectionalLight(0x9fb6ff, 0.55);
  moonDir.position.copy(moon.position); scene.add(moonDir);
  LIGHTS.moon = moonDir;

  // 窓の面を淡く光らせる（外から月光が差している見え）
  const winMat = new THREE.MeshStandardMaterial({ color: 0x9ec2ff, emissive: 0x7fa8ff, emissiveIntensity: 1.5, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const wins = dg.shell.filter((s) => s.model === 'window');
  for (const s of wins) {
    const horiz = Math.abs(Math.sin(s.ry || 0)) < 0.5;
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 0.55, wallH * 0.75), winMat);
    pane.position.set(s.x * TILE, wallH * 0.62, s.z * TILE);
    pane.rotation.y = horiz ? 0 : Math.PI / 2;
    scene.add(pane);
  }
  // 窓際の光だまり（数を絞る）
  for (let i = 0; i < wins.length; i += Math.max(1, Math.floor(wins.length / 4))) {
    const s = wins[i];
    const inX = Math.sign(dg.w / 2 - s.x), inZ = Math.sign(dg.d / 2 - s.z);
    const l = new THREE.PointLight(0x88aaff, 5.5, 9, 1.2);
    l.position.set((s.x + inX * 0.6) * TILE, 1.9, (s.z + inZ * 0.6) * TILE);
    scene.add(l); LIGHTS.lamps.push(l);
  }
}

// ── 絵画（額縁＋手続き生成テクスチャ）。後でエディタから差し替えられるよう paintings[] に控える ──
const paintings = [];
const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b4a1e, roughness: 0.55, metalness: 0.35 });
function addPainting(it) {
  const PW = 0.95, PH = 1.2, T = 0.07;   // 絵の幅/高さ/額の太さ
  const g = new THREE.Group();
  const canvasMat = new THREE.MeshStandardMaterial({ map: makePaintingTexture(THREE, { id: it.id, url: paintingUrl(it.id) }), roughness: 0.9 });
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), canvasMat));
  // 額縁：上下左右の4本＋奥の板
  const bar = (w, h, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, T * 1.6), frameMat); m.position.set(x, y, -T * 0.4); g.add(m); };
  bar(PW + T * 2, T, 0, PH / 2 + T / 2); bar(PW + T * 2, T, 0, -PH / 2 - T / 2);
  bar(T, PH + T * 2, -PW / 2 - T / 2, 0); bar(T, PH + T * 2, PW / 2 + T / 2, 0);
  g.position.set(it.x * TILE + (it.nx || 0) * 0.09, it.y || 1.7, it.z * TILE + (it.nz || 0) * 0.09);
  g.rotation.y = it.ry || 0;
  scene.add(g);
  paintings.push({ id: it.id, group: g, mat: canvasMat });
}
// 差し替え用URL（vamp_param/paintings.json があればそれを使う。無ければ手続き生成）
let paintingCfg = null;
function paintingUrl(id) { return paintingCfg?.[String(id)] || null; }
async function loadPaintingCfg() {
  for (const u of ['./paintings.json', '../vamp_param/paintings.json']) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j) { paintingCfg = j.paintings || j; return; } } catch { /* next */ }
  }
}

// ── 壁の当たり判定（セルではなくエッジ＝薄い板として持つ。扉は通れる） ──
const wallSegs = [];              // {minX,maxX,minZ,maxZ}
const segsByCell = new Map();     // 'cx,cz' -> [seg]
function buildWallColliders() {
  wallSegs.length = 0; segsByCell.clear();
  for (const s of dg.shell) {
    if (!s.wall || s.model === 'doorway') continue;   // 扉は通行可（窓・壁は塞ぐ）
    const horiz = Math.abs(Math.sin(s.ry || 0)) < 0.5;   // ry 0/π → X方向に伸びる壁
    const cx = s.x * TILE, cz = s.z * TILE;
    const hx = horiz ? TILE / 2 : WALL_T, hz = horiz ? WALL_T : TILE / 2;
    const seg = { minX: cx - hx, maxX: cx + hx, minZ: cz - hz, maxZ: cz + hz };
    wallSegs.push(seg);
    // 壁が触れる両側のセルに登録
    for (const [ox, oz] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
      const k = Math.round(s.x + ox) + ',' + Math.round(s.z + oz);
      if (!segsByCell.has(k)) segsByCell.set(k, []);
      const arr = segsByCell.get(k); if (!arr.includes(seg)) arr.push(seg);
    }
  }
}

// ── プレイヤー（一人称・徒歩）──
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, onFloor: false };
const keys = {};
let isLocked = false, touchMode = false, phase = 'load', nightT = 0, won = false, drain = 0;

function resetPlayer() {
  player.pos.set(dg.spawn.x * TILE, EYE_H, dg.spawn.z * TILE);
  player.vel.set(0, 0, 0); player.yaw = 0; player.pitch = 0;
}

// グリッド当たり：足元セル周辺の岩盤を AABB として円(半径BODY_R)を押し出す
function cellSolid(cx, cz) {
  if (cx < 0 || cz < 0 || cx >= dg.w || cz >= dg.d) return true;
  return dg.grid[cz * dg.w + cx] === SOLID;
}
// 円(半径BODY_R)を AABB から押し出す
function pushOutAABB(minX, maxX, minZ, maxZ) {
  const qx = Math.max(minX, Math.min(player.pos.x, maxX));
  const qz = Math.max(minZ, Math.min(player.pos.z, maxZ));
  const ddx = player.pos.x - qx, ddz = player.pos.z - qz;
  const d2 = ddx * ddx + ddz * ddz;
  if (d2 >= BODY_R * BODY_R) return;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2), push = BODY_R - d;
    player.pos.x += (ddx / d) * push; player.pos.z += (ddz / d) * push;
  } else {   // 完全にめり込んだ：一番浅い面へ逃がす
    const cand = [[minX - BODY_R - player.pos.x, 0], [maxX + BODY_R - player.pos.x, 0], [0, minZ - BODY_R - player.pos.z], [0, maxZ + BODY_R - player.pos.z]];
    cand.sort((a, b) => (Math.abs(a[0]) + Math.abs(a[1])) - (Math.abs(b[0]) + Math.abs(b[1])));
    player.pos.x += cand[0][0]; player.pos.z += cand[0][1];
  }
}
function collideWalls() {
  const cx = Math.round(player.pos.x / TILE), cz = Math.round(player.pos.z / TILE);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const gx = cx + dx, gz = cz + dz;
    if (cellSolid(gx, gz)) pushOutAABB(gx * TILE - TILE / 2, gx * TILE + TILE / 2, gz * TILE - TILE / 2, gz * TILE + TILE / 2);
    const segs = segsByCell.get(gx + ',' + gz);   // 部屋の囲い壁など、セル境界に立つ薄い壁
    if (segs) for (const s of segs) pushOutAABB(s.minX, s.maxX, s.minZ, s.maxZ);
  }
}

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _mv = new THREE.Vector3();
// 吸血されている最中か（プレイヤーの拘束に使う）
function isCaptured() { return vamp.ready && vamp.state === 'capture' && phase === 'playing'; }
function syncCamera() {
  camera.position.copy(player.pos);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
}
// 捕縛中の演出：松明を落として顔の白飛びを防ぎ、視点を彼女の顔へ吸い寄せる
const _lookAt = new THREE.Vector3();
function updateCaptureView(dt) {
  const captured = vamp.ready && vamp.state === 'capture' && phase === 'playing';
  torch.intensity += ((captured ? 0.35 : 6.5) - torch.intensity) * Math.min(1, dt * 5);
  if (!captured || !vamp.head) return;
  vamp.head.getWorldPosition(_lookAt);
  const dx = _lookAt.x - player.pos.x, dy = _lookAt.y - player.pos.y, dz = _lookAt.z - player.pos.z;
  const wantYaw = Math.atan2(-dx, -dz);
  const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
  let d = wantYaw - player.yaw;
  while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
  const k = Math.min(1, dt * 4);
  player.yaw += d * k;
  player.pitch += (wantPitch - player.pitch) * k;
}
function updatePlayer(dt) {
  if (!isLocked && !touchMode) { syncCamera(); return; }
  _fwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  _right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  // 捕縛中は掴まれて振りほどけない＝移動が鈍る
  const capMul = isCaptured() ? VAMP.capSpeedMul : 1;
  const speedDelta = dt * (player.onFloor ? PLAYER_SPEED : PLAYER_SPEED * 0.35) * capMul;
  _mv.set(0, 0, 0);
  if (keys['KeyW'] || keys['ArrowUp']) _mv.add(_fwd);
  if (keys['KeyS'] || keys['ArrowDown']) _mv.sub(_fwd);
  if (keys['KeyD'] || keys['ArrowRight']) _mv.add(_right);
  if (keys['KeyA'] || keys['ArrowLeft']) _mv.sub(_right);
  if (touchMode) { _mv.addScaledVector(_fwd, -joy.y); _mv.addScaledVector(_right, joy.x); }
  if (_mv.lengthSq() > 1e-6) player.vel.addScaledVector(_mv.normalize(), speedDelta);

  let damping = Math.exp(-9 * dt) - 1;
  if (!player.onFloor) { player.vel.y -= GRAVITY * dt; damping *= 0.12; }
  player.vel.addScaledVector(player.vel, damping);

  player.pos.addScaledVector(player.vel, dt);
  collideWalls();
  // 床（単層なので y=EYE_H が接地）
  if (player.pos.y <= EYE_H) { player.pos.y = EYE_H; player.vel.y = 0; player.onFloor = true; }
  else player.onFloor = false;

  syncCamera();
}

// ── 入力（PC） ──
const canvas = renderer.domElement;
canvas.addEventListener('click', () => { if (!touchMode && phase === 'playing') canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => { isLocked = document.pointerLockElement === canvas; });
addEventListener('mousedown', (e) => { if (e.button === 0 && isLocked && phase === 'playing') fireShot(); });
document.addEventListener('mousemove', (e) => {
  if (!isLocked) return;
  player.yaw -= e.movementX * 0.0024;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - e.movementY * 0.0024));
});
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space' && player.onFloor && phase === 'playing' && !(VAMP.capNoJump && isCaptured())) { player.vel.y = JUMP_V; player.onFloor = false; }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

// ── 入力（タッチ：左=仮想スティック / 右半分=視点。Pointer Events + setPointerCapture） ──
const joy = { x: 0, y: 0 };
function setupTouch() {
  const IS_TOUCH = matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window;
  if (!IS_TOUCH) return;
  touchMode = true; isLocked = true;
  $('touch-ui').style.display = 'block';
  canvas.style.touchAction = 'none';
  const base = $('joystick-base'), stick = $('joystick-stick');
  const R = 55;
  let joyId = -1, lookId = -1, lastX = 0, lastY = 0;
  const placeBase = (x, y) => { base.style.left = (x - 70) + 'px'; base.style.top = (y - 70) + 'px'; };
  placeBase(110, innerHeight - 120);
  base.addEventListener('pointerdown', (e) => { joyId = e.pointerId; base.setPointerCapture(e.pointerId); e.preventDefault(); });
  base.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    const r = base.getBoundingClientRect();
    let dx = e.clientX - (r.left + 70), dy = e.clientY - (r.top + 70);
    const len = Math.hypot(dx, dy) || 1;
    if (len > R) { dx = dx / len * R; dy = dy / len * R; }
    stick.style.left = (41 + dx) + 'px'; stick.style.top = (41 + dy) + 'px';
    joy.x = dx / R; joy.y = dy / R;
    if (Math.hypot(joy.x, joy.y) < 0.28) { joy.x = 0; joy.y = 0; }   // デッドゾーン
  });
  const joyEnd = (e) => { if (e.pointerId !== joyId) return; joyId = -1; joy.x = joy.y = 0; stick.style.left = '41px'; stick.style.top = '41px'; };
  base.addEventListener('pointerup', joyEnd); base.addEventListener('pointercancel', joyEnd);
  canvas.addEventListener('pointerdown', (e) => { if (lookId < 0) { lookId = e.pointerId; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    player.yaw -= (e.clientX - lastX) * 0.0045;
    player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch - (e.clientY - lastY) * 0.0045));
    lastX = e.clientX; lastY = e.clientY;
  });
  const lookEnd = (e) => { if (e.pointerId === lookId) lookId = -1; };
  canvas.addEventListener('pointerup', lookEnd); canvas.addEventListener('pointercancel', lookEnd);
  $('jump-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (player.onFloor && !(VAMP.capNoJump && isCaptured())) { player.vel.y = JUMP_V; player.onFloor = false; } });
}

// ══════════ JOY_Vamp（徘徊 → 追跡 → 捕縛。テレポートせず歩く） ══════════
const VAMP = {
  walkSpeedMax: 2.2,       // フットロックの安全上限(m/s)
  animSpeed: 1.35,         // 歩きアニメを速める＝フットロックの前進量も増える
  sightRange: 22,          // 視線が通ればこの距離で発見
  hearRange: 5.5,          // 壁越しでも足音で気づく距離
  catchRange: 1.25,        // この距離で捕縛（吸血）開始
  drainPerSec: 8,          // 捕縛中の体力減少（%/秒）＝約12.5秒耐えられる
  capSpeedMul: 0.35,       // 捕縛中のプレイヤー移動倍率（半分以下）
  capNoJump: true,         // 捕縛中はジャンプ不可
  stunSec: 3.2,            // ショット命中で止まる時間
  repathSec: 0.6,
};
const kissAudio = { el: null, playing: false };
function initKissAudio() {
  const name = (ENEMY_CFG.kiss && ENEMY_CFG.kiss.sfx) || 'fat02.ogg';   // エディタで指定した効果音
  const a = new Audio(); a.loop = true; a.volume = (ENEMY_CFG.kiss && ENEMY_CFG.kiss.vol) ?? 0.95;
  a.src = '../audio/' + name;
  a.addEventListener('error', () => { if (!a.src.endsWith('./audio/' + name)) a.src = './audio/' + name; }, { once: true });
  kissAudio.el = a;
}
function playKiss() { if (kissAudio.el && !kissAudio.playing) { kissAudio.playing = true; kissAudio.el.play().catch(() => {}); } }
function stopKiss() { if (kissAudio.el && kissAudio.playing) { try { kissAudio.el.pause(); kissAudio.el.currentTime = 0; } catch {} } kissAudio.playing = false; }

const vamp = {
  vrm: null, mixer: null, action: null, clips: {}, cape: null, root: null,
  state: 'patrol', path: null, seg: 0, repathT: 0, stunT: 0, ready: false,
  hips: null, head: null, footL: null, footR: null,
};
const bodyFwd = new THREE.Vector3(0, 0, 1);   // モデル前方（npcRoot相対・ry補正込み）
const headFace = new THREE.Vector3(0, 0, 1);
let nav = null;

function dataURIToBlob(uri) { const [head, data] = uri.split(','); const bin = atob(data); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream' }); }
async function fetchFirst(urls, asJson) {
  for (const u of urls) { try { const r = await fetch(u); if (!r.ok) continue; return asJson ? JSON.parse(await r.text()) : await r.arrayBuffer(); } catch { /* next */ } }
  return null;
}

async function loadVamp() {
  setStatus('JOY_vamp 読み込み中…');
  const bundle = await fetchFirst(['./JOY_vamp.npc.json', '../npc/JOY_vamp.npc.json'], true);
  if (!bundle) { console.warn('JOY_vamp.npc.json が読めません'); return; }
  const gl = new GLTFLoader();
  gl.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
  const gltf = await gl.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.combineSkeletons(gltf.scene);
  vamp.vrm = vrm;
  vamp.root = new THREE.Group(); vamp.root.add(vrm.scene); scene.add(vamp.root);
  const hb = vrm.humanoid;
  vamp.hips = hb?.getNormalizedBoneNode('hips') ?? null;
  vamp.head = hb?.getNormalizedBoneNode('head') ?? null;
  vamp.footL = hb?.getNormalizedBoneNode('leftFoot') ?? null;
  vamp.footR = hb?.getNormalizedBoneNode('rightFoot') ?? null;
  // 腕IK用チェーン（生ボーン＝メッシュが追従する実スケルトン）
  const raw = (n) => vrm.humanoid?.getRawBoneNode(n) ?? null;
  vamp.armL = { root: raw('leftUpperArm'), mid: raw('leftLowerArm'), end: raw('leftHand') };
  vamp.armR = { root: raw('rightUpperArm'), mid: raw('rightLowerArm'), end: raw('rightHand') };
  if (vamp.hips) hipsRest.copy(vamp.hips.position);
  vrm.update(0); vrm.scene.updateMatrixWorld(true);
  // 前方の確定：頭ボーンの+Z を editorTransform.ry で補正（JOY_vamp はメッシュが180°回っている）
  if (vamp.head) {
    const q = new THREE.Quaternion(), f = new THREE.Vector3();
    vamp.head.getWorldQuaternion(q); f.set(0, 0, 1).applyQuaternion(q); f.y = 0;
    if (f.lengthSq() > 1e-6) {
      f.normalize(); vrm.scene.getWorldQuaternion(q); bodyFwd.copy(f).applyQuaternion(q.invert());
      const ry = ((bundle.cloth?.editorTransform?.ry) || 0) * Math.PI / 180;
      if (ry) bodyFwd.applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
      bodyFwd.y = 0; bodyFwd.normalize();
      headFace.set(0, 0, 1); if (ry) headFace.applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    }
  }
  // 歩きアニメ（timeline に埋まった vrma を使う。マント掴みトラックも含む）
  vamp.mixer = new THREE.AnimationMixer(vrm.scene);
  const loadClip = async (tlName) => {
    const t = await fetchFirst(['./timeline/' + tlName, '../timeline/' + tlName], true);
    const buf = await fetchFirst(['./vrma/' + (t?.vrma || ''), '../vrma/' + (t?.vrma || '')], false);
    if (!buf) return null;
    const al = new GLTFLoader(); al.register((pl) => new VRMAnimationLoaderPlugin(pl));
    const ag = await al.loadAsync(URL.createObjectURL(new Blob([buf])));
    const anims = ag.userData.vrmAnimations;
    return anims?.length ? { action: vamp.mixer.clipAction(createVRMAnimationClip(anims[0], vrm)), tl: t } : null;
  };
  // アニメはエネミーエディタの設定（vamp-enemy.json の states.<st>.anim）から読む。
  // 設定が無い場合だけ既定へフォールバック。
  const DEF_ANIM = { approach_walk: 'eri_model_walk.timeline.json', kiss: 'eri_Fly_idle.timeline.json', repelled: 'eri_model_walk.timeline.json' };
  for (const st of ['approach_walk', 'kiss', 'repelled']) {
    const name = (ENEMY_CFG[st] && ENEMY_CFG[st].anim) || DEF_ANIM[st];
    if (!name || vamp.clips[name]) continue;
    const c = await loadClip(name);
    if (c) vamp.clips[name] = c; else console.warn('アニメ読込失敗:', st, name);
  }
  const walkName = animNameFor('patrol');
  const first = vamp.clips[walkName] || Object.values(vamp.clips)[0];
  const tl = first?.tl || null;
  if (first) { vamp.action = first.action; vamp.action.timeScale = VAMP.animSpeed; vamp.action.play(); vampAnimName = walkName; }
  // 先に配置してからマントを作る（原点で作って後から移動させると布が引き伸ばされて破裂する）
  placeVampAt(pickFarCell(dg.spawn));
  vamp.vrm.scene.updateMatrixWorld(true);
  // cloth-npc の保存設定をマントのマテリアルへ反映（GPU布は生成時に cloth.material を読む）
  CAPE_PARAM = await loadCapeParams('JOY_vamp');
  if (CAPE_PARAM && bundle.cloth) {
    bundle.cloth.material = { ...(bundle.cloth.material || {}), ...CAPE_PARAM.material };
  }
  try { if (bundle.cloth) vamp.cape = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, timeline: tl, basePos: vamp.root.position, floorY: 0 }); }
  catch (e) { console.warn('マント生成をスキップ:', e.message); }
  await loadCharLight();
  // 環境光(env)はシーン全体ではなくマントへ。全体に掛けると暗い屋敷が白飛びするため。
  await hdrReady; applyCapeEnv();
  if (vamp.cape && CAPE_PARAM && CAPE_PARAM.env != null) {
    try { vamp.cape.setMaterial({ envMapIntensity: CAPE_PARAM.env }); } catch { /* noop */ }
  }
  attachCharFill();   // キャラ補助光（前上のキー光＋背後のリム光）＝ar-vampire と同じ見え方に
  vamp.ready = true;
  setStatus('');
}
const hipsRest = new THREE.Vector3();

// ── キャラ補助光（ar-vampire / CityFly と同じ2灯。彼女に追従し、周囲は照らさない距離減衰つき）──
const charFill = { key: null, rim: null };
let charLightCfg = { dirI: 1.9, ambI: 0.85, dirC: '#cfd8ff', ambC: '#b8c4dd' };
async function loadCharLight() {
  for (const u of ['./char-light.json', '../npc/char-light.json']) {
    try { charLightCfg = { ...charLightCfg, ...JSON.parse(await (await fetch(u)).text()) }; break; } catch { /* next */ }
  }
}
function attachCharFill() {
  const f = bodyFwd;
  charFill.key = new THREE.PointLight(charLightCfg.dirC, charLightCfg.dirI, 7, 1.2);
  charFill.key.position.set(f.x * 0.6 + 0.18, 1.58, f.z * 0.6); vamp.root.add(charFill.key);
  charFill.rim = new THREE.PointLight(charLightCfg.ambC, charLightCfg.ambI, 6, 1.2);
  charFill.rim.position.set(-f.x * 0.8, 1.4, -f.z * 0.8); vamp.root.add(charFill.rim);
}

function pickFarCell(from) {   // プレイヤーから遠い歩けるセル
  let best = null, bd = -1;
  for (const r of dg.rooms) { const d = Math.hypot(r.cx - from.x, r.cz - from.z); if (d > bd) { bd = d; best = { x: r.cx, z: r.cz }; } }
  return best || { x: dg.goal.x, z: dg.goal.z };
}
function placeVampAt(cell) { vamp.root.position.set(cell.x * TILE, 0, cell.z * TILE); }

// ── フットロック接地：その場歩きアニメの「最も後ろへ動いた足」の分だけ体を前へ ──
let flL = 0, flR = 0, flInit = false;
const _bq = new THREE.Quaternion(), _fw = new THREE.Vector3(), _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3();
function footFwd(node) {
  node.getWorldPosition(_tmp); vamp.hips.getWorldPosition(_tmp2); _tmp.sub(_tmp2);
  vamp.root.getWorldQuaternion(_bq); _fw.copy(bodyFwd).applyQuaternion(_bq); _fw.y = 0; _fw.normalize();
  return _tmp.x * _fw.x + _tmp.z * _fw.z;
}
function footLockMove(dt) {
  if (!vamp.footL || !vamp.footR || !vamp.hips) return 0;
  const a = footFwd(vamp.footL), b = footFwd(vamp.footR);
  if (!flInit) { flL = a; flR = b; flInit = true; return 0; }
  const dA = a - flL, dB = b - flR; flL = a; flR = b;
  let move = Math.max(0, Math.min(VAMP.walkSpeedMax * dt, -Math.min(dA, dB)));
  if (move <= 0) return 0;
  vamp.root.getWorldQuaternion(_bq); _fw.copy(bodyFwd).applyQuaternion(_bq); _fw.y = 0;
  if (_fw.lengthSq() < 1e-6) return 0;
  _fw.normalize();
  // 壁に当たったら軸ごとに滑る（角に正面衝突しても止まらない）
  const px = vamp.root.position.x, pz = vamp.root.position.z;
  const nx = px + _fw.x * move, nz = pz + _fw.z * move;
  if (vampFree(nx, nz)) { vamp.root.position.x = nx; vamp.root.position.z = nz; return move; }
  if (vampFree(nx, pz)) { vamp.root.position.x = nx; return Math.abs(_fw.x * move); }
  if (vampFree(px, nz)) { vamp.root.position.z = nz; return Math.abs(_fw.z * move); }
  return 0;
}
function vampFree(wx, wz) {
  const cx = Math.round(wx / TILE), cz = Math.round(wz / TILE);
  if (cellSolid(cx, cz)) return false;
  const segs = segsByCell.get(cx + ',' + cz);
  if (segs) for (const s of segs) {
    const qx = Math.max(s.minX, Math.min(wx, s.maxX)), qz = Math.max(s.minZ, Math.min(wz, s.maxZ));
    if ((wx - qx) * (wx - qx) + (wz - qz) * (wz - qz) < 0.36) return false;   // 半径0.6m
  }
  return true;
}
function faceTowards(wx, wz, dt, k) {
  const dx = wx - vamp.root.position.x, dz = wz - vamp.root.position.z;
  if (dx * dx + dz * dz < 1e-6) return;
  const want = Math.atan2(dx, dz);
  let d = want - Math.atan2(bodyFwd.x, bodyFwd.z) - vamp.root.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
  vamp.root.rotation.y += d * Math.min(1, dt * k);
}

// ── 状態機械 ──
function vampCell() { return { x: Math.round(vamp.root.position.x / TILE), z: Math.round(vamp.root.position.z / TILE) }; }
function playerCell() { return { x: Math.round(player.pos.x / TILE), z: Math.round(player.pos.z / TILE) }; }
function repath(to) {
  const from = vampCell();
  const p = findPath(nav, from, to);
  vamp.path = (p && p.length > 1) ? p : null; vamp.seg = 1;
}
function canSeePlayer() {
  const a = vampCell(), b = playerCell();
  const dist = Math.hypot(player.pos.x - vamp.root.position.x, player.pos.z - vamp.root.position.z);
  if (dist < VAMP.hearRange) return true;                       // 近ければ壁越しでも気配で分かる
  if (dist > VAMP.sightRange) return false;
  return hasLineOfSight(nav, a.x, a.z, b.x, b.z);
}
function updateVamp(dt) {
  if (!vamp.ready || phase !== 'playing') return;
  const distToPlayer = Math.hypot(player.pos.x - vamp.root.position.x, player.pos.z - vamp.root.position.z);

  if (vamp.stunT > 0) {   // ショットで硬直（倒せはしない）
    if (vamp.holding) releaseHeldKen();   // 撃たれたら職員を取り落とす
    vamp.stunT -= dt;
    if (vamp.action) vamp.action.paused = true;
    if (vamp.stunT <= 0) { vamp.state = 'chase'; vamp.repathT = 0; if (vamp.action) vamp.action.paused = false; }
    return;
  }
  if (vamp.state === 'holdKen') {   // 職員を持ち上げて吸っている
    const held = vamp.holding;
    if (!held || held.state !== 'grabbed') { vamp.holding = null; vamp.state = 'patrol'; return; }
    held.hp -= KEN.drainPerSec * dt;
    if (held.hp <= 0) { held.state = 'downed'; held.downT = 0; vamp.holding = null; vamp.state = 'patrol'; vamp.path = null; }
    return;
  }
  if (vamp.action) vamp.action.paused = false;

  if (vamp.state === 'capture') {
    setVampAnimForState('capture');
    faceTowards(player.pos.x, player.pos.z, dt, 8);
    kissApproach(dt);          // 口をプレイヤーの顔へ密着（ar-vampire の bite-editor 方式）
    playKiss();
    drain += VAMP.drainPerSec * dt;
    if (distToPlayer > VAMP.catchRange * 2.0) { vamp.state = 'chase'; stopKiss(); }
    if (drain >= 100) { stopKiss(); lose(); }
    return;
  }
  stopKiss(); setVampAnimForState(vamp.state); relaxVampY(dt);

  const sees = canSeePlayer();
  // 職員（ken）も獲物：視界内で最も近い者を狙う
  let prey = null, preyDist = Infinity;
  const vc = vampCell();
  for (const m of kens) {
    if (!kenAlive(m)) continue;
    const d = Math.hypot(m.vrm.scene.position.x - vamp.root.position.x, m.vrm.scene.position.z - vamp.root.position.z);
    if (d > VAMP.sightRange) continue;
    const kc = kenCell(m);
    if (d > VAMP.hearRange && !hasLineOfSight(nav, vc.x, vc.z, kc.x, kc.z)) continue;
    if (d < preyDist) { prey = m; preyDist = d; }
  }
  const huntKen = prey && (!sees || preyDist < distToPlayer);
  vamp.quarry = huntKen ? prey : null;

  const seesAny = sees || !!prey;
  if (seesAny && vamp.state !== 'chase') { vamp.state = 'chase'; vamp.repathT = 0; }
  if (!seesAny && vamp.state === 'chase' && distToPlayer > VAMP.sightRange * 1.3) { vamp.state = 'patrol'; vamp.path = null; if (vampSpeech) vampSpeech.bark('lost'); }

  if (huntKen && preyDist < VAMP.catchRange) { startHoldKen(prey); return; }
  if (!huntKen && distToPlayer < VAMP.catchRange) { vamp.state = 'capture'; return; }

  // 目的地の再計算
  vamp.repathT -= dt;
  if (vamp.repathT <= 0 || !vamp.path) {
    vamp.repathT = VAMP.repathSec;
    repath(vamp.state === 'chase' ? (vamp.quarry ? kenCell(vamp.quarry) : playerCell()) : (vamp.patrolTo || (vamp.patrolTo = pickPatrol())));
    if (vamp.state === 'patrol' && !vamp.path) { vamp.patrolTo = pickPatrol(); }
  }
  // 経路追従：次のウェイポイントを向いて、フットロックで前進
  if (vamp.path && vamp.seg < vamp.path.length) {
    const wp = vamp.path[vamp.seg];
    const wx = wp.x * TILE, wz = wp.z * TILE;
    faceTowards(wx, wz, dt, 7);
    // 進行方向とモデル前方のズレが小さいときだけ前進（斜めに壁へ擦らない）
    vamp.root.getWorldQuaternion(_bq); _fw.copy(bodyFwd).applyQuaternion(_bq); _fw.y = 0; _fw.normalize();
    const tx = wx - vamp.root.position.x, tz = wz - vamp.root.position.z;
    const tl2 = Math.hypot(tx, tz) || 1;
    if ((_fw.x * tx + _fw.z * tz) / tl2 > 0.55) footLockMove(dt);
    if (Math.hypot(wx - vamp.root.position.x, wz - vamp.root.position.z) < TILE * 0.45) vamp.seg++;
  } else if (vamp.state === 'chase') {
    // 経路が尽きた（同セル内など）：獲物へ直接詰める。壁際で立ち尽くさない。
    const tp = vamp.quarry ? vamp.quarry.vrm.scene.position : player;
    const tx2 = (vamp.quarry ? tp.x : player.pos.x), tz2 = (vamp.quarry ? tp.z : player.pos.z);
    faceTowards(tx2, tz2, dt, 7);
    vamp.root.getWorldQuaternion(_bq); _fw.copy(bodyFwd).applyQuaternion(_bq); _fw.y = 0; _fw.normalize();
    const ddx = tx2 - vamp.root.position.x, ddz = tz2 - vamp.root.position.z;
    const dl = Math.hypot(ddx, ddz) || 1;
    if ((_fw.x * ddx + _fw.z * ddz) / dl > 0.4) footLockMove(dt);
  } else if (vamp.state === 'patrol') {
    vamp.patrolTo = pickPatrol(); vamp.repathT = 0;
  }
}
// 歩き⇄キスのクロスフェード
let vampAnimName = '';
/** ステートに対応するアニメ名（エディタ設定を優先） */
function animNameFor(state) {
  const st = EXPR_MAP[state] || state;
  const DEF = { approach_walk: 'eri_model_walk.timeline.json', kiss: 'eri_Fly_idle.timeline.json', repelled: 'eri_model_walk.timeline.json' };
  return (ENEMY_CFG[st] && ENEMY_CFG[st].anim) || DEF[st] || DEF.approach_walk;
}
/** ステートのアニメへクロスフェード。エディタで指定したクリップを再生する。 */
function setVampAnimForState(state) {
  const name = animNameFor(state);
  if (!name || name === vampAnimName) return;
  const rec = vamp.clips[name];
  if (!rec) return;                       // 未ロード（読込失敗）なら現状維持
  const from = vamp.clips[vampAnimName]?.action;
  const to = rec.action;
  to.reset(); to.timeScale = (state === 'capture') ? 1 : VAMP.animSpeed; to.play();
  if (from && from !== to) from.crossFadeTo(to, 0.25, false);
  vamp.action = to; vampAnimName = name;
  if (vamp.cape && rec.tl) { try { vamp.cape.setTimeline(rec.tl); } catch { /* noop */ } }   // マント掴みも切り替え
  flInit = false;
}
// 口(頭+顔前方*fwd)をプレイヤーの目へ寄せる。一人称なので彼女の顔が視界いっぱいに来る。
const KISS = { fwd: 0.115, up: -0.03, gap: 0.07, lean: 0.45, minDist: 0.12 };   // minDist=カメラが顔の内部へ入らない下限
// キス時、腕IKでプレイヤーの両肩（グラブポイント）を押さえる
const GRAB = { enabled: true, side: 0.17, down: 0.14, fwd: 0.03 };
// ar-vampire のエネミー設定（アニメ・効果音・表情）を共有して読む＝エディタの設定がそのまま効く
const ENEMY_CFG = {};   // ar-vampire のステート名 -> { anim, sfx, sfxMode, vol, expr }
async function loadEnemyCfg() {
  for (const u of ['./vamp-enemy.json', '../vamp_param/vamp-enemy.json']) {
    try {
      const j = JSON.parse(await (await fetch(u)).text());
      if (j && j.states) { Object.assign(ENEMY_CFG, j.states); return true; }
    } catch { /* next */ }
  }
  return false;
}
// このゲームのステート名 → ar-vampire のステート名（エディタ側の呼び名に合わせる）
const EXPR_MAP = { patrol: 'approach_walk', chase: 'approach_walk', capture: 'kiss', stunned: 'repelled' };
const cfgOf = (state) => ENEMY_CFG[EXPR_MAP[state] || state] || {};
let exprT = 0, exprManaged = [], exprPrevState = '';
function updateVampExpr(dt) {
  if (!vamp.vrm) return;
  if (vamp.state !== exprPrevState) { exprPrevState = vamp.state; exprT = 0; }
  exprT += dt;
  const tr = cfgOf(vamp.state).expr;
  if (!tr || !(tr.keys || []).length) {
    if (exprManaged.length) { applyExpr(vamp.vrm, {}, exprManaged); exprManaged = []; }
    return;
  }
  const w = sampleExpr(tr, exprT);
  exprManaged = [...new Set([...exprManaged, ...Object.keys(w)])];
  applyExpr(vamp.vrm, w, exprManaged);
}

// cloth-npc で保存したマント設定（粗さ/光沢/透明/厚み/表裏同色）
let CAPE_PARAM = null;
async function loadCapeParams(npcName) {
  for (const u of ['./cape-' + npcName + '.json', '../vamp_param/cape-' + npcName + '.json']) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j && j.material) return j; } catch { /* next */ }
  }
  return null;
}

async function loadTune() {   // ar-vampire と同じ vamp_param を共有
  for (const u of ['./vamp-tune.json', '../vamp_param/vamp-tune.json']) {
    try { const t = JSON.parse(await (await fetch(u)).text());
      if (t) { if (t.kiss) Object.assign(KISS, t.kiss); if (t.grab) Object.assign(GRAB, t.grab);
               if (t.vamp) Object.assign(VAMP, t.vamp);   // 難易度（吸血速度・拘束・硬直など）
               return true; } } catch { /* next */ }
  }
  return false;
}
const _mouth = new THREE.Vector3(), _ktar = new THREE.Vector3(), _hp2 = new THREE.Vector3(), _dh2 = new THREE.Vector3();
function kissApproach(dt) {
  if (!vamp.head) return;
  vamp.head.getWorldPosition(_hp2); vamp.head.getWorldQuaternion(_bq);
  _mouth.copy(headFace).multiplyScalar(KISS.fwd); _mouth.y += KISS.up; _mouth.applyQuaternion(_bq).add(_hp2);
  _dh2.set(_hp2.x - player.pos.x, 0, _hp2.z - player.pos.z);
  if (_dh2.lengthSq() > 1e-6) _dh2.normalize();
  _ktar.set(player.pos.x + _dh2.x * KISS.gap, player.pos.y, player.pos.z + _dh2.z * KISS.gap);
  // 目標が近すぎるとカメラが頭のメッシュ内部に入って“中が見える”。下限距離まで押し戻す。
  const minD = KISS.minDist ?? 0.12;
  const dLen = Math.hypot(_ktar.x - player.pos.x, _ktar.y - player.pos.y, _ktar.z - player.pos.z);
  if (dLen < minD) {
    const sc = dLen > 1e-5 ? minD / dLen : 0;
    if (sc) { _ktar.set(player.pos.x + (_ktar.x - player.pos.x) * sc, player.pos.y + (_ktar.y - player.pos.y) * sc, player.pos.z + (_ktar.z - player.pos.z) * sc); }
    else { _ktar.set(player.pos.x + _dh2.x * minD, player.pos.y, player.pos.z + _dh2.z * minD); }
  }
  const k = Math.min(1, dt * 6);
  const nx = vamp.root.position.x + (_ktar.x - _mouth.x) * k, nz = vamp.root.position.z + (_ktar.z - _mouth.z) * k;
  if (vampFree(nx, nz)) { vamp.root.position.x = nx; vamp.root.position.z = nz; }
  // 縦寄せ（ar-vampire と同じ lean）。これが無いと彼女が見上げる形になり、AR版と見え方が変わる。
  vamp.root.position.y += (_ktar.y - _mouth.y) * KISS.lean * k;
  vamp.root.position.y = Math.max(-0.15, Math.min(0.9, vamp.root.position.y));   // 床から極端に浮き沈みしない
}
// 捕縛が解けたら足元を床へ戻す
function relaxVampY(dt) {
  if (Math.abs(vamp.root.position.y) < 1e-4) return;
  vamp.root.position.y += (0 - vamp.root.position.y) * Math.min(1, dt * 4);
  if (Math.abs(vamp.root.position.y) < 1e-3) vamp.root.position.y = 0;
}
// 首をプレイヤーへ向ける（ar-vampire の applyHeadLook 方式・角度制限つき）
const _hq = new THREE.Quaternion(), _hqD = new THREE.Quaternion(), _hqP = new THREE.Quaternion(), _hf = new THREE.Vector3(), _hd = new THREE.Vector3();
function headLook(w) {
  if (!vamp.head || w <= 0) return;
  vamp.head.getWorldPosition(_hp2);
  const tgt = (vamp.state === 'holdKen' && vamp.holding) ? _kpin : player.pos;   // 獲物を吸っている間はそちらを見る
  _hd.set(tgt.x - _hp2.x, tgt.y - _hp2.y, tgt.z - _hp2.z);
  if (_hd.lengthSq() < 1e-8) return;
  _hd.normalize();
  vamp.head.getWorldQuaternion(_hq);
  _hf.copy(headFace).applyQuaternion(_hq).normalize();
  const ang = _hf.angleTo(_hd); if (ang < 1e-4) return;
  let ww = w; const MAX = Math.PI * 0.55; if (ang > MAX) ww *= MAX / ang;
  _hqD.setFromUnitVectors(_hf, _hd);
  const des = new THREE.Quaternion().identity().slerp(_hqD, ww).multiply(_hq);
  vamp.head.parent.getWorldQuaternion(_hqP);
  vamp.head.quaternion.copy(_hqP.invert().multiply(des)).normalize();
}

// ── 腕IK：プレイヤーの両肩(グラブポイント)へ手を伸ばして押さえる（ar-vampire と同じ）──
const _gpL = new THREE.Vector3(), _gpR = new THREE.Vector3(), _perp = new THREE.Vector3(), _dirH = new THREE.Vector3();
const _yUp = new THREE.Vector3(0, 1, 0);
function computeGrabTargets(outL, outR) {
  _dirH.set(player.pos.x - vamp.root.position.x, 0, player.pos.z - vamp.root.position.z);
  if (_dirH.lengthSq() > 1e-6) _dirH.normalize(); else _dirH.set(0, 0, 1);
  _perp.copy(_dirH).cross(_yUp).normalize();
  outL.copy(player.pos); outL.y -= GRAB.down; outL.addScaledVector(_dirH, -GRAB.fwd);
  outR.copy(outL);
  outL.addScaledVector(_perp, GRAB.side);
  outR.addScaledVector(_perp, -GRAB.side);
}
function applyArmIK(chain, target) {
  if (!chain?.root || !chain.mid || !chain.end) return;
  const r = solveTwoBoneIK(chain, target);
  chain.root.quaternion.copy(r.rootQuat);
  chain.mid.quaternion.copy(r.midQuat);
  chain.root.updateWorldMatrix(true, true);
}
function updateHandIK() {
  if (!GRAB.enabled || !vamp.armL || !vamp.armR) return;
  computeGrabTargets(_gpL, _gpR);
  applyArmIK(vamp.armL, _gpL);
  applyArmIK(vamp.armR, _gpR);
  vamp.vrm.scene.updateMatrixWorld(true);
}

// ══════════ ken 職員NPC（Phase 3）：屋敷を巡回し、暴走した彼女を止めるべく発砲。捕まると持ち上げられ、吸い尽くされるとディソルブ ══════════
const KEN = { count: 3, walkSpeed: 1.5, fleeR: 6, fleeSpeed: 3.0, shootRange: 13, shootCd: 5.0, staffStun: 2.2, hp: 100, drainPerSec: 25 };
const kens = [];
const kenAssets = { ready: false, vrmBlobUrl: null, walkAnim: null, ragOpts: null, speechChar: null };
let speechUI = null, vampSpeech = null;

async function prepareKenAssets() {
  try {
    const bundle = await fetchFirst(['./ken.npc.json', '../npc/ken.npc.json'], true);
    if (!bundle) return false;
    kenAssets.vrmBlobUrl = URL.createObjectURL(dataURIToBlob(bundle.vrm));
    const buf = await fetchFirst(['./vrma/Catwalk_Walk_Forward.vrma', '../vrma/Catwalk_Walk_Forward.vrma'], false);
    if (buf) {
      const al = new GLTFLoader(); al.register((pl) => new VRMAnimationLoaderPlugin(pl));
      const ag = await al.loadAsync(URL.createObjectURL(new Blob([buf])));
      kenAssets.walkAnim = ag.userData.vrmAnimations?.[0] || null;
    }
    const j = await fetchFirst(['./ken.ragdoll.json', '../ragdoll/ken.ragdoll.json'], true);
    if (j) kenAssets.ragOpts = { ...(j.params || {}), boneMaxBend: j.boneMaxBend || {}, boundsMargin: 0.4 };
    const sd = (await fetchSpeechSet('staff.speech.json')) || (await fetchSpeechSet('ken.speech.json'));
    if (sd) kenAssets.speechChar = buildSpeechCharacter(sd, '職員');
    kenAssets.ready = true;
    return true;
  } catch (e) { console.warn('ken素材の準備失敗:', e.message); return false; }
}

function stripRootMotionXZ(clip) {   // その場歩き化（縦のボブは残す）
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.position')) continue;
    const v = tr.values;
    for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
  }
  return clip;
}

async function spawnKen(cell) {
  const gl2 = new GLTFLoader();
  gl2.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
  const gltf = await gl2.loadAsync(kenAssets.vrmBlobUrl);
  const kvrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.combineSkeletons(gltf.scene);
  kvrm.scene.position.set(cell.x * TILE, 0, cell.z * TILE);
  scene.add(kvrm.scene);
  const mixer = new THREE.AnimationMixer(kvrm.scene);
  let action = null;
  if (kenAssets.walkAnim) {
    action = mixer.clipAction(stripRootMotionXZ(createVRMAnimationClip(kenAssets.walkAnim, kvrm)));
    action.play();
  }
  const ragdoll = createRagdoll(kvrm, kenAssets.ragOpts || { gravity: -12, boundsMargin: 0.4 });
  let dis = null;   // ディソルブは事前生成（死亡時のシェーダコンパイルによるカクつき回避）
  try { dis = createDissolve(kvrm.scene, { rimColor: '#8ff0ff', liquidColor: '#bfeaff', rimIntensity: 2.6, groundY: 0.02, puddleScale: 1.4, doubleSide: false, armed: false }); dis.setProgress(0); } catch (e) { console.warn('dissolve生成失敗:', e.message); }
  const m = {
    vrm: kvrm, mixer, action, ragdoll, dis,
    state: 'patrol', path: null, seg: 1, repathT: 0, patrolTo: null,
    hp: KEN.hp, shootCd: 2 + Math.random() * 3, recoverT: 0, dissT: 0, _remove: false,
    speech: null, faceYaw: 0,
  };
  if (kenAssets.speechChar) {
    m.speech = createNpcSpeech(kvrm, kenAssets.speechChar, {
      onLineStart: (sp, text, cps) => { if (speechUI) speechUI.setBubble(m, text, cps); },
    });
  }
  kens.push(m);
  return m;
}

async function spawnStaff() {
  if (!kenAssets.ready) return;
  const rs = dg.rooms.slice().sort(() => Math.random() - 0.5).slice(0, KEN.count);
  for (const r of rs) { try { await spawnKen({ x: r.cx, z: r.cz }); } catch (e) { console.warn('ken spawn失敗:', e.message); } }
}

function kenCell(m) { return { x: Math.round(m.vrm.scene.position.x / TILE), z: Math.round(m.vrm.scene.position.z / TILE) }; }
// 壁ずり移動：進めない時は軸ごとに滑る（壁・角で完全停止しない）
function kenMove(m, dx, dz) {
  const pos = m.vrm.scene.position;
  const nx = pos.x + dx, nz = pos.z + dz;
  if (vampFree(nx, nz)) { pos.x = nx; pos.z = nz; return true; }
  if (vampFree(nx, pos.z)) { pos.x = nx; return true; }
  if (vampFree(pos.x, nz)) { pos.z = nz; return true; }
  // 完全に詰まった（壁の角にめり込み等）：自セル中心へ少しずつ押し戻して脱出させる
  const cx = Math.round(pos.x / TILE) * TILE, cz = Math.round(pos.z / TILE) * TILE;
  const ex = cx - pos.x, ez = cz - pos.z;
  const el = Math.hypot(ex, ez);
  if (el > 0.03) { pos.x += ex / el * 0.02; pos.z += ez / el * 0.02; }
  return false;
}
function kenAlive(m) { return !m._remove && m.hp > 0 && (m.state === 'patrol' || m.state === 'flee'); }
const _kpin = new THREE.Vector3(), _kd2 = new THREE.Vector3(), _ktmp = new THREE.Vector3(), _kperp = new THREE.Vector3();

function startKenDissolve(m) {
  m.state = 'dissolving'; m.dissT = 0;
  if (m.ragdoll?.active) setRagdollActive(m.ragdoll, false);
  // 水たまりは「倒れた体」の位置へ（scene.position は歩行時のルートのままなので使わない）
  const hips = m.vrm.humanoid?.getNormalizedBoneNode('hips');
  const c = hips ? hips.getWorldPosition(_ktmp) : m.vrm.scene.position;
  if (m.dis) {
    m.dis.setArmed(true); m.dis.setProgress(0);
    m.dis.setPuddleCenter(c.x, c.z); m.dis.setGroundY(0.02);   // 床上面(y0)のわずか上＝Z-fight回避
    try { m.dis.recenter(); } catch { /* noop */ }   // 倒れた後の実バウンディングで溶かす
  }
}
function removeKen(m) {
  m._remove = true;
  if (speechUI) speechUI.clearBubble(m);
  try { m.dis?.dispose(); } catch { /* noop */ }
  try { disposeRagdoll(m.ragdoll); } catch { /* noop */ }
  scene.remove(m.vrm.scene);
}

function updateKens(dt) {
  for (let i = kens.length - 1; i >= 0; i--) {
    const m = kens[i];
    if (m._remove) { kens.splice(i, 1); continue; }
    updateOneKen(m, dt);
  }
}
function updateOneKen(m, dt) {
  const pos = m.vrm.scene.position;
  const vd = Math.hypot(vamp.root.position.x - pos.x, vamp.root.position.z - pos.z);

  if (m.state === 'dissolving') {
    m.dissT += dt;
    if (m.dis) m.dis.setProgress(Math.min(1, m.dissT / 1.8));
    if (m.dissT > 1.8 + 1.4) removeKen(m);
    m.vrm.update(dt);
    return;
  }
  if (m.state === 'grabbed') {
    // 肩を掴み、顔を寄せて吸血：獲物の首を「彼女の口の高さ・目の前」へ引き寄せてピン留め
    vamp.root.getWorldQuaternion(_bq); _kd2.copy(bodyFwd).applyQuaternion(_bq); _kd2.y = 0; _kd2.normalize();
    const mouthY = vamp.head ? vamp.head.getWorldPosition(_ktmp).y + (KISS.up || 0) : 1.32;
    _kpin.set(vamp.root.position.x + _kd2.x * 0.42, mouthY, vamp.root.position.z + _kd2.z * 0.42);
    updateRagdoll(m.ragdoll, dt, { floorY: 0, pinBone: m.pinBone || 'neck', pinPos: _kpin });
    m.vrm.update(dt);
    if (m.speech) { m.speech.onState('downed'); m.speech.update(dt); }
    return;
  }
  if (m.state === 'downed') {
    // 吸い尽くされた：ラグドールのまま床へ落ち、崩れて落ち着いたらその場でディソルブ（CityFlyのken方式）
    m.downT = (m.downT || 0) + dt;
    updateRagdoll(m.ragdoll, dt, { floorY: 0 });
    m.vrm.update(dt);
    if (m.downT > 0.8) {
      let low = Infinity;
      for (const pt of m.ragdoll.particles) if (pt.pos.y < low) low = pt.pos.y;
      if (low < 0.22 || m.downT > 4) { setRagdollActive(m.ragdoll, false); startKenDissolve(m); }
    }
    return;
  }
  if (m.recoverT > 0) {   // 解放後：しばらくラグドールのまま倒れて回復
    m.recoverT -= dt;
    updateRagdoll(m.ragdoll, dt, { floorY: 0 });
    m.vrm.update(dt);
    if (m.recoverT <= 0) { setRagdollActive(m.ragdoll, false); m.state = 'patrol'; m.path = null; }
    return;
  }

  // ── 行動：彼女が近い→逃走 / 射程内→発砲 / それ以外→巡回 ──
  m.shootCd -= dt;
  if (vd < KEN.fleeR) {
    if (m.state !== 'flee' && m.speech) m.speech.bark('witness');
    m.state = 'flee';
  } else if (m.state === 'flee' && vd > KEN.fleeR * 2.2) { m.state = 'patrol'; m.path = null; }

  let speed = 0;
  if (m.state === 'flee') {
    // 彼女から最も遠い部屋へ経路で逃げる（直進逃げは壁で詰まるため）
    m.fleeRepathT = (m.fleeRepathT || 0) - dt;
    if (!m.path || m.fleeRepathT <= 0) {
      m.fleeRepathT = 1.5;
      let best = null, bd = -1;
      for (const r of dg.rooms) {
        const d = Math.hypot(r.cx * TILE - vamp.root.position.x, r.cz * TILE - vamp.root.position.z);
        if (d > bd) { bd = d; best = r; }
      }
      const pth = best ? findPath(nav, kenCell(m), { x: best.cx, z: best.cz }) : null;
      m.path = (pth && pth.length > 1) ? pth : null; m.seg = 1;
    }
    if (m.path && m.seg < m.path.length) {
      const wp = m.path[m.seg];
      const dx = wp.x * TILE - pos.x, dz = wp.z * TILE - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < TILE * 0.4) m.seg++;
      else { kenMove(m, dx / d * KEN.fleeSpeed * dt, dz / d * KEN.fleeSpeed * dt); m.faceYaw = Math.atan2(dx, dz); }
    } else {   // 経路なし：彼女と反対方向へ壁ずりで逃げる
      _kd2.set(pos.x - vamp.root.position.x, 0, pos.z - vamp.root.position.z).normalize();
      kenMove(m, _kd2.x * KEN.fleeSpeed * dt, _kd2.z * KEN.fleeSpeed * dt);
      m.faceYaw = Math.atan2(_kd2.x, _kd2.z);
    }
    speed = KEN.fleeSpeed;
  } else {
    // 発砲（視線が通り・彼女が硬直していなければ）
    if (vd < KEN.shootRange && m.shootCd <= 0 && vamp.stunT <= 0) {
      const a = kenCell(m), bcell = vampCell();
      if (hasLineOfSight(nav, a.x, a.z, bcell.x, bcell.z)) {
        m.shootCd = KEN.shootCd + Math.random() * 2;
        staffShoot(m);
      }
    }
    // 巡回
    m.repathT -= dt;
    if (!m.path || m.repathT <= 0) {
      m.repathT = 3 + Math.random() * 2;
      if (!m.patrolTo || Math.random() < 0.3) { const r = dg.rooms[(Math.random() * dg.rooms.length) | 0]; m.patrolTo = { x: r.cx, z: r.cz }; }
      const pth = findPath(nav, kenCell(m), m.patrolTo);
      m.path = (pth && pth.length > 1) ? pth : null; m.seg = 1;
    }
    if (m.path && m.seg < m.path.length) {
      const wp = m.path[m.seg];
      const wx = wp.x * TILE, wz = wp.z * TILE;
      const dx = wx - pos.x, dz = wz - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < TILE * 0.4) m.seg++;
      else {
        kenMove(m, dx / d * KEN.walkSpeed * dt, dz / d * KEN.walkSpeed * dt);
        m.faceYaw = Math.atan2(dx, dz);
        speed = KEN.walkSpeed;
      }
    }
  }
  // 向きと歩きアニメ
  let dyaw = m.faceYaw - m.vrm.scene.rotation.y;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  m.vrm.scene.rotation.y += dyaw * Math.min(1, dt * 8);
  if (m.action) m.action.timeScale = Math.max(0.25, speed / 1.4);
  if (m.mixer) m.mixer.update(dt);
  m.vrm.update(dt);
  if (m.speech) { m.speech.onState(m.state === 'flee' ? 'flee' : 'idle'); m.speech.update(dt); }
}

// 職員の発砲：彼女を硬直させる（ビームの見た目は既存 shotFx を流用）
function staffShoot(m) {
  if (m.speech) m.speech.bark('shoot');
  const from = m.vrm.scene.position.clone(); from.y = 1.35;
  const to = vamp.root.position.clone(); to.y = 1.2;
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.9 }));
  scene.add(line); shotFx.push({ line, t: 0 });
  vamp.stunT = KEN.staffStun;
  vamp.state = 'stunned';
  if (vampSpeech) vampSpeech.bark('repelled');
}

// 彼女が職員を捕まえて持ち上げる
function startHoldKen(m) {
  if (m.hp <= 0 || m.state === 'downed' || m.state === 'dissolving') return;   // 事切れた相手は掴まない
  vamp.state = 'holdKen'; vamp.holding = m;
  m.state = 'grabbed'; m.path = null;
  // 首を掴む（このVRMのラグドールに首が無ければ頭→胸へフォールバック）
  m.pinBone = ['neck', 'head', 'chest'].find((b) => m.ragdoll?.idxOf?.[b] != null) || 'chest';
  if (m.speech) m.speech.bark('grabbed');
  setRagdollActive(m.ragdoll, true);
  setVampAnimForState('capture');
}
function releaseHeldKen() {
  const m = vamp.holding;
  if (m && m.state === 'grabbed') { m.state = 'recover'; m.recoverT = 2.2; if (m.speech) m.speech.bark('thrown'); }
  vamp.holding = null;
}

// セリフ（吸血鬼）とバブルの画面投影
async function initSpeech() {
  speechUI = createSpeechUI({ dom: document.body });
  const sd = await fetchSpeechSet('joy_vamp.speech.json');
  if (sd && vamp.vrm) {
    const ch = buildSpeechCharacter(sd, 'JOY_vamp');
    vampSpeech = createNpcSpeech(vamp.vrm, ch, {
      onLineStart: (sp, text, cps) => { if (speechUI) speechUI.setBubble(vamp, text, cps); },
    });
  }
}
const _bubV = new THREE.Vector3();
function bubbleScreenPos(holder) {
  if (holder === vamp) {
    if (!vamp.head) return { x: 0, y: 0, visible: false };
    vamp.head.getWorldPosition(_bubV); _bubV.y += 0.28;
  } else {
    if (!holder.vrm) return { x: 0, y: 0, visible: false };
    _bubV.setFromMatrixPosition(holder.vrm.scene.matrixWorld); _bubV.y += 1.75;
  }
  const dist = camera.position.distanceTo(_bubV);
  _bubV.project(camera);
  const visible = _bubV.z < 1 && dist <= 30 && _bubV.x >= -1 && _bubV.x <= 1 && _bubV.y >= -1 && _bubV.y <= 1;
  return { x: (_bubV.x * 0.5 + 0.5) * innerWidth, y: (-_bubV.y * 0.5 + 0.5) * innerHeight, visible };
}

function pickPatrol() {   // 屋敷の中を「生活」して巡回：部屋とゴール周辺をランダムに巡る
  const r = dg.rooms[(Math.random() * dg.rooms.length) | 0];
  return { x: r.cx, z: r.cz };
}

// ── プレイヤーのショット（ヒットスキャン。当てると硬直） ──
const shotFx = [];
function fireShot() {
  if (phase !== 'playing' || !vamp.ready) return;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const dir = camera.getWorldDirection(new THREE.Vector3());
  // 吸血鬼を球として判定（胸の高さ）
  const c = vamp.root.position.clone(); c.y = 1.1;
  const toC = c.sub(origin);
  const t = toC.dot(dir);
  let hit = false;
  if (t > 0 && t < 40) {
    const perp2 = toC.lengthSq() - t * t;
    if (perp2 <= 0.8 * 0.8) hit = true;   // 半径0.8m
  }
  const end = origin.clone().addScaledVector(dir, hit ? t : 30);
  const g = new THREE.BufferGeometry().setFromPoints([origin.clone().addScaledVector(dir, 0.3), end]);
  const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: hit ? 0xfff0a0 : 0x88bbff, transparent: true, opacity: 0.9 }));
  scene.add(line); shotFx.push({ line, t: 0 });
  if (hit) {
    vamp.stunT = VAMP.stunSec;
    vamp.state = 'stunned';
    if (vamp.state === 'capture') drain = Math.max(0, drain - 5);
  }
}
function updateShotFx(dt) {
  for (let i = shotFx.length - 1; i >= 0; i--) {
    const f = shotFx[i]; f.t += dt;
    f.line.material.opacity = Math.max(0, 0.9 - f.t * 6);
    if (f.t > 0.16) { scene.remove(f.line); f.line.geometry.dispose(); f.line.material.dispose(); shotFx.splice(i, 1); }
  }
}

// ── ゲーム進行 ──
function startGame() { phase = 'playing'; nightT = 0; won = false; drain = 0;
  if (vamp.ready) { vamp.state = 'patrol'; vamp.path = null; vamp.stunT = 0; vamp.patrolTo = null; }   // 布が飛ぶのでテレポートはしない
  resetPlayer(); $('overlay').style.display = 'none'; if (!touchMode) canvas.requestPointerLock(); }
function showOverlay(title, sub, col) { $('ov-title').textContent = title; $('ov-title').style.color = col; $('ov-sub').textContent = sub; $('overlay').style.display = 'flex'; $('btn-start').textContent = 'もう一度'; $('btn-start').disabled = false; $('overlay').style.display = 'flex'; }
function win(reason) { if (won) return; won = true; phase = 'win'; document.exitPointerLock?.(); showOverlay('ESCAPED', reason, '#8f8'); }
function lose() { if (won) return; won = true; phase = 'lose'; document.exitPointerLock?.(); showOverlay('DRAINED', '彼女に捕まった…', '#f66'); }

let frames = 0, lastFps = performance.now(), fps = 0;
function updateHUD() {
  const remain = Math.max(0, NIGHT_SEC - nightT);
  $('hud-time').textContent = `残り ${Math.floor(remain / 60)}:${String(Math.floor(remain % 60)).padStart(2, '0')}`;
  const gd = goalMesh ? Math.hypot(player.pos.x - goalMesh.position.x, player.pos.z - goalMesh.position.z) : 0;
  $('hud-goal').textContent = `ゴールまで ${gd.toFixed(0)}m`;
  $('hud-fps').textContent = `${fps} FPS`;
  const st = $('hud-state');
  if (st) {
    const label = { patrol: '徘徊中', chase: '追われている！', capture: '捕まった！ 振りほどけない…撃て！', stunned: '怯んでいる' }[vamp.state] || '';
    st.textContent = vamp.ready ? label : '';
    st.style.color = vamp.state === 'capture' ? '#f66' : (vamp.state === 'chase' ? '#fa6' : '#8ab');
  }
  const db = $('hud-drain'); if (db) db.style.width = Math.min(100, drain) + '%';
  const alive = kens.filter((m) => !m._remove).length;
  if (kenAssets.ready) $('hud-goal').textContent += ` / 職員 ${alive}`;
}

// ══════════ 観察エディタ（俯瞰／追従カメラ＋ライティング調整） ══════════
const obs = { on: false, mode: 'overview', yaw: 0.7, pitch: 0.9, dist: 60, tgt: new THREE.Vector3(), kenIdx: 0, drag: 0, lx: 0, ly: 0 };
const lightCfg = { hemi: 0.75, torch: 6.5, moon: 0.55, lamp: 1, env: 1, fog: 42 };

function obsToggle(on) {
  obs.on = on === undefined ? !obs.on : on;
  $('obs-panel').style.display = obs.on ? 'block' : 'none';
  $('btn-obs').style.background = obs.on ? 'rgba(120,60,160,0.95)' : 'rgba(60,30,70,0.85)';
  if (obs.on) {
    document.exitPointerLock && document.exitPointerLock();
    torchHolder.position.copy(player.pos); scene.add(torchHolder); torchHolder.add(torch);   // 松明はプレイヤーの手元に残す
    obs.tgt.set(dg.w * TILE / 2, 0, dg.d * TILE / 2);
    obsSetMode('overview');
    syncLightUI();
  } else {
    obs.mode = 'play';
    camera.add(torch);   // プレイ時は松明＝カメラ追従に戻す
    document.querySelectorAll('.obs-cam').forEach((b) => b.classList.remove('on'));
  }
  setOverheadVisible(!obs.on);
  if (scene.fog) scene.fog.far = obs.on ? Math.max(lightCfg.fog, obs.dist * 2.2) : lightCfg.fog;
}
function obsSetMode(m) {
  if (m === 'play') { obsToggle(false); return; }
  obs.mode = m;
  document.querySelectorAll('.obs-cam').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  obs.dist = (m === 'overview') ? Math.max(dg.w, dg.d) * TILE * 0.95 : 4.5;   // 屋敷全体が入る高さ
  obs.pitch = (m === 'overview') ? 1.15 : 0.25;
  if (m === 'overview') obs.tgt.set(dg.w * TILE / 2, 0, dg.d * TILE / 2);
  else { const t = obsTarget(); if (t) obs.tgt.set(t.x, t.y + 1.1, t.z); }   // 切替時は即座に対象へ（以降は毎フレーム追従）
  if (scene.fog) scene.fog.far = Math.max(lightCfg.fog, obs.dist * 2.2);   // 遠景が霧で消えないように
}
function obsTarget() {
  if (obs.mode === 'vamp' && vamp.ready) return vamp.root.position;
  if (obs.mode === 'ken' && kens.length) {
    const k = kens[obs.kenIdx % kens.length];
    const o = k && (k.root || (k.vrm && k.vrm.scene));
    if (o) return o.position;
  }
  return null;
}
const torchHolder = new THREE.Object3D();   // 観察モード中の松明の置き場（プレイヤー位置に固定）
// 俯瞰では天井が邪魔なので消す。プレイ復帰時に戻す。
function setOverheadVisible(v) { dungeonGroup.traverse((o) => { if (o.userData.overhead) o.visible = v; }); }
const _obsAt = new THREE.Vector3();
// カメラ位置が壁の中に入らないように、注視点から少しずつ後退して当たる直前で止める
function obsPointInWall(x, z) {
  const arr = segsByCell.get(Math.round(x / TILE) + ',' + Math.round(z / TILE));
  if (!arr) return false;
  const R = 0.28;   // カメラの太さぶんの余裕
  for (const w of arr) if (x > w.minX - R && x < w.maxX + R && z > w.minZ - R && z < w.maxZ + R) return true;
  return false;
}
function obsClampDist(tgt, dx, dy, dz, want) {
  const STEP = 0.25;
  for (let d = STEP; d <= want; d += STEP) {
    if (tgt.y + dy * d < 0.35) return Math.max(0.9, d - STEP);   // 床下に潜らない
    if (obsPointInWall(tgt.x + dx * d, tgt.z + dz * d)) return Math.max(0.9, d - STEP);
  }
  return want;
}
function applyObsCamera(dt) {
  if (!obs.on) return;
  const t = obsTarget();
  if (t) obs.tgt.lerp(_obsAt.set(t.x, t.y + 1.1, t.z), Math.min(1, dt * 6));
  torchHolder.position.copy(player.pos);
  if (scene.fog) scene.fog.far = Math.max(lightCfg.fog, obs.dist * 2.2);   // ズームに合わせて霧を下げる
  const cp = Math.cos(obs.pitch), sp = Math.sin(obs.pitch);
  const dx = Math.sin(obs.yaw) * cp, dz = Math.cos(obs.yaw) * cp;
  const d = t ? obsClampDist(obs.tgt, dx, sp, dz, obs.dist) : obs.dist;   // 追従時のみ壁を避ける
  camera.position.set(obs.tgt.x + dx * d, obs.tgt.y + sp * d, obs.tgt.z + dz * d);
  camera.lookAt(obs.tgt);
  const info = $('obs-info');
  if (info) {
    const vs = vamp.ready ? vamp.state : '-';
    let alive = kens.length;
    try { alive = kens.filter((k) => kenAlive(k)).length; } catch (e) { /* 判定関数が無ければ総数 */ }
    let txt = '吸血鬼: ' + vs + '　職員: ' + alive + '/' + kens.length;
    if (obs.mode === 'ken' && kens.length) txt += ' / 追跡中 ' + ((obs.kenIdx % kens.length) + 1) + '人目（ボタン再クリックで次へ）';
    info.textContent = txt;
  }
}
function applyLighting() {
  if (LIGHTS.hemi) LIGHTS.hemi.intensity = lightCfg.hemi;
  if (LIGHTS.torch) LIGHTS.torch.intensity = lightCfg.torch;
  if (LIGHTS.moon) LIGHTS.moon.intensity = lightCfg.moon;
  for (const l of LIGHTS.lamps) {
    if (l.userData.base == null) l.userData.base = l.intensity;
    l.intensity = l.userData.base * lightCfg.lamp;
  }
  if (vamp.cape && vamp.cape.setMaterial) { try { vamp.cape.setMaterial({ envMapIntensity: lightCfg.env }); } catch (e) { /* noop */ } }
  if (scene.fog) scene.fog.far = obs.on ? Math.max(lightCfg.fog, obs.dist * 2.2) : lightCfg.fog;
}
function syncLightUI() {
  const rows = [['hemi', 2], ['torch', 1], ['moon', 2], ['lamp', 2], ['env', 2], ['fog', 0]];
  for (const [k, d] of rows) {
    const el = $('ls-' + k), lab = $('lv-' + k);
    if (el) el.value = lightCfg[k];
    if (lab) lab.textContent = (+lightCfg[k]).toFixed(d);
  }
}
function setupObsUI() {
  const btn = $('btn-obs');
  if (btn) btn.addEventListener('click', () => obsToggle());
  addEventListener('keydown', (e) => {
    if ((e.key === 'o' || e.key === 'O') && !e.repeat && dg) obsToggle();
  });
  document.querySelectorAll('.obs-cam').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.m === 'ken' && obs.mode === 'ken') obs.kenIdx++;
    obsSetMode(b.dataset.m);
  }));
  const cv = renderer.domElement;
  cv.addEventListener('mousedown', (e) => { if (obs.on) { obs.drag = e.button === 2 ? 2 : 1; obs.lx = e.clientX; obs.ly = e.clientY; } });
  addEventListener('mouseup', () => { obs.drag = 0; });
  addEventListener('mousemove', (e) => {
    if (!obs.on || !obs.drag) return;
    const dx = e.clientX - obs.lx, dy = e.clientY - obs.ly;
    obs.lx = e.clientX; obs.ly = e.clientY;
    if (obs.drag === 1) {
      obs.yaw -= dx * 0.005;
      obs.pitch = Math.max(0.05, Math.min(1.5, obs.pitch + dy * 0.004));
    } else if (!obsTarget()) {
      const c = Math.cos(obs.yaw), s2 = Math.sin(obs.yaw), k = obs.dist * 0.0016;
      obs.tgt.x -= (dx * c - dy * s2) * k;
      obs.tgt.z += (dx * s2 + dy * c) * k;
    }
  });
  cv.addEventListener('wheel', (e) => {
    if (!obs.on) return;
    e.preventDefault();
    obs.dist = Math.max(2, Math.min(300, obs.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
  }, { passive: false });
  cv.addEventListener('contextmenu', (e) => { if (obs.on) e.preventDefault(); });

  const bind = (k, d) => {
    const el = $('ls-' + k), lab = $('lv-' + k);
    if (!el) return;
    el.addEventListener('input', (e) => {
      lightCfg[k] = +e.target.value;
      if (lab) lab.textContent = lightCfg[k].toFixed(d);
      applyLighting();
    });
  };
  bind('hemi', 2); bind('torch', 1); bind('moon', 2); bind('lamp', 2); bind('env', 2); bind('fog', 0);

  const nol = $('obs-nolight');
  if (nol) nol.addEventListener('change', (e) => {
    const off = e.target.checked;
    if (LIGHTS.hemi) LIGHTS.hemi.intensity = off ? 0 : lightCfg.hemi;
    if (LIGHTS.torch) LIGHTS.torch.intensity = off ? 0 : lightCfg.torch;
    if (LIGHTS.moon) LIGHTS.moon.intensity = off ? 0 : lightCfg.moon;
    for (const l of LIGHTS.lamps) l.intensity = off ? 0 : (l.userData.base == null ? 1 : l.userData.base) * lightCfg.lamp;
  });
  const sv = $('obs-save');
  if (sv) sv.addEventListener('click', async () => {
    let ok = false;
    try {
      ok = (await fetch('/api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: 'vamp_param', filename: 'dungeon-light.json', content: JSON.stringify(lightCfg, null, 2) }),
      })).ok;
    } catch (e) { /* devサーバ無 */ }
    sv.textContent = ok ? '✓ 保存しました' : '↓ 保存失敗（devサーバ無）';
    setTimeout(() => { sv.textContent = '💾 ライティングを保存'; }, 1500);
  });
}
async function loadLighting() {
  for (const u of ['./dungeon-light.json', '../vamp_param/dungeon-light.json']) {
    try {
      const j = JSON.parse(await (await fetch(u)).text());
      if (j) { Object.assign(lightCfg, j); return; }
    } catch (e) { /* next */ }
  }
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (phase === 'playing') {
    nightT += dt;
    updatePlayer(dt);
    updateVamp(dt);
    updateKens(dt);
    updateCaptureView(dt);
    if (goalMesh) {
      goalMesh.rotation.y += dt * 0.8;
      if (Math.hypot(player.pos.x - goalMesh.position.x, player.pos.z - goalMesh.position.z) < 2.0) win('ゴールに到達した！');
    }
    if (nightT >= NIGHT_SEC) win('夜を耐え抜いた！');
  }
  // VRM/マントの更新（状態機械の後）
  if (vamp.ready) {
    if (vamp.mixer) vamp.mixer.update(dt);
    if (vamp.hips) { vamp.hips.position.x = hipsRest.x; vamp.hips.position.z = hipsRest.z; }   // 腰はその場（前進はフットロック）。ミキサーの後に効かせる
    vamp.vrm.scene.updateMatrixWorld(true);
    if (phase === 'playing') headLook((vamp.state === 'capture' || vamp.state === 'holdKen') ? 1 : (vamp.state === 'chase' ? 0.6 : 0.25));
    updateVampExpr(dt);
    vamp.vrm.update(dt);
    if (vamp.state === 'capture' && phase === 'playing') updateHandIK();   // 腕IKはアニメ適用後に上書き
    else if (vamp.state === 'holdKen' && vamp.holding && phase === 'playing') {   // 両手で獲物の肩を掴む
      _kperp.copy(_kd2).cross(_yUp).normalize();
      _gpL.copy(_kpin); _gpL.y -= GRAB.down; _gpL.addScaledVector(_kd2, GRAB.fwd);
      _gpR.copy(_gpL);
      _gpL.addScaledVector(_kperp, GRAB.side);
      _gpR.addScaledVector(_kperp, -GRAB.side);
      applyArmIK(vamp.armL, _gpL);
      applyArmIK(vamp.armR, _gpR);
      vamp.vrm.scene.updateMatrixWorld(true);
    }
    if (vampSpeech && phase === 'playing') { vampSpeech.onState(vamp.state); vampSpeech.update(dt); }
    if (speechUI) speechUI.update(dt, bubbleScreenPos);
    if (vamp.cape) { try { vamp.cape.update(dt, vamp.action ? vamp.action.time * 30 : 0); } catch { /* noop */ } }
  }
  updateShotFx(dt);
  applyObsCamera(dt);   // 観察モード時はプレイ視点を上書き
  renderer.render(scene, camera);
  frames++; const now = performance.now();
  if (now - lastFps >= 500) { fps = Math.round(frames / ((now - lastFps) / 1000)); frames = 0; lastFps = now; updateHUD(); }
});

// ── 起動 ──
setupTouch();
Promise.all([loadPaintingCfg(), loadTune(), loadEnemyCfg(), loadLighting()]).then(() => { initKissAudio(); return buildDungeon(); }).then(() => { nav = buildNav(dg); return loadVamp(); }).then(() => {
  initSpeech();
  prepareKenAssets().then(spawnStaff).catch((e) => console.warn('職員配置失敗:', e));
  resetPlayer();
  setupObsUI(); applyLighting(); syncLightUI();   // 観察エディタとライティングを初期化
  $('btn-start').disabled = false;
  $('btn-start').textContent = 'スタート';
}).catch((e) => { setStatus('読み込み失敗: ' + e.message); console.error(e); });
$('btn-start').addEventListener('click', startGame);

window.__game = {
  get phase() { return phase; }, get player() { return player; }, get dg() { return dg; },
  startGame, camera, get goal() { return goalMesh; },
  teleport(cx, cz) { player.pos.set(cx * TILE, EYE_H, cz * TILE); player.vel.set(0, 0, 0); },
  get vamp() { return vamp; }, get nav() { return nav; }, get drain() { return drain; },
  vampTo(cx, cz) { placeVampAt({ x: cx, z: cz }); vamp.path = null; vamp.repathT = 0; },
  fireShot, get KISS() { return KISS; }, get GRAB() { return GRAB; },
  get obs() { return obs; }, get lightCfg() { return lightCfg; },
  curAnim() { return vampAnimName; }, get enemyCfg() { return ENEMY_CFG; }, get kens() { return kens; }, get KEN() { return KEN; }, startHoldKen,
  mouthWorld() { if (!vamp.head) return null; const hp=vamp.head.getWorldPosition(new THREE.Vector3()), hq=vamp.head.getWorldQuaternion(new THREE.Quaternion());
    return headFace.clone().multiplyScalar(KISS.fwd).setY(KISS.up).applyQuaternion(hq).add(hp); },
  kissSrc() { return kissAudio.el ? kissAudio.el.src.split('/').pop() : null; },
  grabTargets() { computeGrabTargets(_gpL, _gpR); return { l: _gpL.clone(), r: _gpR.clone() }; },
  handWorld() { return { l: vamp.armL?.end?.getWorldPosition(new THREE.Vector3()) || null, r: vamp.armR?.end?.getWorldPosition(new THREE.Vector3()) || null }; },
};
