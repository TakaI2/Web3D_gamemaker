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
  <button class="mode-btn stage-btn" on:click={() => appModeStore.toStageEditor()}>
    ステージ編集
  </button>
  <a class="mode-btn cloth-btn" href="https://localhost:5174/htdocs/3d_game/cloth-editor/" target="_blank">
    布エディタ ↗
  </a>
  <a class="mode-btn npc-btn" href="https://localhost:5174/htdocs/3d_game/fps-cloth-vrm/" target="_blank">
    VRM NPC ↗
  </a>
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
  .stage-btn { background: #557; }
  .stage-btn:hover { background: #668; }
  .cloth-btn { background: #466; text-decoration: none; text-align: center; }
  .cloth-btn:hover { background: #577; }
  .npc-btn { background: #644; text-decoration: none; text-align: center; }
  .npc-btn:hover { background: #755; }
</style>
