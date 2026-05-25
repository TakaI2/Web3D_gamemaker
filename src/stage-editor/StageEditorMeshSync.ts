import * as THREE from 'three';
import type { MaterialDef, ShapeType, StageObjectDef } from './types';

export function createGeometry(shape: ShapeType): THREE.BufferGeometry {
  switch (shape) {
    case 'box':      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':   return new THREE.SphereGeometry(0.5, 16, 12);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
    case 'cone':     return new THREE.ConeGeometry(0.5, 1, 16);
  }
}

const textureLoader = new THREE.TextureLoader();

export function buildMaterial(def: MaterialDef): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(def.color),
    roughness: def.roughness,
    metalness: def.metalness,
  });
  if (def.textureDataUrl) {
    mat.map = textureLoader.load(def.textureDataUrl);
    mat.needsUpdate = true;
  }
  return mat;
}

export function createMesh(def: StageObjectDef): THREE.Mesh {
  const geo = createGeometry(def.shape);
  const mat = buildMaterial(def.material);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  applyTransform(mesh, def);
  mesh.userData['stageId'] = def.id;
  return mesh;
}

export function syncUpdate(def: StageObjectDef, mesh: THREE.Mesh): void {
  applyTransform(mesh, def);

  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.color.set(def.material.color);
  mat.roughness = def.material.roughness;
  mat.metalness = def.material.metalness;

  if (def.material.textureDataUrl) {
    if (!mat.map || mat.map.image?.src !== def.material.textureDataUrl) {
      mat.map?.dispose();
      mat.map = textureLoader.load(def.material.textureDataUrl);
    }
  } else {
    if (mat.map) {
      mat.map.dispose();
      mat.map = null;
    }
  }
  mat.needsUpdate = true;
}

export function syncRemove(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.map?.dispose();
  mat.dispose();
}

function applyTransform(mesh: THREE.Mesh, def: StageObjectDef): void {
  mesh.position.set(...def.position);
  mesh.rotation.set(
    THREE.MathUtils.degToRad(def.rotation[0]),
    THREE.MathUtils.degToRad(def.rotation[1]),
    THREE.MathUtils.degToRad(def.rotation[2]),
  );
  mesh.scale.set(...def.scale);
}
