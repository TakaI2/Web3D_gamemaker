/**
 * VrmaBuilder.ts
 * キーフレームデータから VRMA（glTF binary）を生成するモジュール。
 * FbxToVrmaConverter と AnimationEditor の両方から使用する。
 */

// ---- glTF 内部型 ----
type GltfAccessor = {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
};
type GltfBufferView = { buffer: number; byteOffset: number; byteLength: number };
type GltfChannel = { sampler: number; target: { node: number; path: string } };
type GltfSampler = { input: number; interpolation: string; output: number };

// ---- 公開型 ----

/** ボーン回転トラック（デルタ値: restQuat_inv ⊗ frameQuat を呼び出し元で計算済み） */
export type VrmaTrackInput = {
  readonly boneName: string;      // VRM HumanBoneName
  readonly times: Float32Array;
  readonly values: Float32Array;  // xyzw quaternion × n フレーム
};

/** ブレンドシェイプ（表情）トラック */
export type VrmaBlendShapeInput = {
  readonly expressionName: string;
  readonly times: Float32Array;
  readonly values: Float32Array;  // weight（0〜1）× n フレーム
};

export type VrmaBuildOptions = {
  readonly durationSec: number;
  readonly hipsRestY: number;       // VRM 安静時ヒップ Y 座標（VRMA restHipsPosition）
  readonly tracks: VrmaTrackInput[];
  readonly blendShapes?: VrmaBlendShapeInput[];
  /** FBX から変換したヒップ平行移動トラック（VEC3、オプション） */
  readonly hipPositionTrack?: { times: Float32Array; values: Float32Array };
};

/**
 * キーフレームデータから VRMA GLB Blob を生成する。
 * tracks の values はすでにデルタ変換済みであること。
 */
export function buildVrmaBlob(options: VrmaBuildOptions): Blob {
  const buf = buildVrmaGlb(options);
  return new Blob([buf], { type: 'model/gltf-binary' });
}

/**
 * buildVrmaBlob の ArrayBuffer 版（テスト・Node.js 環境用）。
 */
export function buildVrmaBuffer(options: VrmaBuildOptions): ArrayBuffer {
  return buildVrmaGlb(options);
}

// ---- 内部実装 ----

function buildVrmaGlb(options: VrmaBuildOptions): ArrayBuffer {
  const { hipsRestY, tracks, blendShapes = [], hipPositionTrack } = options;

  // ノードリスト: ボーン + 表情
  const boneNames = tracks.map((t) => t.boneName);
  const exprNames = blendShapes.map((b) => b.expressionName);

  const boneNameToIdx = new Map(boneNames.map((name, i) => [name, i]));
  const exprNameToIdx = new Map(exprNames.map((name, i) => [name, boneNames.length + i]));

  const nodes = [
    ...boneNames.map((name) => {
      if (name === 'hips' && hipsRestY > 1e-4) {
        return { name, translation: [0, hipsRestY, 0] };
      }
      return { name };
    }),
    ...exprNames.map((name) => ({ name: `expression_${name}` })),
  ];

  const accessors: GltfAccessor[] = [];
  const bufferViews: GltfBufferView[] = [];
  const channels: GltfChannel[] = [];
  const samplers: GltfSampler[] = [];
  const binaryParts: Float32Array[] = [];
  let byteOffset = 0;

  // ボーン回転トラック
  for (const track of tracks) {
    const nodeIdx = boneNameToIdx.get(track.boneName);
    if (nodeIdx === undefined) continue;
    const times = track.times;
    const values = track.values;
    const count = times.length;

    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({
      bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR',
      min: [times[0]], max: [times[count - 1]],
    });
    binaryParts.push(times);
    byteOffset += count * 4;

    const qBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 16 });
    const qAccIdx = accessors.length;
    accessors.push({ bufferView: qBvIdx, componentType: 5126, count, type: 'VEC4' });
    binaryParts.push(values);
    byteOffset += count * 16;

    const samplerIdx = samplers.length;
    samplers.push({ input: tvAccIdx, interpolation: 'LINEAR', output: qAccIdx });
    channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path: 'rotation' } });
  }

  // ブレンドシェイプトラック（表情）
  for (const bs of blendShapes) {
    const nodeIdx = exprNameToIdx.get(bs.expressionName);
    if (nodeIdx === undefined) continue;
    const times = bs.times;
    const values = bs.values;
    const count = times.length;

    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({
      bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR',
      min: [times[0]], max: [times[count - 1]],
    });
    binaryParts.push(times);
    byteOffset += count * 4;

    const wBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const wAccIdx = accessors.length;
    accessors.push({ bufferView: wBvIdx, componentType: 5126, count, type: 'SCALAR' });
    binaryParts.push(values);
    byteOffset += count * 4;

    const samplerIdx = samplers.length;
    samplers.push({ input: tvAccIdx, interpolation: 'LINEAR', output: wAccIdx });
    channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path: 'weights' } });
  }

  // ヒップ平行移動トラック（FBX変換時のみ使用）
  if (hipPositionTrack) {
    const nodeIdx = boneNameToIdx.get('hips') ?? 0;
    const { times, values } = hipPositionTrack;
    const count = times.length;

    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({
      bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR',
      min: [times[0]], max: [times[count - 1]],
    });
    binaryParts.push(times);
    byteOffset += count * 4;

    const pBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 12 });
    const pAccIdx = accessors.length;
    accessors.push({ bufferView: pBvIdx, componentType: 5126, count, type: 'VEC3' });
    binaryParts.push(values);
    byteOffset += count * 12;

    const samplerIdx = samplers.length;
    samplers.push({ input: tvAccIdx, interpolation: 'LINEAR', output: pAccIdx });
    channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path: 'translation' } });
  }

  // バイナリ結合
  const binData = new Uint8Array(byteOffset);
  let off = 0;
  for (const part of binaryParts) {
    binData.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), off);
    off += part.byteLength;
  }

  // humanBones エントリ
  const humanBones: Record<string, { node: number }> = {};
  for (const [name, idx] of boneNameToIdx) {
    humanBones[name] = { node: idx };
  }

  // expressions エントリ
  const expressionsPreset: Record<string, { node: number }> = {};
  for (const [name, idx] of exprNameToIdx) {
    expressionsPreset[name] = { node: idx };
  }

  const vrmAnimExt: Record<string, unknown> = {
    specVersion: '1.0',
    humanoid: { humanBones },
  };
  if (exprNames.length > 0) {
    vrmAnimExt['expressions'] = { preset: expressionsPreset, custom: {} };
  }

  const rootNodeIdx = boneNameToIdx.get('hips') ?? 0;

  const gltfJson = {
    asset: { version: '2.0', generator: 'web3d-gamemaker VrmaBuilder' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: vrmAnimExt },
    scenes: [{ name: 'AuxScene', nodes: [rootNodeIdx] }],
    scene: 0,
    nodes,
    animations: [{ name: 'Animation', channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }],
  };

  return packGlb(gltfJson, binData.buffer);
}

function packGlb(json: object, binBuffer: ArrayBuffer): ArrayBuffer {
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

  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);

  if (binPadded > 0) {
    const binOffset = 20 + jsonBytes.length;
    view.setUint32(binOffset, binPadded, true);
    view.setUint32(binOffset + 4, 0x004e4942, true); // "BIN\0"
    bytes.set(binBytes, binOffset + 8);
  }

  return out;
}
