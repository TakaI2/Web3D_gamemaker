import { writable } from 'svelte/store';
import type { ShapeType, SnapSize, StageObjectDef, ToolMode } from '../stage-editor/types';

type StageEditorState = {
  objects: StageObjectDef[];
  selectedId: string | null;
  toolMode: ToolMode;
  activeShape: ShapeType;
  snapSize: SnapSize;
  previewGlbUrl: string | null;
};

const INITIAL_STATE: StageEditorState = {
  objects: [],
  selectedId: null,
  toolMode: 'place',
  activeShape: 'box',
  snapSize: 1,
  previewGlbUrl: null,
};

function createStageEditorStore() {
  const { subscribe, set, update } = writable<StageEditorState>(INITIAL_STATE);

  let nameCounters: Record<ShapeType, number> = { box: 0, sphere: 0, cylinder: 0, cone: 0 };

  function generateName(shape: ShapeType): string {
    nameCounters[shape] += 1;
    const label = shape.charAt(0).toUpperCase() + shape.slice(1);
    return `${label}_${String(nameCounters[shape]).padStart(3, '0')}`;
  }

  return {
    subscribe,

    addObject(partial: Omit<StageObjectDef, 'id' | 'name'>): string {
      const id = crypto.randomUUID();
      const name = generateName(partial.shape);
      const def: StageObjectDef = { id, name, ...partial };
      update((s) => ({ ...s, objects: [...s.objects, def] }));
      return id;
    },

    updateObject(id: string, partial: Partial<StageObjectDef>): void {
      update((s) => ({
        ...s,
        objects: s.objects.map((o) => (o.id === id ? { ...o, ...partial } : o)),
      }));
    },

    removeObject(id: string): void {
      update((s) => ({
        ...s,
        objects: s.objects.filter((o) => o.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
      }));
    },

    setSelected(id: string | null): void {
      update((s) => ({ ...s, selectedId: id }));
    },

    setToolMode(mode: ToolMode): void {
      update((s) => ({ ...s, toolMode: mode }));
    },

    setActiveShape(shape: ShapeType): void {
      update((s) => ({ ...s, activeShape: shape }));
    },

    setSnapSize(size: SnapSize): void {
      update((s) => ({ ...s, snapSize: size }));
    },

    setPreviewGlbUrl(url: string | null): void {
      update((s) => ({ ...s, previewGlbUrl: url }));
    },

    reset(): void {
      nameCounters = { box: 0, sphere: 0, cylinder: 0, cone: 0 };
      set(INITIAL_STATE);
    },
  };
}

export const stageEditorStore = createStageEditorStore();
