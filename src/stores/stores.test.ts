import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { vrmStore } from './vrmStore';
import { animationStore } from './animationStore';
import { xrStore } from './xrStore';
import { lipSyncStore } from './lipSyncStore';
import type { AppError, AnimationEntry } from '../types';
import * as THREE from 'three';

// ---- vrmStore ----
describe('vrmStore', () => {
  beforeEach(() => vrmStore.reset());

  it('初期状態が正しい', () => {
    const s = get(vrmStore);
    expect(s.vrm).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('setLoading が loading を true にし error をリセットする', () => {
    vrmStore.setLoading(true);
    const s = get(vrmStore);
    expect(s.loading).toBe(true);
    expect(s.error).toBeNull();
  });

  it('setError でエラーがセットされ loading が false になる', () => {
    vrmStore.setLoading(true);
    const err: AppError = { type: 'load', message: 'test error' };
    vrmStore.setError(err);
    const s = get(vrmStore);
    expect(s.error).toEqual(err);
    expect(s.loading).toBe(false);
  });

  it('reset で初期状態に戻る', () => {
    vrmStore.setLoading(true);
    vrmStore.reset();
    const s = get(vrmStore);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});

// ---- animationStore ----
describe('animationStore', () => {
  beforeEach(() => animationStore.resetAnimations());

  const makeEntry = (name: string): AnimationEntry => ({
    name,
    clip: new THREE.AnimationClip(name, 1.0, []),
    duration: 1.0,
  });

  it('初期状態が正しい', () => {
    const s = get(animationStore);
    expect(s.animations).toHaveLength(0);
    expect(s.currentName).toBeNull();
    expect(s.isPlaying).toBe(false);
    expect(s.isLooping).toBe(true);
    expect(s.speed).toBe(1.0);
    expect(s.progress).toBe(0);
  });

  it('addAnimation でアニメーションが追加される', () => {
    animationStore.addAnimation(makeEntry('walk'));
    expect(get(animationStore).animations).toHaveLength(1);
  });

  it('removeAnimation で指定アニメーションが削除される', () => {
    animationStore.addAnimation(makeEntry('walk'));
    animationStore.addAnimation(makeEntry('run'));
    animationStore.removeAnimation('walk');
    const s = get(animationStore);
    expect(s.animations).toHaveLength(1);
    expect(s.animations[0].name).toBe('run');
  });

  it('removeAnimation で現在選択中のアニメーションを削除すると currentName が null になる', () => {
    animationStore.addAnimation(makeEntry('walk'));
    animationStore.selectAnimation('walk');
    animationStore.removeAnimation('walk');
    expect(get(animationStore).currentName).toBeNull();
  });

  it('setPlaying で isPlaying が変わる', () => {
    animationStore.setPlaying(true);
    expect(get(animationStore).isPlaying).toBe(true);
    animationStore.setPlaying(false);
    expect(get(animationStore).isPlaying).toBe(false);
  });

  it('setSpeed で speed が変わる', () => {
    animationStore.setSpeed(0.5);
    expect(get(animationStore).speed).toBe(0.5);
  });

  it('setProgress で progress が変わる', () => {
    animationStore.setProgress(0.75);
    expect(get(animationStore).progress).toBe(0.75);
  });
});

// ---- xrStore ----
describe('xrStore', () => {
  beforeEach(() => xrStore.reset());

  it('初期状態が正しい', () => {
    const s = get(xrStore);
    expect(s.support.vr).toBe(false);
    expect(s.support.ar).toBe(false);
    expect(s.isActive).toBe(false);
    expect(s.activeMode).toBeNull();
    expect(s.error).toBeNull();
  });

  it('setSupport でサポート状態が更新される', () => {
    xrStore.setSupport({ vr: true, ar: false });
    expect(get(xrStore).support.vr).toBe(true);
    expect(get(xrStore).support.ar).toBe(false);
  });

  it('setActive で isActive が true になり mode が設定される', () => {
    xrStore.setActive('vr');
    const s = get(xrStore);
    expect(s.isActive).toBe(true);
    expect(s.activeMode).toBe('vr');
    expect(s.error).toBeNull();
  });

  it('setInactive で isActive が false になる', () => {
    xrStore.setActive('vr');
    xrStore.setInactive();
    const s = get(xrStore);
    expect(s.isActive).toBe(false);
    expect(s.activeMode).toBeNull();
  });

  it('setError でエラーがセットされ isActive が false になる', () => {
    xrStore.setActive('ar');
    const err: AppError = { type: 'xr', message: 'session failed' };
    xrStore.setError(err);
    const s = get(xrStore);
    expect(s.error).toEqual(err);
    expect(s.isActive).toBe(false);
    expect(s.activeMode).toBeNull();
  });
});

// ---- lipSyncStore ----
describe('lipSyncStore', () => {
  beforeEach(() => lipSyncStore.reset());

  it('初期状態が正しい', () => {
    const s = get(lipSyncStore);
    expect(s.isPlaying).toBe(false);
    expect(s.displayedText).toBe('');
    expect(s.currentViseme).toBe('neutral');
    expect(s.charsPerSecond).toBe(8);
  });

  it('appendChar でテキストが1文字追加される', () => {
    lipSyncStore.appendChar('あ');
    lipSyncStore.appendChar('い');
    expect(get(lipSyncStore).displayedText).toBe('あい');
  });

  it('setViseme で currentViseme が更新される', () => {
    lipSyncStore.setViseme('aa');
    expect(get(lipSyncStore).currentViseme).toBe('aa');
  });

  it('setSpeed で charsPerSecond が更新される', () => {
    lipSyncStore.setSpeed(12);
    expect(get(lipSyncStore).charsPerSecond).toBe(12);
  });

  it('reset で初期状態に戻る', () => {
    lipSyncStore.appendChar('test');
    lipSyncStore.setViseme('oh');
    lipSyncStore.reset();
    const s = get(lipSyncStore);
    expect(s.displayedText).toBe('');
    expect(s.currentViseme).toBe('neutral');
  });
});
