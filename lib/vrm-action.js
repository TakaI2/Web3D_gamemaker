// vrm-action.js — IKアクションランナー（拾う・眺める・食べる）。
//
// アニメーションの上に乗る手続きレイヤー:
//   reach（姿勢の自動同調つきで手を伸ばす）→ grab（holdToolで吸着）
//   → bring（顔の前 / 口元へ。口元は bite点⇔口アンカーの剛体一致で逆算）
//   → eat（viseme 'aa' パルス＋齧るたび縮小）→ out（IKを抜いて元のアニメへ）
//
// 姿勢の同調（reach中・毎フレーム）:
//   不足距離を「高さ」で しゃがみ/前傾 に配分（床=腰を落とす主体・机の遠く=前傾主体の連続ブレンド）
//   しゃがみ・前傾とも足は脚IKで接地維持。値は平滑化して急変しない。
//
// 使い方（ホストのループで mixer.update の後・vrm.update の前に）:
//   const runner = createActionRunner(vrm);            // 休止ポーズで生成（腕長などを実測ベイク）
//   runner.play('eat', { object, def, onDone });       // object=シーン上の物 / def=.tool.json
//   runner.update(dt);
import * as THREE from 'https://esm.sh/three@0.184.0';
import { solveTwoBoneIK } from './pose-kit.js';
import { holdTool, applyGrip } from './vrm-tool.js';
import { createHeadLook } from './vrm-look.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _mf = new THREE.Vector3(), _mu = new THREE.Vector3(), _mr = new THREE.Vector3(), _mq = new THREE.Quaternion(), _mm = new THREE.Matrix4();
const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

function trs(out, pos, rotDeg) {
  const r = rotDeg || [0, 0, 0];
  return out.compose(
    _v4.fromArray(pos || [0, 0, 0]),
    _q3.setFromEuler(_e.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180)),
    _v3.set(1, 1, 1),
  );
}

export function createActionRunner(vrm, opts = {}) {
  const nb = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
  const look = createHeadLook(vrm, { maxDownDeg: 70 });

  // ── 休止ポーズで実測ベイク ──
  vrm.scene.updateMatrixWorld(true);
  const head = nb('head'), hips = nb('hips');
  const bake = { armLen: 0.55, kneeY: 0.48, torso: 0.55, faceLocal: new THREE.Vector3(0, 0, 1), upLocal: new THREE.Vector3(0, 1, 0), hipsRest: hips ? hips.position.clone() : new THREE.Vector3() };
  {
    const ua = nb('rightUpperArm'), la = nb('rightLowerArm'), ha = nb('rightHand');
    if (ua && la && ha) bake.armLen = ua.getWorldPosition(_v).distanceTo(la.getWorldPosition(_v2)) + _v2.distanceTo(ha.getWorldPosition(_v3));
    const kn = nb('leftLowerLeg');
    if (kn) bake.kneeY = kn.getWorldPosition(_v).y - vrm.scene.position.y;
    if (hips && head) bake.torso = hips.getWorldPosition(_v).distanceTo(head.getWorldPosition(_v2));
    // 顔の前方（脚実測）を頭ローカルへ
    const lL = nb('leftUpperLeg'), lR = nb('rightUpperLeg');
    if (lL && lR && head) {
      _v3.crossVectors(lL.getWorldPosition(_v).sub(lR.getWorldPosition(_v2)), _up).normalize();
      head.getWorldQuaternion(_q);
      bake.faceLocal.copy(_v3).applyQuaternion(_q2.copy(_q).invert()).normalize();
      bake.upLocal.copy(_up).applyQuaternion(_q2).normalize();
    }
  }

  // アクション調整値（.tool.json の verbs.common で上書き可能）
  const P0 = { durReach: 0.95, durBring: 0.75, durOut: 1.15, holdSec: 1.4, inspectDist: 0.26,
    elbow: [0, -1, 0.35], biteCycle: 0.62, shrink: 0.78 };
  function prm() {
    const c = st.def?.verbs?.common || {};
    const e = st.def?.verbs?.eat || {};
    return { ...P0, ...c, ...e };
  }
  // 食べ点/眺め点（頭ローカルTRS。エディタのギズモで編集可能）。既定は実測した顔の向きから合成
  const anchors = { mouth: null, inspect: null };
  function defaultAnchor(dist, drop) {
    const pos = bake.faceLocal.clone().multiplyScalar(dist).addScaledVector(bake.upLocal, drop);
    // 向き: +Z が顔へ向く（bite法線が唇/顔を向く）
    const z = bake.faceLocal.clone().negate();
    const x = new THREE.Vector3().crossVectors(bake.upLocal, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    return { pos: [+pos.x.toFixed(4), +pos.y.toFixed(4), +pos.z.toFixed(4)],
      rotDeg: [+(e.x * 180 / Math.PI).toFixed(1), +(e.y * 180 / Math.PI).toFixed(1), +(e.z * 180 / Math.PI).toFixed(1)] };
  }
  const st = {
    phase: null, verb: null, t: 0, w: 0, side: 'right',
    object: null, def: null, held: null, onDone: null,
    crouch: 0, lean: 0, bites: 0, biteT: 0, biteMax: 3, returnAfter: false, grabBlend: 0, keep: false,
    lastP: new THREE.Vector3(), lastErr: 0,
    scale0: 1, grabPos: new THREE.Vector3(), grabQuat: new THREE.Quaternion(),
    home: new THREE.Matrix4(),
    fromPos: new THREE.Vector3(), fromQuat: new THREE.Quaternion(),
  };
  function captureHandFrom() {   // フェーズ開始時の手の姿勢（ここから目標へ補間＝ワープ防止）
    const lb = limb(st.side);
    if (!lb.end) return;
    lb.end.updateWorldMatrix(true, false);
    lb.end.getWorldPosition(st.fromPos);
    lb.end.getWorldQuaternion(st.fromQuat);
  }

  function ensureAnchors() {
    if (!anchors.mouth) anchors.mouth = opts.anchors?.mouth || defaultAnchor(0.085, -0.025);
    if (!anchors.inspect) anchors.inspect = opts.anchors?.inspect || defaultAnchor(0.3, -0.05);
  }
  function limb(side) {
    return { root: nb(side + 'UpperArm'), mid: nb(side + 'LowerArm'), end: nb(side + 'Hand') };
  }
  function bodyFwdW(out) {   // 現在の体の正面（脚実測）
    const lL = nb('leftUpperLeg'), lR = nb('rightUpperLeg');
    if (!lL || !lR) return out.set(0, 0, 1);
    out.crossVectors(lL.getWorldPosition(_v).sub(lR.getWorldPosition(_v2)), _up);
    return out.lengthSq() > 1e-8 ? out.normalize() : out.set(0, 0, 1);
  }
  function anchorWorld(which, outPos, outQuat) {   // 頭ローカルTRS → ワールド
    ensureAnchors();
    const a = anchors[which] || anchors.mouth;
    head.updateWorldMatrix(true, false);
    trs(_mm, a.pos, a.rotDeg);
    _mm.premultiply(head.matrixWorld);
    outPos.setFromMatrixPosition(_mm);
    if (outQuat) outQuat.setFromRotationMatrix(_mm);
    return outPos;
  }
  function mouthWorld(outPos, outQuat) { return anchorWorld('mouth', outPos, outQuat); }
  // 物のグリップ位置に手を合わせる時の「手のワールド行列」= objWorld × inverse(mainTRS)
  function handTargetFromObject(outPos, outQuat) {
    st.object.updateWorldMatrix(true, false);
    trs(_m, st.def.main?.pos, st.def.main?.rotDeg);
    _m2.copy(st.object.matrixWorld).multiply(_m.invert());
    outPos.setFromMatrixPosition(_m2);
    outQuat.setFromRotationMatrix(_m2);
  }
  // アンカー枠（食べ点/眺め点）に bite 枠が一致するときの手のワールド行列を逆算
  //   toolWorld = anchorWorld × biteTRS⁻¹ / handWorld = toolWorld × mainTRS⁻¹
  function handTargetFromMouth(outPos, outQuat, which) {
    anchorWorld(which || 'mouth', _v, _q);
    _m.compose(_v, _q, _v3.set(1, 1, 1));
    const bite = st.def.bite || { pos: [0, 0, 0], rotDeg: [0, 0, 0] };
    trs(_m2, bite.pos, bite.rotDeg);
    _m.multiply(_m2.invert());                                                // toolWorld
    trs(_m2, st.def.main?.pos, st.def.main?.rotDeg);
    _m.multiply(_m2.invert());                                                // handWorld
    outPos.setFromMatrixPosition(_m);
    outQuat.setFromRotationMatrix(_m);
  }

  function handTargetFromHome(outPos, outQuat) {
    trs(_m2, st.def.main?.pos, st.def.main?.rotDeg);
    _m.copy(st.home).multiply(_m2.invert());
    outPos.setFromMatrixPosition(_m);
    outQuat.setFromRotationMatrix(_m);
  }
  const _footL = new THREE.Vector3(), _footR = new THREE.Vector3(), _poleL = new THREE.Vector3(), _poleR = new THREE.Vector3();
  function posture(P, w, dt) {   // しゃがみ×前傾の自動配分（平滑化つき）
    const sh = nb(st.side + 'UpperArm');
    if (!sh || !hips) return;
    sh.getWorldPosition(_v);
    const dist = _v.distanceTo(P);
    const deficit = Math.max(0, dist - bake.armLen * 0.88);
    const floorY = vrm.scene.position.y;
    const low = Math.min(1, Math.max(0, (floorY + bake.kneeY - P.y) / Math.max(0.3, bake.kneeY) + 0.25));   // 床=1 / 腰高=0
    const crouchDes = Math.min(0.5, deficit * low * 1.7) * w;
    const leanDes = Math.min(0.95, deficit * (1 - low) * 2.4 / bake.torso + deficit * low * 0.5) * w;
    st.crouch += (crouchDes - st.crouch) * Math.min(1, dt * 5);
    st.lean += (leanDes - st.lean) * Math.min(1, dt * 5);
    if (st.crouch < 0.002 && st.lean < 0.01) return;
    // 足の接地位置を記録
    const fL = nb('leftFoot'), fR = nb('rightFoot');
    vrm.scene.updateMatrixWorld(true);
    if (fL) fL.getWorldPosition(_footL);
    if (fR) fR.getWorldPosition(_footR);
    const fwd = bodyFwdW(_v2);
    // しゃがみ=腰を下へ（少し前へ）/ 前傾のバランスで腰を少し後ろへ
    recPos(hips);
    hips.position.y -= st.crouch;
    const hShift = st.crouch * 0.18 - Math.sin(st.lean) * 0.13;
    _q.identity(); vrm.scene.getWorldQuaternion(_q).invert();
    _v3.copy(fwd).applyQuaternion(_q).multiplyScalar(hShift);   // ルートローカルへ
    hips.position.x += _v3.x; hips.position.z += _v3.z;
    // 前傾: spine/chest をワールド右軸まわりに回す
    if (st.lean > 0.01) {
      // 前傾軸: up×fwd（この軸まわりの正回転で胴体の上方向が fwd 側へ倒れる＝前屈）
      _v3.crossVectors(_up, fwd).normalize();
      for (const [bn, share] of [['spine', 0.55], ['chest', 0.45]]) {
        const b = nb(bn);
        if (!b) continue;
        recQuat(b);
        b.updateWorldMatrix(true, false);
        b.getWorldQuaternion(_q);
        _q2.setFromAxisAngle(_v3, st.lean * share);
        _q2.multiply(_q);
        b.parent.getWorldQuaternion(_q3);
        b.quaternion.copy(_q3.invert().multiply(_q2)).normalize();
      }
    }
    vrm.scene.updateMatrixWorld(true);
    // 脚IKで足を戻す（膝ヒント=前方）
    for (const [side, foot, pole] of [['left', _footL, _poleL], ['right', _footR, _poleR]]) {
      const lg = { root: nb(side + 'UpperLeg'), mid: nb(side + 'LowerLeg'), end: nb(side + 'Foot') };
      if (!lg.root || !lg.mid || !lg.end) continue;
      recQuat(lg.root); recQuat(lg.mid);
      pole.copy(foot).addScaledVector(fwd, 0.6); pole.y += 0.4;
      lg.poleVector = pole;
      const r = solveTwoBoneIK(lg, foot);
      if (r) { lg.root.quaternion.copy(r.rootQuat); lg.mid.quaternion.copy(r.midQuat); }
    }
  }

  const _ht = new THREE.Vector3(), _hq = new THREE.Quaternion(), _nat = new THREE.Vector3(), _natQ = new THREE.Quaternion(), _objP = new THREE.Vector3();
  const _pole = new THREE.Vector3(), _sideV = new THREE.Vector3();
  function armIK(P, Q, w) {
    const lb = limb(st.side);
    if (!lb.root || !lb.mid || !lb.end) return;
    vrm.scene.updateMatrixWorld(true);
    // 肘の向きヒント（体ローカル指定: x=体の外側+ / y=上下 / z=前後）
    // ※bodyFwdW は内部で _v を使うため、IK目標(_v)の計算より先に済ませる
    bodyFwdW(_v2);
    _sideV.crossVectors(_v2, _up).normalize();                    // 体の右方向
    if (st.side === 'left') _sideV.multiplyScalar(-1);
    const eh = prm().elbow;
    _pole.set(0, eh[1], 0).addScaledVector(_sideV, eh[0]).addScaledVector(_v2, eh[2]).normalize();
    lb.poleVector = _pole;
    recQuat(lb.root); recQuat(lb.mid); recQuat(lb.end);
    lb.end.getWorldPosition(_nat);
    _v.lerpVectors(_nat, P, w);
    const r = solveTwoBoneIK(lb, _v);
    if (r) { lb.root.quaternion.copy(r.rootQuat); lb.mid.quaternion.copy(r.midQuat); }
    st.lastP.copy(_v);
    // 手首の向き
    lb.end.updateWorldMatrix(true, false);
    lb.end.getWorldPosition(_nat);
    st.lastErr = _nat.distanceTo(_v);
    lb.end.getWorldQuaternion(_natQ);
    _q2.copy(_natQ).slerp(Q, w);
    lb.end.parent.getWorldQuaternion(_q3);
    lb.end.quaternion.copy(_q3.invert().multiply(_q2)).normalize();
  }
  function setViseme(v) {
    try { vrm.expressionManager?.setValue('aa', v); } catch { /* 表情なし */ }
  }

  function play(verb, params) {
    stop();
    paused = false;
    st.verb = verb === 'eatReturn' ? 'eat' : verb;
    st.returnAfter = verb === 'eatReturn' || !!params.returnAfter;
    st.object = params.object;
    params.object.updateWorldMatrix(true, false);
    st.home.copy(params.object.matrixWorld);
    st.def = params.def || { main: { bone: 'rightHand' } };
    st.side = (st.def.main?.bone || 'rightHand').startsWith('left') ? 'left' : 'right';
    st.onDone = params.onDone || null;
    st.keep = !!params.keep;
    st.biteMax = params.bites ?? st.def.verbs?.eat?.bites ?? 3;
    st.phase = 'reach'; st.t = 0; st.w = 0; st.bites = 0; st.biteT = 0;
    st.scale0 = st.object.scale.x;
    if (params.mouth) { mouth.fwd = params.mouth.fwd ?? mouth.fwd; mouth.up = params.mouth.up ?? mouth.up; }
  }
  function stop() {
    if (st.phase) setViseme(0);
    st.phase = null; st.crouch = 0; st.lean = 0;
    if (st.held) { st.held.release(); st.held = null; }
  }
  let paused = false;
  /** 概算の総時間（スクラブUI用） */
  function totalDur() {
    const pv = prm();
    const eatSec = (st.verb === 'eat') ? pv.biteCycle * st.biteMax : 0;
    const holdSec = (st.verb === 'inspect') ? pv.holdSec : 0;
    const ret = st.returnAfter ? 0.85 : 0;
    return pv.durReach + ((st.verb === 'pickup') ? 0 : pv.durBring) + eatSec + holdSec + ret + pv.durOut;
  }
  /** 先頭から t 秒まで再シミュレートして静止（タイムライン・スクラブ用） */
  function seek(tSec, replayParams) {
    if (!replayParams) return;
    play(replayParams.verbRaw, replayParams);
    const step = 1 / 60;
    let acc = 0;
    while (acc < tSec && st.phase) {
      if (replayParams.preTick) replayParams.preTick();   // ホストのポーズリセット等
      update(step);
      acc += step;
    }
    paused = true;
  }

  // ── 自己復元: 前フレームに自分が書いた値のまま（＝アニメが上書きしていない）なら適用前の値へ戻す。
  //    これによりアニメに該当トラックが無いボーンでも毎フレームの修正が積算しない。
  const _mods = [];   // {node, isPos, pre, post}
  function modsUndo() {
    for (const m of _mods) {
      if (m.isPos) {
        if (m.node.position.distanceToSquared(m.post) < 1e-8) m.node.position.copy(m.pre);
      } else if (m.node.quaternion.angleTo(m.post) < 1e-3) m.node.quaternion.copy(m.pre);
    }
    _mods.length = 0;
  }
  function recPos(node) { _mods.push({ node, isPos: true, pre: node.position.clone(), post: null }); return _mods[_mods.length - 1]; }
  function recQuat(node) { _mods.push({ node, isPos: false, pre: node.quaternion.clone(), post: null }); return _mods[_mods.length - 1]; }
  function sealMods() { for (const m of _mods) if (!m.post) m.post = m.isPos ? m.node.position.clone() : m.node.quaternion.clone(); }

  const _gq = new THREE.Quaternion(), _gv = new THREE.Vector3();
  function applyGrabBlend(dt) {   // 掴んだ瞬間のワープ防止: 直前姿勢→グリップ姿勢へ0.3秒で馴染ませる
    if (st.grabBlend <= 0 || !st.held) return;
    st.grabBlend = Math.max(0, st.grabBlend - dt / 0.3);
    const a = 1 - ease(1 - st.grabBlend);   // 1→0
    const o = st.held.obj;
    const mn = st.def.main || {};
    const r = mn.rotDeg || [0, 0, 0];
    _gv.fromArray(mn.pos || [0, 0, 0]);
    _gq.setFromEuler(_e.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180));
    o.position.lerpVectors(_gv, st.grabPos, a);
    o.quaternion.slerpQuaternions(_gq, st.grabQuat, a);
  }
  function update(dt) {
    if (!st.phase) return;
    if (paused) dt = 0;   // 一時停止中も現在時刻のIKを適用し続ける（スクラブ表示用）
    modsUndo();   // 前フレームの自分の修正を（アニメが上書きしていなければ）巻き戻す
    try { updateInner(dt); } finally { sealMods(); }
  }
  function updateInner(dt) {
    applyGrabBlend(dt);
    if (st.held) {   // 指の握り（掴みからの馴染みに同期。outでは弱める）
      const g0 = st.def.grip ?? 0.8;
      const ramp = 1 - st.grabBlend;
      const w2 = st.phase === 'out' ? st.w : 1;
      applyGrip(vrm, st.side, g0 * ramp * w2);
    }
    vrm.scene.updateMatrixWorld(true);
    const pv = prm();
    const D = { reach: pv.durReach, bring: pv.durBring, inspect: pv.holdSec, out: pv.durOut };
    if (st.phase === 'reach') {
      st.t += dt / D.reach;
      const e = ease(Math.min(1, st.t));
      st.w = e;
      handTargetFromObject(_ht, _hq);
      st.object.getWorldPosition(_objP);
      posture(_ht, e, dt);
      armIK(_ht, _hq, e);
      look.update(_objP, Math.min(1, e * 1.6));
      if (st.t >= 1) {
        st.object.updateWorldMatrix(true, false);
        _m.copy(st.object.matrixWorld);                       // 掴む直前のワールド姿勢
        st.held = holdTool(vrm, st.object, st.def);           // 掴む（以後は手の子）
        // スナップ防止: 直前姿勢を手ローカルへ変換して保持し、bring序盤でグリップ姿勢へブレンド
        const bone = st.object.parent;
        bone.updateWorldMatrix(true, false);
        _m2.copy(bone.matrixWorld).invert().multiply(_m);
        _m2.decompose(st.grabPos, st.grabQuat, _v3);          // grabPos/Quat=手ローカルの直前姿勢
        st.grabBlend = 1;
        st.phase = (st.verb === 'pickup') ? 'out' : 'bring';
        st.t = 0;
        captureHandFrom();
      }
      return;
    }
    if (st.phase === 'bring') {
      st.t += dt / D.bring;
      const e = ease(Math.min(1, st.t));
      handTargetFromMouth(_ht, _hq, st.verb === 'inspect' ? 'inspect' : 'mouth');
      _ht.lerpVectors(st.fromPos, _ht, e);          // 掴んだ位置→口元へ滑らかに
      _hq.slerpQuaternions(st.fromQuat, _hq, e);
      posture(_ht, 1, dt);
      armIK(_ht, _hq, 1);
      st.w = 1;
      st.object.getWorldPosition(_objP);
      look.update(_objP, 1);
      if (st.t >= 1) { st.phase = (st.verb === 'eat') ? 'eat' : 'hold'; st.t = 0; }
      return;
    }
    if (st.phase === 'hold') {   // 眺める
      if (!st.keep) st.t += dt / D.inspect;
      handTargetFromMouth(_ht, _hq, 'inspect');
      posture(_ht, 1, dt);
      armIK(_ht, _hq, 1);
      st.object.getWorldPosition(_objP);
      look.update(_objP, 1);
      if (st.t >= 1) { st.phase = 'out'; st.t = 0; captureHandFrom(); }
      return;
    }
    if (st.phase === 'eat') {
      handTargetFromMouth(_ht, _hq, 'mouth');
      posture(_ht, 1, dt);
      armIK(_ht, _hq, 1);
      st.object.getWorldPosition(_objP);
      look.update(_objP, 0.8);
      st.biteT += dt;
      const CY = pv.biteCycle;   // 1口の周期
      const u = (st.biteT % CY) / CY;
      setViseme(Math.pow(Math.sin(u * Math.PI), 1.4) * 0.9);
      if (st.biteT >= CY * (st.bites + 1)) {
        st.bites++;
        st.object.scale.setScalar(st.scale0 * Math.pow(pv.shrink, st.bites));   // 齧るたび縮む
        if (st.bites >= st.biteMax) {
          setViseme(0);
          if (st.returnAfter) {
            st.phase = 'return'; st.t = 0;
            captureHandFrom();
          } else {
            st.object.visible = false;
            if (st.held) st.held.release();
            st.phase = 'out'; st.t = 0;
            captureHandFrom();
          }
        }
      }
      return;
    }
    if (st.phase === 'return') {   // 元の置き場所へ運んで置く
      st.t += dt / 0.85;
      const e = ease(Math.min(1, st.t));
      handTargetFromHome(_ht, _hq);
      _ht.lerpVectors(st.fromPos, _ht, e);
      _hq.slerpQuaternions(st.fromQuat, _hq, e);
      posture(_ht, 1, dt);
      armIK(_ht, _hq, 1);
      st.object.getWorldPosition(_objP);
      look.update(_objP, 1);
      if (st.t >= 1) {
        if (st.held) st.held.release();
        const parent = vrm.scene.parent || vrm.scene;   // シーンへ戻し、元のワールド姿勢に置く
        parent.add(st.object);
        st.home.decompose(_v, _q, _v2);
        st.object.position.copy(_v);
        st.object.quaternion.copy(_q);
        st.object.updateMatrixWorld(true);
        st.held = null;
        st.phase = 'out'; st.t = 0;
        captureHandFrom();
      }
      return;
    }
    if (st.phase === 'out') {   // 保持していた姿勢から、ゆっくりIKを抜いて元のアニメへ
      st.t += dt / D.out;
      st.w = Math.max(0, 1 - ease(Math.min(1, st.t)));
      if (st.w > 0.01) {
        posture(st.fromPos, st.w, dt);
        armIK(st.fromPos, st.fromQuat, st.w);   // out開始時の手の姿勢 → 自然な姿勢へブレンド
      }
      setViseme(0);
      if (st.t >= 1) {
        if (st.held && st.verb === 'inspect') {   // 読み終えた物はその場で手放す（手を武器等に戻せるように）
          st.object.updateWorldMatrix(true, false);
          _m.copy(st.object.matrixWorld);
          st.held.release();
          const parent = vrm.scene.parent || vrm.scene;
          parent.add(st.object);
          _m.decompose(_v, _q, _v2);
          st.object.position.copy(_v);
          st.object.quaternion.copy(_q);
          st.held = null;
        }
        const held = st.held;
        st.phase = null; st.crouch = 0; st.lean = 0;
        if (st.onDone) st.onDone(held);
      }
    }
  }

  ensureAnchors();
  return {
    play, stop, update, mouthWorld, anchors, anchorWorld,
    get mouth() { ensureAnchors(); return anchors.mouth; },
    get debug() { return { target: st.lastP, err: st.lastErr }; },
    /** keep保持中のholdを終了して腕を返す（物は手に持ったまま） */
    finish() {
      if (st.phase === 'hold' || st.phase === 'eat') { st.phase = 'out'; st.t = 0; st.keep = false; captureHandFrom(); }
    },
    get paused() { return paused; },
    set paused(v) { paused = !!v; },
    totalDur, seek, prm,
    get active() { return !!st.phase; },
    get phase() { return st.phase; },
    get held() { return st.held; },
  };
}
