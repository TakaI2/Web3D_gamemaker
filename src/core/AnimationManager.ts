import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import { animationStore } from '../stores/animationStore';
import { isVRMAFile } from '../utils/fileHelpers';
import type { SpeedPreset, AnimationEntry } from '../types';

export class AnimationManager {
  private _loader: GLTFLoader;
  private _mixer: THREE.AnimationMixer | null = null;
  private _action: THREE.AnimationAction | null = null;
  private _vrm: VRM | null = null;
  private _clips: Map<string, THREE.AnimationClip> = new Map();

  constructor() {
    this._loader = new GLTFLoader();
    this._loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  }

  setVRM(vrm: VRM): void {
    this._stop();
    this._mixer = new THREE.AnimationMixer(vrm.scene);
    this._vrm = vrm;
    // 既存クリップを新しい VRM に再適用
    const clips = [...this._clips.entries()];
    this._clips.clear();
    animationStore.resetAnimations();
    for (const [name, clip] of clips) {
      this._registerClip(name, clip);
    }
  }

  async loadVRMAFromUrl(url: string): Promise<void> {
    if (!this._vrm) return;
    const gltf = await this._loader.loadAsync(url);
    const vrmAnimation = gltf.userData.vrmAnimations?.[0];
    if (!vrmAnimation) throw new Error('VRMA データが見つかりません');
    const clip = createVRMAnimationClip(vrmAnimation, this._vrm);
    const name = this._uniqueName(url.split('/').pop()?.replace(/\.vrma$/i, '') ?? 'animation');
    this._registerClip(name, clip);
  }

  async loadVRMA(file: File): Promise<void> {
    if (!isVRMAFile(file)) {
      animationStore.resetAnimations();
      return;
    }
    if (!this._vrm) {
      animationStore.resetAnimations();
      return;
    }

    const url = URL.createObjectURL(file);
    try {
      const gltf = await this._loader.loadAsync(url);
      const vrmAnimation = gltf.userData.vrmAnimations?.[0];
      if (!vrmAnimation) throw new Error('VRMA データが見つかりません');

      const clip = createVRMAnimationClip(vrmAnimation, this._vrm);
      const name = this._uniqueName(file.name.replace(/\.vrma$/i, ''));
      this._registerClip(name, clip);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  play(name: string): void {
    if (!this._mixer) return;
    const clip = this._clips.get(name);
    if (!clip) return;

    this._action?.stop();
    this._action = this._mixer.clipAction(clip);
    const state = this._getState();
    this._action.setLoop(
      state.isLooping ? THREE.LoopRepeat : THREE.LoopOnce,
      Infinity,
    );
    this._action.timeScale = state.speed;
    this._action.clampWhenFinished = !state.isLooping;
    this._action.play();
    animationStore.selectAnimation(name);
    animationStore.setPlaying(true);
  }

  stop(): void {
    this._stop();
    animationStore.setPlaying(false);
  }

  setLoop(enabled: boolean): void {
    animationStore.setLooping(enabled);
    if (!this._action) return;
    this._action.setLoop(enabled ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this._action.clampWhenFinished = !enabled;
  }

  setSpeed(speed: SpeedPreset): void {
    animationStore.setSpeed(speed);
    if (this._action) this._action.timeScale = speed;
  }

  /** normalizedTime: 0.0 〜 1.0 */
  seek(normalizedTime: number): void {
    if (!this._action || !this._action.getClip()) return;
    const duration = this._action.getClip().duration;
    this._mixer?.setTime(normalizedTime * duration);
  }

  resetTPose(): void {
    this._stop();
    this._mixer?.stopAllAction();
    this._vrm?.humanoid.resetNormalizedPose();
    animationStore.setPlaying(false);
    animationStore.selectAnimation(null);
  }

  setAPose(): void {
    this._stop();
    this._mixer?.stopAllAction();
    // まず T ポーズにリセットしてから腕を下げる
    this._vrm?.humanoid.resetNormalizedPose();

    const leftUpperArm  = this._vrm?.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = this._vrm?.humanoid.getNormalizedBoneNode('rightUpperArm');

    // 約45度腕を下げる（Z軸回転）
    const angle = Math.PI / 4;
    leftUpperArm?.rotation.set(0, 0, -angle);
    rightUpperArm?.rotation.set(0, 0, angle);

    animationStore.setPlaying(false);
    animationStore.selectAnimation(null);
  }

  update(delta: number): void {
    this._mixer?.update(delta);

    // 進捗を更新
    if (this._action?.isRunning()) {
      const duration = this._action.getClip().duration;
      if (duration > 0) {
        animationStore.setProgress(this._action.time / duration);
      }
    }
  }

  get currentAction(): THREE.AnimationAction | null {
    return this._action;
  }

  private _stop(): void {
    this._action?.stop();
    this._action = null;
  }

  private _registerClip(name: string, clip: THREE.AnimationClip): void {
    this._clips.set(name, clip);
    const entry: AnimationEntry = { name, clip, duration: clip.duration };
    animationStore.addAnimation(entry);
  }

  private _uniqueName(base: string): string {
    if (!this._clips.has(base)) return base;
    let i = 1;
    while (this._clips.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  private _getState() {
    let state = { isLooping: true, speed: 1.0 as SpeedPreset };
    const unsub = animationStore.subscribe((s) => {
      state = { isLooping: s.isLooping, speed: s.speed };
    });
    unsub();
    return state;
  }
}
