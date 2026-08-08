// tool-models.js — プロシージャル道具モデル（GLBが無い武器類）。tool-editor とゲームで共用。
import * as THREE from 'https://esm.sh/three@0.184.0';

export const PROC_TOOLS = {
  rifle() {   // アサルトライフル（+X が銃口方向）
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.6, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.05), mat); body.position.y = 0.06;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.04), mat); mag.position.set(0.04, -0.02, 0);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.04), mat); grip.position.set(-0.14, -0.01, 0); grip.rotation.z = 0.3;
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.04), mat); stock.position.set(-0.3, 0.05, 0);
    g.add(body, mag, grip, stock);
    return g;
  },
  shockgun() {   // ショックガン
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x24505c, metalness: 0.5, roughness: 0.4, emissive: 0x0a3d4a, emissiveIntensity: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.08), mat); body.position.y = 0.06;
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 8, 14), new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2299cc, emissiveIntensity: 1.4 }));
    coil.position.set(0.22, 0.06, 0); coil.rotation.y = Math.PI / 2;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), mat); grip.position.set(-0.1, -0.02, 0); grip.rotation.z = 0.3;
    g.add(body, coil, grip);
    return g;
  },
};
