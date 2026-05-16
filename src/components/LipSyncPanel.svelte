<script lang="ts">
  import { lipSyncStore } from '../stores/lipSyncStore';
  import { vrmStore } from '../stores/vrmStore';
  import type { LipSyncEngine } from '../lipsync/LipSyncEngine';

  export let lipSyncEngine: LipSyncEngine | null = null;

  let inputText = '';

  function play() {
    if (!inputText.trim() || !lipSyncEngine) return;
    lipSyncStore.reset();
    lipSyncEngine.play(inputText, $lipSyncStore.charsPerSecond);
  }

  function stop() {
    lipSyncEngine?.stop();
  }

  function onSpeedChange(e: Event) {
    const val = parseFloat((e.target as HTMLInputElement).value);
    lipSyncStore.setSpeed(val);
  }
</script>

<div class="panel">
  <textarea
    bind:value={inputText}
    placeholder="セリフを入力..."
    rows="3"
    disabled={!$vrmStore.vrm}
  />
  <div class="row">
    <button class="play-btn" on:click={play} disabled={!$vrmStore.vrm || !inputText.trim()}>
      ▶ 再生
    </button>
    <button class="stop-btn" on:click={stop} disabled={!$lipSyncStore.isPlaying}>
      ⏹ 停止
    </button>
  </div>
  <label class="speed-row">
    速度 <span class="val">{$lipSyncStore.charsPerSecond} 文字/秒</span>
    <input type="range" min="1" max="20" step="1"
      value={$lipSyncStore.charsPerSecond}
      on:input={onSpeedChange} />
  </label>
  {#if $lipSyncStore.displayedText}
    <div class="display-text">{$lipSyncStore.displayedText}</div>
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 8px; }
  textarea {
    background: #222;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 6px;
    font-size: 13px;
    resize: vertical;
    font-family: sans-serif;
  }
  textarea:disabled { opacity: 0.4; }
  .row { display: flex; gap: 6px; }
  .play-btn {
    flex: 1;
    padding: 6px;
    background: #2a5a8a;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .play-btn:disabled { background: #333; color: #666; cursor: default; }
  .play-btn:not(:disabled):hover { background: #3a6aaa; }
  .stop-btn {
    padding: 6px 12px;
    background: #5a2a2a;
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }
  .stop-btn:disabled { background: #333; color: #666; cursor: default; }
  .stop-btn:not(:disabled):hover { background: #7a3a3a; }
  .speed-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #ccc;
  }
  .speed-row input[type="range"] { flex: 1; }
  .val { color: #4af; min-width: 72px; text-align: right; font-size: 11px; }
  .display-text {
    background: #1a1a2a;
    border: 1px solid #334;
    border-radius: 4px;
    padding: 6px;
    font-size: 13px;
    color: #adf;
    min-height: 32px;
    word-break: break-all;
  }
</style>
