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
  // 頂点→所属バネ一覧
  const vSprings = Array.from({ length: vertexCount }, () => []);
  for (let s = 0; s < springCount; s++) { vSprings[springs[s * 2]].push(s); vSprings[springs[s * 2 + 1]].push(s); }

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
  const gripRanges = new Map();
  for (const trk of (timeline?.tracks ?? [])) {
    if (trk.kind !== 'grip') continue;
    let gid = (trk.groupId && groupById(trk.groupId)) ? trk.groupId : (trk.side ? gripGroups.find(g => g.bone === (trk.side === 'left' ? 'leftHand' : 'rightHand'))?.id : null);
    if (!gid) continue;
    const arr = gripRanges.get(gid) ?? [];
    if (Array.isArray(trk.ranges)) for (const r of trk.ranges) arr.push({ start: r.start, end: r.end });
    gripRanges.set(gid, arr);
  }
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
  const mat = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide, transparent: opacity < 1.0, opacity,
    roughness: m.roughness ?? 1.0, metalness: 0.0,
    sheen: m.sheen ?? 1.0, sheenRoughness: m.sheenRoughness ?? 0.5,
    sheenColor: m.sheenColor ? new THREE.Color(m.sheenColor) : new THREE.Color(0xffffff),
  });
  const uFront = { value: new THREE.Color(m.colorFront ?? '#204080') };
  const uBack = { value: new THREE.Color(m.colorBack ?? '#803020') };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFront = uFront; sh.uniforms.uBack = uBack;
    sh.fragmentShader = 'uniform vec3 uFront;\nuniform vec3 uBack;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = gl_FrontFacing ? uFront : uBack;');
  };
  const clothMesh = new THREE.Mesh(geo, mat);
  clothMesh.frustumCulled = false;
  scene.add(clothMesh);

  // ── コライダー衝突（点を球/カプセルの外へ押し出し。force を加える）──
  function collide(nx, ny, nz, out) {
    for (const c of colliders) {
      let cx = c.x, cy = c.y, cz = c.z;
      if (c.type === 'capsule') {   // A-B線分の最近点
        const abx = c.x2 - c.x, aby = c.y2 - c.y, abz = c.z2 - c.z;
        const ab2 = abx * abx + aby * aby + abz * abz || 1e-6;
        let t = ((nx - c.x) * abx + (ny - c.y) * aby + (nz - c.z) * abz) / ab2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        cx = c.x + abx * t; cy = c.y + aby * t; cz = c.z + abz * t;
      }
      const dx = nx - cx, dy = ny - cy, dz = nz - cz;
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      const pen = c.r - d;
      if (pen > 0) { const f = pen * 1.2 / d; out[0] += dx * f; out[1] += dy * f; out[2] += dz * f; }
    }
  }
  const _cf = [0, 0, 0];

  let disposed = false;
  function update(dt, frame) {
    if (disposed) return;
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
    // コライダー追従
    for (const c of colliders) {
      if (c.type === 'capsule') { computeCapsuleEnds(c); continue; }
      c.boneNode.getWorldPosition(_t); c.boneNode.getWorldQuaternion(_q); _t.add(_o.copy(c.localOffset).applyQuaternion(_q));
      c.x = _t.x; c.y = _t.y; c.z = _t.z;
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
        for (const sid of vSprings[v]) {   // バネ力（近傍の旧位置から＝Jacobi）
          const a = springs[sid * 2], b = springs[sid * 2 + 1];
          const ok = (a === v ? b : a) * 3;
          const dx = pos[ok] - px, dy = pos[ok + 1] - py, dz = pos[ok + 2] - pz;
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          const c = (d - restLen[sid]) * STIFF * 0.5 / d;
          fx += dx * c; fy += dy * c; fz += dz * c;
        }
        fy -= GRAV;
        _cf[0] = fx; _cf[1] = fy; _cf[2] = fz;
        collide(px + fx, py + fy, pz + fz, _cf);
        fx = _cf[0]; fy = _cf[1]; fz = _cf[2];
        const predY = py + fy;
        if (predY < floorY + 0.01) { fy += (floorY + 0.01 - predY); fx *= 0.6; fz *= 0.6; }
        // 発散防止: 1ステップの移動量をクランプ
        const fl = Math.hypot(fx, fy, fz);
        if (fl > MAX_STEP) { const sc = MAX_STEP / fl; fx *= sc; fy *= sc; fz *= sc; }
        force[k] = fx; force[k + 1] = fy; force[k + 2] = fz;
        posNext[k] = px + fx; posNext[k + 1] = py + fy; posNext[k + 2] = pz + fz;
      }
      const tmp = pos; pos = posNext; posNext = tmp;   // ダブルバッファ入替
    }
    posAttr.array.set(pos);
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function dispose() { disposed = true; scene.remove(clothMesh); geo.dispose(); mat.dispose(); }
  return { clothMesh, update, dispose, vertexCount };
}
