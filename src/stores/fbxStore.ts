import { writable } from 'svelte/store';
import type { FbxState, AppError } from '../types';
import type { Group } from 'three';

const initial: FbxState = { root: null, loading: false, error: null, animationNames: [] };
const { subscribe, set, update } = writable<FbxState>(initial);

export const fbxStore = {
  subscribe,
  setLoading: (loading: boolean) =>
    update((s) => ({ ...s, loading, error: null })),
  setRoot: (root: Group, animationNames: readonly string[]) =>
    update((s) => ({ ...s, root, loading: false, error: null, animationNames })),
  setError: (error: AppError) =>
    update((s) => ({ ...s, loading: false, error })),
  reset: () => set(initial),
};
