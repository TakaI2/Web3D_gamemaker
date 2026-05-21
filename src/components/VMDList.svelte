<script lang="ts">
  import { vmdStore } from '../stores/vmdStore';
  import type { VMDManager } from '../core/VMDManager';

  export let vmdManager: VMDManager | null = null;

  function selectAnimation(name: string) {
    vmdManager?.play(name);
  }
</script>

<div class="vmd-list">
  {#if $vmdStore.animations.length === 0}
    <p class="empty">VMD ファイルを読み込んでください</p>
  {:else}
    {#each $vmdStore.animations as entry}
      <button
        class="item"
        class:active={$vmdStore.currentName === entry.name}
        on:click={() => selectAnimation(entry.name)}
        title={entry.name}
      >
        {entry.name}
      </button>
    {/each}
  {/if}
</div>

<style>
  .vmd-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .empty {
    font-size: 11px;
    color: #555;
    text-align: center;
    margin: 8px 0;
  }
  .item {
    padding: 6px 8px;
    background: #2a2a2a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #bbb;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: background 0.1s, color 0.1s;
  }
  .item:hover { background: #333; color: #eee; }
  .item.active { background: #1a3a5c; border-color: #4af; color: #4af; }
</style>
