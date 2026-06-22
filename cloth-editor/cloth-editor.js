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
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
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
let currentVRMADataURI = null; // 再インポートで埋め込みVRMAを読んだ場合の dataURI（再書き出しで再利用）
let importedTimeline   = null; // 再インポートした timeline（再書き出しで再添付）
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
const MAX_COLLIDERS = 16;
// colliders[i] = { x, y, z, r, boneNode, boneName, localOffset, helperMesh }
const colliders = [];
// GPU へ渡す Float32Array: [x,y,z,r, x,y,z,r, ...]  MAX_COLLIDERS 個
const colliderDataArr = new Float32Array(MAX_COLLIDERS * 4);
let   colliderCountUniform = null;  // buildSimulation 後に使用可
let   colliderDataBuffer   = null;  // instancedArray
// 読み込んだ cloth.json のコライダー設定 [{ boneName, r, offset:[x,y,z] }]。VRM読込時に半径・オフセットを復元する。
let   savedColliderData    = null;

// ── グリップ状態 ──────────────────────────────────────────────
// グリップ：名前付きグループ（任意数）。1グループ = {id,name,bone,boneNode,offset,worldPos,markerMesh,active,color}。
// 各頂点は1グループのみ（重複禁止）。グラブ点 worldPos = boneWorldPos + boneWorldQuat*offset（位置＋回転追従）。全頂点がその点へ吸着。
let gripGroups = [];            // グループ配列
const gripMap  = new Map();     // vertexIdx → groupId
let selectedGroupId = null;     // 編集対象グループ id（頂点クリック・オフセット編集の対象）
let gripEditMode = false;       // 頂点割当モード（ON中はマント頂点クリックで選択グループへ割当）
let _gidCounter = 0;
const GRIP_PALETTE = [0x44aaff, 0xff6644, 0x33ddbb, 0xffcc33, 0xcc66ff, 0x66ff88, 0xff66aa, 0x88ccff];
const GRIP_BONES = ['leftHand', 'rightHand', 'leftLowerArm', 'rightLowerArm', 'leftUpperArm', 'rightUpperArm', 'head', 'chest', 'hips'];
const DEFAULT_GROUPS = [
  { name: 'L手', bone: 'leftHand' }, { name: 'R手', bone: 'rightHand' },
  { name: 'L肘', bone: 'leftLowerArm' }, { name: 'R肘', bone: 'rightLowerArm' },
];
// テスト用キー: 押下中、bone一致の全グループを active
const GRIP_KEY_BONE = { KeyL: 'leftHand', KeyR: 'rightHand', KeyK: 'leftLowerArm', KeyE: 'rightLowerArm' };

function makeGroup(name, bone, color) {
  return {
    id: `g${++_gidCounter}`, name, bone, boneNode: null,
    offset: new THREE.Vector3(), worldPos: new THREE.Vector3(), markerMesh: null, active: false,
    color: color ?? GRIP_PALETTE[gripGroups.length % GRIP_PALETTE.length],
  };
}
const groupById = (id) => gripGroups.find(g => g.id === id);
// グラブ点マーカーのドラッグ状態（マーカー球を直接ドラッグして offset 調整）
let _hgpDragSide = null;   // ドラッグ中のグループ名
let gripGizmo    = null;   // グラブ点移動ギズモ(TransformControls)
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
  { bone: 'leftUpperLeg',  r: 0.09 },
  { bone: 'rightUpperLeg', r: 0.09 },
  { bone: 'leftLowerLeg',  r: 0.07 },
  { bone: 'rightLowerLeg', r: 0.07 },
];

// コライダーの表示名（どの部位かを分かりやすく）。boneName から引く。
const COLLIDER_LABELS = {
  head: '頭', neck: '首', chest: '胸', upperChest: '胸上', spine: '腹', hips: '腰',
  leftShoulder: '左肩', rightShoulder: '右肩',
  leftUpperLeg: '左もも', rightUpperLeg: '右もも', leftLowerLeg: '左すね', rightLowerLeg: '右すね',
};
const colliderLabel = (c, i) => (c.boneName && COLLIDER_LABELS[c.boneName]) || c.boneName || `球${i + 1}`;

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
      <span class="c-label">${colliderLabel(c, i)}</span>
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

const gripCountOf = (id) => { let n = 0; for (const gid of gripMap.values()) if (gid === id) n++; return n; };
function ensureDefaultGroups() {
  if (gripGroups.length) return;
  for (const d of DEFAULT_GROUPS) gripGroups.push(makeGroup(d.name, d.bone));
  selectedGroupId = gripGroups[0]?.id ?? null;
}
function _createGroupMarker(g) {
  const geo = new THREE.SphereGeometry(0.03, 14, 10);
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
  ensureDefaultGroups();
  let found = 0;
  for (const g of gripGroups) {
    g.boneNode = vrm.humanoid?.getNormalizedBoneNode(g.bone) ?? null;
    if (g.boneNode) { found++; if (!g.markerMesh) _createGroupMarker(g); }
  }
  if (found > 0) document.getElementById('hand-grab-section').style.display = '';
  updateGripCounts();
  _syncHgpOffsetUI();
}

function disposeHandGrabPoints() {
  for (const g of gripGroups) { _disposeGroupMarker(g); g.boneNode = null; }
  _hgpDragSide = null;
  if (gripGizmo) gripGizmo.detach();
  document.getElementById('hand-grab-section').style.display = 'none';
}

// 毎フレーム：各グループのグラブ点 worldPos = bonePos + boneQuat*offset（位置＋回転に追従）。マーカー更新。
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

// 選択中グループのオフセットスライダーを同期
function _syncHgpOffsetUI() {
  const g = groupById(selectedGroupId);
  for (const axis of ['x', 'y', 'z']) {
    const sl = document.getElementById(`grip-off-${axis}`);
    const vl = document.getElementById(`grip-off-${axis}-val`);
    if (sl) sl.value       = g ? g.offset[axis].toFixed(3) : '0';
    if (vl) vl.textContent = g ? g.offset[axis].toFixed(2) : '0.00';
  }
}

// 移動ギズモでグラブ点マーカーを動かしたとき：マーカー座標 → 関節ローカルoffset を逆算
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
    if (g.id === selectedGroupId) _syncHgpOffsetUI();
    break;
  }
}

// グループ一覧UIを再構築（追加/削除/リネーム/ボーン/選択/active/頂点数）
function updateGripCounts() {
  const host = document.getElementById('grip-group-list');
  if (!host) return;
  host.innerHTML = '';
  for (const g of gripGroups) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:3px;margin:2px 0;padding:2px 3px;border-radius:3px;'
      + (g.id === selectedGroupId ? 'background:rgba(120,170,255,0.18);' : '');
    const hex = '#' + g.color.toString(16).padStart(6, '0');
    // 選択（編集対象）
    const sel = document.createElement('button');
    sel.textContent = '✎'; sel.title = '編集対象に選択';
    sel.style.cssText = `flex-shrink:0;width:18px;background:${g.id === selectedGroupId ? hex : '#333'};color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;`;
    sel.onclick = () => { selectedGroupId = g.id; updateGripCounts(); _syncHgpOffsetUI(); if (gripGizmo && g.markerMesh) gripGizmo.attach(g.markerMesh); };
    // 色ドット
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${hex};flex-shrink:0;`;
    // 名前
    const name = document.createElement('input');
    name.value = g.name; name.title = '名前';
    name.style.cssText = 'flex:1;min-width:30px;background:#1a1a2e;color:#ddd;border:1px solid #444;border-radius:3px;padding:1px 3px;font-size:10px;';
    name.onchange = () => { g.name = name.value; };
    // ボーン
    const bsel = document.createElement('select');
    bsel.style.cssText = 'background:#1a1a2e;color:#bbd;border:1px solid #444;border-radius:3px;font-size:9px;max-width:64px;';
    for (const b of GRIP_BONES) { const o = document.createElement('option'); o.value = b; o.textContent = b.replace(/^(left|right)/, (m) => m === 'left' ? 'L.' : 'R.'); if (b === g.bone) o.selected = true; bsel.appendChild(o); }
    bsel.onchange = () => { g.bone = bsel.value; if (currentVRM) { g.boneNode = currentVRM.humanoid?.getNormalizedBoneNode(g.bone) ?? null; if (g.boneNode && !g.markerMesh) _createGroupMarker(g); } };
    // 頂点数
    const cnt = document.createElement('span');
    cnt.textContent = String(gripCountOf(g.id)); cnt.title = '頂点数';
    cnt.style.cssText = 'flex-shrink:0;color:#8ab;font-size:10px;min-width:14px;text-align:right;';
    // active トグル（プレビュー）
    const act = document.createElement('input');
    act.type = 'checkbox'; act.checked = g.active; act.title = 'グリップ有効(プレビュー)';
    act.style.cssText = 'flex-shrink:0;accent-color:' + hex + ';';
    act.onchange = () => { g.active = act.checked; };
    // 削除
    const del = document.createElement('button');
    del.textContent = '×'; del.title = '削除';
    del.style.cssText = 'flex-shrink:0;width:16px;background:#522;color:#fbb;border:none;border-radius:3px;cursor:pointer;font-size:11px;';
    del.onclick = () => removeGripGroup(g.id);
    row.append(sel, dot, name, bsel, cnt, act, del);
    host.appendChild(row);
  }
}

function addGripGroup() {
  const g = makeGroup(`グループ${gripGroups.length + 1}`, 'leftHand');
  if (currentVRM) { g.boneNode = currentVRM.humanoid?.getNormalizedBoneNode(g.bone) ?? null; if (g.boneNode) _createGroupMarker(g); }
  gripGroups.push(g);
  selectedGroupId = g.id;
  updateGripCounts(); _syncHgpOffsetUI();
}

function removeGripGroup(id) {
  const g = groupById(id);
  if (!g) return;
  _disposeGroupMarker(g);
  for (const [idx, gid] of [...gripMap]) if (gid === id) { gripMap.delete(idx); _updateMarkerVisual(idx); }
  gripGroups = gripGroups.filter(x => x.id !== id);
  if (selectedGroupId === id) selectedGroupId = gripGroups[0]?.id ?? null;
  if (gripGizmo) gripGizmo.detach();
  updateGripCounts(); _syncHgpOffsetUI();
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

// マント変形(tx/ty/tz/ry/scale)のUI（スライダー＋数値入力）を mantleTransform に同期
function syncMantleTransformUI() {
  const set = (id, valId, value, fmt) => {
    const sl = document.getElementById(id), num = document.getElementById(valId);
    if (sl)  sl.value  = value;
    if (num) num.value = fmt(value);
  };
  set('mt-tx',    'mt-tx-val',    mantleTransform.tx,    v => v.toFixed(2));
  set('mt-ty',    'mt-ty-val',    mantleTransform.ty,    v => v.toFixed(2));
  set('mt-tz',    'mt-tz-val',    mantleTransform.tz,    v => v.toFixed(2));
  set('mt-ry',    'mt-ry-val',    mantleTransform.ry,    v => String(Math.round(v)));
  set('mt-scale', 'mt-scale-val', mantleTransform.scale, v => v.toFixed(2));
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
  // グリップ復元：新形式 gripGroups を優先、次に旧 gripIndices(bone別)、無ければ legacy(left/right)
  gripMap.clear();
  for (const g of gripGroups) _disposeGroupMarker(g);
  gripGroups = [];
  const _bindBone = (g) => { if (currentVRM) { g.boneNode = currentVRM.humanoid?.getNormalizedBoneNode(g.bone) ?? null; if (g.boneNode) _createGroupMarker(g); } };
  if (Array.isArray(json.gripGroups) && json.gripGroups.length) {
    for (const gd of json.gripGroups) {
      const g = makeGroup(gd.name || gd.bone, gd.bone, typeof gd.color === 'number' ? gd.color : undefined);
      if (gd.id) { g.id = gd.id; _gidCounter = Math.max(_gidCounter, +((`${gd.id}`.match(/\d+/) || [0])[0])); }
      if (gd.offset) g.offset.set(gd.offset[0], gd.offset[1], gd.offset[2]);
      gripGroups.push(g); _bindBone(g);
      for (const idx of (gd.vertices || [])) gripMap.set(idx, g.id);
    }
  } else {
    ensureDefaultGroups();
    for (const g of gripGroups) _bindBone(g);
    const byBone = (bone) => gripGroups.find(g => g.bone === bone);
    if (json.gripIndices) {  // 旧4キー形式（bone名キー）
      for (const bone of ['leftHand', 'rightHand', 'leftLowerArm', 'rightLowerArm']) {
        const g = byBone(bone); if (!g) continue;
        for (const idx of (json.gripIndices[bone] || [])) gripMap.set(idx, g.id);
        const off = json.gripOffsets?.[bone]; if (off) g.offset.set(off[0], off[1], off[2]);
      }
    } else {  // legacy left/right
      const addLegacy = (indices, bone, off) => {
        const g = byBone(bone); if (!g) return;
        if (indices) for (const idx of indices) gripMap.set(idx, g.id);
        if (off) g.offset.set(off[0], off[1], off[2]);
      };
      addLegacy(json.leftGripIndices, 'leftHand', json.handGrabOffsets?.left);
      addLegacy(json.rightGripIndices, 'rightHand', json.handGrabOffsets?.right);
    }
  }
  selectedGroupId = gripGroups[0]?.id ?? null;
  _syncHgpOffsetUI();
  updateGripCounts();

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

  // マント位置（エディタ変形）を復元。positions は変形前なので二重適用にならない。
  const et = json.editorTransform;
  if (et) {
    mantleTransform.tx = et.tx ?? 0; mantleTransform.ty = et.ty ?? 0; mantleTransform.tz = et.tz ?? 0;
    mantleTransform.ry = et.ry ?? 0; mantleTransform.scale = et.scale ?? 1.0;
  } else {
    mantleTransform.tx = 0; mantleTransform.ty = 0; mantleTransform.tz = 0;
    mantleTransform.ry = 0; mantleTransform.scale = 1.0;
  }
  syncMantleTransformUI();

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
  gripMap.clear();
  updateGripCounts();
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
  } else if (gripMap.has(idx)) {
    const _gg = groupById(gripMap.get(idx));
    mat.color.set(_gg ? _gg.color : 0xffffff); mat.opacity = 1.0; mat.transparent = false;
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

// 選択中グループへ頂点を割当/解除。重複禁止（ピン・アンカー・他グリップから除外）。
function toggleGrip(idx) {
  if (!gripEditMode || !selectedGroupId) return;
  if (gripMap.get(idx) === selectedGroupId) {
    gripMap.delete(idx);
  } else {
    pinnedSet.delete(idx);
    anchorMap.delete(idx);
    gripMap.set(idx, selectedGroupId);
  }
  _updateMarkerVisual(idx);
  updateGripCounts();
}

function resetGrips() {
  const indices = [...gripMap.keys()];
  gripMap.clear();
  for (const i of indices) _updateMarkerVisual(i);
  updateGripCounts();
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

function updatePinTargets() {
  if (!simData?.bonePinTargetBuffer) return;
  if (!anchorMap.size && !gripMap.size) return;
  const arr = simData.bonePinTargetBuffer.value.array;  // vec4 [x,y,z,active]
  // アンカー：頂点ごとのローカルオフセットで追従（active=1）
  for (const [idx, a] of anchorMap) {
    if (!a.boneNode) continue;
    a.boneNode.getWorldPosition(_anchorTmp);
    a.boneNode.getWorldQuaternion(_anchorBoneQuat);
    _anchorWorldOff.copy(a.localOffset).applyQuaternion(_anchorBoneQuat);
    arr[idx*4] = _anchorTmp.x + _anchorWorldOff.x; arr[idx*4+1] = _anchorTmp.y + _anchorWorldOff.y; arr[idx*4+2] = _anchorTmp.z + _anchorWorldOff.z; arr[idx*4+3] = 1;
  }
  // グリップ：所属グループのグラブ点 worldPos へ吸着、w にグループ active(0/1)
  for (const [idx, gid] of gripMap) {
    const g = groupById(gid);
    if (!g || !g.boneNode) { arr[idx*4+3] = 0; continue; }
    arr[idx*4] = g.worldPos.x; arr[idx*4+1] = g.worldPos.y; arr[idx*4+2] = g.worldPos.z; arr[idx*4+3] = g.active ? 1 : 0;
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

  // アンカー＋グリップ：頂点ごとの初期ターゲット座標（boneWorldPos + rotate(localOffset)）を事前計算。
  // フレームごとに updatePinTargets() で更新される。アンカー=常時、グリップ=対応マスク有効時に吸着。
  // per-vertex vec4 [x,y,z,active]：xyz=吸着ターゲット, w=有効(1)/無効(0)。
  // バッファ数を増やさないため active を別バッファにせず w に格納（compute storage 上限対策）。
  const hasPinTargets = anchorMap.size > 0 || gripMap.size > 0;
  const bonePinTargetArr = new Float32Array(vertexCount * 4);
  if (hasPinTargets) {
    updateHandGrabPoints();   // 各グループのグラブ点 worldPos を最新化（offset+bone）
    const tmp      = new THREE.Vector3();
    const boneQuat = new THREE.Quaternion();
    const worldOff = new THREE.Vector3();
    // アンカー：頂点ごとのローカルオフセット（常時active=1。シェーダ側で code==1 は常時吸着）
    for (const [idx, a] of anchorMap) {
      if (!a.boneNode) continue;
      a.boneNode.getWorldPosition(tmp);
      a.boneNode.getWorldQuaternion(boneQuat);
      worldOff.copy(a.localOffset).applyQuaternion(boneQuat);
      bonePinTargetArr[idx*4] = tmp.x + worldOff.x; bonePinTargetArr[idx*4+1] = tmp.y + worldOff.y; bonePinTargetArr[idx*4+2] = tmp.z + worldOff.z; bonePinTargetArr[idx*4+3] = 1;
    }
    // グリップ：所属グループのグラブ点 worldPos へ吸着（w=グループactive）
    for (const [idx, gid] of gripMap) {
      const g = groupById(gid);
      if (!g || !g.boneNode) continue;
      bonePinTargetArr[idx*4] = g.worldPos.x; bonePinTargetArr[idx*4+1] = g.worldPos.y; bonePinTargetArr[idx*4+2] = g.worldPos.z; bonePinTargetArr[idx*4+3] = g.active ? 1 : 0;
    }
  }

  for (let i = 0; i < vertexCount; i++) {
    const isAnchor = anchorMap.has(i);
    const gid      = gripMap.get(i);
    const gg       = gid ? groupById(gid) : null;
    const isGrip   = gg && gg.boneNode;
    // アンカー/グリップ頂点は isFixed=0（シミュしつつシェーダーでターゲットへ吸着）
    const isFixed = (!isAnchor && !isGrip && pinnedSet.has(i)) ? 1 : 0;
    // gripCode: 0=なし, 1=アンカー(常時吸着), 2=グリップ(所属グループがactive時に吸着)
    let gripCode = 0;
    if (isAnchor) gripCode = 1;
    else if (isGrip) gripCode = 2;
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

  // ── アンカー＋グリップの per-vertex ターゲットバッファ（いずれかがある場合のみ）──
  const bonePinTargetBuffer = hasPinTargets ? instancedArray(bonePinTargetArr, 'vec4') : null;

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

    // アンカー＋グリップ：事前計算済み per-vertex ターゲットへ吸着
    // code 1=アンカー(常時) / 2=L手 / 3=R手 / 4=L肘 / 5=R肘（対応マスクが有効な時）
    if (hasPinTargets) {
      const tgt = bonePinTargetBuffer.element(instanceIndex).toVar('tgt');  // xyz=ターゲット, w=active
      const snap = () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(tgt.xyz);
        Return();
      };
      If(gripCode.equal(1), snap);   // アンカー（常時）
      If(gripCode.equal(2), () => { If(tgt.w.greaterThan(0.5), snap); });  // グリップ（グループactive時）
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
    if (gripGizmo && gripGizmo.dragging) return;   // 移動ギズモ操作中は他の掴みを抑制

    // ── グラブ点マーカー球のドラッグ（全グループ・優先度最高）──
    if (!gripEditMode && !pinMode) {
      for (const g of gripGroups) {
        if (!g.markerMesh || !g.markerMesh.visible) continue;
        const p  = g.worldPos.clone().project(camera);
        if (p.z > 1) continue;
        const sx = (p.x *  0.5 + 0.5) * window.innerWidth;
        const sy = (p.y * -0.5 + 0.5) * window.innerHeight;
        if (Math.hypot(sx - e.clientX, sy - e.clientY) < 22) {
          _hgpDragSide = g.id;
          selectedGroupId = g.id; updateGripCounts(); _syncHgpOffsetUI();
          if (gripGizmo) gripGizmo.attach(g.markerMesh);   // 移動ギズモをこのマーカーへ
          const normal = g.worldPos.clone().sub(camera.position).normalize();
          _hgpDragPlane.setFromNormalAndCoplanarPoint(normal, g.worldPos);
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
      toggleGrip(idx);
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
        const g = groupById(_hgpDragSide);
        if (g && g.boneNode) {
          const bonePos = new THREE.Vector3(), boneQuat = new THREE.Quaternion();
          g.boneNode.getWorldPosition(bonePos);
          g.boneNode.getWorldQuaternion(boneQuat);
          // ワールドのドラッグ位置 → 関節ローカルオフセット（回転考慮）
          g.offset.copy(hit).sub(bonePos).applyQuaternion(boneQuat.invert()).clampScalar(-0.4, 0.4);
          if (g.id === selectedGroupId) _syncHgpOffsetUI();
        }
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

// テスト用キー: R=右手 / L=左手 / E=R肘 / K=L肘（押下中、そのボーンの全グループを active）
function setupGripKeyEvents() {
  const _isField = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const _set = (bone, on) => {
    if (on && (!simRunning || !simData)) return;
    for (const g of gripGroups) if (g.bone === bone && g.boneNode) g.active = on;
    updateGripCounts();
  };
  window.addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || _isField(e.target)) return;
    const bone = GRIP_KEY_BONE[e.code];
    if (bone) _set(bone, true);
  });
  window.addEventListener('keyup', e => {
    const bone = GRIP_KEY_BONE[e.code];
    if (bone) _set(bone, false);
  });
}

// ============================================================
// Grip Edit Mode Helper（頂点割当モードのON/OFF）
// ============================================================

function _setGripEditMode(on) {
  gripEditMode = !!on;
  const btn = document.getElementById('btn-grip-mode');
  if (btn) { btn.classList.toggle('active', gripEditMode); btn.textContent = gripEditMode ? '頂点割当モード ON' : '頂点割当モード OFF'; }
  const mode = gripEditMode;

  // グリップ編集モードON時はピン/アンカー編集を解除（移動ギズモも外す＝頂点クリックを妨げない）
  if (mode && gripGizmo) gripGizmo.detach();
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
  // グリップ：名前付きグループ（id/name/bone/offset/vertices）
  const vertsByGroup = {};
  for (const [idx, gid] of gripMap) (vertsByGroup[gid] ??= []).push(idx);
  const gripGroupsOut = gripGroups.map(g => ({
    id: g.id, name: g.name, bone: g.bone, color: g.color,
    offset: [g.offset.x, g.offset.y, g.offset.z],
    vertices: vertsByGroup[g.id] || [],
  }));
  // 互換: ゲーム/cloth-preview 用に leftHand/rightHand bone のグループを従来フィールドへ合成（union）
  const unionByBone = (bone) => { const r = []; for (const g of gripGroups) if (g.bone === bone) r.push(...(vertsByGroup[g.id] || [])); return r; };
  const firstOff = (bone) => { const g = gripGroups.find(x => x.bone === bone); return g ? [g.offset.x, g.offset.y, g.offset.z] : [0, 0, 0]; };
  const leftGripIndices  = unionByBone('leftHand');
  const rightGripIndices = unionByBone('rightHand');
  const handGrabOffsets  = { left: firstOff('leftHand'), right: firstOff('rightHand') };
  // 球コライダー：ボーン相対オフセット + 半径で保存（ボーン名で再バインドするため絶対座標は保存しない）
  const colliderData = colliders
    .filter(c => c.boneName)
    .map(c => ({ boneName: c.boneName, r: c.r, offset: [c.localOffset.x, c.localOffset.y, c.localOffset.z] }));
  return {
    ...mantleData,
    gripGroups: gripGroupsOut,
    leftGripIndices,
    rightGripIndices,
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
  showToast(`エクスポート完了 (グリップ${gripGroups.length}グループ / ${gripMap.size}点)`);
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

// dataURI(base64) → Blob
function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 書き出した npc.json(.npc.json) を再インポート：VRM → cloth → (VRMA/timeline) を復元。
async function importNPCBundle(bundle) {
  if (!bundle || !bundle.vrm) { showToast('VRM を含まないファイルです', 'error'); return; }
  showToast('再インポート中…');
  try {
    const name = bundle.name || 'imported';
    // 1) VRM を Blob→File 化して読み込み（currentVRMFile も設定＝再書き出し可能に）
    const vrmFile = new File([dataURIToBlob(bundle.vrm)], `${name}.vrm`, { type: 'application/octet-stream' });
    const meshes = await loadVRM(vrmFile);
    currentVRMFile = vrmFile;
    updateMeshList();
    _populateAnchorBoneDropdown(currentVRM);

    // 2) cloth（マント）復元：currentVRM があるので pin/grip/アンカー/コライダーまで復元される
    if (bundle.cloth) loadMantleJSON(bundle.cloth);

    // 3) VRMA（埋め込み）復元：プレビュー＋再書き出し用に dataURI を保持
    currentVRMADataURI = null;
    if (bundle.vrma) {
      try {
        unloadVRMA();
        const loader = new GLTFLoader();
        loader.register(parser => new VRMAnimationLoaderPlugin(parser));
        const url = URL.createObjectURL(dataURIToBlob(bundle.vrma));
        const gltf = await loader.loadAsync(url);
        URL.revokeObjectURL(url);
        const vrmAnims = gltf.userData.vrmAnimations;
        if (vrmAnims?.length) {
          vrmaClip   = createVRMAnimationClip(vrmAnims[0], currentVRM);
          mixer      = new THREE.AnimationMixer(currentVRM.scene);
          vrmaAction = mixer.clipAction(vrmaClip);
          vrmaAction.setLoop(THREE.LoopRepeat, Infinity);
          vrmaAction.play();
          vrmaAction.paused = true;
          vrmaPlaying = false;
          _updateVrmaButtons();
          currentVRMADataURI = bundle.vrma;
          currentVRMAName = `${name}.vrma`;
        }
      } catch (e) { console.warn('VRMA 復元失敗', e); }
    }

    // 4) timeline 保持（再書き出しで再添付）
    importedTimeline = bundle.timeline ?? null;

    const parts = ['VRM', bundle.vrma ? 'VRMA' : null, 'Cloth', bundle.timeline ? 'Timeline' : null].filter(Boolean);
    showToast(`再インポート完了（${parts.join(' + ')}）`);
  } catch (err) {
    showToast(`再インポート失敗: ${err.message}`, 'error');
    console.error(err);
  }
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

    // VRMA バイト。再インポートで埋め込みを保持していればそれを再利用。なければサーバ取得。
    let vrmaDataURI = null;
    if (currentVRMADataURI) {
      vrmaDataURI = currentVRMADataURI;
    } else if (currentVRMAName) {
      const res = await fetch(`/vrma/${currentVRMAName}`);
      if (res.ok) {
        vrmaDataURI = 'data:application/octet-stream;base64,' + arrayBufferToBase64(await res.arrayBuffer());
      } else {
        showToast(`VRMA取得失敗（${currentVRMAName}）。VRMAなしで続行`, 'warn');
      }
    }

    // timeline.json：外部ファイルが指定されていればそれ、なければ再インポートで保持したもの。
    let timeline = null;
    const tlInput = document.getElementById('bundle-tl-file');
    const tlFile  = tlInput?.files?.[0];
    if (tlFile) {
      timeline = JSON.parse(await tlFile.text());
    } else if (importedTimeline) {
      timeline = importedTimeline;
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
  gripMap.clear();
  updateGripCounts();

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

  // NPCバンドル(.npc.json) 再インポート
  const importNpcInput = document.getElementById('import-npc-file');
  importNpcInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    importNpcInput.value = '';
    try {
      const bundle = JSON.parse(await file.text());
      await importNPCBundle(bundle);
    } catch (err) {
      showToast(`再インポート失敗: ${err.message}`, 'error');
    }
  });
  document.getElementById('btn-import-npc').addEventListener('click', () => importNpcInput.click());

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
    currentVRMADataURI = null;   // サーバ選択を優先（埋め込み保持を解除）
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
    currentVRMADataURI = null;
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

  // グリップ：グループ追加・頂点割当モード・リセット
  document.getElementById('btn-grip-add')?.addEventListener('click', addGripGroup);
  document.getElementById('btn-grip-mode')?.addEventListener('click', () => _setGripEditMode(!gripEditMode));
  document.getElementById('btn-grip-reset')?.addEventListener('click', () => {
    resetGrips();
    showToast('グリップ割当をリセットしました');
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

  // グラブ点オフセットスライダー（選択中グループに対して動作）
  for (const axis of ['x', 'y', 'z']) {
    const sl = document.getElementById(`grip-off-${axis}`);
    const vl = document.getElementById(`grip-off-${axis}-val`);
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const g = groupById(selectedGroupId);
      if (g) g.offset[axis] = parseFloat(sl.value);
      if (vl) vl.textContent = parseFloat(sl.value).toFixed(2);
    });
  }
  document.getElementById('hgp-visible')?.addEventListener('change', e => {
    for (const g of gripGroups) if (g.markerMesh) g.markerMesh.visible = e.target.checked;
  });
  document.getElementById('btn-hgp-reset')?.addEventListener('click', () => {
    const g = groupById(selectedGroupId);
    if (g) { g.offset.set(0, 0, 0); _syncHgpOffsetUI(); }
    showToast('選択グループのオフセットをリセットしました');
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
    // アンカー/グリップのターゲット座標＋グリップ頂点の active(0/1) を更新
    updatePinTargets();
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

  // グラブ点の移動ギズモ（マーカーをクリックでアタッチ、矢印ドラッグで offset 調整）
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

  setupUI();
  setupGrabEvents(renderer.domElement);
  setupGripKeyEvents();

  // デバッグ用 公開 API（グループ id 単位でグリップ活性化）
  window.clothAPI = {
    grip(id)    { const g = groupById(id); if (g) g.active = true; },
    release(id) { const g = groupById(id); if (g) g.active = false; },
    groups()    { return gripGroups.map(g => ({ id: g.id, name: g.name, bone: g.bone, count: gripCountOf(g.id), active: g.active })); },
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

// 右パネルの幅をドラッグでリサイズ（左端のハンドルを掴んで伸び縮み）
// 左パネルの幅をドラッグでリサイズ（右端ハンドル。縦スクロールに影響しないよう fixed 配置で追従）
(function setupLeftPanelResize() {
  const panel = document.getElementById('panel-left');
  const grip  = document.getElementById('panel-left-resizer');
  if (!panel || !grip) return;
  const place = () => { grip.style.left = `${panel.getBoundingClientRect().width - 3}px`; };
  place();
  window.addEventListener('resize', place);
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true; grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none'; e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(window.innerWidth * 0.6, e.clientX));
    panel.style.width = `${w}px`;
    place();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false; document.body.style.userSelect = '';
    try { grip.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();

(function setupPanelResize() {
  const panel = document.getElementById('panel-right');
  const grip  = document.getElementById('panel-right-resizer');
  if (!panel || !grip) return;
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(window.innerWidth * 0.6, window.innerWidth - e.clientX));
    panel.style.width = `${w}px`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    try { grip.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();
