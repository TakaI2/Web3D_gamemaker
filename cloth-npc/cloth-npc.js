// cloth-npc.js — マント付きNPC(megu)をWebGLで表示＋VRMAアニメ再生。マントは今回のCPU力ベースVerlet。
// WebGPU非依存＝WebXR(VR/AR)対応。megu.npc.json（VRM+VRMA+cloth+timeline）を読む。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRButton } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/VRButton.js';
// ARButton は使わない: 内部で参照空間を 'local'（頭の高さ基準）に固定し床に立たない。
// 自作ボタンで requestSession → setReferenceSpaceType('local-floor') → setSession（床=y=0）で起動する。
import { VRMLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMClothCPU } from '../lib/vrm-cloth-cpu.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const e = $('status'); if (e) e.textContent = m; };

// ── レンダラ / シーン / XR ──
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');   // y=0=実際の床（Guardianの床レベル）
renderer.setClearColor(0x000000, 0);
$('app').appendChild(renderer.domElement);
const vrBtn = VRButton.createButton(renderer);
vrBtn.style.left = 'calc(50% - 130px)'; vrBtn.style.width = '110px';
document.body.appendChild(vrBtn);

// AR自作ボタン: local-floor 参照空間で immersive-ar を起動（床基準）。
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
    renderer.xr.setReferenceSpaceType('local-floor');   // ARButtonと違い local-floor を維持
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
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
camera.position.set(1.2, 1.15, 1.9);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dl = new THREE.DirectionalLight(0xffffff, 1.5); dl.position.set(1.5, 2.5, 1.5); scene.add(dl);
new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
  .then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = t; }).catch(() => {});

// ── XR用 頭部追従FPSパネル ──
const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
const ctx = cv.getContext('2d');
const panelTex = new THREE.CanvasTexture(cv);
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthTest: false }));
panel.position.set(0, 0.26, -1.0); panel.renderOrder = 999; panel.visible = false;
camera.add(panel);
function drawPanel(lines) {
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = 'rgba(12,16,28,0.82)'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => { ctx.font = i === 0 ? 'bold 28px system-ui' : '32px monospace'; ctx.fillStyle = i === 0 ? '#9fd0ff' : (ln.includes('FPS') ? '#8fe98f' : '#e6ecf5'); ctx.fillText(ln, 16, 10 + i * 40); });
  panelTex.needsUpdate = true;
}

// ── AR: 背景を消してモデルを目の前へ ──
let npcRoot = null;   // VRM+マントをまとめて動かす基準（VRMのscene）
renderer.xr.addEventListener('sessionstart', () => {
  const s = renderer.xr.getSession();
  const ar = s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque';
  scene.background = ar ? null : BG;
  if (npcRoot) npcRoot.position.set(0, 0, ar ? -1.6 : 0);   // AR=1.6m前の床に立たせる
});
renderer.xr.addEventListener('sessionend', () => { scene.background = BG; if (npcRoot) npcRoot.position.set(0, 0, 0); });

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

function dataURIToBlob(uri) {
  const [head, data] = uri.split(','); const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream' });
}

// ── megu 読み込み ──
let vrm = null, mixer = null, action = null, cape = null, tlFps = 30, durF = 354;
async function loadMegu() {
  setStatus('megu 読み込み中…（VRMが大きいので少し待ちます）');
  // dist=同フォルダ / dev=public/npc の両対応。開発サーバは未存在ファイルにHTMLを返すので
  // JSONとしてパースできたものを採用する
  let bundle = null;
  for (const url of ['./megu.npc.json', '../npc/megu.npc.json']) {
    try { const txt = await (await fetch(url)).text(); bundle = JSON.parse(txt); break; } catch { /* 次を試す */ }
  }
  if (!bundle) throw new Error('megu.npc.json が読めません（配置を確認）');
  // VRM（WebGLのMToon）
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  // rotateVRM0 は使わない: 回すとボーンだけ回りマント初期位置とねじれて崩れる（マントはVRM素の向きで作成済み）
  vrm.scene.updateMatrixWorld(true);
  scene.add(vrm.scene);
  npcRoot = vrm.scene;
  // VRMA アニメ
  if (bundle.vrma) {
    const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p));
    const ag = await al.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrma)));
    const anims = ag.userData.vrmAnimations;
    if (anims?.length) {
      const clip = createVRMAnimationClip(anims[0], vrm);
      mixer = new THREE.AnimationMixer(vrm.scene);
      action = mixer.clipAction(clip); action.play();
    }
  }
  // マント（今回のCPU力ベースVerlet）
  if (bundle.cloth) {
    vrm.update(0); vrm.scene.updateMatrixWorld(true);
    cape = createVRMClothCPU({ scene, vrm, cloth: bundle.cloth, timeline: bundle.timeline, basePos: new THREE.Vector3(0, 0, 0), floorY: -1e9 });
    $('hud-verts').textContent = cape.vertexCount.toLocaleString() + ' 頂点';
  }
  tlFps = bundle.timeline?.fps || 30;
  durF = bundle.timeline?.durationFrames || 354;
  setStatus('megu 表示中（マント=CPU力ベースVerlet）');
}
loadMegu().catch((e) => { setStatus('読み込み失敗: ' + e.message); console.error(e); });

// ── ループ ──
let frames = 0, last = performance.now(), curFps = 0;
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (mixer) mixer.update(dt);
  if (vrm) { vrm.update(dt); vrm.scene.updateMatrixWorld(true); }
  if (cape) {
    const frame = action ? (action.time * tlFps) % durF : 0;
    cape.update(dt, frame);
  }
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
  // FPS
  frames++;
  const now = performance.now();
  if (now - last >= 500) {
    curFps = Math.round(frames / ((now - last) / 1000)); frames = 0; last = now;
    $('hud-fps').textContent = curFps + ' FPS';
    drawPanel(['megu（マント=CPUクロス）', curFps + ' FPS', (cape?.vertexCount || 0).toLocaleString() + ' 頂点']);
  }
  if (panel) panel.visible = !!renderer.xr.isPresenting;
});
