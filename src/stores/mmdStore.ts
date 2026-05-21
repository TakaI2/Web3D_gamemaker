import { writable } from 'svelte/store';
import type { MMDState, AppError } from '../types';
import type { SkinnedMesh } from 'three';

const initialState: MMDState = {
  mesh: null,
  loading: false,
  error: null,
};

const { subscribe, set, update } = writable<MMDState>(initialState);

export const mmdStore = {
  subscribe,
  setLoading: (loading: boolean) =>
    update((s) => ({ ...s, loading, error: null })),
  setMesh: (mesh: SkinnedMesh) =>
    update((s) => ({ ...s, mesh, loading: false, error: null })),
  setError: (error: AppError) =>
    update((s) => ({ ...s, loading: false, error })),
  reset: () => set(initialState),
};
