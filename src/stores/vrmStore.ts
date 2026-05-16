import { writable } from 'svelte/store';
import type { VRMState, AppError } from '../types';
import type { VRM } from '@pixiv/three-vrm';

const initialState: VRMState = {
  vrm: null,
  loading: false,
  error: null,
};

const { subscribe, set, update } = writable<VRMState>(initialState);

export const vrmStore = {
  subscribe,
  setLoading: (loading: boolean) =>
    update((s) => ({ ...s, loading, error: null })),
  setVRM: (vrm: VRM) =>
    update((s) => ({ ...s, vrm, loading: false, error: null })),
  setError: (error: AppError) =>
    update((s) => ({ ...s, loading: false, error })),
  reset: () => set(initialState),
};
