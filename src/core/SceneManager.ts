import * as THREE from 'three';

export type SceneManagerOptions = {
  antialias?: boolean;
  showGrid?: boolean;
  fov?: number;
  far?: number;
};

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private _gridHelper: THREE.GridHelper | null = null;
  private _directionalLight: THREE.DirectionalLight;
  private _ambientLight: THREE.AmbientLight;

  constructor(canvas: HTMLCanvasElement, options: SceneManagerOptions = {}) {
    const { antialias = true, showGrid = true, fov = 30, far = 20 } = options;

    // シーン
    this.scene = new THREE.Scene();

    // カメラ
    this.camera = new THREE.PerspectiveCamera(
      fov,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      far,
    );
    this.camera.position.set(0, 1.3, 3);

    // レンダラー
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.xr.enabled = true;

    // 照明
    this._directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this._directionalLight.position.set(1, 2, 1);
    this.scene.add(this._directionalLight);

    this._ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this._ambientLight);

    // グリッド
    this.setGrid(showGrid);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setGrid(visible: boolean): void {
    if (visible && !this._gridHelper) {
      this._gridHelper = new THREE.GridHelper(10, 20, 0x444444, 0x222222);
      this.scene.add(this._gridHelper);
    } else if (!visible && this._gridHelper) {
      this.scene.remove(this._gridHelper);
      this._gridHelper.dispose();
      this._gridHelper = null;
    }
  }

  /** AR モード時はシーン背景を透明にする */
  setClearAlpha(alpha: number): void {
    this.renderer.setClearAlpha(alpha);
  }

  dispose(): void {
    this._gridHelper?.dispose();
    this._directionalLight.dispose();
    this._ambientLight.dispose();
    this.renderer.dispose();
  }
}
