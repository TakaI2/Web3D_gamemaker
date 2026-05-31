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
  select, attribute, Loop, float, vec3,
  triNoise3D, time, frontFacing, cross, transformNormalToView,
} from 'https://esm.sh/three@0.184.0/tsl';

const MAX_COLLIDERS = 8;
const BONE_COLLIDER_DEFS = [
  { bone: 'head',         r: 0.10 },
  { bone: 'neck',         r: 0.06 },
  { bone: 'chest',        r: 0.14 },
  { bone: 'spine',        r: 0.12 },
  { bone: 'hips',         r: 0.13 },
  { bone: 'leftShoulder', r: 0.07 },
  { bone: 'rightShoulder',r: 0.07 },
  { bone: 'upperChest',   r: 0.13 },
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
  // NPC が自分のマントを握る手グリップ（左=1 / 右=2）
  const leftGripActiveUniform  = uniform(0);
  const rightGripActiveUniform = uniform(0);
  const leftGripTargetUniform  = uniform(new THREE.Vector3());
  const rightGripTargetUniform = uniform(new THREE.Vector3());

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
  const hasBonePins = anchorMap.size > 0;

  // ── 手グリップ（NPC が自分のマントを握る。timeline の grip 範囲で ON/OFF）──
  const leftGripSet  = new Set(cloth.leftGripIndices  ?? []);
  const rightGripSet = new Set(cloth.rightGripIndices ?? []);
  const handGrip = {
    left:  { boneNode: vrm.humanoid?.getNormalizedBoneNode('leftHand')  ?? null, offset: new THREE.Vector3() },
    right: { boneNode: vrm.humanoid?.getNormalizedBoneNode('rightHand') ?? null, offset: new THREE.Vector3() },
  };
  if (cloth.handGrabOffsets) {
    for (const side of ['left', 'right']) {
      const v = cloth.handGrabOffsets[side];
      if (v) handGrip[side].offset.set(v[0], v[1], v[2]);
    }
  }
  // timeline の grip 範囲（フレーム）
  const gripRanges = { left: [], right: [] };
  if (o.timeline?.tracks) {
    for (const trk of o.timeline.tracks) {
      if (trk.kind === 'grip' && gripRanges[trk.side]) gripRanges[trk.side].push(...(trk.ranges ?? []));
    }
  }
  const gripActiveAt = (ranges, frame) => {
    for (const r of ranges) if (frame >= r.start && frame <= r.end) return true;
    return false;
  };

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
    colliders.push({ x: world.x, y: world.y, z: world.z, r, boneNode: node, localOffset });
    if (colliders.length >= MAX_COLLIDERS) break;
  }
  const colliderDataArr = new Float32Array(MAX_COLLIDERS * 4);
  const fillColliderArr = () => {
    colliderDataArr.fill(0);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      colliderDataArr[i*4] = c.x; colliderDataArr[i*4+1] = c.y; colliderDataArr[i*4+2] = c.z; colliderDataArr[i*4+3] = c.r;
    }
  };
  fillColliderArr();

  // ── バッファ ──
  const vertexSpringIds = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) {
    vertexSpringIds[springs[s*2]    ].push(s);
    vertexSpringIds[springs[s*2 + 1]].push(s);
  }

  const bonePinTargetArr = new Float32Array(vertexCount * 3);
  if (hasBonePins) {
    for (const [idx, { boneNode, localOffset }] of anchorMap) {
      boneNode.getWorldPosition(_t);
      boneNode.getWorldQuaternion(_q);
      _o.copy(localOffset).applyQuaternion(_q);
      bonePinTargetArr[idx*3] = _t.x + _o.x; bonePinTargetArr[idx*3+1] = _t.y + _o.y; bonePinTargetArr[idx*3+2] = _t.z + _o.z;
    }
  }

  const springListArray = [];
  const vertexParamsArr = new Uint32Array(vertexCount * 4);
  for (let i = 0; i < vertexCount; i++) {
    vertexParamsArr[i*4]   = 0;                                  // isFixed
    vertexParamsArr[i*4+3] = anchorMap.has(i) ? 3 : (leftGripSet.has(i) ? 1 : (rightGripSet.has(i) ? 2 : 0));  // 1=左手,2=右手,3=アンカー
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
  const bonePinTargetBuffer    = hasBonePins ? instancedArray(bonePinTargetArr, 'vec3') : null;

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

    // 手グリップ（NPC が自分のマントを握る）：grip頂点を手ボーン位置へ固定
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

    // ボーンアンカー固定
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
    const noise = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    force.z.subAssign(noise.mul(windUniform));

    Loop({ start: 0, end: colliderCountUniform, type: 'int', condition: '<' }, ({ i }) => {
      const col      = colliderDataBuffer.element(i).toVar('col');
      const colPos   = col.xyz.toVar('colPos');
      const colR     = col.w.toVar('colR');
      const toVertex = position.add(force).sub(colPos).toVar('toVtx');
      const dist     = toVertex.length().toVar('cvDist');
      const pen      = colR.sub(dist);
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
    sheenColor:     m.sheenColor ? new THREE.Color(m.sheenColor) : undefined,
  });
  clothMat.colorNode = select(
    frontFacing,
    uniform(new THREE.Color(m.colorFront ?? '#204080')),
    uniform(new THREE.Color(m.colorBack ?? '#803020')),
  );
  clothMat.positionNode = posNode;
  if (!useQuadMesh && vertexNormalBuffer) {
    clothMat.normalNode = Fn(() => transformNormalToView(vertexNormalBuffer.element(attribute('vertexId', 'uint'))))();
  }

  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);

  // ── 毎フレーム更新 ──
  let acc = 0;
  function update(dt, frame) {
    // 手グリップ（NPC が自分のマントを握る）：手ボーン位置を grip 目標に、frame で ON/OFF
    for (const side of ['left', 'right']) {
      const hp = handGrip[side];
      const activeU = side === 'left' ? leftGripActiveUniform : rightGripActiveUniform;
      const targetU = side === 'left' ? leftGripTargetUniform : rightGripTargetUniform;
      const on = hp.boneNode && frame != null && gripActiveAt(gripRanges[side], frame);
      activeU.value = on ? 1 : 0;
      if (on) {
        hp.boneNode.getWorldPosition(_t);
        _t.add(hp.offset);
        targetU.value.copy(_t);
      }
    }
    // コライダーをボーンに追従
    let changed = false;
    for (const c of colliders) {
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
    // アンカー目標をボーンに追従
    if (bonePinTargetBuffer && anchorMap.size) {
      const arr = bonePinTargetBuffer.value.array;
      for (const [idx, { boneNode, localOffset }] of anchorMap) {
        boneNode.getWorldPosition(_t);
        boneNode.getWorldQuaternion(_q);
        _o.copy(localOffset).applyQuaternion(_q);
        arr[idx*3] = _t.x + _o.x; arr[idx*3+1] = _t.y + _o.y; arr[idx*3+2] = _t.z + _o.z;
      }
      bonePinTargetBuffer.value.needsUpdate = true;
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

  return {
    clothMesh, vertexCount, vertexPositionBuffer, anchorMap, colliders,
    cpuPositions, get cpuReady() { return cpuReady; }, refresh,
    update, grab, moveGrab, releaseGrab, setWind, setStiffness, dispose,
  };
}
