import { describe, it, expect } from 'vitest';
import { serializeScene, deserializeScene } from './StageEditorExporter';
import type { StageObjectDef } from './types';

const TEST_BOX: StageObjectDef = {
  id: 'test-id-box',
  name: 'Box_001',
  shape: 'box',
  position: [1, 0, 2],
  rotation: [0, 45, 0],
  scale: [1, 2, 1],
  material: {
    color: '#4488cc',
    roughness: 0.5,
    metalness: 0.1,
    textureDataUrl: null,
  },
};

describe('serializeScene / deserializeScene', () => {
  // T401
  it('空シーンの往復', () => {
    const json = serializeScene([]);
    const result = deserializeScene(json);
    expect(result.objects).toHaveLength(0);
    expect(result.version).toBe(1);
  });

  // T402
  it('単一 Box の往復で全フィールドが一致', () => {
    const json = serializeScene([TEST_BOX]);
    const result = deserializeScene(json);
    expect(result.objects).toHaveLength(1);
    const o = result.objects[0];
    expect(o.id).toBe(TEST_BOX.id);
    expect(o.name).toBe(TEST_BOX.name);
    expect(o.shape).toBe('box');
    expect(o.position).toEqual([1, 0, 2]);
    expect(o.rotation).toEqual([0, 45, 0]);
    expect(o.scale).toEqual([1, 2, 1]);
    expect(o.material.color).toBe('#4488cc');
  });

  // T403
  it('textureDataUrl ありの往復', () => {
    const withTex: StageObjectDef = {
      ...TEST_BOX,
      material: { ...TEST_BOX.material, textureDataUrl: 'data:image/png;base64,abc' },
    };
    const json = serializeScene([withTex]);
    const result = deserializeScene(json);
    expect(result.objects[0].material.textureDataUrl).toBe('data:image/png;base64,abc');
  });

  // T404
  it('4 図形全種の往復で shape が正しく復元される', () => {
    const shapes = ['box', 'sphere', 'cylinder', 'cone'] as const;
    const objects: StageObjectDef[] = shapes.map((shape, i) => ({
      ...TEST_BOX,
      id: `id-${i}`,
      name: `${shape}_001`,
      shape,
    }));
    const json = serializeScene(objects);
    const result = deserializeScene(json);
    expect(result.objects.map((o) => o.shape)).toEqual(shapes);
  });

  // T405
  it('version フィールドが 1', () => {
    const json = serializeScene([]);
    const parsed = JSON.parse(json) as { version: number };
    expect(parsed.version).toBe(1);
  });
});

describe('deserializeScene - 異常系', () => {
  // T501
  it('不正 JSON はエラー', () => {
    expect(() => deserializeScene('not json{{')).toThrow();
  });

  // T502
  it('version 不一致はエラー', () => {
    expect(() =>
      deserializeScene(JSON.stringify({ version: 99, objects: [] })),
    ).toThrow();
  });

  // T503
  it('objects が null はエラー', () => {
    expect(() =>
      deserializeScene(JSON.stringify({ version: 1, objects: null })),
    ).toThrow();
  });

  // T504
  it('必須フィールド欠損のオブジェクトはスキップ', () => {
    const json = JSON.stringify({
      version: 1,
      objects: [
        { id: 'x', position: [0, 0, 0] }, // shape なし
        TEST_BOX,
      ],
    });
    const result = deserializeScene(json);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].id).toBe('test-id-box');
  });
});
