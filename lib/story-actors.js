// story-actors.js — ストーリーの VRM アクター管理（Three.js v0.184 WebGPU）
// 設計: .tmp/design.md §5
//
// npc.json（VRM/cloth/character 同梱）を舞台に登場させ、移動・モーション・向き・表情・崩れ・発話を制御する。
// 既存 lib（lip-sync / vrm-cloth / vrm-ragdoll）を流用。three は各デモと同一 URL を import（同一インスタンス）。
//
// 使い方:
//   const am = createActorManager({ scene, renderer, camera, vrmaUrl: (n)=>new URL('../vrma/'+n, base).href });
//   await am.show('lily', lilyBundle, { x:0, y:0, z:0, ry:180, scale:1 });
//   am.move('lily', 2, 1, 1500, { face:true });   // Promise を返す
//   毎フレーム: am.update(dt, camera);

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createLipSync } from './lip-sync.js';
import { createVRMCloth } from './vrm-cloth.js';
import { createRagdoll, setRagdollActive, updateRagdoll } from './vrm-ragdoll.js';

const DEG2RAD = Math.PI / 180;
const ANIM_CROSSFADE = 0.3;
const FACE_TAU = 0.25;       // 向き補間の時定数(秒)

function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function easeInOut(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }
function shortestAngle(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }

export function createActorManager({ scene, renderer, camera, vrmaUrl }) {
  const actors = new Map();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();

  function loadVrmFromDataUri(uri) {
    const loader = new GLTFLoader();
    // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
    loader.register(p => new VRMLoaderPlugin(p, {
      mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }),
    }));
    return loader.loadAsync(URL.createObjectURL(dataURIToBlob(uri))).then(g => g.userData.vrm);
  }

  async function show(id, bundle, tr = {}) {
    if (actors.has(id)) hide(id);
    if (!bundle || !bundle.vrm) { console.warn('[story] actor.show: VRM がありません:', id); return; }
    const vrm = await loadVrmFromDataUri(bundle.vrm);
    if (!vrm) { console.warn('[story] actor.show: VRM 読込失敗:', id); return; }

    // 埋め込みアイドル VRMA
    let mixer = null, action = null;
    if (bundle.vrma) {
      const al = new GLTFLoader();
      al.register(p => new VRMAnimationLoaderPlugin(p));
      const ag = await al.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrma)));
      const anims = ag.userData.vrmAnimations;
      if (anims && anims.length) {
        const clip = createVRMAnimationClip(anims[0], vrm);
        mixer = new THREE.AnimationMixer(vrm.scene);
        action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity).play();
      }
    }

    const pos = new THREE.Vector3(tr.x ?? 0, tr.y ?? 0, tr.z ?? 0);
    const ry  = (tr.ry ?? 0) * DEG2RAD;
    vrm.scene.position.copy(pos);
    vrm.scene.rotation.y = ry;
    if (tr.scale && tr.scale !== 1) vrm.scene.scale.setScalar(tr.scale);
    vrm.scene.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    const ragdoll = createRagdoll(vrm, { gravity: -9, boundsMargin: 0.4 });

    let cloth = null;
    if (bundle.cloth) {
      try { cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: pos, floorY: 0, timeline: bundle.timeline }); }
      catch (e) { console.warn('[story] マント生成失敗:', id, e); }
    }

    actors.set(id, {
      id, vrm, mixer, action, cloth, ragdoll,
      lip: createLipSync(vrm),
      displayName: (bundle.character && bundle.character.displayName) || id,
      pos, ry, baseScale: tr.scale || 1,
      move: null, faceTarget: null,
      expr: {},                       // name -> weight（保持表情）
      exprTween: null,                // { name, from, to, t, dur }
      speakExpr: null,                // 発話中の行表情 { name, weight }
      tlFps: bundle.timeline?.fps ?? 30,
      tlDuration: bundle.timeline?.durationFrames ?? 0,
      tlClock: 0,
    });
  }

  function hide(id) {
    const a = actors.get(id);
    if (!a) return;
    if (a.cloth && a.cloth.dispose) { try { a.cloth.dispose(); } catch { /* noop */ } }
    scene.remove(a.vrm.scene);
    a.vrm.scene.traverse(o => {
      if (o.isMesh) { o.geometry?.dispose?.(); const m = o.material; if (Array.isArray(m)) m.forEach(x => x.dispose?.()); else m?.dispose?.(); }
    });
    actors.delete(id);
  }

  function move(id, x, z, duration, opts = {}) {
    const a = actors.get(id);
    if (!a) { console.warn('[story] actor.move: 未登場:', id); return Promise.resolve(); }
    return new Promise(resolve => {
      a.move = { fromX: a.pos.x, fromZ: a.pos.z, toX: x, toZ: z, t: 0, dur: Math.max(1, duration || 1), face: opts.face !== false, resolve };
    });
  }

  function face(id, target) {
    const a = actors.get(id);
    if (!a) { console.warn('[story] actor.face: 未登場:', id); return; }
    a.faceTarget = parseFaceTarget(target);
  }

  function parseFaceTarget(target) {
    if (Array.isArray(target)) return { kind: 'pos', x: target[0], z: target[1] };
    if (typeof target === 'string') {
      if (target === 'camera') return { kind: 'camera' };
      if (target.includes(',')) { const [x, z] = target.split(',').map(Number); return { kind: 'pos', x, z }; }
      return { kind: 'actor', id: target };
    }
    return { kind: 'camera' };
  }

  function anim(id, vrmaFile, loop) {
    const a = actors.get(id);
    if (!a) { console.warn('[story] actor.anim: 未登場:', id); return Promise.resolve(); }
    const url = typeof vrmaUrl === 'function' ? vrmaUrl(vrmaFile) : vrmaFile;
    const al = new GLTFLoader();
    al.register(p => new VRMAnimationLoaderPlugin(p));
    return al.loadAsync(url).then(ag => {
      const anims = ag.userData.vrmAnimations;
      if (!anims || !anims.length) { console.warn('[story] VRMA にアニメ無し:', vrmaFile); return; }
      const clip = createVRMAnimationClip(anims[0], a.vrm);
      if (!a.mixer) a.mixer = new THREE.AnimationMixer(a.vrm.scene);
      const next = a.mixer.clipAction(clip);
      next.reset();
      next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      if (a.action) { a.action.crossFadeTo(next, ANIM_CROSSFADE, false); next.play(); }
      else next.play();
      a.action = next;
      if (loop) return;
      return new Promise(res => {
        const onFin = (e) => { if (e.action === next) { a.mixer.removeEventListener('finished', onFin); res(); } };
        a.mixer.addEventListener('finished', onFin);
      });
    }).catch(e => { console.warn('[story] VRMA 読込失敗:', vrmaFile, e); });
  }

  function expression(id, name, weight, duration) {
    const a = actors.get(id);
    if (!a || !name) return;
    const cur = a.expr[name] ?? 0;
    a.exprTween = { name, from: cur, to: weight ?? 1, t: 0, dur: Math.max(1, duration || 1) };
  }

  function ragdoll(id, active) {
    const a = actors.get(id);
    if (!a) return;
    setRagdollActive(a.ragdoll, !!active);
  }

  function speak(id, text, cps, exprName, exprWeight) {
    const a = actors.get(id);
    if (!a) { console.warn('[story] say: 未登場:', id); return; }
    a.lip.play(text, cps || 8);
    a.speakExpr = exprName ? { name: exprName, weight: exprWeight != null ? exprWeight : 1 } : null;
  }

  function headWorldPos(id, out) {
    const a = actors.get(id);
    if (!a) return null;
    const head = a.vrm.humanoid?.getNormalizedBoneNode('head');
    if (head) { head.updateWorldMatrix(true, false); head.getWorldPosition(out); out.y += 0.25; }
    else out.copy(a.pos).add(_v.set(0, 1.5, 0));
    return out;
  }

  function update(dt, cam) {
    const c = cam || camera;
    for (const a of actors.values()) {
      // 移動 tween
      if (a.move) {
        a.move.t += dt * 1000;
        const k = Math.min(1, a.move.t / a.move.dur);
        const e = easeInOut(k);
        a.pos.x = a.move.fromX + (a.move.toX - a.move.fromX) * e;
        a.pos.z = a.move.fromZ + (a.move.toZ - a.move.fromZ) * e;
        if (a.move.face) {
          const dx = a.move.toX - a.move.fromX, dz = a.move.toZ - a.move.fromZ;
          if (dx * dx + dz * dz > 1e-6) a.faceTarget = { kind: 'pos', x: a.move.toX, z: a.move.toZ };
        }
        if (k >= 1) { const r = a.move.resolve; a.move = null; r && r(); }
      }
      a.vrm.scene.position.copy(a.pos);

      // 向き tween
      if (a.faceTarget) {
        let tx = 0, tz = 0, ok = true;
        if (a.faceTarget.kind === 'camera') { tx = c.position.x; tz = c.position.z; }
        else if (a.faceTarget.kind === 'pos') { tx = a.faceTarget.x; tz = a.faceTarget.z; }
        else if (a.faceTarget.kind === 'actor') { const t = actors.get(a.faceTarget.id); if (t) { tx = t.pos.x; tz = t.pos.z; } else ok = false; }
        if (ok) {
          const yaw = Math.atan2(tx - a.pos.x, tz - a.pos.z);
          a.ry += shortestAngle(yaw - a.ry) * (1 - Math.exp(-dt / FACE_TAU));
          a.vrm.scene.rotation.y = a.ry;
        }
      } else {
        a.vrm.scene.rotation.y = a.ry;
      }

      // ラグドール or アニメ
      if (a.ragdoll.active) {
        updateRagdoll(a.ragdoll, dt, { floorY: 0 });
      } else if (a.mixer) {
        a.mixer.update(dt);
      }

      // 表情 tween（保持表情）
      if (a.exprTween) {
        a.exprTween.t += dt * 1000;
        const k = Math.min(1, a.exprTween.t / a.exprTween.dur);
        a.expr[a.exprTween.name] = a.exprTween.from + (a.exprTween.to - a.exprTween.from) * k;
        if (k >= 1) a.exprTween = null;
      }
      const em = a.vrm.expressionManager;
      if (em) for (const [n, w] of Object.entries(a.expr)) { try { em.setValue(n, w); } catch { /* 未定義表情は無視 */ } }

      // 口パク＋発話中の行表情（保持表情の上に上書き）
      a.lip.update(dt * 1000);
      if (em && a.speakExpr) {
        try { em.setValue(a.speakExpr.name, a.lip.playing ? a.speakExpr.weight : 0); } catch { /* noop */ }
        if (!a.lip.playing) a.speakExpr = null;
      }

      a.vrm.update(dt);

      if (a.cloth) {
        let frame = null;
        if (a.action) frame = Math.floor(a.action.time * a.tlFps);
        else if (a.tlDuration) { if (!a.ragdoll.active) a.tlClock += dt; frame = Math.floor(a.tlClock * a.tlFps) % a.tlDuration; }
        a.cloth.update(dt, frame);
      }
    }
  }

  function clear() { for (const id of [...actors.keys()]) hide(id); }

  return { show, hide, move, face, anim, expression, ragdoll, speak, headWorldPos, get: (id) => actors.get(id), has: (id) => actors.has(id), update, clear };
}
