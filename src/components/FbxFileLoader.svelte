<script lang="ts">
  import { fbxStore } from '../stores/fbxStore';
  import type { FbxModelLoader } from '../core/FbxModelLoader';

  export let fbxModelLoader: FbxModelLoader | null = null;

  let fileInput: HTMLInputElement;
  let toast: string | null = null;

  function onFileChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    load(file);
  }

  async function load(file: File) {
    if (!fbxModelLoader) return;
    try {
      await fbxModelLoader.loadFromFile(file);
    } catch {
      showToast('FBX の読み込みに失敗しました');
    } finally {
      fileInput.value = '';
    }
  }

  function unload() {
    fbxModelLoader?.unload();
  }

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 3000);
  }
</script>

<div class="fbx-loader">
  <div class="row">
    <button class="load-btn" on:click={() => fileInput.click()} disabled={$fbxStore.loading}>
      {$fbxStore.loading ? '読み込み中...' : '📂 FBX 選択'}
    </button>
    {#if $fbxStore.root}
      <button class="unload-btn" on:click={unload} title="モデルを削除">✕</button>
    {/if}
  </div>

  {#if $fbxStore.error}
    <p class="error">{$fbxStore.error.message}</p>
  {:else if $fbxStore.root}
    <p class="ok">✓ 読み込み済み</p>
  {/if}

  <input
    bind:this={fileInput}
    type="file"
    accept=".fbx"
    style="display:none"
    on:change={onFileChange}
  />
</div>

{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .fbx-loader { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; gap: 4px; }
  .load-btn {
    flex: 1;
    padding: 6px 10px;
    background: #2a3a4a;
    border: 1px solid #47a;
    border-radius: 4px;
    color: #7bf;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .load-btn:hover:not(:disabled) { background: #334455; }
  .load-btn:disabled { opacity: 0.5; cursor: default; }
  .unload-btn {
    padding: 6px 10px;
    background: #3a2a2a;
    border: 1px solid #755;
    border-radius: 4px;
    color: #f88;
    font-size: 12px;
    cursor: pointer;
  }
  .unload-btn:hover { background: #4a3333; }
  .error { font-size: 11px; color: #f88; margin: 0; }
  .ok { font-size: 11px; color: #4c4; margin: 0; }
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(220, 60, 60, 0.9);
    color: #fff;
    padding: 10px 20px;
    border-radius: 6px;
    font-size: 13px;
    z-index: 30;
    pointer-events: none;
  }
</style>
