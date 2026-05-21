import { writable } from 'svelte/store';
import type { GameState } from '../types';
import { GAME_CONSTANTS } from '../game/constants';

function loadHighScore(): number {
  const raw = localStorage.getItem(GAME_CONSTANTS.HIGH_SCORE_KEY);
  const parsed = parseFloat(raw ?? '0');
  return isNaN(parsed) ? 0 : parsed;
}

function saveHighScore(score: number): void {
  localStorage.setItem(GAME_CONSTANTS.HIGH_SCORE_KEY, score.toFixed(2));
}

const initialState: GameState = {
  phase: 'start',
  score: 0,
  highScore: loadHighScore(),
};

const { subscribe, update, set } = writable<GameState>(initialState);

export const gameStore = {
  subscribe,

  startGame(): void {
    update((s) => ({ ...s, phase: 'playing', score: 0 }));
  },

  addTime(delta: number): void {
    update((s) => {
      if (s.phase !== 'playing') return s;
      return { ...s, score: s.score + delta };
    });
  },

  gameOver(): void {
    update((s) => {
      const newHigh = Math.max(s.score, s.highScore);
      if (newHigh > s.highScore) saveHighScore(newHigh);
      return { ...s, phase: 'gameover', highScore: newHigh };
    });
  },

  reset(): void {
    update((s) => ({ ...s, phase: 'start', score: 0 }));
  },

  /** テスト用: ストアを完全リセット（highScore も初期化） */
  _resetForTest(): void {
    set({ phase: 'start', score: 0, highScore: 0 });
  },
};
