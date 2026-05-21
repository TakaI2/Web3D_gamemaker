import * as THREE from 'three';
import { GAME_CONSTANTS as C } from './constants';

export type GameSceneSetup = {
  setup(scene: THREE.Scene): void;
  dispose(): void;
};

export function createGameSceneSetup(): GameSceneSetup {
  let ground: THREE.Mesh | null = null;
  let gridHelper: THREE.GridHelper | null = null;
  let boundaryLine: THREE.LineLoop | null = null;

  const groundGeo = new THREE.PlaneGeometry(C.FIELD_SIZE, C.FIELD_SIZE);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x446644 });

  return {
    setup(scene) {
      // 地面
      ground = new THREE.Mesh(groundGeo, groundMat);
      ground.rotation.x = -Math.PI / 2;
      scene.add(ground);

      // グリッド
      gridHelper = new THREE.GridHelper(C.FIELD_SIZE, 20, 0x888888, 0x444444);
      scene.add(gridHelper);

      // 境界線（黄色ループ）
      const boundaryPoints = [
        new THREE.Vector3(-C.FIELD_HALF, 0.05, -C.FIELD_HALF),
        new THREE.Vector3( C.FIELD_HALF, 0.05, -C.FIELD_HALF),
        new THREE.Vector3( C.FIELD_HALF, 0.05,  C.FIELD_HALF),
        new THREE.Vector3(-C.FIELD_HALF, 0.05,  C.FIELD_HALF),
      ];
      const boundaryGeo = new THREE.BufferGeometry().setFromPoints(boundaryPoints);
      boundaryLine = new THREE.LineLoop(
        boundaryGeo,
        new THREE.LineBasicMaterial({ color: 0xffff00 }),
      );
      scene.add(boundaryLine);

      // 背景色
      scene.background = new THREE.Color(0x224466);
    },

    dispose() {
      groundGeo.dispose();
      groundMat.dispose();
      gridHelper?.dispose();
      ground = null;
      gridHelper = null;
      boundaryLine = null;
    },
  };
}
