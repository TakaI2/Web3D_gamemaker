import { writable } from 'svelte/store';
import type { AnimationState, AnimationEntry, SpeedPreset } from '../types';

const initialState: AnimationState = {
  animations: [],
  currentName: null,
  isPlaying: false,
  isLooping: true,
  speed: 1.0,
  progress: 0,
};

const { subscribe, set, update } = writable<AnimationState>(initialState);

export const animationStore = {
  subscribe,
  addAnimation: (entry: AnimationEntry) =>
    update((s) => ({ ...s, animations: [...s.animations, entry] })),
  removeAnimation: (name: string) =>
    update((s) => ({
      ...s,
      animations: s.animations.filter((a) => a.name !== name),
      currentName: s.currentName === name ? null : s.currentName,
    })),
  selectAnimation: (name: string | null) =>
    update((s) => ({ ...s, currentName: name })),
  setPlaying: (isPlaying: boolean) =>
    update((s) => ({ ...s, isPlaying })),
  setLooping: (isLooping: boolean) =>
    update((s) => ({ ...s, isLooping })),
  setSpeed: (speed: SpeedPreset) =>
    update((s) => ({ ...s, speed })),
  setProgress: (progress: number) =>
    update((s) => ({ ...s, progress })),
  resetAnimations: () => set(initialState),
};
