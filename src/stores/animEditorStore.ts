import { writable } from 'svelte/store';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { AnimEditorState, IKTarget, BoneKeyframes, BlendShapeKeyframes, HipsPositionKeyframes } from '../types';

const FPS = 30;

function defaultState(): AnimEditorState {
  return {
    durationSec: 3,
    fps: FPS,
    currentFrame: 0,
    isPlaying: false,
    isLooping: true,
    boneKeyframes: new Map(),
    blendShapeKeyframes: new Map(),
    hipsPositionKeyframes: new Map(),
    selectedBoneName: null,
    ikEnabled: {
      leftHand: false,
      rightHand: false,
      leftFoot: false,
      rightFoot: false,
    },
    outputFilename: 'output.vrma',
  };
}

const { subscribe, update, set } = writable<AnimEditorState>(defaultState());

function totalFrames(state: AnimEditorState): number {
  return Math.round(state.durationSec * state.fps);
}

export const animEditorStore = {
  subscribe,

  open(durationSec: number): void {
    set({ ...defaultState(), durationSec });
  },

  close(): void {
    set(defaultState());
  },

  setCurrentFrame(frame: number): void {
    update((s) => ({
      ...s,
      currentFrame: Math.max(0, Math.min(frame, totalFrames(s))),
    }));
  },

  setDuration(sec: number): void {
    update((s) => {
      const clamped = Math.max(0.1, sec);
      return { ...s, durationSec: clamped };
    });
  },

  setPlaying(isPlaying: boolean): void {
    update((s) => ({ ...s, isPlaying }));
  },

  setLooping(isLooping: boolean): void {
    update((s) => ({ ...s, isLooping }));
  },

  setSelectedBone(name: string | null): void {
    update((s) => ({ ...s, selectedBoneName: name }));
  },

  setIKEnabled(target: IKTarget, enabled: boolean): void {
    update((s) => ({
      ...s,
      ikEnabled: { ...s.ikEnabled, [target]: enabled },
    }));
  },

  setOutputFilename(name: string): void {
    update((s) => ({ ...s, outputFilename: name }));
  },

  setBoneKeyframe(boneName: string, frame: number, quat: THREE.Quaternion): void {
    update((s) => {
      const boneKeyframes: BoneKeyframes = new Map(s.boneKeyframes);
      const boneMap = new Map(boneKeyframes.get(boneName) ?? []);
      boneMap.set(frame, quat.clone());
      boneKeyframes.set(boneName, boneMap);
      return { ...s, boneKeyframes };
    });
  },

  removeBoneKeyframe(boneName: string, frame: number): void {
    update((s) => {
      const boneKeyframes: BoneKeyframes = new Map(s.boneKeyframes);
      const boneMap = boneKeyframes.get(boneName);
      if (!boneMap) return s;
      const newMap = new Map(boneMap);
      newMap.delete(frame);
      if (newMap.size === 0) {
        boneKeyframes.delete(boneName);
      } else {
        boneKeyframes.set(boneName, newMap);
      }
      return { ...s, boneKeyframes };
    });
  },

  setBlendShapeKeyframe(exprName: string, frame: number, value: number): void {
    update((s) => {
      const blendShapeKeyframes: BlendShapeKeyframes = new Map(s.blendShapeKeyframes);
      const exprMap = new Map(blendShapeKeyframes.get(exprName) ?? []);
      exprMap.set(frame, Math.max(0, Math.min(1, value)));
      blendShapeKeyframes.set(exprName, exprMap);
      return { ...s, blendShapeKeyframes };
    });
  },

  removeBlendShapeKeyframe(exprName: string, frame: number): void {
    update((s) => {
      const blendShapeKeyframes: BlendShapeKeyframes = new Map(s.blendShapeKeyframes);
      const exprMap = blendShapeKeyframes.get(exprName);
      if (!exprMap) return s;
      const newMap = new Map(exprMap);
      newMap.delete(frame);
      if (newMap.size === 0) {
        blendShapeKeyframes.delete(exprName);
      } else {
        blendShapeKeyframes.set(exprName, newMap);
      }
      return { ...s, blendShapeKeyframes };
    });
  },

  /**
   * @pixiv/three-vrm-animation の生 VRMAnimation オブジェクトからキーフレームをインポートする。
   * humanoidTracks.rotation の値は「正規化ボーン空間のデルタ回転」なので、
   * rawBoneQuat = restRawQuat ⊗ delta に変換してから格納する。
   *
   * vrmAnimRaw は gltf.userData.vrmAnimations[0] を想定。
   */
  importFromVrmAnimation(
    vrmAnimRaw: {
      duration: number;
      humanoidTracks: {
        rotation: Map<string, THREE.QuaternionKeyframeTrack>;
        translation?: Map<string, THREE.VectorKeyframeTrack>;
      };
      expressionTracks: {
        preset: Map<string, THREE.NumberKeyframeTrack>;
        custom: Map<string, THREE.NumberKeyframeTrack>;
      };
    },
    vrm: VRM,
  ): void {
    // T-pose にリセットして rest quaternion を取得（update() で raw ボーンへ反映してから読む）
    vrm.humanoid.resetNormalizedPose();
    vrm.humanoid.update();
    vrm.scene.updateWorldMatrix(true, true);

    const restQuats = new Map<string, THREE.Quaternion>();
    for (const [boneName] of vrmAnimRaw.humanoidTracks.rotation) {
      const rawBone = vrm.humanoid.getRawBoneNode(
        boneName as Parameters<typeof vrm.humanoid.getRawBoneNode>[0],
      );
      if (rawBone) restQuats.set(boneName, rawBone.quaternion.clone());
    }

    update((s) => {
      const boneKeyframes: BoneKeyframes = new Map();
      const blendShapeKeyframes: BlendShapeKeyframes = new Map();
      const hipsPositionKeyframes: HipsPositionKeyframes = new Map();
      const fps = s.fps;

      // ボーン回転トラック
      for (const [boneName, track] of vrmAnimRaw.humanoidTracks.rotation) {
        const restQ = restQuats.get(boneName) ?? new THREE.Quaternion();
        const frameMap = new Map<number, THREE.Quaternion>();
        const { times, values } = track;
        for (let i = 0; i < times.length; i++) {
          const frameIndex = Math.round(times[i] * fps);
          const delta = new THREE.Quaternion(
            values[i * 4],
            values[i * 4 + 1],
            values[i * 4 + 2],
            values[i * 4 + 3],
          ).normalize();
          // rawBone = rest * delta
          frameMap.set(frameIndex, restQ.clone().multiply(delta));
        }
        if (frameMap.size > 0) boneKeyframes.set(boneName, frameMap);
      }

      // ヒップ位置トラック（正規化 VRM 空間の絶対位置、単位:メートル）
      const hipsTranslationTrack = vrmAnimRaw.humanoidTracks.translation?.get('hips');
      if (hipsTranslationTrack) {
        const { times, values } = hipsTranslationTrack;
        for (let i = 0; i < times.length; i++) {
          const frameIndex = Math.round(times[i] * fps);
          hipsPositionKeyframes.set(
            frameIndex,
            new THREE.Vector3(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]),
          );
        }
      }

      // 表情トラック（preset + custom）
      const allExprTracks = new Map<string, THREE.NumberKeyframeTrack>([
        ...vrmAnimRaw.expressionTracks.preset,
        ...vrmAnimRaw.expressionTracks.custom,
      ]);
      for (const [exprName, track] of allExprTracks) {
        const exprMap = new Map<number, number>();
        const { times, values } = track;
        for (let i = 0; i < times.length; i++) {
          exprMap.set(
            Math.round(times[i] * fps),
            Math.max(0, Math.min(1, values[i])),
          );
        }
        if (exprMap.size > 0) blendShapeKeyframes.set(exprName, exprMap);
      }

      return {
        ...s,
        durationSec: vrmAnimRaw.duration,
        boneKeyframes,
        blendShapeKeyframes,
        hipsPositionKeyframes,
        currentFrame: 0,
        isPlaying: false,
      };
    });
  },
};
