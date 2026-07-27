// cloth-cpu.js — 方式1: CPU（JS）で力ベースVerlet布シミュ（three.jsのwebgpu_compute_cloth / 元の/clothと同方式）。
// バネを「力」として加え、速度(=位置差)に蓄積・減衰。重力は小さく、ほぼ伸びない。WebGLRendererで描画。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { initDemo, initHud, buildGrid, makeClothMaterial, sphereCenter, SPHERE_R } from '../lib/cloth-demo-common.js';

const { renderer, scene, camera, controls, sphere, fpsPanel, content } = initDemo();

// GPU版と完全一致の定数。力ベース＝バネは加速度として加算、Verletで積分。
const SUBSTEPS = 8;
const GRAV_BASE = -0.00010;   // 小さい重力（元の/clothと同オーダー）。解像度で軽く正規化
const REF_N = 40;
const SPRING = 0.2;           // バネ加速係数（元の/clothの stiffness と同じ）
const DAMP = 0.99;            // 速度減衰
let WIND = 1.0;
let gravEff = GRAV_BASE;
const NEIGH = [               // 構造(4)＋せん断(4)
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [-1, 1, 1.4142], [1, -1, 1.4142], [-1, -1, 1.4142],
];

let grid, mesh, pos, prev, posAttr, clothMat, work = null;
const sphC = new THREE.Vector3();

function rebuild(N) {
  if (mesh) { content.remove(mesh); mesh.geometry.dispose(); }
  grid = buildGrid(N);
  clothMat = makeClothMaterial('cpu').material;
  if (document.getElementById('wire')?.checked) clothMat.wireframe = true;
  mesh = new THREE.Mesh(grid.geometry, clothMat);
  mesh.frustumCulled = false;
  content.add(mesh);
  posAttr = grid.geometry.attributes.position;
  pos = Float32Array.from(grid.initPos);
  prev = Float32Array.from(grid.initPos);
  work = new Float32Array(pos.length);
  gravEff = GRAV_BASE * (REF_N / N);   // 高解像度の伸びを軽く抑える（linear）
}
rebuild(40);

const hud = initHud({
  label: '方式1: CPU（力ベースVerlet）',
  fpsPanel,
  onResolution: (n) => rebuild(n),
  onWind: (w) => { WIND = w; },
  onWire: (on) => { if (clothMat) clothMat.wireframe = on; },
});

let simT = 0;
function step() {
  const N = grid.N, per = grid.per, s = grid.s;
  const idx = (i, j) => (j * per + i) * 3;
  for (let sub = 0; sub < SUBSTEPS; sub++) {
    simT += 1 / (60 * SUBSTEPS);
    sphereCenter(simT, sphC);
    const windX = Math.sin(simT * 1.3) * 0.00002 * WIND;
    const windZ = Math.sin(simT * 0.7 + 1.0) * 0.00003 * WIND;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const kv = j * per + i, k = kv * 3;
        if (grid.pinned[kv]) { work[k] = grid.initPos[k]; work[k + 1] = grid.initPos[k + 1]; work[k + 2] = grid.initPos[k + 2]; continue; }
        const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
        // 加速度＝重力＋風＋バネ力（近傍の現在位置から）
        let ax = windX, ay = gravEff, az = windZ;
        for (const [di, dj, rm] of NEIGH) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || ni > N || nj < 0 || nj > N) continue;
          const nk = idx(ni, nj);
          const dx = pos[nk] - px, dy = pos[nk + 1] - py, dz = pos[nk + 2] - pz;
          const len = Math.hypot(dx, dy, dz) || 1e-6;
          const c = (len - s * rm) * SPRING / len;   // 伸びに比例した復元力
          ax += dx * c; ay += dy * c; az += dz * c;
        }
        // Verlet積分（速度=位置差×減衰）
        let nx = px + (px - prev[k]) * DAMP + ax;
        let ny = py + (py - prev[k + 1]) * DAMP + ay;
        let nz = pz + (pz - prev[k + 2]) * DAMP + az;
        // スフィア衝突（押し出し）
        const ex = nx - sphC.x, ey = ny - sphC.y, ez = nz - sphC.z;
        const ed = Math.hypot(ex, ey, ez);
        if (ed < SPHERE_R) { const f = SPHERE_R / (ed || 1e-6); nx = sphC.x + ex * f; ny = sphC.y + ey * f; nz = sphC.z + ez * f; }
        work[k] = nx; work[k + 1] = ny; work[k + 2] = nz;
      }
    }
    const t = prev; prev = pos; pos = work; work = t;   // prev←旧pos, pos←新, work再利用
  }
  posAttr.array.set(pos);
  posAttr.needsUpdate = true;
  grid.geometry.computeVertexNormals();
  sphere.position.copy(sphC);
}

renderer.setAnimationLoop(() => {
  step();
  controls.update();
  renderer.render(scene, camera);
  hud.tick(grid.count);
});
