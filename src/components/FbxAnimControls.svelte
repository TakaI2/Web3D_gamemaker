<script lang="ts">
  import { fbxAnimStore } from '../stores/fbxAnimStore';
  import type { FbxModelLoader } from '../core/FbxModelLoader';

  export let fbxModelLoader: FbxModelLoader | null = null;

  function togglePlay() {
    if (!fbxModelLoader) return;
    if ($fbxAnimStore.isPlaying) {
      fbxModelLoader.stop();
    } else if ($fbxAnimStore.currentName) {
      fbxModelLoader.play($fbxAnimStore.currentName);
    }
  }

  function toggleLoop() {
    fbxModelLoader?.setLoop(!$fbxAnimStore.isLooping);
  }
</script>

<div class="controls">
  <button
    class="play-btn"
    disabled={!$fbxAnimStore.currentName}
    on:click={togglePlay}
  >
    {$fbxAnimStore.isPlaying ? '⏹ 停止' : '▶ 再生'}
  </button>

  <label class="loop-label">
    <input
      type="checkbox"
      checked={$fbxAnimStore.isLooping}
      on:change={toggleLoop}
    />
    ループ
  </label>
</div>

<style>
  .controls { display: flex; align-items: center; gap: 8px; }
  .play-btn {
    flex: 1;
    padding: 7px 0;
    background: #2a4a3a;
    border: 1px solid #4a8;
    border-radius: 4px;
    color: #4a8;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .play-btn:hover:not(:disabled) { background: #356a4a; }
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
