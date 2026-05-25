import * as THREE from 'three';
import type { ShapeType } from './types';
import { createGeometry } from './StageEditorMeshSync';

type StageEditorGizmo = {
  showGhost(shape: ShapeType, pos: THREE.Vector3): void;
  hideGhost(): void;
  setSelection(mesh: THREE.Mesh): void;
  clearSelection(): void;
  dispose(): void;
};

export function createStageEditorGizmo(scene: THREE.Scene): StageEditorGizmo {
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0x4488ff,
    opacity: 0.4,
    transparent: true,
    depthWrite: false,
  });
  const ghostMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> =
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMat);
  ghostMesh.visible = false;
  scene.add(ghostMesh);

  let currentGhostShape: ShapeType | null = null;
  let selectedMesh: THREE.Mesh | null = null;
  let originalEmissive: THREE.Color | null = null;

  return {
    showGhost(shape, pos) {
      if (shape !== currentGhostShape) {
        ghostMesh.geometry.dispose();
        ghostMesh.geometry = createGeometry(shape);
        currentGhostShape = shape;
      }
      ghostMesh.position.copy(pos);
      ghostMesh.visible = true;
    },

    hideGhost() {
      ghostMesh.visible = false;
    },

    setSelection(mesh) {
      // 以前の選択を解除
      if (selectedMesh && originalEmissive) {
        (selectedMesh.material as THREE.MeshStandardMaterial).emissive.copy(originalEmissive);
      }
      selectedMesh = mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      originalEmissive = mat.emissive.clone();
      mat.emissive.set(0x224422);
    },

    clearSelection() {
      if (selectedMesh && originalEmissive) {
        (selectedMesh.material as THREE.MeshStandardMaterial).emissive.copy(originalEmissive);
      }
      selectedMesh = null;
      originalEmissive = null;
    },

    dispose() {
      ghostMesh.geometry.dispose();
      ghostMat.dispose();
      scene.remove(ghostMesh);
    },
  };
}
