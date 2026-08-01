// cloth-npc.js — マント付きNPCのAR表示エディタ。表示するNPCを選び、マント素材をライブ調整できる。
// WebGL(MToon)でVRM表示＋VRMA再生、マントはCPU力ベースVerlet（WebGPU非依存＝WebXR対応）。
// 操作: デスクトップ=右上パネル / AR=目の前のカート（Questコントローラのレイ＋指先）。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRButton } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/VRButton.js';
import { OculusHandModel } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/OculusHandModel.js';
import { VRMLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMClothCPU } from '../lib/vrm-cloth-cpu.js';
import { createARCart } from '../lib/ar-cart.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const e = $('status'); if (e) e.textContent = m; };
const NPCS = ['JOY_vamp'];   // このエディタは JOY_vamp 専用
let npcIdx = 0;

// ── レンダラ / シーン / XR ──
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setClearColor(0x000000, 0);
$('app').appendChild(renderer.domElement);
const vrBtn = VRButton.createButton(renderer);
vrBtn.style.left = 'calc(50% - 130px)'; vrBtn.style.width = '110px';
document.body.appendChild(vrBtn);

// AR自作ボタン: local-floor 参照空間で immersive-ar を起動（床基準）。
// three.js の ARButton は参照空間を 'local'（頭の高さ基準）に固定するため使わない。
function setupARButton() {
  const btn = document.createElement('button');
  btn.textContent = 'ENTER AR';
  Object.assign(btn.style, {
    position: 'absolute', bottom: '20px', left: 'calc(50% + 20px)', width: '110px',
    padding: '12px 6px', border: '1px solid #fff', borderRadius: '4px',
    background: 'rgba(0,0,0,0.1)', color: '#fff', font: '13px sans-serif',
    cursor: 'pointer', zIndex: '10', textAlign: 'center', opacity: '0.5',
  });
  document.body.appendChild(btn);
  const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'plane-detection'] };
  let session = null;
  const onEnd = () => { session?.removeEventListener('end', onEnd); btn.textContent = 'ENTER AR'; session = null; };
  async function onStart(s) {
    s.addEventListener('end', onEnd);
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(s);
    btn.textContent = 'EXIT AR';
    session = s;
  }
  btn.onclick = () => {
    if (session) { session.end(); return; }
    navigator.xr.requestSession('immersive-ar', sessionInit).then(onStart).catch((e) => { btn.textContent = 'AR開始失敗'; console.error(e); });
  };
  if (navigator.xr) {
    navigator.xr.isSessionSupported('immersive-ar').then((sup) => {
      if (sup) { btn.style.opacity = '1'; } else { btn.textContent = 'AR NOT SUPPORTED'; btn.disabled = true; }
    });
  } else { btn.textContent = 'AR NOT SUPPORTED'; btn.disabled = true; }
}
setupARButton();

const scene = new THREE.Scene();
const BG = new THREE.Color(0x1a1a2e);
scene.background = BG;
scene.environmentIntensity = 1.0;
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1.2, 1.15, 1.9);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.update();

// 照明はHDRのIBL主体（手本の webgpu_compute_cloth と同じ発想）。フラットなAmbientは
// マントを「のっぺり」させるので使わず、空/地のHemisphere＋弱いキー/フィルだけ添える。
scene.add(new THREE.HemisphereLight(0xbcc7e0, 0x30302a, 0.5));
const dl = new THREE.DirectionalLight(0xffffff, 1.1); dl.position.set(1.5, 2.5, 1.5); scene.add(dl);
const fillLight = new THREE.DirectionalLight(0xa8b6d6, 0.45); fillLight.position.set(-1.5, 1.2, -1.5); scene.add(fillLight);   // 反対側フィル＝片側のっぺり防止
new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
  .then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = t; }).catch(() => {});

// ── XR用 頭部追従FPSパネル ──
const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
const ctx2d = cv.getContext('2d');
const panelTex = new THREE.CanvasTexture(cv);
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthTest: false }));
panel.position.set(0, 0.26, -1.0); panel.renderOrder = 999; panel.visible = false;
camera.add(panel);
function drawPanel(lines) {
  ctx2d.clearRect(0, 0, cv.width, cv.height); ctx2d.fillStyle = 'rgba(12,16,28,0.82)'; ctx2d.fillRect(0, 0, cv.width, cv.height);
  ctx2d.textBaseline = 'top';
  lines.forEach((ln, i) => { ctx2d.font = i === 0 ? 'bold 28px system-ui' : '30px monospace'; ctx2d.fillStyle = i === 0 ? '#9fd0ff' : '#e6ecf5'; ctx2d.fillText(ln, 16, 8 + i * 38); });
  panelTex.needsUpdate = true;
}

// ── コントローラ（レイ＝ボタン押下 / グリップ＝カート掴み）＋ 手（指先＝押下 / ピンチ＝掴み） ──
const _v = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
let grabSrc = null;   // 'c0'/'c1'/'h0'/'h1' いずれかがカートを掴み中
const controllersXR = [renderer.xr.getController(0), renderer.xr.getController(1)];
controllersXR.forEach((c, i) => {
  scene.add(c);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -2)]), new THREE.LineBasicMaterial({ color: 0x66ccff }));
  line.name = 'laser'; c.add(line);
  c.addEventListener('selectstart', () => { if (cart) cart.pressFromController(c); });   // トリガー＝ボタン
  c.addEventListener('squeezestart', () => { if (cart && !grabSrc) { c.getWorldPosition(_v); if (cart.beginGrab(_v)) grabSrc = 'c' + i; } });   // グリップ＝掴み
  c.addEventListener('squeezeend', () => { if (grabSrc === 'c' + i) { cart.endGrab(); grabSrc = null; } });
});
const handsXR = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
for (const h of handsXR) { try { h.add(new OculusHandModel(h)); } catch (e) { console.warn('hand model 失敗', e); } scene.add(h); }
function tipWorld(h, name, out) { const j = h.joints && h.joints[name]; return (j && j.visible) ? j.getWorldPosition(out) : null; }
function getTips() { return handsXR.map((h) => { const p = tipWorld(h, 'index-finger-tip', new THREE.Vector3()); return p; }); }
// ピンチ（親指先↔人差し指先<3cm）でカートを掴む
function updateHandGrab() {
  handsXR.forEach((h, i) => {
    const id = 'h' + i;
    const th = tipWorld(h, 'thumb-tip', _v1), ix = tipWorld(h, 'index-finger-tip', _v2);
    const pinching = th && ix && _v1.distanceTo(_v2) < 0.03;
    if (pinching) {
      _v.copy(_v1).add(_v2).multiplyScalar(0.5);
      if (!grabSrc) { if (cart && cart.beginGrab(_v)) grabSrc = id; }
      else if (grabSrc === id) cart.updateGrab(_v);
    } else if (grabSrc === id) { cart.endGrab(); grabSrc = null; }
  });
}

// ── AR: 背景オフ＋モデルを目の前へ、カート表示 ──
let npcRoot = null, cart = null;
let baseYaw = 0; const modelPose = { yaw: 0, x: 0, z: 0 };   // ユーザー配置調整（向き°/左右/前後）
let xrModelZ = 0;   // XR中のモデル前方位置（AR=1.6m, VR=2.2m）。ユーザーは床原点にいるので前へ置かないと重なる
renderer.xr.addEventListener('sessionstart', () => {
  const s = renderer.xr.getSession();
  const ar = s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque';
  scene.background = ar ? null : BG;   // AR=透過 / VR=背景色
  xrModelZ = ar ? -1.6 : -2.2;
  applyModelPose();
  if (cart) cart.group.visible = true;
});
renderer.xr.addEventListener('sessionend', () => { scene.background = BG; xrModelZ = 0; applyModelPose(); if (cart) cart.group.visible = false; });

function applyModelPose() {
  if (!npcRoot) return;
  const baseZ = renderer.xr.isPresenting ? xrModelZ : 0;
  npcRoot.position.set(modelPose.x, 0, baseZ + modelPose.z);
  npcRoot.rotation.y = baseYaw + modelPose.yaw * Math.PI / 180;
}

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

function dataURIToBlob(uri) {
  const [head, data] = uri.split(','); const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream' });
}
async function fetchBundle(name) {
  for (const url of [`./${name}.npc.json`, `../npc/${name}.npc.json`]) {
    try { const txt = await (await fetch(url)).text(); return JSON.parse(txt); } catch { /* 次 */ }
  }
  throw new Error(name + '.npc.json が読めません');
}
// VRMA(.glb)をdist(./vrma)またはdev(../vrma)から取得。SPAフォールバックHTMLを避けるため glTF マジックで検証
async function fetchVRMABlobUrl(name) {
  for (const url of [`./vrma/${name}`, `../vrma/${name}`]) {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const m = new Uint8Array(buf, 0, 4);
      if (m[0] === 0x67 && m[1] === 0x6C && m[2] === 0x54 && m[3] === 0x46) return URL.createObjectURL(new Blob([buf]));   // 'glTF'
    } catch { /* 次 */ }
  }
  return null;
}
// timeline.json を dist(./timeline) または dev(../timeline) から取得（JSONとしてパースできたものを採用）
async function fetchTimeline(name) {
  for (const url of [`./timeline/${name}`, `../timeline/${name}`]) {
    try { return JSON.parse(await (await fetch(url)).text()); } catch { /* 次 */ }
  }
  return null;
}

// JOY_vamp用の演技（eri_タイムライン。VRMA＋マント掴み(グリップ)を含む）
const PERFORMANCES = [
  { id: 'idle', label: 'アイドル', tl: 'eri_Fly_idle.timeline.json' },
  { id: 'walk', label: '歩き', tl: 'eri_model_walk.timeline.json' },
  { id: 'turn', label: 'ターン', tl: 'eri_turn.timeline.json' },
  { id: 'flyL', label: '左移動', tl: 'eri_Fly_L.timeline.json' },
  { id: 'flyR', label: '右移動', tl: 'eri_Fly_R.timeline.json' },
  { id: 'lightning', label: '雷撃', tl: 'eri_reborn_lightning.timeline.json' },
  { id: 'wrap', label: 'ラップ(マント掴み)', tl: 'eri_wrap.timeline.json' },
];
let perfIdx = 0, curBundle = null;

// 選択中の演技（eri_タイムライン）を適用：VRMA再生＋マントのグリップ範囲を設定
async function applyPerformance() {
  if (!vrm) return;
  if (mixer) mixer.stopAllAction();
  mixer = null; action = null;
  const perf = PERFORMANCES[perfIdx];
  try {
    const tl = await fetchTimeline(perf.tl);
    if (!tl) { durF = 1; if (cape) cape.setTimeline(null); return; }
    const blobUrl = tl.vrma ? await fetchVRMABlobUrl(tl.vrma) : null;
    if (blobUrl) {
      const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p));
      const ag = await al.loadAsync(blobUrl);
      const anims = ag.userData.vrmAnimations;
      if (anims && anims.length) {
        const clip = createVRMAnimationClip(anims[0], vrm);
        mixer = new THREE.AnimationMixer(vrm.scene);
        action = mixer.clipAction(clip); action.reset(); action.play();
      }
    }
    tlFps = tl.fps || 30; durF = tl.durationFrames || 300;
    if (cape) cape.setTimeline(tl);   // マント掴み（グリップ範囲）を更新
  } catch (e) { console.warn('演技の読み込み失敗:', perf.id, e); }
}

// ── 素材/環境の状態（NPC間で保持） ──
const matState = { roughness: 0.45, sheen: 1, opacity: 1, env: 1.0, thickness: 0.006 };
let capeVisible = true, wireOn = false, unifyColor = false;

// ── マント設定の保存／読込（public/vamp_param/cape-<NPC>.json）──
// ゲーム(ar-vampire / vamp-dungeon)は起動時にこれを読み、マント生成時のマテリアルへマージする。
function capeParamFile(name) { return 'cape-' + name + '.json'; }
function currentCapeParams() {
  return { npc: NPCS[npcIdx], material: {
    roughness: matState.roughness, sheen: matState.sheen, opacity: matState.opacity,
    thickness: matState.thickness, unify: unifyColor,
  }, env: matState.env };
}
async function saveCapeParams(manual) {
  const data = currentCapeParams();
  const body = JSON.stringify({ dir: 'vamp_param', filename: capeParamFile(data.npc), content: JSON.stringify(data, null, 2) });
  let ok = false;
  try { ok = (await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).ok; } catch { /* devサーバ無 */ }
  const b = $('btn-save-cape');
  if (manual && b) {
    if (ok) b.textContent = '✓ vamp_param に保存しました';
    else {   // devサーバが無ければダウンロード
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = capeParamFile(data.npc); a.click();
      b.textContent = '↓ DL（devサーバ無）';
    }
    setTimeout(() => { b.textContent = '💾 マント設定を保存（ゲームへ反映）'; }, 1600);
  }
  return ok;
}
async function loadCapeParams(name) {
  for (const u of ['../vamp_param/' + capeParamFile(name), './' + capeParamFile(name)]) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j && j.material) return j; } catch { /* next */ }
  }
  return null;
}

// ── NPC読み込み（差し替え） ──
let vrm = null, mixer = null, action = null, cape = null, tlFps = 30, durF = 300, loading = false;
let hipsNode = null; const hipsRest = new THREE.Vector3();   // ルートモーション除去（その場で演技）

// ── プレイヤーを見る（視線=vrm.lookAt / 首・頭=ボーンをyawで自然に） ──
const lookTarget = new THREE.Object3D(); scene.add(lookTarget);   // 視線(目)のターゲット＝プレイヤー頭
let neckNode = null, headNode = null, armL = null, armR = null;
const lookS = { w: 0 };
const bodyLocalFwd = new THREE.Vector3(0, 0, 1);   // モデル前方(npcRoot相対)。安静姿勢で確定
const _lp = new THREE.Vector3(), _al = new THREE.Vector3(), _ar = new THREE.Vector3();
const _rgt = new THREE.Vector3(), _upv = new THREE.Vector3(0, 1, 0), _fwd = new THREE.Vector3();
const _hpv = new THREE.Vector3(), _dh = new THREE.Vector3(), _hDir = new THREE.Vector3(), _hFwd = new THREE.Vector3();
const _bw = new THREE.Quaternion(), _pw = new THREE.Quaternion();
const _hqCur = new THREE.Quaternion(), _hqDes = new THREE.Quaternion(), _hqPar = new THREE.Quaternion(), _hqDelta = new THREE.Quaternion();
const HEAD_FWD = new THREE.Vector3(0, 0, 1);   // VRM頭の顔正面（VRMLookAt.faceFront 既定=+Z）
const LK = { HEAD_MAX: Math.PI * 0.55, IN: 1.0, OUT: 1.75, SPEED: 6 };   // 頭最大~99°, 正面錐~57°で満/~100°で切れる

// 首・頭をプレイヤーへ（swing-catch の applyHeadLook 方式：頭前方を setFromUnitVectors で目標へ、角度制限つき）
function updateHeadLook(dt) {
  if (!headNode || !npcRoot) return;
  camera.getWorldPosition(_lp);   // プレイヤー頭（XR=ヘッドセット / PC=カメラ）
  headNode.getWorldPosition(_hpv);
  // 正面錐の重み：モデル前方(npcRoot基準・アニメで揺れない)とプレイヤー水平方向の角
  npcRoot.getWorldQuaternion(_bw);
  _fwd.copy(bodyLocalFwd).applyQuaternion(_bw); _fwd.y = 0;
  _dh.copy(_lp).sub(_hpv); _dh.y = 0;
  let wt = 0;
  if (_fwd.lengthSq() > 1e-6 && _dh.lengthSq() > 1e-6) {
    const fa = _fwd.normalize().angleTo(_dh.normalize());
    wt = fa < LK.IN ? 1 : fa > LK.OUT ? 0 : (LK.OUT - fa) / (LK.OUT - LK.IN);
  }
  lookS.w += (wt - lookS.w) * (1 - Math.exp(-dt * LK.SPEED));   // 滑らかに（急に向かない）
  if (lookS.w < 0.01) return;
  // 頭の前方を目標方向へ回す
  _hDir.copy(_lp).sub(_hpv);
  if (_hDir.lengthSq() < 1e-8) return;
  _hDir.normalize();
  headNode.getWorldQuaternion(_hqCur);
  _hFwd.copy(HEAD_FWD).applyQuaternion(_hqCur).normalize();
  const ang = _hFwd.angleTo(_hDir);
  if (ang < 1e-4) return;
  let w = lookS.w;
  if (ang > LK.HEAD_MAX) w *= LK.HEAD_MAX / ang;   // 後ろへ向きすぎない
  _hqDelta.setFromUnitVectors(_hFwd, _hDir);
  _hqDes.identity().slerp(_hqDelta, w).multiply(_hqCur);   // delta を w 分 → 望ましいワールド回転
  headNode.parent.getWorldQuaternion(_hqPar);
  headNode.quaternion.copy(_hqPar.invert().multiply(_hqDes)).normalize();
}
async function loadNPC(name) {
  if (loading) return; loading = true;
  setStatus(name + ' 読み込み中…');
  // 破棄
  if (cape) { cape.dispose(); cape = null; }
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); vrm = null; }
  mixer = null; action = null; npcRoot = null;
  try {
    const bundle = await fetchBundle(name);
    const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
    vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    vrm.scene.updateMatrixWorld(true);
    scene.add(vrm.scene);
    npcRoot = vrm.scene;
    hipsNode = vrm.humanoid?.getNormalizedBoneNode('hips') ?? null;   // 腰の安静位置を記録（後でXZロック）
    if (hipsNode) hipsRest.copy(hipsNode.position);
    // 視線＋首の追従用ボーン
    const hb = vrm.humanoid;
    neckNode = hb?.getNormalizedBoneNode('neck') ?? null;
    headNode = hb?.getNormalizedBoneNode('head') ?? null;
    armL = hb?.getNormalizedBoneNode('leftUpperArm') ?? null;
    armR = hb?.getNormalizedBoneNode('rightUpperArm') ?? null;
    lookS.w = 0;
    if (vrm.lookAt) vrm.lookAt.target = lookTarget;   // 目でプレイヤーを追う
    // 安静姿勢で顔の前方を確定→モデルを+Z（正面/ユーザー方向）へ向ける（頭ボーンの顔正面=HEAD_FWDを基準に）
    vrm.update(0); vrm.scene.updateMatrixWorld(true);
    if (headNode) {
      headNode.getWorldQuaternion(_hqCur);
      _fwd.copy(HEAD_FWD).applyQuaternion(_hqCur); _fwd.y = 0;
      if (_fwd.lengthSq() > 1e-6) {
        _fwd.normalize();
        npcRoot.getWorldQuaternion(_pw);
        bodyLocalFwd.copy(_fwd).applyQuaternion(_pw.invert());   // 顔前方（npcRoot相対・不変）
        npcRoot.rotation.y -= Math.atan2(_fwd.x, _fwd.z);       // 顔を+Z（ユーザー）へ
      }
    }
    baseYaw = npcRoot.rotation.y;   // 自動整列(+Z)後を基準に
    modelPose.yaw = 0; modelPose.x = 0; modelPose.z = 0;
    applyModelPose();
    // マントを先に作る（安静姿勢でアンカー確定）。timelineは後の applyPerformance で setTimeline
    curBundle = bundle;
    if (bundle.cloth) {
      vrm.update(0); vrm.scene.updateMatrixWorld(true);
      cape = createVRMClothCPU({ scene, vrm, cloth: bundle.cloth, timeline: null, basePos: new THREE.Vector3(0, 0, 0), floorY: 0 });
      matState.roughness = cape.defaults.roughness; matState.sheen = cape.defaults.sheen; matState.opacity = cape.defaults.opacity; matState.thickness = cape.defaults.thickness;
      // 保存済みのマント設定があれば復元（ゲームと同じ見た目で調整を再開できる）
      const saved = await loadCapeParams(name);
      if (saved) {
        const m = saved.material || {};
        if (m.roughness != null) matState.roughness = m.roughness;
        if (m.sheen != null) matState.sheen = m.sheen;
        if (m.opacity != null) matState.opacity = m.opacity;
        if (m.thickness != null) matState.thickness = m.thickness;
        if (m.unify != null) unifyColor = !!m.unify;
        if (saved.env != null) matState.env = saved.env;
      }
      applyMaterial();
      cape.clothMesh.visible = capeVisible;
      $('hud-verts').textContent = cape.vertexCount.toLocaleString() + ' 頂点';
    } else {
      $('hud-verts').textContent = 'マント無し';
    }
    // 演技（eri_タイムライン＝VRMA再生＋マント掴み）を適用
    await applyPerformance();
    syncUI();
    setStatus(name + ' 表示中' + (bundle.cloth ? '（マント=CPUクロス）' : '（マント無し）'));
  } catch (e) { setStatus('読み込み失敗: ' + e.message); console.error(e); }
  loading = false;
}

function applyMaterial() {
  if (cape) cape.setMaterial({ roughness: matState.roughness, sheen: matState.sheen, opacity: matState.opacity, thickness: matState.thickness, wireframe: wireOn, unify: unifyColor });
  scene.environmentIntensity = matState.env;
}

// ── 2D HUD（デスクトップ） ──
function syncUI() {
  $('npc-sel').value = NPCS[npcIdx];
  const ps = $('perf-sel'); if (ps) ps.value = PERFORMANCES[perfIdx].id;
  const set = (id, v) => { const e = $(id); if (e) e.value = v; };
  set('sl-rough', matState.roughness); set('sl-sheen', matState.sheen); set('sl-opac', matState.opacity); set('sl-env', matState.env);
  $('val-rough').textContent = matState.roughness.toFixed(2); $('val-sheen').textContent = matState.sheen.toFixed(2);
  $('val-opac').textContent = matState.opacity.toFixed(2); $('val-env').textContent = matState.env.toFixed(2);
  set('sl-thick', matState.thickness); if ($('val-thick')) $('val-thick').textContent = matState.thickness.toFixed(3);
  $('cb-cape').checked = capeVisible; $('cb-wire').checked = wireOn; if ($('cb-unify')) $('cb-unify').checked = unifyColor;
  set('sl-yaw', modelPose.yaw); set('sl-x', modelPose.x); set('sl-z', modelPose.z);
  if ($('val-yaw')) $('val-yaw').textContent = modelPose.yaw.toFixed(0);
  if ($('val-x')) $('val-x').textContent = modelPose.x.toFixed(2);
  if ($('val-z')) $('val-z').textContent = modelPose.z.toFixed(2);
  if (cart) syncCart();
}
function bindUI() {
  $('npc-sel').addEventListener('change', (e) => { npcIdx = NPCS.indexOf(e.target.value); loadNPC(NPCS[npcIdx]); });
  // マント設定の保存／読込（ゲーム側と共有）
  $('btn-save-cape')?.addEventListener('click', () => saveCapeParams(true));
  const ps = $('perf-sel');
  if (ps) {
    ps.innerHTML = PERFORMANCES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
    ps.addEventListener('change', (e) => { const i = PERFORMANCES.findIndex((p) => p.id === e.target.value); perfIdx = i < 0 ? 0 : i; applyPerformance(); syncCart(); });
  }
  const on = (id, key, valId) => $(id).addEventListener('input', (e) => { matState[key] = parseFloat(e.target.value); $(valId).textContent = matState[key].toFixed(2); applyMaterial(); syncCart(); });
  on('sl-rough', 'roughness', 'val-rough'); on('sl-sheen', 'sheen', 'val-sheen'); on('sl-opac', 'opacity', 'val-opac'); on('sl-env', 'env', 'val-env');
  $('sl-thick')?.addEventListener('input', (e) => { matState.thickness = parseFloat(e.target.value); $('val-thick').textContent = matState.thickness.toFixed(3); applyMaterial(); syncCart(); });
  $('cb-cape').addEventListener('change', (e) => { capeVisible = e.target.checked; if (cape) cape.clothMesh.visible = capeVisible; syncCart(); });
  $('cb-wire').addEventListener('change', (e) => { wireOn = e.target.checked; applyMaterial(); syncCart(); });
  $('cb-unify')?.addEventListener('change', (e) => { unifyColor = e.target.checked; applyMaterial(); });
  const onPose = (id, key, valId, fmt) => $(id).addEventListener('input', (e) => { modelPose[key] = parseFloat(e.target.value); $(valId).textContent = fmt(modelPose[key]); applyModelPose(); syncCart(); });
  onPose('sl-yaw', 'yaw', 'val-yaw', (v) => v.toFixed(0)); onPose('sl-x', 'x', 'val-x', (v) => v.toFixed(2)); onPose('sl-z', 'z', 'val-z', (v) => v.toFixed(2));
}

// ── ARカート（3D UI） ──
const PARAMS = [
  { key: 'roughness', name: '粗さ', min: 0, max: 1, step: 0.05, kind: 'mat' },
  { key: 'sheen', name: '光沢', min: 0, max: 1, step: 0.1, kind: 'mat' },
  { key: 'opacity', name: '透明度', min: 0.2, max: 1, step: 0.05, kind: 'mat' },
  { key: 'env', name: '環境光', min: 0, max: 2, step: 0.1, kind: 'mat' },
  { key: 'thickness', name: '厚み', min: 0, max: 0.03, step: 0.002, kind: 'mat' },
  { key: 'yaw', name: '向き', min: -180, max: 180, step: 10, kind: 'pose' },
  { key: 'x', name: '左右', min: -2, max: 2, step: 0.1, kind: 'pose' },
  { key: 'z', name: '前後', min: -2, max: 2, step: 0.1, kind: 'pose' },
];
let paramIdx = 0;
function curParam() { return PARAMS[paramIdx]; }
function syncCart() {
  if (!cart) return;
  cart.setLabel('npcName', NPCS[npcIdx]);
  cart.setLabel('perfName', PERFORMANCES[perfIdx].label);
  cart.setLabel('cape', 'マント', capeVisible ? 'ON' : 'OFF');
  cart.setLabel('wire', 'ワイヤ', wireOn ? 'ON' : 'OFF');
  const p = curParam();
  cart.setLabel('paramSel', '項目', p.name);
  const pv = (p.kind === 'pose' ? modelPose[p.key] : matState[p.key]);
  cart.setLabel('paramVal', p.name, p.key === 'yaw' ? pv.toFixed(0) + '°' : p.key === 'thickness' ? pv.toFixed(3) : pv.toFixed(2));
}
function cartAdjust(dir) {
  const p = curParam();
  const store = p.kind === 'pose' ? modelPose : matState;
  let v = store[p.key] + dir * p.step;
  v = Math.max(p.min, Math.min(p.max, v));
  store[p.key] = Math.round(v * 100) / 100;
  if (p.kind === 'pose') applyModelPose(); else applyMaterial();
  syncUI();
}
function buildCart() {
  const C = [-0.18, 0.0, 0.18], R = [0.17, 0.085, 0.0, -0.085, -0.17], D = 0.075;
  cart = createARCart(scene, {
    position: [0, 0, -0.75],
    buttons: [
      { id: 'npcPrev', label: '◀ NPC', x: C[0], z: R[0], d: D },
      { id: 'npcName', label: 'megu', x: C[1], z: R[0], d: D, type: 'display' },
      { id: 'npcNext', label: 'NPC ▶', x: C[2], z: R[0], d: D },
      { id: 'perfPrev', label: '◀ 演技', x: C[0], z: R[1], d: D },
      { id: 'perfName', label: 'デフォルト', x: C[1], z: R[1], d: D, type: 'display' },
      { id: 'perfNext', label: '演技 ▶', x: C[2], z: R[1], d: D },
      { id: 'cape', label: 'マント', sub: 'ON', x: C[0], z: R[2], d: D },
      { id: 'wire', label: 'ワイヤ', sub: 'OFF', x: C[1], z: R[2], d: D },
      { id: 'reset', label: 'リセット', x: C[2], z: R[2], d: D },
      { id: 'paramSel', label: '項目', sub: '粗さ', x: C[0], z: R[3], d: D },
      { id: 'dec', label: '◀ 減', x: C[1], z: R[3], d: D },
      { id: 'inc', label: '増 ▶', x: C[2], z: R[3], d: D },
      { id: 'paramVal', label: '粗さ', sub: '0.45', x: C[1], z: R[4], w: 0.5, d: D, type: 'display' },
    ],
    onPress: (id) => {
      if (id === 'npcPrev') { if (NPCS.length > 1) { npcIdx = (npcIdx + NPCS.length - 1) % NPCS.length; loadNPC(NPCS[npcIdx]); } }
      else if (id === 'npcNext') { if (NPCS.length > 1) { npcIdx = (npcIdx + 1) % NPCS.length; loadNPC(NPCS[npcIdx]); } }
      else if (id === 'perfPrev') { perfIdx = (perfIdx + PERFORMANCES.length - 1) % PERFORMANCES.length; applyPerformance(); syncUI(); }
      else if (id === 'perfNext') { perfIdx = (perfIdx + 1) % PERFORMANCES.length; applyPerformance(); syncUI(); }
      else if (id === 'cape') { capeVisible = !capeVisible; if (cape) cape.clothMesh.visible = capeVisible; syncUI(); }
      else if (id === 'wire') { wireOn = !wireOn; applyMaterial(); syncUI(); }
      else if (id === 'reset') { if (cape) { matState.roughness = cape.defaults.roughness; matState.sheen = cape.defaults.sheen; matState.opacity = cape.defaults.opacity; matState.thickness = cape.defaults.thickness; } matState.env = 1.0; applyMaterial(); syncUI(); }
      else if (id === 'paramSel') { paramIdx = (paramIdx + 1) % PARAMS.length; syncCart(); }
      else if (id === 'dec') cartAdjust(-1);
      else if (id === 'inc') cartAdjust(1);
    },
  });
  cart.group.visible = renderer.xr.isPresenting;
  syncCart();
}

// ── 起動 ──
bindUI();
buildCart();
loadNPC(NPCS[0]);
window.__ed = { get cart() { return cart; }, get cape() { return cape; }, scene, camera, controls };   // デバッグ/確認用

let frames = 0, last = performance.now(), curFps = 0, loopErr = '';
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  // 更新はtry/catchで囲む：XRで1つ例外が出ても描画は続け、内容をFPSパネルに出す（真っ暗回避）
  try {
    if (mixer) mixer.update(dt);
    if (hipsNode) { hipsNode.position.x = hipsRest.x; hipsNode.position.z = hipsRest.z; }   // 移動系アニメを その場 に固定
    if (vrm) {
      camera.getWorldPosition(lookTarget.position);   // 視線ターゲット＝プレイヤー頭
      vrm.scene.updateMatrixWorld(true);              // アニメ姿勢の世界行列（首追従の計算用）
      updateHeadLook(dt);                             // 首・頭をyawでプレイヤーへ（正規化ボーン→vrm.updateでrawへ転写）
      vrm.update(dt);                                 // 転写＋spring＋視線(目)
      vrm.scene.updateMatrixWorld(true);
    }
    if (cape && capeVisible) { const frame = action ? (action.time * tlFps) % durF : 0; cape.update(dt, frame); }
    if (cart) {
      cart.update(dt);
      if (renderer.xr.isPresenting) {
        updateHandGrab();
        if (grabSrc && grabSrc[0] === 'c') { controllersXR[+grabSrc[1]].getWorldPosition(_v); cart.updateGrab(_v); }
        if (!grabSrc) cart.pressFromTips(getTips());   // 掴み中は指先押下を抑止
      }
    }
  } catch (e) { loopErr = (e && e.message) ? e.message : String(e); }
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last >= 500) {
    curFps = Math.round(frames / ((now - last) / 1000)); frames = 0; last = now;
    $('hud-fps').textContent = curFps + ' FPS';
    if (cape) $('hud-verts').textContent = `${cape.vertexCount.toLocaleString()} 頂点 (${cape.lastUpdateMs.toFixed(1)}ms)`;
    drawPanel([NPCS[npcIdx] + '（マント編集）', curFps + ' FPS', loopErr ? ('⚠ ' + loopErr.slice(0, 40)) : (cape ? `${cape.vertexCount} 頂点 ${cape.lastUpdateMs.toFixed(1)}ms` : 'マント無')]);
  }
  if (panel) panel.visible = !!renderer.xr.isPresenting;
});
