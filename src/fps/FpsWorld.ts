import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Octree } from 'three/addons/math/Octree.js';

export type FpsWorld = {
  octree: InstanceType<typeof Octree>;
  load(scene: THREE.Scene, url: string, onProgress?: (progress: number) => void): Promise<void>;
  dispose(scene: THREE.Scene): void;
};

export function createFpsWorld(): FpsWorld {
  const octree = new Octree();
  let mapScene: THREE.Group | null = null;

  return {
    octree,

    async load(scene, url, onProgress) {
      const loader = new GLTFLoader();
      const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
        loader.load(
          url,
          resolve,
          (event) => {
            if (onProgress && event.lengthComputable) {
              onProgress(event.loaded / event.total);
            }
          },
          reject,
        );
      });

      mapScene = gltf.scene;
      mapScene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material instanceof THREE.MeshStandardMaterial) {
            child.material.envMapIntensity = 0.3;
          }
        }
      });

      scene.add(mapScene);
      octree.fromGraphNode(mapScene);
    },

    dispose(scene) {
      if (mapScene) {
        scene.remove(mapScene);
        mapScene = null;
      }
    },
  };
}
