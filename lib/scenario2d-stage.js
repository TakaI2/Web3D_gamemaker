// lib/scenario2d-stage.js — 2Dシナリオの「3D話者ステージ」（エディタ用）。
// city-fly の OP/ED 全画面3D表示と同じ構図・口パク・表情を、独立キャンバスで再現する。
// 使い方:
//   const st3d = createScenario2DStage({ actors: () => talksActors });   // talks.json の actors（{id:{name,color,vrm,npc,pt}}）
//   await st3d.preload(['hakase','mayor']);                              // 再生前に読込＋事前コンパイル
//   createScenario2D({ ..., stage: st3d.hooks });                       // begin/end フック
//   毎フレーム st3d.update(dt);
// 注意: visible=false のまま compileAsync しても素通りされる（初描画で詰まる）ため、
//       読込直後に一時表示して実描画までウォームする（city-fly の warmGuest と同じ鉄則）。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMCloth } from './vrm-cloth.js';
import { createLipSync } from './lip-sync.js';
import { registerCustomExpressions, resetEmotionExpressions } from './vrm-expressions.js';

// ゲーム(city-fly)の全画面ステージと同じ構図パラメータ
const ST = { dist: 1.5, up: 0.02, fwd: 0, fov: 32 };
const BASIS_MIX = 0.4;         // 0=頭固定（首振りが画に出ない）/ 1=胸固定
const IDLE_VRMA = 'HumanM@Idle01.vrma';
const LIP_CPS_DEF = 9;         // ゲームの TALK_CPS と同じ既定値
const FACE_EXPR = { smile: 'happy', angry: 'angry', worry: 'sad', panic: 'surprised', weak: 'sad', damage: 'sad' };

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
function boneOf(vrm, names) {
  const hm = vrm && vrm.humanoid;
  if (!hm) return null;
  for (const n of names) {
    const b = (hm.getNormalizedBoneNode ? hm.getNormalizedBoneNode(n) : null) || (hm.getRawBoneNode ? hm.getRawBoneNode(n) : null);
    if (b) return b;
  }
  return null;
}

export function createScenario2DStage(opts = {}) {
  const vrmPath = opts.vrmPath || '../vrm';
  const npcPath = opts.npcPath || '../npc';
  const vrmaPath = opts.vrmaPath || '../vrma';
  const expressionsUrl = opts.expressionsUrl || '../cityfly/expressions.json';   // カスタム表情の合成定義
  const actorsMap = () => (typeof opts.actors === 'function' ? opts.actors() : opts.actors) || {};
  let exprDefsP = null;
  const loadExprDefs = () => exprDefsP || (exprDefsP = fetch(expressionsUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null));

  let renderer = null, scene = null, cam = null, keyLight = null, canvas = null;
  const cast = new Map();   // actorId -> { vrm, lip, mixer, cloth }
  let idleAnim = null;      // VRMアニメ（全員で共用）
  let current = null, active = false;
  const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), EYE = new THREE.Vector3();
  const Q1 = new THREE.Quaternion(), Q2 = new THREE.Quaternion();

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    await renderer.init();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(window.innerWidth, window.innerHeight);
    canvas = renderer.domElement;
    canvas.style.cssText = 'position:fixed;inset:0;z-index:44;display:none;'
      + 'background:linear-gradient(180deg,#0a1024,#1a1030);';   // 背景はCSSグラデ（キャンバスは透過描画）
    document.body.appendChild(canvas);
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(ST.fov, window.innerWidth / window.innerHeight, 0.02, 50);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x30281f, 0.5));
    keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    scene.add(keyLight); scene.add(keyLight.target);
    window.addEventListener('resize', () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      cam.aspect = window.innerWidth / window.innerHeight; cam.updateProjectionMatrix();
    });
  }

  async function loadIdle() {
    if (idleAnim) return idleAnim;
    const res = await fetch(vrmaPath + '/' + encodeURIComponent(IDLE_VRMA));
    if (!res.ok) throw new Error('idle vrma ' + res.status);
    const al = new GLTFLoader(); al.register((pl) => new VRMAnimationLoaderPlugin(pl));
    const ag = await al.loadAsync(URL.createObjectURL(await res.blob()));
    idleAnim = (ag.userData.vrmAnimations || [])[0] || null;
    return idleAnim;
  }

  async function loadActor(actorId) {
    if (cast.has(actorId)) return cast.get(actorId);
    const a = actorsMap()[actorId] || {};
    const file = a.npc || a.vrm;
    const entry = { vrm: null, lip: null, mixer: null, cloth: null };
    cast.set(actorId, entry);
    if (!file) return entry;   // モデル未指定＝2D表示にフォールバック
    await ensureRenderer();
    const isBundle = /\.npc\.json$/i.test(file);
    let bundle = null, srcUrl = vrmPath + '/' + encodeURIComponent(file);
    if (isBundle) {
      bundle = await (await fetch(npcPath + '/' + encodeURIComponent(file))).json();
      if (!bundle || !bundle.vrm) throw new Error('バンドルにVRMがありません: ' + file);
      srcUrl = URL.createObjectURL(dataURIToBlob(bundle.vrm));
    }
    const loader = new GLTFLoader();
    loader.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
    const gltf = await loader.loadAsync(srcUrl);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRM拡張なし: ' + file);
    const faceOff = bundle && bundle.faceOffsetDeg != null ? bundle.faceOffsetDeg * Math.PI / 180 : (vrm.meta?.metaVersion === '0' ? Math.PI : 0);
    vrm.scene.rotation.y = faceOff;
    vrm.scene.position.set(cast.size * 8, 0, 0);   // 1体ずつ離す（重なり映り込み防止）
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    vrm.scene.visible = false;
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);
    entry.vrm = vrm;
    if (bundle && bundle.cloth) {   // マント（グラブ点の正準化はゲームと同じ規約）
      try {
        const gripFlip = Math.cos(faceOff) > 0;
        const _flipO = (o) => { if (Array.isArray(o) && o.length >= 3) { o[0] = -o[0]; o[2] = -o[2]; } };
        if (gripFlip) {
          for (const gg of (bundle.cloth.gripGroups || [])) _flipO(gg.offset);
          if (bundle.cloth.handGrabOffsets) { _flipO(bundle.cloth.handGrabOffsets.left); _flipO(bundle.cloth.handGrabOffsets.right); }
        }
        const tr0 = bundle.cloth.editorTransform ?? { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1 };
        const c0 = Math.cos(faceOff), s0 = Math.sin(faceOff);
        const trAdj = { ...tr0, ry: (tr0.ry || 0) + faceOff * 180 / Math.PI,
          tx: (tr0.tx || 0) * c0 - (tr0.tz || 0) * s0,
          tz: (tr0.tx || 0) * s0 + (tr0.tz || 0) * c0 };
        entry.cloth = createVRMCloth({ renderer, scene, vrm, cloth: { ...bundle.cloth, editorTransform: trAdj }, basePos: vrm.scene.position.clone(), floorY: -1e9 });
        if (entry.cloth.clothMesh) { entry.cloth.clothMesh.frustumCulled = false; entry.cloth.clothMesh.visible = false; }
      } catch (e) { console.warn('話者のマント生成失敗:', actorId, e); }
    }
    try {   // アイドル再生（Tポーズ回避）
      const anim = await loadIdle();
      if (anim) {
        const clip = createVRMAnimationClip(anim, vrm); stripRootMotion(clip);
        entry.mixer = new THREE.AnimationMixer(vrm.scene);
        entry.mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
      }
    } catch (e) { console.warn('話者のアイドル再生失敗:', actorId, e.message || e); }
    try { entry.lip = createLipSync(vrm); } catch { /* noop */ }
    try { registerCustomExpressions(vrm, await loadExprDefs()); } catch (e) { console.warn('カスタム表情の登録失敗:', actorId, e); }
    try {   // 事前コンパイル＋実描画ウォーム（初登場ヒッチ対策。非表示のままだと素通りされる）
      vrm.scene.visible = true;
      if (entry.cloth && entry.cloth.clothMesh) entry.cloth.clothMesh.visible = true;
      await renderer.compileAsync(scene, cam);
      if (entry.cloth) { try { entry.cloth.update(1 / 60); entry.cloth.update(1 / 60); } catch { /* noop */ } }
      renderer.render(scene, cam);
    } finally {
      vrm.scene.visible = false;
      if (entry.cloth && entry.cloth.clothMesh) entry.cloth.clothMesh.visible = false;
    }
    return entry;
  }

  async function preload(actorIds, onProgress) {
    for (const id of actorIds || []) {
      try { await loadActor(id); } catch (e) { console.warn('話者モデル読込失敗:', id, e); }
      if (onProgress) onProgress(id);
    }
  }

  function setCurrent(actorId) {
    if (current === actorId) return;
    const prev = current && cast.get(current);
    if (prev && prev.vrm) { prev.vrm.scene.visible = false; if (prev.cloth && prev.cloth.clothMesh) prev.cloth.clothMesh.visible = false; }
    current = actorId;
    const cur = actorId && cast.get(actorId);
    if (cur && cur.vrm) { cur.vrm.scene.visible = true; if (cur.cloth && cur.cloth.clothMesh) cur.cloth.clothMesh.visible = true; }
  }

  function begin(actorId, face, text, extra) {
    const entry = cast.get(actorId);
    if (!entry || !entry.vrm) { end(); return false; }   // モデルなし＝2D紙芝居のまま
    setCurrent(actorId);
    active = true;
    canvas.style.display = 'block';
    const em = entry.vrm.expressionManager;
    if (em) {   // 表情: 行の expression（VRM表情名・カスタム表情名）＞ face（2D表情名→VRM表情へ変換）
      resetEmotionExpressions(em);
      const exOv = extra && extra.expression;
      const ex = exOv || FACE_EXPR[face || 'normal'];
      if (ex) { try { em.setValue(ex, exOv ? (extra.weight ?? 1) : 1); } catch { /* noop */ } }
    }
    if (entry.lip && text) entry.lip.play(text, (extra && extra.lipCps) || LIP_CPS_DEF);
    return true;
  }

  function end() {
    active = false; setCurrent(null);
    if (canvas) canvas.style.display = 'none';
  }

  function frameCamera(vrm, actorId) {   // city-fly updatePortrait のステージ構図と同じ計算
    const h = boneOf(vrm, ['head']);
    if (!h) return;
    h.getWorldPosition(V1); h.getWorldQuaternion(Q1);
    const bn = boneOf(vrm, ['chest', 'upperChest', 'spine', 'hips', 'head']);
    if (bn && bn !== h) { bn.getWorldQuaternion(Q2); Q1.slerp(Q2, BASIS_MIX); }
    const fz = vrm.lookAt?.faceFront?.z;
    const fwd = V2.set(0, 0, typeof fz === 'number' && fz < 0 ? -1 : 1).applyQuaternion(Q1);
    const up = V3.set(0, 1, 0).applyQuaternion(Q1);
    const ov = ((actorsMap()[actorId] || {}).pt || {}).stage || {};
    const dist = ov.dist ?? ST.dist, upOff = ov.up ?? ST.up, fwdOff = ov.fwd ?? ST.fwd, fov = ov.fov ?? ST.fov;
    EYE.copy(V1).addScaledVector(up, upOff).addScaledVector(fwd, fwdOff);
    cam.position.copy(EYE).addScaledVector(fwd, dist);
    cam.up.copy(up);
    cam.lookAt(EYE);
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    keyLight.position.copy(cam.position).addScaledVector(up, 1.2);   // 正面キー光（カメラ側から）
    keyLight.target.position.copy(EYE);
  }

  function update(dt) {
    if (!active || !renderer) return;
    const entry = current && cast.get(current);
    if (!entry || !entry.vrm) return;
    if (entry.lip) entry.lip.update(dt * 1000);
    if (entry.mixer) entry.mixer.update(dt);
    entry.vrm.update(dt);
    if (entry.cloth) { try { entry.cloth.update(dt); } catch { /* noop */ } }
    frameCamera(entry.vrm, current);
    renderer.render(scene, cam);
  }

  return {
    hooks: { begin, end },
    preload, update,
    get active() { return active; },
    get current() { return current; },
    get cast() { return cast; },
  };
}
