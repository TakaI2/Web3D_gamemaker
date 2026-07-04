import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { AnimEditorState, IKTarget, BoneKeyframes, BlendShapeKeyframes, HipsPositionKeyframes } from '../types';

const FPS = 30;

// フレーム番号を付け替える（null を返したフレームは削除）。トリム/範囲削除で使う。
function remapFlat<T>(m: Map<number, T>, fn: (f: number) => number | null): Map<number, T> {
  const out = new Map<number, T>();
  for (const [f, v] of m) {
    const nf = fn(f);
    if (nf !== null) out.set(nf, v);
  }
  return out;
}
function remapNested<T>(m: Map<string, Map<number, T>>, fn: (f: number) => number | null): Map<string, Map<number, T>> {
  const out = new Map<string, Map<number, T>>();
  for (const [k, inner] of m) {
    const ni = remapFlat(inner, fn);
    if (ni.size > 0) out.set(k, ni);
  }
  return out;
}

// 範囲コピー用クリップボード（オフセットは In からの相対フレーム）。リアクティブ不要なのでモジュール変数。
type RangeClip = {
  span: number;
  bones: { bone: string; offset: number; quat: THREE.Quaternion }[];
  blends: { expr: string; offset: number; value: number }[];
  hips: { offset: number; pos: THREE.Vector3 }[];
};
let rangeClipboard: RangeClip | null = null;

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

  setHipsPositionKeyframe(frame: number, pos: THREE.Vector3): void {
    update((s) => {
      const hipsPositionKeyframes: HipsPositionKeyframes = new Map(s.hipsPositionKeyframes);
      hipsPositionKeyframes.set(frame, pos.clone());
      return { ...s, hipsPositionKeyframes };
    });
  },

  removeHipsPositionKeyframe(frame: number): void {
    update((s) => {
      const hipsPositionKeyframes: HipsPositionKeyframes = new Map(s.hipsPositionKeyframes);
      if (!hipsPositionKeyframes.has(frame)) return s;
      hipsPositionKeyframes.delete(frame);
      return { ...s, hipsPositionKeyframes };
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

  // ── トリミング（時間で区切って前後を丸ごと削除・詰める）──
  // 指定フレームより前を削除し、残りを先頭(0)へ詰める（尺も短縮）。
  trimBefore(frame: number): void {
    update((s) => {
      if (frame <= 0) return s;
      const shift = (f: number): number | null => (f >= frame ? f - frame : null);
      const durationSec = Math.max(0.1, s.durationSec - frame / s.fps);
      return {
        ...s,
        boneKeyframes: remapNested(s.boneKeyframes, shift),
        blendShapeKeyframes: remapNested(s.blendShapeKeyframes, shift),
        hipsPositionKeyframes: remapFlat(s.hipsPositionKeyframes, shift),
        durationSec,
        currentFrame: Math.max(0, Math.min(s.currentFrame - frame, Math.round(durationSec * s.fps))),
      };
    });
  },

  // 指定フレームより後を削除（尺＝frame）。
  trimAfter(frame: number): void {
    update((s) => {
      const keep = (f: number): number | null => (f <= frame ? f : null);
      const durationSec = Math.max(0.1, frame / s.fps);
      return {
        ...s,
        boneKeyframes: remapNested(s.boneKeyframes, keep),
        blendShapeKeyframes: remapNested(s.blendShapeKeyframes, keep),
        hipsPositionKeyframes: remapFlat(s.hipsPositionKeyframes, keep),
        durationSec,
        currentFrame: Math.min(s.currentFrame, frame),
      };
    });
  },

  // In〜Out（両端含む）を削除して後ろを詰める（尺も短縮）。
  deleteRange(inF: number, outF: number): void {
    update((s) => {
      const lo = Math.min(inF, outF), hi = Math.max(inF, outF);
      const span = hi - lo + 1;   // 削除フレーム数＝詰め量
      const remap = (f: number): number | null => (f >= lo && f <= hi ? null : (f > hi ? f - span : f));
      const durationSec = Math.max(0.1, s.durationSec - span / s.fps);
      return {
        ...s,
        boneKeyframes: remapNested(s.boneKeyframes, remap),
        blendShapeKeyframes: remapNested(s.blendShapeKeyframes, remap),
        hipsPositionKeyframes: remapFlat(s.hipsPositionKeyframes, remap),
        durationSec,
        currentFrame: Math.max(0, Math.min(s.currentFrame >= lo ? Math.max(lo, s.currentFrame - span) : s.currentFrame, Math.round(durationSec * s.fps))),
      };
    });
  },

  // In〜Out（両端含む）の全トラックのキーフレームを In 基準の相対オフセットでコピー。
  copyRange(inF: number, outF: number): void {
    const s = get({ subscribe });
    const lo = Math.min(inF, outF), hi = Math.max(inF, outF);
    const bones: RangeClip['bones'] = [];
    for (const [bone, m] of s.boneKeyframes) for (const [f, q] of m) if (f >= lo && f <= hi) bones.push({ bone, offset: f - lo, quat: q.clone() });
    const blends: RangeClip['blends'] = [];
    for (const [expr, m] of s.blendShapeKeyframes) for (const [f, v] of m) if (f >= lo && f <= hi) blends.push({ expr, offset: f - lo, value: v });
    const hips: RangeClip['hips'] = [];
    for (const [f, p] of s.hipsPositionKeyframes) if (f >= lo && f <= hi) hips.push({ offset: f - lo, pos: p.clone() });
    rangeClipboard = { span: hi - lo, bones, blends, hips };
  },

  hasRangeClip(): boolean {
    return rangeClipboard !== null;
  },

  // コピーした範囲を atFrame から貼り付け（尺が足りなければ延長）。上書き。
  pasteRange(atFrame: number): void {
    const clip = rangeClipboard;
    if (!clip) return;
    update((s) => {
      const boneKeyframes: BoneKeyframes = new Map(s.boneKeyframes);
      const blendShapeKeyframes: BlendShapeKeyframes = new Map(s.blendShapeKeyframes);
      const hipsPositionKeyframes: HipsPositionKeyframes = new Map(s.hipsPositionKeyframes);
      for (const it of clip.bones) {
        const m = new Map(boneKeyframes.get(it.bone) ?? []);
        m.set(atFrame + it.offset, it.quat.clone());
        boneKeyframes.set(it.bone, m);
      }
      for (const it of clip.blends) {
        const m = new Map(blendShapeKeyframes.get(it.expr) ?? []);
        m.set(atFrame + it.offset, it.value);
        blendShapeKeyframes.set(it.expr, m);
      }
      for (const it of clip.hips) hipsPositionKeyframes.set(atFrame + it.offset, it.pos.clone());
      const durationSec = Math.max(s.durationSec, (atFrame + clip.span) / s.fps);
      return { ...s, boneKeyframes, blendShapeKeyframes, hipsPositionKeyframes, durationSec };
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
