import * as THREE from 'three';

export type TwoBoneIKChain = {
  readonly root: THREE.Bone;       // UpperArm / UpperLeg
  readonly mid: THREE.Bone;        // LowerArm / LowerLeg
  readonly end: THREE.Bone;        // Hand / Foot
  readonly poleVector?: THREE.Vector3; // 膝・肘の曲がる方向ヒント（ワールド空間）
};

export type TwoBoneIKResult = {
  readonly rootQuat: THREE.Quaternion; // root ボーンの新しいローカル回転
  readonly midQuat: THREE.Quaternion;  // mid ボーンの新しいローカル回転
};

const _rootWorld = new THREE.Vector3();
const _midWorld = new THREE.Vector3();
const _endWorld = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _plane = new THREE.Vector3();
const _bendAxis = new THREE.Vector3();
const _parentWorldQuat = new THREE.Quaternion();
const _parentWorldQuatInv = new THREE.Quaternion();

/**
 * 解析的 2-bone IK ソルバー（余弦定理）。
 * root→mid→end の 3 ボーンチェーンを targetWorld に向けて解く。
 * 戻り値は root と mid のローカル回転クォータニオン。
 */
export function solveTwoBoneIK(
  chain: TwoBoneIKChain,
  targetWorld: THREE.Vector3,
): TwoBoneIKResult {
  const { root, mid, end } = chain;

  // ワールド位置を取得
  root.getWorldPosition(_rootWorld);
  mid.getWorldPosition(_midWorld);
  end.getWorldPosition(_endWorld);

  // ボーン長
  const L1 = _rootWorld.distanceTo(_midWorld);
  const L2 = _midWorld.distanceTo(_endWorld);
  const L1L2 = L1 + L2;

  // 目標距離（クランプ）
  _toTarget.subVectors(targetWorld, _rootWorld);
  const d = Math.max(Math.abs(L1 - L2) + 1e-4, Math.min(_toTarget.length(), L1L2 - 1e-4));
  _toTarget.normalize();

  // ポールベクトル: mid の曲がる平面を決める
  let pole: THREE.Vector3;
  if (chain.poleVector) {
    pole = chain.poleVector;
  } else {
    // デフォルト: 現在の mid 位置を参照
    pole = _midWorld.clone().sub(_rootWorld).normalize();
    // 退化ケース対応: toTarget と同方向ならデフォルト UP を使う
    if (Math.abs(pole.dot(_toTarget)) > 0.99) {
      pole = new THREE.Vector3(0, 1, 0);
      if (Math.abs(pole.dot(_toTarget)) > 0.99) pole.set(1, 0, 0);
    }
  }

  // 屈曲平面の法線: _toTarget × pole
  _plane.crossVectors(_toTarget, pole).normalize();
  // mid が曲がる方向（bend axis）: plane × _toTarget
  _bendAxis.crossVectors(_plane, _toTarget).normalize();

  // 余弦定理で root の angle（root→targetに対するmid屈曲前の root 角度）
  // cos(α) = (L1² + d² - L2²) / (2 * L1 * d)
  const cosAlpha = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const alpha = Math.acos(cosAlpha);

  // 余弦定理で mid の angle
  // cos(β) = (L1² + L2² - d²) / (2 * L1 * L2)
  const cosBeta = Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));
  const beta = Math.acos(cosBeta);

  // ---- root の新しいワールド回転を計算 ----
  // 1. _toTarget 方向を向く回転
  // 2. alpha 分だけ bendAxis 周りに傾ける

  // _toTarget を向く基底クォータニオン
  const refDir = new THREE.Vector3(0, 1, 0);
  if (Math.abs(refDir.dot(_toTarget)) > 0.99) refDir.set(1, 0, 0);

  const rootWorldQuat = new THREE.Quaternion().setFromUnitVectors(refDir, _toTarget);

  // bendAxis 周りに alpha 傾ける（ワールド空間の bend axis をローカル化）
  const bendAxisLocal = _bendAxis.clone().applyQuaternion(rootWorldQuat.clone().invert());
  const tiltQuat = new THREE.Quaternion().setFromAxisAngle(bendAxisLocal, alpha);
  rootWorldQuat.multiply(tiltQuat);

  // ---- mid の新しいワールド回転 ----
  // T-pose 基準: mid は root と同じ方向から (PI - beta) だけ屈曲
  const midWorldQuat = rootWorldQuat.clone();
  const midTilt = new THREE.Quaternion().setFromAxisAngle(
    _bendAxis.clone().applyQuaternion(midWorldQuat.clone().invert()),
    -(Math.PI - beta),
  );
  midWorldQuat.multiply(midTilt);

  // ---- ワールド回転 → ローカル回転に変換 ----
  function worldToLocal(bone: THREE.Bone, worldQuat: THREE.Quaternion): THREE.Quaternion {
    if (bone.parent) {
      bone.parent.getWorldQuaternion(_parentWorldQuat);
      _parentWorldQuatInv.copy(_parentWorldQuat).invert();
      return worldQuat.clone().premultiply(_parentWorldQuatInv);
    }
    return worldQuat.clone();
  }

  return {
    rootQuat: worldToLocal(root, rootWorldQuat),
    midQuat: worldToLocal(mid, midWorldQuat),
  };
}
