import * as THREE from 'three';
import { GAME_CONSTANTS as C } from './constants';

type Enemy = {
  readonly mesh: THREE.Mesh;
};

export type EnemyManager = {
  spawn(scene: THREE.Scene, playerPos: THREE.Vector3): void;
  update(delta: number, playerPos: THREE.Vector3): 'alive' | 'gameover';
  dispose(scene: THREE.Scene): void;
};

export function createEnemyManager(): EnemyManager {
  const enemies: Enemy[] = [];
  const _toPlayer = new THREE.Vector3();

  const geometry = new THREE.CapsuleGeometry(
    C.ENEMY_CAPSULE_RADIUS,
    C.ENEMY_CAPSULE_HEIGHT,
    4,
    8,
  );
  const material = new THREE.MeshStandardMaterial({ color: 0xff3333 });

  function randomSpawnPosition(playerPos: THREE.Vector3): THREE.Vector3 {
    let pos: THREE.Vector3;
    let attempts = 0;
    do {
      pos = new THREE.Vector3(
        (Math.random() - 0.5) * C.FIELD_SIZE,
        C.ENEMY_CAPSULE_RADIUS + C.ENEMY_CAPSULE_HEIGHT * 0.5,
        (Math.random() - 0.5) * C.FIELD_SIZE,
      );
      attempts++;
    } while (pos.distanceTo(playerPos) < C.ENEMY_SPAWN_MIN_DIST && attempts < 100);
    return pos;
  }

  return {
    spawn(scene, playerPos) {
      for (let i = 0; i < C.ENEMY_COUNT; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(randomSpawnPosition(playerPos));
        scene.add(mesh);
        enemies.push({ mesh });
      }
    },

    update(delta, playerPos) {
      for (const enemy of enemies) {
        _toPlayer.copy(playerPos).sub(enemy.mesh.position);
        const dist = _toPlayer.length();

        if (dist < C.ENEMY_CONTACT_RADIUS) return 'gameover';

        _toPlayer.normalize();
        enemy.mesh.position.addScaledVector(_toPlayer, C.ENEMY_SPEED * delta);
        enemy.mesh.lookAt(playerPos.x, enemy.mesh.position.y, playerPos.z);
      }
      return 'alive';
    },

    dispose(scene) {
      for (const enemy of enemies) {
        scene.remove(enemy.mesh);
      }
      enemies.length = 0;
      geometry.dispose();
      material.dispose();
    },
  };
}
