import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mixamoBoneToVrm } from './MixamoBoneMap';

export type ConvertResult = {
  readonly blob: Blob;
  readonly filename: string;
  readonly mappedBoneCount: number;
  readonly totalBoneCount: number;
};

export type ConvertProgress = {
  readonly stage: 'loading' | 'converting' | 'exporting';
  readonly message: string;
};

// ---- glTF 型 ----
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

export async function convertFbxToVrma(
  fbxUrl: string,
  outputFilename: string,
  onProgress?: (p: ConvertProgress) => void,
): Promise<ConvertResult> {
  // ---- 1. FBX 読み込み ----
  onProgress?.({ stage: 'loading', message: 'FBX を読み込み中...' });
  const loader = new FBXLoader();
  const fbxRoot = await new Promise<THREE.Group>((resolve, reject) => {
    loader.load(fbxUrl, resolve, undefined, reject);
  });

  const clips: THREE.AnimationClip[] = fbxRoot.animations;
  if (clips.length === 0) throw new Error('FBX にアニメーションが含まれていません');
  const clip = clips[0];

  // ---- 2. ボーンマッピング ----
  onProgress?.({ stage: 'converting', message: 'ボーンをマッピング中...' });

  // シーンを一度更新してワールド座標・バインドポーズを確定
  fbxRoot.updateWorldMatrix(true, true);

  const boneNames = new Set<string>();
  const boneWorldPositions = new Map<string, THREE.Vector3>();
  fbxRoot.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      boneNames.add(obj.name);
      const wp = new THREE.Vector3();
      obj.getWorldPosition(wp);
      boneWorldPositions.set(obj.name, wp);
    }
  });

  // Three.js FBXLoader は FBX の PreRotation をトラック値に焼き込む（obj.quaternion は常に identity）。
  // skeleton.boneInverses（スキンバインド時の逆ワールド行列）から真のローカルバインド回転を復元する。
  // localBind = parentWorldBind^-1 × boneWorldBind = boneInverses[pi] × boneInverses[i]^-1
  // delta(t) = localBind_inv × animQ(t) = PreRotation除去後の純アニメーション回転
  const bindPoseQuats = new Map<string, THREE.Quaternion>();
  {
    const _bpPos = new THREE.Vector3();
    const _bpScale = new THREE.Vector3();
    fbxRoot.traverse((obj) => {
      if (!(obj as THREE.SkinnedMesh).isSkinnedMesh) return;
      const sm = obj as THREE.SkinnedMesh;
      const { skeleton } = sm;
      const boneToIdx = new Map<THREE.Bone, number>();
      skeleton.bones.forEach((b, idx) => boneToIdx.set(b, idx));
      skeleton.bones.forEach((bone, i) => {
        if (bindPoseQuats.has(bone.name)) return;
        // boneWorldBind = boneInverses[i]^-1
        const boneWorldBind = skeleton.boneInverses[i].clone().invert();
        const parentBone = bone.parent && (bone.parent as THREE.Bone).isBone
          ? (bone.parent as THREE.Bone)
          : null;
        let localMat: THREE.Matrix4;
        if (parentBone && boneToIdx.has(parentBone)) {
          const pi = boneToIdx.get(parentBone)!;
          // localMat = boneInverses[pi] × boneWorldBind = parentWorldBind^-1 × boneWorldBind
          localMat = skeleton.boneInverses[pi].clone().multiply(boneWorldBind);
        } else {
          localMat = boneWorldBind;
        }
        const q = new THREE.Quaternion();
        localMat.decompose(_bpPos, q, _bpScale);
        bindPoseQuats.set(bone.name, q.normalize());
      });
    });
  }
  // フォールバック: スキンメッシュなし（Without Skin FBX 等）の場合は第1キーフレームを使用
  if (bindPoseQuats.size === 0) {
    for (const track of clip.tracks) {
      const dotIdx = track.name.lastIndexOf('.');
      if (dotIdx < 0) continue;
      const boneName = track.name.slice(0, dotIdx);
      const property = track.name.slice(dotIdx + 1);
      if (property === 'quaternion' && track.values.length >= 4) {
        const v = track.values as Float32Array;
        if (!bindPoseQuats.has(boneName)) {
          bindPoseQuats.set(boneName, new THREE.Quaternion(v[0], v[1], v[2], v[3]).normalize());
        }
      }
    }
  }
  const totalBoneCount = boneNames.size;

  // hips ボーンのワールド Y 位置（restHipsPosition として VRMA に埋め込む）
  let hipsRestWorldY = 0;
  for (const [boneName, wp] of boneWorldPositions) {
    const vrmBone = mixamoBoneToVrm(boneName);
    if (vrmBone === 'hips') { hipsRestWorldY = wp.y; break; }
  }

  const humanoidQuatTracks = new Map<string, THREE.QuaternionKeyframeTrack>();
  let hipPositionTrack: { times: Float32Array; values: Float32Array } | null = null;

  // バインドポーズ逆回転用の作業クォータニオン
  const _bindInv = new THREE.Quaternion();
  const _frameQ = new THREE.Quaternion();
  const _deltaQ = new THREE.Quaternion();

  for (const track of clip.tracks) {
    const dotIdx = track.name.lastIndexOf('.');
    if (dotIdx < 0) continue;
    const boneName = track.name.slice(0, dotIdx);
    const property = track.name.slice(dotIdx + 1);

    const vrmBone = mixamoBoneToVrm(boneName);
    if (!vrmBone) continue;

    if (property === 'quaternion') {
      // delta(t) = bindPose_inv * anim(t)
      // FBX トラックはバインドポーズ基準の絶対ローカル回転を格納しているため、
      // バインドポーズを除去して T-pose 基準のデルタ回転に変換する
      const bindQ = bindPoseQuats.get(boneName);
      if (bindQ) {
        _bindInv.copy(bindQ).invert();
      } else {
        _bindInv.identity();
      }

      const srcValues = track.values as Float32Array;
      const dstValues = new Float32Array(srcValues.length);
      for (let i = 0; i < srcValues.length; i += 4) {
        _frameQ.set(srcValues[i], srcValues[i + 1], srcValues[i + 2], srcValues[i + 3]);
        _deltaQ.multiplyQuaternions(_bindInv, _frameQ);
        dstValues[i]     = _deltaQ.x;
        dstValues[i + 1] = _deltaQ.y;
        dstValues[i + 2] = _deltaQ.z;
        dstValues[i + 3] = _deltaQ.w;
      }

      humanoidQuatTracks.set(
        vrmBone,
        new THREE.QuaternionKeyframeTrack(
          `${vrmBone}.quaternion`,
          Array.from(track.times),
          dstValues,
        ),
      );
    } else if (property === 'position' && vrmBone === 'hips') {
      hipPositionTrack = {
        times: new Float32Array(track.times),
        values: new Float32Array(track.values as Float32Array),
      };
    }
  }

  const mappedBoneCount = humanoidQuatTracks.size;
  if (mappedBoneCount === 0) {
    const sample = clip.tracks.slice(0, 4).map((t) => t.name).join(' / ');
    throw new Error(`マッピングできるボーンが見つかりませんでした。\nサンプル: ${sample || '(なし)'}`);
  }

  // ---- 3. GLB を直接構築 ----
  onProgress?.({ stage: 'exporting', message: 'VRMA を生成中...' });

  const glbBuffer = buildVrmaGlb(humanoidQuatTracks, hipPositionTrack, clip.duration, hipsRestWorldY);
  const blob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
  return { blob, filename: outputFilename, mappedBoneCount, totalBoneCount };
}

// ---- VRMA GLB 直接構築 ----

function buildVrmaGlb(
  quatTracks: Map<string, THREE.QuaternionKeyframeTrack>,
  hipPos: { times: Float32Array; values: Float32Array } | null,
  _duration: number,
  hipsRestWorldY: number,
): ArrayBuffer {
  const boneList = [...quatTracks.keys()];
  const nameToIdx = new Map(boneList.map((name, i) => [name, i]));

  // hips ノードだけ restHipsPosition として Y 位置を記録する（ローダーがスケール計算に使用）
  const nodes = boneList.map((name) => {
    if (name === 'hips' && hipsRestWorldY > 1e-4) {
      return { name, translation: [0, hipsRestWorldY, 0] };
    }
    return { name };
  });

  const accessors: GltfAccessor[] = [];
  const bufferViews: GltfBufferView[] = [];
  const channels: GltfChannel[] = [];
  const samplers: GltfSampler[] = [];
  const binaryParts: Float32Array[] = [];
  let byteOffset = 0;

  // 各ボーンの quaternion トラック
  for (const [boneName, track] of quatTracks) {
    const nodeIdx = nameToIdx.get(boneName)!;
    const times = new Float32Array(track.times);
    const values = new Float32Array(track.values as Float32Array);
    const count = times.length;

    // time accessor
    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({ bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR', min: [times[0]], max: [times[count - 1]] });
    binaryParts.push(times);
    byteOffset += count * 4;

    // quaternion accessor
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

  // hips position トラック
  if (hipPos) {
    const nodeIdx = nameToIdx.get('hips') ?? 0;
    const { times, values } = hipPos;
    const count = times.length;

    const tvBvIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: count * 4 });
    const tvAccIdx = accessors.length;
    accessors.push({ bufferView: tvBvIdx, componentType: 5126, count, type: 'SCALAR', min: [times[0]], max: [times[count - 1]] });
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
  const totalBinBytes = byteOffset;
  const binData = new Uint8Array(totalBinBytes);
  let off = 0;
  for (const part of binaryParts) {
    binData.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), off);
    off += part.byteLength;
  }

  // humanBones エントリ
  const humanBones: Record<string, { node: number }> = {};
  for (const [name, idx] of nameToIdx) {
    humanBones[name] = { node: idx };
  }

  // ルートノード（シーンに配置するだけのダミー）: hips を使う
  const rootNodeIdx = nameToIdx.get('hips') ?? 0;

  const gltfJson = {
    asset: { version: '2.0', generator: 'web3d-gamemaker FBX→VRMA converter' },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
    scenes: [{ name: 'AuxScene', nodes: [rootNodeIdx] }],
    scene: 0,
    nodes,
    animations: [{ name: 'Animation', channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: totalBinBytes }],
  };

  return packGlb(gltfJson, binData.buffer);
}

// ---- GLB パック ----

function packGlb(json: object, binBuffer: ArrayBuffer): ArrayBuffer {
  // JSON チャンク (4バイトアライン、スペースでパディング)
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const jsonBytes = new TextEncoder().encode(jsonText);

  // BIN チャンク (4バイトアライン、ゼロパディング)
  const binPadded = Math.ceil(binBuffer.byteLength / 4) * 4;
  const binBytes = new Uint8Array(binPadded);
  binBytes.set(new Uint8Array(binBuffer));

  const totalLength = 12 + 8 + jsonBytes.length + (binPadded > 0 ? 8 + binPadded : 0);
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // GLB header
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  // JSON chunk
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.set(jsonBytes, 20);

  // BIN chunk
  if (binPadded > 0) {
    const binOffset = 20 + jsonBytes.length;
    view.setUint32(binOffset, binPadded, true);
    view.setUint32(binOffset + 4, 0x004e4942, true); // "BIN\0"
    bytes.set(binBytes, binOffset + 8);
  }

  return out;
}
