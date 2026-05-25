import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';
import { FPS_CONSTANTS as C } from './FpsConstants';

export type FpsInput = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
};

export type FpsPlayer = {
  collider: InstanceType<typeof Capsule>;
  velocity: THREE.Vector3;
  onFloor: boolean;
  update(delta: number, octree: InstanceType<typeof Octree>, camera: THREE.PerspectiveCamera, input: FpsInput): void;
  teleportToSpawn(): void;
};

export function createFpsPlayer(): FpsPlayer {
  const collider = new Capsule(
    new THREE.Vector3(C.SPAWN_X, C.SPAWN_Y + C.PLAYER_CAPSULE_START_Y, C.SPAWN_Z),
    new THREE.Vector3(C.SPAWN_X, C.SPAWN_Y + C.PLAYER_CAPSULE_END_Y, C.SPAWN_Z),
    C.PLAYER_CAPSULE_RADIUS,
  );
  const velocity = new THREE.Vector3();
  let onFloor = false;

  const _forward = new THREE.Vector3();
  const _side = new THREE.Vector3();

  function applyInput(camera: THREE.PerspectiveCamera, input: FpsInput, dt: number): void {
    const speedDelta = dt * (onFloor ? C.PLAYER_SPEED : C.PLAYER_SPEED * 0.3);

    if (input.forward || input.backward || input.left || input.right) {
      camera.getWorldDirection(_forward);
      _forward.y = 0;
      _forward.normalize();
      _side.crossVectors(new THREE.Vector3(0, 1, 0), _forward).normalize();

      if (input.forward)  velocity.addScaledVector(_forward, speedDelta);
      if (input.backward) velocity.addScaledVector(_forward, -speedDelta);
      if (input.left)     velocity.addScaledVector(_side, speedDelta);
      if (input.right)    velocity.addScaledVector(_side, -speedDelta);
    }

    if (input.jump && onFloor) {
      velocity.y = C.PLAYER_JUMP_HEIGHT;
    }
  }

  function collideWorld(octree: InstanceType<typeof Octree>): void {
    const result = octree.capsuleIntersect(collider);
    onFloor = false;
    if (result) {
      onFloor = result.normal.y > C.FLOOR_NORMAL_Y_THRESHOLD;
      if (!onFloor) {
        velocity.addScaledVector(result.normal, -result.normal.dot(velocity));
      }
      collider.translate(result.normal.multiplyScalar(result.depth));
    }
  }

  return {
    collider,
    velocity,
    get onFloor() { return onFloor; },

    update(delta, octree, camera, input) {
      const dt = delta / C.STEPS_PER_FRAME;

      for (let i = 0; i < C.STEPS_PER_FRAME; i++) {
        // 重力
        if (onFloor) {
          const damping = Math.exp(-4 * dt) - 1;
          velocity.addScaledVector(velocity, damping);
        } else {
          velocity.y -= C.GRAVITY * dt;
        }

        applyInput(camera, input, dt);

        collider.translate(velocity.clone().multiplyScalar(dt));

        collideWorld(octree);

        // リスポーン
        if (collider.end.y < C.RESPAWN_Y_THRESHOLD) {
          this.teleportToSpawn();
        }
      }
    },

    teleportToSpawn() {
      collider.start.set(C.SPAWN_X, C.SPAWN_Y + C.PLAYER_CAPSULE_START_Y, C.SPAWN_Z);
      collider.end.set(C.SPAWN_X, C.SPAWN_Y + C.PLAYER_CAPSULE_END_Y, C.SPAWN_Z);
      velocity.set(0, 0, 0);
    },
  };
}
