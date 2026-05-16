<script lang="ts">
  import { animationStore } from '../stores/animationStore';
  import type { AnimationManager } from '../core/AnimationManager';

  export let animationManager: AnimationManager | null = null;

  function select(name: string) {
    // 選択のみ行う（再生は再生ボタンで）
    animationStore.selectAnimation(name);
    animationStore.setPlaying(false);
    animationManager?.stop();
  }
</script>

<div class="anim-list">
  {#if $animationStore.animations.length === 0}
    <p class="empty">.vrma ファイルをドロップして追加</p>
  {:else}
    {#each $animationStore.animations as entry (entry.name)}
      <button
        class="anim-item"
        class:active={$animationStore.currentName === entry.name}
        on:click={() => select(entry.name)}
      >
        <span class="name">{entry.name}</span>
        <span class="duration">{entry.duration.toFixed(1)}s</span>
      </button>
    {/each}
  {/if}
</div>

<style>
  .anim-list { display: flex; flex-direction: column; gap: 2px; }
  .empty { color: #666; font-size: 12px; text-align: center; padding: 8px 0; }
  .anim-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    background: #2a2a2a;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #ccc;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .anim-item:hover { background: #333; }
  .anim-item.active { border-color: #4af; color: #fff; background: #1a3a4a; }
  .duration { color: #888; font-size: 11px; flex-shrink: 0; margin-left: 8px; }
</style>
