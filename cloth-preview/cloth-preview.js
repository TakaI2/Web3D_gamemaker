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
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { GLTFLoader }       from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
  from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';

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

// ── グリップ：名前付きグループ（cloth.json から復元）─────────────
const GRIP_PALETTE = [0x44aaff, 0xff6644, 0x33ddbb, 0xffcc33, 0xcc66ff, 0x66ff88, 0xff66aa, 0x88ccff];
let gripGroups = [];          // [{id,name,bone,boneNode,offset,worldPos,markerMesh,active,color}]
const gripMap = new Map();    // vertexIdx → groupId
const groupById = (id) => gripGroups.find(g => g.id === id);

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

// ── グラブ点（各グリップグループが関節に追従するマーカー）。座標等は gripGroups 内に保持。
let _hgpDragSide = null;   // ドラッグ中のグループ id
let gripGizmo    = null;   // グラブ点移動ギズモ(TransformControls)
let selectedGroupId = null;// 選択中グループ（ギズモ/位置キーの対象）
const _hgpDragPlane     = new THREE.Plane();
const _hgpDragRaycaster = new THREE.Raycaster();

// ── VRMA プレイヤー ──────────────────────────────────────────────
let mixer      = null;
let vrmaClip   = null;
let vrmaAction = null;
let vrmaPlaying = false;
let vrmaLoop    = true;
let currentVrmaName = '';   // 直近に読み込んだ VRMA のファイル名（public/vrma 基準）。timeline.json に保存。

// ── Readback（HGPドラッグ用スナップショット）───────────────────
const grab = { snapshot: null, snapshotPending: false, snapshotAge: 999 };

// ── タイムライン状態 ─────────────────────────────────────────────
const timeline = {
  fps:           30,
  durationFrames: 90,
  currentFrame:  0,
  trimIn:        0,   // 再生区間 In（フレーム）。VRMA本体は不変、再生のみこの区間でループ
  trimOut:       90,  // 再生区間 Out（フレーム）
  grip: {},     // groupId → [{start, end}]（グリップ有効範囲）
  gripPos: {},  // groupId → Map<frame, {x,y,z}>（グラブ点オフセットのキーフレーム）
  blendShape: new Map(),  // name → Map<frame, value>
  selected:   null,       // { kind, name?, frame } | null
};

// ── タイムライン Canvas 状態 ─────────────────────────────────────
let tlPxPerFrame = 8;
let tlScrollX    = 0;

const HEADER_W = 160;
const ROW_H    = 22;
const RULER_H  = 24;
const TRIM_HANDLE_W = 9;   // ルーラー上の In/Out 三角ハンドル幅
// グリップ行はグループから動的生成（各グループ: 有効範囲 行 ＋ 位置キーフレーム 行）
function gripRows() {
  const rows = [];
  for (const g of gripGroups) {
    const color = '#' + g.color.toString(16).padStart(6, '0');
    rows.push({ kind: 'grip',    groupId: g.id, label: g.name,         color });
    rows.push({ kind: 'gripPos', groupId: g.id, label: g.name + ' 位置', color });
  }
  return rows;
}

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

function _createGroupMarker(g) {
  const geo = new THREE.SphereGeometry(0.028, 14, 10);
  const mat = new THREE.MeshBasicMaterial({ color: g.color, transparent: true, opacity: 0.85, depthTest: false });
  g.markerMesh = new THREE.Mesh(geo, mat);
  g.markerMesh.renderOrder = 12; g.markerMesh.frustumCulled = false;
  scene.add(g.markerMesh);
}
function _disposeGroupMarker(g) {
  if (!g.markerMesh) return;
  scene.remove(g.markerMesh); g.markerMesh.geometry.dispose(); g.markerMesh.material.dispose(); g.markerMesh = null;
}

function initHandGrabPoints(vrm) {
  disposeHandGrabPoints();
  let found = 0;
  for (const g of gripGroups) {
    g.boneNode = vrm.humanoid?.getNormalizedBoneNode(g.bone) ?? null;
    if (g.boneNode) { found++; if (!g.markerMesh) _createGroupMarker(g); }
  }
  if (found > 0) document.getElementById('hgp-section').style.display = '';
}

function disposeHandGrabPoints() {
  for (const g of gripGroups) { _disposeGroupMarker(g); g.boneNode = null; }
  _hgpDragSide = null;
  if (gripGizmo) gripGizmo.detach();
  document.getElementById('hgp-section').style.display = 'none';
}

// ギズモでグラブ点マーカーを動かしたとき：マーカー座標 → 関節ローカルoffset を逆算
const _gizPos = new THREE.Vector3(), _gizQuat = new THREE.Quaternion();
function onGripGizmoChange() {
  const obj = gripGizmo?.object;
  if (!obj) return;
  for (const g of gripGroups) {
    if (g.markerMesh !== obj || !g.boneNode) continue;
    g.boneNode.getWorldPosition(_gizPos);
    g.boneNode.getWorldQuaternion(_gizQuat);
    g.offset.copy(obj.position).sub(_gizPos).applyQuaternion(_gizQuat.invert()).clampScalar(-0.4, 0.4);
    g.worldPos.copy(obj.position);
    break;
  }
}

// 各グループのグラブ点 worldPos = bonePos + boneQuat*offset（位置＋回転追従）。マーカー更新。
function updateHandGrabPoints() {
  for (const g of gripGroups) {
    if (!g.boneNode) continue;
    g.boneNode.getWorldPosition(_anchorTmp);
    g.boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(g.offset).applyQuaternion(_anchorBoneQuat);
    g.worldPos.copy(_anchorTmp).add(_anchorWorldOff);
    if (g.markerMesh) g.markerMesh.position.copy(g.worldPos);
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

// per-vertex vec4 [x,y,z,active] を更新：アンカー=常時(w=1)、グリップ=所属グループの active
function updatePinTargets() {
  if (!simData?.bonePinTargetBuffer) return;
  if (!anchorMap.size && !gripMap.size) return;
  const arr = simData.bonePinTargetBuffer.value.array;
  for (const [idx, { boneNode, localOffset }] of anchorMap) {
    if (!boneNode) continue;
    boneNode.getWorldPosition(_anchorTmp);
    boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(localOffset).applyQuaternion(_anchorBoneQuat);
    arr[idx*4] = _anchorTmp.x + _anchorWorldOff.x; arr[idx*4+1] = _anchorTmp.y + _anchorWorldOff.y; arr[idx*4+2] = _anchorTmp.z + _anchorWorldOff.z; arr[idx*4+3] = 1;
  }
  for (const [idx, gid] of gripMap) {
    const g = groupById(gid);
    if (!g || !g.boneNode) { arr[idx*4+3] = 0; continue; }
    arr[idx*4] = g.worldPos.x; arr[idx*4+1] = g.worldPos.y; arr[idx*4+2] = g.worldPos.z; arr[idx*4+3] = g.active ? 1 : 0;
  }
  simData.bonePinTargetBuffer.value.needsUpdate = true;
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

  // グリップ復元：新形式 gripGroups を優先、無ければ legacy(leftGripIndices/rightGripIndices→既定グループ)
  for (const g of gripGroups) _disposeGroupMarker(g);
  gripGroups = []; gripMap.clear();
  let _gid = 0;
  const _bindBone = (g) => { if (currentVRM) { g.boneNode = currentVRM.humanoid?.getNormalizedBoneNode(g.bone) ?? null; if (g.boneNode) _createGroupMarker(g); } };
  const _mkGroup = (name, bone, color) => ({ id: `g${++_gid}`, name, bone, boneNode: null, offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false, color: color ?? GRIP_PALETTE[gripGroups.length % GRIP_PALETTE.length] });
  if (Array.isArray(json.gripGroups) && json.gripGroups.length) {
    for (const gd of json.gripGroups) {
      const g = _mkGroup(gd.name || gd.bone, gd.bone, typeof gd.color === 'number' ? gd.color : undefined);
      if (gd.id) { g.id = gd.id; _gid = Math.max(_gid, +((`${gd.id}`.match(/\d+/) || [0])[0])); }
      if (gd.offset) g.offset.set(gd.offset[0], gd.offset[1], gd.offset[2]);
      gripGroups.push(g); _bindBone(g);
      for (const idx of (gd.vertices || [])) gripMap.set(idx, g.id);
    }
  } else {
    const addLegacy = (indices, name, bone, off) => {
      if (!indices || !indices.length) return;
      const g = _mkGroup(name, bone); if (off) g.offset.set(off[0], off[1], off[2]);
      gripGroups.push(g); _bindBone(g);
      for (const idx of indices) gripMap.set(idx, g.id);
    };
    addLegacy(json.leftGripIndices, 'L手', 'leftHand', json.handGrabOffsets?.left);
    addLegacy(json.rightGripIndices, 'R手', 'rightHand', json.handGrabOffsets?.right);
  }
  // タイムラインを現グループ id に合わせて初期化（旧グループのデータは破棄）
  timeline.grip = {}; timeline.gripPos = {};
  for (const g of gripGroups) { timeline.grip[g.id] = []; timeline.gripPos[g.id] = new Map(); }

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

  // コライダー設定（半径・ボーンローカルオフセット）を復元してボーンから再構築
  savedColliderData = json.colliders ?? null;
  if (savedColliderData && currentVRM) buildCollidersFromVRM(currentVRM);

  // 初期メッシュをシーンに追加（シミュ未実行で静止表示）
  simData = buildSimulation(_buildMantleAnalysis());
  // simRunning は false のままにしておく

  renderTimeline();
  showToast(`マント読み込み完了 (${json.vertexCount}頂点 / グリップ${gripGroups.length}グループ / アンカー:${anchorMap.size})`);
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

let lastBundleName = '';   // TL保存時の既定ファイル名に使う（直近に読み込んだNPC名）
let lastTlName     = '';   // 直近に読み込んだTL名（拡張子なし）。VRMA差し替え→上書き保存の既定名に使う

// NPCバンドル(.npc.json)を一括読込：VRM → マント(cloth) → VRMA → timeline。
async function importNPCBundle(bundle) {
  if (!bundle || !bundle.vrm) { showToast('VRM を含まないファイルです', 'error'); return; }
  const name = bundle.name || 'imported';
  lastBundleName = name;
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
  for (const g of gripGroups) _disposeGroupMarker(g);
  gripGroups = []; gripMap.clear();
  timeline.grip = {}; timeline.gripPos = {};
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

  // アンカー＋グリップ: 頂点ごとの初期ターゲット vec4 [x,y,z,active] を事前計算
  const hasBonePins = anchorMap.size > 0 || gripMap.size > 0;
  const bonePinTargetArr = new Float32Array(vertexCount * 4);
  if (hasBonePins) {
    updateHandGrabPoints();   // 各グループのグラブ点 worldPos を最新化
    const tmp      = new THREE.Vector3();
    const boneQuat = new THREE.Quaternion();
    const worldOff = new THREE.Vector3();
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      if (!boneNode) continue;
      boneNode.getWorldPosition(tmp);
      boneNode.getWorldQuaternion(boneQuat);
      worldOff.copy(localOffset).applyQuaternion(boneQuat);
      bonePinTargetArr[idx*4] = tmp.x + worldOff.x; bonePinTargetArr[idx*4+1] = tmp.y + worldOff.y; bonePinTargetArr[idx*4+2] = tmp.z + worldOff.z; bonePinTargetArr[idx*4+3] = 1;
    }
    for (const [idx, gid] of gripMap) {
      const g = groupById(gid);
      if (!g || !g.boneNode) continue;
      bonePinTargetArr[idx*4] = g.worldPos.x; bonePinTargetArr[idx*4+1] = g.worldPos.y; bonePinTargetArr[idx*4+2] = g.worldPos.z; bonePinTargetArr[idx*4+3] = g.active ? 1 : 0;
    }
  }

  const springListArray  = [];
  const vertexParamsArr  = new Uint32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    const isFixed = 0;
    // gripCode: 0=なし, 1=アンカー(常時), 2=グリップ(グループactive時)
    let gripCode = 0;
    if (anchorMap.has(i)) gripCode = 1;
    else if (gripMap.has(i) && groupById(gripMap.get(i))?.boneNode) gripCode = 2;
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

  const bonePinTargetBuffer = hasBonePins ? instancedArray(bonePinTargetArr, 'vec4') : null;  // xyz=target, w=active

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

    // アンカー＋グリップ：per-vertex ターゲット(xyz)へ吸着。code1=アンカー(常時), code2=グリップ(w>0.5時)
    if (hasBonePins) {
      const tgt = bonePinTargetBuffer.element(instanceIndex).toVar('tgt');
      const snap = () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(tgt.xyz);
        Return();
      };
      If(gripCode.equal(1), snap);
      If(gripCode.equal(2), () => { If(tgt.w.greaterThan(0.5), snap); });
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
    if (gripGizmo && gripGizmo.dragging) return;   // ギズモ操作中は無視
    for (const g of gripGroups) {
      if (!g.markerMesh || !g.markerMesh.visible) continue;
      const p    = g.worldPos.clone().project(camera);
      if (p.z > 1) continue;
      const rect = canvas.getBoundingClientRect();
      const sx = (p.x *  0.5 + 0.5) * rect.width  + rect.left;
      const sy = (p.y * -0.5 + 0.5) * rect.height + rect.top;
      if (Math.hypot(sx - e.clientX, sy - e.clientY) < 22) {
        _hgpDragSide = g.id;
        selectedGroupId = g.id;
        if (gripGizmo) gripGizmo.attach(g.markerMesh);
        const normal = g.worldPos.clone().sub(camera.position).normalize();
        _hgpDragPlane.setFromNormalAndCoplanarPoint(normal, g.worldPos);
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
      const g = groupById(_hgpDragSide);
      if (g && g.boneNode) {
        const bonePos = new THREE.Vector3(), boneQuat = new THREE.Quaternion();
        g.boneNode.getWorldPosition(bonePos);
        g.boneNode.getWorldQuaternion(boneQuat);
        g.offset.copy(hit).sub(bonePos).applyQuaternion(boneQuat.invert()).clampScalar(-0.4, 0.4);
      }
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

// public/vrma の名前を指定して VRMA を読み込む（timeline の vrma 参照からの自動ロード用）
async function loadVrmaByName(name) {
  try {
    const res = await fetch('/vrma/' + encodeURIComponent(name));
    if (!res.ok) throw new Error('取得失敗');
    await loadVRMA(new File([await res.blob()], name, { type: 'application/octet-stream' }), name);
    const sel = document.getElementById('vrma-select');
    if (sel) sel.value = name;
  } catch (err) { showToast(`VRMA自動読込失敗: ${name}`, 'warn'); console.warn(err); }
}

async function loadVRMA(file, srcName) {
  if (!currentVRM) { showToast('先にVRMを読み込んでください', 'error'); return; }
  const loader = new GLTFLoader();
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const url = URL.createObjectURL(file);
  try {
    const gltf = await loader.loadAsync(url);
    const vrmAnims = gltf.userData.vrmAnimations;
    if (!vrmAnims?.length) throw new Error('VRMAアニメーションデータが見つかりません');

    unloadVRMA();
    currentVrmaName = srcName || '';   // public/vrma のファイル名（bundle埋込など不明な場合は空）
    vrmaClip   = createVRMAnimationClip(vrmAnims[0], currentVRM);
    mixer      = new THREE.AnimationMixer(currentVRM.scene);
    vrmaAction = mixer.clipAction(vrmaClip);
    vrmaAction.timeScale = 1.0;
    vrmaSetLoop(vrmaLoop);
    vrmaAction.play();
    vrmaAction.paused = true;  // 読み込み直後は停止

    // タイムライン尺を更新（トリム区間は全体にリセット）
    timeline.durationFrames = Math.round(vrmaClip.duration * timeline.fps);
    timeline.trimIn  = 0;
    timeline.trimOut = timeline.durationFrames;
    document.getElementById('lbl-duration').textContent = timeline.durationFrames.toString();
    updateTrimLabel();

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
  // 再生開始時、現在位置がトリム区間外なら In へ送る
  if (timeline.currentFrame < timeline.trimIn || timeline.currentFrame >= timeline.trimOut) {
    vrmaSeek(timeline.trimIn);
  }
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
  // トリム区間の末尾は render 側で手動処理するため、ミキサーは常に LoopRepeat（クリップ末で勝手にクランプさせない）
  if (vrmaAction) {
    vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
    vrmaAction.clampWhenFinished = false;
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

function addGripRange(groupId, start, end) {
  if (!timeline.grip[groupId]) timeline.grip[groupId] = [];
  const s = Math.min(start, end), e = Math.max(start, end);
  timeline.grip[groupId].push({ start: s, end: e });
  timeline.grip[groupId].sort((a, b) => a.start - b.start);
}

function removeGripRangeAt(groupId, frame) {
  const ranges = timeline.grip[groupId];
  if (!ranges) return;
  const idx = ranges.findIndex(r => frame >= r.start && frame <= r.end);
  if (idx >= 0) ranges.splice(idx, 1);
}

function gripActiveAt(groupId, frame) {
  const ranges = timeline.grip[groupId];
  return ranges ? ranges.some(r => frame >= r.start && frame <= r.end) : false;
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
  for (const g of gripGroups) {
    const ranges = timeline.grip[g.id];
    if (ranges && ranges.length) tracks.push({ kind: 'grip', groupId: g.id, ranges: ranges.map(r => ({ ...r })) });
    const pos = timeline.gripPos[g.id];
    if (pos && pos.size) tracks.push({ kind: 'gripPos', groupId: g.id,
      keyframes: [...pos.entries()].sort((a, b) => a[0] - b[0]).map(([frame, o]) => ({ frame, offset: [o.x, o.y, o.z] })) });
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
  const out = {
    version: 2, fps: timeline.fps, durationFrames: timeline.durationFrames,
    trimIn: timeline.trimIn, trimOut: timeline.trimOut,
    tracks,
  };
  if (currentVrmaName) out.vrma = currentVrmaName;   // 体モーション(VRMA)の参照。ゲームはこれで本体アニメを再生。
  return out;
}

function importTimeline(json) {
  if (!Array.isArray(json.tracks)) throw new Error('無効なタイムラインファイルです');
  for (const k of Object.keys(timeline.grip)) timeline.grip[k] = [];
  timeline.gripPos = {};
  timeline.blendShape.clear();
  timeline.selected = null;

  if (json.fps)            timeline.fps            = json.fps;
  if (json.durationFrames) timeline.durationFrames = json.durationFrames;
  if (json.vrma)           currentVrmaName         = json.vrma;   // 体モーション参照（再エクスポートで保持）
  // トリム区間（無ければ全体）
  timeline.trimIn  = Number.isFinite(json.trimIn)  ? Math.max(0, Math.min(json.trimIn, timeline.durationFrames)) : 0;
  timeline.trimOut = Number.isFinite(json.trimOut) ? Math.max(timeline.trimIn + 1, Math.min(json.trimOut, timeline.durationFrames)) : timeline.durationFrames;

  const byBone = (bone) => gripGroups.find(g => g.bone === bone)?.id;
  for (const track of json.tracks) {
    if (track.kind === 'grip') {
      // groupId(新) を優先、無ければ legacy side/type を leftHand/rightHand グループへマップ
      let gid = track.groupId && groupById(track.groupId) ? track.groupId : null;
      if (!gid && track.side)  gid = byBone(track.side === 'left' ? 'leftHand' : 'rightHand');
      if (!gid && track.type)  gid = byBone((track.type.includes('Left') || track.type === 'gripLeft') ? 'leftHand' : 'rightHand');
      if (!gid) continue;
      if (!timeline.grip[gid]) timeline.grip[gid] = [];
      if (Array.isArray(track.ranges)) {
        for (const r of track.ranges) timeline.grip[gid].push({ start: r.start, end: r.end });
      } else if (Array.isArray(track.frames) && (track.type === 'gripLeft' || track.type === 'gripRight')) {
        for (const f of track.frames) timeline.grip[gid].push({ start: f, end: f });
      }
    } else if (track.kind === 'gripPos') {
      const gid = track.groupId && groupById(track.groupId) ? track.groupId : null;
      if (!gid) continue;
      const m = new Map();
      if (Array.isArray(track.keyframes)) for (const k of track.keyframes) m.set(k.frame, { x: k.offset[0], y: k.offset[1], z: k.offset[2] });
      timeline.gripPos[gid] = m;
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
  updateTrimLabel();
  document.getElementById('kf-section').style.display = 'none';
  renderTimeline();
}

// ============================================================
// Timeline Canvas 描画
// ============================================================

function allRows() {
  const rows = gripRows();
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
      const ranges = timeline.grip[row.groupId] || [];
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
      if (_gripDrag?.groupId === row.groupId) {
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
    } else if (row.kind === 'gripPos') {
      // グラブ点オフセットのキーフレーム（ひし形）
      const kfMap = timeline.gripPos[row.groupId];
      if (kfMap && kfMap.size) {
        const yc = y + ROW_H / 2;
        const keys = [...kfMap.keys()].sort((a, b) => a - b);
        for (const f of keys) {
          const x = frameToX(f);
          if (x < HEADER_W - 8 || x > W + 8) continue;
          const sel = timeline.selected?.kind === 'gripPos' && timeline.selected.groupId === row.groupId && timeline.selected.frame === f;
          ctx.fillStyle = sel ? '#ffee00' : row.color;
          ctx.beginPath(); ctx.moveTo(x, yc - 5); ctx.lineTo(x + 5, yc); ctx.lineTo(x, yc + 5); ctx.lineTo(x - 5, yc); ctx.closePath(); ctx.fill();
          if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
        }
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

  // トリム区間（淡色オーバーレイ＋In/Outハンドル）
  _drawTrim(ctx, W, H);

  // プレイヘッド
  _drawPlayhead(ctx, W, H);
}

function _drawTrim(ctx, W, H) {
  const xIn  = frameToX(timeline.trimIn);
  const xOut = frameToX(timeline.trimOut);

  // 区間外を暗くする（行領域のみ）
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  if (xIn > HEADER_W) {
    ctx.fillRect(HEADER_W, RULER_H, Math.min(xIn, W) - HEADER_W, H - RULER_H);
  }
  if (xOut < W) {
    const x0 = Math.max(xOut, HEADER_W);
    ctx.fillRect(x0, RULER_H, W - x0, H - RULER_H);
  }

  // 区間境界の縦線
  ctx.strokeStyle = '#33cc88';
  ctx.lineWidth = 1.5;
  if (xIn >= HEADER_W && xIn <= W) {
    ctx.beginPath(); ctx.moveTo(xIn + 0.5, RULER_H); ctx.lineTo(xIn + 0.5, H); ctx.stroke();
  }
  if (xOut >= HEADER_W && xOut <= W) {
    ctx.beginPath(); ctx.moveTo(xOut - 0.5, RULER_H); ctx.lineTo(xOut - 0.5, H); ctx.stroke();
  }

  // ルーラー上のハンドル（In=右向き / Out=左向きの三角）
  ctx.fillStyle = '#33cc88';
  if (xIn >= HEADER_W && xIn <= W) {
    ctx.beginPath();
    ctx.moveTo(xIn, RULER_H - 14); ctx.lineTo(xIn + TRIM_HANDLE_W, RULER_H - 14);
    ctx.lineTo(xIn, RULER_H); ctx.closePath(); ctx.fill();
  }
  if (xOut >= HEADER_W && xOut <= W) {
    ctx.beginPath();
    ctx.moveTo(xOut, RULER_H - 14); ctx.lineTo(xOut - TRIM_HANDLE_W, RULER_H - 14);
    ctx.lineTo(xOut, RULER_H); ctx.closePath(); ctx.fill();
  }
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

let _gripDrag = null; // { groupId, startFrame, endFrame }
let _trimDrag = null; // 'in' | 'out' | null

function maxScrollX() {
  const canvas = document.getElementById('timeline');
  const visible = (canvas?.width ?? 0) - HEADER_W;
  const content = (timeline.durationFrames + 5) * tlPxPerFrame; // 末尾に 5f ぶんの余白
  return Math.max(0, content - visible);
}

function setupTimelineEvents(canvas) {
  let _tlDragging = false;
  let _panDrag = null; // { startX, startScroll } 中ボタン/Alt+左ドラッグでの平行移動

  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 中ボタン or Alt+左ドラッグ → タイムラインを平行移動（パン）
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      _panDrag = { startX: x, startScroll: tlScrollX };
      return;
    }

    // ルーラー領域：In/Out ハンドルのドラッグを優先、無ければシーク
    if (y < RULER_H && x >= HEADER_W) {
      const xIn  = frameToX(timeline.trimIn);
      const xOut = frameToX(timeline.trimOut);
      const TOL  = TRIM_HANDLE_W + 3;
      const dIn  = Math.abs(x - xIn);
      const dOut = Math.abs(x - xOut);
      if (dIn <= TOL || dOut <= TOL) {
        _trimDrag = (dIn <= dOut) ? 'in' : 'out';
        return;
      }
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
      _gripDrag = { groupId: row.groupId, startFrame: frame, endFrame: frame };
      renderTimeline();
    } else if (row.kind === 'gripPos') {
      // クリック：その位置に現グループの offset を記録 / 既存キーは選択
      const kfMap = timeline.gripPos[row.groupId] || (timeline.gripPos[row.groupId] = new Map());
      if (!kfMap.has(frame)) {
        const g = groupById(row.groupId);
        const o = g ? g.offset : { x: 0, y: 0, z: 0 };
        kfMap.set(frame, { x: o.x, y: o.y, z: o.z });
      }
      timeline.selected = { kind: 'gripPos', groupId: row.groupId, frame };
      selectedGroupId = row.groupId;
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
    if (_panDrag) {
      tlScrollX = Math.max(0, Math.min(maxScrollX(), _panDrag.startScroll - (x - _panDrag.startX)));
      renderTimeline();
      return;
    }
    const f = Math.max(0, Math.min(xToFrame(x), timeline.durationFrames));
    if (_trimDrag) {
      if (_trimDrag === 'in')  timeline.trimIn  = Math.max(0, Math.min(f, timeline.trimOut - 1));
      else                     timeline.trimOut = Math.min(timeline.durationFrames, Math.max(f, timeline.trimIn + 1));
      updateTrimLabel();
      renderTimeline();
      return;
    }
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
      addGripRange(_gripDrag.groupId, _gripDrag.startFrame, _gripDrag.endFrame);
      _gripDrag = null;
      renderTimeline();
    }
    _tlDragging = false;
    _trimDrag = null;
    _panDrag = null;
  });
  canvas.addEventListener('mouseleave', () => {
    if (_gripDrag) {
      addGripRange(_gripDrag.groupId, _gripDrag.startFrame, _gripDrag.endFrame);
      _gripDrag = null;
      renderTimeline();
    }
    _tlDragging = false;
    _trimDrag = null;
    _panDrag = null;
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
    else if (row.kind === 'grip')  { removeGripRangeAt(row.groupId, frame); renderTimeline(); }
    else if (row.kind === 'gripPos') { timeline.gripPos[row.groupId]?.delete(frame); renderTimeline(); }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      // 横スクロール（平行移動）
      tlScrollX = Math.max(0, Math.min(maxScrollX(), tlScrollX + (e.shiftKey ? e.deltaY : e.deltaX)));
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
    else if (sel.kind === 'gripPos') { timeline.gripPos[sel.groupId]?.delete(sel.frame); renderTimeline(); }
    e.preventDefault();
  });
  // K キー：選択中グループのグラブ点 offset を現在フレームに記録
  window.addEventListener('keydown', e => {
    if ((e.key !== 'k' && e.key !== 'K') || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!selectedGroupId) { showToast('グラブ点（色付き球）をクリックして選択してください', 'warn'); return; }
    recordGripPosKey(selectedGroupId, timeline.currentFrame);
  });
}

function recordGripPosKey(groupId, frame) {
  const g = groupById(groupId);
  if (!g) return;
  const m = timeline.gripPos[groupId] || (timeline.gripPos[groupId] = new Map());
  m.set(frame, { x: g.offset.x, y: g.offset.y, z: g.offset.z });
  timeline.selected = { kind: 'gripPos', groupId, frame };
  renderTimeline();
  showToast(`${g.name} 位置キー @ ${frame}f`);
}

// ============================================================
// Event Dispatcher + ブレンドシェイプ補間
// ============================================================

function dispatchTimelineEvents(frame) {
  const intFrame = Math.floor(frame);
  // グリップ状態＋グラブ点位置を常に更新（シーク時・再生時どちらも）
  _updateGripState(intFrame);
  applyGripOffsetsAt(intFrame);
  _lastDispatchedFrame = intFrame;
}

function _updateGripState(f) {
  // 各グループの active をフレームの範囲から決定。per-vertex のターゲット/active は updatePinTargets が反映。
  for (const g of gripGroups) g.active = gripActiveAt(g.id, f);
}

// グラブ点オフセットのキーフレーム補間。キーフレームを持つグループは offset を上書き。
function applyGripOffsetsAt(frame) {
  for (const g of gripGroups) {
    const kfMap = timeline.gripPos[g.id];
    if (!kfMap || kfMap.size === 0) continue;
    const o = interpolateGripPos(kfMap, frame);
    if (o) g.offset.set(o.x, o.y, o.z);
  }
}

function interpolateGripPos(kfMap, frame) {
  if (kfMap.size === 0) return null;
  const keys = [...kfMap.keys()].sort((a, b) => a - b);
  if (frame <= keys[0])               return kfMap.get(keys[0]);
  if (frame >= keys[keys.length - 1]) return kfMap.get(keys[keys.length - 1]);
  let lo = 0;
  for (let i = 0; i < keys.length - 1; i++) { if (frame <= keys[i + 1]) { lo = i; break; } }
  const f0 = keys[lo], f1 = keys[lo + 1], t = (frame - f0) / (f1 - f0);
  const a = kfMap.get(f0), b = kfMap.get(f1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
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

function updateTrimLabel() {
  const el = document.getElementById('lbl-trim');
  if (el) el.textContent = `${timeline.trimIn} – ${timeline.trimOut}`;
}

// タイムライン下部パネルを上下ドラッグで伸縮
function setupTimelineResize() {
  const resizer = document.getElementById('timeline-resizer');
  const section = document.getElementById('timeline-section');
  if (!resizer || !section) return;

  let startY = 0, startH = 0, dragging = false;

  const onMove = e => {
    if (!dragging) return;
    const delta  = startY - e.clientY;                 // 上ドラッグで＋（高くなる）
    const maxH   = Math.max(160, window.innerHeight - 140); // ビューポートの最低限を確保
    const newH   = Math.max(120, Math.min(maxH, startH + delta));
    section.style.height = `${newH}px`;
    window.dispatchEvent(new Event('resize'));          // 3Dビューポート＋canvas を追従
  };
  const onUp = () => {
    dragging = false;
    resizer.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
  };

  resizer.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = section.clientHeight;
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
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

  // ── NPCバンドル(.npc.json) ドロップダウン（public/npc から選択）──
  const npcSelect = document.getElementById('npc-select');
  fetch('../npc/manifest.json')
    .then(r => r.ok ? r.json() : [])
    .then(files => {
      for (const f of files) {
        if (!f.endsWith('.npc.json')) continue;
        const o = document.createElement('option');
        o.value = f; o.textContent = f.replace(/\.npc\.json$/, '');
        npcSelect.appendChild(o);
      }
    })
    .catch(() => {});
  npcSelect.addEventListener('change', async () => {
    if (!npcSelect.value) return;
    showToast('NPC読み込み中…');
    try {
      const res = await fetch('../npc/' + npcSelect.value);
      if (!res.ok) throw new Error('取得失敗');
      await importNPCBundle(await res.json());
    } catch (err) { showToast(`NPC読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // ── VRMA 読み込み ──
  const vrmaFile = document.getElementById('vrma-file');
  vrmaFile.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    vrmaFile.value = '';
    showToast('読み込み中…');
    try { await loadVRMA(file, file.name); }
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
      const res = await fetch('/vrma/' + encodeURIComponent(vrmaSelect.value));
      if (!res.ok) throw new Error('取得失敗');
      await loadVRMA(new File([await res.blob()], vrmaSelect.value, { type: 'application/octet-stream' }), vrmaSelect.value);
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

  // ── TL 読み込み（public/timeline の *.timeline.json をドロップダウンから）──
  const tlSelect = document.getElementById('tl-select');
  function populateTlSelect(selectName) {
    fetch('../timeline/manifest.json?ext=timeline.json')
      .then(r => r.ok ? r.json() : [])
      .then(files => {
        tlSelect.innerHTML = '<option value="">-- TL読込 (timeline) --</option>';
        for (const f of files) {
          const o = document.createElement('option');
          o.value = f; o.textContent = f.replace(/\.timeline\.json$/, '');
          if (f === selectName) o.selected = true;
          tlSelect.appendChild(o);
        }
      })
      .catch(() => {});
  }
  populateTlSelect();
  tlSelect.addEventListener('change', async () => {
    if (!tlSelect.value) return;
    try {
      const res = await fetch('../timeline/' + tlSelect.value);
      if (!res.ok) throw new Error('取得失敗');
      const j = await res.json();
      importTimeline(j);
      lastTlName = tlSelect.value.replace(/\.timeline\.json$/, '');
      showToast(`TL読み込み: ${lastTlName}`);
      // timeline に vrma 参照があり VRM 読込済みなら、その体モーションを自動ロード
      if (j.vrma && currentVRM) await loadVrmaByName(j.vrma);
    } catch (err) { showToast(`TL読み込み失敗: ${err.message}`, 'error'); console.error(err); }
  });

  // ── TL 保存（public/timeline へ /api/save 経由で書き込み）──
  document.getElementById('btn-tl-save').addEventListener('click', async () => {
    const def  = lastTlName || lastBundleName || 'timeline';
    const name = prompt('保存名（public/timeline に <名前>.timeline.json で保存）', def);
    if (name === null) return;
    const base = name.trim().replace(/\.timeline\.json$/, '').replace(/[^\w\-]/g, '_');
    if (!base) { showToast('名前が不正です', 'warn'); return; }
    const filename = `${base}.timeline.json`;
    try {
      const r = await fetch('../api/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: 'timeline', filename, content: JSON.stringify(exportTimeline(), null, 2) }),
      });
      const j = await r.json();
      if (j.ok) { lastTlName = base; showToast(`保存: ${j.path}`); populateTlSelect(filename); }
      else showToast('保存失敗', 'error');
    } catch (e) { showToast(`保存失敗: ${e}`, 'error'); }
  });

  // ── 再生コントロール ──
  document.getElementById('btn-play').addEventListener('click', vrmaPlay);
  document.getElementById('btn-pause').addEventListener('click', vrmaPause);
  document.getElementById('cb-loop').addEventListener('change', e => vrmaSetLoop(e.target.checked));
  document.getElementById('sel-speed').addEventListener('change', e => vrmaSetSpeed(parseFloat(e.target.value)));

  // ── トリム（再生範囲）──
  document.getElementById('btn-trim-in').addEventListener('click', () => {
    timeline.trimIn = Math.min(timeline.currentFrame, timeline.trimOut - 1);
    updateTrimLabel(); renderTimeline();
  });
  document.getElementById('btn-trim-out').addEventListener('click', () => {
    timeline.trimOut = Math.max(timeline.currentFrame, timeline.trimIn + 1);
    updateTrimLabel(); renderTimeline();
  });
  document.getElementById('btn-trim-reset').addEventListener('click', () => {
    timeline.trimIn = 0;
    timeline.trimOut = timeline.durationFrames;
    updateTrimLabel(); renderTimeline();
  });

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

  // ── グラブ点マーカー表示切替（オフセット編集は cloth-editor 側。ここは球ドラッグで微調整可）──
  document.getElementById('hgp-visible')?.addEventListener('change', e => {
    for (const g of gripGroups) if (g.markerMesh) g.markerMesh.visible = e.target.checked;
  });
  document.getElementById('btn-hgp-reset')?.addEventListener('click', () => {
    for (const g of gripGroups) g.offset.set(0, 0, 0);
    showToast('グラブ点オフセットをリセットしました');
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

  // VRMA 再生（トリム区間 [trimIn, trimOut] 内でループ。VRMA本体は不変）
  if (mixer && vrmaAction && vrmaPlaying) {
    const inT  = timeline.trimIn  / timeline.fps;
    const outT = timeline.trimOut / timeline.fps;
    const prevTime = vrmaAction.time;
    mixer.update(dt);
    let curTime = vrmaAction.time;

    // 区間末尾に到達 or クリップが折り返した → 区間 In へ
    if (curTime >= outT - 0.0005 || curTime < prevTime - 0.001) {
      if (vrmaLoop) {
        curTime = inT;
        vrmaAction.time = inT;
        _lastDispatchedFrame = -1;
      } else {
        vrmaPlaying = false;
        curTime = outT;
        vrmaAction.time = outT;
        timeline.currentFrame = timeline.trimOut;
        _lastDispatchedFrame  = timeline.currentFrame;
        updatePlayButtons();
      }
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
    updatePinTargets();
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

  // グラブ点の移動ギズモ（マーカークリックでアタッチ、矢印ドラッグで offset 調整）
  gripGizmo = new TransformControls(camera, renderer.domElement);
  gripGizmo.setMode('translate');
  gripGizmo.setSize(0.6);
  gripGizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
  gripGizmo.addEventListener('objectChange', onGripGizmoChange);
  scene.add(gripGizmo.getHelper ? gripGizmo.getHelper() : gripGizmo);

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
  setupTimelineResize();

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
