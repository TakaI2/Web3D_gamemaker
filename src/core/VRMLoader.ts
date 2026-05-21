import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { vrmStore } from '../stores/vrmStore';
import { isVRMFile } from '../utils/fileHelpers';
import type { SceneManager } from './SceneManager';

export class VRMLoader {
  private _loader: GLTFLoader;
  private _sceneManager: SceneManager;
  private _current: VRM | null = null;

  constructor(sceneManager: SceneManager) {
    this._sceneManager = sceneManager;
    this._loader = new GLTFLoader();
    this._loader.register((parser) => new VRMLoaderPlugin(parser));
  }

  get current(): VRM | null {
    return this._current;
  }

  async loadFromUrl(url: string): Promise<VRM> {
    vrmStore.setLoading(true);
    try {
      const gltf = await this._loader.loadAsync(url);
      const vrm: VRM = gltf.userData.vrm;
      if (!vrm) throw new Error('VRM データが見つかりません');
      this.unload();
      this._sceneManager.scene.add(vrm.scene);
      this._current = vrm;
      vrmStore.setVRM(vrm);
      return vrm;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'VRM の読み込みに失敗しました';
      vrmStore.setError({ type: 'load', message });
      throw e;
    }
  }

  async load(file: File): Promise<VRM> {
    if (!isVRMFile(file)) {
      const err = { type: 'load' as const, message: '非対応のファイル形式です（.vrm のみ対応）' };
      vrmStore.setError(err);
      throw new Error(err.message);
    }

    vrmStore.setLoading(true);

    const url = URL.createObjectURL(file);
    try {
      const gltf = await this._loader.loadAsync(url);
      const vrm: VRM = gltf.userData.vrm;

      if (!vrm) {
        throw new Error('VRM データが見つかりません');
      }

      // 既存モデルを破棄してからシーンに追加
      this.unload();
      this._sceneManager.scene.add(vrm.scene);
      this._current = vrm;
      vrmStore.setVRM(vrm);
      return vrm;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'VRM の読み込みに失敗しました';
      vrmStore.setError({ type: 'load', message });
      throw e;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** シーンから取り外すが VRM オブジェクトは破棄しない（モード切替用） */
  detach(scene: THREE.Scene): void {
    if (!this._current) return;
    scene.remove(this._current.scene);
  }

  /** 指定シーンに VRM を追加する（モード切替用） */
  attach(scene: THREE.Scene): void {
    if (!this._current) return;
    scene.add(this._current.scene);
  }

  unload(): void {
    if (!this._current) return;

    this._sceneManager.scene.remove(this._current.scene);
    this._disposeVRM(this._current);
    this._current = null;
  }

  private _disposeVRM(vrm: VRM): void {
    vrm.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
          // テクスチャを解放
          for (const key of Object.keys(mat)) {
            const val = (mat as Record<string, unknown>)[key];
            if (val instanceof THREE.Texture) {
              val.dispose();
            }
          }
          mat.dispose();
        }
      }
    });
  }
}
