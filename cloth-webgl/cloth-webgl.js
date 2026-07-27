// cloth-webgl.js — 方式2: WebGL2のGPGPU（GPUComputationRenderer）で力ベースVerlet布シミュ。
// three.jsのwebgpu_compute_cloth / 元の/clothと同方式（バネ=力・Verlet積分・小さい重力）を、
// WebGPUコンピュートの代わりにFBOフラグメントシェーダで並列計算。CPU版とモデル完全一致。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { GPUComputationRenderer } from 'https://esm.sh/three@0.184.0/examples/jsm/misc/GPUComputationRenderer.js';
import { initDemo, initHud, buildGrid, makeClothMaterial, sphereCenter, SPHERE_R } from '../lib/cloth-demo-common.js';

const { renderer, scene, camera, controls, sphere, fpsPanel, content } = initDemo();

const SUBSTEPS = 8;
const GRAV_BASE = -0.00010, REF_N = 40, SPRING = 0.2, DAMP = 0.99;
let WIND = 1.0;

const POS_FRAG = `
uniform float uGrav, uDamp, uSpring, uWindX, uWindZ, uS, uSphR;
uniform vec3 uSphC;
uniform sampler2D uInit;
vec3 springAccel(vec2 dij, float rm, vec2 ij, vec3 p, float N) {
  vec2 nij = ij + dij;
  if (nij.x < 0.0 || nij.x > N || nij.y < 0.0 || nij.y > N) return vec3(0.0);
  vec3 q = texture2D(texturePos, (nij + 0.5) / resolution).xyz;
  vec3 d = q - p;
  float len = max(length(d), 1e-6);
  return d * ((len - uS * rm) * uSpring / len);
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec4 initP = texture2D(uInit, uv);
  if (initP.w > 0.5) { gl_FragColor = vec4(initP.xyz, 1.0); return; }   // ピン固定
  vec3 p = texture2D(texturePos, uv).xyz;
  vec3 prev = texture2D(texturePrev, uv).xyz;
  float N = resolution.x - 1.0;
  vec2 ij = floor(gl_FragCoord.xy);
  vec3 a = vec3(uWindX, uGrav, uWindZ);
  a += springAccel(vec2( 1.0, 0.0), 1.0,    ij, p, N);
  a += springAccel(vec2(-1.0, 0.0), 1.0,    ij, p, N);
  a += springAccel(vec2( 0.0, 1.0), 1.0,    ij, p, N);
  a += springAccel(vec2( 0.0,-1.0), 1.0,    ij, p, N);
  a += springAccel(vec2( 1.0, 1.0), 1.4142, ij, p, N);
  a += springAccel(vec2(-1.0, 1.0), 1.4142, ij, p, N);
  a += springAccel(vec2( 1.0,-1.0), 1.4142, ij, p, N);
  a += springAccel(vec2(-1.0,-1.0), 1.4142, ij, p, N);
  vec3 np = p + (p - prev) * uDamp + a;
  vec3 e = np - uSphC;
  float ed = length(e);
  if (ed < uSphR) np = uSphC + e * (uSphR / max(ed, 1e-6));
  gl_FragColor = vec4(np, 0.0);
}`;

const PREV_FRAG = `
void main() { gl_FragColor = texture2D(texturePos, gl_FragCoord.xy / resolution); }`;

let grid, mesh, gpu, posVar, uni, mat, simT = 0;
const sphC = new THREE.Vector3();

function rebuild(N) {
  if (mesh) { content.remove(mesh); mesh.geometry.dispose(); }
  if (gpu) gpu.dispose?.();
  grid = buildGrid(N);
  const per = grid.per;

  gpu = new GPUComputationRenderer(per, per, renderer);
  gpu.setDataType(THREE.FloatType);
  const pos0 = gpu.createTexture(), prev0 = gpu.createTexture();
  const initData = new Float32Array(per * per * 4);
  for (let k = 0; k < grid.count; k++) {
    initData[k * 4] = grid.initPos[k * 3];
    initData[k * 4 + 1] = grid.initPos[k * 3 + 1];
    initData[k * 4 + 2] = grid.initPos[k * 3 + 2];
    initData[k * 4 + 3] = grid.pinned[k];
  }
  pos0.image.data.set(initData);
  prev0.image.data.set(initData);
  const initTex = new THREE.DataTexture(initData, per, per, THREE.RGBAFormat, THREE.FloatType);
  initTex.needsUpdate = true;

  posVar = gpu.addVariable('texturePos', POS_FRAG, pos0);
  const prevVar = gpu.addVariable('texturePrev', PREV_FRAG, prev0);
  gpu.setVariableDependencies(posVar, [posVar, prevVar]);
  gpu.setVariableDependencies(prevVar, [posVar]);
  uni = posVar.material.uniforms;
  uni.uGrav = { value: GRAV_BASE * (REF_N / N) };   // 高解像度の伸びを軽く抑える（linear）
  uni.uDamp = { value: DAMP }; uni.uSpring = { value: SPRING };
  uni.uWindX = { value: 0 }; uni.uWindZ = { value: 0 }; uni.uS = { value: grid.s };
  uni.uSphC = { value: new THREE.Vector3() }; uni.uSphR = { value: SPHERE_R };
  uni.uInit = { value: initTex };
  const err = gpu.init();
  if (err) { document.getElementById('hud-label').textContent = 'WebGL2 GPGPU 非対応: ' + err; return; }

  mat = makeClothMaterial('gpu', { texRes: per }).material;
  if (document.getElementById('wire')?.checked) mat.wireframe = true;
  mesh = new THREE.Mesh(grid.geometry, mat);
  mesh.frustumCulled = false;
  content.add(mesh);
  renderer.compile(scene, camera);
}
rebuild(40);

const hud = initHud({
  label: '方式2: WebGL2 GPGPU（力ベースVerlet）',
  fpsPanel,
  onResolution: (n) => rebuild(n),
  onWind: (w) => { WIND = w; },
  onWire: (on) => { if (mat) mat.wireframe = on; },
});

renderer.setAnimationLoop(() => {
  if (uni) {
    for (let s = 0; s < SUBSTEPS; s++) {
      simT += 1 / (60 * SUBSTEPS);
      sphereCenter(simT, sphC);
      uni.uSphC.value.copy(sphC);
      uni.uWindX.value = Math.sin(simT * 1.3) * 0.00002 * WIND;
      uni.uWindZ.value = Math.sin(simT * 0.7 + 1.0) * 0.00003 * WIND;
      gpu.compute();
    }
    const tex = gpu.getCurrentRenderTarget(posVar).texture;
    if (mat.userData.shader) mat.userData.shader.uniforms.posTex.value = tex;
    sphere.position.copy(sphC);
  }
  controls.update();
  renderer.render(scene, camera);
  hud.tick(grid.count);
});
