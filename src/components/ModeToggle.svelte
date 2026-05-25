<script lang="ts">
  import { appModeStore } from '../stores/appModeStore';
</script>

<div class="mode-btns">
  <button class="mode-btn game-btn" on:click={() => appModeStore.toGame()}>
    ゲーム ▶
  </button>
  <button class="mode-btn retarget-btn" on:click={() => appModeStore.toRetarget()}>
    比較 ⇄
  </button>
  <button class="mode-btn fps-btn" on:click={() => appModeStore.toFps()}>
    FPS ▶
  </button>
</div>

<style>
  .mode-btns {
    position: fixed;
    top: 12px;
    left: 12px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mode-btn {
    padding: 7px 14px;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    opacity: 0.9;
  }
  .mode-btn:hover { opacity: 1; }
  .game-btn { background: #2a6; }
  .game-btn:hover { background: #3b7; }
  .retarget-btn { background: #47a; }
  .retarget-btn:hover { background: #58b; }
  .fps-btn { background: #a64; }
  .fps-btn:hover { background: #b75; }
</style>
