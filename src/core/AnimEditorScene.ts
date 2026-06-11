/**
 * AnimEditorScene.ts
 * アニメーションエディタ専用のシーン管理。
 * TransformControls によるボーン回転ギズモ、IK ハンドル、seekToFrame を提供する。
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { VRM } from '@pixiv/three-vrm';
import type { SceneManager } from './SceneManager';
import type { OrbitController } from './OrbitController';
import type { IKTarget } from '../types';
import { solveTwoBoneIK } from './TwoBoneIK';
import type { TwoBoneIKChain } from './TwoBoneIK';
import { animEditorStore } from '../stores/animEditorStore';
import { get } from 'svelte/store';

// IK チェーン定義 (VRM HumanBoneName)
const IK_CHAINS: Record<IKTarget, { root: string; mid: string; end: string }> = {
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand' },
  leftHand:  { root: 'leftUpperArm',  mid: 'leftLowerArm',  end: 'leftHand'  },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot' },
  leftFoot:  { root: 'leftUpperLeg',  mid: 'leftLowerLeg',  end: 'leftFoot'  },
};

export type IKGizmoMode = 'translate' | 'rotate';

export type IKSolveResult = Partial<Record<IKTarget, {
  root: string; rootQ: THREE.Quaternion;
  mid: string;  midQ: THREE.Quaternion;
}>>;

export type AnimEditorSceneHandle = {
  setVRM(vrm: VRM): void;
  seekToFrame(frame: number): void;
  selectBone(boneName: string | null): void;
  setIKEnabled(target: IKTarget, enabled: boolean): void;
  setIKGizmoMode(mode: IKGizmoMode): void;
  onBoneRotated: (boneName: string, quat: THREE.Quaternion) => void;
  onBoneClicked: (boneName: string) => void;
  onIKSolved: (results: IKSolveResult) => void;
  onIKTargetSelected: (target: IKTarget | null) => void;
  update(delta: number): void;
  dispose(): void;
};

export function createAnimEditorScene(
  sceneManager: SceneManager,
  orbitController: OrbitController,
): AnimEditorSceneHandle {
  const { scene, camera, renderer } = sceneManager;

  let vrm: VRM | null = null;
  let skeletonHelper: THREE.SkeletonHelper | null = null;

  // TransformControls は1つだけ使う。ボーン回転・IK移動・IK回転を状態で切り替える。
  // three r169+ では本体ではなく getHelper() の返すオブジェクトをシーンに追加してギズモを描画する。
  let tc: TransformControls | null = null;
  let tcHelper: THREE.Object3D | null = null;

  // ボーン選択状態
  let selectedBone: THREE.Bone | null = null;
  let selectedBoneName: string | null = null;

  // IK 状態
  const ikHandles = new Map<IKTarget, THREE.Mesh>();
  const ikEnabled = new Map<IKTarget, boolean>();
  let activeIKTarget: IKTarget | null = null;
  let ikGizmoMode: IKGizmoMode = 'translate';
  // IK の曲げ方向ヒント（掴んだ時点の肘/膝の向き）。逆曲がり防止用にソルバへ渡す。
  let activePole: THREE.Vector3 | null = null;

  const raycaster = new THREE.Raycaster();
  raycaster.params.Line = { threshold: 0.05 };

  // TransformControls 初期化（VRM ロード時に1回作成）
  function initTC(): void {
    if (tc) {
      if (tcHelper) { scene.remove(tcHelper); tcHelper = null; }
      tc.dispose();
    }
    tc = new TransformControls(camera, renderer.domElement);
    tc.setMode('rotate');
    tc.setSpace('local');
    tcHelper = tc.getHelper();           // r169+: ギズモ描画用オブジェクト
    scene.add(tcHelper);

    tc.addEventListener('dragging-changed', (event) => {
      orbitController.setEnabled(!(event as { value: boolean }).value);
    });

    tc.addEventListener('objectChange', () => {
      if (activeIKTarget !== null) {
        handleIKObjectChange();
      } else if (selectedBone && selectedBoneName) {
        handle.onBoneRotated(selectedBoneName, selectedBone.quaternion.clone());
      }
    });
  }

  function handleIKObjectChange(): void {
    if (!vrm || !activeIKTarget) return;
    const chainDef = IK_CHAINS[activeIKTarget];

    if (ikGizmoMode === 'translate') {
      const handleMesh = ikHandles.get(activeIKTarget);
      if (!handleMesh) return;
      const rootBone = vrm.humanoid.getRawBoneNode(chainDef.root as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      const midBone  = vrm.humanoid.getRawBoneNode(chainDef.mid  as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      const endBone  = vrm.humanoid.getRawBoneNode(chainDef.end  as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      if (!rootBone || !midBone || !endBone) return;

      const chain: TwoBoneIKChain = { root: rootBone, mid: midBone, end: endBone, poleVector: activePole ?? undefined };
      const result = solveTwoBoneIK(chain, handleMesh.position);
      rootBone.quaternion.copy(result.rootQuat);
      midBone.quaternion.copy(result.midQuat);

      handle.onIKSolved({
        [activeIKTarget]: {
          root: chainDef.root, rootQ: result.rootQuat.clone(),
          mid:  chainDef.mid,  midQ:  result.midQuat.clone(),
        },
      });
    } else {
      // rotate: エンドボーン回転をキーフレームに記録
      const endBone = vrm.humanoid.getRawBoneNode(chainDef.end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      if (endBone) handle.onBoneRotated(chainDef.end, endBone.quaternion.clone());
    }
  }

  // IK ハンドル Mesh を生成
  function createIKHandle(target: IKTarget): THREE.Mesh {
    const geo = new THREE.SphereGeometry(0.06, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: target.includes('Hand') ? 0x00aaff : 0x00ff88,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 998;
    scene.add(mesh);
    return mesh;
  }

  // IK ハンドルをボーン先端位置に同期
  function syncIKHandles(): void {
    if (!vrm) return;
    for (const [target, mesh] of ikHandles) {
      if (!ikEnabled.get(target)) { mesh.visible = false; continue; }
      // translate モードでドラッグ中はユーザー位置を維持
      if (activeIKTarget === target && tc?.dragging && ikGizmoMode === 'translate') continue;
      const chain = IK_CHAINS[target];
      const endBone = vrm.humanoid.getRawBoneNode(chain.end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]);
      if (endBone) {
        endBone.getWorldPosition(mesh.position);
        mesh.visible = true;
      }
    }
  }

  // 掴んだ時点の肘/膝の曲げ方向を捕捉（root→end 線に対する mid の直交オフセット方向・ワールド）。
  // これを pole としてソルバに固定で渡すことで、手足が真っ直ぐを通過しても逆側に曲がらない。
  function captureActivePole(target: IKTarget): void {
    activePole = null;
    if (!vrm) return;
    const def = IK_CHAINS[target];
    const rb = vrm.humanoid.getRawBoneNode(def.root as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const mb = vrm.humanoid.getRawBoneNode(def.mid as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const eb = vrm.humanoid.getRawBoneNode(def.end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    if (!rb || !mb || !eb) return;
    const rW = rb.getWorldPosition(new THREE.Vector3());
    const mW = mb.getWorldPosition(new THREE.Vector3());
    const eW = eb.getWorldPosition(new THREE.Vector3());
    const dir = eW.clone().sub(rW);
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();
    const pole = mW.clone().sub(rW);
    pole.addScaledVector(dir, -pole.dot(dir));   // root→end 方向成分を除去 = 肘の出ている向き
    if (pole.lengthSq() > 1e-8) activePole = pole.normalize();
  }

  // IK ターゲットを選択してギズモをアタッチ
  function selectIKTarget(target: IKTarget): void {
    if (!vrm || !tc) return;
    activeIKTarget = target;
    ikGizmoMode = 'translate';
    captureActivePole(target);

    selectedBone = null;
    selectedBoneName = null;
    animEditorStore.setSelectedBone(null);

    const handleMesh = ikHandles.get(target)!;
    tc.setMode('translate');
    tc.setSpace('world');
    tc.attach(handleMesh);
    handle.onIKTargetSelected(target);
  }

  // ボーン選択
  function selectBoneInternal(bone: THREE.Bone, boneName: string): void {
    if (!tc) return;
    selectedBone = bone;
    selectedBoneName = boneName;
    activeIKTarget = null;
    handle.onIKTargetSelected(null);
    tc.setMode('rotate');
    tc.setSpace('local');
    tc.attach(bone);
    animEditorStore.setSelectedBone(boneName);
  }

  // ポインターイベント
  const _mouse = new THREE.Vector2();

  function onPointerDown(e: PointerEvent): void {
    if (!vrm) return;
    // ギズモの軸上クリック or ドラッグ中は独自ピッキングせず TransformControls に委ねる
    // （これをしないと、矢印を掴んだ瞬間に「ハンドル非ヒット」と判定され detach されてドラッグできない）
    if (tc && (tc.dragging || tc.axis !== null)) return;

    const rect = renderer.domElement.getBoundingClientRect();
    _mouse.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(_mouse, camera);

    // IK ハンドルのクリック判定
    for (const [target, mesh] of ikHandles) {
      if (!mesh.visible) continue;
      if (raycaster.intersectObject(mesh).length > 0) {
        selectIKTarget(target);
        return;
      }
    }

    // IK ターゲット解除
    if (activeIKTarget !== null) {
      activeIKTarget = null;
      handle.onIKTargetSelected(null);
      // ボーン回転モードに戻す
      if (selectedBone) {
        tc?.setMode('rotate');
        tc?.setSpace('local');
        tc?.attach(selectedBone);
      } else {
        tc?.detach();
      }
    }

    // ボーンのクリック判定
    if (skeletonHelper) {
      const hits = raycaster.intersectObject(skeletonHelper, true);
      if (hits.length > 0) {
        const point = hits[0].point;
        let nearestBone: THREE.Bone | null = null;
        let nearestBoneName: string | null = null;
        let minDist = Infinity;
        vrm.scene.traverse((obj) => {
          if (!(obj as THREE.Bone).isBone) return;
          const bp = new THREE.Vector3();
          obj.getWorldPosition(bp);
          const dist = bp.distanceTo(point);
          if (dist < minDist) {
            minDist = dist;
            nearestBone = obj as THREE.Bone;
            nearestBoneName = obj.name;
          }
        });
        if (nearestBone && nearestBoneName) {
          selectBoneInternal(nearestBone, nearestBoneName);
          handle.onBoneClicked(nearestBoneName);
        }
      }
    }
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);

  for (const target of Object.keys(IK_CHAINS) as IKTarget[]) {
    ikHandles.set(target, createIKHandle(target));
    ikEnabled.set(target, false);
  }

  const handle: AnimEditorSceneHandle = {
    setVRM(newVrm: VRM): void {
      if (vrm) scene.remove(vrm.scene);
      vrm = newVrm;
      scene.add(newVrm.scene);

      if (skeletonHelper) {
        scene.remove(skeletonHelper);
        skeletonHelper.dispose();
      }
      skeletonHelper = new THREE.SkeletonHelper(newVrm.scene);
      scene.add(skeletonHelper);

      initTC();
      syncIKHandles();
    },

    seekToFrame(frame: number): void {
      if (!vrm) return;
      const state = get(animEditorStore);

      // ヒップ位置を適用
      if (state.hipsPositionKeyframes.size > 0) {
        const hipFrames = [...state.hipsPositionKeyframes.keys()].sort((a, b) => a - b);
        let hipsPos: THREE.Vector3;
        if (frame <= hipFrames[0]) {
          hipsPos = state.hipsPositionKeyframes.get(hipFrames[0])!;
        } else if (frame >= hipFrames[hipFrames.length - 1]) {
          hipsPos = state.hipsPositionKeyframes.get(hipFrames[hipFrames.length - 1])!;
        } else {
          let prevF = hipFrames[0];
          let nextF = hipFrames[hipFrames.length - 1];
          for (const f of hipFrames) {
            if (f <= frame) prevF = f;
            if (f >= frame && f > prevF) { nextF = f; break; }
          }
          const t = nextF === prevF ? 0 : (frame - prevF) / (nextF - prevF);
          hipsPos = new THREE.Vector3().lerpVectors(
            state.hipsPositionKeyframes.get(prevF)!,
            state.hipsPositionKeyframes.get(nextF)!,
            t,
          );
        }
        const normalizedHips = vrm.humanoid.getNormalizedBoneNode('hips');
        if (normalizedHips) {
          normalizedHips.position.copy(hipsPos);
          vrm.humanoid.update();
        }
      }

      // ボーン回転を適用
      for (const [boneName, frameMap] of state.boneKeyframes) {
        const bone = vrm.humanoid.getRawBoneNode(boneName as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]);
        if (!bone) continue;
        const frames = [...frameMap.keys()].sort((a, b) => a - b);
        if (frames.length === 0) continue;

        let q: THREE.Quaternion;
        if (frame <= frames[0]) {
          q = frameMap.get(frames[0])!;
        } else if (frame >= frames[frames.length - 1]) {
          q = frameMap.get(frames[frames.length - 1])!;
        } else {
          let prevF = frames[0];
          let nextF = frames[frames.length - 1];
          for (const f of frames) {
            if (f <= frame) prevF = f;
            if (f >= frame && f > prevF) { nextF = f; break; }
          }
          const t = nextF === prevF ? 0 : (frame - prevF) / (nextF - prevF);
          q = new THREE.Quaternion().slerpQuaternions(frameMap.get(prevF)!, frameMap.get(nextF)!, t);
        }
        bone.quaternion.copy(q);
      }

      // ブレンドシェイプを適用
      if (vrm.expressionManager) {
        for (const [exprName, frameMap] of state.blendShapeKeyframes) {
          const frames = [...frameMap.keys()].sort((a, b) => a - b);
          if (frames.length === 0) continue;
          let value: number;
          if (frame <= frames[0]) {
            value = frameMap.get(frames[0])!;
          } else if (frame >= frames[frames.length - 1]) {
            value = frameMap.get(frames[frames.length - 1])!;
          } else {
            let prevF = frames[0];
            let nextF = frames[frames.length - 1];
            for (const f of frames) {
              if (f <= frame) prevF = f;
              if (f >= frame && f > prevF) { nextF = f; break; }
            }
            const t = nextF === prevF ? 0 : (frame - prevF) / (nextF - prevF);
            value = (frameMap.get(prevF)!) * (1 - t) + (frameMap.get(nextF)!) * t;
          }
          vrm.expressionManager.setValue(exprName as Parameters<typeof vrm.expressionManager.setValue>[0], value);
        }
        vrm.expressionManager.update();
      }

      // TC が IK 移動モードでなければボーンへ再アタッチ（seekToFrame でもギズモ位置が追従）
      if (tc && selectedBone && activeIKTarget === null) {
        tc.attach(selectedBone);
      }

      syncIKHandles();
    },

    selectBone(boneName: string | null): void {
      if (!boneName || !vrm) {
        tc?.detach();
        selectedBone = null;
        selectedBoneName = null;
        animEditorStore.setSelectedBone(null);
        return;
      }
      const bone = vrm.humanoid.getRawBoneNode(boneName as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      if (bone) selectBoneInternal(bone, boneName);
    },

    setIKEnabled(target: IKTarget, enabled: boolean): void {
      ikEnabled.set(target, enabled);
      const mesh = ikHandles.get(target);
      if (!mesh) return;

      if (enabled) {
        syncIKHandles();
        selectIKTarget(target);
      } else {
        mesh.visible = false;
        if (activeIKTarget === target) {
          activeIKTarget = null;
          handle.onIKTargetSelected(null);
          if (selectedBone) {
            tc?.setMode('rotate');
            tc?.setSpace('local');
            tc?.attach(selectedBone);
          } else {
            tc?.detach();
          }
        }
      }
    },

    setIKGizmoMode(mode: IKGizmoMode): void {
      if (!vrm || !activeIKTarget || !tc) return;
      ikGizmoMode = mode;
      const chainDef = IK_CHAINS[activeIKTarget];

      if (mode === 'translate') {
        const handleMesh = ikHandles.get(activeIKTarget)!;
        tc.setSpace('world');
        tc.setMode('translate');
        tc.attach(handleMesh);
      } else {
        const endBone = vrm.humanoid.getRawBoneNode(chainDef.end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
        if (!endBone) return;
        tc.setSpace('local');
        tc.setMode('rotate');
        tc.attach(endBone);
      }
    },

    onBoneRotated: (_boneName: string, _quat: THREE.Quaternion) => {},
    onBoneClicked: (_boneName: string) => {},
    onIKSolved: (_results: IKSolveResult) => {},
    onIKTargetSelected: (_target: IKTarget | null) => {},

    update(_delta: number): void {
      if (vrm) vrm.update(_delta);
    },

    dispose(): void {
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      if (vrm) scene.remove(vrm.scene);
      if (tc) {
        if (tcHelper) { scene.remove(tcHelper); tcHelper = null; }
        tc.dispose();
      }
      if (skeletonHelper) {
        scene.remove(skeletonHelper);
        skeletonHelper.dispose();
      }
      for (const mesh of ikHandles.values()) {
        scene.remove(mesh);
        (mesh.geometry as THREE.SphereGeometry).dispose();
        (mesh.material as THREE.MeshBasicMaterial).dispose();
      }
      ikHandles.clear();
    },
  };

  return handle;
}
