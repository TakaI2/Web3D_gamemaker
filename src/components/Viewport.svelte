<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SceneManager } from '../core/SceneManager';
  import { RenderLoop } from '../core/RenderLoop';
  import { VRMLoader } from '../core/VRMLoader';
  import { AnimationManager } from '../core/AnimationManager';
  import { SpringBoneController } from '../core/SpringBoneController';
  import { OrbitController } from '../core/OrbitController';
  import { LipSyncEngine } from '../lipsync/LipSyncEngine';
  import { XRSessionManager } from '../xr/XRSessionManager';
  import { vrmStore } from '../stores/vrmStore';

  export let onReady: (ctx: {
    vrmLoader: VRMLoader;
    animationManager: AnimationManager;
    springBoneController: SpringBoneController;
    lipSyncEngine: LipSyncEngine;
    xrSessionManager: XRSessionManager;
    orbitController: OrbitController;
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

  onMount(() => {
    sceneManager = new SceneManager(canvas);
    orbitController = new OrbitController(sceneManager);
    vrmLoader = new VRMLoader(sceneManager);
    animationManager = new AnimationManager();
    springBoneController = new SpringBoneController();
    lipSyncEngine = new LipSyncEngine();
    renderLoop = new RenderLoop(sceneManager);
    xrSessionManager = new XRSessionManager(sceneManager, orbitController);

    // 更新順序: mixer → vrm → springBone → lipSync → orbitControls
    renderLoop.addCallback((delta) => {
      animationManager.update(delta);
      const vrm = vrmLoader.current;
      if (vrm) vrm.update(delta);
      springBoneController.update(delta);
      lipSyncEngine.update(delta);
      orbitController.update();
    });

    // VRM 読み込み時に各マネージャーに通知
    const unsub = vrmStore.subscribe((state) => {
      if (state.vrm) {
        animationManager.setVRM(state.vrm);
        springBoneController.setVRM(state.vrm);
        lipSyncEngine.setVRM(state.vrm);
        orbitController.fitToObject(state.vrm.scene);
      }
    });

    // WebXR サポート確認
    xrSessionManager.checkSupport();

    renderLoop.start();

    // リサイズ対応
    const resizeObserver = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas;
      sceneManager.resize(clientWidth, clientHeight);
    });
    resizeObserver.observe(canvas);

    onReady({ vrmLoader, animationManager, springBoneController, lipSyncEngine, xrSessionManager, orbitController });

    return () => {
      resizeObserver.disconnect();
      unsub();
    };
  });

  onDestroy(() => {
    renderLoop?.stop();
    vrmLoader?.unload();
    orbitController?.dispose();
    sceneManager?.dispose();
  });
</script>

<canvas bind:this={canvas} style="width:100%;height:100%;display:block;" />
