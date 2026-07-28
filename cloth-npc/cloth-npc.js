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
const NPCS = ['megu', 'lily', 'ayu', 'eri', 'Joy_reborn', 'JOY_vamp', 'ken'];   // clothの有無は読み込み後に判定
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
let xrModelZ = 0;   // XR中のモデル前方位置（AR=1.6m, VR=2.2m）。ユーザーは床原点にいるので前へ置かないと重なる
renderer.xr.addEventListener('sessionstart', () => {
  const s = renderer.xr.getSession();
  const ar = s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque';
  scene.background = ar ? null : BG;   // AR=透過 / VR=背景色
  xrModelZ = ar ? -1.6 : -2.2;
  if (npcRoot) npcRoot.position.set(0, 0, xrModelZ);
  if (cart) cart.group.visible = true;
});
renderer.xr.addEventListener('sessionend', () => { scene.background = BG; xrModelZ = 0; if (npcRoot) npcRoot.position.set(0, 0, 0); if (cart) cart.group.visible = false; });

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

// NPCが演じるアニメ（どのVRMにも適用できる汎用VRMA）。'default'は各npc.jsonの埋込vrma
const PERFORMANCES = [
  { id: 'default', label: 'デフォルト' },
  { id: 'idle', label: 'アイドル', vrma: 'idle.vrma' },
  { id: 'walk', label: '歩き', vrma: 'model_walk.vrma' },
  { id: 'turn', label: 'ターン', vrma: 'VRMA_01.vrma' },
  { id: 'fly', label: '浮遊', vrma: 'Joy_Fly_down.vrma' },
  { id: 'fly_f', label: '前進飛行', vrma: 'move_Flying_front.vrma' },
  { id: 'attack1', label: '攻撃', vrma: 'attack01.vrma' },
  { id: 'totem', label: 'トーテム', vrma: 'attack02.vrma' },
  { id: 'thunder', label: '雷撃', vrma: 'attack04.vrma' },
  { id: 'wrap', label: 'ラップ', vrma: 'wrap.vrma' },
];
let perfIdx = 0, curBundle = null;

// 現在のVRMに、選択中の演技(VRMA)を適用して再生
async function applyPerformance() {
  if (!vrm) return;
  if (mixer) mixer.stopAllAction();
  mixer = null; action = null;
  const perf = PERFORMANCES[perfIdx];
  try {
    let blobUrl = null;
    if (perf.id === 'default') { if (curBundle?.vrma) blobUrl = URL.createObjectURL(dataURIToBlob(curBundle.vrma)); }
    else blobUrl = await fetchVRMABlobUrl(perf.vrma);
    if (!blobUrl) { durF = 1; return; }   // アニメ無し（静止）
    const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync(blobUrl);
    const anims = ag.userData.vrmAnimations;
    if (anims && anims.length) {
      const clip = createVRMAnimationClip(anims[0], vrm);
      mixer = new THREE.AnimationMixer(vrm.scene);
      action = mixer.clipAction(clip); action.reset(); action.play();
      tlFps = 30; durF = Math.max(1, Math.round(clip.duration * 30));
    }
  } catch (e) { console.warn('演技の読み込み失敗:', perf.id, e); }
}

// ── 素材/環境の状態（NPC間で保持） ──
const matState = { roughness: 0.45, sheen: 1, opacity: 1, env: 1.0 };
let capeVisible = true, wireOn = false;

// ── NPC読み込み（差し替え） ──
let vrm = null, mixer = null, action = null, cape = null, tlFps = 30, durF = 300, loading = false;
let hipsNode = null; const hipsRest = new THREE.Vector3();   // ルートモーション除去（その場で演技）
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
    if (renderer.xr.isPresenting) npcRoot.position.set(0, 0, xrModelZ);
    // 演技（選択中のVRMAを適用。デフォルト=埋込vrma）
    curBundle = bundle;
    await applyPerformance();
    // マント
    if (bundle.cloth) {
      vrm.update(0); vrm.scene.updateMatrixWorld(true);
      cape = createVRMClothCPU({ scene, vrm, cloth: bundle.cloth, timeline: bundle.timeline, basePos: new THREE.Vector3(0, 0, 0), floorY: -1e9 });
      // 素材状態を「そのNPCの既定値」で初期化して反映
      matState.roughness = cape.defaults.roughness; matState.sheen = cape.defaults.sheen; matState.opacity = cape.defaults.opacity;
      applyMaterial();
      cape.clothMesh.visible = capeVisible;
      $('hud-verts').textContent = cape.vertexCount.toLocaleString() + ' 頂点';
    } else {
      $('hud-verts').textContent = 'マント無し';
    }
    syncUI();
    setStatus(name + ' 表示中' + (bundle.cloth ? '（マント=CPUクロス）' : '（マント無し）'));
  } catch (e) { setStatus('読み込み失敗: ' + e.message); console.error(e); }
  loading = false;
}

function applyMaterial() {
  if (cape) cape.setMaterial({ roughness: matState.roughness, sheen: matState.sheen, opacity: matState.opacity, wireframe: wireOn });
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
  $('cb-cape').checked = capeVisible; $('cb-wire').checked = wireOn;
  if (cart) syncCart();
}
function bindUI() {
  $('npc-sel').addEventListener('change', (e) => { npcIdx = NPCS.indexOf(e.target.value); loadNPC(NPCS[npcIdx]); });
  const ps = $('perf-sel');
  if (ps) {
    ps.innerHTML = PERFORMANCES.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
    ps.addEventListener('change', (e) => { const i = PERFORMANCES.findIndex((p) => p.id === e.target.value); perfIdx = i < 0 ? 0 : i; applyPerformance(); syncCart(); });
  }
  const on = (id, key, valId) => $(id).addEventListener('input', (e) => { matState[key] = parseFloat(e.target.value); $(valId).textContent = matState[key].toFixed(2); applyMaterial(); syncCart(); });
  on('sl-rough', 'roughness', 'val-rough'); on('sl-sheen', 'sheen', 'val-sheen'); on('sl-opac', 'opacity', 'val-opac'); on('sl-env', 'env', 'val-env');
  $('cb-cape').addEventListener('change', (e) => { capeVisible = e.target.checked; if (cape) cape.clothMesh.visible = capeVisible; syncCart(); });
  $('cb-wire').addEventListener('change', (e) => { wireOn = e.target.checked; applyMaterial(); syncCart(); });
}

// ── ARカート（3D UI） ──
const PARAMS = [
  { key: 'roughness', name: '粗さ', min: 0, max: 1, step: 0.05 },
  { key: 'sheen', name: '光沢', min: 0, max: 1, step: 0.1 },
  { key: 'opacity', name: '透明度', min: 0.2, max: 1, step: 0.05 },
  { key: 'env', name: '環境光', min: 0, max: 2, step: 0.1 },
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
  cart.setLabel('paramVal', p.name, (p.key === 'env' ? matState.env : matState[p.key]).toFixed(2));
}
function cartAdjust(dir) {
  const p = curParam();
  let v = matState[p.key] + dir * p.step;
  v = Math.max(p.min, Math.min(p.max, v));
  matState[p.key] = Math.round(v * 100) / 100;
  applyMaterial(); syncUI();
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
      if (id === 'npcPrev') { npcIdx = (npcIdx + NPCS.length - 1) % NPCS.length; loadNPC(NPCS[npcIdx]); }
      else if (id === 'npcNext') { npcIdx = (npcIdx + 1) % NPCS.length; loadNPC(NPCS[npcIdx]); }
      else if (id === 'perfPrev') { perfIdx = (perfIdx + PERFORMANCES.length - 1) % PERFORMANCES.length; applyPerformance(); syncUI(); }
      else if (id === 'perfNext') { perfIdx = (perfIdx + 1) % PERFORMANCES.length; applyPerformance(); syncUI(); }
      else if (id === 'cape') { capeVisible = !capeVisible; if (cape) cape.clothMesh.visible = capeVisible; syncUI(); }
      else if (id === 'wire') { wireOn = !wireOn; applyMaterial(); syncUI(); }
      else if (id === 'reset') { if (cape) { matState.roughness = cape.defaults.roughness; matState.sheen = cape.defaults.sheen; matState.opacity = cape.defaults.opacity; } matState.env = 1.0; applyMaterial(); syncUI(); }
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
    if (vrm) { vrm.update(dt); vrm.scene.updateMatrixWorld(true); }
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
