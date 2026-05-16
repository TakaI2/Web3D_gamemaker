import * as THREE from 'three';
import type { SceneManager } from './SceneManager';

export type UpdateCallback = (delta: number) => void;

export class RenderLoop {
  private _clock: THREE.Clock;
  private _sceneManager: SceneManager;
  private _callbacks: UpdateCallback[] = [];
  private _running = false;

  constructor(sceneManager: SceneManager) {
    this._clock = new THREE.Clock();
    this._sceneManager = sceneManager;
  }

  /** 更新コールバックを登録する */
  addCallback(cb: UpdateCallback): void {
    this._callbacks.push(cb);
  }

  /** 更新コールバックを削除する */
  removeCallback(cb: UpdateCallback): void {
    this._callbacks = this._callbacks.filter((c) => c !== cb);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._clock.start();

    // WebXR 対応: renderer.setAnimationLoop を使用
    this._sceneManager.renderer.setAnimationLoop(() => {
      const delta = this._clock.getDelta();
      for (const cb of this._callbacks) {
        cb(delta);
      }
      const { renderer, scene, camera } = this._sceneManager;
      renderer.render(scene, camera);
    });
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._sceneManager.renderer.setAnimationLoop(null);
    this._clock.stop();
  }

  get running(): boolean {
    return this._running;
  }
}
