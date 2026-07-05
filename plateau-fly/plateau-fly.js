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
import { TilesRenderer } from 'https://esm.sh/3d-tiles-renderer@0.4.28?deps=three@0.184.0';
import { GLTFExtensionsPlugin, ImplicitTilingPlugin } from 'https://esm.sh/3d-tiles-renderer@0.4.28/plugins?deps=three@0.184.0';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import { generateBuildings } from '../lib/kenney-buildings.js';
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
const flight = { accel: 220, drag: 2.4, maxSpeed: 140, turn: 8 };   // 街スケールに合わせ高速化
const cam = { dist: 6, height: 1.4, follow: 8 };
const FADE = 0.18, DESCEND_SIN = 0.3;
const STATE_DEFS = {   // 飛行アニメ状態（各 timeline→VRMA）。tps-flight と同じ
  idle:      { tl: 'Joy_reborn_Fly_idle',   loop: true },
  fwd:       { tl: 'Joy_reborn_Fly_f',      loop: true },
  frontDown: { tl: 'Joy_reborn_front_down', loop: true },
  back:      { tl: 'Joy_reborn_Fly_back',   loop: true },
  left:      { tl: 'Joy_reborn_Fly_L',      loop: true },
  right:     { tl: 'Joy_reborn_Fly_R',      loop: true },
};
const player = { vrm: null, mixer: null, cloth: null, states: {}, current: null, ready: false, pos: new THREE.Vector3(0, 230, 150), vel: new THREE.Vector3(), yaw: Math.PI, fwdY: 0 };
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

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 30000);
  camera.position.set(0, 600, 600);

  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.7); sun.position.set(1, 2, 1.2); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbdd7ff, 0x4a4a40, 0.6));

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
  chain.catch((e) => showError('地面/道路/建物生成失敗: ' + (e?.message || e)));
  loadPlayer();   // TPSプレイヤー(Joy_reborn)
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
  if (fwd) { const ty = Math.atan2(_fwd.x, _fwd.z); player.yaw = lerpAngle(player.yaw, ty, Math.min(1, flight.turn * dt)); }
  player.vel.multiplyScalar(Math.exp(-flight.drag * dt));
  clampSpeed(player.vel, flight.maxSpeed);
  player.pos.addScaledVector(player.vel, dt);
  if (KENNEY_CITY) collidePlayer();   // 建物と衝突→押し出し・屋上着地
  groundCollide();                    // 地面(地形)に着地
  player.vrm.scene.position.copy(player.pos);
  player.vrm.scene.rotation.y = player.yaw + FACE_OFFSET;
}
function setState(name) {
  if (!player.states[name] || player.current === name) return;
  const prev = player.current ? player.states[player.current].action : null;
  const next = player.states[name];
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
  const fwd = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwd && player.fwdY < -DESCEND_SIN) return 'frontDown';
  if (fwd) return 'fwd';
  if (keysDown['KeyS'] || keysDown['ArrowDown']) return 'back';
  if (keysDown['KeyA'] || keysDown['ArrowLeft']) return 'left';
  if (keysDown['KeyD'] || keysDown['ArrowRight']) return 'right';
  return 'idle';
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
  setState(desiredState());
  player.mixer.update(dt);
  applyTrim();
  player.vrm.update(dt);
  const cst = player.states[player.current];
  const curFrame = cst ? Math.floor(cst.action.time * cst.fps) : 0;
  if (player.cloth && cst) player.cloth.update(dt, curFrame);
}
function updateCamera(dt) {
  if (!player.ready) return;
  camForwardRight();
  _desiredTarget.copy(player.pos); _desiredTarget.y += cam.height;
  _desiredPos.copy(_desiredTarget).addScaledVector(_fwd, -cam.dist);
  const k = 1 - Math.exp(-cam.follow * dt);
  camPosCur.lerp(_desiredPos, k); camTargetCur.lerp(_desiredTarget, k);
  camera.position.copy(camPosCur); camera.lookAt(camTargetCur);
}

// ── Phase B: 道路グラフ＋車走行（参照プロジェクトの OSM 道路 public/roads/*.json）──
const CAR_KIT = ['sedan', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'police', 'van', 'delivery', 'truck', 'hatchback-sports'].map((n) => 'car_GLB format/' + n + '.glb');
const CAR_COUNT = 40, CAR_RADIUS = 1600, CAR_SPEED = 12, CAR_FACE = 0;
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
  drawRoadLines();
  await spawnCars();
  console.log('roads center nodes', roadNodes.size, 'edges', activeEdges.length, 'cars', cars.length);
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
    const e = activeEdges[(Math.random() * activeEdges.length) | 0];
    const tpl = templates[i % templates.length];
    const mesh = tpl.grp.clone(true); mesh.scale.setScalar(tpl.scale); scene.add(mesh);
    const car = { mesh, aId: e.aId, bId: e.bId, t: Math.random(), speed: CAR_SPEED * (0.7 + Math.random() * 0.6), grabbed: false, thrown: false, dead: false };
    mesh.userData.car = car;   // レイキャストから車オブジェクトへ辿る（掴み用）
    cars.push(car);
  }
}
function repickCar(car) { const e = activeEdges[(Math.random() * activeEdges.length) | 0]; car.aId = e.aId; car.bId = e.bId; car.t = 0; }
function updateCars(dt) {
  if (!cars.length) return;
  for (const car of cars) {
    if (car.grabbed || car.thrown || car.dead) continue;   // 掴み/投擲/破壊中は道路走行しない
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
  cv.addEventListener('mousedown', (e) => { if (locked && e.button === 0) shoot(); });   // 左クリックでショット（命中建物を破壊）
  cv.addEventListener('contextmenu', (e) => e.preventDefault());                           // 右クリックメニュー抑止
  cv.addEventListener('mousedown', (e) => { if (locked && e.button === 2) grabCar(); });   // 右クリックで車を掴む
  cv.addEventListener('mouseup', (e) => { if (e.button === 2) throwCar(); });               // 離すと投擲
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === cv; });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    camYaw -= e.movementX * 0.0024; camPitch -= e.movementY * 0.0024;
    camPitch = Math.max(-1.25, Math.min(1.35, camPitch));
  });
  window.addEventListener('keydown', (e) => { keysDown[e.code] = true; });
  window.addEventListener('keyup', (e) => { keysDown[e.code] = false; });
  window.addEventListener('wheel', (e) => { flight.maxSpeed = Math.max(10, Math.min(2000, flight.maxSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); });
}

const _clock = new THREE.Clock();
let _dbg = 0;
// ── P1: Kenney 都市（PLATEAU タイルの代替。実道路網に建物を手続き配置＝巨大ステージ効率実験）──
const BLD_KIT_DIR = { city: 'city_GLB format/', suburban: 'kenney_city-kit-suburban_20/Models/GLB format/' };
let cityRoot = null;        // scene 直下の建物ルート（モデル単位の InstancedMesh 群）
let cityDamaged = null;     // 破壊で単体化した建物のルート（レイキャスト対象に含める）
let cityInfo = null;

async function buildKenneyCity() {
  if (!activeEdges.length) { console.warn('city: no road edges'); return; }
  // 活性エッジ(world XZ＋DEM Y)→ジェネレータ
  const edges = activeEdges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z]);
  const gen = generateBuildings(edges, { seed: 20260706 });
  cityInfo = { count: gen.instances.length, zones: gen.zones };
  console.log('city buildings', gen.instances.length, gen.zones);

  // 使用モデルの GLB を「1マージ済みジオメトリ＋共有マテリアル」に（InstancedMesh 用）
  const used = new Set(gen.instances.map((i) => i.kit + '|' + i.model));
  const templates = new Map();
  const loader = new GLTFLoader();
  await Promise.all([...used].map(async (key) => {
    const [kit, model] = key.split('|');
    const rel = (BLD_KIT_DIR[kit] + model + '.glb').split('/').map(encodeURIComponent).join('/');
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
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  for (const [k, insts] of byModel) {
    const tpl = templates.get(k);
    const kit = k.split('|')[0];
    if (!kitMat[kit] && tpl.material) kitMat[kit] = tpl.material;
    const foot = Math.max(tpl.size.x, tpl.size.z, 0.1);
    const mesh = new THREE.InstancedMesh(tpl.geometry, kitMat[kit] || tpl.material, insts.length);
    mesh.frustumCulled = false;   // 都市全体を1メッシュで常時描画
    mesh.userData.boxIdx = [];    // instanceId -> collBoxes index（破壊時に当たり判定を無効化）
    for (let i = 0; i < insts.length; i++) {
      const it = insts[i];
      const s = (TARGET_FOOT[it.tier] || 12) / foot * it.s;   // 実寸フットプリントへ正規化＋個体差
      _e.set(0, it.ry, 0); _q.setFromEuler(_e);
      _p.set(it.x, it.y - tpl.baseY * s, it.z);   // 底面を地面Yへ
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.userData.boxIdx[i] = addCollBox(it.x, it.z, it.y, it.y + tpl.size.y * s, foot * s * 0.5);   // 当たり判定箱（回転を包む正方近似）
    }
    mesh.instanceMatrix.needsUpdate = true;
    cityRoot.add(mesh);
  }
  // WebGPUパイプラインを事前コンパイル（初回描画のハングをローディング中へ前倒し）
  try { setStatus('都市を最適化中…'); if (renderer.compileAsync) await renderer.compileAsync(scene, camera); } catch (e) { console.warn('compileAsync', e); }
  console.log('city meshes', cityRoot.children.length, 'buildings', gen.instances.length, 'materials', Object.keys(kitMat).length);
}

// GLB シーンを「1つのマージ済みジオメトリ＋共有マテリアル」へ（位置/法線/UVのみ・変換ベイク・非index化で統一）
function bakeModel(root) {
  root.updateMatrixWorld(true);
  const geoms = [];
  let material = null;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g0 = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', g0.getAttribute('position').clone());
    if (g0.getAttribute('normal')) g.setAttribute('normal', g0.getAttribute('normal').clone());
    if (g0.getAttribute('uv')) g.setAttribute('uv', g0.getAttribute('uv').clone());
    g.applyMatrix4(o.matrixWorld);
    geoms.push(g);
    if (!material) material = Array.isArray(o.material) ? o.material[0] : o.material;
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

// ── P2: Joyのショット破壊（左クリック→命中建物を単体化し、命中点中心の球状ディソルブで大きく欠損。N発で崩壊）──
const CARVE_MAX = 6, CARVE_RADIUS = 7, HITS_TO_DESTROY = 5, SHOOT_RANGE = 450, DIE_DUR = 1.7;
const damaged = new Map();   // "meshUuid:instanceId" -> rec
const dyingList = [];        // 崩壊アニメ中の rec
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
  return { mat: nm, uCenters, uRadii, uKill, uKillOn, uBaseY };
}

function damageBuilding(instMesh, instanceId, point) {
  const key = instMesh.uuid + ':' + instanceId;
  if (damaged.has(key)) { applyCarve(damaged.get(key), point); return; }
  const m = new THREE.Matrix4(); instMesh.getMatrixAt(instanceId, m);
  if (!instMesh.geometry.boundingBox) instMesh.geometry.computeBoundingBox();
  const gb = instMesh.geometry.boundingBox;
  const _p2 = new THREE.Vector3(), _q2 = new THREE.Quaternion(), _s2 = new THREE.Vector3();
  m.decompose(_p2, _q2, _s2);
  const baseY = _p2.y + gb.min.y * _s2.y, height = (gb.max.y - gb.min.y) * _s2.y;   // ワールドの底Y/高さ（Y回転のみなので不変）
  const cm = makeCarveMaterial(instMesh.material, baseY, height);
  const std = new THREE.Mesh(instMesh.geometry, cm.mat);
  std.matrixAutoUpdate = false; std.matrix.copy(m); std.matrixWorldNeedsUpdate = true;
  cityDamaged.add(std);
  const hideM = new THREE.Matrix4().makeScale(0, 0, 0); hideM.setPosition(0, -1e6, 0);
  instMesh.setMatrixAt(instanceId, hideM); instMesh.instanceMatrix.needsUpdate = true;   // 元インスタンスを隠す
  const rec = { std, baseMatrix: m.clone(), uCenters: cm.uCenters, uRadii: cm.uRadii, uKill: cm.uKill, uKillOn: cm.uKillOn, uBaseY: cm.uBaseY, baseY0: baseY, height, hits: 0, key, boxIdx: (instMesh.userData.boxIdx || [])[instanceId], dying: false, dieT: 0 };
  std.userData.rec = rec;
  damaged.set(key, rec);
  applyCarve(rec, point);
}
function applyCarve(rec, point) {   // 命中点にカーブ球を1つ追加。規定発数で崩壊へ
  if (rec.dying) return;
  const i = Math.min(rec.hits, CARVE_MAX - 1);
  rec.uCenters[i].value.copy(point);
  rec.uRadii[i].value = CARVE_RADIUS * (0.9 + Math.random() * 0.35);
  rec.hits++;
  if (rec.hits >= HITS_TO_DESTROY) {   // 崩壊開始＋当たり判定を無効化
    rec.dying = true; rec.dieT = 0; dyingList.push(rec);
    if (rec.boxIdx != null && collBoxes[rec.boxIdx]) { const b = collBoxes[rec.boxIdx]; b.top = b.bottom = -1e9; }
  }
}

function shoot() {
  if (!player.ready || !cityRoot) return;
  camera.getWorldDirection(_camDir);
  camera.getWorldPosition(_muzzle);
  _shootRay.set(_muzzle, _camDir); _shootRay.far = SHOOT_RANGE;
  const hit = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true)[0];
  const end = hit ? hit.point : _muzzle.clone().addScaledVector(_camDir, SHOOT_RANGE);
  spawnBeam(_vk.set(player.pos.x, player.pos.y + 1.2, player.pos.z), end, !!hit);   // 胸元から発射（見た目）
  if (hit) {
    if (hit.object.isInstancedMesh && hit.instanceId != null) damageBuilding(hit.object, hit.instanceId, hit.point);   // 初弾＝単体化
    else if (hit.object.userData && hit.object.userData.rec) applyCarve(hit.object.userData.rec, hit.point);           // 追撃
  }
}

function spawnBeam(from, to, impact) {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]), new THREE.LineBasicMaterial({ color: 0xffb040, transparent: true }));
  scene.add(line); shotFx.push({ obj: line, t: 0, dur: 0.09, kind: 'beam' });
  if (impact) {
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true }));
    flash.position.copy(to); scene.add(flash); shotFx.push({ obj: flash, t: 0, dur: 0.2, kind: 'flash' });
  }
}

function updateDamage(dt) {
  for (let k = dyingList.length - 1; k >= 0; k--) {   // 崩壊: サイズそのままで地面へゆっくり沈む＋上から溶ける（旧ディソルブ風）
    const rec = dyingList[k]; rec.dieT += dt;
    const t = rec.dieT / DIE_DUR;
    rec.uKillOn.value = 1;
    rec.uKill.value = t * 1.2;                                    // 上→下の溶解を進める
    const sink = rec.height * 0.9 * t;                           // 地面へ沈み込む量
    rec.std.matrix.copy(rec.baseMatrix); rec.std.matrix.elements[13] -= sink;   // Y平行移動で沈める（縮めない）
    rec.std.matrixWorldNeedsUpdate = true;
    rec.uBaseY.value = rec.baseY0 - sink;                        // 溶解の高さ基準も一緒に沈める
    if (rec.dieT > DIE_DUR) { if (rec.std.parent) rec.std.parent.remove(rec.std); if (rec.std.material.dispose) rec.std.material.dispose(); damaged.delete(rec.key); dyingList.splice(k, 1); }
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

function grabCar() {
  if (grabbedCar || !cars.length) return;
  camera.getWorldDirection(_camDir); camera.getWorldPosition(_muzzle);
  _grabRay.set(_muzzle, _camDir); _grabRay.far = GRAB_RANGE;
  const meshes = cars.filter((c) => !c.grabbed && !c.thrown && !c.dead).map((c) => c.mesh);
  const hit = _grabRay.intersectObjects(meshes, true)[0];
  let car = null;
  if (hit) { let o = hit.object; while (o && !o.userData.car) o = o.parent; if (o) car = o.userData.car; }
  if (!car) {   // 照準に無ければ前方近傍の最寄り車
    _tmpV.copy(_muzzle).addScaledVector(_camDir, HOLD_DIST + 8);
    let best = GRAB_RANGE;
    for (const c of cars) { if (c.grabbed || c.thrown || c.dead) continue; const d = c.mesh.position.distanceTo(_tmpV); if (d < best) { best = d; car = c; } }
  }
  if (car) { car.grabbed = true; grabbedCar = car; }
}

function throwCar() {
  if (!grabbedCar) return;
  const car = grabbedCar; grabbedCar = null;
  car.grabbed = false; car.thrown = true; car.thrownT = 0;
  camera.getWorldDirection(_camDir);
  car.vel = new THREE.Vector3().copy(_camDir).multiplyScalar(THROW_SPEED).add(player.vel);
  car.angVel = new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
  thrownCars.push(car);
}

function updateGrab(dt) {
  if (!grabbedCar) return;
  camera.getWorldDirection(_camDir);
  _hold.copy(player.pos).addScaledVector(_camDir, HOLD_DIST); _hold.y += 0.5;
  grabbedCar.mesh.position.lerp(_hold, Math.min(1, 12 * dt));
  grabbedCar.mesh.rotation.y += dt * 2.2;   // 掲げてゆっくり回す
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
      const e = activeEdges[(Math.random() * activeEdges.length) | 0];
      r.car.aId = e.aId; r.car.bId = e.bId; r.car.t = Math.random();
      r.car.dead = false; r.car.grabbed = false; r.car.thrown = false;
      r.car.mesh.rotation.set(0, 0, 0); r.car.mesh.visible = true;
      respawnCars.splice(k, 1);
    }
  }
}

function tick() {
  const dt = Math.min(_clock.getDelta(), 1 / 30);
  updateFlight(dt);
  updatePlayerAnim(dt);
  updateCars(dt);
  updateCarPhysics(dt);
  if (KENNEY_CITY) updateDamage(dt);
  updateCamera(dt);
  camera.updateMatrixWorld();
  if (tiles) {
    try { tiles.setResolutionFromRenderer(camera, renderer); tiles.update(); } catch (e) { showError('update失敗: ' + (e?.message || e)); tiles = null; }
  }
  if (++_dbg % 30 === 0) {
    const info = KENNEY_CITY
      ? `建物 ${cityInfo ? cityInfo.count : 0} / メッシュ ${cityRoot ? cityRoot.children.length : 0}`
      : `タイル ${tiles && tiles.group ? tiles.group.children.length : -1}`;
    setStatus(`高度 ${Math.round(player.pos.y)}m / 速度上限 ${Math.round(flight.maxSpeed)} / ${info}`);
  }
  renderer.render(scene, camera);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

init().catch((e) => showError('初期化失敗: ' + (e?.message || e)));
