import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { solveTwoBoneIK } from './TwoBoneIK';
import type { TwoBoneIKChain } from './TwoBoneIK';

/** テスト用の 3 ボーンチェーンを構築（各ボーンはシーンに追加済み） */
function buildChain(
  rootPos: THREE.Vector3,
  L1: number,
  L2: number,
  poleVector?: THREE.Vector3,
): TwoBoneIKChain {
  const root = new THREE.Bone();
  const mid  = new THREE.Bone();
  const end  = new THREE.Bone();

  root.position.copy(rootPos);
  // mid は root から +Y に L1
  mid.position.set(0, L1, 0);
  // end は mid から +Y に L2
  end.position.set(0, L2, 0);

  root.add(mid);
  mid.add(end);

  // ワールド行列を更新
  root.updateWorldMatrix(false, true);

  return { root, mid, end, poleVector };
}

describe('TwoBoneIK', () => {
  it('IK-01: 完全伸展 - target がチェーン最大長の場合エラーなし', () => {
    const L1 = 1, L2 = 1;
    const chain = buildChain(new THREE.Vector3(0, 0, 0), L1, L2);
    const target = new THREE.Vector3(0, L1 + L2 - 0.01, 0);
    expect(() => solveTwoBoneIK(chain, target)).not.toThrow();
    const result = solveTwoBoneIK(chain, target);
    expect(result.rootQuat).toBeInstanceOf(THREE.Quaternion);
    expect(result.midQuat).toBeInstanceOf(THREE.Quaternion);
  });

  it('IK-02: 結果クォータニオンが正規化されている', () => {
    const chain = buildChain(new THREE.Vector3(0, 0, 0), 1, 1);
    const target = new THREE.Vector3(1, 0, 0);
    const { rootQuat, midQuat } = solveTwoBoneIK(chain, target);
    expect(rootQuat.length()).toBeCloseTo(1, 3);
    expect(midQuat.length()).toBeCloseTo(1, 3);
  });

  it('IK-03: 届かない距離 - エラーなし', () => {
    const chain = buildChain(new THREE.Vector3(0, 0, 0), 1, 1);
    const target = new THREE.Vector3(0, 100, 0); // 遠すぎる
    expect(() => solveTwoBoneIK(chain, target)).not.toThrow();
  });

  it('IK-04: 近すぎる距離 - エラーなし', () => {
    const chain = buildChain(new THREE.Vector3(0, 0, 0), 1, 1);
    const target = new THREE.Vector3(0, 0, 0); // root と同じ位置
    expect(() => solveTwoBoneIK(chain, target)).not.toThrow();
  });

  it('IK-05: ポールベクトルが結果に影響する', () => {
    const L1 = 1, L2 = 1;
    const chain1 = buildChain(new THREE.Vector3(0, 0, 0), L1, L2, new THREE.Vector3(0, 0, 1));
    const chain2 = buildChain(new THREE.Vector3(0, 0, 0), L1, L2, new THREE.Vector3(0, 0, -1));
    const target = new THREE.Vector3(1, 0, 0);
    const r1 = solveTwoBoneIK(chain1, target);
    const r2 = solveTwoBoneIK(chain2, target);
    // ポールベクトルが異なれば mid の回転も異なるはず
    const diff = Math.abs(r1.midQuat.dot(r2.midQuat));
    expect(diff).toBeLessThan(0.999); // 完全に同一ではない
  });

  it('IK-06: 戻り値の型が正しい', () => {
    const chain = buildChain(new THREE.Vector3(0, 0, 0), 1, 1);
    const result = solveTwoBoneIK(chain, new THREE.Vector3(0.5, 0.5, 0));
    expect(result).toHaveProperty('rootQuat');
    expect(result).toHaveProperty('midQuat');
    expect(result.rootQuat).toBeInstanceOf(THREE.Quaternion);
    expect(result.midQuat).toBeInstanceOf(THREE.Quaternion);
  });
});
