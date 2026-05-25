import { describe, it, expect } from 'vitest';
import { FPS_CONSTANTS as C } from './FpsConstants';

describe('FpsConstants', () => {
  it('GRAVITY is 30', () => {
    expect(C.GRAVITY).toBe(30);
  });
  it('STEPS_PER_FRAME is 5', () => {
    expect(C.STEPS_PER_FRAME).toBe(5);
  });
  it('NUM_SPHERES is 100', () => {
    expect(C.NUM_SPHERES).toBe(100);
  });
  it('SPHERE_RADIUS is 0.2', () => {
    expect(C.SPHERE_RADIUS).toBe(0.2);
  });
  it('PLAYER_CAPSULE_RADIUS is 0.35', () => {
    expect(C.PLAYER_CAPSULE_RADIUS).toBe(0.35);
  });
  it('RESPAWN_Y_THRESHOLD is -25', () => {
    expect(C.RESPAWN_Y_THRESHOLD).toBe(-25);
  });
  it('max throw impulse is THROW_BASE_IMPULSE + THROW_MAX_EXTRA_IMPULSE = 45', () => {
    expect(C.THROW_BASE_IMPULSE + C.THROW_MAX_EXTRA_IMPULSE).toBe(45);
  });
});

describe('Throw impulse calculation', () => {
  function calcImpulse(msDiff: number): number {
    return C.THROW_BASE_IMPULSE + C.THROW_MAX_EXTRA_IMPULSE * (1 - Math.exp(-msDiff * 0.001));
  }

  it('instant click gives base impulse', () => {
    expect(calcImpulse(0)).toBeCloseTo(15, 5);
  });
  it('1 second gives ~33.96', () => {
    expect(calcImpulse(1000)).toBeCloseTo(15 + 30 * (1 - Math.exp(-1)), 3);
  });
  it('10 seconds approaches max (< 45)', () => {
    const v = calcImpulse(10000);
    expect(v).toBeLessThan(45);
    expect(v).toBeGreaterThan(44);
  });
  it('impulse is always less than max', () => {
    for (const ms of [0, 500, 1000, 5000, 100000]) {
      expect(calcImpulse(ms)).toBeLessThanOrEqual(45);
    }
  });
});

describe('appModeStore FPS', () => {
  it('toFps sets mode to fps', async () => {
    const { appModeStore } = await import('../stores/appModeStore');
    const { get } = await import('svelte/store');
    appModeStore.toFps();
    expect(get(appModeStore)).toBe('fps');
  });
  it('toEditor returns to editor', async () => {
    const { appModeStore } = await import('../stores/appModeStore');
    const { get } = await import('svelte/store');
    appModeStore.toFps();
    appModeStore.toEditor();
    expect(get(appModeStore)).toBe('editor');
  });
});
