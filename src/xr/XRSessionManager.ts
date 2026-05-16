import type { SceneManager } from '../core/SceneManager';
import type { OrbitController } from '../core/OrbitController';
import { xrStore } from '../stores/xrStore';
import type { XRMode } from '../types';

export class XRSessionManager {
  private _sceneManager: SceneManager;
  private _orbitController: OrbitController;
  private _session: XRSession | null = null;

  constructor(sceneManager: SceneManager, orbitController: OrbitController) {
    this._sceneManager = sceneManager;
    this._orbitController = orbitController;
  }

  async checkSupport(): Promise<void> {
    if (!navigator.xr) {
      xrStore.setSupport({ vr: false, ar: false });
      return;
    }
    const [vr, ar] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-vr'),
      navigator.xr.isSessionSupported('immersive-ar'),
    ]);
    xrStore.setSupport({ vr, ar });
  }

  async enterXR(mode: XRMode): Promise<void> {
    if (!navigator.xr) return;

    // 既存セッションを終了してから開始
    if (this._session) {
      await this.exitXR();
      // 1フレーム待機（セッション終了が確定するまで）
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    try {
      const xrMode = mode === 'vr' ? 'immersive-vr' : 'immersive-ar';
      const sessionInit: XRSessionInit = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: mode === 'ar' ? ['dom-overlay'] : [],
      };

      const session = await navigator.xr.requestSession(xrMode, sessionInit);
      this._session = session;

      await this._sceneManager.renderer.xr.setSession(session);

      // AR モードは背景を透明に
      if (mode === 'ar') {
        this._sceneManager.setClearAlpha(0);
      } else {
        this._sceneManager.setClearAlpha(1);
      }

      this._orbitController.setEnabled(false);
      xrStore.setActive(mode);

      session.addEventListener('end', () => {
        this._onSessionEnd();
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'XR セッションの開始に失敗しました';
      xrStore.setError({ type: 'xr', message });
    }
  }

  async exitXR(): Promise<void> {
    if (!this._session) return;
    await this._session.end();
    // end イベントで _onSessionEnd() が呼ばれる
  }

  get isActive(): boolean {
    return this._session !== null;
  }

  private _onSessionEnd(): void {
    this._session = null;
    this._sceneManager.setClearAlpha(1);
    this._orbitController.setEnabled(true);
    xrStore.setInactive();
  }
}
