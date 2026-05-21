import { writable } from 'svelte/store';

export type BoneEntry = {
  readonly index: number;
  readonly name: string;
};

type SkeletonState = {
  readonly visible: boolean;
  readonly bones: BoneEntry[];
  readonly selectedBoneIndex: number | null;
};

const initial: SkeletonState = { visible: false, bones: [], selectedBoneIndex: null };
const { subscribe, update } = writable<SkeletonState>(initial);

export const skeletonStore = {
  subscribe,
  setVisible: (visible: boolean) => update((s) => ({ ...s, visible })),
  setBones: (bones: BoneEntry[]) => update((s) => ({ ...s, bones, selectedBoneIndex: null })),
  selectBone: (selectedBoneIndex: number | null) => update((s) => ({ ...s, selectedBoneIndex })),
  reset: () => update(() => initial),
};
