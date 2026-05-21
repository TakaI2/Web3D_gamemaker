<script lang="ts">
  import { gameStore } from '../stores/gameStore';
  import { appModeStore } from '../stores/appModeStore';

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function handleStart(): void {
    gameStore.startGame();
  }

  function handleRetry(): void {
    gameStore.reset();
  }

  function handleToEditor(): void {
    gameStore.reset();
    appModeStore.toEditor();
  }
</script>

{#if $gameStore.phase === 'start'}
  <div class="overlay" role="button" tabindex="0"
       on:click={handleStart}
       on:keydown={(e) => e.key === 'Enter' && handleStart()}>
    <p class="start-text">クリックでスタート</p>
  </div>
{/if}

{#if $gameStore.phase === 'playing'}
  <div class="score-display">
    {formatTime($gameStore.score)}
  </div>
{/if}

{#if $gameStore.phase === 'gameover'}
  <div class="overlay gameover">
    <h2>GAME OVER</h2>
    <p class="score-line">スコア: <span class="score-value">{formatTime($gameStore.score)}</span></p>
    <p class="score-line">ハイスコア: <span class="score-value">{formatTime($gameStore.highScore)}</span></p>
    <div class="buttons">
      <button class="btn retry" on:click={handleRetry}>リトライ</button>
      <button class="btn editor" on:click={handleToEditor}>エディタへ</button>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    z-index: 50;
    cursor: pointer;
    user-select: none;
  }

  .overlay.gameover {
    cursor: default;
  }

  .start-text {
    font-size: 2rem;
    letter-spacing: 0.1em;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }

  .score-display {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    color: #fff;
    font-size: 1.6rem;
    font-family: monospace;
    font-weight: bold;
    text-shadow: 0 2px 6px rgba(0,0,0,0.8);
    z-index: 50;
    pointer-events: none;
  }

  h2 {
    font-size: 3rem;
    margin: 0 0 1rem;
    color: #ff5555;
  }

  .score-line {
    font-size: 1.2rem;
    margin: 0.3rem 0;
  }

  .score-value {
    font-family: monospace;
    font-size: 1.4rem;
    color: #ffe066;
  }

  .buttons {
    margin-top: 1.5rem;
    display: flex;
    gap: 1rem;
  }

  .btn {
    padding: 10px 24px;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    font-weight: bold;
  }

  .retry {
    background: #2a6;
    color: #fff;
  }

  .retry:hover {
    background: #3b7;
  }

  .editor {
    background: #446;
    color: #ccc;
  }

  .editor:hover {
    background: #558;
    color: #fff;
  }
</style>
