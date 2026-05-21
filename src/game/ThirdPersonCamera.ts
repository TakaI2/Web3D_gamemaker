import * as THREE from 'three';
import { GAME_CONSTANTS as C } from './constants';

export type ThirdPersonCamera = {
  applyMouseDelta(dx: number, dy: number): void;
  update(camera: THREE.PerspectiveCamera, targetPosition: THREE.Vector3): void;
  readonly yaw: number;
};

export function createThirdPersonCamera(): ThirdPersonCamera {
  let _yaw   = Math.PI;
  let _pitch = 0.3;

  const _offset = new THREE.Vector3();
  const _lookAt  = new THREE.Vector3();

  return {
    get yaw() { return _yaw; },

    applyMouseDelta(dx, dy) {
      _yaw   -= dx * C.CAMERA_YAW_SPEED;
      _pitch -= dy * C.CAMERA_YAW_SPEED;
      _pitch  = Math.max(C.CAMERA_PITCH_MIN, Math.min(C.CAMERA_PITCH_MAX, _pitch));
    },

    update(camera, targetPosition) {
      _offset.set(
        Math.sin(_yaw) * C.CAMERA_OFFSET_BACK,
        C.CAMERA_OFFSET_UP + Math.sin(_pitch) * C.CAMERA_OFFSET_BACK,
        Math.cos(_yaw) * C.CAMERA_OFFSET_BACK,
      );
      camera.position.copy(targetPosition).add(_offset);

      _lookAt.copy(targetPosition);
      _lookAt.y += 1.2;
      camera.lookAt(_lookAt);
    },
  };
}
