import { writable } from 'svelte/store';
import type { XRState, XRMode, XRSupportState, AppError } from '../types';

const initialState: XRState = {
  support: { vr: false, ar: false },
  activeMode: null,
  isActive: false,
  error: null,
};

const { subscribe, set, update } = writable<XRState>(initialState);

export const xrStore = {
  subscribe,
  setSupport: (support: XRSupportState) =>
    update((s) => ({ ...s, support })),
  setActive: (mode: XRMode) =>
    update((s) => ({ ...s, activeMode: mode, isActive: true, error: null })),
  setInactive: () =>
    update((s) => ({ ...s, activeMode: null, isActive: false })),
  setError: (error: AppError) =>
    update((s) => ({ ...s, error, isActive: false, activeMode: null })),
  reset: () => set(initialState),
};
