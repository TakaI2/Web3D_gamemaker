<script lang="ts">
  import MMDFileLoader from './MMDFileLoader.svelte';
  import VMDList from './VMDList.svelte';
  import VMDControls from './VMDControls.svelte';
  import { mmdStore } from '../stores/mmdStore';
  import type { MMDModelLoader } from '../core/MMDModelLoader';
  import type { VMDManager } from '../core/VMDManager';

  export let mmdModelLoader: MMDModelLoader | null = null;
  export let vmdManager: VMDManager | null = null;
</script>

<div class="mmd-header">
  <span class="title">MMD Editor</span>
  <div class="loader-btns">
    <MMDFileLoader {mmdModelLoader} {vmdManager} />
  </div>
</div>

{#if $mmdStore.error}
  <p class="error">{$mmdStore.error.message}</p>
{/if}

{#if $mmdStore.mesh}
  <div class="section-label">モデル読み込み済み</div>
{/if}

<div class="section-label">モーション</div>
<VMDList {vmdManager} />
<hr />
<VMDControls {vmdManager} />

<style>
  .mmd-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  .title { font-size: 14px; font-weight: bold; color: #fa4; }
  .loader-btns {
    display: flex;
    gap: 4px;
  }
  .section-label {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 0;
  }
  .error {
    font-size: 11px;
    color: #f88;
    margin: 4px 0;
  }
  hr { border: none; border-top: 1px solid #333; margin: 4px 0; }
</style>
