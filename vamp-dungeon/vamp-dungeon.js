// vamp-dungeon.js — Vampire Dungeon（Phase 1: ダンジョン生成＋徒歩移動＋壁当たり＋ゴール）
// レンダラは WebGPURenderer（WebGPU が無ければ three が WebGL2 バックエンドへ自動フォールバック。
// どちらでも TSL/ノードマテリアル＝ディソルブ等のFXが動くので、後段フェーズの資産を活かせる）。
// 当たり判定は Octree ではなく「ダンジョンのグリッド」を直接引く。NPCのナビ(Phase2)と同じデータを共有でき、
// 描画は InstancedMesh でまとめられる（数百メッシュ→数ドローコール）。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { WebGLRenderer } from 'https://esm.sh/three@0.184.0';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import { pmremTexture } from 'https://esm.sh/three@0.184.0/tsl';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { generateEstate, SOLID } from '../lib/dungeon-gen.js';
import { makePaintingTexture } from '../lib/painting-tex.js';
import { buildNav, findPath, hasLineOfSight, passable } from '../lib/dungeon-nav.js';
import { categorize } from '../lib/room-gen.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { solveTwoBoneIK } from '../lib/vrm-ik.js';
import { sampleExpr, applyExpr } from '../lib/expr-timeline.js';
import { createRagdoll, setRagdollActive, updateRagdoll, disposeRagdoll } from '../lib/vrm-ragdoll.js';
import { createDissolve } from '../lib/fx-dissolve.js';
import { createMeshFx } from '../lib/fx-mesh.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { createNpcSpeech } from '../lib/npc-speech.js';
import { createStoryRunner } from '../lib/story-runner.js';
import { createLipSync } from '../lib/lip-sync.js';
import { createSpeechUI } from '../lib/speech-ui.js';
import { fetchSpeechSet, buildSpeechCharacter } from '../lib/speech-set.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const e = $('status'); if (e) e.textContent = m; };

// ── 設定 ──
const SCALE = 2.5;                 // 1セル=2.5m（入口高を人の身長より上げる）→ 大回廊3セル=7.5m / 脇廊下2セル=5m
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

// ── マテリアルの共有 ──
// キットのGLBは部材ごとに別マテリアルの実体を持つが、実際の見た目は数種類しかない
// （実測: 141実体 → 見た目は20種類）。WebGPU では 1マテリアルにつき TSL のノードグラフを
// 解析して WGSL を生成するため、同じ見た目のものは1つに統合して構築回数を減らす。
const matPool = new Map();
function matKey(m) {
  const t = (x) => (x ? x.uuid : '-');
  return [
    m.type, m.color?.getHexString(), m.roughness, m.metalness,
    m.emissive?.getHexString(), m.emissiveIntensity, m.opacity, m.alphaTest,
    m.transparent, m.side, m.flatShading, m.vertexColors, m.depthWrite, m.wireframe,
    t(m.map), t(m.normalMap), t(m.roughnessMap), t(m.metalnessMap), t(m.emissiveMap), t(m.aoMap), t(m.alphaMap),
  ].join('|');
}
function shareMaterial(m) {
  if (!m || !m.isMaterial) return m;
  const k = matKey(m);
  const hit = matPool.get(k);
  if (hit && hit !== m) { m.dispose(); return hit; }
  if (!hit) matPool.set(k, m);
  return hit || m;
}

// ── モデル読み込み（bottom-center 原点に正規化＝room-editor と同じ規約） ──
const loader = new GLTFLoader();
// unlit（KHR_materials_unlit → MeshBasicMaterial）はライトに反応しないので標準マテリアルへ変換。
// 同じ元マテリアルからは同じ変換結果を返す（共有を保ってパイプライン数を増やさない）
const litCache = new WeakMap();
function litMaterial(m) {
  if (!m || !m.isMeshBasicMaterial) return m;
  let std = litCache.get(m);
  if (!std) {
    std = new THREE.MeshStandardMaterial({
      map: m.map || null, color: m.color ? m.color.clone() : 0xffffff,
      roughness: 0.95, metalness: 0,
      transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest || 0,
      side: THREE.DoubleSide,   // unlitモデルは面の向きが不定（床が上から見えない等）→両面で描く
    });
    litCache.set(m, std);
  }
  return std;
}
async function loadPart(dir, name) {
  const url = dir.split('/').map(encodeURIComponent).join('/').replace(/^\.\.%2F|^%2E%2E\//, '../') + encodeURIComponent(name) + '.glb';
  const gltf = await loader.loadAsync(dir + encodeURIComponent(name) + '.glb');
  const obj = gltf.scene;
  // 読み込み直後に共有へ差し替える＝この部材を使う全ての経路（InstancedMesh・編集用clone）に効く
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const wasUnlit = Array.isArray(o.material) ? o.material.some((mm) => mm && mm.isMeshBasicMaterial) : o.material?.isMeshBasicMaterial;
    o.material = Array.isArray(o.material) ? o.material.map((mm) => shareMaterial(litMaterial(mm))) : shareMaterial(litMaterial(o.material));
    // unlitモデルは法線を持たないことがある。標準マテリアル化すると真っ黒になるので補完する。
    // さらに両面共有の平面（floor-flat等）は自動計算が表裏で打ち消されて長さ0/NaNの法線になる
    // → 無効な法線は上向きに置き換える（DoubleSideなので裏面は自動反転）
    if (wasUnlit && o.geometry) {
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const nor = o.geometry.attributes.normal;
      if (nor) {
        let fixed = false;
        for (let i = 0; i < nor.count; i++) {
          const l = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
          if (!(l > 0.5)) { nor.setXYZ(i, 0, 1, 0); fixed = true; }
        }
        if (fixed) nor.needsUpdate = true;
      }
    }
  });
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  return { obj, size, url };
}
// 部材の全メッシュを取り出す（InstancedMesh 化のため）。
// WebGPU は (ジオメトリ×マテリアル) の組ごとにシェーダを構築するため、部材内で同じマテリアルの
// サブメッシュはジオメトリを統合して組の数を減らす。起動時間はこの構築回数でほぼ決まる。
const MERGE_ATTR = ['position', 'normal', 'uv'];
const collectCache = new WeakMap();   // userData に持たせると clone 時に JSON 化されて壊れる
function collectMeshes(root) {
  const hit = collectCache.get(root);
  if (hit) return hit;
  const groups = new Map(), out = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) { out.push({ geo: o.geometry, mat: o.material, mat4: o.matrixWorld.clone() }); return; }
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);   // 統合するので行列を焼き込む
    for (const k of Object.keys(g.attributes)) if (!MERGE_ATTR.includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);   // 統合は index の有無を揃える必要がある
    const k = o.material.uuid;
    if (!groups.has(k)) groups.set(k, { mat: o.material, geos: [] });
    groups.get(k).geos.push(g);
  });
  const I = new THREE.Matrix4();
  for (const { mat, geos } of groups.values()) {
    let geo = geos[0];
    if (geos.length > 1) { const m = mergeGeometries(geos, false); if (m) geo = m; else { for (const g of geos) out.push({ geo: g, mat, mat4: I }); continue; } }
    out.push({ geo, mat, mat4: I });
  }
  collectCache.set(root, out);
  return out;
}

// ── ダンジョン ──
let dg = null;
const dungeonGroup = new THREE.Group();
scene.add(dungeonGroup);

async function buildDungeon() {
  setStatus('ダンジョン生成中…');
  const stg = stageCfg;
  dg = generateEstate({ layout: stg?.layout || 'mansion', roomsX: stg?.roomsX || 3, roomsZ: stg?.roomsZ || 3, seed: stg?.seed ?? ((Math.random() * 99999) | 0) });
  dg.parts = stg?.parts || null; applyPartMap(dg.parts);   // 外装パーツの差し替え（柱/床/壁/窓）
  if (stg?.items) dg.items = stg.items;          // 編集済みアイテムで置き換え
  if (stg?.goal) dg.goal = stg.goal;             // 編集済みゴール
  buildWallColliders();

  const needed = new Set(['floor', 'wall', 'doorway', 'window']);
  for (const it of dg.items) if (it.model !== 'painting') needed.add(it.model);
  await Promise.all([...needed].map((name) => ensurePart(name)));
  const zoneSet = new Set([0]);
  for (const sh of dg.shell) zoneSet.add(sh.zone ?? sh.level ?? 0);
  await Promise.all([...zoneSet].flatMap((z) => ['floor', 'wall', 'window', 'pillar'].map((k) => ensurePartRef(partRefOf(k, z)))));
  const parts = partsCache;
  // 種類ごとに配置行列を集めて InstancedMesh 化
  const buckets = new Map();
  const push = (kind, m) => { if (!buckets.has(kind)) buckets.set(kind, []); buckets.get(kind).push(m); };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _yAxis = new THREE.Vector3(0, 1, 0), _s = new THREE.Vector3(SCALE, SCALE, SCALE), _p = new THREE.Vector3();

  const WALL_H = (partOf('wall', 0) || parts.wall).size.y * SCALE;   // 壁1段の高さ（ゾーン0基準）
  FLOOR_T = ((partOf('floor', 0) || parts.floor)?.size.y || 0.05) * SCALE;   // 床タイルの厚み
  wallH = WALL_H;
  STORY_H = WALL_H * 2;   // 天井が全域2段なので1フロア＝壁2枚ぶん
  stairByCell.clear();
  for (const st of (dg.stairs || [])) {
    stairByCell.set(st.x + ',' + st.z, st);
    stairByCell.set((st.x + st.dx) + ',' + (st.z + st.dz), st);
  }
  for (const s of dg.shell) {
    const isWall = s.model === 'wall' || s.model === 'doorway' || s.model === 'window';
    const zn = s.zone ?? s.level ?? 0;
    let ry = (s.ry || 0) + (isWall ? WALL_RY_OFFSET : 0);
    if (s.model === 'wall' || s.model === 'window' || s.model === 'floor') ry += partRotOf(s.model, zn);
    const yB = (s.level || 0) * STORY_H;   // 2階以上は上へ積む
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    // 床は厚みぶん沈めて「上面が階の基準高」になるように（家具や足が床上面に正しく載る）
    // holeOnly＝吹き抜けの開口：床板は張らないが天井（屋根）は生成する
    const lv = s.level || 0;
    if (!(s.model === 'floor' && s.holeOnly)) {
      _p.set(s.x * TILE, yB + (s.model === 'floor' ? -FLOOR_T : 0), s.z * TILE);
      push(s.model + '|' + lv + '|' + zn, _m.compose(_p, _q, _s).clone());
    }
    if (isWall && s.tall) {   // 広間側は2段積み（天井が高いぶんを塞ぐ）
      _p.set(s.x * TILE, yB + WALL_H, s.z * TILE);
      // 2段目は常に「壁」モデルなので、扉・窓レコード由来でも壁の回転補正で積む
      _q2.setFromAxisAngle(_yAxis, (s.ry || 0) + WALL_RY_OFFSET + partRotOf('wall', zn));
      push('wall|' + lv + '|' + zn, _m.compose(_p, _q2, _s).clone());
    }
    // 床の真上に天井（noCeil＝上階の床が天井を兼ねる／吹き抜け）
    if (s.model === 'floor' && !s.noCeil) { _p.set(s.x * TILE, yB + (s.ceil || 1) * WALL_H, s.z * TILE); push('ceiling|' + lv + '|' + zn, _m.compose(_p, _q, _s).clone()); }
  }
  // 絵画は額縁＋テクスチャで個別生成
  for (const it of dg.items) if (it.model === 'painting') addPainting(it);

  partsCache.ceiling = partsCache.floor;   // 天井は床と同じ部材（バケットだけ分けて観察モードで隠せるように）
  for (const [bkey, mats] of buckets) {
    const seg = bkey.split('|');
    const kind = seg[0], blv = +(seg[1] || 0), bzn = seg[2] != null ? +seg[2] : blv;
    const part = (kind === 'doorway') ? parts.doorway : partOf(kind === 'ceiling' ? 'floor' : kind, bzn);
    if (!part || !mats.length) continue;
    for (const sub of collectMeshes(part.obj)) {
      const inst = new THREE.InstancedMesh(sub.geo, sub.mat, mats.length);
      const mm = new THREE.Matrix4();
      for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mm.multiplyMatrices(mats[i], sub.mat4));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.userData.level = blv;
      if (kind === 'ceiling') inst.userData.overhead = true;   // 俯瞰時に隠す
      dungeonGroup.add(inst);
    }
  }
  await rebuildItemInstances();

  // ゴール（金色の柱＋光）
  goalMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 1.6, roughness: 0.3 }));
  goalMesh.position.set(dg.goal.x * TILE, (dg.goal.level || 0) * STORY_H + 1.6, dg.goal.z * TILE);
  scene.add(goalMesh);
  goalLight = new THREE.PointLight(0xffcc55, 40, 22, 1.4);
  goalLight.position.copy(goalMesh.position); scene.add(goalLight);

  // ランタンの淡い光（負荷対策：各階3灯まで）
  const lanternPerLv = {};
  for (const it of dg.items.filter((i) => i.model === 'lantern')) {
    const lv = it.level || 0;
    lanternPerLv[lv] = (lanternPerLv[lv] || 0) + 1;
    if (lanternPerLv[lv] > 3) continue;
    const l = new THREE.PointLight(0xffb060, 10, 10, 1.4);
    l.position.set(it.x * TILE, 2.2 + lv * STORY_H, it.z * TILE); scene.add(l); LIGHTS.lamps.push(l);
  }
  buildMoonlight();
  setStatus('');
}
let goalMesh = null, goalLight = null, wallH = 2.0, FLOOR_T = 0.1;
const FURN_S = 1.4;   // 家具は建築(2.0)より小さめ＝人のスケールに合わせる
// 抽象名 → 実モデル（キット指定）。部屋の家具は room-gen が返す実名をそのまま使う。
const MODEL_MAP = {
  floor: [KIT_FURN, 'floorFull'], wall: [KIT, 'wall'], doorway: [KIT, 'wall-doorway-square'],
  window: [KIT, 'wall-window-round'], pillar: [KIT, 'pillar-stone'], lantern: [KIT, 'lantern'],
  stair: [KIT, 'stairs-wide-stone-handrail'], door: [KIT, 'wall-door'],
  paneling: [KIT_FURN, 'paneling'], rug: [KIT_FURN, 'rugRectangle'],
  chandelier: [KIT_FURN, 'lampSquareCeiling'], plant: [KIT_FURN, 'pottedPlant'],
};
const KIT_RETRO = '../models/GLB retro_fantasy/';
// 地下の配置物（タル・木箱）はレトロキットから
for (const n of ['barrels', 'detail-barrel', 'detail-crate', 'detail-crate-ropes', 'detail-crate-small']) MODEL_MAP[n] = [KIT_RETRO, n];
// ステージ設定 parts で 柱/床/壁/窓 をレトロキットのモデルへ差し替え（null=既定のfantasyキット）
const PART_CANDIDATES = {
  pillar: ['column', 'column-damaged', 'column-paint', 'column-paint-damaged', 'column-wood'],
  floor: ['floor', 'floor-flat', 'wood-floor'],
  wall: ['wall', 'wall-detail', 'wall-half', 'wall-fortified', 'wall-fortified-paint', 'wall-pane-wood', 'structure-wall'],
  window: ['wall-window', 'wall-fortified-window', 'wall-fortified-paint-window', 'wall-pane-window', 'wall-pane-wood-window'],
};
// 外装パーツ設定：全体(global) と ゾーン別(zones)。ゾーン＝階（2階建て/地下）または棟（本館0/別棟1）
const PART_KEYS = ['pillar', 'floor', 'wall', 'window'];
const PART_CFG = { global: {}, zones: {} };   // {key: {name, rot}}（name=null は既定モデルで回転のみ）
function applyPartMap(parts) {
  if (!parts) return;
  const norm = (v) => (typeof v === 'string') ? { name: v, rot: 0 } : { name: v.name || null, rot: v.rot || 0 };
  if (parts.global || parts.zones) {
    for (const k of PART_KEYS) if (parts.global?.[k]) PART_CFG.global[k] = norm(parts.global[k]);
    for (const [z, m] of Object.entries(parts.zones || {})) {
      PART_CFG.zones[z] = {};
      for (const k of PART_KEYS) if (m[k]) PART_CFG.zones[z][k] = norm(m[k]);
    }
  } else {
    for (const k of PART_KEYS) if (parts[k]) PART_CFG.global[k] = norm(parts[k]);   // 旧形式（フラット）
  }
}
function partOvOf(kind, zone) { return (PART_CFG.zones[zone] && PART_CFG.zones[zone][kind]) || PART_CFG.global[kind] || null; }
function partRefOf(kind, zone) {
  const o = partOvOf(kind, zone);
  if (o && o.name) return [KIT_RETRO, o.name];
  return MODEL_MAP[kind] || [KIT_FURN, kind];
}
function partRotOf(kind, zone) { const o = partOvOf(kind, zone); return o ? (o.rot || 0) * Math.PI / 2 : 0; }
const partRefCache = new Map();   // "dir|file" → {obj, size}
async function ensurePartRef(ref) {
  const key = ref[0] + '|' + ref[1];
  if (partRefCache.has(key)) return partRefCache.get(key);
  let part = null;
  try { part = await loadPart(ref[0], ref[1]); } catch (e) { console.warn('モデル読込失敗:', ref[1], e.message); }
  partRefCache.set(key, part);
  return part;
}
function partOf(kind, zone) { return partRefCache.get(partRefOf(kind, zone).join('|')) || partsCache[kind]; }
const partsCache = {};
async function ensurePart(name) {
  if (partsCache[name]) return partsCache[name];
  const [dir, file] = MODEL_MAP[name] || [KIT_FURN, name];
  try { partsCache[name] = await loadPart(dir, file); } catch (e) { console.warn('モデル読込失敗:', name, e.message); }
  return partsCache[name];
}
// アイテム1個の配置（セル→ワールド）。インスタンス描画とステージ編集の両方で使う共通計算。
function itemPlacement(it) {
  const yB = (it.level || 0) * STORY_H;   // 2階の家具は上へ
  if (it.model === 'stair') {   // 階段：セグメント0=床→半階 / 1=半階→1階
    return { x: it.x * TILE, y: yB + (it.seg ? wallH : 0), z: it.z * TILE, ry: (it.ry || 0) + STAIR_RY, sx: SCALE, sy: SCALE, sz: SCALE, ox: 0, oz: 0 };
  }
  let y = it.y || 0, sc = SCALE, sy = 1, ox = 0, oz = 0;
  if (it.furn || it.model === 'plant') { sc = FURN_S; }
  else if (it.model === 'rug') { y = 0.02; }
  else if (it.model === 'chandelier') {
    // 原点が下端のモデルなので、上端が天井に付く高さへ（上階の床への突き抜け防止）
    const ph = ((partsCache.chandelier?.size?.y) || 0.35) * FURN_S;
    y = (it.ceil || 2) * wallH - ph - 0.02; sc = FURN_S;
  }
  else if (it.wainscot) { y = 0; sy = 0.42; ox = Math.sin(it.ry || 0) * 0.07; oz = Math.cos(it.ry || 0) * 0.07; }
  if (it.toCeil) sy = 2;
  return { x: it.x * TILE + ox, y: y + yB, z: it.z * TILE + oz, ry: (it.ry || 0) + (it.model === 'pillar' ? partRotOf('pillar', it.zone ?? it.level ?? 0) : 0), sx: sc, sy: sc * sy, sz: sc, ox, oz };
}
// アイテム（家具・柱・燭台等）のインスタンス群を dg.items から作り直す（ステージ編集後の反映にも使う）
const itemGroup = new THREE.Group();
scene.add(itemGroup);
async function rebuildItemInstances() {
  for (const o of [...itemGroup.children]) { itemGroup.remove(o); }
  const need = new Set();
  for (const it of dg.items) if (it.model !== 'painting') need.add(it.model);
  await Promise.all([...need].map((n) => ensurePart(n)));
  const zset = new Set([0]);
  for (const it of dg.items) if (it.model === 'pillar') zset.add(it.zone ?? it.level ?? 0);
  await Promise.all([...zset].map((z) => ensurePartRef(partRefOf('pillar', z))));
  const buckets = new Map();
  const push = (kind, m) => { if (!buckets.has(kind)) buckets.set(kind, []); buckets.get(kind).push(m); };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _sv = new THREE.Vector3();
  for (const it of dg.items) {
    if (it.model === 'painting') continue;
    const pl = itemPlacement(it);
    _p.set(pl.x, pl.y, pl.z);
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.ry);
    _sv.set(pl.sx, pl.sy, pl.sz);
    push(it.model + '|' + (it.level || 0) + '|' + (it.zone ?? it.level ?? 0), _m.compose(_p, _q, _sv).clone());
  }
  // 家具は種類が多く（実測54種）、種類ごとに InstancedMesh を作ると (ジオメトリ×マテリアル) の
  // 組が増えて起動時のシェーダ構築が膨らむ。マテリアル単位でジオメトリを1つに焼き込み、
  // 描画オブジェクトを組の数まで減らす（インスタンス化の利点よりシェーダ構築の削減が効く）。
  const merged = new Map();   // (マテリアル×階) → 統合待ちのジオメトリ配列
  const mm = new THREE.Matrix4();
  for (const [bkey, mats] of buckets) {
    const seg = bkey.split('|');
    const kind = seg[0], blv = +(seg[1] || 0), bzn = seg[2] != null ? +seg[2] : blv;
    const part = kind === 'pillar' ? partOf('pillar', bzn) : partsCache[kind];
    if (!part || !mats.length) continue;
    const overhead = kind === 'chandelier';   // 観察モードで隠す対象は混ぜない
    for (const sub of collectMeshes(part.obj)) {
      if (Array.isArray(sub.mat)) {   // マルチマテリアルは統合せずインスタンスのまま
        const inst = new THREE.InstancedMesh(sub.geo, sub.mat, mats.length);
        for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mm.multiplyMatrices(mats[i], sub.mat4));
        inst.instanceMatrix.needsUpdate = true; inst.frustumCulled = false;
        inst.userData.level = blv;
        if (overhead) inst.userData.overhead = true;
        itemGroup.add(inst); continue;
      }
      const key = sub.mat.uuid + (overhead ? '|oh' : '') + '|L' + blv;
      if (!merged.has(key)) merged.set(key, { mat: sub.mat, overhead, lv: blv, geos: [] });
      const bucket = merged.get(key).geos;
      for (const m of mats) bucket.push(sub.geo.clone().applyMatrix4(mm.multiplyMatrices(m, sub.mat4)));
    }
  }
  for (const { mat, overhead, lv, geos } of merged.values()) {
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geo) { for (const g of geos) { const mh = new THREE.Mesh(g, mat); mh.frustumCulled = false; mh.userData.level = lv; if (overhead) mh.userData.overhead = true; itemGroup.add(mh); } continue; }
    if (geos.length > 1) for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.userData.level = lv;
    if (overhead) mesh.userData.overhead = true;
    itemGroup.add(mesh);
  }
}
function setGoalCell(cx, cz) {
  dg.goal = { x: cx, z: cz, level: dg.goal?.level || 0 };
  if (goalMesh) goalMesh.position.set(cx * TILE, (dg.goal.level || 0) * STORY_H + 1.6, cz * TILE);
  if (goalLight) goalLight.position.copy(goalMesh.position);
}

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
    pane.position.set(s.x * TILE, wallH * 0.62 + (s.level || 0) * STORY_H, s.z * TILE);
    pane.userData.level = s.level || 0;
    pane.rotation.y = horiz ? 0 : Math.PI / 2;
    scene.add(pane);
  }
  // 窓際の光だまり（数を絞る）
  for (let i = 0; i < wins.length; i += Math.max(1, Math.floor(wins.length / 4))) {
    const s = wins[i];
    const inX = Math.sign(dg.w / 2 - s.x), inZ = Math.sign(dg.d / 2 - s.z);
    const l = new THREE.PointLight(0x88aaff, 5.5, 9, 1.2);
    l.position.set((s.x + inX * 0.6) * TILE, 1.9 + (s.level || 0) * STORY_H, (s.z + inZ * 0.6) * TILE);
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
  g.position.set(it.x * TILE + (it.nx || 0) * 0.09, (it.y || 1.7) + (it.level || 0) * STORY_H, it.z * TILE + (it.nz || 0) * 0.09);
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
    // 壁が触れる両側のセルに登録（階層別）
    for (const [ox, oz] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
      const k = (s.level || 0) + ':' + Math.round(s.x + ox) + ',' + Math.round(s.z + oz);
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
  player.pos.set(dg.spawn.x * TILE, (dg.spawn.level || 0) * STORY_H + EYE_H, dg.spawn.z * TILE);
  player.vel.set(0, 0, 0); player.yaw = 0; player.pitch = 0;
}

// ── 多層基盤：階の高さ・階段・階層別の通行/接地 ──
let STORY_H = 4;                    // 1階ぶんの高さ（buildDungeon で壁高×2に確定）
const STAIR_RY = -Math.PI / 2;      // 階段モデルの向き補正（stairs-wide-stone はローカル+X方向へ上る形状）
const stairByCell = new Map();      // 'cx,cz' → {x,z,dx,dz,base}
function lvlOfY(y) { const n = dg?.floors || 1; return Math.max(0, Math.min(n - 1, Math.round(y / STORY_H))); }
// グリッド当たり：足元セル周辺の岩盤を AABB として円(半径BODY_R)を押し出す
function cellSolidAt(lvl, cx, cz) {
  if (cx < 0 || cz < 0 || cx >= dg.w || cz >= dg.d) return true;
  if (stairByCell.has(cx + ',' + cz)) return false;   // 階段セルは常に通行可（高さは floorYAt が受け持つ）
  if (typeof doorSolidAt === 'function' && doorSolidAt(cx, cz)) return true;   // 閉じた扉はセルを塞ぐ
  const g = dg.grids ? dg.grids[Math.max(0, Math.min(dg.grids.length - 1, lvl))] : dg.grid;
  return g[cz * dg.w + cx] === SOLID;
}
function cellSolid(cx, cz) { return cellSolidAt(0, cx, cz); }
// その場所の床の高さ。階段セルは入口→2セル先へ1階ぶんのスロープ。それ以外は「今の高さから届く一番高い床」
function floorYAt(wx, wz, curY) {
  const cx = Math.round(wx / TILE), cz = Math.round(wz / TILE);
  const st = stairByCell.get(cx + ',' + cz);
  if (st) {
    const ex = st.x * TILE - st.dx * TILE * 0.5, ez = st.z * TILE - st.dz * TILE * 0.5;   // 入口セルの手前端
    const u = Math.max(0, Math.min(1, ((wx - ex) * st.dx + (wz - ez) * st.dz) / (TILE * 2)));
    return (st.base || 0) * STORY_H + u * STORY_H;
  }
  const levels = dg.grids ? dg.grids.length : 1;
  const maxRef = (curY == null ? 1e9 : curY) + 0.6;
  let best = 0;
  for (let l = 0; l < levels; l++) {
    const g = dg.grids ? dg.grids[l] : dg.grid;
    if (cx >= 0 && cz >= 0 && cx < dg.w && cz < dg.d && g[cz * dg.w + cx] !== SOLID) {
      const y = l * STORY_H;
      if (y <= maxRef && y >= best) best = y;
    }
  }
  return best;
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
  const lv = lvlOfY(player.pos.y - EYE_H);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const gx = cx + dx, gz = cz + dz;
    if (cellSolidAt(lv, gx, gz)) pushOutAABB(gx * TILE - TILE / 2, gx * TILE + TILE / 2, gz * TILE - TILE / 2, gz * TILE + TILE / 2);
    const segs = segsByCell.get(lv + ':' + gx + ',' + gz);   // 部屋の囲い壁など、セル境界に立つ薄い壁
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
// 吸血中は画面の縁が薄赤く染まる（吸われるほど濃く・鼓動のように脈打つ）
let vignetteEl = null, vignetteA = 0, vignetteT = 0;
function updateVignette(dt, captured) {
  if (!vignetteEl) {
    vignetteEl = document.createElement('div');
    vignetteEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:15;opacity:0;'
      + 'background:radial-gradient(ellipse at center, rgba(150,0,25,0) 52%, rgba(150,0,25,0.42) 82%, rgba(120,0,20,0.72) 100%);';
    document.body.appendChild(vignetteEl);
  }
  vignetteT += dt;
  const pulse = captured ? Math.sin(vignetteT * 5.2) * 0.08 : 0;
  const target = captured ? Math.min(1, 0.45 + 0.55 * (drain / 100)) + pulse : 0;   // 危険度が上がるほど濃く
  vignetteA += (target - vignetteA) * Math.min(1, dt * (captured ? 6 : 3));
  vignetteEl.style.opacity = Math.max(0, Math.min(1, vignetteA)).toFixed(3);
}
function updateCaptureView(dt) {
  const captured = vamp.ready && vamp.state === 'capture' && phase === 'playing';
  torch.intensity += ((captured ? 0.35 : 6.5) - torch.intensity) * Math.min(1, dt * 5);
  updateVignette(dt, captured);
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
  if (memoOpen) { syncCamera(); return; }   // メモ閲覧中は停止（カーソル表示）
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
  // 床（多層：その場の床高＝階段はスロープ）
  const gy = floorYAt(player.pos.x, player.pos.z, player.pos.y - EYE_H);
  if (player.pos.y <= gy + EYE_H) { player.pos.y = gy + EYE_H; player.vel.y = 0; player.onFloor = true; }
  else player.onFloor = false;

  syncCamera();
}

// ── 入力（PC） ──
const canvas = renderer.domElement;
canvas.addEventListener('click', () => {
  if (cutscene.on) { const f = cutscene.advance; cutscene.advance = null; if (f) f(); return; }   // 会話送り
  if (!touchMode && phase === 'playing' && !obs.on && !edit.on) canvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => { isLocked = document.pointerLockElement === canvas; });
addEventListener('mousedown', (e) => {
  if (e.button === 0 && isLocked && phase === 'playing') fireShot();
  if (e.button === 2 && isLocked && phase === 'playing' && heldWeapon() === 'shockgun' && !cutscene.on) tryShockGrab();
});
addEventListener('mouseup', (e) => { if (e.button === 2) shockRelease(); });
addEventListener('contextmenu', (e) => { if (isLocked) e.preventDefault(); });
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
// 職員の発砲音（プレイヤーからの距離で減衰。cloneで同時発砲も重ねて鳴る）
let gunAudio = null;
function initGunAudio() {
  const a = new Audio();
  a.src = '../sound/Gunshot01.ogg';
  a.addEventListener('error', () => { if (!a.src.endsWith('./sound/Gunshot01.ogg')) a.src = './sound/Gunshot01.ogg'; }, { once: true });
  a.preload = 'auto';
  gunAudio = a;
}
function playGunshot(fromPos) {
  if (!gunAudio) return;
  const d = Math.hypot(fromPos.x - player.pos.x, fromPos.y - player.pos.y, fromPos.z - player.pos.z);
  const a = gunAudio.cloneNode();
  a.volume = Math.max(0.1, Math.min(1, 1 - d / 30));
  a.play().catch(() => { /* 自動再生制限 */ });
}
function playKiss() { if (kissAudio.el && !kissAudio.playing) { kissAudio.playing = true; kissAudio.el.play().catch(() => {}); } }
function stopKiss() { if (kissAudio.el && kissAudio.playing) { try { kissAudio.el.pause(); kissAudio.el.currentTime = 0; } catch {} } kissAudio.playing = false; }

const vamp = {
  vrm: null, mixer: null, action: null, clips: {}, cape: null, root: null,
  state: 'patrol', path: null, seg: 0, repathT: 0, stunT: 0, ready: false,
  grabState: null, grabBone: null, rdRecover: 0, ragdoll: null, inactive: false,   // ショックガン/出現トリガー用（未初期化だとガードが誤作動する）
  hips: null, head: null, footL: null, footR: null,
};
const bodyFwd = new THREE.Vector3(0, 0, 1);   // モデル前方（npcRoot相対・ry補正込み）
const headFace = new THREE.Vector3(0, 0, 1);
let nav = null;

function dataURIToBlob(uri) { const [head, data] = uri.split(','); const bin = atob(data); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream' }); }
async function fetchFirst(urls, asJson) {
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      // 開発サーバは存在しないパスに index.html を 200 で返すことがある。
      // JSON なら JSON.parse が弾くが、バイナリは中身を見ないと気づけないので content-type で判定する。
      if (!asJson && /text\/html/i.test(r.headers.get('content-type') || '')) continue;
      return asJson ? JSON.parse(await r.text()) : await r.arrayBuffer();
    } catch { /* next */ }
  }
  return null;
}
// NPCバンドルの読み込み。scripts/split-npc.mjs で切り出した <name>.meta.json + <name>.vrm があれば
// そちらを使う（base64 埋め込みの .npc.json より 25% 小さく、巨大JSONのパースと atob が要らない）。
// 無ければ従来どおり .npc.json を読む。返り値の vrmUrl はそのまま GLTFLoader に渡せる。
async function loadNpcBundle(name, dirs) {
  const at = (f) => dirs.map((d) => d + f);
  const meta = await fetchFirst(at(name + '.meta.json'), true);
  if (meta) {
    const bin = async (key) => {
      const rel = meta[key + 'Url'];
      if (!rel) return null;
      const buf = await fetchFirst(at(rel.replace(/^\.\//, '')), false);
      return buf ? URL.createObjectURL(new Blob([buf])) : null;
    };
    const [vrmUrl, vrmaUrl] = await Promise.all([bin('vrm'), bin('vrma')]);
    if (vrmUrl) return { ...meta, vrmUrl, vrmaUrl };
  }
  const bundle = await fetchFirst(at(name + '.npc.json'), true);
  if (!bundle) return null;
  return {
    ...bundle,
    vrmUrl: bundle.vrm ? URL.createObjectURL(dataURIToBlob(bundle.vrm)) : null,
    vrmaUrl: bundle.vrma ? URL.createObjectURL(dataURIToBlob(bundle.vrma)) : null,
  };
}

async function loadVamp() {
  setStatus('JOY_vamp 読み込み中…');
  const bundle = await loadNpcBundle('JOY_vamp', ['./', '../npc/']);
  if (!bundle || !bundle.vrmUrl) { console.warn('JOY_vamp のモデルが読めません'); return; }
  const gl = new GLTFLoader();
  gl.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
  const gltf = await gl.loadAsync(bundle.vrmUrl);
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
  hdrReady.then(applyCapeEnv);   // HDRは外部サイトから取るので待たない（届いた時点でマントに適用）
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
  const vy = vamp.root.position.y;
  if (vampFree(nx, nz, vy)) { vamp.root.position.x = nx; vamp.root.position.z = nz; return move; }
  if (vampFree(nx, pz, vy)) { vamp.root.position.x = nx; return Math.abs(_fw.x * move); }
  if (vampFree(px, nz, vy)) { vamp.root.position.z = nz; return Math.abs(_fw.z * move); }
  return 0;
}
function vampFree(wx, wz, wy = 0) {
  const cx = Math.round(wx / TILE), cz = Math.round(wz / TILE);
  const lv = lvlOfY(wy);
  if (cellSolidAt(lv, cx, cz)) return false;
  const segs = segsByCell.get(lv + ':' + cx + ',' + cz);
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
function vampCell() { return { x: Math.round(vamp.root.position.x / TILE), z: Math.round(vamp.root.position.z / TILE), level: lvlOfY(vamp.root.position.y) }; }
function playerCell() { return { x: Math.round(player.pos.x / TILE), z: Math.round(player.pos.z / TILE), level: lvlOfY(player.pos.y - EYE_H) }; }
function repath(to) {
  const from = vampCell();
  const p = findPath(nav, from, to);
  vamp.path = (p && p.length > 1) ? p : null; vamp.seg = 1;
}
function canSeePlayer() {
  const a = vampCell(), b = playerCell();
  const dist = Math.hypot(player.pos.x - vamp.root.position.x, (player.pos.y - EYE_H) - vamp.root.position.y, player.pos.z - vamp.root.position.z);
  if (dist < VAMP.hearRange && a.level === b.level) return true;   // 近ければ壁越しでも気配で分かる（同じ階のみ）
  if (dist > VAMP.sightRange) return false;
  return hasLineOfSight(nav, a.x, a.z, b.x, b.z, a.level, b.level);
}
function updateVamp(dt) {
  if (!vamp.ready || phase !== 'playing') return;
  if (vamp.inactive) { if (vamp.vrm && vamp.vrm.scene.visible) vamp.vrm.scene.visible = false; return; }   // 出現トリガー待ち
  if (vamp.grabState) return;   // ショックガンで掴まれている（ラグドール駆動）
  if (vamp.rdRecover > 0) {
    vamp.rdRecover -= dt;
    if (vamp.rdRecover <= 0 && vamp.ragdoll) {
      // 倒れた位置から復帰：腰粒子の位置へルートを合わせてからラグドール解除
      const hi = vamp.ragdoll.idxOf?.hips;
      if (hi != null && vamp.ragdoll.particles?.[hi]) {
        const hp = vamp.ragdoll.particles[hi].pos;
        vamp.root.position.x = hp.x; vamp.root.position.z = hp.z;
        vamp.root.position.y = floorYAt(hp.x, hp.z, hp.y);
      }
      setRagdollActive(vamp.ragdoll, false);
      vamp.stunT = 1.4; vamp.state = 'stunned'; vamp.path = null;
      capeSettle(0.4);
    }
    return;
  }
  const distToPlayer = Math.hypot(player.pos.x - vamp.root.position.x, (player.pos.y - EYE_H) - vamp.root.position.y, player.pos.z - vamp.root.position.z);

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
  stuckRescue(vamp, vamp.root.position, dt, () => { vamp.path = null; vamp.repathT = 0; });

  const sees = canSeePlayer();
  // 職員（ken）も獲物：視界内で最も近い者を狙う
  let prey = null, preyDist = Infinity;
  const vc = vampCell();
  for (const m of kens) {
    if (!kenAlive(m)) continue;
    const d = Math.hypot(m.vrm.scene.position.x - vamp.root.position.x, m.vrm.scene.position.y - vamp.root.position.y, m.vrm.scene.position.z - vamp.root.position.z);
    if (d > VAMP.sightRange) continue;
    const kc = kenCell(m);
    if (d > VAMP.hearRange && !hasLineOfSight(nav, vc.x, vc.z, kc.x, kc.z, vc.level, kc.level)) continue;
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

// ステージ編集の保存（public/vamp_param/mansion-stage.json）。seed で外殻を再現し items/goal を上書き。
let stageCfg = null;
async function loadStageCfg() {
  for (const u of ['./mansion-stage.json', '../vamp_param/mansion-stage.json']) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j && j.seed != null) { stageCfg = j; return true; } } catch { /* next */ }
  }
  return false;
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
  if (vampFree(nx, nz, vamp.root.position.y)) { vamp.root.position.x = nx; vamp.root.position.z = nz; }
  // 縦寄せ（ar-vampire と同じ lean）。これが無いと彼女が見上げる形になり、AR版と見え方が変わる。
  vamp.root.position.y += (_ktar.y - _mouth.y) * KISS.lean * k;
  vamp.root.position.y = Math.max((vamp.groundY || 0) - 0.15, Math.min((vamp.groundY || 0) + 0.9, vamp.root.position.y));   // 床から極端に浮き沈みしない
}
// 捕縛が解けたら足元をその場の床へ戻す（階段・2階に追従）
function relaxVampY(dt) {
  const g = floorYAt(vamp.root.position.x, vamp.root.position.z, vamp.root.position.y);
  vamp.groundY = g;
  const d = g - vamp.root.position.y;
  if (Math.abs(d) < 1e-4) return;
  vamp.root.position.y += d * Math.min(1, dt * 5);
}
// 首をプレイヤーへ向ける（ar-vampire の applyHeadLook 方式・角度制限つき）
const _hq = new THREE.Quaternion(), _hqD = new THREE.Quaternion(), _hqP = new THREE.Quaternion(), _hf = new THREE.Vector3(), _hd = new THREE.Vector3();
// 首の可動域（体の正面基準）。目線は VRM の lookAt が担い、首より広い範囲を追える
const NECK_LIMIT = { yaw: 1.22, up: 0.52, down: 0.7 };   // ヨー±70° / 上30° / 下40°
const _bfw2 = new THREE.Vector3(), _bq3 = new THREE.Quaternion();
function headLook(w) {
  if (!vamp.head || w <= 0) return;
  vamp.head.getWorldPosition(_hp2);
  const tgt = (vamp.state === 'holdKen' && vamp.holding) ? _kpin : player.pos;   // 獲物を吸っている間はそちらを見る
  // 目線ターゲット：VRM の lookAt が目の可動域内で追う（首がクランプされても目だけは向く）
  if (vamp.vrm?.lookAt) {
    if (!vamp.eyeTgt) { vamp.eyeTgt = new THREE.Object3D(); scene.add(vamp.eyeTgt); vamp.vrm.lookAt.target = vamp.eyeTgt; }
    vamp.eyeTgt.position.set(tgt.x, tgt.y, tgt.z);
  }
  _hd.set(tgt.x - _hp2.x, tgt.y - _hp2.y, tgt.z - _hp2.z);
  if (_hd.lengthSq() < 1e-8) return;
  _hd.normalize();
  // 体の正面を基準にヨー/ピッチをクランプ＝真後ろへは向かない
  vamp.root.getWorldQuaternion(_bq3);
  _bfw2.copy(bodyFwd).applyQuaternion(_bq3); _bfw2.y = 0; _bfw2.normalize();
  const bodyYaw = Math.atan2(_bfw2.x, _bfw2.z);
  let dyaw = Math.atan2(_hd.x, _hd.z) - bodyYaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  dyaw = Math.max(-NECK_LIMIT.yaw, Math.min(NECK_LIMIT.yaw, dyaw));
  const pitch = Math.max(-NECK_LIMIT.down, Math.min(NECK_LIMIT.up, Math.asin(Math.max(-1, Math.min(1, _hd.y)))));
  const yaw2 = bodyYaw + dyaw, cp = Math.cos(pitch);
  _hd.set(Math.sin(yaw2) * cp, Math.sin(pitch), Math.cos(yaw2) * cp);
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
    const bundle = await loadNpcBundle('ken', ['./', '../npc/']);
    if (!bundle || !bundle.vrmUrl) return false;
    kenAssets.vrmBlobUrl = bundle.vrmUrl;
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
  kvrm.scene.position.set(cell.x * TILE, (cell.level || 0) * STORY_H, cell.z * TILE);
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
  for (const r of rs) { try { await spawnKen({ x: r.cx, z: r.cz, level: r.level || 0 }); } catch (e) { console.warn('ken spawn失敗:', e.message); } }
}

function kenCell(m) { return { x: Math.round(m.vrm.scene.position.x / TILE), z: Math.round(m.vrm.scene.position.z / TILE), level: lvlOfY(m.vrm.scene.position.y) }; }
// 壁ずり移動：進めない時は軸ごとに滑る（壁・角で完全停止しない）
function kenMove(m, dx, dz) {
  const pos = m.vrm.scene.position;
  const nx = pos.x + dx, nz = pos.z + dz;
  const follow = () => { pos.y += (floorYAt(pos.x, pos.z, pos.y) - pos.y) * 0.35; };   // 階段・2階の床に足を合わせる
  if (vampFree(nx, nz, pos.y)) { pos.x = nx; pos.z = nz; follow(); return true; }
  if (vampFree(nx, pos.z, pos.y)) { pos.x = nx; follow(); return true; }
  if (vampFree(pos.x, nz, pos.y)) { pos.z = nz; follow(); return true; }
  // 完全に詰まった（壁の角にめり込み等）：自セル中心へ少しずつ押し戻して脱出させる
  const cx = Math.round(pos.x / TILE) * TILE, cz = Math.round(pos.z / TILE) * TILE;
  const ex = cx - pos.x, ez = cz - pos.z;
  const el = Math.hypot(ex, ez);
  if (el > 0.03) { pos.x += ex / el * 0.02; pos.z += ez / el * 0.02; }
  return false;
}
// 動けなくなった歩行者の救済：2.5秒間ほぼ動いていなければ、経路を捨てて床高を合わせ、
// 階段セル上なら近い方の端（下=入口/上=着地）へ寄せて再探索させる
function stuckRescue(ent, pos, dt, clearPath) {
  ent._stk = ent._stk || { x: pos.x, z: pos.z, t: 0 };
  const st = ent._stk;
  st.t += dt;
  if (Math.hypot(pos.x - st.x, pos.z - st.z) > 0.12) { st.x = pos.x; st.z = pos.z; st.t = 0; return; }
  if (st.t < 2.5) return;
  st.t = 0; st.x = pos.x; st.z = pos.z;
  const cx = Math.round(pos.x / TILE), cz = Math.round(pos.z / TILE);
  const sc = stairByCell.get(cx + ',' + cz);
  if (sc) {   // 階段の途中で詰まった：高さに応じて入口 or 着地セルの中心へ寄せる
    const base = (sc.base || 0) * STORY_H;
    const up = pos.y > base + STORY_H * 0.5;
    const ex = up ? sc.x + 2 * sc.dx : sc.x - sc.dx, ez = up ? sc.z + 2 * sc.dz : sc.z - sc.dz;
    pos.x = ex * TILE; pos.z = ez * TILE;
  }
  pos.y = floorYAt(pos.x, pos.z, pos.y + 0.5);
  clearPath();
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
    m.dis.setPuddleCenter(c.x, c.z);
    m.dis.setGroundY(floorYAt(c.x, c.z, c.y) + 0.02);   // その階の床上面のわずか上＝Z-fight回避
    try { m.dis.recenter(); } catch { /* noop */ }   // 倒れた後の実バウンディングで溶かす
  }
}
function removeKen(m) {
  m._remove = true;
  if (m.eyeTgt) scene.remove(m.eyeTgt);
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
  const vd = Math.hypot(vamp.root.position.x - pos.x, vamp.root.position.y - pos.y, vamp.root.position.z - pos.z);

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
    updateRagdoll(m.ragdoll, dt, { floorY: floorYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y), pinBone: m.pinBone || 'neck', pinPos: _kpin });
    if (m.speech) { m.speech.onState('downed'); m.speech.update(dt); }
    m.vrm.update(dt);
    return;
  }
  if (m.state === 'downed') {
    // 吸い尽くされた：ラグドールのまま床へ落ち、崩れて落ち着いたらその場でディソルブ（CityFlyのken方式）
    if (!m._dropped) {   // 手榴弾とライフルを落とす
      m._dropped = true;
      dropGrenadeAt(pos.x + 0.4, pos.z + 0.3, pos.y);
      dropPropAt('rifle', pos.x - 0.4, pos.z - 0.2, pos.y);
    }
    m.downT = (m.downT || 0) + dt;
    const fy = floorYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y);
    updateRagdoll(m.ragdoll, dt, { floorY: fy });
    m.vrm.update(dt);
    if (m.downT > 0.8) {
      let low = Infinity;
      for (const pt of m.ragdoll.particles) if (pt.pos.y < low) low = pt.pos.y;
      if (low - fy < 0.22 || m.downT > 4) { setRagdollActive(m.ragdoll, false); startKenDissolve(m); }
    }
    return;
  }
  if (m.recoverT > 0) {   // 解放後：しばらくラグドールのまま倒れて回復
    m.recoverT -= dt;
    updateRagdoll(m.ragdoll, dt, { floorY: floorYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y) });
    m.vrm.update(dt);
    if (m.recoverT <= 0) { setRagdollActive(m.ragdoll, false); m.state = 'patrol'; m.path = null; }
    return;
  }

  // ── 行動：彼女が近い→逃走 / 射程内→発砲 / それ以外→巡回 ──
  stuckRescue(m, pos, dt, () => { m.path = null; m.patrolTo = null; m.fleeRepathT = 0; });
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
        const d = Math.hypot(r.cx * TILE - vamp.root.position.x, (r.level || 0) * STORY_H - vamp.root.position.y, r.cz * TILE - vamp.root.position.z);
        if (d > bd) { bd = d; best = r; }
      }
      const pth = best ? findPath(nav, kenCell(m), { x: best.cx, z: best.cz, level: best.level || 0 }) : null;
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
      if (hasLineOfSight(nav, a.x, a.z, bcell.x, bcell.z, a.level, bcell.level)) {
        m.shootCd = KEN.shootCd + Math.random() * 2;
        staffShoot(m);
      }
    }
    // 巡回
    m.repathT -= dt;
    if (!m.path || m.repathT <= 0) {
      m.repathT = 3 + Math.random() * 2;
      if (!m.patrolTo || Math.random() < 0.3) { const r = dg.rooms[(Math.random() * dg.rooms.length) | 0]; m.patrolTo = { x: r.cx, z: r.cz, level: r.level || 0 }; }
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
  // 目線：彼女が近い/逃走中は VRM の lookAt で目だけ追う（首は体の向きのまま＝可動域の狭い順）
  if (m.vrm.lookAt) {
    if (!m.eyeTgt) { m.eyeTgt = new THREE.Object3D(); scene.add(m.eyeTgt); m.vrm.lookAt.target = m.eyeTgt; }
    if ((m.state === 'flee' || vd < 8) && vamp.head) vamp.head.getWorldPosition(m.eyeTgt.position);
    else m.eyeTgt.position.set(pos.x + Math.sin(m.faceYaw) * 3, pos.y + 1.35, pos.z + Math.cos(m.faceYaw) * 3);
  }
  if (m.action) m.action.timeScale = Math.max(0.25, speed / 1.4);
  if (m.mixer) m.mixer.update(dt);
  // 口パク（viseme）は vrm.update の前に適用（npc-speech の設計順）
  if (m.speech) { m.speech.onState(m.state === 'flee' ? 'flee' : 'idle'); m.speech.update(dt); }
  m.vrm.update(dt);
}

// 職員の発砲：彼女を硬直させる（ビームの見た目は既存 shotFx を流用）
function staffShoot(m) {
  playGunshot(m.vrm.scene.position);
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

function pickPatrol() {   // 屋敷の中を「生活」して巡回：部屋とゴール周辺をランダムに巡る（全階）
  const r = dg.rooms[(Math.random() * dg.rooms.length) | 0];
  return { x: r.cx, z: r.cz, level: r.level || 0 };
}

// ── プレイヤーのショット（ヒットスキャン。当てると硬直） ──
const shotFx = [];
function fireShot() {
  if (phase !== 'playing' || !vamp.ready || cutscene.on) return;
  if (!heldWeapon()) return;   // ライフルかショックガンを持っている時だけ撃てる
  playGunshot(player.pos);
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
function win(reason) { if (won) return; won = true; phase = 'win'; achSet('clear', true); document.exitPointerLock?.(); showOverlay('ESCAPED', reason, '#8f8'); }
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
let overheadVis = true;
const floorVis = [];   // エディタの「表示階」。空=全階表示
function applyVisibility() {
  const groups = [dungeonGroup, itemGroup];
  if (edit.group) groups.push(edit.group);
  if (edit.trigGroup) groups.push(edit.trigGroup);
  for (const g of groups) {
    g.traverse((o) => {
      let lv = o.userData.level;
      if (lv == null && o.userData.item) lv = o.userData.item.level || 0;
      if (lv == null && !o.userData.overhead) return;
      let v = true;
      if (o.userData.overhead && !overheadVis) v = false;
      if (lv != null && floorVis.length && floorVis[lv] === false) v = false;
      o.visible = v;
    });
  }
  for (const pr of props) pr.mesh.visible = !(floorVis.length && floorVis[pr.data.level || 0] === false);
  for (const dr of doorObjs) dr.group.visible = !(floorVis.length && floorVis[dr.data.level || 0] === false);
}
function setOverheadVisible(v) { overheadVis = v; applyVisibility(); }
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
  cv.addEventListener('mousedown', (e) => { if (obs.on && !edit.busy) { obs.drag = e.button === 2 ? 2 : 1; obs.lx = e.clientX; obs.ly = e.clientY; } });
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


// ══════════ ステージ編集モード（観察カメラの上に構築。パーツ移動/回転・等間隔配置・ユニット・ゴール移動） ══════════
const edit = { on: false, busy: false, sel: [], gizmo: null, group: null, snap: true, mode: 'translate', helpers: new Map(), hover: null, drag: null, altDown: false, ptr: null, lights: null, fogSave: null, paletteBuilt: false };

// トリガーボックスの編集用メッシュ（半透明箱・編集モードのみ）。ゲーム中はメッシュ自体を作らない
const trigMeshes = new Map();   // data → mesh
const TRIG_COLORS = { speech: 0x44aaff, bgm: 0xaa66ff, vampWake: 0xff5566, thunder: 0xffcc44, cutscene: 0x55dd88 };
function makeTriggerMesh(t) {
  if (!edit.trigGroup) return null;
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(TILE, 1.4, TILE),
    new THREE.MeshBasicMaterial({ color: TRIG_COLORS[t.event?.type] || 0x888888, transparent: true, opacity: 0.3, depthWrite: false }));
  m.scale.set(t.w || 1, 1, t.d || 1);
  m.position.set(t.x * TILE, (t.level || 0) * STORY_H + 0.7, t.z * TILE);
  m.userData.item = t;
  edit.trigGroup.add(m);
  trigMeshes.set(t, m);
  return m;
}
function trigRecolor(t) { const m = trigMeshes.get(t); if (m) m.material.color.setHex(TRIG_COLORS[t.event?.type] || 0x888888); }
function makeCsMarker(cs) {   // カットシーン地点マーカー（緑の円錐・編集モードのみ）
  if (!edit.trigGroup) return null;
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.0, 10), new THREE.MeshBasicMaterial({ color: 0x55dd88, transparent: true, opacity: 0.75 }));
  m.position.set(cs.x * TILE, (cs.level || 0) * STORY_H + 0.5, cs.z * TILE);
  m.userData.item = cs;
  edit.trigGroup.add(m);
  trigMeshes.set(cs, m);
  return m;
}
function buildTriggerMeshes() {
  trigMeshes.clear();
  for (const t of (dg.triggers || [])) makeTriggerMesh(t);
  for (const cs of (dg.cutscenes || [])) makeCsMarker(cs);
}

function editItemMesh(it) {   // 編集用の個別メッシュ（選択・ギズモ操作対象）
  const part = partsCache[it.model];
  if (!part) return null;
  const g = new THREE.Group();
  g.add(part.obj.clone(true));
  const pl = itemPlacement(it);
  g.position.set(pl.x, pl.y, pl.z);
  g.rotation.y = pl.ry;
  g.scale.set(pl.sx, pl.sy, pl.sz);
  g.userData.item = it;
  return g;
}
async function editEnter() {
  if (edit.on || !dg) return;
  edit.on = true;
  if (!obs.on) obsToggle(true);
  if (!edit.group) { edit.group = new THREE.Group(); scene.add(edit.group); }
  if (!edit.trigGroup) { edit.trigGroup = new THREE.Group(); scene.add(edit.trigGroup); }
  buildTriggerMeshes();
  // アイテムを個別メッシュ化（インスタンス表示は隠す）
  itemGroup.visible = false;
  for (const it of dg.items) {
    if (it.model === 'painting') continue;
    await ensurePart(it.model);
    const m = editItemMesh(it);
    if (m) edit.group.add(m);
  }
  if (!edit.gizmo) {
    edit.gizmo = new TransformControls(camera, renderer.domElement);
    edit.gizmo.addEventListener('dragging-changed', (e) => {
      edit.busy = e.value;
      if (e.value) editDragStart(); else { editWriteBack(); edit.drag = null; }
    });
    edit.gizmo.addEventListener('objectChange', () => editDragFollow());
    scene.add(edit.gizmo.getHelper ? edit.gizmo.getHelper() : edit.gizmo);
  }
  editApplySnap();
  const ov = $('overlay');
  if (ov) ov.style.display = 'none';   // スタート画面がキャンバスを覆うと選択も右クリックメニューも効かない
  // 全体が見えるようフラット照明へ（夜の演出照明・フォグは編集の邪魔）
  if (!edit.lights) {
    edit.lights = new THREE.Group();
    edit.lights.add(new THREE.AmbientLight(0xffffff, 1.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(30, 60, 20); edit.lights.add(dl);
  }
  scene.add(edit.lights);
  edit.fogSave = scene.fog; scene.fog = null;
  if (!edit.paletteBuilt) { edit.paletteBuilt = true; buildEditPalette(); }
  buildPartsUI();
  const fv = $('ed-floorvis');
  if (fv) {
    const n = dg.floors || 1;
    if (n > 1) {
      const names = dg.layout === 'basement' ? ['B1', '1F'] : ['1F', '2F'];
      fv.innerHTML = '表示階: ' + Array.from({ length: n }, (_, i) =>
        '<label style="margin-right:8px;cursor:pointer;"><input type="checkbox" data-fv="' + i + '" checked> ' + (names[i] || (i + 1) + 'F') + '</label>').join('');
      floorVis.length = 0; for (let i = 0; i < n; i++) floorVis.push(true);
      fv.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => { floorVis[+cb.dataset.fv] = cb.checked; applyVisibility(); }));
    } else { fv.innerHTML = ''; floorVis.length = 0; }
  }
  const achTa = $('ed-ach-events');
  if (achTa) achTa.value = JSON.stringify(dg.achEvents || []);
  $('edit-panel').style.display = 'block';
  setStatus('ステージ編集中：クリック=選択 / Shift+クリック=追加選択 / Alt+ドラッグ=複製 / G移動 R回転 / Del削除');
}
function editExit() {
  if (!edit.on) return;
  edit.on = false;
  editSelect(null);
  if (edit.lights) scene.remove(edit.lights);
  scene.fog = edit.fogSave;
  floorVis.length = 0; applyVisibility();
  if (phase !== 'playing') { const ov = $('overlay'); if (ov) ov.style.display = ''; }
  applyLighting();
  if (edit.hover) edit.hover.visible = false;
  if (edit.group) { for (const o of [...edit.group.children]) edit.group.remove(o); }
  if (edit.trigGroup) { for (const o of [...edit.trigGroup.children]) edit.trigGroup.remove(o); trigMeshes.clear(); }
  itemGroup.visible = true;
  rebuildItemInstances();
  $('edit-panel').style.display = 'none';
  setStatus('');
}
function editApplySnap() {
  if (!edit.gizmo) return;
  edit.gizmo.setTranslationSnap(edit.snap ? TILE / 2 : null);
  edit.gizmo.setRotationSnap(edit.snap ? Math.PI / 2 : null);
}
function editSetMode(m) {
  edit.mode = m;
  if (!edit.gizmo) return;
  edit.gizmo.setMode(m);
  if (m === 'rotate') { edit.gizmo.showX = false; edit.gizmo.showZ = false; edit.gizmo.showY = true; }
  else {   // 移動は床平面が基本。プロップ選択中はYも（机の上などに載せられる）
    const prim = edit.sel[edit.sel.length - 1];
    const isProp = !!(prim?.userData.item && dg.props?.includes(prim.userData.item));
    edit.gizmo.showX = true; edit.gizmo.showZ = true; edit.gizmo.showY = isProp;
  }
}
function editSelect(obj, additive) {
  if (!additive) {
    for (const o of edit.sel) { setEditHighlight(o, false); removeSelHelper(o); }
    edit.sel = [];
  }
  if (obj) {
    if (!edit.sel.includes(obj)) { edit.sel.push(obj); setEditHighlight(obj, true); addSelHelper(obj); }
  }
  const prim = edit.sel[edit.sel.length - 1] || null;
  if (edit.gizmo) { if (prim) { edit.gizmo.attach(prim); editSetMode(edit.mode); } else edit.gizmo.detach(); }
  const inf = $('edit-info');
  if (inf) inf.textContent = edit.sel.length === 0 ? '（未選択）'
    : edit.sel.length === 1 ? (prim === goalMesh ? '🏁 ゴール地点' : (prim.userData.item?.model || prim.userData.item?.id || '?'))
    : edit.sel.length + '個選択中';
  const csIt = prim?.userData.item;
  const csTa = $('ed-cs-script');
  if (csTa && csIt && dg.cutscenes?.includes(csIt)) {
    csTa.value = JSON.stringify({ actors: csIt.actors || [], script: csIt.script || [] }, null, 1);
    csTa.scrollIntoView({ block: 'center', behavior: 'smooth' });   // 長いパネルでも設定が見えるように
  }
  if (csIt && dg.triggers?.includes(csIt)) {
    const tp = $('ed-trig-type');
    if (tp) {
      tp.value = csIt.event?.type || 'speech';
      $('ed-trig-param').value = csIt.event?.text || csIt.event?.name || csIt.event?.id || '';
      $('ed-trig-w').value = csIt.w || 1; $('ed-trig-d').value = csIt.d || 1;
      tp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}
// マテリアルは同じ見た目のものを共有しているので、選択色を直接書くと同じ部材が全部光ってしまう。
// ハイライト中だけ複製に差し替え、解除で共有マテリアルへ戻す。
function setEditHighlight(obj, on) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (on) {
      if (o.userData._matOrg) return;
      o.userData._matOrg = o.material;
      const mk = (m) => { if (!m || !m.emissive) return m; const c = m.clone(); c.emissive.setHex(0x2255ff); return c; };
      o.material = Array.isArray(o.material) ? o.material.map(mk) : mk(o.material);
    } else if (o.userData._matOrg) {
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && m !== o.userData._matOrg) m.dispose();
      o.material = o.userData._matOrg;
      delete o.userData._matOrg;
    }
  });
}
// 選択枠（黄）とホバー枠（水色）。壁越しでも見えるよう depthTest を切る
function addSelHelper(obj) {
  if (edit.helpers.has(obj)) return;
  const h = new THREE.BoxHelper(obj, 0xffdd33);
  h.material.depthTest = false; h.renderOrder = 999;
  scene.add(h); edit.helpers.set(obj, h);
}
function removeSelHelper(obj) {
  const h = edit.helpers.get(obj);
  if (h) { scene.remove(h); h.geometry.dispose(); h.material.dispose(); edit.helpers.delete(obj); }
}
function editHitAt(cx, cy) {   // 画面座標→編集対象（アイテムのルートまで遡る）
  const r = renderer.domElement.getBoundingClientRect();
  _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects([...(edit.group ? edit.group.children : []), ...(edit.trigGroup ? edit.trigGroup.children : []), ...props.map((pr) => pr.mesh), goalMesh].filter(Boolean), true);
  if (!hits.length) return null;
  let obj = hits[0].object;
  if (obj !== goalMesh) { while (obj.parent && obj.parent !== edit.group && obj.parent !== scene) obj = obj.parent; }
  if (obj === goalMesh || obj.parent === edit.group) return obj;
  if (obj.userData.prop || (obj.userData.item && (dg.props?.includes(obj.userData.item) || dg.doors?.includes(obj.userData.item) || dg.triggers?.includes(obj.userData.item) || dg.cutscenes?.includes(obj.userData.item)))) return obj;
  return null;
}
// 毎フレーム：選択枠の追従と、どれが選択対象になるかのホバー表示
function editFrame() {
  for (const h of edit.helpers.values()) h.update();
  if (edit.ptr && !edit.busy) {
    const obj = editHitAt(edit.ptr[0], edit.ptr[1]);
    if (obj) {
      if (!edit.hover) { edit.hover = new THREE.BoxHelper(obj, 0x66ccff); edit.hover.material.depthTest = false; edit.hover.renderOrder = 998; scene.add(edit.hover); }
      edit.hover.visible = true;
      edit.hover.setFromObject(obj);
    } else if (edit.hover) edit.hover.visible = false;
  } else if (edit.hover) edit.hover.visible = false;
}
// ドラッグ開始：Alt＝元の位置にコピーを残す（UE式複製）。複数選択の基準位置も記録
function editDragStart() {
  const prim = edit.gizmo && edit.gizmo.object;
  if (!prim) return;
  if (edit.altDown) {
    for (const o of edit.sel) {
      const it = o.userData.item; if (!it) continue;
      const copy = { ...it };
      dg.items.push(copy);
      const m = editItemMesh(copy); if (m) edit.group.add(m);
    }
  }
  edit.drag = {
    pos: prim.position.clone(), ry: prim.rotation.y,
    others: edit.sel.filter((o) => o !== prim).map((o) => ({ o, pos: o.position.clone(), ry: o.rotation.y })),
  };
}
// ドラッグ中：主対象の差分を他の選択物へ適用（回転は主対象を軸に公転＋自転）
function editDragFollow() {
  const prim = edit.gizmo && edit.gizmo.object;
  if (!prim) return;
  if (prim === goalMesh && edit.mode === 'translate') prim.position.y = 1.6;
  if (!edit.drag) return;
  if (edit.mode === 'translate') {
    const dx = prim.position.x - edit.drag.pos.x, dz = prim.position.z - edit.drag.pos.z;
    for (const r of edit.drag.others) {
      r.o.position.x = r.pos.x + dx; r.o.position.z = r.pos.z + dz;
      if (r.o === goalMesh) r.o.position.y = 1.6;
    }
  } else {
    const dry = prim.rotation.y - edit.drag.ry;
    const c = Math.cos(dry), sn = Math.sin(dry);
    for (const r of edit.drag.others) {
      const ox = r.pos.x - edit.drag.pos.x, oz = r.pos.z - edit.drag.pos.z;
      r.o.position.x = edit.drag.pos.x + ox * c + oz * sn;
      r.o.position.z = edit.drag.pos.z - ox * sn + oz * c;
      r.o.rotation.y = r.ry + dry;
    }
  }
}
// ギズモ操作の結果をアイテムデータへ書き戻す
function editWriteBack() {
  const objs = edit.sel.length ? edit.sel : (edit.gizmo && edit.gizmo.object ? [edit.gizmo.object] : []);
  for (const o of objs) {
    if (o === goalMesh) { setGoalCell(Math.round(o.position.x / TILE), Math.round(o.position.z / TILE)); continue; }
    const it = o.userData.item; if (!it) continue;
    it.ry = o.rotation.y;
    if (dg.cutscenes && dg.cutscenes.includes(it)) {   // カットシーン地点
      it.x = o.position.x / TILE; it.z = o.position.z / TILE;
      it.level = lvlOfY(o.position.y);
      o.position.y = it.level * STORY_H + 0.5;
      continue;
    }
    if (dg.triggers && dg.triggers.includes(it)) {   // トリガー：セル座標＋階
      it.x = o.position.x / TILE; it.z = o.position.z / TILE;
      it.level = lvlOfY(o.position.y);
      o.position.y = it.level * STORY_H + 0.7;
      continue;
    }
    if (dg.props && dg.props.includes(it)) {   // プロップ：セル座標＋床からの高さ(yOff)を保存＝机上にも置ける
      it.x = o.position.x / TILE; it.z = o.position.z / TILE;
      it.level = lvlOfY(o.position.y);
      delete it.yOff;
      const rest = propRestY(it);
      const off = +(o.position.y - rest).toFixed(3);
      if (off > 0.02) it.yOff = off;
      o.position.y = propRestY(it);
      continue;
    }
    const pl = itemPlacement(it);            // ry確定後のオフセット（腰板など）で逆算
    it.x = (o.position.x - pl.ox) / TILE;
    it.z = (o.position.z - pl.oz) / TILE;
  }
  // 高さは chandelier / rug 等は自動。手動Yは維持しない（床置き前提）
}
function editDeleteSel() {
  for (const o of edit.sel) {
    if (o === goalMesh) continue;   // ゴールは消さない
    const it = o.userData.item;
    const i = dg.items.indexOf(it);
    if (i >= 0) dg.items.splice(i, 1);
    const ti2 = dg.triggers ? dg.triggers.indexOf(it) : -1;
    if (ti2 >= 0) { dg.triggers.splice(ti2, 1); trigMeshes.delete(it); if (edit.trigGroup) edit.trigGroup.remove(o); continue; }
    const ci = dg.cutscenes ? dg.cutscenes.indexOf(it) : -1;
    if (ci >= 0) { dg.cutscenes.splice(ci, 1); trigMeshes.delete(it); if (edit.trigGroup) edit.trigGroup.remove(o); continue; }
    const pi = dg.props ? dg.props.indexOf(it || o.userData.prop) : -1;
    if (pi >= 0) {
      dg.props.splice(pi, 1);
      const k = props.findIndex((pr) => pr.data === (it || o.userData.prop));
      if (k >= 0) { scene.remove(props[k].mesh); props.splice(k, 1); }
      continue;
    }
    edit.group.remove(o);
  }
  editSelect(null);
}
function editDuplicateSel() {
  const made = [];
  for (const o of edit.sel) {
    const it = o.userData.item; if (!it) continue;
    const copy = { ...it, x: it.x + 1 };
    dg.items.push(copy);
    const m = editItemMesh(copy); if (m) { edit.group.add(m); made.push(m); }
  }
  if (made.length) { editSelect(null); for (const m of made) editSelect(m, true); }
}
// 等間隔配置：選択パーツを N 個、指定セル間隔・方向に並べる（パーツは共通寸法＝セル単位なのできれいに揃う）
function editArray(count, stepCells, dir) {
  const src = edit.sel[edit.sel.length - 1];
  const it = src && src.userData.item;
  if (!it || count < 2) return;
  let dx = 0, dz = 0;
  if (dir === 'x+') dx = 1; else if (dir === 'x-') dx = -1;
  else if (dir === 'z+') dz = 1; else if (dir === 'z-') dz = -1;
  else { dx = Math.round(Math.sin(it.ry || 0)); dz = Math.round(Math.cos(it.ry || 0)); if (!dx && !dz) dz = 1; }   // fwd=向いている方向
  for (let i = 1; i < count; i++) {
    const copy = { ...it, x: it.x + dx * stepCells * i, z: it.z + dz * stepCells * i };
    dg.items.push(copy);
    const m = editItemMesh(copy);
    if (m) edit.group.add(m);
  }
}
// クリック選択（obsのドラッグ回転と両立：動かさずに離した時だけ選択）
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
let _downXY = null;
function editPointerDown(e) { edit.altDown = e.altKey; if (edit.on && e.button === 0 && !edit.busy) _downXY = [e.clientX, e.clientY]; }
function editPointerMove(e) { if (edit.on) edit.ptr = [e.clientX, e.clientY]; }
function editPointerUp(e) {
  if (!edit.on || !_downXY || edit.busy) { _downXY = null; return; }
  const moved = Math.hypot(e.clientX - _downXY[0], e.clientY - _downXY[1]);
  _downXY = null;
  if (moved > 4) return;   // ドラッグ＝カメラ回転
  editSelect(editHitAt(e.clientX, e.clientY), e.shiftKey);
}
// 選択グループをユニットとして保存（room-editor 互換の .unit.json）
async function editSaveUnit(name) {
  const items = edit.sel.map((o) => o.userData.item).filter(Boolean);
  if (!items.length || !name) return false;
  let cx = 0, cz = 0;
  for (const it of items) { cx += it.x; cz += it.z; }
  cx /= items.length; cz /= items.length;
  const children = items.map((it) => ({
    model: it.model,
    x: +(((it.x - cx) * TILE) / FURN_S).toFixed(4), y: 0, z: +(((it.z - cz) * TILE) / FURN_S).toFixed(4),
    ry: +(it.ry || 0).toFixed(4),
  }));
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
  for (const c of children) { mnx = Math.min(mnx, c.x); mxx = Math.max(mxx, c.x); mnz = Math.min(mnz, c.z); mxz = Math.max(mxz, c.z); }
  const def = { format: 'unit', version: 1, name, tags: { rooms: ['any'], place: 'free' }, fp: [Math.max(1, Math.ceil(mxx - mnx)), Math.max(1, Math.ceil(mxz - mnz))], items: children };
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'room', filename: name + '.unit.json', content: JSON.stringify(def, null, 1) }) });
    return r.ok;
  } catch { return false; }
}
async function editPlaceUnit(name) {
  let def = null;
  try { def = JSON.parse(await (await fetch('../rooms/' + encodeURIComponent(name))).text()); } catch { /* noop */ }
  if (!def || !def.items) return;
  const bx = obs.tgt.x / TILE, bz = obs.tgt.z / TILE;   // カメラ注視点に配置
  for (const c of def.items) {
    const it = { model: c.model, x: bx + (c.x * FURN_S) / TILE, z: bz + (c.z * FURN_S) / TILE, y: (c.y || 0) * FURN_S, ry: c.ry || 0, furn: true };
    dg.items.push(it);
    await ensurePart(it.model);
    const m = editItemMesh(it);
    if (m) edit.group.add(m);
  }
}
async function editAddModel(name) {
  const it = { model: name, x: obs.tgt.x / TILE, z: obs.tgt.z / TILE, ry: 0, furn: true };
  await ensurePart(name);
  if (!partsCache[name]) { setStatus('モデルが読めません: ' + name); return; }
  dg.items.push(it);
  const m = editItemMesh(it);
  if (m) { edit.group.add(m); editSelect(m); }
}
async function editSaveStage() {
  const data = { version: 1, seed: dg.seed, layout: dg.layout || 'mansion', roomsX: 3, roomsZ: 3, goal: dg.goal, items: dg.items, props: dg.props || [], doors: dg.doors || [], achEvents: dg.achEvents || [], triggers: (dg.triggers || []).map((t) => { const c = { ...t }; delete c._fired; return c; }), cutscenes: dg.cutscenes || [], parts: dg.parts || null };
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'vamp_param', filename: 'mansion-stage.json', content: JSON.stringify(data) }) });
    return r.ok;
  } catch { return false; }
}
// UI（自前DOM注入。index.html は変更しない）
function setupEditUI() {
  const panel = document.createElement('div');
  panel.id = 'edit-panel';
  panel.style.cssText = 'display:none;position:fixed;right:10px;top:150px;z-index:31;background:rgba(14,18,30,0.93);border:1px solid #4a6;border-radius:8px;padding:10px 12px;font-size:12px;color:#cfe;width:250px;max-height:78vh;overflow-y:auto;';
  panel.innerHTML = [
    '<div style="font-weight:bold;color:#8f8;margin-bottom:4px;">🛠 ステージ編集</div>',
    '<div id="edit-info" style="color:#9fe6ff;min-height:16px;">（未選択）</div>',
    '<div id="ed-floorvis" style="margin-top:2px;font-size:11px;"></div>',
    '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">',
    '<button id="ed-move">移動(G)</button><button id="ed-rot">回転(R)</button><button id="ed-rot90">90°回す</button>',
    '<button id="ed-dup">複製(Ctrl+D)</button><button id="ed-del" style="background:#5a2a2a;">削除(Del)</button></div>',
    '<label style="display:flex;align-items:center;gap:5px;margin-top:6px;cursor:pointer;"><input type="checkbox" id="ed-snap" checked> グリッド吸着（1mマス・90°）</label>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">等間隔配置</div>',
    '<div style="display:flex;gap:4px;align-items:center;margin-top:3px;">個数<input type="number" id="ed-n" value="4" min="2" max="40" style="width:44px;">',
    '間隔<input type="number" id="ed-step" value="1" min="0.5" step="0.5" style="width:44px;">セル</div>',
    '<div style="display:flex;gap:4px;align-items:center;margin-top:3px;">方向<select id="ed-dir" style="flex:1;"><option value="x+">X+</option><option value="x-">X-</option><option value="z+">Z+</option><option value="z-">Z-</option><option value="fwd">向いている方向</option></select>',
    '<button id="ed-array">並べる</button></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">パーツ追加（クリックで配置）</div>',
    '<div id="ed-thumbs"></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">ユニット</div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><select id="ed-units" style="flex:1;"></select><button id="ed-unit-place">配置</button></div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><input type="text" id="ed-unit-name" placeholder="ユニット名" style="flex:1;"><button id="ed-unit-save">選択を保存</button></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">アイテム（プロップ）</div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><button id="ed-prop-key">🔑 鍵</button><button id="ed-prop-grenade">💣 手榴弾</button><button id="ed-prop-memo">📄 メモ</button></div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><button id="ed-prop-rifle">🔫 ライフル</button><button id="ed-prop-shockgun">⚡ ショックガン</button></div>',
    '<label style="display:flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;"><input type="checkbox" id="ed-grabbable" checked> 掴める（grabbable）</label>',
    '<div style="display:flex;gap:4px;margin-top:4px;"><button id="ed-door">🚪 扉</button><button id="ed-keylink">選択した鍵を最寄りの扉に連動</button></div>',
    '<div style="margin-top:4px;">メモ内容（"---"の行でページ区切り）<textarea id="ed-memo-pages" rows="3" style="width:100%;"></textarea></div>',
    '<div style="display:flex;gap:4px;align-items:center;">実績ID <input type="text" id="ed-memo-ach" style="flex:1;" placeholder="readNote など"></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">トリガーボックス（ゲーム中不可視）</div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><button id="ed-trig-add">＋トリガー</button>',
    '<select id="ed-trig-type" style="flex:1;"><option value="speech">会話（字幕）</option><option value="bgm">BGM変更</option><option value="vampWake">吸血鬼出現</option><option value="thunder">雷</option><option value="cutscene">カットシーン</option></select></div>',
    '<input type="text" id="ed-trig-param" placeholder="セリフ / BGMファイル名 / シーンID" style="width:100%;margin-top:3px;">',
    '<div style="display:flex;gap:4px;align-items:center;margin-top:3px;">範囲(セル) 幅<input type="number" id="ed-trig-w" value="1" min="1" style="width:44px;"> 奥<input type="number" id="ed-trig-d" value="1" min="1" style="width:44px;"></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">カットシーン（キャンバス右クリックで作成）</div>',
    '<div style="font-size:11px;color:#9ab;">actors/script は story-editor 形式（x,z はセル）</div>',
    '<textarea id="ed-cs-script" rows="5" style="width:100%;margin-top:3px;font-size:11px;" placeholder="マーカー選択でスクリプト表示"></textarea>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><button id="ed-cs-apply">スクリプト反映</button><button id="ed-cs-test">▶ テスト再生</button></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">実績イベント</div>',
    '<div style="font-size:11px;color:#9ab;">[{"when":{"id":"readNote","op":"==","value":true},"event":{"type":"thunder"}}] 形式。実績はメモ閲覧/clear などで更新</div>',
    '<textarea id="ed-ach-events" rows="3" style="width:100%;margin-top:3px;font-size:11px;"></textarea>',
    '<button id="ed-ach-apply" style="margin-top:3px;">反映</button>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">外装パーツ（GLB retro_fantasy と交換）</div>',
    '<div id="ed-parts-box" style="margin-top:3px;"></div>',
    '<button id="ed-part-apply" style="margin-top:3px;width:100%;">保存してリロード（反映）</button>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;color:#9fe6ff;font-weight:bold;">ステージ生成</div>',
    '<div style="display:flex;gap:4px;margin-top:3px;"><select id="ed-layout" style="flex:1;"><option value="mansion">本館のみ</option><option value="annex">別棟つき（渡り廊下）</option><option value="floors2">2階建て（階段）</option><option value="basement">地下棟つき（階段）</option></select><button id="ed-regen">🎲 生成</button></div>',
    '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;display:flex;gap:4px;">',
    '<button id="ed-save" style="flex:1;background:#2b6a4a;">💾 ステージ保存</button>',
    '<button id="ed-play" style="flex:1;background:#6a2b4a;">▶ シミュレーション</button></div>',
  ].join('');
  document.body.appendChild(panel);
  const st = document.createElement('style');
  st.textContent = '#edit-panel button{background:#25304a;border:1px solid #46608c;color:#cfe;border-radius:4px;padding:3px 7px;font-size:11px;cursor:pointer;} #edit-panel input,#edit-panel select{background:#1a2030;color:#cfe;border:1px solid #345;border-radius:3px;padding:2px 4px;font-size:11px;} #ed-thumbs{max-height:210px;overflow-y:auto;background:#12182a;border:1px solid #263452;border-radius:6px;padding:4px;display:flex;flex-wrap:wrap;gap:3px;align-content:flex-start;margin-top:3px;} #ed-thumbs .cat{width:100%;font-size:10px;color:#8fa9cc;margin:4px 2px 1px;} #ed-thumbs img{width:44px;height:44px;border-radius:4px;background:#1c2436;cursor:pointer;border:1px solid transparent;} #ed-thumbs img:hover{border-color:#5580cc;background:#24304a;}';
  document.head.appendChild(st);
  // 編集開始ボタンを観察パネルへ注入
  const obsPanel = $('obs-panel');
  if (obsPanel) {
    const b = document.createElement('button');
    b.textContent = '🛠 ステージ編集を開く';
    b.style.cssText = 'margin-top:8px;width:100%;padding:7px;background:#2a5a3a;border:1px solid #4a8;border-radius:5px;color:#fff;cursor:pointer;';
    b.addEventListener('click', () => editEnter());
    obsPanel.appendChild(b);
  }
  $('ed-move').addEventListener('click', () => editSetMode('translate'));
  $('ed-rot').addEventListener('click', () => editSetMode('rotate'));
  $('ed-rot90').addEventListener('click', () => { for (const o of edit.sel) { if (o === goalMesh) continue; o.rotation.y += Math.PI / 2; const it = o.userData.item; if (it) it.ry = o.rotation.y; } });
  $('ed-dup').addEventListener('click', editDuplicateSel);
  $('ed-del').addEventListener('click', editDeleteSel);
  $('ed-snap').addEventListener('change', (e) => { edit.snap = e.target.checked; editApplySnap(); });
  $('ed-array').addEventListener('click', () => editArray(+$('ed-n').value || 2, +$('ed-step').value || 1, $('ed-dir').value));
  $('ed-unit-place').addEventListener('click', () => { const v = $('ed-units').value; if (v) editPlaceUnit(v); });
  $('ed-unit-save').addEventListener('click', async () => {
    const name = ($('ed-unit-name').value || '').replace(/[^\w\-]/g, '');
    const btn = $('ed-unit-save');
    const ok = await editSaveUnit(name);
    btn.textContent = ok ? '✓保存' : '✗失敗';
    setTimeout(() => { btn.textContent = '選択を保存'; refreshUnitList(); }, 1200);
  });
  $('ed-save').addEventListener('click', async () => { const b2 = $('ed-save'); b2.textContent = (await editSaveStage()) ? '✓ 保存しました' : '✗ 失敗'; setTimeout(() => { b2.textContent = '💾 ステージ保存'; }, 1400); });
  const addProp = (model) => {
    if (!dg.props) dg.props = [];
    const d = { model, x: Math.round(obs.tgt.x / TILE), z: Math.round(obs.tgt.z / TILE), ry: 0, level: lvlOfY(obs.tgt.y), grabbable: model !== 'memo' };
    if (model === 'memo') d.memo = { pages: ['ここに内容を書く'] };
    dg.props.push(d);
    const pr = { data: d, mesh: makePropMesh(d), held: false, vel: null };
    scene.add(pr.mesh); props.push(pr);
    pr.mesh.userData.item = d;   // 既存のギズモ選択/移動/回転と互換にする
    editSelect(pr.mesh);
  };
  $('ed-prop-key').addEventListener('click', () => addProp('key'));
  $('ed-prop-grenade').addEventListener('click', () => addProp('grenade'));
  $('ed-prop-memo').addEventListener('click', () => addProp('memo'));
  $('ed-prop-rifle').addEventListener('click', () => addProp('rifle'));
  $('ed-prop-shockgun').addEventListener('click', () => addProp('shockgun'));
  $('ed-door').addEventListener('click', () => {
    if (!dg.doors) dg.doors = [];
    const d = { id: 'd' + (dg.doors.length + 1), x: Math.round(obs.tgt.x / TILE), z: Math.round(obs.tgt.z / TILE), ry: 0, level: lvlOfY(obs.tgt.y) };
    dg.doors.push(d); buildDoors();
    const dr = doorObjs.find((o) => o.data === d);
    if (dr) editSelect(dr.group);
  });
  $('ed-keylink').addEventListener('click', () => {
    const o = edit.sel[edit.sel.length - 1];
    const it = o?.userData.item;
    if (!it || it.model !== 'key' || !dg.doors?.length) { setStatus('鍵を選択してから押してください'); return; }
    let best = null, bd = 1e9;
    for (const d of dg.doors) { const dd = Math.hypot(d.x - it.x, d.z - it.z); if (dd < bd) { bd = dd; best = d; } }
    it.doorId = best.id;
    setStatus('鍵を扉 ' + best.id + ' に連動しました');
  });
  $('ed-memo-pages').addEventListener('change', (e) => {
    const it = edit.sel[edit.sel.length - 1]?.userData.item;
    if (it?.model === 'memo') { if (!it.memo) it.memo = {}; it.memo.pages = e.target.value.split('\n---\n'); }
  });
  $('ed-memo-ach').addEventListener('change', (e) => {
    const it = edit.sel[edit.sel.length - 1]?.userData.item;
    if (it?.model === 'memo') { if (!it.memo) it.memo = {}; it.memo.achievement = e.target.value.trim() || undefined; }
  });
  $('ed-trig-add').addEventListener('click', () => {
    if (!dg.triggers) dg.triggers = [];
    const t = { id: 't' + (dg.triggers.length + 1), x: Math.round(obs.tgt.x / TILE), z: Math.round(obs.tgt.z / TILE), w: 1, d: 1, level: lvlOfY(obs.tgt.y), event: { type: 'speech', text: '……' } };
    dg.triggers.push(t);
    const m = makeTriggerMesh(t);
    if (m) { editSelect(m); }
  });
  const trigOfSel = () => { const it = edit.sel[edit.sel.length - 1]?.userData.item; return (it && dg.triggers?.includes(it)) ? it : null; };
  $('ed-trig-type').addEventListener('change', (e) => {
    const t = trigOfSel(); if (!t) return;
    t.event = { type: e.target.value };
    if (t.event.type === 'speech') t.event.text = $('ed-trig-param').value || '……';
    else if (t.event.type === 'bgm') t.event.name = $('ed-trig-param').value;
    else if (t.event.type === 'cutscene') t.event.id = $('ed-trig-param').value;
    trigRecolor(t);
  });
  $('ed-trig-param').addEventListener('change', (e) => {
    const t = trigOfSel(); if (!t || !t.event) return;
    if (t.event.type === 'speech') t.event.text = e.target.value;
    else if (t.event.type === 'bgm') t.event.name = e.target.value;
    else if (t.event.type === 'cutscene') t.event.id = e.target.value;
  });
  const trigResize = () => {
    const t = trigOfSel(); if (!t) return;
    t.w = Math.max(1, +$('ed-trig-w').value || 1); t.d = Math.max(1, +$('ed-trig-d').value || 1);
    const m = trigMeshes.get(t); if (m) m.scale.set(t.w, 1, t.d);
  };
  $('ed-trig-w').addEventListener('change', trigResize);
  $('ed-trig-d').addEventListener('change', trigResize);
  $('ed-ach-apply').addEventListener('click', () => {
    try {
      const j = JSON.parse($('ed-ach-events').value || '[]');
      if (Array.isArray(j)) { dg.achEvents = j; setStatus('実績イベントを反映しました（' + j.length + '件）'); }
    } catch (e) { setStatus('JSONエラー: ' + e.message); }
  });
  const csOfSel = () => { const it = edit.sel[edit.sel.length - 1]?.userData.item; return (it && dg.cutscenes?.includes(it)) ? it : null; };
  $('ed-cs-apply').addEventListener('click', () => {
    const cs = csOfSel(); if (!cs) { setStatus('カットシーンのマーカーを選択してください'); return; }
    try {
      const j = JSON.parse($('ed-cs-script').value);
      if (Array.isArray(j)) cs.script = j;
      else { if (j.script) cs.script = j.script; if (j.actors) cs.actors = j.actors; }
      setStatus('スクリプトを反映しました');
    } catch (e) { setStatus('JSONエラー: ' + e.message); }
  });
  $('ed-cs-test').addEventListener('click', () => {
    const cs = csOfSel(); if (!cs) { setStatus('カットシーンのマーカーを選択してください'); return; }
    editExit(); obsToggle(false);
    if (phase !== 'playing') startGame();
    setTimeout(() => playCutscene(cs), 300);
  });
  // 右クリック→「カットシーンをつくる」メニュー
  let csMenu = null;
  renderer.domElement.addEventListener('contextmenu', (e) => {
    if (!edit.on || edit.busy) return;
    e.preventDefault();
    if (!csMenu) {
      csMenu = document.createElement('div');
      csMenu.style.cssText = 'position:fixed;z-index:50;background:#1c2436;border:1px solid #46608c;border-radius:5px;padding:4px;display:none;';
      csMenu.innerHTML = '<button id="cs-make" style="background:#25304a;border:none;color:#cfe;padding:5px 12px;cursor:pointer;border-radius:3px;">🎬 カットシーンをつくる</button>';
      document.body.appendChild(csMenu);
      csMenu.querySelector('#cs-make').addEventListener('click', () => {
        csMenu.style.display = 'none';
        const pt = csMenu._pt; if (!pt) return;
        if (!dg.cutscenes) dg.cutscenes = [];
        const cs = {
          id: 'cs' + (dg.cutscenes.length + 1),
          x: Math.round(pt.x / TILE), z: Math.round(pt.z / TILE), level: lvlOfY(pt.y),
          actors: [{ npc: 'vamp', x: Math.round(pt.x / TILE), z: Math.round(pt.z / TILE) - 2, ry: 180 }],
          script: [
            { op: 'say', actor: 'vamp', lines: ['ようこそ……私の屋敷へ'], cps: 8 },
            { op: 'end' },
          ],
        };
        dg.cutscenes.push(cs);
        const m = makeCsMarker(cs);
        if (m) editSelect(m);
        $('ed-cs-script').value = JSON.stringify({ actors: cs.actors, script: cs.script }, null, 1);
        setStatus('カットシーン ' + cs.id + ' を作成（トリガーの「カットシーン」種別でIDを指定して発火）');
      });
    }
    // 床平面（注視高さ）との交点
    const r = renderer.domElement.getBoundingClientRect();
    _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, camera);
    const planeY = (lvlOfY(obs.tgt.y)) * STORY_H;
    const tt = (planeY - _ray.ray.origin.y) / _ray.ray.direction.y;
    if (!(tt > 0)) return;
    csMenu._pt = { x: _ray.ray.origin.x + _ray.ray.direction.x * tt, y: planeY, z: _ray.ray.origin.z + _ray.ray.direction.z * tt };
    csMenu.style.left = e.clientX + 'px'; csMenu.style.top = e.clientY + 'px';
    csMenu.style.display = 'block';
    const hide = () => { csMenu.style.display = 'none'; removeEventListener('pointerdown', hide, true); };
    setTimeout(() => addEventListener('pointerdown', hide, true), 10);
  });
  $('ed-grabbable').addEventListener('change', (e) => {
    const o = edit.sel[edit.sel.length - 1];
    if (o?.userData.item && dg.props?.includes(o.userData.item)) o.userData.item.grabbable = e.target.checked;
  });
  if (stageCfg?.layout) $('ed-layout').value = stageCfg.layout;
  $('ed-part-apply').addEventListener('click', async () => {
    const clean = (sel) => {
      const out = {};
      for (const key of ['pillar', 'floor', 'wall', 'window']) {
        const ps = sel[key];
        if (ps && (ps.name || ps.rot)) out[key] = { name: ps.name || null, rot: ps.rot || 0 };
      }
      return out;
    };
    const g = clean(partScopes.all || {});
    const zones = {};
    for (const [z, sel] of Object.entries(partScopes)) {
      if (z === 'all') continue;
      const c = clean(sel);
      if (Object.keys(c).length) zones[z] = c;
    }
    dg.parts = (Object.keys(g).length || Object.keys(zones).length) ? { global: g, zones } : null;
    if (await editSaveStage()) location.reload();
    else setStatus('保存に失敗（devサーバなし）');
  });
  $('ed-regen').addEventListener('click', async () => {
    if (!confirm('保存済みステージを置き換えて新しく生成します。よろしいですか？')) return;
    const data = { version: 1, seed: (Math.random() * 99999) | 0, layout: $('ed-layout').value };
    try {
      await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'vamp_param', filename: 'mansion-stage.json', content: JSON.stringify(data) }) });
      location.reload();   // レイアウト変更は再構築が多いのでリロードで反映
    } catch { setStatus('保存に失敗（devサーバなし）'); }
  });
  $('ed-play').addEventListener('click', () => { editExit(); obsToggle(false); if (phase !== 'playing') startGame(); });
  renderer.domElement.addEventListener('pointerdown', editPointerDown);
  renderer.domElement.addEventListener('pointerup', editPointerUp);
  renderer.domElement.addEventListener('pointermove', editPointerMove);
  addEventListener('keydown', (e) => {
    if (!edit.on) return;
    if (e.key === 'Alt') e.preventDefault();   // ブラウザのメニューフォーカスを防ぐ
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.code === 'KeyG') editSetMode('translate');
    else if (e.code === 'KeyR') editSetMode('rotate');
    else if (e.code === 'Delete' || e.code === 'Backspace') editDeleteSel();
    else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); editDuplicateSel(); }
  });
  refreshUnitList();
}
// ── パーツパレット（room-editor と同方式：各モデルをオフスクリーンWebGLで1枚ずつ描いてカテゴリ別に並べる）──
let thumbR = null, thumbScene = null, thumbCam = null;
function initThumbRenderer() {
  thumbR = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbR.setSize(64, 64);
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(2, 3, 2); thumbScene.add(dl);
  thumbCam = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
}
async function makeThumb(name) {
  const part = await ensurePart(name);
  if (!part) throw new Error('no model: ' + name);
  const c = part.obj.clone(true);
  thumbScene.add(c);
  const r = Math.max(part.size.x, part.size.y, part.size.z) || 1;   // 斜め上から全体が収まる距離
  thumbCam.position.set(r * 1.4, r * 1.1, r * 1.4);
  thumbCam.lookAt(0, part.size.y * 0.45, 0);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL();
  thumbScene.remove(c);
  return url;
}
async function buildEditPalette() {
  const box = $('ed-thumbs');
  if (!box) return;
  let names = [];
  try {
    const all = await (await fetch('../models/manifest.json')).json();
    names = all.filter((f) => f.includes('kenney_furniture-kit')).map((f) => f.split('/').pop().replace(/\.glb$/i, ''));
  } catch { box.textContent = '（devサーバ無し）'; return; }
  initThumbRenderer();
  const groups = new Map();
  for (const n of names) {
    const cat = categorize(n) || 'shell';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(n);
  }
  const queue = [];
  for (const cat of [...groups.keys()].sort()) {
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = cat; box.appendChild(h);
    for (const n of groups.get(cat)) {
      const img = document.createElement('img');
      img.title = n; img.alt = n;
      img.addEventListener('click', () => { editAddModel(n); });
      box.appendChild(img);
      queue.push({ n, img });
    }
  }
  const step = () => {   // 1枚ずつ順次生成（編集開始を固めない）
    const job = queue.shift();
    if (!job) return;
    makeThumb(job.n).then((url) => { job.img.src = url; }).catch(() => { /* 失敗はプレースホルダのまま */ })
      .finally(() => setTimeout(step, 10));
  };
  step();
}
// ── 外装パーツのサムネイル選択UI（適用先＝全体/ゾーン別、既定タイル＋レトロキット候補、90°回転ボタン付き）──
const emptySel = () => ({ pillar: { name: null, rot: 0 }, floor: { name: null, rot: 0 }, wall: { name: null, rot: 0 }, window: { name: null, rot: 0 } });
const partScopes = { all: emptySel() };   // 'all' | '0' | '1'（ゾーン番号）
let partScope = 'all';
const partUiRefs = {};   // key → { select(name), rotBtn }
const retroPartCache = new Map();
function renderThumbOf(part) {
  const c = part.obj.clone(true);
  thumbScene.add(c);
  const r = Math.max(part.size.x, part.size.y, part.size.z) || 1;
  thumbCam.position.set(r * 1.4, r * 1.1, r * 1.4);
  thumbCam.lookAt(0, part.size.y * 0.45, 0);
  thumbR.render(thumbScene, thumbCam);
  const url = thumbR.domElement.toDataURL();
  thumbScene.remove(c);
  return url;
}
function curPartSel() { if (!partScopes[partScope]) partScopes[partScope] = emptySel(); return partScopes[partScope]; }
function refreshPartsUiFromScope() {
  const sel = curPartSel();
  for (const key of Object.keys(PART_CANDIDATES)) {
    const r = partUiRefs[key];
    if (!r) continue;
    r.select(sel[key].name, true);
    r.rotBtn.textContent = (sel[key].rot * 90) + '°';
  }
}
let partsUiBuilt = false;
async function buildPartsUI() {
  if (partsUiBuilt) return;
  partsUiBuilt = true;
  const box = $('ed-parts-box');
  if (!box) return;
  if (!thumbR) initThumbRenderer();
  // 保存済み設定を初期状態へ（旧フラット形式 / {global, zones} 両対応）
  const norm = (v) => (typeof v === 'string') ? { name: v, rot: 0 } : { name: v.name || null, rot: v.rot || 0 };
  const src = dg.parts || {};
  if (src.global || src.zones) {
    for (const k of Object.keys(PART_CANDIDATES)) if (src.global?.[k]) partScopes.all[k] = norm(src.global[k]);
    for (const [z, m] of Object.entries(src.zones || {})) {
      partScopes[z] = emptySel();
      for (const k of Object.keys(PART_CANDIDATES)) if (m[k]) partScopes[z][k] = norm(m[k]);
    }
  } else {
    for (const k of Object.keys(PART_CANDIDATES)) if (src[k]) partScopes.all[k] = norm(src[k]);
  }
  // 適用先（全体 / ゾーン別）。ゾーン名はレイアウトに合わせる
  const zoneNames = dg.layout === 'basement' ? ['B1（地下）', '1F（本館）']
    : dg.layout === 'floors2' ? ['1F', '2F']
    : dg.layout === 'annex' ? ['本館', '別棟'] : [];
  const scopeRow = document.createElement('div');
  scopeRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;';
  const scopeSel = document.createElement('select');
  scopeSel.innerHTML = '<option value="all">全体</option>' + zoneNames.map((n, i) => '<option value="' + i + '">' + n + '</option>').join('');
  scopeSel.addEventListener('change', () => { partScope = scopeSel.value; refreshPartsUiFromScope(); });
  scopeRow.append('適用先', scopeSel);
  box.appendChild(scopeRow);

  const LABEL = { pillar: '柱', floor: '床', wall: '壁', window: '窓' };
  const queue = [];
  for (const key of Object.keys(PART_CANDIDATES)) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:4px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:#9fe6ff;';
    const rotBtn = document.createElement('button');
    rotBtn.title = '向きを90°ずつ回転';
    rotBtn.addEventListener('click', () => { const ps = curPartSel()[key]; ps.rot = (ps.rot + 1) % 4; rotBtn.textContent = (ps.rot * 90) + '°'; });
    head.append(LABEL[key], rotBtn);
    const strip = document.createElement('div');
    strip.style.cssText = 'display:flex;gap:3px;overflow-x:auto;margin-top:2px;padding-bottom:2px;';
    // 横スクロール帯はホイールで送れるように（縦ホイール→横スクロール変換）
    strip.addEventListener('wheel', (e) => { if (e.deltaY) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    const tiles = [];
    const select = (name, uiOnly) => {
      if (!uiOnly) curPartSel()[key].name = name;
      for (const t of tiles) t.el.style.borderColor = (t.name === name) ? '#ffd166' : 'transparent';
    };
    partUiRefs[key] = { select, rotBtn };
    const defTile = document.createElement('div');
    defTile.textContent = '既定';
    defTile.style.cssText = 'min-width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:#1c2436;border:2px solid transparent;border-radius:4px;cursor:pointer;font-size:10px;color:#9ab;';
    defTile.addEventListener('click', () => select(null));
    strip.appendChild(defTile);
    tiles.push({ name: null, el: defTile });
    for (const n of PART_CANDIDATES[key]) {
      const img = document.createElement('img');
      img.title = n; img.alt = n;
      img.style.cssText = 'width:40px;height:40px;border-radius:4px;background:#1c2436;cursor:pointer;border:2px solid transparent;flex:none;';
      img.addEventListener('click', () => select(n));
      strip.appendChild(img);
      tiles.push({ name: n, el: img });
      queue.push({ n, img });
    }
    row.append(head, strip);
    box.appendChild(row);
  }
  refreshPartsUiFromScope();
  const step = () => {   // 1枚ずつ順次生成
    const job = queue.shift();
    if (!job) return;
    (async () => {
      let part = retroPartCache.get(job.n);
      if (!part) { part = await loadPart(KIT_RETRO, job.n); retroPartCache.set(job.n, part); }
      job.img.src = renderThumbOf(part);
    })().catch(() => { /* 失敗はプレースホルダのまま */ }).finally(() => setTimeout(step, 10));
  };
  step();
}

async function refreshUnitList() {
  const sel = $('ed-units');
  if (!sel) return;
  try {
    const files = await (await fetch('../rooms/manifest.json')).json();
    const units = files.filter((f) => f.endsWith('.unit.json'));
    sel.innerHTML = units.map((n) => '<option value="' + n + '">' + n.replace('.unit.json', '') + '</option>').join('');
  } catch { sel.innerHTML = ''; }
}

// ══════════ プロップ（拾えるアイテム：鍵/手榴弾/メモ）══════════
// 仮モデルはプリミティブ（後で objUrl で .obj に差し替えられる想定のフィールドだけ確保）
const props = [];                  // {data, mesh, held, vel:THREE.Vector3|null}
let heldProp = null, hoverProp = null, propHover = null;   // propHover=視線枠(BoxHelper)
const PROP_MAKERS = {
  key() {   // 金の鍵
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8b23a, metalness: 0.8, roughness: 0.35 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 8, 16), mat);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.16, 8), mat);
    shaft.rotation.z = Math.PI / 2; shaft.position.x = 0.1;
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 0.016), mat);
    tooth.position.set(0.16, -0.035, 0);
    g.add(ring, shaft, tooth);
    return g;
  },
  grenade() {   // 手榴弾
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshStandardMaterial({ color: 0x33452e, roughness: 0.6, metalness: 0.3 }));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 8), new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.7, roughness: 0.4 }));
    cap.position.y = 0.08;
    g.add(body, cap);
    return g;
  },
  rifle() {   // アサルトライフル（仮モデル）
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.6, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.05), mat); body.position.y = 0.06;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.04), mat); mag.position.set(0.04, -0.02, 0);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.04), mat); grip.position.set(-0.14, -0.01, 0); grip.rotation.z = 0.3;
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.04), mat); stock.position.set(-0.3, 0.05, 0);
    g.add(body, mag, grip, stock);
    return g;
  },
  shockgun() {   // ショックガン（仮モデル）
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x24505c, metalness: 0.5, roughness: 0.4, emissive: 0x0a3d4a, emissiveIntensity: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.08), mat); body.position.y = 0.06;
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 8, 14), new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2299cc, emissiveIntensity: 1.4 }));
    coil.position.set(0.22, 0.06, 0); coil.rotation.y = Math.PI / 2;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), mat); grip.position.set(-0.1, -0.02, 0); grip.rotation.z = 0.3;
    g.add(body, coil, grip);
    return g;
  },
  memo() {   // メモ（紙）
    const g = new THREE.Group();
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.32), new THREE.MeshStandardMaterial({ color: 0xf2edda, roughness: 0.9, side: THREE.DoubleSide }));
    paper.rotation.x = -Math.PI / 2; paper.rotation.z = 0.4;
    paper.position.y = 0.012;
    g.add(paper);
    return g;
  },
};
function propRestY(d) { return floorYAt(d.x * TILE, d.z * TILE, ((d.level || 0) * STORY_H) + 0.5) + 0.06 + (d.yOff || 0); }
function makePropMesh(d) {
  const mk = PROP_MAKERS[d.model] || PROP_MAKERS.key;
  const m = mk();
  m.position.set(d.x * TILE, propRestY(d), d.z * TILE);
  m.rotation.y = d.ry || 0;
  m.userData.prop = d;
  return m;
}
function buildProps() {
  for (const pr of props) scene.remove(pr.mesh);
  props.length = 0;
  heldProp = null; hoverProp = null;
  for (const d of (dg.props || [])) {
    const mesh = makePropMesh(d);
    scene.add(mesh);
    props.push({ data: d, mesh, held: false, vel: null });
  }
}
// 視線→拾う/読む/放る。レイキャストは登録プロップのみ（毎フレーム1回・少数）
const _propRay = new THREE.Raycaster(); _propRay.far = 2.8;
const _ndc0 = new THREE.Vector2(0, 0);
let propHint = null;
function setPropHint(text) {
  if (!propHint) {
    propHint = document.createElement('div');
    propHint.style.cssText = 'position:fixed;left:50%;top:56%;transform:translateX(-50%);z-index:16;color:#ffe;font-size:13px;background:rgba(0,0,0,0.45);padding:3px 10px;border-radius:4px;pointer-events:none;display:none;';
    document.body.appendChild(propHint);
  }
  if (text) { propHint.textContent = text; propHint.style.display = 'block'; }
  else propHint.style.display = 'none';
}
function updateProps(dt) {
  // 投げられたプロップの弾道（重力＋床/壁で停止）
  for (const pr of props) {
    if (!pr.vel) continue;
    const m = pr.mesh;
    pr.vel.y -= 14 * dt;
    const nx = m.position.x + pr.vel.x * dt, nz = m.position.z + pr.vel.z * dt;
    if (vampFree(nx, nz, m.position.y)) { m.position.x = nx; m.position.z = nz; }
    else { pr.vel.x = 0; pr.vel.z = 0; }
    m.position.y += pr.vel.y * dt;
    const fy = floorYAt(m.position.x, m.position.z, m.position.y) + 0.06;
    if (m.position.y <= fy) {
      m.position.y = fy;
      pr.vel = null;   // 着地＝静止
      pr.data.x = m.position.x / TILE; pr.data.z = m.position.z / TILE;
      gameEvent('propLanded', pr);
    }
  }
  // 持っているプロップは目の前に追従
  if (heldProp) {
    const m = heldProp.mesh;
    m.position.set(
      player.pos.x - Math.sin(player.yaw) * 0.55 + Math.cos(player.yaw) * 0.22,
      player.pos.y - 0.32,
      player.pos.z - Math.cos(player.yaw) * 0.55 - Math.sin(player.yaw) * 0.22);
    m.rotation.y = player.yaw;
  }
  // 視線ハイライト（プレイ中・非捕縛・メモ閲覧中でない時のみ）
  hoverProp = null;
  if (phase === 'playing' && !edit.on && !isCaptured() && !memoOpen) {
    _propRay.setFromCamera(_ndc0, camera);
    let best = null, bd = 1e9;
    for (const pr of props) {
      if (pr.held || pr.vel) continue;
      const d2 = pr.mesh.position.distanceToSquared(player.pos);
      if (d2 > 2.8 * 2.8) continue;
      const hits = _propRay.intersectObject(pr.mesh, true);
      if (hits.length && hits[0].distance < bd) { bd = hits[0].distance; best = pr; }
    }
    hoverProp = best;
  }
  // 視線枠（黄）。ステージ編集と同じ BoxHelper 方式
  if (hoverProp) {
    if (!propHover) { propHover = new THREE.BoxHelper(hoverProp.mesh, 0xffe066); propHover.material.depthTest = false; propHover.renderOrder = 997; scene.add(propHover); }
    propHover.visible = true;
    propHover.setFromObject(hoverProp.mesh);
  } else if (propHover) propHover.visible = false;
  // ヒント表示
  if (heldProp) {
    const w = heldWeapon();
    setPropHint(w === 'rifle' ? 'クリック: ショット / E: 捨てる' : w === 'shockgun' ? '左: ショット / 右: 引き寄せ / E: 捨てる' : 'E: 投げる');
  }
  else if (hoverProp) setPropHint(hoverProp.data.model === 'memo' ? 'E: 読む' : (hoverProp.data.grabbable !== false ? 'E: 拾う' : ''));
  else setPropHint(null);
}
function propInteract() {   // Eキー
  if (memoOpen) { closeMemo(); return; }
  if (heldProp) {   // 前へ放る
    const pr = heldProp;
    heldProp = null; pr.held = false;
    pr.vel = new THREE.Vector3(-Math.sin(player.yaw) * 6.5, 2.2, -Math.cos(player.yaw) * 6.5);
    gameEvent('propThrown', pr);
    return;
  }
  if (!hoverProp) return;
  const d = hoverProp.data;
  if (d.model === 'memo') { openMemo(d); return; }
  if (d.grabbable === false) return;
  heldProp = hoverProp; heldProp.held = true;
  gameEvent('propTaken', heldProp);
}
addEventListener('keydown', (e) => {
  if (e.code === 'KeyE' && phase === 'playing' && !edit.on && !cutscene.on) propInteract();
});
// メモ閲覧（P3で内容編集UIと実績連動を拡張。閲覧中はプレイヤー停止＝ループ側で参照）
let memoOpen = false, memoEl = null, memoPage = 0, memoData = null;
function openMemo(d) {
  memoOpen = true; memoData = d; memoPage = 0;
  document.exitPointerLock?.();
  if (!memoEl) {
    memoEl = document.createElement('div');
    memoEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:40;background:#f2edda;color:#332;padding:28px 34px;border-radius:4px;width:min(420px,80vw);min-height:260px;font-size:14px;line-height:1.9;box-shadow:0 8px 40px rgba(0,0,0,0.6);white-space:pre-wrap;font-family:serif;';
    memoEl.innerHTML = '<div id="memo-body"></div><div style="text-align:center;margin-top:14px;"><button id="memo-prev">◀</button> <span id="memo-pg"></span> <button id="memo-next">▶</button> <button id="memo-close" style="margin-left:14px;">閉じる</button></div>';
    document.body.appendChild(memoEl);
    memoEl.querySelector('#memo-prev').addEventListener('click', () => memoNav(-1));
    memoEl.querySelector('#memo-next').addEventListener('click', () => memoNav(1));
    memoEl.querySelector('#memo-close').addEventListener('click', closeMemo);
  }
  memoEl.style.display = 'block';
  memoRender();
  gameEvent('memoRead', d);
}
function memoPages() { return (memoData?.memo?.pages && memoData.memo.pages.length) ? memoData.memo.pages : ['（何も書かれていない）']; }
function memoNav(d) { const n = memoPages().length; memoPage = Math.max(0, Math.min(n - 1, memoPage + d)); memoRender(); }
function memoRender() {
  const pgs = memoPages();
  memoEl.querySelector('#memo-body').textContent = pgs[memoPage];
  memoEl.querySelector('#memo-pg').textContent = (memoPage + 1) + '/' + pgs.length;
}
function closeMemo() { memoOpen = false; if (memoEl) memoEl.style.display = 'none'; if (!touchMode && phase === 'playing') canvas.requestPointerLock(); }

// ══════════ 銃器：アサルトライフル＋ショックガン ══════════
// ライフル/ショックガンを持っている時だけショットが撃てる。ショックガンは右クリックで
// swing-catch 方式の引き寄せ（プロップ=ばね / 吸血鬼=ラグドール化して部位ピン / マント=布頂点ピン）
const heldWeapon = () => heldProp && (heldProp.data.model === 'rifle' || heldProp.data.model === 'shockgun') ? heldProp.data.model : null;
const _sgAnchor = new THREE.Vector3(), _sgDir = new THREE.Vector3(), _sgV = new THREE.Vector3();
const SG_RANGE = 16, SG_HOLD = 2.3, SG_BONES = ['head', 'neck', 'chest', 'spine', 'hips', 'leftHand', 'rightHand', 'leftLowerArm', 'rightLowerArm', 'leftFoot', 'rightFoot', 'leftLowerLeg', 'rightLowerLeg'];
let sgPullProp = null;   // 引き寄せ中のプロップ
function sgUpdateAnchor() {
  _sgDir.set(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
  _sgAnchor.copy(player.pos).addScaledVector(_sgDir, SG_HOLD);
}
function vampBoneAtRay() {   // 視線レイに近い彼女のボーンを探す（swing-catch の findMeguBone 方式）
  if (!vamp.ready || !vamp.vrm.humanoid) return null;
  const orig = player.pos;
  let best = null, bestAlong = SG_RANGE;
  for (const bn of SG_BONES) {
    const node = vamp.vrm.humanoid.getNormalizedBoneNode(bn);
    if (!node) continue;
    node.getWorldPosition(_sgV).sub(orig);
    const along = _sgV.dot(_sgDir);
    if (along < 0.5 || along > SG_RANGE) continue;
    const perp2 = _sgV.lengthSq() - along * along;
    if (perp2 < 0.36 && along < bestAlong) { bestAlong = along; best = bn; }
  }
  return best;
}
function ensureVampRagdoll() {
  if (!vamp.ragdoll) { try { vamp.ragdoll = createRagdoll(vamp.vrm, { gravity: -12, boundsMargin: 0.4 }); } catch (e) { console.warn('vampラグドール生成失敗:', e.message); } }
  return vamp.ragdoll;
}
function tryShockGrab() {
  sgUpdateAnchor();
  // ① マント（布メッシュの頂点を直接ピン）
  if (vamp.ready && vamp.cape?.clothMesh) {
    _propRay.far = SG_RANGE;
    _propRay.setFromCamera(_ndc0, camera);
    const hits = _propRay.intersectObject(vamp.cape.clothMesh, false);
    if (hits.length && hits[0].face) {
      if (!ensureVampRagdoll()) return;
      stopKiss();
      try { vamp.cape.grab(hits[0].face.a, _sgAnchor); } catch (e) { console.warn('マント掴み失敗:', e.message); }
      setRagdollActive(vamp.ragdoll, true);
      vamp.grabState = 'cloth'; vamp.rdRecover = 0;
      if (vamp.holding) releaseHeldKen();
      if (vampSpeech) vampSpeech.bark('repelled');
      return;
    }
  }
  // ② 彼女の体（部位ピン）
  const bone = vampBoneAtRay();
  if (bone) {
    if (!ensureVampRagdoll()) return;
    stopKiss();
    setRagdollActive(vamp.ragdoll, true);
    vamp.grabState = 'body'; vamp.grabBone = bone; vamp.rdRecover = 0;
    if (vamp.holding) releaseHeldKen();
    if (vampSpeech) vampSpeech.bark('repelled');
    return;
  }
  // ③ プロップ（ばね引き寄せ）
  _propRay.far = SG_RANGE;
  _propRay.setFromCamera(_ndc0, camera);
  let best = null, bd = 1e9;
  for (const pr of props) {
    if (pr.held || pr === heldProp || pr.data.grabbable === false) continue;
    const hits = _propRay.intersectObject(pr.mesh, true);
    if (hits.length && hits[0].distance < bd) { bd = hits[0].distance; best = pr; }
  }
  if (best) { sgPullProp = best; best.vel = best.vel || new THREE.Vector3(); }
}
function shockRelease() {
  if (vamp.grabState) {
    if (vamp.grabState === 'cloth') { try { vamp.cape.releaseGrab(); } catch { /* noop */ } }
    vamp.grabState = null;
    vamp.rdRecover = 1.2;   // しばらくラグドールのまま落下→復帰（swing-catch の releaseMegu 方式）
  }
  sgPullProp = null;
}
function updateShock(dt) {
  if (heldWeapon() !== 'shockgun') { if (vamp.grabState) shockRelease(); sgPullProp = null; }
  if (!vamp.grabState && !sgPullProp) return;
  sgUpdateAnchor();
  if (vamp.grabState === 'cloth' && vamp.cape) { try { vamp.cape.moveGrab(_sgAnchor); } catch { /* noop */ } }
  if (sgPullProp) {   // ばねで引き寄せ（swing-catch のオブジェクト搬送と同じ考え方）
    const m = sgPullProp.mesh;
    _sgV.copy(_sgAnchor).sub(m.position);
    sgPullProp.vel.addScaledVector(_sgV, 26 * dt);          // ばね
    sgPullProp.vel.multiplyScalar(Math.exp(-6 * dt));       // 減衰
    m.position.addScaledVector(sgPullProp.vel, dt);
    if (_sgV.lengthSq() > SG_RANGE * SG_RANGE * 4) sgPullProp = null;   // 千切れた
  }
}

// ══════════ 実績・手榴弾・鍵/扉 ══════════
// 実績：bool/int のパラメータ。変化時に achEvents の条件を評価してイベント発火
const ACH = {};
function achSet(id, v) {
  if (!id || ACH[id] === v) return;
  ACH[id] = v;
  for (const ae of (dg.achEvents || [])) {
    if (ae._done || !ae.when || ae.when.id !== id) continue;
    const val = ACH[ae.when.id];
    const ok = ae.when.op === '>=' ? val >= ae.when.value : val === (ae.when.value ?? true);
    if (ok) { ae._done = true; gameEvent(ae.event?.type, ae.event); }
  }
}

// 手榴弾：投げてから2.5秒で爆発。近くの彼女を長めに硬直させる。職員ダウン時にドロップ
// 爆発の見た目は CityFly と同じ「プール＋ビルボード/スプライトFX」方式（ライト無し・大量爆発に耐える）
const IMPACT_POOL = 4, IMPACT_LIFE = 1.4, IMPACT_SCALE = 1.6;
const impactFx = [];   // { fire, smoke, until }
async function loadImpactFx() {
  let spec = null;
  try { spec = await (await fetch('../fx/explosion.fx.json')).json(); } catch { /* 無し */ }
  if (spec && Array.isArray(spec.layers)) for (const l of spec.layers) { if (l.type === 'particle') { l.spawnRate = 0; if (l.maxParticles == null) l.maxParticles = 24; } }
  for (let i = 0; i < IMPACT_POOL; i++) {
    try {
      const fire = spec ? createMeshFx(spec) : null;
      const sCfg = cloneFxConfig(FX_PRESETS.smoke); sCfg.spawnRate = 0;
      if (sCfg.size) { sCfg.size.start = (sCfg.size.start || 1) * IMPACT_SCALE; sCfg.size.end = (sCfg.size.end || 1) * IMPACT_SCALE; }
      const smoke = createFxSystem(sCfg);
      if (fire) { fire.object3D.scale.setScalar(IMPACT_SCALE); fire.setEmitting(false); fire.object3D.visible = false; scene.add(fire.object3D); }
      smoke.setEmitting(false); smoke.object3D.visible = false; scene.add(smoke.object3D);
      impactFx.push({ fire, smoke, until: 0 });
    } catch (e) { console.warn('爆発FXプール生成失敗:', e.message); break; }
  }
}
function spawnImpactFx(pos, scale = 1) {
  if (!impactFx.length) return;
  let slot = impactFx.find((sl) => sl.until <= 0);
  if (!slot) { slot = impactFx[0]; for (const sl of impactFx) if (sl.until < slot.until) slot = sl; }
  if (slot.fire) {
    slot.fire.object3D.scale.setScalar(IMPACT_SCALE * scale);
    slot.fire.object3D.position.copy(pos);
    slot.fire.object3D.visible = true;
    slot.fire.burst(3);
  }
  slot.smoke.object3D.position.copy(pos);
  slot.smoke.object3D.visible = true;
  slot.smoke.burst(10);
  slot.until = IMPACT_LIFE;
}
function updateImpactFx(dt) {
  for (const sl of impactFx) {
    if (sl.until <= 0) continue;
    if (sl.fire) sl.fire.update(dt);
    sl.smoke.update(dt);
    sl.until -= dt;
    if (sl.until <= 0) { if (sl.fire) sl.fire.object3D.visible = false; sl.smoke.object3D.visible = false; }
  }
}
let explAudio = null;
function explodeGrenade(pr) {
  const m = pr.mesh.position;
  if (!explAudio) { explAudio = new Audio(); explAudio.src = '../audio/' + encodeURIComponent('爆破・爆発10.mp3'); explAudio.preload = 'auto'; }
  const a = explAudio.cloneNode();
  a.volume = Math.max(0.2, Math.min(1, 1 - m.distanceTo(player.pos) / 30));
  a.play().catch(() => {});
  spawnImpactFx(m, 1);
  if (vamp.ready && vamp.root.position.distanceTo(m) < 4.5) {
    if (vamp.holding) releaseHeldKen();
    vamp.stunT = (VAMP.stunSec || 2.2) * 2.2; vamp.state = 'stunned';
    if (vampSpeech) vampSpeech.bark('repelled');
  }
  const i = props.indexOf(pr); if (i >= 0) props.splice(i, 1);
  const di = dg.props ? dg.props.indexOf(pr.data) : -1; if (di >= 0) dg.props.splice(di, 1);
  scene.remove(pr.mesh);
}
function dropPropAt(model, x, z, y) {
  const d = { model, x: x / TILE, z: z / TILE, ry: Math.random() * Math.PI * 2, level: lvlOfY(y), grabbable: true };
  if (!dg.props) dg.props = [];
  dg.props.push(d);
  const pr = { data: d, mesh: makePropMesh(d), held: false, vel: null };
  scene.add(pr.mesh); props.push(pr);
}
function dropGrenadeAt(x, z, y) { dropPropAt('grenade', x, z, y); }

// 鍵/扉：扉はセルを塞ぐ（プレイヤー衝突＋NPCナビ両方）。鍵を持って近づくと開く
const doorObjs = [];   // {data, group, open}
function buildDoors() {
  for (const dr of doorObjs) scene.remove(dr.group);
  doorObjs.length = 0;
  if (nav) nav.doorSolid = new Set();
  for (const d of (dg.doors || [])) {
    const part = partsCache.door;
    if (!part) continue;
    const g = new THREE.Group();                       // ヒンジ＝セル端
    const leaf = part.obj.clone(true);
    leaf.position.x = TILE / 2;                        // 扉本体を蝶番からずらす
    g.add(leaf);
    g.scale.set(SCALE, SCALE, SCALE);
    g.position.set(d.x * TILE - Math.cos(d.ry || 0) * TILE / 2, (d.level || 0) * STORY_H, d.z * TILE + Math.sin(d.ry || 0) * TILE / 2);
    g.rotation.y = (d.ry || 0) + WALL_RY_OFFSET;
    g.userData.item = d;
    scene.add(g);
    doorObjs.push({ data: d, group: g, open: false });
    if (nav?.doorSolid) nav.doorSolid.add(Math.round(d.x) + ',' + Math.round(d.z));
  }
}
function doorSolidAt(cx, cz) { return doorObjs.some((dr) => !dr.open && Math.round(dr.data.x) === cx && Math.round(dr.data.z) === cz); }
function openDoor(dr) {
  dr.open = true; dr.anim = 0;
  if (nav?.doorSolid) nav.doorSolid.delete(Math.round(dr.data.x) + ',' + Math.round(dr.data.z));
  gameEvent('doorOpened', dr.data);
}
function updateDoors(dt) {
  updateImpactFx(dt);
  for (const pr of props) {   // 手榴弾の信管
    if (pr.fuse == null) continue;
    pr.fuse -= dt;
    if (pr.fuse <= 0) { pr.fuse = null; explodeGrenade(pr); break; }
  }
  for (const dr of doorObjs) {
    if (dr.open && dr.anim != null && dr.anim < 1) {   // 開閉アニメ（蝶番回転）
      dr.anim = Math.min(1, dr.anim + dt * 1.6);
      dr.group.rotation.y = (dr.data.ry || 0) + WALL_RY_OFFSET + dr.anim * 1.9;
    }
    if (!dr.open && heldProp && heldProp.data.model === 'key' && (heldProp.data.doorId == null || heldProp.data.doorId === dr.data.id)) {
      const dx = dr.data.x * TILE - player.pos.x, dz = dr.data.z * TILE - player.pos.z;
      if (dx * dx + dz * dz < 4 && Math.abs((dr.data.level || 0) * STORY_H + EYE_H - player.pos.y) < 2) {
        openDoor(dr);
        const pr = heldProp; heldProp = null;   // 鍵は消費
        const i = props.indexOf(pr); if (i >= 0) props.splice(i, 1);
        const di = dg.props ? dg.props.indexOf(pr.data) : -1; if (di >= 0) dg.props.splice(di, 1);
        scene.remove(pr.mesh);
      }
    }
  }
}

// ══════════ イベントバス＋雷演出 ══════════
// gameEvent('名前', 引数) で発火。トリガーボックス/実績/カットシーンから共通で使う
const EVENT_HANDLERS = {};
function onGameEvent(name, fn) { EVENT_HANDLERS[name] = fn; }
function gameEvent(name, arg) {
  const fn = EVENT_HANDLERS[name];
  if (fn) { try { fn(arg); } catch (e) { console.warn('イベント失敗:', name, e.message); } }
}

// 雷：音＋既存ライトの intensity 変調のみ（ライト追加なし＝負荷ゼロ）。ランダム＋イベント発火可
const thunder = { t: 0, seq: null, audio: null, nextAt: 18 + Math.random() * 35 };
function triggerThunder() {
  if (thunder.seq) return;   // 明滅中は重ねない
  thunder.seq = [[0, 4.5], [0.08, 0.6], [0.17, 6], [0.32, 2.2], [0.55, 0.6], [0.9, 0]];   // [秒, 強さ]
  thunder.t = 0;
  if (!thunder.audio) {
    const a = new Audio();
    a.src = '../sound/Thunder-Real_Ambi03-1.ogg';
    a.addEventListener('error', () => { if (!a.src.endsWith('./sound/Thunder-Real_Ambi03-1.ogg')) a.src = './sound/Thunder-Real_Ambi03-1.ogg'; }, { once: true });
    a.preload = 'auto';
    thunder.audio = a;
  }
  const a = thunder.audio.cloneNode(); a.volume = 0.85; a.play().catch(() => { /* 自動再生制限 */ });
}
function updateThunder(dt) {
  if (phase === 'playing' && !edit.on) {   // ランダム発生はプレイ中のみ
    thunder.nextAt -= dt;
    if (thunder.nextAt <= 0) { thunder.nextAt = 25 + Math.random() * 50; triggerThunder(); }
  }
  if (!thunder.seq) return;
  thunder.t += dt;
  const sq = thunder.seq;
  if (thunder.t >= sq[sq.length - 1][0]) { thunder.seq = null; applyLighting(); return; }   // 終了＝基準へ戻す
  let mul = 0;
  for (let i = 0; i < sq.length - 1; i++) {
    const t0 = sq[i][0], v0 = sq[i][1], t1 = sq[i + 1][0], v1 = sq[i + 1][1];
    if (thunder.t >= t0 && thunder.t < t1) { mul = v0 + (v1 - v0) * ((thunder.t - t0) / (t1 - t0)); break; }
  }
  if (LIGHTS.hemi) LIGHTS.hemi.intensity = lightCfg.hemi * (1 + mul * 2.2);
  if (LIGHTS.moon) LIGHTS.moon.intensity = lightCfg.moon * (1 + mul * 6);
}
onGameEvent('thunder', triggerThunder);

// ══════════ トリガーボックス＋イベント実装 ══════════
// ゲーム中は不可視・AABB判定のみ（毎フレーム、未発火のものだけ）。一度触れたら消滅
let subEl = null, subT = 0;
function showSubtitle(text) {
  if (!subEl) {
    subEl = document.createElement('div');
    subEl.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:26;color:#fff;font-size:15px;background:rgba(0,0,0,0.62);padding:8px 18px;border-radius:6px;pointer-events:none;display:none;max-width:70vw;line-height:1.7;';
    document.body.appendChild(subEl);
  }
  subEl.textContent = text;
  subEl.style.display = 'block';
  subT = Math.max(2.5, (text || '').length / 6);
}
let bgmAudio = null;
function playBgmFile(name, loop = true, vol = 0.5) {
  if (bgmAudio) { try { bgmAudio.pause(); } catch { /* noop */ } bgmAudio = null; }
  if (!name) return;
  const a = new Audio();
  a.src = '../bgm/' + encodeURIComponent(name);
  a.addEventListener('error', () => { if (!a.src.includes('/bgm/') || a.src.startsWith(location.origin + '/htdocs')) a.src = './bgm/' + encodeURIComponent(name); }, { once: true });
  a.loop = loop; a.volume = vol;
  a.play().catch(() => { /* 自動再生制限 */ });
  bgmAudio = a;
}
onGameEvent('speech', (ev) => showSubtitle((ev && ev.text) || ''));
onGameEvent('bgm', (ev) => playBgmFile(ev && ev.name, !ev || ev.loop !== false, (ev && ev.vol) ?? 0.5));
onGameEvent('vampWake', () => {
  if (!vamp.inactive) return;
  vamp.inactive = false;
  if (vamp.vrm) vamp.vrm.scene.visible = true;
  vamp.state = 'patrol'; vamp.path = null; vamp.repathT = 0;
});
onGameEvent('cutscene', (ev) => { const cs = (dg.cutscenes || []).find((c) => c.id === (ev && ev.id)); if (cs) playCutscene(cs); else console.warn('カットシーンが見つからない:', ev && ev.id); });

function updateTriggers(dt) {
  if (subT > 0) { subT -= dt; if (subT <= 0 && subEl) subEl.style.display = 'none'; }
  if (!dg.triggers) return;
  const px = player.pos.x / TILE, pz = player.pos.z / TILE, pl = lvlOfY(player.pos.y - EYE_H);
  for (const t of dg.triggers) {
    if (t._fired || (t.level || 0) !== pl) continue;
    const hw = (t.w || 1) / 2, hd = (t.d || 1) / 2;
    if (px >= t.x - hw && px <= t.x + hw && pz >= t.z - hd && pz <= t.z + hd) {
      t._fired = true;   // 一度きり（保存データには残る＝再スタートで復活）
      gameEvent(t.event?.type, t.event);
    }
  }
}

// ══════════ カットシーン（story-runner / story-ops 流用。既存NPCをアクターとして動かす）══════════
// 視点はプレイヤーのまま。クリック＝会話送りのみ受け付け。終了時はその位置・姿勢から行動再開（シームレス）
const cutscene = { on: false, runner: null, lips: new Map(), advance: null, fadeEl: null };
const csMoves = [];   // {root, fx, fz, tx, tz, t, dur, face, m?, done?}
function csActorOf(id) {
  if (!id || id === 'vamp' || id === '彼女') return vamp.ready ? { root: vamp.root, vrm: vamp.vrm, kind: 'vamp' } : null;
  if (id.startsWith('ken')) { const m = kens[+id.slice(3) || 0]; return (m && !m._remove) ? { root: m.vrm.scene, vrm: m.vrm, kind: 'ken', m } : null; }
  return null;
}
function csWaitClick() { return new Promise((res) => { cutscene.advance = res; }); }
function csFade(toBlack, dur, color) {
  if (!cutscene.fadeEl) {
    cutscene.fadeEl = document.createElement('div');
    cutscene.fadeEl.style.cssText = 'position:fixed;inset:0;z-index:35;pointer-events:none;opacity:0;background:#000;';
    document.body.appendChild(cutscene.fadeEl);
  }
  const el = cutscene.fadeEl;
  el.style.background = color || '#000';
  el.style.transition = 'opacity ' + ((dur || 500) / 1000) + 's';
  el.style.opacity = toBlack ? '1' : '0';
  return new Promise((res) => setTimeout(res, dur || 500));
}
function csLipOf(vrm) {
  let lip = cutscene.lips.get(vrm);
  if (!lip) { lip = createLipSync(vrm); cutscene.lips.set(vrm, lip); }
  return lip;
}
function csHooks() {
  return {
    say(op) {
      const a = csActorOf(op.actor);
      const lines = Array.isArray(op.lines) ? op.lines : [op.lines];
      return (async () => {
        for (const ln of lines) {
          const text = typeof ln === 'string' ? ln : (ln && ln.text) || '';
          showSubtitle(text); subT = 1e9;   // クリックで送るまで表示し続ける
          if (a) {
            csLipOf(a.vrm).play(text, op.cps || 8);
            if (ln && typeof ln === 'object' && ln.expression) { try { a.vrm.expressionManager?.setValue(ln.expression, ln.weight ?? 1); } catch { /* noop */ } }
          }
          await csWaitClick();
        }
        subT = 0.01;
      })();
    },
    wait() { return csWaitClick(); },
    delay(op) { return new Promise((r) => setTimeout(r, op.duration || 500)); },
    'actor.move'(op) {   // x/z はセル座標（ステージエディタと同じ単位）
      const a = csActorOf(op.id); if (!a) return;
      const mv = { root: a.root, fx: a.root.position.x, fz: a.root.position.z, tx: (op.x || 0) * TILE, tz: (op.z || 0) * TILE, t: 0, dur: Math.max(0.05, (op.duration || 1000) / 1000), face: op.face !== false, m: a.m, kind: a.kind };
      csMoves.push(mv);
      if (op.wait === false) return;
      return new Promise((res) => { mv.done = res; });
    },
    'actor.face'(op) {
      const a = csActorOf(op.id); if (!a) return;
      const t = (!op.target || op.target === 'camera') ? player.pos : (csActorOf(op.target)?.root.position || player.pos);
      const yaw = Math.atan2(t.x - a.root.position.x, t.z - a.root.position.z);
      if (a.kind === 'vamp') a.root.rotation.y = yaw - Math.atan2(bodyFwd.x, bodyFwd.z);
      else { a.root.rotation.y = yaw; if (a.m) a.m.faceYaw = yaw; }
    },
    'actor.show'(op) {   // 既存アクターの再配置として扱う（新規スポーンはしない）
      const a = csActorOf(op.id); if (!a) return;
      a.root.position.set((op.x || 0) * TILE, floorYAt((op.x || 0) * TILE, (op.z || 0) * TILE, 99), (op.z || 0) * TILE);
      if (op.ry != null) a.root.rotation.y = op.ry * Math.PI / 180;
    },
    'actor.expression'(op) {
      const a = csActorOf(op.id); if (!a) return;
      try { a.vrm.expressionManager?.setValue(op.expression, op.weight ?? 1); } catch { /* noop */ }
    },
    'bgm.play'(op) { playBgmFile(op.name, op.loop !== false, op.volume ?? 0.6); },
    'bgm.stop'() { playBgmFile(null); },
    se(op) {
      const a = new Audio('../sound/' + encodeURIComponent(op.name || ''));
      a.addEventListener('error', () => { a.src = '../audio/' + encodeURIComponent(op.name || ''); a.play().catch(() => {}); }, { once: true });
      a.volume = op.volume ?? 1; a.play().catch(() => { /* noop */ });
    },
    'fade.out'(op) { return csFade(true, op.duration, op.color); },
    'fade.in'(op) { return csFade(false, op.duration, op.color); },
    end() { /* runner 側で停止 */ },
  };
}
// テレポート直後はマントの粒子が旧位置に残り、バネが伸び切って弾ける。
// 非表示のまま小刻みに数十ステップ回して収束させ、落ち着いてから見せる（lib変更なし・再生成なし）
let capeSettleT = 0;
function capeSettle(sec = 0.7) {
  if (!vamp.cape) return;
  capeSettleT = sec;
  if (vamp.cape.clothMesh) vamp.cape.clothMesh.visible = false;
  try { for (let i = 0; i < 30; i++) vamp.cape.update(1 / 60, vamp.action ? vamp.action.time * 30 : 0); } catch { /* noop */ }
}

async function playCutscene(cs) {
  if (cutscene.on || !cs || !Array.isArray(cs.script) || phase !== 'playing') return;
  cutscene.on = true;
  document.exitPointerLock?.();
  for (const ac of (cs.actors || [])) {   // 立ち位置の初期配置（設定があるアクターだけ）
    const a = csActorOf(ac.npc); if (!a) continue;
    const jump = Math.hypot(a.root.position.x - ac.x * TILE, a.root.position.z - ac.z * TILE);
    a.root.position.set(ac.x * TILE, floorYAt(ac.x * TILE, ac.z * TILE, 99), ac.z * TILE);
    if (ac.ry != null) a.root.rotation.y = ac.ry * Math.PI / 180;
    if (a.kind === 'ken' && a.m) { a.m.path = null; a.m.faceYaw = a.root.rotation.y; }
    if (a.kind === 'vamp' && jump > 2) { a.root.updateMatrixWorld(true); if (vamp.vrm) vamp.vrm.scene.updateMatrixWorld(true); capeSettle(0.7); }
  }
  if (vamp.ready) vamp.path = null;
  cutscene.runner = createStoryRunner(cs.script, csHooks());
  try { await cutscene.runner.run(0); } catch (e) { console.warn('カットシーン失敗:', e.message); }
  for (const lip of cutscene.lips.values()) lip.stop();
  subT = 0.01;
  csMoves.length = 0;
  cutscene.on = false; cutscene.advance = null;
  if (vamp.ready) vamp.repathT = 0;   // 終了時の位置から行動再開
  for (const m of kens) if (!m._remove) m.repathT = 0;
  if (!touchMode && phase === 'playing') canvas.requestPointerLock();
}
function updateCutscene(dt) {
  for (let i = csMoves.length - 1; i >= 0; i--) {
    const mv = csMoves[i];
    mv.t += dt;
    const u = Math.min(1, mv.t / mv.dur);
    mv.root.position.x = mv.fx + (mv.tx - mv.fx) * u;
    mv.root.position.z = mv.fz + (mv.tz - mv.fz) * u;
    mv.root.position.y = floorYAt(mv.root.position.x, mv.root.position.z, mv.root.position.y + 0.6);
    if (mv.face) {
      const yaw = Math.atan2(mv.tx - mv.fx, mv.tz - mv.fz);
      if (mv.kind === 'vamp') mv.root.rotation.y = yaw - Math.atan2(bodyFwd.x, bodyFwd.z);
      else { mv.root.rotation.y = yaw; if (mv.m) mv.m.faceYaw = yaw; }
    }
    if (u >= 1) { if (mv.done) mv.done(); csMoves.splice(i, 1); }
  }
}
onGameEvent('propThrown', (pr) => { if (pr.data.model === 'grenade') pr.fuse = 2.5; });
onGameEvent('memoRead', (d) => { if (d.memo && d.memo.achievement) achSet(d.memo.achievement, true); });

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (phase === 'playing' && !edit.on && !cutscene.on) {
    nightT += dt;
    updatePlayer(dt);
    updateVamp(dt);
    updateKens(dt);
    updateCaptureView(dt);
    if (goalMesh) {
      goalMesh.rotation.y += dt * 0.8;
      if (Math.hypot(player.pos.x - goalMesh.position.x, player.pos.z - goalMesh.position.z) < 2.0 && Math.abs(player.pos.y - goalMesh.position.y) < 2.5) win('ゴールに到達した！');
    }
    if (nightT >= NIGHT_SEC) win('夜を耐え抜いた！');
  }
  // VRM/マントの更新（状態機械の後）
  if (vamp.ready) {
    if (!vamp.grabState && vamp.rdRecover <= 0 && vamp.mixer) vamp.mixer.update(dt);
    if (vamp.hips && !vamp.grabState && vamp.rdRecover <= 0) { vamp.hips.position.x = hipsRest.x; vamp.hips.position.z = hipsRest.z; }   // 腰はその場（前進はフットロック）。ミキサーの後に効かせる
    vamp.vrm.scene.updateMatrixWorld(true);
    if (phase === 'playing' && !vamp.grabState && vamp.rdRecover <= 0) headLook((vamp.state === 'capture' || vamp.state === 'holdKen') ? 1 : (vamp.state === 'chase' ? 0.6 : 0.25));
    updateVampExpr(dt);
    // 口パク＋行表情は状態表情の「後」・vrm.update の「前」（viseme が最後に勝つ＝npc-speech の設計順）
    if (cutscene.on) { const lip = cutscene.lips.get(vamp.vrm); if (lip) lip.update(dt * 1000); }
    else if (vampSpeech && phase === 'playing') { vampSpeech.onState(vamp.state); vampSpeech.update(dt); }
    if ((vamp.grabState || vamp.rdRecover > 0) && vamp.ragdoll) {
      const env = { floorY: floorYAt(vamp.root.position.x, vamp.root.position.z, vamp.root.position.y) };
      if (vamp.grabState === 'body') { sgUpdateAnchor(); env.pinBone = vamp.grabBone || 'chest'; env.pinPos = _sgAnchor; }
      updateRagdoll(vamp.ragdoll, dt, env);
    }
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
    if (speechUI) speechUI.update(dt, bubbleScreenPos);
    if (vamp.cape) { try { vamp.cape.update(dt, vamp.action ? vamp.action.time * 30 : 0); } catch { /* noop */ } }
    if (capeSettleT > 0) { capeSettleT -= dt; if (capeSettleT <= 0 && vamp.cape?.clothMesh) vamp.cape.clothMesh.visible = true; }
  }
  if (cutscene.on) {   // カットシーン中：移動補間＋職員の最小更新（アニメ・口パク）
    updateCutscene(dt);
    for (const m of kens) {
      if (m._remove) continue;
      const lip = cutscene.lips.get(m.vrm); if (lip) lip.update(dt * 1000);
      if (m.mixer) m.mixer.update(dt);
      m.vrm.update(dt);
    }
  }
  updateShotFx(dt);
  updateThunder(dt);
  if (phase === 'playing') { updateProps(dt); updateDoors(dt); updateTriggers(dt); updateShock(dt); }
  if (edit.on) editFrame();   // 選択枠・ホバー枠の更新
  applyObsCamera(dt);   // 観察モード時はプレイ視点を上書き
  renderer.render(scene, camera);
  frames++; const now = performance.now();
  if (now - lastFps >= 500) { fps = Math.round(frames / ((now - lastFps) / 1000)); frames = 0; lastFps = now; updateHUD(); }
});

// ── 起動 ──
setupTouch();
Promise.all([loadPaintingCfg(), loadTune(), loadEnemyCfg(), loadLighting(), loadStageCfg()]).then(() => { initKissAudio(); initGunAudio(); return buildDungeon(); }).then(async () => { dg.props = stageCfg?.props || []; dg.doors = stageCfg?.doors || []; dg.achEvents = stageCfg?.achEvents || []; dg.triggers = (stageCfg?.triggers || []).map((t) => ({ ...t, _fired: false })); dg.cutscenes = stageCfg?.cutscenes || []; vamp.inactive = dg.triggers.some((t) => t.event?.type === 'vampWake'); buildProps(); await ensurePart('door'); buildDoors(); loadImpactFx(); }).then(() => { nav = buildNav(dg); return loadVamp(); }).then(() => {
  initSpeech();
  prepareKenAssets().then(spawnStaff).catch((e) => console.warn('職員配置失敗:', e));
  resetPlayer();
  setupObsUI();
  setupEditUI(); applyLighting(); syncLightUI();   // 観察エディタとライティングを初期化
  $('btn-start').disabled = false;
  $('btn-start').textContent = 'スタート';
}).catch((e) => { setStatus('読み込み失敗: ' + e.message); console.error(e); });
$('btn-start').addEventListener('click', startGame);

window.__game = {
  get phase() { return phase; }, get player() { return player; }, get dg() { return dg; },
  startGame, camera, renderer, get goal() { return goalMesh; },
  teleport(cx, cz, lvl = 0) { player.pos.set(cx * TILE, lvl * STORY_H + EYE_H, cz * TILE); player.vel.set(0, 0, 0); },
  get vamp() { return vamp; }, get nav() { return nav; }, get drain() { return drain; },
  vampTo(cx, cz) { placeVampAt({ x: cx, z: cz }); vamp.path = null; vamp.repathT = 0; },
  fireShot, get KISS() { return KISS; }, get GRAB() { return GRAB; },
  get obs() { return obs; }, get lightCfg() { return lightCfg; },
  curAnim() { return vampAnimName; }, get enemyCfg() { return ENEMY_CFG; }, get kens() { return kens; }, get KEN() { return KEN; }, startHoldKen,
  get edit() { return edit; }, editEnter, editExit, editSelect, editArray, editSaveStage, setGoalCell, get stageCfg() { return stageCfg; },
  get bodyFwd() { return bodyFwd; }, get headFace() { return headFace; },
  staffShoot, playGunshot,
  gameEvent, triggerThunder, get props() { return props; }, propInteract, get heldProp() { return heldProp; }, get hoverProp() { return hoverProp; }, get memoOpen() { return memoOpen; }, capeSettle,
  partRotOf, partRefOf, get PART_CFG() { return PART_CFG; }, get partRefCache() { return partRefCache; },
  get ACH() { return ACH; }, achSet, get doorObjs() { return doorObjs; }, openDoor, dropGrenadeAt, explodeGrenade,
  get triggers() { return dg?.triggers; }, showSubtitle, playBgmFile, get vampInactive() { return vamp.inactive; },
  playCutscene, get cutscene() { return cutscene; }, get cutscenes() { return dg?.cutscenes; },
  tryShockGrab, shockRelease, get vampGrab() { return { state: vamp.grabState, bone: vamp.grabBone, recover: vamp.rdRecover }; }, dropPropAt,
  get partsCache() { return partsCache; },
  mouthWorld() { if (!vamp.head) return null; const hp=vamp.head.getWorldPosition(new THREE.Vector3()), hq=vamp.head.getWorldQuaternion(new THREE.Quaternion());
    return headFace.clone().multiplyScalar(KISS.fwd).setY(KISS.up).applyQuaternion(hq).add(hp); },
  kissSrc() { return kissAudio.el ? kissAudio.el.src.split('/').pop() : null; },
  grabTargets() { computeGrabTargets(_gpL, _gpR); return { l: _gpL.clone(), r: _gpR.clone() }; },
  handWorld() { return { l: vamp.armL?.end?.getWorldPosition(new THREE.Vector3()) || null, r: vamp.armR?.end?.getWorldPosition(new THREE.Vector3()) || null }; },
};
