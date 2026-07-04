// fx-preview.js — lib/fx-particles.js を WebGPU で動作確認するための最小プレビュー。
// 目的: TSL/SpriteNodeMaterial 実装が WebGPU で実際に描画されるか・実フレームレートを確認する。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from '../lib/fx-particles.js';

let renderer, scene, camera, controls;
const systems = [];   // { fx } 常駐システム
const bursts = [];     // 単発バースト用システム（使い回しプール）

function showError(msg) {
  const el = document.getElementById('error-msg');
  document.getElementById('error-detail').textContent = String(msg);
  el.classList.add('visible');
}

// 常駐システムを1つだけにして種類を切替
let resident = null;
function setResident(presetKey) {
  if (resident) { scene.remove(resident.object3D); resident.dispose(); resident = null; }
  resident = createFxSystem(cloneFxConfig(FX_PRESETS[presetKey]));
  resident.object3D.position.set(0, 0.2, 0);
  scene.add(resident.object3D);
  systems.length = 0;
  systems.push(resident);
}

// スパークの単発バースト（位置指定）。プールから空きを探して使い回す。
function sparkAt(pos) {
  let slot = bursts.find((b) => b.idle);
  if (!slot) {
    const fx = createFxSystem(cloneFxConfig(FX_PRESETS.spark));
    scene.add(fx.object3D);
    slot = { fx, idle: true };
    bursts.push(slot);
  }
  slot.fx.object3D.position.copy(pos);
  slot.fx.burst(28);
  slot.idle = false;
  slot.releaseAt = performance.now() + 600; // 寿命後にidleへ戻す
}

// FPS / 粒数表示
let frames = 0, lastT = performance.now();
function updateHud() {
  frames++;
  const now = performance.now();
  if (now - lastT >= 500) {
    const fps = Math.round(frames / ((now - lastT) / 1000));
    frames = 0; lastT = now;
    const fc = document.getElementById('fps-counter');
    let live = 0;
    for (const s of systems) live += s.getConfig().maxParticles;
    for (const b of bursts) if (!b.idle) live += b.fx.getConfig().maxParticles;
    fc.firstChild.textContent = `${fps} FPS / 粒 `;
    document.getElementById('count').textContent = String(live);
  }
}

const clock = new THREE.Clock();
function render() {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  for (const s of systems) s.update(dt);
  const now = performance.now();
  for (const b of bursts) {
    if (!b.idle) { b.fx.update(dt); if (now >= b.releaseAt) b.idle = true; }
  }
  controls.update();
  updateHud();
  renderer.render(scene, camera);
}

async function init() {
  const app = document.getElementById('app');
  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x0e0e14, 1);
  app.appendChild(renderer.domElement);
  await renderer.init();

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(2.4, 1.6, 3.2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.9, 0);

  const grid = new THREE.GridHelper(8, 16, 0x4488ff, 0x223344);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // UI
  document.getElementById('btn-fire').onclick = () => setResident('fire');
  document.getElementById('btn-frost').onclick = () => setResident('frost');
  document.getElementById('btn-smoke').onclick = () => setResident('smoke');
  document.getElementById('btn-burst').onclick = () => sparkAt(new THREE.Vector3(0, 1.0, 0));
  document.getElementById('btn-stress').onclick = () => {
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      sparkAt(new THREE.Vector3(Math.cos(a) * 1.5, 0.6 + Math.random(), Math.sin(a) * 1.5));
    }
  };
  renderer.domElement.addEventListener('click', () => sparkAt(new THREE.Vector3(0, 1.0, 0)));

  setResident('fire');
  renderer.setAnimationLoop(render);
}

init().catch((e) => { console.error(e); showError(e && e.message ? e.message : e); });
