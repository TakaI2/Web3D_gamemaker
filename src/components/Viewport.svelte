<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { SceneManager } from '../core/SceneManager';
  import { RenderLoop } from '../core/RenderLoop';
  import { VRMLoader } from '../core/VRMLoader';
  import { AnimationManager } from '../core/AnimationManager';
  import { SpringBoneController } from '../core/SpringBoneController';
  import { OrbitController } from '../core/OrbitController';
  import { LipSyncEngine } from '../lipsync/LipSyncEngine';
  import { XRSessionManager } from '../xr/XRSessionManager';
  import { MMDModelLoader } from '../core/MMDModelLoader';
  import { VMDManager } from '../core/VMDManager';
  import { SkeletonController } from '../core/SkeletonController';
  import { FbxModelLoader } from '../core/FbxModelLoader';
  import { vrmStore } from '../stores/vrmStore';
  import { mmdStore } from '../stores/mmdStore';
  import { fbxStore } from '../stores/fbxStore';
  import { appModeStore } from '../stores/appModeStore';
  import { boneMappingStore } from '../stores/boneMappingStore';
  import { attachShiftDragScale } from '../utils/shiftDragScale';

  export let onReady: (ctx: {
    vrmLoader: VRMLoader;
    animationManager: AnimationManager;
    springBoneController: SpringBoneController;
    lipSyncEngine: LipSyncEngine;
    xrSessionManager: XRSessionManager;
    orbitController: OrbitController;
    mmdModelLoader: MMDModelLoader;
    vmdManager: VMDManager;
    skeletonController: SkeletonController;
    fbxModelLoader: FbxModelLoader;
  }) => void = () => {};

  let canvas: HTMLCanvasElement;
  let sceneManager: SceneManager;
  let renderLoop: RenderLoop;
  let vrmLoader: VRMLoader;
  let animationManager: AnimationManager;
  let springBoneController: SpringBoneController;
  let orbitController: OrbitController;
  let lipSyncEngine: LipSyncEngine;
  let xrSessionManager: XRSessionManager;
  let mmdModelLoader: MMDModelLoader;
  let vmdManager: VMDManager;
  let skeletonController: SkeletonController;
  let fbxModelLoader: FbxModelLoader;

  onMount(() => {
    sceneManager = new SceneManager(canvas);
    orbitController = new OrbitController(sceneManager);
    vrmLoader = new VRMLoader(sceneManager);
    animationManager = new AnimationManager();
    springBoneController = new SpringBoneController();
    lipSyncEngine = new LipSyncEngine();
    renderLoop = new RenderLoop(sceneManager);
    xrSessionManager = new XRSessionManager(sceneManager, orbitController);
    mmdModelLoader = new MMDModelLoader(sceneManager);
    vmdManager = new VMDManager();
    skeletonController = new SkeletonController(sceneManager.scene);
    fbxModelLoader = new FbxModelLoader(sceneManager);

    // 更新順序: mixer → vrm → springBone → lipSync → vmd → fbx → orbitControls
    renderLoop.addCallback((delta) => {
      animationManager.update(delta);
      const vrm = vrmLoader.current;
      if (vrm) vrm.update(delta);
      springBoneController.update(delta);
      lipSyncEngine.update(delta);
      vmdManager.update(delta);
      fbxModelLoader.update(delta);
      skeletonController?.update();
      orbitController.update();
    });

    // VRM 読み込み時に各マネージャーに通知
    // ゲームモードからの復帰時も含め、シーンに VRM が存在しなければ追加する
    const unsubVrm = vrmStore.subscribe((state) => {
      if (state.vrm) {
        if (!sceneManager.scene.children.includes(state.vrm.scene)) {
          sceneManager.scene.add(state.vrm.scene);
        }
        animationManager.setVRM(state.vrm);
        springBoneController.setVRM(state.vrm);
        lipSyncEngine.setVRM(state.vrm);
        orbitController.fitToObject(state.vrm.scene);
        skeletonController.setTarget(state.vrm.scene);
        boneMappingStore.load(state.vrm);
      } else {
        skeletonController?.setTarget(null);
        boneMappingStore.clear();
      }
    });

    // MMD 読み込み時に VMDManager へ通知
    const unsubMmd = mmdStore.subscribe((state) => {
      if (state.mesh) {
        vmdManager.setMesh(state.mesh);
        orbitController.fitToObject(state.mesh);
        skeletonController.setTarget(state.mesh);
      } else {
        skeletonController?.setTarget(null);
      }
    });

    // FBX 読み込み時にスケルトン・カメラを更新
    const unsubFbx = fbxStore.subscribe((state) => {
      if (state.root) {
        orbitController.fitToObject(state.root);
        skeletonController.setTarget(state.root);
      } else {
        skeletonController?.setTarget(null);
      }
    });

    // Shift+ドラッグ スケール
    const cleanupShiftDrag = attachShiftDragScale(
      canvas,
      () => get(mmdStore).mesh ?? get(fbxStore).root ?? get(vrmStore).vrm?.scene ?? null,
      () => orbitController.refitToLast(),
      (enabled) => orbitController.setEnabled(enabled),
    );

    // WebXR サポート確認
    xrSessionManager.checkSupport();

    renderLoop.start();

    // リサイズ対応
    const resizeObserver = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas;
      sceneManager.resize(clientWidth, clientHeight);
    });
    resizeObserver.observe(canvas);

    onReady({
      vrmLoader, animationManager, springBoneController, lipSyncEngine,
      xrSessionManager, orbitController, mmdModelLoader, vmdManager, skeletonController,
      fbxModelLoader,
    });

    return () => {
      resizeObserver.disconnect();
      unsubVrm();
      unsubMmd();
      unsubFbx();
      cleanupShiftDrag();
    };
  });

  onDestroy(() => {
    renderLoop?.stop();
    // ゲームモードへの切替時は VRM を破棄せずシーンから外すだけにする
    if (get(appModeStore) === 'game') {
      if (vrmLoader && sceneManager) vrmLoader.detach(sceneManager.scene);
    } else {
      vrmLoader?.unload();
    }
    mmdModelLoader?.unload();
    fbxModelLoader?.unload();
    skeletonController?.dispose();
    orbitController?.dispose();
    sceneManager?.dispose();
  });
</script>

<canvas bind:this={canvas} style="width:100%;height:100%;display:block;" />
