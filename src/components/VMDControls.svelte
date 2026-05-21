<script lang="ts">
  import { vmdStore } from '../stores/vmdStore';
  import type { VMDManager } from '../core/VMDManager';

  export let vmdManager: VMDManager | null = null;

  function togglePlay() {
    if (!vmdManager) return;
    if ($vmdStore.isPlaying) {
      vmdManager.stop();
    } else if ($vmdStore.currentName) {
      vmdManager.play($vmdStore.currentName);
    }
  }

  function toggleLoop() {
    vmdManager?.setLoop(!$vmdStore.isLooping);
  }
</script>

<div class="controls">
  <button
    class="play-btn"
    disabled={!$vmdStore.currentName}
    on:click={togglePlay}
  >
    {$vmdStore.isPlaying ? '⏹ 停止' : '▶ 再生'}
  </button>

  <label class="loop-label">
    <input
      type="checkbox"
      checked={$vmdStore.isLooping}
      on:change={toggleLoop}
    />
    ループ
  </label>
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .play-btn {
    flex: 1;
    padding: 7px 0;
    background: #2a4a6a;
    border: 1px solid #4af;
    border-radius: 4px;
    color: #4af;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .play-btn:hover:not(:disabled) { background: #35608a; }
  .play-btn:disabled { opacity: 0.4; cursor: default; }
  .loop-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #aaa;
    cursor: pointer;
    user-select: none;
  }
  .loop-label input { cursor: pointer; }
</style>
