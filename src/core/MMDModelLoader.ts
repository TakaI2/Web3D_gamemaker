import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import type { SceneManager } from './SceneManager';
import { mmdStore } from '../stores/mmdStore';

export class MMDModelLoader {
  private readonly _loader: MMDLoader;
  private readonly _sceneManager: SceneManager;
  private _current: THREE.SkinnedMesh | null = null;

  constructor(sceneManager: SceneManager) {
    this._sceneManager = sceneManager;
    this._loader = new MMDLoader();
  }

  get current(): THREE.SkinnedMesh | null {
    return this._current;
  }

  async loadFromUrl(url: string): Promise<THREE.SkinnedMesh> {
    mmdStore.setLoading(true);
    try {
      const mesh = await this._loader.loadAsync(url);
      this.unload();
      this._sceneManager.scene.add(mesh);
      this._current = mesh;
      mmdStore.setMesh(mesh);
      return mesh;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'PMX の読み込みに失敗しました';
      mmdStore.setError({ type: 'load', message });
      throw e;
    }
  }

  unload(): void {
    if (!this._current) return;
    this._sceneManager.scene.remove(this._current);
    this._disposeMesh(this._current);
    this._current = null;
    mmdStore.reset();
  }

  private _disposeMesh(mesh: THREE.SkinnedMesh): void {
    mesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          for (const key of Object.keys(mat)) {
            const val = (mat as Record<string, unknown>)[key];
            if (val instanceof THREE.Texture) val.dispose();
          }
          mat.dispose();
        }
      }
    });
  }
}
