<script lang="ts">
  import { skeletonStore } from '../stores/skeletonStore';
  import type { SkeletonController } from '../core/SkeletonController';

  export let skeletonController: SkeletonController | null = null;

  let filter = '';

  $: filteredBones = filter.trim()
    ? $skeletonStore.bones.filter((b) =>
        b.name.toLowerCase().includes(filter.trim().toLowerCase())
      )
    : $skeletonStore.bones;

  function toggleVisible() {
    skeletonController?.setVisible(!$skeletonStore.visible);
  }

  function selectBone(index: number) {
    const next = $skeletonStore.selectedBoneIndex === index ? null : index;
    skeletonController?.selectBone(next);
  }
</script>

<div class="skeleton-panel">
  <!-- 表示トグル -->
  <label class="toggle-row">
    <span class="label">アーマチュア表示</span>
    <button
      class="toggle-btn"
      class:on={$skeletonStore.visible}
      on:click={toggleVisible}
      disabled={$skeletonStore.bones.length === 0}
    >
      {$skeletonStore.visible ? 'ON' : 'OFF'}
    </button>
  </label>

  <!-- ボーン数 -->
  <div class="bone-count">
    {#if $skeletonStore.bones.length > 0}
      {$skeletonStore.bones.length} ボーン
      {#if $skeletonStore.selectedBoneIndex !== null}
        <span class="selected-hint">— #{$skeletonStore.selectedBoneIndex} 選択中</span>
      {/if}
    {:else}
      モデルを読み込んでください
    {/if}
  </div>

  {#if $skeletonStore.bones.length > 0}
    <!-- 検索 -->
    <input
      class="search"
      type="text"
      placeholder="ボーン名で絞り込み..."
      bind:value={filter}
    />

    <!-- ボーン一覧 -->
    <div class="bone-list">
      {#each filteredBones as bone (bone.index)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="bone-row"
          class:selected={$skeletonStore.selectedBoneIndex === bone.index}
          on:click={() => selectBone(bone.index)}
        >
          <span class="bone-index">{bone.index}</span>
          <span class="bone-name" title={bone.name}>{bone.name || '(unnamed)'}</span>
        </div>
      {/each}
      {#if filteredBones.length === 0}
        <p class="empty">一致なし</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .skeleton-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
  }
  .label {
    font-size: 12px;
    color: #ccc;
  }
  .toggle-btn {
    padding: 4px 14px;
    border-radius: 12px;
    border: 1px solid #555;
    background: #2a2a2a;
    color: #888;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .toggle-btn.on {
    background: #1a3a5c;
    border-color: #4af;
    color: #4af;
  }
  .toggle-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .bone-count {
    font-size: 11px;
    color: #666;
  }
  .selected-hint {
    color: #fa0;
    font-size: 10px;
  }
  .search {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #ddd;
    font-size: 11px;
    outline: none;
  }
  .search:focus { border-color: #4af; }
  .bone-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 2px;
  }
  .bone-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .bone-row:hover { background: #2a2a2a; }
  .bone-row.selected {
    background: #2a1f00;
    border: 1px solid #fa0;
  }
  .bone-index {
    font-size: 10px;
    color: #555;
    width: 28px;
    flex-shrink: 0;
    text-align: right;
  }
  .bone-row.selected .bone-index { color: #fa0; }
  .bone-name {
    font-size: 11px;
    color: #bbb;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bone-row.selected .bone-name { color: #ffd080; }
  .empty {
    font-size: 11px;
    color: #555;
    text-align: center;
    margin: 8px 0;
  }
</style>
