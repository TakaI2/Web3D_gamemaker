// cloth-preview.js
// VRM + VRMA アニメーション + マント布シミュ + タイムライン編集

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float, vec3,
  triNoise3D, time, frontFacing,
} from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls }    from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }       from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin }  from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation?deps=three@0.184.0,@pixiv/three-vrm@3.4.0';

// ── 定数 ─────────────────────────────────────────────────────────
const MAX_COLLIDERS = 16;

// ── シーングローバル ─────────────────────────────────────────────
let renderer, scene, camera, controls;
const timer = new THREE.Timer();

// ── VRM 状態 ─────────────────────────────────────────────────────
let currentVRM = null;

// ── マント状態 ───────────────────────────────────────────────────
let mantleData    = null;
let mantleOrigPos = null;
const mantleTransform = { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 };

// ── グリップセット（マントJSONから復元）─────────────────────────
const leftGripSet  = new Set();
const rightGripSet = new Set();

// ── ボーンアンカー（マントJSONから復元）─────────────────────────
// vertexIdx → { boneName, boneNode, localOffset: THREE.Vector3 }
const anchorMap = new Map();

// ── シミュレーション状態 ─────────────────────────────────────────
let simRunning = false;
let simData    = null;
let timeSinceLastStep = 0;

// ── 共有 uniform ─────────────────────────────────────────────────
let stiffnessUniform;
let dampeningUniform;
let windUniform;

// ── コライダー ───────────────────────────────────────────────────
const colliders        = [];
const colliderDataArr  = new Float32Array(MAX_COLLIDERS * 4);
let colliderCountUniform = null;
let colliderDataBuffer   = null;
let savedColliderData    = null;   // 読み込んだ cloth/bundle のコライダー設定 [{ boneName, r, offset }]

// ── ハンドグラブポイント ─────────────────────────────────────────
const handGrabPoints = {
  left:  { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false },
  right: { boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false },
};
let _hgpDragSide = null;
const _hgpDragPlane     = new THREE.Plane();
const _hgpDragRaycaster = new THREE.Raycaster();

// ── VRMA プレイヤー ──────────────────────────────────────────────
let mixer      = null;
let vrmaClip   = null;
let vrmaAction = null;
let vrmaPlaying = false;
let vrmaLoop    = true;

// ── Readback（HGPドラッグ用スナップショット）───────────────────
const grab = { snapshot: null, snapshotPending: false, snapshotAge: 999 };

// ── タイムライン状態 ─────────────────────────────────────────────
const timeline = {
  fps:           30,
  durationFrames: 90,
  currentFrame:  0,
  grip: {
    left:  [],  // [{start, end}] — グリップ有効範囲
    right: [],
  },
  blendShape: new Map(),  // name → Map<frame, value>
  selected:   null,       // { kind, name?, frame } | null
};

// ── タイムライン Canvas 状態 ─────────────────────────────────────
let tlPxPerFrame = 8;
let tlScrollX    = 0;

const HEADER_W = 160;
const ROW_H    = 22;
const RULER_H  = 24;
const GRIP_ROWS = [
  { kind: 'grip', side: 'left',  label: 'Grip L', color: '#44aaff' },
  { kind: 'grip', side: 'right', label: 'Grip R', color: '#ff6644' },
];

// ── イベントディスパッチ ─────────────────────────────────────────
let _lastDispatchedFrame = -1;

// ── FPS カウンター ───────────────────────────────────────────────
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

    scene.add(vrm.scene);
    vrm.scene.updateMatrixWorld(true);

    buildCollidersFromVRM(vrm);
    initHandGrabPoints(vrm);
    populateBlendShapeDropdown(vrm);

    document.getElementById('btn-vrma-load').disabled = false;
    document.getElementById('vrma-select').disabled = false;
    showToast('VRM 読み込み完了');
    return vrm;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function unloadVRM() {
  if (!currentVRM) return;
  unloadVRMA();
  disposeSimulation();
  clearMantle();
  clearColliders();
  disposeHandGrabPoints();

  scene.remove(currentVRM.scene);
  currentVRM.scene.traverse(obj => {
    if (obj.isMesh) {
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m?.dispose();
    }
  });
  currentVRM = null;

  const sel = document.getElementById('bs-select');
  if (sel) sel.innerHTML = '<option value="">-- VRM読込後 --</option>';
  document.getElementById('btn-vrma-load').disabled = true;
  const vsel = document.getElementById('vrma-select');
  if (vsel) vsel.disabled = true;
}

// ============================================================
// Collider Manager
// ============================================================

const BONE_COLLIDER_DEFS = [
  { bone: 'head',          r: 0.10 },
  { bone: 'neck',          r: 0.06 },
  { bone: 'chest',         r: 0.14 },
  { bone: 'spine',         r: 0.12 },
  { bone: 'hips',          r: 0.13 },
  { bone: 'leftShoulder',  r: 0.07 },
  { bone: 'rightShoulder', r: 0.07 },
  { bone: 'upperChest',    r: 0.13 },
  { bone: 'leftUpperLeg',  r: 0.09 },
  { bone: 'rightUpperLeg', r: 0.09 },
  { bone: 'leftLowerLeg',  r: 0.07 },
  { bone: 'rightLowerLeg', r: 0.07 },
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
    // 保存済み設定があれば半径・ボーンローカルオフセットを復元（無ければ既定）
    const saved = savedColliderData?.find(s => s.boneName === def.bone);
    const r           = saved ? saved.r : def.r;
    const localOffset = (saved && saved.offset) ? new THREE.Vector3(...saved.offset) : new THREE.Vector3();
    const world = tmp.clone().add(localOffset.clone().applyQuaternion(quat));
    addCollider(world.x, world.y, world.z, r, node, def.bone, localOffset);
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  syncColliderDataArr();
}

function addCollider(x, y, z, r, boneNode = null, boneName = null, localOffset = null) {
  const geo  = new THREE.SphereGeometry(1, 12, 8);
  const mat  = new THREE.MeshBasicMaterial({
    color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.25,
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
    colliderDataArr[i*4]   = c.x;
    colliderDataArr[i*4+1] = c.y;
    colliderDataArr[i*4+2] = c.z;
    colliderDataArr[i*4+3] = c.r;
  }
  if (colliderDataBuffer) {
    colliderDataBuffer.value.array.set(colliderDataArr);
    colliderDataBuffer.value.needsUpdate = true;
  }
  if (colliderCountUniform) colliderCountUniform.value = colliders.length;
}

// ============================================================
// Hand Grab Points
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
    document.getElementById('hgp-section').style.display = '';
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
  }
  _hgpDragSide = null;
  document.getElementById('hgp-section').style.display = 'none';
}

function updateHandGrabPoints() {
  for (const side of ['left', 'right']) {
    const hp = handGrabPoints[side];
    if (!hp.boneNode) continue;
    hp.boneNode.getWorldPosition(hp.worldPos);
    hp.worldPos.add(hp.offset);
    if (hp.markerMesh) hp.markerMesh.position.copy(hp.worldPos);
    // アクティブなグリップのターゲットを毎フレーム追従更新
    if (simData && hp.active) {
      if (side === 'left') simData.leftGripTargetUniform.value.copy(hp.worldPos);
      else                 simData.rightGripTargetUniform.value.copy(hp.worldPos);
    }
  }
}

const _anchorTmp      = new THREE.Vector3();
const _anchorBoneQuat = new THREE.Quaternion();
const _anchorWorldOff = new THREE.Vector3();

const _colliderTmp = new THREE.Vector3();
const _colliderQuat = new THREE.Quaternion();
function updateBoneColliders() {
  let changed = false;
  for (const c of colliders) {
    if (!c.boneNode) continue;
    c.boneNode.getWorldPosition(_colliderTmp);
    // 保存されたボーンローカルオフセットを反映してボーン追従
    if (c.localOffset && c.localOffset.lengthSq() > 0) {
      c.boneNode.getWorldQuaternion(_colliderQuat);
      _colliderTmp.add(c.localOffset.clone().applyQuaternion(_colliderQuat));
    }
    if (c.x === _colliderTmp.x && c.y === _colliderTmp.y && c.z === _colliderTmp.z) continue;
    c.x = _colliderTmp.x;
    c.y = _colliderTmp.y;
    c.z = _colliderTmp.z;
    c.helperMesh.position.copy(_colliderTmp);
    changed = true;
  }
  if (changed) syncColliderDataArr();
}

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

function _syncHgpOffsetUI(side) {
  const hp     = handGrabPoints[side];
  const prefix = side === 'left' ? 'hgp-l' : 'hgp-r';
  for (const axis of ['x', 'y', 'z']) {
    const sl = document.getElementById(`${prefix}-${axis}`);
    const vl = document.getElementById(`${prefix}-${axis}-val`);
    if (sl) sl.value       = hp.offset[axis].toFixed(3);
    if (vl) vl.textContent = hp.offset[axis].toFixed(2);
  }
}

// ============================================================
// Mantle Loader
// ============================================================

function applyMantleTransform(origPos, vertexCount, tr) {
  const out  = new Float32Array(vertexCount * 3);
  const cosY = Math.cos(tr.ry * Math.PI / 180);
  const sinY = Math.sin(tr.ry * Math.PI / 180);
  for (let i = 0; i < vertexCount; i++) {
    const x = origPos[i*3]   * tr.scale;
    const y = origPos[i*3+1] * tr.scale;
    const z = origPos[i*3+2] * tr.scale;
    out[i*3]   = x * cosY - z * sinY + tr.tx;
    out[i*3+1] = y + tr.ty;
    out[i*3+2] = x * sinY + z * cosY + tr.tz;
  }
  return out;
}

function loadMantleJSON(json) {
  if (json.version !== 1 || !json.positions || !json.springs || !json.indices) {
    throw new Error('無効なマントファイルです');
  }
  clearMantle();
  mantleData    = json;
  mantleOrigPos = new Float32Array(json.positions);

  // エディタで保存したトランスフォームを引き継ぐ
  if (json.editorTransform) {
    Object.assign(mantleTransform, json.editorTransform);
  } else {
    Object.assign(mantleTransform, { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 });
  }

  leftGripSet.clear();
  rightGripSet.clear();
  if (json.leftGripIndices)  for (const idx of json.leftGripIndices)  leftGripSet.add(idx);
  if (json.rightGripIndices) for (const idx of json.rightGripIndices) rightGripSet.add(idx);

  // ボーンアンカー復元（VRM読込済みの場合のみ）
  anchorMap.clear();
  const anchorData = json.anchorAssignments ?? json.pinnedBoneAssignments;
  if (anchorData && currentVRM) {
    for (const entry of anchorData) {
      const { vertexIdx, boneName } = entry;
      const boneNode = currentVRM.humanoid?.getNormalizedBoneNode(boneName);
      if (!boneNode) continue;
      let localOffset;
      if (entry.localOffset) {
        localOffset = new THREE.Vector3(...entry.localOffset);
      } else if (entry.offset) {
        const boneQuat = new THREE.Quaternion();
        boneNode.getWorldQuaternion(boneQuat);
        localOffset = new THREE.Vector3(...entry.offset).applyQuaternion(boneQuat.invert());
      } else { continue; }
      anchorMap.set(vertexIdx, { boneName, boneNode, localOffset });
    }
  }

  // HGPオフセット復元
  if (json.handGrabOffsets) {
    for (const side of ['left', 'right']) {
      const v = json.handGrabOffsets[side];
      if (v) handGrabPoints[side].offset.set(v[0], v[1], v[2]);
    }
    _syncHgpOffsetUI('left');
    _syncHgpOffsetUI('right');
  }

  // コライダー設定（半径・ボーンローカルオフセット）を復元してボーンから再構築
  savedColliderData = json.colliders ?? null;
  if (savedColliderData && currentVRM) buildCollidersFromVRM(currentVRM);

  // 初期メッシュをシーンに追加（シミュ未実行で静止表示）
  simData = buildSimulation(_buildMantleAnalysis());
  // simRunning は false のままにしておく

  showToast(`マント読み込み完了 (${json.vertexCount}頂点 / L手:${leftGripSet.size} R手:${rightGripSet.size} アンカー:${anchorMap.size})`);
}

// dataURI(base64) → Blob
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// NPCバンドル(.npc.json)を一括読込：VRM → マント(cloth) → VRMA → timeline。
async function importNPCBundle(bundle) {
  if (!bundle || !bundle.vrm) { showToast('VRM を含まないファイルです', 'error'); return; }
  const name = bundle.name || 'imported';
  showToast('NPC読み込み中…');
  try {
    // 1) VRM（先に読む＝マントのボーンアンカー解決に必要）
    await loadVRM(new File([dataURIToBlob(bundle.vrm)], `${name}.vrm`, { type: 'application/octet-stream' }));
    // 2) マント（cloth）
    if (bundle.cloth) loadMantleJSON(bundle.cloth);
    // 3) VRMA（埋め込み）
    if (bundle.vrma) {
      try { await loadVRMA(new File([dataURIToBlob(bundle.vrma)], `${name}.vrma`, { type: 'application/octet-stream' })); }
      catch (e) { console.warn('VRMA 復元失敗', e); }
    }
    // 4) timeline
    if (bundle.timeline) { try { importTimeline(bundle.timeline); } catch (e) { console.warn('timeline 復元失敗', e); } }
    const parts = ['VRM', bundle.cloth ? 'マント' : null, bundle.vrma ? 'VRMA' : null, bundle.timeline ? 'TL' : null].filter(Boolean);
    showToast(`NPC読み込み完了（${parts.join(' + ')}）`);
  } catch (err) {
    showToast(`NPC読み込み失敗: ${err.message}`, 'error');
    console.error(err);
  }
}

function clearMantle() {
  if (simRunning) stopSim();
  disposeSimulation();
  leftGripSet.clear();
  rightGripSet.clear();
  anchorMap.clear();
  mantleData    = null;
  mantleOrigPos = null;
  Object.assign(mantleTransform, { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1.0 });
}

function _buildMantleAnalysis() {
  const transformed = applyMantleTransform(mantleOrigPos, mantleData.vertexCount, mantleTransform);
  const m = mantleData.material ?? {};
  return {
    positions:      transformed,
    vertexCount:    mantleData.vertexCount,
    springs:        mantleData.springs,
    springCount:    mantleData.springs.length / 2,
    indices:        mantleData.indices,
    colorFront:     m.colorFront      ?? '#204080',
    colorBack:      m.colorBack       ?? '#803020',
    roughness:      m.roughness       ?? 0.85,
    sheen:          m.sheen           ?? 0.8,
    sheenRoughness: m.sheenRoughness  ?? 0.5,
    sheenColor:     m.sheenColor      ?? null,
    mesh:           null,
  };
}

// ============================================================
// Cloth Simulator
// ============================================================

function buildSimulation(analysis) {
  const { positions, vertexCount, springs, springCount } = analysis;

  const vertexSpringIds = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) {
    vertexSpringIds[springs[s*2]    ].push(s);
    vertexSpringIds[springs[s*2 + 1]].push(s);
  }

  // ボーンアンカー: 頂点ごとの初期ターゲット座標を事前計算
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

  const springListArray  = [];
  const vertexParamsArr  = new Uint32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const isFixed = 0;
    let gripCode = 0;
    if (anchorMap.has(i))       gripCode = 3;
    else if (leftGripSet.has(i))  gripCode = 1;
    else if (rightGripSet.has(i)) gripCode = 2;
    vertexParamsArr[i*4]   = isFixed;
    vertexParamsArr[i*4+3] = gripCode;
    vertexParamsArr[i*4+1] = vertexSpringIds[i].length;
    vertexParamsArr[i*4+2] = springListArray.length;
    for (const sid of vertexSpringIds[i]) springListArray.push(sid);
  }

  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);
  for (let s = 0; s < springCount; s++) {
    const v0 = springs[s*2], v1 = springs[s*2 + 1];
    springVertIdArr[s*2]   = v0;
    springVertIdArr[s*2+1] = v1;
    const dx = positions[v0*3]   - positions[v1*3];
    const dy = positions[v0*3+1] - positions[v1*3+1];
    const dz = positions[v0*3+2] - positions[v1*3+2];
    springRestLenArr[s] = Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  const vertexPositionBuffer   = instancedArray(positions.slice(), 'vec3').setPBO(true);
  const vertexForceBuffer      = instancedArray(vertexCount, 'vec3');
  const vertexParamsBuffer     = instancedArray(vertexParamsArr, 'uvec4');
  const springListBuffer       = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true);
  const springVertexIdBuffer   = instancedArray(springVertIdArr, 'uvec2').setPBO(true);
  const springRestLengthBuffer = instancedArray(springRestLenArr, 'float');
  const springForceBuffer      = instancedArray(springCount * 3, 'vec3').setPBO(true);

  syncColliderDataArr();
  colliderDataBuffer   = instancedArray(colliderDataArr.slice(), 'vec4');
  colliderCountUniform = uniform(colliders.length);

  const bonePinTargetBuffer = hasBonePins ? instancedArray(bonePinTargetArr, 'vec3') : null;

  const leftGripActiveUniform  = uniform(0);
  const rightGripActiveUniform = uniform(0);
  const leftGripTargetUniform  = uniform(new THREE.Vector3());
  const rightGripTargetUniform = uniform(new THREE.Vector3());

  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('CP_Spring');

  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;
    const gripCode      = vparams.w;

    If(isFixed, () => { Return(); });

    If(leftGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(1), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(leftGripTargetUniform);
        Return();
      });
    });
    If(rightGripActiveUniform.greaterThan(0.5), () => {
      If(gripCode.equal(2), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(rightGripTargetUniform);
        Return();
      });
    });

    // ボーンアンカー（gripCode == 3）
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

    force.y.subAssign(0.00005);
    const noise     = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    const windForce = noise.mul(windUniform);
    force.z.subAssign(windForce);

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
  })().compute(vertexCount).setName('CP_Vertex');

  // 布メッシュ生成（マントモード固定）
  const vidArr = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vidArr[i] = i;

  const posNode = Fn(() =>
    vertexPositionBuffer.element(attribute('vertexId', 'uint'))
  )();

  const clothGeo = new THREE.BufferGeometry();
  clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));
  clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(analysis.indices), 1));

  const fc = analysis.colorFront ?? '#204080';
  const bc = analysis.colorBack  ?? '#803020';
  const clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:          THREE.DoubleSide,
    roughness:     analysis.roughness     ?? 0.85,
    sheen:         analysis.sheen         ?? 0.8,
    sheenRoughness: analysis.sheenRoughness ?? 0.5,
  });
  if (analysis.sheenColor) clothMat.sheenColor = new THREE.Color(analysis.sheenColor);
  clothMat.colorNode    = select(frontFacing, uniform(new THREE.Color(fc)), uniform(new THREE.Color(bc)));
  clothMat.positionNode = posNode;

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);

  return {
    vertexPositionBuffer,
    vertexCount,
    computeSpringForces,
    computeVertexForces,
    bonePinTargetBuffer,
    clothMesh, clothGeo, clothMat,
    leftGripActiveUniform, rightGripActiveUniform,
    leftGripTargetUniform, rightGripTargetUniform,
    cpuPositions: positions.slice(),
  };
}

function disposeSimulation() {
  if (!simData) return;
  scene.remove(simData.clothMesh);
  simData.clothGeo.dispose();
  simData.clothMat.dispose();
  simData             = null;
  simRunning          = false;
  colliderDataBuffer  = null;
  colliderCountUniform = null;
  grab.snapshotAge    = 999;
}

function scheduleReadbacks() {
  if (!simData) return;
  grab.snapshotAge = (grab.snapshotAge ?? 999) + 1;
  if (grab.snapshotAge < 30 || grab.snapshotPending) return;
  grab.snapshotAge     = 0;
  grab.snapshotPending = true;
  renderer.getArrayBufferAsync(simData.vertexPositionBuffer.value)
    .then(ab => {
      grab.snapshot        = new Float32Array(ab);
      grab.snapshotPending = false;
    })
    .catch(() => { grab.snapshotPending = false; });
}

function startSim() {
  if (!mantleData) { showToast('マントを読み込んでください', 'error'); return; }
  if (simRunning)  return;
  // 読み込み時に既に buildSimulation 済みなので再ビルド不要
  if (!simData) simData = buildSimulation(_buildMantleAnalysis());
  simRunning = true;
  document.getElementById('btn-sim-start').disabled = true;
  document.getElementById('btn-sim-stop').disabled  = false;
}

function stopSim() {
  simRunning = false;
  document.getElementById('btn-sim-start').disabled = false;
  document.getElementById('btn-sim-stop').disabled  = true;
}

// ============================================================
// HGP Drag Events（マーカー球ドラッグでオフセット微調整）
// ============================================================

function setupGrabEvents(canvas) {
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    for (const side of ['left', 'right']) {
      const hp = handGrabPoints[side];
      if (!hp.markerMesh) continue;
      const p    = hp.worldPos.clone().project(camera);
      if (p.z > 1) continue;
      const rect = canvas.getBoundingClientRect();
      const sx = (p.x *  0.5 + 0.5) * rect.width  + rect.left;
      const sy = (p.y * -0.5 + 0.5) * rect.height + rect.top;
      if (Math.hypot(sx - e.clientX, sy - e.clientY) < 22) {
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
  }, { capture: true });

  canvas.addEventListener('pointermove', e => {
    if (!_hgpDragSide) return;
    const rect = canvas.getBoundingClientRect();
    _hgpDragRaycaster.setFromCamera(
      { x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1 },
      camera,
    );
    const hit = new THREE.Vector3();
    if (_hgpDragRaycaster.ray.intersectPlane(_hgpDragPlane, hit)) {
      const hp = handGrabPoints[_hgpDragSide];
      const bonePos = new THREE.Vector3();
      hp.boneNode.getWorldPosition(bonePos);
      hp.offset.copy(hit).sub(bonePos).clampScalar(-0.3, 0.3);
      _syncHgpOffsetUI(_hgpDragSide);
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (!_hgpDragSide) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    _hgpDragSide     = null;
    controls.enabled = true;
    canvas.style.cursor = '';
  });

  canvas.addEventListener('pointercancel', () => {
    if (!_hgpDragSide) return;
    _hgpDragSide     = null;
    controls.enabled = true;
    canvas.style.cursor = '';
  });
}

// ============================================================
// VRMA Player
// ============================================================

async function loadVRMA(file) {
  if (!currentVRM) { showToast('先にVRMを読み込んでください', 'error'); return; }
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrmAnims = gltf.userData.vrmAnimations;
    if (!vrmAnims?.length) throw new Error('VRMAアニメーションデータが見つかりません');

    unloadVRMA();
    vrmaClip   = createVRMAnimationClip(vrmAnims[0], currentVRM);
    mixer      = new THREE.AnimationMixer(currentVRM.scene);
    vrmaAction = mixer.clipAction(vrmaClip);
    vrmaAction.timeScale = 1.0;
    vrmaSetLoop(vrmaLoop);
    vrmaAction.play();
    vrmaAction.paused = true;  // 読み込み直後は停止

    // タイムライン尺を更新
    timeline.durationFrames = Math.round(vrmaClip.duration * timeline.fps);
    document.getElementById('lbl-duration').textContent = timeline.durationFrames.toString();

    document.getElementById('btn-play').disabled  = false;
    document.getElementById('btn-pause').disabled = false;
    renderTimeline();
    showToast(`VRMA 読み込み完了 (${timeline.durationFrames}フレーム)`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function vrmaPlay() {
  if (!mixer || !vrmaAction) return;
  if (vrmaPlaying) return;
  vrmaPlaying = true;
  vrmaAction.paused = false;
  _lastDispatchedFrame = timeline.currentFrame - 1;
  updatePlayButtons();
}

function vrmaPause() {
  if (!vrmaPlaying) return;
  vrmaPlaying = false;
  if (vrmaAction) vrmaAction.paused = true;
  updatePlayButtons();
}

function vrmaSeek(frame) {
  const clampedFrame = Math.max(0, Math.min(frame, timeline.durationFrames));
  timeline.currentFrame = clampedFrame;
  _lastDispatchedFrame  = clampedFrame;

  if (mixer && vrmaAction && vrmaClip) {
    const t = clampedFrame / timeline.fps;
    vrmaAction.time = Math.min(t, vrmaClip.duration);
    mixer.update(0);
  }

  applyBlendShapesAt(clampedFrame);
  updateFrameLabel();
  renderTimeline();
}

function vrmaSetSpeed(speed) {
  if (vrmaAction) vrmaAction.timeScale = speed;
}

function vrmaSetLoop(enabled) {
  vrmaLoop = enabled;
  if (vrmaAction) {
    if (enabled) {
      vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      vrmaAction.setLoop(THREE.LoopOnce, 1);
      vrmaAction.clampWhenFinished = true;
    }
  }
}

function unloadVRMA() {
  if (vrmaAction) vrmaAction.stop();
  if (mixer)      mixer.stopAllAction();
  mixer      = null;
  vrmaClip   = null;
  vrmaAction = null;
  vrmaPlaying          = false;
  _lastDispatchedFrame = -1;
  document.getElementById('btn-play').disabled  = true;
  document.getElementById('btn-pause').disabled = true;
}

function updatePlayButtons() {
  document.getElementById('btn-play').disabled  = !mixer || vrmaPlaying;
  document.getElementById('btn-pause').disabled = !mixer || !vrmaPlaying;
}

// ============================================================
// Timeline State Management
// ============================================================

function addGripRange(side, start, end) {
  const s = Math.min(start, end), e = Math.max(start, end);
  timeline.grip[side].push({ start: s, end: e });
  timeline.grip[side].sort((a, b) => a.start - b.start);
}

function removeGripRangeAt(side, frame) {
  const ranges = timeline.grip[side];
  const idx = ranges.findIndex(r => frame >= r.start && frame <= r.end);
  if (idx >= 0) ranges.splice(idx, 1);
}

function gripActiveAt(side, frame) {
  return timeline.grip[side].some(r => frame >= r.start && frame <= r.end);
}

function addBlendShapeTrack(name) {
  if (!name) return;
  if (timeline.blendShape.has(name)) {
    showToast(`"${name}" は既に追加されています`, 'warn');
    return;
  }
  timeline.blendShape.set(name, new Map());
  renderTimeline();
  showToast(`"${name}" トラックを追加しました`);
}

function setBlendShapeKF(name, frame, value) {
  const kfMap = timeline.blendShape.get(name);
  if (!kfMap) return;
  kfMap.set(frame, Math.max(0, Math.min(1, value)));
}

function removeBlendShapeKF(name, frame) {
  const kfMap = timeline.blendShape.get(name);
  if (!kfMap) return;
  kfMap.delete(frame);
  if (timeline.selected?.kind === 'blendShape' &&
      timeline.selected.name === name && timeline.selected.frame === frame) {
    timeline.selected = null;
    document.getElementById('kf-section').style.display = 'none';
  }
  renderTimeline();
}

function selectBlendShapeKF(name, frame) {
  const kfMap = timeline.blendShape.get(name);
  if (!kfMap?.has(frame)) return;
  timeline.selected = { kind: 'blendShape', name, frame };
  document.getElementById('kf-section').style.display = '';
  document.getElementById('kf-label').textContent = `${name} @ ${frame}f`;
  document.getElementById('kf-value').value = kfMap.get(frame).toFixed(2);
}

function exportTimeline() {
  const tracks = [];
  for (const side of ['left', 'right']) {
    if (timeline.grip[side].length > 0)
      tracks.push({ kind: 'grip', side, ranges: timeline.grip[side].map(r => ({ ...r })) });
  }
  for (const [name, kfMap] of timeline.blendShape) {
    if (kfMap.size > 0) {
      tracks.push({
        kind: 'blendShape', name,
        keyframes: [...kfMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([frame, value]) => ({ frame, value })),
      });
    }
  }
  return { version: 2, fps: timeline.fps, durationFrames: timeline.durationFrames, tracks };
}

function importTimeline(json) {
  if (!Array.isArray(json.tracks)) throw new Error('無効なタイムラインファイルです');
  timeline.grip.left  = [];
  timeline.grip.right = [];
  timeline.blendShape.clear();
  timeline.selected = null;

  if (json.fps)            timeline.fps            = json.fps;
  if (json.durationFrames) timeline.durationFrames = json.durationFrames;

  for (const track of json.tracks) {
    if (track.kind === 'grip') {
      if (track.side && Array.isArray(track.ranges)) {
        // v2形式: ranges
        for (const r of track.ranges) timeline.grip[track.side].push({ start: r.start, end: r.end });
      } else if (track.type && Array.isArray(track.frames)) {
        // v1旧形式: 単一フレームをそのまま1フレーム範囲として読み込み
        const side = track.type.includes('Left') || track.type === 'gripLeft' ? 'left' : 'right';
        if (track.type === 'gripLeft' || track.type === 'gripRight') {
          for (const f of track.frames) timeline.grip[side].push({ start: f, end: f });
        }
        // releaseLeft/releaseRight は無視
      }
    } else if (track.kind === 'blendShape') {
      const kfMap = new Map();
      if (Array.isArray(track.keyframes)) {
        for (const { frame, value } of track.keyframes) kfMap.set(frame, value);
      }
      timeline.blendShape.set(track.name, kfMap);
    }
    // 未知の kind は無視（将来の effect トラック拡張用）
  }

  document.getElementById('lbl-duration').textContent = timeline.durationFrames.toString();
  document.getElementById('kf-section').style.display = 'none';
  renderTimeline();
}

// ============================================================
// Timeline Canvas 描画
// ============================================================

function allRows() {
  const rows = [...GRIP_ROWS];
  for (const name of timeline.blendShape.keys()) {
    rows.push({ kind: 'blendShape', name, label: name, color: '#44ee88' });
  }
  return rows;
}

function frameToX(frame) {
  return HEADER_W + frame * tlPxPerFrame - tlScrollX;
}

function xToFrame(x) {
  return Math.round((x - HEADER_W + tlScrollX) / tlPxPerFrame);
}

function rowToY(rowIdx) {
  return RULER_H + rowIdx * ROW_H;
}

function renderTimeline() {
  const canvas = document.getElementById('timeline');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const rows = allRows();

  // 背景
  ctx.fillStyle = '#08081a';
  ctx.fillRect(0, 0, W, H);

  // フレームグリッド（10f ごと）
  const startF = Math.max(0, Math.floor(tlScrollX / tlPxPerFrame));
  const endF   = Math.ceil((tlScrollX + W - HEADER_W) / tlPxPerFrame);
  for (let f = startF; f <= endF; f++) {
    const x = frameToX(f);
    if (x < HEADER_W) continue;
    if (f % 10 === 0) {
      ctx.strokeStyle = '#1c1c32';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
    } else if (tlPxPerFrame >= 12 && f % 5 === 0) {
      ctx.strokeStyle = '#14142a';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  // トラック行
  rows.forEach((row, ri) => {
    const y = rowToY(ri);

    // 行背景
    ctx.fillStyle = ri % 2 === 0 ? '#0d0d20' : '#0f0f25';
    ctx.fillRect(HEADER_W, y, W - HEADER_W, ROW_H);

    // ヘッダー背景
    ctx.fillStyle = '#0a0a18';
    ctx.fillRect(0, y, HEADER_W, ROW_H);

    // ラベル
    ctx.fillStyle = row.color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(row.label ?? row.name, 6, y + ROW_H - 6);

    // 区切り線
    ctx.strokeStyle = '#181830';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H - 0.5);
    ctx.lineTo(W, y + ROW_H - 0.5);
    ctx.stroke();

    if (row.kind === 'grip') {
      const ranges = timeline.grip[row.side];
      for (const r of ranges) {
        const x0 = Math.max(HEADER_W, frameToX(r.start));
        const x1 = Math.min(W, frameToX(r.end + 1));
        if (x1 < HEADER_W || x0 > W) continue;
        // バー塗りつぶし
        ctx.fillStyle = row.color + '55';
        ctx.fillRect(x0, y + 3, x1 - x0, ROW_H - 6);
        ctx.strokeStyle = row.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0, y + 3, x1 - x0, ROW_H - 6);
        // 端のハンドル
        ctx.fillStyle = row.color;
        ctx.fillRect(x0, y + 3, 3, ROW_H - 6);
        ctx.fillRect(x1 - 3, y + 3, 3, ROW_H - 6);
      }
      // ドラッグ中プレビュー
      if (_gripDrag?.side === row.side) {
        const s = Math.min(_gripDrag.startFrame, _gripDrag.endFrame);
        const e = Math.max(_gripDrag.startFrame, _gripDrag.endFrame);
        const x0 = Math.max(HEADER_W, frameToX(s));
        const x1 = Math.min(W, frameToX(e + 1));
        ctx.fillStyle = row.color + '33';
        ctx.fillRect(x0, y + 3, x1 - x0, ROW_H - 6);
        ctx.strokeStyle = row.color + 'aa';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0, y + 3, x1 - x0, ROW_H - 6);
        ctx.setLineDash([]);
      }
    } else if (row.kind === 'blendShape') {
      const kfMap = timeline.blendShape.get(row.name);
      if (!kfMap || kfMap.size === 0) return;
      const sortedKeys = [...kfMap.keys()].sort((a, b) => a - b);

      // 補間折れ線
      if (sortedKeys.length >= 2) {
        ctx.strokeStyle = row.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let first = true;
        const step = Math.max(1, Math.round(1 / tlPxPerFrame));
        for (let f = sortedKeys[0]; f <= sortedKeys[sortedKeys.length - 1]; f += step) {
          const x = frameToX(f);
          if (x < HEADER_W - 1) { first = true; continue; }
          if (x > W + 1) break;
          const val = interpolateBlendShape(kfMap, f);
          const yv  = y + ROW_H - 4 - val * (ROW_H - 8);
          if (first) { ctx.moveTo(x, yv); first = false; } else ctx.lineTo(x, yv);
        }
        ctx.stroke();
      }

      // キーフレーム丸マーカー
      for (const f of sortedKeys) {
        const x = frameToX(f);
        if (x < HEADER_W - 8 || x > W + 8) continue;
        const val = kfMap.get(f);
        const yv  = y + ROW_H - 4 - val * (ROW_H - 8);
        const sel = timeline.selected?.kind === 'blendShape' &&
                    timeline.selected.name === row.name &&
                    timeline.selected.frame === f;
        ctx.fillStyle = sel ? '#ffee00' : row.color;
        ctx.beginPath(); ctx.arc(x, yv, 5, 0, Math.PI * 2); ctx.fill();
        if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }
    }
  });

  // ルーラー
  ctx.fillStyle = '#10102a';
  ctx.fillRect(0, 0, W, RULER_H);

  const tickEvery = tlPxPerFrame >= 8 ? 10 : tlPxPerFrame >= 4 ? 30 : 60;
  ctx.fillStyle   = '#556';
  ctx.font        = '10px monospace';
  ctx.textAlign   = 'center';
  for (let f = 0; f <= timeline.durationFrames + tickEvery; f += tickEvery) {
    const x = frameToX(f);
    if (x < HEADER_W || x > W) continue;
    ctx.fillStyle = '#666';
    ctx.fillText(f.toString(), x, RULER_H - 5);
    ctx.fillStyle = '#444';
    ctx.fillRect(x - 0.5, RULER_H - 14, 1, 9);
  }

  // 区切り線
  ctx.strokeStyle = '#2a2a44';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(HEADER_W - 0.5, 0); ctx.lineTo(HEADER_W - 0.5, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(W, RULER_H - 0.5); ctx.stroke();

  // プレイヘッド
  _drawPlayhead(ctx, W, H);
}

function _drawPlayhead(ctx, W, H) {
  const x = frameToX(timeline.currentFrame);
  if (x < HEADER_W - 1 || x > W + 1) return;
  ctx.strokeStyle = '#ff3333';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.fillStyle = '#ff3333';
  ctx.beginPath();
  ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 8);
  ctx.closePath(); ctx.fill();
}

function renderTimelinePlayhead() {
  renderTimeline();
}

// ============================================================
// Timeline Interaction Events
// ============================================================

function screenToTrack(offsetX, offsetY) {
  if (offsetX < HEADER_W || offsetY < RULER_H) return null;
  const rows   = allRows();
  const rowIdx = Math.floor((offsetY - RULER_H) / ROW_H);
  if (rowIdx < 0 || rowIdx >= rows.length) return null;
  const frame = xToFrame(offsetX);
  if (frame < 0 || frame > timeline.durationFrames) return null;
  return { row: rows[rowIdx], rowIdx, frame };
}

let _gripDrag = null; // { side, startFrame, endFrame }

function setupTimelineEvents(canvas) {
  let _tlDragging = false;

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // ルーラードラッグ → シーク
    if (y < RULER_H && x >= HEADER_W) {
      _tlDragging = true;
      const f = Math.max(0, Math.min(xToFrame(x), timeline.durationFrames));
      vrmaSeek(f);
      return;
    }

    if (e.button !== 0) return;
    const hit = screenToTrack(x, y);
    if (!hit) return;
    const { row, frame } = hit;

    if (row.kind === 'grip') {
      // ドラッグ開始（マウスアップまで範囲確定しない）
      _gripDrag = { side: row.side, startFrame: frame, endFrame: frame };
      renderTimeline();
    } else if (row.kind === 'blendShape') {
      const kfMap = timeline.blendShape.get(row.name);
      if (!kfMap) return;
      if (kfMap.has(frame)) {
        selectBlendShapeKF(row.name, frame);
      } else {
        setBlendShapeKF(row.name, frame, 1.0);
        selectBlendShapeKF(row.name, frame);
      }
      renderTimeline();
    }
  });

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const f = Math.max(0, Math.min(xToFrame(x), timeline.durationFrames));
    if (_tlDragging) {
      vrmaSeek(f);
      return;
    }
    if (_gripDrag) {
      _gripDrag.endFrame = f;
      renderTimeline();
    }
  });

  canvas.addEventListener('mouseup', () => {
    if (_gripDrag) {
      addGripRange(_gripDrag.side, _gripDrag.startFrame, _gripDrag.endFrame);
      _gripDrag = null;
      renderTimeline();
    }
    _tlDragging = false;
  });
  canvas.addEventListener('mouseleave', () => {
    if (_gripDrag) {
      addGripRange(_gripDrag.side, _gripDrag.startFrame, _gripDrag.endFrame);
      _gripDrag = null;
      renderTimeline();
    }
    _tlDragging = false;
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = screenToTrack(x, y);
    if (!hit) return;
    const { row, frame } = hit;
    if (row.kind === 'blendShape') removeBlendShapeKF(row.name, frame);
    else if (row.kind === 'grip')  { removeGripRangeAt(row.side, frame); renderTimeline(); }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      // 横スクロール
      tlScrollX = Math.max(0, tlScrollX + (e.shiftKey ? e.deltaY : e.deltaX));
    } else {
      // ズーム（カーソル下のフレームを中心に）
      if (x < HEADER_W) { tlScrollX = Math.max(0, tlScrollX + e.deltaY); }
      else {
        const fAtCursor = xToFrame(x);
        const factor    = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        tlPxPerFrame    = Math.max(2, Math.min(60, tlPxPerFrame * factor));
        tlScrollX       = Math.max(0, fAtCursor * tlPxPerFrame - (x - HEADER_W));
      }
    }
    renderTimeline();
  }, { passive: false });

  // Deleteキー
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const sel = timeline.selected;
    if (!sel) return;
    if (sel.kind === 'blendShape') removeBlendShapeKF(sel.name, sel.frame);
    e.preventDefault();
  });
}

// ============================================================
// Event Dispatcher + ブレンドシェイプ補間
// ============================================================

function dispatchTimelineEvents(frame) {
  const intFrame = Math.floor(frame);
  // グリップ状態を常に更新（シーク時・再生時どちらも）
  _updateGripState(intFrame);
  _lastDispatchedFrame = intFrame;
}

function _updateGripState(f) {
  if (!simData) return;
  for (const side of ['left', 'right']) {
    const active = gripActiveAt(side, f);
    const hp     = handGrabPoints[side];
    hp.active    = active;
    try {
      if (side === 'left') {
        simData.leftGripActiveUniform.value = active ? 1 : 0;
        if (active && hp.boneNode) simData.leftGripTargetUniform.value.copy(hp.worldPos);
      } else {
        simData.rightGripActiveUniform.value = active ? 1 : 0;
        if (active && hp.boneNode) simData.rightGripTargetUniform.value.copy(hp.worldPos);
      }
    } catch (err) {
      showToast(`グリップエラー: ${err.message}`, 'error');
    }
  }
}

function applyBlendShapesAt(frame) {
  if (!currentVRM?.expressionManager) return;
  for (const [name, kfMap] of timeline.blendShape) {
    if (kfMap.size === 0) continue;
    try {
      const val = interpolateBlendShape(kfMap, frame);
      currentVRM.expressionManager.setValue(name, val);
    } catch (err) {
      showToast(`ブレンドシェイプエラー (${name}): ${err.message}`, 'error');
    }
  }
}

function interpolateBlendShape(kfMap, frame) {
  if (kfMap.size === 0) return 0;
  const keys = [...kfMap.keys()].sort((a, b) => a - b);
  // KF範囲外は0（範囲内でのみ有効）
  if (frame < keys[0])               return 0;
  if (frame > keys[keys.length - 1]) return 0;
  if (frame === keys[keys.length - 1]) return kfMap.get(keys[keys.length - 1]);
  let lo = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame <= keys[i + 1]) { lo = i; break; }
  }
  const f0 = keys[lo], f1 = keys[lo + 1];
  const t  = (frame - f0) / (f1 - f0);
  return kfMap.get(f0) + (kfMap.get(f1) - kfMap.get(f0)) * t;
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

function populateBlendShapeDropdown(vrm) {
  const sel = document.getElementById('bs-select');
  sel.innerHTML = '<option value="">-- 表情を選択 --</option>';
  const em = vrm?.expressionManager;
  if (!em) return;
  const names = Object.keys(em.expressionMap ?? {}).sort();
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
}

function updateFrameLabel() {
  document.getElementById('lbl-frame').textContent = timeline.currentFrame.toString();
}

function resizeTimeline() {
  const section = document.getElementById('timeline-section');
  const canvas  = document.getElementById('timeline');
  canvas.width  = section.clientWidth;
  canvas.height = section.clientHeight;
}

function setupUI() {
  // ── VRM 読み込み ──
  const vrmFile = document.getElementById('vrm-file');
  vrmFile.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    vrmFile.value = '';
    showToast('読み込み中…');
    try { await loadVRM(file); }
    catch (err) { showToast(`VRM 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrm-load').addEventListener('click', () => vrmFile.click());

  // ── NPCバンドル(.npc.json) 一括読み込み ──
  const npcFile = document.getElementById('npc-file');
  npcFile.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    npcFile.value = '';
    showToast('NPC読み込み中…');
    try { await importNPCBundle(JSON.parse(await file.text())); }
    catch (err) { showToast(`NPC読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-npc-load').addEventListener('click', () => npcFile.click());

  // ── VRMA 読み込み ──
  const vrmaFile = document.getElementById('vrma-file');
  vrmaFile.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    vrmaFile.value = '';
    showToast('読み込み中…');
    try { await loadVRMA(file); }
    catch (err) { showToast(`VRMA 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });
  document.getElementById('btn-vrma-load').addEventListener('click', () => vrmaFile.click());

  // ── VRMA ドロップダウン（vrmaフォルダのモーションを選択） ──
  const vrmaSelect = document.getElementById('vrma-select');
  fetch('/vrma/manifest.json')
    .then(r => r.ok ? r.json() : [])
    .then(files => { for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.vrma$/, ''); vrmaSelect.appendChild(o); } })
    .catch(() => {});
  vrmaSelect.addEventListener('change', async () => {
    if (!vrmaSelect.value) return;
    showToast('VRMA 読み込み中…');
    try {
      const res = await fetch('/vrma/' + vrmaSelect.value);
      if (!res.ok) throw new Error('取得失敗');
      await loadVRMA(new File([await res.blob()], vrmaSelect.value, { type: 'application/octet-stream' }));
    } catch (err) { showToast(`VRMA 読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // ── マント読み込み ──
  const mantleFile = document.getElementById('mantle-file');
  mantleFile.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    mantleFile.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try { loadMantleJSON(JSON.parse(ev.target.result)); }
      catch (err) { showToast(`マント読み込み失敗: ${err.message}`, 'error'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-mantle-load').addEventListener('click', () => mantleFile.click());

  // ── TL 読み込み ──
  const tlFile = document.getElementById('tl-file');
  tlFile.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    tlFile.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      try { importTimeline(JSON.parse(ev.target.result)); showToast('タイムライン読み込み完了'); }
      catch (err) { showToast(`TL 読み込み失敗: ${err.message}`, 'error'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-tl-load').addEventListener('click', () => tlFile.click());

  // ── TL 保存 ──
  document.getElementById('btn-tl-save').addEventListener('click', () => {
    const json = exportTimeline();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = 'timeline.timeline.json';
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('タイムライン保存完了');
  });

  // ── 再生コントロール ──
  document.getElementById('btn-play').addEventListener('click', vrmaPlay);
  document.getElementById('btn-pause').addEventListener('click', vrmaPause);
  document.getElementById('cb-loop').addEventListener('change', e => vrmaSetLoop(e.target.checked));
  document.getElementById('sel-speed').addEventListener('change', e => vrmaSetSpeed(parseFloat(e.target.value)));

  // ── 布シミュ ──
  document.getElementById('btn-sim-start').addEventListener('click', startSim);
  document.getElementById('btn-sim-stop').addEventListener('click', stopSim);

  const bindSlider = (id, valId, uniformRef, parse, fmt) => {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    sl.addEventListener('input', () => {
      const v = parse(sl.value);
      vl.textContent = fmt(v);
      uniformRef.value = v;
    });
  };
  bindSlider('stiffness', 'stiffness-val', stiffnessUniform, parseFloat, v => v.toFixed(3));
  bindSlider('wind',      'wind-val',      windUniform,      parseFloat, v => v.toFixed(1));

  // ── HGP オフセットスライダー ──
  for (const side of ['left', 'right']) {
    const prefix = side === 'left' ? 'hgp-l' : 'hgp-r';
    for (const axis of ['x', 'y', 'z']) {
      const sl = document.getElementById(`${prefix}-${axis}`);
      const vl = document.getElementById(`${prefix}-${axis}-val`);
      if (!sl) continue;
      sl.addEventListener('input', () => {
        handGrabPoints[side].offset[axis] = parseFloat(sl.value);
        if (vl) vl.textContent = parseFloat(sl.value).toFixed(2);
      });
    }
  }
  document.getElementById('hgp-visible')?.addEventListener('change', e => {
    for (const side of ['left', 'right']) {
      if (handGrabPoints[side].markerMesh) handGrabPoints[side].markerMesh.visible = e.target.checked;
    }
  });
  document.getElementById('btn-hgp-reset')?.addEventListener('click', () => {
    for (const side of ['left', 'right']) {
      handGrabPoints[side].offset.set(0, 0, 0);
      _syncHgpOffsetUI(side);
    }
    showToast('グラブポイントオフセットをリセットしました');
  });

  // ── ブレンドシェイプ追加 ──
  document.getElementById('btn-bs-add').addEventListener('click', () => {
    const name = document.getElementById('bs-select').value;
    if (!name) { showToast('表情を選択してください', 'warn'); return; }
    addBlendShapeTrack(name);
  });

  // ── 選択KF値編集 ──
  document.getElementById('kf-value').addEventListener('change', e => {
    const sel = timeline.selected;
    if (!sel || sel.kind !== 'blendShape') return;
    const val = Math.max(0, Math.min(1, parseFloat(e.target.value)));
    setBlendShapeKF(sel.name, sel.frame, val);
    e.target.value = val.toFixed(2);
    renderTimeline();
  });
}

// ============================================================
// FPS Counter + Render Loop
// ============================================================

function updateFPS() {
  fpsFrameCount++;
  const now = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount / (elapsed / 1000));
    document.getElementById('fps-counter').textContent  = `${fps} FPS`;
    document.getElementById('fps-toolbar').textContent  = `${fps} FPS`;
    fpsFrameCount = 0;
    fpsLastTime   = now;
  }
}

async function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1 / 20);

  updateFPS();

  // VRMA 再生
  if (mixer && vrmaAction && vrmaPlaying) {
    const prevTime = vrmaAction.time;
    mixer.update(dt);
    const curTime = vrmaAction.time;

    // ループ折り返し検出
    if (vrmaLoop && curTime < prevTime - 0.001) {
      _lastDispatchedFrame = -1;
    }

    // LoopOnce 終端検出
    if (!vrmaLoop && curTime >= (vrmaClip?.duration ?? 0) - 0.001) {
      vrmaPlaying = false;
      timeline.currentFrame = timeline.durationFrames;
      _lastDispatchedFrame  = timeline.currentFrame;
      updatePlayButtons();
    }

    const newFrame = Math.min(Math.floor(curTime * timeline.fps), timeline.durationFrames);
    if (newFrame !== timeline.currentFrame) {
      timeline.currentFrame = newFrame;
      dispatchTimelineEvents(newFrame);
      updateFrameLabel();
    }
  }

  // タイムライン差分描画（プレイヘッド）
  renderTimelinePlayhead();

  // VRM 更新（VRMA ブレンドシェイプ反映）
  if (currentVRM) currentVRM.update(dt);

  // タイムラインブレンドシェイプ（VRM update 後に適用）
  applyBlendShapesAt(timeline.currentFrame);

  // HGP 追従
  updateHandGrabPoints();
  updateBoneColliders();

  // 布シミュレーション
  if (simRunning && simData) {
    updateAnchorPositions();
    timeSinceLastStep += dt;
    const step = 1 / 360;
    while (timeSinceLastStep >= step) {
      timeSinceLastStep -= step;
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
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.2;
  app.appendChild(renderer.domElement);

  // 初期サイズ設定
  const setRendererSize = () => {
    const w = app.clientWidth;
    const h = app.clientHeight;
    renderer.setSize(w, h);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };
  setRendererSize();

  scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);

  camera = new THREE.PerspectiveCamera(45, app.clientWidth / app.clientHeight, 0.01, 100);
  camera.position.set(0, 1.2, 2.8);

  // ライト
  const ambient = new THREE.AmbientLight(0xffffff, 1.2);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(1, 3, 2);
  scene.add(dir);

  // OrbitControls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

  // 共有 uniform 初期化
  stiffnessUniform = uniform(0.2);
  dampeningUniform = uniform(0.99);
  windUniform      = uniform(1.0);

  timer.connect(document);

  // タイムライン canvas 初期化
  resizeTimeline();
  renderTimeline();

  setupUI();
  setupGrabEvents(renderer.domElement);
  setupTimelineEvents(document.getElementById('timeline'));

  window.addEventListener('resize', () => {
    setRendererSize();
    resizeTimeline();
    renderTimeline();
  });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
}

init().catch(err => {
  console.error(err);
  document.getElementById('loading').textContent = `初期化失敗: ${err.message}`;
});
