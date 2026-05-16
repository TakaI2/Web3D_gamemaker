<script lang="ts">
  import { xrStore } from '../stores/xrStore';
  import type { XRSessionManager } from '../xr/XRSessionManager';
  import type { XRMode } from '../types';

  export let xrSessionManager: XRSessionManager | null = null;

  async function enter(mode: XRMode) {
    await xrSessionManager?.enterXR(mode);
  }

  async function exit() {
    await xrSessionManager?.exitXR();
  }
</script>

<div class="xr-controls">
  {#if $xrStore.isActive}
    <button class="exit-btn" on:click={exit}>XR 終了</button>
    <span class="mode-label">
      {$xrStore.activeMode === 'vr' ? '🥽 VRモード' : '👁 ARモード'}
    </span>
  {:else}
    <button
      class="vr-btn"
      on:click={() => enter('vr')}
      disabled={!$xrStore.support.vr}
      title={$xrStore.support.vr ? 'VRモードで開く' : 'このブラウザはVRに非対応です'}
    >
      🥽 VR
    </button>
    <button
      class="ar-btn"
      on:click={() => enter('ar')}
      disabled={!$xrStore.support.ar}
      title={$xrStore.support.ar ? 'ARモードで開く' : 'このブラウザはARに非対応です'}
    >
      👁 AR
    </button>
  {/if}
  {#if $xrStore.error}
    <p class="xr-error">{$xrStore.error.message}</p>
  {/if}
</div>

<style>
  .xr-controls { display: flex; flex-direction: column; gap: 6px; }
  .vr-btn, .ar-btn, .exit-btn {
    padding: 8px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: bold;
  }
  .vr-btn { background: #4a3a8a; color: #fff; }
  .vr-btn:not(:disabled):hover { background: #5a4aaa; }
  .ar-btn { background: #2a6a5a; color: #fff; }
  .ar-btn:not(:disabled):hover { background: #3a8a6a; }
  .exit-btn { background: #6a3a2a; color: #fff; }
  .exit-btn:hover { background: #8a4a3a; }
  button:disabled { background: #333; color: #666; cursor: not-allowed; }
  .mode-label { font-size: 13px; color: #4af; text-align: center; }
  .xr-error { font-size: 11px; color: #f88; margin: 0; }
</style>
