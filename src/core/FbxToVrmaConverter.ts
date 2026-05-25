import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mixamoBoneToVrm } from './MixamoBoneMap';
import { buildVrmaBlob } from './VrmaBuilder';
import type { VrmaTrackInput } from './VrmaBuilder';

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

  // ---- 3. GLB を VrmaBuilder 経由で構築 ----
  onProgress?.({ stage: 'exporting', message: 'VRMA を生成中...' });

  const tracks: VrmaTrackInput[] = [...humanoidQuatTracks.entries()].map(([boneName, track]) => ({
    boneName,
    times: new Float32Array(track.times),
    values: new Float32Array(track.values as Float32Array),
  }));

  const blob = buildVrmaBlob({
    durationSec: clip.duration,
    hipsRestY: hipsRestWorldY,
    tracks,
    ...(hipPositionTrack ? { hipPositionTrack } : {}),
  });

  return { blob, filename: outputFilename, mappedBoneCount, totalBoneCount };
}

