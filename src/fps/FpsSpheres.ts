import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Octree } from 'three/addons/math/Octree.js';
import { FPS_CONSTANTS as C } from './FpsConstants';

type SphereState = {
  mesh: THREE.Mesh;
  collider: THREE.Sphere;
  velocity: THREE.Vector3;
};

export type FpsSpheres = {
  throwBall(camera: THREE.PerspectiveCamera, playerVelocity: THREE.Vector3, mouseDownTime: number): void;
  update(delta: number, octree: InstanceType<typeof Octree>, playerCollider: InstanceType<typeof Capsule>): void;
  dispose(scene: THREE.Scene): void;
};

export function createFpsSpheres(scene: THREE.Scene): FpsSpheres {
  const geometry = new THREE.IcosahedronGeometry(C.SPHERE_RADIUS, 5);
  const material = new THREE.MeshStandardMaterial({ color: 0xdede8d });

  const spheres: SphereState[] = Array.from({ length: C.NUM_SPHERES }, () => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return {
      mesh,
      collider: new THREE.Sphere(new THREE.Vector3(0, -100, 0), C.SPHERE_RADIUS),
      velocity: new THREE.Vector3(),
    };
  });

  let sphereIdx = 0;

  const _normal = new THREE.Vector3();
  const _relVel = new THREE.Vector3();
  const _v1 = new THREE.Vector3();

  function updateSphere(sphere: SphereState, delta: number, octree: InstanceType<typeof Octree>): void {
    sphere.collider.center.addScaledVector(sphere.velocity, delta);

    const result = octree.sphereIntersect(sphere.collider);
    if (result) {
      sphere.velocity.addScaledVector(result.normal, -result.normal.dot(sphere.velocity) * C.SPHERE_BOUNCE_DAMPING);
      sphere.collider.center.add(result.normal.clone().multiplyScalar(result.depth));
    } else {
      sphere.velocity.y -= C.GRAVITY * delta;
    }

    const damping = Math.exp(-1.5 * delta) - 1;
    sphere.velocity.addScaledVector(sphere.velocity, damping);
    sphere.mesh.position.copy(sphere.collider.center);
  }

  function spheresCollisions(): void {
    for (let i = 0; i < spheres.length; i++) {
      const s1 = spheres[i];
      for (let j = i + 1; j < spheres.length; j++) {
        const s2 = spheres[j];
        _normal.copy(s1.collider.center).sub(s2.collider.center);
        const dist = _normal.length();
        if (dist < C.SPHERE_RADIUS * 2) {
          _normal.normalize();
          const v1 = _relVel.copy(s1.velocity).dot(_normal);
          const v2 = _v1.copy(s2.velocity).dot(_normal);
          s1.velocity.addScaledVector(_normal, v2 - v1);
          s2.velocity.addScaledVector(_normal, v1 - v2);

          const d = (C.SPHERE_RADIUS * 2 - dist) / 2;
          s1.collider.center.addScaledVector(_normal, d);
          s2.collider.center.addScaledVector(_normal, -d);
        }
      }
    }
  }

  function playerSphereCollision(sphere: SphereState, playerCollider: InstanceType<typeof Capsule>): void {
    const center = _v1.addVectors(playerCollider.start, playerCollider.end).multiplyScalar(0.5);
    const sphereCenter = sphere.collider.center;
    const r = C.SPHERE_RADIUS + C.PLAYER_CAPSULE_RADIUS;
    const r2 = r * r;

    for (const point of [playerCollider.start, playerCollider.end, center]) {
      const d2 = point.distanceToSquared(sphereCenter);
      if (d2 < r2) {
        _normal.copy(point).sub(sphereCenter).normalize();
        const v1 = sphere.velocity.dot(_normal);
        sphere.velocity.addScaledVector(_normal, -v1 * 1.5);
        const d = (r - Math.sqrt(d2)) / 2;
        sphereCenter.addScaledVector(_normal, -d);
      }
    }
  }

  return {
    throwBall(camera, playerVelocity, mouseDownTime) {
      const sphere = spheres[sphereIdx];
      sphereIdx = (sphereIdx + 1) % C.NUM_SPHERES;

      camera.getWorldDirection(_v1);
      sphere.collider.center.copy(camera.position).addScaledVector(_v1, C.PLAYER_CAPSULE_RADIUS * 1.5);

      const impulse = C.THROW_BASE_IMPULSE
        + C.THROW_MAX_EXTRA_IMPULSE * (1 - Math.exp((mouseDownTime - Date.now()) * 0.001));

      sphere.velocity.copy(_v1).multiplyScalar(impulse);
      sphere.velocity.addScaledVector(playerVelocity, 2);
    },

    update(delta, octree, playerCollider) {
      const dt = delta / C.STEPS_PER_FRAME;
      for (let i = 0; i < C.STEPS_PER_FRAME; i++) {
        for (const sphere of spheres) {
          updateSphere(sphere, dt, octree);
        }
        spheresCollisions();
        for (const sphere of spheres) {
          playerSphereCollision(sphere, playerCollider);
        }
      }
    },

    dispose(scene) {
      for (const sphere of spheres) {
        scene.remove(sphere.mesh);
      }
      geometry.dispose();
      material.dispose();
    },
  };
}
