// fps-cloth-mobile.js — スマホ専用 FPS + 布シミュレーション

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float,
  transformNormalToView, cross, triNoise3D, time,
  frontFacing,
} from 'https://esm.sh/three@0.184.0/tsl';
import { Octree } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Octree.js';
import { Capsule } from 'https://esm.sh/three@0.184.0/examples/jsm/math/Capsule.js';

// ── Cloth constants ───────────────────────────────────────────────────────
const clothWidth     = 1;
const clothHeight    = 1;
const sphereRadius   = 0.15;
const CLOTH_SPACING  = 1.5;
const CLOTH_Y_OFFSET = 2.0;

// ── Player constants ──────────────────────────────────────────────────────
const PLAYER_SPEED   = 20;
const GRAVITY_ACCEL  = 25;
const JUMP_VEL       = 10;
const RESPAWN_Y      = -8;

// ── Mutable settings ──────────────────────────────────────────────────────
let clothNumSegments = 30;
let instanceCount    = 3;

// ── Scene globals ─────────────────────────────────────────────────────────
let renderer, scene, camera;
let worldOctree    = null;
let playerCollider = null;
let playerOnFloor  = false;
let timeSinceLastStep = 0;
let timestamp         = 0;

// ── Player state ──────────────────────────────────────────────────────────
const playerVel  = new THREE.Vector3();
let   playerYaw   = Math.PI;
let   playerPitch = 0;
let   isLocked    = true; // タッチ版は常時操作可能

// ── Touch controls ────────────────────────────────────────────────────────
const JOYSTICK_MAX = 60;
const touchMove    = { active: false, id: -1, startX: 0, startY: 0 };
const touchLook    = { active: false, id: -1, prevX: 0, prevY: 0 };
const joystickVec  = { x: 0, y: 0 };

// ── FPS counter ───────────────────────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ── Frustum culling for cloth compute ────────────────────────────────────
const clothFrustum    = new THREE.Frustum();
const clothProjMatrix = new THREE.Matrix4();

// ── Shared uniforms ───────────────────────────────────────────────────────
let stiffnessUniform;
let dampeningUniform;
let windUniform;
let sphereVisibleUniform;
let frontColorUniform;
let backColorUniform;

const instances = [];

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

const poleMat = new THREE.MeshStandardMaterial({ color: 0x888899, roughness: 0.4, metalness: 0.8 });

// ============================================================
// Level builder
// ============================================================

function buildLevel() {
  const group = new THREE.Group();

  const mFloor    = new THREE.MeshStandardMaterial({ color: 0x4a7c3a, roughness: 0.95 });
  const mPlatform = new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 0.85 });
  const mStair    = new THREE.MeshStandardMaterial({ color: 0xaa9a80, roughness: 0.80 });
  const mWall     = new THREE.MeshStandardMaterial({ color: 0x6a7080, roughness: 0.90 });
  const mColumn   = new THREE.MeshStandardMaterial({ color: 0x9090a0, roughness: 0.70, metalness: 0.2 });

  const box = (x, y, z, w, h, d, mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };

  box(0, -0.25, 2.5, 22, 0.5, 11, mFloor);
  box(-11, 1.5, 2.5, 0.3, 3, 11, mWall);
  box( 11, 1.5, 2.5, 0.3, 3, 11, mWall);

  const S1 = { count: 5, rise: 0.5, tread: 0.8, zStart: -3, yStart: 0, width: 16 };
  for (let i = 0; i < S1.count; i++) {
    const h  = (i + 1) * S1.rise;
    const cy = S1.yStart + h / 2;
    const cz = S1.zStart - (i + 0.5) * S1.tread;
    box(0, cy, cz, S1.width, h, S1.tread, mStair);
  }

  box(0, 2.25, -12, 16, 0.5, 10, mPlatform);
  box(-8, 4.0, -12, 0.3, 3, 10, mWall);
  box( 8, 4.0, -12, 0.3, 3, 10, mWall);
  for (const px of [-6, -3, 3, 6]) {
    box(px, 3.75, -7.5, 0.4, 2.5, 0.4, mColumn);
  }
  const midLight = new THREE.PointLight(0xfff0cc, 1.5, 18);
  midLight.position.set(0, 5.0, -12);
  scene.add(midLight);

  const S2 = { count: 5, rise: 0.5, tread: 0.8, zStart: -17, yStart: 2.5, width: 14 };
  for (let i = 0; i < S2.count; i++) {
    const h  = (i + 1) * S2.rise;
    const cy = S2.yStart + h / 2;
    const cz = S2.zStart - (i + 0.5) * S2.tread;
    box(0, cy, cz, S2.width, h, S2.tread, mStair);
  }

  box(0, 4.75, -26, 14, 0.5, 10, mPlatform);
  box(-7, 7.0, -26, 0.3, 4, 10, mWall);
  box( 7, 7.0, -26, 0.3, 4, 10, mWall);
  box(0, 7.0, -31, 14, 4, 0.3, mWall);
  for (const px of [-5, 0, 5]) {
    box(px, 6.5, -22, 0.4, 3, 0.4, mColumn);
  }
  const hiLight = new THREE.PointLight(0xccddff, 1.5, 18);
  hiLight.position.set(0, 7.5, -26);
  scene.add(hiLight);

  scene.add(group);
  worldOctree = new Octree();
  worldOctree.fromGraphNode(group);
}

// ============================================================
// Cloth geometry builder
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

// ============================================================
// Per-instance creation / teardown
// ============================================================

function createInstance(segs, offsetX) {
  const { verletVertices, verletSprings, verletVertexColumns } = buildVerletGeometry(segs);

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

  const spherePositionUniform = uniform(new THREE.Vector3(0, 0, 0));

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
  vertexWireframeObject.position.set(offsetX, CLOTH_Y_OFFSET, 0);
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
  springWireframeObject.position.set(offsetX, CLOTH_Y_OFFSET, 0);
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
    const top      = v0.add(v1);
    const right    = v1.add(v3);
    const bottom   = v2.add(v3);
    const left     = v0.add(v2);
    const tangent   = right.sub(left).normalize();
    const bitangent = bottom.sub(top).normalize();
    const normal    = cross(tangent, bitangent);
    material.normalNode = transformNormalToView(normal).toVarying();
    return v0.add(v1).add(v2).add(v3).mul(0.25);
  })();

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  clothMesh.position.set(offsetX, CLOTH_Y_OFFSET, 0);
  scene.add(clothMesh);

  // ---- Sphere ----
  const sphereGeo  = new THREE.IcosahedronGeometry(sphereRadius * 0.95, 4);
  const sphereMat2 = new THREE.MeshStandardNodeMaterial();
  const sphereMesh  = new THREE.Mesh(sphereGeo, sphereMat2);
  sphereMesh.position.set(offsetX, CLOTH_Y_OFFSET, 0);
  scene.add(sphereMesh);

  // ---- Hanging pole ----
  const barWorldY = CLOTH_Y_OFFSET + 0.5;
  const barGeo = new THREE.CylinderGeometry(0.025, 0.025, clothWidth + 0.12, 8);
  const bar = new THREE.Mesh(barGeo, poleMat);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(offsetX, barWorldY, 0);
  scene.add(bar);

  const poles = [];
  for (const side of [-1, 1]) {
    const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, barWorldY, 8);
    const pole    = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(offsetX + side * (clothWidth * 0.5 + 0.05), barWorldY * 0.5, 0);
    scene.add(pole);
    poles.push(pole);
  }

  const boundingSphere = new THREE.Sphere(
    new THREE.Vector3(offsetX, CLOTH_Y_OFFSET, 0),
    1.5,
  );

  return {
    offsetX,
    boundingSphere,
    spherePositionUniform,
    computeSpringForces,
    computeVertexForces,
    clothMesh,
    clothMat,
    vertexWireframeObject,
    springWireframeObject,
    sphereMesh,
    bar,
    poles,
    clothGeo,
    springGeo,
    sphereGeo,
    barGeo,
  };
}

function teardownInstance(inst) {
  scene.remove(inst.clothMesh);
  scene.remove(inst.vertexWireframeObject);
  scene.remove(inst.springWireframeObject);
  scene.remove(inst.sphereMesh);
  scene.remove(inst.bar);
  for (const p of inst.poles) scene.remove(p);
  inst.clothGeo.dispose();
  inst.springGeo.dispose();
  inst.vertexWireframeObject.geometry.dispose();
  inst.sphereGeo.dispose();
  inst.barGeo.dispose();
  for (const p of inst.poles) p.geometry.dispose();
}

function setInstanceCount(n, segs) {
  for (const inst of instances) teardownInstance(inst);
  instances.length    = 0;
  timeSinceLastStep   = 0;
  timestamp           = 0;
  for (let i = 0; i < n; i++) {
    const offsetX = (i - (n - 1) / 2) * CLOTH_SPACING;
    instances.push(createInstance(segs, offsetX));
  }
  applyVisibility();
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
// Player physics
// ============================================================

function playerCollisions() {
  const result = worldOctree.capsuleIntersect(playerCollider);
  playerOnFloor = false;
  if (result) {
    playerOnFloor = result.normal.y > 0;
    if (!playerOnFloor) {
      playerVel.addScaledVector(result.normal, -result.normal.dot(playerVel));
    }
    playerCollider.translate(result.normal.multiplyScalar(result.depth));
  }
}

function updatePlayer(dt) {
  const speedDelta = dt * (playerOnFloor ? PLAYER_SPEED : PLAYER_SPEED * 0.4);
  const fwd   = new THREE.Vector3(-Math.sin(playerYaw), 0, -Math.cos(playerYaw));
  const right  = new THREE.Vector3( Math.cos(playerYaw), 0, -Math.sin(playerYaw));

  playerVel.addScaledVector(fwd,  -joystickVec.y * speedDelta);
  playerVel.addScaledVector(right,  joystickVec.x * speedDelta);

  let damping = Math.exp(-4 * dt) - 1;
  if (!playerOnFloor) {
    playerVel.y -= GRAVITY_ACCEL * dt;
    damping *= 0.1;
  }
  playerVel.addScaledVector(playerVel, damping);

  playerCollider.translate(playerVel.clone().multiplyScalar(dt));
  playerCollisions();

  if (playerCollider.end.y < RESPAWN_Y) {
    playerCollider.set(
      new THREE.Vector3(0, 0.35, 4),
      new THREE.Vector3(0, 1.0, 4),
      0.35,
    );
    playerVel.set(0, 0, 0);
  }

  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
}

// ============================================================
// Touch controls
// ============================================================

function setupTouchControls() {
  const jumpBtn       = document.getElementById('jump-btn');
  const joystickBase  = document.getElementById('joystick-base');
  const joystickStick = document.getElementById('joystick-stick');
  const canvas        = renderer.domElement;

  if (jumpBtn) jumpBtn.style.display = 'flex';
  canvas.style.touchAction = 'none';

  canvas.addEventListener('pointerdown', (e) => {
    const isLeft = e.clientX < window.innerWidth / 2;
    if (isLeft) {
      if (touchMove.active) return;
      touchMove.active = true;
      touchMove.id     = e.pointerId;
      touchMove.startX = e.clientX;
      touchMove.startY = e.clientY;
      joystickBase.style.left    = `${e.clientX - 70}px`;
      joystickBase.style.top     = `${e.clientY - 70}px`;
      joystickBase.style.display = 'block';
      joystickStick.style.transform = 'translate(0px, 0px)';
    } else {
      if (touchLook.active) return;
      touchLook.active = true;
      touchLook.id     = e.pointerId;
      touchLook.prevX  = e.clientX;
      touchLook.prevY  = e.clientY;
    }
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (touchMove.active && e.pointerId === touchMove.id) {
      const dx   = e.clientX - touchMove.startX;
      const dy   = e.clientY - touchMove.startY;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const clamped = Math.min(dist, JOYSTICK_MAX);
        const nx = dx / dist;
        const ny = dy / dist;
        joystickVec.x = nx * (clamped / JOYSTICK_MAX);
        joystickVec.y = ny * (clamped / JOYSTICK_MAX);
        joystickStick.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`;
      }
    }
    if (touchLook.active && e.pointerId === touchLook.id) {
      const sens  = 0.005;
      playerYaw   -= (e.clientX - touchLook.prevX) * sens;
      playerPitch -= (e.clientY - touchLook.prevY) * sens;
      playerPitch  = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, playerPitch));
      camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');
      touchLook.prevX = e.clientX;
      touchLook.prevY = e.clientY;
    }
  });

  const endTouch = (e) => {
    if (touchMove.active && e.pointerId === touchMove.id) {
      touchMove.active  = false;
      touchMove.id      = -1;
      joystickVec.x     = 0;
      joystickVec.y     = 0;
      joystickBase.style.display = 'none';
      joystickStick.style.transform = 'translate(0px, 0px)';
    }
    if (touchLook.active && e.pointerId === touchLook.id) {
      touchLook.active = false;
      touchLook.id     = -1;
    }
  };
  canvas.addEventListener('pointerup',     endTouch);
  canvas.addEventListener('pointercancel', endTouch);

  jumpBtn?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (playerOnFloor) playerVel.y = JUMP_VEL;
  });
}

// ============================================================
// UI
// ============================================================

function setupUI() {
  // 設定パネル開閉
  const settingsBtn = document.getElementById('settings-btn');
  const uiCloseBtn  = document.getElementById('ui-close-btn');
  const uiPanel     = document.getElementById('ui');

  settingsBtn?.addEventListener('click', () => {
    uiPanel.classList.remove('collapsed');
    settingsBtn.style.display = 'none';
  });
  uiCloseBtn?.addEventListener('click', () => {
    uiPanel.classList.add('collapsed');
    settingsBtn.style.display = 'block';
  });

  const countSlider = document.getElementById('count');
  const countVal    = document.getElementById('count-val');
  let   countTimer  = null;
  if (countSlider) {
    countSlider.value = String(instanceCount);
    countVal.textContent = String(instanceCount);
    countSlider.addEventListener('input', () => {
      const n = parseInt(countSlider.value, 10);
      countVal.textContent = String(n);
      clearTimeout(countTimer);
      countTimer = setTimeout(() => {
        instanceCount = n;
        setInstanceCount(n, clothNumSegments);
      }, 400);
    });
  }

  const stiffnessSlider = document.getElementById('stiffness');
  const stiffnessVal    = document.getElementById('stiffness-val');
  stiffnessSlider?.addEventListener('input', () => {
    const v = parseFloat(stiffnessSlider.value);
    stiffnessVal.textContent = v.toFixed(2);
    stiffnessUniform.value   = v;
  });

  const windSlider = document.getElementById('wind');
  const windVal    = document.getElementById('wind-val');
  windSlider?.addEventListener('input', () => {
    params.wind         = parseFloat(windSlider.value);
    windVal.textContent = params.wind.toFixed(1);
  });

  document.getElementById('wireframe')?.addEventListener('change', (e) => {
    params.wireframe = e.target.checked; applyVisibility();
  });
  document.getElementById('sphere')?.addEventListener('change', (e) => {
    params.sphere = e.target.checked; applyVisibility();
  });

  const segsSlider = document.getElementById('segments');
  const segsVal    = document.getElementById('segments-val');
  let   segsTimer  = null;
  segsSlider?.addEventListener('input', () => {
    const v = parseInt(segsSlider.value, 10);
    segsVal.textContent = `${v}×${v}`;
    clearTimeout(segsTimer);
    segsTimer = setTimeout(() => {
      clothNumSegments = v;
      setInstanceCount(instanceCount, v);
    }, 300);
  });

  document.getElementById('mat-color-front')?.addEventListener('input', (e) => {
    frontColorUniform.value.set(e.target.value);
  });
  document.getElementById('mat-color-back')?.addEventListener('input', (e) => {
    backColorUniform.value.set(e.target.value);
  });

  const matRoughness    = document.getElementById('mat-roughness');
  const matRoughnessVal = document.getElementById('mat-roughness-val');
  matRoughness?.addEventListener('input', () => {
    const v = parseFloat(matRoughness.value);
    matRoughnessVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.roughness = v;
  });

  const matSheen    = document.getElementById('mat-sheen');
  const matSheenVal = document.getElementById('mat-sheen-val');
  matSheen?.addEventListener('input', () => {
    const v = parseFloat(matSheen.value);
    matSheenVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheen = v;
  });

  const matSheenRough    = document.getElementById('mat-sheen-roughness');
  const matSheenRoughVal = document.getElementById('mat-sheen-roughness-val');
  matSheenRough?.addEventListener('input', () => {
    const v = parseFloat(matSheenRough.value);
    matSheenRoughVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheenRoughness = v;
  });

  document.getElementById('mat-sheen-color')?.addEventListener('input', (e) => {
    for (const inst of instances) inst.clothMat.sheenColor.set(e.target.value);
  });

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
    inst.sphereMesh.position.set(inst.offsetX + localX, CLOTH_Y_OFFSET, localZ);
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
    const el = document.getElementById('fps-counter');
    if (el) el.textContent = `${fps} FPS`;
  }
}

async function render() {
  timer.update();
  updateFPS();

  const dt = Math.min(timer.getDelta(), 1 / 30);
  updatePlayer(dt);

  sphereVisibleUniform.value = params.sphere ? 1 : 0;
  windUniform.value          = params.wind;

  clothProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  clothFrustum.setFromProjectionMatrix(clothProjMatrix);

  const stepsPerSec     = 360;
  const timePerStep     = 1 / stepsPerSec;
  const MAX_STEPS_FRAME = 6;
  let stepsThisFrame    = 0;
  timeSinceLastStep += dt;
  while (timeSinceLastStep >= timePerStep && stepsThisFrame < MAX_STEPS_FRAME) {
    stepsThisFrame    += 1;
    timestamp         += timePerStep;
    timeSinceLastStep -= timePerStep;
    updateSpheres();
    for (const inst of instances) {
      if (!clothFrustum.intersectsSphere(inst.boundingSphere)) continue;
      renderer.compute(inst.computeSpringForces);
      renderer.compute(inst.computeVertexForces);
    }
  }
  if (stepsThisFrame >= MAX_STEPS_FRAME) timeSinceLastStep = 0;

  renderer.render(scene, camera);
}

// ============================================================
// Init
// ============================================================

async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.1;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6a9ab8);
  scene.fog = new THREE.FogExp2(0x6a9ab8, 0.018);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.rotation.order = 'YXZ';

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const sun = new THREE.DirectionalLight(0xfff4cc, 1.8);
  sun.position.set(5, 12, -3);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x8ab8d8, 0x4a8c3a, 0.6));

  buildLevel();

  playerCollider = new Capsule(
    new THREE.Vector3(0, 0.35, 4),
    new THREE.Vector3(0, 1.0,  4),
    0.35,
  );
  playerVel.set(0, 0, 0);
  camera.position.copy(playerCollider.end);
  camera.rotation.set(playerPitch, playerYaw, 0, 'YXZ');

  // cloth.json が指定されていればマテリアルパラメータを上書き
  const clothJsonUrl = document.querySelector('script[data-cloth-json]')?.dataset.clothJson;
  if (clothJsonUrl) {
    try {
      const json = await fetch(clothJsonUrl).then(r => r.json());
      const m = json.material ?? {};
      if (m.colorFront)     matParams.colorFront     = m.colorFront;
      if (m.colorBack)      matParams.colorBack      = m.colorBack;
      if (m.roughness      != null) matParams.roughness      = m.roughness;
      if (m.sheen          != null) matParams.sheen          = m.sheen;
      if (m.sheenRoughness != null) matParams.sheenRoughness = m.sheenRoughness;
      if (m.sheenColor)     matParams.sheenColor     = m.sheenColor;
    } catch (e) {
      console.warn('cloth.json の読み込みに失敗しました:', e);
    }
  }

  stiffnessUniform     = uniform(0.2);
  dampeningUniform     = uniform(0.99);
  windUniform          = uniform(1.0);
  sphereVisibleUniform = uniform(1.0);
  frontColorUniform    = uniform(new THREE.Color(matParams.colorFront));
  backColorUniform     = uniform(new THREE.Color(matParams.colorBack));

  setInstanceCount(instanceCount, clothNumSegments);
  setupUI();
  setupTouchControls();

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
  const detail = document.getElementById('error-detail');
  if (detail) detail.textContent = String(err);
  document.getElementById('error-msg').classList.add('visible');
  document.getElementById('loading').style.display = 'none';
});
