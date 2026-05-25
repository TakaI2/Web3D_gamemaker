import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import * as THREE from 'three';
import { animEditorStore } from './animEditorStore';
import { appModeStore } from './appModeStore';

beforeEach(() => {
  animEditorStore.close();
});

describe('animEditorStore', () => {
  it('AES-01: 初期状態', () => {
    const s = get(animEditorStore);
    expect(s.currentFrame).toBe(0);
    expect(s.isPlaying).toBe(false);
    expect(s.boneKeyframes.size).toBe(0);
    expect(s.blendShapeKeyframes.size).toBe(0);
  });

  it('AES-02: setBoneKeyframe', () => {
    const q = new THREE.Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    animEditorStore.open(3);
    animEditorStore.setBoneKeyframe('hips', 10, q);
    const s = get(animEditorStore);
    const stored = s.boneKeyframes.get('hips')?.get(10);
    expect(stored).toBeDefined();
    expect(stored!.x).toBeCloseTo(q.x, 5);
    expect(stored!.y).toBeCloseTo(q.y, 5);
  });

  it('AES-03: removeBoneKeyframe', () => {
    animEditorStore.open(3);
    animEditorStore.setBoneKeyframe('hips', 10, new THREE.Quaternion());
    animEditorStore.removeBoneKeyframe('hips', 10);
    const s = get(animEditorStore);
    expect(s.boneKeyframes.get('hips')).toBeUndefined();
  });

  it('AES-04: setBlendShapeKeyframe', () => {
    animEditorStore.open(3);
    animEditorStore.setBlendShapeKeyframe('happy', 5, 0.8);
    const s = get(animEditorStore);
    expect(s.blendShapeKeyframes.get('happy')?.get(5)).toBeCloseTo(0.8);
  });

  it('AES-05: removeBlendShapeKeyframe', () => {
    animEditorStore.open(3);
    animEditorStore.setBlendShapeKeyframe('happy', 5, 0.8);
    animEditorStore.removeBlendShapeKeyframe('happy', 5);
    const s = get(animEditorStore);
    expect(s.blendShapeKeyframes.get('happy')).toBeUndefined();
  });

  it('AES-06: setCurrentFrame', () => {
    animEditorStore.open(3);
    animEditorStore.setCurrentFrame(15);
    expect(get(animEditorStore).currentFrame).toBe(15);
  });

  it('AES-07: setCurrentFrame 負の値は 0 にクランプ', () => {
    animEditorStore.open(3);
    animEditorStore.setCurrentFrame(-5);
    expect(get(animEditorStore).currentFrame).toBe(0);
  });

  it('AES-08: setCurrentFrame が totalFrames を超えない', () => {
    animEditorStore.open(1); // 30フレーム
    animEditorStore.setCurrentFrame(9999);
    expect(get(animEditorStore).currentFrame).toBe(30);
  });

  it('AES-09: setDuration', () => {
    animEditorStore.open(3);
    animEditorStore.setDuration(5);
    expect(get(animEditorStore).durationSec).toBe(5);
  });

  it('AES-10: setIKEnabled', () => {
    animEditorStore.open(3);
    animEditorStore.setIKEnabled('leftHand', true);
    expect(get(animEditorStore).ikEnabled.leftHand).toBe(true);
  });

  it('AES-11: setSelectedBone', () => {
    animEditorStore.open(3);
    animEditorStore.setSelectedBone('hips');
    expect(get(animEditorStore).selectedBoneName).toBe('hips');
  });

  it('AES-12: setOutputFilename', () => {
    animEditorStore.open(3);
    animEditorStore.setOutputFilename('walk.vrma');
    expect(get(animEditorStore).outputFilename).toBe('walk.vrma');
  });

  it('AES-13: open() はキーフレームをリセットする', () => {
    animEditorStore.open(3);
    animEditorStore.setBoneKeyframe('hips', 1, new THREE.Quaternion());
    animEditorStore.open(5);
    expect(get(animEditorStore).boneKeyframes.size).toBe(0);
    expect(get(animEditorStore).durationSec).toBe(5);
  });

  it('AES-14: importFromVrmAnimation - humanoidTracks を解析する', () => {
    animEditorStore.open(2);
    const track = new THREE.QuaternionKeyframeTrack(
      'hips.quaternion',
      [0, 0.5, 1.0],
      [0,0,0,1,  0,0,0,1,  0.1,0,0,0.99],
    );
    const vrmAnimRaw = {
      duration: 1.0,
      humanoidTracks: {
        rotation: new Map([['hips', track]]),
      },
      expressionTracks: {
        preset: new Map<string, THREE.NumberKeyframeTrack>(),
        custom: new Map<string, THREE.NumberKeyframeTrack>(),
      },
    };
    // VRM モック（resetNormalizedPose と getRawBoneNode を持つ最小実装）
    const mockVrm = {
      humanoid: {
        resetNormalizedPose: () => {},
        getRawBoneNode: () => ({ quaternion: new THREE.Quaternion() }),
      },
      scene: { updateWorldMatrix: () => {} },
    };
    animEditorStore.importFromVrmAnimation(vrmAnimRaw, mockVrm as never);
    const s = get(animEditorStore);
    expect(s.boneKeyframes.has('hips')).toBe(true);
    expect(s.durationSec).toBeCloseTo(1.0, 3);
  });

  it('AES-15: importFromVrmAnimation - 時間量子化 30fps', () => {
    animEditorStore.open(2);
    const track = new THREE.QuaternionKeyframeTrack(
      'hips.quaternion',
      [0.1667], // ≈ 5フレーム @ 30fps
      [0,0,0,1],
    );
    const vrmAnimRaw = {
      duration: 0.5,
      humanoidTracks: { rotation: new Map([['hips', track]]) },
      expressionTracks: {
        preset: new Map<string, THREE.NumberKeyframeTrack>(),
        custom: new Map<string, THREE.NumberKeyframeTrack>(),
      },
    };
    const mockVrm = {
      humanoid: {
        resetNormalizedPose: () => {},
        getRawBoneNode: () => ({ quaternion: new THREE.Quaternion() }),
      },
      scene: { updateWorldMatrix: () => {} },
    };
    animEditorStore.importFromVrmAnimation(vrmAnimRaw, mockVrm as never);
    const s = get(animEditorStore);
    expect(s.boneKeyframes.get('hips')?.has(5)).toBe(true);
  });
});

describe('appModeStore', () => {
  it('AM-01: toAnimEditor()', () => {
    appModeStore.toAnimEditor();
    expect(get(appModeStore)).toBe('anim-editor');
  });

  it('AM-02: toEditor() 復帰', () => {
    appModeStore.toAnimEditor();
    appModeStore.toEditor();
    expect(get(appModeStore)).toBe('editor');
  });
});
