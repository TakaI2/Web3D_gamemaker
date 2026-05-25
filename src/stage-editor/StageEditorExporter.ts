import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { SceneDef, StageObjectDef } from './types';

export function serializeScene(objects: StageObjectDef[]): string {
  const def: SceneDef = { version: 1, objects };
  return JSON.stringify(def, null, 2);
}

export function deserializeScene(json: string): SceneDef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['version'] !== 1
  ) {
    throw new Error('Invalid scene version');
  }

  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw['objects'])) {
    throw new Error('objects must be an array');
  }

  const objects: StageObjectDef[] = [];
  for (const item of raw['objects'] as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o['id'] !== 'string' ||
      typeof o['name'] !== 'string' ||
      !['box', 'sphere', 'cylinder', 'cone'].includes(o['shape'] as string)
    ) {
      continue;
    }
    objects.push(o as unknown as StageObjectDef);
  }

  return { version: 1, objects };
}

export function saveJson(objects: StageObjectDef[]): void {
  const json = serializeScene(objects);
  downloadBlob(new Blob([json], { type: 'application/json' }), 'stage.json');
}

export function loadJson(file: File): Promise<SceneDef> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const result = e.target?.result;
        if (typeof result !== 'string') throw new Error('File read error');
        resolve(deserializeScene(result));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('File read error'));
    reader.readAsText(file);
  });
}

export function exportGlb(meshMap: Map<string, THREE.Mesh>): Promise<ArrayBuffer> {
  const exportGroup = new THREE.Group();
  for (const mesh of meshMap.values()) {
    // transform は clone のまま保持（GLTFExporter が正しく出力し、Octree.fromGraphNode が world transform を処理する）
    const clone = mesh.clone();
    exportGroup.add(clone);
  }

  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      exportGroup,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          // JSON モードで返ってきた場合も ArrayBuffer に変換して resolve
          const json = JSON.stringify(result);
          const buf = new TextEncoder().encode(json).buffer;
          resolve(buf as ArrayBuffer);
        }
      },
      (err) => reject(err),
      { binary: true },
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
