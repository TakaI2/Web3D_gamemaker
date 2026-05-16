import type { VRM } from '@pixiv/three-vrm';
import type * as THREE from 'three';

// Viseme
export type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'neutral';

// アニメーションエントリー
export type AnimationEntry = {
  readonly name: string;
  readonly clip: THREE.AnimationClip;
  readonly duration: number;
};

// アニメーション再生速度プリセット
export type SpeedPreset = 0.25 | 0.5 | 1.0 | 2.0;

// XRモード
export type XRMode = 'vr' | 'ar';

// XRサポート状態
export type XRSupportState = {
  readonly vr: boolean;
  readonly ar: boolean;
};

// アプリケーション全体エラー
export type AppError = {
  readonly type: 'load' | 'xr' | 'animation' | 'lipsync';
  readonly message: string;
  readonly detail?: string;
};

// Spring Bone パラメータ
export type SpringBoneParams = {
  stiffness: number; // 0.0 〜 4.0
  damping: number;   // 0.0 〜 1.0
  enabled: boolean;
};

// vrmStore の状態
export type VRMState = {
  readonly vrm: VRM | null;
  readonly loading: boolean;
  readonly error: AppError | null;
};

// animationStore の状態
export type AnimationState = {
  readonly animations: AnimationEntry[];
  readonly currentName: string | null;
  readonly isPlaying: boolean;
  readonly isLooping: boolean;
  readonly speed: SpeedPreset;
  readonly progress: number; // 0.0 〜 1.0
};

// lipSyncStore の状態
export type LipSyncState = {
  readonly isPlaying: boolean;
  readonly displayedText: string;
  readonly currentViseme: VisemeKey;
  readonly charsPerSecond: number;
};

// xrStore の状態
export type XRState = {
  readonly support: XRSupportState;
  readonly activeMode: XRMode | null;
  readonly isActive: boolean;
  readonly error: AppError | null;
};
