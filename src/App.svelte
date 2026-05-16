<script lang="ts">
  import Viewport from './components/Viewport.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import type { VRMLoader } from './core/VRMLoader';
  import type { AnimationManager } from './core/AnimationManager';
  import type { SpringBoneController } from './core/SpringBoneController';
  import type { LipSyncEngine } from './lipsync/LipSyncEngine';
  import type { XRSessionManager } from './xr/XRSessionManager';

  let vrmLoader: VRMLoader | null = null;
  let animationManager: AnimationManager | null = null;
  let springBoneController: SpringBoneController | null = null;
  let lipSyncEngine: LipSyncEngine | null = null;
  let xrSessionManager: XRSessionManager | null = null;

  function onViewportReady(ctx: {
    vrmLoader: VRMLoader;
    animationManager: AnimationManager;
    springBoneController: SpringBoneController;
    lipSyncEngine: LipSyncEngine;
    xrSessionManager: XRSessionManager;
  }) {
    vrmLoader = ctx.vrmLoader;
    animationManager = ctx.animationManager;
    springBoneController = ctx.springBoneController;
    lipSyncEngine = ctx.lipSyncEngine;
    xrSessionManager = ctx.xrSessionManager;
  }
</script>

<div class="app">
  <Viewport onReady={onViewportReady} />
  <ControlPanel
    {vrmLoader}
    {animationManager}
    {springBoneController}
    {lipSyncEngine}
    {xrSessionManager}
  />
</div>

<style>
  .app {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }
</style>
