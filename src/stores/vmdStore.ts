import { writable } from 'svelte/store';
import type { VMDState, VMDEntry } from '../types';

const initialState: VMDState = {
  animations: [],
  currentName: null,
  isPlaying: false,
  isLooping: true,
};

const { subscribe, set, update } = writable<VMDState>(initialState);

export const vmdStore = {
  subscribe,
  addAnimation: (entry: VMDEntry) =>
    update((s) => ({ ...s, animations: [...s.animations, entry] })),
  selectAnimation: (name: string | null) =>
    update((s) => ({ ...s, currentName: name })),
  setPlaying: (isPlaying: boolean) =>
    update((s) => ({ ...s, isPlaying })),
  setLooping: (isLooping: boolean) =>
    update((s) => ({ ...s, isLooping })),
  resetAnimations: () => set(initialState),
};
