import { writable } from 'svelte/store';
import type { AppMode } from '../types';

const { subscribe, set } = writable<AppMode>('editor');

export const appModeStore = {
  subscribe,
  toGame(): void { set('game'); },
  toEditor(): void { set('editor'); },
  toRetarget(): void { set('retarget'); },
};
