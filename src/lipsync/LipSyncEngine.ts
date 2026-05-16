import type { VRM } from '@pixiv/three-vrm';
import type { VisemeKey } from '../types';
import { lipSyncStore } from '../stores/lipSyncStore';
import { isJapanese, jpCharToViseme } from './JapaneseLipSync';
import { isAsciiAlpha, enCharToViseme } from './EnglishLipSync';

export class LipSyncEngine {
  private _vrm: VRM | null = null;
  private _timerId: ReturnType<typeof setInterval> | null = null;
  private _targetViseme: VisemeKey = 'neutral';

  setVRM(vrm: VRM): void {
    this._vrm = vrm;
  }

  play(text: string, charsPerSecond: number): void {
    if (!text) return;

    this.stop();

    const chars = text.split('');
    let index = 0;
    const interval = 1000 / charsPerSecond;

    lipSyncStore.setPlaying(true);

    this._timerId = setInterval(() => {
      if (index >= chars.length) {
        this._finish();
        return;
      }
      const char = chars[index];
      const viseme = this._charToViseme(char);
      this._targetViseme = viseme;
      lipSyncStore.appendChar(char);
      lipSyncStore.setViseme(viseme);
      index++;
    }, interval);
  }

  stop(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    this._targetViseme = 'neutral';
    this._applyViseme('neutral', 1.0);
    lipSyncStore.reset();
  }

  /**
   * RenderLoop から毎フレーム呼び出す
   * 現在の Viseme をターゲットに向けて LERP する
   */
  update(_delta: number): void {
    if (!this._vrm?.expressionManager) return;

    const lerpFactor = 0.3;
    const allVisemes: VisemeKey[] = ['aa', 'ih', 'ou', 'ee', 'oh', 'neutral'];

    for (const v of allVisemes) {
      const target = v === this._targetViseme ? 1.0 : 0.0;
      const current = this._vrm.expressionManager.getValue(v) ?? 0;
      const next = current + (target - current) * lerpFactor;
      // サイレントスキップ: Expression が存在しない場合は何もしない
      try {
        this._vrm.expressionManager.setValue(v, next);
      } catch {
        // Expression が未定義の VRM では無視
      }
    }
  }

  get isPlaying(): boolean {
    return this._timerId !== null;
  }

  private _charToViseme(char: string): VisemeKey {
    if (isJapanese(char)) return jpCharToViseme(char);
    if (isAsciiAlpha(char)) return enCharToViseme(char);
    return 'neutral';
  }

  private _finish(): void {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    this._targetViseme = 'neutral';
    lipSyncStore.setPlaying(false);
    lipSyncStore.setViseme('neutral');
  }

  private _applyViseme(viseme: VisemeKey, weight: number): void {
    if (!this._vrm?.expressionManager) return;
    try {
      this._vrm.expressionManager.setValue(viseme, weight);
    } catch {
      // Expression 未定義は無視
    }
  }
}
