// fx-particles.js — WebGPU(TSL) パーティクル実行系（サイキッカーの技エフェクト用）
// 設計: docs/story-bible.md §7 / particle-editor(fire_webAR) と同じ ParticleConfig スキーマを共有。
//
// 方針:
//   - particle-editor は WebGL の GLSL ShaderMaterial で動くが、本ゲームは WebGPU なので
//     コードは移植せず「データ形式(ParticleConfig / particle-composition.json)」だけ共有する。
//   - CPU 側の粒シミュ(プール更新)は描画非依存なのでそのまま移植。
//   - 描画は SpriteNodeMaterial（カメラ自動追従ビルボード）＋ InstancedBufferGeometry。
//     向きの行列計算は SpriteNodeMaterial に任せるため軸固定(床/壁貼り)は未対応＝今後の課題。
//
// 使い方:
//   const fx = createFxSystem(FX_PRESETS.spark);
//   scene.add(fx.object3D);
//   fx.object3D.position.copy(hitPos);
//   fx.burst(24);                 // 単発バースト（着弾・マズルフラッシュ等）
//   // 毎フレーム: fx.update(dt);
//   // 連続発生は config.spawnRate>0。fx.setEmitting(false) で連続発生だけ止める。
//   fx.dispose();
//
// three は各デモと同一 URL を import（同一モジュールインスタンス＝instanceof 互換）。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  attribute, uv, texture, uniform, vec2, float, mod, floor,
} from 'https://esm.sh/three@0.184.0/tsl';

// ============================================================
// プリセット（ParticleConfig。particle-editor と同じスキーマ）
// ============================================================

/** 炎（additive・浮力上昇） */
const FIRE = {
  maxParticles: 600, spawnRate: 90, lifetime: [0.5, 1.1],
  emitter: { shape: 'disc', radius: 0.15, size: [0.1, 0.1, 0.1], rotation: [0, 0, 0] },
  velocity: { speed: [0.6, 1.4], spreadDeg: 16 },
  acceleration: [0, 1.8, 0], drag: 0.6,
  size: { start: 0.4, end: 0.12 },
  color: { start: '#fff2b0', end: '#e23b13' },
  opacity: { start: 0.95, end: 0.0 },
  blending: 'additive', sizeAttenuation: true, texture: null,
  frames: { cols: 1, rows: 1, fps: 12, mode: 'overLife' },
  spin: { startDeg: [0, 360], speedDeg: [-30, 30] },
};

/** 煙（normal・もくもく拡大） */
const SMOKE = {
  maxParticles: 400, spawnRate: 28, lifetime: [1.6, 3.2],
  emitter: { shape: 'disc', radius: 0.12, size: [0.1, 0.1, 0.1], rotation: [0, 0, 0] },
  velocity: { speed: [0.3, 0.7], spreadDeg: 12 },
  acceleration: [0, 0.5, 0], drag: 0.5,
  size: { start: 0.22, end: 1.0 },
  color: { start: '#9a9a9a', end: '#2a2a2a' },
  opacity: { start: 0.45, end: 0.0 },
  blending: 'normal', sizeAttenuation: true, texture: null,
  frames: { cols: 1, rows: 1, fps: 12, mode: 'overLife' },
  spin: { startDeg: [0, 360], speedDeg: [-20, 20] },
};

/** 着弾スパーク（単発バースト向け：spawnRate=0、外向きに飛び散る短寿命の光） */
const SPARK = {
  maxParticles: 120, spawnRate: 0, lifetime: [0.15, 0.4],
  emitter: { shape: 'point', radius: 0.0, size: [0.05, 0.05, 0.05], rotation: [0, 0, 0] },
  velocity: { speed: [3.0, 7.0], spreadDeg: 90 },
  acceleration: [0, -6.0, 0], drag: 1.2,
  size: { start: 0.16, end: 0.02 },
  color: { start: '#fff7d6', end: '#ffa030' },
  opacity: { start: 1.0, end: 0.0 },
  blending: 'additive', sizeAttenuation: true, texture: null,
  frames: { cols: 1, rows: 1, fps: 12, mode: 'overLife' },
  spin: { startDeg: [0, 0], speedDeg: [0, 0] },
};

/** 氷オーラ（フローゼ：淡水色の冷気が立ち上る） */
const FROST = {
  maxParticles: 300, spawnRate: 40, lifetime: [0.6, 1.3],
  emitter: { shape: 'disc', radius: 0.25, size: [0.1, 0.1, 0.1], rotation: [0, 0, 0] },
  velocity: { speed: [0.4, 0.9], spreadDeg: 22 },
  acceleration: [0, 1.2, 0], drag: 0.8,
  size: { start: 0.3, end: 0.06 },
  color: { start: '#dff4ff', end: '#5fa8ff' },
  opacity: { start: 0.8, end: 0.0 },
  blending: 'additive', sizeAttenuation: true, texture: null,
  frames: { cols: 1, rows: 1, fps: 12, mode: 'overLife' },
  spin: { startDeg: [0, 360], speedDeg: [-40, 40] },
};

export const FX_PRESETS = { fire: FIRE, smoke: SMOKE, spark: SPARK, frost: FROST };

/** ネスト込みディープコピー */
export function cloneFxConfig(c) {
  return JSON.parse(JSON.stringify(c));
}

// ============================================================
// テクスチャ（内蔵ソフト円 or PNG）
// ============================================================

function makeSoftCircleTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function loadFxTexture(src) {
  if (!src) return makeSoftCircleTexture();
  const tex = new THREE.TextureLoader().load(src);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================
// 乱数ヘルパ
// ============================================================

function rand(min, max) { return min + Math.random() * (max - min); }

const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(1, 0, 0);

/** dir を中心とした円錐内のランダム方向（spreadRad=半角） */
function randomConeDir(dir, spreadRad, out) {
  if (spreadRad <= 1e-4) return out.copy(dir);
  const cosA = Math.cos(spreadRad);
  const z = rand(cosA, 1);
  const phi = rand(0, Math.PI * 2);
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const up = Math.abs(dir.y) < 0.99 ? _up : _altUp;
  const t1 = new THREE.Vector3().crossVectors(up, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1);
  return out.copy(t1).multiplyScalar(Math.cos(phi) * r)
    .addScaledVector(t2, Math.sin(phi) * r)
    .addScaledVector(dir, z)
    .normalize();
}

// ============================================================
// パーティクルシステム生成
// ============================================================

export function createFxSystem(initial) {
  let cfg = initial;
  let curMax = cfg.maxParticles;
  let curBlending = cfg.blending;
  let curTexture = cfg.texture;
  let emitting = true;

  // --- CPU状態（プール） ---
  let n = cfg.maxParticles;
  let px, vel, aCol, aSize, aFrame, aRot, spinV, age, life, alive;
  let spawnAcc = 0;
  let extraSpawn = 0; // burst() で要求された即時発生数

  function allocArrays() {
    px = new Float32Array(n * 3);
    vel = new Float32Array(n * 3);
    aCol = new Float32Array(n * 4);
    aSize = new Float32Array(n);
    aFrame = new Float32Array(n);
    aRot = new Float32Array(n);
    spinV = new Float32Array(n);
    age = new Float32Array(n);
    life = new Float32Array(n);
    alive = new Uint8Array(n);
  }
  allocArrays();

  const cStart = new THREE.Color();
  const cEnd = new THREE.Color();
  const tmpDir = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const emitQuat = new THREE.Quaternion();
  const emitEuler = new THREE.Euler();
  const baseDir = new THREE.Vector3(0, 1, 0);

  // --- ジオメトリ（板1枚 + インスタンス属性） ---
  const baseGeom = new THREE.PlaneGeometry(1, 1);
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = baseGeom.index;
  geom.setAttribute('position', baseGeom.getAttribute('position'));
  geom.setAttribute('uv', baseGeom.getAttribute('uv'));

  let iPosAttr, iSizeAttr, iColAttr, iFrameAttr, iRotAttr;
  function bindInstanced() {
    iPosAttr = new THREE.InstancedBufferAttribute(px, 3).setUsage(THREE.DynamicDrawUsage);
    iSizeAttr = new THREE.InstancedBufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage);
    iColAttr = new THREE.InstancedBufferAttribute(aCol, 4).setUsage(THREE.DynamicDrawUsage);
    iFrameAttr = new THREE.InstancedBufferAttribute(aFrame, 1).setUsage(THREE.DynamicDrawUsage);
    iRotAttr = new THREE.InstancedBufferAttribute(aRot, 1).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iPos', iPosAttr);
    geom.setAttribute('iSize', iSizeAttr);
    geom.setAttribute('iColor', iColAttr);
    geom.setAttribute('iFrame', iFrameAttr);
    geom.setAttribute('iRot', iRotAttr);
    geom.instanceCount = n;
  }
  bindInstanced();

  // --- マテリアル（SpriteNodeMaterial＝カメラ自動追従ビルボード） ---
  const uCols = uniform(cfg.frames ? cfg.frames.cols : 1);
  const uRows = uniform(cfg.frames ? cfg.frames.rows : 1);

  const iPos = attribute('iPos', 'vec3');
  const iSize = attribute('iSize', 'float');
  const iColor = attribute('iColor', 'vec4');
  const iFrame = attribute('iFrame', 'float');
  const iRot = attribute('iRot', 'float');

  // スプライトシートのコマUV（frame0=左上、上向き正）
  const baseUv = uv();
  const fxCol = mod(iFrame, uCols);
  const fyRow = floor(iFrame.div(uCols));
  const sheetUv = vec2(
    fxCol.add(baseUv.x).div(uCols),
    float(1).sub(fyRow.add(float(1).sub(baseUv.y)).div(uRows)),
  );
  // texture(tex, uv) は uv でサンプルしたノードを返し、.value で後からテクスチャ差替も可能
  const texNode = texture(loadFxTexture(cfg.texture), sheetUv);

  const material = new THREE.SpriteNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.blending = cfg.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.positionNode = iPos;                 // per-instance 中心（SpriteNodeMaterial がカメラ向きに展開）
  material.scaleNode = vec2(iSize, iSize);      // per-instance サイズ
  material.rotationNode = iRot;                 // per-instance 面内自転
  material.colorNode = iColor.xyz.mul(texNode.xyz);
  material.opacityNode = iColor.w.mul(texNode.w);

  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;

  function reallocate() {
    n = cfg.maxParticles;
    allocArrays();
    bindInstanced();
  }

  function spawn(i, t) {
    emitEuler.set(
      THREE.MathUtils.degToRad(cfg.emitter.rotation[0]),
      THREE.MathUtils.degToRad(cfg.emitter.rotation[1]),
      THREE.MathUtils.degToRad(cfg.emitter.rotation[2]),
    );
    emitQuat.setFromEuler(emitEuler);

    tmpV.set(0, 0, 0);
    if (cfg.emitter.shape === 'disc') {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * cfg.emitter.radius;
      tmpV.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    } else if (cfg.emitter.shape === 'box') {
      tmpV.set(
        rand(-cfg.emitter.size[0], cfg.emitter.size[0]),
        rand(-cfg.emitter.size[1], cfg.emitter.size[1]),
        rand(-cfg.emitter.size[2], cfg.emitter.size[2]),
      );
    }
    tmpV.applyQuaternion(emitQuat);
    px[i * 3] = tmpV.x; px[i * 3 + 1] = tmpV.y; px[i * 3 + 2] = tmpV.z;

    tmpDir.copy(baseDir).applyQuaternion(emitQuat).normalize();
    randomConeDir(tmpDir, THREE.MathUtils.degToRad(cfg.velocity.spreadDeg), tmpDir);
    const sp = rand(cfg.velocity.speed[0], cfg.velocity.speed[1]);
    vel[i * 3] = tmpDir.x * sp; vel[i * 3 + 1] = tmpDir.y * sp; vel[i * 3 + 2] = tmpDir.z * sp;

    const spinCfg = cfg.spin;
    aRot[i] = spinCfg ? THREE.MathUtils.degToRad(rand(spinCfg.startDeg[0], spinCfg.startDeg[1])) : 0;
    spinV[i] = spinCfg ? THREE.MathUtils.degToRad(rand(spinCfg.speedDeg[0], spinCfg.speedDeg[1])) : 0;

    age[i] = 0;
    life[i] = rand(cfg.lifetime[0], cfg.lifetime[1]);
    alive[i] = 1;
    void t;
  }

  function frameIndex(t, ageSec) {
    const fr = cfg.frames;
    if (!fr) return 0;
    const total = fr.cols * fr.rows;
    if (total <= 1) return 0;
    if (fr.mode === 'overLife') return Math.min(total - 1, Math.floor(t * total));
    if (fr.mode === 'once') return Math.min(total - 1, Math.floor(ageSec * fr.fps));
    return Math.floor(ageSec * fr.fps) % total; // loop
  }

  function writeParticle(i) {
    const t = life[i] > 0 ? age[i] / life[i] : 1;
    const sz = THREE.MathUtils.lerp(cfg.size.start, cfg.size.end, t);
    const op = THREE.MathUtils.lerp(cfg.opacity.start, cfg.opacity.end, t);
    const col = cStart.clone().lerp(cEnd, t);
    aSize[i] = sz;
    aCol[i * 4] = col.r; aCol[i * 4 + 1] = col.g; aCol[i * 4 + 2] = col.b; aCol[i * 4 + 3] = op;
    aFrame[i] = frameIndex(t, age[i]);
  }

  /** 何個か即時発生（着弾・マズルフラッシュ等の単発演出） */
  function burst(count) { extraSpawn += Math.max(0, count | 0); }

  function setEmitting(on) { emitting = !!on; }

  function update(dt) {
    cStart.set(cfg.color.start);
    cEnd.set(cfg.color.end);

    // 連続発生 + バースト分
    if (emitting) spawnAcc += cfg.spawnRate * dt;
    let toSpawn = Math.floor(spawnAcc) + extraSpawn;
    spawnAcc -= Math.floor(spawnAcc);
    extraSpawn = 0;
    for (let i = 0; i < n && toSpawn > 0; i++) {
      if (alive[i] === 0) { spawn(i); toSpawn--; }
    }

    const damp = Math.max(0, 1 - cfg.drag * dt);
    for (let i = 0; i < n; i++) {
      if (alive[i] === 0) { aCol[i * 4 + 3] = 0; continue; }
      age[i] += dt;
      if (age[i] >= life[i]) { alive[i] = 0; aCol[i * 4 + 3] = 0; continue; }
      vel[i * 3] = (vel[i * 3] + cfg.acceleration[0] * dt) * damp;
      vel[i * 3 + 1] = (vel[i * 3 + 1] + cfg.acceleration[1] * dt) * damp;
      vel[i * 3 + 2] = (vel[i * 3 + 2] + cfg.acceleration[2] * dt) * damp;
      px[i * 3] += vel[i * 3] * dt;
      px[i * 3 + 1] += vel[i * 3 + 1] * dt;
      px[i * 3 + 2] += vel[i * 3 + 2] * dt;
      aRot[i] += spinV[i] * dt;
      writeParticle(i);
    }

    iPosAttr.needsUpdate = true;
    iColAttr.needsUpdate = true;
    iSizeAttr.needsUpdate = true;
    iFrameAttr.needsUpdate = true;
    iRotAttr.needsUpdate = true;
  }

  function setConfig(next) {
    cfg = next;
    if (next.maxParticles !== curMax) { reallocate(); curMax = next.maxParticles; }
    if (next.blending !== curBlending) {
      material.blending = next.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
      material.needsUpdate = true;
      curBlending = next.blending;
    }
    if (next.texture !== curTexture) {
      const old = texNode.value;
      texNode.value = loadFxTexture(next.texture);
      if (old && old.dispose) old.dispose();
      curTexture = next.texture;
    }
    uCols.value = next.frames ? next.frames.cols : 1;
    uRows.value = next.frames ? next.frames.rows : 1;
  }

  function getConfig() { return cfg; }

  function dispose() {
    geom.dispose();
    baseGeom.dispose();
    if (texNode.value && texNode.value.dispose) texNode.value.dispose();
    material.dispose();
  }

  return { object3D: mesh, update, burst, setEmitting, setConfig, getConfig, dispose };
}
