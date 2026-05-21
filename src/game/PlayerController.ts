import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { InputManager } from './InputManager';
import { GAME_CONSTANTS as C } from './constants';

export type PlayerController = {
  setVRM(vrm: VRM | null): void;
  setPlaceholder(mesh: THREE.Mesh | null): void;
  update(delta: number, cameraYaw: number, input: InputManager): boolean;
  readonly position: THREE.Vector3;
  dispose(): void;
};

export function createPlayerController(): PlayerController {
  const _position = new THREE.Vector3(0, 0, 0);
  let _vrm: VRM | null = null;
  let _placeholder: THREE.Mesh | null = null;

  function syncMesh(): void {
    if (_vrm) _vrm.scene.position.copy(_position);
    if (_placeholder) _placeholder.position.copy(_position);
  }

  return {
    get position() { return _position; },

    setVRM(vrm) { _vrm = vrm; },
    setPlaceholder(mesh) { _placeholder = mesh; },

    update(delta, cameraYaw, input): boolean {
      let dx = 0;
      let dz = 0;
      if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp'))    dz -= 1;
      if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown'))  dz += 1;
      if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft'))  dx -= 1;
      if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) dx += 1;

      const isMoving = dx !== 0 || dz !== 0;
      if (isMoving) {
        const len = Math.sqrt(dx * dx + dz * dz);
        dx /= len;
        dz /= len;

        const sin = Math.sin(cameraYaw);
        const cos = Math.cos(cameraYaw);
        const worldX = dx * cos - dz * sin;
        const worldZ = dx * sin + dz * cos;

        _position.x = Math.max(
          -C.FIELD_HALF,
          Math.min(C.FIELD_HALF, _position.x + worldX * C.PLAYER_SPEED * delta),
        );
        _position.z = Math.max(
          -C.FIELD_HALF,
          Math.min(C.FIELD_HALF, _position.z + worldZ * C.PLAYER_SPEED * delta),
        );

        const angle = Math.atan2(worldX, worldZ);
        if (_vrm) _vrm.scene.rotation.y = angle;
        if (_placeholder) _placeholder.rotation.y = angle;

        syncMesh();
      }
      return isMoving;
    },

    dispose() {
      _vrm = null;
      _placeholder = null;
    },
  };
}
