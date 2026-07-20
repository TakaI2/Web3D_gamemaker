// lib/pose-kit.js — 家具アニメエディタ用のポーズ基盤（src/core の TwoBoneIK / SpineIK / VrmaBuilder をJSポート）。
// エディタ(WebGL)専用。VRMAビルダーはthree非依存の純ロジック。
import * as THREE from 'https://esm.sh/three@0.184.0';

const EPS = 1e-6;

// ── 解析的 2-bone IK（rest向き非依存・位置再構築方式）。chain={root,mid,end,poleVector?} ──
export function solveTwoBoneIK(chain, targetWorld) {
  const { root, mid, end } = chain;
  const rootW = root.getWorldPosition(new THREE.Vector3());
  const midW = mid.getWorldPosition(new THREE.Vector3());
  const endW = end.getWorldPosition(new THREE.Vector3());
  const a = rootW.distanceTo(midW), b = midW.distanceTo(endW);
  const toTarget = new THREE.Vector3().subVectors(targetWorld, rootW);
  const dist = toTarget.length();
  if (dist < EPS || a < EPS || b < EPS) return { rootQuat: root.quaternion.clone(), midQuat: mid.quaternion.clone() };
  const c = Math.min(Math.max(dist, Math.abs(a - b) + EPS), a + b - EPS);
  const toTargetDir = toTarget.clone().normalize();
  const rootToMid = new THREE.Vector3().subVectors(midW, rootW);
  const midToEnd = new THREE.Vector3().subVectors(endW, midW);
  let bendDir = null;
  if (chain.poleVector && chain.poleVector.lengthSq() > EPS) {
    const p = chain.poleVector.clone();
    p.addScaledVector(toTargetDir, -p.dot(toTargetDir));
    if (p.lengthSq() > EPS) bendDir = p.normalize();
  }
  if (!bendDir) {
    const axis = new THREE.Vector3().crossVectors(rootToMid, midToEnd);
    if (axis.lengthSq() < EPS) {
      axis.crossVectors(toTargetDir, new THREE.Vector3(0, 0, 1));
      if (axis.lengthSq() < EPS) axis.crossVectors(toTargetDir, new THREE.Vector3(0, 1, 0));
    }
    axis.normalize();
    bendDir = new THREE.Vector3().crossVectors(axis, toTargetDir).normalize();
    if (bendDir.dot(rootToMid) < 0) bendDir.negate();
  }
  const cosRoot = THREE.MathUtils.clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const angRoot = Math.acos(cosRoot);
  const newMidW = rootW.clone().addScaledVector(toTargetDir, a * Math.cos(angRoot)).addScaledVector(bendDir, a * Math.sin(angRoot));
  const clampTarget = rootW.clone().addScaledVector(toTargetDir, c);
  const rootQW = root.getWorldQuaternion(new THREE.Quaternion());
  const midQW = mid.getWorldQuaternion(new THREE.Quaternion());
  const qRootDelta = new THREE.Quaternion().setFromUnitVectors(rootToMid.clone().normalize(), newMidW.clone().sub(rootW).normalize());
  const newRootQW = qRootDelta.clone().multiply(rootQW);
  const curMidDirAfterRoot = midToEnd.clone().normalize().applyQuaternion(qRootDelta);
  const desMidDir = clampTarget.clone().sub(newMidW).normalize();
  const qMidDelta = new THREE.Quaternion().setFromUnitVectors(curMidDirAfterRoot, desMidDir);
  const newMidQW = qMidDelta.clone().multiply(qRootDelta).multiply(midQW);
  const rootParentQW = root.parent ? root.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  return {
    rootQuat: rootParentQW.clone().invert().multiply(newRootQW),
    midQuat: newRootQW.clone().invert().multiply(newMidQW),
  };
}

// ── 背骨CCD IK: chain[0]=腰側→chain[last]=首側、end(head)を target へ。ローカル回転を直接更新 ──
const _bp = new THREE.Vector3(), _ep = new THREE.Vector3(), _te = new THREE.Vector3(), _tt = new THREE.Vector3();
const _ax = new THREE.Vector3(), _qs = new THREE.Quaternion(), _bq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _nq = new THREE.Quaternion();
export function solveSpineIK(chain, end, targetWorld, opts = {}) {
  if (!chain.length) return;
  const iterations = opts.iterations ?? 10;
  const maxStep = (opts.maxStepDeg ?? 12) * Math.PI / 180;
  for (let it = 0; it < iterations; it++) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      bone.updateWorldMatrix(true, false);
      end.updateWorldMatrix(true, false);
      bone.getWorldPosition(_bp);
      end.getWorldPosition(_ep);
      _te.copy(_ep).sub(_bp);
      _tt.copy(targetWorld).sub(_bp);
      if (_te.lengthSq() < 1e-10 || _tt.lengthSq() < 1e-10) continue;
      _te.normalize(); _tt.normalize();
      let angle = Math.acos(THREE.MathUtils.clamp(_te.dot(_tt), -1, 1));
      if (angle < 1e-5) continue;
      if (angle > maxStep) angle = maxStep;
      _ax.crossVectors(_te, _tt);
      if (_ax.lengthSq() < 1e-12) continue;
      _ax.normalize();
      _qs.setFromAxisAngle(_ax, angle);
      bone.getWorldQuaternion(_bq);
      if (bone.parent) bone.parent.getWorldQuaternion(_pq); else _pq.identity();
      _nq.copy(_qs).multiply(_bq);
      bone.quaternion.copy(_pq.invert().multiply(_nq));
    }
  }
}

// ── VRMA(glTF binary) 生成。tracks: [{boneName, times:Float32Array, values:Float32Array(xyzw×n)}]
//    正規化ボーンのローカル回転はrest=identityなのでデルタ変換不要（そのまま渡してよい）──
export function buildVrmaBlob(options) {
  return new Blob([buildVrmaGlb(options)], { type: 'model/gltf-binary' });
}
export function buildVrmaBuffer(options) {
  return buildVrmaGlb(options);
}
function buildVrmaGlb(options) {
  const { hipsRestY, tracks, blendShapes = [], hipPositionTrack } = options;
  const boneNames = tracks.map((t) => t.boneName);
  const exprNames = blendShapes.map((b) => b.expressionName);
  const boneNameToIdx = new Map(boneNames.map((name, i) => [name, i]));
  const exprNameToIdx = new Map(exprNames.map((name, i) => [name, boneNames.length + i]));
  const nodes = [
    ...boneNames.map((name) => (name === 'hips' && hipsRestY > 1e-4) ? { name, translation: [0, hipsRestY, 0] } : { name }),
    ...exprNames.map((name) => ({ name: `expression_${name}` })),
  ];
  const accessors = [], bufferViews = [], channels = [], samplers = [], binaryParts = [];
  let byteOffset = 0;
  const pushTrack = (times, values, comps, nodeIdx, path) => {
    const count = times.length;
    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({ bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR', min: [times[0]], max: [times[count - 1]] });
    binaryParts.push(times);
    byteOffset += count * 4;
    const vBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 * comps });
    const vAccIdx = accessors.length;
    accessors.push({ bufferView: vBvIdx, componentType: 5126, count, type: comps === 4 ? 'VEC4' : comps === 3 ? 'VEC3' : 'SCALAR' });
    binaryParts.push(values);
    byteOffset += count * 4 * comps;
    const samplerIdx = samplers.length;
    samplers.push({ input: tvAccIdx, interpolation: 'LINEAR', output: vAccIdx });
    channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path } });
  };
  for (const track of tracks) {
    const nodeIdx = boneNameToIdx.get(track.boneName);
    if (nodeIdx === undefined) continue;
    pushTrack(track.times, track.values, 4, nodeIdx, 'rotation');
  }
  for (const bs of blendShapes) {
    const nodeIdx = exprNameToIdx.get(bs.expressionName);
    if (nodeIdx === undefined) continue;
    pushTrack(bs.times, bs.values, 1, nodeIdx, 'weights');
  }
  if (hipPositionTrack) {
    pushTrack(hipPositionTrack.times, hipPositionTrack.values, 3, boneNameToIdx.get('hips') ?? 0, 'translation');
  }
  const binData = new Uint8Array(byteOffset);
  let off = 0;
  for (const part of binaryParts) {
    binData.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), off);
    off += part.byteLength;
  }
  const humanBones = {};
  for (const [name, idx] of boneNameToIdx) humanBones[name] = { node: idx };
  const expressionsPreset = {};
  for (const [name, idx] of exprNameToIdx) expressionsPreset[name] = { node: idx };
  const vrmAnimExt = { specVersion: '1.0', humanoid: { humanBones } };
  if (exprNames.length > 0) vrmAnimExt.expressions = { preset: expressionsPreset, custom: {} };
  const gltfJson = {
    asset: { version: '2.0', generator: 'web3d-gamemaker pose-kit' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: vrmAnimExt },
    scenes: [{ name: 'AuxScene', nodes: [boneNameToIdx.get('hips') ?? 0] }],
    scene: 0,
    nodes,
    animations: [{ name: 'Animation', channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };
  return packGlb(gltfJson, binData.buffer);
}
function packGlb(json, binBuffer) {
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const jsonBytes = new TextEncoder().encode(jsonText);
  const binPadded = Math.ceil(binBuffer.byteLength / 4) * 4;
  const binBytes = new Uint8Array(binPadded);
  binBytes.set(new Uint8Array(binBuffer));
  const totalLength = 12 + 8 + jsonBytes.length + (binPadded > 0 ? 8 + binPadded : 0);
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  if (binPadded > 0) {
    const binOffset = 20 + jsonBytes.length;
    view.setUint32(binOffset, binPadded, true);
    view.setUint32(binOffset + 4, 0x004e4942, true);
    bytes.set(binBytes, binOffset + 8);
  }
  return out;
}
