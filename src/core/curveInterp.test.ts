import { describe, it, expect } from 'vitest';
import { autoTangent, resolveAutoKeys, sampleCurve, type CurveKey } from './curveInterp';

const flat = (f: number, v: number): CurveKey => ({ f, v, inT: 0, outT: 0 });

describe('curveInterp', () => {
  it('CI-01: キー上では厳密に値を返す', () => {
    const keys = resolveAutoKeys([{ f: 0, v: 1 }, { f: 10, v: 5 }, { f: 20, v: 2 }]);
    expect(sampleCurve(keys, 0)).toBeCloseTo(1, 6);
    expect(sampleCurve(keys, 10)).toBeCloseTo(5, 6);
    expect(sampleCurve(keys, 20)).toBeCloseTo(2, 6);
  });

  it('CI-02: 範囲外はクランプ', () => {
    const keys = resolveAutoKeys([{ f: 5, v: 3 }, { f: 15, v: 7 }]);
    expect(sampleCurve(keys, -100)).toBe(3);
    expect(sampleCurve(keys, 999)).toBe(7);
  });

  it('CI-03: 同値フラット区間は途中も同値（タンジェント0）', () => {
    const keys = [flat(0, 4), flat(30, 4)];
    expect(sampleCurve(keys, 15)).toBeCloseTo(4, 6);
  });

  it('CI-04: フラットタンジェントの中点は線形補間ではなく S 字（Hermite）で中央値', () => {
    // inT=outT=0 の2キーは ease-in-out。中点は (v0+v1)/2 になる（h00=h01=0.5, h10=h11 が対称）
    const keys = [flat(0, 0), flat(10, 10)];
    expect(sampleCurve(keys, 5)).toBeCloseTo(5, 6);
    // ease なので 1/4 地点は線形(2.5)より下
    expect(sampleCurve(keys, 2.5)).toBeLessThan(2.5);
  });

  it('CI-05: 単調増加キーで区間内は端点の間に収まる', () => {
    const keys = resolveAutoKeys([{ f: 0, v: 0 }, { f: 10, v: 10 }, { f: 20, v: 20 }]);
    const v = sampleCurve(keys, 5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(10);
  });

  it('CI-06: autoTangent は中心差分スロープ（値/フレーム）', () => {
    // vPrev=0@f0, vNext=4@f4 → (4-0)/(4-0)=1
    expect(autoTangent(0, 4, 0, 4)).toBeCloseTo(1, 6);
    // 前後同値（0,0）はスロープ0
    expect(autoTangent(0, 0, 0, 2)).toBeCloseTo(0, 6);
  });

  it('CI-07: 空/単一キー', () => {
    expect(sampleCurve([], 5)).toBe(0);
    expect(sampleCurve(resolveAutoKeys([{ f: 3, v: 9 }]), 100)).toBe(9);
  });

  it('CI-08: 明示タンジェントで傾きが反映される（出だしの傾き）', () => {
    // outT を大きくすると区間序盤で急に立ち上がる
    const gentle: CurveKey[] = [{ f: 0, v: 0, inT: 0, outT: 0 }, { f: 10, v: 10, inT: 0, outT: 0 }];
    const steep: CurveKey[] = [{ f: 0, v: 0, inT: 0, outT: 2 }, { f: 10, v: 10, inT: 0, outT: 0 }];
    expect(sampleCurve(steep, 2)).toBeGreaterThan(sampleCurve(gentle, 2));
  });
});
