<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { vrmStore } from '../stores/vrmStore';
  import { extractVRMFile, extractVRMAFiles } from '../utils/fileHelpers';
  import type { VRMLoader } from '../core/VRMLoader';
  import type { AnimationManager } from '../core/AnimationManager';

  export let vrmLoader: VRMLoader | null = null;
  export let animationManager: AnimationManager | null = null;

  let isDragging = false;
  let dragCounter = 0;
  let toast: string | null = null;
  type ListMode = 'vrm' | 'vrma' | null;
  let serverFiles: string[] = [];
  let listMode: ListMode = null;

  async function fetchList(mode: 'vrm' | 'vrma') {
    listMode = mode;
    try {
      const res = await fetch(`/${mode}/manifest.json`);
      serverFiles = res.ok ? await res.json() : [];
    } catch {
      serverFiles = [];
    }
  }

  async function loadFromServer(filename: string) {
    const mode = listMode;
    listMode = null;
    try {
      if (mode === 'vrma') {
        if (!animationManager) { showToast('先に VRM を読み込んでください'); return; }
        await animationManager.loadVRMAFromUrl(`/vrma/${filename}`);
      } else {
        if (!vrmLoader) return;
        await vrmLoader.loadFromUrl(`/vrm/${filename}`);
      }
    } catch {
      showToast('読み込みに失敗しました');
    }
  }

  function showToast(msg: string) {
    toast = msg;
    setTimeout(() => (toast = null), 3000);
  }

  // window レベルでドラッグイベントを捕捉
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
    const vrm = extractVRMFile(files);
    if (vrm) {
      if (!vrmLoader) return;
      try {
        await vrmLoader.load(vrm);
      } catch {
        showToast('VRM の読み込みに失敗しました');
      }
      return;
    }

    const vrmas = extractVRMAFiles(files);
    if (vrmas.length > 0) {
      if (!animationManager) {
        showToast('先に VRM を読み込んでください');
        return;
      }
      for (const f of vrmas) {
        await animationManager.loadVRMA(f);
      }
      return;
    }

    showToast('非対応のファイル形式です（.vrm / .vrma のみ対応）');
  }

  function onFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) handleFiles(input.files);
  }
</script>

<!-- ドラッグ中のビジュアルフィードバック（pointer-events なし） -->
{#if isDragging}
  <div class="drop-overlay" />
{/if}

<!-- ファイル選択ボタン -->
<label class="file-btn" title="VRM / VRMA ファイルを開く">
  <input
    type="file"
    accept=".vrm,.vrma"
    multiple
    style="display:none"
    on:change={onFileChange}
  />
  📂 開く
</label>

<!-- サーバーから VRM 読み込み -->
<button class="server-btn" on:click={() => fetchList('vrm')} title="サーバーのVRMを読み込む">
  🌐 VRM
</button>

<!-- サーバーから VRMA 読み込み -->
<button class="server-btn" on:click={() => fetchList('vrma')} title="サーバーのVRMAを読み込む">
  🌐 VRMA
</button>

<!-- サーバーファイル一覧 -->
{#if listMode !== null}
  <div class="server-list">
    <div class="server-list-header">
      <span>{listMode === 'vrm' ? 'VRM' : 'VRMA'} ファイル</span>
      <button class="close-btn" on:click={() => (listMode = null)}>✕</button>
    </div>
    {#if serverFiles.length === 0}
      <p class="empty">public/{listMode}/ にファイルがありません</p>
    {:else}
      <div class="server-list-items">
        {#each serverFiles as f}
          <button class="server-item" on:click={() => loadFromServer(f)}>{f}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!-- ローディング表示 -->
{#if $vrmStore.loading}
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
    border: 3px solid #4af;
    background: rgba(64, 170, 255, 0.08);
  }
  .file-btn {
    cursor: pointer;
    padding: 6px 12px;
    background: #333;
    color: #eee;
    border-radius: 4px;
    font-size: 13px;
    user-select: none;
  }
  .file-btn:hover { background: #444; }
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
    min-width: 220px;
    max-width: min(420px, 90vw);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* ファイルが増えても画面内に収め、リストだけスクロール（ヘッダーは固定） */
  .server-list-items {
    max-height: 60vh;
    overflow-y: auto;
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
    overflow-wrap: anywhere;   /* 長いファイル名でも横にはみ出さず折り返す */
  }
  .server-item:hover { background: #444; color: #fff; }
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
