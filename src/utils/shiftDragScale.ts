import type * as THREE from 'three';

/**
 * Shift+左ドラッグでオブジェクトをスケール変更する。
 * 上ドラッグ→拡大、下ドラッグ→縮小。1px あたり 0.4% の線形変化。
 *
 * @param canvas         イベント対象のキャンバス
 * @param getTarget      スケール対象オブジェクトを返す関数（null なら何もしない）
 * @param onScaleChange  スケール変更後に呼ぶコールバック（refit など）
 * @param setOrbitEnabled OrbitControls の有効/無効切替
 * @returns クリーンアップ関数
 */
export function attachShiftDragScale(
  canvas: HTMLCanvasElement,
  getTarget: () => THREE.Object3D | null,
  onScaleChange: () => void,
  setOrbitEnabled: (enabled: boolean) => void,
): () => void {
  const SENSITIVITY = 0.004; // 1px あたりのスケール変化率
  let dragging = false;
  let lastY = 0;

  function onMouseDown(e: MouseEvent) {
    if (!e.shiftKey || e.button !== 0) return;
    if (!getTarget()) return;
    e.preventDefault();
    dragging = true;
    lastY = e.clientY;
    setOrbitEnabled(false);
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging) return;
    const dy = e.clientY - lastY;
    lastY = e.clientY;
    if (dy === 0) return;
    const target = getTarget();
    if (!target) return;
    // 上ドラッグ（dy < 0）で拡大、下ドラッグ（dy > 0）で縮小
    const factor = 1 - dy * SENSITIVITY;
    target.scale.multiplyScalar(Math.max(0.001, factor));
    onScaleChange();
  }

  function onMouseUp(_e: MouseEvent) {
    if (!dragging) return;
    dragging = false;
    setOrbitEnabled(true);
    // ドラッグ終了後に refit
    onScaleChange();
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.key === 'Shift' && dragging) {
      dragging = false;
      setOrbitEnabled(true);
    }
  }

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keyup', onKeyUp);
  };
}
