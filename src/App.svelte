<script lang="ts">
  import Viewport from './components/Viewport.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import ModeToggle from './components/ModeToggle.svelte';
  import GameViewport from './components/GameViewport.svelte';
  import GameHUD from './components/GameHUD.svelte';
  import RetargetViewport from './components/RetargetViewport.svelte';
  import ZoomControls from './components/ZoomControls.svelte';
  import AnimEditor from './components/AnimEditor.svelte';
  import FpsViewport from './components/FpsViewport.svelte';
  import { appModeStore } from './stores/appModeStore';
  import type { VRMLoader } from './core/VRMLoader';
  import type { AnimationManager } from './core/AnimationManager';
  import type { SpringBoneController } from './core/SpringBoneController';
  import type { LipSyncEngine } from './lipsync/LipSyncEngine';
  import type { XRSessionManager } from './xr/XRSessionManager';
  import type { MMDModelLoader } from './core/MMDModelLoader';
  import type { VMDManager } from './core/VMDManager';
  import type { OrbitController } from './core/OrbitController';
  import type { SkeletonController } from './core/SkeletonController';
  import type { FbxModelLoader } from './core/FbxModelLoader';

  let vrmLoader: VRMLoader | null = null;
  let animationManager: AnimationManager | null = null;
  let springBoneController: SpringBoneController | null = null;
  let lipSyncEngine: LipSyncEngine | null = null;
  let xrSessionManager: XRSessionManager | null = null;
  let mmdModelLoader: MMDModelLoader | null = null;
  let vmdManager: VMDManager | null = null;
  let orbitController: OrbitController | null = null;
  let skeletonController: SkeletonController | null = null;
  let fbxModelLoader: FbxModelLoader | null = null;

  function onViewportReady(ctx: {
    vrmLoader: VRMLoader;
    animationManager: AnimationManager;
    springBoneController: SpringBoneController;
    lipSyncEngine: LipSyncEngine;
    xrSessionManager: XRSessionManager;
    mmdModelLoader: MMDModelLoader;
    vmdManager: VMDManager;
    orbitController: OrbitController;
    skeletonController: SkeletonController;
    fbxModelLoader: FbxModelLoader;
  }) {
    vrmLoader = ctx.vrmLoader;
    animationManager = ctx.animationManager;
    springBoneController = ctx.springBoneController;
    lipSyncEngine = ctx.lipSyncEngine;
    xrSessionManager = ctx.xrSessionManager;
    mmdModelLoader = ctx.mmdModelLoader;
    vmdManager = ctx.vmdManager;
    orbitController = ctx.orbitController;
    skeletonController = ctx.skeletonController;
    fbxModelLoader = ctx.fbxModelLoader;
  }
</script>

<div class="app">
  {#if $appModeStore === 'editor'}
    <Viewport onReady={onViewportReady} />
    <ControlPanel
      {vrmLoader}
      {animationManager}
      {springBoneController}
      {lipSyncEngine}
      {xrSessionManager}
      {mmdModelLoader}
      {vmdManager}
      {skeletonController}
      {fbxModelLoader}
      {orbitController}
    />
    <ModeToggle />
    <ZoomControls {orbitController} />
  {:else if $appModeStore === 'game'}
    <GameViewport {vrmLoader} />
    <GameHUD />
  {:else if $appModeStore === 'anim-editor'}
    <AnimEditor />
  {:else if $appModeStore === 'fps'}
    <FpsViewport />
  {:else}
    <RetargetViewport />
  {/if}
</div>

<style>
  .app {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }
</style>
