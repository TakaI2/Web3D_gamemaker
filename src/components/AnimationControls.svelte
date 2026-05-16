<script lang="ts">
  import { animationStore } from '../stores/animationStore';
  import type { AnimationManager } from '../core/AnimationManager';
  import type { SpeedPreset } from '../types';

  export let animationManager: AnimationManager | null = null;

  const speeds: SpeedPreset[] = [0.25, 0.5, 1.0, 2.0];

  function togglePlay() {
    if (!animationManager) return;
    if ($animationStore.isPlaying) {
      animationManager.stop();
    } else if ($animationStore.currentName) {
      animationManager.play($animationStore.currentName);
    }
  }

  function onSeek(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    animationManager?.seek(val);
  }

  function onSpeedChange(e: Event) {
    const val = parseFloat((e.target as HTMLSelectElement).value) as SpeedPreset;
    animationManager?.setSpeed(val);
  }

  function onLoopChange(e: Event) {
    animationManager?.setLoop((e.target as HTMLInputElement).checked);
  }

  function resetTPose() {
    animationManager?.resetTPose();
  }

  function setAPose() {
    animationManager?.setAPose();
  }

  $: canPlay = !!animationManager && !!$animationStore.currentName;
  $: progressPct = ($animationStore.progress * 100).toFixed(1);
</script>

<div class="controls">
  <!-- 再生・停止 -->
  <div class="row">
    <button class="play-btn" on:click={togglePlay} disabled={!canPlay}>
      {$animationStore.isPlaying ? '⏹ 停止' : '▶ 再生'}
    </button>
    <button class="tpose-btn" on:click={resetTPose} title="Tポーズにリセット">T</button>
    <button class="tpose-btn" on:click={setAPose} title="Aポーズにリセット">A</button>
  </div>

  <!-- タイムライン -->
  <div class="row timeline">
    <input
      type="range"
      min="0" max="1" step="0.001"
      value={$animationStore.progress}
      on:change={onSeek}
      disabled={!canPlay}
      style="flex:1"
    />
    <span class="time">{progressPct}%</span>
  </div>

  <!-- ループ・速度 -->
  <div class="row options">
    <label class="loop-label">
      <input type="checkbox" checked={$animationStore.isLooping} on:change={onLoopChange} />
      ループ
    </label>
    <select value={$animationStore.speed} on:change={onSpeedChange} class="speed-sel">
      {#each speeds as s}
        <option value={s}>{s}x</option>
      {/each}
    </select>
  </div>
</div>

<style>
  .controls { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; align-items: center; gap: 6px; }
  .timeline { flex-wrap: nowrap; }
  .options { justify-content: space-between; }
  .play-btn {
    flex: 1;
    padding: 6px;
    background: #1a6a3a;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .play-btn:disabled { background: #333; color: #666; cursor: default; }
  .play-btn:not(:disabled):hover { background: #1f8a4a; }
  .tpose-btn {
    padding: 6px 10px;
    background: #444;
    color: #ccc;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: bold;
  }
  .tpose-btn:hover { background: #555; }
  .time { font-size: 11px; color: #888; min-width: 40px; text-align: right; }
  .loop-label { font-size: 12px; color: #ccc; display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .speed-sel {
    background: #333;
    color: #ccc;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 12px;
  }
</style>
