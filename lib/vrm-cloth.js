// vrm-cloth.js — VRM 用 GPU クロス（マント）シミュ。fps-cloth-vrm のクロスを共有モジュール化。
// Three.js v0.184 WebGPU + TSL。cloth = .npc.json / .cloth.json の cloth データ。
//
// 使い方:
//   const cl = createVRMCloth({ renderer, scene, vrm, cloth, basePos, floorY: 0 });
//   毎フレーム vrm.update(dt) の“後”に cl.update(dt)   // アンカー/コライダーがボーンを追従
//   cl.grab(index, worldPos) / cl.moveGrab(worldPos) / cl.releaseGrab()   // マント掴み（バネ）
//   cl.dispose()

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float, vec3, clamp,
  triNoise3D, time, frontFacing, cross, transformNormalToView,
} from 'https://esm.sh/three@0.184.0/tsl';
import { normalizeSheenColor } from './sheen-util.js';

const MAX_COLLIDERS = 24;   // GPUは1バッファ(vec4×2N)。ストレージバッファ8本制限とは別物なので増やしても安全。
const BONE_COLLIDER_DEFS = [
  { bone: 'head',          r: 0.10 },
  { bone: 'neck',          r: 0.06 },
  { bone: 'chest',         r: 0.14 },
  { bone: 'spine',         r: 0.12 },
  { bone: 'hips',          r: 0.13 },
  { bone: 'leftShoulder',  r: 0.07 },
  { bone: 'rightShoulder', r: 0.07 },
  { bone: 'upperChest',    r: 0.13 },
  { bone: 'leftFoot',      r: 0.06 },
  { bone: 'rightFoot',     r: 0.06 },
];
// 腕・脚はボーン軸の筒（カプセル）: cloth-editor / cloth-preview と同一定義
const BONE_CAPSULE_DEFS = [
  { bone: 'leftUpperArm',  bone2: 'leftLowerArm',  r: 0.050 },
  { bone: 'leftLowerArm',  bone2: 'leftHand',      r: 0.042 },
  { bone: 'rightUpperArm', bone2: 'rightLowerArm', r: 0.050 },
  { bone: 'rightLowerArm', bone2: 'rightHand',     r: 0.042 },
  { bone: 'leftUpperLeg',  bone2: 'leftLowerLeg',  r: 0.090 },
  { bone: 'leftLowerLeg',  bone2: 'leftFoot',      r: 0.065 },
  { bone: 'rightUpperLeg', bone2: 'rightLowerLeg', r: 0.090 },
  { bone: 'rightLowerLeg', bone2: 'rightFoot',     r: 0.065 },
];

const STEP_HZ = 360;
const MAX_STEPS_FRAME = 6;

// マントのローカル座標 → ワールド初期位置（スケール・Y回転・平行移動・基準位置）
function applyMantleTransform(origPos, vertexCount, tr, basePos) {
  const out  = new Float32Array(vertexCount * 3);
  const s    = tr.scale ?? 1;
  const cosY = Math.cos((tr.ry || 0) * Math.PI / 180);
  const sinY = Math.sin((tr.ry || 0) * Math.PI / 180);
  for (let i = 0; i < vertexCount; i++) {
    const x = origPos[i*3] * s, y = origPos[i*3+1] * s, z = origPos[i*3+2] * s;
    out[i*3]   = x * cosY - z * sinY + (tr.tx || 0) + basePos.x;
    out[i*3+1] = y + (tr.ty || 0) + basePos.y;
    out[i*3+2] = x * sinY + z * cosY + (tr.tz || 0) + basePos.z;
  }
  return out;
}

// 再利用テンポラリ
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _o = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _capAxis = new THREE.Vector3();

// カプセル端点: ボーン2点＋オフセット→軸シフト(axShift)/伸縮(axLen)を適用（cloth-editorと同一ロジック）
function computeCapsuleEnds(c) {
  c.boneNode.getWorldPosition(_t);
  c.boneNode.getWorldQuaternion(_q);
  _t.add(_o.copy(c.localOffset).applyQuaternion(_q));
  c.boneNode2.getWorldPosition(_capB);
  c.boneNode2.getWorldQuaternion(_q);
  _capB.add(_o.copy(c.localOffset2).applyQuaternion(_q));
  _capAxis.copy(_capB).sub(_t);
  const L = _capAxis.length() || 1e-6;
  _capAxis.divideScalar(L);
  const sh = c.axShift || 0, ex = (c.axLen || 0) / 2;
  _t.addScaledVector(_capAxis, sh - ex);
  _capB.addScaledVector(_capAxis, sh + ex);
  const moved = c.x !== _t.x || c.y !== _t.y || c.z !== _t.z
    || c.x2 !== _capB.x || c.y2 !== _capB.y || c.z2 !== _capB.z;
  c.x = _t.x; c.y = _t.y; c.z = _t.z;
  c.x2 = _capB.x; c.y2 = _capB.y; c.z2 = _capB.z;
  return moved;
}

// グリップ用ボーン解決: leftBreast/rightBreast はシーン内のバスト系ボーンを名前検索（VRM humanoid標準外）
function resolveGripBone(vrm, boneName) {
  if (!vrm) return null;
  if (boneName === 'leftBreast' || boneName === 'rightBreast') {
    const wantLeft = boneName === 'leftBreast';
    let best = null, bestDepth = Infinity;
    vrm.scene.traverse((obj) => {
      const n = (obj.name || '').toLowerCase();
      if (!/(bust|breast|boob|mune|oppai|chichi)/.test(n)) return;
      const isL = /(^|[^a-z])l([^a-z]|$)|left/.test(n);
      const isR = /(^|[^a-z])r([^a-z]|$)|right/.test(n);
      if (wantLeft ? (!isL || (isR && !isL)) : (!isR || (isL && !isR))) return;
      let d = 0;
      for (let pn = obj.parent; pn; pn = pn.parent) d++;
      if (d < bestDepth) { best = obj; bestDepth = d; }
    });
    return best;
  }
  return vrm.humanoid?.getNormalizedBoneNode(boneName) ?? null;
}

export function createVRMCloth(o) {
  const { renderer, scene, vrm, cloth } = o;
  if (!cloth || !cloth.positions || !cloth.springs || !cloth.indices) {
    throw new Error('createVRMCloth: 無効な cloth データです');
  }
  const basePos = o.basePos ? o.basePos.clone() : new THREE.Vector3();
  const tr = cloth.editorTransform ?? { tx: 0, ty: 0, tz: 0, ry: 0, scale: 1 };

  vrm.scene.updateMatrixWorld(true);

  // ── uniforms ──
  const stiffnessUniform  = uniform(o.stiffness ?? 0.2);
  const dampeningUniform  = uniform(o.dampening ?? 0.99);
  const windUniform       = uniform(o.wind ?? 1.0);
  const floorYUniform     = uniform(o.floorY != null ? o.floorY : -1e9);
  const grabActiveUniform = uniform(0);
  const grabIndexUniform  = uniform(0, 'uint');
  const grabTargetUniform = uniform(new THREE.Vector3());
  // 名前付きグリップグループ（cloth.gripGroups / legacy）はper-vertexターゲット(vec4)で表現（下記）

  // ── 解析 ──
  const vertexCount = cloth.vertexCount;
  const positions   = applyMantleTransform(new Float32Array(cloth.positions), vertexCount, tr, basePos);
  const springs     = cloth.springs;
  const springCount = springs.length / 2;

  // ── ボーンアンカー（指定頂点をボーンに固定）──
  const anchorMap = new Map();
  const anchorData = cloth.anchorAssignments ?? cloth.pinnedBoneAssignments;
  if (anchorData) {
    for (const entry of anchorData) {
      const boneNode = vrm.humanoid?.getNormalizedBoneNode(entry.boneName);
      if (!boneNode) continue;
      let localOffset;
      if (entry.localOffset) {
        localOffset = new THREE.Vector3(...entry.localOffset);
      } else if (entry.offset) {
        boneNode.getWorldQuaternion(_q);
        localOffset = new THREE.Vector3(...entry.offset).applyQuaternion(_q.invert());
      } else { continue; }
      anchorMap.set(entry.vertexIdx, { boneNode, localOffset });
    }
  }
  // アンカーの吸着先を「現在の姿勢での初期位置(positions)」に合わせて再計算する。
  // 保存された localOffset は cloth-editor 作成時の姿勢基準なので、VRMA で姿勢が変わっていると
  // 初期位置とズレてマントが飛ぶ/ずれる（JOY_vamp のように editorTransform.ry がある個体で顕著）。
  // ここで現在の姿勢基準に振り直すと、設定位置から始まって以降ボーンに追従する。（CPU版 vrm-cloth-cpu.js と同じ対策）
  for (const [idx, a] of anchorMap) {
    if (!a.boneNode) continue;
    a.boneNode.getWorldPosition(_t);
    a.boneNode.getWorldQuaternion(_q);
    a.localOffset = new THREE.Vector3(
      positions[idx * 3] - _t.x, positions[idx * 3 + 1] - _t.y, positions[idx * 3 + 2] - _t.z,
    ).applyQuaternion(_q.invert());
  }
  // ── 手グリップ（名前付きグループ）。各グループ = bone + offset + 頂点集合。timeline の grip 範囲で ON/OFF。
  // 新形式 cloth.gripGroups を優先。無ければ legacy(leftGripIndices/rightGripIndices) から leftHand/rightHand を合成。
  const gripGroups = [];          // { id, bone, boneNode, offset:Vector3, worldPos:Vector3, active:bool }
  const gripMap    = new Map();   // vertexIdx -> groupId（重複は先勝ち）
  const groupById  = (id) => gripGroups.find(g => g.id === id);
  const _addGroup = (id, bone, offsetArr, vertices) => {
    const boneNode = resolveGripBone(vrm, bone);
    const offset = new THREE.Vector3();
    if (offsetArr) offset.set(offsetArr[0], offsetArr[1], offsetArr[2]);
    gripGroups.push({ id, bone, boneNode, offset, worldPos: new THREE.Vector3(), active: false });
    if (Array.isArray(vertices)) for (const vi of vertices) if (!gripMap.has(vi)) gripMap.set(vi, id);
  };
  if (Array.isArray(cloth.gripGroups) && cloth.gripGroups.length) {
    for (const gd of cloth.gripGroups) _addGroup(gd.id, gd.bone, gd.offset, gd.vertices);
  } else {
    const lo = cloth.handGrabOffsets?.left, ro = cloth.handGrabOffsets?.right;
    if (cloth.leftGripIndices?.length)  _addGroup('leftHand',  'leftHand',  lo, cloth.leftGripIndices);
    if (cloth.rightGripIndices?.length) _addGroup('rightHand', 'rightHand', ro, cloth.rightGripIndices);
  }

  const hasBonePins = anchorMap.size > 0 || gripMap.size > 0;

  // timeline の grip 範囲（groupId -> [{start,end}]）。groupId(新) 優先、legacy side は leftHand/rightHand へマップ。
  function parseTimelineGrips(timeline) {
    const ranges = new Map();
    const byBone = (bone) => gripGroups.find(g => g.bone === bone)?.id;
    for (const trk of (timeline?.tracks ?? [])) {
      if (trk.kind !== 'grip') continue;
      let gid = (trk.groupId && groupById(trk.groupId)) ? trk.groupId : null;
      if (!gid && trk.side) gid = byBone(trk.side === 'left' ? 'leftHand' : 'rightHand');
      if (!gid) continue;
      const arr = ranges.get(gid) ?? [];
      if (Array.isArray(trk.ranges)) for (const r of trk.ranges) arr.push({ start: r.start, end: r.end });
      ranges.set(gid, arr);
    }
    return ranges;
  }
  let gripRanges = parseTimelineGrips(o.timeline);
  const gripActiveAt = (ranges, frame) => {
    if (!ranges || frame == null) return false;
    for (const r of ranges) if (frame >= r.start && frame <= r.end) return true;
    return false;
  };

  // timeline の gripPos（グラブ点オフセットのキーフレーム）。groupId -> [{frame,x,y,z}]（昇順）。
  // 編集側(cloth-preview)はボーンローカルの offset をフレーム毎に記録する。これを補間して g.offset の代わりに使う。
  function parseGripPos(timeline) {
    const m = new Map();
    for (const trk of (timeline?.tracks ?? [])) {
      if (trk.kind !== 'gripPos') continue;
      const gid = (trk.groupId && groupById(trk.groupId)) ? trk.groupId : null;
      if (!gid || !Array.isArray(trk.keyframes)) continue;
      const arr = trk.keyframes
        .map(k => ({ frame: k.frame, x: k.offset[0], y: k.offset[1], z: k.offset[2] }))
        .sort((a, b) => a.frame - b.frame);
      if (arr.length) m.set(gid, arr);
    }
    return m;
  }
  let gripPosKeys = parseGripPos(o.timeline);
  const _gripOff = new THREE.Vector3();
  // 指定グループの発生フレームでのオフセット（gripPos キーフレーム優先・線形補間。無ければ静的 g.offset）。
  function gripOffsetAt(g, frame) {
    const keys = gripPosKeys.get(g.id);
    if (!keys || !keys.length || frame == null) return g.offset;
    if (frame <= keys[0].frame) return _gripOff.set(keys[0].x, keys[0].y, keys[0].z);
    const last = keys[keys.length - 1];
    if (frame >= last.frame) return _gripOff.set(last.x, last.y, last.z);
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
        return _gripOff.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      }
    }
    return g.offset;
  }

  // ── 球コライダー（VRM ボーンから）──
  const savedColliders = cloth.colliders ?? null;
  const colliders = [];
  for (const def of BONE_COLLIDER_DEFS) {
    const node = vrm.humanoid?.getNormalizedBoneNode(def.bone);
    if (!node) continue;
    node.getWorldPosition(_t);
    node.getWorldQuaternion(_q);
    const saved = savedColliders?.find(s => s.boneName === def.bone);
    const r           = saved ? saved.r : def.r;
    const localOffset = (saved && saved.offset) ? new THREE.Vector3(...saved.offset) : new THREE.Vector3();
    const world = _t.clone().add(localOffset.clone().applyQuaternion(_q));
    colliders.push({ type: 'sphere', x: world.x, y: world.y, z: world.z, r, boneNode: node, localOffset });
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  for (const def of BONE_CAPSULE_DEFS) {
    if (colliders.length >= MAX_COLLIDERS) break;
    const n1 = vrm.humanoid?.getNormalizedBoneNode(def.bone);
    const n2 = vrm.humanoid?.getNormalizedBoneNode(def.bone2);
    if (!n1 || !n2) continue;
    const saved = savedColliders?.find(sv => sv.type === 'capsule' && sv.boneName === def.bone && sv.boneName2 === def.bone2);
    const c = {
      type: 'capsule', x: 0, y: 0, z: 0, x2: 0, y2: 0, z2: 0,
      r: saved ? saved.r : def.r,
      boneNode: n1, boneNode2: n2,
      localOffset:  (saved && saved.offset)  ? new THREE.Vector3(...saved.offset)  : new THREE.Vector3(),
      localOffset2: (saved && saved.offset2) ? new THREE.Vector3(...saved.offset2) : new THREE.Vector3(),
      axShift: saved?.axShift || 0, axLen: saved?.axLen || 0,
    };
    computeCapsuleEnds(c);
    colliders.push(c);
  }
  const colliderDataArr = new Float32Array(MAX_COLLIDERS * 8);   // 1個 = vec4×2 [A,r][B,type]
  const fillColliderArr = () => {
    colliderDataArr.fill(0);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const o2 = i * 8;
      colliderDataArr[o2] = c.x; colliderDataArr[o2+1] = c.y; colliderDataArr[o2+2] = c.z; colliderDataArr[o2+3] = c.r;
      if (c.type === 'capsule') {
        colliderDataArr[o2+4] = c.x2; colliderDataArr[o2+5] = c.y2; colliderDataArr[o2+6] = c.z2; colliderDataArr[o2+7] = 1;
      }
    }
  };
  fillColliderArr();

  // ── バッファ ──
  const vertexSpringIds = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) {
    vertexSpringIds[springs[s*2]    ].push(s);
    vertexSpringIds[springs[s*2 + 1]].push(s);
  }

  // per-vertex ターゲット(vec4: xyz=ワールド目標, w=active)。アンカーは常時 w=1。
  const bonePinTargetArr = new Float32Array(vertexCount * 4);
  if (anchorMap.size) {
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      boneNode.getWorldPosition(_t);
      boneNode.getWorldQuaternion(_q);
      _o.copy(localOffset).applyQuaternion(_q);
      bonePinTargetArr[idx*4] = _t.x + _o.x; bonePinTargetArr[idx*4+1] = _t.y + _o.y; bonePinTargetArr[idx*4+2] = _t.z + _o.z;
      bonePinTargetArr[idx*4+3] = 1;
    }
  }

  const springListArray = [];
  const vertexParamsArr = new Uint32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    vertexParamsArr[i*4]   = 0;                                  // isFixed
    // gripCode: 0=なし, 1=アンカー(常時), 2=グリップ(グループactive時)
    vertexParamsArr[i*4+3] = anchorMap.has(i) ? 1 : ((gripMap.has(i) && groupById(gripMap.get(i))?.boneNode) ? 2 : 0);
    vertexParamsArr[i*4+1] = vertexSpringIds[i].length;
    vertexParamsArr[i*4+2] = springListArray.length;
    for (const sid of vertexSpringIds[i]) springListArray.push(sid);
  }

  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);
  for (let s = 0; s < springCount; s++) {
    const v0 = springs[s*2], v1 = springs[s*2 + 1];
    springVertIdArr[s*2] = v0; springVertIdArr[s*2+1] = v1;
    const dx = positions[v0*3] - positions[v1*3];
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
  const colliderDataBuffer     = instancedArray(colliderDataArr.slice(), 'vec4');
  const colliderCountUniform   = uniform(colliders.length);
  const bonePinTargetBuffer    = hasBonePins ? instancedArray(bonePinTargetArr, 'vec4') : null;  // xyz=target, w=active

  // ── 力学コンピュート ──
  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('Cloth_Spring');

  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;
    const gripCode      = vparams.w;

    If(isFixed, () => { Return(); });

    // 動的グラブ（マント掴み）：掴んだ頂点を手アンカーへ固定 → 残りは布バネで追従＝バネ感
    If(grabActiveUniform.greaterThan(0.5), () => {
      If(instanceIndex.equal(grabIndexUniform), () => {
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(grabTargetUniform);
        Return();
      });
    });

    // ボーンアンカー(常時) / 名前付きグリップ(グループactive時)：per-vertex ターゲット(vec4)へ固定
    if (hasBonePins) {
      const tgt = bonePinTargetBuffer.element(instanceIndex).toVar('tgt');
      If(gripCode.equal(1), () => {                       // アンカー：常時吸着
        vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
        vertexPositionBuffer.element(instanceIndex).assign(tgt.xyz);
        Return();
      });
      If(gripCode.equal(2), () => {                       // グリップ：所属グループがactive(w>0.5)なら吸着
        If(tgt.w.greaterThan(0.5), () => {
          vertexForceBuffer.element(instanceIndex).assign(vec3(0, 0, 0));
          vertexPositionBuffer.element(instanceIndex).assign(tgt.xyz);
          Return();
        });
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
    const noise = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    force.z.subAssign(noise.mul(windUniform));

    // コライダー衝突（球＋カプセル）。カプセル=A-B線分への最近点から押し出し（球はtype=0→最近点=A）
    Loop({ start: 0, end: colliderCountUniform, type: 'int', condition: '<' }, ({ i }) => {
      const colA = colliderDataBuffer.element(i.mul(2)).toVar('colA');
      const colB = colliderDataBuffer.element(i.mul(2).add(1)).toVar('colB');
      const pNow = position.add(force).toVar('colPNow');
      const ab   = colB.xyz.sub(colA.xyz).toVar('colAB');
      const segT = select(
        colB.w.greaterThan(0.5),
        clamp(pNow.sub(colA.xyz).dot(ab).div(ab.dot(ab).max(0.000001)), 0.0, 1.0),
        float(0),
      ).toVar('colSegT');
      const closest  = colA.xyz.add(ab.mul(segT)).toVar('colClosest');
      const toVertex = pNow.sub(closest).toVar('toVtx');
      const dist     = toVertex.length().toVar('cvDist');
      const pen      = colA.w.sub(dist);
      If(pen.greaterThan(0.0), () => {
        force.addAssign(toVertex.div(dist.max(0.0001)).mul(pen).mul(1.2));
      });
    });

    // 床との衝突（突き抜け防止）
    const predY    = position.y.add(force.y).toVar('predY');
    const floorPen = floorYUniform.add(float(0.01)).sub(predY).toVar('floorPen');
    If(floorPen.greaterThan(0.0), () => {
      force.y.addAssign(floorPen);
      force.x.mulAssign(float(0.6));
      force.z.mulAssign(float(0.6));
    });

    vertexForceBuffer.element(instanceIndex).assign(force);
    vertexPositionBuffer.element(instanceIndex).addAssign(force);
  })().compute(vertexCount).setName('Cloth_Vertex');

  // ── 法線（quad 方式はインライン、非 quad はコンピュート）──
  const useQuadMesh = !!cloth.quadVertexIds;
  let computeFaceNormals = null, computeVertexNormals = null, vertexNormalBuffer = null;

  if (!useQuadMesh) {
    const triangleCount  = cloth.indices.length / 3;
    const triIndicesFlat = new Uint32Array(cloth.indices);
    const vtxTriLists    = Array.from({ length: vertexCount }, () => []);
    for (let tri = 0; tri < triangleCount; tri++) {
      vtxTriLists[triIndicesFlat[tri*3]].push(tri);
      vtxTriLists[triIndicesFlat[tri*3+1]].push(tri);
      vtxTriLists[triIndicesFlat[tri*3+2]].push(tri);
    }
    const vtxTriListArr  = [];
    const vtxTriParamArr = new Uint32Array(vertexCount * 2);
    for (let v = 0; v < vertexCount; v++) {
      vtxTriParamArr[v*2]   = vtxTriLists[v].length;
      vtxTriParamArr[v*2+1] = vtxTriListArr.length;
      for (const tri of vtxTriLists[v]) vtxTriListArr.push(tri);
    }
    const triIdxBuffer      = instancedArray(triIndicesFlat, 'uint');
    const faceNormalBuffer  = instancedArray(triangleCount, 'vec3');
    vertexNormalBuffer      = instancedArray(vertexCount, 'vec3');
    const vtxTriParamBuffer = instancedArray(vtxTriParamArr, 'uvec2');
    const vtxTriListBuffer  = instancedArray(new Uint32Array(vtxTriListArr), 'uint');

    computeFaceNormals = Fn(() => {
      const base = instanceIndex.mul(3);
      const p0 = vertexPositionBuffer.element(triIdxBuffer.element(base)).toVar();
      const p1 = vertexPositionBuffer.element(triIdxBuffer.element(base.add(1))).toVar();
      const p2 = vertexPositionBuffer.element(triIdxBuffer.element(base.add(2))).toVar();
      faceNormalBuffer.element(instanceIndex).assign(cross(p1.sub(p0), p2.sub(p0)));
    })().compute(triangleCount).setName('Cloth_FaceN');

    computeVertexNormals = Fn(() => {
      const vp     = vtxTriParamBuffer.element(instanceIndex).toVar('vp');
      const count  = vp.x.toVar('cnt');
      const offset = vp.y.toVar('off');
      const n      = vec3(0, 0, 0).toVar('n');
      Loop({ start: offset, end: offset.add(count), type: 'uint', condition: '<' }, ({ i }) => {
        n.addAssign(faceNormalBuffer.element(vtxTriListBuffer.element(i)));
      });
      const len = n.length();
      If(len.greaterThan(0.0001), () => { n.divAssign(len); });
      vertexNormalBuffer.element(instanceIndex).assign(n);
    })().compute(vertexCount).setName('Cloth_VertN');
  }

  // ── メッシュ ──
  let clothGeo, posNode;
  if (useQuadMesh) {
    const rvc = cloth.renderVertexCount;
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rvc * 3), 3, false));
    clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(new Uint32Array(cloth.quadVertexIds), 4, false));
    clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(cloth.renderIndices), 1));
    posNode = Fn(({ material }) => {
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
    const vidArr = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) vidArr[i] = i;
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(vidArr, 1));
    clothGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(cloth.indices), 1));
    posNode = Fn(() => vertexPositionBuffer.element(attribute('vertexId', 'uint')))();
  }

  const m = cloth.material ?? {};
  const opacity = m.opacity ?? 0.85;
  const clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:           THREE.DoubleSide,
    transparent:    opacity < 1.0,
    opacity,
    roughness:      m.roughness ?? 1.0,
    sheen:          m.sheen ?? 1.0,
    sheenRoughness: m.sheenRoughness ?? 0.5,
  });
  // sheenColor の three 既定は黒＝sheen をいくら上げても効果が出ない。CPU版と揃えて白を既定にする。
  // （NodeMaterial はコンストラクタで sheenColor を受け取らないことがあるため、生成後に明示代入する）
  // 注意: 保存データに sheenColor='#000000' が入っている個体があり（JOY_vamp 等）、
  // 黒い光沢＝何も足さないので sheen スライダーが効かなくなる。黒は「未設定」とみなして白に寄せる。
  clothMat.sheenColor = new THREE.Color(normalizeSheenColor(m.sheenColor));
  clothMat.colorNode = select(
    frontFacing,
    uniform(new THREE.Color(m.colorFront ?? '#204080')),
    uniform(new THREE.Color(m.colorBack ?? '#803020')),
  );
  clothMat.positionNode = posNode;
  if (!useQuadMesh && vertexNormalBuffer) {
    clothMat.normalNode = Fn(() => transformNormalToView(vertexNormalBuffer.element(attribute('vertexId', 'uint'))))();
  }

  // ── 見かけの厚み（CPU版 vrm-cloth-cpu.js と同じ二重シェル）──
  // 1枚のDoubleSideだと紙のように薄く見える。表(FrontSide)を法線+方向、裏(BackSide)を法線-方向へ
  // ずらした2枚に分けることで、cloth-npc / ar-vampire と同じ「厚みのある布」の見え方にする。
  const thickUniform = uniform(m.thickness ?? 0.0);
  let clothMesh, matFront = null, matBack = null;
  if ((m.thickness ?? 0) > 0) {
    // シェルごとに「位置＋法線×厚み×向き」を計算する positionNode を作る。
    // quad経路は4頂点から法線を求め、非quad経路は法線バッファを引く（どちらも対応）。
    const mkPos = (dir) => (useQuadMesh
      ? Fn(({ material }) => {
        const vids = attribute('vertexIds');
        const v0 = vertexPositionBuffer.element(vids.x).toVar();
        const v1 = vertexPositionBuffer.element(vids.y).toVar();
        const v2 = vertexPositionBuffer.element(vids.z).toVar();
        const v3 = vertexPositionBuffer.element(vids.w).toVar();
        const tangent = v1.add(v3).sub(v0.add(v2)).normalize();
        const bitangent = v2.add(v3).sub(v0.add(v1)).normalize();
        const nrm = cross(tangent, bitangent).toVar();
        material.normalNode = transformNormalToView(nrm).toVarying();
        return v0.add(v1).add(v2).add(v3).mul(0.25).add(nrm.mul(thickUniform.mul(dir)));
      })()
      : Fn(() => vertexPositionBuffer.element(attribute('vertexId', 'uint'))
        .add(vertexNormalBuffer.element(attribute('vertexId', 'uint')).mul(thickUniform.mul(dir))))());
    const mkShell = (side, colorHex, dir) => {
      const mat = new THREE.MeshPhysicalNodeMaterial({
        side, transparent: opacity < 1.0, opacity,
        roughness: m.roughness ?? 1.0, sheen: m.sheen ?? 1.0, sheenRoughness: m.sheenRoughness ?? 0.5,
      });
      mat.sheenColor = new THREE.Color(normalizeSheenColor(m.sheenColor));
      mat.colorNode = uniform(new THREE.Color(colorHex));
      mat.positionNode = mkPos(dir);
      if (!useQuadMesh && vertexNormalBuffer) {
        mat.normalNode = Fn(() => transformNormalToView(vertexNormalBuffer.element(attribute('vertexId', 'uint'))))();
      }
      return mat;
    };
    const unify = !!m.unify;
    matFront = mkShell(THREE.FrontSide, unify ? (m.colorBack ?? '#803020') : (m.colorFront ?? '#204080'), 1);
    matBack = mkShell(THREE.BackSide, m.colorBack ?? '#803020', -1);
    clothMesh = new THREE.Group();
    const mf = new THREE.Mesh(clothGeo, matFront); mf.frustumCulled = false;
    const mb = new THREE.Mesh(clothGeo, matBack); mb.frustumCulled = false;
    clothMesh.add(mb, mf);
  } else {
    clothMesh = new THREE.Mesh(clothGeo, clothMat);
    clothMesh.frustumCulled = false;
  }
  scene.add(clothMesh);
  // 実行中のマテリアル調整（cloth-npc と同じ項目）
  function setMaterial(p = {}) {
    const mats = [clothMat, matFront, matBack].filter(Boolean);
    for (const mt of mats) {
      if (p.roughness != null) mt.roughness = p.roughness;
      if (p.sheen != null) mt.sheen = p.sheen;
      if (p.sheenRoughness != null) mt.sheenRoughness = p.sheenRoughness;
      if (p.sheenColor != null) mt.sheenColor = new THREE.Color(normalizeSheenColor(p.sheenColor));
      if (p.opacity != null) { mt.opacity = p.opacity; mt.transparent = p.opacity < 1.0; mt.needsUpdate = true; }
      if (p.wireframe != null) mt.wireframe = p.wireframe;
      if (p.envMapIntensity != null) mt.envMapIntensity = p.envMapIntensity;   // マントだけ環境光を強める
    }
    if (p.thickness != null) thickUniform.value = p.thickness;
  }

  // ── 毎フレーム更新 ──
  let acc = 0, lastMs = 0;   // lastMs = メインスレッド側の消費（compute自体はGPUで並列実行）
  function update(dt, frame) {
    const _perf0 = performance.now();
    try { return _update(dt, frame); } finally { lastMs = performance.now() - _perf0; }
  }
  function _update(dt, frame) {
    // 名前付きグリップ：各グループ active を frame から決定。グラブ点 worldPos = bone + boneQuat×offset（回転追従）。
    for (const g of gripGroups) {
      g.active = !!g.boneNode && gripActiveAt(gripRanges.get(g.id), frame);
      if (g.active) {
        g.boneNode.getWorldPosition(_t);
        g.boneNode.getWorldQuaternion(_q);
        // gripPos キーフレームがあればフレーム補間したオフセットを使う（無ければ静的 offset）
        g.worldPos.copy(_t).add(_o.copy(gripOffsetAt(g, frame)).applyQuaternion(_q));
      }
    }
    // per-vertex ターゲット(vec4) を更新：アンカー(常時, w=1) ＋ グリップ(group.worldPos, w=active)
    if (bonePinTargetBuffer) {
      const arr = bonePinTargetBuffer.value.array;
      for (const [idx, { boneNode, localOffset }] of anchorMap) {
        boneNode.getWorldPosition(_t);
        boneNode.getWorldQuaternion(_q);
        _o.copy(localOffset).applyQuaternion(_q);
        arr[idx*4] = _t.x + _o.x; arr[idx*4+1] = _t.y + _o.y; arr[idx*4+2] = _t.z + _o.z; arr[idx*4+3] = 1;
      }
      for (const [idx, gid] of gripMap) {
        const g = groupById(gid);
        if (!g) continue;
        arr[idx*4] = g.worldPos.x; arr[idx*4+1] = g.worldPos.y; arr[idx*4+2] = g.worldPos.z;
        arr[idx*4+3] = g.active ? 1 : 0;
      }
      bonePinTargetBuffer.value.needsUpdate = true;
    }
    // コライダーをボーンに追従（カプセルは両端）
    let changed = false;
    for (const c of colliders) {
      if (c.type === 'capsule' && c.boneNode2) {
        if (computeCapsuleEnds(c)) changed = true;
        continue;
      }
      c.boneNode.getWorldPosition(_t);
      c.boneNode.getWorldQuaternion(_q);
      _t.add(_o.copy(c.localOffset).applyQuaternion(_q));
      if (c.x !== _t.x || c.y !== _t.y || c.z !== _t.z) { c.x = _t.x; c.y = _t.y; c.z = _t.z; changed = true; }
    }
    if (changed) {
      fillColliderArr();
      colliderDataBuffer.value.array.set(colliderDataArr);
      colliderDataBuffer.value.needsUpdate = true;
    }
    // 固定タイムステップでコンピュート
    acc += dt;
    const tps = 1 / STEP_HZ;
    let steps = 0;
    while (acc >= tps && steps < MAX_STEPS_FRAME) { acc -= tps; steps++; }
    if (steps >= MAX_STEPS_FRAME) acc = 0;
    for (let s = 0; s < steps; s++) {
      renderer.compute(computeSpringForces);
      renderer.compute(computeVertexForces);
    }
    if (computeFaceNormals)   renderer.compute(computeFaceNormals);
    if (computeVertexNormals) renderer.compute(computeVertexNormals);
  }

  // ── マント掴み（バネ）API ──
  function grab(index, worldPos) {
    grabIndexUniform.value = index >>> 0;
    grabTargetUniform.value.copy(worldPos);
    grabActiveUniform.value = 1;
  }
  function moveGrab(worldPos) { grabTargetUniform.value.copy(worldPos); }
  function releaseGrab() { grabActiveUniform.value = 0; }

  // ── timeline（マントのグリップ範囲）をランタイムで差し替え（状態機械でアニメ切替時に呼ぶ）──
  function setTimeline(timeline) { gripRanges = parseTimelineGrips(timeline); gripPosKeys = parseGripPos(timeline); }

  // ── CPU 位置シャドウ（マント掴みの頂点選択用に GPU から読み戻す）──
  const cpuPositions = new Float32Array(vertexCount * 3);
  let refreshing = false;
  let cpuReady = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const ab = await renderer.getArrayBufferAsync(vertexPositionBuffer.value);
      const f = new Float32Array(ab);
      const stride = f.length >= vertexCount * 4 ? 4 : 3;   // vec3 はGPU上16byte境界の場合あり
      for (let i = 0; i < vertexCount; i++) {
        cpuPositions[i*3]   = f[i*stride];
        cpuPositions[i*3+1] = f[i*stride+1];
        cpuPositions[i*3+2] = f[i*stride+2];
      }
      cpuReady = true;
    } catch (_) { /* 読み戻し失敗時はマント掴みを無効化（致命的でない） */ }
    refreshing = false;
  }

  function setWind(w)      { windUniform.value = w; }
  function setStiffness(s) { stiffnessUniform.value = s; }

  function dispose() {
    scene.remove(clothMesh);
    clothGeo.dispose();
    clothMat.dispose();
  }

  // グラブ点（グリップグループ）のワールド位置一覧。可視化用（bite-editor 等）。
  function gripPoints() {
    const out = [];
    for (const g of gripGroups) {
      if (!g.boneNode) continue;
      g.boneNode.getWorldPosition(_t); g.boneNode.getWorldQuaternion(_q);
      out.push({ id: g.id, bone: g.bone, active: g.active, pos: _t.clone().add(g.offset.clone().applyQuaternion(_q)) });
    }
    return out;
  }

  return {
    clothMesh, vertexCount, vertexPositionBuffer, anchorMap, colliders,
    cpuPositions, get cpuReady() { return cpuReady; }, refresh, gripPoints,
    update, grab, moveGrab, releaseGrab, setTimeline, setWind, setStiffness, dispose,
    setFloorY: (y) => { floorYUniform.value = y; },   // 動的な床高（可変地形での接地衝突用）
    setMaterial,   // cloth-npc と同じ調整項目（粗さ/光沢/透明/厚み）
    get lastUpdateMs() { return lastMs; },   // CPU布(vrm-cloth-cpu.js)と同じ計測API
  };
}
