import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { vmdStore } from '../stores/vmdStore';
import type { VMDEntry } from '../types';

export class VMDManager {
  private _loader: MMDLoader;
  private _helper: MMDAnimationHelper;
  private _mesh: THREE.SkinnedMesh | null = null;
  private _clips: Map<string, THREE.AnimationClip> = new Map();
  private _currentName: string | null = null;
  private _isLooping: boolean = true;

  constructor() {
    this._loader = new MMDLoader();
    this._helper = new MMDAnimationHelper({ sync: false, afterglow: 0 });
  }

  setMesh(mesh: THREE.SkinnedMesh): void {
    if (this._mesh) {
      try { this._helper.remove(this._mesh); } catch { /* ignore */ }
    }
    this._mesh = mesh;
    this._clips.clear();
    this._currentName = null;
    this._helper = new MMDAnimationHelper({ sync: false, afterglow: 0 });
    vmdStore.resetAnimations();
  }

  async loadVMDFromUrl(url: string, name: string): Promise<void> {
    if (!this._mesh) throw new Error('先に PMX モデルを読み込んでください');
    const mesh = this._mesh;

    const clip = await new Promise<THREE.AnimationClip>((resolve, reject) => {
      this._loader.loadAnimation(
        url,
        mesh,
        (obj) => resolve(obj as THREE.AnimationClip),
        undefined,
        (e) => reject(e),
      );
    });

    const uniqueName = this._uniqueName(name);
    this._clips.set(uniqueName, clip);
    const entry: VMDEntry = { name: uniqueName, clip };
    vmdStore.addAnimation(entry);
  }

  async loadVMD(file: File): Promise<void> {
    if (!this._mesh) throw new Error('先に PMX モデルを読み込んでください');
    const url = URL.createObjectURL(file);
    try {
      const name = file.name.replace(/\.vmd$/i, '');
      await this.loadVMDFromUrl(url, name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  play(name: string): void {
    if (!this._mesh) return;
    const clip = this._clips.get(name);
    if (!clip) return;

    // 既存のアニメーションを停止
    this._stopHelper();

    this._helper.add(this._mesh, { animation: clip, physics: false });

    // ループ設定をミキサーに反映
    const mixerObj = this._helper.objects.get(this._mesh);
    const action = mixerObj?.mixer?.existingAction(clip);
    if (action) {
      action.setLoop(
        this._isLooping ? THREE.LoopRepeat : THREE.LoopOnce,
        Infinity,
      );
      action.clampWhenFinished = !this._isLooping;
    }

    this._currentName = name;
    vmdStore.selectAnimation(name);
    vmdStore.setPlaying(true);
  }

  stop(): void {
    this._stopHelper();
    this._currentName = null;
    vmdStore.selectAnimation(null);
    vmdStore.setPlaying(false);
  }

  setLoop(isLooping: boolean): void {
    this._isLooping = isLooping;
    vmdStore.setLooping(isLooping);

    if (!this._mesh || !this._currentName) return;
    const clip = this._clips.get(this._currentName);
    if (!clip) return;
    const mixerObj = this._helper.objects.get(this._mesh);
    const action = mixerObj?.mixer?.existingAction(clip);
    if (action) {
      action.setLoop(isLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !isLooping;
    }
  }

  update(delta: number): void {
    this._helper.update(delta);
  }

  private _stopHelper(): void {
    if (!this._mesh) return;
    try { this._helper.remove(this._mesh); } catch { /* ignore */ }
    // 新しい helper を作成してリセット
    this._helper = new MMDAnimationHelper({ sync: false, afterglow: 0 });
  }

  private _uniqueName(base: string): string {
    if (!this._clips.has(base)) return base;
    let i = 1;
    while (this._clips.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }
}
