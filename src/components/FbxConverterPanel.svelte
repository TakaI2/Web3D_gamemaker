<script lang="ts">
  import { fbxConvertStore } from '../stores/fbxConvertStore';
  import { convertFbxToVrma } from '../core/FbxToVrmaConverter';

  type FbxEntry = { label: string; url: string; outName: string };

  const SERVER_FILES: FbxEntry[] = [
    { label: 'Standing Idle',               url: '/fbx/Standing Idle.fbx',                        outName: 'Standing_Idle.vrma' },
    { label: 'Catwalk Walk Forward HighKnees', url: '/fbx/Catwalk Walk Forward HighKnees.fbx',    outName: 'Catwalk_Walk_Forward.vrma' },
  ];

  let dragActive = false;

  async function convertEntry(entry: FbxEntry) {
    await runConvert(entry.url, entry.outName);
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.fbx')) {
      fbxConvertStore.setError('FBX ファイルをドロップしてください');
      return;
    }
    const url = URL.createObjectURL(file);
    const outName = file.name.replace(/\.fbx$/i, '.vrma');
    await runConvert(url, outName, () => URL.revokeObjectURL(url));
  }

  async function runConvert(url: string, outName: string, cleanup?: () => void) {
    fbxConvertStore.reset();
    try {
      const result = await convertFbxToVrma(url, outName, (p) => {
        fbxConvertStore.setProgress(p.stage, p.message);
      });
      fbxConvertStore.setDone(result.mappedBoneCount, result.totalBoneCount, outName);
      downloadBlob(result.blob, outName);
    } catch (err) {
      fbxConvertStore.setError(err instanceof Error ? err.message : String(err));
    } finally {
      cleanup?.();
    }
  }

  function downloadBlob(blob: Blob, filename: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  $: busy = ['loading', 'converting', 'exporting'].includes($fbxConvertStore.status);
</script>

<div class="fbx-panel">
  <div class="section-title">FBX → VRMA 変換</div>

  <!-- サーバーファイル一覧 -->
  <div class="file-list">
    {#each SERVER_FILES as entry}
      <div class="file-row">
        <span class="file-label" title={entry.url}>{entry.label}</span>
        <button
          class="convert-btn"
          disabled={busy}
          on:click={() => convertEntry(entry)}
        >変換</button>
      </div>
    {/each}
  </div>

  <!-- ドロップゾーン -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="dropzone"
    class:active={dragActive}
    on:dragover|preventDefault={() => (dragActive = true)}
    on:dragleave={() => (dragActive = false)}
    on:drop={handleDrop}
  >
    <span class="drop-hint">
      {dragActive ? 'ドロップして変換' : 'FBX をここにドロップ'}
    </span>
  </div>

  <!-- ステータス -->
  {#if $fbxConvertStore.status !== 'idle'}
    <div
      class="status"
      class:done={$fbxConvertStore.status === 'done'}
      class:error={$fbxConvertStore.status === 'error'}
      class:busy
    >
      {#if busy}<span class="spinner">⏳</span>{/if}
      {$fbxConvertStore.message}
      {#if $fbxConvertStore.status === 'done'}
        <span class="bone-stats">
          ({$fbxConvertStore.mappedBoneCount}/{$fbxConvertStore.totalBoneCount} ボーン変換)
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fbx-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .section-title {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #1e1e1e;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    padding: 4px 6px;
  }
  .file-label {
    flex: 1;
    font-size: 11px;
    color: #bbb;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .convert-btn {
    padding: 3px 10px;
    background: #1a3a5c;
    border: 1px solid #4af;
    border-radius: 4px;
    color: #4af;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .convert-btn:hover:not(:disabled) { background: #1e4a72; }
  .convert-btn:disabled { opacity: 0.4; cursor: default; }
  .dropzone {
    border: 1px dashed #444;
    border-radius: 4px;
    padding: 10px;
    text-align: center;
    transition: border-color 0.15s, background 0.15s;
    cursor: default;
  }
  .dropzone.active {
    border-color: #4af;
    background: #0e1e2e;
  }
  .drop-hint {
    font-size: 11px;
    color: #555;
  }
  .dropzone.active .drop-hint { color: #4af; }
  .status {
    font-size: 11px;
    color: #888;
    padding: 4px 6px;
    border-radius: 4px;
    background: #1e1e1e;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .status.done { color: #4c4; }
  .status.error { color: #f88; }
  .status.busy { color: #4af; }
  .spinner { font-size: 13px; }
  .bone-stats { color: #888; font-size: 10px; }
</style>
