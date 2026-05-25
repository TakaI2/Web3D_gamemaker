import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float,
  transformNormalToView, cross, triNoise3D, time,
  frontFacing,
} from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';

// ---- Cloth geometry constants ----
const clothWidth   = 1;
const clothHeight  = 1;
const sphereRadius = 0.15;
const CLOTH_SPACING = 1.3; // インスタンス間隔 (m)

// ---- Mutable settings ----
let clothNumSegments = 30;
let instanceCount    = 1;

// ---- Scene ----
let renderer, scene, camera, controls;
let timeSinceLastStep = 0;
let timestamp         = 0;

// ---- Shared uniforms (全インスタンス共通) ----
let stiffnessUniform;
let dampeningUniform;
let windUniform;
let sphereVisibleUniform;

// ---- Shared color uniforms ----
let frontColorUniform;
let backColorUniform;

// ---- Instance list ----
const instances = [];

// ---- FPS ----
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ---- Runtime params ----
const params = {
  wireframe: false,
  sphere:    true,
  wind:      1.0,
};
const matParams = {
  colorFront:     '#204080',
  colorBack:      '#803020',
  roughness:      1.0,
  sheen:          1.0,
  sheenRoughness: 0.5,
  sheenColor:     '#ffffff',
};

const timer = new THREE.Timer();
timer.connect(document);

// ============================================================
// Per-instance creation / teardown
// ============================================================

function buildVerletGeometry(segs) {
  const verletVertices      = [];
  const verletSprings       = [];
  const verletVertexColumns = [];

  const addVertex = (x, y, z, isFixed) => {
    const id = verletVertices.length;
    const v  = { id, position: new THREE.Vector3(x, y, z), isFixed, springIds: [] };
    verletVertices.push(v);
    return v;
  };
  const addSpring = (v0, v1) => {
    const id = verletSprings.length;
    v0.springIds.push(id);
    v1.springIds.push(id);
    verletSprings.push({ id, vertex0: v0, vertex1: v1 });
  };

  for (let x = 0; x <= segs; x++) {
    const col = [];
    for (let y = 0; y <= segs; y++) {
      const posX    = x * (clothWidth / segs) - clothWidth * 0.5;
      const posZ    = y * (clothHeight / segs);
      const isFixed = (y === 0) && ((x % Math.max(1, Math.floor(segs / 6))) === 0);
      col.push(addVertex(posX, clothHeight * 0.5, posZ, isFixed));
    }
    verletVertexColumns.push(col);
  }

  for (let x = 0; x <= segs; x++) {
    for (let y = 0; y <= segs; y++) {
      const v0 = verletVertexColumns[x][y];
      if (x > 0)              addSpring(v0, verletVertexColumns[x-1][y]);
      if (y > 0)              addSpring(v0, verletVertexColumns[x][y-1]);
      if (x > 0 && y > 0)    addSpring(v0, verletVertexColumns[x-1][y-1]);
      if (x > 0 && y < segs) addSpring(v0, verletVertexColumns[x-1][y+1]);
    }
  }

  return { verletVertices, verletSprings, verletVertexColumns };
}

function createInstance(segs, offsetX) {
  const { verletVertices, verletSprings, verletVertexColumns } = buildVerletGeometry(segs);

  // ---- Vertex buffers ----
  const vertexCount     = verletVertices.length;
  const springListArray = [];
  const vertexPosArr    = new Float32Array(vertexCount * 3);
  const vertexParamsArr = new Uint32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    const v = verletVertices[i];
    vertexPosArr[i*3]   = v.position.x;
    vertexPosArr[i*3+1] = v.position.y;
    vertexPosArr[i*3+2] = v.position.z;
    vertexParamsArr[i*3] = v.isFixed ? 1 : 0;
    if (!v.isFixed) {
      vertexParamsArr[i*3+1] = v.springIds.length;
      vertexParamsArr[i*3+2] = springListArray.length;
      springListArray.push(...v.springIds);
    }
  }

  const vertexPositionBuffer = instancedArray(vertexPosArr, 'vec3').setPBO(true);
  const vertexForceBuffer    = instancedArray(vertexCount, 'vec3');
  const vertexParamsBuffer   = instancedArray(vertexParamsArr, 'uvec3');
  const springListBuffer     = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true);

  // ---- Spring buffers ----
  const springCount      = verletSprings.length;
  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);

  for (let i = 0; i < springCount; i++) {
    const s = verletSprings[i];
    springVertIdArr[i*2]   = s.vertex0.id;
    springVertIdArr[i*2+1] = s.vertex1.id;
    springRestLenArr[i]    = s.vertex0.position.distanceTo(s.vertex1.position);
  }

  const springVertexIdBuffer   = instancedArray(springVertIdArr, 'uvec2').setPBO(true);
  const springRestLengthBuffer = instancedArray(springRestLenArr, 'float');
  const springForceBuffer      = instancedArray(springCount * 3, 'vec3').setPBO(true);

  // ---- Per-instance uniform ----
  const spherePositionUniform = uniform(new THREE.Vector3(0, 0, 0));

  // ---- Compute shaders ----
  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('Spring Forces');

  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;

    If(isFixed, () => { Return(); });

    const position = vertexPositionBuffer.element(instanceIndex).toVar('vertexPosition');
    const force    = vertexForceBuffer.element(instanceIndex).toVar('vertexForce');

    force.mulAssign(dampeningUniform);

    const ptrStart = springPointer.toVar('ptrStart');
    const ptrEnd   = ptrStart.add(springCnt).toVar('ptrEnd');

    Loop({ start: ptrStart, end: ptrEnd, type: 'uint', condition: '<' }, ({ i }) => {
      const springId      = springListBuffer.element(i).toVar('springId');
      const springForce   = springForceBuffer.element(springId);
      const springVertIds = springVertexIdBuffer.element(springId);
      const factor        = select(springVertIds.x.equal(instanceIndex), 1.0, -1.0);
      force.addAssign(springForce.mul(factor));
    });

    force.y.subAssign(0.00005);

    const noise     = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    const windForce = noise.mul(windUniform);
    force.z.subAssign(windForce);

    const deltaSphere = position.add(force).sub(spherePositionUniform);
    const dist        = deltaSphere.length();
    const sphereForce = float(sphereRadius).sub(dist).max(0).mul(deltaSphere).div(dist).mul(sphereVisibleUniform);
    force.addAssign(sphereForce);

    vertexForceBuffer.element(instanceIndex).assign(force);
    vertexPositionBuffer.element(instanceIndex).addAssign(force);
  })().compute(vertexCount).setName('Vertex Forces');

  // ---- Wireframe ----
  const vertexWireMat = new THREE.SpriteNodeMaterial();
  vertexWireMat.positionNode = vertexPositionBuffer.element(instanceIndex);
  const vertexWireframeObject = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), vertexWireMat);
  vertexWireframeObject.frustumCulled = false;
  vertexWireframeObject.count = verletVertices.length;
  vertexWireframeObject.position.x = offsetX;
  scene.add(vertexWireframeObject);

  const springMat = new THREE.LineBasicNodeMaterial();
  springMat.positionNode = Fn(() => {
    const vertexIds = springVertexIdBuffer.element(instanceIndex);
    const vertexId  = select(attribute('vertexIndex').equal(0), vertexIds.x, vertexIds.y);
    return vertexPositionBuffer.element(vertexId);
  })();
  const springGeo = new THREE.InstancedBufferGeometry();
  springGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3, false));
  springGeo.setAttribute('vertexIndex', new THREE.BufferAttribute(new Uint32Array([0, 1]), 1, false));
  springGeo.instanceCount = verletSprings.length;
  const springWireframeObject = new THREE.Line(springGeo, springMat);
  springWireframeObject.frustumCulled = false;
  springWireframeObject.position.x = offsetX;
  scene.add(springWireframeObject);

  // ---- Cloth mesh ----
  const meshVertexCount = segs * segs;
  const clothGeo        = new THREE.BufferGeometry();
  const verletVertIdArr = new Uint32Array(meshVertexCount * 4);
  const indices         = [];
  const getIndex        = (x, y) => y * segs + x;

  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const idx = getIndex(x, y);
      verletVertIdArr[idx*4]   = verletVertexColumns[x][y].id;
      verletVertIdArr[idx*4+1] = verletVertexColumns[x+1][y].id;
      verletVertIdArr[idx*4+2] = verletVertexColumns[x][y+1].id;
      verletVertIdArr[idx*4+3] = verletVertexColumns[x+1][y+1].id;
      if (x > 0 && y > 0) {
        indices.push(getIndex(x,y), getIndex(x-1,y), getIndex(x-1,y-1));
        indices.push(getIndex(x,y), getIndex(x-1,y-1), getIndex(x,y-1));
      }
    }
  }

  clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(meshVertexCount * 3), 3, false));
  clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(verletVertIdArr, 4, false));
  clothGeo.setIndex(indices);

  const clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:           THREE.DoubleSide,
    transparent:    true,
    opacity:        0.85,
    roughness:      matParams.roughness,
    sheen:          matParams.sheen,
    sheenRoughness: matParams.sheenRoughness,
    sheenColor:     new THREE.Color(matParams.sheenColor),
  });
  clothMat.colorNode = select(frontFacing, frontColorUniform, backColorUniform);
  clothMat.positionNode = Fn(({ material }) => {
    const vertexIds = attribute('vertexIds');
    const v0 = vertexPositionBuffer.element(vertexIds.x).toVar();
    const v1 = vertexPositionBuffer.element(vertexIds.y).toVar();
    const v2 = vertexPositionBuffer.element(vertexIds.z).toVar();
    const v3 = vertexPositionBuffer.element(vertexIds.w).toVar();
    const top     = v0.add(v1);
    const right   = v1.add(v3);
    const bottom  = v2.add(v3);
    const left    = v0.add(v2);
    const tangent   = right.sub(left).normalize();
    const bitangent = bottom.sub(top).normalize();
    const normal    = cross(tangent, bitangent);
    material.normalNode = transformNormalToView(normal).toVarying();
    return v0.add(v1).add(v2).add(v3).mul(0.25);
  })();

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  clothMesh.position.x = offsetX;
  scene.add(clothMesh);

  // ---- Sphere ----
  const sphereGeo  = new THREE.IcosahedronGeometry(sphereRadius * 0.95, 4);
  const sphereMat2 = new THREE.MeshStandardNodeMaterial();
  const sphereMesh  = new THREE.Mesh(sphereGeo, sphereMat2);
  sphereMesh.position.x = offsetX;
  scene.add(sphereMesh);

  return {
    offsetX,
    spherePositionUniform,
    computeSpringForces,
    computeVertexForces,
    clothMesh,
    clothMat,
    vertexWireframeObject,
    springWireframeObject,
    sphereMesh,
  };
}

function teardownInstance(inst) {
  scene.remove(inst.clothMesh);
  inst.clothMesh.geometry.dispose();
  scene.remove(inst.vertexWireframeObject);
  inst.vertexWireframeObject.geometry.dispose();
  scene.remove(inst.springWireframeObject);
  inst.springWireframeObject.geometry.dispose();
  scene.remove(inst.sphereMesh);
  inst.sphereMesh.geometry.dispose();
}

function setInstanceCount(n, segs) {
  for (const inst of instances) teardownInstance(inst);
  instances.length = 0;
  timeSinceLastStep = 0;
  timestamp         = 0;

  for (let i = 0; i < n; i++) {
    const offsetX = (i - (n - 1) / 2) * CLOTH_SPACING;
    instances.push(createInstance(segs, offsetX));
  }

  applyVisibility();

  // カメラをインスタンス数に合わせてズームアウト
  const spread    = (n - 1) * CLOTH_SPACING;
  const idealDist = Math.max(2.5, 1.8 + spread * 0.65);
  camera.position.set(-idealDist * 0.9, -0.1, -idealDist * 0.9);
  controls.maxDistance = Math.max(4, idealDist * 2.5);
  controls.target.set(0, -0.1, 0);
  controls.update();
}

function applyVisibility() {
  for (const inst of instances) {
    inst.clothMesh.visible             = !params.wireframe;
    inst.vertexWireframeObject.visible = params.wireframe;
    inst.springWireframeObject.visible = params.wireframe;
    inst.sphereMesh.visible            = params.sphere;
  }
}

// ============================================================
// UI
// ============================================================
function setupUI() {
  // Count
  const countSlider = document.getElementById('count');
  const countVal    = document.getElementById('count-val');
  let   countTimer  = null;
  countSlider.addEventListener('input', () => {
    const n = parseInt(countSlider.value, 10);
    countVal.textContent = String(n);
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      instanceCount = n;
      setInstanceCount(n, clothNumSegments);
    }, 400);
  });

  // Stiffness
  const stiffnessSlider = document.getElementById('stiffness');
  const stiffnessVal    = document.getElementById('stiffness-val');
  stiffnessSlider.addEventListener('input', () => {
    const v = parseFloat(stiffnessSlider.value);
    stiffnessVal.textContent = v.toFixed(2);
    stiffnessUniform.value   = v;
  });

  // Wind
  const windSlider = document.getElementById('wind');
  const windVal    = document.getElementById('wind-val');
  windSlider.addEventListener('input', () => {
    params.wind       = parseFloat(windSlider.value);
    windVal.textContent = params.wind.toFixed(1);
  });

  // Wireframe / Sphere
  document.getElementById('wireframe').addEventListener('change', (e) => {
    params.wireframe = e.target.checked;
    applyVisibility();
  });
  document.getElementById('sphere').addEventListener('change', (e) => {
    params.sphere = e.target.checked;
    applyVisibility();
  });

  // Segments
  const segsSlider = document.getElementById('segments');
  const segsVal    = document.getElementById('segments-val');
  let   segsTimer  = null;
  segsSlider.addEventListener('input', () => {
    const v = parseInt(segsSlider.value, 10);
    segsVal.textContent = `${v}×${v}`;
    clearTimeout(segsTimer);
    segsTimer = setTimeout(() => {
      clothNumSegments = v;
      setInstanceCount(instanceCount, v);
    }, 300);
  });

  // Material
  document.getElementById('mat-color-front').addEventListener('input', (e) => {
    matParams.colorFront = e.target.value;
    frontColorUniform.value.set(e.target.value);
  });
  document.getElementById('mat-color-back').addEventListener('input', (e) => {
    matParams.colorBack = e.target.value;
    backColorUniform.value.set(e.target.value);
  });

  const matRoughness     = document.getElementById('mat-roughness');
  const matRoughnessVal  = document.getElementById('mat-roughness-val');
  matRoughness.addEventListener('input', () => {
    const v = parseFloat(matRoughness.value);
    matParams.roughness = v;
    matRoughnessVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.roughness = v;
  });

  const matSheen    = document.getElementById('mat-sheen');
  const matSheenVal = document.getElementById('mat-sheen-val');
  matSheen.addEventListener('input', () => {
    const v = parseFloat(matSheen.value);
    matParams.sheen = v;
    matSheenVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheen = v;
  });

  const matSheenRough    = document.getElementById('mat-sheen-roughness');
  const matSheenRoughVal = document.getElementById('mat-sheen-roughness-val');
  matSheenRough.addEventListener('input', () => {
    const v = parseFloat(matSheenRough.value);
    matParams.sheenRoughness = v;
    matSheenRoughVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheenRoughness = v;
  });

  const matSheenColor = document.getElementById('mat-sheen-color');
  matSheenColor.addEventListener('input', () => {
    matParams.sheenColor = matSheenColor.value;
    for (const inst of instances) inst.clothMat.sheenColor.set(matSheenColor.value);
  });

  // セクション折りたたみ
  for (const id of ['mat-toggle', 'mesh-toggle']) {
    const toggle = document.getElementById(id);
    const body   = document.getElementById(id.replace('toggle', 'body'));
    if (toggle && body) {
      toggle.addEventListener('click', () => {
        toggle.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
      });
    }
  }
}

// ============================================================
// Render loop
// ============================================================
function updateSpheres() {
  const n = instances.length;
  for (let i = 0; i < n; i++) {
    const inst   = instances[i];
    const phase  = i * (Math.PI / Math.max(n, 1));
    const localX = Math.sin(timestamp * 2.1 + phase) * 0.1;
    const localZ = Math.sin(timestamp * 0.8 + phase);
    inst.spherePositionUniform.value.set(localX, 0, localZ);
    inst.sphereMesh.position.set(inst.offsetX + localX, 0, localZ);
  }
}

function updateFPS() {
  fpsFrameCount++;
  const now     = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount / (elapsed / 1000));
    fpsFrameCount = 0;
    fpsLastTime   = now;
    document.getElementById('fps-counter').textContent = `${fps} FPS`;
  }
}

async function render() {
  timer.update();
  updateFPS();

  sphereVisibleUniform.value = params.sphere ? 1 : 0;
  windUniform.value          = params.wind;

  const deltaTime   = Math.min(timer.getDelta(), 1 / 60);
  const stepsPerSec = 360;
  const timePerStep = 1 / stepsPerSec;

  timeSinceLastStep += deltaTime;
  while (timeSinceLastStep >= timePerStep) {
    timestamp         += timePerStep;
    timeSinceLastStep -= timePerStep;
    updateSpheres();
    for (const inst of instances) {
      renderer.compute(inst.computeSpringForces);
      renderer.compute(inst.computeVertexForces);
    }
  }

  renderer.render(scene, camera);
}

// ============================================================
// Init
// ============================================================
async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  const hasWebGPU = !!navigator.gpu;

  renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  app.appendChild(renderer.domElement);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(-1.6, -0.1, -1.6);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 0.5;
  controls.maxDistance = 30;
  controls.target.set(0, -0.1, 0);
  controls.update();

  // 共有ユニフォーム初期化
  stiffnessUniform     = uniform(0.2);
  dampeningUniform     = uniform(0.99);
  windUniform          = uniform(1.0);
  sphereVisibleUniform = uniform(1.0);
  frontColorUniform    = uniform(new THREE.Color(matParams.colorFront));
  backColorUniform     = uniform(new THREE.Color(matParams.colorBack));

  // HDR
  try {
    const hdrLoader  = new UltraHDRLoader();
    const hdrTexture = await hdrLoader.loadAsync(
      'https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg',
    );
    hdrTexture.mapping         = THREE.EquirectangularReflectionMapping;
    scene.background           = hdrTexture;
    scene.backgroundBlurriness = 0.5;
    scene.environment          = hdrTexture;
  } catch {
    scene.background = new THREE.Color(0x1a1a2e);
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dLight = new THREE.DirectionalLight(0xffffff, 2);
    dLight.position.set(1, 2, 1);
    scene.add(dLight);
  }

  setInstanceCount(1, clothNumSegments);
  setupUI();

  if (!hasWebGPU) {
    // WebGL2フォールバック: セグメント変更でクラッシュするため無効化
    const segsSlider = document.getElementById('segments');
    const countSlider = document.getElementById('count');
    if (segsSlider) { segsSlider.disabled = true; segsSlider.title = 'WebGPU必須'; }
    if (countSlider) { countSlider.disabled = true; countSlider.title = 'WebGPU必須'; }
    const warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;bottom:36px;left:50%;transform:translateX(-50%);background:rgba(180,120,0,0.85);color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;pointer-events:none;z-index:10;white-space:nowrap;';
    warn.textContent = '⚠ WebGL2モード: Count/Segment変更不可 (WebGPU推奨)';
    document.body.appendChild(warn);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
}

init().catch((err) => {
  console.error(err);
  const msg    = document.getElementById('error-msg');
  const detail = document.getElementById('error-detail');
  detail.textContent = String(err);
  msg.classList.add('visible');
  document.getElementById('loading').style.display = 'none';
});
