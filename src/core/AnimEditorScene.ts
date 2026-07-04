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
import { solveSpineIK } from './SpineIK';
import { animEditorStore } from '../stores/animEditorStore';
import { get } from 'svelte/store';

// IK チェーン定義 (VRM HumanBoneName)
const IK_CHAINS: Record<IKTarget, { root: string; mid: string; end: string }> = {
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand' },
  leftHand:  { root: 'leftUpperArm',  mid: 'leftLowerArm',  end: 'leftHand'  },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot' },
  leftFoot:  { root: 'leftUpperLeg',  mid: 'leftLowerLeg',  end: 'leftFoot'  },
};

// 背骨IK（腰固定→頭）: 回転させるボーン（腰側→首側）。VRMに存在するものだけ使う。end=head。
const SPINE_CHAIN_NAMES = ['spine', 'chest', 'upperChest', 'neck'] as const;

// 手グラブ（指の開閉）
const HAND_FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
function handFingerBoneNames(side: 'left' | 'right'): string[] {
  const out: string[] = [];
  for (const f of HAND_FINGERS) {
    const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    for (const s of segs) out.push(`${side}${f}${s}`);
  }
  return out;
}
const FINGER_CURL_AXIS = new THREE.Vector3(0, 0, 1);   // 指を握る回転軸（ボーンのローカル）。逆/横に曲がる場合は軸・符号を変更。
const FINGER_CURL_PER_SEG = 0.9;                        // 1関節の最大曲げ角(ラジアン≈51°)
const THUMB_CURL_PER_SEG  = 0.5;
// 頭の正面（VRM の faceFront 既定 = +Z）
const HEAD_FRONT = new THREE.Vector3(0, 0, 1);

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
  setRootEnabled(enabled: boolean): void;
  setSpineEnabled(enabled: boolean): void;
  setHandGrab(side: 'left' | 'right', value: number): void;
  setLookAtEnabled(enabled: boolean): void;
  onBoneRotated: (boneName: string, quat: THREE.Quaternion) => void;
  onBoneClicked: (boneName: string) => void;
  onIKSolved: (results: IKSolveResult) => void;
  onIKTargetSelected: (target: IKTarget | null) => void;
  onHipsMoved: (pos: THREE.Vector3) => void;
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
  // ルート移動中のIKピン留め用に、ドラッグ開始時点で捕捉した曲げ方向(pole)。
  // 解決のたびに再計算すると、humanoid.update() でほぼ直線に戻った腕から不正な pole が出て肘が飛ぶ。
  const pinnedPoles = new Map<IKTarget, THREE.Vector3 | null>();
  let activeIKTarget: IKTarget | null = null;
  let ikGizmoMode: IKGizmoMode = 'translate';
  // IK の曲げ方向ヒント（掴んだ時点の肘/膝の向き）。逆曲がり防止用にソルバへ渡す。
  let activePole: THREE.Vector3 | null = null;

  // ルート(腰)移動 / 背骨IK / LookAt。専用ハンドル（球）をギズモで操作する。
  let rootHandle: THREE.Mesh | null = null;
  let spineHandle: THREE.Mesh | null = null;
  let lookAtHandle: THREE.Mesh | null = null;
  let rootEnabled = false;
  let spineEnabled = false;
  let lookAtEnabled = false;
  let activeSpecial: 'root' | 'spine' | 'lookAt' | null = null;
  // 指の安静回転（グラブ開閉の基準）
  const restFingerQuats = new Map<string, THREE.Quaternion>();
  const _qCurl = new THREE.Quaternion();
  const _laPos = new THREE.Vector3();
  const _laDir = new THREE.Vector3();
  const _laFwd = new THREE.Vector3();
  const _laQ = new THREE.Quaternion();
  const _laParentQ = new THREE.Quaternion();
  const _laDelta = new THREE.Quaternion();
  const _laDes = new THREE.Quaternion();

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
      const dragging = (event as { value: boolean }).value;
      orbitController.setEnabled(!dragging);
      // ルート移動の開始時に、現在の(posed)姿勢から各IKの曲げ方向を一度だけ捕捉して固定する。
      if (dragging && activeSpecial === 'root') {
        pinnedPoles.clear();
        for (const target of ikHandles.keys()) {
          if (ikEnabled.get(target)) pinnedPoles.set(target, poleFor(target));
        }
      } else if (!dragging) {
        pinnedPoles.clear();
      }
    });

    tc.addEventListener('objectChange', () => {
      if (activeSpecial === 'root') {
        handleRootChange();
      } else if (activeSpecial === 'spine') {
        handleSpineChange();
      } else if (activeSpecial === 'lookAt') {
        handleLookAtChange();
      } else if (activeIKTarget !== null) {
        handleIKObjectChange();
      } else if (selectedBone && selectedBoneName) {
        handle.onBoneRotated(selectedBoneName, selectedBone.quaternion.clone());
      }
    });
  }

  // ルート(腰)移動：ハンドル位置へ正規化hipsを移動し、その正規化ローカル位置をキーフレーム化。
  function handleRootChange(): void {
    if (!vrm || !rootHandle) return;
    const nHips = vrm.humanoid.getNormalizedBoneNode('hips');
    if (!nHips || !nHips.parent) return;
    nHips.parent.updateWorldMatrix(true, false);
    const localPos = nHips.parent.worldToLocal(rootHandle.position.clone());
    nHips.position.copy(localPos);
    vrm.humanoid.update();
    handle.onHipsMoved(nHips.position.clone());

    // IKピン留め：有効な手足IKは末端ハンドルをワールド固定したまま、ルート移動後に関節を再解決。
    vrm.scene.updateWorldMatrix(true, true);
    for (const target of ikHandles.keys()) {
      if (ikEnabled.get(target)) {
        const pole = pinnedPoles.has(target) ? (pinnedPoles.get(target) ?? null) : poleFor(target);
        solveLimbIK(target, pole);
      }
    }
  }

  // 背骨IK：頭ハンドルへ向けて spine→neck をCCDで曲げ、各ボーン回転をキーフレーム化。
  function handleSpineChange(): void {
    if (!vrm || !spineHandle) return;
    const chain: THREE.Bone[] = [];
    const names: string[] = [];
    for (const name of SPINE_CHAIN_NAMES) {
      const b = vrm.humanoid.getRawBoneNode(name as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      if (b) { chain.push(b); names.push(name); }
    }
    const head = vrm.humanoid.getRawBoneNode('head') as THREE.Bone | null;
    if (!head || chain.length === 0) return;
    solveSpineIK(chain, head, spineHandle.position, { iterations: 10, maxStepDeg: 12 });
    for (let i = 0; i < chain.length; i++) handle.onBoneRotated(names[i], chain[i].quaternion.clone());
  }

  // LookAt：頭ボーンをハンドル方向へ向け（顔の向き＝キーフレーム化）、目は vrm.lookAt がプレビュー追従。
  function handleLookAtChange(): void {
    if (!vrm || !lookAtHandle) return;
    const head = vrm.humanoid.getRawBoneNode('head') as THREE.Bone | null;
    if (!head) return;
    head.updateWorldMatrix(true, false);
    head.getWorldPosition(_laPos);
    _laDir.copy(lookAtHandle.position).sub(_laPos);
    if (_laDir.lengthSq() < 1e-8) return;
    _laDir.normalize();
    head.getWorldQuaternion(_laQ);
    _laFwd.copy(HEAD_FRONT).applyQuaternion(_laQ).normalize();
    const ang = _laFwd.angleTo(_laDir);
    if (ang < 1e-4) return;
    let w = 1;
    if (ang > Math.PI * 0.6) w = (Math.PI * 0.6) / ang;   // 後ろは向きすぎない
    _laDelta.setFromUnitVectors(_laFwd, _laDir);
    _laDes.identity().slerp(_laDelta, w).multiply(_laQ);   // 望ましいワールド回転
    if (head.parent) { head.parent.getWorldQuaternion(_laParentQ); head.quaternion.copy(_laParentQ.invert().multiply(_laDes)); }
    else head.quaternion.copy(_laDes);
    handle.onBoneRotated('head', head.quaternion.clone());
  }

  // 手グラブ（開閉）：指ボーンを安静姿勢から value(0開〜1握) 分だけ曲げ、各ボーン回転をキーフレーム化。
  function setHandGrabInternal(side: 'left' | 'right', value: number): void {
    if (!vrm) return;
    const v = Math.max(0, Math.min(1, value));
    for (const name of handFingerBoneNames(side)) {
      const bone = vrm.humanoid.getRawBoneNode(name as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      const rest = restFingerQuats.get(name);
      if (!bone || !rest) continue;
      const per = name.includes('Thumb') ? THUMB_CURL_PER_SEG : FINGER_CURL_PER_SEG;
      _qCurl.setFromAxisAngle(FINGER_CURL_AXIS, -v * per);   // ローカル軸まわりに曲げる（符号は実機で要確認）
      bone.quaternion.copy(rest).multiply(_qCurl);
      handle.onBoneRotated(name, bone.quaternion.clone());
    }
  }

  // root/spine ハンドルをボーン位置へ同期（ドラッグ中の対象は維持）。lookAt は自由配置なので動かさない。
  function syncSpecialHandles(): void {
    if (!vrm) return;
    if (rootHandle) {
      rootHandle.visible = rootEnabled;
      const dragging = activeSpecial === 'root' && !!tc?.dragging;
      if (rootEnabled && !dragging) {
        const hips = vrm.humanoid.getRawBoneNode('hips');
        if (hips) hips.getWorldPosition(rootHandle.position);
      }
    }
    if (spineHandle) {
      spineHandle.visible = spineEnabled;
      const dragging = activeSpecial === 'spine' && !!tc?.dragging;
      if (spineEnabled && !dragging) {
        const head = vrm.humanoid.getRawBoneNode('head');
        if (head) head.getWorldPosition(spineHandle.position);
      }
    }
    if (lookAtHandle) lookAtHandle.visible = lookAtEnabled;   // LookAt は自由配置（位置は維持）
  }

  // ルート/背骨/LookAt ハンドルを選択してギズモをアタッチ
  function selectSpecial(kind: 'root' | 'spine' | 'lookAt'): void {
    if (!vrm || !tc) return;
    activeSpecial = kind;
    activeIKTarget = null;
    selectedBone = null;
    selectedBoneName = null;
    animEditorStore.setSelectedBone(null);
    handle.onIKTargetSelected(null);
    syncSpecialHandles();
    const h = kind === 'root' ? rootHandle : kind === 'spine' ? spineHandle : lookAtHandle;
    if (!h) return;
    tc.setMode('translate');
    tc.setSpace('world');
    tc.attach(h);
  }

  // 2ボーンIKをハンドル位置へ解決し、root/mid 回転をキーフレーム化（onIKSolved）。
  function solveLimbIK(target: IKTarget, pole: THREE.Vector3 | null): void {
    if (!vrm) return;
    const chainDef = IK_CHAINS[target];
    const handleMesh = ikHandles.get(target);
    if (!handleMesh) return;
    const rootBone = vrm.humanoid.getRawBoneNode(chainDef.root as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const midBone  = vrm.humanoid.getRawBoneNode(chainDef.mid  as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const endBone  = vrm.humanoid.getRawBoneNode(chainDef.end  as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    if (!rootBone || !midBone || !endBone) return;
    const chain: TwoBoneIKChain = { root: rootBone, mid: midBone, end: endBone, poleVector: pole ?? undefined };
    const result = solveTwoBoneIK(chain, handleMesh.position);
    rootBone.quaternion.copy(result.rootQuat);
    midBone.quaternion.copy(result.midQuat);
    handle.onIKSolved({
      [target]: {
        root: chainDef.root, rootQ: result.rootQuat.clone(),
        mid:  chainDef.mid,  midQ:  result.midQuat.clone(),
      },
    });
  }

  // 現在のボーン位置から肘/膝の出ている向き（pole）を算出して返す。
  function poleFor(target: IKTarget): THREE.Vector3 | null {
    if (!vrm) return null;
    const def = IK_CHAINS[target];
    const rb = vrm.humanoid.getRawBoneNode(def.root as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const mb = vrm.humanoid.getRawBoneNode(def.mid as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    const eb = vrm.humanoid.getRawBoneNode(def.end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
    if (!rb || !mb || !eb) return null;
    const rW = rb.getWorldPosition(new THREE.Vector3());
    const mW = mb.getWorldPosition(new THREE.Vector3());
    const eW = eb.getWorldPosition(new THREE.Vector3());
    const dir = eW.clone().sub(rW);
    if (dir.lengthSq() < 1e-8) return null;
    dir.normalize();
    const pole = mW.clone().sub(rW);
    pole.addScaledVector(dir, -pole.dot(dir));
    return pole.lengthSq() > 1e-8 ? pole.normalize() : null;
  }

  function handleIKObjectChange(): void {
    if (!vrm || !activeIKTarget) return;
    if (ikGizmoMode === 'translate') {
      solveLimbIK(activeIKTarget, activePole);
    } else {
      // rotate: エンドボーン回転をキーフレームに記録
      const endBone = vrm.humanoid.getRawBoneNode(IK_CHAINS[activeIKTarget].end as Parameters<typeof vrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
      if (endBone) handle.onBoneRotated(IK_CHAINS[activeIKTarget].end, endBone.quaternion.clone());
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

  // ルート/背骨ハンドル（色違いの球）を生成
  function createSimpleHandle(color: number, radius: number): THREE.Mesh {
    const geo = new THREE.SphereGeometry(radius, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
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
      // ルート移動中はIK末端ハンドルをワールド固定（ピン留め）。末端へ追従させない。
      if (activeSpecial === 'root' && tc?.dragging) { mesh.visible = true; continue; }
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
    activePole = poleFor(target);
  }

  // IK ターゲットを選択してギズモをアタッチ
  function selectIKTarget(target: IKTarget): void {
    if (!vrm || !tc) return;
    activeIKTarget = target;
    activeSpecial = null;
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
    activeSpecial = null;
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

    // ルート/背骨/LookAt ハンドルのクリック判定（優先）
    if (rootHandle && rootHandle.visible && raycaster.intersectObject(rootHandle).length > 0) {
      selectSpecial('root');
      return;
    }
    if (spineHandle && spineHandle.visible && raycaster.intersectObject(spineHandle).length > 0) {
      selectSpecial('spine');
      return;
    }
    if (lookAtHandle && lookAtHandle.visible && raycaster.intersectObject(lookAtHandle).length > 0) {
      selectSpecial('lookAt');
      return;
    }

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
        // 最も近い「ヒューマノイドボーン」を選ぶ。名前は three.js のノード名ではなく
        // VRM HumanBoneName を使う（getRawBoneNode が解決でき、seekToFrame でキーフレームが再適用される）。
        // ノード名のままだと getRawBoneNode が null を返し、vrm.update() の normalized→raw 上書きで
        // ギズモ編集が即座に消える＝ポーズが動かせない不具合になる。
        const bp = new THREE.Vector3();
        let nearestBone: THREE.Bone | null = null;
        let nearestBoneName: string | null = null;
        let minDist = Infinity;
        for (const name of Object.keys(vrm.humanoid.humanBones)) {
          const node = vrm.humanoid.getRawBoneNode(
            name as Parameters<typeof vrm.humanoid.getRawBoneNode>[0],
          ) as THREE.Bone | null;
          if (!node) continue;
          node.getWorldPosition(bp);
          const dist = bp.distanceTo(point);
          if (dist < minDist) {
            minDist = dist;
            nearestBone = node;
            nearestBoneName = name;
          }
        }
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
  rootHandle  = createSimpleHandle(0xffaa00, 0.075);   // 橙＝ルート(腰)
  spineHandle = createSimpleHandle(0xffee44, 0.07);    // 黄＝背骨IK(頭)
  lookAtHandle = createSimpleHandle(0xff66cc, 0.05);   // 桃＝LookAt(視線/顔)

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

      // 指の安静回転を捕捉（グラブ開閉の基準。VRM読込直後 = bind/rest）
      restFingerQuats.clear();
      for (const side of ['left', 'right'] as const) {
        for (const name of handFingerBoneNames(side)) {
          const b = newVrm.humanoid.getRawBoneNode(name as Parameters<typeof newVrm.humanoid.getRawBoneNode>[0]) as THREE.Bone | null;
          if (b) restFingerQuats.set(name, b.quaternion.clone());
        }
      }

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
      syncSpecialHandles();
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

    setRootEnabled(enabled: boolean): void {
      rootEnabled = enabled;
      if (enabled) {
        spineEnabled = false;          // ルートと背骨は排他（ギズモは1つ）
        selectSpecial('root');
      } else if (activeSpecial === 'root') {
        activeSpecial = null;
        tc?.detach();
      }
      syncSpecialHandles();
    },

    setSpineEnabled(enabled: boolean): void {
      spineEnabled = enabled;
      if (enabled) {
        rootEnabled = false;
        selectSpecial('spine');
      } else if (activeSpecial === 'spine') {
        activeSpecial = null;
        tc?.detach();
      }
      syncSpecialHandles();
    },

    setHandGrab(side: 'left' | 'right', value: number): void {
      setHandGrabInternal(side, value);
    },

    setLookAtEnabled(enabled: boolean): void {
      lookAtEnabled = enabled;
      if (!vrm) return;
      if (enabled) {
        rootEnabled = false;
        spineEnabled = false;
        // ハンドルを顔の正面 約0.5m 先に配置
        const head = vrm.humanoid.getRawBoneNode('head') as THREE.Bone | null;
        if (head && lookAtHandle) {
          head.updateWorldMatrix(true, false);
          head.getWorldPosition(_laPos);
          head.getWorldQuaternion(_laQ);
          _laFwd.copy(HEAD_FRONT).applyQuaternion(_laQ).normalize();
          lookAtHandle.position.copy(_laPos).addScaledVector(_laFwd, 0.5);
        }
        if (vrm.lookAt && lookAtHandle) vrm.lookAt.target = lookAtHandle;   // 目はプレビューで追従
        selectSpecial('lookAt');
      } else {
        if (vrm.lookAt) vrm.lookAt.target = null;
        if (activeSpecial === 'lookAt') { activeSpecial = null; tc?.detach(); }
      }
      syncSpecialHandles();
    },

    onBoneRotated: (_boneName: string, _quat: THREE.Quaternion) => {},
    onBoneClicked: (_boneName: string) => {},
    onIKSolved: (_results: IKSolveResult) => {},
    onIKTargetSelected: (_target: IKTarget | null) => {},
    onHipsMoved: (_pos: THREE.Vector3) => {},

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
      for (const mesh of [...ikHandles.values(), rootHandle, spineHandle, lookAtHandle]) {
        if (!mesh) continue;
        scene.remove(mesh);
        (mesh.geometry as THREE.SphereGeometry).dispose();
        (mesh.material as THREE.MeshBasicMaterial).dispose();
      }
      ikHandles.clear();
      rootHandle = null;
      spineHandle = null;
      lookAtHandle = null;
    },
  };

  return handle;
}
