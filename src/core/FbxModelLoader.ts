import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import type { SceneManager } from './SceneManager';
import { fbxStore } from '../stores/fbxStore';
import { fbxAnimStore } from '../stores/fbxAnimStore';

export class FbxModelLoader {
  private readonly _loader = new FBXLoader();
  private readonly _sceneManager: SceneManager;
  private _root: THREE.Group | null = null;
  private _mixer: THREE.AnimationMixer | null = null;
  private _clips: Map<string, THREE.AnimationClip> = new Map();
  private _currentAction: THREE.AnimationAction | null = null;
  private _isLooping = true;

  constructor(sceneManager: SceneManager) {
    this._sceneManager = sceneManager;
  }

  get current(): THREE.Group | null {
    return this._root;
  }

  async loadFromFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    try {
      await this._load(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async _load(url: string): Promise<void> {
    fbxStore.setLoading(true);
    try {
      const root = await new Promise<THREE.Group>((resolve, reject) => {
        this._loader.load(url, resolve, undefined, reject);
      });
      this.unload();
      this._root = root;
      this._sceneManager.scene.add(root);

      // 埋め込みアニメーションクリップを収集
      this._clips.clear();
      const names: string[] = [];
      root.animations.forEach((clip, i) => {
        const name = clip.name.trim() || `Clip_${i}`;
        this._clips.set(name, clip);
        names.push(name);
      });

      this._mixer = this._clips.size > 0 ? new THREE.AnimationMixer(root) : null;
      fbxStore.setRoot(root, names);
      fbxAnimStore.reset();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'FBX の読み込みに失敗しました';
      fbxStore.setError({ type: 'load', message });
      throw e;
    }
  }

  play(name: string): void {
    if (!this._mixer) return;
    const clip = this._clips.get(name);
    if (!clip) return;

    if (this._currentAction) {
      this._currentAction.stop();
    }
    const action = this._mixer.clipAction(clip);
    action.setLoop(this._isLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !this._isLooping;
    action.reset().play();
    this._currentAction = action;
    fbxAnimStore.setCurrent(name);
    fbxAnimStore.setPlaying(true);
  }

  stop(): void {
    if (this._currentAction) {
      this._currentAction.stop();
      this._currentAction = null;
    }
    fbxAnimStore.setCurrent(null);
    fbxAnimStore.setPlaying(false);
  }

  setLoop(isLooping: boolean): void {
    this._isLooping = isLooping;
    fbxAnimStore.setLooping(isLooping);
    if (!this._currentAction) return;
    this._currentAction.setLoop(isLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this._currentAction.clampWhenFinished = !isLooping;
  }

  update(delta: number): void {
    this._mixer?.update(delta);
  }

  unload(): void {
    if (!this._root) return;
    this.stop();
    this._mixer?.stopAllAction();
    this._mixer = null;
    this._clips.clear();
    this._sceneManager.scene.remove(this._root);
    this._disposeObject(this._root);
    this._root = null;
    fbxStore.reset();
    fbxAnimStore.reset();
  }

  private _disposeObject(obj: THREE.Object3D): void {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
          for (const key of Object.keys(mat)) {
            const val = (mat as Record<string, unknown>)[key];
            if (val instanceof THREE.Texture) val.dispose();
          }
          mat.dispose();
        });
      }
    });
  }
}
