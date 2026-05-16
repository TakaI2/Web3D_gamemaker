import { writable } from 'svelte/store';
import type { LipSyncState, VisemeKey } from '../types';

const initialState: LipSyncState = {
  isPlaying: false,
  displayedText: '',
  currentViseme: 'neutral',
  charsPerSecond: 8,
};

const { subscribe, set, update } = writable<LipSyncState>(initialState);

export const lipSyncStore = {
  subscribe,
  setPlaying: (isPlaying: boolean) =>
    update((s) => ({ ...s, isPlaying })),
  appendChar: (char: string) =>
    update((s) => ({ ...s, displayedText: s.displayedText + char })),
  setViseme: (currentViseme: VisemeKey) =>
    update((s) => ({ ...s, currentViseme })),
  setSpeed: (charsPerSecond: number) =>
    update((s) => ({ ...s, charsPerSecond })),
  reset: () => set(initialState),
};
