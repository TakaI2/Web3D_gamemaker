// plateau-fly.js — PLATEAU(八王子)の 3D Tiles を three.js(WebGL) で読み込み、自由飛行で街を巡る。
// 3d-tiles-renderer が LOD/ストリーミング/視錐台カリングを担う（＝軽量化は標準装備）。
// ECEF の tileset を bounding-sphere 中心＋ENU で「八王子原点・Y-up」のローカル座標へ再中心化し、
// tps-flight 風のスペクテイター飛行で上空〜街中を移動。
// データ出典: 3D都市モデル PLATEAU / 国土交通省 / Pacific Spatial Solutions（CC BY 4.0）。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/KTX2Loader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { createMeshFx } from '../lib/fx-mesh.js';
import { createBeamFx } from '../lib/fx-beam.js';
import { createTornado } from '../lib/fx-tornado.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { createDissolve } from '../lib/fx-dissolve.js';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse, disposeRagdoll } from '../lib/vrm-ragdoll.js';
import { TilesRenderer } from 'https://esm.sh/3d-tiles-renderer@0.4.28?deps=three@0.184.0';
import { GLTFExtensionsPlugin, ImplicitTilingPlugin } from 'https://esm.sh/3d-tiles-renderer@0.4.28/plugins?deps=three@0.184.0';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import { generateBuildings } from '../lib/kenney-buildings.js';
import { generateHouse } from '../lib/room-gen.js';
import { createNpcSpeech } from '../lib/npc-speech.js';
import { createSpeechUI } from '../lib/speech-ui.js';
import { fetchSpeechSet, buildSpeechCharacter } from '../lib/speech-set.js';
import { uniform, color, float, positionWorld, mx_noise_float, clamp, texture, uv, mix, frontFacing } from 'https://esm.sh/three@0.184.0/tsl';

// 八王子(13201) 2025 LOD2 テクスチャ付き tileset（reearth CMS 配信）
const TILESET = 'https://assets.cms.plateau.reearth.io/assets/5b/5071b2-6b29-40b8-99a9-890e22b8feff/13201_hachioji-shi_pref_2025_citygml_1_op_bldg_3dtiles_lod2/tileset.json';

let renderer, scene, camera, tiles, pivot, groundGroup;
const keysDown = {};
let locked = false, recentered = false, diagMsg = '';
// TPS プレイヤー（tps-flight から移植・WebGL）
const KENNEY_CITY = true;   // true: PLATEAUタイルを撤去し実道路網にKenney建物を配置（破壊実験P1）
const PLAYER_NPC = 'Joy_reborn.npc.json';
const FACE_OFFSET = Math.PI;   // Joy_reborn は正面が逆焼き→180°補正
const flight = { accel: 32, drag: 2.4, maxSpeed: 8, turn: 8 };   // TPS-Flight と同じ操作感（ホイールで増速可）
const cam = { dist: 4.0, height: 1.2, follow: 8, side: 0.75 };   // side=肩越しオフセット(m)。プレイヤーを画面中心よりやや左へ＝クロスヘア/エフェクトが見やすい
const FADE = 0.18, DESCEND_SIN = 0.3;
const STATE_DEFS = {   // 飛行アニメ状態（各 timeline→VRMA）。tps-flight と同じ
  idle:      { tl: 'Joy_reborn_Fly_idle',   loop: true },
  fwd:       { tl: 'Joy_reborn_Fly_f',      loop: true },
  frontDown: { tl: 'Joy_reborn_front_down', loop: true },
  back:      { tl: 'Joy_reborn_Fly_back',   loop: true },
  left:      { tl: 'Joy_reborn_Fly_L',      loop: true },
  right:     { tl: 'Joy_reborn_Fly_R',      loop: true },
  grabMove:  { tl: 'Joy_reborn_Fly_f2',     loop: true },    // 掴んだまま移動
  grab:      { tl: 'Joy_reborn_capcher1',   loop: false },
  shot:      { tl: 'Joy_reborn_cas1_L1',    loop: false },   // 通常ビーム（FX埋め込み）
  throw:     { tl: 'Joy_reborn_throw',      loop: false },
  largeLoad: { tl: 'Joy_reborn_large_shot_load', loop: true },   // 左長押し＝チャージ
  large:     { tl: 'Joy_reborn_large_beam', loop: false },   // チャージ解放＝5秒貫通ビーム
  lightning: { tl: 'Joy_reborn_lightning',  loop: false },   // 3連目のスーパービーム
  totem:     { tl: 'Joy_reborn_totem',      loop: false },   // 接地中の長押し＝トーテム設置
};
const player = {
  vrm: null, mixer: null, cloth: null, states: {}, current: null, ready: false,
  pos: new THREE.Vector3(0, 230, 150), vel: new THREE.Vector3(), yaw: Math.PI, fwdY: 0,
  grounded: false,
  oneShot: null,        // { name, until } 一発再生（shot/throw/grab/lightning/large/totem）
  charging: false,      // 左クリック長押しでチャージ中
  chargeT: 0,
  prey: null,           // 右クリックで掴んだ ken（地面付近で保持→捕食）
  eating: false, eatT: 0,
};
// ── 攻撃（tps-flight 準拠＋計画の追加仕様）──
const TAP_THRESHOLD = 0.18, MAX_CHARGE_TIME = 1.5;
const SHOT_COMBO_WINDOW = 1.6;      // この間隔以内の連射でコンボ継続。3発目=lightning
const LARGE_BEAM_DUR = 5.0, LARGE_BEAM_TICK = 0.12, LARGE_BEAM_RANGE = 700;   // 貫通ビーム
const DMG_SHOT = 1, DMG_LIGHTNING = 2.5, DMG_LARGE_TICK = 0.55;               // 建物HPへのダメージ
const KEN_DMG_SHOT = 26, KEN_DMG_LIGHTNING = 60, KEN_DMG_LARGE_TICK = 30;     // ken HPへのダメージ
const GRAB_FRONT_DIST = 1.9, GRAB_FRONT_Y = 1.0, THROW_BOOST = 1.6, SHOT_LAUNCH = 60;
const PREY_GROUND_Y = 0.25, PREY_GROUND_TIME = 0.7, PREDATION_EAT_TIME = 4.5;  // 捕食(TPS_plan準拠)
const PREY_FRONT_Y = 0.25;          // 捕食対象を運ぶ間の前方アンカー高さ（低め＝地面に置ける）
const frontAnchor = new THREE.Vector3();
let shotComboN = 0, shotComboT = 0;      // 通常ビームのコンボ
const largeBeam = { active: false, t: 0, tickT: 0, mesh: null };   // 貫通ビーム進行
let totemCast = null;                    // { placed } トーテム設置アニメ進行
let camYaw = Math.PI, camPitch = 0.18;
const camPosCur = new THREE.Vector3(), camTargetCur = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3(), _desiredPos = new THREE.Vector3();

function $(id) { return document.getElementById(id); }
function showError(msg) { const e = $('err'); if (e) { e.style.display = 'block'; e.textContent = String(msg); } console.error(msg); }
function setStatus(msg) { const e = $('status'); if (e) e.textContent = msg; }

async function init() {
  const app = $('app');
  if (!navigator.gpu) { showError('WebGPU 非対応のブラウザです'); return; }
  renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });   // マント(GPUクロス)に必要
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ec6e6);
  scene.fog = new THREE.Fog(0x9ec6e6, 2500, 12000);
  dayRefs.bg = scene.background; dayRefs.fog = scene.fog;

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 1, 30000);   // FOV は TPS-Flight と同じ70
  camera.position.set(0, 600, 600);

  dayRefs.amb = new THREE.AmbientLight(0xffffff, 1.0); scene.add(dayRefs.amb);
  dayRefs.sun = new THREE.DirectionalLight(0xfff4e0, 1.7); dayRefs.sun.position.set(1, 2, 1.2); scene.add(dayRefs.sun);
  dayRefs.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x4a4a40, 0.6); scene.add(dayRefs.hemi);
  initSky();   // WebGPU用 SkyMesh（読めなければ背景色レルプにフォールバック）
  try { buildClouds(); } catch (e) { console.warn('雲生成失敗', e); }

  // ECEF→ローカル再中心化のためのピボット（tiles.group をぶら下げて逆ENUを掛ける）
  pivot = new THREE.Group(); pivot.matrixAutoUpdate = false; scene.add(pivot);

  // 原点の参照グリッド＋軸（タイルが出なくても座標系が見える＝八王子原点付近の地表）
  const grid = new THREE.GridHelper(8000, 80, 0x557799, 0x2a3a4a);   // 地表の目安（薄く）
  grid.material.transparent = true; grid.material.opacity = 0.16; scene.add(grid);

  if (!KENNEY_CITY) try {
    tiles = new TilesRenderer(TILESET);
    tiles.registerPlugin(new ImplicitTilingPlugin());   // 暗黙タイリング対応（PLATEAUで使う場合あり）
    // b3dm(RTC座標)＋DRACO/KTX2 を正しく展開する公式プラグイン（rtc:true が肝）
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/gltf/');
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/');
    try { ktx2.detectSupport(renderer); } catch (e) { console.warn('ktx2 detectSupport 失敗(WebGPU)', e); }
    tiles.registerPlugin(new GLTFExtensionsPlugin({ rtc: true, dracoLoader: draco, ktxLoader: ktx2 }));
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.errorTarget = 20;            // 画面誤差px（大きいほど粗く広く速い）。飛行なので広範囲優先
    // キャッシュ・並列度を上げて建物が速く広く出るように
    try {
      if (tiles.lruCache) { tiles.lruCache.minSize = 1200; tiles.lruCache.maxSize = 2200; }
      if (tiles.downloadQueue) tiles.downloadQueue.maxJobs = 12;
      if (tiles.parseQueue) tiles.parseQueue.maxJobs = 6;
    } catch (e) { console.warn('tiles cache設定', e); }
    pivot.add(tiles.group);
    tiles.addEventListener('load-error', (e) => { const m = 'タイル読込エラー: ' + (e?.error?.message || e?.url || 'unknown'); diagMsg = m; showError(m); });
    tiles.addEventListener('load-tile-set', () => { diagMsg = 'tileset parsed ✓'; console.log('[diag] load-tile-set'); });
    tiles.addEventListener('load-model', () => { diagMsg = 'models ✓'; });
  } catch (e) {
    showError('3d-tiles-renderer 初期化失敗: ' + (e?.message || e) + '（import か CORS を確認）');
  }

  recenterToHachioji();   // 固定原点で即時再中心化
  groundGroup = new THREE.Group(); scene.add(groundGroup);
  let chain = buildAerialGround();
  if (!KENNEY_CITY) chain = chain.then(() => new Promise((res) => setTimeout(res, 2500)));   // タイル優先で道路を後ろへ
  chain = chain.then(() => loadRoads());
  if (KENNEY_CITY) chain = chain.then(() => buildKenneyCity());   // 実道路網に Kenney 建物を配置
  chain = chain.then(() => {   // 世界完成後: 着弾FX・トーテム・地上NPC(ken)・生活エージェント
    loadImpactFx().catch((e) => console.warn('着弾FX準備失敗:', e));
    ensureTotemFx().catch((e) => console.warn('トーテムFX準備失敗:', e));
    prepareKenAssets().then((ok) => { if (ok) setKenCount(KEN_COUNT); }).catch((e) => console.warn('ken準備失敗:', e));
    try { initAgents(); } catch (e) { console.warn('agents初期化失敗:', e); }
  });
  chain.catch((e) => showError('地面/道路/建物生成失敗: ' + (e?.message || e)));
  loadPlayer().then(() => prepareBiteAssets()).catch((e) => console.warn('bite準備失敗:', e));   // TPSプレイヤー→捕食アセット
  setupControls();
  window.addEventListener('resize', onResize);
  renderer.setAnimationLoop(tick);
  const li = $('loading'); if (li) li.style.display = 'none';
  setStatus('クリックで視点ロック / WASD飛行 / Space上昇 Shift下降 / マウスで視点 / ホイール速度');
}

const D2R = Math.PI / 180;
function lla2ecef(latDeg, lonDeg, h) {
  const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = latDeg * D2R, lon = lonDeg * D2R, sLat = Math.sin(lat), cLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sLat * sLat);
  return new THREE.Vector3((N + h) * cLat * Math.cos(lon), (N + h) * cLat * Math.sin(lon), (N * (1 - e2) + h) * sLat);
}
// 八王子の緯度経度から ECEF→ローカルENU(原点=八王子・Y=up・-Z=north)へ即時再中心化（getBoundingSphere非依存）
function recenterToHachioji() {
  const latDeg = 35.6664, lonDeg = 139.3159;
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon);
  const east = new THREE.Vector3(-sLon, cLon, 0);
  const north = new THREE.Vector3(-sLat * cLon, -sLat * sLon, cLat);
  const up = new THREE.Vector3(cLat * cLon, cLat * sLon, sLat);
  const c = lla2ecef(latDeg, lonDeg, 0);
  const M = new THREE.Matrix4().makeBasis(east, up, north.clone().negate());   // X=east, Y=up, Z=south
  M.setPosition(c);
  pivot.matrix.copy(M.clone().invert()); pivot.matrixWorldNeedsUpdate = true;
  pivot.updateMatrixWorld(true);   // tiles.update() が正しい group ワールド行列を読めるよう即時反映
  recentered = true;
  console.log('recentered to Hachioji; ECEF origin=', c.toArray().map((v) => Math.round(v)));
}

// ── 地面: 地理院タイル(航空写真)＋DEM(標高)で地形追従。建物(楕円体高)に合わせ geoid 補正 ──
const GROUND_ZOOM = 16, GROUND_RADIUS = 5, DEM_ZOOM = 14, GROUND_SUB = 8;
const GEOID = 37;              // Kanto ジオイド高(概算, m)。DEM(標高)→楕円体高 へ +GEOID（建物と整合）
const GROUND_FALLBACK = 100;   // DEM欠測時の標高(m)
function lon2tileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function lat2tileY(lat, z) { const r = lat * D2R; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
function tileX2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function tileY2lat(y, z) { const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }
function llaToLocal(latDeg, lonDeg, h) { return lla2ecef(latDeg, lonDeg, h).applyMatrix4(pivot.matrix); }   // ECEF→ローカルENU

const _dem = new Map();   // "tx_ty"(DEM_ZOOM) -> Float32Array(256*256) 標高(m) | null
async function fetchDem(tx, ty) {
  const key = tx + '_' + ty; if (_dem.has(key)) return;
  try {
    const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem/${DEM_ZOOM}/${tx}/${ty}.txt`);
    if (!r.ok) { _dem.set(key, null); return; }
    const rows = (await r.text()).trim().split('\n');
    const grid = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) {
      const cells = (rows[j] || '').split(',');
      for (let i = 0; i < 256; i++) { const v = cells[i]; grid[j * 256 + i] = (v === undefined || v === 'e' || v === '') ? NaN : parseFloat(v); }
    }
    _dem.set(key, grid);
  } catch { _dem.set(key, null); }
}
function elevAt(lat, lon) {   // 標高(m)。欠測は GROUND_FALLBACK
  const n = Math.pow(2, DEM_ZOOM);
  const fx = (lon + 180) / 360 * n;
  const r = lat * D2R;
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  const grid = _dem.get(Math.floor(fx) + '_' + Math.floor(fy));
  if (!grid) return GROUND_FALLBACK;
  const px = Math.max(0, Math.min(255, Math.floor((fx - Math.floor(fx)) * 256)));
  const py = Math.max(0, Math.min(255, Math.floor((fy - Math.floor(fy)) * 256)));
  const v = grid[py * 256 + px];
  return Number.isFinite(v) ? v : GROUND_FALLBACK;
}

async function buildAerialGround() {
  const loader = new THREE.TextureLoader();
  const clat = 35.6664, clon = 139.3159, z = GROUND_ZOOM;
  const cx = lon2tileX(clon, z), cy = lat2tileY(clat, z);
  // 範囲を覆う DEM タイル(z14)を先読み
  const lonMin = tileX2lon(cx - GROUND_RADIUS, z), lonMax = tileX2lon(cx + GROUND_RADIUS + 1, z);
  const latMax = tileY2lat(cy - GROUND_RADIUS, z), latMin = tileY2lat(cy + GROUND_RADIUS + 1, z);
  const dJobs = [];
  for (let ty = lat2tileY(latMax, DEM_ZOOM); ty <= lat2tileY(latMin, DEM_ZOOM); ty++)
    for (let tx = lon2tileX(lonMin, DEM_ZOOM); tx <= lon2tileX(lonMax, DEM_ZOOM); tx++)
      dJobs.push(fetchDem(tx, ty));
  await Promise.all(dJobs);
  // 航空写真タイルを地形追従メッシュ(SUB×SUB分割)として配置
  const S = GROUND_SUB;
  for (let dy = -GROUND_RADIUS; dy <= GROUND_RADIUS; dy++) {
    for (let dx = -GROUND_RADIUS; dx <= GROUND_RADIUS; dx++) {
      const tx = cx + dx, ty = cy + dy;
      const lonW = tileX2lon(tx, z), lonE = tileX2lon(tx + 1, z);
      const latN = tileY2lat(ty, z), latS = tileY2lat(ty + 1, z);
      const pos = [], uv = [], idx = [];
      for (let gy = 0; gy <= S; gy++) {
        for (let gx = 0; gx <= S; gx++) {
          const lon = lonW + (lonE - lonW) * (gx / S);
          const lat = latN + (latS - latN) * (gy / S);
          const p = llaToLocal(lat, lon, elevAt(lat, lon) + GEOID);
          pos.push(p.x, p.y, p.z); uv.push(gx / S, gy / S);   // UV: 画像NW(左上)=(0,0)。flipY=false
        }
      }
      for (let gy = 0; gy < S; gy++) for (let gx = 0; gx < S; gx++) {
        const a = gy * (S + 1) + gx, b = a + 1, c = a + (S + 1), d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      const url = `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${tx}/${ty}.jpg`;
      const tex = loader.load(url, undefined, undefined, () => { /* 欠けは無視 */ });
      tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      mesh.renderOrder = -1;   // 建物より先に描画
      groundGroup.add(mesh);
    }
  }
  console.log('aerial+DEM ground tiles:', groundGroup.children.length, 'dem tiles:', _dem.size);
}

// ── TPS プレイヤー（tps-flight 移植。WebGL版 MToon で VRM を読む）──
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (!t.name.endsWith('.position')) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
}
function lerpAngle(a, b, t) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }
function clampSpeed(v, max) { const s = v.length(); if (s > max) v.multiplyScalar(max / s); }

async function loadPlayer() {
  try {
    const bundle = await (await fetch('../npc/' + PLAYER_NPC)).json();
    if (!bundle?.vrm) { showError('プレイヤーVRMが見つかりません'); return; }
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
    const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
    const vrm = gltf.userData.vrm;
    vrm.scene.position.copy(player.pos);
    vrm.scene.rotation.y = player.yaw + FACE_OFFSET;
    scene.add(vrm.scene); vrm.scene.updateMatrixWorld(true);
    player.vrm = vrm;
    player.mixer = new THREE.AnimationMixer(vrm.scene);
    // マント（GPUクロス）。空中でも落ちないよう floorY 無効化
    if (bundle.cloth) {
      try { player.cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: player.pos, floorY: -1e9 }); }
      catch (e) { console.warn('マント生成失敗:', e); }
    }
    // 飛行アニメ状態（timeline→VRMA→trim）。tps-flight と同じ状態機械
    for (const [name, def] of Object.entries(STATE_DEFS)) {
      try {
        const tl = await (await fetch('../timeline/' + def.tl + '.timeline.json')).json();
        const vrmaName = tl.vrma; if (!vrmaName) continue;
        const vres = await fetch('../vrma/' + encodeURIComponent(vrmaName)); if (!vres.ok) continue;
        const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p));
        const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
        const anims = ag.userData.vrmAnimations; if (!anims?.length) continue;
        const clip = createVRMAnimationClip(anims[0], vrm); stripRootMotion(clip);
        const action = player.mixer.clipAction(clip);
        action.setLoop(def.loop ? THREE.LoopRepeat : THREE.LoopOnce, def.loop ? Infinity : 1);
        action.clampWhenFinished = !def.loop;
        const fps = tl.fps || 30;
        const total = Math.max(1, Math.round(clip.duration * fps));
        const tin = Number.isFinite(tl.trimIn) ? Math.max(0, Math.min(tl.trimIn, total - 1)) : 0;
        const tout = Number.isFinite(tl.trimOut) ? Math.max(tin + 1, Math.min(tl.trimOut, total)) : total;
        const speed = (Number.isFinite(tl.speed) && tl.speed > 0) ? tl.speed : 1;
        player.states[name] = { action, timeline: tl, fps, dur: clip.duration, loop: def.loop, trimIn: tin, trimOut: tout, total, speed };
        await createStateEffects(player.states[name], tl);   // timeline の effect トラック（FXエディタ配置）を準備
      } catch (e) { console.warn('状態ロード失敗:', name, e); }
    }
    const idle = player.states.idle;
    if (idle) { idle.action.play(); idle.action.setEffectiveWeight(1); player.current = 'idle'; if (player.cloth) player.cloth.setTimeline(idle.timeline); }
    camForwardRight();   // TPSカメラ初期化（スナップ回避）
    camTargetCur.copy(player.pos); camTargetCur.y += cam.height;
    camPosCur.copy(camTargetCur).addScaledVector(_fwd, -cam.dist);
    player.ready = true;
    console.log('player ready; states=', Object.keys(player.states).length);
  } catch (e) { showError('プレイヤー読込失敗: ' + (e?.message || e)); }
}

function camForwardRight() {
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  _fwd.set(cp * Math.sin(camYaw), sp, cp * Math.cos(camYaw)).normalize();
  _right.set(-_fwd.z, 0, _fwd.x).normalize();
}
function updateFlight(dt) {
  if (!player.ready) return;
  if (player.eating) { player.vel.set(0, 0, 0); return; }   // 捕食中はその場で静止
  camForwardRight();
  player.fwdY = _fwd.y;
  _move.set(0, 0, 0);
  const fwd = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwd) _move.add(_fwd);
  if (keysDown['KeyS'] || keysDown['ArrowDown']) _move.sub(_fwd);
  if (keysDown['KeyD'] || keysDown['ArrowRight']) _move.add(_right);
  if (keysDown['KeyA'] || keysDown['ArrowLeft']) _move.sub(_right);
  if (keysDown['Space']) _move.y += 1;
  if (keysDown['ShiftLeft'] || keysDown['ControlLeft']) _move.y -= 1;
  if (_move.lengthSq() > 1e-6) { _move.normalize(); player.vel.addScaledVector(_move, flight.accel * dt); }
  const holding = isHolding();
  if (holding) player.yaw = lerpAngle(player.yaw, camYaw, Math.min(1, 18 * dt));   // 掴み中は体をマウス方向へ（振り回し）
  else if (fwd) { const ty = Math.atan2(_fwd.x, _fwd.z); player.yaw = lerpAngle(player.yaw, ty, Math.min(1, flight.turn * dt)); }
  player.vel.multiplyScalar(Math.exp(-flight.drag * dt));
  clampSpeed(player.vel, flight.maxSpeed);
  player.pos.addScaledVector(player.vel, dt);
  player.grounded = false;
  if (interior.active) interiorClamp();   // 内装内は部屋境界と床でクランプ
  else {
    if (KENNEY_CITY) collidePlayer();   // 建物と衝突→押し出し・屋上着地
    groundCollide();                    // 地面(地形)に着地
  }
  player.vrm.scene.position.copy(player.pos);
  player.vrm.scene.rotation.y = player.yaw + FACE_OFFSET;
  // 前方アンカー（掴んだ物の吸着点）。掴み中はカメラ3D前方＝上下にも振り回せる
  const reach = GRAB_FRONT_DIST + (grabbedCar ? 1.6 : 0);
  if (holding) frontAnchor.copy(_fwd).multiplyScalar(reach).add(player.pos);
  else frontAnchor.set(Math.sin(player.yaw), 0, Math.cos(player.yaw)).multiplyScalar(reach).add(player.pos);
  frontAnchor.y += (player.prey && !player.eating) ? PREY_FRONT_Y : GRAB_FRONT_Y;
}
function isHolding() { return !!grabbedCar || !!grabbedKen(); }
function setState(name) {
  if (!player.states[name] || player.current === name) return;
  if (player.current && player.states[player.current]) hideStateEffects(player.states[player.current]);
  const prev = player.current ? player.states[player.current].action : null;
  const next = player.states[name];
  next.effLastFrame = -1;   // effect 発火追跡をリセット
  next.action.reset();
  next.action.setEffectiveTimeScale(next.speed || 1);
  next.action.setEffectiveWeight(1);
  next.action.enabled = true;
  if (next.trimIn > 0) next.action.time = next.trimIn / next.fps;
  next.action.play();
  if (prev && prev !== next.action) prev.crossFadeTo(next.action, FADE, false);
  player.current = name;
  if (player.cloth) player.cloth.setTimeline(next.timeline);
}
function desiredState() {
  if (player.oneShot) return player.oneShot.name;
  const moving = keysDown['KeyW'] || keysDown['ArrowUp'] || keysDown['KeyS'] || keysDown['ArrowDown']
              || keysDown['KeyA'] || keysDown['ArrowLeft'] || keysDown['KeyD'] || keysDown['ArrowRight'];
  if (player.charging && player.chargeT >= TAP_THRESHOLD) return 'largeLoad';   // 閾値超過の長押し＝溜め
  if (isHolding()) return moving ? 'grabMove' : 'idle';
  const fwd = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwd && player.fwdY < -DESCEND_SIN) return 'frontDown';
  if (fwd) return 'fwd';
  if (keysDown['KeyS'] || keysDown['ArrowDown']) return 'back';
  if (keysDown['KeyA'] || keysDown['ArrowLeft']) return 'left';
  if (keysDown['KeyD'] || keysDown['ArrowRight']) return 'right';
  return 'idle';
}
function triggerOneShot(name) {
  const st = player.states[name];
  if (!st) return;
  const playDur = (st.trimOut - st.trimIn) / st.fps;
  player.oneShot = { name, until: Math.max(0.05, playDur / (st.speed || 1)) };
  st.action.reset();
  if (st.trimIn > 0) st.action.time = st.trimIn / st.fps;
  st.action.setEffectiveTimeScale(st.speed || 1);
  setState(name);
}
function applyTrim() {
  const st = player.states[player.current];
  if (!st || (st.trimIn <= 0 && st.trimOut >= st.total)) return;
  const inT = st.trimIn / st.fps, outT = st.trimOut / st.fps, a = st.action;
  let changed = false;
  if (a.time >= outT) { if (st.loop) { const span = Math.max(1e-3, outT - inT); a.time = inT + ((a.time - inT) % span); } else a.time = outT; changed = true; }
  else if (a.time < inT - 1e-4) { a.time = inT; changed = true; }
  if (changed) player.mixer.update(0);
}
function updatePlayerAnim(dt) {
  if (!player.ready) return;
  if (player.eating) { updatePlayerEating(dt); return; }   // 捕食中は feed のみ駆動
  if (player.oneShot) {
    player.oneShot.until -= dt;
    if (player.oneShot.until <= 0) { player.oneShot = null; if (!largeBeam.active) attackAimActive = false; }   // 攻撃終了で照準固定を解除
  }
  if (player.charging) {
    player.chargeT = Math.min(MAX_CHARGE_TIME, player.chargeT + dt);
    // 接地中＋捕食対象なし＝長押しがトーテム設置に化ける（空中はチャージ→large_beam）
    if (player.chargeT >= TAP_THRESHOLD && player.grounded && !player.prey && !grabbedCar && !totemCast) {
      player.charging = false;
      startTotemCast();
    }
  }
  setState(desiredState());
  player.mixer.update(dt);
  applyTrim();
  player.vrm.update(dt);
  const cst = player.states[player.current];
  const curFrame = cst ? Math.floor(cst.action.time * cst.fps) : 0;
  if (player.cloth && cst) player.cloth.update(dt, curFrame);
  if (cst) driveStateEffects(cst, curFrame, dt);   // timeline 埋め込みFXをアニメと同期
  if (totemCast && player.current === 'totem' && !totemCast.placed && curFrame >= TOTEM_CAST_FRAME) { totemCast.placed = true; placeTotem(); }
  if (totemCast && player.current !== 'totem') totemCast = null;   // アニメが終わった/中断された
}
const _camRayC = new THREE.Raycaster(), _camDirC = new THREE.Vector3();
function updateCamera(dt) {
  if (!player.ready) return;
  camForwardRight();
  _desiredTarget.copy(player.pos); _desiredTarget.y += cam.height;
  _desiredTarget.addScaledVector(_right, cam.side);   // 注視点を右へ→プレイヤーは画面左に寄る（肩越し）
  _desiredPos.copy(_desiredTarget).addScaledVector(_fwd, -cam.dist);
  let blocked = false;
  if (interior.active && interior.group) {   // 屋内: 注視点→カメラ間に壁があれば手前へ詰める（めり込み防止）
    _camDirC.copy(_desiredPos).sub(_desiredTarget);
    const want = _camDirC.length();
    _camDirC.normalize();
    _camRayC.set(_desiredTarget, _camDirC);
    _camRayC.far = want + 0.3;
    const hit = _camRayC.intersectObject(interior.group, true)[0];
    if (hit && hit.distance < want) {
      _desiredPos.copy(_desiredTarget).addScaledVector(_camDirC, Math.max(0.35, hit.distance - 0.25));
      blocked = true;
    }
  }
  const k = 1 - Math.exp(-cam.follow * dt);
  if (blocked) camPosCur.copy(_desiredPos);   // 遮蔽時はスナップ（補間中の壁抜けを防ぐ）
  else camPosCur.lerp(_desiredPos, k);
  camTargetCur.lerp(_desiredTarget, k);
  camera.position.copy(camPosCur); camera.lookAt(camTargetCur);
}

// ── timeline 埋め込みFXの再生エンジン（tps-flight から移植）──
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
async function makeEffectFx(track) {
  const preset = track.preset || 'fire';
  if (preset.startsWith('custom:')) {
    const spec = await loadFxSpec(preset.slice(7));
    return spec ? createMeshFx(spec) : null;
  }
  if (preset === 'beam') {   // FXエディタのビーム（from=アンカー / to=到達点）。lib/fx-beam
    const fx = createBeamFx({ ...(track.params || {}), style: track.beamStyle || 'jagged' });
    try {
      if (track.beamTex && fx.setTexture) fx.setTexture(track.beamTex.src, track.beamTex.cols, track.beamTex.rows, track.beamTex.fps);
      if (track.tubeTex && fx.setTubeTexture) fx.setTubeTexture(track.tubeTex.src, track.tubeTex.cols, track.tubeTex.rows, track.tubeTex.fps);
      if (track.path && fx.setParam) { fx.setParam('pathPhase', track.path.phase); fx.setParam('pathTiles', track.path.tiles); }
    } catch (e) { console.warn('beam設定失敗:', e); }
    return fx;
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
function computeEffectTransform(trk, obj) {
  const pos = trk.pos || [0, 0, 0], rot = trk.rot || [0, 0, 0];
  _efE.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R);
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
// ビームの端点（from=アンカー / to=到達点）。fx-editor の beamEndpoints 相当をプレイヤー空間で再現
const _bFrom = new THREE.Vector3(), _bTo = new THREE.Vector3();
// 攻撃の実着弾点。有効な間はビームFXの到達点をここへ上書き（＝エフェクトと破壊地点を一致させる）
const attackAim = new THREE.Vector3();
let attackAimActive = false;
function beamTrackEndpoints(trk, outFrom, outTo) {
  // from: bone/world アンカー（computeEffectTransform の位置計算と同じ）
  const pos = trk.pos || [0, 0, 0];
  let fromSet = false;
  if (trk.anchor === 'bone' && player.vrm) {
    const node = player.vrm.humanoid?.getNormalizedBoneNode(trk.bone);
    if (node) {
      node.updateWorldMatrix(true, false);
      node.getWorldPosition(_efPos); node.getWorldQuaternion(_efQuat);
      outFrom.copy(_efOff.set(pos[0], pos[1], pos[2]).applyQuaternion(_efQuat)).add(_efPos);
      fromSet = true;
    }
  }
  if (!fromSet) {
    _efQuat.setFromAxisAngle(_EF_UP, player.yaw + FACE_OFFSET);
    outFrom.copy(_efOff.set(pos[0], pos[1], pos[2]).applyQuaternion(_efQuat)).add(player.pos);
  }
  // to: 攻撃中は実着弾点へ（エフェクト＝破壊地点）。それ以外はエディタ設定（bone/gizmo）
  if (attackAimActive) { outTo.copy(attackAim); return; }
  const to = trk.to || { mode: 'gizmo', pos: [0, 1.2, 2] };
  if (to.mode === 'bone' && player.vrm) {
    const node = player.vrm.humanoid?.getNormalizedBoneNode(to.bone);
    if (node) { node.updateWorldMatrix(true, false); node.getWorldPosition(outTo); return; }
  }
  const tp = to.pos || [0, 1.2, 2];
  _efQuat.setFromAxisAngle(_EF_UP, player.yaw + FACE_OFFSET);
  outTo.copy(_efOff.set(tp[0], tp[1], tp[2]).applyQuaternion(_efQuat)).add(player.pos);
}
function driveStateEffects(st, frame, dt) {
  if (!st || !st.effects || !st.effects.length) return;
  let prev = st.effLastFrame;
  if (frame < prev) prev = frame - 1;
  const forceOn = largeBeam.active && player.states.large === st;   // ラージ発射中(5秒)は range 外でも点灯し続ける
  for (const ef of st.effects) {
    const trk = ef.track;
    if (trk.preset === 'beam' && ef.fx.setEndpoints) {   // ビームは毎フレーム端点を張り直す（fx-editor 同様）
      const on = forceOn || (trk.mode === 'range' ? (frame >= (trk.start ?? 0) && frame <= (trk.end ?? 0)) : true);
      ef.fx.setEmitting(on);
      if (on) {
        ef.fx.object3D.visible = true;
        if (ef.fx.setPathMode) ef.fx.setPathMode(false);   // 経路モードは未使用（直線）
        beamTrackEndpoints(trk, _bFrom, _bTo);
        ef.fx.setEndpoints(_bFrom, _bTo, camera.position);
      }
      ef.fx.update(dt);
      continue;
    }
    computeEffectTransform(trk, ef.fx.object3D);
    if (trk.mode === 'range') {
      const on = forceOn || (frame >= (trk.start ?? 0) && frame <= (trk.end ?? 0));
      ef.fx.setEmitting(on);
      if (on) ef.fx.object3D.visible = true;
    } else if (trk.frame > prev && trk.frame <= frame) {
      ef.fx.object3D.visible = true;
      ef.fx.burst(trk.count || 10);
    }
    ef.fx.update(dt);
  }
  st.effLastFrame = frame;
}
function hideStateEffects(st) {
  if (!st || !st.effects) return;
  for (const ef of st.effects) { ef.fx.setEmitting(false); ef.fx.object3D.visible = false; }
}

// ── 着弾FX（炎=explosion.fx.json＋煙=smokeプリセット）。プール＋同時数キャップ ──
const IMPACT_POOL = 10, IMPACT_LIFE = 1.4, IMPACT_SCALE = 10;   // 建物スケールに合わせ大きめの炎煙
const impactFx = [];   // { fire, smoke, until }
async function loadImpactFx() {
  let spec = null;
  try { spec = await (await fetch('../fx/explosion.fx.json')).json(); } catch { /* 無し */ }
  if (spec && Array.isArray(spec.layers)) for (const l of spec.layers) { if (l.type === 'particle') { l.spawnRate = 0; if (l.maxParticles == null) l.maxParticles = 24; } }
  for (let i = 0; i < IMPACT_POOL; i++) {
    try {
      const fire = spec ? createMeshFx(spec) : null;
      const sCfg = cloneFxConfig(FX_PRESETS.smoke); sCfg.spawnRate = 0;
      if (sCfg.size) { sCfg.size.start = (sCfg.size.start || 1) * IMPACT_SCALE; sCfg.size.end = (sCfg.size.end || 1) * IMPACT_SCALE; }   // 煙も5倍
      const smoke = createFxSystem(sCfg);
      if (fire) { fire.object3D.scale.setScalar(IMPACT_SCALE); fire.setEmitting(false); scene.add(fire.object3D); }   // 炎(メッシュFX)は丸ごと5倍
      smoke.setEmitting(false); scene.add(smoke.object3D);
      impactFx.push({ fire, smoke, until: 0 });
    } catch (e) { console.warn('着弾FXプール生成失敗', e); break; }
  }
}
function spawnImpactFx(pos) {
  if (!impactFx.length) return;
  let slot = impactFx.find((s) => s.until <= 0);
  if (!slot) { slot = impactFx[0]; for (const s of impactFx) if (s.until < slot.until) slot = s; }
  if (slot.fire) { slot.fire.object3D.position.copy(pos); slot.fire.object3D.visible = true; slot.fire.burst(3); }
  slot.smoke.object3D.position.copy(pos); slot.smoke.object3D.visible = true; slot.smoke.burst(10);
  slot.until = IMPACT_LIFE;
}
function updateImpactFx(dt) {
  for (const s of impactFx) {
    if (s.until <= 0) continue;
    if (s.fire) s.fire.update(dt);
    s.smoke.update(dt);
    s.until -= dt;
    if (s.until <= 0) { if (s.fire) s.fire.object3D.visible = false; s.smoke.object3D.visible = false; }
  }
}

// ── Phase B: 道路グラフ＋車走行（参照プロジェクトの OSM 道路 public/roads/*.json）──
const CAR_KIT = ['sedan', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'police', 'van', 'delivery', 'truck', 'hatchback-sports'].map((n) => 'car_GLB format/' + n + '.glb');
const CAR_COUNT = 120, CAR_RADIUS = 1600, CAR_SPEED = 12, CAR_FACE = 0, CAR_NEAR_R = 500;   // 掴みテストできる密度に増量。大半をプレイヤー近傍へ
let roadNodes = new Map();     // id -> { local:Vector3, adj:Set }
let activeEdges = [];          // { aId, bId, a, b, len }
let cars = [];

async function loadRoads() {
  let files = [];
  try { files = await (await fetch('../roads/manifest.json')).json(); } catch { showError('道路manifest取得失敗'); return; }
  if (!Array.isArray(files) || !files.length) { console.warn('roads: no files'); return; }
  const nodes = new Map(), adj = new Map();
  const tiles = await Promise.all(files.map((f) => fetch('../roads/' + f).then((r) => r.ok ? r.json() : null).catch(() => null)));
  for (const j of tiles) {
    if (!j) continue;
    for (const n of (j.nodes || [])) nodes.set(n[0], [n[1], n[2]]);   // [lon,lat]
    for (const e of (j.edges || [])) {
      if (!adj.has(e[0])) adj.set(e[0], new Set()); adj.get(e[0]).add(e[1]);
      if (!adj.has(e[1])) adj.set(e[1], new Set()); adj.get(e[1]).add(e[0]);   // 双方向化
    }
  }
  // 中心付近(DEM範囲)のノードだけローカル座標化
  roadNodes = new Map();
  for (const [id, ll] of nodes) {
    const local = llaToLocal(ll[1], ll[0], elevAt(ll[1], ll[0]) + GEOID + 0.5);   // 路面=地面+0.5m
    if (Math.hypot(local.x, local.z) > CAR_RADIUS) continue;
    roadNodes.set(id, { local, adj: adj.get(id) });
  }
  activeEdges = [];
  const seen = new Set();
  for (const [id, nd] of roadNodes) {
    for (const nb of (nd.adj || [])) {
      if (!roadNodes.has(nb)) continue;
      const key = id < nb ? id + '_' + nb : nb + '_' + id;
      if (seen.has(key)) continue; seen.add(key);
      const a = roadNodes.get(id).local, b = roadNodes.get(nb).local;
      activeEdges.push({ aId: id, bId: nb, a, b, len: a.distanceTo(b) });
    }
  }
  await buildRoadMeshes().catch((e) => { console.warn('道路メッシュ生成失敗（デバッグ線で代替）:', e); drawRoadLines(); });
  await spawnCars();
  try { buildCarLights(); } catch (e) { console.warn('車ライト生成失敗', e); }
  console.log('roads center nodes', roadNodes.size, 'edges', activeEdges.length, 'cars', cars.length);
}
// ── P2: 道路の実体化＋街灯 ─────────────────────────────────────
// OSM実道路は任意角度なので Kenney の road-straight を「エッジ長に引き伸ばし」てインスタンス配置。
// 交差点ノードは円パッチで繋ぎ、街灯(light-curved)を等間隔配置＋夜だけ光る発光点を Points で重ねる。
const ROAD_WIDTH = 7.0;        // 道路幅(m)
const ROAD_LIFT = 0.12;        // 地形からの浮かせ量（z-fighting回避）
const LIGHT_SPACING = 42;      // 街灯間隔(m)
const LIGHT_HEIGHT = 5.5;      // 街灯の高さ(m)
const MAX_LIGHTS = 3000;
let streetGlowMat = null;
async function buildRoadMeshes() {
  if (!activeEdges.length) return;
  const loader = new GLTFLoader();
  const loadKit = async (name) => {
    const gltf = await loader.loadAsync(new URL('../models/kenney_city-kit-roads/Models/GLB%20format/' + name + '.glb', location.href).href);
    return bakeModel(gltf.scene);   // {geometry, material, baseY, size}
  };
  const road = await loadKit('road-straight');
  const lamp = await loadKit('light-curved');
  // 道路: レーン方向をZに正規化（正方形タイルはレーンがX向き＝90°回す）→底面を0へ
  const rg = road.geometry.clone();
  if (road.size.z >= road.size.x) rg.rotateY(Math.PI / 2);
  rg.computeBoundingBox();
  const rb = rg.boundingBox;
  rg.translate(-(rb.min.x + rb.max.x) / 2, -rb.min.y, -(rb.min.z + rb.max.z) / 2);
  const roadLen = Math.max(0.01, rb.max.z - rb.min.z), roadWid = Math.max(0.01, rb.max.x - rb.min.x);
  const wScale = ROAD_WIDTH / roadWid;
  const roadMesh = new THREE.InstancedMesh(rg, road.material, activeEdges.length);
  roadMesh.frustumCulled = false;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _rotM = new THREE.Matrix4(), _zero = new THREE.Vector3();
  for (let i = 0; i < activeEdges.length; i++) {
    const e = activeEdges[i];
    _dir.copy(e.b).sub(e.a);
    const len = _dir.length() || 1;
    _dir.normalize();
    _rotM.lookAt(_zero, _dir, _up);           // -Z→dir（道路は前後対称なので符号は不問）
    _q.setFromRotationMatrix(_rotM);
    _p.copy(e.a).add(e.b).multiplyScalar(0.5);
    _p.y += ROAD_LIFT;
    _s.set(wScale, 1, len / roadLen);   // 厚みは等倍（幅スケールを掛けると路面が数十cm持ち上がる）
    _m.compose(_p, _q, _s);
    roadMesh.setMatrixAt(i, _m);
  }
  scene.add(roadMesh);
  // 交差点パッチ（全ノードに道路色の円）
  const patchGeo = new THREE.CircleGeometry(0.5, 20);
  patchGeo.rotateX(-Math.PI / 2);
  const patchMat = new THREE.MeshStandardMaterial({ color: 0x46484c, roughness: 0.95 });
  const nodes = [...roadNodes.values()];
  const patch = new THREE.InstancedMesh(patchGeo, patchMat, nodes.length);
  patch.frustumCulled = false;
  for (let i = 0; i < nodes.length; i++) {
    _p.copy(nodes[i].local); _p.y += ROAD_LIFT + 0.02;
    _q.identity();
    _s.set(ROAD_WIDTH, 1, ROAD_WIDTH);
    _m.compose(_p, _q, _s);
    patch.setMatrixAt(i, _m);
  }
  scene.add(patch);
  // 街灯: 各エッジ沿いに等間隔・左右交互。腕(+Z)が道路を向くように回す
  const lg = lamp.geometry.clone();
  lg.computeBoundingBox();
  const lb = lg.boundingBox;
  lg.translate(-(lb.min.x + lb.max.x) / 2, -lb.min.y, -(lb.min.z + lb.max.z) / 2);
  const lScale = LIGHT_HEIGHT / Math.max(0.01, lb.max.y - lb.min.y);
  const lampMats = [], glowPos = [];
  const armZ = (lb.max.z - lb.min.z) / 2 * lScale;   // 腕の張り出し（発光点の位置に使う）
  let side = 1;
  for (const e of activeEdges) {
    const len = e.a.distanceTo(e.b);
    if (len < LIGHT_SPACING * 0.6 || lampMats.length >= MAX_LIGHTS) continue;
    const n = Math.max(1, Math.floor(len / LIGHT_SPACING));
    _dir.copy(e.b).sub(e.a).normalize();
    const px = -_dir.z, pz = _dir.x;   // 水平垂直
    for (let k = 1; k <= n && lampMats.length < MAX_LIGHTS; k++) {
      const t = k / (n + 1);
      side = -side;
      const bx = e.a.x + (e.b.x - e.a.x) * t + px * side * (ROAD_WIDTH / 2 + 0.6);
      const bz = e.a.z + (e.b.z - e.a.z) * t + pz * side * (ROAD_WIDTH / 2 + 0.6);
      const by = e.a.y + (e.b.y - e.a.y) * t + ROAD_LIFT;
      const ry = Math.atan2(px * side, pz * side);   // 腕が道路の中心側を向く（実物合わせで符号反転済み）
      lampMats.push({ x: bx, y: by, z: bz, ry });
      glowPos.push(bx + Math.sin(ry) * armZ * 0.8, by + LIGHT_HEIGHT * 0.92, bz + Math.cos(ry) * armZ * 0.8);
    }
  }
  const lampMesh = new THREE.InstancedMesh(lg, lamp.material, lampMats.length);
  lampMesh.frustumCulled = false;
  for (let i = 0; i < lampMats.length; i++) {
    const L = lampMats[i];
    _p.set(L.x, L.y, L.z);
    _q.setFromAxisAngle(_up, L.ry);
    _s.set(lScale, lScale, lScale);
    _m.compose(_p, _q, _s);
    lampMesh.setMatrixAt(i, _m);
  }
  scene.add(lampMesh);
  // 街灯の発光球（夜だけ）。WebGPUのPoints1px制限を避けて加算小球で
  streetGlowMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 6, 5), streetGlowMat, glowPos.length / 3);
  glow.frustumCulled = false;
  for (let i = 0; i < glowPos.length / 3; i++) {
    _m.makeTranslation(glowPos[i * 3], glowPos[i * 3 + 1], glowPos[i * 3 + 2]);
    glow.setMatrixAt(i, _m);
  }
  scene.add(glow);
  console.log('roads:', activeEdges.length, 'patches:', nodes.length, 'lights:', lampMats.length);
}

function drawRoadLines() {
  if (!activeEdges.length) return;
  const pts = [];
  for (const e of activeEdges) pts.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2ad0ff, transparent: true, opacity: 0.35 })));
}
async function spawnCars() {
  if (!activeEdges.length) return;
  const loader = new GLTFLoader();
  const templates = [];
  for (const f of CAR_KIT) {
    try {
      const gltf = await loader.loadAsync(new URL('../models/' + f.split('/').map(encodeURIComponent).join('/'), location.href).href);
      const obj = gltf.scene;
      const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      obj.position.set(-c.x, -box.min.y, -c.z);   // 底面中心
      const scale = 4.5 / Math.max(size.x, size.z, 0.5);   // 実車~4.5m 長へ
      const grp = new THREE.Group(); grp.add(obj);
      templates.push({ grp, scale });
    } catch (e) { console.warn('car load失敗', f, e); }
  }
  if (!templates.length) return;
  cars = [];
  for (let i = 0; i < CAR_COUNT; i++) {
    const e = pickEdgeNear(player.pos, i % 3 ? CAR_NEAR_R : 1e9);   // 2/3をプレイヤー近傍、1/3を全域へ
    const tpl = templates[i % templates.length];
    const mesh = tpl.grp.clone(true); mesh.scale.setScalar(tpl.scale); scene.add(mesh);
    const car = { mesh, aId: e.aId, bId: e.bId, t: Math.random(), speed: CAR_SPEED * (0.7 + Math.random() * 0.6), grabbed: false, thrown: false, dead: false };
    mesh.userData.car = car;   // レイキャストから車オブジェクトへ辿る（掴み用）
    cars.push(car);
  }
}
// プレイヤー近傍 r 内のエッジを優先的に選ぶ（見つからなければ全体からランダム。棄却サンプリング=軽量）
function pickEdgeNear(pos, r) {
  for (let tries = 0; tries < 24; tries++) {
    const e = activeEdges[(Math.random() * activeEdges.length) | 0];
    if (Math.hypot(e.a.x - pos.x, e.a.z - pos.z) < r) return e;
  }
  return activeEdges[(Math.random() * activeEdges.length) | 0];
}
function repickCar(car) { const e = pickEdgeNear(player.pos, CAR_NEAR_R * 1.5); car.aId = e.aId; car.bId = e.bId; car.t = 0; }
function updateCars(dt) {
  if (!cars.length) return;
  for (const car of cars) {
    if (car.grabbed || car.thrown || car.dead || car.tornado) continue;   // 掴み/投擲/破壊/トーネード中は道路走行しない
    let a = roadNodes.get(car.aId), b = roadNodes.get(car.bId);
    if (!a || !b) { repickCar(car); a = roadNodes.get(car.aId); b = roadNodes.get(car.bId); if (!a || !b) continue; }
    const len = a.local.distanceTo(b.local) || 1;
    car.t += car.speed * dt / len;
    if (car.t >= 1) {
      car.t = 0;
      const nbrs = [...(b.adj || [])].filter((n) => roadNodes.has(n) && n !== car.aId);
      car.aId = car.bId;
      car.bId = nbrs.length ? nbrs[(Math.random() * nbrs.length) | 0] : car.aId;   // 行き止まりは折返し
      a = roadNodes.get(car.aId); b = roadNodes.get(car.bId);
      if (!a || !b) continue;
    }
    car.mesh.position.lerpVectors(a.local, b.local, car.t);
    const dx = b.local.x - a.local.x, dz = b.local.z - a.local.z;
    if (dx * dx + dz * dz > 1e-6) car.mesh.rotation.y = Math.atan2(dx, dz) + CAR_FACE;
  }
}

function setupControls() {
  const cv = renderer.domElement;
  cv.addEventListener('click', () => { if (!locked) cv.requestPointerLock(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());   // 右クリックメニュー抑止
  cv.addEventListener('mousedown', (e) => {
    if (!locked || player.eating) return;   // 捕食中は入力ロック
    if (e.button === 0) { player.charging = true; player.chargeT = 0; }   // タップ=ビーム / 長押し=チャージ(空中)・トーテム(接地)
    else if (e.button === 2) grabTarget();                                 // 掴む（ken優先→車）
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      if (player.eating || !player.charging) { player.charging = false; return; }
      player.charging = false;
      if (player.chargeT < TAP_THRESHOLD) normalShot();
      else fireLargeBeam();   // チャージ解放＝5秒貫通ビーム
    } else if (e.button === 2) releaseGrab();   // 離すと投擲（tps-flight同様の振り回し投げ）
  });
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === cv; });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    camYaw -= e.movementX * 0.0024; camPitch -= e.movementY * 0.0024;
    camPitch = Math.max(-1.25, Math.min(1.35, camPitch));
  });
  window.addEventListener('keydown', (e) => {
    keysDown[e.code] = true;
    if (e.code === 'KeyE' && locked) onInteract();
    if (e.code === 'KeyT') timeScale = timeScale === 1 ? 10 : timeScale === 10 ? 60 : 1;   // 時間の早送り（動作確認用）
  });
  window.addEventListener('keyup', (e) => { keysDown[e.code] = false; });
  window.addEventListener('wheel', (e) => { flight.maxSpeed = Math.max(4, Math.min(2000, flight.maxSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); });   // 基準8まで戻せるよう下限4
}

const _clock = new THREE.Clock();
let _dbg = 0;
// ── P1: Kenney 都市（PLATEAU タイルの代替。実道路網に建物を手続き配置＝巨大ステージ効率実験）──
const BLD_KIT_DIR = { city: 'city_GLB format/', suburban: 'kenney_city-kit-suburban_20/Models/GLB format/' };
let cityRoot = null;        // scene 直下の建物ルート（モデル単位の InstancedMesh 群）
let cityDamaged = null;     // 破壊で単体化した建物のルート（レイキャスト対象に含める）
let cityInfo = null;
// 距離2段LOD: 近=フルモデル / 遠=バウンディングボックスの箱ポリ（頂点数を桁で削減）。定期再振り分け＋ヒステリシス
const LOD_NEAR = 700, LOD_HYST = 100, LOD_INTERVAL = 0.4;
const bldModels = [];       // { tpl, near, far, recs:[{m,x,z,boxIdx,dead,isFar,carve}] }
let _lodT = 0, _lodNearCount = 0, _lodFarCount = 0;

async function buildKenneyCity() {
  if (!activeEdges.length) { console.warn('city: no road edges'); return; }
  // 活性エッジ(world XZ＋DEM Y)→ジェネレータ
  const edges = activeEdges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z]);
  const gen = generateBuildings(edges, { seed: 20260706 });
  cityInfo = { count: gen.instances.length, zones: gen.zones };
  console.log('city buildings', gen.instances.length, gen.zones);

  // 進入マーカー（entry-editor 製）: モデル相対パス -> [{kind:'door'|'window', pos:[x,y,z]}]
  try { bldEntries = await (await fetch('../models/building-entries.json')).json(); } catch { bldEntries = {}; }

  // 使用モデルの GLB を「1マージ済みジオメトリ＋共有マテリアル」に（InstancedMesh 用）
  const used = new Set(gen.instances.map((i) => i.kit + '|' + i.model));
  const templates = new Map();
  const relByKey = new Map();
  const loader = new GLTFLoader();
  await Promise.all([...used].map(async (key) => {
    const [kit, model] = key.split('|');
    const relPath = BLD_KIT_DIR[kit] + model + '.glb';
    relByKey.set(key, relPath);
    const rel = relPath.split('/').map(encodeURIComponent).join('/');
    try {
      const gltf = await loader.loadAsync(new URL('../models/' + rel, location.href).href);
      const baked = bakeModel(gltf.scene);
      if (baked) templates.set(key, baked);
    } catch (e) { console.warn('building load失敗', key, e); }
  }));

  // モデル単位のグローバル InstancedMesh に集約（チャンク分割は InstancedMesh 個数=GPUバッファ/バインドグループ生成が
  // 数千個に膨れ、初回描画で20秒級のフリーズになる。モデル単位なら 40 個だけ＝生成が一瞬。低ポリ×インスタンスで常時描画でも軽い）
  cityRoot = new THREE.Group(); scene.add(cityRoot);
  cityDamaged = new THREE.Group(); scene.add(cityDamaged);   // 破壊で単体化した建物（追撃レイキャスト対象）
  const byModel = new Map();
  for (const inst of gen.instances) {
    const k = inst.kit + '|' + inst.model;
    if (!templates.has(k)) continue;
    if (!byModel.has(k)) byModel.set(k, []);
    byModel.get(k).push(inst);
  }
  const TARGET_FOOT = { tower: 26, mid: 15, house: 10 };   // ゾーン別の実寸フットプリント(m)。Kenneyキット単位→メートル正規化
  const kitMat = {};   // kit -> 共有マテリアル（同一colormap＝パイプライン1本）
  const farMat = {};   // kit -> 遠景ボックス用フラット材質（LOD低段）
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  for (const [k, insts] of byModel) {
    const tpl = templates.get(k);
    const kit = k.split('|')[0];
    if (!kitMat[kit] && tpl.material) kitMat[kit] = tpl.material;
    if (!farMat[kit]) farMat[kit] = new THREE.MeshStandardMaterial({ color: kit === 'city' ? '#a8afb9' : '#cbc1b2', roughness: 1 });
    const foot = Math.max(tpl.size.x, tpl.size.z, 0.1);
    // 近=フルモデル / 遠=バウンディングボックスの箱ポリ（同じインスタンス行列で置換可能なよう bbox 中心へ合わせる）
    const near = new THREE.InstancedMesh(tpl.geometry, kitMat[kit] || tpl.material, insts.length);
    const bb = tpl.geometry.boundingBox;
    const boxGeo = new THREE.BoxGeometry(tpl.size.x, tpl.size.y, tpl.size.z);
    boxGeo.translate(bb.min.x + tpl.size.x / 2, bb.min.y + tpl.size.y / 2, bb.min.z + tpl.size.z / 2);
    const far = new THREE.InstancedMesh(boxGeo, farMat[kit], insts.length);
    near.frustumCulled = far.frustumCulled = false;
    // レイキャスト用境界球を都市全域で固定。InstancedMesh は初回レイキャスト時の球をキャッシュするため、
    // LODの振り分けで行列が入れ替わると古い球の外（郊外など）が「命中しない」バグになる
    near.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 200, 0), 6000);
    far.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 200, 0), 6000);
    near.userData.slots = []; far.userData.slots = [];   // slot -> 建物レコード（射撃レイキャストの逆引き）
    const md = { tpl, near, far, recs: [], rel: relByKey.get(k), entries: bldEntries[relByKey.get(k)] || null };
    near.userData.md = md; far.userData.md = md;
    for (let i = 0; i < insts.length; i++) {
      const it = insts[i];
      const s = (TARGET_FOOT[it.tier] || 12) / foot * it.s;   // 実寸フットプリントへ正規化＋個体差
      _e.set(0, it.ry, 0); _q.setFromEuler(_e);
      _p.set(it.x, it.y - tpl.baseY * s, it.z);   // 底面を地面Yへ
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      md.recs.push({ m: _m.clone(), x: it.x, z: it.z, tier: it.tier, boxIdx: addCollBox(it.x, it.z, it.y, it.y + tpl.size.y * s, foot * s * 0.5), dead: false, isFar: false, carve: null });
    }
    cityRoot.add(near); cityRoot.add(far);
    bldModels.push(md);
  }
  partitionBuildings();   // 初期の近/遠振り分け（compile で両パイプラインを事前生成させる）
  try { buildNeon(); } catch (e) { console.warn('neon生成失敗', e); }   // 屋上ランプ（夜用）
  // カーブ（欠損）材質のパイプラインを事前コンパイル（初弾のヒッチ軽減）
  const _dummyGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const mkey of Object.keys(kitMat)) {
    try {
      const cm = makeCarveMaterial(kitMat[mkey], 0, 1);
      const dm = new THREE.Mesh(_dummyGeo, cm.mat);
      dm.position.set(0, -500, 0);
      scene.add(dm);
    } catch (e) { console.warn('carve prewarm失敗', e); }
  }
  // WebGPUパイプラインを事前コンパイル（初回描画のハングをローディング中へ前倒し）
  try { setStatus('都市を最適化中…'); if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (e) { console.warn('compileAsync', e); }
  console.log('city models', bldModels.length, 'buildings', gen.instances.length, 'near/far', _lodNearCount, _lodFarCount);
}

// 建物の近/遠LOD再振り分け（LOD_INTERVAL 毎）。ヒステリシスでちらつき防止。全走査9500件でも算術のみ＝軽量
function partitionBuildings() {
  const px = player.pos.x, pz = player.pos.z;
  const inR2 = (LOD_NEAR - LOD_HYST) ** 2, outR2 = (LOD_NEAR + LOD_HYST) ** 2;
  let nTot = 0, fTot = 0;
  for (const md of bldModels) {
    let n = 0, f = 0;
    for (const rec of md.recs) {
      if (rec.dead) continue;
      const dx = rec.x - px, dz = rec.z - pz, d2 = dx * dx + dz * dz;
      if (rec.isFar) { if (d2 < inR2) rec.isFar = false; }
      else if (d2 > outR2) rec.isFar = true;
      if (rec.isFar) { md.far.setMatrixAt(f, rec.m); md.far.userData.slots[f] = rec; f++; }
      else { md.near.setMatrixAt(n, rec.m); md.near.userData.slots[n] = rec; n++; }
    }
    md.near.count = n; md.far.count = f;
    md.near.instanceMatrix.needsUpdate = true; md.far.instanceMatrix.needsUpdate = true;
    nTot += n; fTot += f;
  }
  _lodNearCount = nTot; _lodFarCount = fTot;
}

// GLB シーンを「1つのマージ済みジオメトリ＋共有マテリアル」へ（位置/法線/UVのみ・変換ベイク・非index化で統一）
function bakeModel(root) {
  root.updateMatrixWorld(true);
  const geoms = [];
  let material = null, bestCnt = -1;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g0 = o.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', g0.getAttribute('position').clone());
    if (g0.getAttribute('normal')) g.setAttribute('normal', g0.getAttribute('normal').clone());
    if (g0.getAttribute('uv')) g.setAttribute('uv', g0.getAttribute('uv').clone());
    if (g0.index) g.setIndex(g0.index.clone());   // インデックス保持（非インデックス化は頂点3倍＝hk高ポリで致命的）
    else {
      const n = g.getAttribute('position').count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.applyMatrix4(o.matrixWorld);
    geoms.push(g);
    const cnt = g.getAttribute('position').count;   // 最も頂点数の多いメッシュの材質を採用（複数材質GLBで主要アトラスを拾う）
    if (cnt > bestCnt) { bestCnt = cnt; material = Array.isArray(o.material) ? o.material[0] : o.material; }
  });
  if (!geoms.length) return null;
  for (const g of geoms) {   // merge 要件: 全ジオメトリの属性を揃える
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  }
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (!merged) return null;
  merged.computeBoundingBox();
  const size = merged.boundingBox.getSize(new THREE.Vector3());
  const mat = (material && material.clone) ? material.clone() : new THREE.MeshStandardMaterial({ color: 0xcccccc });
  mat.side = THREE.DoubleSide;
  return { geometry: merged, material: mat, baseY: merged.boundingBox.min.y, size };
}

// ── P1-2: 建物の箱当たり判定（AABB近似＋空間ハッシュ）＋屋上着地 ──
const COLL_CELL = 40;          // 空間ハッシュのセル(m)
const collGrid = new Map();    // "cx_cz" -> [boxIndex,...]
const collBoxes = [];          // { x, z, bottom, top, h }
const PLAYER_R = 1.0, PLAYER_H = 1.5, LAND_EPS = 0.8;
function addCollBox(x, z, bottom, top, h) {
  const idx = collBoxes.length; collBoxes.push({ x, z, bottom, top, h });
  const x0 = Math.floor((x - h) / COLL_CELL), x1 = Math.floor((x + h) / COLL_CELL);
  const z0 = Math.floor((z - h) / COLL_CELL), z1 = Math.floor((z + h) / COLL_CELL);
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
    const key = cx + '_' + cz; let a = collGrid.get(key); if (!a) collGrid.set(key, a = []); a.push(idx);
  }
  return idx;
}
function collidePlayer() {
  if (!collBoxes.length) return;
  player.grounded = false;
  const ccx = Math.floor(player.pos.x / COLL_CELL), ccz = Math.floor(player.pos.z / COLL_CELL);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const arr = collGrid.get((ccx + dx) + '_' + (ccz + dz));
    if (!arr) continue;
    for (const idx of arr) {
      const b = collBoxes[idx];
      const px = player.pos.x, pz = player.pos.z, feet = player.pos.y, head = feet + PLAYER_H;
      const hx = b.h + PLAYER_R, hz = b.h + PLAYER_R;
      const dxp = px - b.x, dzp = pz - b.z;
      if (Math.abs(dxp) >= hx || Math.abs(dzp) >= hz) continue;   // XZ外
      if (head <= b.bottom || feet >= b.top) continue;            // Y外（屋根より上＝素通り）
      const penXp = hx - dxp, penXn = hx + dxp, penZp = hz - dzp, penZn = hz + dzp;
      const penUp = b.top - feet, penDn = head - b.bottom;
      let axis = 'xp', pv = penXp;                                // 最小貫通の面へ押し出す
      if (penXn < pv) { axis = 'xn'; pv = penXn; }
      if (penZp < pv) { axis = 'zp'; pv = penZp; }
      if (penZn < pv) { axis = 'zn'; pv = penZn; }
      if (penDn < pv) { axis = 'dn'; pv = penDn; }
      if (penUp - LAND_EPS < pv) { axis = 'up'; pv = penUp; }     // 屋上着地を優遇
      switch (axis) {
        case 'up': player.pos.y = b.top; if (player.vel.y < 0) player.vel.y = 0; player.grounded = true; break;
        case 'dn': player.pos.y = b.bottom - PLAYER_H; if (player.vel.y > 0) player.vel.y = 0; break;
        case 'xp': player.pos.x = b.x + hx; if (player.vel.x < 0) player.vel.x = 0; break;
        case 'xn': player.pos.x = b.x - hx; if (player.vel.x > 0) player.vel.x = 0; break;
        case 'zp': player.pos.z = b.z + hz; if (player.vel.z < 0) player.vel.z = 0; break;
        case 'zn': player.pos.z = b.z - hz; if (player.vel.z > 0) player.vel.z = 0; break;
      }
    }
  }
}

// 地面（地理院タイル地形）への着地: 真下へレイキャストして足を止める
const _groundRay = new THREE.Raycaster();
const _rayFrom = new THREE.Vector3();
const _DOWN = new THREE.Vector3(0, -1, 0);
function groundCollide() {
  if (!groundGroup || !groundGroup.children.length || player.pos.y > 300) return;   // 高高度はスキップ
  _rayFrom.set(player.pos.x, player.pos.y + 60, player.pos.z);
  _groundRay.set(_rayFrom, _DOWN); _groundRay.far = 100000;
  const hit = _groundRay.intersectObject(groundGroup, true)[0];
  if (hit && player.pos.y < hit.point.y) {
    player.pos.y = hit.point.y;
    if (player.vel.y < 0) player.vel.y = 0;
    player.grounded = true;
  }
}

// ── P2: Joyのショット破壊（左クリック→命中建物を単体化し、命中点中心の球状ディソルブで大きく欠損）──
// HP制: 小さな住宅=少HP / 中層=中HP / 高層=大HP。被弾後は自壊（毎秒スローでHP減＋徐々に傾く＋上から溶け始め）
const CARVE_MAX = 6, CARVE_RADIUS = 7, SHOOT_RANGE = 450, DIE_DUR = 1.7;
const BLD_HP = { house: 2, mid: 5, tower: 9 };   // 建物HP（ダメージ: 通常弾=1, 雷=2.5, 貫通ビーム=0.55/tick）
const BLD_DECAY_TIME = 40;   // 被弾後、放置してもこの秒数で自壊しきる
const BLD_MAX_TILT = 0.14;   // 自壊進行での最大傾き(rad)
const dyingList = [];        // 崩壊アニメ中の rec（建物レコードの carve に紐付く）
const damagedList = [];      // 被弾済み（自壊進行中）の rec
const shotFx = [];           // ビーム/フラッシュのフェード
const _shootRay = new THREE.Raycaster();
const _camDir = new THREE.Vector3(), _muzzle = new THREE.Vector3(), _vk = new THREE.Vector3();

// 命中点中心の球状カーブ（局所ディソルブ）マテリアル。CARVE_MAX 個の球の内側を discard＝欠損。縁は発光。
// アンリットの MeshBasicNodeMaterial を使う（Standardノード材質だと WebGPU で真っ黒になったため）。
// colormap をそのまま色に出すので黒化しない。fx-dissolve の水たまりと同系の実績パターン。
function makeCarveMaterial(srcMat, baseY, height) {
  const nm = new THREE.MeshBasicNodeMaterial();
  const base = (srcMat && srcMat.map) ? texture(srcMat.map, uv()) : color('#bfc4cc');
  const uCenters = [], uRadii = [];
  for (let i = 0; i < CARVE_MAX; i++) { uCenters.push(uniform(new THREE.Vector3(1e6, 1e6, 1e6))); uRadii.push(uniform(0)); }
  const uEdge = uniform(1.4), uScorch = uniform(6.5), uNoiseScale = uniform(0.16), uNoiseAmt = uniform(1.4);
  const uBaseY = uniform(baseY), uHeight = uniform(Math.max(0.01, height)), uKill = uniform(0), uKillOn = uniform(0), uKillEdge = uniform(0.14);
  const nz = mx_noise_float(positionWorld.mul(uNoiseScale)).mul(uNoiseAmt);         // 縁を不規則にするノイズ
  const nz2 = mx_noise_float(positionWorld.mul(0.85)).mul(0.5).add(0.5);            // 焦げの斑(0..1)
  let alpha = null, rimSum = null, scorchSum = null;
  for (let i = 0; i < CARVE_MAX; i++) {
    const dn = positionWorld.sub(uCenters[i]).length().sub(uRadii[i]).add(nz);      // 球iまでの符号付き距離
    alpha = alpha ? alpha.mul(dn.smoothstep(float(0), uEdge)) : dn.smoothstep(float(0), uEdge);   // どれかの球内=0＝欠損
    const ri = clamp(float(1).sub(dn.abs().div(uEdge)), 0, 1);                      // 縁の残り火(狭い)
    rimSum = rimSum ? rimSum.add(ri) : ri;
    const sc = clamp(float(1).sub(dn.div(uScorch)), 0, 1);                          // 縁の外側 uScorch 幅を焦がす
    scorchSum = scorchSum ? scorchSum.add(sc) : sc;
  }
  // 崩壊時の上→下ディソルブ（旧ディソルブ風）: uKillOn=1 で有効。uKill 0→ で上から消える
  const hNorm = clamp(positionWorld.y.sub(uBaseY).div(uHeight), 0, 1);              // 0=底 1=上
  const dcTop = hNorm.oneMinus().add(mx_noise_float(positionWorld.mul(0.18)).mul(0.16));   // 上ほど小
  const killA = dcTop.smoothstep(uKill.sub(uKillEdge), uKill);                      // uKill上昇で上から0
  alpha = alpha.mul(mix(float(1), killA, uKillOn));                                 // 通常時は無効(×1)
  const killRim = clamp(float(1).sub(dcTop.sub(uKill).abs().div(uKillEdge)), 0, 1).mul(uKillOn);   // 溶解縁の発光
  // 見た目: 裏面(内側)を暗くくすませ、断面付近を焦がし、縁に残り火
  const cavity = mix(float(0.28), float(1.0), frontFacing);                         // 裏面=0.28(中空を暗く), 表面=1.0
  const rim = clamp(rimSum.add(killRim), 0, 1);
  const scorch = clamp(scorchSum, 0, 1).mul(nz2);                                   // 斑で不均一な焦げ
  const charred = base.mul(cavity).mul(float(1).sub(scorch.mul(0.92)));             // 内側を暗く＋断面付近を黒くくすませる
  const ember = color('#ff4d10').mul(rim.mul(1.5)).add(color('#ffd06a').mul(rim.mul(rim).mul(1.8)));   // 残り火(縁で白熱)
  nm.colorNode = charred.add(ember);
  nm.opacityNode = alpha;
  nm.alphaTest = 0.5;
  nm.side = THREE.DoubleSide;
  nm.needsUpdate = true;
  return { mat: nm, uCenters, uRadii, uKill, uKillOn, uBaseY, uHeight };
}

function damageBuilding(instMesh, instanceId, point, dmg = DMG_SHOT) {
  const rec0 = (instMesh.userData.slots || [])[instanceId];   // LOD振り分けの slot から建物レコードへ逆引き（近/遠どちらの命中でも同じレコード）
  const md = instMesh.userData.md;
  if (!rec0 || !md || rec0.dead) return;
  if (rec0.carve) { applyCarve(rec0.carve, point, dmg); return; }
  const m = rec0.m;
  const _p2 = new THREE.Vector3(), _q2 = new THREE.Quaternion(), _s2 = new THREE.Vector3();
  m.decompose(_p2, _q2, _s2);
  const gb = md.tpl.geometry.boundingBox;
  const baseY = _p2.y + gb.min.y * _s2.y, height = (gb.max.y - gb.min.y) * _s2.y;   // ワールドの底Y/高さ（Y回転のみなので不変）
  const cm = makeCarveMaterial(md.near.material, baseY, height);
  const std = new THREE.Mesh(md.tpl.geometry, cm.mat);   // 遠箱に当たってもフルモデルで単体化
  std.matrixAutoUpdate = false; std.matrix.copy(m); std.matrixWorldNeedsUpdate = true;
  cityDamaged.add(std);
  rec0.dead = true; partitionBuildings();   // インスタンス側から即除去
  // 欠損半径は建物サイズに比例（小さな住宅が一撃で丸ごと消えないように）
  const minDim = Math.min((gb.max.x - gb.min.x) * _s2.x, (gb.max.z - gb.min.z) * _s2.z, height);
  const carveR = Math.min(CARVE_RADIUS, Math.max(2.5, minDim * 0.45));
  const hpMax = BLD_HP[rec0.tier] || 4;
  const tiltA = Math.random() * Math.PI * 2;   // 傾き方向（水平軸）をランダムに固定
  const rec = {
    std, baseMatrix: m.clone(), uCenters: cm.uCenters, uRadii: cm.uRadii, uKill: cm.uKill, uKillOn: cm.uKillOn, uBaseY: cm.uBaseY,
    baseY0: baseY, height, hits: 0, boxIdx: rec0.boxIdx, carveR,
    hp: hpMax, hpMax, decay: hpMax / BLD_DECAY_TIME,
    tiltAxis: new THREE.Vector3(Math.cos(tiltA), 0, Math.sin(tiltA)),
    pivot: new THREE.Vector3(_p2.x, baseY, _p2.z),   // 傾き回転の支点（基部中心）
    dying: false, dieT: 0,
  };
  std.userData.rec = rec;
  rec0.carve = rec;
  damagedList.push(rec);   // 以後、自壊（スロー減衰＋傾き）が進行
  applyCarve(rec, point, dmg);
}
function applyCarve(rec, point, dmg = DMG_SHOT) {   // 命中点にカーブ球を追加＋HPダメージ。HP0で崩壊
  if (rec.dying) return;
  const i = Math.min(rec.hits, CARVE_MAX - 1);
  rec.uCenters[i].value.copy(point);
  rec.uRadii[i].value = (rec.carveR || CARVE_RADIUS) * (0.9 + Math.random() * 0.35);
  rec.hits++;
  spawnImpactFx(point);   // 着弾点に炎＋煙
  applyBldDamage(rec, dmg);
}
function applyBldDamage(rec, dmg) {
  if (rec.dying) return;
  rec.hp -= dmg;
  if (rec.hp <= 0) startCollapse(rec);
}
function startCollapse(rec) {   // 崩壊開始＋当たり判定を無効化。現在の傾きを基準行列に焼き込む
  if (rec.dying) return;
  applyTilt(rec, tiltAngle(rec), rec.baseMatrix);   // baseMatrix ← 傾き込みへ更新
  rec.std.matrix.copy(rec.baseMatrix); rec.std.matrixWorldNeedsUpdate = true;
  rec.dying = true; rec.dieT = 0; dyingList.push(rec);
  const di = damagedList.indexOf(rec); if (di >= 0) damagedList.splice(di, 1);
  if (rec.boxIdx != null && collBoxes[rec.boxIdx]) { const b = collBoxes[rec.boxIdx]; b.top = b.bottom = -1e9; }
}
function tiltAngle(rec) { return (1 - Math.max(0, rec.hp) / rec.hpMax) * BLD_MAX_TILT; }
const _tiltM = new THREE.Matrix4(), _tiltR = new THREE.Matrix4(), _tiltT = new THREE.Matrix4();
function applyTilt(rec, ang, outMatrix) {   // out = T(pivot)·R(axis,ang)·T(-pivot)·baseMatrix
  _tiltR.makeRotationAxis(rec.tiltAxis, ang);
  _tiltT.makeTranslation(-rec.pivot.x, -rec.pivot.y, -rec.pivot.z);
  _tiltM.makeTranslation(rec.pivot.x, rec.pivot.y, rec.pivot.z).multiply(_tiltR).multiply(_tiltT);
  outMatrix.copy(_tiltM.multiply(rec.baseMatrix));
}

// ── 攻撃：タップ=cas1_L1ビーム / 3連目=lightning / チャージ解放=large_beam(5秒貫通) ──
const _rayToC = new THREE.Vector3();
function rayHitSphere(o, d, center, radius, maxT) {   // レイ上の命中距離 t（外れは Infinity）
  _rayToC.copy(center).sub(o);
  const t = _rayToC.dot(d);
  if (t < 0 || t > maxT) return Infinity;
  const perp2 = _rayToC.lengthSq() - t * t;
  return perp2 <= radius * radius ? t : Infinity;
}
function applyHitToBuilding(hit, dmg) {
  if (hit.object.isInstancedMesh && hit.instanceId != null) damageBuilding(hit.object, hit.instanceId, hit.point, dmg);
  else if (hit.object.userData && hit.object.userData.rec) applyCarve(hit.object.userData.rec, hit.point, dmg);
}
function hitCarBeam(car) {
  const ti = thrownCars.indexOf(car); if (ti >= 0) thrownCars.splice(ti, 1);
  breakCar(car, car.mesh.position.clone());
}
// 単発ヒットスキャン（建物/車/kenの最も手前）。pierce=貫通（射線上の全対象へ）
function fireBeam(bldDmg, kenDmg, colorHex, thick) {
  if (!player.ready || !cityRoot) return;
  camera.getWorldDirection(_camDir);
  camera.getWorldPosition(_muzzle);
  _shootRay.set(_muzzle, _camDir); _shootRay.far = SHOOT_RANGE;
  const hits = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true);
  const bldT = hits.length ? hits[0].distance : Infinity;
  let carBest = null, carT = Infinity;
  for (const car of cars) {
    if (car.dead || car.grabbed || car.tornado) continue;
    const t = rayHitSphere(_muzzle, _camDir, car.mesh.position, 2.4, SHOOT_RANGE);
    if (t < carT) { carT = t; carBest = car; }
  }
  let kenBest = null, kenT = Infinity;
  for (const m of kens) {
    if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
    kenCenter(m, _vk);
    const t = rayHitSphere(_muzzle, _camDir, _vk, 0.85, SHOOT_RANGE);
    if (t < kenT) { kenT = t; kenBest = m; }
  }
  const gndHit = (groundGroup && groundGroup.children.length) ? _shootRay.intersectObject(groundGroup, true)[0] : null;
  const gndT = gndHit ? gndHit.distance : Infinity;   // 地形も遮蔽（着弾のみ・ダメージなし）
  const minT = Math.min(bldT, carT, kenT, gndT);
  const end = _muzzle.clone().addScaledVector(_camDir, minT === Infinity ? SHOOT_RANGE : minT);
  attackAim.copy(end); attackAimActive = true;   // FXビームの到達点＝この実着弾点
  spawnBeam(_vk.set(player.pos.x, player.pos.y + 1.2, player.pos.z), end, minT !== Infinity, colorHex, thick);
  if (minT === Infinity) return;
  if (minT === bldT) applyHitToBuilding(hits[0], bldDmg);
  else if (minT === carT) hitCarBeam(carBest);
  else if (minT === kenT) hitKenBeam(kenBest, kenDmg);
  // 地形着弾はダメージなし（spawnBeam 側で炎煙のみ）
}
function snapYawToView() { player.yaw = camYaw; }   // 発射時に一回だけ体を視点方向へ
function normalShot() {
  shotComboT = 0;
  if (++shotComboN >= 3) { shotComboN = 0; superShot(); return; }   // 3連目＝スーパービーム
  if (grabbedCar) { snapYawToView(); launchHeldCar(); triggerOneShot('shot'); return; }   // 抱えた車を前方へ射出
  snapYawToView();
  triggerOneShot('shot');
  fireBeam(DMG_SHOT, KEN_DMG_SHOT, 0xffb040, false);
}
function superShot() {
  snapYawToView();
  triggerOneShot('lightning');
  fireBeam(DMG_LIGHTNING, KEN_DMG_LIGHTNING, 0x9fd8ff, true);
}
function fireLargeBeam() {
  triggerOneShot('large');
  if (player.oneShot) player.oneShot.until = LARGE_BEAM_DUR;   // 5秒間ポーズ保持しつつ照射
  largeBeam.active = true; largeBeam.t = 0; largeBeam.tickT = 0;
  if (!largeBeam.mesh) {
    const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true);
    g.rotateX(Math.PI / 2);   // Z軸に沿う筒
    largeBeam.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffc47a, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
    largeBeam.mesh.frustumCulled = false;
    scene.add(largeBeam.mesh);
  }
  largeBeam.mesh.visible = true;
}
const _lbFrom = new THREE.Vector3(), _lbEnd = new THREE.Vector3();
function updateAttacks(dt) {
  shotComboT += dt;
  if (shotComboT > SHOT_COMBO_WINDOW) shotComboN = 0;   // 連射が途切れたらコンボ解除
  if (!largeBeam.active) return;
  largeBeam.t += dt; largeBeam.tickT -= dt;
  player.yaw = lerpAngle(player.yaw, camYaw, Math.min(1, 20 * dt));   // 発射中は体ごと視点方向へ追従
  camera.getWorldDirection(_camDir); camera.getWorldPosition(_muzzle);
  _lbFrom.set(player.pos.x, player.pos.y + 1.2, player.pos.z);
  // 到達点＝地形で遮蔽（建物は貫通）。FXビームもここまで＝破壊とエフェクトが一致
  _shootRay.set(_muzzle, _camDir); _shootRay.far = LARGE_BEAM_RANGE;
  const gnd = (groundGroup && groundGroup.children.length) ? _shootRay.intersectObject(groundGroup, true)[0] : null;
  const endT = Math.min(gnd ? gnd.distance : Infinity, LARGE_BEAM_RANGE);
  _lbEnd.copy(_muzzle).addScaledVector(_camDir, endT);
  attackAim.copy(_lbEnd); attackAimActive = true;
  // ビーム筒を胸元→到達点で張る
  const mesh = largeBeam.mesh;
  mesh.position.copy(_lbFrom).add(_lbEnd).multiplyScalar(0.5);
  mesh.lookAt(_lbEnd);
  mesh.scale.set(1, 1, _lbFrom.distanceTo(_lbEnd));
  if (largeBeam.tickT <= 0) {   // 貫通ダメージ tick
    largeBeam.tickT = LARGE_BEAM_TICK;
    spawnImpactFx(_lbEnd);   // 到達点（地形/最遠）にも炎煙
    _shootRay.set(_muzzle, _camDir); _shootRay.far = endT;
    const hits = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true);
    for (let i = 0; i < Math.min(hits.length, 8); i++) applyHitToBuilding(hits[i], DMG_LARGE_TICK);   // 射線上の建物すべて（上限8）
    for (const car of cars) {
      if (car.dead || car.grabbed || car.tornado) continue;
      if (rayHitSphere(_muzzle, _camDir, car.mesh.position, 2.4, LARGE_BEAM_RANGE) < Infinity) hitCarBeam(car);
    }
    for (const m of kens) {
      if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
      kenCenter(m, _vk);
      if (rayHitSphere(_muzzle, _camDir, _vk, 0.85, LARGE_BEAM_RANGE) < Infinity) hitKenBeam(m, KEN_DMG_LARGE_TICK);
    }
  }
  if (largeBeam.t >= LARGE_BEAM_DUR) { largeBeam.active = false; mesh.visible = false; attackAimActive = false; }
}

function spawnBeam(from, to, impact, colorHex = 0xffb040, thick = false) {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]), new THREE.LineBasicMaterial({ color: colorHex, transparent: true }));
  scene.add(line); shotFx.push({ obj: line, t: 0, dur: thick ? 0.16 : 0.09, kind: 'beam' });
  if (thick) {   // スーパービームは筒を重ねて太く
    const len = from.distanceTo(to);
    const g = new THREE.CylinderGeometry(0.3, 0.3, 1, 8, 1, true); g.rotateX(Math.PI / 2);
    const cyl = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
    cyl.position.copy(from).add(to).multiplyScalar(0.5); cyl.lookAt(to); cyl.scale.set(1, 1, len);
    scene.add(cyl); shotFx.push({ obj: cyl, t: 0, dur: 0.22, kind: 'beam' });   // beam種＝フェードのみ（flashの膨張を避ける）
  }
  if (impact) {
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true }));
    flash.position.copy(to); scene.add(flash); shotFx.push({ obj: flash, t: 0, dur: 0.2, kind: 'flash' });
    spawnImpactFx(to);   // 炎＋煙
  }
}

function updateDamage(dt) {
  // 被弾済み建物の自壊: 放置でもHPがスロー減衰→徐々に傾き＋上からうっすら溶け始める。追撃すれば即崩壊
  for (let k = damagedList.length - 1; k >= 0; k--) {
    const rec = damagedList[k];
    rec.hp -= rec.decay * dt;
    if (rec.hp <= 0) { startCollapse(rec); continue; }   // startCollapse が damagedList から除去
    const prog = 1 - rec.hp / rec.hpMax;
    applyTilt(rec, tiltAngle(rec), rec.std.matrix); rec.std.matrixWorldNeedsUpdate = true;   // ゆっくり傾く
    rec.uKillOn.value = 1;
    rec.uKill.value = Math.max(rec.uKill.value, prog * 0.5);   // 進行に応じ上から溶け始める
  }
  for (let k = dyingList.length - 1; k >= 0; k--) {   // 崩壊: サイズそのままで地面へゆっくり沈む＋上から溶ける（旧ディソルブ風）
    const rec = dyingList[k]; rec.dieT += dt;
    const t = rec.dieT / DIE_DUR;
    rec.uKillOn.value = 1;
    rec.uKill.value = Math.max(rec.uKill.value, t * 1.2);         // 上→下の溶解（自壊分から単調増加）
    const sink = rec.height * 0.9 * t;                           // 地面へ沈み込む量
    rec.std.matrix.copy(rec.baseMatrix); rec.std.matrix.elements[13] -= sink;   // Y平行移動で沈める（縮めない）
    rec.std.matrixWorldNeedsUpdate = true;
    rec.uBaseY.value = rec.baseY0 - sink;                        // 溶解の高さ基準も一緒に沈める
    if (rec.dieT > DIE_DUR) { if (rec.std.parent) rec.std.parent.remove(rec.std); if (rec.std.material.dispose) rec.std.material.dispose(); dyingList.splice(k, 1); }
  }
  for (let k = shotFx.length - 1; k >= 0; k--) {   // ビーム/フラッシュのフェード
    const f = shotFx[k]; f.t += dt; const a = 1 - f.t / f.dur;
    if (a <= 0) { scene.remove(f.obj); f.obj.geometry.dispose(); f.obj.material.dispose(); shotFx.splice(k, 1); continue; }
    f.obj.material.opacity = a;
    if (f.kind === 'flash') f.obj.scale.setScalar(1 + f.t * 28);
  }
}

// ── P3: 車の掴み・投擲・破壊 ──
const GRAB_RANGE = 70, HOLD_DIST = 6, THROW_SPEED = 95, CAR_GRAV = 42, CAR_RESPAWN = 4, THROW_LIFE = 7;
let grabbedCar = null;
const thrownCars = [], respawnCars = [], carDebris = [];
const _grabRay = new THREE.Raycaster();
const _hold = new THREE.Vector3(), _tmpV = new THREE.Vector3();

// 右クリック＝掴む。ken の関節を優先し、無ければ車（照準→前方近傍の順）
function grabTarget() {
  if (isHolding()) return;
  camera.getWorldDirection(_camDir); camera.getWorldPosition(_muzzle);
  // ken の関節（tps-flight の nearestNpcJoint 相当）
  let bestKen = null, bestBone = null, bestAlong = GRAB_RANGE;
  for (const m of kens) {
    if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
    const j = nearestKenJoint(m, _muzzle, _camDir);
    if (j && j.along < bestAlong) { bestAlong = j.along; bestKen = m; bestBone = j.bone; }
  }
  if (bestKen) { grabKen(bestKen, bestBone); triggerOneShot('grab'); return; }
  // 車（照準レイ→無ければ前方近傍の最寄り）
  if (!cars.length) return;
  _grabRay.set(_muzzle, _camDir); _grabRay.far = GRAB_RANGE;
  const meshes = cars.filter((c) => !c.grabbed && !c.thrown && !c.dead && !c.tornado).map((c) => c.mesh);
  const hit = _grabRay.intersectObjects(meshes, true)[0];
  let car = null;
  if (hit) { let o = hit.object; while (o && !o.userData.car) o = o.parent; if (o) car = o.userData.car; }
  if (!car) {
    _tmpV.copy(_muzzle).addScaledVector(_camDir, HOLD_DIST + 8);
    let best = GRAB_RANGE;
    for (const c of cars) { if (c.grabbed || c.thrown || c.dead || c.tornado) continue; const d = c.mesh.position.distanceTo(_tmpV); if (d < best) { best = d; car = c; } }
  }
  if (car) { car.grabbed = true; grabbedCar = car; car.holdVel = car.holdVel || new THREE.Vector3(); car.holdVel.set(0, 0, 0); triggerOneShot('grab'); }
}

// 右クリック解放＝投擲（振り回した速度×ブースト。tps-flight の release 相当）
function releaseGrab() {
  const m = grabbedKen();
  if (m) { releaseKen(m); triggerOneShot('throw'); return; }
  if (!grabbedCar) return;
  const car = grabbedCar; grabbedCar = null;
  car.grabbed = false; car.thrown = true; car.thrownT = 0;
  car.vel = (car.vel || new THREE.Vector3()).copy(car.holdVel || _tmpV.set(0, 0, 0)).multiplyScalar(THROW_BOOST);
  if (car.vel.length() < 12) { camera.getWorldDirection(_camDir); car.vel.addScaledVector(_camDir, 18); }   // ほぼ静止なら前方へ軽く
  car.angVel = new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
  thrownCars.push(car);
  triggerOneShot('throw');
}

// 通常ショットで抱えた車を前方射出（tps-flight の normalShot と同じ扱い）
function launchHeldCar() {
  if (!grabbedCar) return;
  const car = grabbedCar; grabbedCar = null;
  car.grabbed = false; car.thrown = true; car.thrownT = 0;
  camera.getWorldDirection(_camDir);
  car.vel = (car.vel || new THREE.Vector3()).copy(_camDir).multiplyScalar(SHOT_LAUNCH).add(player.vel);
  car.angVel = new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
  thrownCars.push(car);
}

function updateGrab(dt) {
  if (!grabbedCar) return;
  const mesh = grabbedCar.mesh;
  _tmpV.copy(mesh.position);
  mesh.position.lerp(frontAnchor, Math.min(1, 12 * dt));   // 前方アンカーへ吸着（カメラで振り回すと勢いがつく）
  if (dt > 0 && grabbedCar.holdVel) grabbedCar.holdVel.copy(mesh.position).sub(_tmpV).divideScalar(dt);
  mesh.rotation.y += dt * 2.2;
}

function updateThrown(dt) {
  for (let k = thrownCars.length - 1; k >= 0; k--) {
    const car = thrownCars[k];
    car.thrownT += dt; car.vel.y -= CAR_GRAV * dt;
    const p = car.mesh.position;
    p.addScaledVector(car.vel, dt);
    car.mesh.rotation.x += car.angVel.x * dt; car.mesh.rotation.y += car.angVel.y * dt; car.mesh.rotation.z += car.angVel.z * dt;
    let impact = null;
    const cx = Math.floor(p.x / COLL_CELL), cz = Math.floor(p.z / COLL_CELL);   // 建物へ衝突？
    for (let dz = -1; dz <= 1 && !impact; dz++) for (let dx = -1; dx <= 1 && !impact; dx++) {
      const arr = collGrid.get((cx + dx) + '_' + (cz + dz)); if (!arr) continue;
      for (const idx of arr) { const b = collBoxes[idx]; if (Math.abs(p.x - b.x) < b.h && Math.abs(p.z - b.z) < b.h && p.y > b.bottom && p.y < b.top) { impact = p.clone(); break; } }
    }
    if (!impact && groundGroup && groundGroup.children.length) {   // 地面へ衝突？
      _grabRay.set(_tmpV.set(p.x, p.y + 30, p.z), _DOWN); _grabRay.far = 100000;
      const g = _grabRay.intersectObject(groundGroup, true)[0];
      if (g && p.y <= g.point.y + 0.5) impact = g.point.clone();
    }
    if (!impact && (car.thrownT > THROW_LIFE || p.y < -40)) impact = p.clone();
    if (impact) { thrownCars.splice(k, 1); breakCar(car, impact); }
  }
}

function breakCar(car, point) {
  spawnBreakFx(point);
  addWanted(0.3, point);   // 車の破壊＝犯罪
  car.mesh.visible = false; car.thrown = false; car.dead = true; car.vel = null;
  respawnCars.push({ car, t: 0 });   // 数秒後に道路へ復帰
}

function spawnBreakFx(point) {
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true }));
  flash.position.copy(point); scene.add(flash); shotFx.push({ obj: flash, t: 0, dur: 0.28, kind: 'flash' });
  for (let i = 0; i < 8; i++) {   // 破片バースト（小箱）
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 1.0), new THREE.MeshBasicMaterial({ color: 0x2b2b30 }));
    d.position.copy(point); scene.add(d);
    carDebris.push({ obj: d, vel: new THREE.Vector3((Math.random() - 0.5) * 20, Math.random() * 14 + 5, (Math.random() - 0.5) * 20), t: 0 });
  }
}

function updateCarPhysics(dt) {
  updateGrab(dt);
  updateThrown(dt);
  for (let k = carDebris.length - 1; k >= 0; k--) {   // 破片
    const d = carDebris[k]; d.t += dt; d.vel.y -= CAR_GRAV * dt;
    d.obj.position.addScaledVector(d.vel, dt);
    d.obj.rotation.x += dt * 6; d.obj.rotation.z += dt * 5;
    if (d.t > 0.9) { scene.remove(d.obj); d.obj.geometry.dispose(); d.obj.material.dispose(); carDebris.splice(k, 1); }
  }
  for (let k = respawnCars.length - 1; k >= 0; k--) {   // リスポーン
    const r = respawnCars[k]; r.t += dt;
    if (r.t > CAR_RESPAWN && activeEdges.length) {
      const e = pickEdgeNear(player.pos, CAR_NEAR_R * 1.5);   // 復帰もプレイヤー近傍優先
      r.car.aId = e.aId; r.car.bId = e.bId; r.car.t = Math.random();
      r.car.dead = false; r.car.grabbed = false; r.car.thrown = false;
      r.car.mesh.rotation.set(0, 0, 0); r.car.mesh.visible = true;
      respawnCars.splice(k, 1);
    }
  }
}

// ── P3a: 生活NPC（エージェント層）。全員データのみで通勤し、近傍だけ ken の身体で実体化 ──
const AGENT_COUNT = 80, AGENT_WALK = 1.5;          // 徒歩1.5m/s
const AGENT_BIND_R = 60, AGENT_RELEASE_R = 85;     // 実体化/解除の距離（ヒステリシス）
const agents = [];
const _pathQueue = [];    // A*要求（フレームあたり2件まで処理＝早送り時のスパイク防止）
let _agentBindT = 0;

function nearestRoadNode(x, z) {
  let best = null, bd = Infinity;
  for (const [id, nd] of roadNodes) {
    const d = (nd.local.x - x) ** 2 + (nd.local.z - z) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

// A*（道路グラフ）。二分ヒープ＋ユークリッド距離ヒューリスティック
function astar(fromId, toId) {
  if (fromId == null || toId == null || fromId === toId) return null;
  const goal = roadNodes.get(toId);
  if (!goal || !roadNodes.get(fromId)) return null;
  const heap = [], hIdx = new Map();
  const push = (id, f) => { heap.push({ id, f }); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let s = i; if (l < heap.length && heap[l].f < heap[s].f) s = l; if (r < heap.length && heap[r].f < heap[s].f) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
  const g = new Map([[fromId, 0]]), came = new Map(), closed = new Set();
  const h = (id) => { const n = roadNodes.get(id).local; return Math.hypot(goal.local.x - n.x, goal.local.z - n.z); };
  push(fromId, h(fromId));
  let guard = 0;
  while (heap.length && guard++ < 30000) {
    const cur = pop().id;
    if (cur === toId) {
      const path = [cur];
      let c = cur;
      while (came.has(c)) { c = came.get(c); path.push(c); }
      return path.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const nd = roadNodes.get(cur);
    for (const nb of (nd.adj || [])) {
      const nbn = roadNodes.get(nb);
      if (!nbn || closed.has(nb)) continue;
      const w = Math.hypot(nbn.local.x - nd.local.x, nbn.local.z - nd.local.z);
      const ng = g.get(cur) + w;
      if (ng < (g.get(nb) ?? Infinity)) { g.set(nb, ng); came.set(nb, cur); push(nb, ng + h(nb)); }
    }
  }
  return null;
}

function initAgents() {
  if (!roadNodes.size || !bldModels.length) return;
  const houses = [], works = [];
  for (const md of bldModels) for (const rec of md.recs) (rec.tier === 'house' ? houses : works).push(rec);
  if (!houses.length || !works.length) return;
  for (let i = 0; i < AGENT_COUNT; i++) {
    const home = houses[(Math.random() * houses.length) | 0];
    const work = works[(Math.random() * works.length) | 0];
    agents.push({
      id: i, home, work,
      homeNode: nearestRoadNode(home.x, home.z), workNode: nearestRoadNode(work.x, work.z),
      goWork: 7 + Math.random() * 3, goHome: 17 + Math.random() * 4,   // 通勤時刻の個体差
      state: 'home', path: null, seg: 0, segT: 0, pathPending: false,
      pos: new THREE.Vector3(home.x, home.m ? 0 : 0, home.z),
      side: Math.random() < 0.5 ? 1 : -1,   // 歩道の左右
      body: null, paused: 0,
    });
  }
  console.log('agents:', agents.length);
}

function walkPath(a, dt) {
  const path = a.path;
  if (!path || a.seg >= path.length - 1) { a.state = a.state === 'toWork' ? 'work' : 'home'; a.path = null; return; }
  let move = AGENT_WALK * dt * timeScale;
  while (move > 0 && a.seg < path.length - 1) {
    const n0 = roadNodes.get(path[a.seg]), n1 = roadNodes.get(path[a.seg + 1]);
    if (!n0 || !n1) { a.seg++; a.segT = 0; continue; }
    const len = Math.hypot(n1.local.x - n0.local.x, n1.local.z - n0.local.z) || 1;
    const remain = (1 - a.segT) * len;
    if (move >= remain) { move -= remain; a.seg++; a.segT = 0; }
    else { a.segT += move / len; move = 0; }
  }
  if (a.seg >= path.length - 1) { a.state = a.state === 'toWork' ? 'work' : 'home'; a.path = null; return; }
  const n0 = roadNodes.get(path[a.seg]).local, n1 = roadNodes.get(path[a.seg + 1]).local;
  const dx = n1.x - n0.x, dz = n1.z - n0.z, len = Math.hypot(dx, dz) || 1;
  const ox = -dz / len * a.side * (ROAD_WIDTH / 2 + 1.0), oz = dx / len * a.side * (ROAD_WIDTH / 2 + 1.0);   // 歩道オフセット
  a.pos.set(n0.x + dx * a.segT + ox, n0.y + (n1.y - n0.y) * a.segT, n0.z + dz * a.segT + oz);
}

function updateAgents(dt) {
  if (!agents.length) return;
  // A*は1フレーム2件まで
  for (let k = 0; k < 2 && _pathQueue.length; k++) {
    const req = _pathQueue.shift();
    req.a.path = astar(req.from, req.to);
    req.a.seg = 0; req.a.segT = 0; req.a.pathPending = false;
    req.a.state = req.a.path ? req.next : (req.next === 'toWork' ? 'work' : 'home');   // 経路なしなら即到着扱い
  }
  for (const a of agents) {
    if (a.paused > 0) { a.paused -= dt; continue; }
    const wantWork = gameHour >= a.goWork && gameHour < a.goHome;
    if (!a.pathPending) {
      if (wantWork && a.state === 'home') { a.pathPending = true; _pathQueue.push({ a, from: a.homeNode, to: a.workNode, next: 'toWork' }); }
      else if (!wantWork && a.state === 'work') { a.pathPending = true; _pathQueue.push({ a, from: a.workNode, to: a.homeNode, next: 'toHome' }); }
    }
    if (a.state === 'toWork' || a.state === 'toHome') walkPath(a, dt);
  }
}

// 近傍の通勤中エージェントに ken の身体を割当（0.4s毎・ヒステリシス）
function updateAgentBodies(dt) {
  _agentBindT -= dt;
  if (_agentBindT > 0 || !agents.length) return;
  _agentBindT = 0.4;
  for (const a of agents) {
    const walking = a.state === 'toWork' || a.state === 'toHome';
    const d = walking ? Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z) : Infinity;
    if (a.body) {
      const m = a.body;
      if (m.dissolving || m._remove) { a.body = null; a.paused = 30; continue; }   // 倒された→しばらく再出現しない
      if (m.grabbed || m.eating || m.tornado || m.ragdoll?.active || m.scared) continue;   // 干渉中は既存挙動に任せる
      if (!walking || d > AGENT_RELEASE_R) { m.agent = null; a.body = null; }
    } else if (walking && d < AGENT_BIND_R) {
      const m = kens.find((k) => !k.agent && !k.grabbed && !k.eating && !k.dissolving && !k.tornado && !k.ragdoll?.active);
      if (m) {
        m.agent = a; a.body = m;
        m.pos.set(a.pos.x, groundYAt(a.pos.x, a.pos.z, player.pos.y), a.pos.z);
        m.vrm.scene.position.copy(m.pos);
      }
    }
  }
}

// agent に追従して歩く（既存の逃走/掴み/捕食はそのまま優先される）
function updateKenAgentFollow(m, dt) {
  const a = m.agent;
  const distP = Math.hypot(m.pos.x - player.pos.x, m.pos.z - player.pos.z);
  if (distP < KEN_FLEE_RADIUS) { m.scared = true; updateKenGround(m, dt); return; }   // 近づかれたら通勤中断して逃げる
  const invDt = dt > 1e-4 ? 1 / dt : 0;
  m.vel.set((a.pos.x - m.pos.x) * invDt, 0, (a.pos.z - m.pos.z) * invDt);
  const sp = Math.hypot(m.vel.x, m.vel.z);
  if (sp > 6) m.vel.multiplyScalar(6 / sp);   // 早送り時も見た目は歩き〜小走り
  m.pos.x = a.pos.x; m.pos.z = a.pos.z;
  m.pos.y = groundYAt(m.pos.x, m.pos.z, m.pos.y);
  m.vrm.scene.position.copy(m.pos);
  faceKenMove(m, dt);
  if (m.action) m.action.timeScale = Math.max(0.4, Math.min(2.2, Math.hypot(m.vel.x, m.vel.z) / KEN_WALK_SPEED));
}

// ── Phase 4: 地上NPC ken（tps-flight から移植・DEM地形対応）＋捕食 ──
const KEN_COUNT = 6, KEN_WALK_VRMA = 'Catwalk_Walk_Forward.vrma';   // プール=通勤者の実体化にも使う
const KEN_WALK_SPEED = 1.6, KEN_RUN_SPEED = 4.4, KEN_FLEE_RADIUS = 9, KEN_STEER_TAU = 0.45;
const KEN_MAX_HP = 100, KEN_RECOVER_DELAY = 2.5, KEN_RAGDOLL_IMPULSE = 0.3, KEN_GRAB_RANGE = 45;
const KEN_DISSOLVE_DURATION = 1.8, KEN_DISSOLVE_LINGER = 1.4;
const KEN_FAR_TELEPORT = 140, KEN_SPAWN_R = 45;
const KEN_DISSOLVE_OPTS = { rimColor: '#8ff0ff', liquidColor: '#bfeaff', rimIntensity: 2.6, groundY: 0, puddleScale: 1.6, doubleSide: false };
const kens = [];
const kenAssets = { ready: false, bundle: null, vrmBlobUrl: null, walkAnim: null, ragOpts: null, speechChar: null };
let speechUI = null;   // セリフ表示（頭上バブル）
const BUBBLE_Y = 1.9, BUBBLE_MAX_DIST = 45;
const _bubbleV = new THREE.Vector3();
function kenScreenPos(m) {   // バブルのワールド→画面投影（speech-ui が所有者ごとに呼ぶ）
  kenCenter(m, _bubbleV);
  _bubbleV.y += BUBBLE_Y - 1.0;
  const dist = camera.position.distanceTo(_bubbleV);
  _bubbleV.project(camera);
  const visible = _bubbleV.z < 1 && dist <= BUBBLE_MAX_DIST && _bubbleV.x >= -1 && _bubbleV.x <= 1 && _bubbleV.y >= -1 && _bubbleV.y <= 1;
  return { x: (_bubbleV.x * 0.5 + 0.5) * window.innerWidth, y: (-_bubbleV.y * 0.5 + 0.5) * window.innerHeight, visible };
}
const KEN_BOUNDS = { min: new THREE.Vector3(-1e5, -1e5, -1e5), max: new THREE.Vector3(1e5, 1e5, 1e5) };
const _kQ = new THREE.Vector3(), _kF = new THREE.Vector3(), _kJ = new THREE.Vector3();

const _gRayK = new THREE.Raycaster(), _gFromK = new THREE.Vector3(), _G_DOWN = new THREE.Vector3(0, -1, 0);
function groundYAt(x, z, ref) {   // 地形の地面Y（DEM地形へレイキャスト）。取れなければ ref
  if (!groundGroup || !groundGroup.children.length) return ref ?? 0;
  _gFromK.set(x, (ref ?? 0) + 80, z);
  _gRayK.set(_gFromK, _G_DOWN); _gRayK.far = 100000;
  const hit = _gRayK.intersectObject(groundGroup, true)[0];
  return hit ? hit.point.y : (ref ?? 0);
}

async function loadVrmAnimations(name) {
  const res = await fetch('../vrma/' + encodeURIComponent(name));
  if (!res.ok) throw new Error('VRMA取得失敗: ' + name);
  const al = new GLTFLoader();
  al.register((p) => new VRMAnimationLoaderPlugin(p));
  const ag = await al.loadAsync(URL.createObjectURL(await res.blob()));
  return ag.userData.vrmAnimations || null;
}

async function prepareKenAssets() {
  try {
    const bundle = await (await fetch('../npc/ken.npc.json')).json();
    if (!bundle?.vrm) return false;
    kenAssets.bundle = bundle;
    kenAssets.vrmBlobUrl = URL.createObjectURL(dataURIToBlob(bundle.vrm));
    try { kenAssets.walkAnim = (await loadVrmAnimations(KEN_WALK_VRMA))?.[0] ?? null; } catch (e) { console.warn('ken歩行VRMA失敗:', e); }
    try {   // ragdoll-editor の調整値（暴れ防止）
      const rr = await fetch('../ragdoll/ken.ragdoll.json');
      if (rr.ok) { const j = await rr.json(); kenAssets.ragOpts = { ...(j.params || {}), boneMaxBend: j.boneMaxBend || {}, boundsMargin: 0.4 }; }
    } catch { /* 無ければ既定 */ }
    try {   // セリフセット（住民の状況セリフ）
      const sd = await fetchSpeechSet('ken.speech.json');
      if (sd) kenAssets.speechChar = buildSpeechCharacter(sd, '住民');
      if (!speechUI) speechUI = createSpeechUI({ dom: document.body });
    } catch (e) { console.warn('kenセリフ準備失敗:', e); }
    kenAssets.ready = true;
    return true;
  } catch (e) { console.warn('ken素材準備失敗:', e); return false; }
}

function makeHpBar() {
  const group = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.14), new THREE.MeshBasicMaterial({ color: 0x101014, transparent: true, opacity: 0.75, depthTest: false }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.10), new THREE.MeshBasicMaterial({ color: 0x35e06a, depthTest: false }));
  fill.position.z = 0.002;
  group.add(bg, fill);
  group.renderOrder = 999;
  group.visible = false;
  return { group, fill, w: 0.88 };
}
function updateHpBar(m) {
  const bar = m.hpBar;
  if (!bar) return;
  if (m.dissolving || m.dead || m.tornado) { bar.group.visible = false; return; }
  const frac = Math.max(0, Math.min(1, m.hp / m.maxHp));
  bar.group.visible = frac < 0.999;
  kenCenter(m, _kQ);
  bar.group.position.set(_kQ.x, _kQ.y + 1.1, _kQ.z);
  bar.group.quaternion.copy(camera.quaternion);
  bar.fill.scale.x = Math.max(0.0001, frac);
  bar.fill.position.x = -bar.w * (1 - frac) * 0.5;
  bar.fill.material.color.set(frac > 0.5 ? 0x35e06a : frac > 0.25 ? 0xffc23a : 0xff4436);
}

async function spawnKen() {
  if (!kenAssets.ready) return false;
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
  const gltf = await loader.loadAsync(kenAssets.vrmBlobUrl);
  const vrm = gltf.userData.vrm;
  // プレイヤー近傍の道路沿いにスポーン（地形の地面Yへ接地）
  let px = player.pos.x + (Math.random() - 0.5) * KEN_SPAWN_R * 2, pz = player.pos.z + (Math.random() - 0.5) * KEN_SPAWN_R * 2;
  if (activeEdges.length) { const e = pickEdgeNear(player.pos, KEN_SPAWN_R * 2); px = e.a.x + (Math.random() - 0.5) * 6; pz = e.a.z + (Math.random() - 0.5) * 6; }
  const pos = new THREE.Vector3(px, groundYAt(px, pz, player.pos.y), pz);
  vrm.scene.position.copy(pos);
  scene.add(vrm.scene); vrm.scene.updateMatrixWorld(true);
  let mixer = null, action = null;
  if (kenAssets.walkAnim) {
    const clip = createVRMAnimationClip(kenAssets.walkAnim, vrm);
    stripRootMotion(clip);
    mixer = new THREE.AnimationMixer(vrm.scene);
    action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity).play();
    action.time = Math.random() * (clip.duration || 1);
  }
  const ragdoll = createRagdoll(vrm, kenAssets.ragOpts || { gravity: -12, boundsMargin: 0.4 });
  const hpBar = makeHpBar();
  scene.add(hpBar.group);
  let dis = null;   // ディソルブを事前生成（死亡時のシェーダ再コンパイルによるカクつき回避）
  try { dis = createDissolve(vrm.scene, { ...KEN_DISSOLVE_OPTS, groundY: pos.y, armed: false }); dis.setProgress(0); } catch (e) { console.warn('kenディソルブ事前生成失敗:', e); }
  let speech = null;   // 状況セリフ（頭上バブル）
  if (kenAssets.speechChar) {
    const holder = {};   // バブルの所有者キー（下で m に差し替え）
    speech = createNpcSpeech(vrm, kenAssets.speechChar, {
      onLineStart: (speaker, text, cps) => { if (speechUI && holder.m) speechUI.setBubble(holder.m, text, cps); },
    });
    speech._holder = holder;
  }
  kens.push({
    vrm, ragdoll, mixer, action, pos, speech, faceOff: 0,
    vel: new THREE.Vector3(), grabbed: false, grabBone: 'chest', recoverTimer: 0,
    scared: false, wanderTimer: 0, wanderDirX: 0, wanderDirZ: 0,
    hp: KEN_MAX_HP, maxHp: KEN_MAX_HP, hpBar,
    dissolving: false, dis, dissT: 0, dead: false, deadTimer: 0, _remove: false, eating: false, tornado: null,
  });
  if (speech) speech._holder.m = kens[kens.length - 1];   // バブル所有者を確定
  return true;
}

function kenCount() { return kens.length; }
function removeKen() {
  for (let i = kens.length - 1; i >= 0; i--) {
    const m = kens[i];
    if (m.grabbed || m.eating || m === player.prey) continue;
    finalizeRemoveKenAssets(m);
    kens.splice(i, 1);
    return true;
  }
  return false;
}
let kenDesired = 0, kenReconciling = false;
async function reconcileKens() {
  if (kenReconciling) return;
  kenReconciling = true;
  try {
    while (kenCount() !== kenDesired) {
      if (kenCount() < kenDesired) { if (!await spawnKen()) break; }
      else { if (!removeKen()) break; }
    }
  } finally { kenReconciling = false; }
}
function setKenCount(n) { kenDesired = Math.max(0, n | 0); reconcileKens(); }

function grabbedKen() { for (const m of kens) if (m.grabbed) return m; return null; }
function kenCenter(m, out) {
  const rd = m.ragdoll;
  if (rd.active && rd.idxOf.hips != null) out.copy(rd.particles[rd.idxOf.hips].pos);
  else { out.copy(m.pos); out.y += 1.0; }
  return out;
}
function kenLowestY(m) {
  const rd = m.ragdoll;
  if (rd.active && rd.particles.length) {
    let y = Infinity;
    for (const p of rd.particles) if (p.pos.y < y) y = p.pos.y;
    return y;
  }
  return m.pos.y;
}
function nearestKenJoint(m, orig, dir) {   // 照準レイに近い関節（掴み用）
  const rd = m.ragdoll;
  let best = null, bestAlong = Infinity;
  for (const p of rd.particles) {
    if (rd.active) _kJ.copy(p.pos);
    else { const node = m.vrm.humanoid?.getNormalizedBoneNode(p.bone); if (!node) continue; node.getWorldPosition(_kJ); }
    _kJ.sub(orig);
    const along = _kJ.dot(dir);
    if (along < 0 || along > KEN_GRAB_RANGE) continue;
    const perp2 = _kJ.lengthSq() - along * along;
    if (perp2 < 0.3 && along < bestAlong) { bestAlong = along; best = p.bone; }
  }
  return best ? { bone: best, along: bestAlong } : null;
}
function grabKen(m, bone) {
  m.grabbed = true;
  addWanted(0.2, m.pos);   // 住人を掴む＝軽犯罪
  if (m.speech) m.speech.bark('grabbed');
  if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true);
  m.grabBone = bone || 'chest';
  if (bite.ready) { player.prey = m; m.preyGroundT = 0; }   // 捕食候補（地面付近で保持→捕食）
}
function releaseKen(m) {
  m.grabbed = false;
  m.recoverTimer = KEN_RECOVER_DELAY;
  if (m.speech) m.speech.bark('thrown');
  if (player.prey === m) player.prey = null;
}
function hitKen(m, dir, impulse = KEN_RAGDOLL_IMPULSE) {
  if (m.ragdoll.active) { applyRagdollImpulse(m.ragdoll, dir.clone().multiplyScalar(impulse), 'hips'); return; }
  setRagdollActive(m.ragdoll, true);
  applyRagdollImpulse(m.ragdoll, dir.clone().multiplyScalar(impulse), 'chest');
  m.recoverTimer = KEN_RECOVER_DELAY;
}
function hitKenBeam(m, dmg) {
  m.hp -= dmg;
  kenCenter(m, _kQ);
  spawnImpactFx(_kQ);
  addWanted(0.4, _kQ);   // 住人への攻撃＝犯罪
  if (m.hp <= 0) { startKenDissolve(m); return; }
  camera.getWorldDirection(_camDir);
  hitKen(m, _camDir, KEN_RAGDOLL_IMPULSE);
}

function startKenDissolve(m) {
  if (m.dissolving) return;
  kenCenter(m, _kQ);
  addWanted(1.0, _kQ);   // 住人を倒した＝重犯罪
  m.dissolving = true; m.dissT = 0; m.dead = false; m.deadTimer = 0;
  m.grabbed = false; m.tornado = null;
  m.vel.set(0, 0, 0);
  if (player.prey === m) player.prey = null;
  if (m.ragdoll?.active) setRagdollActive(m.ragdoll, false);
  if (m.hpBar) m.hpBar.group.visible = false;
  if (m.dis) m.dis.setArmed(true);
  else m.dis = createDissolve(m.vrm.scene, KEN_DISSOLVE_OPTS);
  m.dis.setProgress(0);
  m.dis.setGroundY(groundYAt(_kQ.x, _kQ.z, _kQ.y));   // 地形の地面へパドルを固定
  m.dis.setPuddleCenter(_kQ.x, _kQ.z);
  spawnImpactFx(_kQ);
}
function updateKenDissolve(m, dt) {
  m.vrm.update(dt);
  if (!m.dead) {
    m.dissT += dt;
    const pr = Math.min(1, m.dissT / KEN_DISSOLVE_DURATION);
    m.dis.setProgress(pr);
    if (pr >= 1) { m.dead = true; m.deadTimer = KEN_DISSOLVE_LINGER; }
  } else m.deadTimer -= dt;
  if (m.dis) m.dis.update(dt);
  if (m.dead && m.deadTimer <= 0) m._remove = true;
}
function finalizeRemoveKenAssets(m) {
  if (m.dis) { m.dis.dispose(); m.dis = null; }
  if (m.hpBar) { scene.remove(m.hpBar.group); m.hpBar = null; }
  try { if (m.ragdoll) disposeRagdoll(m.ragdoll); } catch { /* noop */ }
  if (m.vrm?.scene) scene.remove(m.vrm.scene);
}
function onKenRecovered(m) {
  const rd = m.ragdoll;
  if (rd.idxOf.hips != null) { const hp = rd.particles[rd.idxOf.hips].pos; m.pos.set(hp.x, groundYAt(hp.x, hp.z, hp.y), hp.z); }
  m.vel.set(0, 0, 0); m.wanderTimer = 0; m.scared = false;
}

function updateKenGround(m, dt) {   // 地形上を逃走/うろつき
  _kF.copy(player.pos).sub(m.pos); _kF.y = 0;
  const dist = _kF.length();
  let dx, dz, speed;
  if (dist < KEN_FLEE_RADIUS) {
    m.scared = true;
    const inv = dist > 1e-3 ? 1 / dist : 0;
    dx = -_kF.x * inv; dz = -_kF.z * inv;
    speed = KEN_RUN_SPEED;
  } else {
    m.scared = false;
    m.wanderTimer -= dt;
    if (m.wanderTimer <= 0 || (m.wanderDirX === 0 && m.wanderDirZ === 0)) {
      const a = Math.random() * Math.PI * 2;
      m.wanderDirX = Math.cos(a); m.wanderDirZ = Math.sin(a);
      m.wanderTimer = 1.5 + Math.random() * 2.5;
    }
    dx = m.wanderDirX; dz = m.wanderDirZ;
    speed = KEN_WALK_SPEED;
  }
  const dl = Math.hypot(dx, dz) || 1;
  const tvx = dx / dl * speed, tvz = dz / dl * speed;
  const k = 1 - Math.exp(-dt / KEN_STEER_TAU);
  m.vel.x += (tvx - m.vel.x) * k; m.vel.z += (tvz - m.vel.z) * k; m.vel.y = 0;
  m.pos.addScaledVector(m.vel, dt);
  m.pos.y = groundYAt(m.pos.x, m.pos.z, m.pos.y);
  if (m.pos.distanceTo(player.pos) > KEN_FAR_TELEPORT) {   // 離れすぎたら近傍へ再配置
    const e = activeEdges.length ? pickEdgeNear(player.pos, KEN_SPAWN_R * 2) : null;
    if (e) { m.pos.set(e.a.x, groundYAt(e.a.x, e.a.z, player.pos.y), e.a.z); }
  }
  m.vrm.scene.position.copy(m.pos);
  faceKenMove(m, dt);
  if (m.action) {
    const sp = Math.hypot(m.vel.x, m.vel.z);
    m.action.timeScale = Math.max(0.4, Math.min(2.2, sp / KEN_WALK_SPEED));
  }
}
function faceKenMove(m, dt) {
  const sp2 = m.vel.x * m.vel.x + m.vel.z * m.vel.z;
  if (sp2 < 0.09) return;
  const targetYaw = Math.atan2(m.vel.x, m.vel.z) + m.faceOff;
  let diff = targetYaw - m.vrm.scene.rotation.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  m.vrm.scene.rotation.y += diff * (1 - Math.exp(-dt / 0.4));
}

function updateKens(dt) {
  for (const m of kens) updateOneKen(m, dt);
  for (let i = kens.length - 1; i >= 0; i--) {
    if (kens[i]._remove) { const m = kens[i]; kens.splice(i, 1); finalizeRemoveKenAssets(m); reconcileKens().catch(() => { /* noop */ }); }
  }
}
function updateOneKen(m, dt) {
  updateHpBar(m);
  if (m.eating) { updateEatingVictim(m, dt); return; }
  if (m.dissolving) { updateKenDissolve(m, dt); return; }
  if (m.tornado) { updateKenTornado(m, dt); return; }
  const rd = m.ragdoll;
  if (rd.active) {
    const env = { floorY: groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y), bounds: KEN_BOUNDS };
    if (m.grabbed) { env.pinBone = m.grabBone || 'chest'; env.pinPos = frontAnchor; }
    updateRagdoll(rd, dt, env);
    if (!m.grabbed) { m.recoverTimer -= dt; if (m.recoverTimer <= 0) setRagdollActive(rd, false); }
  } else if (rd.recovering) {
    if (m.mixer) m.mixer.update(dt);
    updateRagdollRecovery(rd, dt);
    if (!rd.recovering) onKenRecovered(m);
  } else {
    if (m.mixer) m.mixer.update(dt);
    if (m.agent && !m.scared) updateKenAgentFollow(m, dt);   // 通勤エージェントに追従
    else updateKenGround(m, dt);
  }
  m.vrm.update(dt);
  if (m.speech) {   // 状況セリフ（表情適用後に update）
    if (m.grabbed || m.ragdoll?.active) m.speech.onState('downed');
    else if (m.scared) m.speech.onState('flee');
    else if (m.agent) m.speech.onState('commute');
    else m.speech.onState('idle');
    m.speech.update(dt);
  }
}

// ── 捕食（tps-flight から移植。接地判定のみ地形相対に変更）──
const bite = { cfg: null, victimAnim: null, feedAction: null, feedIn: 0, feedIntroOut: 2.5, feedLoopEnd: 4, feedClipDur: 4, loopStartFrame: 75, sound: null, ready: false };
const _baPos = new THREE.Vector3(), _baQuat = new THREE.Quaternion(), _baOff = new THREE.Vector3();
const _mouthPos = new THREE.Vector3(), _baE = new THREE.Euler(), _baTmpQ = new THREE.Quaternion();
const _desiredQ = new THREE.Quaternion(), _desiredP = new THREE.Vector3();
const _savePos = new THREE.Vector3(), _saveQ = new THREE.Quaternion();
const _biteCur = new THREE.Vector3(), _biteQ = new THREE.Quaternion(), _baDelta = new THREE.Vector3(), _targetP = new THREE.Vector3();

async function prepareBiteAssets() {
  try { bite.cfg = await (await fetch('../bitealign/ken.bite.json')).json(); }
  catch (e) { console.warn('bite設定の読込失敗:', e); return; }
  const a = bite.cfg.anim || {};
  const fps = a.fps || 30;
  bite.feedIn = (a.trimIn || 0) / fps;
  try { bite.victimAnim = (await loadVrmAnimations(a.victimVrma || 'attack_drain_victim02.vrma'))?.[0] ?? null; }
  catch (e) { console.warn('victim VRMA 読込失敗:', e); }
  try {
    if (player.vrm && player.mixer) {
      const anims = await loadVrmAnimations(a.playerVrma || 'feed.vrma');
      if (anims?.[0]) {
        const clip = createVRMAnimationClip(anims[0], player.vrm);
        stripRootMotion(clip);
        bite.feedAction = player.mixer.clipAction(clip);
        bite.feedAction.setLoop(THREE.LoopRepeat, Infinity);
        bite.feedAction.clampWhenFinished = false;
        bite.feedClipDur = clip.duration;
        bite.feedIntroOut = Math.min(clip.duration - 1e-3, (a.loopStart ?? 75) / fps);
        bite.loopStartFrame = a.loopStart ?? 75;
        bite.feedLoopEnd = Math.min(clip.duration - 1e-3, a.loopEnd != null ? a.loopEnd / fps : clip.duration - 1e-3);
        if (bite.feedLoopEnd <= bite.feedIntroOut) bite.feedLoopEnd = clip.duration - 1e-3;
      }
    }
  } catch (e) { console.warn('feed VRMA 読込失敗:', e); }
  if (bite.cfg.anim?.sound) {
    try { bite.sound = new Audio('../audio/' + encodeURIComponent(bite.cfg.anim.sound)); bite.sound.loop = true; bite.sound.load(); }
    catch { bite.sound = null; }
  }
  bite.ready = !!(bite.cfg && bite.victimAnim && bite.feedAction);
}

function updatePredation(dt) {
  const m = player.prey;
  if (!m || player.eating) return;
  if (!m.grabbed || m.dissolving || m._remove) { player.prey = null; return; }
  const gy = groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y);
  if (kenLowestY(m) < gy + PREY_GROUND_Y) m.preyGroundT = (m.preyGroundT || 0) + dt;   // 体の最下点が地形に接地
  else m.preyGroundT = 0;
  if (m.preyGroundT >= PREY_GROUND_TIME) startEating(m);
}
function startVictimAnim(m) {
  if (!bite.victimAnim || !m.mixer) return;
  try {
    const clip = createVRMAnimationClip(bite.victimAnim, m.vrm);
    stripRootMotion(clip);
    const act = m.mixer.clipAction(clip);
    act.setLoop(bite.cfg.anim.loopVictim ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    act.clampWhenFinished = !bite.cfg.anim.loopVictim;
    act.reset(); act.setEffectiveWeight(1); act.enabled = true; act.play();
    if (m.action) m.action.crossFadeTo(act, 0.12, false);
    m.victimAction = act;
  } catch (e) { console.warn('victim anim 生成失敗:', e); }
}
function startEating(m) {
  if (m.speech) m.speech.bark('predation');
  player.eating = true; player.eatT = 0;
  player.vel.set(0, 0, 0);
  m.eating = true; m.eatBlend = 0;
  m.grabbed = false;
  m.eatMode = (bite.cfg.npc && bite.cfg.npc.mode === 'ragdoll') ? 'ragdoll' : 'anim';
  if (m.eatMode === 'ragdoll') {
    if (!m.ragdoll.active) setRagdollActive(m.ragdoll, true);
    m.eatNudgeIdx = 0; m.eatLastFrame = -1;
  } else {
    if (m.ragdoll?.active) setRagdollActive(m.ragdoll, false);
    startVictimAnim(m);
  }
  if (bite.feedAction) {
    const cur = (player.current && player.states[player.current]) ? player.states[player.current].action : null;
    if (player.current && player.states[player.current]) hideStateEffects(player.states[player.current]);
    bite.feedAction.reset();
    bite.feedAction.time = bite.feedIn;
    bite.feedAction.setEffectiveWeight(1);
    bite.feedAction.setEffectiveTimeScale(1);
    bite.feedAction.enabled = true;
    bite.feedAction.play();
    if (cur && cur !== bite.feedAction) cur.crossFadeTo(bite.feedAction, bite.cfg.align.blendIn ?? 0.15, false);
  }
  if (bite.sound) { try { bite.sound.currentTime = 0; bite.sound.play().catch(() => { /* 自動再生制限 */ }); } catch { /* noop */ } }
  player.oneShot = null; player.charging = false;
  player.current = null;
}
function biteSample(name) {
  const tr = bite.cfg && bite.cfg.tracks && bite.cfg.tracks[name];
  if (!tr || !tr.length) return null;
  const fps = (bite.cfg.anim && bite.cfg.anim.fps) || 30;
  const f = (bite.feedAction ? bite.feedAction.time : 0) * fps;
  if (f <= tr[0].f) return tr[0].v;
  const last = tr[tr.length - 1];
  if (f >= last.f) return last.v;
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i], b = tr[i + 1];
    if (f >= a.f && f <= b.f) { const t = (f - a.f) / Math.max(1, b.f - a.f); return [a.v[0] + (b.v[0] - a.v[0]) * t, a.v[1] + (b.v[1] - a.v[1]) * t, a.v[2] + (b.v[2] - a.v[2]) * t]; }
  }
  return last.v;
}
function applyBiteAlign(m, blend) {
  const cfg = bite.cfg;
  const head = player.vrm.humanoid?.getNormalizedBoneNode(cfg.player.mouthBone);
  const neck = m.vrm.humanoid?.getNormalizedBoneNode(cfg.npc.biteBone);
  if (!head || !neck) return;
  const mOff = biteSample('mouthOffset') || cfg.player.mouthOffset;
  const bOff = biteSample('biteOffset') || cfg.npc.biteOffset;
  const aPos = biteSample('alignPos') || cfg.align.pos;
  const aRot = biteSample('alignRot') || cfg.align.rotEuler;
  head.updateWorldMatrix(true, false);
  head.getWorldPosition(_baPos); head.getWorldQuaternion(_baQuat);
  _mouthPos.copy(_baOff.fromArray(mOff).applyQuaternion(_baQuat)).add(_baPos);
  _baE.set(aRot[0] * D2R, aRot[1] * D2R, aRot[2] * D2R, 'YXZ');
  _desiredQ.copy(_baQuat).multiply(_baTmpQ.setFromEuler(_baE));
  _desiredP.copy(_baOff.fromArray(aPos).applyQuaternion(_baQuat)).add(_mouthPos);
  _savePos.copy(m.vrm.scene.position); _saveQ.copy(m.vrm.scene.quaternion);
  m.vrm.scene.quaternion.copy(_desiredQ); m.vrm.scene.updateMatrixWorld(true);
  neck.updateWorldMatrix(true, false);
  neck.getWorldPosition(_biteCur); neck.getWorldQuaternion(_biteQ);
  _biteCur.add(_baOff.fromArray(bOff).applyQuaternion(_biteQ));
  _baDelta.copy(_desiredP).sub(_biteCur);
  _targetP.copy(m.vrm.scene.position).add(_baDelta);
  m.vrm.scene.quaternion.copy(_saveQ).slerp(_desiredQ, blend);
  m.vrm.scene.position.copy(_savePos).lerp(_targetP, blend);
  m.vrm.scene.updateMatrixWorld(true);
}
function updateEatingVictim(m, dt) {
  if (m.eatMode === 'ragdoll') { updateEatingRagdoll(m, dt); return; }
  if (m.mixer) m.mixer.update(dt);
  m.vrm.update(dt);
  m.eatBlend = Math.min(1, (m.eatBlend || 0) + dt / Math.max(0.03, bite.cfg.align.blendIn ?? 0.15));
  applyBiteAlign(m, m.eatBlend);
}
function biteMouthAnchor(out) {
  const cfg = bite.cfg;
  const head = player.vrm.humanoid?.getNormalizedBoneNode(cfg.player.mouthBone);
  if (!head) return false;
  const mOff = biteSample('mouthOffset') || cfg.player.mouthOffset;
  head.updateWorldMatrix(true, false);
  head.getWorldPosition(_baPos); head.getWorldQuaternion(_baQuat);
  out.copy(_baOff.fromArray(mOff).applyQuaternion(_baQuat)).add(_baPos);
  return true;
}
function fireNudge(m, n) {
  const bone = (n.bone && m.ragdoll.idxOf[n.bone] != null) ? n.bone : 'chest';
  _kF.set((n.dir && n.dir[0]) || 0, (n.dir && n.dir[1]) || 0, (n.dir && n.dir[2]) || 0).multiplyScalar(n.strength || 1);
  applyRagdollImpulse(m.ragdoll, _kF, bone);
}
function updateEatingRagdoll(m, dt) {
  const env = { floorY: groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y), bounds: KEN_BOUNDS };
  if (biteMouthAnchor(_kQ)) { env.pinBone = bite.cfg.npc.biteBone || 'neck'; env.pinPos = _kQ; }
  updateRagdoll(m.ragdoll, dt, env);
  m.vrm.update(dt);
  const nudges = bite.cfg.nudges || [];
  if (nudges.length) {
    const fps = (bite.cfg.anim && bite.cfg.anim.fps) || 30;
    const cf = (bite.feedAction ? bite.feedAction.time : 0) * fps;
    if (cf < (m.eatLastFrame ?? -1)) {
      m.eatNudgeIdx = 0;
      while (m.eatNudgeIdx < nudges.length && nudges[m.eatNudgeIdx].f < bite.loopStartFrame) m.eatNudgeIdx++;
    }
    while (m.eatNudgeIdx < nudges.length && nudges[m.eatNudgeIdx].f <= cf) { fireNudge(m, nudges[m.eatNudgeIdx]); m.eatNudgeIdx++; }
    m.eatLastFrame = cf;
  }
}
function updatePlayerEating(dt) {
  player.mixer.update(dt);
  const a = bite.feedAction;
  if (a) {
    const s = bite.feedIntroOut, e = bite.feedLoopEnd, span = Math.max(1e-3, e - s);
    if (a.time >= e) { a.time = s + ((a.time - s) % span); player.mixer.update(0); }
  }
  player.vrm.update(dt);
  if (player.cloth) player.cloth.update(dt, 0);
  player.eatT += dt;
  if (player.eatT >= PREDATION_EAT_TIME) finishEating();
}
function finishEating() {
  const m = player.prey;
  player.eating = false; player.eatT = 0; player.prey = null;
  if (bite.sound) { try { bite.sound.pause(); } catch { /* noop */ } }
  if (m) {
    m.eating = false;
    m.pos.copy(m.vrm.scene.position);
    startKenDissolve(m);
  }
  const idle = player.states.idle;
  if (idle) {
    idle.action.reset(); idle.action.setEffectiveWeight(1); idle.action.enabled = true; idle.action.play();
    if (bite.feedAction) bite.feedAction.crossFadeTo(idle.action, bite.cfg.align.blendOut ?? 0.2, false);
    player.current = 'idle';
    if (player.cloth) player.cloth.setTimeline(idle.timeline);
  }
}

// ── Phase 5: トーテム（接地中の左長押し→Joy_reborn_totem 再生→トーネード設置。投入物を溶かして成長）──
const TOTEM_CAST_FRAME = 48;   // totem timeline の custom:totem 開始フレームに合わせて設置
const TOTEM_R = 6, TOTEM_CONSUME = 2.6, TOTEM_GROW = 0.14, TOTEM_MAX = 2.6, TOTEM_SPIN = 3.2;
const totem = { fx: null, active: false, pos: new THREE.Vector3(), scale: 0.25, target: 1 };
function startTotemCast() { totemCast = { placed: false }; triggerOneShot('totem'); }
async function ensureTotemFx() {
  if (totem.fx) return;
  const spec = await loadFxSpec('totem');
  if (!spec) return;
  try {
    totem.fx = createMeshFx(spec);
    totem.fx.setEmitting(false);
    totem.fx.object3D.visible = false;
    scene.add(totem.fx.object3D);
  } catch (e) { console.warn('トーテムFX生成失敗:', e); }
}
function placeTotem() {   // 設置/移動（小さく発生→現在サイズへ成長）
  if (!totem.fx) return;
  const dx = Math.sin(player.yaw), dz = Math.cos(player.yaw);
  const px = player.pos.x + dx * 3.5, pz = player.pos.z + dz * 3.5;
  totem.pos.set(px, groundYAt(px, pz, player.pos.y), pz);
  totem.scale = 0.25;
  if (!totem.active) totem.target = 1;   // 移動時は成長を維持
  totem.active = true;
  totem.fx.object3D.position.copy(totem.pos);
  totem.fx.object3D.visible = true;
  totem.fx.setEmitting(true);
}
function updateKenTornado(m, dt) {   // トーネードに投げ込まれた ken：旋回→溶解
  const tr = m.tornado; if (!tr) return;
  tr.t += dt; tr.ang += dt * TOTEM_SPIN;
  tr.r += (1.4 - tr.r) * Math.min(1, dt * 1.2);
  const y = totem.pos.y + 1.0 + tr.t * 1.2;
  m.vrm.scene.position.set(totem.pos.x + Math.cos(tr.ang) * tr.r, y, totem.pos.z + Math.sin(tr.ang) * tr.r);
  m.vrm.scene.rotation.y += dt * 6;
  m.pos.copy(m.vrm.scene.position);
  m.vrm.update(dt);
  if (tr.t >= TOTEM_CONSUME) {
    m.tornado = null;
    startKenDissolve(m);   // その場で溶け消える
    totem.target = Math.min(TOTEM_MAX, totem.target + TOTEM_GROW);
  }
}
function updateTotem(dt) {
  if (!totem.active || !totem.fx) return;
  totem.scale += (totem.target - totem.scale) * Math.min(1, dt * 2.2);
  totem.fx.object3D.scale.setScalar(totem.scale);
  totem.fx.update(dt);
  const R = TOTEM_R * totem.scale;
  // 投げ込まれた車を捕獲
  for (let i = thrownCars.length - 1; i >= 0; i--) {
    const car = thrownCars[i];
    const dx = car.mesh.position.x - totem.pos.x, dz = car.mesh.position.z - totem.pos.z;
    if (dx * dx + dz * dz < R * R && Math.abs(car.mesh.position.y - totem.pos.y) < R + 12) {
      thrownCars.splice(i, 1);
      car.thrown = false;
      car.tornado = { ang: Math.atan2(dz, dx), r: Math.max(1.5, Math.hypot(dx, dz)), t: 0, s0: car.mesh.scale.x };
    }
  }
  // 捕獲済みの車：旋回→縮小→消滅（トーテム成長）
  for (const car of cars) {
    const tr = car.tornado; if (!tr) continue;
    tr.t += dt; tr.ang += dt * TOTEM_SPIN * 1.2;
    tr.r += (1.6 - tr.r) * Math.min(1, dt * 1.1);
    const y = totem.pos.y + 1.2 + tr.t * 1.4;
    car.mesh.position.set(totem.pos.x + Math.cos(tr.ang) * tr.r, y, totem.pos.z + Math.sin(tr.ang) * tr.r);
    car.mesh.rotation.x += dt * 5; car.mesh.rotation.y += dt * 4;
    const shrink = Math.max(0.05, 1 - Math.max(0, tr.t - TOTEM_CONSUME * 0.55) / (TOTEM_CONSUME * 0.45));
    car.mesh.scale.setScalar(tr.s0 * shrink);
    if (tr.t >= TOTEM_CONSUME) {
      spawnBreakFx(car.mesh.position.clone());
      car.mesh.scale.setScalar(tr.s0);
      car.tornado = null; car.mesh.visible = false; car.dead = true; car.vel = null;
      respawnCars.push({ car, t: 0 });
      totem.target = Math.min(TOTEM_MAX, totem.target + TOTEM_GROW);
    }
  }
  // 投げ込まれた ken（ラグドール中に接近）を捕獲
  for (const m of kens) {
    if (m.tornado || m.grabbed || m.eating || m.dissolving) continue;
    if (!m.ragdoll?.active) continue;   // 「放り込む」＝投げられて飛んでいる個体だけ
    kenCenter(m, _kQ);
    const dx = _kQ.x - totem.pos.x, dz = _kQ.z - totem.pos.z;
    if (dx * dx + dz * dz < R * R && Math.abs(_kQ.y - totem.pos.y) < R + 10) {
      setRagdollActive(m.ragdoll, false);
      if (player.prey === m) player.prey = null;
      m.tornado = { ang: Math.atan2(dz, dx), r: Math.max(1.2, Math.hypot(dx, dz)), t: 0 };
    }
  }
}

// ── P1: 昼夜サイクル（ゲーム内時計→空(SkyMesh)/太陽光/フォグ/ネオン/車ライト）──
const DAY_SECONDS = 600;   // 1ゲーム日 = 実時間10分
let gameHour = 10, timeScale = 1;
const dayRefs = { amb: null, sun: null, hemi: null, bg: null, fog: null };
let skyMesh = null, nightF = 0;
async function initSky() {
  try {
    const { SkyMesh } = await import('https://esm.sh/three@0.184.0/examples/jsm/objects/SkyMesh.js?deps=three@0.184.0');
    skyMesh = new SkyMesh();
    skyMesh.scale.setScalar(20000);
    skyMesh.turbidity.value = 6;
    skyMesh.rayleigh.value = 2;
    skyMesh.mieCoefficient.value = 0.004;
    skyMesh.mieDirectionalG.value = 0.8;
    scene.add(skyMesh);
    scene.background = null;   // 空は SkyMesh が描く（フォールバック時は背景色レルプ）
  } catch (e) { console.warn('SkyMesh 読込失敗（背景色レルプで代替）:', e); }
}
// 時刻キー（色・強度を区間ごとに線形補間）
const DAY_KEYS = [
  { h: 0.0,  sky: 0x0a1226, sunI: 0.04, ambI: 0.14, hemiI: 0.08, sunC: 0x8899ff },
  { h: 5.0,  sky: 0x141c33, sunI: 0.06, ambI: 0.16, hemiI: 0.10, sunC: 0x8899ff },
  { h: 6.5,  sky: 0xe8b58e, sunI: 0.90, ambI: 0.55, hemiI: 0.30, sunC: 0xffcf99 },
  { h: 9.0,  sky: 0x9ec6e6, sunI: 1.70, ambI: 1.00, hemiI: 0.60, sunC: 0xfff4e0 },
  { h: 15.0, sky: 0x9ec6e6, sunI: 1.70, ambI: 1.00, hemiI: 0.60, sunC: 0xfff4e0 },
  { h: 18.0, sky: 0xdd9a78, sunI: 0.80, ambI: 0.48, hemiI: 0.25, sunC: 0xffb070 },
  { h: 19.5, sky: 0x141c33, sunI: 0.06, ambI: 0.16, hemiI: 0.10, sunC: 0x8899ff },
  { h: 24.0, sky: 0x0a1226, sunI: 0.04, ambI: 0.14, hemiI: 0.08, sunC: 0x8899ff },
];
const _dcA = new THREE.Color(), _dcB = new THREE.Color(), _dcOut = new THREE.Color();
function dayLerp(prop, h) {
  let i = 0;
  while (i < DAY_KEYS.length - 1 && DAY_KEYS[i + 1].h < h) i++;
  const a = DAY_KEYS[i], b = DAY_KEYS[Math.min(i + 1, DAY_KEYS.length - 1)];
  const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
  if (typeof a[prop] === 'number' && prop.endsWith('I')) return a[prop] + (b[prop] - a[prop]) * t;
  _dcA.setHex(a[prop]); _dcB.setHex(b[prop]);
  return _dcOut.copy(_dcA).lerp(_dcB, t);
}
function updateDayNight(dt) {
  gameHour = (gameHour + dt * timeScale * 24 / DAY_SECONDS) % 24;
  const ang = ((gameHour - 6) / 12) * Math.PI;   // 6時=日の出 / 18時=日の入り
  const sx = Math.cos(ang), sy = Math.sin(ang);
  nightF = THREE.MathUtils.clamp(1 - (sy + 0.08) / 0.25, 0, 1);   // 0=昼 1=夜
  if (dayRefs.sun) {
    dayRefs.sun.position.set(sx * 3000, Math.max(0.06, sy) * 3000, 1200);
    dayRefs.sun.intensity = dayLerp('sunI', gameHour);
    dayRefs.sun.color.copy(dayLerp('sunC', gameHour));
  }
  if (dayRefs.amb) dayRefs.amb.intensity = dayLerp('ambI', gameHour);
  if (dayRefs.hemi) dayRefs.hemi.intensity = dayLerp('hemiI', gameHour);
  const skyC = dayLerp('sky', gameHour);
  if (dayRefs.fog) dayRefs.fog.color.copy(skyC);
  if (skyMesh) skyMesh.sunPosition.value.set(sx, sy, 0.35);
  else if (dayRefs.bg) dayRefs.bg.copy(skyC);
  if (neonMat) neonMat.opacity = nightF;                     // 屋上ランプは夜だけ
  if (carHeadMat) { carHeadMat.opacity = nightF; carTailMat.opacity = nightF; }
  if (streetGlowMat) streetGlowMat.opacity = nightF;   // 街灯も夜だけ
  if (cloudMat) {   // 雲: 時刻で色（夕焼けは太陽色に染まる）と濃さを変え、ゆっくり流す
    cloudMat.color.copy(dayLerp('sunC', gameHour)).lerp(_dcWhite, 0.6);
    cloudMat.opacity = 0.85 - nightF * 0.55;
    cloudDrift = (cloudDrift + dt * 4) % 4000;
    if (cloudMesh) cloudMesh.position.x = cloudDrift - 2000;
  }
}

// ── 雲: プロシージャル雲テクスチャ×大判の水平ビルボードをインスタンス描画（1ドローコール）──
const _dcWhite = new THREE.Color(0xffffff);
let cloudMat = null, cloudMesh = null, cloudDrift = 0;
function buildClouds() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < 16; i++) {   // ふわっとした塊を重ねる
    const x = 48 + Math.random() * 160, y = 80 + Math.random() * 96, r = 28 + Math.random() * 48;
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, r);
    g2.addColorStop(0, 'rgba(255,255,255,0.5)');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(cv);
  cloudMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);   // 水平の雲層
  const N = 42;
  cloudMesh = new THREE.InstancedMesh(geo, cloudMat, N);
  cloudMesh.frustumCulled = false;
  cloudMesh.renderOrder = 1;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), e = new THREE.Euler();
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, rr = 400 + Math.random() * 5200;
    p.set(Math.cos(a) * rr, 750 + Math.random() * 420, Math.sin(a) * rr);
    e.set(0, Math.random() * Math.PI * 2, 0); q.setFromEuler(e);
    const sc = 350 + Math.random() * 650;
    s.set(sc, 1, sc * (0.55 + Math.random() * 0.5));
    m.compose(p, q, s);
    cloudMesh.setMatrixAt(i, m);
  }
  scene.add(cloudMesh);
}

// ── ネオン/屋上ランプ: 高層=四隅・中層=中央1点を、全建物まとめて1つの Points で描画 ──
let neonMat = null;
function buildNeon() {
  const pos = [], col = [];
  const c = new THREE.Color(), _v = new THREE.Vector3();
  for (const md of bldModels) {
    const bb = md.tpl.geometry.boundingBox;
    for (const rec of md.recs) {
      if (rec.tier === 'house') continue;
      const corners = rec.tier === 'tower'
        ? [[bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z]]
        : [[(bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2]];
      for (const p of corners) {
        _v.set(p[0], p[1] + 0.6, p[2]).applyMatrix4(rec.m);
        c.setHSL(Math.random() < 0.55 ? 0.0 : (Math.random() < 0.6 ? 0.6 : 0.09), 1.0, 0.55);   // 赤/青/橙
        pos.push({ x: _v.x, y: _v.y, z: _v.z, r: c.r, g: c.g, b: c.b });
      }
    }
  }
  // WebGPUはPointsが常に1px（近づくと見えない）→ 加算合成の小球インスタンスで描く
  const geo = new THREE.SphereGeometry(0.8, 6, 5);
  neonMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.InstancedMesh(geo, neonMat, pos.length);
  mesh.frustumCulled = false;
  const _mm = new THREE.Matrix4(), _cc = new THREE.Color();
  for (let i = 0; i < pos.length; i++) {
    _mm.makeTranslation(pos[i].x, pos[i].y, pos[i].z);
    mesh.setMatrixAt(i, _mm);
    mesh.setColorAt(i, _cc.setRGB(pos[i].r, pos[i].g, pos[i].b));
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  console.log('neon lamps:', pos.length);
}

// ── 車ライト: ヘッド/テールを各1つの Points（動的更新）。夜は遠距離の車体を隠しライトだけ描く ──
let carHeadMat = null, carTailMat = null, carHeadMesh = null, carTailMesh = null;
const CAR_HIDE_DIST = 250;
const _clM = new THREE.Matrix4();
function buildCarLights() {
  const n = cars.length * 2;
  const mk = (color, r) => {
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(r, 6, 5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
      n,
    );
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  carHeadMesh = mk(0xfff0c0, 0.32); carHeadMat = carHeadMesh.material;
  carTailMesh = mk(0xff2818, 0.24); carTailMat = carTailMesh.material;
}
function updateCarLights() {
  if (!carHeadMesh) return;
  const night = nightF > 0.4;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const away = Math.hypot(car.mesh.position.x - player.pos.x, car.mesh.position.z - player.pos.z);
    // 夜は遠距離の車体を隠してライトだけ（「光の川」＝描画節約）
    if (!car.dead && !car.grabbed && !car.tornado) car.mesh.visible = !(night && away > CAR_HIDE_DIST);
    if (car.dead || !night) {
      _clM.makeTranslation(0, -9999, 0);
      carHeadMesh.setMatrixAt(i * 2, _clM); carHeadMesh.setMatrixAt(i * 2 + 1, _clM);
      carTailMesh.setMatrixAt(i * 2, _clM); carTailMesh.setMatrixAt(i * 2 + 1, _clM);
      continue;
    }
    const ry = car.mesh.rotation.y;
    const fx = Math.sin(ry), fz = Math.cos(ry);
    const lx = Math.cos(ry), lz = -Math.sin(ry);
    const px = car.mesh.position.x, py = car.mesh.position.y + 0.55, pz = car.mesh.position.z;
    _clM.makeTranslation(px + fx * 2.0 + lx * 0.7, py, pz + fz * 2.0 + lz * 0.7); carHeadMesh.setMatrixAt(i * 2, _clM);
    _clM.makeTranslation(px + fx * 2.0 - lx * 0.7, py, pz + fz * 2.0 - lz * 0.7); carHeadMesh.setMatrixAt(i * 2 + 1, _clM);
    _clM.makeTranslation(px - fx * 2.0 + lx * 0.7, py, pz - fz * 2.0 + lz * 0.7); carTailMesh.setMatrixAt(i * 2, _clM);
    _clM.makeTranslation(px - fx * 2.0 - lx * 0.7, py, pz - fz * 2.0 - lz * 0.7); carTailMesh.setMatrixAt(i * 2 + 1, _clM);
  }
  carHeadMesh.instanceMatrix.needsUpdate = true;
  carTailMesh.instanceMatrix.needsUpdate = true;
}

// ── P5: 手配度＋パトカー ─────────────────────────────────────
// 犯罪(住人攻撃/捕食/車破壊)で上昇(目撃者=近くの住人がいると倍)、時間で減衰。
// 手配度1〜5に応じて police.glb が道路をA*追跡。赤青点滅灯＋WebAudio生成サイレン。
const WANTED_MAX = 5, WANTED_DECAY = 0.05, WITNESS_R = 35;
const POLICE_SPEED = 22, POLICE_REPATH = 3;
let wantedPts = 0, wantedCool = 0;
const police = [];
let policeTpl = null, policePending = 0;   // 非同期スポーンの多重発行防止
const wantedLevel = () => Math.min(WANTED_MAX, Math.floor(wantedPts));

function addWanted(base, pos) {
  let wit = false;   // 目撃者: 事件現場の近くに別の住人がいるか
  if (pos) for (const m of kens) {
    if (!m.dissolving && Math.hypot(m.pos.x - pos.x, m.pos.z - pos.z) < WITNESS_R) {
      wit = true;
      if (m.speech) m.speech.bark('witness');   // 目撃者が叫ぶ
      break;
    }
  }
  wantedPts = Math.min(WANTED_MAX + 0.9, wantedPts + base * (wit ? 2 : 1));
  wantedCool = 10;   // 10秒は減衰しない
}

async function ensurePoliceTpl() {
  if (policeTpl) return policeTpl;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(new URL('../models/car_GLB%20format/police.glb', location.href).href);
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  const grp = new THREE.Group(); grp.add(obj);
  policeTpl = { grp, scale: 4.8 / Math.max(size.x, size.z, 0.5) };
  return policeTpl;
}

async function spawnPolice() {
  const tpl = await ensurePoliceTpl();
  if (!activeEdges.length) return;
  let e = null;   // 150〜450m離れた道路からスポーン
  for (let t = 0; t < 30; t++) {
    const cand = activeEdges[(Math.random() * activeEdges.length) | 0];
    const d = Math.hypot(cand.a.x - player.pos.x, cand.a.z - player.pos.z);
    if (d > 150 && d < 450) { e = cand; break; }
  }
  if (!e) e = activeEdges[(Math.random() * activeEdges.length) | 0];
  const mesh = tpl.grp.clone(true);
  mesh.scale.setScalar(tpl.scale);
  mesh.position.copy(e.a);
  const mkLight = (color, x) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.position.set(x, 1.05, -0.1);
    mesh.add(s);
    return s;
  };
  const p = { mesh, node: e.aId, path: null, seg: 0, segT: 0, repathT: 0, lightR: mkLight(0xff2020, 0.35), lightB: mkLight(0x2040ff, -0.35), flashT: 0 };
  scene.add(mesh);
  police.push(p);
}
function removePolice() {
  const p = police.pop();
  if (p) scene.remove(p.mesh);
}

// WebAudio 2トーンサイレン（アセット不要）。手配中だけ鳴らし、最寄りパトカー距離で音量減衰
let sirenCtx = null, sirenOsc = null, sirenGain = null, sirenT = 0;
function updateSiren(dt, active, dist) {
  try {
    if (active && !sirenOsc) {
      sirenCtx = sirenCtx || new (window.AudioContext || window.webkitAudioContext)();
      sirenOsc = sirenCtx.createOscillator();
      sirenGain = sirenCtx.createGain();
      sirenOsc.type = 'triangle';
      sirenOsc.connect(sirenGain).connect(sirenCtx.destination);
      sirenGain.gain.value = 0;
      sirenOsc.start();
    }
    if (!active && sirenOsc) { sirenOsc.stop(); sirenOsc.disconnect(); sirenGain.disconnect(); sirenOsc = null; sirenGain = null; return; }
    if (sirenOsc) {
      sirenT += dt;
      sirenOsc.frequency.value = (sirenT % 1.2) < 0.6 ? 700 : 950;
      sirenGain.gain.value = Math.max(0, 1 - dist / 350) * 0.12;
    }
  } catch { /* オーディオ不可環境 */ }
}

function updateWanted(dt) {
  if (wantedCool > 0) wantedCool -= dt;
  else wantedPts = Math.max(0, wantedPts - WANTED_DECAY * dt);
  const lvl = wantedLevel();
  if (police.length + policePending < lvl) {   // 読込中を台数に含める（毎フレーム多重スポーン→即削除のチャーン防止）
    policePending++;
    spawnPolice().catch(() => { /* noop */ }).finally(() => { policePending--; });
  }
  while (police.length > lvl) removePolice();
  let nearest = Infinity;
  for (const p of police) {
    // 追跡: プレイヤー最寄りノードへ定期リパス。
    // 走行中の再計算は「今向かっている前方ノード」起点で予約し、到達時に切替（後方スナップで消えたように見える問題の修正）
    p.repathT -= dt;
    const atEnd = !p.path || p.seg >= p.path.length - 1;
    if (atEnd || p.repathT <= 0) {
      p.repathT = POLICE_REPATH;
      const target = nearestRoadNode(player.pos.x, player.pos.z);
      if (atEnd) {
        const path = astar(p.node, target);
        if (path && path.length > 1) { p.path = path; p.seg = 0; p.segT = 0; p.nextPath = null; }
      } else {
        const from = p.path[p.seg + 1];
        const path = astar(from, target);
        if (path && path.length > 1) p.nextPath = path;
      }
    }
    if (p.path && p.seg < p.path.length - 1) {
      let move = POLICE_SPEED * dt;
      while (move > 0 && p.seg < p.path.length - 1) {
        const n0 = roadNodes.get(p.path[p.seg]), n1 = roadNodes.get(p.path[p.seg + 1]);
        if (!n0 || !n1) { p.seg++; p.segT = 0; continue; }
        const len = n0.local.distanceTo(n1.local) || 1;
        const remain = (1 - p.segT) * len;
        if (move >= remain) {
          move -= remain; p.seg++; p.segT = 0; p.node = p.path[p.seg];
          if (p.nextPath && p.nextPath[0] === p.node) { p.path = p.nextPath; p.nextPath = null; p.seg = 0; }   // 前方ノードで新経路へ滑らかに切替
        } else { p.segT += move / len; move = 0; }
      }
      if (p.seg < p.path.length - 1) {
        const n0 = roadNodes.get(p.path[p.seg]).local, n1 = roadNodes.get(p.path[p.seg + 1]).local;
        p.mesh.position.lerpVectors(n0, n1, p.segT);
        const dx = n1.x - n0.x, dz = n1.z - n0.z;
        if (dx * dx + dz * dz > 1e-6) p.mesh.rotation.y = Math.atan2(dx, dz);
      }
    }
    // 赤青点滅
    p.flashT += dt;
    const on = (p.flashT * 4) % 2 < 1;
    p.lightR.visible = on;
    p.lightB.visible = !on;
    nearest = Math.min(nearest, p.mesh.position.distanceTo(player.pos));
  }
  updateSiren(dt, police.length > 0, nearest);
}

// ── 建物内装: 番地シードでその場生成（保存データゼロ）。玄関/窓マーカー（entry-editor）からEキーで出入り ──
let bldEntries = {};   // モデル相対パス -> マーカー配列（buildKenneyCity で読込）
const INTERIOR_ORIGIN = new THREE.Vector3(0, -320, 0);   // 内装ポケット（地形の遥か下＝街と干渉しない）
const ENTRY_RANGE = 6, PROMPT_SCAN_R = 40;
const FURN_DIR = '../models/kenney_furniture-kit/Models/GLTF format/';
const INTERIOR_SCALE = 1.5;   // 家具キットはVRM比で小さめ→内装全体を拡大
const furnCache = new Map();   // name -> {tpl,size}
let TILE_I = 1, FLOORT_I = 0, FLOORH_I = 2.6;
const interior = { active: false, group: null, ret: null, w: 0, d: 0, cz: 0, doorPos: new THREE.Vector3() };
let entryCandidate = null, entryPrompt = '', _entryT = 0;
const _emk = new THREE.Vector3();
const furnLoader = new GLTFLoader();

async function loadFurn(name) {
  if (furnCache.has(name)) return furnCache.get(name);
  const gltf = await furnLoader.loadAsync(new URL(FURN_DIR + encodeURIComponent(name) + '.glb', location.href).href);
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  obj.position.set(-c.x, -box.min.y, -c.z);
  const tpl = new THREE.Group(); tpl.add(obj);
  const e = { tpl, size };
  furnCache.set(name, e);
  return e;
}

// 建物の進入マーカー（無ければテンプレ正面中央の玄関を仮定）
function mdMarkers(md) {
  if (md.entries && md.entries.length) return md.entries;
  const bb = md.tpl.geometry.boundingBox;
  return [{ kind: 'door', pos: [(bb.min.x + bb.max.x) / 2, bb.min.y + 0.02, bb.max.z] }];
}

// 近傍の建物マーカーを走査してEキー候補を更新（0.25s毎）
function updateEntryPrompt(dt) {
  _entryT -= dt;
  if (_entryT > 0) return;
  _entryT = 0.25;
  if (interior.active) {
    entryPrompt = player.pos.distanceTo(interior.doorPos) < 3 ? '【E】外に出る' : '';
    return;
  }
  entryCandidate = null;
  let best = ENTRY_RANGE;
  for (const md of bldModels) {
    const markers = mdMarkers(md);
    for (const rec of md.recs) {
      if (rec.dead) continue;
      if (Math.abs(rec.x - player.pos.x) > PROMPT_SCAN_R || Math.abs(rec.z - player.pos.z) > PROMPT_SCAN_R) continue;
      for (const mk of markers) {
        _emk.fromArray(mk.pos).applyMatrix4(rec.m);
        const dist = _emk.distanceTo(player.pos);
        if (dist < best) { best = dist; entryCandidate = { md, rec, kind: mk.kind }; }
      }
    }
  }
  entryPrompt = entryCandidate ? `【E】${entryCandidate.kind === 'door' ? '玄関から入る' : '窓から入る'}` : '';
}

function onInteract() {
  if (interior.active) { if (player.pos.distanceTo(interior.doorPos) < 3) exitInterior(); return; }
  if (entryCandidate) enterBuilding(entryCandidate).catch((e) => showError('入室失敗: ' + (e?.message || e)));
}

async function enterBuilding(cand) {
  const t0 = performance.now();
  const rec = cand.rec;
  // 番地シード＝建物のワールド格子座標ハッシュ（保存データゼロで毎回同じ間取り）
  const seed = ((Math.round(rec.x) * 73856093) ^ (Math.round(rec.z) * 19349663) ^ 0x5bd1e995) >>> 0;
  const tier = rec.tier || 'house';
  const P = tier === 'tower' ? { w: 13, d: 10, floors: 2 } : tier === 'mid' ? { w: 11, d: 9, floors: 2 } : { w: 9, d: 8, floors: 1 };
  const layout = generateHouse({ ...P, seed, windowRate: 0.4 });
  const t1 = performance.now();
  // 基準寸法（床タイル・壁高）を実測してから一括スポーン
  const S = INTERIOR_SCALE;
  const floorE = await loadFurn('floorFull');
  TILE_I = (Math.max(floorE.size.x, floorE.size.z) || 1) * S;
  FLOORT_I = (floorE.size.y || 0) * S;
  FLOORH_I = (await loadFurn('wall')).size.y * S + FLOORT_I;
  const all = [...layout.shell, ...layout.items.filter((i) => !i.unit)];
  await Promise.all([...new Set(all.map((i) => i.model))].map((n) => loadFurn(n).catch(() => null)));   // モデル先読み
  const g = new THREE.Group();
  for (const it of all) {
    const e = furnCache.get(it.model);
    if (!e) continue;
    const m = e.tpl.clone(true);
    m.scale.setScalar(S);
    const isFloor = it.model.startsWith('floor');
    let y = (it.level || 0) * FLOORH_I + (isFloor ? 0 : FLOORT_I);
    if (it.stackOn && furnCache.has(it.stackOn)) y += furnCache.get(it.stackOn).size.y * S;
    m.position.set(it.x * TILE_I, y, it.z * TILE_I);
    m.rotation.y = it.ry || 0;
    g.add(m);
  }
  g.position.copy(INTERIOR_ORIGIN);
  scene.add(g);
  // 入場: 玄関（西端の廊下）へテレポ
  const cz = Math.max(3, Math.min(layout.d - 4, (layout.d / 2) | 0));
  interior.active = true; interior.group = g; interior.w = layout.w; interior.d = layout.d; interior.cz = cz;
  interior.floors = layout.floors || 1;
  interior.doorPos.set(INTERIOR_ORIGIN.x + 0.6 * TILE_I, INTERIOR_ORIGIN.y + FLOORT_I, INTERIOR_ORIGIN.z + cz * TILE_I);
  interior.ret = { pos: player.pos.clone(), vel: player.vel.clone(), yaw: player.yaw, camYaw, camPitch };
  player.pos.copy(interior.doorPos); player.pos.y += 0.05;
  player.vel.set(0, 0, 0);
  player.yaw = Math.PI / 2; camYaw = Math.PI / 2; camPitch = 0.1;   // 廊下の東（部屋側）を向く
  const t2 = performance.now();
  console.log(`interior: layout ${(t1 - t0).toFixed(1)}ms / spawn ${(t2 - t1).toFixed(1)}ms / seed ${seed}`);
  setStatus(`入室（生成 ${(t1 - t0).toFixed(1)}ms＋構築 ${(t2 - t1).toFixed(0)}ms）/ 玄関付近で【E】退出`);
}

function exitInterior() {
  if (interior.group) { scene.remove(interior.group); interior.group = null; }   // ジオメトリ/材質はキャッシュ共有なのでdisposeしない
  interior.active = false;
  const r = interior.ret;
  if (r) { player.pos.copy(r.pos); player.vel.copy(r.vel); player.yaw = r.yaw; camYaw = r.camYaw; camPitch = r.camPitch; }
  setStatus('外に出ました');
}

// 内装内の移動制限（部屋の中に収める・床で止める）
function interiorClamp() {
  const x0 = INTERIOR_ORIGIN.x - 0.4 * TILE_I, x1 = INTERIOR_ORIGIN.x + (interior.w - 0.6) * TILE_I;
  const z0 = INTERIOR_ORIGIN.z - 0.4 * TILE_I, z1 = INTERIOR_ORIGIN.z + (interior.d - 0.6) * TILE_I;
  const yLo = INTERIOR_ORIGIN.y + FLOORT_I, yHi = INTERIOR_ORIGIN.y + interior.floors * FLOORH_I - 0.3;
  if (player.pos.x < x0) { player.pos.x = x0; if (player.vel.x < 0) player.vel.x = 0; }
  if (player.pos.x > x1) { player.pos.x = x1; if (player.vel.x > 0) player.vel.x = 0; }
  if (player.pos.z < z0) { player.pos.z = z0; if (player.vel.z < 0) player.vel.z = 0; }
  if (player.pos.z > z1) { player.pos.z = z1; if (player.vel.z > 0) player.vel.z = 0; }
  if (player.pos.y < yLo) { player.pos.y = yLo; if (player.vel.y < 0) player.vel.y = 0; player.grounded = true; }
  if (player.pos.y > yHi) { player.pos.y = yHi; if (player.vel.y > 0) player.vel.y = 0; }
}

function tick() {
  const dt = Math.min(_clock.getDelta(), 1 / 30);
  updateFlight(dt);
  updatePlayerAnim(dt);
  updateCars(dt);
  updateCarPhysics(dt);
  updateAttacks(dt);      // コンボ窓＋貫通ビーム
  updateKens(dt);         // 地上NPC ken
  updatePredation(dt);    // 掴んだ ken の接地判定→捕食
  updateTotem(dt);        // トーテム（旋回・溶解・成長）
  updateImpactFx(dt);     // 着弾の炎＋煙
  updateEntryPrompt(dt);  // 建物進入のEキー候補
  updateDayNight(dt);     // 昼夜サイクル（空・光・ネオン）
  updateCarLights();      // 車のヘッド/テールライト（夜）
  updateAgents(dt);       // 生活エージェント（データ層＝通勤）
  updateAgentBodies(dt);  // 近傍の通勤者へ ken の身体を割当
  updateWanted(dt);       // 手配度＋パトカー追跡＋サイレン
  if (speechUI) speechUI.update(dt, kenScreenPos);   // 頭上セリフバブル
  if (KENNEY_CITY) updateDamage(dt);
  if (KENNEY_CITY && bldModels.length) { _lodT -= dt; if (_lodT <= 0) { _lodT = LOD_INTERVAL; partitionBuildings(); } }   // 建物LODの定期再振り分け
  updateCamera(dt);
  camera.updateMatrixWorld();
  if (tiles) {
    try { tiles.setResolutionFromRenderer(camera, renderer); tiles.update(); } catch (e) { showError('update失敗: ' + (e?.message || e)); tiles = null; }
  }
  if (++_dbg % 30 === 0) {
    const info = KENNEY_CITY
      ? `建物 ${cityInfo ? cityInfo.count : 0} (近${_lodNearCount}/遠${_lodFarCount})`
      : `タイル ${tiles && tiles.group ? tiles.group.children.length : -1}`;
    const clock = `${String(Math.floor(gameHour)).padStart(2, '0')}:${String(Math.floor((gameHour % 1) * 60)).padStart(2, '0')}`;
    const wanted = wantedLevel() > 0 ? ` / 手配${'★'.repeat(wantedLevel())}` : '';
    setStatus(`${clock}${timeScale > 1 ? `(x${timeScale})` : ''}${wanted} / 高度 ${Math.round(player.pos.y)}m / 速度上限 ${Math.round(flight.maxSpeed)} / ${info}${entryPrompt ? ' / ' + entryPrompt : ''}`);
  }
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

init().catch((e) => showError('初期化失敗: ' + (e?.message || e)));
