export type ShapeType = 'box' | 'sphere' | 'cylinder' | 'cone';

export type ToolMode = 'place' | 'select';

export type SnapSize = 0.5 | 1 | 2 | 4;

export type MaterialDef = {
  color: string;
  roughness: number;
  metalness: number;
  textureDataUrl: string | null;
};

export type StageObjectDef = {
  id: string;
  name: string;
  shape: ShapeType;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: readonly [number, number, number];
  material: MaterialDef;
};

export type SceneDef = {
  version: 1;
  objects: StageObjectDef[];
};

export const DEFAULT_MATERIAL: MaterialDef = {
  color: '#888888',
  roughness: 0.7,
  metalness: 0.0,
  textureDataUrl: null,
};
