<script lang="ts">
  import type { OrbitController } from '../core/OrbitController';

  export let orbitController: OrbitController | null = null;

  const ZOOM_IN  = 0.75;
  const ZOOM_OUT = 1.35;

  let inTimer: ReturnType<typeof setInterval> | null = null;
  let outTimer: ReturnType<typeof setInterval> | null = null;

  function startZoom(factor: number, timerRef: 'in' | 'out') {
    orbitController?.zoom(factor);
    const t = setInterval(() => orbitController?.zoom(factor), 80);
    if (timerRef === 'in') inTimer = t; else outTimer = t;
  }
  function stopZoom(timerRef: 'in' | 'out') {
    if (timerRef === 'in' && inTimer) { clearInterval(inTimer); inTimer = null; }
    if (timerRef === 'out' && outTimer) { clearInterval(outTimer); outTimer = null; }
  }
</script>

<div class="zoom-controls">
  <button
    class="btn"
    on:pointerdown={() => startZoom(ZOOM_IN, 'in')}
    on:pointerup={() => stopZoom('in')}
    on:pointerleave={() => stopZoom('in')}
    aria-label="ズームイン"
  >＋</button>

  <button
    class="btn fit-btn"
    on:click={() => orbitController?.refitToLast()}
    title="表示リセット"
    aria-label="表示リセット"
  >⊙</button>

  <button
    class="btn"
    on:pointerdown={() => startZoom(ZOOM_OUT, 'out')}
    on:pointerup={() => stopZoom('out')}
    on:pointerleave={() => stopZoom('out')}
    aria-label="ズームアウト"
  >－</button>
</div>

<style>
  .zoom-controls {
    position: fixed;
    left: 12px;
    bottom: 40px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 10;
  }
  .btn {
    width: 48px;
    height: 48px;
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid #444;
    border-radius: 8px;
    color: #ddd;
    font-size: 22px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s;
  }
  .btn:active { background: rgba(80, 80, 80, 0.9); }
  .fit-btn { font-size: 18px; }
</style>
