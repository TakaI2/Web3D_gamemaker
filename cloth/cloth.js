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
const sphereRadius  = 0.15;
const CLOTH_SPACING = 1.3; // インスタンス間隔 (m)

// ---- Shape params (UI で変更可) ----
const shapeParams = {
  type:         'rect',  // 'rect' | 'trapezoid' | 'semicircle'
  topWidth:     1.0,
  bottomWidth:  1.0,
  height:       1.0,
  pinCount:     7,       // 上端に打つピン数
  topCurve:     0.0,     // 上端曲率: + で中央が前へ（肩フィット）, - で後ろへ
  arcAngle:     180,     // semicircle の中心角（度）: 30〜360
  collar:       false,   // 衿を有効にするか
  collarHeight: 0.2,     // 衿の高さ
  collarFlare:  0.5,     // 衿の広がり係数（0=直筒, 1=ラッパ状）
  collarCurve:  0.0,     // 衿上端の前後カーブ（+ で前方へ, - で後方へ）
};

// ---- Picking constants ----
const GRAB_NONE        = -1;      // grabbedIndexUniform の「掴みなし」値
const GRAB_THRESHOLD_PX = 32;    // スクリーン上の最大ピッキング距離 (px)

// ---- Mutable settings ----
let clothNumSegments = 30;
let instanceCount    = 1;
let simRunning       = true;

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

// ---- Grab state ----
const grab = {
  active:      false,
  instanceIdx: -1,
  vertexIdx:   -1,
  dragPlane:   new THREE.Plane(),
  raycaster:   new THREE.Raycaster(),
  highlightMesh: null,
  // クリック時に1回だけ readback する CPU 座標スナップショット（インスタンス毎）
  snapshots:       [],   // Float32Array[], indexed by instances index
  pendingDown:     false, // pointerdown→readback完了までの保留中フラグ
};

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
  opacity:        0.85,
};

const timer = new THREE.Timer();
timer.connect(document);

// ============================================================
// Per-instance creation / teardown
// ============================================================

/**
 * グリッド上の (xi, yi) → ワールド座標 を返す。
 * yi=0 が上端（ピン行）、yi=segs が下端。
 */
function calcVertexPos(xi, yi, segs, sp) {
  const t = yi / segs; // 0=上端, 1=下端

  // X・Z: 形状に応じて計算
  let posX;
  let posZArcFactor = 1.0; // Z = t * height * posZArcFactor (semicircle のみ変化)

  if (sp.type === 'trapezoid') {
    // 上から下へ topWidth→bottomWidth にリニア補間
    const halfW = (sp.topWidth + (sp.bottomWidth - sp.topWidth) * t) * 0.5;
    posX = (xi / segs) * 2 * halfW - halfW;
  } else if (sp.type === 'semicircle') {
    // 上端は topWidth の直線、下端は arcAngle 度の円弧
    // 両端が Z=0、中央が Z=height となるように正規化する
    const halfArc   = (sp.arcAngle ?? 180) * Math.PI / 180 / 2;
    const angle     = (xi / segs * 2 - 1) * halfArc; // -halfArc 〜 +halfArc
    const cosHalf   = Math.cos(halfArc);
    // (cos(angle) - cos(halfArc)) / (1 - cos(halfArc)) → 両端=0、中央=1
    posZArcFactor   = (Math.cos(angle) - cosHalf) / (1 - cosHalf + 1e-9);
    const straightX = (xi / segs - 0.5) * sp.topWidth;
    const arcX      = Math.sin(angle) * sp.bottomWidth * 0.5;
    posX = straightX + (arcX - straightX) * t;
  } else {
    // rect（デフォルト）
    posX = (xi / segs - 0.5) * sp.topWidth;
  }

  // 上端曲率: nx = -1〜+1 の放物線で Z オフセット、下へ向かいフェードアウト
  const nx          = (xi / segs) * 2 - 1;            // -1(左端) 〜 +1(右端)
  const curveOffset = sp.topCurve * (1 - nx * nx) * (1 - t); // 中央最大・下端0
  const posZ = t * sp.height * posZArcFactor + curveOffset;
  const posY = sp.height * 0.5;
  return { posX, posY, posZ };
}

/**
 * 衿頂点 (xi, collarYi) のワールド座標を返す。
 * collarYi=0 がピン行（マント上端と共有）、collarYi=collarSegs が衿の自由端（上端）。
 */
function calcCollarPos(xi, collarYi, collarSegs, segs, sp) {
  const tc  = collarYi / collarSegs;             // 0=ピン行, 1=衿上端
  const nx  = (xi / segs) * 2 - 1;              // -1(左端) 〜 +1(右端)
  // マント上端の X と同じ基準（t=0 時点）
  const baseX = (xi / segs - 0.5) * sp.topWidth;
  // ラッパ状の広がり: tc が大きいほど外側へ
  const posX  = baseX * (1 + (sp.collarFlare ?? 0) * tc);
  // Y: ピン行から上方へ延伸
  const posY  = sp.height * 0.5 + (sp.collarHeight ?? 0.2) * tc;
  // Z: ピン行の topCurve オフセットから始まり衿上端の collarCurve へ遷移
  const pinZ  = sp.topCurve * (1 - nx * nx);
  const topZ  = (sp.collarCurve ?? 0) * (1 - nx * nx);
  const posZ  = pinZ + (topZ - pinZ) * tc;
  return { posX, posY, posZ };
}

function buildVerletGeometry(segs, sp) {
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

  // ピン位置を均等配置で決定（pinCount 本、両端を含む）
  const pinSet = new Set();
  const pc = Math.max(2, sp.pinCount);
  for (let k = 0; k < pc; k++) {
    const xi = Math.round(k / (pc - 1) * segs);
    pinSet.add(Math.min(xi, segs));
  }

  for (let x = 0; x <= segs; x++) {
    const col = [];
    for (let y = 0; y <= segs; y++) {
      const { posX, posY, posZ } = calcVertexPos(x, y, segs, sp);
      const isFixed = (y === 0) && pinSet.has(x);
      col.push(addVertex(posX, posY, posZ, isFixed));
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

  // ---- 衿 ----
  const collarColumns = [];
  let   collarSegs    = 0;

  if (sp.collar && (sp.collarHeight ?? 0) > 0) {
    collarSegs = 2; // 静的メッシュなので縦2分割で十分

    for (let x = 0; x <= segs; x++) {
      const col = [verletVertexColumns[x][0]]; // ピン行の頂点を共有（cy=0）
      for (let cy = 1; cy <= collarSegs; cy++) {
        const { posX, posY, posZ } = calcCollarPos(x, cy, collarSegs, segs, sp);
        col.push(addVertex(posX, posY, posZ, true)); // 衿は固定（静的メッシュ）
      }
      collarColumns.push(col);
    }

    // スプリング（縦・横・斜め）
    for (let x = 0; x <= segs; x++) {
      for (let cy = 0; cy < collarSegs; cy++) {
        // 縦
        addSpring(collarColumns[x][cy], collarColumns[x][cy + 1]);
        if (x < segs) {
          // 横（cy=0 はメイングリッドで追加済みのためスキップ）
          if (cy + 1 > 0) addSpring(collarColumns[x][cy + 1], collarColumns[x + 1][cy + 1]);
          // 斜め（全 cy で新規）
          addSpring(collarColumns[x][cy],     collarColumns[x + 1][cy + 1]);
          addSpring(collarColumns[x + 1][cy], collarColumns[x][cy + 1]);
        }
      }
    }
  }

  return { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs };
}

function createInstance(segs, offsetX) {
  const { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs } = buildVerletGeometry(segs, shapeParams);

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

  // ---- Per-instance uniforms ----
  const spherePositionUniform  = uniform(new THREE.Vector3(0, 0, 0));
  const grabbedIndexUniform    = uniform(GRAB_NONE);  // float: -1 = no grab
  const grabbedTargetUniform   = uniform(new THREE.Vector3(0, 0, 0)); // local-space target

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

    // 固定頂点はスキップ（固定頂点はグラブも不可）
    If(isFixed, () => { Return(); });

    // ---- グラブ オーバーライド ----
    // float(instanceIndex) と float(grabbedIndexUniform) を比較
    If(float(instanceIndex).equal(float(grabbedIndexUniform)), () => {
      // 速度をゼロにしてターゲット位置へ瞬時移動
      const grabForce = vertexForceBuffer.element(instanceIndex).toVar('grabForce');
      grabForce.mulAssign(0);
      vertexForceBuffer.element(instanceIndex).assign(grabForce);
      vertexPositionBuffer.element(instanceIndex).assign(grabbedTargetUniform);
      Return();
    });

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
  const mantleCells     = segs * segs;
  const collarCells     = collarSegs > 0 ? segs * collarSegs : 0;
  const meshVertexCount = mantleCells + collarCells;
  const clothGeo        = new THREE.BufferGeometry();
  const verletVertIdArr = new Uint32Array(meshVertexCount * 4);
  const indices         = [];
  const getMantleIndex  = (x, y)  => y * segs + x;
  const getCollarIndex  = (x, cy) => mantleCells + cy * segs + x;

  // マント本体セル
  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const idx = getMantleIndex(x, y);
      verletVertIdArr[idx*4]   = verletVertexColumns[x][y].id;
      verletVertIdArr[idx*4+1] = verletVertexColumns[x+1][y].id;
      verletVertIdArr[idx*4+2] = verletVertexColumns[x][y+1].id;
      verletVertIdArr[idx*4+3] = verletVertexColumns[x+1][y+1].id;
      if (x > 0 && y > 0) {
        indices.push(getMantleIndex(x,y), getMantleIndex(x-1,y), getMantleIndex(x-1,y-1));
        indices.push(getMantleIndex(x,y), getMantleIndex(x-1,y-1), getMantleIndex(x,y-1));
      }
    }
  }

  // 衿セル
  for (let x = 0; x < segs; x++) {
    for (let cy = 0; cy < collarSegs; cy++) {
      const idx = getCollarIndex(x, cy);
      verletVertIdArr[idx*4]   = collarColumns[x][cy].id;
      verletVertIdArr[idx*4+1] = collarColumns[x+1][cy].id;
      verletVertIdArr[idx*4+2] = collarColumns[x][cy+1].id;
      verletVertIdArr[idx*4+3] = collarColumns[x+1][cy+1].id;
      if (x > 0) {
        if (cy > 0) {
          // 衿内部の三角形（ワインディング逆）
          indices.push(getCollarIndex(x-1,cy-1), getCollarIndex(x-1,cy), getCollarIndex(x,cy));
          indices.push(getCollarIndex(x,cy-1), getCollarIndex(x-1,cy-1), getCollarIndex(x,cy));
        } else {
          // ピン行境界（ワインディング逆）
          indices.push(getMantleIndex(x-1,0), getCollarIndex(x-1,0), getCollarIndex(x,0));
          indices.push(getMantleIndex(x,0), getMantleIndex(x-1,0), getCollarIndex(x,0));
        }
      }
    }
  }

  clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(meshVertexCount * 3), 3, false));
  clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(verletVertIdArr, 4, false));
  clothGeo.setIndex(indices);

  const clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:           THREE.DoubleSide,
    transparent:    matParams.opacity < 1.0,
    opacity:        matParams.opacity,
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
    grabbedIndexUniform,
    grabbedTargetUniform,
    vertexPositionBuffer,
    vertexParamsCPU:     vertexParamsArr,   // 固定フラグ参照用
    vertexCount,
    cpuPositions:        vertexPosArr.slice(), // GPU→CPU スナップショット（初期値）
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

function clearGrabState() {
  if (grab.active && grab.instanceIdx >= 0 && instances[grab.instanceIdx]) {
    instances[grab.instanceIdx].grabbedIndexUniform.value = GRAB_NONE;
  }
  grab.active      = false;
  grab.pendingDown = false;
  grab.instanceIdx = -1;
  grab.vertexIdx   = -1;
  if (grab.highlightMesh) grab.highlightMesh.visible = false;
  if (controls) controls.enabled = true;
}

function setInstanceCount(n, segs) {
  clearGrabState();
  grab.snapshots.length = 0;

  for (const inst of instances) teardownInstance(inst);
  instances.length = 0;
  timeSinceLastStep = 0;
  timestamp         = 0;

  for (let i = 0; i < n; i++) {
    const offsetX = (i - (n - 1) / 2) * CLOTH_SPACING;
    instances.push(createInstance(segs, offsetX));
    grab.snapshots.push(null);
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
// Grab / Picking
// ============================================================

/**
 * スクリーン座標 (clientX, clientY) に最も近い非固定頂点を探す。
 * @returns {{ instIdx, vertIdx, screenDist }} or null
 */
function pickNearestVertex(clientX, clientY) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  let bestInstIdx  = -1;
  let bestVertIdx  = -1;
  let bestDist     = GRAB_THRESHOLD_PX;

  const projected = new THREE.Vector3();

  for (let ii = 0; ii < instances.length; ii++) {
    const inst     = instances[ii];
    const snapshot = grab.snapshots[ii] ?? inst.cpuPositions;
    const vcnt     = inst.vertexCount;

    for (let vi = 0; vi < vcnt; vi++) {
      // 固定頂点はグラブ対象外
      if (inst.vertexParamsCPU[vi * 3] === 1) continue;

      // ローカル座標 → ワールド座標
      projected.set(
        snapshot[vi * 3    ] + inst.offsetX,
        snapshot[vi * 3 + 1],
        snapshot[vi * 3 + 2],
      );

      // ワールド座標 → NDC → スクリーン座標
      projected.project(camera);
      if (projected.z > 1) continue; // カメラ背後

      const sx = (projected.x *  0.5 + 0.5) * w;
      const sy = (projected.y * -0.5 + 0.5) * h;
      const d  = Math.hypot(sx - clientX, sy - clientY);

      if (d < bestDist) {
        bestDist     = d;
        bestInstIdx  = ii;
        bestVertIdx  = vi;
      }
    }
  }

  if (bestInstIdx === -1) return null;
  return { instIdx: bestInstIdx, vertIdx: bestVertIdx };
}

function buildDragPlane(worldPos) {
  // ドラッグ平面：カメラ→頂点方向を法線とし、頂点を通る平面
  const normal = worldPos.clone().sub(camera.position).normalize();
  grab.dragPlane.setFromNormalAndCoplanarPoint(normal, worldPos);
}

function applyGrabTarget(clientX, clientY) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  grab.raycaster.setFromCamera(
    { x: (clientX / w) * 2 - 1, y: -(clientY / h) * 2 + 1 },
    camera,
  );

  const hitPoint = new THREE.Vector3();
  if (!grab.raycaster.ray.intersectPlane(grab.dragPlane, hitPoint)) return;

  const inst = instances[grab.instanceIdx];
  // ワールド座標 → クロスのローカル座標（offsetX を引く）
  inst.grabbedTargetUniform.value.set(
    hitPoint.x - inst.offsetX,
    hitPoint.y,
    hitPoint.z,
  );

  // ハイライトをワールド座標で追従
  grab.highlightMesh.position.copy(hitPoint);
}

function setupGrabEvents(canvas) {
  // キャプチャフェーズで受け取ることで OrbitControls より先に実行
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!simRunning || grab.active || grab.pendingDown) return;
    if (instances.length === 0) return;

    // クリック時に全インスタンスの最新頂点座標を1回だけ readback
    // → 揺れている布でも見た目どおりに掴める（OrbitControls 判定はその後に確定）
    const { clientX, clientY, pointerId } = e;
    grab.pendingDown = true;

    Promise.all(instances.map(inst =>
      renderer.getArrayBufferAsync(inst.vertexPositionBuffer.value)
        .then(ab => new Float32Array(ab))
        .catch(() => null)
    )).then((bufs) => {
      // readback待ちの間に pointerup された場合は中止
      if (!grab.pendingDown || !simRunning) { grab.pendingDown = false; return; }
      grab.pendingDown = false;

      for (let i = 0; i < instances.length; i++) {
        if (bufs[i]) { grab.snapshots[i] = bufs[i]; instances[i].cpuPositions = bufs[i]; }
      }

      const hit = pickNearestVertex(clientX, clientY);
      if (!hit) return; // 布の近くでないクリックは何もしない（OrbitControls は既にこのpointerを開始済み）

      controls.enabled = false;
      grab.active      = true;
      grab.instanceIdx = hit.instIdx;
      grab.vertexIdx   = hit.vertIdx;

      const inst     = instances[hit.instIdx];
      const snapshot = grab.snapshots[hit.instIdx] ?? inst.cpuPositions;
      const wx = snapshot[hit.vertIdx * 3    ] + inst.offsetX;
      const wy = snapshot[hit.vertIdx * 3 + 1];
      const wz = snapshot[hit.vertIdx * 3 + 2];

      buildDragPlane(new THREE.Vector3(wx, wy, wz));
      inst.grabbedIndexUniform.value = hit.vertIdx;

      // ハイライト表示
      grab.highlightMesh.position.set(wx, wy, wz);
      grab.highlightMesh.visible = true;

      applyGrabTarget(clientX, clientY);

      // キャンバス外でも pointermove/pointerup を受け取る
      canvas.setPointerCapture(pointerId);
      canvas.style.cursor = 'grabbing';
    });
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!grab.active) return;
    applyGrabTarget(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerup', (e) => {
    grab.pendingDown = false;
    if (!grab.active) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    clearGrabState();
    canvas.style.cursor = '';
  });

  canvas.addEventListener('pointercancel', () => {
    grab.pendingDown = false;
    if (!grab.active) return;
    clearGrabState();
    canvas.style.cursor = '';
  });
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

  const matOpacity    = document.getElementById('mat-opacity');
  const matOpacityVal = document.getElementById('mat-opacity-val');
  matOpacity.addEventListener('input', () => {
    const v = parseFloat(matOpacity.value);
    matParams.opacity = v;
    matOpacityVal.textContent = v.toFixed(2);
    for (const inst of instances) {
      inst.clothMat.opacity      = v;
      inst.clothMat.transparent  = v < 1.0;
      inst.clothMat.needsUpdate  = true;
    }
  });

  // Shape
  const shapeSelect = document.getElementById('shape-type');
  shapeSelect.addEventListener('change', () => {
    shapeParams.type = shapeSelect.value;
    _updateShapeVisibility();
    setInstanceCount(instanceCount, clothNumSegments);
  });

  const bindShape = (id, valId, key, parse, fmt, isRange = true) => {
    const el = document.getElementById(id);
    const vl = document.getElementById(valId);
    el.addEventListener('input', () => {
      const v = parse(el.value);
      if (vl) vl.textContent = fmt(v);
      shapeParams[key] = v;
      clearTimeout(el._t);
      el._t = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 300);
    });
  };
  bindShape('shape-top-width',    'shape-top-width-val',    'topWidth',    parseFloat, v => v.toFixed(2));
  bindShape('shape-bottom-width', 'shape-bottom-width-val', 'bottomWidth', parseFloat, v => v.toFixed(2));
  bindShape('shape-height',       'shape-height-val',       'height',      parseFloat, v => v.toFixed(2));
  bindShape('shape-pin-count',    'shape-pin-count-val',    'pinCount',    parseInt,   v => String(v));
  bindShape('shape-top-curve',    'shape-top-curve-val',    'topCurve',    parseFloat, v => v.toFixed(2));
  bindShape('shape-arc-angle',    'shape-arc-angle-val',    'arcAngle',    parseInt,   v => `${v}°`);

  // 衿パラメータ
  const collarCheckbox = document.getElementById('collar-enable');
  collarCheckbox.addEventListener('change', () => {
    shapeParams.collar = collarCheckbox.checked;
    _updateCollarVisibility();
    setInstanceCount(instanceCount, clothNumSegments);
  });
  bindShape('collar-height', 'collar-height-val', 'collarHeight', parseFloat, v => v.toFixed(2));
  bindShape('collar-flare',  'collar-flare-val',  'collarFlare',  parseFloat, v => v.toFixed(2));
  bindShape('collar-curve',  'collar-curve-val',  'collarCurve',  parseFloat, v => v.toFixed(2));

  function _updateCollarVisibility() {
    const show = shapeParams.collar;
    document.getElementById('collar-sliders').style.display = show ? 'flex' : 'none';
  }
  _updateCollarVisibility();

  function _updateShapeVisibility() {
    const isTrap = shapeParams.type === 'trapezoid';
    const isSemi = shapeParams.type === 'semicircle';
    document.getElementById('row-bottom-width').style.display =
      (isTrap || isSemi) ? '' : 'none';
    document.getElementById('row-arc-angle').style.display =
      isSemi ? '' : 'none';
  }
  _updateShapeVisibility();

  // シミュ停止 / リセット
  const btnStop  = document.getElementById('btn-sim-stop');
  const btnReset = document.getElementById('btn-sim-reset');
  btnStop.addEventListener('click', () => {
    simRunning = !simRunning;
    btnStop.textContent  = simRunning ? '⏹ 停止' : '▶ 再開';
    btnStop.style.color  = simRunning ? '#ebb' : '#9eb';
  });
  btnReset.addEventListener('click', () => {
    setInstanceCount(instanceCount, clothNumSegments);
    // 停止状態は維持（simRunning を変えない）
    if (!simRunning) {
      btnStop.textContent = '▶ 再開';
      btnStop.style.color = '#9eb';
    }
  });

  // マント出力
  document.getElementById('btn-export-mantle').addEventListener('click', exportMantle);

  // セクション折りたたみ
  for (const id of ['mat-toggle', 'mesh-toggle', 'shape-toggle', 'collar-toggle']) {
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
// Mantle export
// ============================================================
function exportMantle() {
  const segs = clothNumSegments;
  const { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs } = buildVerletGeometry(segs, shapeParams);

  const vertexCount   = verletVertices.length;
  const positions     = [];
  const pinnedIndices = [];

  for (let i = 0; i < vertexCount; i++) {
    const v = verletVertices[i];
    positions.push(v.position.x, v.position.y, v.position.z);
    if (v.isFixed) pinnedIndices.push(i);
  }

  const springs = [];
  for (const s of verletSprings) springs.push(s.vertex0.id, s.vertex1.id);

  // グリッドからトライアングルインデックスを生成
  const indices = [];
  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const v00 = verletVertexColumns[x][y].id;
      const v10 = verletVertexColumns[x + 1][y].id;
      const v01 = verletVertexColumns[x][y + 1].id;
      const v11 = verletVertexColumns[x + 1][y + 1].id;
      indices.push(v00, v10, v01);
      indices.push(v10, v11, v01);
    }
  }
  // 衿のトライアングルインデックス（ワインディング逆）
  for (let x = 0; x < segs; x++) {
    for (let cy = 0; cy < collarSegs; cy++) {
      const v00 = collarColumns[x][cy].id;
      const v10 = collarColumns[x + 1][cy].id;
      const v01 = collarColumns[x][cy + 1].id;
      const v11 = collarColumns[x + 1][cy + 1].id;
      indices.push(v01, v10, v00);
      indices.push(v01, v11, v10);
    }
  }

  // Quad レンダーメッシュ（/cloth の createInstance と同一構造）
  const mantleCells       = segs * segs;
  const collarCells       = collarSegs > 0 ? segs * collarSegs : 0;
  const renderVertexCount = mantleCells + collarCells;
  const quadVertexIds     = new Array(renderVertexCount * 4);
  const renderIndices     = [];
  const getMantleRIdx = (x, y)  => y * segs + x;
  const getCollarRIdx = (x, cy) => mantleCells + cy * segs + x;

  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const idx = getMantleRIdx(x, y);
      quadVertexIds[idx*4]   = verletVertexColumns[x][y].id;
      quadVertexIds[idx*4+1] = verletVertexColumns[x+1][y].id;
      quadVertexIds[idx*4+2] = verletVertexColumns[x][y+1].id;
      quadVertexIds[idx*4+3] = verletVertexColumns[x+1][y+1].id;
      if (x > 0 && y > 0) {
        renderIndices.push(getMantleRIdx(x,y), getMantleRIdx(x-1,y), getMantleRIdx(x-1,y-1));
        renderIndices.push(getMantleRIdx(x,y), getMantleRIdx(x-1,y-1), getMantleRIdx(x,y-1));
      }
    }
  }
  if (collarSegs > 0) {
    for (let x = 0; x < segs; x++) {
      for (let cy = 0; cy < collarSegs; cy++) {
        const idx = getCollarRIdx(x, cy);
        quadVertexIds[idx*4]   = collarColumns[x][cy].id;
        quadVertexIds[idx*4+1] = collarColumns[x+1][cy].id;
        quadVertexIds[idx*4+2] = collarColumns[x][cy+1].id;
        quadVertexIds[idx*4+3] = collarColumns[x+1][cy+1].id;
        if (x > 0) {
          if (cy > 0) {
            renderIndices.push(getCollarRIdx(x-1,cy-1), getCollarRIdx(x-1,cy), getCollarRIdx(x,cy));
            renderIndices.push(getCollarRIdx(x,cy-1), getCollarRIdx(x-1,cy-1), getCollarRIdx(x,cy));
          } else {
            renderIndices.push(getMantleRIdx(x-1,0), getCollarRIdx(x-1,0), getCollarRIdx(x,0));
            renderIndices.push(getMantleRIdx(x,0), getMantleRIdx(x-1,0), getCollarRIdx(x,0));
          }
        }
      }
    }
  }

  const data = {
    version:      1,
    shapeParams:  { ...shapeParams },
    segments:     segs,
    vertexCount,
    positions,
    springs,
    pinnedIndices,
    indices,
    renderVertexCount,
    quadVertexIds,
    renderIndices,
    material: {
      colorFront:     matParams.colorFront,
      colorBack:      matParams.colorBack,
      roughness:      matParams.roughness,
      sheen:          matParams.sheen,
      sheenRoughness: matParams.sheenRoughness,
      sheenColor:     matParams.sheenColor,
      opacity:        matParams.opacity,
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'mantle.cloth.json';
  a.click();
  URL.revokeObjectURL(url);
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

/**
 * GPU バッファ → CPU スナップショットの非同期リードバック（ピッキング用）
 * グラブ中はスキップして競合を防ぐ
 */
async function render() {
  timer.update();
  updateFPS();

  sphereVisibleUniform.value = params.sphere ? 1 : 0;
  windUniform.value          = params.wind;

  const deltaTime   = Math.min(timer.getDelta(), 1 / 60);
  const stepsPerSec = 360;
  const timePerStep = 1 / stepsPerSec;

  if (simRunning) {
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

  // ---- グラブ ハイライト (グラブ中に掴んでいる頂点を表示) ----
  grab.highlightMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.028, 10, 10),
    new THREE.MeshBasicMaterial({
      color:       0xffee00,
      depthTest:   false,
      transparent: true,
      opacity:     0.9,
    }),
  );
  grab.highlightMesh.visible     = false;
  grab.highlightMesh.renderOrder = 999;
  scene.add(grab.highlightMesh);

  // ---- OrbitControls（グラブイベントより後に登録して優先度を下げる）----
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
  setupGrabEvents(renderer.domElement);

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
