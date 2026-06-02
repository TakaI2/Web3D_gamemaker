// story-stage.js — ストーリー再生エンジン（Three.js v0.184 WebGPU）。player と editor プレビューで共用。
// 設計: .tmp/design.md §6, §7
//
// 3Dシーン（床+空+ライト）・カメラ・アクター・セリフUI・フェード・音声・ステージ読込を統合し、
// story-runner に op の hooks を注入する。アセットURLは lib/ からの相対（import.meta.url）で解決するため
// player/editor どちらのページからでも同じパスで読める。
//
// 使い方:
//   const stage = await createStoryStage({ container: document.getElementById('app'), mode:'play' });
//   stage.loadStory(storyJson);
//   stage.setOnEnd(() => { ... });
//   await stage.play(0);              // 先頭から（pc 指定可）
//   stage.stop();

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { createActorManager } from './story-actors.js';
import { createStoryRunner } from './story-runner.js';
import { createSpeechUI } from './speech-ui.js';
import { applyDefaults } from './story-ops.js';

const BUBBLE_MAX_DIST = 25;
const FADE_DEFAULT_MS = 500;

const npcUrl   = (n) => new URL('../npc/' + encodeURIComponent(n), import.meta.url).href;
const vrmaUrl  = (n) => new URL('../vrma/' + String(n).split('/').map(encodeURIComponent).join('/'), import.meta.url).href;
const modelUrl = (n) => new URL('../models/' + String(n).split('/').map(encodeURIComponent).join('/'), import.meta.url).href;
const assetUrl = (n) => new URL('../assets/' + String(n).split('/').map(encodeURIComponent).join('/'), import.meta.url).href;

const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const wait = (ms) => new Promise(r => setTimeout(r, ms || 0));

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map(l => typeof l === 'string'
    ? { text: l, expression: null, weight: 1 }
    : { text: l.text || '', expression: l.expression || null, weight: l.weight != null ? l.weight : 1 })
    .filter(l => l.text);
}

export async function createStoryStage({ container, mode = 'play' }) {
  if (!navigator.gpu) throw new Error('WebGPU 非対応のブラウザです');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  // ── レンダラ / シーン / カメラ ──
  const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbcd8ef);
  scene.fog = new THREE.FogExp2(0xcfe3f5, 0.01);

  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.05, 600);
  camera.position.set(0, 1.4, 3);
  const camLook = new THREE.Vector3(0, 1.2, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  scene.add(new THREE.HemisphereLight(0xcfe3f5, 0x404840, 0.6));
  const key = new THREE.DirectionalLight(0xfff6e6, 1.5); key.position.set(5, 12, 6); scene.add(key);

  // 床
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: 0x6b7a5a, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  scene.add(new THREE.GridHelper(40, 40, 0x888888, 0x556055));

  try {
    const hdr = await new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg');
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  } catch (e) { console.warn('[story] HDR 環境マップ読込失敗（ライトのみで継続）:', e); }

  // ── サブシステム ──
  const actorManager = createActorManager({ scene, renderer, camera, vrmaUrl });
  const speechUI = createSpeechUI({ dom: container });

  // フェード幕
  const fadeEl = document.createElement('div');
  fadeEl.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:50;';
  container.appendChild(fadeEl);
  let fadeTween = null;
  function fadeTo(to, color, duration) {
    if (color) fadeEl.style.background = color;
    const from = parseFloat(fadeEl.style.opacity) || 0;
    if (!duration) { fadeEl.style.opacity = String(to); return Promise.resolve(); }
    return new Promise(res => { fadeTween = { from, to, t: 0, dur: duration, res }; });
  }

  // カメラ tween
  let camTween = null;
  function cameraMoveTo(pos, target, duration) {
    const fromP = camera.position.clone(), fromT = camLook.clone();
    const toP = pos ? new THREE.Vector3(pos[0], pos[1], pos[2]) : fromP.clone();
    const toT = target ? new THREE.Vector3(target[0], target[1], target[2]) : fromT.clone();
    if (!duration) { camera.position.copy(toP); camLook.copy(toT); camera.lookAt(camLook); return Promise.resolve(); }
    return new Promise(res => { camTween = { fromP, fromT, toP, toT, t: 0, dur: duration, res }; });
  }

  // ステージ（GLB配置）
  let stageGroup = new THREE.Group(); scene.add(stageGroup);
  const stageCache = new Map();
  async function loadStage(name) {
    let data = null;
    try { const r = await fetch(modelUrl(name)); if (r.ok) data = await r.json(); } catch { /* 無ければ無視 */ }
    scene.remove(stageGroup);
    stageGroup = new THREE.Group(); scene.add(stageGroup);
    if (!data || !Array.isArray(data.items)) return;
    for (const it of data.items) {
      try {
        let tpl = stageCache.get(it.model);
        if (!tpl) { const g = await new GLTFLoader().loadAsync(modelUrl(it.model)); tpl = g.scene; stageCache.set(it.model, tpl); }
        const m = tpl.clone(true);
        m.scale.setScalar(it.scale || 1);
        m.position.set(it.x || 0, it.y || 0, it.z || 0);
        m.rotation.y = it.ry || 0;
        stageGroup.add(m);
      } catch (e) { console.warn('[story] ステージ置物の読込失敗:', it.model, e); }
    }
  }

  // 音声
  let bgmAudio = null;
  function playBgm(op) {
    try { if (bgmAudio) bgmAudio.pause(); bgmAudio = new Audio(assetUrl(op.name)); bgmAudio.loop = op.loop !== false; bgmAudio.volume = op.volume ?? 0.6; bgmAudio.play().catch(e => console.warn('[story] BGM再生不可:', e)); }
    catch (e) { console.warn('[story] BGM失敗:', e); }
  }
  function stopBgm() { if (bgmAudio) { bgmAudio.pause(); bgmAudio = null; } }
  function playSe(op) { try { const a = new Audio(assetUrl(op.name)); a.volume = op.volume ?? 1; a.play().catch(() => {}); } catch { /* noop */ } }

  // ── アクター解決（npc.json キャッシュ） ──
  let story = { actors: [], script: [] };
  const npcCache = new Map();
  async function loadNpc(file) {
    if (npcCache.has(file)) return npcCache.get(file);
    const b = await fetch(npcUrl(file)).then(r => r.ok ? r.json() : null).catch(() => null);
    npcCache.set(file, b);
    return b;
  }
  function actorFileFor(id) { const a = (story.actors || []).find(a => a.id === id); return a ? a.npc : null; }

  // ── say フロー（クリック/Space 送り） ──
  let advanceResolve = null;
  function waitAdvance() { return new Promise(r => { advanceResolve = r; }); }
  function doAdvance() { if (advanceResolve) { const r = advanceResolve; advanceResolve = null; r(); } }
  renderer.domElement.addEventListener('click', doAdvance);
  function onKey(e) { if (e.code === 'Space') { e.preventDefault(); doAdvance(); } }
  window.addEventListener('keydown', onKey);

  async function sayFlow(op) {
    const actor = actorManager.get(op.actor);
    const name = actor ? actor.displayName : (op.actor || '');
    const cps = op.cps || 8;
    for (const line of normalizeLines(op.lines)) {
      speechUI.showBottom(name, line.text, cps);
      if (actor) { speechUI.setBubble(actor, line.text, cps); actorManager.speak(op.actor, line.text, cps, line.expression, line.weight); }
      await waitAdvance();
    }
  }

  // ── hooks（runner へ注入） ──
  let onEnd = null;
  const hooks = {
    'say': (op) => sayFlow(op),
    'wait': () => waitAdvance(),
    'actor.show': async (op) => {
      const file = op.npc || actorFileFor(op.id);
      if (!file) { console.warn('[story] actor 未定義:', op.id); return; }
      const bundle = await loadNpc(file);
      if (!bundle) { console.warn('[story] npc.json 読込失敗:', file); return; }
      await actorManager.show(op.id, bundle, op);
    },
    'actor.hide': (op) => actorManager.hide(op.id),
    'actor.move': (op) => actorManager.move(op.id, op.x, op.z, op.duration, { face: op.face }),
    'actor.face': (op) => { actorManager.face(op.id, op.target); },
    'actor.anim': (op) => actorManager.anim(op.id, op.vrma, op.loop),
    'actor.expression': (op) => { actorManager.expression(op.id, op.expression, op.weight, op.duration); },
    'actor.ragdoll': (op) => { actorManager.ragdoll(op.id, op.active); },
    'camera': (op) => cameraMoveTo(op.pos, op.target, op.duration),
    'stage': (op) => loadStage(op.name),
    'bg': (op) => { if (op.color) scene.background = new THREE.Color(op.color); },
    'bgm.play': (op) => { playBgm(op); },
    'bgm.stop': () => { stopBgm(); },
    'se': (op) => { playSe(op); },
    'delay': (op) => wait(op.duration),
    'fade.in': (op) => fadeTo(0, op.color, op.duration ?? FADE_DEFAULT_MS),
    'fade.out': (op) => fadeTo(1, op.color, op.duration ?? FADE_DEFAULT_MS),
    'end': () => { if (onEnd) onEnd(); },
  };

  // ── 投影（頭上吹き出し） ──
  const _proj = new THREE.Vector3();
  function projectHead(actor) {
    const out = actorManager.headWorldPos(actor.id, _proj);
    if (!out) return { visible: false };
    const dist = camera.position.distanceTo(out);
    out.project(camera);
    const visible = out.z < 1 && dist <= BUBBLE_MAX_DIST && out.x >= -1 && out.x <= 1 && out.y >= -1 && out.y <= 1;
    return { x: (out.x * 0.5 + 0.5) * container.clientWidth, y: (-out.y * 0.5 + 0.5) * container.clientHeight, visible };
  }

  // ── ループ ──
  const timer = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(timer.getDelta(), 1 / 30);
    actorManager.update(dt, camera);
    // カメラ / フェード tween
    if (camTween) {
      camTween.t += dt * 1000; const k = Math.min(1, camTween.t / camTween.dur); const e = easeInOut(k);
      camera.position.lerpVectors(camTween.fromP, camTween.toP, e);
      camLook.lerpVectors(camTween.fromT, camTween.toT, e);
      if (k >= 1) { const r = camTween.res; camTween = null; r && r(); }
    }
    camera.lookAt(camLook);
    if (fadeTween) {
      fadeTween.t += dt * 1000; const k = Math.min(1, fadeTween.t / fadeTween.dur);
      fadeEl.style.opacity = String(fadeTween.from + (fadeTween.to - fadeTween.from) * k);
      if (k >= 1) { const r = fadeTween.res; fadeTween = null; r && r(); }
    }
    speechUI.update(dt, projectHead);
    renderer.render(scene, camera);
  });

  function onResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', onResize);

  // ── 公開 ──
  let runner = null;
  function loadStory(json) {
    story = json || { actors: [], script: [] };
    actorManager.clear();
    stopBgm();
    if (story.stage) loadStage(story.stage);
  }
  function play(fromPc = 0) {
    if (runner && runner.running) runner.stop();
    runner = createStoryRunner(story.script || [], hooks);
    return runner.run(fromPc);
  }
  // editor「ここから再生」用: uptoPc 手前のセットアップ系 op を先行実行して舞台を整える
  async function prime(uptoPc) {
    const script = story.script || [];
    const skip = new Set(['say', 'wait', 'delay', 'fade.in', 'fade.out', 'end']);
    const awaitOps = new Set(['actor.show', 'stage']);
    for (let i = 0; i < uptoPc && i < script.length; i++) {
      const op = applyDefaults(script[i]);
      if (skip.has(op.op)) continue;
      const fn = hooks[op.op];
      if (!fn) continue;
      try { const p = fn(op); if (awaitOps.has(op.op)) await p; } catch (e) { console.warn('[story] prime 失敗:', op.op, e); }
    }
  }
  function stop() { if (runner) runner.stop(); doAdvance(); }
  function dispose() {
    if (runner) runner.stop();
    renderer.setAnimationLoop(null);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    actorManager.clear();
    stopBgm();
    renderer.dispose();
    renderer.domElement.remove();
    fadeEl.remove();
  }

  return {
    loadStory, play, prime, stop, dispose,
    setOnEnd(fn) { onEnd = fn; },
    advance: doAdvance,
    actorManager, camera, scene,
  };
}
