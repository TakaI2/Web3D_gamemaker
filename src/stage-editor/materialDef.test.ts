import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { buildMaterial } from './StageEditorMeshSync';
import type { MaterialDef } from './types';

// TextureLoader.load のスタブ
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof THREE>();
  return {
    ...actual,
    TextureLoader: class {
      load() {
        return new actual.Texture();
      }
    },
  };
});

const BASE_MAT: MaterialDef = {
  color: '#ff0000',
  roughness: 0.3,
  metalness: 0.8,
  textureDataUrl: null,
};

describe('buildMaterial', () => {
  // T601
  it('色が正しく変換される', () => {
    const mat = buildMaterial(BASE_MAT);
    const expected = new THREE.Color('#ff0000');
    expect(mat.color.r).toBeCloseTo(expected.r, 5);
    expect(mat.color.g).toBeCloseTo(expected.g, 5);
    expect(mat.color.b).toBeCloseTo(expected.b, 5);
  });

  // T602
  it('roughness が正しく設定される', () => {
    const mat = buildMaterial(BASE_MAT);
    expect(mat.roughness).toBe(0.3);
  });

  // T603
  it('metalness が正しく設定される', () => {
    const mat = buildMaterial(BASE_MAT);
    expect(mat.metalness).toBe(0.8);
  });

  // T604
  it('textureDataUrl が null の場合 map は null', () => {
    const mat = buildMaterial(BASE_MAT);
    expect(mat.map).toBeNull();
  });
});
