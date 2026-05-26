// cloth-editor.js — VRMメッシュを布シミュレーションに変換するエディタ
// Three.js v0.184 WebGPU + TSL + @pixiv/three-vrm

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float, vec3,
  triNoise3D, time, frontFacing,
} from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }    from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';

// ── 定数 ─────────────────────────────────────────────────────
const GRAB_NONE           = -1;
const GRAB_THRESHOLD_PX   = 22;
const PIN_THRESHOLD_PX    = 25;
const MARKER_RADIUS       = 0.005;
const MAX_VERTICES_WARN   = 2000;

// ── シーングローバル ──────────────────────────────────────────
let renderer, scene, camera, controls;
const timer = new THREE.Timer();

// ── VRM 状態 ──────────────────────────────────────────────────
let currentVRM       = null;
let currentMeshes    = [];   // { name, mesh }[]
let selectedMeshIdx  = -1;
let analysisData     = null; // analyzeMesh() の結果
let originalPositions = null; // リセット用バックアップ

// ── ピン状態 ──────────────────────────────────────────────────
let pinMode    = false;
const pinnedSet  = new Set();
const markerMeshes = [];
let markerGroup  = null;

// ── シミュレーション状態 ──────────────────────────────────────
let simRunning = false;
let simData    = null;

// ── マント状態 ────────────────────────────────────────────────
let mantleData    = null;   // ロードした JSON
let mantleOrigPos = null;   // 変換前の元座標 Float32Array
const mantleTransform = { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 };

// ── 共有 uniform ──────────────────────────────────────────────
let stiffnessUniform;
let dampeningUniform;
let windUniform;

// ── コライダー（球）────────────────────────────────────────────
const MAX_COLLIDERS = 8;
// colliders[i] = { x, y, z, r, visible: bool, helperMesh }
const colliders = [];
// GPU へ渡す Float32Array: [x,y,z,r, x,y,z,r, ...]  MAX_COLLIDERS 個
const colliderDataArr = new Float32Array(MAX_COLLIDERS * 4);
let   colliderCountUniform = null;  // buildSimulation 後に使用可
let   colliderDataBuffer   = null;  // instancedArray

// ── グリップ状態 ──────────────────────────────────────────────
const leftGripSet  = new Set();  // 左手でつかめる頂点インデックス
const rightGripSet = new Set();  // 右手でつかめる頂点インデックス
let gripEditMode   = null;        // 'left' | 'right' | null

// ── グラブ状態 ────────────────────────────────────────────────
const grab = {
  active:          false,
  vertexIdx:       -1,
  dragPlane:       new THREE.Plane(),
  raycaster:       new THREE.Raycaster(),
  highlightMesh:   null,
  snapshot:        null,
  snapshotPending: false,
  snapshotAge:     999,
};

// ── FPS カウンター ────────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ============================================================
// VRM Loader
// ============================================================

async function loadVRM(file) {
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));

  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm  = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');

    unloadVRM();
    currentVRM = vrm;

    // ShaderMaterial (MToon v0) を MeshPhysicalNodeMaterial に変換してから追加
    // → WebGPU NodeBuilder との互換性確保
    vrm.scene.traverse(obj => {
      if (!obj.isMesh && !obj.isSkinnedMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const converted = mats.map(m => {
        if (!m || m.isNodeMaterial) return m;
        const nm = new THREE.MeshPhysicalNodeMaterial({
          side:        m.side        ?? THREE.FrontSide,
          transparent: m.transparent ?? false,
          opacity:     m.opacity     ?? 1.0,
          roughness:   0.85,
          alphaTest:   m.alphaTest   ?? 0,
        });
        if (m.map)            nm.map            = m.map;
        if (m.color)          nm.color.copy(m.color);
        if (m.normalMap)      nm.normalMap      = m.normalMap;
        if (m.emissiveMap)    nm.emissiveMap    = m.emissiveMap;
        if (m.emissive)       nm.emissive.copy(m.emissive);
        m.dispose();
        return nm;
      });
      obj.material = Array.isArray(obj.material) ? converted : converted[0];
    });

    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    currentMeshes = [];
    vrm.scene.traverse(obj => {
      if ((obj.isSkinnedMesh || obj.isMesh) && obj.geometry) {
        currentMeshes.push({ name: obj.name || `Mesh_${currentMeshes.length}`, mesh: obj });
      }
    });

    buildCollidersFromVRM(vrm);

    return currentMeshes;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function unloadVRM() {
  if (!currentVRM) return;
  if (simRunning) stopSim();
  disposeSimulation();
  disposeMarkers();

  scene.remove(currentVRM.scene);
  currentVRM.scene.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose();
    }
  });

  clearColliders();
  currentVRM        = null;
  currentMeshes     = [];
  selectedMeshIdx   = -1;
  analysisData      = null;
  originalPositions = null;
}

// ============================================================
// Collider Manager
// ============================================================

// VRM ボーン名 → { radius } の定義（半身中心部のみ）
const BONE_COLLIDER_DEFS = [
  { bone: 'head',          r: 0.10 },
  { bone: 'neck',          r: 0.06 },
  { bone: 'chest',         r: 0.14 },
  { bone: 'spine',         r: 0.12 },
  { bone: 'hips',          r: 0.13 },
  { bone: 'leftShoulder',  r: 0.07 },
  { bone: 'rightShoulder', r: 0.07 },
  { bone: 'upperChest',    r: 0.13 },
];

function buildCollidersFromVRM(vrm) {
  clearColliders();
  const tmp = new THREE.Vector3();
  for (const def of BONE_COLLIDER_DEFS) {
    const node = vrm.humanoid?.getNormalizedBoneNode(def.bone);
    if (!node) continue;
    node.getWorldPosition(tmp);
    addCollider(tmp.x, tmp.y, tmp.z, def.r);
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  updateColliderUI();
  syncColliderDataArr();
}

function addCollider(x, y, z, r) {
  const geo  = new THREE.SphereGeometry(1, 12, 8);
  const mat  = new THREE.MeshBasicMaterial({
    color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.35,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(r);
  mesh.renderOrder = 5;
  scene.add(mesh);
  colliders.push({ x, y, z, r, helperMesh: mesh });
}

function clearColliders() {
  for (const c of colliders) {
    scene.remove(c.helperMesh);
    c.helperMesh.geometry.dispose();
    c.helperMesh.material.dispose();
  }
  colliders.length = 0;
}

function syncColliderDataArr() {
  colliderDataArr.fill(0);
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    colliderDataArr[i*4]     = c.x;
    colliderDataArr[i*4 + 1] = c.y;
    colliderDataArr[i*4 + 2] = c.z;
    colliderDataArr[i*4 + 3] = c.r;
  }
  // GPU バッファへ書き戻し（シミュ実行中も即反映）
  if (colliderDataBuffer) {
    colliderDataBuffer.value.array.set(colliderDataArr);
    colliderDataBuffer.value.needsUpdate = true;
  }
  if (colliderCountUniform) colliderCountUniform.value = colliders.length;
}

function updateColliderHelper(idx) {
  const c = colliders[idx];
  if (!c) return;
  c.helperMesh.position.set(c.x, c.y, c.z);
  c.helperMesh.scale.setScalar(c.r);
}

function setCollidersVisible(show) {
  for (const c of colliders) c.helperMesh.visible = show;
}

// UI の「コライダー一覧」を動的に再生成
function updateColliderUI() {
  const list = document.getElementById('collider-list');
  if (!list) return;
  list.innerHTML = '';
  colliders.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'collider-row';
    row.innerHTML = `
      <span class="c-label">球${i + 1}</span>
      <label style="font-size:10px;color:#888;">X</label>
      <input type="number" class="c-input" data-idx="${i}" data-key="x" value="${c.x.toFixed(3)}" step="0.01">
      <label style="font-size:10px;color:#888;">Y</label>
      <input type="number" class="c-input" data-idx="${i}" data-key="y" value="${c.y.toFixed(3)}" step="0.01">
      <label style="font-size:10px;color:#888;">Z</label>
      <input type="number" class="c-input" data-idx="${i}" data-key="z" value="${c.z.toFixed(3)}" step="0.01">
      <label style="font-size:10px;color:#888;">R</label>
      <input type="number" class="c-input" data-idx="${i}" data-key="r" value="${c.r.toFixed(3)}" step="0.005" min="0.01">
    `;
    list.appendChild(row);
  });
  // イベント委任
  list.addEventListener('change', e => {
    const el = e.target;
    if (!el.classList.contains('c-input')) return;
    const idx = parseInt(el.dataset.idx);
    const key = el.dataset.key;
    colliders[idx][key] = parseFloat(el.value);
    updateColliderHelper(idx);
    syncColliderDataArr();
  });
}

// ============================================================
// Mesh Analyzer
// ============================================================

function analyzeMesh(skinnedMesh) {
  const geo = skinnedMesh.geometry;
  if (!geo.index) return { error: 'インデックスなしメッシュは非対応です' };

  skinnedMesh.updateMatrixWorld(true);
  const mat4      = skinnedMesh.matrixWorld;
  const posAttr   = geo.attributes.position;
  const vertexCount = posAttr.count;

  const positions = new Float32Array(vertexCount * 3);
  const tmpV = new THREE.Vector3();
  for (let i = 0; i < vertexCount; i++) {
    tmpV.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    tmpV.applyMatrix4(mat4);
    positions[i * 3]     = tmpV.x;
    positions[i * 3 + 1] = tmpV.y;
    positions[i * 3 + 2] = tmpV.z;
  }

  // トライアングルエッジ → スプリング（重複除去）
  const idxArr  = geo.index.array;
  const edgeSet = new Set();
  const springs = [];

  for (let i = 0; i < idxArr.length; i += 3) {
    const a = idxArr[i], b = idxArr[i + 1], c = idxArr[i + 2];
    for (const [v0, v1] of [[a, b], [b, c], [a, c]]) {
      const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        springs.push(v0, v1);
      }
    }
  }

  const springCount = springs.length / 2;
  const warning = vertexCount > MAX_VERTICES_WARN
    ? `頂点数が多いです（${vertexCount}頂点）。動作が重くなる場合があります。`
    : null;

  return { positions, vertexCount, springs, springCount, mesh: skinnedMesh, warning };
}

// ============================================================
// Mantle Loader
// ============================================================

function applyMantleTransform(origPos, vertexCount, tr) {
  const out  = new Float32Array(vertexCount * 3);
  const cosY = Math.cos(tr.ry * Math.PI / 180);
  const sinY = Math.sin(tr.ry * Math.PI / 180);
  for (let i = 0; i < vertexCount; i++) {
    const x = origPos[i*3]     * tr.scale;
    const y = origPos[i*3 + 1] * tr.scale;
    const z = origPos[i*3 + 2] * tr.scale;
    out[i*3]     = x * cosY - z * sinY + tr.tx;
    out[i*3 + 1] = y + tr.ty;
    out[i*3 + 2] = x * sinY + z * cosY + tr.tz;
  }
  return out;
}

function loadMantleJSON(json) {
  if (json.version !== 1 || !json.positions || !json.springs || !json.indices) {
    throw new Error('無効なマントファイルです');
  }
  if (simRunning) stopSim();
  disposeSimulation();
  disposeMarkers();
  pinnedSet.clear();

  // VRMメッシュ選択を解除
  selectedMeshIdx = -1;
  analysisData    = null;
  updateMeshList();

  mantleData    = json;
  mantleOrigPos = new Float32Array(json.positions);

  // ピン・グリップをJSONから復元
  for (const idx of json.pinnedIndices) pinnedSet.add(idx);
  leftGripSet.clear(); rightGripSet.clear();
  if (json.leftGripIndices)  for (const idx of json.leftGripIndices)  leftGripSet.add(idx);
  if (json.rightGripIndices) for (const idx of json.rightGripIndices) rightGripSet.add(idx);

  // 初期変換を適用してマーカー表示（initMarkers内で全マーカーvisualを更新）
  const transformed = applyMantleTransform(mantleOrigPos, json.vertexCount, mantleTransform);
  initMarkers(transformed, json.vertexCount);

  document.getElementById('mantle-transform-section').style.display = '';
  document.getElementById('mantle-export-section').style.display   = '';
  document.getElementById('btn-mantle-clear').style.display = '';
  showToast(`マント読み込み完了 (${json.vertexCount}頂点)`);
}

function clearMantle() {
  if (simRunning) stopSim();
  disposeSimulation();
  disposeMarkers();
  pinnedSet.clear();
  leftGripSet.clear();
  rightGripSet.clear();
  mantleData    = null;
  mantleOrigPos = null;
  mantleTransform.tx = 0; mantleTransform.ty = 0; mantleTransform.tz = 0;
  mantleTransform.ry = 0; mantleTransform.scale = 1.0;
  _resetMantleSliders();
  document.getElementById('mantle-transform-section').style.display = 'none';
  document.getElementById('mantle-export-section').style.display   = 'none';
  document.getElementById('btn-mantle-clear').style.display = 'none';
  showToast('マントを削除しました');
}

function _resetMantleSliders() {
  for (const [id, val] of [
    ['mt-tx', '0'], ['mt-ty', '0'], ['mt-tz', '0'], ['mt-ry', '0'], ['mt-scale', '1'],
  ]) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
  document.getElementById('mt-tx-val').textContent    = '0.00';
  document.getElementById('mt-ty-val').textContent    = '0.00';
  document.getElementById('mt-tz-val').textContent    = '0.00';
  document.getElementById('mt-ry-val').textContent    = '0°';
  document.getElementById('mt-scale-val').textContent = '1.00';
}

function updateMantleMarkers() {
  if (!mantleData || !mantleOrigPos || markerMeshes.length === 0) return;
  const transformed = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
  for (let i = 0; i < mantleData.vertexCount; i++) {
    markerMeshes[i].position.set(
      transformed[i*3], transformed[i*3+1], transformed[i*3+2],
    );
  }
}

// ============================================================
// Pin Manager
// ============================================================

function initMarkers(positions, vertexCount) {
  disposeMarkers();

  markerGroup = new THREE.Group();
  scene.add(markerGroup);

  const sharedGeo = new THREE.SphereGeometry(MARKER_RADIUS, 6, 6);
  markerGroup.userData.sharedGeo = sharedGeo;

  for (let i = 0; i < vertexCount; i++) {
    const mat  = new THREE.MeshBasicMaterial({
      color:       0xffffff,
      transparent: true,
      opacity:     0.4,
      depthTest:   false,
    });
    const mesh = new THREE.Mesh(sharedGeo, mat);
    mesh.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    mesh.frustumCulled = false;
    mesh.renderOrder   = 10;
    markerMeshes.push(mesh);
    markerGroup.add(mesh);
  }

  // 既存ピン・グリップを反映
  for (let i = 0; i < vertexCount; i++) _updateMarkerVisual(i);
}

// ピン・グリップ状態に応じてマーカーの見た目を更新（優先度: ピン > L手 > R手 > 通常）
function _updateMarkerVisual(idx) {
  if (idx < 0 || idx >= markerMeshes.length) return;
  const mat = markerMeshes[idx].material;
  if (pinnedSet.has(idx)) {
    mat.color.set(0xffee00); mat.opacity = 1.0; mat.transparent = false;
    markerMeshes[idx].scale.setScalar(1.6);
  } else if (leftGripSet.has(idx)) {
    mat.color.set(0x44aaff); mat.opacity = 1.0; mat.transparent = false;
    markerMeshes[idx].scale.setScalar(1.4);
  } else if (rightGripSet.has(idx)) {
    mat.color.set(0xff6644); mat.opacity = 1.0; mat.transparent = false;
    markerMeshes[idx].scale.setScalar(1.4);
  } else {
    mat.color.set(0xffffff); mat.opacity = 0.4; mat.transparent = true;
    markerMeshes[idx].scale.setScalar(1.0);
  }
  mat.needsUpdate = true;
}

function togglePin(idx) {
  if (pinnedSet.has(idx)) {
    pinnedSet.delete(idx);
  } else {
    pinnedSet.add(idx);
  }
  _updateMarkerVisual(idx);
}

function resetPins() {
  pinnedSet.clear();
  for (let i = 0; i < markerMeshes.length; i++) _updateMarkerVisual(i);
}

function toggleGrip(idx, side) {
  if (side === 'left') {
    if (leftGripSet.has(idx)) {
      leftGripSet.delete(idx);
    } else {
      leftGripSet.add(idx);
      rightGripSet.delete(idx); // 同じ頂点を両手に割り当て不可
    }
  } else {
    if (rightGripSet.has(idx)) {
      rightGripSet.delete(idx);
    } else {
      rightGripSet.add(idx);
      leftGripSet.delete(idx);
    }
  }
  _updateMarkerVisual(idx);
}

function resetGrips() {
  leftGripSet.clear();
  rightGripSet.clear();
  for (let i = 0; i < markerMeshes.length; i++) _updateMarkerVisual(i);
}

function disposeMarkers() {
  if (!markerGroup) return;
  scene.remove(markerGroup);
  markerGroup.userData.sharedGeo?.dispose();
  for (const m of markerMeshes) m.material.dispose();
  markerMeshes.length = 0;
  markerGroup = null;
}

// ============================================================
// Cloth Simulator
// ============================================================

function buildSimulation(analysis) {
  const { positions, vertexCount, springs, springCount, mesh: srcMesh } = analysis;

  // 各頂点のスプリングIDリストを構築
  const vertexSpringIds = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) {
    vertexSpringIds[springs[s * 2]    ].push(s);
    vertexSpringIds[springs[s * 2 + 1]].push(s);
  }

  // vertexParams: [isFixed, springCount, springPointer, gripCode]
  // gripCode: 0=なし, 1=左手グリップ, 2=右手グリップ
  const springListArray = [];
  const vertexParamsArr = new Uint32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    const isFixed = pinnedSet.has(i) ? 1 : 0;
    vertexParamsArr[i * 4]     = isFixed;
    vertexParamsArr[i * 4 + 3] = leftGripSet.has(i) ? 1 : rightGripSet.has(i) ? 2 : 0;
    if (!isFixed) {
      vertexParamsArr[i * 4 + 1] = vertexSpringIds[i].length;
      vertexParamsArr[i * 4 + 2] = springListArray.length;
      for (const sid of vertexSpringIds[i]) springListArray.push(sid);
    }
  }

  // スプリングバッファ
  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);

  for (let s = 0; s < springCount; s++) {
    const v0 = springs[s * 2], v1 = springs[s * 2 + 1];
    springVertIdArr[s * 2]     = v0;
    springVertIdArr[s * 2 + 1] = v1;
    const dx = positions[v0*3]   - positions[v1*3];
    const dy = positions[v0*3+1] - positions[v1*3+1];
    const dz = positions[v0*3+2] - positions[v1*3+2];
    springRestLenArr[s] = Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  // ── GPU バッファ ──
  const vertexPositionBuffer   = instancedArray(positions.slice(), 'vec3').setPBO(true);
  const vertexForceBuffer      = instancedArray(vertexCount, 'vec3');
  const vertexParamsBuffer     = instancedArray(vertexParamsArr, 'uvec4');
  const springListBuffer       = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true);
  const springVertexIdBuffer   = instancedArray(springVertIdArr, 'uvec2').setPBO(true);
  const springRestLengthBuffer = instancedArray(springRestLenArr, 'float');
  const springForceBuffer      = instancedArray(springCount * 3, 'vec3').setPBO(true);

  const grabbedIndexUniform  = uniform(GRAB_NONE);
  const grabbedTargetUniform = uniform(new THREE.Vector3());

  // ── コライダーバッファ（最大 MAX_COLLIDERS 球、各 vec4 = xyzr）──
  syncColliderDataArr();
  colliderDataBuffer   = instancedArray(colliderDataArr.slice(), 'vec4');
  colliderCountUniform = uniform(colliders.length);

  // ── グリップ uniform（マスクはvertexParamsの.wに格納済み）──
  const leftGripActiveUniform  = uniform(0);   // 1=アクティブ, 0=非アクティブ
  const rightGripActiveUniform = uniform(0);
  const leftGripTargetUniform  = uniform(new THREE.Vector3());
  const rightGripTargetUniform = uniform(new THREE.Vector3());

  // ── Compute: スプリング力 ──
  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('CE_Spring');

  // ── Compute: 頂点力（重力・風・グラブ） ──
  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;
    const gripCode      = vparams.w;  // 0=なし, 1=左手グリップ, 2=右手グリップ

    If(isFixed, () => { Return(); });

    // グラブオーバーライド（マウスによる単一頂点グラブ）
    If(float(instanceIndex).equal(float(grabbedIndexUniform)), () => {
      const gf = vertexForceBuffer.element(instanceIndex).toVar('gf');
      gf.mulAssign(0);
      vertexForceBuffer.element(instanceIndex).assign(gf);
      vertexPositionBuffer.element(instanceIndex).assign(grabbedTargetUniform);
      Return();
    });

    // 左手グリップオーバーライド（gripCode==1 かつアクティブ時）
    If(leftGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(1), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(leftGripTargetUniform);
        Return();
      });
    });

    // 右手グリップオーバーライド（gripCode==2 かつアクティブ時）
    If(rightGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(2), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(rightGripTargetUniform);
        Return();
      });
    });

    const position = vertexPositionBuffer.element(instanceIndex).toVar('pos');
    const force    = vertexForceBuffer.element(instanceIndex).toVar('force');

    force.mulAssign(dampeningUniform);

    const ptrStart = springPointer.toVar('ps');
    const ptrEnd   = ptrStart.add(springCnt).toVar('pe');

    Loop({ start: ptrStart, end: ptrEnd, type: 'uint', condition: '<' }, ({ i }) => {
      const sid    = springListBuffer.element(i).toVar('sid');
      const sf     = springForceBuffer.element(sid);
      const svids  = springVertexIdBuffer.element(sid);
      const factor = select(svids.x.equal(instanceIndex), 1.0, -1.0);
      force.addAssign(sf.mul(factor));
    });

    // 重力
    force.y.subAssign(0.00005);

    // 風（ノイズベース）
    const noise     = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    const windForce = noise.mul(windUniform);
    force.z.subAssign(windForce);

    // 球コライダー衝突
    Loop({ start: 0, end: colliderCountUniform, type: 'int', condition: '<' }, ({ i }) => {
      const col      = colliderDataBuffer.element(i).toVar('col');
      const colPos   = col.xyz.toVar('colPos');
      const colR     = col.w.toVar('colR');
      const toVertex = position.add(force).sub(colPos).toVar('toVtx');
      const dist     = toVertex.length().toVar('cvDist');
      const penetration = colR.sub(dist);
      If(penetration.greaterThan(0.0), () => {
        const pushDir = toVertex.div(dist.max(0.0001));
        force.addAssign(pushDir.mul(penetration).mul(1.2));
      });
    });

    vertexForceBuffer.element(instanceIndex).assign(force);
    vertexPositionBuffer.element(instanceIndex).addAssign(force);
  })().compute(vertexCount).setName('CE_Vertex');

  // ── 布メッシュ ──
  const posNode = Fn(() =>
    vertexPositionBuffer.element(attribute('vertexId', 'uint'))
  )();

  const vidArr = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vidArr[i] = i;

  let clothGeo, clothMat;

  if (srcMesh) {
    // VRM メッシュモード: 元 geometry をクローン
    clothGeo = srcMesh.geometry.clone();
    clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));

    const srcMats = Array.isArray(srcMesh.material) ? srcMesh.material : [srcMesh.material];
    const clothMats = srcMats.map(m => {
      let mat;
      if (m.isNodeMaterial) {
        mat = m.clone();
      } else {
        mat = new THREE.MeshPhysicalNodeMaterial({
          side: THREE.DoubleSide, transparent: m.transparent ?? false,
          opacity: m.opacity ?? 1.0, roughness: 0.85,
        });
        if (m.map)   mat.map   = m.map;
        if (m.color) mat.color.copy(m.color);
      }
      mat.positionNode = posNode;
      return mat;
    });
    clothMat = clothMats.length === 1 ? clothMats[0] : clothMats;
  } else {
    // マントモード: インデックスから geometry を構築
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));
    clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.indices), 1));

    const fc = analysis.colorFront ?? '#204080';
    const bc = analysis.colorBack  ?? '#803020';
    clothMat = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.85, sheen: 0.8 });
    clothMat.colorNode    = select(frontFacing, uniform(new THREE.Color(fc)), uniform(new THREE.Color(bc)));
    clothMat.positionNode = posNode;
  }

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);

  if (srcMesh) srcMesh.visible = false;
  if (markerGroup) markerGroup.visible = false;

  return {
    vertexPositionBuffer,
    vertexParamsCPU:     vertexParamsArr,
    vertexCount,
    computeSpringForces,
    computeVertexForces,
    clothMesh,
    clothGeo,
    clothMat: clothMat,
    grabbedIndexUniform,
    grabbedTargetUniform,
    leftGripActiveUniform,
    rightGripActiveUniform,
    leftGripTargetUniform,
    rightGripTargetUniform,
    srcMesh,
    cpuPositions: positions.slice(),
  };
}

function disposeSimulation() {
  if (!simData) return;
  if (simData.srcMesh) simData.srcMesh.visible = true;
  scene.remove(simData.clothMesh);
  simData.clothGeo.dispose();
  const mats = Array.isArray(simData.clothMat) ? simData.clothMat : [simData.clothMat];
  for (const m of mats) m.dispose();
  simData              = null;
  simRunning           = false;
  colliderDataBuffer   = null;
  colliderCountUniform = null;
  grab.snapshot    = null;
  grab.snapshotAge = 999;
  if (markerGroup) markerGroup.visible = true;
}

// ============================================================
// Vertex Picker（ピン指定・グラブ共用）
// ============================================================

function pickNearestVertex(clientX, clientY, snapshot, vertexCount, threshold) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let bestIdx = -1, bestDist = threshold;
  const p = new THREE.Vector3();

  for (let i = 0; i < vertexCount; i++) {
    p.set(snapshot[i*3], snapshot[i*3+1], snapshot[i*3+2]);
    p.project(camera);
    if (p.z > 1) continue;

    const sx = (p.x *  0.5 + 0.5) * w;
    const sy = (p.y * -0.5 + 0.5) * h;
    const d  = Math.hypot(sx - clientX, sy - clientY);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// ============================================================
// Grab Controller
// ============================================================

function buildDragPlane(worldPos) {
  const normal = worldPos.clone().sub(camera.position).normalize();
  grab.dragPlane.setFromNormalAndCoplanarPoint(normal, worldPos);
}

function applyGrabTarget(clientX, clientY) {
  grab.raycaster.setFromCamera(
    { x: (clientX / window.innerWidth) * 2 - 1, y: -(clientY / window.innerHeight) * 2 + 1 },
    camera,
  );
  const hit = new THREE.Vector3();
  if (!grab.raycaster.ray.intersectPlane(grab.dragPlane, hit)) return;
  simData.grabbedTargetUniform.value.copy(hit);
  grab.highlightMesh.position.copy(hit);
}

function clearGrabState() {
  if (grab.active && simData) simData.grabbedIndexUniform.value = GRAB_NONE;
  grab.active    = false;
  grab.vertexIdx = -1;
  if (grab.highlightMesh) grab.highlightMesh.visible = false;
  controls.enabled = !pinMode;
}

function scheduleReadbacks() {
  if (!simData || grab.active) return;
  grab.snapshotAge = (grab.snapshotAge ?? 999) + 1;
  if (grab.snapshotAge < 30 || grab.snapshotPending) return;
  grab.snapshotAge     = 0;
  grab.snapshotPending = true;

  renderer.getArrayBufferAsync(simData.vertexPositionBuffer.value)
    .then(ab => {
      grab.snapshot        = new Float32Array(ab);
      simData.cpuPositions = grab.snapshot;
      grab.snapshotPending = false;
    })
    .catch(() => { grab.snapshotPending = false; });
}

function setupGrabEvents(canvas) {
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;

    // グリップ編集モード：頂点クリックでグリップ指定（シミュ停止中のみ）
    if (gripEditMode && !simRunning) {
      let snapshot, vertexCount;
      if (mantleData && mantleOrigPos) {
        snapshot    = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
        vertexCount = mantleData.vertexCount;
      } else if (analysisData) {
        snapshot    = analysisData.positions;
        vertexCount = analysisData.vertexCount;
      } else { return; }
      const idx = pickNearestVertex(e.clientX, e.clientY, snapshot, vertexCount, PIN_THRESHOLD_PX);
      if (idx < 0) return;
      toggleGrip(idx, gripEditMode);
      e.stopPropagation();
      return;
    }

    // ピンモード：頂点クリックでピン指定
    if (pinMode) {
      let snapshot, vertexCount;
      if (mantleData && mantleOrigPos) {
        snapshot    = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
        vertexCount = mantleData.vertexCount;
      } else if (analysisData) {
        snapshot    = analysisData.positions;
        vertexCount = analysisData.vertexCount;
      } else { return; }
      const idx = pickNearestVertex(e.clientX, e.clientY, snapshot, vertexCount, PIN_THRESHOLD_PX);
      if (idx < 0) return;
      togglePin(idx);
      e.stopPropagation();
      return;
    }

    // グラブモード（シミュ実行中のみ）
    if (!simRunning || !simData) return;
    const snapshot = grab.snapshot ?? simData.cpuPositions;
    if (!snapshot) return;

    const idx = pickNearestVertex(e.clientX, e.clientY, snapshot, simData.vertexCount, GRAB_THRESHOLD_PX);
    if (idx < 0) return;
    if (simData.vertexParamsCPU[idx * 3] === 1) return; // ピン頂点はグラブ不可

    controls.enabled = false;
    grab.active    = true;
    grab.vertexIdx = idx;
    simData.grabbedIndexUniform.value = idx;

    const wx = snapshot[idx*3], wy = snapshot[idx*3+1], wz = snapshot[idx*3+2];
    buildDragPlane(new THREE.Vector3(wx, wy, wz));
    grab.highlightMesh.position.set(wx, wy, wz);
    grab.highlightMesh.visible = true;
    applyGrabTarget(e.clientX, e.clientY);

    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    e.stopPropagation();
  }, { capture: true });

  canvas.addEventListener('pointermove', e => {
    if (!grab.active) return;
    applyGrabTarget(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerup', e => {
    if (!grab.active) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    clearGrabState();
    canvas.style.cursor = '';
  });

  canvas.addEventListener('pointercancel', () => {
    if (!grab.active) return;
    clearGrabState();
    canvas.style.cursor = '';
  });
}

// ============================================================
// Grip Key Test (L/R キー押下中グリップ動作テスト)
// ============================================================

function setupGripKeyEvents(canvas) {
  let mouseX = 0, mouseY = 0;
  const leftDragPlane  = new THREE.Plane();
  const rightDragPlane = new THREE.Plane();
  const gripRaycaster  = new THREE.Raycaster();
  const gripHitPoint   = new THREE.Vector3();
  const keyState       = { left: false, right: false };

  // マウス座標を常に追跡
  canvas.addEventListener('pointermove', e => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    _updateGripTargets();
  });

  // グリップ重心を cpuPositions から計算
  function _gripCentroid(side) {
    const set = side === 'left' ? leftGripSet : rightGripSet;
    if (set.size === 0) return null;
    const src = simData?.cpuPositions;
    if (!src) return null;
    const c = new THREE.Vector3();
    for (const idx of set) {
      c.x += src[idx * 3];
      c.y += src[idx * 3 + 1];
      c.z += src[idx * 3 + 2];
    }
    return c.divideScalar(set.size);
  }

  function _activateGrip(side) {
    if (!simRunning || !simData) return;
    const set = side === 'left' ? leftGripSet : rightGripSet;
    if (set.size === 0) {
      showToast(`${side === 'left' ? 'L' : 'R'}手グリップ頂点が未設定です`, 'warn');
      return;
    }
    // ドラッグ平面をグリップ重心 + カメラ向き法線で設定
    const origin = _gripCentroid(side) ?? controls.target.clone();
    const normal = origin.clone().sub(camera.position).normalize();
    const plane  = side === 'left' ? leftDragPlane : rightDragPlane;
    plane.setFromNormalAndCoplanarPoint(normal, origin);

    keyState[side] = true;
    if (side === 'left') simData.leftGripActiveUniform.value  = 1;
    else                 simData.rightGripActiveUniform.value = 1;
    _updateGripTargets();
  }

  function _deactivateGrip(side) {
    keyState[side] = false;
    if (simData) {
      if (side === 'left') simData.leftGripActiveUniform.value  = 0;
      else                 simData.rightGripActiveUniform.value = 0;
    }
  }

  function _updateGripTargets() {
    if (!keyState.left && !keyState.right) return;
    if (!simData) return;
    gripRaycaster.setFromCamera(
      { x: (mouseX / window.innerWidth) * 2 - 1, y: -(mouseY / window.innerHeight) * 2 + 1 },
      camera,
    );
    if (keyState.left) {
      if (gripRaycaster.ray.intersectPlane(leftDragPlane, gripHitPoint))
        simData.leftGripTargetUniform.value.copy(gripHitPoint);
    }
    if (keyState.right) {
      if (gripRaycaster.ray.intersectPlane(rightDragPlane, gripHitPoint))
        simData.rightGripTargetUniform.value.copy(gripHitPoint);
    }
  }

  window.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyL') _activateGrip('left');
    if (e.code === 'KeyR') _activateGrip('right');
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'KeyL') _deactivateGrip('left');
    if (e.code === 'KeyR') _deactivateGrip('right');
  });
}

// ============================================================
// Grip Edit Mode Helper
// ============================================================

function _setGripEditMode(mode) {
  gripEditMode = mode;
  const gripLBtn = document.getElementById('btn-grip-left-mode');
  const gripRBtn = document.getElementById('btn-grip-right-mode');
  if (!gripLBtn || !gripRBtn) return;

  gripLBtn.classList.toggle('active', mode === 'left');
  gripRBtn.classList.toggle('active', mode === 'right');
  gripLBtn.textContent = mode === 'left' ? 'L手グリップ編集 ON' : 'L手グリップ編集 OFF';
  gripRBtn.textContent = mode === 'right' ? 'R手グリップ編集 ON' : 'R手グリップ編集 OFF';

  // グリップ編集モードON時はピンモードを解除
  if (mode) {
    pinMode = false;
    const pinBtn = document.getElementById('btn-pin-mode');
    if (pinBtn) {
      pinBtn.classList.remove('active');
      pinBtn.textContent = 'ピン編集 OFF [P]';
    }
  }
  controls.enabled = !mode && !pinMode;
}

// ============================================================
// Mantle Export (with grip data)
// ============================================================

function exportMantleWithGrips() {
  if (!mantleData) {
    showToast('マントが読み込まれていません', 'error');
    return;
  }
  const out = {
    ...mantleData,
    leftGripIndices:  [...leftGripSet],
    rightGripIndices: [...rightGripSet],
    editorTransform:  { ...mantleTransform },
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'mantle_with_grips.cloth.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`エクスポート完了 (L手:${leftGripSet.size}頂点 / R手:${rightGripSet.size}頂点)`);
}

// ============================================================
// UI Manager
// ============================================================

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast ${type} visible`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3500);
}

function updateMeshList() {
  const list = document.getElementById('mesh-list');
  list.innerHTML = '';
  for (let i = 0; i < currentMeshes.length; i++) {
    const li = document.createElement('li');
    li.textContent = currentMeshes[i].name;
    if (i === selectedMeshIdx) li.classList.add('selected');
    li.addEventListener('click', () => selectMesh(i));
    list.appendChild(li);
  }
}

function selectMesh(idx) {
  if (idx === selectedMeshIdx) return;

  // マントモードを解除してメッシュモードへ
  if (mantleData) clearMantle();

  if (simRunning) stopSim();
  disposeSimulation();
  disposeMarkers();
  pinnedSet.clear();
  leftGripSet.clear();
  rightGripSet.clear();

  selectedMeshIdx = idx;
  updateMeshList();

  const { mesh } = currentMeshes[idx];
  const analysis = analyzeMesh(mesh);

  if (analysis.error) {
    showToast(analysis.error, 'error');
    return;
  }
  if (analysis.warning) showToast(analysis.warning, 'warn');

  analysisData      = analysis;
  originalPositions = analysis.positions.slice();
  initMarkers(analysis.positions, analysis.vertexCount);

  showToast(`${analysis.vertexCount}頂点 / ${analysis.springCount}スプリング`);
}

function _buildMantleAnalysis() {
  // マント JSON から analysisData 互換オブジェクトを生成（変換座標適用済み）
  const transformed = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
  const springs     = new Array(mantleData.springs.length);
  for (let i = 0; i < mantleData.springs.length; i++) springs[i] = mantleData.springs[i];
  return {
    positions:   transformed,
    vertexCount: mantleData.vertexCount,
    springs,
    springCount: mantleData.springs.length / 2,
    indices:     mantleData.indices,
    colorFront:  mantleData.material?.colorFront ?? '#204080',
    colorBack:   mantleData.material?.colorBack  ?? '#803020',
    mesh:        null,  // マントモード
  };
}

function startSim() {
  if (!analysisData && !mantleData) {
    showToast('メッシュを選択するかマントを読み込んでください', 'error');
    return;
  }
  if (simRunning) return;
  const analysis = mantleData ? _buildMantleAnalysis() : analysisData;
  simData    = buildSimulation(analysis);
  simRunning = true;
  document.getElementById('btn-sim-start').disabled = true;
  document.getElementById('btn-sim-stop').disabled  = false;
  document.getElementById('btn-sim-reset').disabled = false;
}

function stopSim() {
  simRunning = false;
  document.getElementById('btn-sim-start').disabled = false;
  document.getElementById('btn-sim-stop').disabled  = true;
}

function resetSim() {
  if (!analysisData && !mantleData) return;
  if (simRunning) stopSim();
  disposeSimulation();
  // ピンは維持したまま再表示
  if (mantleData) {
    const transformed = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
    initMarkers(transformed, mantleData.vertexCount);
  } else {
    initMarkers(analysisData.positions, analysisData.vertexCount);
  }
  for (const idx of pinnedSet) _setPinVisual(idx, true);
  document.getElementById('btn-sim-reset').disabled = true;
}

function setupUI() {
  // VRM 読み込み
  const fileInput = document.getElementById('vrm-file');
  fileInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileInput.value = '';
    showToast('読み込み中...');
    try {
      const meshes = await loadVRM(file);
      updateMeshList();
      showToast(`VRM 読み込み完了 (${meshes.length} メッシュ)`);
    } catch (err) {
      showToast(`読み込み失敗: ${err.message}`, 'error');
      console.error(err);
    }
  });
  document.getElementById('btn-vrm-load').addEventListener('click', () => fileInput.click());

  // ピンモード
  const pinBtn = document.getElementById('btn-pin-mode');
  pinBtn.addEventListener('click', () => {
    pinMode = !pinMode;
    pinBtn.classList.toggle('active', pinMode);
    pinBtn.textContent = pinMode ? 'ピン編集 ON  [P]' : 'ピン編集 OFF [P]';
    // ピンモードON時はグリップ編集を解除
    if (pinMode) _setGripEditMode(null);
    controls.enabled = !pinMode && !gripEditMode;
  });
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyP' && !e.ctrlKey && !e.altKey) pinBtn.click();
  });

  document.getElementById('btn-pin-reset').addEventListener('click', () => {
    resetPins();
    showToast('ピンをリセットしました');
  });

  // グリップ編集モード
  const gripLBtn = document.getElementById('btn-grip-left-mode');
  const gripRBtn = document.getElementById('btn-grip-right-mode');

  gripLBtn.addEventListener('click', () => {
    const next = gripEditMode === 'left' ? null : 'left';
    _setGripEditMode(next);
  });
  gripRBtn.addEventListener('click', () => {
    const next = gripEditMode === 'right' ? null : 'right';
    _setGripEditMode(next);
  });

  document.getElementById('btn-grip-reset').addEventListener('click', () => {
    resetGrips();
    showToast('グリップをリセットしました');
  });

  // マントエクスポート（グリップ付き）
  document.getElementById('btn-export-grip').addEventListener('click', exportMantleWithGrips);

  // シミュコントロール
  document.getElementById('btn-sim-start').addEventListener('click', startSim);
  document.getElementById('btn-sim-stop').addEventListener('click', stopSim);
  document.getElementById('btn-sim-reset').addEventListener('click', resetSim);

  // マント読み込み
  const mantleFileInput = document.getElementById('mantle-file');
  mantleFileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    mantleFileInput.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        loadMantleJSON(JSON.parse(ev.target.result));
      } catch (err) {
        showToast(`マント読み込み失敗: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-mantle-load').addEventListener('click', () => mantleFileInput.click());
  document.getElementById('btn-mantle-clear').addEventListener('click', clearMantle);

  // マント変換スライダー
  const bindTransform = (id, valId, key, parse, fmt) => {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    sl.addEventListener('input', () => {
      const v = parse(sl.value);
      vl.textContent = fmt(v);
      mantleTransform[key] = v;
      if (!simRunning) updateMantleMarkers();
    });
  };
  bindTransform('mt-tx',    'mt-tx-val',    'tx',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-ty',    'mt-ty-val',    'ty',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-tz',    'mt-tz-val',    'tz',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-ry',    'mt-ry-val',    'ry',    parseFloat, v => `${Math.round(v)}°`);
  bindTransform('mt-scale', 'mt-scale-val', 'scale', parseFloat, v => v.toFixed(2));

  // コライダー表示切替
  document.getElementById('collider-visible').addEventListener('change', e => {
    setCollidersVisible(e.target.checked);
  });
  // ボーンから再生成
  document.getElementById('btn-collider-rebuild').addEventListener('click', () => {
    if (!currentVRM) { showToast('VRMを読み込んでください', 'error'); return; }
    buildCollidersFromVRM(currentVRM);
    showToast('コライダーを再生成しました');
  });

  // パラメータスライダー
  const bind = (id, valId, uniformRef, parse, fmt) => {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    sl.addEventListener('input', () => {
      const v = parse(sl.value);
      vl.textContent = fmt(v);
      uniformRef.value = v;
    });
  };
  bind('stiffness', 'stiffness-val', stiffnessUniform, parseFloat, v => v.toFixed(3));
  bind('dampening', 'dampening-val', dampeningUniform, parseFloat, v => v.toFixed(3));
  bind('wind',      'wind-val',      windUniform,      parseFloat, v => v.toFixed(1));
}

// ============================================================
// FPS Counter + Render Loop
// ============================================================

function updateFPS() {
  fpsFrameCount++;
  const now = performance.now();
  const e   = now - fpsLastTime;
  if (e >= 500) {
    document.getElementById('fps-counter').textContent =
      `${Math.round(fpsFrameCount / (e / 1000))} FPS`;
    fpsFrameCount = 0;
    fpsLastTime   = now;
  }
}

let timeSinceLastStep = 0;

async function render() {
  timer.update();
  updateFPS();

  if (simRunning && simData) {
    const dt          = Math.min(timer.getDelta(), 1 / 60);
    const timePerStep = 1 / 360;
    timeSinceLastStep += dt;
    while (timeSinceLastStep >= timePerStep) {
      timeSinceLastStep -= timePerStep;
      renderer.compute(simData.computeSpringForces);
      renderer.compute(simData.computeVertexForces);
    }
    scheduleReadbacks();
  }

  renderer.render(scene, camera);
}

// ============================================================
// Init
// ============================================================

async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  // WebGPU チェック
  if (!navigator.gpu) {
    document.getElementById('webgpu-warning').style.display = 'block';
    document.getElementById('btn-sim-start').disabled = true;
  }

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.2;
  app.appendChild(renderer.domElement);

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.2, 2.8);

  // ライト
  const ambient = new THREE.AmbientLight(0xffffff, 1.2);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  // グラブハイライト球
  grab.highlightMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.015, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffee00, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  grab.highlightMesh.visible = false;
  grab.highlightMesh.renderOrder = 999;
  scene.add(grab.highlightMesh);

  // OrbitControls（グラブイベントより先に登録しておく）
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  // 共有 uniform 初期化
  stiffnessUniform = uniform(0.2);
  dampeningUniform = uniform(0.99);
  windUniform      = uniform(1.0);

  timer.connect(document);

  setupUI();
  setupGrabEvents(renderer.domElement);
  setupGripKeyEvents(renderer.domElement);

  // ゲームコードから呼び出せる公開 API
  window.clothAPI = {
    /** 左手グリップをアクティブにし、指定ワールド座標へ頂点を引き寄せる */
    gripLeft(x, y, z) {
      if (!simData) return;
      simData.leftGripActiveUniform.value = 1;
      simData.leftGripTargetUniform.value.set(x, y, z);
    },
    /** 右手グリップをアクティブにし、指定ワールド座標へ頂点を引き寄せる */
    gripRight(x, y, z) {
      if (!simData) return;
      simData.rightGripActiveUniform.value = 1;
      simData.rightGripTargetUniform.value.set(x, y, z);
    },
    /** 左手グリップを解放する */
    releaseLeft() {
      if (!simData) return;
      simData.leftGripActiveUniform.value = 0;
    },
    /** 右手グリップを解放する */
    releaseRight() {
      if (!simData) return;
      simData.rightGripActiveUniform.value = 0;
    },
    /** 左手グリップ頂点数を返す */
    get leftGripCount() { return leftGripSet.size; },
    /** 右手グリップ頂点数を返す */
    get rightGripCount() { return rightGripSet.size; },
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
}

init().catch(err => {
  console.error(err);
  document.getElementById('error-detail').textContent = String(err);
  document.getElementById('error-msg').classList.add('visible');
  document.getElementById('loading').style.display = 'none';
});
