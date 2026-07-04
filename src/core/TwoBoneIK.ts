import * as THREE from 'three';

export type TwoBoneIKChain = {
  readonly root: THREE.Bone;             // UpperArm / UpperLeg
  readonly mid: THREE.Bone;              // LowerArm / LowerLeg
  readonly end: THREE.Bone;              // Hand / Foot
  readonly poleVector?: THREE.Vector3;   // 肘/膝の曲がる向きヒント（root からのワールド方向）。手足が直線のときに使用
};

export type TwoBoneIKResult = {
  readonly rootQuat: THREE.Quaternion;   // root の新しいローカル回転
  readonly midQuat: THREE.Quaternion;    // mid の新しいローカル回転
};

const EPS = 1e-6;

/**
 * 解析的 2-bone IK（位置再構築方式）。
 *
 * 設計方針（Blender の IK に近い挙動）:
 * - ボーンの rest 向き（VRMごとにバラバラ）に依存しないよう、固定参照軸ではなく
 *   「現在のボーン方向 → 目標方向」の差分回転（setFromUnitVectors）で解く。
 * - 曲がる平面は「現在の手足平面（root-mid-end の法線）」を維持 → 自然な曲がり方。
 *   手足が直線で平面が定まらない場合のみ poleVector / フォールバックを使う。
 * - mid のローカル回転は「新しい root のワールド回転」を親として算出（root を動かす影響を考慮）。
 */
export function solveTwoBoneIK(chain: TwoBoneIKChain, targetWorld: THREE.Vector3): TwoBoneIKResult {
  const { root, mid, end } = chain;

  const rootW = root.getWorldPosition(new THREE.Vector3());
  const midW = mid.getWorldPosition(new THREE.Vector3());
  const endW = end.getWorldPosition(new THREE.Vector3());

  const a = rootW.distanceTo(midW);     // root→mid 長
  const b = midW.distanceTo(endW);      // mid→end 長

  const toTarget = new THREE.Vector3().subVectors(targetWorld, rootW);
  const dist = toTarget.length();
  if (dist < EPS || a < EPS || b < EPS) {
    return { rootQuat: root.quaternion.clone(), midQuat: mid.quaternion.clone() };
  }
  const c = Math.min(Math.max(dist, Math.abs(a - b) + EPS), a + b - EPS);   // 到達可能距離にクランプ
  const toTargetDir = toTarget.clone().normalize();

  const rootToMid = new THREE.Vector3().subVectors(midW, rootW);
  const midToEnd = new THREE.Vector3().subVectors(endW, midW);

  // 「肘/膝の出る方向」(bendDir) を決める。逆曲がり防止のため poleVector を最優先で使う。
  // poleVector を toTargetDir に直交化したものが曲げ方向。掴んだ時点で固定されるため、
  // 手足が真っ直ぐを通過しても曲げ側が反転しない（ヒンジ制限のような挙動）。
  let bendDir: THREE.Vector3 | null = null;
  if (chain.poleVector && chain.poleVector.lengthSq() > EPS) {
    const p = chain.poleVector.clone();
    p.addScaledVector(toTargetDir, -p.dot(toTargetDir));   // toTargetDir 成分を除去（直交化）
    if (p.lengthSq() > EPS) bendDir = p.normalize();
  }
  if (!bendDir) {
    // pole 無し: 現在の手足平面から。直線なら適当な直交軸へフォールバック。
    const axis = new THREE.Vector3().crossVectors(rootToMid, midToEnd);
    if (axis.lengthSq() < EPS) {
      axis.crossVectors(toTargetDir, new THREE.Vector3(0, 0, 1));
      if (axis.lengthSq() < EPS) axis.crossVectors(toTargetDir, new THREE.Vector3(0, 1, 0));
    }
    axis.normalize();
    bendDir = new THREE.Vector3().crossVectors(axis, toTargetDir).normalize();
    if (bendDir.dot(rootToMid) < 0) bendDir.negate();
  }

  // 余弦定理：root→target 線に対する root の開き角
  const cosRoot = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const angRoot = Math.acos(cosRoot);

  // 再構築した mid / target 位置（ワールド）
  const newMidW = rootW.clone()
    .addScaledVector(toTargetDir, a * Math.cos(angRoot))
    .addScaledVector(bendDir, a * Math.sin(angRoot));
  const clampTarget = rootW.clone().addScaledVector(toTargetDir, c);

  // 現在のワールド回転
  const rootQW = root.getWorldQuaternion(new THREE.Quaternion());
  const midQW = mid.getWorldQuaternion(new THREE.Quaternion());

  // root: 現在の root方向(rootToMid) → 新しい mid 方向 への差分
  const qRootDelta = new THREE.Quaternion().setFromUnitVectors(
    rootToMid.clone().normalize(),
    newMidW.clone().sub(rootW).normalize(),
  );
  const newRootQW = qRootDelta.clone().multiply(rootQW);

  // mid: root を回した後の mid方向 → 新しい end 方向 への差分
  const curMidDirAfterRoot = midToEnd.clone().normalize().applyQuaternion(qRootDelta);
  const desMidDir = clampTarget.clone().sub(newMidW).normalize();
  const qMidDelta = new THREE.Quaternion().setFromUnitVectors(curMidDirAfterRoot, desMidDir);
  const newMidQW = qMidDelta.clone().multiply(qRootDelta).multiply(midQW);

  // ワールド → ローカル（mid の親は root の「新しい」ワールド回転）
  const rootParentQW = root.parent
    ? root.parent.getWorldQuaternion(new THREE.Quaternion())
    : new THREE.Quaternion();
  const rootQuat = rootParentQW.clone().invert().multiply(newRootQW);
  const midQuat = newRootQW.clone().invert().multiply(newMidQW);

  return { rootQuat, midQuat };
}
