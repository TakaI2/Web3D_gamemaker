<script lang="ts">
  import type { VRM } from '@pixiv/three-vrm';
  import { animEditorStore } from '../stores/animEditorStore';

  export let vrm: VRM;

  $: state = $animEditorStore;

  // 表情名一覧（VRM から取得）
  $: expressionNames = vrm.expressionManager
    ? [...Object.keys(vrm.expressionManager.expressionMap)]
    : [];

  // 各表情の現在スライダー値
  let sliderValues: Record<string, number> = {};
  $: {
    for (const name of expressionNames) {
      if (!(name in sliderValues)) sliderValues[name] = 0;
    }
  }

  function onSliderInput(name: string, value: number): void {
    sliderValues[name] = value;
    sliderValues = sliderValues; // trigger reactivity
    // リアルタイムプレビュー
    if (vrm.expressionManager) {
      vrm.expressionManager.setValue(name as Parameters<typeof vrm.expressionManager.setValue>[0], value);
    }
  }

  function addKeyframe(name: string): void {
    animEditorStore.setBlendShapeKeyframe(name, state.currentFrame, sliderValues[name] ?? 0);
  }
</script>

<div class="facial-panel">
  <div class="panel-title">表情 (ブレンドシェイプ)</div>
  {#if expressionNames.length === 0}
    <div class="empty">このモデルには表情データがありません</div>
  {:else}
    {#each expressionNames as name}
      <div class="expr-row">
        <span class="expr-name">{name}</span>
        <input
          type="range" min="0" max="1" step="0.01"
          value={sliderValues[name] ?? 0}
          on:input={(e) => onSliderInput(name, parseFloat(e.currentTarget.value))}
          class="expr-slider"
        />
        <span class="expr-val">{(sliderValues[name] ?? 0).toFixed(2)}</span>
        <button class="key-btn" on:click={() => addKeyframe(name)} title="このフレームにキーを追加">K</button>
      </div>
    {/each}
  {/if}
</div>

<style>
  .facial-panel {
    padding: 8px;
    background: #1a1a1a;
    overflow-y: auto;
    flex: 1;
  }
  .panel-title {
    font-size: 12px;
    color: #888;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .empty {
    color: #555;
    font-size: 12px;
  }
  .expr-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
  }
  .expr-name {
    font-size: 11px;
    color: #bba;
    width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .expr-slider {
    flex: 1;
    min-width: 0;
    accent-color: #f8a;
  }
  .expr-val {
    font-size: 10px;
    color: #888;
    width: 32px;
    text-align: right;
    flex-shrink: 0;
  }
  .key-btn {
    background: #333;
    border: 1px solid #555;
    color: #ccc;
    font-size: 10px;
    padding: 1px 5px;
    cursor: pointer;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .key-btn:hover { background: #444; }
</style>
