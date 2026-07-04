/**
 * SpineIK.ts
 * 背骨（腰→頭）の多ボーン CCD IK。腰(hips)は固定の起点とし、
 * chain（腰側→首側のボーン群）の回転を更新してエンドエフェクタ(head)を target へ近づける。
 * raw ボーンのローカル回転を直接書き換える（AnimEditor は raw 空間でポーズを保持しているため）。
 */
import * as THREE from 'three';

const _bonePos = new THREE.Vector3();
const _endPos = new THREE.Vector3();
const _toEnd = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _qStep = new THREE.Quaternion();
const _boneWorldQ = new THREE.Quaternion();
const _parentWorldQ = new THREE.Quaternion();
const _newWorldQ = new THREE.Quaternion();

export type SpineIKOptions = {
  readonly iterations?: number;   // CCD 反復回数
  readonly maxStepDeg?: number;   // 1ボーン1反復あたりの最大回転角（揺れ/暴れ防止）
};

/**
 * CCD で chain を回し、end を targetWorld へ近づける。chain[0]=腰側, chain[last]=首側。
 * 各ボーンの bone.quaternion（ローカル）を書き換える。
 */
export function solveSpineIK(
  chain: THREE.Object3D[],
  end: THREE.Object3D,
  targetWorld: THREE.Vector3,
  opts: SpineIKOptions = {},
): void {
  if (chain.length === 0) return;
  const iterations = opts.iterations ?? 10;
  const maxStep = (opts.maxStepDeg ?? 12) * Math.PI / 180;

  for (let it = 0; it < iterations; it++) {
    // 首側 → 腰側 の順（CCD）
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      bone.updateWorldMatrix(true, false);
      end.updateWorldMatrix(true, false);
      bone.getWorldPosition(_bonePos);
      end.getWorldPosition(_endPos);
      _toEnd.copy(_endPos).sub(_bonePos);
      _toTarget.copy(targetWorld).sub(_bonePos);
      if (_toEnd.lengthSq() < 1e-10 || _toTarget.lengthSq() < 1e-10) continue;
      _toEnd.normalize();
      _toTarget.normalize();
      let angle = Math.acos(THREE.MathUtils.clamp(_toEnd.dot(_toTarget), -1, 1));
      if (angle < 1e-5) continue;
      if (angle > maxStep) angle = maxStep;
      _axis.crossVectors(_toEnd, _toTarget);
      if (_axis.lengthSq() < 1e-12) continue;
      _axis.normalize();
      // ワールド軸回りの回転をボーンのローカル回転へ変換して適用
      _qStep.setFromAxisAngle(_axis, angle);
      bone.getWorldQuaternion(_boneWorldQ);
      if (bone.parent) bone.parent.getWorldQuaternion(_parentWorldQ); else _parentWorldQ.identity();
      _newWorldQ.copy(_qStep).multiply(_boneWorldQ);                  // newWorld = step * boneWorld
      bone.quaternion.copy(_parentWorldQ.invert().multiply(_newWorldQ)); // local = parentWorld^-1 * newWorld
    }
  }
}
