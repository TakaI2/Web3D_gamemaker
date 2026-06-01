// cloth-editor.js — VRMメッシュを布シミュレーションに変換するエディタ
// Three.js v0.184 WebGPU + TSL + @pixiv/three-vrm

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float, vec3,
  triNoise3D, time, frontFacing,
  cross, transformNormalToView,
} from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }    from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';

// ── 定数 ─────────────────────────────────────────────────────
const GRAB_NONE           = -1;
const GRAB_THRESHOLD_PX   = 32;
const PIN_THRESHOLD_PX    = 25;
const MARKER_RADIUS       = 0.005;
const MAX_VERTICES_WARN   = 2000;

// ── シーングローバル ──────────────────────────────────────────
let renderer, scene, camera, controls;
const timer = new THREE.Timer();

// ── VRM 状態 ──────────────────────────────────────────────────
let currentVRM       = null;
let currentVRMFile   = null;   // NPCバンドル書き出し用：アップロードしたVRMのFile（バイト保持）
let currentVRMAName  = null;   // NPCバンドル書き出し用：選択中のVRMAファイル名
let currentMeshes    = [];   // { name, mesh }[]
let selectedMeshIdx  = -1;
let analysisData     = null; // analyzeMesh() の結果
let originalPositions = null; // リセット用バックアップ

// ── ピン状態 ──────────────────────────────────────────────────
let pinMode    = false;
const pinnedSet  = new Set();
const markerMeshes = [];
let markerGroup  = null;
// ボーンアンカー: vertexIdx → { boneName, boneNode, offset: THREE.Vector3 }
const anchorMap = new Map();
let anchorEditMode = null; // string|null = アンカー編集中のボーン名

// ── シミュレーション状態 ──────────────────────────────────────
let simRunning = false;
let simData    = null;

// ── VRMA プレイヤー ───────────────────────────────────────────
let mixer       = null;
let vrmaAction  = null;
let vrmaClip    = null;
let vrmaPlaying = false;

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
// colliders[i] = { x, y, z, r, boneNode, boneName, localOffset, helperMesh }
const colliders = [];
// GPU へ渡す Float32Array: [x,y,z,r, x,y,z,r, ...]  MAX_COLLIDERS 個
const colliderDataArr = new Float32Array(MAX_COLLIDERS * 4);
let   colliderCountUniform = null;  // buildSimulation 後に使用可
let   colliderDataBuffer   = null;  // instancedArray
// 読み込んだ cloth.json のコライダー設定 [{ boneName, r, offset:[x,y,z] }]。VRM読込時に半径・オフセットを復元する。
let   savedColliderData    = null;

// ── グリップ状態 ──────────────────────────────────────────────
const leftGripSet  = new Set();  // 左手でつかめる頂点インデックス
const rightGripSet = new Set();  // 右手でつかめる頂点インデックス
let gripEditMode   = null;        // 'left' | 'right' | null

// ── ハンドグラブポイント ─────────────────────────────────────
// VRM手ボーンに追従するグラブポイント（オフセット微調整可能）
const handGrabPoints = {
  left:  { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false },
  right: { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false },
};
// ハンドグラブポイントのドラッグ状態（マーカー球を直接ドラッグして微調整）
let _hgpDragSide = null;
const _hgpDragPlane    = new THREE.Plane();
const _hgpDragRaycaster = new THREE.Raycaster();

// ── グラブ状態 ────────────────────────────────────────────────
const grab = {
  active:          false,
  vertexIdx:       -1,
  dragPlane:       new THREE.Plane(),
  raycaster:       new THREE.Raycaster(),
  highlightMesh:   null,
  snapshot:        null,
  pendingDown:     false,  // pointerdown→readback完了までの保留中フラグ（途中でpointerupされたら掴みを中止）
};

// ── FPS カウンター ────────────────────────────────────────────
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ============================================================
// VRM Loader
// ============================================================

async function loadVRM(file) {
  const loader = new GLTFLoader();
  // WebGPU 互換の MToonNodeMaterial を指定して、本来の MToon 見た目を保持する
  loader.register(parser => new VRMLoaderPlugin(parser, {
    mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, {
      materialType: MToonNodeMaterial,
    }),
  }));

  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrm  = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMデータが見つかりません');

    unloadVRM();
    currentVRM = vrm;

    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    currentMeshes = [];
    vrm.scene.traverse(obj => {
      if ((obj.isSkinnedMesh || obj.isMesh) && obj.geometry) {
        currentMeshes.push({ name: obj.name || `Mesh_${currentMeshes.length}`, mesh: obj });
      }
    });

    buildCollidersFromVRM(vrm);
    initHandGrabPoints(vrm);

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

  unloadVRMA();
  clearColliders();
  disposeHandGrabPoints();
  currentVRM        = null;
  currentMeshes     = [];
  selectedMeshIdx   = -1;
  analysisData      = null;
  originalPositions = null;
  anchorMap.clear();
  anchorEditMode = null;
  document.getElementById('anchor-section').style.display = 'none';
  document.getElementById('anchor-section-placeholder').style.display = '';
  const anchorBtn = document.getElementById('btn-anchor-mode');
  if (anchorBtn) { anchorBtn.classList.remove('active'); anchorBtn.textContent = 'アンカー編集 OFF'; }
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
  const tmp  = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  for (const def of BONE_COLLIDER_DEFS) {
    const node = vrm.humanoid?.getNormalizedBoneNode(def.bone);
    if (!node) continue;
    node.getWorldPosition(tmp);
    node.getWorldQuaternion(quat);
    // 保存済み設定があれば半径・ボーンローカルオフセットを復元（無ければデフォルト）
    const saved = savedColliderData?.find(s => s.boneName === def.bone);
    const r           = saved ? saved.r : def.r;
    const localOffset = (saved && saved.offset) ? new THREE.Vector3(...saved.offset) : new THREE.Vector3();
    const world = tmp.clone().add(localOffset.clone().applyQuaternion(quat));
    addCollider(world.x, world.y, world.z, r, node, def.bone, localOffset);
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  updateColliderUI();
  syncColliderDataArr();
}

function addCollider(x, y, z, r, boneNode = null, boneName = null, localOffset = null) {
  const geo  = new THREE.SphereGeometry(1, 12, 8);
  const mat  = new THREE.MeshBasicMaterial({
    color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.35,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(r);
  mesh.renderOrder = 5;
  scene.add(mesh);
  colliders.push({ x, y, z, r, boneNode, boneName, localOffset: localOffset ?? new THREE.Vector3(), helperMesh: mesh });
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
    const c   = colliders[idx];
    c[key] = parseFloat(el.value);
    // 位置(X/Y/Z)編集時は、絶対座標からボーンローカルオフセットを再計算して永続化
    // （毎フレームの updateBoneColliders がオフセットを保ったままボーン追従する）
    if (key !== 'r' && c.boneNode) {
      c.boneNode.getWorldPosition(_colliderTmp);
      c.boneNode.getWorldQuaternion(_colliderQuat);
      _colliderQuat.invert();
      c.localOffset.set(c.x - _colliderTmp.x, c.y - _colliderTmp.y, c.z - _colliderTmp.z)
                   .applyQuaternion(_colliderQuat);
    }
    updateColliderHelper(idx);
    syncColliderDataArr();
  });
}

// ============================================================
// Hand Grab Points（VRM手ボーン追従グラブポイント）
// ============================================================

function initHandGrabPoints(vrm) {
  disposeHandGrabPoints();
  const defs = [
    { side: 'left',  boneName: 'leftHand',  color: 0x44aaff },
    { side: 'right', boneName: 'rightHand', color: 0xff6644 },
  ];
  let found = 0;
  for (const { side, boneName, color } of defs) {
    const hp = handGrabPoints[side];
    hp.boneNode = vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
    if (!hp.boneNode) continue;
    found++;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.offset.set(0, 0, 0);

    const geo  = new THREE.SphereGeometry(0.025, 14, 10);
    const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(hp.worldPos);
    mesh.renderOrder   = 12;
    mesh.frustumCulled = false;
    hp.markerMesh = mesh;
    scene.add(mesh);
  }
  if (found > 0) {
    document.getElementById('hand-grab-section').style.display = '';
    _syncHgpOffsetUI('left');
    _syncHgpOffsetUI('right');
  }
}

function disposeHandGrabPoints() {
  for (const side of ['left', 'right']) {
    const hp = handGrabPoints[side];
    if (hp.markerMesh) {
      scene.remove(hp.markerMesh);
      hp.markerMesh.geometry.dispose();
      hp.markerMesh.material.dispose();
      hp.markerMesh = null;
    }
    hp.boneNode = null;
    hp.offset.set(0, 0, 0);
    hp.active = false;
  }
  _hgpDragSide = null;
  document.getElementById('hand-grab-section').style.display = 'none';
}

// 毎フレーム呼び出し：ボーン位置＋オフセットでmarkerを更新し、アクティブ時はgrip targetも更新
function updateHandGrabPoints() {
  for (const side of ['left', 'right']) {
    const hp = handGrabPoints[side];
    if (!hp.boneNode) continue;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.worldPos.add(hp.offset);
    if (hp.markerMesh) hp.markerMesh.position.copy(hp.worldPos);
    if (simData && hp.active) {
      if (side === 'left')  simData.leftGripTargetUniform.value.copy(hp.worldPos);
      else                  simData.rightGripTargetUniform.value.copy(hp.worldPos);
    }
  }
}

function _syncHgpOffsetUI(side) {
  const hp     = handGrabPoints[side];
  const prefix = side === 'left' ? 'hgp-l' : 'hgp-r';
  for (const axis of ['x', 'y', 'z']) {
    const sl = document.getElementById(`${prefix}-${axis}`);
    const vl = document.getElementById(`${prefix}-${axis}-val`);
    if (sl) sl.value         = hp.offset[axis].toFixed(3);
    if (vl) vl.textContent   = hp.offset[axis].toFixed(2);
  }
}

// ボーンに紐づいたコライダーを毎フレーム追従させる
const _colliderTmp  = new THREE.Vector3();
const _colliderQuat = new THREE.Quaternion();
const _colliderOff  = new THREE.Vector3();
function updateBoneColliders() {
  let changed = false;
  for (const c of colliders) {
    if (!c.boneNode) continue;
    c.boneNode.getWorldPosition(_colliderTmp);
    c.boneNode.getWorldQuaternion(_colliderQuat);
    _colliderTmp.add(_colliderOff.copy(c.localOffset).applyQuaternion(_colliderQuat));
    if (c.x === _colliderTmp.x && c.y === _colliderTmp.y && c.z === _colliderTmp.z) continue;
    c.x = _colliderTmp.x;
    c.y = _colliderTmp.y;
    c.z = _colliderTmp.z;
    c.helperMesh.position.copy(_colliderTmp);
    changed = true;
  }
  if (changed) syncColliderDataArr();
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
  anchorMap.clear();
  for (const idx of json.pinnedIndices) pinnedSet.add(idx);
  leftGripSet.clear(); rightGripSet.clear();
  if (json.leftGripIndices)  for (const idx of json.leftGripIndices)  leftGripSet.add(idx);
  if (json.rightGripIndices) for (const idx of json.rightGripIndices) rightGripSet.add(idx);

  // ボーンアンカー復元（VRM 読み込み済みの場合のみ boneNode を解決）
  const anchorData = json.anchorAssignments ?? json.pinnedBoneAssignments;
  if (anchorData && currentVRM) {
    for (const entry of anchorData) {
      const { vertexIdx, boneName } = entry;
      const boneNode = currentVRM.humanoid?.getNormalizedBoneNode(boneName);
      if (!boneNode) continue;
      // localOffset（新形式）またはoffset（旧形式・ワールド空間）を処理
      let localOffset;
      if (entry.localOffset) {
        localOffset = new THREE.Vector3(...entry.localOffset);
      } else if (entry.offset) {
        // 旧形式：ワールド空間オフセットをボーンローカル空間に変換
        const boneQuat = new THREE.Quaternion();
        boneNode.getWorldQuaternion(boneQuat);
        localOffset = new THREE.Vector3(...entry.offset).applyQuaternion(boneQuat.invert());
      } else { continue; }
      anchorMap.set(vertexIdx, { boneName, boneNode, localOffset });
    }
  }

  // 球コライダー設定を復元（VRM読込済みなら半径・オフセットを適用して再構築）
  savedColliderData = json.colliders ?? null;
  if (savedColliderData && currentVRM) buildCollidersFromVRM(currentVRM);

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
  anchorMap.clear();
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
  document.getElementById('mt-tx-val').value    = '0.00';
  document.getElementById('mt-ty-val').value    = '0.00';
  document.getElementById('mt-tz-val').value    = '0.00';
  document.getElementById('mt-ry-val').value    = '0';
  document.getElementById('mt-scale-val').value = '1.00';
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

// ピン・グリップ状態に応じてマーカーの見た目を更新
// 優先度: ボーンアンカー(マゼンタ) > 固定ピン(黄) > L手グリップ(青) > R手グリップ(橙) > 通常(白)
function _updateMarkerVisual(idx) {
  if (idx < 0 || idx >= markerMeshes.length) return;
  const mat = markerMeshes[idx].material;
  if (anchorMap.has(idx)) {
    mat.color.set(0xff44cc); mat.opacity = 1.0; mat.transparent = false;
    markerMeshes[idx].scale.setScalar(1.8);
  } else if (pinnedSet.has(idx)) {
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

function toggleAnchor(idx) {
  if (!anchorEditMode || !currentVRM) return;
  const boneNode = currentVRM.humanoid?.getNormalizedBoneNode(anchorEditMode);
  if (!boneNode) { showToast(`ボーン "${anchorEditMode}" が見つかりません`, 'warn'); return; }

  if (anchorMap.has(idx)) {
    anchorMap.delete(idx);
  } else {
    // 頂点ワールド座標を取得してボーンローカル空間でのオフセットを算出
    let snapshot;
    if (mantleData && mantleOrigPos) {
      snapshot = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
    } else if (analysisData) {
      snapshot = analysisData.positions;
    } else { return; }
    const bonePos  = new THREE.Vector3();
    const boneQuat = new THREE.Quaternion();
    boneNode.getWorldPosition(bonePos);
    boneNode.getWorldQuaternion(boneQuat);
    // ワールド空間のオフセットをボーンローカル空間に変換（逆クォータニオンを適用）
    const localOffset = new THREE.Vector3(
      snapshot[idx*3]   - bonePos.x,
      snapshot[idx*3+1] - bonePos.y,
      snapshot[idx*3+2] - bonePos.z,
    ).applyQuaternion(boneQuat.invert());
    anchorMap.set(idx, { boneName: anchorEditMode, boneNode, localOffset });
  }
  _updateMarkerVisual(idx);
}

function clearAnchorMap() {
  anchorMap.clear();
  for (let i = 0; i < markerMeshes.length; i++) _updateMarkerVisual(i);
  showToast('ボーンアンカーをリセットしました');
}

// シミュ中に毎フレーム呼ぶ：各アンカー頂点のターゲット座標 (boneWorldPos + rotate(localOffset)) を更新
const _anchorTmp      = new THREE.Vector3();
const _anchorBoneQuat = new THREE.Quaternion();
const _anchorWorldOff = new THREE.Vector3();

function updateAnchorPositions() {
  if (!simData?.bonePinTargetBuffer || !anchorMap.size) return;
  const arr = simData.bonePinTargetBuffer.value.array;
  for (const [idx, { boneNode, localOffset }] of anchorMap) {
    boneNode.getWorldPosition(_anchorTmp);
    boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(localOffset).applyQuaternion(_anchorBoneQuat);
    arr[idx*3]   = _anchorTmp.x + _anchorWorldOff.x;
    arr[idx*3+1] = _anchorTmp.y + _anchorWorldOff.y;
    arr[idx*3+2] = _anchorTmp.z + _anchorWorldOff.z;
  }
  simData.bonePinTargetBuffer.value.needsUpdate = true;
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
  // gripCode: 0=なし, 1=左手グリップ, 2=右手グリップ, 3+N=ボーンスロットN
  const springListArray = [];
  const vertexParamsArr = new Uint32Array(vertexCount * 4);

  // ボーンアンカー：頂点ごとの初期ターゲット座標（boneWorldPos + rotate(localOffset) をCPUで事前計算）
  // フレームごとに updateAnchorPositions() で更新される
  const hasBonePins = anchorMap.size > 0;
  const bonePinTargetArr = new Float32Array(vertexCount * 3);
  if (hasBonePins) {
    const tmp      = new THREE.Vector3();
    const boneQuat = new THREE.Quaternion();
    const worldOff = new THREE.Vector3();
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      boneNode.getWorldPosition(tmp);
      boneNode.getWorldQuaternion(boneQuat);
      worldOff.copy(localOffset).applyQuaternion(boneQuat);
      bonePinTargetArr[idx*3]   = tmp.x + worldOff.x;
      bonePinTargetArr[idx*3+1] = tmp.y + worldOff.y;
      bonePinTargetArr[idx*3+2] = tmp.z + worldOff.z;
    }
  }

  for (let i = 0; i < vertexCount; i++) {
    const isAnchor = anchorMap.has(i);
    // アンカー頂点は isFixed=0 にしてシェーダー内で gripCode==3 として処理
    const isFixed = (!isAnchor && pinnedSet.has(i)) ? 1 : 0;
    let gripCode = 0;
    if (isAnchor) {
      gripCode = 3;
    } else if (leftGripSet.has(i)) {
      gripCode = 1;
    } else if (rightGripSet.has(i)) {
      gripCode = 2;
    }
    vertexParamsArr[i * 4]     = isFixed;
    vertexParamsArr[i * 4 + 3] = gripCode;
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

  // ── ボーンアンカーターゲットバッファ（アンカーがある場合のみ）──
  // 1本のバッファに boneWorldPos+offset を事前計算して格納（スロット方式不要）
  const bonePinTargetBuffer = hasBonePins ? instancedArray(bonePinTargetArr, 'vec3') : null;

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
    const gripCode      = vparams.w;  // 0=なし, 1=左手グリップ, 2=右手グリップ, 3=ボーンアンカー

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

    // ボーンアンカー（gripCode == 3）: 事前計算済みターゲット座標へ直接セット
    if (hasBonePins) {
      If(gripCode.equal(3), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(bonePinTargetBuffer.element(instanceIndex));
        Return();
      });
    }

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
    // マントモード: quad メッシュ（新形式）or パーティクル直接メッシュ（旧形式フォールバック）
    const useQuadMesh = !!(analysis.quadVertexIds);
    const fc      = analysis.colorFront  ?? '#204080';
    const bc      = analysis.colorBack   ?? '#803020';
    const opacity = analysis.opacity     ?? 0.85;
    const matOpts = {
      side:           THREE.DoubleSide,
      transparent:    opacity < 1.0,
      opacity,
      roughness:      analysis.roughness      ?? 1.0,
      sheen:          analysis.sheen          ?? 1.0,
      sheenRoughness: analysis.sheenRoughness ?? 0.5,
      sheenColor:     analysis.sheenColor ? new THREE.Color(analysis.sheenColor) : undefined,
    };

    if (useQuadMesh) {
      // /cloth と同一構造：レンダー頂点 = 4パーティクルのセル中心、法線もインライン計算
      const rvc       = analysis.renderVertexCount;
      const quadIdArr = new Uint32Array(analysis.quadVertexIds);
      clothGeo = new THREE.BufferGeometry();
      clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rvc * 3), 3, false));
      clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(quadIdArr, 4, false));
      clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.renderIndices), 1));
      clothMat = new THREE.MeshPhysicalNodeMaterial(matOpts);
      clothMat.colorNode    = select(frontFacing, uniform(new THREE.Color(fc)), uniform(new THREE.Color(bc)));
      clothMat.positionNode = Fn(({ material }) => {
        const vids = attribute('vertexIds');
        const v0 = vertexPositionBuffer.element(vids.x).toVar();
        const v1 = vertexPositionBuffer.element(vids.y).toVar();
        const v2 = vertexPositionBuffer.element(vids.z).toVar();
        const v3 = vertexPositionBuffer.element(vids.w).toVar();
        const tangent   = v1.add(v3).sub(v0.add(v2)).normalize();
        const bitangent = v2.add(v3).sub(v0.add(v1)).normalize();
        material.normalNode = transformNormalToView(cross(tangent, bitangent)).toVarying();
        return v0.add(v1).add(v2).add(v3).mul(0.25);
      })();
    } else {
      // 旧形式フォールバック: パーティクル直接メッシュ
      clothGeo = new THREE.BufferGeometry();
      clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));
      clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.indices), 1));
      clothMat = new THREE.MeshPhysicalNodeMaterial(matOpts);
      clothMat.colorNode    = select(frontFacing, uniform(new THREE.Color(fc)), uniform(new THREE.Color(bc)));
      clothMat.positionNode = posNode;
    }
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
    bonePinTargetBuffer,
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
  grab.pendingDown = false;
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
  grab.active      = false;
  grab.pendingDown = false;
  grab.vertexIdx   = -1;
  if (grab.highlightMesh) grab.highlightMesh.visible = false;
  controls.enabled = !pinMode && !anchorEditMode && !gripEditMode;
}

function setupGrabEvents(canvas) {
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;

    // ── ハンドグラブポイント マーカー球のドラッグ（優先度最高）──
    if (!gripEditMode && !pinMode) {
      for (const side of ['left', 'right']) {
        const hp = handGrabPoints[side];
        if (!hp.markerMesh) continue;
        const p  = hp.worldPos.clone().project(camera);
        if (p.z > 1) continue;
        const sx = (p.x *  0.5 + 0.5) * window.innerWidth;
        const sy = (p.y * -0.5 + 0.5) * window.innerHeight;
        if (Math.hypot(sx - e.clientX, sy - e.clientY) < 22) {
          // ドラッグ開始：カメラ向き法線でドラッグ平面を設定
          _hgpDragSide = side;
          const normal = hp.worldPos.clone().sub(camera.position).normalize();
          _hgpDragPlane.setFromNormalAndCoplanarPoint(normal, hp.worldPos);
          controls.enabled = false;
          canvas.setPointerCapture(e.pointerId);
          canvas.style.cursor = 'move';
          e.stopPropagation();
          return;
        }
      }
    }

    // アンカー編集モード：頂点クリックでアンカー指定
    if (anchorEditMode) {
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
      toggleAnchor(idx);
      e.stopPropagation();
      return;
    }

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
    if (grab.active || grab.pendingDown) return;

    // クリック時に最新の頂点座標を1回だけ readback → 揺れている布でも見た目どおりに掴める。
    // 非同期のため stopPropagation はせず、掴み成立時に controls.enabled=false で OrbitControls を抑制する
    // （布から外れたクリックはそのままカメラ回転に使える）。
    const { clientX, clientY, pointerId } = e;
    grab.pendingDown = true;

    renderer.getArrayBufferAsync(simData.vertexPositionBuffer.value)
      .then(ab => {
        // readback待ちの間に pointerup された場合は中止
        if (!grab.pendingDown || !simRunning || !simData) { grab.pendingDown = false; return; }
        grab.pendingDown = false;

        const snapshot = new Float32Array(ab);
        grab.snapshot        = snapshot;
        simData.cpuPositions = snapshot;

        const idx = pickNearestVertex(clientX, clientY, snapshot, simData.vertexCount, GRAB_THRESHOLD_PX);
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
        applyGrabTarget(clientX, clientY);

        canvas.setPointerCapture(pointerId);
        canvas.style.cursor = 'grabbing';
      })
      .catch(() => { grab.pendingDown = false; });
  }, { capture: true });

  canvas.addEventListener('pointermove', e => {
    // ハンドグラブポイントのオフセットドラッグ
    if (_hgpDragSide) {
      _hgpDragRaycaster.setFromCamera(
        { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 },
        camera,
      );
      const hit = new THREE.Vector3();
      if (_hgpDragRaycaster.ray.intersectPlane(_hgpDragPlane, hit)) {
        const hp = handGrabPoints[_hgpDragSide];
        const bonePos = new THREE.Vector3();
        hp.boneNode.getWorldPosition(bonePos);
        hp.offset.copy(hit).sub(bonePos);
        // スライダー範囲にクランプ
        hp.offset.clampScalar(-0.3, 0.3);
        _syncHgpOffsetUI(_hgpDragSide);
      }
      return;
    }
    if (!grab.active) return;
    applyGrabTarget(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerup', e => {
    if (_hgpDragSide) {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      _hgpDragSide     = null;
      controls.enabled = !pinMode && !anchorEditMode && !gripEditMode;
      canvas.style.cursor = '';
      return;
    }
    // readback待ちの間にリリースされた場合は保留を解除して掴みを中止
    grab.pendingDown = false;
    if (!grab.active) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    clearGrabState();
    canvas.style.cursor = '';
  });

  canvas.addEventListener('pointercancel', () => {
    if (_hgpDragSide) {
      _hgpDragSide     = null;
      controls.enabled = !pinMode && !anchorEditMode && !gripEditMode;
      canvas.style.cursor = '';
      return;
    }
    grab.pendingDown = false;
    if (!grab.active) return;
    clearGrabState();
    canvas.style.cursor = '';
  });
}

// ============================================================
// Grip Key Events (L/R キー → VRM手ボーン位置でグリップ)
// ============================================================

function setupGripKeyEvents() {
  function _activateGrip(side) {
    if (!simRunning || !simData) return;
    const set = side === 'left' ? leftGripSet : rightGripSet;
    if (set.size === 0) {
      showToast(`${side === 'left' ? 'L' : 'R'}手グリップ頂点が未設定です`, 'warn');
      return;
    }
    const hp = handGrabPoints[side];
    if (!hp.boneNode) {
      showToast(`VRMの${side === 'left' ? '左' : '右'}手ボーンが見つかりません`, 'warn');
      return;
    }
    hp.active = true;
    if (side === 'left') simData.leftGripActiveUniform.value  = 1;
    else                 simData.rightGripActiveUniform.value = 1;
  }

  function _deactivateGrip(side) {
    handGrabPoints[side].active = false;
    if (simData) {
      if (side === 'left') simData.leftGripActiveUniform.value  = 0;
      else                 simData.rightGripActiveUniform.value = 0;
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

  // グリップ編集モードON時はピン/アンカー編集を解除
  if (mode) {
    pinMode = false;
    const pinBtn = document.getElementById('btn-pin-mode');
    if (pinBtn) { pinBtn.classList.remove('active'); pinBtn.textContent = 'ピン編集 OFF [P]'; }
    anchorEditMode = null;
    const anchorBtn = document.getElementById('btn-anchor-mode');
    if (anchorBtn) { anchorBtn.classList.remove('active'); anchorBtn.textContent = 'アンカー編集 OFF'; }
  }
  controls.enabled = !mode && !pinMode && !anchorEditMode;
}

// ============================================================
// Mantle Export (with grip data)
// ============================================================

// グリップ・アンカー込みの cloth.json オブジェクトを組み立てる（単体保存とバンドル両方で共用）
function buildMantleExport() {
  const anchorAssignments = [...anchorMap.entries()].map(([idx, { boneName, localOffset }]) => ({
    vertexIdx: idx, boneName, localOffset: [localOffset.x, localOffset.y, localOffset.z],
  }));
  const handGrabOffsets = {
    left:  [handGrabPoints.left.offset.x,  handGrabPoints.left.offset.y,  handGrabPoints.left.offset.z],
    right: [handGrabPoints.right.offset.x, handGrabPoints.right.offset.y, handGrabPoints.right.offset.z],
  };
  // 球コライダー：ボーン相対オフセット + 半径で保存（ボーン名で再バインドするため絶対座標は保存しない）
  const colliderData = colliders
    .filter(c => c.boneName)
    .map(c => ({ boneName: c.boneName, r: c.r, offset: [c.localOffset.x, c.localOffset.y, c.localOffset.z] }));
  return {
    ...mantleData,
    leftGripIndices:  [...leftGripSet],
    rightGripIndices: [...rightGripSet],
    anchorAssignments,
    handGrabOffsets,
    editorTransform:  { ...mantleTransform },
    colliders:        colliderData,
  };
}

function exportMantleWithGrips() {
  if (!mantleData) {
    showToast('マントが読み込まれていません', 'error');
    return;
  }
  const out = buildMantleExport();
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'mantle_with_grips.cloth.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`エクスポート完了 (L手:${leftGripSet.size}頂点 / R手:${rightGripSet.size}頂点)`);
}

// ArrayBuffer → base64（大きいVRMでもスタック溢れしないようチャンク処理）
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// NPCバンドル(.npc.json)書き出し：VRM + VRMA + cloth(+任意でtimeline) を1ファイルにまとめる。
// fps-cloth-vrm の「NPC一括読込」で読める形式（format: "fps-npc-bundle"）。
async function exportNPCBundle() {
  if (!currentVRMFile) { showToast('先にVRMを読み込んでください', 'error'); return; }
  if (!mantleData)     { showToast('マントが読み込まれていません', 'error'); return; }

  showToast('NPCバンドル書き出し中…');
  try {
    const name = currentVRMFile.name.replace(/\.vrm$/i, '');

    // VRM バイト（アップロードFileから）
    const vrmB64 = arrayBufferToBase64(await currentVRMFile.arrayBuffer());

    // VRMA バイト（選択中のものをサーバから取得）。未選択なら省略。
    let vrmaDataURI = null;
    if (currentVRMAName) {
      const res = await fetch(`/vrma/${currentVRMAName}`);
      if (res.ok) {
        vrmaDataURI = 'data:application/octet-stream;base64,' + arrayBufferToBase64(await res.arrayBuffer());
      } else {
        showToast(`VRMA取得失敗（${currentVRMAName}）。VRMAなしで続行`, 'warn');
      }
    }

    // 任意添付の timeline.json（cloth-editor にタイムラインは無いので外部ファイルを受け付ける）
    let timeline = null;
    const tlInput = document.getElementById('bundle-tl-file');
    const tlFile  = tlInput?.files?.[0];
    if (tlFile) {
      timeline = JSON.parse(await tlFile.text());
    }

    const bundle = {
      format: 'fps-npc-bundle',
      version: 1,
      name,
      vrm:  'data:application/octet-stream;base64,' + vrmB64,
      vrma: vrmaDataURI,
      cloth: buildMantleExport(),
      timeline,
    };

    const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `${name}.npc.json`;
    a.click();
    URL.revokeObjectURL(a.href);

    const parts = ['VRM', vrmaDataURI ? 'VRMA' : null, 'Cloth', timeline ? 'Timeline' : null].filter(Boolean);
    showToast(`NPCバンドル書き出し完了（${parts.join(' + ')}）`);
  } catch (err) {
    showToast(`バンドル書き出し失敗: ${err.message}`, 'error');
    console.error(err);
  }
}

// ============================================================
// VRMA Player
// ============================================================

async function loadVRMA(filename) {
  if (!currentVRM) { showToast('先にVRMを読み込んでください', 'error'); return; }
  unloadVRMA();
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  try {
    const gltf = await loader.loadAsync(`/vrma/${filename}`);
    const vrmAnims = gltf.userData.vrmAnimations;
    if (!vrmAnims?.length) throw new Error('VRMAデータが見つかりません');
    vrmaClip   = createVRMAnimationClip(vrmAnims[0], currentVRM);
    mixer      = new THREE.AnimationMixer(currentVRM.scene);
    vrmaAction = mixer.clipAction(vrmaClip);
    vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
    vrmaAction.play();
    vrmaAction.paused = true;
    vrmaPlaying = false;
    _updateVrmaButtons();
    showToast(`VRMA 読み込み完了: ${filename}`);
  } catch (err) {
    showToast(`VRMA 読み込み失敗: ${err.message}`, 'error');
    console.error(err);
  }
}

function unloadVRMA() {
  if (vrmaAction) vrmaAction.stop();
  if (mixer)      mixer.stopAllAction();
  mixer       = null;
  vrmaAction  = null;
  vrmaClip    = null;
  vrmaPlaying = false;
  _updateVrmaButtons();
}

function _updateVrmaButtons() {
  const btnPlay  = document.getElementById('btn-vrma-play');
  const btnPause = document.getElementById('btn-vrma-pause');
  const btnStop  = document.getElementById('btn-vrma-stop');
  if (!btnPlay) return;
  btnPlay.disabled  = !vrmaAction || vrmaPlaying;
  btnPause.disabled = !vrmaAction || !vrmaPlaying;
  btnStop.disabled  = !vrmaAction;
}

// ============================================================
// UI Manager
// ============================================================

// VRM読み込み後にアンカーボーン選択ドロップダウンを生成
function _populateAnchorBoneDropdown(vrm) {
  const sel = document.getElementById('anchor-bone-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- ボーンを選択 --</option>';
  if (!vrm?.humanoid) {
    document.getElementById('anchor-section').style.display = 'none';
    document.getElementById('anchor-section-placeholder').style.display = '';
    return;
  }
  // VRM humanoid の全ボーン名を列挙（存在するものだけ）
  const boneNames = [
    'hips','spine','chest','upperChest','neck','head',
    'leftShoulder','leftUpperArm','leftLowerArm','leftHand',
    'rightShoulder','rightUpperArm','rightLowerArm','rightHand',
    'leftUpperLeg','leftLowerLeg','leftFoot','leftToes',
    'rightUpperLeg','rightLowerLeg','rightFoot','rightToes',
  ];
  for (const name of boneNames) {
    if (!vrm.humanoid.getNormalizedBoneNode(name)) continue;
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  document.getElementById('anchor-section').style.display = '';
  document.getElementById('anchor-section-placeholder').style.display = 'none';
}

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
    colorFront:        mantleData.material?.colorFront      ?? '#204080',
    colorBack:         mantleData.material?.colorBack       ?? '#803020',
    roughness:         mantleData.material?.roughness       ?? 1.0,
    sheen:             mantleData.material?.sheen           ?? 1.0,
    sheenRoughness:    mantleData.material?.sheenRoughness  ?? 0.5,
    sheenColor:        mantleData.material?.sheenColor      ?? null,
    opacity:           mantleData.material?.opacity         ?? 0.85,
    quadVertexIds:     mantleData.quadVertexIds     ?? null,
    renderIndices:     mantleData.renderIndices     ?? null,
    renderVertexCount: mantleData.renderVertexCount ?? null,
    mesh:              null,  // マントモード
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
      currentVRMFile = file;
      updateMeshList();
      _populateAnchorBoneDropdown(currentVRM);
      showToast(`VRM 読み込み完了 (${meshes.length} メッシュ)`);
    } catch (err) {
      showToast(`読み込み失敗: ${err.message}`, 'error');
      console.error(err);
    }
  });
  document.getElementById('btn-vrm-load').addEventListener('click', () => fileInput.click());

  // VRMA ドロップダウン + 再生コントロール
  fetch('/vrma/manifest.json')
    .then(r => r.json())
    .then(files => {
      const sel = document.getElementById('vrma-select');
      for (const f of files) {
        const opt = document.createElement('option');
        opt.value = f; opt.textContent = f.replace('.vrma', '');
        sel.appendChild(opt);
      }
    })
    .catch(() => {});

  document.getElementById('btn-vrma-load').addEventListener('click', () => {
    const sel = document.getElementById('vrma-select');
    if (!sel.value) { showToast('VRMAを選択してください', 'warn'); return; }
    currentVRMAName = sel.value;
    loadVRMA(sel.value);
  });
  document.getElementById('btn-vrma-play').addEventListener('click', () => {
    if (!vrmaAction) return;
    vrmaPlaying = true;
    vrmaAction.paused = false;
    _updateVrmaButtons();
  });
  document.getElementById('btn-vrma-pause').addEventListener('click', () => {
    if (!vrmaAction) return;
    vrmaPlaying = false;
    vrmaAction.paused = true;
    _updateVrmaButtons();
  });
  document.getElementById('btn-vrma-stop').addEventListener('click', () => {
    unloadVRMA();
    currentVRMAName = null;
    document.getElementById('vrma-select').value = '';
  });
  document.getElementById('vrma-speed').addEventListener('change', e => {
    if (vrmaAction) vrmaAction.timeScale = parseFloat(e.target.value);
  });

  // ピンモード
  const pinBtn = document.getElementById('btn-pin-mode');
  pinBtn.addEventListener('click', () => {
    pinMode = !pinMode;
    pinBtn.classList.toggle('active', pinMode);
    pinBtn.textContent = pinMode ? 'ピン編集 ON  [P]' : 'ピン編集 OFF [P]';
    // ピンモードON時はグリップ/アンカー編集を解除
    if (pinMode) {
      _setGripEditMode(null);
      anchorEditMode = null;
      const anchorBtn = document.getElementById('btn-anchor-mode');
      if (anchorBtn) { anchorBtn.classList.remove('active'); anchorBtn.textContent = 'アンカー編集 OFF'; }
    }
    controls.enabled = !pinMode && !anchorEditMode && !gripEditMode;
  });
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyP' && !e.ctrlKey && !e.altKey) pinBtn.click();
  });

  document.getElementById('btn-pin-reset').addEventListener('click', () => {
    resetPins();
    showToast('ピンをリセットしました');
  });

  // ボーンアンカーUI
  document.getElementById('btn-anchor-mode').addEventListener('click', () => {
    const sel = document.getElementById('anchor-bone-select');
    if (!sel.value) { showToast('ボーンを選択してください', 'warn'); return; }
    // 同じボーンを再クリックまたはanchorEditModeがすでにONならOFF
    anchorEditMode = anchorEditMode ? null : sel.value;
    const btn = document.getElementById('btn-anchor-mode');
    btn.classList.toggle('active', !!anchorEditMode);
    btn.textContent = anchorEditMode ? `アンカー編集 ON: ${anchorEditMode}` : 'アンカー編集 OFF';
    // アンカー編集ONのときはピン/グリップ編集を解除
    if (anchorEditMode) {
      pinMode = false;
      const pinBtn = document.getElementById('btn-pin-mode');
      if (pinBtn) { pinBtn.classList.remove('active'); pinBtn.textContent = 'ピン編集 OFF [P]'; }
      _setGripEditMode(null);
    }
    controls.enabled = !anchorEditMode && !pinMode && !gripEditMode;
  });
  document.getElementById('btn-anchor-clear').addEventListener('click', clearAnchorMap);

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
  document.getElementById('btn-export-npc').addEventListener('click', exportNPCBundle);

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

  // マント変換スライダー + 数値直接入力（双方向同期）
  const bindTransform = (id, valId, key, toNum, slFmt) => {
    const sl  = document.getElementById(id);
    const num = document.getElementById(valId);

    const apply = v => {
      mantleTransform[key] = v;
      sl.value   = Math.max(parseFloat(sl.min), Math.min(parseFloat(sl.max), v));
      num.value  = slFmt(v);
      if (!simRunning) updateMantleMarkers();
    };

    // スライダー → 数値欄
    sl.addEventListener('input', () => apply(toNum(sl.value)));

    // 数値欄 → スライダー（Enter/Tab/フォーカスアウトで確定）
    num.addEventListener('change', () => {
      const v = toNum(num.value);
      if (isNaN(v)) { num.value = slFmt(mantleTransform[key]); return; }
      apply(v);
    });
  };
  bindTransform('mt-tx',    'mt-tx-val',    'tx',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-ty',    'mt-ty-val',    'ty',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-tz',    'mt-tz-val',    'tz',    parseFloat, v => v.toFixed(2));
  bindTransform('mt-ry',    'mt-ry-val',    'ry',    parseFloat, v => String(Math.round(v)));
  bindTransform('mt-scale', 'mt-scale-val', 'scale', parseFloat, v => v.toFixed(2));

  // ハンドグラブポイント オフセットスライダー
  for (const side of ['left', 'right']) {
    const prefix = side === 'left' ? 'hgp-l' : 'hgp-r';
    for (const axis of ['x', 'y', 'z']) {
      const sl = document.getElementById(`${prefix}-${axis}`);
      const vl = document.getElementById(`${prefix}-${axis}-val`);
      if (!sl) continue;
      sl.addEventListener('input', () => {
        handGrabPoints[side].offset[axis] = parseFloat(sl.value);
        vl.textContent = parseFloat(sl.value).toFixed(2);
      });
    }
  }
  document.getElementById('hgp-visible')?.addEventListener('change', e => {
    for (const side of ['left', 'right']) {
      if (handGrabPoints[side].markerMesh)
        handGrabPoints[side].markerMesh.visible = e.target.checked;
    }
  });
  document.getElementById('btn-hgp-reset')?.addEventListener('click', () => {
    for (const side of ['left', 'right']) {
      handGrabPoints[side].offset.set(0, 0, 0);
      _syncHgpOffsetUI(side);
    }
    showToast('グラブポイントオフセットをリセットしました');
  });

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
  const dt = Math.min(timer.getDelta(), 1 / 20);
  updateFPS();

  // VRMA 再生
  if (mixer && vrmaPlaying) {
    mixer.update(dt);
    currentVRM?.update(dt);
  }

  updateHandGrabPoints();
  updateBoneColliders();

  if (simRunning && simData) {
    const timePerStep = 1 / 360;
    timeSinceLastStep += dt;
    // ボーンスロット座標を更新（ユニークボーン数×vec3、グリップuniform更新と同等のコスト）
    updateAnchorPositions();
    while (timeSinceLastStep >= timePerStep) {
      timeSinceLastStep -= timePerStep;
      renderer.compute(simData.computeSpringForces);
      renderer.compute(simData.computeVertexForces);
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

  // WebGPU チェック
  if (!navigator.gpu) {
    document.getElementById('webgpu-warning').style.display = 'block';
    document.getElementById('btn-sim-start').disabled = true;
  }

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  app.appendChild(renderer.domElement);

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.2, 2.8);

  // ライト（HDR 環境マップが主光源。アンビは控えめのフィル）
  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  // HDR 環境マップ：/cloth と同じ IBL を scene.environment に設定し、
  // roughness=1.0 + sheen=1.0 の MeshPhysicalNodeMaterial にマント質感を与える。
  // 背景はエディタ用に暗いまま維持（マントの見た目は scene.environment のみで決まる）。
  try {
    const hdrTexture = await new UltraHDRLoader().loadAsync(
      'https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg',
    );
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment  = hdrTexture;
  } catch {
    // オフライン時は従来のアンビ強度に戻す
    ambient.intensity = 1.2;
  }

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
  setupGripKeyEvents();

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
