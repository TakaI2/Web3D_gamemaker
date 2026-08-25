// city-fly.js — 手続き生成都市（実道路網＋Kenney建物）を three.js で自由飛行するゲーム。
// 既定は八王子原点: OSM道路網＋地理院タイル(航空写真/DEM)の地面に建物を手続き配置。
// ?map=<名前> で map-editor 製の自作地形マップに置換。
// tps-flight 風のスペクテイター飛行で上空〜街中を移動。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMCloth } from '../lib/vrm-cloth.js';
import { createCityflyMp } from '../lib/cityfly-mp.js';
import { createMeshFx } from '../lib/fx-mesh.js';
import { createBeamFx } from '../lib/fx-beam.js';
import { createTornado } from '../lib/fx-tornado.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';
import { createDissolve } from '../lib/fx-dissolve.js';
import { createScenario2D } from '../lib/scenario2d.js';
import { createLipSync } from '../lib/lip-sync.js';
import { registerCustomExpressions, resetEmotionExpressions } from '../lib/vrm-expressions.js';
import { createFlow } from '../lib/flow-runner.js';
import { createRagdoll, setRagdollActive, updateRagdoll, updateRagdollRecovery, applyRagdollImpulse, disposeRagdoll } from '../lib/vrm-ragdoll.js';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import { generateBuildings, instanceId } from '../lib/kenney-buildings.js';
import { generateHouse } from '../lib/room-gen.js';
import { deserializeTerrain, createTerrainMesh, buildRoadGraph, sampleRoadPoints, unb64 } from '../lib/terrain.js';
import { createNpcSpeech } from '../lib/npc-speech.js';
import { createSpeechUI } from '../lib/speech-ui.js';
import { fetchSpeechSet, buildSpeechCharacter } from '../lib/speech-set.js';
import { uniform, color, float, positionWorld, mx_noise_float, clamp, texture, uv, mix, frontFacing } from 'https://esm.sh/three@0.184.0/tsl';

let renderer, scene, camera, pivot, groundGroup;
const keysDown = {};
let locked = false, recentered = false;
// TPS プレイヤー（tps-flight から移植・WebGL）
const KENNEY_CITY = true;   // 実道路網に Kenney 建物を手続き配置（破壊・都市ゲームの土台）
const PLAYER_NPC = 'nei_v2.npc.json';
const FACE_OFFSET = Math.PI;   // Joy_reborn は正面が逆焼き→180°補正
const flight = { accel: 32, drag: 2.4, maxSpeed: 9, turn: 8 };   // TPS-Flight と同じ操作感（ホイールで増速可）
const cam = { dist: 4.0, height: 1.2, follow: 8, side: 0.75 };   // side=肩越しオフセット(m)。プレイヤーを画面中心よりやや左へ＝クロスヘア/エフェクトが見やすい
const FADE = 0.18, DESCEND_SIN = 0.3;
const STATE_DEFS = {   // 飛行アニメ状態（各 timeline→VRMA）。tps-flight と同じ
  idle:      { tl: 'Joy_reborn_Fly_idle',   loop: true },
  groggy:    { tl: 'Joy_reborn_groggy',     loop: true },    // 低HP時の静止（GROGGY_HP以下）
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
  drain0:    { tl: 'Joy_reborn_drain_0',    loop: false },   // アルティメット導入（一度だけ）
  drain1:    { tl: 'Joy_reborn_drain_1',    loop: true },    // アルティメット中ループ
};
// 夜間キャラ補助光: プレイヤーVRMに追従する前後2灯のPointLight（距離減衰つき＝街をほぼ照らさない）。
// 強さ/色は anim-editor の「キャラライト」パネルと同一構成→ npc/char-light.json で共有
const charFill = { key: null, rim: null };
let charLightCfg = { dirI: 1.9, ambI: 0.85, dirC: '#cfd8ff', ambC: '#b8c4dd' };
async function loadCharLight() {
  try { charLightCfg = { ...charLightCfg, ...(await (await fetch('../npc/char-light.json')).json()) }; }
  catch { /* 未保存=既定値 */ }
  if (charFill.key) charFill.key.color.set(charLightCfg.dirC);
}
function attachCharFill(root) {   // プレイヤーVRM読込時に呼ぶ（子として追従）
  // 正面キー光のみ（負荷対策で背面の回り込み光は廃止。マントの質感を昼夜問わず持ち上げる）
  charFill.key = new THREE.PointLight(charLightCfg.dirC, charLightCfg.dirI, 7, 1.2);
  charFill.key.position.set(0.35, 1.7, 0.7);    // 前上（キー光）
  root.add(charFill.key);
}
const player = {
  vrm: null, mixer: null, cloth: null, states: {}, current: null, ready: false, faceOffset: Math.PI,
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
  // powerPreference: 既定だとブラウザが省電力＝内蔵GPU(Intel)を選ぶことがある。明示して外付けGPU(GeForce等)を要求する。
  renderer = new THREE.WebGPURenderer({
    antialias: !NO_AA,
    powerPreference: LOW_POWER ? 'low-power' : 'high-performance',
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },   // マント(GPUクロス)に必要
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, DPR_CAP || (LOW ? 1 : 2)));   // ?dpr=1 / ?low=1 で等倍（塗り面積↓）
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  await renderer.init();
  await collectGpuInfo();   // 診断: 実際に使われている GPU（ソフトウェアフォールバックだと極端に遅い）
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
  loadCharLight();   // 保存済みのキャラライト設定（ライト本体はプレイヤーVRM読込時に生成して追従）
  // TPS Flightと同じ画づくり: Neutralトーンマップ＋HDR環境マップ（マント等の光沢。強度は昼夜連動）
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  if (!NO_ENV) {   // IBL（全PBR材質が毎ピクセル環境光サンプル）。弱GPUでは重い→?noenv/?low で無効
    new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
      .then((hdr) => { hdr.mapping = THREE.EquirectangularReflectionMapping; scene.environment = hdr; })
      .catch((e) => console.warn('HDR環境マップ読込失敗:', e));
  }
  initSunMoon();   // 太陽と月のディスク（日周に追従）
  if (!NO_SKY) {   // procedural大気散乱シェーダ（フルスクリーン）→?nosky/?low では背景色のみ
    initSky();   // WebGPU用 SkyMesh（読めなければ背景色レルプにフォールバック）
    try { buildClouds(); } catch (e) { console.warn('雲生成失敗', e); }
  }

  // ECEF→ローカルENU変換のピボット（OSM道路の経緯度→ローカル座標化に使用）
  pivot = new THREE.Group(); pivot.matrixAutoUpdate = false; scene.add(pivot);

  recenterToHachioji();   // 固定原点で即時再中心化
  groundGroup = new THREE.Group(); scene.add(groundGroup);
  // map-editor 製 .map.json の自作地形マップ（?map=<name>、既定 mytown）
  let chain = buildMapGround().catch((e) => showError('マップ読込失敗: ' + (e?.message || e)));
  chain = chain.then(() => loadRoads());
  if (KENNEY_CITY) chain = chain.then(() => buildKenneyCity());   // 実道路網に Kenney 建物を配置
  chain = chain.then(() => buildParks().catch((e) => console.warn('公園生成失敗', e)));   // 閉じスプラインの公園
  chain = chain.then(() => buildForest().catch((e) => console.warn('森生成失敗', e)));   // 空き地の森（建物確定後）
  chain = chain.then(() => {   // 世界完成後: 着弾FX・トーテム・地上NPC(ken)・生活エージェント
    try { warmEnemyMats(); } catch (e) { console.warn('敵材質ウォーム失敗:', e); }
    loadImpactFx().catch((e) => console.warn('着弾FX準備失敗:', e));
    ensureTotemFx().catch((e) => console.warn('トーテムFX準備失敗:', e));
    try { initDebrisFx(); } catch (e) { console.warn('破片FX準備失敗:', e); }
    try { initUltFx(); } catch (e) { console.warn('アルティメットFX準備失敗:', e); }
    if (!NO_NPC) {   // 性能切り分け: ?nonpc=1 で住民NPCと生活エージェントを出さない
      prepareKenAssets().then((ok) => { if (ok) setKenCount(KEN_COUNT); }).catch((e) => console.warn('ken準備失敗:', e));
      loadAgentOverrides().then(() => { try { initAgents(); } catch (e) { console.warn('agents初期化失敗:', e); } });
    }
  });
  chain.catch((e) => showError('地面/道路/建物生成失敗: ' + (e?.message || e)));
  loadPlayer().then(() => prepareBiteAssets()).catch((e) => console.warn('bite準備失敗:', e));   // TPSプレイヤー→捕食アセット
  try {
    // マルチプレイはMP専用ビルド(window.MP_BUILD)か ?mp=1 のときだけ有効化（通常のCityFlyはシングル専用のまま）
    const mpAvailable = MP_ON || !!window.MP_BUILD;
    if (mpAvailable) {
      setupMpLoginUI();
      const ob = $('mp-open-btn');
      if (ob) ob.style.display = '';
      if (MP_NAME_PARAM) initMultiplayer();   // ?name= 付きなら即参加
      else mpShowLogin();                     // それ以外はログイン画面を開く
    }
  } catch (e) { console.warn('マルチプレイ初期化失敗:', e); }
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
  pivot.updateMatrixWorld(true);
  recentered = true;
  console.log('recentered to Hachioji; ECEF origin=', c.toArray().map((v) => Math.round(v)));
}

// ── マップモード（map-editor製 .map.json の地形。既定 mytown＝my-city ステージ）──
const MAP_NAME = new URLSearchParams(location.search).get('map') || window.DEFAULT_MAP || 'mytown';   // dist はビルド時に window.DEFAULT_MAP を注入
// 性能切り分け用スイッチ。?diag=1 で GPU名/drawCall/三角数まで表示。
//   ?nocape=1 マント無効 / ?nocity=1 建物無効 / ?nonpc=1 NPC(ken)と車を無効 / ?dpr=1 解像度を下げる
const _qs = new URLSearchParams(location.search);
const NO_CAPE = _qs.get('nocape') === '1';
const NO_PORTRAIT = _qs.get('noportrait') === '1';   // 会話ウィンドウの立体ポートレートを無効化（負荷比較用）
const NO_CITY = _qs.get('nocity') === '1';
const NO_NPC = _qs.get('nonpc') === '1';
const DIAG = _qs.get('diag') === '1';
const DPR_CAP = parseFloat(_qs.get('dpr') || '') || 0;   // 例 ?dpr=1 で等倍（GPU負荷を大きく下げる）
// 低スペック向け: ?low=1 で MSAA/環境マップ(IBL)/空シェーダ/雲 をまとめて切り、DPR も 1 に。
// 個別に切って原因を特定したい場合は ?noaa=1 / ?noenv=1 / ?nosky=1 も使える。
const LOW = _qs.get('low') === '1';
const LOW_POWER = _qs.get('lowpower') === '1';   // 検証用: あえて内蔵GPUを要求して差を見る
const NO_AA = LOW || _qs.get('noaa') === '1';
const NO_ENV = LOW || _qs.get('noenv') === '1';
const NO_SKY = LOW || _qs.get('nosky') === '1';
const SHOW_FPS = _qs.get('fps') === '1' || NO_CAPE || NO_CITY || NO_NPC || DIAG || LOW;
let mapTerrain = null;   // createTerrainMesh の戻り値（heightAt含む）
let mapRoads = [];       // .map.json のスプライン道路（あればOSMの代わりに使う）
let mapBridges = [];     // .map.json の橋 {x,z,dx,dz,len,w,kind:'flat'|'arch',deckY,wl,bedY}（道路ノードをデッキ高へ持ち上げ＋簡易モデル描画）
let mapRails = [];       // .map.json の鉄道 [{points:[[x,z,y]..], gauge, stations:[{x,z,name}]}]（複線＋高架＋駅＋列車運行）
let mapPort = null;      // .map.json の埠頭 {rect:[x0,z0,x1,z1], h, containers:[{x0,x1,z}], ship:{x,z,len}}
let mapBldParams = null; // .map.json buildings.params（自動配置のオプション上書き。例: spacing）
let mapBuildings = null; // .map.json の建物差分 {removed[], moved{}, added[]}
let mapWater = [];       // .map.json の水面矩形 {x,z,w,d,level}
let mapForest = null;    // .map.json の植生ペイント {cell,res,data:Uint8Array 密度0-255}（map-editorで描く）
let mapParks = [];       // .map.json の公園 {points:[[x,z]...], fountain:'round'|'square'}（閉じスプライン）
let mapParkCfg = {};     // .map.json の公園設定 {hedgeOvr}（map-editorのスライダ）
const waterMeshes = [];
let waterNearMat = null, waterFarMat = null, _waterLodT = 0;
const WATER_FAR = 600;   // これ以上離れた水面は静的マテリアルへ（LOD）
function buildMapWater() {
  // 法線マップをcanvasで生成（アセット不要・柔らかいノイズ）
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 128, y = Math.random() * 128, r = 3 + Math.random() * 9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dx = (Math.random() * 44 - 22) | 0, dy = (Math.random() * 44 - 22) | 0;
    g.addColorStop(0, `rgba(${128 + dx},${128 + dy},255,0.5)`);
    g.addColorStop(1, 'rgba(128,128,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  waterNearMat = new THREE.MeshStandardMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.82, roughness: 0.12, metalness: 0.55, normalMap: tex, normalScale: new THREE.Vector2(0.4, 0.4), depthWrite: false });
  waterFarMat = new THREE.MeshStandardMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.8, roughness: 0.35, metalness: 0.3, depthWrite: false });
  for (const w of mapWater) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), waterNearMat);
    mesh.position.set(w.x, w.level ?? 0, w.z);
    mesh.scale.set(w.w || 100, 1, w.d || 100);
    const rep = Math.max(2, Math.round((w.w || 100) / 30));
    mesh.userData.rep = rep;   // 大きい水面ほど法線を細かく繰り返す
    scene.add(mesh);
    waterMeshes.push(mesh);
  }
  if (waterMeshes.length) tex.repeat.set(waterMeshes[0].userData.rep, waterMeshes[0].userData.rep);
  // 遠距離マテリアルのパイプラインも起動時にコンパイルさせる（切替ヒッチ防止）
  const pre = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), waterFarMat);
  pre.position.set(0, -800, 0);
  scene.add(pre);
  console.log('water planes:', waterMeshes.length);
}
function updateWater(dt) {
  if (!waterMeshes.length) return;
  if (waterNearMat?.normalMap) {   // ゆっくり流れる法線＝波のきらめき
    waterNearMat.normalMap.offset.x += dt * 0.012;
    waterNearMat.normalMap.offset.y += dt * 0.008;
  }
  _waterLodT -= dt;
  if (_waterLodT > 0) return;
  _waterLodT = 0.5;
  for (const m of waterMeshes) {
    const far = Math.hypot(m.position.x - player.pos.x, m.position.z - player.pos.z) - Math.max(m.scale.x, m.scale.z) / 2 > WATER_FAR;
    const want = far ? waterFarMat : waterNearMat;
    if (m.material !== want) m.material = want;
  }
}
async function buildMapGround() {
  const res = await fetch('../maps/' + encodeURIComponent(MAP_NAME) + '.map.json');
  if (!res.ok) throw new Error('maps/' + MAP_NAME + '.map.json が見つかりません');
  const j = await res.json();
  mapTerrain = createTerrainMesh(THREE, deserializeTerrain(j.terrain));
  groundGroup.add(mapTerrain.group);
  mapRoads = Array.isArray(j.roads) ? j.roads.filter((r) => r.points && r.points.length >= 2) : [];
  mapBuildings = (j.buildings && ((j.buildings.removed || []).length || (j.buildings.added || []).length || Object.keys(j.buildings.moved || {}).length)) ? j.buildings : null;
  mapWater = Array.isArray(j.water) ? j.water : [];
  mapBridges = Array.isArray(j.bridges) ? j.bridges : [];
  mapRails = Array.isArray(j.rails) ? j.rails : [];
  mapPort = j.port || null;
  mapBldParams = (j.buildings && j.buildings.params) || null;
  mapForest = (j.forest && j.forest.data) ? { cell: j.forest.cell || 16, res: j.forest.res, yOff: j.forest.yOff ?? 0, model: j.forest.model || null, treeH: j.forest.treeH || 7, data: unb64(j.forest.data) } : null;
  mapParks = Array.isArray(j.parks) ? j.parks.filter((pk) => pk.points && pk.points.length >= 3) : [];
  mapParkCfg = j.parkCfg || {};
  if (mapWater.length) try { buildMapWater(); } catch (e) { console.warn('水面生成失敗', e); }
  // 表記を実際の使用データに合わせて動的に書き換え
  const a = $('attrib');
  if (a) {
    const parts = [];
    if (j.terrain?.attribution) parts.push('地形標高: 地理院タイル/国土地理院');
    if (!mapRoads.length || j.osmRoads) parts.push('道路データ: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL)');   // スプライン未保存＝OSMフォールバック
    if (parts.length) a.innerHTML = parts.join('｜ ');
    else a.style.display = 'none';
  }
  console.log('map:', MAP_NAME, mapTerrain.data.size + 'm / res', mapTerrain.data.res, '/ roads', mapRoads.length);
}

function llaToLocal(latDeg, lonDeg, h) { return lla2ecef(latDeg, lonDeg, h).applyMatrix4(pivot.matrix); }   // ECEF→ローカルENU

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

// ── マルチプレイ（?mp=1 で参戦。開発サーバ同居のWSリレー /cityfly-mp）────────────
// 同期: 位置/向き15Hz＋射撃/命中イベント。命中判定は撃った側（リレーの単純さ優先＝LAN対戦想定）。
const _mpQ = new URLSearchParams(location.search);
const MP_ON = _mpQ.get('mp') === '1';                    // ?mp=1 = 起動時に参加（name無しならログイン画面）
const MP_NAME_PARAM = (_mpQ.get('name') || '').slice(0, 16);
let MP_NAME = MP_NAME_PARAM || localStorage.getItem('cityfly-mp-name') || '';
let MP_ROOM = (_mpQ.get('room') || localStorage.getItem('cityfly-mp-room') || 'lobby').trim().slice(0, 24) || 'lobby';
const MP_SEND_HZ = 15, MP_LERP_DELAY = 0.12;   // 送信頻度と補間遅延（この分だけ過去を描く＝カクつかない）
const MP_DMG = { beam: 15, super: 40, large: 6, ult: 30 };
let mp = null, mpSendAcc = 0, mpMyHp = 100, mpKills = 0, mpInvulnT = 0, mpRenderingRemote = false;
const mpAvatars = new Map();   // id -> { id, name, group, vrm, mixer, snaps, yaw, hp }
let mpBundleP = null;          // プレイヤーVRMバンドルの共有fetch
const _mpV1 = new THREE.Vector3(), _mpV2 = new THREE.Vector3(), _mpV3 = new THREE.Vector3();

function mpHud(msg) {
  const feed = $('mp-feed');
  if (!feed) return;
  const div = document.createElement('div');
  div.textContent = msg;
  feed.prepend(div);
  while (feed.children.length > 5) feed.lastChild.remove();
  setTimeout(() => { if (div.parentNode) div.remove(); }, 7000);
}
function mpHudCount() {
  const el = $('mp-count');
  if (el) el.textContent = `ルーム「${MP_ROOM}」: ${mpAvatars.size + 1}人`;
  const k = $('mp-kills');
  if (k) k.textContent = `撃墜: ${mpKills}`;
}
function mpHudHp() {
  const bar = $('mp-hp');
  if (!bar) return;
  bar.style.width = mpMyHp + '%';
  bar.style.background = mpMyHp > 50 ? '#5f6' : mpMyHp > 25 ? '#fc4' : '#f55';
}
function mpFlash() {
  const f = $('mp-flash');
  if (!f) return;
  f.style.opacity = '1';
  setTimeout(() => { f.style.opacity = '0'; }, 80);
}
function mpCenterOf(h, out) {
  out.copy(h.group.position);
  out.y += 1.0;
  return out;
}
async function mpSpawnAvatar(id, name, st) {
  if (mpAvatars.has(id)) return;
  const holder = { id, name, group: new THREE.Group(), vrm: null, mixer: null, snaps: [], yaw: 0, hp: 100 };
  mpAvatars.set(id, holder);
  scene.add(holder.group);
  if (st?.p) holder.group.position.set(st.p[0], st.p[1], st.p[2]);
  try {
    mpBundleP = mpBundleP || fetch('../npc/' + PLAYER_NPC).then((r) => r.json());
    const bundle = await mpBundleP;
    const loader = new GLTFLoader();
    loader.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
    const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
    if (!mpAvatars.has(id)) return;   // 読込中に退出
    const vrm = gltf.userData.vrm;
    holder.vrm = vrm;
    vrm.scene.rotation.y = FACE_OFFSET;
    holder.group.add(vrm.scene);
    holder.mixer = new THREE.AnimationMixer(vrm.scene);
    try {   // 飛行アイドルをループ再生
      const tl = await (await fetch('../timeline/Joy_reborn_Fly_idle.timeline.json')).json();
      const vres = await fetch('../vrma/' + encodeURIComponent(tl.vrma));
      const al = new GLTFLoader();
      al.register((pl) => new VRMAnimationLoaderPlugin(pl));
      const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
      const clip = createVRMAnimationClip(ag.userData.vrmAnimations[0], vrm);
      stripRootMotion(clip);
      holder.mixer.clipAction(clip).play();
    } catch (e) { console.warn('[mp] リモートアニメ読込失敗', e); }
    // 頭上ネーム
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const cx = cv.getContext('2d');
    cx.font = 'bold 34px system-ui';
    cx.textAlign = 'center';
    cx.strokeStyle = 'rgba(0,0,0,0.85)';
    cx.lineWidth = 6;
    cx.fillStyle = '#fff';
    cx.strokeText(name, 128, 44);
    cx.fillText(name, 128, 44);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }));
    sp.scale.set(1.7, 0.42, 1);
    sp.position.y = 2.15;
    sp.renderOrder = 20;
    holder.group.add(sp);
  } catch (e) { console.warn('[mp] リモートVRM読込失敗', e); }
}
function mpRemoveAvatar(id) {
  const h = mpAvatars.get(id);
  if (!h) return;
  mpAvatars.delete(id);
  scene.remove(h.group);
}
function mpTakeDamage(dmg, fromId) {
  if (mpInvulnT > 0) return;
  mpMyHp = Math.max(0, mpMyHp - dmg);
  mpHudHp();
  mpFlash();
  if (mpMyHp <= 0) {
    mp.sendDie(fromId);
    try { spawnImpactFx(_mpV1.set(player.pos.x, player.pos.y + 1, player.pos.z), 3); } catch { /* FX未準備 */ }
    player.pos.set((Math.random() - 0.5) * 400, 130 + Math.random() * 80, (Math.random() - 0.5) * 400);
    if (player.vel) player.vel.set(0, 0, 0);
    mpMyHp = 100;
    mpInvulnT = 2.5;
    mpHudHp();
    mpHud('撃墜された！リスポーン');
  } else {
    mp.sendHp(mpMyHp);
  }
}
// ── ログイン画面（🎮ボタン→名前入力→参加。参加前に現在人数を表示・満員なら参加不可）──
let mpStatusTimer = null;
async function mpPollStatus() {
  const el = $('mp-login-status'), btn = $('mp-login-join'), list = $('mp-login-rooms');
  if (!el) return;
  try {
    const st = await (await fetch('/cityfly-mp-status')).json();
    const roomName = (($('mp-login-room')?.value) || 'lobby').trim().slice(0, 24) || 'lobby';
    const n = st.rooms?.find((r) => r.name === roomName)?.players ?? 0;
    const full = n >= st.max;
    el.textContent = full
      ? `ルーム「${roomName}」は満員（${n}/${st.max}人）`
      : `ルーム「${roomName}」: 現在 ${n}/${st.max} 人`;
    el.style.color = full ? '#f88' : '#9fd0a0';
    if (btn) btn.disabled = full;
    if (list) {   // 稼働中ルーム一覧（クリックで入力欄へ）
      list.innerHTML = '';
      const rooms = (st.rooms || []).filter((r) => r.players > 0);
      if (rooms.length) {
        const lbl = document.createElement('span');
        lbl.textContent = '稼働中: ';
        lbl.style.color = '#889';
        list.appendChild(lbl);
        for (const r of rooms) {
          const a = document.createElement('span');
          a.textContent = `${r.name}(${r.players}/${st.max})`;
          a.style.cssText = 'color:#8fd0ff;cursor:pointer;margin-right:8px;text-decoration:underline;';
          a.onclick = () => { $('mp-login-room').value = r.name; mpPollStatus(); };
          list.appendChild(a);
        }
      }
    }
  } catch {
    el.textContent = 'サーバに接続できません（シングルプレイは可能）';
    el.style.color = '#f88';
    if (btn) btn.disabled = true;
  }
}
function mpShowLogin() {
  const ov = $('mp-login');
  if (!ov || mp) return;
  ov.style.display = 'flex';
  const rin = $('mp-login-room');
  if (rin) rin.value = MP_ROOM;
  const inp = $('mp-login-name');
  inp.value = MP_NAME;
  inp.focus();
  mpPollStatus();
  clearInterval(mpStatusTimer);
  mpStatusTimer = setInterval(mpPollStatus, 2000);
}
function mpHideLogin() {
  const ov = $('mp-login');
  if (ov) ov.style.display = 'none';
  clearInterval(mpStatusTimer);
  mpStatusTimer = null;
}
function mpJoinFromLogin() {
  const name = ($('mp-login-name')?.value || '').trim().slice(0, 16);
  if (!name) { const inp = $('mp-login-name'); inp.placeholder = '名前を入力してください'; inp.focus(); return; }
  MP_NAME = name;
  MP_ROOM = (($('mp-login-room')?.value) || 'lobby').trim().slice(0, 24) || 'lobby';
  localStorage.setItem('cityfly-mp-name', name);
  localStorage.setItem('cityfly-mp-room', MP_ROOM);
  mpHideLogin();
  initMultiplayer();
}
function setupMpLoginUI() {
  const btn = $('mp-open-btn');
  if (btn) btn.addEventListener('click', mpShowLogin);
  $('mp-login-join')?.addEventListener('click', mpJoinFromLogin);
  $('mp-login-cancel')?.addEventListener('click', mpHideLogin);
  $('mp-login-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') mpJoinFromLogin(); e.stopPropagation(); });
  $('mp-login-room')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') mpJoinFromLogin(); e.stopPropagation(); });
  $('mp-login-room')?.addEventListener('input', () => mpPollStatus());
}

function initMultiplayer() {
  if (mp) return;
  const openBtn = $('mp-open-btn');
  if (openBtn) openBtn.style.display = 'none';   // 参加後はボタン非表示
  const hud = $('mp-hud');
  if (hud) hud.style.display = '';
  mpHudHp();
  mpHudCount();
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/cityfly-mp';
  mp = createCityflyMp({ url: wsUrl, name: MP_NAME, room: MP_ROOM, handlers: {
    connect: () => { mpHud('サーバに接続しました'); mpHudCount(); },
    disconnect: () => mpHud('切断（再接続待ち…）'),
    join: (id, name, st) => { mpSpawnAvatar(id, name, st); mpHud(`${name} が参加`); mpHudCount(); },
    rename: (id, name) => { const h = mpAvatars.get(id); if (h) h.name = name; },
    leave: (id) => {
      const h = mpAvatars.get(id);
      if (h) mpHud(`${h.name} が退出`);
      mpRemoveAvatar(id);
      mpHudCount();
    },
    state: (id, m) => {
      const h = mpAvatars.get(id);
      if (!h || !m.p) return;
      h.snaps.push({ t: performance.now() / 1000, p: m.p, yaw: m.yaw ?? h.yaw });
      if (h.snaps.length > 30) h.snaps.shift();
    },
    shot: (id, m) => {   // リモートの射撃を描画（spawnBeamの再送ループはフラグで防止）
      if (!m.from || !m.to) return;
      mpRenderingRemote = true;
      try { spawnBeam(_mpV1.fromArray(m.from), _mpV2.fromArray(m.to), true, m.c ?? 0xffb040, !!m.thick); }
      finally { mpRenderingRemote = false; }
    },
    hit: (m) => { if (mp && m.target === mp.id) mpTakeDamage(m.dmg || 10, m.id); },
    hp: (id, hp) => { const h = mpAvatars.get(id); if (h) h.hp = hp; },
    die: (id, by) => {
      const h = mpAvatars.get(id);
      if (h) { try { spawnImpactFx(mpCenterOf(h, _mpV1), 3); } catch { /* noop */ } }
      const byName = (mp && by === mp.id) ? MP_NAME : (mpAvatars.get(by)?.name ?? '?');
      mpHud(`${h?.name ?? '?'} 撃墜 (by ${byName})`);
      if (mp && by === mp.id) { mpKills++; mpHudCount(); }
    },
    full: (max) => mpHud(`サーバ満員（${max}人上限）。空き待ちで再試行します…`),
  } });
}
function mpUpdate(dt) {
  if (!mp) return;
  mpInvulnT = Math.max(0, mpInvulnT - dt);
  mpSendAcc += dt;
  if (mpSendAcc >= 1 / MP_SEND_HZ && player.ready) {
    mpSendAcc = 0;
    mp.sendState({
      p: [+player.pos.x.toFixed(2), +player.pos.y.toFixed(2), +player.pos.z.toFixed(2)],
      yaw: +player.yaw.toFixed(3),
    });
  }
  // リモートの補間（MP_LERP_DELAYぶん過去のスナップショット間をlerp）
  const now = performance.now() / 1000 - MP_LERP_DELAY;
  for (const h of mpAvatars.values()) {
    const sn = h.snaps;
    if (!sn.length) continue;
    let i = sn.length - 1;
    while (i > 0 && sn[i - 1].t > now) i--;
    const a = sn[Math.max(0, i - 1)], b = sn[i];
    const span = Math.max(1e-3, b.t - a.t);
    const f = Math.max(0, Math.min(1, (now - a.t) / span));
    h.group.position.set(
      a.p[0] + (b.p[0] - a.p[0]) * f,
      a.p[1] + (b.p[1] - a.p[1]) * f,
      a.p[2] + (b.p[2] - a.p[2]) * f,
    );
    h.yaw = lerpAngle(a.yaw, b.yaw, f);
    h.group.rotation.y = h.yaw;
    if (h.vrm) h.vrm.update(dt);
    if (h.mixer) h.mixer.update(dt);
  }
}
function clampSpeed(v, max) { const s = v.length(); if (s > max) v.multiplyScalar(max / s); }

// ── プレイヤーキャラ選択（npc.json交換）──
const NPC_SEL_KEY = 'cityfly.playerNpc';
const REF_HEAD_H = 1.403;   // Joy_reborn の頭ボーン高さ(レスト時)＝身長正規化の基準(Joyがscale1.0になる値)
function npcSelection() { try { return localStorage.getItem(NPC_SEL_KEY) || 'file:' + PLAYER_NPC; } catch { return 'file:' + PLAYER_NPC; } }
function vrmUrlOf(bundle) { return bundle.vrm.startsWith('data:') ? URL.createObjectURL(dataURIToBlob(bundle.vrm)) : bundle.vrm; }
// 持ち込みVRMは IndexedDB（27MB級なので localStorage 不可）
function idbOpen() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('cityfly-npc', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('npc');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function idbPutNpc(name, bundle) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const tx = db.transaction('npc', 'readwrite'); tx.objectStore('npc').put(bundle, name); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbGetNpc(name) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const rq = db.transaction('npc').objectStore('npc').get(name); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error); });
}
async function idbDelNpc(name) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const tx = db.transaction('npc', 'readwrite'); tx.objectStore('npc').delete(name); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbListNpc() {
  const db = await idbOpen();
  return new Promise((res, rej) => { const rq = db.transaction('npc').objectStore('npc').getAllKeys(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); });
}
async function fetchSelectedBundle() {
  // キャラ交換機能は一旦停止中: 常に既定キャラ（nei_vamp）を読む。復活させる時はこの関数と setupCharUI() を戻す
  return await (await fetch('../npc/' + PLAYER_NPC)).json();
}
function disposePlayerModel() {
  if (!player.vrm) return;
  for (const st of Object.values(player.states)) {
    try { st.action?.stop(); } catch { /* noop */ }
    for (const ef of (st.effects || [])) { try { scene.remove(ef.fx.object3D); ef.fx.dispose?.(); } catch { /* noop */ } }
  }
  player.states = {}; player.current = null;
  try { player.mixer?.stopAllAction(); } catch { /* noop */ }
  player.mixer = null;
  try { player.cloth?.dispose?.(); } catch { /* noop */ }
  player.cloth = null;
  try { scene.remove(player.vrm.scene); } catch { /* noop */ }
  player.vrm = null; player.ready = false;
}
// ── プレイヤーHP＋ダメージ損耗（damage-editor の damage.json 準拠）──
const PLAYER_HP_MAX = 100;
const GROGGY_HP = 0.30;   // この割合以下の静止は groggy モーション
let playerHp = PLAYER_HP_MAX;
const dmgParts = [];   // [{id, kind, dis, range:[s,e]}]
let dmgExpressions = [];   // ダメージ連動表情 [{name, keys:[{at,value}]}]
function dmgExprValueAt(keys, dmg) {
  if (!keys?.length) return 0;
  const ks = [...keys].sort((a, b) => a.at - b.at);
  if (dmg <= ks[0].at) return ks[0].value;
  if (dmg >= ks[ks.length - 1].at) return ks[ks.length - 1].value;
  for (let i = 0; i < ks.length - 1; i++) {
    if (dmg <= ks[i + 1].at) {
      const t = (dmg - ks[i].at) / Math.max(0.001, ks[i + 1].at - ks[i].at);
      return ks[i].value + (ks[i + 1].value - ks[i].value) * t;
    }
  }
  return ks[ks.length - 1].value;
}
function buildClothDamageAttrs(clothData, geo) {   // damage-editor と同一: dmgPos=布ローカル座標 / dmgH=アンカー距離(1=根元,0=先端)
  const pos = clothData.positions;
  const n = clothData.vertexCount;
  const anchors = (clothData.anchorAssignments || []).map((a) => a.vertexIdx);
  // アンカー重心・軸ごとのアンカー広がり（広がる軸=幅方向は除外したい）
  const ac = [0, 0, 0], as = [0, 0, 0];
  for (const ai of anchors) for (let k = 0; k < 3; k++) ac[k] += pos[ai * 3 + k];
  for (let k = 0; k < 3; k++) ac[k] /= Math.max(1, anchors.length);
  for (const ai of anchors) for (let k = 0; k < 3; k++) as[k] = Math.max(as[k], Math.abs(pos[ai * 3 + k] - ac[k]));
  // 「アンカーから最も遠くへ伸びる軸」＝裾方向。距離ベースだと放射状（横からも溶ける）になるので軸射影にする
  let axis = 2, bestScore = -1, sign = 1;
  for (let k = 0; k < 3; k++) {
    let mx = 0, sg = 1;
    for (let i = 0; i < n; i++) { const d = pos[i * 3 + k] - ac[k]; if (Math.abs(d) > mx) { mx = Math.abs(d); sg = d >= 0 ? 1 : -1; } }
    const score = mx / (1 + as[k] * 4);
    if (score > bestScore) { bestScore = score; axis = k; sign = sg; }
  }
  const dmgH = new Float32Array(n);
  let tMax = 0.0001;
  for (let i = 0; i < n; i++) { const t = Math.max(0, (pos[i * 3 + axis] - ac[axis]) * sign); dmgH[i] = t; if (t > tMax) tMax = t; }
  for (let i = 0; i < n; i++) dmgH[i] = 1 - dmgH[i] / tMax;   // 1=根元(アンカー側) → 0=裾(先端)
  geo.setAttribute('dmgPos', new THREE.BufferAttribute(Float32Array.from(pos), 3));
  geo.setAttribute('dmgH', new THREE.BufferAttribute(dmgH, 1));
}
let hpBarEl = null;
let vigEl = null, vigA = 0, vigT = 0, dmgFlash = 0, vigLastO = '';
function updateDamageVignette(dt) {   // vamp-dungeon と同じ見た目の赤ビネット
  if (!vigEl) {
    vigEl = document.createElement('div');
    vigEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:15;opacity:0;'
      + 'background:radial-gradient(ellipse at center, rgba(150,0,25,0) 52%, rgba(150,0,25,0.42) 82%, rgba(120,0,20,0.72) 100%);';
    document.body.appendChild(vigEl);
  }
  vigT += dt;
  dmgFlash = Math.max(0, dmgFlash - dt * 1.8);
  const hpRatio = playerHp / PLAYER_HP_MAX;
  const low = hpRatio < 0.35 ? (0.32 * (1 - hpRatio / 0.35) + Math.sin(vigT * 5.2) * 0.06 * (1 - hpRatio / 0.35)) : 0;   // 低HP=常時うっすら+脈動
  const target = Math.min(1, Math.max(dmgFlash, low));
  vigA += (target - vigA) * Math.min(1, dt * 8);
  if (vigA < 0.003 && target <= 0) vigA = 0;   // 無被弾時は完全に0へスナップ
  const o = Math.max(0, Math.min(1, vigA)).toFixed(3);
  if (o !== vigLastO) { vigEl.style.opacity = o; vigLastO = o; }   // 値が変わる時だけDOMへ書く
}
let hpNumEl = null;
function updateHpUI() {
  if (!hpBarEl) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;left:12px;top:52px;z-index:20;pointer-events:none;display:flex;align-items:center;gap:8px;';
    const label = document.createElement('div');
    label.textContent = 'HP';
    label.style.cssText = "color:#cfe;font:900 13px 'Yu Gothic',Meiryo,sans-serif;text-shadow:0 1px 2px #000;";
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'width:190px;height:13px;background:rgba(10,14,22,0.7);border:1px solid #46608c;border-radius:7px;overflow:hidden;';
    hpBarEl = document.createElement('div');
    hpBarEl.style.cssText = 'height:100%;width:100%;background:linear-gradient(90deg,#3adf7c,#9fe6ff);transition:width 0.25s;';
    barWrap.appendChild(hpBarEl);
    hpNumEl = document.createElement('div');
    hpNumEl.style.cssText = "color:#fff;font:900 15px 'Yu Gothic',Meiryo,sans-serif;text-shadow:0 1px 3px #000;min-width:34px;";
    wrap.append(label, barWrap, hpNumEl);
    document.body.appendChild(wrap);
  }
  const r = Math.max(0, playerHp / PLAYER_HP_MAX);
  hpBarEl.style.width = (r * 100) + '%';
  hpBarEl.style.background = r < 0.3 ? 'linear-gradient(90deg,#e2402f,#ff9a3a)' : 'linear-gradient(90deg,#3adf7c,#9fe6ff)';
  if (hpNumEl) hpNumEl.textContent = String(Math.ceil(playerHp));
}
// ── 撃墜数（敵を倒すと太字ゴシックで一定時間表示→フェードアウト）──
// ── ゲームループP1: モード状態機械＋ゲームパラメータ（docs/cityfly-game-plan.md §3）──
let gameMode = 'title';   // 'title' | 'training' | 'play'（'op'/'ed' はP2で追加）
const gp = { destroyed: 0, attritionPts: 0 };          // 都市被害・敵損耗の実測値
const ATTR_PTS = { jet: 3, walker: 20, spider: 35 };   // 撃破ポイント（想定総量100pt=100%）
function cityDamagePct() { return cityInfo && cityInfo.count ? Math.min(100, gp.destroyed / cityInfo.count * 100) : 0; }
function attritionPct() { return Math.min(100, gp.attritionPts); }
function enemyAllowed(kind) {   // 敵出現のモード制御（本編の投入は events.json 駆動）
  if (kind === 'walker' && spider) return false;   // スパイダーキャリア出現中はウォーカーを出さない
  if (gameMode === 'training') return true;
  if (gameMode !== 'play') return false;   // title / op / ed 中は敵なし
  if (ev.flags.warEnd) return false;   // 終戦後は増援なし（ED遷移はP4）
  if (kind === 'jet') return true;
  return !!ev.spawnAllow[kind];   // walker/spider は events.json の投入指示で解禁
}
let titleEl = null, goEl = null, paramsEl = null;
function setupTitle() {
  titleEl = document.createElement('div');
  titleEl.style.cssText = 'position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;'
    + 'background:linear-gradient(180deg,rgba(6,10,26,0.90),rgba(24,8,34,0.86));color:#eef;';
  const btn = 'font:700 20px Meiryo,sans-serif;padding:12px 52px;border-radius:8px;border:1px solid #86f;background:#1b1f3a;color:#dde;cursor:pointer;min-width:340px;';
  titleEl.innerHTML = '<div style="font:900 64px \'Yu Gothic\',\'Arial Black\',Meiryo,sans-serif;letter-spacing:0.08em;text-shadow:0 4px 18px rgba(130,70,255,0.65),0 2px 6px #000;">City-Fly</div>'
    + '<div style="font:14px Meiryo,sans-serif;color:#aab;margin-bottom:14px;">デッドアトモス襲来 — 吸血鬼ネイ、出撃</div>'
    + '<button id="cf-start" style="' + btn + '" disabled>準備中…</button>'
    + '<button id="cf-training" style="' + btn + '" disabled>トレーニングモード</button>';
  document.body.appendChild(titleEl);
  const bs = titleEl.querySelector('#cf-start'), bt = titleEl.querySelector('#cf-training');
  const iv = setInterval(() => {   // 都市生成＋プレイヤー＋会話キャストの先読みが済んだらボタン有効化
    const worldOk = cityRoot && collBoxes.length && player.ready;
    if (worldOk) bt.disabled = false;   // トレーニングはキャスト不要
    if (worldOk && guestPreloadDone) {  // 本編はOP直後に会話キャストを使うので待つ
      bs.disabled = false; bs.textContent = 'ゲームスタート'; clearInterval(iv);
    } else if (worldOk) bs.textContent = 'キャスト読込中…';
  }, 400);
  bs.addEventListener('click', () => startMode('play'));
  bt.addEventListener('click', () => startMode('training'));
}
function startMode(mode) {
  gameMode = mode;
  if (titleEl) titleEl.style.display = 'none';
  if (mode === 'play') startFlow();   // start→story(OP)→battle の順にフローが進行
}
function showGameOver() {
  if (goEl) return;
  goEl = document.createElement('div');
  goEl.style.cssText = 'position:fixed;inset:0;z-index:39;display:flex;align-items:center;justify-content:center;background:rgba(12,0,8,0.55);';
  goEl.innerHTML = '<div style="font:900 76px \'Yu Gothic\',\'Arial Black\',Meiryo,sans-serif;color:#ff4a5e;letter-spacing:0.1em;text-shadow:0 4px 20px #000;">GAME OVER</div>';
  document.body.appendChild(goEl);
}
function updateParamsUI() {   // デバッグ兼HUD: 都市被害/敵損耗/手配（タイトル中は非表示）
  if (gameMode === 'title') { if (paramsEl) paramsEl.style.display = 'none'; return; }
  if (!paramsEl) {
    paramsEl = document.createElement('div');
    paramsEl.style.cssText = 'position:fixed;left:12px;top:122px;z-index:20;pointer-events:none;'
      + 'color:#cfe;font:700 12px Meiryo,sans-serif;text-shadow:0 1px 3px #000;';
    document.body.appendChild(paramsEl);
  }
  paramsEl.style.display = '';
  paramsEl.textContent = '都市被害 ' + cityDamagePct().toFixed(1) + '% ／ 敵損耗 ' + attritionPct().toFixed(0) + '% ／ 手配 ' + ('★'.repeat(wantedLevel()) || 'ー');
}
// ── ゲームループP3: イベントシステム＋ゲーム内会話（public/cityfly/events.json / talks.json）──
const ev = { defs: [], talks: null, fired: new Set(), flags: {}, spawnAllow: {}, kills: [], pendingOn: new Set(), lastPort: null };
const TALK_MIN_SEC = 3.2, TALK_CPS = 9;   // 1行の表示時間 = max(最低秒, 文字数/読速)
// 2D紙芝居プレイヤ（OP/ED。素材: public/scenario2d/、脚本: public/story/*.story.json）
const scn = createScenario2D({
  basePath: '../scenario2d', soundPath: '../sound', actors: () => (ev.talks && ev.talks.actors) || null,
  stage: {   // OP/ED: 話者を全画面で3D表示（モデルは起動時に先読み済み＝追加ロードなし）
    begin: (who, face, text, extra) => { const ok = beginPortraitFor(who, face, text, true, extra); setGameHudVisible(false); return ok; },
    end: () => { portraitStage = false; portraitOn = false; setActiveGuest(null); setGameHudVisible(true); },
  },
});
async function playScenario(name, after = 'play') {   // after: 'play'=本編へ / 'title'=リロードでタイトルへ
  let story = null;
  try { story = await (await fetch('../story/' + name + '.story.json')).json(); }
  catch (err) { console.warn('シナリオ読込失敗:', name, err); }
  if (!story) { if (after === 'title') location.reload(); else gameMode = 'play'; return; }
  gameMode = after === 'title' ? 'ed' : 'op';
  scn.play(story, { onEnd: () => { if (after === 'title') location.reload(); else gameMode = 'play'; } });
}
// ── フロー統合（public/flow/cityfly.flow.json。start→story(OP)→battle→win/bad/lose→story(ED)→end）──
let flowRt = null, flowNode = null, flowBattleDone = false, flowTimer = null;   // flowTimer={port,t}=ポート発火の遅延（撃破演出を見せてからED）
async function startFlow() {
  if (!flowRt) {
    try { flowRt = createFlow(await (await fetch('../flow/cityfly.flow.json')).json()); }
    catch (err) { console.warn('フロー読込失敗（本編へ直行）:', err); }
  }
  if (!flowRt) { gameMode = 'play'; return; }
  flowNode = flowRt.getStart();
  flowAdvance('next');
}
function flowAdvance(port) {
  if (!flowRt || !flowNode) return;
  const nx = flowRt.next(flowNode.id, port);
  if (!nx) { runFlowEnd(); return; }
  flowNode = nx;
  if (nx.type === 'story') {
    const name = String((nx.data && nx.data.story) || '').replace(/\.story\.json$/, '');
    gameMode = flowBattleDone ? 'ed' : 'op';
    playFlowStory(name);
  } else if (nx.type === 'battle') {
    gameMode = 'play';
  } else if (nx.type === 'end') {
    runFlowEnd();
  } else {
    flowAdvance('next');   // start等は素通り
  }
}
function runFlowEnd() { location.reload(); }   // フロー終了＝タイトルへ（全リセット）
async function playFlowStory(name) {
  let story = null;
  try { story = await (await fetch('../story/' + name + '.story.json')).json(); }
  catch (err) { console.warn('シナリオ読込失敗:', name, err); }
  if (!story) { flowAdvance('next'); return; }
  scn.play(story, { onEnd: () => { flowAdvance('next'); } });
}
function updateFlowTimer(dt) {   // battle中のポート発火遅延（例: ウォーカー崩壊を5秒見せてからGood ED）
  if (!flowTimer) return;
  flowTimer.t -= dt;
  if (flowTimer.t > 0) return;
  const port = flowTimer.port; flowTimer = null;
  if (flowNode && flowNode.type === 'battle') { flowBattleDone = true; flowAdvance(port); }
}
async function loadGameEvents() {
  try {
    const [e, t] = await Promise.all([
      fetch('../cityfly/events.json').then((r) => r.json()),
      fetch('../cityfly/talks.json').then((r) => r.json()),
    ]);
    ev.defs = Array.isArray(e.events) ? e.events : [];
    ev.talks = t;
  } catch (err) { console.warn('イベント定義の読込失敗:', err); }
}
function evParam(name) {
  if (name === 'hpPct') return playerHp / PLAYER_HP_MAX * 100;
  if (name === 'attrition') return attritionPct();
  if (name === 'cityDamage') return cityDamagePct();
  if (name === 'wanted') return wantedLevel();
  return 0;
}
function evCmp(v, op, val) { return op === '<=' ? v <= val : op === '<' ? v < val : op === '>' ? v > val : v >= val; }
function evalEvents() {   // 本編のみ・各イベント1回発火。しきい値はクロス検知でなく現在値判定（fired で一度きり）
  if (gameMode !== 'play' || !ev.defs.length) { ev.pendingOn.clear(); return; }
  for (const d of ev.defs) {
    if (ev.fired.has(d.id)) continue;
    const w = d.when || {};
    if (w.flag && !ev.flags[w.flag]) continue;        // 追加AND条件: フラグ必須
    if (w.notFlag && ev.flags[w.notFlag]) continue;   // 追加AND条件: フラグ不成立が必須
    let hit = false;
    if (w.on) hit = ev.pendingOn.has(w.on);
    else if (w.param) hit = evCmp(evParam(w.param), w.op || '>=', w.value || 0);
    else if (w.kill) hit = ev.kills.includes(w.kill);
    if (!hit) continue;
    ev.fired.add(d.id);
    for (const a of (d.do || [])) runEvAction(a);
  }
  ev.pendingOn.clear();
}
function runEvAction(a) {
  if (a.type === 'talk') queueTalk(a.talk);
  else if (a.type === 'spawn') ev.spawnAllow[a.enemy] = true;   // 投入指示（enemyAllowed が参照）
  else if (a.type === 'flag') ev.flags[a.flag] = true;
  else if (a.type === 'scenario') playScenario(a.scenario, a.after || 'play');
  else if (a.type === 'flow') {
    ev.lastPort = a.port;
    if (!flowTimer) flowTimer = { port: a.port, t: a.delay ?? 0 };   // 先勝ち（win/bad の競合は先に発火した方）
  }
}
// ── 立体ポートレート: 会話ウィンドウの顔枠にプレイヤーVRMの顔を実描画＋リップシンク ──
const PORTRAIT_LAYER = 3;          // このレイヤに載せたものだけをポートレートカメラが見る（街を描かない）
const PORTRAIT_ACTOR = 'nei';      // 立体表示する話者ID（＝操作キャラ）
// 頭ボーン基準の構図パラメータ（実行中に window.__pt で微調整可）
const PT = { dist: 0.60, up: 0.06, fwd: 0.02, sign: 1, fov: 27, basis: 'chest', basisMix: 0.4 };   // basisMix: 0=頭固定(常に正対) / 1=胸固定(首振りが強く出る)   // sign=+1: 頭ボーンの +Z が顔の向き。顔が読める寄り構図
let portraitCam = null, portraitLip = null, portraitOn = false, portraitBg = null;
const portraitGuests = new Map();   // actorId -> { vrm, lip, loading } （talks.json の actor.vrm を遅延読込）
let portraitWho = PORTRAIT_ACTOR;   // 今ポートレートに映している話者
let portraitStage = false;         // true=シナリオ中の全画面ステージ表示
const PT_STAGE = { dist: 1.5, up: 0.02, fwd: 0, fov: 32 };   // バストアップ寄りの引き
const GUEST_POS = new THREE.Vector3(0, -800, 0);   // 本編カメラから見えない控え位置（ポートレート専用レイヤなので実害なし）
const exprDefsP = fetch('../cityfly/expressions.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);   // カスタム表情の合成定義
const GUEST_IDLE_VRMA = 'HumanM@Idle01.vrma';      // 会話相手の待機モーション
const _ptV1 = new THREE.Vector3(), _ptV2 = new THREE.Vector3(), _ptV3 = new THREE.Vector3(), _ptEye = new THREE.Vector3(), _ptQ = new THREE.Quaternion(), _ptQ2 = new THREE.Quaternion();
const _ptSunPos = new THREE.Vector3(), _ptSunCol = new THREE.Color();   // ポートレート描画中のライト退避用
window.__pt = PT;   // 構図の微調整用
function setupPortrait() {   // プレイヤーVRM読込後に呼ぶ
  if (NO_PORTRAIT || portraitCam || !player.vrm) return;
  portraitCam = new THREE.PerspectiveCamera(26, 1, 0.02, 8);
  portraitCam.layers.set(PORTRAIT_LAYER);
  portraitBg = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ color: 0x0d1120 }));
  portraitBg.layers.set(PORTRAIT_LAYER);   // 専用レイヤ＝本編カメラには映らない背景板
  portraitBg.frustumCulled = false;
  scene.add(portraitBg);
  // 注意: ポートレート専用のライトを足してはいけない。本編パスとライト構成が変わると
  // ノード材質が毎フレーム再コンパイルされ 16ms→1600ms に落ちる（実測）。既存ライトを共有する。
  player.vrm.scene.traverse((o) => o.layers.enable(PORTRAIT_LAYER));
  if (player.cloth && player.cloth.clothMesh) player.cloth.clothMesh.layers.enable(PORTRAIT_LAYER);
  for (const l of [dayRefs.amb, dayRefs.sun, dayRefs.hemi, charFill.key]) if (l) l.layers.enable(PORTRAIT_LAYER);
  try { portraitLip = createLipSync(player.vrm); } catch (e) { console.warn('リップシンク初期化失敗:', e); }
  exprDefsP.then((d) => { try { if (d && player.vrm) registerCustomExpressions(player.vrm, d); } catch (e) { console.warn('カスタム表情登録失敗(player):', e); } });
  preloadGuestVrms();   // 会話相手のVRMを裏で先読み（初回のセリフから立体表示にするため）
}
let guestPreloadDone = false;
async function preloadGuestVrms() {
  for (let i = 0; i < 40 && !(ev.talks && ev.talks.actors); i++) await new Promise((r) => setTimeout(r, 500));   // talks.json 待ち
  const actors = (ev.talks && ev.talks.actors) || {};
  for (const [aid, a] of Object.entries(actors)) {
    const file = a && (a.npc || a.vrm);
    if (!file || aid === PORTRAIT_ACTOR) continue;
    await ensureGuestVrm(aid, file);   // 直列＝読込集中で本編がカクつかないように
  }
  guestPreloadDone = true;
}
function headNodeOf(vrm) {
  const hm = vrm && vrm.humanoid;
  if (!hm) return null;
  return (hm.getNormalizedBoneNode ? hm.getNormalizedBoneNode('head') : null) || (hm.getRawBoneNode ? hm.getRawBoneNode('head') : null);
}
function portraitSubject() {   // 現在の話者のVRM（プレイヤー or ゲスト）
  if (portraitWho === PORTRAIT_ACTOR) return player.vrm;
  const g = portraitGuests.get(portraitWho);
  return (g && g.vrm) || null;
}
function portraitHeadNode() { return headNodeOf(portraitSubject()); }
function portraitBasisNode(vrm) {   // カメラの基準は胸（頭に固定すると首を振っても追従して顔が動いて見えない）
  const hm = vrm && vrm.humanoid;
  if (!hm) return null;
  const get = (n) => (hm.getNormalizedBoneNode ? hm.getNormalizedBoneNode(n) : null) || (hm.getRawBoneNode ? hm.getRawBoneNode(n) : null);
  for (const n of (PT.basis === 'head' ? ['head'] : ['chest', 'upperChest', 'spine', 'hips', 'head'])) { const b = get(n); if (b) return b; }
  return null;
}
async function ensureGuestVrm(actorId, file) {   // 会話相手のVRMをポートレート専用レイヤへ読み込む
  let g = portraitGuests.get(actorId);
  if (g) return g.vrm;
  g = { vrm: null, lip: null, loading: true };
  portraitGuests.set(actorId, g);
  try {
    const isBundle = /\.npc\.json$/i.test(file);   // .npc.json＝マント等を含むバンドル / それ以外は素のVRM
    let bundle = null, srcUrl = '../vrm/' + encodeURIComponent(file);
    if (isBundle) {
      bundle = await (await fetch('../npc/' + encodeURIComponent(file))).json();
      if (!bundle || !bundle.vrm) throw new Error('バンドルにVRMがありません: ' + file);
      srcUrl = URL.createObjectURL(dataURIToBlob(bundle.vrm));
    }
    const loader = new GLTFLoader();
    loader.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
    const gltf = await loader.loadAsync(srcUrl);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRM拡張なし: ' + file);
    vrm.scene.position.copy(GUEST_POS).x += portraitGuests.size * 8;   // 1体ずつ離す（重ねると隣の後頭部が映り込む）
    // モデルの正面をカメラ基準に合わせる（VRM0は180°ラップ）
    const faceOff = bundle && bundle.faceOffsetDeg != null ? bundle.faceOffsetDeg * Math.PI / 180 : (vrm.meta?.metaVersion === '0' ? Math.PI : 0);
    vrm.scene.rotation.y = faceOff;
    vrm.scene.traverse((o) => { o.layers.set(PORTRAIT_LAYER); o.frustumCulled = false; });   // 本編カメラには映らない
    vrm.scene.visible = false;   // 喋る時だけ表示
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    g.vrm = vrm;
    if (bundle && bundle.cloth && !NO_CAPE) {   // マント（GPUクロス）。プレイヤーと同じ正準化を適用
      try {
        const gripFlip = Math.cos(faceOff) > 0;
        const _flipO = (o) => { if (Array.isArray(o) && o.length >= 3) { o[0] = -o[0]; o[2] = -o[2]; } };
        if (gripFlip) {
          for (const gg of (bundle.cloth.gripGroups || [])) _flipO(gg.offset);
          if (bundle.cloth.handGrabOffsets) { _flipO(bundle.cloth.handGrabOffsets.left); _flipO(bundle.cloth.handGrabOffsets.right); }
        }
        const tr0 = bundle.cloth.editorTransform ?? { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1 };
        const yawDeg = faceOff * 180 / Math.PI;   // 初期配置はモデルの向きを見ないので ry に合成が必要
        const c0 = Math.cos(faceOff), s0 = Math.sin(faceOff);
        const trAdj = { ...tr0, ry: (tr0.ry || 0) + yawDeg,
          tx: (tr0.tx || 0) * c0 - (tr0.tz || 0) * s0,
          tz: (tr0.tx || 0) * s0 + (tr0.tz || 0) * c0 };
        g.basePos = vrm.scene.position.clone();
        g.cloth = createVRMCloth({ renderer, scene, vrm, cloth: { ...bundle.cloth, editorTransform: trAdj }, basePos: g.basePos, floorY: -1e9 });
        if (g.cloth.clothMesh) { g.cloth.clothMesh.layers.set(PORTRAIT_LAYER); g.cloth.clothMesh.frustumCulled = false; g.cloth.clothMesh.visible = false; }
      } catch (e) { console.warn('会話相手のマント生成失敗:', actorId, e); }
    }
    try {   // アイドル再生（Tポーズ回避）。VRMAが無ければ腕だけ下ろす
      const vres = await fetch('../vrma/' + encodeURIComponent(GUEST_IDLE_VRMA));
      if (!vres.ok) throw new Error('idle vrma ' + vres.status);
      const al = new GLTFLoader(); al.register((pl) => new VRMAnimationLoaderPlugin(pl));
      const ag = await al.loadAsync(URL.createObjectURL(await vres.blob()));
      const anims = ag.userData.vrmAnimations;
      if (!anims || !anims.length) throw new Error('vrmAnimations なし');
      const clip = createVRMAnimationClip(anims[0], vrm); stripRootMotion(clip);
      g.mixer = new THREE.AnimationMixer(vrm.scene);
      g.mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
    } catch (e) {
      console.warn('ゲストのアイドル再生失敗（腕を下ろすだけにします）:', actorId, e.message || e);
      const hm = vrm.humanoid;
      const arm = (n, z) => { const b2 = hm.getNormalizedBoneNode ? hm.getNormalizedBoneNode(n) : null; if (b2) b2.rotation.z = z; };
      arm('leftUpperArm', 1.15); arm('rightUpperArm', -1.15);
    }
    try { g.lip = createLipSync(vrm); } catch (e) { console.warn('ゲストのリップシンク初期化失敗:', actorId, e); }
    try { registerCustomExpressions(vrm, await exprDefsP); } catch (e) { console.warn('カスタム表情登録失敗:', actorId, e); }
    try { await warmGuest(g); } catch (e) { console.warn('ゲストの事前コンパイル失敗（初回表示が詰まります）:', actorId, e); }

    console.log('ポートレート用VRM読込:', actorId, file);
  } catch (e) {
    console.warn('ポートレート用VRM読込失敗:', actorId, file, e);
  }
  g.loading = false;
  return g.vrm;
}
async function warmGuest(g) {   // 初登場ヒッチ対策: visible=false のままでは compileAsync が素通りする（Renderer._projectObject が非表示ツリーをスキップ）ため、一時表示して実コンパイル＋1pxの実描画まで済ませる
  if (!g.vrm || !portraitCam) return;
  const cm = g.cloth && g.cloth.clothMesh;
  g.vrm.scene.visible = true;
  if (cm) cm.visible = true;
  try {
    await renderer.compileAsync(scene, portraitCam);
    if (g.cloth) for (let i = 0; i < 2; i++) { try { g.cloth.update(1 / 60); } catch { /* noop */ } }   // マントの計算パイプラインも温める
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, 1, 1);
    renderer.setViewport(0, 0, 1, 1);
    renderer.render(scene, portraitCam);   // テクスチャ転送など残りを実描画で確定させる
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.autoClear = true;
  } finally {
    g.vrm.scene.visible = false;
    if (cm) cm.visible = false;
  }
}
function updatePortrait(dt) {
  if (portraitLip) portraitLip.update(dt * 1000);
  const gCur = portraitWho !== PORTRAIT_ACTOR ? portraitGuests.get(portraitWho) : null;
  if (gCur && gCur.vrm) {   // ゲストは会話中だけ更新（モーション/表情/リップ/揺れもの）
    if (gCur.lip) gCur.lip.update(dt * 1000);
    if (gCur.mixer) gCur.mixer.update(dt);
    gCur.vrm.update(dt);
    if (gCur.cloth) { try { gCur.cloth.update(dt); } catch { /* noop */ } }
  }
  if (!portraitOn || !portraitCam) return;
  const h = portraitHeadNode();
  if (!h) { portraitOn = false; return; }
  h.getWorldPosition(_ptV1);   // 注視点＝頭（顔は常に画面内）
  h.getWorldQuaternion(_ptQ);
  const bn = portraitBasisNode(portraitSubject());   // 向き＝頭と胸の中間（首振りが画に出るが顔は外れない）
  if (bn && bn !== h) { bn.getWorldQuaternion(_ptQ2); _ptQ.slerp(_ptQ2, Math.max(0, Math.min(1, PT.basisMix))); }
  // 顔の向き（体の傾き・首振りに追従）。VRM0は前方が -Z なのでモデルごとに符号を判定
  const fz = portraitSubject()?.lookAt?.faceFront?.z;
  const fwd = _ptV2.set(0, 0, PT.sign * (typeof fz === 'number' && fz < 0 ? -1 : 1)).applyQuaternion(_ptQ);
  const up = _ptV3.set(0, 1, 0).applyQuaternion(_ptQ);
  const ov0 = ((ev.talks && ev.talks.actors && ev.talks.actors[portraitWho]) || {}).pt || {};   // 話者ごとの構図上書き（頭の大きさ/被り物の差を吸収）
  const base = portraitStage ? PT_STAGE : PT;
  const ov = portraitStage ? (ov0.stage || {}) : ov0;
  const dist = ov.dist ?? base.dist, upOff = ov.up ?? base.up, fwdOff = ov.fwd ?? base.fwd, fov = ov.fov ?? base.fov;
  _ptEye.copy(_ptV1).addScaledVector(up, upOff).addScaledVector(fwd, fwdOff);   // 頭ボーン=首元→目の高さへ
  portraitCam.position.copy(_ptEye).addScaledVector(fwd, dist);
  portraitCam.up.copy(up);
  portraitCam.lookAt(_ptEye);
  const rr = portraitRect();
  const asp = rr && rr.height > 0 ? rr.width / rr.height : 1;
  if (portraitCam.fov !== fov || portraitCam.aspect !== asp) { portraitCam.fov = fov; portraitCam.aspect = asp; portraitCam.updateProjectionMatrix(); }
  if (portraitBg) {   // 背景板は画角を必ず覆うサイズに（街が見えないように）
    const back = portraitStage ? 2.2 : 0.9;
    portraitBg.position.copy(_ptEye).addScaledVector(fwd, -back);
    portraitBg.lookAt(portraitCam.position);
    const halfH = Math.tan(fov * Math.PI / 360) * (dist + back) * 2.2;
    portraitBg.scale.setScalar(Math.max(1, halfH * Math.max(1, asp)));
  }
}
const HUD_IDS = ['status', 'crosshair', 'hint', 'attrib'];   // シナリオ中に隠すゲームHUD
function setGameHudVisible(on) {
  for (const id of HUD_IDS) { const el = $(id); if (el) el.style.visibility = on ? '' : 'hidden'; }
  if (hpBarEl && hpBarEl.parentElement && hpBarEl.parentElement.parentElement) hpBarEl.parentElement.parentElement.style.visibility = on ? '' : 'hidden';
  if (paramsEl) paramsEl.style.visibility = on ? '' : 'hidden';
  if (killEl) killEl.style.visibility = on ? '' : 'hidden';
}
function portraitRect() {   // 描画先の矩形（会話=顔枠 / シナリオ=画面全体）
  if (portraitStage) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, bottom: window.innerHeight };
  return talkEls ? talkEls.face.getBoundingClientRect() : null;
}
function renderPortrait() {   // メイン描画の直後に、対象矩形へキャラだけを追加描画
  if (!portraitOn || !portraitCam) return;
  const r = portraitRect();
  if (!r || r.width < 4 || r.bottom <= 0) return;
  const x = Math.round(r.left), y = Math.round(r.top);   // WebGPU は左上原点
  const w = Math.round(r.width), h = Math.round(r.height);
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setScissor(x, y, w, h);
  renderer.setViewport(x, y, w, h);
  renderer.setClearColor(0x10131f, 1);
  renderer.clear(true, true, false);
  // 立体表示は時刻に依らず常に昼の標準照明で描く。強さ・色・向きの差し替え＝uniform更新のみで
  // 再コンパイルは走らない（ライトの追加・削除は構造が変わるので厳禁＝既存の鉄則どおり）。
  // 注意: ライトuniformはフレーム単位キャッシュ（AnalyticLightNode=FRAME更新・Animationが1tick1回frameId++）のため、
  // 値だけ変えても同一フレーム2回目のrenderには反映されない。前後で frameId を進めて強制再評価させる。
  const s = dayRefs.sun, am = dayRefs.amb, hm = dayRefs.hemi, k = charFill.key;
  const nf = renderer._nodes && renderer._nodes.nodeFrame;
  const lit = !!(s && am && hm && nf);
  let sI, amI, hmI, kI;
  if (lit) {
    sI = s.intensity; amI = am.intensity; hmI = hm.intensity;
    _ptSunPos.copy(s.position); _ptSunCol.copy(s.color);
    s.intensity = 1.7; s.color.setHex(0xfff4e0); s.position.set(3000, 6000, 3600);   // 起動時の昼標準（ポートレート構図はこの光で調整済み）
    am.intensity = 1.0; hm.intensity = 0.6;
    if (k) { kI = k.intensity; k.intensity = charLightCfg.dirI; }
    nf.frameId++;
  }
  renderer.render(scene, portraitCam);
  if (lit) {
    s.intensity = sI; s.color.copy(_ptSunCol); s.position.copy(_ptSunPos);
    am.intensity = amI; hm.intensity = hmI;
    if (k) k.intensity = kI;
    nf.frameId++;   // 次のメイン描画でも必ず再評価させる（戻した夜の値を確実に反映）
  }
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.autoClear = true;
}
// 会話ウィンドウ: 画面下部・顔グラ＋話者名＋テキスト。時間経過で自動送り（ポインタロック中のためクリック送りなし）
let talkEls = null; const talkQ = []; let talkCur = null, talkT = 0;
function ensureTalkUI() {
  if (talkEls) return;
  const wrap = document.createElement('div');
  // 背景は本文パネル側に持たせ、顔枠は「窓の穴」にする（立体ポートレートをDOMで覆わないため）
  wrap.style.cssText = 'position:fixed;left:50%;bottom:46px;transform:translateX(-50%);width:min(1100px,92vw);z-index:30;'
    + 'pointer-events:none;gap:18px;align-items:center;display:none;';
  const face = document.createElement('div');
  face.style.cssText = 'width:138px;height:138px;flex:0 0 138px;border-radius:12px;overflow:hidden;position:relative;background:#223;'
    + 'border:1px solid rgba(140,150,255,0.45);box-shadow:0 4px 18px rgba(0,0,0,0.5);';
  const fb = document.createElement('div');   // 顔グラ未配置時の仮表示（イニシャル）
  fb.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:900 66px Meiryo,sans-serif;color:#fff;';
  const img = document.createElement('img');
  img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;';
  face.appendChild(fb); face.appendChild(img);
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;background:rgba(8,10,24,0.82);border:1px solid rgba(140,150,255,0.45);'
    + 'border-radius:15px;padding:15px 21px;box-shadow:0 4px 18px rgba(0,0,0,0.5);';
  const name = document.createElement('div'); name.style.cssText = 'font:700 21px Meiryo,sans-serif;margin-bottom:6px;';
  const text = document.createElement('div'); text.style.cssText = 'font:24px/1.6 Meiryo,sans-serif;color:#eef;min-height:3.2em;';
  body.appendChild(name); body.appendChild(text);
  wrap.appendChild(face); wrap.appendChild(body);
  document.body.appendChild(wrap);
  talkEls = { wrap, face, img, fb, name, text };
}
let activeGuest = null;
function setActiveGuest(who) {   // 喋っているゲストだけ表示（シーンからの出し入れは切替時に250msのヒッチが出るので不可）
  if (activeGuest === who) return;
  const prev = activeGuest && portraitGuests.get(activeGuest);
  if (prev && prev.vrm) { prev.vrm.scene.visible = false; if (prev.cloth && prev.cloth.clothMesh) prev.cloth.clothMesh.visible = false; }
  activeGuest = who;
  const cur = who && portraitGuests.get(who);
  if (cur && cur.vrm) { cur.vrm.scene.visible = true; if (cur.cloth && cur.cloth.clothMesh) cur.cloth.clothMesh.visible = true; }
}
function beginPortraitFor(who, face, text, stage, extra) {   // 話者の立体表示を開始（戻り値=立体表示できたか）。extra={lipCps,expression,weight}
  if (NO_PORTRAIT || !portraitCam) return false;
  portraitWho = who;
  let live = false;
  if (who === PORTRAIT_ACTOR) live = player.ready && !playerDead;
  else {
    const a = (ev.talks && ev.talks.actors && ev.talks.actors[who]) || {};
    const g = portraitGuests.get(who);
    if (g && g.vrm) live = true;
    else if (a.npc || a.vrm) ensureGuestVrm(who, a.npc || a.vrm);   // 未読込なら読込だけ走らせる（次の行から立体表示）
  }
  portraitStage = !!stage && live;
  portraitOn = live;
  setActiveGuest(live && who !== PORTRAIT_ACTOR ? who : null);
  if (!live) return false;
  const lip = who === PORTRAIT_ACTOR ? portraitLip : (portraitGuests.get(who) || {}).lip;
  if (lip && text) lip.play(text, (extra && extra.lipCps) || TALK_CPS);   // say.lipCps で口パク速度を上書き可
  const exOv = extra && extra.expression;   // 行単位の表情（VRM表情名）。face（2D表情名）より優先
  if (exOv || who !== PORTRAIT_ACTOR) {
    const em = (who === PORTRAIT_ACTOR ? player.vrm : (portraitGuests.get(who) || {}).vrm)?.expressionManager;
    if (em) {
      resetEmotionExpressions(em);   // 感情系（プリセット＋カスタム）を全て0へ。口パク・まばたきは触らない
      const map = { smile: 'happy', angry: 'angry', worry: 'sad', panic: 'surprised', weak: 'sad', damage: 'sad' };
      const ex = exOv || map[face || 'normal'];
      if (ex) { try { em.setValue(ex, exOv ? (extra.weight ?? 1) : 1); } catch { /* noop */ } }
    }
  }
  return true;
}
function queueTalk(id) {
  const lines = ev.talks && ev.talks.talks && ev.talks.talks[id];
  if (!lines) { console.warn('talk未定義:', id); return; }
  for (const ln of lines) talkQ.push(ln);
}
function showTalkLine(ln) {
  ensureTalkUI();
  const actor = (ev.talks && ev.talks.actors && ev.talks.actors[ln.who]) || { name: ln.who, color: '#889' };
  talkEls.wrap.style.display = 'flex';
  talkEls.name.textContent = actor.name; talkEls.name.style.color = actor.color || '#adf';
  talkEls.text.textContent = ln.text;
  talkEls.fb.textContent = (actor.name || '?').slice(0, 1);
  talkEls.fb.style.background = actor.color || '#445';
  talkEls.img.style.display = 'none';
  const live = beginPortraitFor(ln.who, ln.face, ln.text, false);   // 会話ウィンドウ＝顔枠モード
  if (!live && actor && (actor.npc || actor.vrm)) {   // 読込中だった場合、完了したら立体表示へ差し替え
    ensureGuestVrm(ln.who, actor.npc || actor.vrm).then((v) => { if (v && talkCur === ln) showTalkLine(ln); });
  }
  talkEls.face.style.background = live ? 'transparent' : '#223';   // 立体表示中はキャンバスを透かす
  talkEls.fb.style.display = live ? 'none' : '';
  if (!live) {
    talkEls.img.onload = () => { talkEls.img.style.display = ''; };
    talkEls.img.onerror = () => { talkEls.img.style.display = 'none'; };   // 仮画像のまま
    talkEls.img.src = '../scenario2d/face/' + ln.who + '/' + (ln.face || 'normal') + '.png';
  }
  talkT = Math.max(TALK_MIN_SEC, ln.text.length / TALK_CPS);
}
function updateTalk(dt) {
  if (talkCur) {
    talkT -= dt;
    if (talkT > 0) return;
    talkCur = null;
  }
  if (talkQ.length) { talkCur = talkQ.shift(); showTalkLine(talkCur); }
  else if (talkEls) {   // 会話キューが空＝会話ウィンドウを閉じる。ただしシナリオのステージ表示中は消さない
    talkEls.wrap.style.display = 'none';
    if (!portraitStage) { portraitOn = false; setActiveGuest(null); }
  }
}
let killCount = 0, killShowT = 0, killEl = null;
function addKill(kind = 'jet') {
  killCount++;
  gp.attritionPts += ATTR_PTS[kind] || 0;   // 敵損耗率へ加算
  ev.kills.push(kind);
  killShowT = 3.0;
  if (!killEl) {
    killEl = document.createElement('div');
    killEl.style.cssText = 'position:fixed;left:12px;top:78px;z-index:20;pointer-events:none;opacity:0;'
      + "color:#ffd45e;font:900 34px 'Yu Gothic','Arial Black',Meiryo,sans-serif;text-shadow:0 2px 6px #000,0 0 14px rgba(255,120,40,0.55);";
    document.body.appendChild(killEl);
  }
  killEl.textContent = '撃墜 ' + killCount;
}
function updateKillUI(dt) {
  if (!killEl || killShowT <= 0) return;
  killShowT = Math.max(0, killShowT - dt);
  killEl.style.opacity = Math.min(1, killShowT / 0.6).toFixed(2);   // 残り0.6秒でフェードアウト
}
let dmgWarmT = 0;   // 起動直後は溶解ON/OFF両方のパイプラインをコンパイルさせる猶予（切替ストール防止）
function applyDamageFx() {   // ダメージ割合 → 各部位の溶解進行＋表情
  const dmgPct = (1 - playerHp / PLAYER_HP_MAX) * 100;
  for (const dp of dmgParts) {
    const [s0, e0] = dp.range;
    const prog = e0 > s0 ? Math.max(0, Math.min(1, (dmgPct - s0) / (e0 - s0))) : (dmgPct >= e0 ? 1 : 0);
    dp.dis.setProgress(prog);
    if (dmgWarmT <= 0 && dp.dis.setActive) dp.dis.setActive(prog > 0);   // 無傷部位は溶解シェーダを停止
  }
  const em = player.vrm?.expressionManager;
  if (em) for (const ec of dmgExpressions) { try { em.setValue(ec.name, dmgExprValueAt(ec.keys, dmgPct)); } catch { /* noop */ } }
}
const PLAYER_BIGHIT = 10;   // これ以上の単発ダメージ＝大ダメージ（dead03＋吹っ飛び）
let playerDead = false, playerDeathT = 0, playerRagOn = false, playerKnockT = 0;   // playerRagOn=きりもみ落下フェーズ
let playerRagdoll = null, playerLandRag = false, playerRagOpts = null;   // 接地後のラグドール（nei_vamp.ragdoll.json）
const _pdV = new THREE.Vector3(), _pdV2 = new THREE.Vector3(), _pdV3 = new THREE.Vector3(), _pdC = new THREE.Vector3(), _pdAxis = new THREE.Vector3(), _pdUp = new THREE.Vector3(0, 1, 0), _pdQ = new THREE.Quaternion();
function playerDamage(n, dir) {
  if (!player.ready || playerDead) return;
  if (gameMode === 'op' || gameMode === 'ed') return;   // シナリオ中は被弾なし
  dmgFlash = Math.min(1, 0.45 + n * 0.03);   // 被弾の赤フラッシュ（強いほど濃い）
  playerHp = Math.max(0, playerHp - n);
  updateHpUI();
  applyDamageFx();
  if (playerHp <= 0) { startPlayerDeath(dir); return; }
  if (n >= PLAYER_BIGHIT) {   // 大ダメージ: dead03 再生＋吹っ飛ばされる
    triggerOneShot('bighit');
    if (dir) { player.vel.addScaledVector(dir, 55); player.vel.y += 14; playerKnockT = 1.0; }
  } else {
    triggerOneShot('hit');   // 通常被弾: hit_front
  }
}
function startPlayerDeath(dir) {
  playerDead = true; playerDeathT = 0; playerRagOn = false;
  if (gameMode === 'play') ev.pendingOn.add('playerDead');
  player.charging = false; largeBeam.active = false;
  if (grabbedCar) releaseGrab();
  triggerOneShot('bighit');   // dead03 を再生し切ってからラグドール化
  if (dir) { player.vel.addScaledVector(dir, 45); player.vel.y += 12; playerKnockT = 1.0; }
}
function updatePlayerDeath(dt) {
  if (!playerDead) return;
  playerDeathT += dt;
  const dieDur = player.states.bighit ? player.states.bighit.dur : 1.2;
  if (!playerRagOn && playerDeathT >= dieDur) {   // 再生後: ポーズのまま きりもみ落下開始
    playerRagOn = true;
    _pdV2.copy(player.vel).setY(0);
    if (_pdV2.lengthSq() < 1) _pdV2.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    _pdV2.normalize();
    player.tumbleDir = (player.tumbleDir || new THREE.Vector3()).copy(_pdV2);
    _pdAxis.crossVectors(_pdUp, player.tumbleDir).normalize();
    player.tumbleAxis = (player.tumbleAxis || new THREE.Vector3()).copy(_pdAxis);
    player.tumbleSpin = 6 + Math.random() * 3;   // rad/s
  }
  if (playerRagOn) {   // きりもみ落下（アニメはdead03の最終ポーズで固定）
    const gy = groundYAt(player.pos.x, player.pos.z, player.pos.y + 100) + 0.4;
    if (player.pos.y > gy) {
      player.vel.y -= 26 * dt;
      player.vel.x *= Math.max(0, 1 - 0.35 * dt);
      player.vel.z *= Math.max(0, 1 - 0.35 * dt);
      player.pos.addScaledVector(player.vel, dt);
      if (player.pos.y < gy) player.pos.y = gy;
      _pdQ.setFromAxisAngle(player.tumbleAxis, player.tumbleSpin * dt);
      player.vrm.scene.quaternion.premultiply(_pdQ);   // 体ごとくるくる回る
    } else {
      player.pos.y = gy;
      player.vel.set(0, 0, 0);
      if (!playerLandRag) {   // 接地: その場でラグドール化（崩れ落ちる）
        playerLandRag = true;
        try {
          playerRagdoll = playerRagdoll || createRagdoll(player.vrm, playerRagOpts || { gravity: -22, boundsMargin: 0.4 });
          setRagdollActive(playerRagdoll, true);
        } catch (e) { console.warn('着地ラグドール失敗:', e); }
      }
    }
    if (playerLandRag && playerRagdoll) updateRagdoll(playerRagdoll, dt, { floorY: gy - 0.35 });
    player.vrm.scene.position.copy(player.pos);
    player.vrm.update(dt);
  }
  if (gameMode === 'play') {   // 本編: 死亡＝ゲームオーバー→タイトルへ（リロードで全リセット）
    if (playerDeathT >= dieDur + 1.5) showGameOver();
    if (playerDeathT >= dieDur + 5) location.reload();
    return;
  }
  if (playerDeathT >= dieDur + 5) {   // 5秒後にリセット（トレーニング）
    playerDead = false; playerRagOn = false;
    if (playerLandRag && playerRagdoll) setRagdollActive(playerRagdoll, false);
    playerLandRag = false;
    try { player.vrm.humanoid?.resetNormalizedPose?.(); } catch { /* noop */ }
    playerHp = PLAYER_HP_MAX;
    updateHpUI(); applyDamageFx();
    player.pos.set(0, 230, 150); player.vel.set(0, 0, 0);
    player.vrm.scene.position.copy(player.pos);
    player.vrm.scene.rotation.set(0, player.yaw + player.faceOffset, 0);
    player.oneShot = null;
    setState('idle');
  }
}
async function setupDamageFx(bundle, vrm) {   // damage/<npc>.damage.json を読み、部位ごとに溶解を仕込む
  for (const dp of dmgParts) { try { dp.dis.dispose(); } catch { /* noop */ } }
  dmgParts.length = 0;
  dmgWarmT = 5;   // この間は全部位アクティブで描画→ON状態のパイプラインをコンパイル
  playerHp = PLAYER_HP_MAX;
  updateHpUI();
  let cfg = null;
  try { cfg = await (await fetch('../damage/' + PLAYER_NPC.replace(/\.npc\.json$/, '') + '.damage.json')).json(); } catch { /* 設定なし */ }
  dmgExpressions = cfg?.expressions || [];
  if (!cfg?.parts) return;
  // 部位id → メッシュ（damage-editor と同じ命名: メッシュ名＋重複は _n）
  const byId = new Map();
  const seen = new Map();
  vrm.scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    let label = o.name || 'mesh';
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    if (n > 1) label = label + '_' + n;
    byId.set('mesh:' + label, o);
  });
  for (const pc of cfg.parts) {
    if (!pc.enabled) continue;
    const target = pc.kind === 'cloth' ? (player.cloth?.clothMesh || null) : (byId.get(pc.id) || null);
    if (!target) continue;
    try {
      if (pc.kind === 'cloth') buildClothDamageAttrs(bundle.cloth, target.geometry);   // GPUクロスの安定基準（アンカー距離）
      const dis = createDissolve(target, {
        direction: pc.mode, noiseScale: pc.noiseScale, noiseAmt: pc.noiseAmt, edge: pc.edge,
        rimColor: pc.rimColor, rimIntensity: pc.rimIntensity, puddle: false, doubleSide: true, armed: true,
        space: pc.kind === 'cloth' ? 'attributes' : 'geometry',   // 布=dmgPos/dmgH属性・メッシュ=バインド形状（なびきで穴が動かない）
      });
      dmgParts.push({ id: pc.id, kind: pc.kind, dis, range: pc.range || [0, 100] });
    } catch (e) { console.warn('損耗エフェクト生成失敗:', pc.id, e); }
  }
  applyDamageFx();
  console.log('damage fx parts:', dmgParts.map((d) => d.id).join(', '));
}
function updateDamageFx() { /* space:'geometry' 化で高さ基準の毎フレーム供給は不要になった */ }
let npcSwapBusy = false;
async function swapPlayer(sel) {   // sel='file:xxx.npc.json' | 'idb:名前'
  if (npcSwapBusy) return;
  npcSwapBusy = true;
  try {
    try { localStorage.setItem(NPC_SEL_KEY, sel); } catch { /* noop */ }
    disposePlayerModel();
    await loadPlayer();
  } finally { npcSwapBusy = false; }
}
async function loadPlayer() {
  try {
    const bundle = await (await fetch('../npc/' + PLAYER_NPC)).json();   // 従来方式: npc.jsonを直読み
    if (!bundle?.vrm) { showError('プレイヤーVRMが見つかりません'); return; }
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
    const gltf = await loader.loadAsync(vrmUrlOf(bundle));
    const vrm = gltf.userData.vrm;
    vrm.scene.position.copy(player.pos);
    // 正面向き: VRM0系は正面が逆焼き→180°。バンドルの faceOffsetDeg で上書き可
    player.faceOffset = bundle.faceOffsetDeg != null ? bundle.faceOffsetDeg * Math.PI / 180 : (vrm.meta?.metaVersion === '0' ? Math.PI : 0);
    // グラブ点オフセットの正準化: 正規化ボーンはrest回転ゼロのため、オフセットは
    // 「180°ラップされる側（Joy_reborn=VRM0）」基準で作られている。ラップされないモデル
    // （VRM1系=faceOffset≈0）ではX/Zを反転しないと『体の前』が背中側に出る（cloth-previewと同じ規約）
    const gripFlip = Math.cos(player.faceOffset) > 0;
    const _flipO = (o) => { if (Array.isArray(o) && o.length >= 3) { o[0] = -o[0]; o[2] = -o[2]; } };
    if (gripFlip && bundle.cloth) {
      for (const g of (bundle.cloth.gripGroups || [])) _flipO(g.offset);
      if (bundle.cloth.handGrabOffsets) { _flipO(bundle.cloth.handGrabOffsets.left); _flipO(bundle.cloth.handGrabOffsets.right); }
      console.log('grip正準化: このモデルはオフセットX/Z反転を適用');
    }
    // 従来方式: スケール正規化はしない（cloth.jsonの形状/コライダはスケール1前提。
    // 身長合わせが必要ならモデル側かバンドルデータで調整する）
    vrm.scene.rotation.y = player.yaw + player.faceOffset;
    scene.add(vrm.scene); vrm.scene.updateMatrixWorld(true);
    attachCharFill(vrm.scene);   // 正面キー光のみ復活（回り込み光なし）
    player.vrm = vrm;
    player.mixer = new THREE.AnimationMixer(vrm.scene);
    // マント（GPUクロス）。空中でも落ちないよう floorY 無効化
    // ?nocape=1 でマントを生成しない（性能切り分け用: マントが重さの原因かを比較できる）
    if (bundle.cloth && !NO_CAPE) {
      try {
        // lib/vrm-cloth の初期配置は editorTransform.ry しか回さず、モデルの向き(yaw+faceOffset)を知らない。
        // アンカーは初期配置から再導出されるため、向きを ry に合成しないと首元が180°破綻する
        // （Joyはspawn時 yawπ+faceOffsetπ=2π≡0で偶然無事だった）。tx/tz も同じ回転で回す。
        const tr0 = bundle.cloth.editorTransform ?? { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1 };
        const yawDeg = (player.yaw + player.faceOffset) * 180 / Math.PI;
        const c0 = Math.cos((yawDeg) * Math.PI / 180), s0 = Math.sin((yawDeg) * Math.PI / 180);
        const trAdj = { ...tr0, ry: (tr0.ry || 0) + yawDeg,
          tx: (tr0.tx || 0) * c0 - (tr0.tz || 0) * s0,
          tz: (tr0.tx || 0) * s0 + (tr0.tz || 0) * c0 };
        player.cloth = createVRMCloth({ renderer, scene, vrm, cloth: { ...bundle.cloth, editorTransform: trAdj }, basePos: player.pos, floorY: -1e9 });
      }
      catch (e) { console.warn('マント生成失敗:', e); }
    }
    // 飛行アニメ状態（timeline→VRMA→trim）。tps-flight と同じ状態機械
    for (const [name, def] of Object.entries(STATE_DEFS)) {
      try {
        const tl = await (await fetch('../timeline/' + def.tl + '.timeline.json')).json();
        if (gripFlip) for (const trk of (tl.tracks || [])) {   // グラブ点位置キーも正準化（体基準の同位置へ）
          if (trk.kind !== 'gripPos') continue;
          for (const k of (trk.keyframes || [])) _flipO(k.offset);
        }
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
        // 部分ループ（任意）: oneShot保持中に [loopStart,loopEnd] を繰り返す（チャージビーム照射中など）
        const lpS = Number.isFinite(tl.loopStart) ? Math.max(tin, Math.min(tl.loopStart, tout - 1)) : null;
        const lpE = lpS != null ? (Number.isFinite(tl.loopEnd) ? Math.max(lpS + 1, Math.min(tl.loopEnd, tout)) : tout) : null;
        player.states[name] = { action, timeline: tl, fps, dur: clip.duration, loop: def.loop, trimIn: tin, trimOut: tout, total, speed, loopStart: lpS, loopEnd: lpE };
        await createStateEffects(player.states[name], tl);   // timeline の effect トラック（FXエディタ配置）を準備
      } catch (e) { console.warn('状態ロード失敗:', name, e); }
    }
    // 被弾/死亡モーション（タイムライン無しの生VRMA）
    const addRawState = async (name, file) => {
      try {
        const vres = await fetch('../vrma/' + encodeURIComponent(file));
        if (!vres.ok) return;
        const al2 = new GLTFLoader(); al2.register((pl) => new VRMAnimationLoaderPlugin(pl));
        const ag2 = await al2.loadAsync(URL.createObjectURL(await vres.blob()));
        const anims2 = ag2.userData.vrmAnimations;
        if (!anims2?.length) return;
        const clip2 = createVRMAnimationClip(anims2[0], vrm);
        stripRootMotion(clip2);
        const action2 = player.mixer.clipAction(clip2);
        action2.setLoop(THREE.LoopOnce, 1);
        action2.clampWhenFinished = true;
        const total2 = Math.max(1, Math.round(clip2.duration * 30));
        player.states[name] = { action: action2, timeline: null, fps: 30, dur: clip2.duration, loop: false, trimIn: 0, trimOut: total2, total: total2, speed: 1, effects: [] };
      } catch (e) { console.warn('rawState失敗:', name, e); }
    };
    setupPortrait();   // 会話ウィンドウの立体ポートレート
    await addRawState('hit', 'hit_front.vrma');
    await addRawState('bighit', 'dead03.vrma');
    try {
      const rj = await (await fetch('../ragdoll/' + PLAYER_NPC.replace(/\.npc\.json$/, '') + '.ragdoll.json')).json();
      playerRagOpts = { ...(rj.params || {}), boneMaxBend: rj.boneMaxBend || {}, boundsMargin: 0.4 };
    } catch { playerRagOpts = null; }
    const idle = player.states.idle;
    if (idle) { idle.action.play(); idle.action.setEffectiveWeight(1); player.current = 'idle'; if (player.cloth) player.cloth.setTimeline(idle.timeline); }
    camForwardRight();   // TPSカメラ初期化（スナップ回避）
    camTargetCur.copy(player.pos); camTargetCur.y += cam.height;
    camPosCur.copy(camTargetCur).addScaledVector(_fwd, -cam.dist);
    player.ready = true;
    setupDamageFx(bundle, vrm).catch((e) => console.warn('damage fx初期化失敗:', e));
    console.log('player ready; states=', Object.keys(player.states).length);
  } catch (e) { showError('プレイヤー読込失敗: ' + (e?.message || e)); }
}

window.__fly = { get player() { return player; }, get camera() { return camera; }, gp, attritionPct, cityDamagePct, startMode, get mode() { return gameMode; }, ev, queueTalk, addKill, scn, playScenario, addWanted, get portraitOn() { return portraitOn; }, get portraitStage() { return portraitStage; }, guests: portraitGuests, talkWho: () => portraitWho, get portraitCam() { return portraitCam; }, get portraitLip() { return portraitLip; }, get flowNode() { return flowNode; }, swapPlayer, idbPutNpc, npcSelection, playerDamage, get hp() { return playerHp; }, get dmgParts() { return dmgParts; }, get hour() { return gameHour; }, setHour: (h) => { gameHour = h; }, get trains() { return trains; }, get railPath() { return railPath; }, get cars() { return cars; }, get roadNodes() { return roadNodes; }, get edgeKinds() { return edgeKindByPair; }, get police() { return police; }, get port() { return portShip; }, breakCar };
// ── キャラ選択パネル（👤ボタン）──
function setupCharUI() {
  const btn = document.createElement('button');
  btn.textContent = '👤 キャラ';
  btn.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:30;background:#25304a;border:1px solid #46608c;color:#cfe;border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;';
  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;position:fixed;left:12px;bottom:56px;z-index:31;background:rgba(14,18,30,0.95);border:1px solid #46608c;border-radius:8px;padding:10px 12px;font-size:13px;color:#cfe;width:270px;max-height:60vh;overflow-y:auto;';
  panel.innerHTML = '<div style="font-weight:bold;color:#9fe6ff;margin-bottom:6px;">プレイヤーキャラ交換</div>'
    + '<div id="char-list"></div>'
    + '<div style="border-top:1px solid #345;margin-top:8px;padding-top:8px;">'
    + '<button id="char-import" style="width:100%;">＋ VRMファイルを読み込む</button>'
    + '<input type="file" id="char-file" accept=".vrm" style="display:none;">'
    + '<div style="font-size:11px;color:#9ab;margin-top:4px;">操作・攻撃・マント・アニメはそのまま、モデルだけ入れ替わります。読み込んだVRMはブラウザに保存され次回も選べます。</div></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);
  const refresh = async () => {
    const list = panel.querySelector('#char-list');
    const sel = npcSelection();
    let files = [PLAYER_NPC];
    try { const r = await fetch('../npc/manifest.json'); if (r.ok) { const mj = await r.json(); if (Array.isArray(mj.players) && mj.players.length) files = mj.players; } } catch { /* 既定のみ */ }
    const customs = await idbListNpc().catch(() => []);
    const row = (key, label, del) => '<div style="display:flex;gap:4px;align-items:center;margin-top:3px;">'
      + '<button data-sel="' + key + '" style="flex:1;text-align:left;background:' + (sel === key ? '#3d6b46' : '#25304a') + ';border:1px solid #46608c;color:#cfe;border-radius:4px;padding:5px 8px;cursor:pointer;">' + (sel === key ? '✓ ' : '') + label + '</button>'
      + (del ? '<button data-del="' + key.slice(4) + '" style="background:#5a2a2a;border:1px solid #845;color:#fcc;border-radius:4px;cursor:pointer;">🗑</button>' : '') + '</div>';
    list.innerHTML = files.map((f) => row('file:' + f, f.replace(/\.npc\.json$/, ''), false)).join('')
      + customs.map((c) => row('idb:' + c, '📦 ' + c, true)).join('');
    for (const b of list.querySelectorAll('[data-sel]')) b.addEventListener('click', async () => { b.textContent = '読込中…'; await swapPlayer(b.dataset.sel); refresh(); });
    for (const b of list.querySelectorAll('[data-del]')) b.addEventListener('click', async () => { await idbDelNpc(b.dataset.del); if (npcSelection() === 'idb:' + b.dataset.del) await swapPlayer('file:' + PLAYER_NPC); refresh(); });
  };
  btn.addEventListener('click', () => { const on = panel.style.display === 'none'; panel.style.display = on ? 'block' : 'none'; if (on) refresh(); });
  panel.querySelector('#char-import').addEventListener('click', () => panel.querySelector('#char-file').click());
  panel.querySelector('#char-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.vrm$/i, '');
    const dataUri = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
    // マントは既定キャラのものを流用（細かい調整は fps-cloth-vrm でバンドルを作って npc/ へ）
    let cloth = null;
    try { cloth = (await (await fetch('../npc/' + PLAYER_NPC)).json()).cloth || null; } catch { /* マント無し */ }
    const bundle = { format: 'fps-npc-bundle', version: 1, name, vrm: dataUri, cloth, vrma: null, timeline: null };
    await idbPutNpc(name, bundle);
    await swapPlayer('idb:' + name);
    refresh();
    e.target.value = '';
  });
}
// setupCharUI();   // キャラ交換UIは一旦停止（PLAYER_NPC固定）
function camForwardRight() {
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  _fwd.set(cp * Math.sin(camYaw), sp, cp * Math.cos(camYaw)).normalize();
  _right.set(-_fwd.z, 0, _fwd.x).normalize();
}
function updateFlight(dt) {
  if (!player.ready) return;
  if (playerDead) {   // 死亡中: 操作不能。ラグドール前は吹っ飛びの慣性で流れる
    if (!playerRagOn) {
      player.vel.multiplyScalar(Math.max(0, 1 - 1.5 * dt));
      player.pos.addScaledVector(player.vel, dt);
      player.vrm.scene.position.copy(player.pos);
    }
    return;
  }
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
  if (playerHp <= PLAYER_HP_MAX * 0.25 && !player.grounded && !player.eating) {
    player.vel.y -= 7 * dt;   // 重傷(25%以下): 浮遊を維持できず徐々に沈む（上昇入力で抗える）
  }
  if (playerKnockT > 0) playerKnockT = Math.max(0, playerKnockT - dt);
  clampSpeed(player.vel, flight.maxSpeed + playerKnockT * 70);   // 吹っ飛び中は一時的に上限解放
  player.pos.addScaledVector(player.vel, dt);
  player.grounded = false;
  if (interior.active) interiorClamp();   // 内装内は部屋境界と床でクランプ
  else {
    if (KENNEY_CITY) collidePlayer();   // 建物と衝突→押し出し・屋上着地
    groundCollide();                    // 地面(地形)に着地
  }
  player.vrm.scene.position.copy(player.pos);
  player.vrm.scene.rotation.y = player.yaw + player.faceOffset;
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
  const idleName = playerHp <= PLAYER_HP_MAX * GROGGY_HP ? 'groggy' : 'idle';   // 低HPの静止はぐったりモーション
  if (isHolding()) return moving ? 'grabMove' : idleName;
  const fwd = keysDown['KeyW'] || keysDown['ArrowUp'];
  if (fwd && player.fwdY < -DESCEND_SIN) return 'frontDown';
  if (fwd) return 'fwd';
  if (keysDown['KeyS'] || keysDown['ArrowDown']) return 'back';
  if (keysDown['KeyA'] || keysDown['ArrowLeft']) return 'left';
  if (keysDown['KeyD'] || keysDown['ArrowRight']) return 'right';
  return idleName;
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
// 部分ループ: oneShot 保持中は timeline の [loopStart,loopEnd] を繰り返し、
// 残り保持時間が尾部（loopEnd→trimOut）ぶんを切ったら通し再生に移って自然に終わる
function applyHoldLoop() {
  const st = player.states[player.current];
  if (!st || st.loopStart == null || !player.oneShot || player.oneShot.name !== player.current) return;
  const sT = st.loopStart / st.fps, eT = st.loopEnd / st.fps;
  const tailT = (st.trimOut / st.fps - eT) / (st.speed || 1);
  if (player.oneShot.until <= tailT + 1e-3) return;   // 尾部再生フェーズ
  const a = st.action;
  if (a.time >= eT) { a.time = sT + ((a.time - sT) % Math.max(1e-3, eT - sT)); player.mixer.update(0); }
}
function updatePlayerAnim(dt) {
  if (!player.ready) return;
  if (player.eating) { updatePlayerEating(dt); return; }   // 捕食中は feed のみ駆動
  if (player.oneShot) {
    player.oneShot.until -= dt;
    if (player.oneShot.until <= 0) { player.oneShot = null; if (!largeBeam.active) attackAimActive = false; }   // 攻撃終了で照準固定を解除
  }
  if (player.charging) {
    player.chargeT = Math.min(ULT_CHARGE_TIME, player.chargeT + dt);   // 1.5s超も蓄積＝ゲージ（満タンでアルティメット）
    // 接地中＋捕食対象なし＝長押しがトーテム設置に化ける（空中はチャージ→large_beam/アルティメット）
    if (player.chargeT >= TAP_THRESHOLD && player.grounded && !player.prey && !grabbedCar && !totemCast) {
      player.charging = false;
      startTotemCast();
    }
  }
  {   // チャージゲージHUD
    const g = $('gauge');
    if (g) {
      if (player.charging && player.chargeT >= TAP_THRESHOLD) {
        g.style.display = 'block';
        const f = Math.min(1, player.chargeT / ULT_CHARGE_TIME);
        $('gauge-fill').style.width = (f * 100) + '%';
        g.classList.toggle('full', f >= 1);
      } else g.style.display = 'none';
    }
  }
  setState(desiredState());
  player.mixer.update(dt);
  applyHoldLoop();
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
  _efQuat.setFromAxisAngle(_EF_UP, player.yaw + player.faceOffset);
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
    _efQuat.setFromAxisAngle(_EF_UP, player.yaw + player.faceOffset);
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
  _efQuat.setFromAxisAngle(_EF_UP, player.yaw + player.faceOffset);
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
function spawnImpactFx(pos, scale = 1) {
  if (!impactFx.length) return;
  let slot = impactFx.find((s) => s.until <= 0);
  if (!slot) { slot = impactFx[0]; for (const s of impactFx) if (s.until < slot.until) slot = s; }
  if (slot.fire) {
    slot.fire.object3D.scale.setScalar(IMPACT_SCALE * scale);   // スーパー/落雷は3倍等（プール再利用なので毎回設定）
    slot.fire.object3D.position.copy(pos);
    slot.fire.object3D.visible = true;
    slot.fire.burst(scale > 1 ? 5 : 3);
  }
  slot.smoke.object3D.position.copy(pos);
  slot.smoke.object3D.visible = true;
  slot.smoke.burst(scale > 1 ? 22 : 10);
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
  if (mapTerrain && mapRoads.length) { buildMapRoads(); await finishRoads(); return; }   // 自作道路（M2）
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
    const local = llaToLocal(ll[1], ll[0], 0.5);   // 経緯度→ローカルENU
    if (mapTerrain) local.y = mapTerrain.heightAt(local.x, local.z) + 0.5;   // 路面=マップ地形+0.5m
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
  await finishRoads();
}
// 道路グラフ確定後の共通処理（実体化・車・ライト・路面インデックス）
async function finishRoads() {
  buildRoadSurfIndex();
  await buildRoadMeshes().catch((e) => { console.warn('道路メッシュ生成失敗（デバッグ線で代替）:', e); drawRoadLines(); });
  try { buildMapBridges(); } catch (e) { console.warn('橋の生成失敗:', e); }
  try { await buildMapRails(); } catch (e) { console.warn('鉄道の生成失敗:', e); }
  try { await buildMapPort(); } catch (e) { console.warn('埠頭の生成失敗:', e); }
  if (!NO_NPC) await spawnCars();   // 性能切り分け: ?nonpc=1 で車を出さない
  try { buildCarLights(); } catch (e) { console.warn('車ライト生成失敗', e); }
  console.log('roads center nodes', roadNodes.size, 'edges', activeEdges.length, 'cars', cars.length);
}
// ── 埠頭（.map.json port）: 岸壁＋コンテナ置き場＋接岸した客船（船は掴み/破壊対象）──
let portShip = null;   // {mesh, proxy, home:{x,y,z,ry}, respawnT}
async function buildMapPort() {
  if (!mapPort || !mapTerrain) return;
  const [px0, pz0, px1, pz1] = mapPort.rect;
  const loader = new GLTFLoader();
  const loadW = async (name) => {   // waterfrontキット: 底面0・XZ中心へ正規化
    const a = bakeModel((await loader.loadAsync(new URL('../models/waterfront_GLB%20format/' + name + '.glb', location.href).href)).scene);
    const g = a.geometry.clone();
    g.computeBoundingBox();
    let b = g.boundingBox;
    if ((b.max.z - b.min.z) > (b.max.x - b.min.x)) { g.rotateY(Math.PI / 2); g.computeBoundingBox(); b = g.boundingBox; }   // 長軸→X
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    return { g, mat: a.material, size: b.getSize(new THREE.Vector3()) };
  };
  const grp = new THREE.Group();
  const conc = new THREE.MeshStandardMaterial({ color: 0x8e9298, roughness: 0.9 });
  const quay = new THREE.Mesh(new THREE.BoxGeometry(px1 - px0, 4.0, 2.4), conc);   // 海側の岸壁
  quay.position.set((px0 + px1) / 2, (mapPort.h || 2.6) - 1.8, pz1 - 0.8);
  grp.add(quay);
  // コンテナ置き場（cargo-container-a を積み上げ）
  try {
    const cont = await loadW('cargo-container-a');
    const cs = 6.2 / Math.max(0.01, cont.size.x);
    const cl = 6.2, cw = cont.size.z * cs, ch = cont.size.y * cs;
    const spots = [];
    let seed = 20260825;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const yd of (mapPort.containers || [])) {
      const cols = Math.floor((yd.x1 - yd.x0) / (cl + 0.6));
      for (let i = 0; i < cols; i++) {
        for (let r = 0; r < 2; r++) {
          const st = 1 + Math.floor(rnd() * 3);   // 1〜3段
          for (let s = 0; s < st; s++) spots.push([yd.x0 + (i + 0.5) * (cl + 0.6), (mapPort.h || 2.6) + s * ch, yd.z + r * (cw + 1.0)]);
        }
      }
    }
    const im = new THREE.InstancedMesh(cont.g, cont.mat, spots.length);
    im.frustumCulled = false;
    const _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _cs2 = new THREE.Vector3(cs, cs, cs), _cp = new THREE.Vector3();
    for (let i = 0; i < spots.length; i++) { _cp.set(spots[i][0], spots[i][1], spots[i][2]); _cm.compose(_cp, _cq, _cs2); im.setMatrixAt(i, _cm); }
    grp.add(im);
    console.log('port: containers', spots.length);
  } catch (e) { console.warn('コンテナ生成失敗:', e); }
  // 客船（接岸・掴み/破壊対象）
  try {
    const ship = await loadW('ship-ocean-liner');
    const ss = (mapPort.ship && mapPort.ship.len || 150) / Math.max(0.01, ship.size.x);
    const beam = ship.size.z * ss;
    const mesh = new THREE.Mesh(ship.g, ship.mat);
    mesh.scale.setScalar(ss);
    mesh.position.set((mapPort.ship && mapPort.ship.x) || (px0 + px1) / 2, -ship.size.y * ss * 0.10, pz1 + beam / 2 + 4);
    mesh.frustumCulled = false;
    grp.add(mesh);
    portShip = { mesh, proxy: { mesh, hitR: Math.max(20, beam * 0.8), ship: true }, home: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }, respawnT: 0 };
    mesh.userData.car = portShip.proxy;
    console.log('port: ship len', Math.round(ship.size.x * ss), 'beam', Math.round(beam));
  } catch (e) { console.warn('客船生成失敗:', e); }
  scene.add(grp);
}
function updatePort(dt) {
  if (!portShip || !portShip.proxy.dead) return;
  portShip.respawnT -= dt;
  if (portShip.respawnT <= 0) {   // しばらくして再入港
    const p = portShip.proxy;
    p.dead = false; p.thrown = false; p.grabbed = false; p.vel = null;
    portShip.mesh.visible = true;
    portShip.mesh.position.set(portShip.home.x, portShip.home.y, portShip.home.z);
    portShip.mesh.rotation.set(0, 0, 0);
  }
}
// 橋の簡易モデル（mapplan: 平橋=床版+欄干+橋脚 / アーチ橋=単純ポリゴンの上路アーチ+川中の支柱）
function buildMapBridges() {
  if (!mapBridges.length) return;
  const conc = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a3a34, roughness: 0.5, metalness: 0.35 });
  const grpAll = new THREE.Group();
  for (const br of mapBridges) {
    const g2 = new THREE.Group();
    g2.position.set(br.x, 0, br.z);
    g2.rotation.y = Math.atan2(br.dx, br.dz);   // ローカル+z=橋の進行方向
    const L = br.len + 12, W = br.w;
    const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g2.add(m); return m; };
    box(W, 0.7, L, conc, 0, br.deckY - 0.35, 0);                    // 床版
    box(0.3, 0.9, L, conc, W / 2 - 0.2, br.deckY + 0.45, 0);        // 欄干
    box(0.3, 0.9, L, conc, -(W / 2 - 0.2), br.deckY + 0.45, 0);
    const pier = (zAlo, r) => {                                     // 橋脚（川底まで）
      const h = br.deckY - 0.3 - (br.bedY - 1);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.2, h, 10), conc);
      m.position.set(0, br.bedY - 1 + h / 2, zAlo);
      g2.add(m);
    };
    if (br.kind === 'flat') {
      if (L > 60) { pier(-L / 4, 1.0); pier(L / 4, 1.0); } else pier(0, 1.0);
    } else {
      pier(-L / 4, 1.6); pier(L / 4, 1.6);                          // 川の中の支柱
      const bot = Math.max(br.bedY + 0.6, br.wl - 1.2);             // アーチ端部の最下端
      const N = 12;
      for (const sideX of [W / 2 - 0.6, -(W / 2 - 0.6)]) {
        let prev = null;
        for (let i = 0; i <= N; i++) {
          const t = i / N, zAlo = (t - 0.5) * L;
          const y = bot + (br.deckY - 0.7 - bot) * (1 - Math.pow(2 * t - 1, 2));   // 上路アーチ（中央で床版に接する放物線）
          if (prev) {
            const dz2 = zAlo - prev.z, dy2 = y - prev.y, segL = Math.hypot(dz2, dy2);
            const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, segL + 0.12), steel);
            m.position.set(sideX, (y + prev.y) / 2, (zAlo + prev.z) / 2);
            m.rotation.x = -Math.atan2(dy2, dz2);
            g2.add(m);
          }
          if (i % 3 === 0 && i > 0 && i < N) {                      // 鉛直材（アーチ→床版）
            const h2 = br.deckY - 0.7 - y;
            if (h2 > 0.5) box(0.3, h2, 0.3, steel, sideX, y + h2 / 2, zAlo);
          }
          prev = { z: zAlo, y };
        }
      }
    }
    grpAll.add(g2);
  }
  scene.add(grpAll);
  console.log('bridges:', mapBridges.length);
}
// ── 鉄道: 複線レール＋高架（デッキ+円柱橋脚）＋駅ホーム＋列車の定期運行（.map.json rails）──
let railPath = null;     // {pts,cum,total,gauge,stations:[{name,arc,y}]}
const trains = [];       // {cars:[{mesh,len}], track(-1/1), dir(1/-1), arc, speed, stopT}
const _tp = new THREE.Vector3(), _tt = new THREE.Vector3(), _tpr = new THREE.Vector3(), _ttN = new THREE.Vector3();
const _trm = new THREE.Matrix4(), _upT = new THREE.Vector3(0, 1, 0), _zeroT = new THREE.Vector3();
async function buildMapRails() {
  if (!mapRails.length || !mapRails[0].points || mapRails[0].points.length < 2) return;
  const line = mapRails[0];
  const pts = line.points.map((p) => new THREE.Vector3(p[0], p[2], p[1]));   // 保存形式は [x,z,y]
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  railPath = { pts, cum, total: cum[cum.length - 1], gauge: line.gauge || 5.2, stations: [] };
  for (const st of (line.stations || [])) {
    let bi = 0, bd = 1e9;
    for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i].x - st.x, pts[i].z - st.z); if (d < bd) { bd = d; bi = i; } }
    railPath.stations.push({ name: st.name, x: pts[bi].x, z: pts[bi].z, arc: cum[bi], y: pts[bi].y });
  }
  const grp = new THREE.Group();
  const loader = new GLTFLoader();
  const loadTrainGlb = async (name) => bakeModel((await loader.loadAsync(new URL('../models/train_GLB%20format/' + name + '.glb', location.href).href)).scene);
  // レールタイル正規化: 長軸→Z・XZ中心・底面0
  const railAsset = await loadTrainGlb('railroad-straight');
  const g0 = railAsset.geometry.clone();
  g0.computeBoundingBox();
  let bb = g0.boundingBox;
  if ((bb.max.x - bb.min.x) > (bb.max.z - bb.min.z)) g0.rotateY(Math.PI / 2);
  g0.computeBoundingBox(); bb = g0.boundingBox;
  g0.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const tileW = Math.max(0.01, bb.max.x - bb.min.x), tileL = Math.max(0.01, bb.max.z - bb.min.z);
  const TRACK_W = 4.2, half = railPath.gauge / 2;
  const segs = pts.length - 1;
  const railIM = new THREE.InstancedMesh(g0, railAsset.material, segs * 2);
  railIM.frustumCulled = false;
  const _m2 = new THREE.Matrix4(), _q2 = new THREE.Quaternion(), _p2 = new THREE.Vector3(), _s2 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _rm2 = new THREE.Matrix4();
  const elev = [];
  let n = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[i + 1];
    _d2.copy(b).sub(a);
    const len = _d2.length() || 1;
    _d2.normalize();
    _rm2.lookAt(_zeroT, _d2, _upT);
    _q2.setFromRotationMatrix(_rm2);
    _tpr.set(-_d2.z, 0, _d2.x).normalize();   // 水平垂直（複線オフセット）
    for (const side of [-1, 1]) {
      _p2.copy(a).addScaledVector(_d2, len / 2).addScaledVector(_tpr, half * side);
      _s2.set(TRACK_W / tileW, TRACK_W / tileW, len / tileL * 1.002);
      _m2.compose(_p2, _q2, _s2);
      railIM.setMatrixAt(n++, _m2);
    }
    const midY = (a.y + b.y) / 2, ter = mapTerrain ? mapTerrain.heightAt((a.x + b.x) / 2, (a.z + b.z) / 2) : 0;
    if (midY - ter > 2.5) elev.push({ a, b, len, q: _q2.clone(), midY });
  }
  grp.add(railIM);
  if (elev.length) {   // 高架: デッキ＋40m毎の円柱橋脚
    const concM = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.85 });
    const deckIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), concM, elev.length);
    deckIM.frustumCulled = false;
    let k = 0;
    for (const e of elev) {
      _p2.copy(e.a).lerp(e.b, 0.5); _p2.y -= 0.55;
      _s2.set(railPath.gauge + 4.6, 1.0, e.len + 0.4);
      _m2.compose(_p2, e.q, _s2);
      deckIM.setMatrixAt(k++, _m2);
    }
    grp.add(deckIM);
    const piers = elev.filter((_, i2) => i2 % 4 === 0);
    const pierIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.12, 1, 10), concM, piers.length);
    pierIM.frustumCulled = false;
    k = 0;
    _q2.identity();
    for (const e of piers) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      const gy = (mapTerrain ? mapTerrain.heightAt(mx, mz) : 0) - 1.5;
      const h = Math.max(1, e.midY - 1.0 - gy);
      _p2.set(mx, gy + h / 2, mz);
      _s2.set(1.5, h, 1.5);
      _m2.compose(_p2, _q2, _s2);
      pierIM.setMatrixAt(k++, _m2);
    }
    grp.add(pierIM);
  }
  // 駅: 相対式ホーム2面＋屋根（高架駅は自動で高架上）
  const platM = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.9 });
  const roofM = new THREE.MeshStandardMaterial({ color: 0x4a6b8a, roughness: 0.6 });
  for (const st of railPath.stations) {
    let bi = 0, bd = 1e9;
    for (let i = 0; i < segs; i++) { const d = Math.hypot((pts[i].x + pts[i + 1].x) / 2 - st.x, (pts[i].z + pts[i + 1].z) / 2 - st.z); if (d < bd) { bd = d; bi = i; } }
    _d2.copy(pts[bi + 1]).sub(pts[bi]).normalize();
    _rm2.lookAt(_zeroT, _d2, _upT);
    const sg = new THREE.Group();
    sg.position.set(st.x, st.y, st.z);
    sg.quaternion.setFromRotationMatrix(_rm2);
    const off = half + TRACK_W / 2 + 1.5;
    for (const side of [-1, 1]) {
      const px2 = off * side;
      const plat = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 62), platM);
      plat.position.set(px2, -0.15, 0); sg.add(plat);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.22, 58), roofM);
      roof.position.set(px2, 3.7, 0); sg.add(roof);
      for (const zz of [-24, 0, 24]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.3, 8), platM);
        post.position.set(px2, 2.0, zz); sg.add(post);
      }
    }
    grp.add(sg);
  }
  // 列車: train-electric-city（a=先頭/末尾・b/c=客車）×2編成（上り/下り）
  const CAR_LEN = 14;
  const carGeo = {};
  for (const nm of ['a', 'b', 'c']) {
    const asset = await loadTrainGlb('train-electric-city-' + nm);
    const g = asset.geometry.clone();
    g.computeBoundingBox(); let b2 = g.boundingBox;
    if ((b2.max.x - b2.min.x) > (b2.max.z - b2.min.z)) g.rotateY(Math.PI / 2);
    g.computeBoundingBox(); b2 = g.boundingBox;
    g.translate(-(b2.min.x + b2.max.x) / 2, -b2.min.y, -(b2.min.z + b2.max.z) / 2);
    const s = CAR_LEN / Math.max(0.01, b2.max.z - b2.min.z);
    g.scale(s, s, s);
    carGeo[nm] = { g, mat: asset.material };
  }
  for (const [track, dir] of [[-1, 1], [1, -1]]) {
    const tcars = [];
    for (const [nm, flip] of [['a', true], ['b', true], ['c', true], ['b', true], ['a', false]]) {   // 先頭a+客車3両+末尾a（基準向きは実物合わせで反転済み）
      const g = carGeo[nm].g.clone();
      if (flip) { g.rotateY(Math.PI); g.computeBoundingBox(); }
      const mesh = new THREE.Mesh(g, carGeo[nm].mat);
      mesh.frustumCulled = false;
      grp.add(mesh);
      const c = { mesh, len: CAR_LEN, proxy: { mesh, hitR: 7.5, trainCar: true, tRef: null } };
      mesh.userData.car = c.proxy;   // 照準レイの掴みでプロキシへ辿れるように
      tcars.push(c);
    }
    const tr = { cars: tcars, track, dir, arc: railPath.total * (dir > 0 ? 0.35 : 0.65), speed: 0, stopT: 0, state: 'run', heldIdx: 0, wreckT: 0 };
    tcars.forEach((c, i) => { c.proxy.tRef = { tr, i }; });
    trains.push(tr);
  }
  scene.add(grp);
  console.log('rails:', pts.length, 'pts /', Math.round(railPath.total) + 'm / 高架', elev.length, 'seg / 駅', railPath.stations.length, '/ 列車', trains.length, '編成');
}
function railPosAt(arc, out, tan) {
  const { pts, cum, total } = railPath;
  arc = Math.max(0, Math.min(total, arc));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= arc) lo = mid; else hi = mid; }
  const t = (arc - cum[lo]) / Math.max(0.001, cum[lo + 1] - cum[lo]);
  out.copy(pts[lo]).lerp(pts[lo + 1], t);
  if (tan) tan.copy(pts[lo + 1]).sub(pts[lo]).normalize();
  return out;
}
// 電車の掴み: 掴んだ車両がアンカー、残りの車両は連結距離を保ってぶら下がる（verletチェーン）
const TRAIN_LINK = 14.7;
function ensureCarPhys(c) {
  if (!c.p) { c.p = c.mesh.position.clone(); c.pv = c.p.clone(); }
  else { c.p.copy(c.mesh.position); }
}
function beginTrainHold(proxy) {
  const { tr, i } = proxy.tRef;
  tr.state = 'held'; tr.heldIdx = i;
  for (const c of tr.cars) { ensureCarPhys(c); c.pv.copy(c.p); c.crashed = false; }
}
function wreckTrain(tr) {
  if (tr.state === 'wreck') return;
  for (const c of tr.cars) ensureCarPhys(c);
  tr.state = 'wreck'; tr.wreckT = 0;
}
function resetTrain(tr) {
  tr.state = 'run'; tr.wreckT = 0; tr.speed = 0; tr.stopT = 3;
  tr.arc = railPath.total * (0.2 + Math.random() * 0.6);
  tr.dir = Math.random() < 0.5 ? 1 : -1;
  for (const c of tr.cars) {
    c.mesh.visible = true; c.crashed = false; delete c.p; delete c.pv;
    c.proxy.dead = false; c.proxy.thrown = false; c.proxy.grabbed = false; c.proxy.vel = null;
  }
}
function trainCarOrient(c, dirV) {   // 車両の長軸(Z)をチェーン方向へ（真下向きでもlookAtが破綻しないようupを切替）
  _upT.set(Math.abs(dirV.y) > 0.93 ? 1 : 0, Math.abs(dirV.y) > 0.93 ? 0 : 1, 0);
  _trm.lookAt(_zeroT, dirV, _upT);
  c.mesh.quaternion.setFromRotationMatrix(_trm);
}
function updateTrainChain(tr, dt) {
  const held = tr.cars[tr.heldIdx];
  held.p && held.p.copy(held.mesh.position);   // アンカー＝掴み/投擲で動く車両
  const arms = [[], []];
  for (let k = tr.heldIdx - 1; k >= 0; k--) arms[0].push(tr.cars[k]);
  for (let k = tr.heldIdx + 1; k < tr.cars.length; k++) arms[1].push(tr.cars[k]);
  const g2 = 30 * dt * dt;
  for (const arm of arms) {
    let prev = held.mesh.position;
    for (const c of arm) {
      ensureCarPhys(c);
      _tp.copy(c.p);                       // verlet積分
      c.p.multiplyScalar(2).sub(c.pv);
      c.p.y -= g2;
      c.pv.copy(_tp);
      _tt.copy(c.p).sub(prev);             // 連結距離を厳守（上側固定の片側拘束）
      const d = _tt.length() || 1;
      c.p.copy(prev).addScaledVector(_tt, TRAIN_LINK / d);
      const gy = groundYAt(c.p.x, c.p.z, c.p.y + 50) ?? -1000;
      if (c.p.y < gy + 1.2) { c.p.y = gy + 1.2; c.pv.lerp(c.p, 0.25); }   // 接地したら擦って減衰
      c.mesh.position.copy(c.p);
      _tt.copy(prev).sub(c.p).normalize();
      trainCarOrient(c, _tt);
      prev = c.p;
    }
  }
}
function updateTrainWreck(tr, dt) {
  tr.wreckT += dt;
  const g2 = 32 * dt * dt;
  for (const c of tr.cars) {
    if (!c.mesh.visible || !c.p) continue;
    _tp.copy(c.p);
    c.p.multiplyScalar(2).sub(c.pv);
    c.p.y -= g2;
    c.pv.copy(_tp);
    const gy = groundYAt(c.p.x, c.p.z, c.p.y + 50) ?? -1000;
    if (c.p.y < gy + 1.0) {
      c.p.y = gy + 1.0;
      c.pv.copy(c.p).lerp(c.pv, 0.4);   // 摩擦
      if (!c.crashed) { c.crashed = true; spawnBreakFx(c.p); }
    }
    c.mesh.position.copy(c.p);
  }
  if (tr.wreckT > 18) resetTrain(tr);
}
function updateTrains(dt) {
  if (!railPath || !trains.length) return;
  const VMAX = 18, ACC = 4;
  for (const tr of trains) {
    if (tr.state === 'held' || tr.state === 'thrownChain') { updateTrainChain(tr, dt); continue; }
    if (tr.state === 'wreck') { updateTrainWreck(tr, dt); continue; }
    if (tr.stopT > 0) { tr.stopT -= dt; tr.speed = 0; }
    else {
      let nextSta = null, bestD = 1e9;   // 進行方向の次の停車目標
      for (const st of railPath.stations) {
        const d = (st.arc - tr.arc) * tr.dir;
        if (d > 0.5 && d < bestD) { bestD = d; nextSta = st; }
      }
      const endD = tr.dir > 0 ? railPath.total - tr.arc : tr.arc;
      const stopD = Math.min(nextSta ? bestD : 1e9, endD);
      const vMax = Math.min(VMAX, Math.sqrt(Math.max(0.25, 2 * ACC * Math.max(0, stopD - 0.3))));
      tr.speed = Math.min(vMax, tr.speed + ACC * dt);
      tr.arc += tr.speed * tr.dir * dt;
      if (nextSta && (nextSta.arc - tr.arc) * tr.dir <= 0.4) { tr.arc = nextSta.arc; tr.stopT = 7; }
      else if (endD <= 0.5) { tr.dir *= -1; tr.stopT = 9; }   // 終端で折返し
    }
    for (let i = 0; i < tr.cars.length; i++) {   // 先頭=arc、後続は車長+連結間隔で追従
      const c = tr.cars[i];
      railPosAt(tr.arc - tr.dir * i * (c.len + 0.7), _tp, _tt);
      _tpr.set(-_tt.z, 0, _tt.x).normalize();
      c.mesh.position.copy(_tp).addScaledVector(_tpr, railPath.gauge / 2 * tr.track);
      c.mesh.position.y += 0.3;
      _trm.lookAt(_zeroT, tr.dir > 0 ? _tt : _ttN.copy(_tt).negate(), _upT);
      c.mesh.quaternion.setFromRotationMatrix(_trm);
    }
  }
}
// 橋の上の道路ノードはデッキ高へ持ち上げる（アーチ橋は緩いキャンバー付き）
function bridgeY(x, z, ty) {
  for (const br of mapBridges) {
    const alo = (x - br.x) * br.dx + (z - br.z) * br.dz;
    const per = -(x - br.x) * br.dz + (z - br.z) * br.dx;
    if (Math.abs(alo) > br.len / 2 + 10 || Math.abs(per) > br.w / 2 + 4) continue;
    const camber = br.kind === 'arch' ? Math.cos(Math.PI * alo / (br.len + 24)) * 1.1 : 0;
    return Math.max(ty, br.deckY + camber + 0.5);
  }
  return ty;
}
// .map.json のスプライン → roadNodes/activeEdges（吸着済み制御点＝交差点ノード）
function buildMapRoads() {
  const g = buildRoadGraph(mapRoads);
  roadNodes = new Map();
  for (const [id, n] of g.nodes) {
    const ty = mapTerrain.heightAt(n.x, n.z) + 0.5;
    roadNodes.set(id, { local: new THREE.Vector3(n.x, bridgeY(n.x, n.z, ty), n.z), adj: n.adj });
  }
  activeEdges = [];
  edgeKindByPair.clear();
  for (const [aId, bId, kind] of g.edges) {
    const a = roadNodes.get(aId).local, b = roadNodes.get(bId).local;
    activeEdges.push({ aId, bId, a, b, len: a.distanceTo(b), kind });
    if (kind) edgeKindByPair.set(aId < bId ? aId + '|' + bId : bId + '|' + aId, kind);
  }
  console.log('map roads:', mapRoads.length, 'splines →', roadNodes.size, 'nodes /', activeEdges.length, 'edges');
}
// ── P2: 道路の実体化＋街灯 ─────────────────────────────────────
// OSM実道路は任意角度なので Kenney の road-straight を「エッジ長に引き伸ばし」てインスタンス配置。
// 交差点ノードは円パッチで繋ぎ、街灯(light-curved)を等間隔配置＋夜だけ光る発光点を Points で重ねる。
const ROAD_WIDTH = 7.0;        // 道路幅(m)
const AVE_DUAL_OFF = ROAD_WIDTH / 2 + 0.8;   // 幹線(avenue)の上下線オフセット＝車線中心（描画と車の走行で共用）
const edgeKindByPair = new Map();            // 'aId|bId'(小さい方が先) -> kind。車の車線振り分け用（buildMapRoadsで構築）
const ROAD_LIFT = 0.12;        // 地形からの浮かせ量（z-fighting回避）
const USE_BENDS = false;       // カーブタイル: 任意角度だと向きが合わず不評→無効化（trueで復活）
const BEND_BASE = 0;           // road-bend-sidewalk の基準向き（ズレたら±90°単位で調整）
const TEE_BASE = 0;            // road-intersection-path の枝方向の基準（同上）
const SIGNAL_HEIGHT = 5.2;     // 信号機(light-square)の高さ(m)
const MAX_SIGNALS = 6000;      // 信号ポール上限。八王子1600m圏で~3,900本必要（900では地域偏りで大半の交差点に立たなかった）
const BARRIER_MIN_EDGE = 80;   // これ以上長いエッジは road-straight-barrier（ガードレール付き）
const XING_SPACING = 170;      // 横断歩道(road-crossing)の間隔(m)
const MAX_XINGS = 1200;
const LIGHT_SPACING = 42;      // 街灯間隔(m)
const LIGHT_HEIGHT = 5.5;      // 街灯の高さ(m)
const MAX_LIGHTS = 6000;   // 八王子1600m圏で実測4,126本必要（3000では郊外が頭打ちで消えていた）
let streetGlowMat = null;
let roadGroup = null;          // 道路一式（将来、地形編集時に丸ごと再構築するための入れ物）
// ── 路面の高さ問い合わせ: 道路タイルは地形より~0.6m高いため、道路上の接地（捕食・NPC・ラグドール）は路面を使う ──
let roadSurfGrid = null, roadTopOff = 0.25;   // roadTopOff=ROAD_LIFT+タイル厚（buildRoadMeshesで実測更新）
const ROAD_SURF_CELL = 48;
function buildRoadSurfIndex() {
  roadSurfGrid = new Map();
  for (const e of activeEdges) {
    const minx = Math.min(e.a.x, e.b.x) - ROAD_WIDTH, maxx = Math.max(e.a.x, e.b.x) + ROAD_WIDTH;
    const minz = Math.min(e.a.z, e.b.z) - ROAD_WIDTH, maxz = Math.max(e.a.z, e.b.z) + ROAD_WIDTH;
    for (let gz = Math.floor(minz / ROAD_SURF_CELL); gz <= Math.floor(maxz / ROAD_SURF_CELL); gz++) {
      for (let gx = Math.floor(minx / ROAD_SURF_CELL); gx <= Math.floor(maxx / ROAD_SURF_CELL); gx++) {
        const k = gx + '_' + gz;
        if (!roadSurfGrid.has(k)) roadSurfGrid.set(k, []);
        roadSurfGrid.get(k).push(e);
      }
    }
  }
}
function roadTopAt(x, z) {   // 道路上なら路面Y、外ならnull（セル分割で近傍エッジだけ距離判定）
  if (!roadSurfGrid) return null;
  const list = roadSurfGrid.get(Math.floor(x / ROAD_SURF_CELL) + '_' + Math.floor(z / ROAD_SURF_CELL));
  if (!list) return null;
  let best = null;
  const hw = ROAD_WIDTH / 2 + 0.4;
  for (const e of list) {
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - e.a.x) * dx + (z - e.a.z) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = e.a.x + dx * t, pz = e.a.z + dz * t;
    if (Math.hypot(x - px, z - pz) > hw) continue;
    const y = e.a.y + (e.b.y - e.a.y) * t + roadTopOff;
    if (best == null || y > best) best = y;
  }
  return best;
}
async function buildRoadMeshes() {
  if (!activeEdges.length) return;
  if (roadGroup) { scene.remove(roadGroup); roadGroup = null; }
  roadCarveSets.length = 0;
  roadCarveIdx = 0;
  roadGroup = new THREE.Group();
  const loader = new GLTFLoader();
  const loadKit = async (name, dir = 'kenney_city-kit-roads/Models/GLB%20format') => {
    const gltf = await loader.loadAsync(new URL('../models/' + dir + '/' + name + '.glb', location.href).href);
    return bakeModel(gltf.scene);   // {geometry, material, baseY, size}
  };
  const road = await loadKit('road-straight');
  const lamp = await loadKit('light-curved');
  // 交差点/カーブ/横断歩道/バリア道路のタイル（無ければ従来動作にフォールバック）
  const optKit = (name) => loadKit(name).catch(() => null);
  const [tCross, tTee, tBendRaw, tXing, roadBar, sigLamp, tSplit, signHw] = await Promise.all([
    optKit('road-crossroad-path'), optKit('road-intersection-path'), optKit('road-bend-sidewalk'),
    optKit('road-crossing'), optKit('road-straight-barrier'), optKit('light-square'),
    optKit('road-split'), optKit('sign-highway-detailed'),
  ]);
  // 大通り(kind='avenue')は上下線を並列化した幹線道路として描く
  const DUAL_OFF = AVE_DUAL_OFF;                                      // 各車線の中心オフセット（車の走行オフセットと共用）
  const AVE_JUNC_SCALE = (DUAL_OFF * 2 + ROAD_WIDTH) / ROAD_WIDTH;    // 幹線が絡む交差点タイルの拡大率
  const SPLIT_BASE = 0;                                               // road-split の向き補正（目視調整ポイント）
  const aveNodes = new Set();
  for (const e of activeEdges) if (e.kind === 'avenue') { aveNodes.add(e.aId); aveNodes.add(e.bId); }
  const tBend = USE_BENDS ? tBendRaw : null;
  // タイル正規化: laneRotate=正方形タイルのレーンX向きをZへ90°回す → XZ中心・底面0
  const normTile = (asset, laneRotate) => {
    const g = asset.geometry.clone();
    if (laneRotate && asset.size.z >= asset.size.x) g.rotateY(Math.PI / 2);
    g.computeBoundingBox();
    const b = g.boundingBox;
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    return { g, w: Math.max(0.01, b.max.x - b.min.x), l: Math.max(0.01, b.max.z - b.min.z), h: Math.max(0, b.max.y - b.min.y), mat: asset.material };
  };
  const R = normTile(road, true);
  const roadThick = R.h;
  roadTopOff = ROAD_LIFT + roadThick;   // 路面高さ問い合わせ(roadTopAt)用に実測を反映
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _dir = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _rotM = new THREE.Matrix4(), _zero = new THREE.Vector3(), _lat = new THREE.Vector3();

  // ── ノード分類: 出射方向の組から 十字(4方向直交)/T字(本線+直交枝)/カーブ(2方向~90°) を判定 ──
  const nodeDirs = new Map();
  for (const e of activeEdges) {
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z, l = Math.hypot(dx, dz) || 1;
    if (!nodeDirs.has(e.aId)) nodeDirs.set(e.aId, []);
    if (!nodeDirs.has(e.bId)) nodeDirs.set(e.bId, []);
    nodeDirs.get(e.aId).push({ x: dx / l, z: dz / l, kind: e.kind });
    nodeDirs.get(e.bId).push({ x: -dx / l, z: -dz / l, kind: e.kind });
  }
  const JTOL = Math.PI / 180 * 25;   // 直交とみなす許容角
  const yawOf = (d) => Math.atan2(d.x, d.z);
  const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const junc = { cross: [], tee: [], bend: [], any: [], split: [] };   // any=直交判定に漏れた3叉以上（信号だけ立てる）/ split=幹線→単線の遷移
  const tiledNodes = new Set();
  for (const [id, nd] of roadNodes) {
    const dirs = nodeDirs.get(id);
    if (!dirs) continue;
    let put = null;
    if (dirs.length === 2 && tSplit && dirs[0].kind !== dirs[1].kind && (dirs[0].kind === 'avenue' || dirs[1].kind === 'avenue')) {
      // 幹線(並列2車線)と通常道路の継ぎ目 → road-split で車線を合流/分岐させる
      const dot = dirs[0].x * dirs[1].x + dirs[0].z * dirs[1].z;
      if (dot < -Math.cos(JTOL * 1.4)) {
        const ai = dirs[0].kind === 'avenue' ? 0 : 1;
        put = { arr: junc.split, ry: yawOf(dirs[ai]) + SPLIT_BASE };
      }
    }
    if (!put && dirs.length === 2 && tBend) {
      const d = wrapA(yawOf(dirs[1]) - yawOf(dirs[0]));
      if (Math.abs(Math.abs(d) - Math.PI / 2) < JTOL) put = { arr: junc.bend, ry: (d > 0 ? yawOf(dirs[0]) : yawOf(dirs[1])) + BEND_BASE };
    } else if (dirs.length === 3 && tTee) {
      let bi = -1, bj = -1, bd = 1;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const dot = dirs[i].x * dirs[j].x + dirs[i].z * dirs[j].z;
        if (dot < bd) { bd = dot; bi = i; bj = j; }
      }
      const br = dirs[3 - bi - bj], t = dirs[bi];
      if (bd < -Math.cos(JTOL) && Math.abs(br.x * t.x + br.z * t.z) < Math.sin(JTOL * 1.4)) put = { arr: junc.tee, ry: yawOf(br) + TEE_BASE };
    } else if (dirs.length === 4 && tCross) {
      const used = new Set(), axes = [];
      let ok = true;
      for (let i = 0; i < 4 && ok; i++) {
        if (used.has(i)) continue;
        let mj = -1, md = 1;
        for (let j = 0; j < 4; j++) {
          if (j === i || used.has(j)) continue;
          const dot = dirs[i].x * dirs[j].x + dirs[i].z * dirs[j].z;
          if (dot < md) { md = dot; mj = j; }
        }
        if (mj < 0 || md > -Math.cos(JTOL)) { ok = false; break; }
        used.add(i); used.add(mj); axes.push(dirs[i]);
      }
      if (ok && axes.length === 2 && Math.abs(axes[0].x * axes[1].x + axes[0].z * axes[1].z) < Math.sin(JTOL * 1.4)) put = { arr: junc.cross, ry: yawOf(axes[0]) };
    }
    if (put) { put.arr.push({ x: nd.local.x, y: nd.local.y, z: nd.local.z, ry: put.ry, ave: aveNodes.has(id) }); tiledNodes.add(id); }
    else if (dirs.length >= 3) junc.any.push({ x: nd.local.x, y: nd.local.y, z: nd.local.z, ry: yawOf(dirs[0]), ave: aveNodes.has(id) });
  }

  // ── 継ぎ目の方針をノード別に決定（円パッチだらけの見た目を廃止）──
  //   ほぼ直線(≥155°)＝道路同士を直接突き合わせ(隙間3cm=不可視) / 曲がり＝二等分方向の短い路面で継ぐ /
  //   タイル交差点＝従来の引き込み / 円パッチは「変則的な3叉以上」だけに残る
  const PULL = ROAD_WIDTH * 0.45;
  const nodePull = new Map();   // id -> セグメント端の引き込み量(m)
  const joints = [];            // 曲がり継ぎ手 {x,y,z,ry,len}
  const patchNodes = [];        // 円パッチを置くノード（変則多叉のみ）
  for (const [id, nd] of roadNodes) {
    const dirs = nodeDirs.get(id) || [];
    if (tiledNodes.has(id)) { nodePull.set(id, PULL); continue; }
    if (dirs.length === 2) {
      const ang = Math.abs(wrapA(yawOf(dirs[1]) - yawOf(dirs[0])));   // π=直進
      if (ang > Math.PI * 155 / 180) { nodePull.set(id, 0.03); continue; }
      nodePull.set(id, PULL);
      const thru = { x: dirs[1].x - dirs[0].x, z: dirs[1].z - dirs[0].z };   // 通過方向（二等分）
      joints.push({ x: nd.local.x, y: nd.local.y, z: nd.local.z, ry: Math.atan2(thru.x, thru.z), len: PULL * 2 + 1.0 });
      continue;
    }
    if (dirs.length <= 1) { nodePull.set(id, 0.03); continue; }   // 行き止まりは端まで描く
    nodePull.set(id, PULL);
    patchNodes.push(nd);
  }
  if (joints.length) {   // 曲がり継ぎ手＝road-straightの短片を僅かに浮かせて被せる（マイター継ぎの近似）
    const jm = new THREE.InstancedMesh(R.g, R.mat, joints.length);
    jm.frustumCulled = false;
    const jws = ROAD_WIDTH / R.w;
    for (let i = 0; i < joints.length; i++) {
      const J = joints[i];
      _p.set(J.x, J.y + ROAD_LIFT + 0.018, J.z);
      _q.setFromAxisAngle(_up, J.ry);
      _s.set(jws, 1, J.len / R.l);
      _m.compose(_p, _q, _s);
      jm.setMatrixAt(i, _m);
    }
    roadGroup.add(jm);
  }
  const addJunc = (asset, list) => {
    if (!asset || !list.length) return 0;
    const t = normTile(asset, false);
    const mesh = new THREE.InstancedMesh(t.g, t.mat, list.length);
    mesh.frustumCulled = false;
    const s = ROAD_WIDTH / t.w;
    for (let i = 0; i < list.length; i++) {
      const J = list[i];
      _p.set(J.x, J.y + ROAD_LIFT + 0.02, J.z);   // 短縮した道路端との重なり帯だけ僅かに上＝共平面回避
      _q.setFromAxisAngle(_up, J.ry);
      const s2 = s * (J.ave ? AVE_JUNC_SCALE : 1);   // 幹線が絡む交差点はタイルを拡大して並列車線を受ける
      _s.set(s2, 1, s2);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
    }
    roadGroup.add(mesh);
    return list.length;
  };
  const nJunc = addJunc(tCross, junc.cross) + addJunc(tTee, junc.tee) + addJunc(tBend, junc.bend) + addJunc(tSplit, junc.split);
  if (sigLamp) try { buildSignals(sigLamp, junc); } catch (e) { console.warn('信号生成失敗', e); }

  // ── 道路セグメント: 幹線(avenue)=並列2車線 / 長いエッジは barrier 付きタイル（＝ガードレール）──
  const stdIdx = [], barIdx = [], aveIdx = [];
  for (let i = 0; i < activeEdges.length; i++) {
    const e = activeEdges[i];
    if (e.kind === 'avenue') { aveIdx.push(i); continue; }
    ((roadBar && e.len >= BARRIER_MIN_EDGE) ? barIdx : stdIdx).push(i);
  }
  const fillRoad = (tile, idxList, lateral = 0) => {
    if (!idxList.length) return;
    // 道路を破壊可能に: カーブ材質（ワールド座標球）＝着弾点に穴＋焦げ縁。夜は暗くなるよう昼夜係数を掛ける
    let mat = tile.mat;
    try {
      const c = makeCarveMaterial(tile.mat, 0, 1);
      if (!roadLightU) roadLightU = uniform(1);
      c.mat.colorNode = c.mat.colorNode.mul(roadLightU);
      roadCarveSets.push({ uCenters: c.uCenters, uRadii: c.uRadii });
      mat = c.mat;
    } catch (e) { console.warn('道路カーブ材質失敗（通常材質で続行）', e); }
    const mesh = new THREE.InstancedMesh(tile.g, mat, idxList.length);
    mesh.frustumCulled = false;
    const ws = ROAD_WIDTH / tile.w;
    for (let k = 0; k < idxList.length; k++) {
      const e = activeEdges[idxList[k]];
      _dir.copy(e.b).sub(e.a);
      const len = _dir.length() || 1;
      _dir.normalize();
      _rotM.lookAt(_zero, _dir, _up);           // -Z→dir（道路は前後対称なので符号は不問）
      _q.setFromRotationMatrix(_rotM);
      // 両端をノード別の引き込み量で短縮（直進の継ぎ目は3cm=ほぼ突き合わせ、交差点はタイル/継ぎ手ぶん引く）
      const pa = Math.min(nodePull.get(e.aId) ?? PULL, len * 0.3);
      const pb = Math.min(nodePull.get(e.bId) ?? PULL, len * 0.3);
      const segLen = Math.max(0.4, len - pa - pb);
      _p.copy(e.a).addScaledVector(_dir, pa + segLen / 2);
      _p.y += ROAD_LIFT;
      if (lateral) { _lat.set(-_dir.z, 0, _dir.x).normalize(); _p.addScaledVector(_lat, lateral); }   // 並列車線の横オフセット
      _s.set(ws, 1, segLen / tile.l);   // 厚みは等倍
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(k, _m);
    }
    roadGroup.add(mesh);
  };
  fillRoad(R, stdIdx);
  if (roadBar) fillRoad(normTile(roadBar, true), barIdx);
  if (signHw && aveIdx.length) {   // 幹線の案内標識: sign-highway-detailed をところどころ（約240m毎・左右交互）
    const sgeo = signHw.geometry.clone();
    sgeo.computeBoundingBox();
    const sb = sgeo.boundingBox;
    sgeo.translate(-(sb.min.x + sb.max.x) / 2, -sb.min.y, -(sb.min.z + sb.max.z) / 2);
    const sScale = 4.6 / Math.max(0.01, sb.max.y - sb.min.y);
    const signPts = [];
    let sSide = 1, signAcc = 130;   // 連続する幹線エッジに沿って約240m毎（エッジ単体は~20mなので距離を累積）
    for (const i of aveIdx) {
      const e = activeEdges[i];
      _dir.copy(e.b).sub(e.a).normalize();
      const px = -_dir.z, pz = _dir.x;
      let dAcc = signAcc;
      while (dAcc < e.len && signPts.length < 400) {
        const t = dAcc / e.len;
        sSide = -sSide;
        const off = DUAL_OFF + ROAD_WIDTH / 2 + 1.5;
        signPts.push({
          x: e.a.x + (e.b.x - e.a.x) * t + px * sSide * off,
          y: e.a.y + (e.b.y - e.a.y) * t + ROAD_LIFT,
          z: e.a.z + (e.b.z - e.a.z) * t + pz * sSide * off,
          ry: Math.atan2(_dir.x, _dir.z) + (sSide > 0 ? Math.PI : 0),   // 手前側車線の進行方向へ正対
        });
        dAcc += 240;
      }
      signAcc = Math.max(0, dAcc - e.len);
    }
    if (signPts.length) {
      const signIM = new THREE.InstancedMesh(sgeo, signHw.material, signPts.length);
      signIM.frustumCulled = false;
      for (let i = 0; i < signPts.length; i++) {
        const S = signPts[i];
        _p.set(S.x, S.y, S.z);
        _q.setFromAxisAngle(_up, S.ry);
        _s.set(sScale, sScale, sScale);
        _m.compose(_p, _q, _s);
        signIM.setMatrixAt(i, _m);
      }
      roadGroup.add(signIM);
    }
  }
  if (aveIdx.length) {   // 幹線: 上下線を左右にオフセットして並列化＋中央帯
    fillRoad(R, aveIdx, DUAL_OFF);
    fillRoad(R, aveIdx, -DUAL_OFF);
    const medIM = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x39404a, roughness: 0.95 }), aveIdx.length);
    medIM.frustumCulled = false;
    for (let k = 0; k < aveIdx.length; k++) {
      const e = activeEdges[aveIdx[k]];
      _dir.copy(e.b).sub(e.a);
      const len = _dir.length() || 1;
      _dir.normalize();
      _rotM.lookAt(_zero, _dir, _up);
      _q.setFromRotationMatrix(_rotM);
      const pa = Math.min(nodePull.get(e.aId) ?? PULL, len * 0.3) + 2.5;
      const pb = Math.min(nodePull.get(e.bId) ?? PULL, len * 0.3) + 2.5;
      const segLen = Math.max(0.4, len - pa - pb);
      _p.copy(e.a).addScaledVector(_dir, pa + segLen / 2);
      _p.y += ROAD_LIFT * 0.7;
      _s.set(DUAL_OFF * 2 - ROAD_WIDTH + 0.4, 0.34, segLen);
      _m.compose(_p, _q, _s);
      medIM.setMatrixAt(k, _m);
    }
    roadGroup.add(medIM);
  }

  // ── 横断歩道: 長めのエッジに等間隔オーバーレイ（路面より2.5cm上）──
  let nXing = 0;
  if (tXing) {
    const X = normTile(tXing, true);
    const spots = [];
    for (const e of activeEdges) {
      if (e.len < XING_SPACING * 0.7) continue;
      const n = Math.min(3, Math.floor(e.len / XING_SPACING));
      for (let k = 0; k < n && spots.length < MAX_XINGS; k++) spots.push({ e, t: (k + 0.5) / n });
    }
    if (spots.length) {
      const mesh = new THREE.InstancedMesh(X.g, X.mat, spots.length);
      mesh.frustumCulled = false;
      const s = ROAD_WIDTH / X.w;
      for (let i = 0; i < spots.length; i++) {
        const { e, t } = spots[i];
        _dir.copy(e.b).sub(e.a).normalize();
        _rotM.lookAt(_zero, _dir, _up);
        _q.setFromRotationMatrix(_rotM);
        _p.set(e.a.x + (e.b.x - e.a.x) * t, e.a.y + (e.b.y - e.a.y) * t + ROAD_LIFT + 0.025, e.a.z + (e.b.z - e.a.z) * t);
        _s.set(s, 1, s);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      }
      roadGroup.add(mesh);
      nXing = spots.length;
    }
  }

  // ── 円パッチ: タイルを置けなかった変則ノードだけ塞ぐ ──
  const patchGeo = new THREE.CircleGeometry(0.5, 20);
  patchGeo.rotateX(-Math.PI / 2);
  const patchMat = new THREE.MeshStandardMaterial({ color: 0x46484c, roughness: 0.95 });
  const plainNodes = patchNodes;   // 変則的な3叉以上だけ（直線・曲がり・行き止まりは道路同士で継ぐ）
  const patch = new THREE.InstancedMesh(patchGeo, patchMat, plainNodes.length);
  patch.frustumCulled = false;
  for (let i = 0; i < plainNodes.length; i++) {
    _p.copy(plainNodes[i].local); _p.y += ROAD_LIFT + roadThick + 0.02;
    _q.identity();
    _s.set(ROAD_WIDTH, 1, ROAD_WIDTH);
    _m.compose(_p, _q, _s);
    patch.setMatrixAt(i, _m);
  }
  roadGroup.add(patch);
  console.log('junctions:', nJunc, `(cross ${junc.cross.length} / tee ${junc.tee.length} / bend ${junc.bend.length} / split ${junc.split.length} / 変則 ${junc.any.length})`, 'crossings:', nXing, 'barrier edges:', barIdx.length, 'patches:', plainNodes.length);
  // 街灯: 各エッジ沿いに等間隔・左右交互。腕(+Z)が道路を向くように回す
  const lg = lamp.geometry.clone();
  lg.computeBoundingBox();
  const lb = lg.boundingBox;
  lg.translate(-(lb.min.x + lb.max.x) / 2, -lb.min.y, -(lb.min.z + lb.max.z) / 2);
  const lScale = LIGHT_HEIGHT / Math.max(0.01, lb.max.y - lb.min.y);
  const lampMats = [], glowPos = [];
  const armZ = (lb.max.z - lb.min.z) / 2 * lScale;   // 腕の張り出し（発光点の既定位置に使う）
  // entry-editor で街灯モデルに光点マーカーがあればそれを使う（ローカル→正規化空間→スケール）
  await loadBldEntries();
  const lampMk = (bldEntries['kenney_city-kit-roads/Models/GLB format/light-curved.glb'] || []).find((m) => m.kind === 'light');
  const lampLocal = lampMk ? {
    x: (lampMk.pos[0] - (lb.min.x + lb.max.x) / 2) * lScale,
    y: (lampMk.pos[1] - lb.min.y) * lScale,
    z: (lampMk.pos[2] - (lb.min.z + lb.max.z) / 2) * lScale,
  } : null;
  let side = 1, aveLampAcc = 20;
  const dblMats = [];   // 幹線の中央帯: 両腕街灯 light-curved-double
  let lampD = null, lgD = null, lScaleD = 1, armZD = 0;
  try {
    lampD = await loadKit('light-curved-double');
    lgD = lampD.geometry.clone();
    lgD.computeBoundingBox();
    const db = lgD.boundingBox;
    lgD.translate(-(db.min.x + db.max.x) / 2, -db.min.y, -(db.min.z + db.max.z) / 2);
    lScaleD = LIGHT_HEIGHT / Math.max(0.01, db.max.y - db.min.y);
    armZD = (db.max.z - db.min.z) / 2 * lScaleD;
  } catch { /* 無ければ幹線も通常街灯で続行 */ }
  for (const e of activeEdges) {
    const len = e.a.distanceTo(e.b);
    if (lampMats.length + dblMats.length >= MAX_LIGHTS) break;
    _dir.copy(e.b).sub(e.a).normalize();
    const px = -_dir.z, pz = _dir.x;   // 水平垂直
    if (e.kind === 'avenue' && lgD) {   // 幹線: 中央帯に等間隔（グラフのエッジは~20mと短いので、連続エッジに沿って距離を累積。長さフィルタより先）
      let dAcc = aveLampAcc;
      while (dAcc < len && lampMats.length + dblMats.length < MAX_LIGHTS) {
        const t = dAcc / len;
        const bx = e.a.x + (e.b.x - e.a.x) * t;
        const bz = e.a.z + (e.b.z - e.a.z) * t;
        const by = e.a.y + (e.b.y - e.a.y) * t + ROAD_LIFT;
        const ry = Math.atan2(px, pz);
        dblMats.push({ x: bx, y: by, z: bz, ry, glowIdx: glowPos.length / 3 });
        glowPos.push(bx + Math.sin(ry) * armZD * 0.8, by + LIGHT_HEIGHT * 0.92, bz + Math.cos(ry) * armZD * 0.8);
        glowPos.push(bx - Math.sin(ry) * armZD * 0.8, by + LIGHT_HEIGHT * 0.92, bz - Math.cos(ry) * armZD * 0.8);
        dAcc += LIGHT_SPACING;
      }
      aveLampAcc = Math.max(0, dAcc - len);   // 次の幹線エッジへ持ち越し
      continue;
    }
    if (len < LIGHT_SPACING * 0.6) continue;
    const n = Math.max(1, Math.floor(len / LIGHT_SPACING));
    for (let k = 1; k <= n && lampMats.length + dblMats.length < MAX_LIGHTS; k++) {
      const t = k / (n + 1);
      side = -side;
      const bx = e.a.x + (e.b.x - e.a.x) * t + px * side * (ROAD_WIDTH / 2 + 0.6);
      const bz = e.a.z + (e.b.z - e.a.z) * t + pz * side * (ROAD_WIDTH / 2 + 0.6);
      const by = e.a.y + (e.b.y - e.a.y) * t + ROAD_LIFT;
      const ry = Math.atan2(px * side, pz * side);   // 腕が道路の中心側を向く（実物合わせで符号反転済み）
      lampMats.push({ x: bx, y: by, z: bz, ry, glowIdx: glowPos.length / 3 });
      if (lampLocal) {   // エディタ指定の光点（ヨー回転して配置）
        const cs = Math.cos(ry), sn = Math.sin(ry);
        glowPos.push(bx + lampLocal.x * cs + lampLocal.z * sn, by + lampLocal.y, bz - lampLocal.x * sn + lampLocal.z * cs);
      } else glowPos.push(bx + Math.sin(ry) * armZ * 0.8, by + LIGHT_HEIGHT * 0.92, bz + Math.cos(ry) * armZ * 0.8);
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
  roadGroup.add(lampMesh);
  // 街灯の発光球（夜だけ）。WebGPUのPoints1px制限を避けて加算小球で
  streetGlowMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 6, 5), streetGlowMat, glowPos.length / 3);
  glow.frustumCulled = false;
  for (let i = 0; i < glowPos.length / 3; i++) {
    _m.makeTranslation(glowPos[i * 3], glowPos[i * 3 + 1], glowPos[i * 3 + 2]);
    glow.setMatrixAt(i, _m);
  }
  roadGroup.add(glow);
  streetGlowMesh = glow;
  // 幹線の両腕街灯（中央帯）
  let dblMesh = null;
  if (dblMats.length && lgD) {
    dblMesh = new THREE.InstancedMesh(lgD, lampD.material, dblMats.length);
    dblMesh.frustumCulled = false;
    for (let i = 0; i < dblMats.length; i++) {
      const L = dblMats[i];
      _p.set(L.x, L.y, L.z);
      _q.setFromAxisAngle(_up, L.ry);
      _s.set(lScaleD, lScaleD, lScaleD);
      _m.compose(_p, _q, _s);
      dblMesh.setMatrixAt(i, _m);
    }
    roadGroup.add(dblMesh);
  }
  // 街灯を破壊対象として登録（吹っ飛び用に同じジオメトリ/材質のプールを用意）
  registerPropKind('lamp', lg, lamp.material);
  for (let i = 0; i < lampMats.length; i++) {
    const L = lampMats[i];
    props.push({ kind: 'lamp', mesh: lampMesh, index: i, x: L.x, y: L.y, z: L.z, ry: L.ry, s: lScale, h: LIGHT_HEIGHT, r: 1.7, dead: false, glowIndex: L.glowIdx });
  }
  if (dblMesh) {
    registerPropKind('lampD', lgD, lampD.material);
    for (let i = 0; i < dblMats.length; i++) {
      const L = dblMats[i];
      props.push({ kind: 'lampD', mesh: dblMesh, index: i, x: L.x, y: L.y, z: L.z, ry: L.ry, s: lScaleD, h: LIGHT_HEIGHT, r: 1.7, dead: false, glowIndex: L.glowIdx });
    }
  }
  const counts = await buildRoadsideProps(loadKit, _m, _q, _p, _s, _dir, _up);
  scene.add(roadGroup);
  console.log('roads:', activeEdges.length, 'lights:', lampMats.length, '+ dbl', dblMats.length, 'trees:', counts.trees);
}

// ── 信号機: 十字/T字交差点に light-square を立て、腕先に三色の加算発光球（昼夜問わず点灯）──
// 2フェーズ交互（軸A青⇔軸B赤）。ネオンと同じ InstancedMesh 小球方式・instanceColorを状態遷移時だけ更新
let signalMesh = null, signalMeta = [], signalTimer = 0, signalState = -1;
const SIGNAL_CYCLE = [[4.0, 'g', 'r'], [1.2, 'y', 'r'], [4.0, 'r', 'g'], [1.2, 'r', 'y']];   // [秒, 群0色, 群1色]
const SIG_RGB = { g: [0.15, 1.0, 0.35], y: [1.0, 0.8, 0.1], r: [1.0, 0.12, 0.08] };
function buildSignals(asset, junc) {
  signalMesh = null; signalMeta = []; signalState = -1;
  const g = asset.geometry.clone();
  g.computeBoundingBox();
  const b = g.boundingBox;
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  const t = { g, mat: asset.material, h: Math.max(0.01, b.max.y - b.min.y), l: Math.max(0.01, b.max.z - b.min.z) };
  const sc = SIGNAL_HEIGHT / Math.max(0.01, t.h);
  const armZ = t.l / 2 * sc;                    // 腕の張り出し（+Z想定・light-curvedと同じ）
  const headY = t.h * sc * 0.93;
  const poles = [];   // {x,y,z,ry,group}
  // 配置は初版と同じ。向きだけ初版から180°回転（ユーザー実物合わせ）
  for (const J of junc.cross) {                 // 十字=対角2本（群0/1で交互に切替が見える）
    if (poles.length >= MAX_SIGNALS - 1) break;
    const off = (J.ave ? ROAD_WIDTH + 0.8 : ROAD_WIDTH / 2) + 1.0, cs = Math.cos(J.ry), sn = Math.sin(J.ry);   // 幹線交差点は並列車線の外へ
    poles.push({ x: J.x + cs * off + sn * off, y: J.y, z: J.z - sn * off + cs * off, ry: J.ry, group: 0 });
    poles.push({ x: J.x - cs * off - sn * off, y: J.y, z: J.z + sn * off - cs * off, ry: J.ry - Math.PI / 2, group: 1 });
  }
  for (const J of junc.tee) {                   // T字=枝の脇に1本
    if (poles.length >= MAX_SIGNALS) break;
    const off = (J.ave ? ROAD_WIDTH + 0.8 : ROAD_WIDTH / 2) + 1.0, cs = Math.cos(J.ry), sn = Math.sin(J.ry);   // 幹線交差点は並列車線の外へ
    poles.push({ x: J.x + cs * off, y: J.y, z: J.z - sn * off, ry: J.ry, group: 0 });
  }
  for (const J of junc.any) {                   // 変則角度の交差点にも1本（自作マップ対策）
    if (poles.length >= MAX_SIGNALS) break;
    const off = (J.ave ? ROAD_WIDTH + 0.8 : ROAD_WIDTH / 2) + 1.0, cs = Math.cos(J.ry), sn = Math.sin(J.ry);   // 幹線交差点は並列車線の外へ
    poles.push({ x: J.x + cs * off, y: J.y, z: J.z - sn * off, ry: J.ry, group: poles.length % 2 });
  }
  if (!poles.length) return;
  // ポール本体
  const pm = new THREE.InstancedMesh(t.g, t.mat, poles.length);
  pm.frustumCulled = false;
  const _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _ps = new THREE.Vector3(sc, sc, sc);
  const _upS = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < poles.length; i++) {
    const P = poles[i];
    _pq.setFromAxisAngle(_upS, P.ry);
    _pm.compose(_pp.set(P.x, P.y + ROAD_LIFT, P.z), _pq, _ps);
    pm.setMatrixAt(i, _pm);
  }
  roadGroup.add(pm);
  // 信号を破壊対象として登録（バルブは pole i → 3i..3i+2 で対応）
  registerPropKind('sig', t.g, t.mat);
  for (let i = 0; i < poles.length; i++) {
    const P = poles[i];
    props.push({ kind: 'sig', mesh: pm, index: i, x: P.x, y: P.y + ROAD_LIFT, z: P.z, ry: P.ry, s: sc, h: SIGNAL_HEIGHT, r: 1.7, dead: false, bulbStart: i * 3 });
  }
  // 三色バルブ（腕の先端から 赤・黄・青 の順で内側へ）
  const bulbs = [];
  for (const P of poles) {
    const cs = Math.cos(P.ry), sn = Math.sin(P.ry);
    for (let k = 0; k < 3; k++) {
      const lz = armZ - 0.35 - 0.55 * k;   // 先端=赤
      bulbs.push({ x: P.x + sn * lz, y: P.y + ROAD_LIFT + headY, z: P.z + cs * lz, color: ['r', 'y', 'g'][k], group: P.group });
    }
  }
  signalMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.24, 6, 5),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    bulbs.length,
  );
  signalMesh.frustumCulled = false;
  const _bm = new THREE.Matrix4();
  for (let i = 0; i < bulbs.length; i++) {
    _bm.makeTranslation(bulbs[i].x, bulbs[i].y, bulbs[i].z);
    signalMesh.setMatrixAt(i, _bm);
    signalMeta.push({ color: bulbs[i].color, group: bulbs[i].group });
    // 初期色をここで書く＝instanceColorバッファを「最初の描画前」に確定させる。
    // 描画後に遅延生成するとWebGPUのパイプラインが色なしでコンパイルされ、以後の色変更が効かない
    const rgb = SIG_RGB[bulbs[i].color];
    _sigC.setRGB(rgb[0], rgb[1], rgb[2]).multiplyScalar(0.05);
    signalMesh.setColorAt(i, _sigC);
  }
  signalMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  signalMesh.instanceColor.needsUpdate = true;
  roadGroup.add(signalMesh);
  console.log('signals:', poles.length, 'poles /', bulbs.length, 'bulbs');
}
const _sigC = new THREE.Color();
function updateSignals(dt) {   // 実時間サイクル（Tの早送りに依存しない）。状態が変わった時だけ色更新
  if (!signalMesh) return;
  signalTimer += dt;
  const total = SIGNAL_CYCLE.reduce((s, c) => s + c[0], 0);
  let t = signalTimer % total, idx = 0;
  while (t > SIGNAL_CYCLE[idx][0]) { t -= SIGNAL_CYCLE[idx][0]; idx++; }
  if (idx === signalState) return;
  signalState = idx;
  const [, c0, c1] = SIGNAL_CYCLE[idx];
  for (let i = 0; i < signalMeta.length; i++) {
    const m = signalMeta[i];
    const rgb = SIG_RGB[m.color];
    const active = (m.group === 0 ? c0 : c1) === m.color;
    _sigC.setRGB(rgb[0], rgb[1], rgb[2]).multiplyScalar(active ? 1 : 0.05);
    signalMesh.setColorAt(i, _sigC);
  }
  if (signalMesh.instanceColor) signalMesh.instanceColor.needsUpdate = true;
}

// ── 街路樹: 街灯と同じ「エッジ沿い等間隔インスタンス」パターン ─────
// （ガードレールは road-straight-barrier タイルに統合済み＝fence-low レールは撤去）
const TREE_SPACING = 30;                        // 街路樹の間隔(m)
const TREE_OFFSET = ROAD_WIDTH / 2 + 2.8;       // 道路中心からの張り出し(m)
const TREE_HEIGHT = 7.0;                        // tree-largeの樹高(m)。smallはこの0.6倍
const MAX_TREES = 8000;   // 実測5,158本必要（4000では郊外が頭打ち）
async function buildRoadsideProps(loadKit, _m, _q, _p, _s, _dir, _up) {
  const SUB_DIR = 'kenney_city-kit-suburban_20/Models/GLB%20format';
  const [treeL, treeS] = await Promise.all([
    loadKit('tree-large', SUB_DIR), loadKit('tree-small', SUB_DIR),
  ]);
  const prep = (asset) => {   // 底面0・XZ中心へ正規化した複製ジオメトリ
    const g = asset.geometry.clone();
    g.computeBoundingBox();
    const b = g.boundingBox;
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    return { g, size: b.getSize(new THREE.Vector3()), mat: asset.material };
  };
  const tL = prep(treeL), tS = prep(treeS);
  // 決定的乱数（mulberry32相当）: リロードしても同じ並木になる
  let rs = 0xC17EE5 >>> 0;
  const rnd = () => {
    rs = (rs + 0x6D2B79F5) >>> 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const treeMats = { L: [], S: [] };
  for (const e of activeEdges) {
    const len = e.len;
    _dir.copy(e.b).sub(e.a).normalize();
    const px = -_dir.z, pz = _dir.x;                 // 水平垂直
    // 街路樹: 左右交互・大小と向きは決定的ランダム
    if (len >= TREE_SPACING * 0.8 && treeMats.L.length + treeMats.S.length < MAX_TREES) {
      const n = Math.max(1, Math.floor(len / TREE_SPACING));
      for (let k = 1; k <= n && treeMats.L.length + treeMats.S.length < MAX_TREES; k++) {
        const t = (k - 0.5) / n, sd = rnd() < 0.5 ? 1 : -1;
        (rnd() < 0.7 ? treeMats.L : treeMats.S).push({
          x: e.a.x + (e.b.x - e.a.x) * t + px * sd * TREE_OFFSET,
          y: e.a.y + (e.b.y - e.a.y) * t - 0.15,     // 横斜面で浮くより沈む方がマシ
          z: e.a.z + (e.b.z - e.a.z) * t + pz * sd * TREE_OFFSET,
          ry: rnd() * Math.PI * 2, s: 0.85 + rnd() * 0.4,
        });
      }
    }
  }
  const addInst = (p, mats, mkScale, kind, hBase) => {
    if (!mats.length) return;
    const mesh = new THREE.InstancedMesh(p.g, p.mat, mats.length);
    mesh.frustumCulled = false;
    registerPropKind(kind, p.g, p.mat);
    for (let i = 0; i < mats.length; i++) {
      const M = mats[i];
      _p.set(M.x, M.y, M.z);
      _q.setFromAxisAngle(_up, M.ry);
      mkScale(M, _s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const h = hBase * M.s;   // 実際の樹高（個体スケール込み）
      props.push({ kind, mesh, index: i, x: M.x, y: M.y, z: M.z, ry: M.ry, s: _s.x, h, r: Math.max(1.5, h * 0.3), dead: false });
    }
    roadGroup.add(mesh);
  };
  const sL = TREE_HEIGHT / Math.max(0.01, tL.size.y), sS = TREE_HEIGHT * 0.6 / Math.max(0.01, tS.size.y);
  addInst(tL, treeMats.L, (M, s) => s.setScalar(sL * M.s), 'treeL', TREE_HEIGHT);
  addInst(tS, treeMats.S, (M, s) => s.setScalar(sS * M.s), 'treeS', TREE_HEIGHT * 0.6);
  treeAssets = { tL, tS, sL, sS };   // 森の自動群生（buildForest）で再利用
  return { trees: treeMats.L.length + treeMats.S.length };
}

// ── 森: 家も道も水もない空き地に樹木を自動群生（マップモードのみ・建物配置後に呼ぶ）──
// 値ノイズで「まとまった森」を作り、占有グリッド（道路/建物/水）と急斜面を避けて配置。
// 描画は400mチャンクのInstancedMesh＋視錐台カリング＝画面外の森は描かない。破壊対応（propsに登録）。
let treeAssets = null;
const FOREST_MAX = 9000;         // 総本数上限（超過分はマップ全体から均等に間引く）
const FOREST_CELL = 7;           // 配置格子(m)。ジッタを加えて自然な散らばりに
const FOREST_CHUNK = 400;        // 描画チャンク(m)
const FOREST_ROAD_MARGIN = 13;   // 道路中心からの立入禁止距離(m)（街路樹と重ならない）
async function buildForest() {
  if (!mapTerrain) return;
  // 木モデル: map-editorの植生設定で models/ から選択可（未指定は街路樹と同じ tree-large/small）
  let custom = null;
  if (mapForest && mapForest.model) {
    try {
      const url = '../models/' + mapForest.model.split('/').map(encodeURIComponent).join('/');
      const asset = bakeModel((await new GLTFLoader().loadAsync(new URL(url, location.href).href)).scene);
      const g = asset.geometry.clone();
      g.computeBoundingBox();
      const b = g.boundingBox;
      g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);   // 底面0・XZ中心
      custom = { g, mat: asset.material, h: Math.max(0.01, b.max.y - b.min.y) };
    } catch (e) { console.warn('森モデル読込失敗（既定の木で続行）:', mapForest.model, e); }
  }
  if (!custom && !treeAssets) return;
  const size = mapTerrain.data.size, half = size / 2;
  let rs = 0xF07E57 >>> 0;   // 決定的乱数（リロードで同じ森）
  const rnd = () => {
    rs = (rs + 0x6D2B79F5) >>> 0;
    let t = rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const h2 = (ix, iz) => {   // 2Dハッシュ→[0,1)
    let n = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) ^ 0x5F0E57;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, z, w) => {   // バイリニア値ノイズ（波長w）
    const fx = x / w, fz = z / w, ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
    const a = h2(ix, iz), b = h2(ix + 1, iz), c = h2(ix, iz + 1), d = h2(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
  // 占有グリッド: 道路・建物・水面（+余白）を立入禁止に塗る
  const OG = 8;
  const gw = Math.ceil(size / OG) + 4, off = half + OG * 2;
  const occ = new Uint8Array(gw * gw);
  const mark = (x, z, rx, rz) => {
    const x0 = Math.max(0, Math.floor((x - rx + off) / OG)), x1 = Math.min(gw - 1, Math.floor((x + rx + off) / OG));
    const z0 = Math.max(0, Math.floor((z - rz + off) / OG)), z1 = Math.min(gw - 1, Math.floor((z + rz + off) / OG));
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) occ[cz * gw + cx] = 1;
  };
  for (const e of activeEdges) {   // 道路: 4m刻みで歩いて周囲を塗る
    const n = Math.max(1, Math.ceil(e.len / 4));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      mark(e.a.x + (e.b.x - e.a.x) * t, e.a.z + (e.b.z - e.a.z) * t, FOREST_ROAD_MARGIN, FOREST_ROAD_MARGIN);
    }
  }
  for (const b of collBoxes) if (b.top > b.bottom) mark(b.x, b.z, b.h + 3, b.h + 3);
  for (const w of mapWater) mark(w.x, w.z, (w.w || 100) / 2 + 4, (w.d || 100) / 2 + 4);
  for (const pk of mapParks) {   // 公園（閉じスプライン）内も立入禁止
    const pts = pk.points.map((q) => ({ x: q[0], z: q[1] }));
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const q of pts) { bx0 = Math.min(bx0, q.x); bx1 = Math.max(bx1, q.x); bz0 = Math.min(bz0, q.z); bz1 = Math.max(bz1, q.z); }
    for (let cz = Math.max(0, Math.floor((bz0 + off) / OG)); cz <= Math.min(gw - 1, Math.floor((bz1 + off) / OG)); cz++) {
      for (let cx = Math.max(0, Math.floor((bx0 + off) / OG)); cx <= Math.min(gw - 1, Math.floor((bx1 + off) / OG)); cx++) {
        if (pointInPoly(cx * OG - off + OG / 2, cz * OG - off + OG / 2, pts)) occ[cz * gw + cx] = 1;
      }
    }
  }
  // パス1: 候補集め。map-editorの植生ペイントがあればそれに従い、なければ値ノイズで自動群生。
  let cand = [];
  if (mapForest) {   // ペイント密度(0-255)＝そのセルの本数の期待値。位置はセル内の完全ランダム＝格子感なし
    const mf = mapForest, mres = mf.res, mcell = mf.cell;
    const perCell = (mcell * mcell) / (FOREST_CELL * FOREST_CELL) * 1.15;   // 密度1.0でおおむね7m間隔相当の本数
    for (let mz = 0; mz < mres; mz++) {
      for (let mx = 0; mx < mres; mx++) {
        const den = mf.data[mz * mres + mx] / 255;
        if (den <= 0) continue;
        const cx0 = mx * mcell - half, cz0 = mz * mcell - half;
        // ノイズは濃淡だけ（下限0.45）: 塗った場所には必ず生える＝切れ間でセルごと消さない
        const v = noise(cx0, cz0, 90) * 0.7 + noise(cx0 + 5555, cz0 - 2222, 28) * 0.3;
        const clump = 0.45 + Math.max(0, Math.min(1, (v - 0.3) / 0.4)) * 1.05;
        let n = perCell * den * clump;
        while (n > 0) {
          if (n < 1 && rnd() >= n) break;   // 端数は確率で1本
          n -= 1;
          const x = cx0 + rnd() * mcell, z = cz0 + rnd() * mcell;
          if (x < -half + 6 || x > half - 6 || z < -half + 6 || z > half - 6) continue;
          if (occ[Math.floor((z + off) / OG) * gw + Math.floor((x + off) / OG)]) continue;
          cand.push(x, z);
        }
      }
    }
  } else for (const th of [0.56, 0.62, 0.68, 0.74, 0.8]) {
    // 自動: 候補が上限を大きく超えるマップでは閾値を上げて「森の面積」を狭める＝密度は保つ
    cand = [];
    rs = 0xF07E57 >>> 0;   // 乱数を巻き戻す＝閾値だけの違いで決定的
    for (let gz = -half + 6; gz < half - 6; gz += FOREST_CELL) {
      for (let gx = -half + 6; gx < half - 6; gx += FOREST_CELL) {
        const d = noise(gx, gz, 130) * 0.75 + noise(gx + 7777, gz - 3333, 34) * 0.25;   // 大きな塊＋細かいムラ
        if (d < th) continue;
        const x = gx + (rnd() - 0.5) * FOREST_CELL * 0.9, z = gz + (rnd() - 0.5) * FOREST_CELL * 0.9;
        if (occ[Math.floor((z + off) / OG) * gw + Math.floor((x + off) / OG)]) continue;
        cand.push(x, z);
      }
    }
    if (cand.length / 2 <= FOREST_MAX * 1.5) break;
  }
  // パス2: 上限へ均等に間引き→高さ/斜面チェック→確定
  const keep = Math.min(1, FOREST_MAX / Math.max(1, cand.length / 2));
  const yOff = mapForest ? mapForest.yOff : -0.2;   // 接地位置はエディタの植生設定に従う（自動群生は従来通り沈める）
  const spots = { L: [], S: [] };
  for (let i = 0; i < cand.length; i += 2) {
    if (rnd() > keep) continue;
    const x = cand[i], z = cand[i + 1];
    if (Math.abs(mapTerrain.heightAt(x + 3, z) - mapTerrain.heightAt(x - 3, z)) > 3.4) continue;   // 急斜面
    if (Math.abs(mapTerrain.heightAt(x, z + 3) - mapTerrain.heightAt(x, z - 3)) > 3.4) continue;
    // 接地=足元範囲の最高点（斜面で根元が埋まらない。エディタのプレビューと同じ基準）
    const y = Math.max(
      mapTerrain.heightAt(x, z),
      mapTerrain.heightAt(x + 1.5, z), mapTerrain.heightAt(x - 1.5, z),
      mapTerrain.heightAt(x, z + 1.5), mapTerrain.heightAt(x, z - 1.5),
    );
    (rnd() < 0.72 ? spots.L : spots.S).push({ x, y: y + yOff, z, ry: rnd() * Math.PI * 2, s: 0.75 + rnd() * 0.6 });
  }
  // チャンク分割してInstancedMesh化（カリング有効＝画面外は描かない）
  const ta = treeAssets;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  let nChunks = 0;
  const build = (list, kind, asset, base, hBase) => {
    if (!list.length) return;
    if (!propFly[kind]) registerPropKind(kind, asset.g, asset.mat);   // 街路樹ゼロのマップでもプール確保
    const byChunk = new Map();
    for (const t of list) {
      const key = Math.floor((t.x + half) / FOREST_CHUNK) + '_' + Math.floor((t.z + half) / FOREST_CHUNK);
      let arr = byChunk.get(key);
      if (!arr) byChunk.set(key, arr = []);
      arr.push(t);
    }
    for (const arr of byChunk.values()) {
      const mesh = new THREE.InstancedMesh(asset.g, asset.mat, arr.length);
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        _p.set(t.x, t.y, t.z);
        _q.setFromAxisAngle(_pfUp, t.ry);
        _s.setScalar(base * t.s);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
        const h = hBase * t.s;
        props.push({ kind, mesh, index: i, x: t.x, y: t.y, z: t.z, ry: t.ry, s: base * t.s, h, r: Math.max(1.5, h * 0.3), dead: false });
      }
      mesh.computeBoundingSphere();   // インスタンス全体の球＝これで視錐台カリングが効く
      scene.add(mesh);
      nChunks++;
    }
  };
  if (custom) {
    const tH = mapForest.treeH;
    build(spots.L.concat(spots.S), 'forestM', { g: custom.g, mat: custom.mat }, tH / custom.h, tH);
  } else {
    build(spots.L, 'treeL', ta.tL, ta.sL, TREE_HEIGHT);
    build(spots.S, 'treeS', ta.tS, ta.sS, TREE_HEIGHT * 0.6);
  }
  console.log('forest trees:', spots.L.length + spots.S.length, '/ chunks:', nChunks, custom ? '/ model: ' + mapForest.model : '');
}

// ── 公園: map-editorの閉じスプライン内を 生垣＋緑地＋噴水＋ランタン で埋める ──
// 生垣は境界の弧長に沿って隙間なく敷き詰め、道路に最も近い1区画をゲートに置換。
// ランタンは各制御点（少し内側）で夜に発光（街灯と同じ挙動）。全て破壊可能（propsに登録）。
const PARK_HEDGE_H = 1.4;      // 生垣の高さ(m)
const PARK_LANTERN_H = 2.4;    // ランタンの高さ(m)
const PARK_FOUNTAIN_W = 4.5;   // 噴水の幅(m)
const PARK_HEDGE_OVR = 1.1;    // 生垣のオーバーラップ倍率の既定（1.0=ぴったり。カーブ外側の楔を埋める分だけ少し重ねる）。map-editorのスライダで上書き可
let parkGlowMat = null;
function pointInPoly(px, pz, pts) {   // 偶奇判定
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, zi = pts[i].z, xj = pts[j].x, zj = pts[j].z;
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
async function buildParks() {
  if (!mapTerrain || !mapParks.length) return;
  const loader = new GLTFLoader();
  const loadM = async (name) => {   // 底面0・XZ中心へ正規化
    const gltf = await loader.loadAsync(new URL('../models/fantasy_GLB%20format/' + name + '.glb', location.href).href);
    const a = bakeModel(gltf.scene);
    const g = a.geometry.clone();
    g.computeBoundingBox();
    const b = g.boundingBox;
    g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
    return { g, mat: a.material, size: b.getSize(new THREE.Vector3()) };
  };
  const [hedge, gate, fRound, fSquare, lantern] = await Promise.all([
    loadM('hedge'), loadM('hedge-gate'), loadM('fountain-round-detail'), loadM('fountain-square-detail'), loadM('lantern'),
  ]);
  const alignX = (m) => {   // 長手方向をXへ（生垣/ゲートを進行方向に沿わせる）
    if (m.size.z > m.size.x) {
      m.g.rotateY(Math.PI / 2);
      m.g.computeBoundingBox();
      m.size = m.g.boundingBox.getSize(new THREE.Vector3());
    }
  };
  alignX(hedge); alignX(gate);
  const hs = PARK_HEDGE_H / Math.max(0.01, hedge.size.y);
  const gs = PARK_HEDGE_H / Math.max(0.01, gate.size.y);
  const ls = PARK_LANTERN_H / Math.max(0.01, lantern.size.y);
  const hedgeLen = Math.max(0.5, hedge.size.x * hs);
  const H = (x, z) => mapTerrain.heightAt(x, z);
  const hedgeMats = [], gateMats = [], lantMats = [], fountMats = { R: [], S: [] }, glowPos = [];
  const groundGeos = [];
  for (const pk of mapParks) {
    const ctrl = pk.points.map((q) => ({ x: q[0], z: q[1] }));
    let cx = 0, cz = 0;
    for (const q of ctrl) { cx += q.x; cz += q.z; }
    cx /= ctrl.length; cz /= ctrl.length;
    // 境界の密サンプル→弧長で等分割（生垣が隙間なく閉じる）
    const dense = sampleRoadPoints(pk.points, true, 2);
    dense.push({ x: dense[0].x, z: dense[0].z });   // 完全に閉じる
    const arc = [0];
    for (let i = 1; i < dense.length; i++) arc.push(arc[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
    const L = arc[arc.length - 1];
    if (L < hedgeLen * 3) continue;
    const at = (d, out) => {   // 弧長d→位置＋接線
      let i = 1;
      while (i < arc.length - 1 && arc[i] < d) i++;
      const t = (d - arc[i - 1]) / Math.max(0.001, arc[i] - arc[i - 1]);
      out.x = dense[i - 1].x + (dense[i].x - dense[i - 1].x) * t;
      out.z = dense[i - 1].z + (dense[i].z - dense[i - 1].z) * t;
      out.tx = dense[i].x - dense[i - 1].x; out.tz = dense[i].z - dense[i - 1].z;
      const tl = Math.hypot(out.tx, out.tz) || 1;
      out.tx /= tl; out.tz /= tl;
    };
    const n = Math.max(3, Math.round(L / hedgeLen));
    const segLen = L / n;
    // ゲート位置＝道路に最も近い区画
    const smp = {};
    let gateIdx = 0, gateBest = Infinity;
    for (let i = 0; i < n; i++) {
      at((i + 0.5) * segLen, smp);
      for (const e of activeEdges) {
        const dx = smp.x - (e.a.x + e.b.x) / 2, dz = smp.z - (e.a.z + e.b.z) / 2;
        const d2 = dx * dx + dz * dz;
        if (d2 < gateBest) { gateBest = d2; gateIdx = i; }
      }
    }
    for (let i = 0; i < n; i++) {
      at((i + 0.5) * segLen, smp);
      const it = { x: smp.x, y: H(smp.x, smp.z) - 0.03, z: smp.z, ry: Math.atan2(-smp.tz, smp.tx) };
      // sx はジオメトリ単位からの完全なXスケール（hs で割った比率ではない＝以前は1/hs倍に縮んで隙間だらけだった）
      if (i === gateIdx) { it.sx = segLen / Math.max(0.01, gate.size.x) * 1.04; gateMats.push(it); }
      else { it.sx = segLen / Math.max(0.01, hedge.size.x) * (mapParkCfg.hedgeOvr || PARK_HEDGE_OVR); hedgeMats.push(it); }
    }
    // 緑地: 境界サンプルの多角形（earcut）。頂点を地形高さ+0.12へ
    const shp = new THREE.Shape();
    const ring = sampleRoadPoints(pk.points, true, 4);
    shp.moveTo(ring[0].x, ring[0].z);
    for (let i = 1; i < ring.length; i++) shp.lineTo(ring[i].x, ring[i].z);
    const gg = new THREE.ShapeGeometry(shp);
    const posA = gg.attributes.position;
    const nrm = new Float32Array(posA.count * 3);
    for (let i = 0; i < posA.count; i++) {
      const gx = posA.getX(i), gz = posA.getY(i);
      posA.setXYZ(i, gx, H(gx, gz) + 0.12, gz);
      nrm[i * 3 + 1] = 1;
    }
    gg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    groundGeos.push(gg);
    // 噴水（中心）＋ランタン（各制御点の少し内側）
    (pk.fountain === 'square' ? fountMats.S : fountMats.R).push({ x: cx, y: H(cx, cz), z: cz, ry: 0 });
    for (const q of ctrl) {
      const dx = cx - q.x, dz = cz - q.z;
      const dl = Math.hypot(dx, dz) || 1;
      const lx = q.x + dx / dl * 1.4, lz = q.z + dz / dl * 1.4;
      const ly = H(lx, lz);
      lantMats.push({ x: lx, y: ly, z: lz, ry: Math.atan2(dx, dz) });
      glowPos.push(lx, ly + lantern.size.y * ls * 0.82, lz);
    }
  }
  // 緑地メッシュ（全公園まとめて）
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x4e8f3e, roughness: 0.95, side: THREE.DoubleSide });
  for (const gg of groundGeos) scene.add(new THREE.Mesh(gg, groundMat));
  // ランタンの発光球（街灯と同じ: 夜だけ加算発光）
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  let parkGlowMesh = null;
  if (glowPos.length) {
    parkGlowMat = new THREE.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    parkGlowMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 6, 5), parkGlowMat, glowPos.length / 3);
    parkGlowMesh.frustumCulled = false;
    for (let i = 0; i < glowPos.length / 3; i++) {
      _m.makeTranslation(glowPos[i * 3], glowPos[i * 3 + 1], glowPos[i * 3 + 2]);
      parkGlowMesh.setMatrixAt(i, _m);
    }
    scene.add(parkGlowMesh);
  }
  lantMats.forEach((it, i) => { it.glowIndex = i; it.glowMesh = parkGlowMesh; });
  // インスタンス配置＋破壊登録（種類ごとに1メッシュ）
  const addKind = (kind, asset, mats, sy, propH, mkScale) => {
    if (!mats.length) return;
    registerPropKind(kind, asset.g, asset.mat);
    const mesh = new THREE.InstancedMesh(asset.g, asset.mat, mats.length);
    mesh.frustumCulled = false;
    for (let i = 0; i < mats.length; i++) {
      const it = mats[i];
      _p.set(it.x, it.y, it.z);
      _q.setFromAxisAngle(_pfUp, it.ry);
      mkScale(it, _s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const pr = { kind, mesh, index: i, x: it.x, y: it.y, z: it.z, ry: it.ry, s: sy, h: propH, r: Math.max(1.4, propH * 0.5), dead: false };
      if (it.glowIndex != null) { pr.glowIndex = it.glowIndex; pr.glowMesh = it.glowMesh; }
      props.push(pr);
    }
    scene.add(mesh);
  };
  addKind('hedge', hedge, hedgeMats, hs, PARK_HEDGE_H, (it, sv) => sv.set(it.sx, hs, hs));
  addKind('hedgeGate', gate, gateMats, gs, PARK_HEDGE_H, (it, sv) => sv.set(it.sx, gs, gs));
  const fr = PARK_FOUNTAIN_W / Math.max(0.01, Math.max(fRound.size.x, fRound.size.z));
  const fsq = PARK_FOUNTAIN_W / Math.max(0.01, Math.max(fSquare.size.x, fSquare.size.z));
  addKind('fountainR', fRound, fountMats.R, fr, fRound.size.y * fr, (it, sv) => sv.setScalar(fr));
  addKind('fountainS', fSquare, fountMats.S, fsq, fSquare.size.y * fsq, (it, sv) => sv.setScalar(fsq));
  addKind('lantern', lantern, lantMats, ls, PARK_LANTERN_H, (it, sv) => sv.setScalar(ls));
  console.log('parks:', mapParks.length, '/ hedges:', hedgeMats.length, '/ lanterns:', lantMats.length);
}

// ── 破壊可能な道路小物（信号/街灯/街路樹）: 攻撃が当たると吹っ飛ぶ ─────
// 元のInstancedMeshのインスタンスをスケール0で消し、同じジオメトリ/材質の小プールで
// 物理飛翔（初速=攻撃威力比例・回転・バウンド→沈んで消滅）を演じる。
const props = [];                // {kind, mesh, index, x, y, z, ry, s, h, r, dead, glowIndex?, bulbStart?}
let streetGlowMesh = null;       // 街灯の発光球（破壊時に一緒に消す）
const PROP_FLY_MAX = 20;         // 種類ごとの同時飛翔数（超えたら古いものを再利用）
const PROP_FLY_LIFE = 6.5;       // 飛翔→着地→沈んで消えるまでの秒数
const propFly = {};              // kind -> {mesh, slots, idx}
const _pfM = new THREE.Matrix4(), _pfS = new THREE.Vector3();
const _pfDq = new THREE.Quaternion(), _pfUp = new THREE.Vector3(0, 1, 0);
function registerPropKind(kind, geo, mat) {
  if (propFly[kind]) {   // 再構築時: 古いプールと登録を捨てる
    scene.remove(propFly[kind].mesh);
    for (let i = props.length - 1; i >= 0; i--) if (props[i].kind === kind) props.splice(i, 1);
  }
  const mesh = new THREE.InstancedMesh(geo, mat, PROP_FLY_MAX);
  mesh.frustumCulled = false;
  _pfM.makeScale(0, 0, 0);
  const slots = [];
  for (let i = 0; i < PROP_FLY_MAX; i++) {
    mesh.setMatrixAt(i, _pfM);
    slots.push({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(), axis: new THREE.Vector3(1, 0, 0), spin: 0, s: 1, gy: 0, t: 0, bounces: 0 });
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);   // 最初からシーンに置く＝パイプラインを事前コンパイル（初回ヒット時のカクつき回避）
  propFly[kind] = { mesh, slots, idx: 0 };
}
function smashProp(p, dx, dz, power = 1) {   // (dx,dz)=吹っ飛ぶ水平方向（内部で正規化）
  if (p.dead) return;
  p.dead = true;
  _pfM.makeScale(0, 0, 0);
  p.mesh.setMatrixAt(p.index, _pfM);
  p.mesh.instanceMatrix.needsUpdate = true;
  const _gm = p.glowMesh || streetGlowMesh;
  if (p.glowIndex != null && _gm) { _gm.setMatrixAt(p.glowIndex, _pfM); _gm.instanceMatrix.needsUpdate = true; }
  if (p.bulbStart != null && signalMesh) {
    for (let k = 0; k < 3; k++) signalMesh.setMatrixAt(p.bulbStart + k, _pfM);
    signalMesh.instanceMatrix.needsUpdate = true;
  }
  const F = propFly[p.kind];
  if (!F) return;
  const sl = F.slots[F.idx]; F.idx = (F.idx + 1) % PROP_FLY_MAX;
  const dl = Math.hypot(dx, dz);
  const nx = dl > 0.001 ? dx / dl : Math.cos(p.ry), nz = dl > 0.001 ? dz / dl : Math.sin(p.ry);
  const v = (7 + 6 * power) * (0.85 + Math.random() * 0.3);   // 初速=威力比例
  sl.active = true; sl.t = 0; sl.bounces = 0; sl.s = p.s; sl.gy = p.y;
  sl.pos.set(p.x, p.y + 0.1, p.z);
  sl.q.setFromAxisAngle(_pfUp, p.ry);
  sl.vel.set(nx * v, 4.5 + 3 * power, nz * v);
  sl.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  sl.spin = (2.5 + Math.random() * 3.5) * (0.7 + 0.4 * power);
}
const _propC = new THREE.Vector3();
function rayNearestProp(o, d, maxT) {   // 最手前の1本（縦長なので中腹の球で近似）
  let best = null, bestT = Infinity;
  for (const p of props) {
    if (p.dead) continue;
    _propC.set(p.x, p.y + p.h * 0.55, p.z);
    const t = rayHitSphere(o, d, _propC, p.r, maxT);
    if (t < bestT) { bestT = t; best = p; }
  }
  return best ? { prop: best, t: bestT } : null;
}
function raySmashProps(o, d, maxT, power) {   // 貫通系: 射線上の全部をなぎ倒す
  for (const p of props) {
    if (p.dead) continue;
    _propC.set(p.x, p.y + p.h * 0.55, p.z);
    if (rayHitSphere(o, d, _propC, p.r, maxT) < Infinity) smashProp(p, d.x, d.z, power);
  }
}
function blastPropsAt(point, radius, power) {   // 着弾点の巻き込み（放射状に飛ぶ）
  const r2 = radius * radius;
  for (const p of props) {
    if (p.dead) continue;
    const dx = p.x - point.x, dz = p.z - point.z;
    if (dx * dx + dz * dz > r2) continue;
    if (Math.abs(p.y - point.y) > p.h + radius) continue;   // ビル屋上着弾など高さ違いは除外
    smashProp(p, dx, dz, power);
  }
}
function updatePropFly(dt) {
  for (const kind in propFly) {
    const F = propFly[kind];
    let dirty = false;
    for (let i = 0; i < F.slots.length; i++) {
      const sl = F.slots[i];
      if (!sl.active) continue;
      sl.t += dt;
      dirty = true;
      if (sl.t > PROP_FLY_LIFE) {
        sl.active = false;
        _pfM.makeScale(0, 0, 0);
        F.mesh.setMatrixAt(i, _pfM);
        continue;
      }
      sl.vel.y -= 22 * dt;
      sl.pos.addScaledVector(sl.vel, dt);
      if (sl.pos.y < sl.gy && sl.vel.y < 0) {   // 元の接地高さでバウンド（近傍に落ちる前提の近似）
        sl.pos.y = sl.gy;
        if (sl.bounces++ < 2) { sl.vel.y *= -0.35; sl.vel.x *= 0.5; sl.vel.z *= 0.5; sl.spin *= 0.5; }
        else { sl.vel.set(0, 0, 0); sl.spin = 0; }
      }
      if (sl.t > PROP_FLY_LIFE - 1.3) sl.pos.y -= dt * 1.5;   // 最後は地面へ沈んで消える
      if (sl.spin > 0) { _pfDq.setFromAxisAngle(sl.axis, sl.spin * dt); sl.q.premultiply(_pfDq); }
      _pfS.setScalar(sl.s);
      _pfM.compose(sl.pos, sl.q, _pfS);
      F.mesh.setMatrixAt(i, _pfM);
    }
    if (dirty) F.mesh.instanceMatrix.needsUpdate = true;
  }
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
    if (edgeKindByPair.size) {   // 幹線は進行方向の左側車線へ（左側通行）＝分離帯の上を走らせない
      const ek = edgeKindByPair.get(car.aId < car.bId ? car.aId + '|' + car.bId : car.bId + '|' + car.aId);
      if (ek === 'avenue') {
        const inv = 1 / Math.sqrt(dx * dx + dz * dz || 1);
        car.mesh.position.x += dz * inv * AVE_DUAL_OFF;
        car.mesh.position.z += -dx * inv * AVE_DUAL_OFF;
      }
    }
    if (dx * dx + dz * dz > 1e-6) car.mesh.rotation.y = Math.atan2(dx, dz) + CAR_FACE;
  }
}

function setupControls() {
  const cv = renderer.domElement;
  cv.addEventListener('click', () => { if (!locked && !agentEd.open) cv.requestPointerLock(); });
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
      else if (player.chargeT >= ULT_CHARGE_TIME - 0.01) fireUltimate();   // ゲージ満タン＝電撃乱射
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
    if (agentEd.open && e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;   // 入力欄への打鍵はゲームに流さない
    if (e.code === 'KeyM') { toggleAgentEd(); return; }
    if (agentEd.open) return;   // エディタ表示中はゲーム操作を止める
    keysDown[e.code] = true;
    if (e.code === 'KeyE' && locked) onInteract();
    if (e.code === 'KeyT') timeScale = timeScale === 1 ? 10 : timeScale === 10 ? 60 : 1;   // 時間の早送り（動作確認用）
  });
  window.addEventListener('keyup', (e) => { keysDown[e.code] = false; });
  window.addEventListener('wheel', (e) => { flight.maxSpeed = Math.max(4, Math.min(2000, flight.maxSpeed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); });   // 基準8まで戻せるよう下限4
  if (IS_TOUCH) setupTouchControls(cv);
}

// ── スマホ用タッチ操作（PCは従来どおり。粗ポインタ検出で自動有効化）──
// 左半分=仮想スティック(移動) / 右半分=ドラッグで視点。右側タップ=通常ビーム、
// 長押し=掴み（対象が居れば）／対象なしはチャージ→離してラージビーム。掴み中は指を離すと投擲
const IS_TOUCH = (typeof window !== 'undefined') && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
const TOUCH_HOLD = 0.28;         // 長押し判定(秒)
const TOUCH_LOOK = 0.0045;       // 視点感度
function setupTouchControls(cv) {
  for (const el of document.querySelectorAll('.touch-ui')) el.style.display = el.classList.contains('touch-btn') ? 'flex' : 'block';
  $('joystick-base').style.display = 'none';
  $('touch-charge').style.display = 'none';
  const hint = $('hint');
  if (hint) hint.textContent = '左半分ドラッグ=移動 / ▲▼=昇降 / 右半分ドラッグ=視点 / 右タップ=ビーム / 長押し=掴む(対象なしはチャージ→離してラージ) / 掴み中は指を離すと投擲';
  locked = true;   // タッチはポインタロック不要＝入力を常時有効化
  // 仮想スティック（左半分）
  const base = $('joystick-base'), stick = $('joystick-stick');
  let moveId = null, moveCx = 0, moveCy = 0;
  const JOY_R = 55;
  const setMoveKeys = (dx, dy) => {
    const t = JOY_R * 0.3;
    keysDown['KeyW'] = dy < -t; keysDown['KeyS'] = dy > t;
    keysDown['KeyA'] = dx < -t; keysDown['KeyD'] = dx > t;
  };
  // 視点＋アクション（右半分）
  let lookId = null, lookX = 0, lookY = 0, downT = 0, moved = 0, holdFired = false, touchGrabbed = false;
  const holdCheck = () => {   // 長押し成立: まず掴みを試し、ダメならチャージ開始
    if (holdFired || lookId == null || player.eating) return;
    holdFired = true;
    grabTarget();
    if (isHolding()) { touchGrabbed = true; return; }
    player.charging = true; player.chargeT = 0;
    $('touch-charge').style.display = 'block';
  };
  cv.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth / 2 && moveId == null) {   // 左=スティック出現
        moveId = t.identifier; moveCx = t.clientX; moveCy = t.clientY;
        base.style.display = 'block';
        base.style.left = (moveCx - 70) + 'px'; base.style.top = (moveCy - 70) + 'px';
        stick.style.transform = 'translate(0px,0px)';
      } else if (lookId == null) {                                  // 右=視点/アクション
        lookId = t.identifier; lookX = t.clientX; lookY = t.clientY;
        downT = performance.now(); moved = 0; holdFired = false; touchGrabbed = false;
      }
    }
  }, { passive: false });
  cv.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - moveCx, dy = t.clientY - moveCy;
        const d = Math.hypot(dx, dy);
        if (d > JOY_R) { dx *= JOY_R / d; dy *= JOY_R / d; }
        stick.style.transform = `translate(${dx}px,${dy}px)`;
        setMoveKeys(dx, dy);
      } else if (t.identifier === lookId) {
        const dx = t.clientX - lookX, dy = t.clientY - lookY;
        lookX = t.clientX; lookY = t.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        camYaw -= dx * TOUCH_LOOK;
        camPitch = Math.max(-1.25, Math.min(1.35, camPitch - dy * TOUCH_LOOK));
      }
    }
    if (lookId != null && !holdFired && moved < 18 && performance.now() - downT >= TOUCH_HOLD * 1000) holdCheck();
  }, { passive: false });
  const endTouch = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        moveId = null;
        base.style.display = 'none';
        setMoveKeys(0, 0);
      } else if (t.identifier === lookId) {
        lookId = null;
        if (!holdFired && moved < 18 && performance.now() - downT >= TOUCH_HOLD * 1000) holdCheck();   // move無しの長押し
        if (touchGrabbed) releaseGrab();                        // 掴み解放＝投擲
        else if (player.charging) {                             // チャージ解放
          player.charging = false;
          $('touch-charge').style.display = 'none';
          if (!player.eating) {
            if (player.chargeT < TAP_THRESHOLD) normalShot();
            else if (player.chargeT >= ULT_CHARGE_TIME - 0.01) fireUltimate();
            else fireLargeBeam();
          }
        } else if (!holdFired && moved < 18 && !player.eating) normalShot();   // 短タップ=通常ビーム
        touchGrabbed = false; holdFired = false;
      }
    }
  };
  cv.addEventListener('touchend', endTouch, { passive: false });
  cv.addEventListener('touchcancel', endTouch, { passive: false });
  // 長押し判定は移動が無くても発火させる（ポーリング）
  setInterval(() => {
    if (lookId != null && !holdFired && moved < 18 && performance.now() - downT >= TOUCH_HOLD * 1000) holdCheck();
    if (player.charging) $('touch-charge').textContent = player.chargeT >= ULT_CHARGE_TIME - 0.01 ? 'MAX!! 離して乱射' : `チャージ ${(Math.min(player.chargeT / ULT_CHARGE_TIME, 1) * 100) | 0}%`;
    else $('touch-charge').style.display = 'none';   // トーテム分岐などでチャージが解除された場合も消す
    const be = $('btn-enter');
    if (be) be.style.display = entryPrompt ? 'flex' : 'none';   // 入退室ボタンはプロンプトが出ている時だけ
  }, 120);
  $('btn-up').addEventListener('touchstart', (e) => { e.preventDefault(); keysDown['Space'] = true; }, { passive: false });
  $('btn-up').addEventListener('touchend', (e) => { e.preventDefault(); keysDown['Space'] = false; }, { passive: false });
  $('btn-down').addEventListener('touchstart', (e) => { e.preventDefault(); keysDown['ShiftLeft'] = true; }, { passive: false });
  $('btn-down').addEventListener('touchend', (e) => { e.preventDefault(); keysDown['ShiftLeft'] = false; }, { passive: false });
  $('btn-enter').addEventListener('touchstart', (e) => { e.preventDefault(); onInteract(); }, { passive: false });
}

const _clock = new THREE.Clock();
let _dbg = 0;
// map-editor の建物差分を自動配置へ適用（IDは自動配置の元座標から＝moved適用前に計算）
function applyMapBuildings(gen) {
  const rm = new Set(mapBuildings.removed || []);
  const mv = mapBuildings.moved || {};
  const out = [];
  for (const it of gen.instances) {
    const id = instanceId(it);
    if (rm.has(id)) continue;
    const m = mv[id];
    if (m) {
      it.x = m.x; it.z = m.z;
      if (m.ry != null) it.ry = m.ry;
      it.y = mapTerrain ? mapTerrain.heightAt(it.x, it.z) : it.y;
    }
    out.push(it);
  }
  for (const a of (mapBuildings.added || [])) {
    out.push({
      kit: a.kit, model: a.model, tier: a.tier || 'house',
      x: a.x, z: a.z, ry: a.ry || 0, s: a.s || 1, tall: a.tier !== 'house',
      y: mapTerrain ? mapTerrain.heightAt(a.x, a.z) : groundYAt(a.x, a.z, 0),
    });
  }
  console.log('map buildings diff: removed', rm.size, 'moved', Object.keys(mv).length, 'added', (mapBuildings.added || []).length);
  gen.instances = out;
}
// ── Kenney 都市（実道路網に建物を手続き配置＝巨大ステージの土台）──
const BLD_KIT_DIR = { city: 'city_GLB format/', suburban: 'kenney_city-kit-suburban_20/Models/GLB format/', industrial: 'Industrial_GLB format/' };
let cityRoot = null;        // scene 直下の建物ルート（モデル単位の InstancedMesh 群）
let cityDamaged = null;     // 破壊で単体化した建物のルート（レイキャスト対象に含める）
let cityInfo = null;
// 距離2段LOD: 近=フルモデル / 遠=バウンディングボックスの箱ポリ（頂点数を桁で削減）。定期再振り分け＋ヒステリシス
const LOD_NEAR = 700, LOD_HYST = 100, LOD_INTERVAL = 0.4;
const bldModels = [];       // { tpl, near, far, recs:[{m,x,z,boxIdx,dead,isFar,carve}] }
let _lodT = 0, _lodNearCount = 0, _lodFarCount = 0;

async function buildKenneyCity() {
  if (NO_CITY) { console.log('city: ?nocity=1 のため建物をスキップ'); return; }   // 性能切り分け
  if (!activeEdges.length) { console.warn('city: no road edges'); return; }
  // 活性エッジ(world XZ＋DEM Y)→ジェネレータ
  const edges = activeEdges.map((e) => [e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z]);
  const gen = generateBuildings(edges, { seed: 20260706, ...(mapBldParams || {}) });
  if (mapBuildings) applyMapBuildings(gen);   // map-editorの差分（削除/移動/追加）
  cityInfo = { count: gen.instances.length, zones: gen.zones };
  console.log('city buildings', gen.instances.length, gen.zones);

  // 進入マーカー（entry-editor 製）: モデル相対パス -> [{kind:'door'|'window'|'light'|'glow', ...}]
  await loadBldEntries();

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
  try { buildWindowGlows(); } catch (e) { console.warn('窓発光生成失敗', e); }   // 窓の光漏れ（夜用）
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
// ── 敵側の建物ヒット用: collGrid AABB直判定（1.2万インスタンスの三角形レイキャストを排除）──
let boxToBld = null;   // boxIdx -> { md, rec }
function ensureBoxMap() {
  if (boxToBld && boxToBld.length === collBoxes.length) return;
  boxToBld = new Array(collBoxes.length);
  for (const md of bldModels) for (const rec of md.recs) if (rec.boxIdx != null) boxToBld[rec.boxIdx] = { md, rec };
}
const _rbSeen = new Set();
function rayCityBox(ox, oy, oz, dx, dy, dz, far) {   // レイが最初に当たる建物ボックス {bi, t}（無ければ null）
  ensureBoxMap();
  _rbSeen.clear();
  let bestT = Infinity, bestBi = -1;
  const step = COLL_CELL * 0.5;
  const n = Math.ceil(far / step);
  for (let i = 0; i <= n; i++) {
    const t0 = Math.min(far, i * step);
    const cx = Math.floor((ox + dx * t0) / COLL_CELL), cz = Math.floor((oz + dz * t0) / COLL_CELL);
    for (let z2 = -1; z2 <= 1; z2++) for (let x2 = -1; x2 <= 1; x2++) {
      const key = (cx + x2) + '_' + (cz + z2);
      if (_rbSeen.has(key)) continue;
      _rbSeen.add(key);
      const arr = collGrid.get(key);
      if (!arr) continue;
      for (const bi of arr) {
        const b = collBoxes[bi];
        if (b.top <= b.bottom) continue;
        let tmin = 0, tmax = far, t1, t2, tt;   // AABBスラブ判定
        if (Math.abs(dx) < 1e-9) { if (ox < b.x - b.h || ox > b.x + b.h) continue; }
        else { t1 = (b.x - b.h - ox) / dx; t2 = (b.x + b.h - ox) / dx; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) continue; }
        if (Math.abs(dy) < 1e-9) { if (oy < b.bottom || oy > b.top) continue; }
        else { t1 = (b.bottom - oy) / dy; t2 = (b.top - oy) / dy; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) continue; }
        if (Math.abs(dz) < 1e-9) { if (oz < b.z - b.h || oz > b.z + b.h) continue; }
        else { t1 = (b.z - b.h - oz) / dz; t2 = (b.z + b.h - oz) / dz; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) continue; }
        if (tmin < bestT) { bestT = tmin; bestBi = bi; }
      }
    }
    if (bestBi >= 0 && bestT <= t0) break;   // 探索済み距離より手前で確定
  }
  return bestBi >= 0 ? { bi: bestBi, t: bestT } : null;
}
const _boxHitP = new THREE.Vector3();
function hitBoxBuilding(bi, px, py, pz, dmg, fxScale, src) {   // boxIdx→建物レコードへ直ダメージ（applyHitToBuilding 相当）
  const e = boxToBld && boxToBld[bi];
  if (!e) return;
  _boxHitP.set(px, py, pz);
  if (e.rec.carve) applyCarve(e.rec.carve, _boxHitP, dmg, fxScale, src);
  else if (!e.rec.dead) damageBuildingRec(e.rec, e.md, _boxHitP, dmg, fxScale, src);
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
const BLD_DECAY_TIME = 28;   // 被弾後、放置してもこの秒数で自壊しきる（基準値）
const BLD_DECAY_ACCEL = 6;   // ダメージが進むほど自壊が加速する係数（progの2乗に掛ける）
const BLD_MAX_TILT = 0.14;   // 自壊進行での最大傾き(rad)
const dyingList = [];        // 崩壊アニメ中の rec（建物レコードの carve に紐付く）
const damagedList = [];      // 被弾済み（自壊進行中）の rec
const shotFx = [];           // ビーム/フラッシュのフェード
const _shootRay = new THREE.Raycaster();
const _camDir = new THREE.Vector3(), _muzzle = new THREE.Vector3(), _vk = new THREE.Vector3();

// 命中点中心の球状カーブ（局所ディソルブ）マテリアル。CARVE_MAX 個の球の内側を discard＝欠損。縁は発光。
// アンリットの MeshBasicNodeMaterial を使う（Standardノード材質だと WebGPU で真っ黒になったため）。
// colormap をそのまま色に出すので黒化しない。fx-dissolve の水たまりと同系の実績パターン。
function makeCarveMaterial(srcMat, baseY, height, flashU) {
  const nm = new THREE.MeshBasicNodeMaterial();
  const base = (srcMat && srcMat.map) ? texture(srcMat.map, uv()) : color(srcMat?.color ? '#' + srcMat.color.getHexString() : '#bfc4cc');
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
  nm.colorNode = flashU ? charred.add(ember).add(color('#ff2418').mul(flashU)) : charred.add(ember);   // flashU=被弾の赤フラッシュ（ウォーカー用）
  nm.opacityNode = alpha;
  nm.alphaTest = 0.5;
  nm.side = THREE.DoubleSide;
  nm.needsUpdate = true;
  return { mat: nm, uCenters, uRadii, uKill, uKillOn, uBaseY, uHeight };
}

function damageBuilding(instMesh, instanceId, point, dmg = DMG_SHOT, fxScale = 1, src = null) {
  const rec0 = (instMesh.userData.slots || [])[instanceId];   // LOD振り分けの slot から建物レコードへ逆引き（近/遠どちらの命中でも同じレコード）
  const md = instMesh.userData.md;
  if (!rec0 || !md) return;
  damageBuildingRec(rec0, md, point, dmg, fxScale, src);
}
function damageBuildingRec(rec0, md, point, dmg = DMG_SHOT, fxScale = 1, src = null) {   // レコード直指定（ボックス判定経路と共用）
  if (rec0.dead) return;
  if (rec0.carve) { applyCarve(rec0.carve, point, dmg, fxScale, src); return; }
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
    baseY0: baseY, height, hits: 0, boxIdx: rec0.boxIdx, carveR, bldRec: rec0,
    hp: hpMax, hpMax, decay: hpMax / BLD_DECAY_TIME,
    tiltAxis: new THREE.Vector3(Math.cos(tiltA), 0, Math.sin(tiltA)),
    pivot: new THREE.Vector3(_p2.x, baseY, _p2.z),   // 傾き回転の支点（基部中心）
    dying: false, dieT: 0,
  };
  std.userData.rec = rec;
  rec0.carve = rec;
  damagedList.push(rec);   // 以後、自壊（スロー減衰＋傾き）が進行
  applyCarve(rec, point, dmg, fxScale, src);
}
function applyCarve(rec, point, dmg = DMG_SHOT, fxScale = 1, src = null) {   // 命中点にカーブ球を追加＋HPダメージ。HP0で崩壊
  if (rec.dying) return;
  if (src) rec.lastSrc = src;   // 最後に攻撃した者（崩壊時の手配度判定）
  const i = Math.min(rec.hits, CARVE_MAX - 1);
  rec.uCenters[i].value.copy(point);
  rec.uRadii[i].value = (rec.carveR || CARVE_RADIUS) * (0.9 + Math.random() * 0.35);
  rec.hits++;
  spawnImpactFx(point, fxScale);   // 着弾点に炎＋煙
  spawnDebrisBurst(point, 'bld', dmg < 1 ? 0.5 : 1);   // がれき＋棒材（ラージのtickは少量ずつ=連続的）
  applyBldDamage(rec, dmg);
}
function applyBldDamage(rec, dmg) {
  if (rec.dying) return;
  rec.hp -= dmg;
  if (rec.hp <= 0) startCollapse(rec);
}
function startCollapse(rec) {   // 崩壊開始＋当たり判定を無効化。現在の傾きを基準行列に焼き込む
  if (rec.dying) return;
  gp.destroyed++;   // 都市被害率（誰が壊しても加算）
  if (rec.lastSrc === 'player') addWanted(0.5, rec.pivot);   // プレイヤー起因の建物破壊＝犯罪
  playSfxAt('bakuha.ogg', rec.pivot, 1.0);
  hideBuildingLights(rec.bldRec);   // 窓明かり・屋上ランプを消す（廃墟が光り続けない）
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
function applyHitToBuilding(hit, dmg, fxScale = 1, src = null) {
  if (hit.object.isInstancedMesh && hit.instanceId != null) damageBuilding(hit.object, hit.instanceId, hit.point, dmg, fxScale, src);
  else if (hit.object.userData && hit.object.userData.rec) applyCarve(hit.object.userData.rec, hit.point, dmg, fxScale, src);
}
function hitCarBeam(car) {
  if (car.jet && !car.thrown && !car.dead) {   // 戦闘機: 撃墜＝きりもみ落下（着地/建物で爆発）。落下中に追撃なら即爆発
    addKill();
    car.flashT = 0.35;   // 被弾の赤フラッシュ
    car.shotDown = true; car.thrown = true; car.thrownT = 0;
    car.vel = (car.vel || new THREE.Vector3()).copy(car.flyVel || car.vel || new THREE.Vector3());
    car.vel.y = Math.min(car.vel.y, 2);
    car.angVel = new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    thrownCars.push(car);
    spawnImpactFx(car.mesh.position.clone(), 1);
    return;
  }
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
  for (const car of carsAndJets()) {
    if (car.dead || car.grabbed || car.tornado) continue;
    const t = rayHitSphere(_muzzle, _camDir, car.mesh.position, car.hitR || 2.4, SHOOT_RANGE);
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
  const pr = rayNearestProp(_muzzle, _camDir, SHOOT_RANGE);   // 信号/街灯/街路樹
  const propT = pr ? pr.t : Infinity;
  let mpBest = null, mpT = Infinity;   // マルチプレイ: リモート機
  if (mp) {
    for (const h of mpAvatars.values()) {
      const t = rayHitSphere(_muzzle, _camDir, mpCenterOf(h, _mpV3), 1.1, SHOOT_RANGE);
      if (t < mpT) { mpT = t; mpBest = h; }
    }
  }
  let wkT = Infinity;   // 敵ウォーカー（胴体＋砲塔の2球）
  if (walker && !walker.dying) {
    wkT = rayHitSphere(_muzzle, _camDir, _wkV4.set(walker.pos.x, walker.pos.y + 2, walker.pos.z), 13, SHOOT_RANGE);
    const t2 = rayHitSphere(_muzzle, _camDir, _wkV4.set(walker.pos.x, walker.pos.y + WK.bodyH / 2 + 4.5, walker.pos.z), 7, SHOOT_RANGE);
    if (t2 < wkT) wkT = t2;
  }
  let spT = Infinity;   // スパイダータンク（胴体＋砲塔）
  if (spider && !spider.dying) {
    spT = rayHitSphere(_muzzle, _camDir, _wkV4.set(spider.pos.x, spider.pos.y + 4, spider.pos.z), 38, SHOOT_RANGE);
    const t3 = rayHitSphere(_muzzle, _camDir, _wkV4.set(spider.pos.x, spider.pos.y + SP.bodyH / 2 + 12, spider.pos.z), 18, SHOOT_RANGE);
    if (t3 < spT) spT = t3;
  }
  let mslT2 = Infinity, mslBest = null;   // 誘導ミサイル（撃ち落とせる）
  for (const ms of spMissiles) {
    const t4 = rayHitSphere(_muzzle, _camDir, ms.mesh.position, 2.8, SHOOT_RANGE);
    if (t4 < mslT2) { mslT2 = t4; mslBest = ms; }
  }
  const minT = Math.min(bldT, carT, kenT, gndT, propT, mpT, wkT, spT, mslT2);
  const end = _muzzle.clone().addScaledVector(_camDir, minT === Infinity ? SHOOT_RANGE : minT);
  attackAim.copy(end); attackAimActive = true;   // FXビームの到達点＝この実着弾点
  spawnBeam(_vk.set(player.pos.x, player.pos.y + 1.2, player.pos.z), end, minT !== Infinity, colorHex, thick);
  if (minT === Infinity) return;
  playSfxAt(thick ? 'bomb.ogg' : 'bomb_short.ogg', end, thick ? 0.95 : 0.7);
  if (minT === mslT2) { destroySpMissile(mslBest); return; }
  if (minT === spT) { spiderHit(end, bldDmg * 6); return; }
  if (minT === wkT) { walkerHit(end, bldDmg * 6); return; }
  if (minT === mpT) { mp.sendHit(mpBest.id, MP_DMG.beam, 'beam'); spawnImpactFx(end, 1); }
  else if (minT === propT) { smashProp(pr.prop, _camDir.x, _camDir.z, bldDmg); spawnImpactFx(end, 1); }
  else if (minT === bldT) applyHitToBuilding(hits[0], bldDmg, 1, 'player');
  else if (minT === carT) hitCarBeam(carBest);
  else if (minT === kenT) hitKenBeam(kenBest, kenDmg);
  else if (minT === gndT) {   // 地形着弾: 岩の吹き上げ＋火柱＋焦げ跡。道路上なら穴＋アスファルト片
    const onRoad = roadTopAt(end.x, end.z) != null;
    spawnDebrisBurst(end, onRoad ? 'road' : 'ground', thick ? 1.4 : 1);
    spawnFirePillar(end, thick ? 1.5 : 1);
    spawnScorch(end, thick ? 3.6 : 2.6);
    if (onRoad) spawnRoadCarve(end, thick ? 2.8 : 2.1);
  }
}
function snapYawToView() { player.yaw = camYaw; }   // 発射時に一回だけ体を視点方向へ
function normalShot() {
  if (playerDead) return;
  shotComboT = 0;
  if (++shotComboN >= 3) { shotComboN = 0; superShot(); return; }   // 3連目＝スーパービーム
  if (grabbedCar) { snapYawToView(); launchHeldCar(); triggerOneShot('shot'); return; }   // 抱えた車を前方へ射出
  snapYawToView();
  triggerOneShot('shot');
  playSfx('beam.ogg', 0.55);
  fireBeam(DMG_SHOT, KEN_DMG_SHOT, 0xffb040, false);
}
let pendingSuper = 0;   // スーパービームの発射待ち（タイムラインFX開始に同期）
function superShot() {
  snapYawToView();
  triggerOneShot('lightning');
  // 発射タイミング＝lightningタイムラインの最初のeffectトラック開始フレーム
  const st = player.states.lightning;
  const trk = st?.timeline?.tracks?.find((t) => t.kind === 'effect');
  const f = trk ? (trk.start ?? trk.frame ?? 0) : 8;
  pendingSuper = st ? Math.max(0.02, (f - st.trimIn) / st.fps / (st.speed || 1)) : 0.25;
}
// スーパービーム実発射: 貫通（射線上の建物全部・車・ken）＋着弾FXは3倍
function fireSuperPierce() {
  if (!player.ready || !cityRoot) return;
  camera.getWorldDirection(_camDir);
  camera.getWorldPosition(_muzzle);
  _shootRay.set(_muzzle, _camDir);
  _shootRay.far = SHOOT_RANGE;
  const gndHit = (groundGroup && groundGroup.children.length) ? _shootRay.intersectObject(groundGroup, true)[0] : null;
  const endT = Math.min(gndHit ? gndHit.distance : Infinity, SHOOT_RANGE);
  const end = _muzzle.clone().addScaledVector(_camDir, endT);
  attackAim.copy(end);
  attackAimActive = true;
  spawnBeam(_vk.set(player.pos.x, player.pos.y + 1.2, player.pos.z), end, false, 0x9fd8ff, true);
  playSfx('beam.ogg', 0.7);
  _shootRay.far = endT;
  const hits = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true);
  for (let i = 0; i < Math.min(hits.length, 8); i++) applyHitToBuilding(hits[i], DMG_LIGHTNING, 3, 'player');   // 貫通・各命中点3倍FX
  if (hits.length) playSfxAt('bomb.ogg', hits[0].point, 0.95);
  else if (gndHit) playSfxAt('bomb.ogg', end, 0.95);
  if (walker && !walker.dying) {   // 敵ウォーカーにも貫通ヒット
    const tw = Math.min(
      rayHitSphere(_muzzle, _camDir, _wkV4.set(walker.pos.x, walker.pos.y + 2, walker.pos.z), 13, endT),
      rayHitSphere(_muzzle, _camDir, _wkV4.set(walker.pos.x, walker.pos.y + WK.bodyH / 2 + 4.5, walker.pos.z), 7, endT));
    if (tw < Infinity) walkerHit(_wkV4.copy(_muzzle).addScaledVector(_camDir, tw), DMG_LIGHTNING * 6);
  }
  for (let mi = spMissiles.length - 1; mi >= 0; mi--) {   // 射線上の誘導ミサイルは全て爆破
    if (rayHitSphere(_muzzle, _camDir, spMissiles[mi].mesh.position, 2.8, endT) < Infinity) destroySpMissile(spMissiles[mi]);
  }
  if (spider && !spider.dying) {   // スパイダータンクにも貫通ヒット
    const ts2 = Math.min(
      rayHitSphere(_muzzle, _camDir, _wkV4.set(spider.pos.x, spider.pos.y + 4, spider.pos.z), 38, endT),
      rayHitSphere(_muzzle, _camDir, _wkV4.set(spider.pos.x, spider.pos.y + SP.bodyH / 2 + 12, spider.pos.z), 18, endT));
    if (ts2 < Infinity) spiderHit(_wkV4.copy(_muzzle).addScaledVector(_camDir, ts2), DMG_LIGHTNING * 6);
  }
  raySmashProps(_muzzle, _camDir, endT, 2.2);   // 射線上の信号/街灯/街路樹もなぎ倒す
  if (mp) {
    for (const h of mpAvatars.values()) {
      if (rayHitSphere(_muzzle, _camDir, mpCenterOf(h, _mpV3), 1.1, endT) < Infinity) {
        mp.sendHit(h.id, MP_DMG.super, 'super');
        spawnImpactFx(mpCenterOf(h, _mpV3), 3);
      }
    }
  }
  for (const car of carsAndJets()) {
    if (car.dead || car.grabbed || car.tornado) continue;
    if (rayHitSphere(_muzzle, _camDir, car.mesh.position, car.hitR || 2.4, endT) < Infinity) hitCarBeam(car);
  }
  for (const m of kens) {
    if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
    kenCenter(m, _vk);
    if (rayHitSphere(_muzzle, _camDir, _vk, 0.85, endT) < Infinity) hitKenBeam(m, KEN_DMG_LIGHTNING);
  }
  if (gndHit && endT < SHOOT_RANGE) {   // 地面到達: 3倍の着弾FX＋大きめの岩/火柱/焦げ
    spawnImpactFx(end, 3);
    const onRoad = roadTopAt(end.x, end.z) != null;
    spawnDebrisBurst(end, onRoad ? 'road' : 'ground', 2);
    spawnFirePillar(end, 2.2);
    spawnScorch(end, 4.5);
    if (onRoad) spawnRoadCarve(end, 2.8);
  } else if (hits.length) spawnImpactFx(end, 3);
}
// ── アルティメット: チャージゲージ満タン(4.5s)で解放＝電撃ビーム乱射（drain0→drain1再生）──
// electric.png 4×4/18fps・帯幅2/2.5/3循環・ランダム経路(setPathMode)・視線コーンに拡散連射
const ULT_CHARGE_TIME = 4.5, ULT_FIRE_DUR = 7.0, ULT_POOL = 10, ULT_SHOOT_INT = 0.07;
const ULT_RING_MIN = 18, ULT_RING_MAX = 126, ULT_SKY_H = 80;   // 落雷リング半径と天の高さ
const ULT_DMG_BLD = 1.5, ULT_DMG_KEN = 45, ULT_HIT_R = 3.2;  // 着弾点の巻き込み半径
const ULT_WIDTHS = [6, 8, 10];   // 帯太さ（循環）
const ult = { active: false, phase: 'intro', t: 0, shootT: 0, pool: [], idx: 0, prewarmT: 0, shotN: 0 };
function initUltFx() {
  if (ult.pool.length) return;
  for (let i = 0; i < ULT_POOL; i++) {
    const fx = createBeamFx({ style: 'jagged', width: 2, jitter: 0.5, freq: 14, scroll: 1.2, repeat: 3, emissive: 2.0, coreAmt: 0.5 });
    fx.setTexture('../electric.png', 4, 4, 18);
    fx.setPathMode(true);
    // prewarm: 地下で一度描画してパイプラインをコンパイル→数秒後に消灯
    fx.setEmitting(true);
    const a = new THREE.Vector3(i * 4, -650, 0), b = new THREE.Vector3(i * 4 + 6, -650, 4);
    fx.setPathPoints([a, a.clone().lerp(b, 0.5), b], camera.position, true);
    scene.add(fx.object3D);
    ult.pool.push({ fx, ttl: 0 });
  }
  ult.prewarmT = 2.5;
}
function fireUltimate() {
  ult.active = true; ult.phase = 'intro'; ult.t = 0; ult.shootT = 0;
  playSfx('Thunder-Real_Ambi03-1.ogg', 0.9);   // 雷鳴アンビエンス（解放の合図）
  triggerOneShot('drain0');   // 導入モーション（この間は撃たない）→ drain1開始と同時に落雷開始
}
const _ultFrom = new THREE.Vector3(), _ultDir = new THREE.Vector3(), _ultEnd = new THREE.Vector3();
const _ultMid = new THREE.Vector3(), _ultMid2 = new THREE.Vector3(), _ultSide = new THREE.Vector3();
function fireUltBeam() {
  const s = ult.pool[ult.idx];
  ult.idx = (ult.idx + 1) % ULT_POOL;
  // 落雷点＝プレイヤー周囲のリング内ランダム
  const ang = Math.random() * Math.PI * 2;
  const r = ULT_RING_MIN + Math.random() * (ULT_RING_MAX - ULT_RING_MIN);
  const x = player.pos.x + Math.cos(ang) * r;
  const z = player.pos.z + Math.sin(ang) * r;
  const gy = groundYAt(x, z, player.pos.y);
  _ultEnd.set(x, gy, z);
  // 天から降らせる（起点は上空・少し横にずらして斜めの稲妻に）
  _ultFrom.set(x + (Math.random() - 0.5) * 14, Math.max(gy, player.pos.y) + ULT_SKY_H, z + (Math.random() - 0.5) * 14);
  _ultDir.copy(_ultEnd).sub(_ultFrom).normalize();
  // 途中の建物に当たればそこで止めてダメージ
  _shootRay.set(_ultFrom, _ultDir);
  _shootRay.far = _ultFrom.distanceTo(_ultEnd) + 4;
  const bHits = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true);
  const hitBld = bHits.length > 0;
  if (hitBld) _ultEnd.copy(bHits[0].point);
  // ランダム経路: 中間2点を横方向へ大きく散らした落雷ジグザグ
  playSfx('beam.ogg', 0.4);   // 降り注ぐ雷（多重制限でロール状に鳴る）
  const off = 4 + Math.random() * 8;
  _ultMid.copy(_ultFrom).lerp(_ultEnd, 0.35);
  _ultMid.x += (Math.random() - 0.5) * off; _ultMid.z += (Math.random() - 0.5) * off; _ultMid.y += (Math.random() - 0.5) * 3;
  _ultMid2.copy(_ultFrom).lerp(_ultEnd, 0.7);
  _ultMid2.x += (Math.random() - 0.5) * off; _ultMid2.z += (Math.random() - 0.5) * off; _ultMid2.y += (Math.random() - 0.5) * 3;
  playSfxAt('bomb.ogg', _ultEnd, 0.7);   // 着弾
  s.fx.setParam('width', ULT_WIDTHS[ult.shotN % ULT_WIDTHS.length]);
  s.fx.setEmitting(true);
  s.fx.setPathPoints([_ultFrom.clone(), _ultMid.clone(), _ultMid2.clone(), _ultEnd.clone()], camera.position, true);
  s.ttl = 0.22;
  ult.shotN++;
  // ダメージ＋着弾演出（着弾FXはスーパービームと同じ3倍）
  if (hitBld) applyHitToBuilding(bHits[0], ULT_DMG_BLD, 3, 'player');
  else if (ult.shotN % 2 === 0) {
    spawnImpactFx(_ultEnd, 3);
    const onRoad = roadTopAt(_ultEnd.x, _ultEnd.z) != null;
    spawnDebrisBurst(_ultEnd, onRoad ? 'road' : 'ground', 0.5);
    spawnScorch(_ultEnd, 2.4);
    if (onRoad) spawnRoadCarve(_ultEnd, 1.8);
    if (ult.shotN % 4 === 0) spawnFirePillar(_ultEnd, 1.1);
  }
  for (const m of kens) {   // 着弾点の巻き込み（ken/車）
    if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
    kenCenter(m, _vk);
    if (_vk.distanceTo(_ultEnd) < ULT_HIT_R) hitKenBeam(m, ULT_DMG_KEN);
  }
  for (const car of cars) {
    if (car.dead || car.grabbed || car.tornado) continue;
    if (car.mesh.position.distanceTo(_ultEnd) < ULT_HIT_R) hitCarBeam(car);
  }
  blastPropsAt(_ultEnd, ULT_HIT_R + 2, 2.2);   // 信号/街灯/街路樹は放射状に吹っ飛ぶ
  if (mp) {
    for (const h of mpAvatars.values()) {
      if (mpCenterOf(h, _mpV3).distanceTo(_ultEnd) < ULT_HIT_R) mp.sendHit(h.id, MP_DMG.ult, 'ult');
    }
  }
}
function updateUltimate(dt) {
  if (ult.prewarmT > 0) { ult.prewarmT -= dt; if (ult.prewarmT <= 0) for (const s of ult.pool) s.fx.setEmitting(false); }
  for (const s of ult.pool) {
    if (s.ttl > 0) { s.ttl -= dt; if (s.ttl <= 0) s.fx.setEmitting(false); }
    s.fx.update(dt);
  }
  if (!ult.active) return;
  if (ult.phase === 'intro') {   // drain0再生中は溜め＝撃たない
    if (!player.oneShot) {       // drain0が終わった→drain1ループ開始＝乱射開始
      player.oneShot = { name: 'drain1', until: ULT_FIRE_DUR + 0.2 };
      ult.phase = 'fire';
      ult.t = 0;
      ult.shootT = 0;
    }
    return;
  }
  ult.t += dt;
  ult.shootT -= dt;
  while (ult.shootT <= 0 && ult.active) {
    ult.shootT += ULT_SHOOT_INT;
    fireUltBeam();
  }
  if (ult.t >= ULT_FIRE_DUR) {
    ult.active = false;
    if (player.oneShot?.name === 'drain1') player.oneShot.until = Math.min(player.oneShot.until, 0.15);   // すぐ通常状態へ
  }
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
  updateUltimate(dt);   // アルティメット（乱射＋プールprewarm消灯）
  if (pendingSuper > 0) {   // スーパービーム: タイムラインFXの開始と同時に実発射
    pendingSuper -= dt;
    if (pendingSuper <= 0) fireSuperPierce();
  }
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
    largeBeam.sfxT = (largeBeam.sfxT || 0) - LARGE_BEAM_TICK;
    if (largeBeam.sfxT <= 0) { largeBeam.sfxT = 0.5; playSfxAt('bomb.ogg', _lbEnd, 0.85); }
    spawnImpactFx(_lbEnd);   // 到達点（地形/最遠）にも炎煙
    if (gnd) {   // ラージ直撃中の地面: tick毎に岩＋火柱＝連続的に噴き上がる。焦げ跡と道路穴も掃引で残る
      const onRoad = roadTopAt(_lbEnd.x, _lbEnd.z) != null;
      spawnDebrisBurst(_lbEnd, onRoad ? 'road' : 'ground', 0.6);
      spawnFirePillar(_lbEnd, 1.3);
      spawnScorch(_lbEnd, 3.2);
      if (onRoad) spawnRoadCarve(_lbEnd, 2.4);
    }
    _shootRay.set(_muzzle, _camDir); _shootRay.far = endT;
    const hits = _shootRay.intersectObjects(cityDamaged ? [cityRoot, cityDamaged] : [cityRoot], true);
    for (let i = 0; i < Math.min(hits.length, 8); i++) applyHitToBuilding(hits[i], DMG_LARGE_TICK, 1, 'player');   // 射線上の建物すべて（上限8）
    raySmashProps(_muzzle, _camDir, endT, 1.4);   // 掃引中の信号/街灯/街路樹もなぎ倒す
    if (mp) {
      for (const h of mpAvatars.values()) {
        if (rayHitSphere(_muzzle, _camDir, mpCenterOf(h, _mpV3), 1.1, endT) < Infinity) mp.sendHit(h.id, MP_DMG.large, 'large');
      }
    }
    for (const car of carsAndJets()) {
      if (car.dead || car.grabbed || car.tornado) continue;
      if (rayHitSphere(_muzzle, _camDir, car.mesh.position, car.hitR || 2.4, LARGE_BEAM_RANGE) < Infinity) hitCarBeam(car);
    }
    if (walker && !walker.dying) {   // 敵ウォーカーも削れる
      const tw = rayHitSphere(_muzzle, _camDir, _wkV4.set(walker.pos.x, walker.pos.y + 2, walker.pos.z), 13, LARGE_BEAM_RANGE);
      if (tw < Infinity) walkerHit(_wkV4.copy(_muzzle).addScaledVector(_camDir, tw), DMG_LARGE_TICK * 6);
    }
    if (spider && !spider.dying) {
      const ts3 = rayHitSphere(_muzzle, _camDir, _wkV4.set(spider.pos.x, spider.pos.y + 4, spider.pos.z), 38, LARGE_BEAM_RANGE);
      if (ts3 < Infinity) spiderHit(_wkV4.copy(_muzzle).addScaledVector(_camDir, ts3), DMG_LARGE_TICK * 6);
    }
    for (let mi = spMissiles.length - 1; mi >= 0; mi--) {
      if (rayHitSphere(_muzzle, _camDir, spMissiles[mi].mesh.position, 2.8, LARGE_BEAM_RANGE) < Infinity) destroySpMissile(spMissiles[mi]);
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
  if (mp && !mpRenderingRemote) {
    mp.sendShot({ from: [from.x, from.y, from.z], to: [to.x, to.y, to.z], c: colorHex, thick: !!thick });
  }
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]), new THREE.LineBasicMaterial({ color: colorHex, transparent: true }));
  scene.add(line); shotFx.push({ obj: line, t: 0, dur: thick ? 0.16 : 0.09, kind: 'beam' });
  if (thick) {   // スーパービームは筒を重ねて太く（thick=数値なら半径指定）
    const len = from.distanceTo(to);
    const rr = typeof thick === 'number' ? thick : 0.3;
    const g = new THREE.CylinderGeometry(rr, rr, 1, 8, 1, true); g.rotateX(Math.PI / 2);
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
    // ダメージが深いほど加速して倒れる（軽傷はゆっくり・重傷は一気に傾き崩壊へ）
    const prog0 = 1 - rec.hp / rec.hpMax;
    rec.hp -= rec.decay * (1 + BLD_DECAY_ACCEL * prog0 * prog0) * dt;
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
// ── 効果音（sound/*.ogg。cloneNodeで多重再生）──
const _sfxCache = new Map(), _sfxTimes = new Map();
function playSfx(name, vol = 0.7) {
  try {
    // 連鎖崩壊などで同じ音が重なりすぎないように制限（1.2秒窓で最大4発・最短70ms間隔）
    const now = performance.now();
    let ts = _sfxTimes.get(name);
    if (!ts) { ts = []; _sfxTimes.set(name, ts); }
    while (ts.length && now - ts[0] > 1200) ts.shift();
    if (ts.length >= 4 || (ts.length && now - ts[ts.length - 1] < 70)) return;
    ts.push(now);
    let b = _sfxCache.get(name);
    if (!b) { b = new Audio('../sound/' + name); _sfxCache.set(name, b); }
    const a = b.cloneNode();
    a.volume = Math.max(0, Math.min(1, vol));
    a.play().catch(() => {});
  } catch { /* noop */ }
}
function playSfxAt(name, pos, vol = 0.8) {   // 距離減衰つき
  const d = camera.position.distanceTo(pos);
  playSfx(name, vol * Math.max(0.06, Math.min(1, 80 / Math.max(1, d))));
}

let grabbedCar = null;
const thrownCars = [], respawnCars = [], carDebris = [];
const _grabRay = new THREE.Raycaster();
const _hold = new THREE.Vector3(), _tmpV = new THREE.Vector3();

// 右クリック＝掴む。ken の関節を優先し、無ければ車（照準→前方近傍の順）
function grabTarget() {
  if (isHolding() || playerDead) return;
  camera.getWorldDirection(_camDir); camera.getWorldPosition(_muzzle);
  // ken の関節（tps-flight の nearestNpcJoint 相当）
  let bestKen = null, bestBone = null, bestAlong = GRAB_RANGE;
  for (const m of kens) {
    if (m.dissolving || m.eating || m.grabbed || m.tornado) continue;
    const j = nearestKenJoint(m, _muzzle, _camDir);
    if (j && j.along < bestAlong) { bestAlong = j.along; bestKen = m; bestBone = j.bone; }
  }
  if (bestKen) { grabKen(bestKen, bestBone); triggerOneShot('grab'); return; }
  // 車（照準レイ→無ければ前方近傍の最寄り）。パトカー/電車/客船もプロキシ経由で対象
  if (!carsAndJets().length) return;
  _grabRay.set(_muzzle, _camDir); _grabRay.far = GRAB_RANGE;
  const meshes = carsAndJets().filter((c) => !c.grabbed && !c.thrown && !c.dead && !c.tornado).map((c) => c.mesh);
  const hit = _grabRay.intersectObjects(meshes, true)[0];
  let car = null;
  if (hit) { let o = hit.object; while (o && !o.userData.car) o = o.parent; if (o) car = o.userData.car; }
  if (!car) {
    _tmpV.copy(_muzzle).addScaledVector(_camDir, HOLD_DIST + 8);
    let best = GRAB_RANGE;
    for (const c of carsAndJets()) { if (c.grabbed || c.thrown || c.dead || c.tornado) continue; const d = c.mesh.position.distanceTo(_tmpV); if (d < best) { best = d; car = c; } }
  }
  if (car) {
    car.grabbed = true; grabbedCar = car; car.holdVel = car.holdVel || new THREE.Vector3(); car.holdVel.set(0, 0, 0);
    car.holdSpin = new THREE.Vector3((Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 5);   // TPS Flight風にぐるぐる
    if (car.trainCar) { car.holdSpin.multiplyScalar(0.3); beginTrainHold(car); }   // 電車: 残りの車両がぶら下がる
    if (car.ship) car.holdSpin.multiplyScalar(0.25);                               // 客船はゆっくり
    triggerOneShot('grab');
  }
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
  if (car.trainCar) { car.angVel.multiplyScalar(0.25); car.tRef.tr.state = 'thrownChain'; }   // 投げても後続はぶら下がったまま
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
  if (car.trainCar) { car.angVel.multiplyScalar(0.25); car.tRef.tr.state = 'thrownChain'; }
  thrownCars.push(car);
}

function updateGrab(dt) {
  if (!grabbedCar) return;
  const mesh = grabbedCar.mesh;
  _tmpV.copy(mesh.position);
  mesh.position.lerp(frontAnchor, Math.min(1, 12 * dt));   // 前方アンカーへ吸着（カメラで振り回すと勢いがつく）
  if (dt > 0 && grabbedCar.holdVel) grabbedCar.holdVel.copy(mesh.position).sub(_tmpV).divideScalar(dt);
  const sp = grabbedCar.holdSpin;
  if (sp) { mesh.rotation.x += sp.x * dt; mesh.rotation.y += sp.y * dt; mesh.rotation.z += sp.z * dt; }
  else mesh.rotation.y += dt * 2.2;
}

function updateThrown(dt) {
  for (let k = thrownCars.length - 1; k >= 0; k--) {
    const car = thrownCars[k];
    car.thrownT += dt; car.vel.y -= CAR_GRAV * (car.shotDown ? 0.35 : 1) * dt;   // 撃墜機はゆっくり堕ちる
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
    if (!impact && (car.thrownT > (car.shotDown ? 16 : THROW_LIFE) || p.y < -40)) impact = p.clone();
    if (impact) { thrownCars.splice(k, 1); breakCar(car, impact); }
  }
}

function breakCar(car, point) {
  spawnBreakFx(point);
  if (car.trainCar) {   // 列車車両: 当たった車両は爆散、残りは脱線して落下
    addWanted(1.0, point);
    spawnImpactFx(point, 1.8);
    spawnFirePillar(point, 1.0);
    car.dead = true; car.thrown = false; car.vel = null;
    const { tr, i } = car.tRef;
    tr.cars[i].mesh.visible = false; tr.cars[i].crashed = true;
    wreckTrain(tr);
    return;
  }
  if (car.ship) {   // 客船: 大爆発→しばらくして再入港
    addWanted(1.5, point);
    spawnImpactFx(point, 3.0);
    spawnFirePillar(point, 1.6);
    spawnDebrisBurst(point, 'bld', 1.6);
    car.dead = true; car.thrown = false; car.vel = null;
    car.mesh.visible = false;
    if (portShip) portShip.respawnT = 45;
    return;
  }
  if (car.policeCar) {   // パトカー破壊＝重犯罪（手配度が残っていれば updateWanted が補充する）
    addWanted(1.0, point);
    spawnImpactFx(point, 1.3);
    spawnFirePillar(point, 0.8);
    car.dead = true; car.thrown = false; car.vel = null;
    const i = police.indexOf(car.pRef);
    if (i >= 0) { police.splice(i, 1); scene.remove(car.pRef.mesh); }
    return;
  }
  if (car.jet) {   // 戦闘機: 犯罪ではない。爆発火柱→しばらくして空中へ再出撃
    if (!car.shotDown) addKill();   // 掴み投げ等での直接破壊（撃墜済みは二重カウントしない）
    spawnImpactFx(point, 1.6);
    spawnFirePillar(point, 0.9);
    car.mesh.visible = false; car.thrown = false; car.shotDown = false; car.dead = true; car.vel = null;
    jetRespawn.push({ car, t: 0 });
    return;
  }
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

// ── 汎用破片（建物=がれき+棒 / 地面=岩の吹き上げ）＋火柱 ───────────────────
// 車の破片と同じ軽量方式。ジオメトリ/マテリアルは共有＝WebGPUパイプラインは起動時にprewarm
const debris = [];
const DEBRIS_MAX = 190;
const _debGeo = new THREE.BoxGeometry(1, 1, 1);
const debMats = {
  bldA: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.95 }),   // コンクリ
  bldB: new THREE.MeshStandardMaterial({ color: 0xcbc1b2, roughness: 0.95 }),   // 外壁
  rod: new THREE.MeshStandardMaterial({ color: 0x565c64, roughness: 0.8 }),     // 鉄骨/柱
  rock: new THREE.MeshStandardMaterial({ color: 0x6b5f52, roughness: 1.0 }),    // 岩
  asphalt: new THREE.MeshStandardMaterial({ color: 0x3a3b40, roughness: 1.0 }), // アスファルト片
};
function spawnDebrisBurst(point, kind, scaleN = 1) {
  const n = Math.max(1, Math.round((kind === 'bld' ? 10 : 7) * scaleN));
  const gy = groundYAt(point.x, point.z, point.y);
  for (let i = 0; i < n && debris.length < DEBRIS_MAX; i++) {
    let mat, sx, sy, sz, vel;
    if (kind === 'bld') {
      const rod = i % 3 === 2;   // 1/3は棒状（鉄骨・柱材）
      mat = rod ? debMats.rod : (i % 2 ? debMats.bldA : debMats.bldB);
      if (rod) { sx = 0.22 + Math.random() * 0.18; sy = 2.2 + Math.random() * 2.4; sz = sx; }
      else { const s = 0.9 + Math.random() * 1.4; sx = s; sy = s * (0.6 + Math.random() * 0.8); sz = s * (0.6 + Math.random() * 0.8); }
      vel = new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 5 + 1.5, (Math.random() - 0.5) * 10);   // がれき=散って落ちる
    } else {
      mat = kind === 'road' ? debMats.asphalt : debMats.rock;
      const s = 0.35 + Math.random() * 0.75;
      sx = s; sy = s * (0.7 + Math.random() * 0.7); sz = s * (0.7 + Math.random() * 0.7);
      vel = new THREE.Vector3((Math.random() - 0.5) * 9, 9 + Math.random() * 9, (Math.random() - 0.5) * 9);   // 岩=上向きに吹き上がる
    }
    const d = new THREE.Mesh(_debGeo, mat);
    d.scale.set(sx, sy, sz);
    d.position.copy(point);
    d.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    scene.add(d);
    debris.push({ obj: d, vel, avx: (Math.random() - 0.5) * 9, avz: (Math.random() - 0.5) * 9, t: 0, dur: 1.5 + Math.random() * 0.8, gy });
  }
}
function updateDebris(dt) {
  for (let k = debris.length - 1; k >= 0; k--) {
    const d = debris[k];
    d.t += dt;
    d.vel.y -= 26 * dt;
    d.obj.position.addScaledVector(d.vel, dt);
    d.obj.rotation.x += d.avx * dt;
    d.obj.rotation.z += d.avz * dt;
    if (d.obj.position.y < d.gy + 0.12 && d.vel.y < 0) {   // 接地: 小バウンド＋減衰
      d.obj.position.y = d.gy + 0.12;
      d.vel.y *= -0.25;
      d.vel.x *= 0.5; d.vel.z *= 0.5;
      d.avx *= 0.4; d.avz *= 0.4;
    }
    if (d.dur - d.t < 0.3) d.obj.scale.multiplyScalar(Math.max(0, 1 - dt * 4));   // 消え際は縮む
    if (d.t > d.dur) { scene.remove(d.obj); debris.splice(k, 1); }
  }
}
// 火柱: プール4本（マテリアル個別opacityのためWebGPUの遅延コンパイルを避けてプール化）
const FIRE_POOL = 4;
const firePillars = [];
function initDebrisFx() {
  if (firePillars.length) return;
  // 縦グラデの炎テクスチャ（下=濃橙→上=透明）
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, 'rgba(255,190,80,0.95)');
  g.addColorStop(0.45, 'rgba(255,120,30,0.7)');
  g.addColorStop(1, 'rgba(255,60,10,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(cv);
  const geo = new THREE.CylinderGeometry(0.55, 0.95, 1, 10, 1, true);
  geo.translate(0, 0.5, 0);   // 底面原点＝上に伸びる
  for (let i = 0; i < FIRE_POOL; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.position.set(0, -600, 0);
    m.frustumCulled = false;   // 起動時からパイプラインをコンパイルさせる（初弾ヒッチ防止）
    scene.add(m);
    firePillars.push({ obj: m, t: 1e9, dur: 0.7, gy: -600, scale: 1 });
  }
  // 破片マテリアルのprewarm（画面外の常時描画ダミー）
  for (const mat of Object.values(debMats)) {
    const d = new THREE.Mesh(_debGeo, mat);
    d.position.set(0, -600, 0);
    d.frustumCulled = false;
    scene.add(d);
  }
  initScorch();   // 焦げ跡デカール（プール＋prewarm）
}
// ── 焦げ跡デカール（地面/路面共通・プール40枚を古い順にリサイクル＝残り続けるが数は一定）──
const DECAL_MAX = 40;
const decals = { pool: [], idx: 0, last: new THREE.Vector3(1e9, 0, 1e9) };
function initScorch() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, 'rgba(12,10,8,0.92)');
  g.addColorStop(0.55, 'rgba(20,16,12,0.75)');
  g.addColorStop(1, 'rgba(20,16,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 90; i++) {   // 縁を斑に汚す
    const a = Math.random() * Math.PI * 2, r = 38 + Math.random() * 24;
    ctx.fillStyle = `rgba(15,12,10,${0.25 * Math.random()})`;
    ctx.beginPath();
    ctx.arc(64 + Math.cos(a) * r * 0.9, 64 + Math.sin(a) * r * 0.9, 4 + Math.random() * 9, 0, 7);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  for (let i = 0; i < DECAL_MAX; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 2;
    scene.add(m);
    decals.pool.push(m);
  }
  const dummy = new THREE.Mesh(geo, mat);   // prewarm用（常時描画・画面外）
  dummy.position.set(0, -600, 0);
  dummy.frustumCulled = false;
  scene.add(dummy);
}
function spawnScorch(point, size = 2.6) {
  if (!decals.pool.length) return;
  if (point.distanceTo(decals.last) < 1.2) return;   // 同一点への連打は1枚（ラージ照射の使い潰し防止）
  decals.last.copy(point);
  const m = decals.pool[decals.idx];
  decals.idx = (decals.idx + 1) % DECAL_MAX;
  const y = groundYAt(point.x, point.z, point.y);   // 路面対応済み＝道路の上にも正しく乗る
  m.position.set(point.x, y + 0.045, point.z);
  m.rotation.y = Math.random() * Math.PI * 2;
  const s = size * (0.85 + Math.random() * 0.4);
  m.scale.set(s, 1, s);
  m.visible = true;
}
// ── 道路の穴: 道路材質をカーブ化し、着弾点にワールド座標の球を書く（CARVE_MAX個をリサイクル）──
const roadCarveSets = [];
let roadCarveIdx = 0, roadLightU = null;
const _rcLast = new THREE.Vector3(1e9, 0, 1e9);
function spawnRoadCarve(point, r = 2.2) {
  if (!roadCarveSets.length) return;
  if (point.distanceTo(_rcLast) < 1.5) return;
  _rcLast.copy(point);
  for (const s of roadCarveSets) {
    s.uCenters[roadCarveIdx].value.copy(point);
    s.uRadii[roadCarveIdx].value = r;
  }
  roadCarveIdx = (roadCarveIdx + 1) % CARVE_MAX;
}
function spawnFirePillar(point, scale = 1) {
  if (!firePillars.length) return;
  let p = firePillars.find((q) => q.t > q.dur) || firePillars.reduce((a, b) => (a.t > b.t ? a : b));
  p.t = 0; p.dur = 0.7; p.scale = scale;
  p.gy = point.y;
  p.obj.position.set(point.x, point.y, point.z);
}
function updateFirePillars(dt) {
  for (const p of firePillars) {
    if (p.t > p.dur) { p.obj.material.opacity = 0; continue; }
    p.t += dt;
    const f = Math.min(1, p.t / p.dur);
    const h = (1.5 + 7 * Math.min(1, f * 2.4)) * p.scale;   // 一気に立ち上がる火柱
    p.obj.scale.set(p.scale * (1 + f * 0.5), h, p.scale * (1 + f * 0.5));
    p.obj.material.opacity = 0.95 * (1 - f * f);
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
const AGENT_COUNT = 2000, AGENT_WALK = 1.5;        // 人口（データのみ）・徒歩1.5m/s
const AGENT_BIND_R = 60, AGENT_RELEASE_R = 85;     // 実体化/解除の距離（ヒステリシス）
const agents = [];
const walkingAgents = new Set();   // 歩行中だけ毎フレーム更新（在宅/在勤はイベント駆動で眠らせる）
const wakeBuckets = new Map();     // 分バケット(0-1439) -> agent[]。毎日同じ分に発火（日次サイクル）
const homeIndex = new Map();       // 自宅rec -> agent[]（入室時の在宅検索用）
let lastMinute = -1;
const _pathQueue = [];    // A*要求（フレームあたり2件まで処理。経路は日次キャッシュで初回のみ）
let _agentBindT = 0, _agentPerfMs = 0, _agentPerfN = 0, _agentPerfT = 0;

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

function bucketAdd(minute, a) {
  const key = ((minute % 1440) + 1440) % 1440;
  if (!wakeBuckets.has(key)) wakeBuckets.set(key, []);
  wakeBuckets.get(key).push(a);
}
function bucketRemove(minute, a) {
  const l = wakeBuckets.get(((minute % 1440) + 1440) % 1440);
  if (l) { const i = l.indexOf(a); if (i >= 0) l.splice(i, 1); }
}
// ── エージェント決定的化: 固定シード乱数＋氏名。毎回同じ住人が同じ家・職場・時刻で生成される ──
const AGENT_SEED = 20260713;
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const AGENT_SURNAME = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '斎藤', '清水'];
const AGENT_GIVEN = ['太郎', '花子', '健', '美咲', '翔', '葵', '大輔', 'さくら', '誠', '陽菜', '拓也', '結衣', '直樹', '愛', '悠', '凛', '剛', '千夏', '学', '萌'];
let agentOverrides = {};   // agent-editorの保存差分: { "<id>": {work,goWork,goHome,line} }
let agentWorks = [], agentHouses = [];
async function loadAgentOverrides() {
  try { agentOverrides = (await (await fetch('../npc/agent-overrides.json')).json()) || {}; }
  catch { agentOverrides = {}; }
}
function initAgents() {
  if (!roadNodes.size || !bldModels.length) return;
  const houses = [], works = [];
  for (const md of bldModels) for (const rec of md.recs) (rec.tier === 'house' ? houses : works).push(rec);
  if (!houses.length || !works.length) return;
  // 最寄りノード探索の高速化: ノード配列を一度作り、粗い格子で近傍だけ見る
  const nodeArr = [...roadNodes.entries()];
  const cellMap = new Map();
  for (const [id, nd] of nodeArr) {
    const key = `${Math.floor(nd.local.x / 100)}_${Math.floor(nd.local.z / 100)}`;
    if (!cellMap.has(key)) cellMap.set(key, []);
    cellMap.get(key).push([id, nd]);
  }
  const nearNode = (x, z) => {
    const cx = Math.floor(x / 100), cz = Math.floor(z / 100);
    let best = null, bd = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = cellMap.get(`${cx + dx}_${cz + dz}`);
      if (list) for (const [id, nd] of list) { const d = (nd.local.x - x) ** 2 + (nd.local.z - z) ** 2; if (d < bd) { bd = d; best = id; } }
    }
    return best ?? nearestRoadNode(x, z);
  };
  agentHouses = houses; agentWorks = works;   // エディタ用に公開
  const rnd = makeRng(AGENT_SEED);   // 決定的: 毎回同じ住人
  for (let i = 0; i < AGENT_COUNT; i++) {
    const homeIdx = (rnd() * houses.length) | 0;
    let workIdx = (rnd() * works.length) | 0;
    let goWork = 7 + rnd() * 3, goHome = 17 + rnd() * 4;
    const name = AGENT_SURNAME[(rnd() * AGENT_SURNAME.length) | 0] + ' ' + AGENT_GIVEN[(rnd() * AGENT_GIVEN.length) | 0];
    const side = rnd() < 0.5 ? 1 : -1;
    const o = agentOverrides[i];   // エディタの保存差分を上書き適用
    if (o) {
      if (Number.isInteger(o.work) && works[o.work]) workIdx = o.work;
      if (o.goWork > 0) goWork = o.goWork;
      if (o.goHome > 0) goHome = o.goHome;
    }
    const home = houses[homeIdx], work = works[workIdx];
    const a = {
      id: i, name, home, work, homeIdx, workIdx,
      homeNode: nearNode(home.x, home.z), workNode: nearNode(work.x, work.z),
      goWork, goHome, line: (o && o.line) || '',
      state: (gameHour >= goWork && gameHour < goHome) ? 'work' : 'home',   // 開始時刻に応じた初期配置
      path: null, pathHW: null, pathWH: null, seg: 0, segT: 0, pathPending: false,
      pos: new THREE.Vector3(home.x, 0, home.z),
      side,
      body: null, paused: 0,
      buckets: [Math.floor(goWork * 60), Math.floor(goHome * 60)],
    };
    agents.push(a);
    for (const b of a.buckets) bucketAdd(b, a);   // 毎日この分に起床判定（日次サイクルなので入れっぱなし）
    if (!homeIndex.has(home)) homeIndex.set(home, []);
    homeIndex.get(home).push(a);
  }
  console.log('agents:', agents.length, '(homes covered:', homeIndex.size, '/', houses.length, ') overrides:', Object.keys(agentOverrides).length);
}
// エディタからの編集反映: 時刻→分バケット入替 / 職場→最寄りノード再計算＋経路キャッシュ破棄
function rescheduleAgent(a, goWork, goHome) {
  for (const b of a.buckets) bucketRemove(b, a);
  a.goWork = goWork; a.goHome = goHome;
  a.buckets = [Math.floor(goWork * 60), Math.floor(goHome * 60)];
  for (const b of a.buckets) bucketAdd(b, a);
}
function setAgentWork(a, workIdx) {
  if (!agentWorks[workIdx]) return;
  a.workIdx = workIdx; a.work = agentWorks[workIdx];
  a.workNode = nearestRoadNode(a.work.x, a.work.z);
  a.pathHW = a.pathWH = null;
}

// ── 生活NPCエディタ（Mキー・ゲーム内オーバーレイ）──────────────────────
// 俯瞰マップ＋一覧＋詳細編集。編集は即ゲームに反映し、保存で public/npc/agent-overrides.json へ
const agentEd = { open: false, sel: null, bounds: null, roadsCv: null, t: 0, listT: 0, inited: false };
const AE_STATE_LABEL = { home: '在宅', work: '勤務中', toWork: '出勤中', toHome: '帰宅中' };

function toggleAgentEd() {
  agentEd.open = !agentEd.open;
  const el = $('agent-ed');
  if (el) el.style.display = agentEd.open ? 'flex' : 'none';
  if (agentEd.open) {
    if (document.pointerLockElement) document.exitPointerLock();
    for (const k of Object.keys(keysDown)) keysDown[k] = false;   // 押しっぱなし解除
    if (!agents.length) { setStatus('エージェント未生成（都市の読込完了を待ってください）'); }
    initAgentEdOnce();
    refreshAgentList();
    drawAgentMap();
  }
}

function initAgentEdOnce() {
  if (agentEd.inited || !roadNodes.size) return;
  agentEd.inited = true;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [, nd] of roadNodes) {
    minX = Math.min(minX, nd.local.x); maxX = Math.max(maxX, nd.local.x);
    minZ = Math.min(minZ, nd.local.z); maxZ = Math.max(maxZ, nd.local.z);
  }
  agentEd.bounds = { minX, maxX, minZ, maxZ };
  // 道路網は一度だけオフスクリーンに描いて使い回す
  const cv = $('ae-map');
  const off = document.createElement('canvas');
  off.width = cv.width; off.height = cv.height;
  const ctx = off.getContext('2d');
  ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, off.width, off.height);
  ctx.strokeStyle = '#26314e'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const e of activeEdges) {
    const a = aeW2M(e.a.x, e.a.z), b = aeW2M(e.b.x, e.b.z);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  agentEd.roadsCv = off;
  cv.addEventListener('click', (ev) => {   // マップ上のドットをクリックで選択
    const r = cv.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (cv.width / r.width), my = (ev.clientY - r.top) * (cv.height / r.height);
    let best = null, bd = 12 * 12;
    for (const a of agents) {
      const p = aeAgentPos(a), q = aeW2M(p.x, p.z);
      const d = (q[0] - mx) ** 2 + (q[1] - my) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    if (best) selectAgent(best);
  });
  $('ae-close').addEventListener('click', toggleAgentEd);
  $('ae-search').addEventListener('input', refreshAgentList);
  $('ae-list').addEventListener('click', (ev) => {
    const it = ev.target.closest('.ae-item');
    if (it) { const a = agents[Number(it.dataset.id)]; if (a) selectAgent(a); }
  });
  $('ae-gowork').addEventListener('change', aeCommitTimes);
  $('ae-gohome').addEventListener('change', aeCommitTimes);
  $('ae-line').addEventListener('change', () => {
    const a = agentEd.sel; if (!a) return;
    a.line = $('ae-line').value.trim();
    aeMarkOverride(a);
  });
  $('ae-work-rand').addEventListener('click', () => {
    const a = agentEd.sel; if (!a) return;
    setAgentWork(a, (Math.random() * agentWorks.length) | 0);
    aeMarkOverride(a); fillAgentDetail(true); drawAgentMap();
  });
  $('ae-work-near').addEventListener('click', () => {
    const a = agentEd.sel; if (!a) return;
    let bi = a.workIdx, bd = Infinity;
    for (let i = 0; i < agentWorks.length; i++) {
      const w = agentWorks[i];
      const d = (w.x - a.home.x) ** 2 + (w.z - a.home.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    setAgentWork(a, bi); aeMarkOverride(a); fillAgentDetail(true); drawAgentMap();
  });
  $('ae-save').addEventListener('click', saveAgentOverrides);
}

function aeW2M(x, z) {
  const b = agentEd.bounds, cv = $('ae-map'), pad = 8;
  const s = Math.min((cv.width - pad * 2) / Math.max(1, b.maxX - b.minX), (cv.height - pad * 2) / Math.max(1, b.maxZ - b.minZ));
  return [pad + (x - b.minX) * s, pad + (z - b.minZ) * s];
}
function aeAgentPos(a) { return walkingAgents.has(a) ? a.pos : (a.state === 'work' ? a.work : a.home); }

function selectAgent(a) {
  agentEd.sel = a;
  const d = $('ae-detail'); if (d) d.style.display = 'flex';
  refreshAgentList();
  fillAgentDetail(true);
  drawAgentMap();
}
function fillAgentDetail(full) {
  const a = agentEd.sel; if (!a) return;
  $('ae-name').textContent = `#${a.id} ${a.name}`;
  $('ae-info').innerHTML =
    `状態: ${AE_STATE_LABEL[a.state] || a.state}<br>` +
    `自宅: (${a.home.x.toFixed(0)}, ${a.home.z.toFixed(0)})<br>` +
    `職場: ${a.work.tier} (${a.work.x.toFixed(0)}, ${a.work.z.toFixed(0)})`;
  if (full) {   // 入力欄は選択時のみ上書き（編集中の値を毎秒消さない）
    $('ae-gowork').value = a.goWork.toFixed(1);
    $('ae-gohome').value = a.goHome.toFixed(1);
    $('ae-line').value = a.line || '';
  }
}
function aeCommitTimes() {
  const a = agentEd.sel; if (!a) return;
  const gw = Math.min(23.9, Math.max(0, parseFloat($('ae-gowork').value))) || a.goWork;
  const gh = Math.min(23.9, Math.max(0, parseFloat($('ae-gohome').value))) || a.goHome;
  rescheduleAgent(a, gw, gh);
  aeMarkOverride(a);
}
function aeMarkOverride(a) {
  const o = { work: a.workIdx, goWork: Number(a.goWork.toFixed(2)), goHome: Number(a.goHome.toFixed(2)) };
  if (a.line) o.line = a.line;
  agentOverrides[a.id] = o;
  const st = $('ae-count'); if (st) st.textContent = `変更 ${Object.keys(agentOverrides).length}件（要保存）`;
}
async function saveAgentOverrides() {
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'npc', filename: 'agent-overrides.json', content: JSON.stringify(agentOverrides, null, 1) }) });
    setStatus(r.ok ? `保存しました: npc/agent-overrides.json（${Object.keys(agentOverrides).length}件）` : '保存失敗: ' + r.status);
  } catch (e) { setStatus('保存失敗: ' + (e?.message || e)); }
}
function refreshAgentList() {
  const list = $('ae-list'); if (!list) return;
  const q = ($('ae-search')?.value || '').trim().toLowerCase();
  const rows = [];
  let shown = 0;
  for (const a of agents) {
    if (q && String(a.id) !== q && !a.name.toLowerCase().includes(q)) continue;
    rows.push(`<div class="ae-item${agentEd.sel === a ? ' sel' : ''}" data-id="${a.id}"><span>#${a.id} ${a.name}</span><span class="ae-state">${AE_STATE_LABEL[a.state] || a.state}</span></div>`);
    if (++shown >= 60) break;
  }
  list.innerHTML = rows.join('') || '<div class="ae-item"><span class="ae-state">該当なし</span></div>';
  const st = $('ae-count');
  if (st && !st.textContent.includes('要保存')) st.textContent = `${agents.length}人`;
}
function drawAgentMap() {
  const cv = $('ae-map'); if (!cv || !agentEd.roadsCv) return;
  const ctx = cv.getContext('2d');
  ctx.drawImage(agentEd.roadsCv, 0, 0);
  for (const a of agents) {   // 在宅=緑 / 勤務=青 / 歩行=橙
    const p = aeAgentPos(a), [x, y] = aeW2M(p.x, p.z);
    ctx.fillStyle = walkingAgents.has(a) ? '#ffa030' : a.state === 'work' ? '#4d7dd8' : '#3fae6a';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  { const [x, y] = aeW2M(player.pos.x, player.pos.z); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); }
  const a = agentEd.sel;
  if (a) {
    const path = a.path || a.pathHW;
    if (path) {
      ctx.strokeStyle = 'rgba(255,220,120,0.8)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const nd = roadNodes.get(path[i]); if (!nd) continue;
        const [x, y] = aeW2M(nd.local.x, nd.local.z);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const sq = (bx, bz, color) => { const [x, y] = aeW2M(bx, bz); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x - 4, y - 4, 8, 8); };
    sq(a.home.x, a.home.z, '#3fae6a');   // 自宅=緑□
    sq(a.work.x, a.work.z, '#4d7dd8');   // 職場=青□
    const p = aeAgentPos(a), [x, y] = aeW2M(p.x, p.z);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
  }
}
function updateAgentEd(dt) {
  if (!agentEd.open) return;
  if (!agentEd.inited) initAgentEdOnce();   // 開いた時点で都市未生成だった場合のリトライ
  agentEd.t -= dt;
  if (agentEd.t <= 0) {
    agentEd.t = 0.25;
    drawAgentMap();
    const h = Math.floor(gameHour), mi = Math.floor((gameHour - h) * 60);
    const ck = $('ae-clock'); if (ck) ck.textContent = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')} x${timeScale}`;
    if (agentEd.sel) fillAgentDetail(false);   // 状態表示だけ更新（入力欄は触らない）
  }
  agentEd.listT -= dt;
  if (agentEd.listT <= 0) { agentEd.listT = 1.5; refreshAgentList(); }
}

function requestCommute(a, dir) {
  const cached = dir === 'toWork' ? a.pathHW : a.pathWH;
  if (cached) { startWalk(a, dir, cached); return; }
  if (!a.pathPending) { a.pathPending = true; _pathQueue.push({ a, dir }); }
}
function startWalk(a, dir, path) {
  a.path = path; a.seg = 0; a.segT = 0; a.state = dir;
  walkingAgents.add(a);
}
function arriveAgent(a) {
  a.state = a.state === 'toWork' ? 'work' : 'home';
  a.path = null;
  walkingAgents.delete(a);
  if (a.body) { a.body.agent = null; a.body = null; }   // 到着で身体をプールへ返す
}
function wakeAgent(a) {   // 分バケットから毎日呼ばれる。歩行中/停止中は無視
  if (a.paused > 0) return;
  if (a.state === 'home' && gameHour >= a.goWork && gameHour < a.goHome) requestCommute(a, 'toWork');
  else if (a.state === 'work' && (gameHour >= a.goHome || gameHour < a.goWork)) requestCommute(a, 'toHome');
}

function walkPath(a, dt) {
  const path = a.path;
  if (!path || a.seg >= path.length - 1) { arriveAgent(a); return; }
  let move = AGENT_WALK * dt * timeScale;
  while (move > 0 && a.seg < path.length - 1) {
    const n0 = roadNodes.get(path[a.seg]), n1 = roadNodes.get(path[a.seg + 1]);
    if (!n0 || !n1) { a.seg++; a.segT = 0; continue; }
    const len = Math.hypot(n1.local.x - n0.local.x, n1.local.z - n0.local.z) || 1;
    const remain = (1 - a.segT) * len;
    if (move >= remain) { move -= remain; a.seg++; a.segT = 0; }
    else { a.segT += move / len; move = 0; }
  }
  if (a.seg >= path.length - 1) { arriveAgent(a); return; }
  const n0 = roadNodes.get(path[a.seg]).local, n1 = roadNodes.get(path[a.seg + 1]).local;
  const dx = n1.x - n0.x, dz = n1.z - n0.z, len = Math.hypot(dx, dz) || 1;
  const ox = -dz / len * a.side * (ROAD_WIDTH / 2 + 1.0), oz = dx / len * a.side * (ROAD_WIDTH / 2 + 1.0);   // 歩道オフセット
  a.pos.set(n0.x + dx * a.segT + ox, n0.y + (n1.y - n0.y) * a.segT, n0.z + dz * a.segT + oz);
}

function updateAgents(dt) {
  if (!agents.length) return;
  const t0 = performance.now();
  // A*は1フレーム2件まで。結果は往復キャッシュ（=各エージェント一生に1回だけ計算）
  for (let k = 0; k < 2 && _pathQueue.length; k++) {
    const { a, dir } = _pathQueue.shift();
    a.pathPending = false;
    const p = astar(a.homeNode, a.workNode);
    if (p && p.length > 1) {
      a.pathHW = p; a.pathWH = p.slice().reverse();
      startWalk(a, dir, dir === 'toWork' ? a.pathHW : a.pathWH);
    } else {
      a.state = dir === 'toWork' ? 'work' : 'home';   // 経路なし＝瞬間移動扱い
    }
  }
  // 分バケット起床（在宅/在勤のエージェントはここでしか触らない＝イベント駆動）
  const nowMin = Math.floor(gameHour * 60) % 1440;
  if (lastMinute < 0) lastMinute = nowMin;
  let guard = 0;
  while (lastMinute !== nowMin && guard++ < 1441) {
    lastMinute = (lastMinute + 1) % 1440;
    const list = wakeBuckets.get(lastMinute);
    if (list) for (const a of list) wakeAgent(a);
  }
  // 歩行中だけ毎フレーム更新
  for (const a of walkingAgents) {
    if (a.paused > 0) { a.paused -= dt; continue; }
    walkPath(a, dt);
  }
  // 計測（5秒毎にコンソールへ）
  _agentPerfMs += performance.now() - t0; _agentPerfN++;
  _agentPerfT += dt;
  if (_agentPerfT >= 5) {
    console.log(`agents: walking ${walkingAgents.size}/${agents.length}, upd ${(_agentPerfMs / Math.max(1, _agentPerfN)).toFixed(3)}ms/f, queue ${_pathQueue.length}`);
    _agentPerfMs = 0; _agentPerfN = 0; _agentPerfT = 0;
  }
}

// 近傍の通勤中エージェントに ken の身体を割当（0.4s毎・ヒステリシス）
function updateAgentBodies(dt) {
  _agentBindT -= dt;
  if (_agentBindT > 0 || !agents.length) return;
  _agentBindT = 0.4;
  // 解放チェック（bodyを持つのは最大でもプール数）
  for (const m of kens) {
    const a = m.agent;
    if (!a) continue;
    if (m.dissolving || m._remove) { a.body = null; m.agent = null; a.paused = 30; continue; }   // 倒された→しばらく再出現しない
    if (m.grabbed || m.eating || m.tornado || m.ragdoll?.active || m.scared) continue;   // 干渉中は既存挙動に任せる
    const d = Math.hypot(a.pos.x - player.pos.x, a.pos.z - player.pos.z);
    if (!walkingAgents.has(a) || d > AGENT_RELEASE_R) { m.agent = null; a.body = null; }
  }
  // バインド（歩行中のみ走査。距離2乗で早期スキップ）
  const r2 = AGENT_BIND_R * AGENT_BIND_R;
  for (const a of walkingAgents) {
    if (a.body || a.paused > 0) continue;
    const dx = a.pos.x - player.pos.x, dz = a.pos.z - player.pos.z;
    if (dx * dx + dz * dz > r2) continue;
    const m = kens.find((k) => !k.agent && !k.interior && !k.grabbed && !k.eating && !k.dissolving && !k.tornado && !k.ragdoll?.active);
    if (!m) break;   // プール枯渇
    m.agent = a; a.body = m;
    m.pos.set(a.pos.x, groundYAt(a.pos.x, a.pos.z, player.pos.y), a.pos.z);
    m.vrm.scene.position.copy(m.pos);
    if (a.line && speechUI) speechUI.setBubble(m, a.line, 12);   // エディタで設定した一言（実体化した瞬間に喋る）
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
function groundYAt(x, z, ref) {   // 地面Y。道路上なら路面（タイル天面）を返す＝捕食・NPCが路面に埋まらない
  const rt = roadTopAt(x, z);
  if (mapTerrain) {   // マップモードは配列参照＝レイキャスト不要
    const y = mapTerrain.heightAt(x, z);
    return rt != null && rt > y ? rt : y;
  }
  if (!groundGroup || !groundGroup.children.length) return rt ?? ref ?? 0;
  _gFromK.set(x, (ref ?? 0) + 80, z);
  _gRayK.set(_gFromK, _G_DOWN); _gRayK.far = 100000;
  const hit = _gRayK.intersectObject(groundGroup, true)[0];
  const y = hit ? hit.point.y : (ref ?? 0);
  return rt != null && rt > y ? rt : y;
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

function kenCount() { return kens.filter((k) => !k.interior).length; }   // 屋外プールの数（在宅住人は別枠）
function removeKen() {
  for (let i = kens.length - 1; i >= 0; i--) {
    const m = kens[i];
    if (m.grabbed || m.eating || m === player.prey || m.interior) continue;
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
  m.dis.setGroundY(m.floorY != null ? m.floorY : groundYAt(_kQ.x, _kQ.z, _kQ.y));   // 地形or屋内床へパドルを固定
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
    speed = m.interior ? 2.2 : KEN_RUN_SPEED;   // 屋内では全力疾走しない
  } else {
    m.scared = false;
    m.wanderTimer -= dt;
    if (m.wanderTimer <= 0 || (m.wanderDirX === 0 && m.wanderDirZ === 0)) {
      const a = Math.random() * Math.PI * 2;
      m.wanderDirX = Math.cos(a); m.wanderDirZ = Math.sin(a);
      m.wanderTimer = 1.5 + Math.random() * 2.5;
    }
    dx = m.wanderDirX; dz = m.wanderDirZ;
    speed = m.walkSpeed ?? KEN_WALK_SPEED;
  }
  const dl = Math.hypot(dx, dz) || 1;
  const tvx = dx / dl * speed, tvz = dz / dl * speed;
  const k = 1 - Math.exp(-dt / KEN_STEER_TAU);
  m.vel.x += (tvx - m.vel.x) * k; m.vel.z += (tvz - m.vel.z) * k; m.vel.y = 0;
  m.pos.addScaledVector(m.vel, dt);
  m.pos.y = m.floorY != null ? m.floorY : groundYAt(m.pos.x, m.pos.z, m.pos.y);   // 屋内は固定床高
  if (m.bounds) {   // 在宅住人は自分の部屋の中だけ
    m.pos.x = Math.max(m.bounds.x0, Math.min(m.bounds.x1, m.pos.x));
    m.pos.z = Math.max(m.bounds.z0, Math.min(m.bounds.z1, m.pos.z));
  }
  if (!m.interior && m.pos.distanceTo(player.pos) > KEN_FAR_TELEPORT) {   // 離れすぎたら近傍へ再配置
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
    const env = { floorY: m.floorY != null ? m.floorY : groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y), bounds: KEN_BOUNDS };
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
        // ループ終端: loopEnd > trimOut > クリップ末尾 の優先順（trimOut超の帯域を誤って再生しない）
        const rawEnd = a.loopEnd != null ? a.loopEnd / fps : (a.trimOut > 0 ? a.trimOut / fps : clip.duration);
        bite.feedLoopEnd = Math.min(clip.duration - 1e-3, rawEnd);
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
  const gy = m.floorY != null ? m.floorY : groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y);
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
  player.eating = true; player.eatT = 0; player.eatIntroDone = false;
  player.vel.set(0, 0, 0);
  const sy = groundYAt(player.pos.x, player.pos.z, player.pos.y);   // 道路上なら路面へスナップ（埋まり防止）
  if (player.pos.y < sy + 0.02) { player.pos.y = sy + 0.02; player.vrm.scene.position.copy(player.pos); }
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
  const env = { floorY: m.floorY != null ? m.floorY : groundYAt(m.vrm.scene.position.x, m.vrm.scene.position.z, m.vrm.scene.position.y), bounds: KEN_BOUNDS };
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
const PREDATION_HEAL = 5;   // 吸血(捕食)中のHP回復量/秒
function updatePlayerEating(dt) {
  if (playerHp < PLAYER_HP_MAX) {   // 吸血で回復（損耗・表情も戻る）
    playerHp = Math.min(PLAYER_HP_MAX, playerHp + PREDATION_HEAL * dt);
    updateHpUI();
    applyDamageFx();
  }
  player.mixer.update(dt);
  const a = bite.feedAction;
  if (a) {
    const s = bite.feedIntroOut, e = bite.feedLoopEnd, span = Math.max(1e-3, e - s);
    if (!player.eatIntroDone && a.time >= s) player.eatIntroDone = true;
    if (a.time >= e) { a.time = s + ((a.time - s) % span); player.mixer.update(0); }
    else if (player.eatIntroDone && a.time < s) {   // loopEnd=クリップ末尾だとLoopRepeatが先に0へ巻き戻す→ループ開始点へ戻す
      a.time = s + ((a.time + bite.feedClipDur - s) % span);
      player.mixer.update(0);
    }
  }
  player.vrm.update(dt);
  if (player.cloth) player.cloth.update(dt, 0);
  player.eatT += dt;
  const eatDur = (bite.cfg?.anim?.eatTime > 0) ? bite.cfg.anim.eatTime : PREDATION_EAT_TIME;   // bite-editorで調整可能
  if (player.eatT >= eatDur) finishEating();
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
// ── 太陽と月のディスク（プレイヤー追従の遠景・fog非適用・日周に連動）──
let sunDisc = null, moonDisc = null;
const _sunHi = new THREE.Color(0xfff6d8), _sunLo = new THREE.Color(0xff8c3a);
function initSunMoon() {
  const mk = (colorHex, size) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 20, 14),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    m.frustumCulled = false;
    m.renderOrder = -2;   // 空の直後・雲や街より先
    scene.add(m);
    return m;
  };
  sunDisc = mk(0xfff6d8, 320);
  moonDisc = mk(0xe8eef8, 230);
}
function updateSunMoon(sx, sy) {
  const R = 8500;
  if (sunDisc) {
    sunDisc.position.set(player.pos.x + sx * R, player.pos.y + sy * R, player.pos.z + 0.35 * R);
    sunDisc.material.opacity = THREE.MathUtils.clamp((sy + 0.05) / 0.1, 0, 1);
    const low = THREE.MathUtils.clamp(1 - sy * 2.5, 0, 1);   // 低空ほど夕焼け色
    sunDisc.material.color.copy(_sunHi).lerp(_sunLo, low);
  }
  if (moonDisc) {   // 月は太陽の反対側
    moonDisc.position.set(player.pos.x - sx * R, player.pos.y - sy * R, player.pos.z - 0.3 * R);
    moonDisc.material.opacity = THREE.MathUtils.clamp((-sy + 0.05) / 0.12, 0, 1) * 0.95;
  }
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
  updateSunMoon(sx, sy);   // 太陽/月ディスクの位置・色・出没
  scene.environmentIntensity = 0.22 + (1 - nightF) * 0.78;   // 環境マップ（光沢）は夜に絞る
  if (charFill.key) charFill.key.intensity = charLightCfg.dirI * (1 + nightF * 0.3);   // 正面キー光のみ常時点灯（夜はさらに少し持ち上げ）
  if (neonMat) neonMat.opacity = nightF;                     // 屋上ランプは夜だけ
  if (carHeadMat) { carHeadMat.opacity = nightF; carTailMat.opacity = nightF; }
  if (streetGlowMat) streetGlowMat.opacity = nightF;   // 街灯も夜だけ
  if (parkGlowMat) parkGlowMat.opacity = nightF;       // 公園ランタンも夜だけ
  if (windowGlowMat) windowGlowMat.opacity = nightF * 0.9;   // 窓の光漏れも夜だけ
  if (roadLightU) roadLightU.value = 0.30 + (1 - nightF) * 0.75;   // 道路(カーブ材質=アンリット)の昼夜明度
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
// entry-editor で光点(light)マーカーを打ったモデルは、その位置・色を優先（全ティア有効）
let neonMat = null, neonMesh = null, windowGlowMesh = null;
let neonBlinks = [], neonTime = 0;   // entry-editorでblink(秒)を指定した光点の点滅管理
const recLights = new Map();   // 建物rec -> {neon:[idx], glow:[idx]}（破壊時の消灯用）
function recLightsOf(rec) {
  if (!recLights.has(rec)) recLights.set(rec, { neon: [], glow: [] });
  return recLights.get(rec);
}
const _offM = new THREE.Matrix4().makeScale(0, 0, 0);
function hideBuildingLights(rec) {   // 崩壊した建物のネオン/窓発光をゼロスケールで消す
  const e = rec && recLights.get(rec);
  if (!e) return;
  if (neonMesh) { for (const i of e.neon) neonMesh.setMatrixAt(i, _offM); if (e.neon.length) neonMesh.instanceMatrix.needsUpdate = true; }
  if (windowGlowMesh) { for (const i of e.glow) windowGlowMesh.setMatrixAt(i, _offM); if (e.glow.length) windowGlowMesh.instanceMatrix.needsUpdate = true; }
  recLights.delete(rec);
}
function buildNeon() {
  const pos = [], col = [];
  const c = new THREE.Color(), _v = new THREE.Vector3();
  for (const md of bldModels) {
    const bb = md.tpl.geometry.boundingBox;
    const custom = (md.entries || []).filter((e) => e.kind === 'light');
    for (const rec of md.recs) {
      if (custom.length) {
        for (const L of custom) {
          _v.fromArray(L.pos).applyMatrix4(rec.m);
          if (L.color) c.set(L.color);
          else c.setHSL(Math.random() < 0.55 ? 0.0 : (Math.random() < 0.6 ? 0.6 : 0.09), 1.0, 0.55);
          recLightsOf(rec).neon.push(pos.length);
          pos.push({ x: _v.x, y: _v.y, z: _v.z, r: c.r, g: c.g, b: c.b, blink: L.blink || 0 });
        }
        continue;
      }
      if (rec.tier === 'house') continue;
      const corners = rec.tier === 'tower'
        ? [[bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z], [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z]]
        : [[(bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2]];
      for (const p of corners) {
        _v.set(p[0], p[1] + 0.6, p[2]).applyMatrix4(rec.m);
        c.setHSL(Math.random() < 0.55 ? 0.0 : (Math.random() < 0.6 ? 0.6 : 0.09), 1.0, 0.55);   // 赤/青/橙
        recLightsOf(rec).neon.push(pos.length);
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
  // 点滅指定のある光点: 位相をばらして登録（同一モデルの全インスタンスが同期しないように）
  neonBlinks = []; neonTime = 0;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i].blink > 0) neonBlinks.push({ i, period: pos[i].blink, phase: Math.random() * pos[i].blink, r: pos[i].r, g: pos[i].g, b: pos[i].b });
  }
  if (neonBlinks.length && mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);
  neonMesh = mesh;
  console.log('neon lamps:', pos.length, neonBlinks.length ? `(点滅 ${neonBlinks.length})` : '');
}
const _neonC = new THREE.Color();
let neonBlinkAcc = 0;
function updateNeonBlink(dt) {   // サイン波のゆっくり明滅（30Hzに間引き）。昼は不可視＝更新しない
  neonTime += dt;
  neonBlinkAcc += dt;
  if (!neonBlinks.length || !neonMesh || neonMat.opacity < 0.02 || neonBlinkAcc < 1 / 30) return;
  neonBlinkAcc = 0;
  for (const b of neonBlinks) {
    const br = 0.5 - 0.5 * Math.cos(((neonTime + b.phase) / b.period) * Math.PI * 2);   // 0→1→0
    neonMesh.setColorAt(b.i, _neonC.setRGB(b.r, b.g, b.b).multiplyScalar(0.04 + 0.96 * br));
  }
  if (neonMesh.instanceColor) neonMesh.instanceColor.needsUpdate = true;
}

// ── 窓の光漏れ: entry-editor の glow マーカー矩形を全建物インスタンスへ展開（夜だけ点灯）──
// 通常合成＋深度テストあり＝壁の向こうは見えない。番地ハッシュで一部だけ点灯＝生活感と数の節約
let windowGlowMat = null;
const MAX_WINDOW_GLOWS = 20000, WINDOW_LIT_RATE = 0.6;
function buildWindowGlows() {
  const items = [];
  // 窓ポイントマーカー(window)も既定サイズで光漏れ扱い（向きはバウンディングボックスの最寄り面から推定）
  const guessRy = (p, bb) => {
    const dW = p[0] - bb.min.x, dE = bb.max.x - p[0], dS = p[2] - bb.min.z, dN = bb.max.z - p[2];
    const m = Math.min(dW, dE, dS, dN);
    return m === dW ? -Math.PI / 2 : m === dE ? Math.PI / 2 : m === dS ? Math.PI : 0;
  };
  for (const md of bldModels) {
    const bb = md.tpl.geometry.boundingBox;
    const glows = [];
    for (const e of md.entries || []) {
      if (e.kind === 'glow') glows.push(e);
      else if (e.kind === 'window') glows.push({ pos: e.pos, ry: guessRy(e.pos, bb), size: [0.14, 0.18] });
    }
    if (!glows.length) continue;
    for (const rec of md.recs) {
      for (let gi = 0; gi < glows.length; gi++) {
        const h = ((Math.round(rec.x) * 73856093) ^ (Math.round(rec.z) * 19349663) ^ (gi * 83492791)) >>> 0;
        if ((h % 1000) / 1000 > WINDOW_LIT_RATE) continue;   // この窓は消灯
        if (items.length >= MAX_WINDOW_GLOWS) break;
        items.push({ rec, g: glows[gi], h });
      }
    }
  }
  if (!items.length) { console.log('window glows: 0（glowマーカー未設定）'); return; }
  windowGlowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), windowGlowMat, items.length);
  mesh.frustumCulled = false;
  const _pp = new THREE.Vector3(), _qq = new THREE.Quaternion(), _ss = new THREE.Vector3();
  const _lm = new THREE.Matrix4(), _wm = new THREE.Matrix4(), _cc = new THREE.Color(), _up2 = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < items.length; i++) {
    const { rec, g, h } = items[i];
    const ry = g.ry || 0;
    _pp.fromArray(g.pos).addScaledVector(_ss.set(Math.sin(ry), 0, Math.cos(ry)), 0.006);   // 面から浮かせてz-fighting回避
    _qq.setFromAxisAngle(_up2, ry);
    _ss.set(g.size?.[0] ?? 0.3, g.size?.[1] ?? 0.4, 1);
    _lm.compose(_pp, _qq, _ss);
    _wm.multiplyMatrices(rec.m, _lm);
    mesh.setMatrixAt(i, _wm);
    recLightsOf(rec).glow.push(i);
    _cc.setHSL(0.085 + ((h >>> 10) % 100) / 100 * 0.045, 0.85, 0.55 + ((h >>> 4) % 100) / 100 * 0.15);   // 暖色バリエーション
    mesh.setColorAt(i, _cc);
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  windowGlowMesh = mesh;
  console.log('window glows:', items.length);
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
  p.proxy = { mesh, hitR: 2.8, policeCar: true, pRef: p };   // 攻撃/掴み対象にする cars 互換の最小プロキシ
  mesh.userData.car = p.proxy;   // 照準レイの掴み対応
  scene.add(mesh);
  police.push(p);
}
function removePolice() {
  const idx = police.findIndex((p) => !(p.proxy && (p.proxy.grabbed || p.proxy.thrown)));   // 掴まれ/投擲中は撤収させない
  if (idx < 0) return;
  const p = police.splice(idx, 1)[0];
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
    if (p.proxy && (p.proxy.grabbed || p.proxy.thrown || p.proxy.dead)) continue;   // 掴まれ/投擲中は走行AIを止める
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
let bldEntries = {};   // モデル相対パス -> マーカー配列（entry-editor製。道路の街灯より先に読む）
let _bldEntriesP = null;
function loadBldEntries() {   // 何度呼んでも1回だけfetch
  if (!_bldEntriesP) _bldEntriesP = fetch('../models/building-entries.json').then((r) => r.json()).then((j) => { bldEntries = j || {}; }).catch(() => { bldEntries = {}; });
  return _bldEntriesP;
}
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

// 建物の進入マーカー（入口になるものが無ければテンプレ正面中央の玄関を仮定。lightだけのモデルも玄関を補う）
function mdMarkers(md) {
  if (md.entries && md.entries.some((e) => e.kind !== 'light')) return md.entries;
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
        if (mk.kind === 'light') continue;   // 光点は入口ではない（glowは窓入口として有効）
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
  interior.residents = [];
  spawnResidents(layout, rec).catch((e) => console.warn('住人スポーン失敗:', e));   // この家が「自宅」で在宅中のエージェント
}

// この建物を自宅とする在宅エージェントを、内装に住人として実体化（夜=ベッド脇/日中=ソファや食卓付近）
async function spawnResidents(layout, rec) {
  const residentsAll = homeIndex.get(rec) || [];
  const homies = residentsAll.filter((a) => a.state === 'home').slice(0, 2);   // インデックスでO(1)検索
  if (!homies.length) {
    // 理由を可視化: 「住人はいるが外出中」or「誰の家でもない（空き家）」
    if (residentsAll.length) setStatus(`入室 / 住人は外出中のようだ（${residentsAll.length}人暮らし）/ 玄関で【E】退出`);
    console.log(`residents: ${residentsAll.length} registered, 0 at home (hour=${gameHour.toFixed(1)})`);
    return;
  }
  console.log(`residents: spawning ${homies.length}/${residentsAll.length} (hour=${gameHour.toFixed(1)})`);
  const floorY = INTERIOR_ORIGIN.y + FLOORT_I;
  const isNight = gameHour >= 21 || gameHour < 7;
  const items0 = (layout.items || []).filter((i) => (i.level || 0) === 0 && !i.unit);
  for (const a of homies) {
    const pref = isNight ? ['bed', 'sofa'] : ['sofa', 'armchair', 'diningTable', 'chair'];
    let spot = null;
    for (const cat of pref) {
      const c = items0.filter((i) => i.cat === cat);
      if (c.length) { spot = c[(Math.random() * c.length) | 0]; break; }
    }
    const sx = spot ? spot.x : layout.w / 2, sz = spot ? spot.z : layout.d / 2;
    if (!await spawnKen()) break;
    const m = kens[kens.length - 1];
    m.interior = true;
    m.walkSpeed = 0.5;             // 家の中はゆっくり
    m.floorY = floorY;
    const room = (layout.rooms || []).find((r) => (r.level || 0) === 0 && sx >= r.x0 - 0.5 && sx <= r.x0 + r.w - 0.5 && sz >= r.z0 - 0.5 && sz <= r.z0 + r.d - 0.5);
    const b = room || { x0: 0, z0: 0, w: layout.w, d: layout.d };
    m.bounds = {   // 自分の部屋の中だけ動く
      x0: INTERIOR_ORIGIN.x + (b.x0 - 0.1) * TILE_I, x1: INTERIOR_ORIGIN.x + (b.x0 + b.w - 0.9) * TILE_I,
      z0: INTERIOR_ORIGIN.z + (b.z0 - 0.1) * TILE_I, z1: INTERIOR_ORIGIN.z + (b.z0 + b.d - 0.9) * TILE_I,
    };
    m.pos.set(INTERIOR_ORIGIN.x + (sx + 0.7) * TILE_I, floorY, INTERIOR_ORIGIN.z + sz * TILE_I);
    m.vrm.scene.position.copy(m.pos);
    // 将来の生活アニメ用アンカー（sleep/sit）。VRMA が用意でき次第ここに合わせる
    m.lifeSpot = spot ? { action: spot.cat === 'bed' ? 'sleep' : 'sit', x: spot.x, z: spot.z, ry: spot.ry || 0 } : null;
    interior.residents.push(m);
  }
  if (interior.residents.length) setStatus(`入室 / 住人が${interior.residents.length}人いる…（玄関で【E】退出）`);
}

function exitInterior() {
  for (const m of (interior.residents || [])) {   // 住人を撤収（プールとは別枠）
    if (player.prey === m) player.prey = null;
    const i = kens.indexOf(m);
    if (i >= 0) { kens.splice(i, 1); finalizeRemoveKenAssets(m); }
  }
  interior.residents = [];
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

// 使用中GPUの取得。software フォールバック（SwiftShader/Basic Render Driver/llvmpipe 等）だと桁違いに遅い。
let _gpuInfo = '取得中…', _gpuIsSoftware = false, _gpuAlt = '';
async function adapterName(pref) {
  try {
    const ad = await navigator.gpu.requestAdapter(pref ? { powerPreference: pref } : {});
    const info = ad?.info ?? (ad?.requestAdapterInfo ? await ad.requestAdapterInfo() : null);
    if (!info) return '(情報なし)';
    return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || '(空)';
  } catch (e) { return 'エラー: ' + e.message; }
}
async function collectGpuInfo() {
  _gpuInfo = await adapterName(LOW_POWER ? 'low-power' : 'high-performance');
  _gpuIsSoftware = /swiftshader|basic render|llvmpipe|software|warp|microsoft basic/i.test(_gpuInfo);
  const other = await adapterName(LOW_POWER ? 'high-performance' : 'low-power');
  if (other && other !== _gpuInfo) _gpuAlt = other;   // 別GPUも見えている＝選択の問題だと分かる
}

// FPS計測オーバーレイ（?fps=1 / ?nocape=1 / ?diag=1 で表示）。性能問題の切り分け用。
let _fpsEl = null, _fpsFrames = 0, _fpsLast = performance.now(), _fpsMin = 999, _fpsWorstMs = 0;
let _diagDraw = 0, _diagTri = 0;
function updateFpsMeter() {
  if (!_fpsEl) {
    _fpsEl = document.createElement('div');
    Object.assign(_fpsEl.style, { position: 'fixed', top: '10px', right: '10px', zIndex: '30', background: 'rgba(0,0,0,0.7)', color: '#8f8', font: '12px monospace', padding: '6px 10px', borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'pre', maxWidth: '46vw' });
    document.body.appendChild(_fpsEl);
  }
  _fpsFrames++;
  const now = performance.now();
  const frameMs = now - _fpsLastFrame; _fpsLastFrame = now;
  if (frameMs > _fpsWorstMs && _fpsFrames > 2) _fpsWorstMs = frameMs;
  if (now - _fpsLast >= 500) {
    const fps = Math.round(_fpsFrames / ((now - _fpsLast) / 1000));
    if (fps < _fpsMin) _fpsMin = fps;
    let txt = `${fps} FPS (最低 ${_fpsMin} / 最遅 ${_fpsWorstMs.toFixed(0)}ms)\nマント: ${NO_CAPE ? 'OFF' : 'ON'}`;
    if (DIAG) {
      txt += `\nGPU: ${_gpuIsSoftware ? '⚠ソフトウェア描画! ' : ''}${_gpuInfo}`;
      if (_gpuAlt) txt += `\n  (別GPUも検出: ${_gpuAlt})`;
      txt += `\ndrawCalls ${_diagDraw} / tri ${_diagTri.toLocaleString()}`;
      txt += `\n建物 ${NO_CITY ? 'OFF' : '近' + _lodNearCount + '/遠' + _lodFarCount} / NPC ${NO_NPC ? 'OFF' : 'ON'}`;
      txt += `\n解像度 ${renderer?.domElement?.width ?? 0}x${renderer?.domElement?.height ?? 0} (DPR${renderer?.getPixelRatio?.().toFixed(1) ?? '-'})`;
      txt += `\nMSAA ${NO_AA ? 'OFF' : 'ON'} / 環境光 ${NO_ENV ? 'OFF' : 'ON'} / 空 ${NO_SKY ? 'OFF' : 'ON'}`;
      if (player.cloth) txt += `\nマント(GPU布) ${player.cloth.vertexCount}頂点 CPU側 ${player.cloth.lastUpdateMs.toFixed(2)}ms`;
    }
    _fpsEl.textContent = txt;
    _fpsFrames = 0; _fpsLast = now; _fpsWorstMs = 0;
  }
}
let _fpsLastFrame = performance.now();

// ══════════ 戦闘機スウォーム（黒紫の編隊・撃墜きりもみ・車と同じ掴み/投げ） ══════════
const JET = { n: 6, spMin: 30, spMax: 52, sep: 18, orbitR: 130, resp: 12, hitR: 8,   // hitR=機体を覆う球コリジョン
  killZone: 110, shotCd: 1.6, shotRange: 260, shotDmg: 8, bombCd: 4.5, bombDmg: 1 };   // killZone内=プレイヤー攻撃/外=爆撃
const jets = [], jetRespawn = [];
let jetAnchorA = 0;
const _jV1 = new THREE.Vector3(), _jV2 = new THREE.Vector3(), _jV3 = new THREE.Vector3(), _jV4b = new THREE.Vector3();
function carsAndJets() {
  const extra = [];
  for (const p of police) extra.push(p.proxy);                    // パトカー
  for (const tr of trains) for (const c of tr.cars) extra.push(c.proxy);   // 電車（車両単位で掴める）
  if (portShip) extra.push(portShip.proxy);                       // 客船
  if (!jets.length && !extra.length) return cars;
  return cars.concat(jets, extra);
}
const jetBombs = [];
function jetFireShot(jet) {   // 正面ショット: 筒形ポリゴンのビーム（spawnBeam thick）
  const from = _jV2.copy(jet.mesh.position).addScaledVector(_jV3.copy(jet.flyVel).normalize(), 7);
  _jV1.copy(player.pos); _jV1.y += 0.8;
  const dir = _jV3.subVectors(_jV1, from).normalize();
  const bh = rayCityBox(from.x, from.y, from.z, dir.x, dir.y, dir.z, JET.shotRange);
  const bldT = bh ? bh.t : Infinity;
  const plT = rayHitSphere(from, dir, _jV1, 1.7, JET.shotRange);
  const minT = Math.min(bldT, plT);
  const end = from.clone().addScaledVector(dir, minT === Infinity ? JET.shotRange : minT);
  spawnBeam(from.clone(), end, minT !== Infinity, 0xc46bff, true);   // 紫の筒ビーム
  playSfxAt('beam.ogg', jet.mesh.position, 0.35);
  if (minT === Infinity) return;
  if (minT === plT) { playerDamage(JET.shotDmg, dir); spawnImpactFx(end, 0.8); }
  else if (bh) hitBoxBuilding(bh.bi, end.x, end.y, end.z, 0.5);   // 外れて建物に当たった分は軽微
}
const _bombGlowGeo = new THREE.SphereGeometry(0.3, 8, 6);
const _bombGlowMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a });   // 両端のオレンジ発光（unlit=常に明るい）
const _bombBodyMat = new THREE.MeshStandardMaterial({ color: 0x0d0d12, metalness: 0.6, roughness: 0.5 });
function jetDropBomb(jet) {   // 爆撃: 黒い筒を投下（建物にウォーカービーム相当のダメージ）
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.8, 8), _bombBodyMat);
  const g1 = new THREE.Mesh(_bombGlowGeo, _bombGlowMat); g1.position.y = 0.95; mesh.add(g1);
  const g2 = new THREE.Mesh(_bombGlowGeo, _bombGlowMat); g2.position.y = -0.95; mesh.add(g2);
  mesh.position.copy(jet.mesh.position);
  mesh.position.y -= 2;
  scene.add(mesh);
  jetBombs.push({ mesh, vel: new THREE.Vector3(jet.flyVel.x * 0.45, -2, jet.flyVel.z * 0.45), t: 0 });
}
function updateJetBombs(dt) {
  for (let k = jetBombs.length - 1; k >= 0; k--) {
    const bm = jetBombs[k];
    bm.t += dt;
    bm.vel.y -= 28 * dt;
    const pos = bm.mesh.position;
    pos.addScaledVector(bm.vel, dt);
    bm.mesh.rotation.x += dt * 2.4;
    // 建物ボックス/地面/寿命
    let hit = false;
    const cx = Math.floor(pos.x / COLL_CELL), cz = Math.floor(pos.z / COLL_CELL);
    for (let dz2 = -1; dz2 <= 1 && !hit; dz2++) for (let dx2 = -1; dx2 <= 1 && !hit; dx2++) {
      const arr = collGrid.get((cx + dx2) + '_' + (cz + dz2));
      if (!arr) continue;
      for (const idx of arr) {
        const b = collBoxes[idx];
        if (Math.abs(pos.x - b.x) < b.h && Math.abs(pos.z - b.z) < b.h && pos.y > b.bottom && pos.y < b.top) { hit = true; break; }
      }
    }
    const gy = groundYAt(pos.x, pos.z, pos.y + 200);
    if (!hit && pos.y > gy && bm.t < 12) continue;
    // 起爆: 上から短いレイで建物を特定（箱の内側からだと裏面で外れるため）
    jetBombs.splice(k, 1);
    scene.remove(bm.mesh);
    bm.mesh.geometry.dispose(); bm.mesh.material.dispose();
    const bh = rayCityBox(pos.x, pos.y + 30, pos.z, 0, -1, 0, 80);
    playSfxAt('bomb_short.ogg', pos, 0.7);
    if (bh) hitBoxBuilding(bh.bi, pos.x, pos.y + 30 - bh.t, pos.z, DMG_SHOT, 1.5);   // ウォーカービーム相当（通常弾ダメージ＋FX）
    else {
      const onRoad = roadTopAt(pos.x, pos.z) != null;
      spawnImpactFx(_jV2.set(pos.x, gy, pos.z), 1.2);
      spawnDebrisBurst(_jV2, onRoad ? 'road' : 'ground', 1);
      spawnScorch(_jV2, 2.6);
      if (onRoad) spawnRoadCarve(_jV2, 2.0);
    }
  }
}

function makeJetMesh(jet) {
  const g = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: 0x16121e, metalness: 0.7, roughness: 0.35 });
  const mAcc = new THREE.MeshStandardMaterial({ color: 0x5b2fa8, metalness: 0.6, roughness: 0.4 });
  const mGlow = new THREE.MeshStandardMaterial({ color: 0x2a1140, emissive: 0x9a5cff, emissiveIntensity: 2.2 });
  const fus = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.3, 10), mBody); g.add(fus);            // 胴体（機首=+Z）
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.85, 3.2, 8), mBody);
  nose.rotation.x = Math.PI / 2; nose.position.z = 6.5; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), mGlow);
  canopy.scale.set(0.8, 0.6, 1.6); canopy.position.set(0, 0.7, 2.6); g.add(canopy);
  for (const sgn of [-1, 1]) {   // 後退翼＋垂直尾翼
    const wing = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.16, 3.2), mAcc);
    wing.position.set(sgn * 3.1, 0, -1.2); wing.rotation.y = sgn * 0.55; g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.9, 1.7), mAcc);
    tail.position.set(sgn * 0.9, 1.1, -4.4); tail.rotation.z = sgn * -0.35; g.add(tail);
  }
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 1.2, 10), mGlow);
  engine.rotation.x = Math.PI / 2; engine.position.z = -5.2; g.add(engine);
  g.userData.car = jet;   // 掴みレイキャストの逆引き（車と同じ流儀）
  jet.flashMats = [mBody, mAcc];   // 被弾フラッシュ用（emissiveを一瞬赤に）
  return g;
}
// 噴射コーン: 街灯の発光と同じ加算メッシュを機体後方に付け、高速に伸び縮みさせる（頂点更新なし＝軽量）
const _exGeo = (() => { const g = new THREE.ConeGeometry(1, 1, 7, 1, true); g.rotateX(-Math.PI / 2); g.translate(0, 0, -0.5); return g; })();   // 基部=原点 → -Z へ長さ1
const _exMat = new THREE.MeshBasicMaterial({ color: 0xffa050, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
let exhaustT = 0;   // animate で加算（全コーン共通の時刻）
function attachExhaust(parent, zOff, len, rad) {
  const m = new THREE.Mesh(_exGeo, _exMat);
  m.position.z = zOff;
  m.scale.set(rad, rad, len);
  m.userData.exLen = len; m.userData.exPhase = Math.random() * Math.PI * 2;
  parent.add(m);
  return m;
}
function updateExhaust(ex) {   // アフターバーナー風の明滅（スケールのみ）
  if (!ex) return;
  ex.scale.z = ex.userData.exLen * (0.6 + 0.4 * Math.abs(Math.sin(exhaustT * 26 + ex.userData.exPhase)));
}
function jetAirPos(out, r) {
  const a = Math.random() * Math.PI * 2;
  out.set(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
  out.y = Math.max(player.pos.y + 60, groundYAt(out.x, out.z, player.pos.y + 400) + 70);
  return out;
}
function spawnJets() {
  for (let i = 0; i < JET.n; i++) {
    const jet = { jet: true, hitR: JET.hitR, grabbed: false, thrown: false, dead: false, tornado: false,
      flyVel: new THREE.Vector3(), phase: Math.random() * Math.PI * 2, mesh: null, vel: null, angVel: null, holdVel: null };
    jet.mesh = makeJetMesh(jet);
    jetAirPos(jet.mesh.position, 380 + Math.random() * 120);
    jet.flyVel.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(JET.spMax * 0.8);
    scene.add(jet.mesh);
    jet.exhaust = attachExhaust(jet.mesh, -5.6, 7.5, 0.55);
    jets.push(jet);
  }
  window.__jets = jets;
  window.__jetsDbg = { hit: hitCarBeam, grab: grabTarget, release: releaseGrab, get thrownN() { return thrownCars.length; }, get held() { return grabbedCar; }, get player() { return player; }, get cam() { return camera; }, get bite() { return bite; }, startEating, get kens() { return kens; } };
  console.log('jets spawn', jets.length);
}
function updateJets(dt) {
  if (!KENNEY_CITY) return;
  if (!jets.length) { if (enemyAllowed('jet') && cityRoot && collBoxes.length && player.ready) spawnJets(); return; }
  for (let k = jetRespawn.length - 1; k >= 0; k--) {   // 撃墜からの再出撃（遠くの空へ）
    const r = jetRespawn[k]; r.t += dt;
    if (r.t > JET.resp) {
      const jet = r.car;
      jet.dead = false; jet.thrown = false; jet.shotDown = false; jet.grabbed = false;
      jet.mesh.rotation.set(0, 0, 0); jet.mesh.visible = true;
      jetAirPos(jet.mesh.position, 500);
      jet.flyVel.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(JET.spMax * 0.8);
      jetRespawn.splice(k, 1);
    }
  }
  // スウォームの錨＝プレイヤー周囲を旋回する点
  jetAnchorA += dt * 0.3;
  _jV1.set(player.pos.x + Math.cos(jetAnchorA) * JET.orbitR, 0, player.pos.z + Math.sin(jetAnchorA) * JET.orbitR);
  _jV1.y = Math.max(player.pos.y + 20, groundYAt(_jV1.x, _jV1.z, player.pos.y + 400) + 55);
  updateJetBombs(dt);
  for (const jet of jets) {   // 被弾フラッシュ（撃墜きりもみ中も含む）
    if (jet.flashT > 0 && jet.flashMats) {
      jet.flashT = Math.max(0, jet.flashT - dt);
      const f = jet.flashT / 0.35;
      for (const m2 of jet.flashMats) m2.emissive.setRGB(f, f * 0.08, f * 0.05);
    }
  }
  for (const jet of jets) {
    if (jet.dead || jet.grabbed || jet.thrown) continue;
    const p = jet.mesh.position;
    jet.phase += dt;
    jet.shotT = (jet.shotT || 0) - dt;
    jet.bombT = (jet.bombT || 0) - dt;
    const pd = p.distanceTo(player.pos);
    let atkRun = false;
    if (pd < JET.killZone && !playerDead) {   // キルゾーン内: プレイヤーへ攻撃ラン
      atkRun = true;
      _jV4b.copy(player.pos);
      _jV4b.y = Math.max(player.pos.y + 4, groundYAt(p.x, p.z, p.y + 300) + 18);
      _jV3.copy(jet.flyVel).normalize();
      const align = _jV3.dot(_jV2.subVectors(player.pos, p).normalize());
      if (jet.shotT <= 0 && align > 0.86 && pd < JET.shotRange) { jet.shotT = JET.shotCd + Math.random() * 0.8; jetFireShot(jet); }
    } else if (jet.bombT <= 0 && p.y > groundYAt(p.x, p.z, p.y + 300) + 25) {   // 外: 町へ爆撃
      jet.bombT = JET.bombCd + Math.random() * 3;
      jetDropBomb(jet);
    }
    // 操舵: 錨（攻撃ラン中はプレイヤー）へ寄る＋仲間と離れる＋ゆらぎ
    _jV2.subVectors(atkRun ? _jV4b : _jV1, p);
    const far = _jV2.length();
    _jV2.normalize().multiplyScalar(Math.min(28, far * 0.35));
    for (const o of jets) {
      if (o === jet || o.dead || o.grabbed || o.thrown) continue;
      _jV3.subVectors(p, o.mesh.position);
      const d = _jV3.length();
      if (d > 0.01 && d < JET.sep) _jV2.addScaledVector(_jV3.normalize(), (JET.sep - d) * 2.2);
    }
    _jV2.y += Math.sin(jet.phase * 1.7) * 5;
    jet.flyVel.addScaledVector(_jV2, dt);
    // 地面回避＋速度クランプ
    const gy = groundYAt(p.x, p.z, p.y + 300) + 22;
    if (p.y < gy) jet.flyVel.y += (gy - p.y) * dt * 9;
    const sp = jet.flyVel.length();
    if (sp > JET.spMax) jet.flyVel.multiplyScalar(JET.spMax / sp);
    else if (sp < JET.spMin) jet.flyVel.multiplyScalar(sp > 0.01 ? JET.spMin / sp : 1);
    p.addScaledVector(jet.flyVel, dt);
    // 機首を進行方向へ＋旋回バンク
    _jV3.copy(p).add(jet.flyVel);
    jet.mesh.lookAt(_jV3);
    const bank = Math.max(-0.9, Math.min(0.9, (_jV2.x * jet.flyVel.z - _jV2.z * jet.flyVel.x) * 0.0016));
    jet.mesh.rotateZ(bank);
    updateExhaust(jet.exhaust);
  }
  for (const jet of jets) { if (jet.exhaust) jet.exhaust.visible = !(jet.dead || jet.grabbed || jet.thrown); }   // 非アクティブ機は噴射を消す
}

// ══════════ 敵のエネルギー弾（主砲: 弾速あり・太い発光円筒＝回避可能） ══════════
const enemyBolts = [];
const _ebV1 = new THREE.Vector3(), _ebV2 = new THREE.Vector3();
function fireEnemyBolt(from, dir, o) {
  const len = o.len ?? 9, r = o.radius ?? 1;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10),
    new THREE.MeshBasicMaterial({ color: o.color ?? 0xffb040, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.rotation.x = Math.PI / 2;
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.8, r * 1.8, len * 0.8, 10),
    new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.rotation.x = Math.PI / 2;
  const g = new THREE.Group();
  g.add(core, halo);
  g.position.copy(from);
  _ebV1.copy(from).add(dir);
  g.lookAt(_ebV1);
  scene.add(g);
  enemyBolts.push({ mesh: g, vel: dir.clone().multiplyScalar(o.speed ?? 90), t: 0,
    radius: r, dmg: o.dmg ?? 12, knock: o.knock ?? 22, bldDmg: o.bldDmg ?? DMG_SHOT, fxScale: o.fxScale ?? 1, range: o.range ?? 450 });
}
function updateEnemyBolts(dt) {
  for (let k = enemyBolts.length - 1; k >= 0; k--) {
    const eb = enemyBolts[k];
    eb.t += dt;
    const pos = eb.mesh.position;
    pos.addScaledVector(eb.vel, dt);
    let boom = false, hitPlayer = false, bldHit = -1;
    // プレイヤー命中
    if (!playerDead && pos.distanceTo(player.pos) < eb.radius + 2.2) { boom = true; hitPlayer = true; }
    // 建物
    if (!boom) {
      const cx = Math.floor(pos.x / COLL_CELL), cz = Math.floor(pos.z / COLL_CELL);
      outer: for (let dz2 = -1; dz2 <= 1; dz2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        const arr = collGrid.get((cx + dx2) + '_' + (cz + dz2));
        if (!arr) continue;
        for (const idx of arr) {
          const b = collBoxes[idx];
          if (Math.abs(pos.x - b.x) < b.h && Math.abs(pos.z - b.z) < b.h && pos.y > b.bottom && pos.y < b.top) { boom = true; bldHit = idx; break outer; }
        }
      }
    }
    // 地面/寿命
    const gy = groundYAt(pos.x, pos.z, pos.y + 300);
    const grounded = pos.y <= gy + eb.radius * 0.5;
    if (!boom && (grounded || eb.t * (eb.vel.length()) > eb.range || eb.t > 8)) boom = true;
    if (!boom) continue;
    enemyBolts.splice(k, 1);
    scene.remove(eb.mesh);
    playSfxAt('bomb.ogg', pos, 0.8);
    if (hitPlayer) {
      _ebV1.copy(eb.vel).normalize();
      player.vel.addScaledVector(_ebV1, eb.knock); player.vel.y += 8;
      spawnImpactFx(pos, eb.fxScale);
      playerDamage(eb.dmg, _ebV1);
    } else if (bldHit >= 0) {
      hitBoxBuilding(bldHit, pos.x, pos.y, pos.z, eb.bldDmg, eb.fxScale * 1.2);
    } else if (grounded) {
      _ebV2.set(pos.x, gy, pos.z);
      const onRoad = roadTopAt(pos.x, pos.z) != null;
      spawnImpactFx(_ebV2, eb.fxScale);
      spawnDebrisBurst(_ebV2, onRoad ? 'road' : 'ground', eb.fxScale);
      spawnFirePillar(_ebV2, eb.fxScale);
      spawnScorch(_ebV2, 2.6 * eb.fxScale);
      if (onRoad) spawnRoadCarve(_ebV2, 2.1 * eb.fxScale);
    } else spawnImpactFx(pos, eb.fxScale);
  }
}

// ══════════ 巨大ウォーカー（4足歩行・建物なぎ倒し・回転砲塔ビーム） ══════════
const WK = {
  bodyW: 16, bodyH: 7, bodyD: 24, hipY: 24,       // 胴体寸法・股関節の地上高
  L1: 17, L2: 22,                                  // 腿/脛の長さ
  speed: 7, turn: 0.5,                             // 徘徊速度・旋回(rad/s)
  stepTrig: 6, stepDur: 0.42, stepArc: 7,          // 足のステップ発火距離・時間・弧の高さ
  smashInt: 0.16, smashDmg: 8, smashRange: 17,     // なぎ倒しレイの間隔・ダメージ・射程
  beamCd: 3.0, beamRange: 330, aimTol: 0.12,       // 砲塔ビーム
  turretYawRate: 0.9, knock: 22,
  hp: 60, respawnSec: 35, fallSec: 2.6, meltSec: 2.8,   // 被弾（通常弾=6dmg相当で10発）→転倒→溶解
  killZone: 150,   // この半径内にプレイヤーがいれば対プレイヤー攻撃、外なら町（建物）を砲撃
};
let walkerCd = 0;   // 撃破後の再出現クールダウン
let walker = null;
const _wkV1 = new THREE.Vector3(), _wkV2 = new THREE.Vector3(), _wkV3 = new THREE.Vector3(), _wkV4 = new THREE.Vector3();
const _wkQ = new THREE.Quaternion(), _wkYAxis = new THREE.Vector3(0, 1, 0), _wkRay = new THREE.Raycaster(), _wkE = new THREE.Euler();
const _cullFrus = new THREE.Frustum(), _cullM = new THREE.Matrix4(), _cullSph = new THREE.Sphere();
let _cullFrame = -1;
function sphereOnScreen(pos, r) {   // 画面外なら脚IK等の見た目更新をスキップ（歩行・破壊などのロジックは継続）
  if (_cullFrame !== _dbg) { _cullM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _cullFrus.setFromProjectionMatrix(_cullM); _cullFrame = _dbg; }
  _cullSph.center.copy(pos); _cullSph.radius = r;
  return _cullFrus.intersectsSphere(_cullSph);
}

function wkBoneMesh(r, len, mat) {   // 2関節間を結ぶ円柱（毎フレーム位置と向きを更新）
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.8, 1, 8), mat);
  m.scale.y = len;
  return m;
}
function wkOrient(mesh, a, b) {   // aからbへ円柱を張る
  _wkV3.subVectors(b, a);
  const len = _wkV3.length();
  mesh.position.copy(a).addScaledVector(_wkV3, 0.5);
  mesh.quaternion.setFromUnitVectors(_wkYAxis, _wkV3.normalize());
  mesh.scale.y = Math.max(0.1, len);
}
let wkMatCache = null, spMatCache = null;
function resetCarveSet(set, baseY, height) {   // 使い回し材質の穴・溶解を初期化
  for (let i = 0; i < set.uRadii.length; i++) { set.uRadii[i].value = 0; set.uCenters[i].value.set(1e6, 1e6, 1e6); }
  if (set.uKill) set.uKill.value = 0;
  set.uKillOn.value = 0;
  set.uBaseY.value = baseY; set.uHeight.value = height;
}
function ensureWkMats() {   // 再出現でも材質を使い回し＝パイプライン再コンパイルのヒッチを防ぐ
  if (!wkMatCache) {
    const flashU = uniform(0);
    wkMatCache = {
      flashU,
      cmBody: makeCarveMaterial(new THREE.MeshStandardMaterial({ color: 0x3a4149, metalness: 0.7, roughness: 0.45 }), 0, 40, flashU),
      cmLeg: makeCarveMaterial(new THREE.MeshStandardMaterial({ color: 0x2c3138, metalness: 0.6, roughness: 0.55 }), 0, 40, flashU),
      matAcc: new THREE.MeshStandardMaterial({ color: 0x8a2f2f, metalness: 0.5, roughness: 0.5, emissive: 0x300808, emissiveIntensity: 0.8 }),
    };
  }
  wkMatCache.flashU.value = 0;
  resetCarveSet(wkMatCache.cmBody, 0, 40); resetCarveSet(wkMatCache.cmLeg, 0, 40);
  return wkMatCache;
}
function ensureSpMats() {
  if (!spMatCache) {
    const flashU = uniform(0);
    spMatCache = {
      flashU,
      cmBody: makeCarveMaterial(new THREE.MeshStandardMaterial({ color: 0x2f3540, metalness: 0.7, roughness: 0.45 }), 0, 120, flashU),
      cmLeg: makeCarveMaterial(new THREE.MeshStandardMaterial({ color: 0x232830, metalness: 0.6, roughness: 0.55 }), 0, 120, flashU),
      matAcc: new THREE.MeshStandardMaterial({ color: 0x8a2f2f, metalness: 0.5, roughness: 0.5, emissive: 0x300808, emissiveIntensity: 0.8 }),
    };
  }
  spMatCache.flashU.value = 0;
  resetCarveSet(spMatCache.cmBody, 0, 120); resetCarveSet(spMatCache.cmLeg, 0, 120);
  return spMatCache;
}
function warmEnemyMats() {   // 出現時のシェーダコンパイルヒッチ対策: タイトル中に一度描画してコンパイルさせる
  const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const meshes = [];
  for (const cm of [ensureWkMats().cmBody, ensureWkMats().cmLeg, ensureSpMats().cmBody, ensureSpMats().cmLeg]) {
    const m = new THREE.Mesh(g, cm.mat);
    m.frustumCulled = false;   // 画面外でも描画パスに載せてコンパイルさせる
    m.position.set(0, -2000, 0);
    scene.add(m); meshes.push(m);
  }
  setTimeout(() => { for (const m of meshes) scene.remove(m); }, 5000);
}
function spawnWalker() {
  // 市街境界（建物コリジョンの範囲）
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const b of collBoxes) { if (b.top <= b.bottom) continue; x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x); z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z); }
  if (x0 > x1) return;
  const bounds = { x0: x0 + 30, x1: x1 - 30, z0: z0 + 30, z1: z1 - 30 };
  const ang = Math.random() * Math.PI * 2;
  const px = Math.max(bounds.x0, Math.min(bounds.x1, player.pos.x + Math.cos(ang) * 250));
  const pz = Math.max(bounds.z0, Math.min(bounds.z1, player.pos.z + Math.sin(ang) * 250));
  const { flashU: wkFlashU, cmBody, cmLeg, matAcc } = ensureWkMats();   // 使い回し（再コンパイル防止）
  const matBody = cmBody.mat, matLeg = cmLeg.mat;
  const root = new THREE.Group();
  // 胴体＋装甲
  const body = new THREE.Mesh(new THREE.BoxGeometry(WK.bodyW, WK.bodyH, WK.bodyD), matBody);
  root.add(body);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(WK.bodyW + 2.4, 1.4, WK.bodyD + 2.4), matLeg);
  plate.position.y = WK.bodyH / 2 + 0.4; root.add(plate);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 4), matAcc);
  nose.position.set(0, -0.6, WK.bodyD / 2 + 1.6); root.add(nose);   // 前方マーカー（+Z が正面）
  // 砲塔（ヨー台座＋ピッチバレル）
  const turret = new THREE.Group(); turret.position.y = WK.bodyH / 2 + 1.1; root.add(turret);
  const tBase = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 5.2, 3.2, 12), matBody); tBase.position.y = 1.6; turret.add(tBase);
  const pitchPivot = new THREE.Group(); pitchPivot.position.y = 3.6; turret.add(pitchPivot);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 12, 10), matLeg);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = 6; pitchPivot.add(barrel);
  const muzzleTip = new THREE.Object3D(); muzzleTip.position.set(0, 0, 12); pitchPivot.add(muzzleTip);
  // 脚4本
  const legs = [];
  const hipDefs = [[-WK.bodyW / 2, WK.bodyD / 2 - 1.5], [WK.bodyW / 2, WK.bodyD / 2 - 1.5], [-WK.bodyW / 2, -WK.bodyD / 2 + 1.5], [WK.bodyW / 2, -WK.bodyD / 2 + 1.5]];
  for (let i = 0; i < 4; i++) {
    const [hx, hz] = hipDefs[i];
    const femur = wkBoneMesh(2.6, WK.L1, matLeg);
    const tibia = wkBoneMesh(1.9, WK.L2, matLeg);
    const hipBall = new THREE.Mesh(new THREE.SphereGeometry(3.4, 10, 8), matBody);
    const kneeBall = new THREE.Mesh(new THREE.SphereGeometry(2.6, 10, 8), matAcc);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 2.4, 10), matBody);
    scene.add(femur, tibia, hipBall, kneeBall, foot);
    legs.push({
      idx: i,
      hipOff: new THREE.Vector3(hx, -WK.bodyH / 2 + 0.5, hz),
      homeOff: new THREE.Vector3(hx * 1.9, 0, hz * 1.7),   // 接地ホーム（胴体基準・広め）
      foot: new THREE.Vector3(), step: null,
      femur, tibia, hipBall, kneeBall, footMesh: foot,
    });
  }
  scene.add(root);
  const gy = groundYAt(px, pz, 400);   // 高い基準から下ろす（丘の中からレイが出ると外れる）
  walker = {
    root, turret, pitchPivot, muzzleTip, legs, bounds,
    pos: new THREE.Vector3(px, gy + WK.hipY, pz), yaw: Math.random() * Math.PI * 2,
    target: null, retargetT: 0, smashT: 0, beamT: WK.beamCd, swayT: 0,
    hp: WK.hp, carve: { sets: [cmBody, cmLeg], pts: [] }, dying: false, dieT: 0, accMeshes: [], flashU: wkFlashU,
  };
  root.traverse((o) => { if (o.isMesh && o.material === matAcc) walker.accMeshes.push(o); });
  for (const lg of legs) walker.accMeshes.push(lg.kneeBall);
  for (const lg of legs) {   // 初期の足位置＝ホーム
    lg.foot.copy(lg.homeOff).applyAxisAngle(_wkYAxis, walker.yaw).add(walker.pos);
    lg.foot.y = groundYAt(lg.foot.x, lg.foot.z, walker.pos.y + 300);
  }
  window.__walker = walker;
  window.__walkerDbg = { get dmg() { return cityDamaged ? cityDamaged.children.length : 0; }, get player() { return player; }, get cam() { return camera; }, fire: wkFireBeam, hit: walkerHit, get w() { return walker; } };
  console.log('walker spawn', px.toFixed(0), pz.toFixed(0));
}
function walkerHit(point, dmg) {   // ビル同様: 着弾点に穴あきカーブ＋炎/がれき。HP0で溶解崩壊
  if (!walker || walker.dying) return;
  walker.hp -= dmg;
  walker.flashU.value = 1;   // 一瞬赤く
  const c = walker.carve;
  const local = point.clone().sub(walker.pos);
  local.applyAxisAngle(_wkYAxis, -walker.yaw);
  const i = Math.min(c.pts.length, 5);   // CARVE_MAX=6
  c.pts[i] = { p: local, r: 1.9 + Math.random() * 0.9 };
  for (const set of c.sets) set.uRadii[i].value = c.pts[i].r;
  spawnImpactFx(point, 1.1);
  spawnDebrisBurst(point, 'bld', 0.8);
  if (walker.hp <= 0) walkerDie();
}
function walkerDie() {
  addKill('walker');
  const w = walker;
  w.dying = true; w.dieT = 0; w.slammed = false;
  w.dieStartY = w.pos.y;
  w.dieGroundY = groundYAt(w.pos.x, w.pos.z, w.pos.y + 300);
  playSfxAt('bomb.ogg', w.pos, 0.9);   // 致命打。激突時に bakuha が鳴る
}
function walkerRemove() {
  const w = walker;
  scene.remove(w.root);
  for (const lg of w.legs) { scene.remove(lg.femur, lg.tibia, lg.hipBall, lg.kneeBall, lg.footMesh); }
  walker = null;
  walkerCd = WK.respawnSec;
}
function wkSolveLeg(lg, yaw, quat) {   // 2ボーンIK: 股→膝→足（膝ポール=外側+上）。quat指定時は転倒姿勢
  if (quat) _wkV1.copy(lg.hipOff).applyQuaternion(quat).add(walker.pos);
  else _wkV1.copy(lg.hipOff).applyAxisAngle(_wkYAxis, yaw).add(walker.pos);      // 股（ワールド）
  const hip = _wkV1, foot = lg.foot;
  _wkV2.subVectors(foot, hip);
  let d = _wkV2.length();
  const maxD = WK.L1 + WK.L2 - 0.5;
  if (d > maxD) { _wkV2.multiplyScalar(maxD / d); d = maxD; }
  _wkV2.normalize();
  // ポール: 胴体中心から股への外向き水平＋上
  _wkV4.copy(lg.hipOff).setY(0).normalize().applyAxisAngle(_wkYAxis, yaw);
  _wkV4.y = 0.9; _wkV4.normalize();
  // dir に直交するポール成分
  _wkV3.copy(_wkV4).addScaledVector(_wkV2, -_wkV2.dot(_wkV4));
  if (_wkV3.lengthSq() < 1e-6) _wkV3.set(0, 1, 0);
  _wkV3.normalize();
  const a = (WK.L1 * WK.L1 - WK.L2 * WK.L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, WK.L1 * WK.L1 - a * a));
  const knee = _wkV4.copy(hip).addScaledVector(_wkV2, a).addScaledVector(_wkV3, h);
  lg.hipBall.position.copy(hip);
  lg.kneeBall.position.copy(knee);
  wkOrient(lg.femur, hip, knee);
  wkOrient(lg.tibia, knee, foot);
  lg.footMesh.position.copy(foot).y += 0.8;
}
function wkSmashRays() {   // 進行方向の建物をなぎ倒す（collGridボックス直判定＝軽量）
  const fwd = _wkV1.set(Math.sin(walker.yaw), 0, Math.cos(walker.yaw));
  for (const yOff of [10, 20]) {
    for (const aOff of [-0.35, 0, 0.35]) {
      _wkV2.copy(fwd).applyAxisAngle(_wkYAxis, aOff);
      _wkV3.set(walker.pos.x, walker.pos.y - WK.hipY + yOff, walker.pos.z);
      const h = rayCityBox(_wkV3.x, _wkV3.y, _wkV3.z, _wkV2.x, _wkV2.y, _wkV2.z, WK.smashRange);
      if (h) hitBoxBuilding(h.bi, _wkV3.x + _wkV2.x * h.t, _wkV3.y + _wkV2.y * h.t, _wkV3.z + _wkV2.z * h.t, WK.smashDmg, 2.2);
    }
  }
}
function wkFootSmash(footPos) {   // 着地点の建物破壊＋踏み跡
  const h = rayCityBox(footPos.x, footPos.y + 30, footPos.z, 0, -1, 0, 40);
  if (h) hitBoxBuilding(h.bi, footPos.x, footPos.y + 30 - h.t, footPos.z, WK.smashDmg, 2);
  const onRoad = roadTopAt(footPos.x, footPos.z) != null;
  spawnDebrisBurst(footPos, onRoad ? 'road' : 'ground', 0.8);
}
function wkFireBeam(tgt) {   // 主砲: 太いエネルギー弾（弾速85=回避可能）
  walker.muzzleTip.getWorldPosition(_wkV1);
  if (tgt) _wkV2.copy(tgt);
  else { _wkV2.copy(player.pos); _wkV2.y += 1.0; }
  const dir = _wkV3.subVectors(_wkV2, _wkV1).normalize();
  fireEnemyBolt(_wkV1, dir, { speed: 85, radius: 1.1, len: 10, color: 0xffb040, dmg: 12, knock: WK.knock, bldDmg: DMG_SHOT, fxScale: 1, range: WK.beamRange + 80 });
  playSfxAt('beam.ogg', _wkV1, 0.5);
}
function updateWalker(dt) {
  if (!KENNEY_CITY) return;
  if (!walker) {
    if (walkerCd > 0) { walkerCd -= dt; return; }
    if (enemyAllowed('walker') && cityRoot && collBoxes.length && player.ready) spawnWalker();
    return;
  }
  const w = walker;
  if (w.flashU.value > 0) w.flashU.value = Math.max(0, w.flashU.value - dt * 4);   // 被弾フラッシュ減衰
  // 穴あきカーブの中心をウォーカーに追従させる（ビルは静的だがこちらは動く）
  for (let i = 0; i < w.carve.pts.length; i++) {
    const cp = w.carve.pts[i];
    if (!cp) continue;
    _wkV4.copy(cp.p).applyAxisAngle(_wkYAxis, w.yaw).add(w.pos);
    for (const set of w.carve.sets) set.uCenters[i].value.copy(_wkV4);
  }
  if (w.dying) {   // 段階1: ゆっくり前へ倒れる → 地面に激突 → 段階2: 溶解して消える
    w.dieT += dt;
    if (w.dieT < WK.fallSec) {   // 転倒（加速しながら前へ75°）
      const u = w.dieT / WK.fallSec;
      const ang = (u * u) * (75 * Math.PI / 180);
      _wkE.set(ang, w.yaw, 0, 'YXZ');
      w.root.quaternion.setFromEuler(_wkE);
      w.pos.y = w.dieStartY + (w.dieGroundY + 9 - w.dieStartY) * (u * u);
      w.root.position.copy(w.pos);
      if (sphereOnScreen(w.pos, 70)) for (const lg of w.legs) wkSolveLeg(lg, w.yaw, w.root.quaternion);   // 足は接地したまま＝脚が折れ崩れる
      if ((w._dieFxT = (w._dieFxT || 0) - dt) <= 0) {
        w._dieFxT = 0.5;
        _wkV4.set(w.pos.x + (Math.random() - 0.5) * 12, w.pos.y + (Math.random() - 0.5) * 6, w.pos.z + (Math.random() - 0.5) * 12);
        spawnImpactFx(_wkV4, 1.2);
      }
      return;
    }
    if (!w.slammed) {   // 激突: 土煙＋がれき＋焦げ＋bakuha
      w.slammed = true;
      const fwdX = Math.sin(w.yaw), fwdZ = Math.cos(w.yaw);
      _wkV4.set(w.pos.x + fwdX * 12, w.dieGroundY, w.pos.z + fwdZ * 12);
      playSfxAt('bakuha.ogg', _wkV4, 1.0);
      spawnImpactFx(_wkV4, 2.6);
      spawnDebrisBurst(_wkV4, 'bld', 2);
      spawnScorch(_wkV4, 6);
      spawnFirePillar(_wkV4, 1.4);
      for (const set of w.carve.sets) { set.uKillOn.value = 1; set.uBaseY.value = w.dieGroundY; set.uHeight.value = 24; }
      for (const o of w.accMeshes) o.visible = false;   // 溶解しないアクセントは消す
    }
    const mu = (w.dieT - WK.fallSec) / WK.meltSec;   // 溶解（上から白熱消滅）
    for (const set of w.carve.sets) set.uKill.value = Math.min(1, mu);
    w.pos.y -= dt * 0.8;
    w.root.position.copy(w.pos);
    if ((w._dieFxT = (w._dieFxT || 0) - dt) <= 0) {
      w._dieFxT = 0.45;
      _wkV4.set(w.pos.x + (Math.random() - 0.5) * 16, w.pos.y + (Math.random() - 0.5) * 6, w.pos.z + (Math.random() - 0.5) * 16);
      spawnImpactFx(_wkV4, 1.4);
      if (Math.random() < 0.4) spawnFirePillar(_wkV4, 0.7);
    }
    if (mu >= 1.1) walkerRemove();
    return;
  }
  // ── 徘徊: 目標点へ旋回して前進 ──
  w.retargetT -= dt;
  if (!w.target || w.retargetT <= 0 || Math.hypot(w.target.x - w.pos.x, w.target.z - w.pos.z) < 25) {
    w.target = { x: w.bounds.x0 + Math.random() * (w.bounds.x1 - w.bounds.x0), z: w.bounds.z0 + Math.random() * (w.bounds.z1 - w.bounds.z0) };
    w.retargetT = 30;
  }
  const wantYaw = Math.atan2(w.target.x - w.pos.x, w.target.z - w.pos.z);
  let dy = wantYaw - w.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  w.yaw += Math.max(-WK.turn * dt, Math.min(WK.turn * dt, dy));
  const throttle = Math.max(0, 1 - Math.abs(dy) * 1.2);   // 曲がり切るまで減速
  w.pos.x += Math.sin(w.yaw) * WK.speed * throttle * dt;
  w.pos.z += Math.cos(w.yaw) * WK.speed * throttle * dt;
  // 接地高さ＝足の平均（ステップ中の足は除く）＋股関節高
  let gsum = 0, gn = 0;
  for (const lg of w.legs) { if (!lg.step) { gsum += lg.foot.y; gn++; } }
  const gy = gn ? gsum / gn : groundYAt(w.pos.x, w.pos.z, w.pos.y + 300);
  w.swayT += dt;
  w.pos.y += ((gy + WK.hipY + Math.sin(w.swayT * 1.3) * 0.35) - w.pos.y) * Math.min(1, dt * 3);
  w.root.position.copy(w.pos);
  w.root.rotation.y = w.yaw;
  // ── 足のステップ（最も遅れている脚を優先。対角ペアなら2本同時＝トロット）──
  for (const lg of w.legs) {
    if (!lg.step) continue;
    const st = lg.step;
    st.t = Math.min(1, st.t + dt / WK.stepDur);
    lg.foot.lerpVectors(st.from, st.to, st.t);
    lg.foot.y += Math.sin(st.t * Math.PI) * WK.stepArc;
    if (st.t >= 1) {
      lg.foot.copy(st.to);
      lg.step = null;
      wkFootSmash(lg.foot);
    }
  }
  const steppingLegs = w.legs.filter((l) => l.step);
  if (steppingLegs.length < 2) {
    let best = null, bestD = WK.stepTrig;
    for (const lg of w.legs) {
      if (lg.step) continue;
      if (steppingLegs.length === 1 && steppingLegs[0].idx + lg.idx !== 3) continue;   // 対角(0-3/1-2)のみ同時
      // ホーム位置（進行方向へ少しリード）
      _wkV1.copy(lg.homeOff).applyAxisAngle(_wkYAxis, w.yaw).add(w.pos);
      _wkV1.x += Math.sin(w.yaw) * WK.speed * throttle * 1.3;   // ホームより先へ踏み出す＝1歩で大きく稼ぐ
      _wkV1.z += Math.cos(w.yaw) * WK.speed * throttle * 1.3;
      const d = Math.hypot(_wkV1.x - lg.foot.x, _wkV1.z - lg.foot.z);
      if (d > bestD) { bestD = d; best = lg; best._toX = _wkV1.x; best._toZ = _wkV1.z; }
    }
    if (best) {
      const to = new THREE.Vector3(best._toX, 0, best._toZ);
      to.y = groundYAt(to.x, to.z, w.pos.y + 300);
      best.step = { from: best.foot.clone(), to, t: 0 };
    }
  }
  if (sphereOnScreen(w.pos, 70)) for (const lg of w.legs) wkSolveLeg(lg, w.yaw);   // 画面外はIK省略
  // ── なぎ倒し ──
  w.smashT -= dt;
  if (w.smashT <= 0 && throttle > 0.2) { w.smashT = WK.smashInt; wkSmashRays(); }
  // ── 砲塔: キルゾーン内=プレイヤー狙い / 外=町（建物）を砲撃 ──
  const dx = player.pos.x - w.pos.x, dz = player.pos.z - w.pos.z;
  const distP = Math.hypot(dx, dz);
  const playerIn = distP < WK.killZone;
  let aimX, aimY, aimZ;
  if (playerIn) { aimX = player.pos.x; aimY = player.pos.y + 1.0; aimZ = player.pos.z; }
  else {
    w.townT = (w.townT || 0) - dt;
    if (!w.townTarget || w.townT <= 0) {   // 砲撃目標＝射程内のランダムな建物
      w.townTarget = null;
      for (let tryN = 0; tryN < 40; tryN++) {
        const b = collBoxes[(Math.random() * collBoxes.length) | 0];
        if (!b || b.top <= b.bottom) continue;
        const d = Math.hypot(b.x - w.pos.x, b.z - w.pos.z);
        if (d < 40 || d > WK.beamRange * 0.9) continue;
        w.townTarget = { x: b.x, y: b.bottom + (b.top - b.bottom) * 0.6, z: b.z };
        break;
      }
      w.townT = 6 + Math.random() * 4;
    }
    if (w.townTarget) { aimX = w.townTarget.x; aimY = w.townTarget.y; aimZ = w.townTarget.z; }
    else { aimX = player.pos.x; aimY = player.pos.y; aimZ = player.pos.z; }
  }
  const adx = aimX - w.pos.x, adz = aimZ - w.pos.z;
  const aimD = Math.hypot(adx, adz);
  const wantT = Math.atan2(adx, adz) - w.yaw;   // 砲塔は胴体ローカルのヨー
  let tdy = wantT - w.turret.rotation.y;
  while (tdy > Math.PI) tdy -= Math.PI * 2; while (tdy < -Math.PI) tdy += Math.PI * 2;
  w.turret.rotation.y += Math.max(-WK.turretYawRate * dt, Math.min(WK.turretYawRate * dt, tdy));
  w.muzzleTip.getWorldPosition(_wkV1);
  const pitchWant = Math.atan2(aimY - _wkV1.y, aimD);
  w.pitchPivot.rotation.x = Math.max(-0.9, Math.min(0.6, w.pitchPivot.rotation.x + Math.max(-0.8 * dt, Math.min(0.8 * dt, -pitchWant - w.pitchPivot.rotation.x))));
  w.beamT -= dt;
  const pitchOk = Math.abs(-pitchWant - w.pitchPivot.rotation.x) < 0.15;   // 俯角上限を超える目標（真下など）は撃てない
  if (w.beamT <= 0 && aimD < WK.beamRange && Math.abs(tdy) < WK.aimTol && pitchOk) {
    w.beamT = WK.beamCd + Math.random() * 1.2;
    wkFireBeam(playerIn ? null : _wkV4.set(aimX, aimY, aimZ));
  }
}

// ══════════ スパイダータンク（ウォーカー上位互換: 3倍・6脚・主砲＋誘導ミサイル＋腹部砲門2基） ══════════
const SP = {
  bodyW: 42, bodyH: 18, bodyD: 60, hipY: 72,       // 3倍スケール
  L1: 54, L2: 72,                                   // クモのように長い足
  speed: 13, turn: 0.35,
  stepTrig: 20, stepDur: 0.7, stepArc: 22,          // 大股
  smashInt: 0.14, smashDmg: 8, smashRange: 50,
  beamCd: 3.2, beamRange: 500, aimTol: 0.12, turretYawRate: 0.8, beamDmg: 15,
  mslCd: 6.5, mslN: 2, mslSpeed: 58, mslTurn: 1.6, mslLife: 7, mslDmg: 15, mslR: 3.2,   // 誘導ミサイル
  bellyCd: 0.55, bellyR: 130, bellyDmg: 8,          // 腹部砲門（真下の敵へ戦闘機ショット連射）
  hp: 240, respawnSec: 60, fallSec: 3.2, meltSec: 3.4,
  killZone: 260,
};
let spider = null, spiderCd = 0;
const spMissiles = [];
const _spV1 = new THREE.Vector3(), _spV2 = new THREE.Vector3(), _spV3 = new THREE.Vector3(), _spV4 = new THREE.Vector3();
const _spE = new THREE.Euler();

function spawnSpider() {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const b of collBoxes) { if (b.top <= b.bottom) continue; x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x); z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z); }
  if (x0 > x1) return;
  const bounds = { x0: x0 + 60, x1: x1 - 60, z0: z0 + 60, z1: z1 - 60 };
  const ang = Math.random() * Math.PI * 2;
  const px = Math.max(bounds.x0, Math.min(bounds.x1, player.pos.x + Math.cos(ang) * 450));
  const pz = Math.max(bounds.z0, Math.min(bounds.z1, player.pos.z + Math.sin(ang) * 450));
  const { flashU: spFlashU, cmBody, cmLeg, matAcc } = ensureSpMats();   // 使い回し（再コンパイル防止）
  const matBody = cmBody.mat, matLeg = cmLeg.mat;
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(SP.bodyW, SP.bodyH, SP.bodyD), matBody);
  root.add(body);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(SP.bodyW + 7, 4, SP.bodyD + 7), matLeg);
  plate.position.y = SP.bodyH / 2 + 1.2; root.add(plate);
  const head = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 16), matBody);   // 頭部（前方下）
  head.position.set(0, -SP.bodyH / 2, SP.bodyD / 2 + 6); root.add(head);
  // 主砲（ウォーカーと同形式・大型）
  const turret = new THREE.Group(); turret.position.y = SP.bodyH / 2 + 3.4; root.add(turret);
  const tBase = new THREE.Mesh(new THREE.CylinderGeometry(12, 14.5, 9, 12), matBody); tBase.position.y = 4.5; turret.add(tBase);
  const pitchPivot = new THREE.Group(); pitchPivot.position.y = 10; turret.add(pitchPivot);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 34, 10), matLeg);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = 17; pitchPivot.add(barrel);
  const muzzleTip = new THREE.Object3D(); muzzleTip.position.set(0, 0, 34); pitchPivot.add(muzzleTip);
  // 誘導ミサイルのボックス型タレット
  const mslBox = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 12), matLeg);
  mslBox.position.set(-14, SP.bodyH / 2 + 6, -12); root.add(mslBox);
  const mslCells = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 10), matAcc);
  mslCells.position.set(-14, SP.bodyH / 2 + 10.2, -12); root.add(mslCells);
  // 腹部砲門2基（頭の下・真下の敵を狙う）
  const bellyGuns = [];
  for (const sgn of [-1, 1]) {
    const g = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.0, 7, 8), matAcc);
    g.position.set(sgn * 6, -SP.bodyH / 2 - 5.5, SP.bodyD / 2 + 6);
    root.add(g);
    bellyGuns.push(g);
  }
  // 6脚（前/中/後 ×左右）
  const legs = [];
  const hipDefs = [
    [-SP.bodyW / 2, SP.bodyD / 2 - 5], [SP.bodyW / 2, SP.bodyD / 2 - 5],
    [-SP.bodyW / 2, 0], [SP.bodyW / 2, 0],
    [-SP.bodyW / 2, -SP.bodyD / 2 + 5], [SP.bodyW / 2, -SP.bodyD / 2 + 5],
  ];
  for (let i = 0; i < 6; i++) {
    const [hx, hz] = hipDefs[i];
    const femur = wkBoneMesh(5.2, SP.L1, matLeg);
    const tibia = wkBoneMesh(3.6, SP.L2, matLeg);
    const hipBall = new THREE.Mesh(new THREE.SphereGeometry(7.5, 10, 8), matBody);
    const kneeBall = new THREE.Mesh(new THREE.SphereGeometry(5.4, 10, 8), matAcc);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 7.5, 5, 10), matBody);
    scene.add(femur, tibia, hipBall, kneeBall, foot);
    legs.push({
      idx: i,
      hipOff: new THREE.Vector3(hx, -SP.bodyH / 2 + 1.5, hz),
      homeOff: new THREE.Vector3(hx * 2.6, 0, hz * 1.9),   // クモらしく大きく広げる
      foot: new THREE.Vector3(), step: null,
      femur, tibia, hipBall, kneeBall, footMesh: foot,
    });
  }
  scene.add(root);
  const gy = groundYAt(px, pz, 500);
  spider = {
    root, turret, pitchPivot, muzzleTip, bellyGuns, legs, bounds,
    pos: new THREE.Vector3(px, gy + SP.hipY, pz), yaw: Math.random() * Math.PI * 2,
    target: null, retargetT: 0, smashT: 0, beamT: SP.beamCd, mslT: SP.mslCd, bellyT: 0, swayT: 0,
    hp: SP.hp, carve: { sets: [cmBody, cmLeg], pts: [] }, dying: false, dieT: 0, accMeshes: [], flashU: spFlashU,
  };
  root.traverse((o) => { if (o.isMesh && o.material === matAcc) spider.accMeshes.push(o); });
  for (const lg of legs) {
    spider.accMeshes.push(lg.kneeBall);
    lg.foot.copy(lg.homeOff).applyAxisAngle(_wkYAxis, spider.yaw).add(spider.pos);
    lg.foot.y = groundYAt(lg.foot.x, lg.foot.z, spider.pos.y + 300);
  }
  window.__spider = spider;
  window.__spiderDbg = { get msl() { return spMissiles; }, get bolts() { return enemyBolts; }, hit: spiderHit, fireMsl: spFireMissiles, destroyMsl: destroySpMissile, fireBolt: fireEnemyBolt };
  console.log('spider spawn', px.toFixed(0), pz.toFixed(0));
}
function spSolveLeg(lg, yaw, quat) {   // 2ボーンIK（ウォーカーと同形・寸法のみ）
  if (quat) _spV1.copy(lg.hipOff).applyQuaternion(quat).add(spider.pos);
  else _spV1.copy(lg.hipOff).applyAxisAngle(_wkYAxis, yaw).add(spider.pos);
  const hip = _spV1, foot = lg.foot;
  _spV2.subVectors(foot, hip);
  let d = _spV2.length();
  const maxD = SP.L1 + SP.L2 - 1.5;
  if (d > maxD) { _spV2.multiplyScalar(maxD / d); d = maxD; }
  _spV2.normalize();
  _spV4.copy(lg.hipOff).setY(0).normalize().applyAxisAngle(_wkYAxis, yaw);
  _spV4.y = 1.5;   // クモらしく膝を高く
  _spV4.normalize();
  _spV3.copy(_spV4).addScaledVector(_spV2, -_spV2.dot(_spV4));
  if (_spV3.lengthSq() < 1e-6) _spV3.set(0, 1, 0);
  _spV3.normalize();
  const a = (SP.L1 * SP.L1 - SP.L2 * SP.L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, SP.L1 * SP.L1 - a * a));
  const knee = _spV4.copy(hip).addScaledVector(_spV2, a).addScaledVector(_spV3, h);
  lg.hipBall.position.copy(hip);
  lg.kneeBall.position.copy(knee);
  wkOrient(lg.femur, hip, knee);
  wkOrient(lg.tibia, knee, foot);
  lg.footMesh.position.copy(foot).y += 2.4;
}
function spiderHit(point, dmg) {
  if (!spider || spider.dying) return;
  spider.hp -= dmg;
  spider.flashU.value = 1;
  const c = spider.carve;
  const local = point.clone().sub(spider.pos);
  local.applyAxisAngle(_wkYAxis, -spider.yaw);
  const i = Math.min(c.pts.length, 5);
  c.pts[i] = { p: local, r: 5 + Math.random() * 2.5 };
  for (const set of c.sets) set.uRadii[i].value = c.pts[i].r;
  spawnImpactFx(point, 1.6);
  spawnDebrisBurst(point, 'bld', 1.2);
  if (spider.hp <= 0) spiderDie();
}
function spiderDie() {
  addKill('spider');
  const w = spider;
  w.dying = true; w.dieT = 0; w.slammed = false;
  w.dieStartY = w.pos.y;
  w.dieGroundY = groundYAt(w.pos.x, w.pos.z, w.pos.y + 500);
  playSfxAt('bomb.ogg', w.pos, 1.0);
}
function spiderRemove() {
  const w = spider;
  scene.remove(w.root);
  for (const lg of w.legs) scene.remove(lg.femur, lg.tibia, lg.hipBall, lg.kneeBall, lg.footMesh);
  spider = null;
  spiderCd = SP.respawnSec;
}
function spFireBeam(tgt) {   // 主砲: さらに太いエネルギー弾（弾速105）
  spider.muzzleTip.getWorldPosition(_spV1);
  if (tgt) _spV2.copy(tgt);
  else { _spV2.copy(player.pos); _spV2.y += 1.0; }
  const dir = _spV3.subVectors(_spV2, _spV1).normalize();
  fireEnemyBolt(_spV1, dir, { speed: 105, radius: 2.0, len: 16, color: 0xffb040, dmg: SP.beamDmg, knock: 30, bldDmg: DMG_SHOT * 2, fxScale: 1.6, range: SP.beamRange + 100 });
  playSfxAt('beam.ogg', _spV1, 0.6);
}
const _mslGlowMat = new THREE.MeshBasicMaterial({ color: 0xffd06a });
const _mslBodyMat = new THREE.MeshBasicMaterial({ color: 0xff7a20 });   // 夜でも見えるオレンジ（unlit）
function spFireMissiles() {   // ボックスタレットから誘導ミサイル
  for (let i = 0; i < SP.mslN; i++) {
    const m = new THREE.Group();
    const bodyM = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 4.4, 8), _mslBodyMat);
    bodyM.rotation.x = Math.PI / 2; m.add(bodyM);
    const glow = new THREE.Mesh(_bombGlowGeo, _mslGlowMat); glow.position.z = -2.4; m.add(glow);
    _spV1.set(-14 + i * 6, SP.bodyH / 2 + 8, -12).applyAxisAngle(_wkYAxis, spider.yaw).add(spider.pos);
    m.position.copy(_spV1);
    scene.add(m);
    const ms = { mesh: m, vel: new THREE.Vector3((Math.random() - 0.5) * 12, 42, (Math.random() - 0.5) * 12), t: 0 };
    ms.flyVel = ms.vel;   // 参照互換（撃墜処理等）
    ms.exhaust = attachExhaust(m, -2.6, 4.5, 0.35);
    spMissiles.push(ms);
  }
  playSfxAt('beam.ogg', spider.pos, 0.5);
}
function removeSpMissileFx(ms) { /* 噴射コーンは mesh の子として一緒に除去される */ }
function updateSpMissiles(dt) {
  for (let k = spMissiles.length - 1; k >= 0; k--) {
    const ms = spMissiles[k];
    ms.t += dt;
    // 誘導: 目標へ旋回（発射直後0.5sは上へ吹き上がる）
    if (ms.t > 0.5 && !playerDead) {
      _spV1.copy(player.pos).sub(ms.mesh.position).normalize();
      ms.vel.lerp(_spV1.multiplyScalar(SP.mslSpeed), Math.min(1, SP.mslTurn * dt));
    }
    const sp2 = ms.vel.length();
    if (sp2 > 0.01) ms.vel.multiplyScalar(Math.min(SP.mslSpeed, sp2 + 30 * dt) / sp2);
    ms.mesh.position.addScaledVector(ms.vel, dt);
    _spV2.copy(ms.mesh.position).add(ms.vel);
    ms.mesh.lookAt(_spV2);
    updateExhaust(ms.exhaust);
    // 命中/着弾/寿命
    const pos = ms.mesh.position;
    const dP = pos.distanceTo(player.pos);
    let boom = false, hitPlayer = false;
    if (dP < SP.mslR && !playerDead) { boom = true; hitPlayer = true; }
    if (!boom) {
      const cx = Math.floor(pos.x / COLL_CELL), cz = Math.floor(pos.z / COLL_CELL);
      outer: for (let dz2 = -1; dz2 <= 1; dz2++) for (let dx2 = -1; dx2 <= 1; dx2++) {
        const arr = collGrid.get((cx + dx2) + '_' + (cz + dz2));
        if (!arr) continue;
        for (const idx of arr) {
          const b = collBoxes[idx];
          if (Math.abs(pos.x - b.x) < b.h && Math.abs(pos.z - b.z) < b.h && pos.y > b.bottom && pos.y < b.top) { boom = true; break outer; }
        }
      }
    }
    const gy = groundYAt(pos.x, pos.z, pos.y + 300);
    if (!boom && (pos.y <= gy || ms.t > SP.mslLife)) boom = true;
    if (!boom) continue;
    spMissiles.splice(k, 1);
    scene.remove(ms.mesh);
    removeSpMissileFx(ms);
    playSfxAt('bomb.ogg', pos, 0.8);
    spawnImpactFx(pos, 1.4);
    if (hitPlayer) { _spV1.copy(ms.vel).normalize(); playerDamage(SP.mslDmg, _spV1); }
    else {
      const bh = rayCityBox(pos.x, pos.y + 30, pos.z, 0, -1, 0, 80);
      if (bh) hitBoxBuilding(bh.bi, pos.x, pos.y + 30 - bh.t, pos.z, DMG_SHOT, 1.2);
      else spawnScorch(_spV3.set(pos.x, gy, pos.z), 3);
    }
  }
}
function destroySpMissile(ms) {   // プレイヤーの攻撃などで空中爆破
  const i = spMissiles.indexOf(ms);
  if (i < 0) return;
  spMissiles.splice(i, 1);
  scene.remove(ms.mesh);
  removeSpMissileFx(ms);
  playSfxAt('bomb_short.ogg', ms.mesh.position, 0.7);
  spawnImpactFx(ms.mesh.position, 1.1);
}
function spBellyShot(gun) {   // 腹部砲門: 戦闘機と同じ紫筒ショットで真下の敵を撃つ
  gun.getWorldPosition(_spV1);
  _spV2.copy(player.pos); _spV2.y += 0.8;
  const dir = _spV3.subVectors(_spV2, _spV1).normalize();
  const plT = rayHitSphere(_spV1, dir, _spV2, 1.8, SP.bellyR * 1.4);
  const end = _spV1.clone().addScaledVector(dir, plT === Infinity ? SP.bellyR : plT);
  spawnBeam(_spV1.clone(), end, plT !== Infinity, 0xc46bff, true);
  playSfxAt('beam.ogg', _spV1, 0.3);
  if (plT !== Infinity) { playerDamage(SP.bellyDmg, dir); spawnImpactFx(end, 0.8); }
}
function updateSpider(dt) {
  if (!KENNEY_CITY) return;
  if (!spider) {
    if (spiderCd > 0) { spiderCd -= dt; return; }
    if (enemyAllowed('spider') && cityRoot && collBoxes.length && player.ready) spawnSpider();
    return;
  }
  const w = spider;
  updateSpMissiles(dt);
  if (w.flashU.value > 0) w.flashU.value = Math.max(0, w.flashU.value - dt * 4);
  for (let i = 0; i < w.carve.pts.length; i++) {
    const cp = w.carve.pts[i];
    if (!cp) continue;
    _spV4.copy(cp.p).applyAxisAngle(_wkYAxis, w.yaw).add(w.pos);
    for (const set of w.carve.sets) set.uCenters[i].value.copy(_spV4);
  }
  if (w.dying) {   // 転倒→激突→溶解（ウォーカーと同演出の大型版）
    w.dieT += dt;
    if (w.dieT < SP.fallSec) {
      const u = w.dieT / SP.fallSec;
      const ang = (u * u) * (65 * Math.PI / 180);
      _spE.set(ang, w.yaw, 0, 'YXZ');
      w.root.quaternion.setFromEuler(_spE);
      w.pos.y = w.dieStartY + (w.dieGroundY + 24 - w.dieStartY) * (u * u);
      w.root.position.copy(w.pos);
      if (sphereOnScreen(w.pos, 200)) for (const lg of w.legs) spSolveLeg(lg, w.yaw, w.root.quaternion);
      return;
    }
    if (!w.slammed) {
      w.slammed = true;
      _spV4.set(w.pos.x + Math.sin(w.yaw) * 30, w.dieGroundY, w.pos.z + Math.cos(w.yaw) * 30);
      playSfxAt('bakuha.ogg', _spV4, 1.0);
      spawnImpactFx(_spV4, 4);
      spawnDebrisBurst(_spV4, 'bld', 3);
      spawnScorch(_spV4, 12);
      spawnFirePillar(_spV4, 2.2);
      for (const set of w.carve.sets) { set.uKillOn.value = 1; set.uBaseY.value = w.dieGroundY; set.uHeight.value = 70; }
      for (const o of w.accMeshes) o.visible = false;
    }
    const mu = (w.dieT - SP.fallSec) / SP.meltSec;
    for (const set of w.carve.sets) set.uKill.value = Math.min(1, mu);
    w.pos.y -= dt * 1.6;
    w.root.position.copy(w.pos);
    if ((w._dieFxT = (w._dieFxT || 0) - dt) <= 0) {
      w._dieFxT = 0.35;
      _spV4.set(w.pos.x + (Math.random() - 0.5) * 50, w.pos.y + (Math.random() - 0.5) * 16, w.pos.z + (Math.random() - 0.5) * 50);
      spawnImpactFx(_spV4, 2.2);
      if (Math.random() < 0.5) spawnFirePillar(_spV4, 1.2);
    }
    if (mu >= 1.1) spiderRemove();
    return;
  }
  // ── 徘徊 ──
  w.retargetT -= dt;
  if (!w.target || w.retargetT <= 0 || Math.hypot(w.target.x - w.pos.x, w.target.z - w.pos.z) < 50) {
    w.target = { x: w.bounds.x0 + Math.random() * (w.bounds.x1 - w.bounds.x0), z: w.bounds.z0 + Math.random() * (w.bounds.z1 - w.bounds.z0) };
    w.retargetT = 40;
  }
  const wantYaw = Math.atan2(w.target.x - w.pos.x, w.target.z - w.pos.z);
  let dy = wantYaw - w.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  w.yaw += Math.max(-SP.turn * dt, Math.min(SP.turn * dt, dy));
  const throttle = Math.max(0, 1 - Math.abs(dy) * 1.2);
  w.pos.x += Math.sin(w.yaw) * SP.speed * throttle * dt;
  w.pos.z += Math.cos(w.yaw) * SP.speed * throttle * dt;
  let gsum = 0, gn = 0;
  for (const lg of w.legs) { if (!lg.step) { gsum += lg.foot.y; gn++; } }
  const gy = gn ? gsum / gn : groundYAt(w.pos.x, w.pos.z, w.pos.y + 300);
  w.swayT += dt;
  w.pos.y += ((gy + SP.hipY + Math.sin(w.swayT * 1.0) * 0.8) - w.pos.y) * Math.min(1, dt * 3);
  w.root.position.copy(w.pos);
  w.root.rotation.y = w.yaw;
  // ── 6脚ゲイト: 最も遅れた脚を優先・同時2本まで ──
  for (const lg of w.legs) {
    if (!lg.step) continue;
    const st = lg.step;
    st.t = Math.min(1, st.t + dt / SP.stepDur);
    lg.foot.lerpVectors(st.from, st.to, st.t);
    lg.foot.y += Math.sin(st.t * Math.PI) * SP.stepArc;
    if (st.t >= 1) {
      lg.foot.copy(st.to);
      lg.step = null;
      const h = rayCityBox(lg.foot.x, lg.foot.y + 60, lg.foot.z, 0, -1, 0, 90);
      if (h) hitBoxBuilding(h.bi, lg.foot.x, lg.foot.y + 60 - h.t, lg.foot.z, SP.smashDmg, 2.4);
      const onRoad = roadTopAt(lg.foot.x, lg.foot.z) != null;
      spawnDebrisBurst(lg.foot, onRoad ? 'road' : 'ground', 1.6);
      playSfxAt('bomb_short.ogg', lg.foot, 0.5);
    }
  }
  const steppingN = w.legs.filter((l) => l.step).length;
  if (steppingN < 2) {
    let best = null, bestD = SP.stepTrig;
    for (const lg of w.legs) {
      if (lg.step) continue;
      _spV1.copy(lg.homeOff).applyAxisAngle(_wkYAxis, w.yaw).add(w.pos);
      _spV1.x += Math.sin(w.yaw) * SP.speed * throttle * 1.4;
      _spV1.z += Math.cos(w.yaw) * SP.speed * throttle * 1.4;
      const d = Math.hypot(_spV1.x - lg.foot.x, _spV1.z - lg.foot.z);
      if (d > bestD) { bestD = d; best = lg; best._toX = _spV1.x; best._toZ = _spV1.z; }
    }
    if (best) {
      const to = new THREE.Vector3(best._toX, 0, best._toZ);
      to.y = groundYAt(to.x, to.z, w.pos.y + 300);
      best.step = { from: best.foot.clone(), to, t: 0 };
    }
  }
  if (sphereOnScreen(w.pos, 200)) for (const lg of w.legs) spSolveLeg(lg, w.yaw);   // 画面外はIK省略
  // ── なぎ倒し ──
  w.smashT -= dt;
  if (w.smashT <= 0 && throttle > 0.2) {
    w.smashT = SP.smashInt;
    const fwd = _spV1.set(Math.sin(w.yaw), 0, Math.cos(w.yaw));
    for (const yOff of [25, 55]) {
      for (const aOff of [-0.3, 0, 0.3]) {
        _spV2.copy(fwd).applyAxisAngle(_wkYAxis, aOff);
        _spV3.set(w.pos.x, w.pos.y - SP.hipY + yOff, w.pos.z);
        const h = rayCityBox(_spV3.x, _spV3.y, _spV3.z, _spV2.x, _spV2.y, _spV2.z, SP.smashRange);
        if (h) hitBoxBuilding(h.bi, _spV3.x + _spV2.x * h.t, _spV3.y + _spV2.y * h.t, _spV3.z + _spV2.z * h.t, SP.smashDmg, 2.6);
      }
    }
  }
  // ── 主砲（キルゾーン内=プレイヤー/外=町。俯角が届かない真下は腹部砲門の担当）──
  const dx = player.pos.x - w.pos.x, dz = player.pos.z - w.pos.z;
  const distP = Math.hypot(dx, dz);
  const playerIn = distP < SP.killZone;
  let aimX, aimY, aimZ;
  if (playerIn && !playerDead) { aimX = player.pos.x; aimY = player.pos.y + 1.0; aimZ = player.pos.z; }
  else {
    w.townT = (w.townT || 0) - dt;
    if (!w.townTarget || w.townT <= 0) {
      w.townTarget = null;
      for (let tryN = 0; tryN < 40; tryN++) {
        const b = collBoxes[(Math.random() * collBoxes.length) | 0];
        if (!b || b.top <= b.bottom) continue;
        const d = Math.hypot(b.x - w.pos.x, b.z - w.pos.z);
        if (d < 90 || d > SP.beamRange * 0.9) continue;
        w.townTarget = { x: b.x, y: b.bottom + (b.top - b.bottom) * 0.6, z: b.z };
        break;
      }
      w.townT = 7 + Math.random() * 4;
    }
    if (w.townTarget) { aimX = w.townTarget.x; aimY = w.townTarget.y; aimZ = w.townTarget.z; }
    else { aimX = player.pos.x; aimY = player.pos.y; aimZ = player.pos.z; }
  }
  const adx = aimX - w.pos.x, adz = aimZ - w.pos.z;
  const aimD = Math.hypot(adx, adz);
  const wantT = Math.atan2(adx, adz) - w.yaw;
  let tdy = wantT - w.turret.rotation.y;
  while (tdy > Math.PI) tdy -= Math.PI * 2; while (tdy < -Math.PI) tdy += Math.PI * 2;
  w.turret.rotation.y += Math.max(-SP.turretYawRate * dt, Math.min(SP.turretYawRate * dt, tdy));
  w.muzzleTip.getWorldPosition(_spV1);
  const pitchWant = Math.atan2(aimY - _spV1.y, aimD);
  w.pitchPivot.rotation.x = Math.max(-0.9, Math.min(0.55, w.pitchPivot.rotation.x + Math.max(-0.8 * dt, Math.min(0.8 * dt, -pitchWant - w.pitchPivot.rotation.x))));
  w.beamT -= dt;
  const pitchOk = Math.abs(-pitchWant - w.pitchPivot.rotation.x) < 0.15;
  if (w.beamT <= 0 && aimD < SP.beamRange && Math.abs(tdy) < SP.aimTol && pitchOk) {
    w.beamT = SP.beamCd + Math.random() * 1.4;
    spFireBeam(playerIn ? null : _spV4.set(aimX, aimY, aimZ));
  }
  // ── 誘導ミサイル（キルゾーン内のみ）──
  w.mslT -= dt;
  if (playerIn && !playerDead && w.mslT <= 0) { w.mslT = SP.mslCd + Math.random() * 2; spFireMissiles(); }
  // ── 腹部砲門: 真下〜近距離下方の敵へ連射 ──
  w.bellyT -= dt;
  const below = player.pos.y < w.pos.y - 8 && distP < SP.bellyR && !playerDead;
  if (below && w.bellyT <= 0) {
    w.bellyT = SP.bellyCd;
    spBellyShot(w.bellyGuns[(Math.random() * 2) | 0]);
  }
}

function tick() {
  const dt = Math.min(_clock.getDelta(), 1 / 30);
  if (SHOW_FPS) updateFpsMeter();
  updateFlight(dt);
  updatePlayerDeath(dt);
  if (!playerRagOn) updatePlayerAnim(dt);
  updateCars(dt);
  updateCarPhysics(dt);
  updateAttacks(dt);      // コンボ窓＋貫通ビーム
  updateKens(dt);         // 地上NPC ken
  if (gameMode !== 'op' && gameMode !== 'ed') {   // シナリオ中は戦闘停止（敵AI・弾・被弾なし）
    updateSpider(dt);       // スパイダータンク（6脚・主砲/誘導ミサイル/腹部砲門）※ウォーカーより先に評価（出現中はウォーカー禁止のため）
    updateWalker(dt);       // 巨大ウォーカー（4足歩行・砲塔ビーム）
    updateEnemyBolts(dt);   // 敵主砲のエネルギー弾
    updateJets(dt);         // 戦闘機スウォーム
  }
  updateDamageFx();       // ダメージ損耗（マントの高さ基準追従）
  exhaustT += dt;         // 噴射コーンの明滅時刻
  if (dmgWarmT > 0) { dmgWarmT -= dt; if (dmgWarmT <= 0) applyDamageFx(); }   // ウォームアップ後、無傷部位の溶解を停止
  updateDamageVignette(dt);
  updateKillUI(dt);
  evalEvents();
  updateFlowTimer(dt);
  updateTalk(dt);
  updatePortrait(dt);
  scn.update(dt);
  updatePredation(dt);    // 掴んだ ken の接地判定→捕食
  updateTotem(dt);        // トーテム（旋回・溶解・成長）
  updateImpactFx(dt);     // 着弾の炎＋煙
  updateEntryPrompt(dt);  // 建物進入のEキー候補
  updateDayNight(dt);     // 昼夜サイクル（空・光・ネオン）
  updateCarLights();      // 車のヘッド/テールライト（夜）
  updateAgents(dt);       // 生活エージェント（データ層＝通勤）
  updateAgentBodies(dt);  // 近傍の通勤者へ ken の身体を割当
  updateAgentEd(dt);      // 生活NPCエディタ（Mキー・開いている間だけ）
  updateSignals(dt);      // 信号の三色サイクル（実時間・昼夜問わず点灯）
  updateNeonBlink(dt);    // 光点の点滅（entry-editorのblink指定）
  updateWater(dt);        // 水面: 法線スクロール＋距離LOD（マップモードのみ）
  updateTrains(dt);       // 鉄道: 列車の定期運行（railsのあるマップのみ）
  updatePort(dt);         // 埠頭: 客船の再入港
  updateDebris(dt);       // 破片（がれき/岩）
  updatePropFly(dt);      // 吹っ飛んだ信号/街灯/街路樹の飛翔
  if (mp) mpUpdate(dt);   // マルチプレイ: 状態送信＋リモート補間
  updateFirePillars(dt);  // 地面着弾の火柱
  updateWanted(dt);       // 手配度＋パトカー追跡＋サイレン
  if (speechUI) speechUI.update(dt, kenScreenPos);   // 頭上セリフバブル
  if (KENNEY_CITY) updateDamage(dt);
  if (KENNEY_CITY && bldModels.length) { _lodT -= dt; if (_lodT <= 0) { _lodT = LOD_INTERVAL; partitionBuildings(); } }   // 建物LODの定期再振り分け
  updateCamera(dt);
  camera.updateMatrixWorld();
  if (++_dbg % 30 === 0) {
    const info = `建物 ${cityInfo ? cityInfo.count : 0} (近${_lodNearCount}/遠${_lodFarCount})`;
    updateParamsUI();
    const clock = `${String(Math.floor(gameHour)).padStart(2, '0')}:${String(Math.floor((gameHour % 1) * 60)).padStart(2, '0')}`;
    const wanted = wantedLevel() > 0 ? ` / 手配${'★'.repeat(wantedLevel())}` : '';
    setStatus(`${clock}${timeScale > 1 ? `(x${timeScale})` : ''}${wanted} / 高度 ${Math.round(player.pos.y)}m / 速度上限 ${Math.round(flight.maxSpeed)} / ${info}${entryPrompt ? ' / ' + entryPrompt : ''}`);
  }
  renderer.render(scene, camera);
  renderPortrait();   // 会話中のみ: 顔枠へキャラだけを追加描画
  if (DIAG) { const r = renderer.info?.render; if (r) { _diagDraw = r.drawCalls; _diagTri = r.triangles; } }   // 描画直後に採取（render前はリセット済み）
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

setupTitle();
loadGameEvents();
init().catch((e) => showError('初期化失敗: ' + (e?.message || e)));
