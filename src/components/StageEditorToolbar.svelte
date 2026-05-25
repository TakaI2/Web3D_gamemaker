<script lang="ts">
  import { appModeStore } from '../stores/appModeStore';
  import { stageEditorStore } from '../stores/stageEditorStore';
  import { saveJson, loadJson, exportGlb, downloadBlob } from '../stage-editor/StageEditorExporter';
  import type { SnapSize } from '../stage-editor/types';
  import type * as THREE from 'three';

  export let getMeshMap: () => Map<string, THREE.Mesh>;

  $: toolMode = $stageEditorStore.toolMode;
  $: snapSize = $stageEditorStore.snapSize;

  const snapOptions: SnapSize[] = [0.5, 1, 2, 4];

  let loadInput: HTMLInputElement;
  let exporting = false;

  function onSnapChange(e: Event): void {
    const val = parseFloat((e.currentTarget as HTMLSelectElement).value) as SnapSize;
    stageEditorStore.setSnapSize(val);
  }

  function onLoadFile(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    loadJson(file)
      .then((def) => {
        stageEditorStore.reset();
        for (const obj of def.objects) {
          stageEditorStore.addObject({
            shape: obj.shape,
            position: obj.position,
            rotation: obj.rotation,
            scale: obj.scale,
            material: obj.material,
          });
        }
      })
      .catch((err: unknown) => {
        console.error('JSON 読み込み失敗:', err);
        alert('シーンの読み込みに失敗しました。');
      });
    (e.target as HTMLInputElement).value = '';
  }

  async function onExportGlb(): Promise<void> {
    exporting = true;
    try {
      const meshMap = getMeshMap();
      if (meshMap.size === 0) {
        alert('オブジェクトが 1 つもありません。');
        return;
      }
      const buf = await exportGlb(meshMap);
      downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), 'stage.glb');
    } catch (err: unknown) {
      console.error('GLB エクスポート失敗:', err);
      alert('GLB エクスポートに失敗しました。');
    } finally {
      exporting = false;
    }
  }

  async function onFpsPreview(): Promise<void> {
    exporting = true;
    try {
      const meshMap = getMeshMap();
      if (meshMap.size === 0) {
        alert('オブジェクトが 1 つもありません。');
        return;
      }
      const buf = await exportGlb(meshMap);
      const blob = new Blob([buf], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      stageEditorStore.setPreviewGlbUrl(url);
      appModeStore.toFps();
    } catch (err: unknown) {
      console.error('FPS プレビュー失敗:', err);
      alert('FPS プレビューの起動に失敗しました。');
    } finally {
      exporting = false;
    }
  }
</script>

<div class="toolbar">
  <button class="tb-btn back-btn" on:click={() => appModeStore.toEditor()}>← エディタ</button>

  <div class="tb-separator"></div>

  <div class="tb-group">
    <button
      class="tb-btn mode-btn"
      class:active={toolMode === 'place'}
      on:click={() => stageEditorStore.setToolMode('place')}
    >配置</button>
    <button
      class="tb-btn mode-btn"
      class:active={toolMode === 'select'}
      on:click={() => stageEditorStore.setToolMode('select')}
    >選択</button>
  </div>

  <div class="tb-separator"></div>

  <label class="tb-label">
    スナップ
    <select value={snapSize} on:change={onSnapChange}>
      {#each snapOptions as s}
        <option value={s}>{s}</option>
      {/each}
    </select>
  </label>

  <div class="tb-separator"></div>

  <button class="tb-btn" on:click={() => saveJson($stageEditorStore.objects)}>
    JSON 保存
  </button>
  <button class="tb-btn" on:click={() => loadInput.click()}>
    JSON 読込
  </button>
  <input bind:this={loadInput} type="file" accept=".json" style="display:none" on:change={onLoadFile} />

  <div class="tb-separator"></div>

  <button class="tb-btn export-btn" on:click={onExportGlb} disabled={exporting}>
    {exporting ? '処理中...' : 'GLB 書出'}
  </button>

  <button class="tb-btn fps-btn" on:click={onFpsPreview} disabled={exporting}>
    🎮 FPS テスト
  </button>
</div>

<style>
  .toolbar {
    height: 44px;
    background: #11111e;
    border-bottom: 1px solid #2a2a3e;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    flex-shrink: 0;
  }
  .tb-btn {
    background: #1e1e2e;
    border: 1px solid #2a2a3e;
    border-radius: 4px;
    color: #aaa;
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tb-btn:hover:not(:disabled) { background: #252535; color: #ddd; }
  .tb-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .tb-btn.active { background: #2a3a5e; border-color: #4488cc; color: #7ab; }
  .back-btn { color: #888; }
  .export-btn { border-color: #446; color: #9ad; }
  .fps-btn { background: #1e2a1e; border-color: #4a6; color: #8c8; }
  .fps-btn:hover:not(:disabled) { background: #223a22; }

  .tb-separator {
    width: 1px;
    height: 24px;
    background: #2a2a3e;
    margin: 0 2px;
  }
  .tb-group { display: flex; gap: 2px; }
  .tb-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #888;
  }
  select {
    background: #1e1e2e;
    border: 1px solid #2a2a3e;
    border-radius: 4px;
    color: #aaa;
    padding: 3px 6px;
    font-size: 12px;
  }
</style>
