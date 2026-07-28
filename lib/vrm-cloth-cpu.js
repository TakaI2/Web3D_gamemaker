// vrm-cloth-cpu.js — VRMマント布のCPU(力ベースVerlet)実装。WebGLRendererで動く＝WebXR対応。
// lib/vrm-cloth.js（WebGPUコンピュート版）と同じ cloth.json / timeline を受け取り、同じ物理モデル
// （バネ力・重力0.00005・減衰0.99・球/カプセルコライダー・ボーンアンカー・タイムライングリップ）を
// JSで計算する。頂点数は数千まで（マント用途）を想定。
import * as THREE from 'https://esm.sh/three@0.184.0';

const MAX_COLLIDERS = 24;
const BONE_COLLIDER_DEFS = [
  { bone: 'head', r: 0.10 }, { bone: 'neck', r: 0.06 }, { bone: 'chest', r: 0.14 },
  { bone: 'spine', r: 0.12 }, { bone: 'hips', r: 0.13 }, { bone: 'leftShoulder', r: 0.07 },
  { bone: 'rightShoulder', r: 0.07 }, { bone: 'upperChest', r: 0.13 },
  { bone: 'leftFoot', r: 0.06 }, { bone: 'rightFoot', r: 0.06 },
];
const BONE_CAPSULE_DEFS = [
  { bone: 'leftUpperArm', bone2: 'leftLowerArm', r: 0.050 }, { bone: 'leftLowerArm', bone2: 'leftHand', r: 0.042 },
  { bone: 'rightUpperArm', bone2: 'rightLowerArm', r: 0.050 }, { bone: 'rightLowerArm', bone2: 'rightHand', r: 0.042 },
  { bone: 'leftUpperLeg', bone2: 'leftLowerLeg', r: 0.090 }, { bone: 'leftLowerLeg', bone2: 'leftFoot', r: 0.065 },
  { bone: 'rightUpperLeg', bone2: 'rightLowerLeg', r: 0.090 }, { bone: 'rightLowerLeg', bone2: 'rightFoot', r: 0.065 },
];
const SUBSTEPS = 6, STIFF = 0.2, DAMP = 0.99, GRAV = 0.00005;

const _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _o = new THREE.Vector3();
const _capB = new THREE.Vector3(), _capAxis = new THREE.Vector3();

function resolveGripBone(vrm, boneName) {
  if (!vrm) return null;
  if (boneName === 'leftBreast' || boneName === 'rightBreast') {
    const wantLeft = boneName === 'leftBreast';
    let best = null, bestDepth = Infinity;
    vrm.scene.traverse((obj) => {
      const n = (obj.name || '').toLowerCase();
      if (!/(bust|breast|boob|mune|oppai|chichi)/.test(n)) return;
      const isL = /(^|[^a-z])l([^a-z]|$)|left/.test(n), isR = /(^|[^a-z])r([^a-z]|$)|right/.test(n);
      if (wantLeft ? (!isL || (isR && !isL)) : (!isR || (isL && !isR))) return;
      let d = 0; for (let p = obj.parent; p; p = p.parent) d++;
      if (d < bestDepth) { best = obj; bestDepth = d; }
    });
    return best;
  }
  return vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
}

function applyMantleTransform(orig, vertexCount, tr, basePos) {
  const out = new Float32Array(vertexCount * 3);
  const s = tr?.scale ?? 1;
  const cy = Math.cos((tr?.ry || 0) * Math.PI / 180), sy = Math.sin((tr?.ry || 0) * Math.PI / 180);
  for (let i = 0; i < vertexCount; i++) {
    const x = orig[i * 3] * s, y = orig[i * 3 + 1] * s, z = orig[i * 3 + 2] * s;
    out[i * 3]     = x * cy - z * sy + (tr?.tx || 0) + basePos.x;
    out[i * 3 + 1] = y + (tr?.ty || 0) + basePos.y;
    out[i * 3 + 2] = x * sy + z * cy + (tr?.tz || 0) + basePos.z;
  }
  return out;
}

function computeCapsuleEnds(c) {
  c.boneNode.getWorldPosition(_t); c.boneNode.getWorldQuaternion(_q);
  _t.add(_o.copy(c.localOffset).applyQuaternion(_q));
  c.boneNode2.getWorldPosition(_capB); c.boneNode2.getWorldQuaternion(_q);
  _capB.add(_o.copy(c.localOffset2).applyQuaternion(_q));
  _capAxis.copy(_capB).sub(_t); const L = _capAxis.length() || 1e-6; _capAxis.divideScalar(L);
  const sh = c.axShift || 0, ex = (c.axLen || 0) / 2;
  _t.addScaledVector(_capAxis, sh - ex); _capB.addScaledVector(_capAxis, sh + ex);
  c.x = _t.x; c.y = _t.y; c.z = _t.z; c.x2 = _capB.x; c.y2 = _capB.y; c.z2 = _capB.z;
}

export function createVRMClothCPU(o) {
  const { scene, vrm, cloth, timeline } = o;
  const basePos = o.basePos ?? new THREE.Vector3();
  const floorY = o.floorY ?? -1e9;

  const vertexCount = cloth.vertexCount ?? (cloth.positions.length / 3);
  const springs = cloth.springs;           // [v0,v1, ...]
  const springCount = springs.length / 2;
  let pos = applyMantleTransform(cloth.positions, vertexCount, cloth.editorTransform, basePos);
  let posNext = new Float32Array(vertexCount * 3);   // Jacobi用ダブルバッファ
  const force = new Float32Array(vertexCount * 3);   // 速度相当（毎ステップ減衰＋力加算）
  const MAX_STEP = 0.05;                             // 1ステップの最大移動量（発散防止クランプ）

  // バネの自然長（初期ワールド距離）
  const restLen = new Float32Array(springCount);
  for (let s = 0; s < springCount; s++) {
    const a = springs[s * 2] * 3, b = springs[s * 2 + 1] * 3;
    restLen[s] = Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]);
  }
  // 頂点→所属バネ隣接をCSR（フラット配列）で構築。配列の配列＋for...ofより大幅に速い。
  // vsNbr=相手頂点index, vsRest=自然長 を [vsStart[v], vsStart[v+1]) に格納。
  const vsStart = new Uint32Array(vertexCount + 1);
  for (let s = 0; s < springCount; s++) { vsStart[springs[s * 2] + 1]++; vsStart[springs[s * 2 + 1] + 1]++; }
  for (let i = 0; i < vertexCount; i++) vsStart[i + 1] += vsStart[i];
  const vsNbr = new Uint32Array(vsStart[vertexCount]);
  const vsRest = new Float32Array(vsStart[vertexCount]);
  const _cursor = vsStart.slice(0, vertexCount);
  for (let s = 0; s < springCount; s++) {
    const a = springs[s * 2], b = springs[s * 2 + 1], r = restLen[s];
    const ia = _cursor[a]++; vsNbr[ia] = b; vsRest[ia] = r;
    const ib = _cursor[b]++; vsNbr[ib] = a; vsRest[ib] = r;
  }

  // ── ボーンアンカー（常時吸着）──
  const anchorMap = new Map();
  const anchorData = cloth.anchorAssignments ?? cloth.pinnedBoneAssignments;
  if (anchorData) {
    for (const e of anchorData) {
      const boneNode = vrm.humanoid?.getNormalizedBoneNode(e.boneName);
      if (!boneNode) continue;
      let localOffset;
      if (e.localOffset) localOffset = new THREE.Vector3(...e.localOffset);
      else if (e.offset) { boneNode.getWorldQuaternion(_q); localOffset = new THREE.Vector3(...e.offset).applyQuaternion(_q.invert()); }
      else continue;
      anchorMap.set(e.vertexIdx, { boneNode, localOffset });
    }
  }
  // アンカーの吸着先を「現在の姿勢での初期位置(pos=snap)」に合わせて再計算する。
  // 保存されたlocalOffsetは作成時(cloth-editor)の姿勢基準なので、ここでVRMAにより姿勢が
  // 変わっていると初期位置とズレて開始時にマントが飛ぶ。これで設定位置から飛ばず、以降ボーンに追従する。
  for (const [idx, a] of anchorMap) {
    if (!a.boneNode) continue;
    a.boneNode.getWorldPosition(_t);
    a.boneNode.getWorldQuaternion(_q);
    a.localOffset = new THREE.Vector3(
      pos[idx * 3] - _t.x, pos[idx * 3 + 1] - _t.y, pos[idx * 3 + 2] - _t.z,
    ).applyQuaternion(_q.invert());
  }
  // ── グリップグループ（timeline範囲でON）──
  const gripGroups = [], gripMap = new Map();
  const groupById = (id) => gripGroups.find(g => g.id === id);
  const addGroup = (id, bone, offArr, verts) => {
    const boneNode = resolveGripBone(vrm, bone);
    const offset = new THREE.Vector3(); if (offArr) offset.set(offArr[0], offArr[1], offArr[2]);
    gripGroups.push({ id, bone, boneNode, offset, worldPos: new THREE.Vector3(), active: false });
    if (Array.isArray(verts)) for (const vi of verts) if (!gripMap.has(vi)) gripMap.set(vi, id);
  };
  if (Array.isArray(cloth.gripGroups) && cloth.gripGroups.length) {
    for (const g of cloth.gripGroups) addGroup(g.id, g.bone, g.offset, g.vertices);
  } else {
    if (cloth.leftGripIndices?.length) addGroup('leftHand', 'leftHand', cloth.handGrabOffsets?.left, cloth.leftGripIndices);
    if (cloth.rightGripIndices?.length) addGroup('rightHand', 'rightHand', cloth.handGrabOffsets?.right, cloth.rightGripIndices);
  }
  // グリップ範囲（timeline由来）。演技(タイムライン)差し替えで作り直せるよう関数化。
  const gripRanges = new Map();
  function setTimeline(tl) {
    gripRanges.clear();
    for (const trk of (tl?.tracks ?? [])) {
      if (trk.kind !== 'grip') continue;
      const gid = (trk.groupId && groupById(trk.groupId)) ? trk.groupId : (trk.side ? gripGroups.find(g => g.bone === (trk.side === 'left' ? 'leftHand' : 'rightHand'))?.id : null);
      if (!gid) continue;
      const arr = gripRanges.get(gid) ?? [];
      if (Array.isArray(trk.ranges)) for (const r of trk.ranges) arr.push({ start: r.start, end: r.end });
      gripRanges.set(gid, arr);
    }
  }
  setTimeline(timeline);
  const gripActiveAt = (ranges, frame) => { if (!ranges || frame == null) return false; for (const r of ranges) if (frame >= r.start && frame <= r.end) return true; return false; };

  // gripCode: 0=なし, 1=アンカー, 2=グリップ / target[vec4]
  const gripCode = new Uint8Array(vertexCount);
  const target = new Float32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) gripCode[i] = anchorMap.has(i) ? 1 : ((gripMap.has(i) && groupById(gripMap.get(i))?.boneNode) ? 2 : 0);

  // ── コライダー（球＋カプセル、ボーン追従）──
  const saved = cloth.colliders ?? null;
  const colliders = [];
  for (const def of BONE_COLLIDER_DEFS) {
    const node = vrm.humanoid?.getNormalizedBoneNode(def.bone); if (!node) continue;
    const sv = saved?.find(s => s.boneName === def.bone && s.type !== 'capsule');
    const localOffset = (sv && sv.offset) ? new THREE.Vector3(...sv.offset) : new THREE.Vector3();
    colliders.push({ type: 'sphere', r: sv ? sv.r : def.r, boneNode: node, localOffset, x: 0, y: 0, z: 0 });
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  for (const def of BONE_CAPSULE_DEFS) {
    if (colliders.length >= MAX_COLLIDERS) break;
    const n1 = vrm.humanoid?.getNormalizedBoneNode(def.bone), n2 = vrm.humanoid?.getNormalizedBoneNode(def.bone2);
    if (!n1 || !n2) continue;
    const sv = saved?.find(s => s.type === 'capsule' && s.boneName === def.bone && s.boneName2 === def.bone2);
    const c = { type: 'capsule', r: sv ? sv.r : def.r, boneNode: n1, boneNode2: n2,
      localOffset: (sv && sv.offset) ? new THREE.Vector3(...sv.offset) : new THREE.Vector3(),
      localOffset2: (sv && sv.offset2) ? new THREE.Vector3(...sv.offset2) : new THREE.Vector3(),
      axShift: sv?.axShift || 0, axLen: sv?.axLen || 0, x: 0, y: 0, z: 0, x2: 0, y2: 0, z2: 0 };
    computeCapsuleEnds(c); colliders.push(c);
  }

  // ── メッシュ ──
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  geo.setAttribute('position', posAttr);
  geo.setIndex(Array.from(cloth.indices));
  posAttr.array.set(pos);
  geo.computeVertexNormals();

  const m = cloth.material ?? {};
  const opacity = m.opacity ?? 0.85;
  // 布を「表シェル(+法線へ押出)」と「裏シェル(-法線へ押出)」の2枚で描く＝見かけの厚み。
  // 折り重なっても表裏の面が空間的に離れ、深度の前後が安定して突き抜け(裏地が表に出る等)を抑える。
  // 物理は1枚のまま（geo/位置は共有、押し出しは頂点シェーダのみ＝見た目だけ）。
  const uThick = { value: 0.006 };   // シェル半厚(m)。表裏の間隔=2*これ
  function makeSideMat(side, colorHex, dir) {
    const mat = new THREE.MeshPhysicalMaterial({
      side, transparent: opacity < 1.0, opacity,
      roughness: m.roughness ?? 1.0, metalness: 0.0,
      sheen: m.sheen ?? 1.0, sheenRoughness: m.sheenRoughness ?? 0.5,
      sheenColor: m.sheenColor ? new THREE.Color(m.sheenColor) : new THREE.Color(0xffffff),
      color: new THREE.Color(colorHex),
      // 裏(内)だけ深度を奥へ寄せる。平行に重なっても外側(表)が深度で勝ち、裏地の突き抜けを抑える。
      // 表は動かさない（動かすと縁に隙間→裏地の線が出るため）。
      polygonOffset: dir < 0, polygonOffsetFactor: 2.5, polygonOffsetUnits: 5.0,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uThick = uThick;
      sh.vertexShader = 'uniform float uThick;\n' + sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  transformed += normalize(objectNormal) * (uThick * ' + dir.toFixed(1) + ');');
    };
    mat.customProgramCacheKey = () => 'clothshell' + dir;
    return mat;
  }
  const matFront = makeSideMat(THREE.FrontSide, m.colorFront ?? '#204080', 1);   // 表=外へ
  const matBack = makeSideMat(THREE.BackSide, m.colorBack ?? '#803020', -1);     // 裏=内へ
  const clothMesh = new THREE.Group();   // 表裏2メッシュ＋縁の壁をまとめて可視/位置を扱う
  const meshFront = new THREE.Mesh(geo, matFront); meshFront.frustumCulled = false;
  const meshBack = new THREE.Mesh(geo, matBack); meshBack.frustumCulled = false;
  clothMesh.add(meshBack, meshFront);

  // ── 縁の壁: 境界エッジ（1三角形にしか属さない開いた縁）に、表シェルと裏シェルを繋ぐ帯を張る。
  // 厚みで開いた表裏の隙間を裏地色で塞ぎ、断面が見えて厚い布らしくなる（隙間の抜けを解消）。
  const _bIdx = cloth.indices;
  const _ec = new Map();
  const _ekey = (a, b) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let t = 0; t < _bIdx.length; t += 3) {
    const a = _bIdx[t], b = _bIdx[t + 1], c = _bIdx[t + 2];
    _ec.set(_ekey(a, b), (_ec.get(_ekey(a, b)) || 0) + 1);
    _ec.set(_ekey(b, c), (_ec.get(_ekey(b, c)) || 0) + 1);
    _ec.set(_ekey(c, a), (_ec.get(_ekey(c, a)) || 0) + 1);
  }
  const boundaryEdges = [];
  for (let t = 0; t < _bIdx.length; t += 3) {
    const a = _bIdx[t], b = _bIdx[t + 1], c = _bIdx[t + 2];
    if (_ec.get(_ekey(a, b)) === 1) boundaryEdges.push(a, b);
    if (_ec.get(_ekey(b, c)) === 1) boundaryEdges.push(b, c);
    if (_ec.get(_ekey(c, a)) === 1) boundaryEdges.push(c, a);
  }
  const edgeN = boundaryEdges.length / 2;
  const edgePos = new Float32Array(edgeN * 4 * 3);
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
  const _eIdx = [];
  for (let e = 0; e < edgeN; e++) { const b = e * 4; _eIdx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
  edgeGeo.setIndex(_eIdx);
  const edgeMat = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide, transparent: opacity < 1.0, opacity, metalness: 0.0,
    roughness: m.roughness ?? 1.0, sheen: m.sheen ?? 1.0, sheenRoughness: m.sheenRoughness ?? 0.5,
    color: new THREE.Color(m.colorFront ?? '#204080'),   // 縁の壁は表地色
  });
  const edgeMesh = new THREE.Mesh(edgeGeo, edgeMat); edgeMesh.frustumCulled = false;
  clothMesh.add(edgeMesh);
  function updateEdges() {
    const t = uThick.value;
    if (t <= 1e-5) { edgeMesh.visible = false; return; }
    edgeMesh.visible = true;
    const nrm = geo.attributes.normal.array, pa = posAttr.array;
    for (let e = 0; e < edgeN; e++) {
      const a3 = boundaryEdges[e * 2] * 3, b3 = boundaryEdges[e * 2 + 1] * 3, o = e * 12;
      let nax = nrm[a3], nay = nrm[a3 + 1], naz = nrm[a3 + 2]; let nl = Math.sqrt(nax * nax + nay * nay + naz * naz) || 1; nax /= nl; nay /= nl; naz /= nl;
      let nbx = nrm[b3], nby = nrm[b3 + 1], nbz = nrm[b3 + 2]; nl = Math.sqrt(nbx * nbx + nby * nby + nbz * nbz) || 1; nbx /= nl; nby /= nl; nbz /= nl;
      edgePos[o] = pa[a3] + nax * t; edgePos[o + 1] = pa[a3 + 1] + nay * t; edgePos[o + 2] = pa[a3 + 2] + naz * t;         // a表
      edgePos[o + 3] = pa[b3] + nbx * t; edgePos[o + 4] = pa[b3 + 1] + nby * t; edgePos[o + 5] = pa[b3 + 2] + nbz * t;     // b表
      edgePos[o + 6] = pa[b3] - nbx * t; edgePos[o + 7] = pa[b3 + 1] - nby * t; edgePos[o + 8] = pa[b3 + 2] - nbz * t;     // b裏
      edgePos[o + 9] = pa[a3] - nax * t; edgePos[o + 10] = pa[a3 + 1] - nay * t; edgePos[o + 11] = pa[a3 + 2] - naz * t;   // a裏
    }
    edgeGeo.attributes.position.needsUpdate = true;
    edgeGeo.computeVertexNormals();
  }
  scene.add(clothMesh);

  // ── コライダー衝突（点を球/カプセルの外へ押し出し）──
  // 最適化: activeColliders（毎フレームのカリング済み集合）だけ走査、カプセルの軸ベクトルは
  // フレーム冒頭でキャッシュ(_abx.._invab2)、距離は二乗で早期判定し貫通時のみ sqrt。
  const activeColliders = [];
  // 位置 p=[x,y,z] をコライダーの外(面ちょうど)へ射影する。等倍押し出し＝跳ね返り無し。
  function collidePos(p) {
    for (let i = 0; i < activeColliders.length; i++) {
      const c = activeColliders[i];
      let cx = c.x, cy = c.y, cz = c.z;
      if (c.type === 'capsule') {   // A-B線分の最近点（軸ベクトルはキャッシュ済み）
        let t = ((p[0] - c.x) * c._abx + (p[1] - c.y) * c._aby + (p[2] - c.z) * c._abz) * c._invab2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        cx = c.x + c._abx * t; cy = c.y + c._aby * t; cz = c.z + c._abz * t;
      }
      const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < c._r2) {   // 貫通時のみ sqrt
        const d = Math.sqrt(d2) || 1e-6;
        const push = (c.r - d) / d;
        p[0] += dx * push; p[1] += dy * push; p[2] += dz * push;
      }
    }
  }
  const _np = [0, 0, 0];

  let disposed = false, lastMs = 0, lastNormalMs = 0;
  function update(dt, frame) {
    if (disposed) return;
    const _perf0 = performance.now();
    // グリップ active＋グラブ点、アンカー/グリップ target 更新
    for (const g of gripGroups) {
      g.active = !!g.boneNode && gripActiveAt(gripRanges.get(g.id), frame);
      if (g.active) { g.boneNode.getWorldPosition(_t); g.boneNode.getWorldQuaternion(_q); g.worldPos.copy(_t).add(_o.copy(g.offset).applyQuaternion(_q)); }
    }
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      boneNode.getWorldPosition(_t); boneNode.getWorldQuaternion(_q); _o.copy(localOffset).applyQuaternion(_q);
      target[idx * 4] = _t.x + _o.x; target[idx * 4 + 1] = _t.y + _o.y; target[idx * 4 + 2] = _t.z + _o.z; target[idx * 4 + 3] = 1;
    }
    for (const [idx, gid] of gripMap) {
      const g = groupById(gid); if (!g) continue;
      target[idx * 4] = g.worldPos.x; target[idx * 4 + 1] = g.worldPos.y; target[idx * 4 + 2] = g.worldPos.z; target[idx * 4 + 3] = g.active ? 1 : 0;
    }
    // コライダー追従＋フレーム単位のキャッシュ（軸ベクトル・半径²・代表点・到達半径）
    for (const c of colliders) {
      if (c.type === 'capsule') {
        computeCapsuleEnds(c);
        c._abx = c.x2 - c.x; c._aby = c.y2 - c.y; c._abz = c.z2 - c.z;
        const ab2 = c._abx * c._abx + c._aby * c._aby + c._abz * c._abz || 1e-6;
        c._invab2 = 1 / ab2;
        c._cx = (c.x + c.x2) * 0.5; c._cy = (c.y + c.y2) * 0.5; c._cz = (c.z + c.z2) * 0.5;
        c._reach = c.r + Math.sqrt(ab2) * 0.5;
      } else {
        c.boneNode.getWorldPosition(_t); c.boneNode.getWorldQuaternion(_q); _t.add(_o.copy(c.localOffset).applyQuaternion(_q));
        c.x = _t.x; c.y = _t.y; c.z = _t.z;
        c._cx = c.x; c._cy = c.y; c._cz = c.z; c._reach = c.r;
      }
      c._r2 = c.r * c.r;
    }
    // マントのAABB→代表球で広域カリング（遠いコライダーは今フレーム除外）
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    const ccx = (mnx + mxx) * 0.5, ccy = (mny + mxy) * 0.5, ccz = (mnz + mxz) * 0.5;
    const capeR = Math.hypot(mxx - ccx, mxy - ccy, mxz - ccz);
    activeColliders.length = 0;
    for (const c of colliders) {
      if (Math.hypot(c._cx - ccx, c._cy - ccy, c._cz - ccz) < capeR + c._reach + 0.05) activeColliders.push(c);
    }
    // シミュ（力ベースVerlet・SUBSTEPS回・Jacobi＝全頂点を旧位置から一斉更新）
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      for (let v = 0; v < vertexCount; v++) {
        const k = v * 3, code = gripCode[v];
        if (code === 1 || (code === 2 && target[v * 4 + 3] > 0.5)) {   // 吸着（アンカー/グリップactive）
          posNext[k] = target[v * 4]; posNext[k + 1] = target[v * 4 + 1]; posNext[k + 2] = target[v * 4 + 2];
          force[k] = force[k + 1] = force[k + 2] = 0;
          continue;
        }
        let fx = force[k] * DAMP, fy = force[k + 1] * DAMP, fz = force[k + 2] * DAMP;
        const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
        const s1 = vsStart[v + 1];
        for (let si = vsStart[v]; si < s1; si++) {   // バネ力（近傍の旧位置から＝Jacobi）
          const ok = vsNbr[si] * 3;
          const dx = pos[ok] - px, dy = pos[ok + 1] - py, dz = pos[ok + 2] - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const c = (d - vsRest[si]) * STIFF * 0.5 / d;
          fx += dx * c; fy += dy * c; fz += dz * c;
        }
        fy -= GRAV;
        // 予測位置 → 床（位置クランプ）→ コライダー位置射影 → 移動量クランプ
        let nx = px + fx, ny = py + fy, nz = pz + fz;
        if (ny < floorY + 0.01) ny = floorY + 0.01;
        _np[0] = nx; _np[1] = ny; _np[2] = nz;
        collidePos(_np);
        nx = _np[0]; ny = _np[1]; nz = _np[2];
        let mx = nx - px, my = ny - py, mz = nz - pz;   // 実移動量＝新しい速度（貫通時は面で止まり内向き速度が消える）
        const ml2 = mx * mx + my * my + mz * mz;
        if (ml2 > MAX_STEP * MAX_STEP) { const sc = MAX_STEP / Math.sqrt(ml2); mx *= sc; my *= sc; mz *= sc; nx = px + mx; ny = py + my; nz = pz + mz; }
        force[k] = mx; force[k + 1] = my; force[k + 2] = mz;
        posNext[k] = nx; posNext[k + 1] = ny; posNext[k + 2] = nz;
      }
      const tmp = pos; pos = posNext; posNext = tmp;   // ダブルバッファ入替
    }
    posAttr.array.set(pos);
    posAttr.needsUpdate = true;
    const _perfN = performance.now();
    geo.computeVertexNormals();
    lastNormalMs = performance.now() - _perfN;
    updateEdges();   // 縁の壁を追従（厚み>0のとき隙間を裏地色で塞ぐ）
    lastMs = performance.now() - _perf0;
  }

  // 色の現在値と統一フラグ（表裏同色）。setMaterial の unify/colorFront/colorBack で更新
  let curFront = m.colorFront ?? '#204080', curBack = m.colorBack ?? '#803020', unifyColor = false;
  // 素材のライブ調整（エディタ/カートUIから）。表裏2マテリアル＋縁の壁へ反映
  function setMaterial(p) {
    for (const mat of [matFront, matBack]) {
      if (p.roughness != null) mat.roughness = p.roughness;
      if (p.sheen != null) mat.sheen = p.sheen;
      if (p.sheenRoughness != null) mat.sheenRoughness = p.sheenRoughness;
      if (p.opacity != null) { mat.opacity = p.opacity; mat.transparent = p.opacity < 1.0; mat.needsUpdate = true; }
      if (p.wireframe != null) mat.wireframe = p.wireframe;
    }
    if (p.roughness != null) edgeMat.roughness = p.roughness;
    if (p.sheen != null) edgeMat.sheen = p.sheen;
    if (p.opacity != null) { edgeMat.opacity = p.opacity; edgeMat.transparent = p.opacity < 1.0; edgeMat.needsUpdate = true; }
    if (p.wireframe != null) edgeMat.wireframe = p.wireframe;
    let colorDirty = false;
    if (p.colorFront) { curFront = p.colorFront; colorDirty = true; }
    if (p.colorBack) { curBack = p.colorBack; colorDirty = true; }
    if (p.unify != null) { unifyColor = p.unify; colorDirty = true; }
    if (colorDirty) {
      const front = unifyColor ? curBack : curFront;   // 表裏同色ON時は裏地色に統一
      matFront.color.set(front);
      matBack.color.set(curBack);
      edgeMat.color.set(front);   // 縁の壁は表地色（統一時は裏地色）
    }
    if (p.thickness != null) uThick.value = p.thickness;   // 見かけの厚み＝縁の壁の幅
  }
  const defaults = {
    roughness: m.roughness ?? 1.0, sheen: m.sheen ?? 1.0, sheenRoughness: m.sheenRoughness ?? 0.5,
    opacity, colorFront: m.colorFront ?? '#204080', colorBack: m.colorBack ?? '#803020', thickness: uThick.value,
  };

  function dispose() { disposed = true; scene.remove(clothMesh); geo.dispose(); matFront.dispose(); matBack.dispose(); edgeGeo.dispose(); edgeMat.dispose(); }
  return {
    clothMesh, update, dispose, setMaterial, setTimeline, defaults, vertexCount,
    get lastUpdateMs() { return lastMs; }, get lastNormalMs() { return lastNormalMs; }, get activeColliderCount() { return activeColliders.length; }, colliderCount: colliders.length,
  };
}
