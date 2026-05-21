import { writable } from 'svelte/store';
import type { FbxAnimState } from '../types';

const initial: FbxAnimState = { currentName: null, isPlaying: false, isLooping: true };
const { subscribe, set, update } = writable<FbxAnimState>(initial);

export const fbxAnimStore = {
  subscribe,
  setCurrent: (currentName: string | null) =>
    update((s) => ({ ...s, currentName })),
  setPlaying: (isPlaying: boolean) =>
    update((s) => ({ ...s, isPlaying })),
  setLooping: (isLooping: boolean) =>
    update((s) => ({ ...s, isLooping })),
  reset: () => set(initial),
};
