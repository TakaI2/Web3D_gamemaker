import { describe, it, expect } from 'vitest';
import { snapToGrid } from './snapToGrid';

describe('snapToGrid', () => {
  // T301
  it('snap=1, ちょうど整数', () => {
    expect(snapToGrid(3.0, 1)).toBe(3);
  });

  // T302
  it('snap=1, 切り上げ', () => {
    expect(snapToGrid(3.6, 1)).toBe(4);
  });

  // T303
  it('snap=1, 切り捨て', () => {
    expect(snapToGrid(3.4, 1)).toBe(3);
  });

  // T304
  it('snap=2, 奇数は偶数に丸める', () => {
    expect(snapToGrid(3.0, 2)).toBe(4);
  });

  // T305
  it('snap=0.5, 小数', () => {
    expect(snapToGrid(1.3, 0.5)).toBe(1.5);
  });

  // T306
  it('snap=4, 負の値', () => {
    expect(snapToGrid(-3.0, 4)).toBe(-4);
  });

  // T307
  it('snap=1, ゼロ', () => {
    expect(snapToGrid(0.0, 1)).toBe(0);
  });

  // T308: -1.1 は 0(距離1.1) より -2(距離0.9) に近いので -2 が正しい
  it('snap=2, 負の小数 -1.1 は -2 に丸める', () => {
    expect(snapToGrid(-1.1, 2)).toBe(-2);
  });
});
