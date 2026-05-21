<script lang="ts">
  import { fbxStore } from '../stores/fbxStore';
  import { fbxAnimStore } from '../stores/fbxAnimStore';
  import type { FbxModelLoader } from '../core/FbxModelLoader';

  export let fbxModelLoader: FbxModelLoader | null = null;

  function select(name: string) {
    fbxModelLoader?.play(name);
  }
</script>

<div class="anim-list">
  {#if $fbxStore.animationNames.length === 0}
    <p class="empty">
      {$fbxStore.root ? 'アニメーションなし' : 'FBX を読み込んでください'}
    </p>
  {:else}
    {#each $fbxStore.animationNames as name}
      <button
        class="item"
        class:active={$fbxAnimStore.currentName === name}
        on:click={() => select(name)}
        title={name}
      >
        {name}
      </button>
    {/each}
  {/if}
</div>

<style>
  .anim-list { display: flex; flex-direction: column; gap: 3px; }
  .empty { font-size: 11px; color: #555; text-align: center; margin: 8px 0; }
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
