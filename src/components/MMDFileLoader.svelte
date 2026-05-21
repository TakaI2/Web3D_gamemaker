<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { mmdStore } from '../stores/mmdStore';
  import type { MMDModelLoader } from '../core/MMDModelLoader';
  import type { VMDManager } from '../core/VMDManager';

  export let mmdModelLoader: MMDModelLoader | null = null;
  export let vmdManager: VMDManager | null = null;

  let isDragging = false;
  let dragCounter = 0;
  let toast: string | null = null;
  type ListMode = 'pmx' | 'vmd' | null;
  let serverFiles: string[] = [];
  let listMode: ListMode = null;

  async function fetchList(mode: 'pmx' | 'vmd') {
    listMode = mode;
    try {
      const res = await fetch(`/${mode}/manifest.json`);
      serverFiles = res.ok ? await res.json() : [];
    } catch {
      serverFiles = [];
    }
  }

  async function loadFromServer(filePath: string) {
    const mode = listMode;
    listMode = null;
    try {
      if (mode === 'vmd') {
        if (!vmdManager) { showToast('先に PMX を読み込んでください'); return; }
        const name = filePath.split('/').pop()?.replace(/\.vmd$/i, '') ?? filePath;
        await vmdManager.loadVMDFromUrl(`/${filePath}`, name);
      } else {
        if (!mmdModelLoader) return;
        await mmdModelLoader.loadFromUrl(`/${filePath}`);
      }
    } catch {
      showToast('読み込みに失敗しました');
    }
  }

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 3000);
  }

  // VMD はドラッグ&ドロップで読み込める（単一ファイル）
  // PMX はテクスチャが別ファイルのためサーバー読み込みのみ対応
  function onWindowDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
    isDragging = true;
  }
  function onWindowDragOver(e: DragEvent) {
    e.preventDefault();
  }
  function onWindowDragLeave() {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      isDragging = false;
    }
  }
  function onWindowDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    isDragging = false;
    if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
  }

  onMount(() => {
    window.addEventListener('dragenter', onWindowDragEnter);
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('dragleave', onWindowDragLeave);
    window.addEventListener('drop', onWindowDrop);
  });
  onDestroy(() => {
    window.removeEventListener('dragenter', onWindowDragEnter);
    window.removeEventListener('dragover', onWindowDragOver);
    window.removeEventListener('dragleave', onWindowDragLeave);
    window.removeEventListener('drop', onWindowDrop);
  });

  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);

    // VRM/VRMA が含まれていたらモード切替を促す
    const hasVrm = arr.some((f) => /\.(vrm|vrma)$/i.test(f.name));
    if (hasVrm) {
      showToast('VRM を読み込むには、上の「VRM」タブに切り替えてください');
      return;
    }

    const vmds = arr.filter((f) => f.name.toLowerCase().endsWith('.vmd'));
    if (vmds.length > 0) {
      if (!vmdManager) {
        showToast('先に PMX モデルを読み込んでください');
        return;
      }
      for (const f of vmds) {
        try {
          await vmdManager.loadVMD(f);
        } catch {
          showToast(`VMD の読み込みに失敗しました: ${f.name}`);
        }
      }
      return;
    }
    showToast('VMD ファイルをドロップしてください（PMX はサーバーから読み込んでください）');
  }
</script>

{#if isDragging}
  <div class="drop-overlay" />
{/if}

<!-- サーバーから PMX 読み込み -->
<button class="server-btn" on:click={() => fetchList('pmx')} title="サーバーのPMXを読み込む">
  🌐 PMX
</button>

<!-- サーバーから VMD 読み込み -->
<button class="server-btn" on:click={() => fetchList('vmd')} title="サーバーのVMDを読み込む">
  🌐 VMD
</button>

<!-- サーバーファイル一覧 -->
{#if listMode !== null}
  <div class="server-list">
    <div class="server-list-header">
      <span>{listMode === 'pmx' ? 'PMX モデル' : 'VMD モーション'}</span>
      <button class="close-btn" on:click={() => (listMode = null)}>✕</button>
    </div>
    {#if serverFiles.length === 0}
      <p class="empty">
        {listMode === 'pmx'
          ? 'public/ に .pmx ファイルがありません'
          : 'public/ に .vmd ファイルがありません'}
      </p>
    {:else}
      {#each serverFiles as f}
        <button class="server-item" on:click={() => loadFromServer(f)}>
          {f.split('/').pop()}
          <span class="path-hint">{f.includes('/') ? f.split('/').slice(0, -1).join('/') : ''}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}

<!-- ローディング表示 -->
{#if $mmdStore.loading}
  <div class="spinner">読み込み中...</div>
{/if}

<!-- トースト -->
{#if toast}
  <div class="toast">{toast}</div>
{/if}

<style>
  .drop-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 5;
    border: 3px solid #fa4;
    background: rgba(255, 170, 64, 0.08);
  }
  .server-btn {
    cursor: pointer;
    padding: 6px 10px;
    background: #333;
    color: #eee;
    border: none;
    border-radius: 4px;
    font-size: 13px;
  }
  .server-btn:hover { background: #444; }
  .server-list {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #2a2a2a;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 12px;
    min-width: 260px;
    max-height: 60vh;
    overflow-y: auto;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .server-list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #eee;
    font-size: 13px;
    font-weight: bold;
    margin-bottom: 4px;
  }
  .close-btn {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
  }
  .close-btn:hover { color: #fff; }
  .server-item {
    padding: 6px 8px;
    background: #333;
    border: none;
    border-radius: 4px;
    color: #ccc;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .server-item:hover { background: #444; color: #fff; }
  .path-hint {
    font-size: 10px;
    color: #666;
  }
  .empty { font-size: 12px; color: #666; text-align: center; margin: 4px 0; }
  .spinner {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #fff;
    background: rgba(0,0,0,0.7);
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 20;
  }
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
