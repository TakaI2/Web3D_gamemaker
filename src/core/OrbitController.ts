import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SceneManager } from './SceneManager';

export class OrbitController {
  private _controls: OrbitControls;
  private _camera: THREE.PerspectiveCamera;
  private _lastFitObject: THREE.Object3D | null = null;

  constructor(sceneManager: SceneManager) {
    this._camera = sceneManager.camera;
    this._controls = new OrbitControls(
      sceneManager.camera,
      sceneManager.renderer.domElement,
    );
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.minDistance = 0.5;
    this._controls.maxDistance = 10;
    this._controls.target.set(0, 1.0, 0);
    this._controls.update();
  }

  update(): void {
    if (this._controls.enabled) {
      this._controls.update();
    }
  }

  setEnabled(enabled: boolean): void {
    this._controls.enabled = enabled;
  }

  get enabled(): boolean {
    return this._controls.enabled;
  }

  /**
   * モデルの BoundingBox に基づいてカメラをフィットさせる
   */
  fitToObject(object: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fovRad = (this._camera.fov * Math.PI) / 180;
    const distance = (maxDim / 2 / Math.tan(fovRad / 2)) * 1.5;

    // モデルサイズに合わせて距離上限とファークリッピング面を動的に拡張
    this._controls.minDistance = Math.max(0.1, maxDim * 0.05);
    this._controls.maxDistance = distance * 5;
    this._camera.near = Math.max(0.01, maxDim * 0.001);
    this._camera.far  = distance * 20;
    this._camera.updateProjectionMatrix();

    this._controls.target.copy(center);
    this._camera.position.set(center.x, center.y, center.z + distance);
    this._controls.update();
    this._lastFitObject = object;
  }

  /** 最後に fitToObject したオブジェクトに再フィットする */
  refitToLast(): void {
    if (this._lastFitObject) this.fitToObject(this._lastFitObject);
  }

  /**
   * カメラをターゲットに向かって近づける / 遠ざける
   * factor < 1 でズームイン、factor > 1 でズームアウト
   */
  zoom(factor: number): void {
    const offset = this._camera.position.clone().sub(this._controls.target);
    const newLen = Math.max(
      this._controls.minDistance,
      Math.min(this._controls.maxDistance, offset.length() * factor),
    );
    offset.setLength(newLen);
    this._camera.position.copy(this._controls.target).add(offset);
    this._controls.update();
  }

  dispose(): void {
    this._controls.dispose();
  }
}
