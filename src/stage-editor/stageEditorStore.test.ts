import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

// crypto.randomUUID のスタブ
let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `test-id-${++uuidCounter}`,
});

import { stageEditorStore } from '../stores/stageEditorStore';
import { DEFAULT_MATERIAL } from './types';

const BASE_OBJECT = {
  shape: 'box' as const,
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  material: { ...DEFAULT_MATERIAL },
};

beforeEach(() => {
  stageEditorStore.reset();
  uuidCounter = 0;
});

describe('stageEditorStore - addObject', () => {
  // T001
  it('オブジェクトを追加できる', () => {
    const id = stageEditorStore.addObject(BASE_OBJECT);
    const state = get(stageEditorStore);
    expect(state.objects).toHaveLength(1);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  // T002
  it('複数追加で各 id が異なる', () => {
    const id1 = stageEditorStore.addObject(BASE_OBJECT);
    const id2 = stageEditorStore.addObject(BASE_OBJECT);
    const id3 = stageEditorStore.addObject(BASE_OBJECT);
    expect(get(stageEditorStore).objects).toHaveLength(3);
    expect(new Set([id1, id2, id3]).size).toBe(3);
  });
});

describe('stageEditorStore - updateObject', () => {
  // T003
  it('指定フィールドだけ更新され、他は不変', () => {
    const id = stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.updateObject(id, { position: [1, 2, 3] });
    const obj = get(stageEditorStore).objects[0];
    expect(obj.position).toEqual([1, 2, 3]);
    expect(obj.shape).toBe('box');
    expect(obj.scale).toEqual([1, 1, 1]);
  });

  // T101
  it('存在しない id の更新は無操作', () => {
    stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.updateObject('nonexistent', { position: [9, 9, 9] });
    expect(get(stageEditorStore).objects[0].position).toEqual([0, 0, 0]);
  });
});

describe('stageEditorStore - removeObject', () => {
  // T004
  it('オブジェクトを削除できる', () => {
    const id = stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.removeObject(id);
    expect(get(stageEditorStore).objects).toHaveLength(0);
  });

  // T102
  it('存在しない id の削除は無操作', () => {
    stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.removeObject('nonexistent');
    expect(get(stageEditorStore).objects).toHaveLength(1);
  });

  // T103
  it('削除後に同 id を再削除しても問題なし', () => {
    const id = stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.removeObject(id);
    stageEditorStore.removeObject(id);
    expect(get(stageEditorStore).objects).toHaveLength(0);
  });

  it('選択中のオブジェクトを削除すると selectedId が null になる', () => {
    const id = stageEditorStore.addObject(BASE_OBJECT);
    stageEditorStore.setSelected(id);
    stageEditorStore.removeObject(id);
    expect(get(stageEditorStore).selectedId).toBeNull();
  });
});

describe('stageEditorStore - setSelected', () => {
  // T005
  it('選択 ID を設定できる', () => {
    stageEditorStore.setSelected('abc');
    expect(get(stageEditorStore).selectedId).toBe('abc');
  });

  // T006
  it('null を設定すると解除される', () => {
    stageEditorStore.setSelected('abc');
    stageEditorStore.setSelected(null);
    expect(get(stageEditorStore).selectedId).toBeNull();
  });
});

describe('stageEditorStore - ツールモード・設定', () => {
  // T007
  it('ツールモードを切り替えられる', () => {
    stageEditorStore.setToolMode('select');
    expect(get(stageEditorStore).toolMode).toBe('select');
  });

  // T008
  it('スナップサイズを切り替えられる', () => {
    stageEditorStore.setSnapSize(2);
    expect(get(stageEditorStore).snapSize).toBe(2);
  });

  // T009
  it('図形タイプを切り替えられる', () => {
    stageEditorStore.setActiveShape('sphere');
    expect(get(stageEditorStore).activeShape).toBe('sphere');
  });

  // T010
  it('previewGlbUrl を設定・クリアできる', () => {
    stageEditorStore.setPreviewGlbUrl('blob:test');
    expect(get(stageEditorStore).previewGlbUrl).toBe('blob:test');
    stageEditorStore.setPreviewGlbUrl(null);
    expect(get(stageEditorStore).previewGlbUrl).toBeNull();
  });
});

describe('stageEditorStore - 境界値', () => {
  // T201
  it('position に極大値を格納できる', () => {
    stageEditorStore.addObject({ ...BASE_OBJECT, position: [1e6, 1e6, 1e6] });
    expect(get(stageEditorStore).objects[0].position).toEqual([1e6, 1e6, 1e6]);
  });

  // T202
  it('scale に 0 を格納できる', () => {
    stageEditorStore.addObject({ ...BASE_OBJECT, scale: [0, 0, 0] });
    expect(get(stageEditorStore).objects[0].scale).toEqual([0, 0, 0]);
  });

  // T203
  it('material.roughness 境界値 0 と 1', () => {
    const id = stageEditorStore.addObject({
      ...BASE_OBJECT,
      material: { ...DEFAULT_MATERIAL, roughness: 0 },
    });
    expect(get(stageEditorStore).objects[0].material.roughness).toBe(0);
    stageEditorStore.updateObject(id, { material: { ...DEFAULT_MATERIAL, roughness: 1 } });
    expect(get(stageEditorStore).objects[0].material.roughness).toBe(1);
  });
});
