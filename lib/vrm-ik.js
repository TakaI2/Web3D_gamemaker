// vrm-ik.js — 解析的 2-bone IK（AnimEditor の src/core/TwoBoneIK.ts を独立ESMへ移植）。
// ボーンの rest 向きに依存せず「現在方向→目標方向」の差分回転で解く。肘の逆曲がりは poleVector で防止。
// 使い方: solveTwoBoneIK({root, mid, end, poleVector?}, targetWorld) → {rootQuat, midQuat}（各ボーンの新ローカル回転）
import * as THREE from 'https://esm.sh/three@0.184.0';

const EPS = 1e-6;
const _v = () => new THREE.Vector3();
const _q = () => new THREE.Quaternion();

export function solveTwoBoneIK(chain, targetWorld) {
  const { root, mid, end } = chain;
  const rootW = root.getWorldPosition(_v());
  const midW = mid.getWorldPosition(_v());
  const endW = end.getWorldPosition(_v());

  const a = rootW.distanceTo(midW);   // root→mid 長
  const b = midW.distanceTo(endW);    // mid→end 長

  const toTarget = _v().subVectors(targetWorld, rootW);
  const dist = toTarget.length();
  if (dist < EPS || a < EPS || b < EPS) {
    return { rootQuat: root.quaternion.clone(), midQuat: mid.quaternion.clone() };
  }
  const c = Math.min(Math.max(dist, Math.abs(a - b) + EPS), a + b - EPS);   // 到達可能距離にクランプ
  const toTargetDir = toTarget.clone().normalize();

  const rootToMid = _v().subVectors(midW, rootW);
  const midToEnd = _v().subVectors(endW, midW);

  // 曲げ方向(bendDir)。poleVector を最優先（逆曲がり防止）。
  let bendDir = null;
  if (chain.poleVector && chain.poleVector.lengthSq() > EPS) {
    const p = chain.poleVector.clone();
    p.addScaledVector(toTargetDir, -p.dot(toTargetDir));   // toTargetDir 成分を除去（直交化）
    if (p.lengthSq() > EPS) bendDir = p.normalize();
  }
  if (!bendDir) {
    const axis = _v().crossVectors(rootToMid, midToEnd);
    if (axis.lengthSq() < EPS) {
      axis.crossVectors(toTargetDir, new THREE.Vector3(0, 0, 1));
      if (axis.lengthSq() < EPS) axis.crossVectors(toTargetDir, new THREE.Vector3(0, 1, 0));
    }
    axis.normalize();
    bendDir = _v().crossVectors(axis, toTargetDir).normalize();
    if (bendDir.dot(rootToMid) < 0) bendDir.negate();
  }

  // 余弦定理：root→target 線に対する root の開き角
  const cosRoot = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const angRoot = Math.acos(cosRoot);

  const newMidW = rootW.clone().addScaledVector(toTargetDir, a * Math.cos(angRoot)).addScaledVector(bendDir, a * Math.sin(angRoot));
  const clampTarget = rootW.clone().addScaledVector(toTargetDir, c);

  const rootQW = root.getWorldQuaternion(_q());
  const midQW = mid.getWorldQuaternion(_q());

  const qRootDelta = _q().setFromUnitVectors(rootToMid.clone().normalize(), newMidW.clone().sub(rootW).normalize());
  const newRootQW = qRootDelta.clone().multiply(rootQW);

  const curMidDirAfterRoot = midToEnd.clone().normalize().applyQuaternion(qRootDelta);
  const desMidDir = clampTarget.clone().sub(newMidW).normalize();
  const qMidDelta = _q().setFromUnitVectors(curMidDirAfterRoot, desMidDir);
  const newMidQW = qMidDelta.clone().multiply(qRootDelta).multiply(midQW);

  const rootParentQW = root.parent ? root.parent.getWorldQuaternion(_q()) : _q();
  const rootQuat = rootParentQW.clone().invert().multiply(newRootQW);
  const midQuat = newRootQW.clone().invert().multiply(newMidQW);

  return { rootQuat, midQuat };
}
