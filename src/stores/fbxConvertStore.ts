import { writable } from 'svelte/store';

export type FbxConvertStatus = 'idle' | 'loading' | 'converting' | 'exporting' | 'done' | 'error';

type FbxConvertState = {
  readonly status: FbxConvertStatus;
  readonly message: string;
  readonly mappedBoneCount: number;
  readonly totalBoneCount: number;
  readonly lastFilename: string;
};

const initial: FbxConvertState = {
  status: 'idle',
  message: '',
  mappedBoneCount: 0,
  totalBoneCount: 0,
  lastFilename: '',
};

const { subscribe, update } = writable<FbxConvertState>(initial);

export const fbxConvertStore = {
  subscribe,
  setProgress: (status: FbxConvertStatus, message: string) =>
    update((s) => ({ ...s, status, message })),
  setDone: (mappedBoneCount: number, totalBoneCount: number, lastFilename: string) =>
    update((s) => ({ ...s, status: 'done', message: '変換完了', mappedBoneCount, totalBoneCount, lastFilename })),
  setError: (message: string) => update((s) => ({ ...s, status: 'error', message })),
  reset: () => update(() => initial),
};
