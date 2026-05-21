<script lang="ts">
  import AnimationList from './AnimationList.svelte';
  import AnimationControls from './AnimationControls.svelte';
  import SpringBonePanel from './SpringBonePanel.svelte';
  import LipSyncPanel from './LipSyncPanel.svelte';
  import XRControls from './XRControls.svelte';
  import ModelLoader from './ModelLoader.svelte';
  import MMDFileLoader from './MMDFileLoader.svelte';
  import VMDList from './VMDList.svelte';
  import VMDControls from './VMDControls.svelte';
  import SkeletonPanel from './SkeletonPanel.svelte';
  import BoneMappingPanel from './BoneMappingPanel.svelte';
  import FbxConverterPanel from './FbxConverterPanel.svelte';
  import FbxFileLoader from './FbxFileLoader.svelte';
  import FbxAnimList from './FbxAnimList.svelte';
  import FbxAnimControls from './FbxAnimControls.svelte';
  import { mmdStore } from '../stores/mmdStore';
  import { fbxStore } from '../stores/fbxStore';
  import type { VRMLoader } from '../core/VRMLoader';
  import type { AnimationManager } from '../core/AnimationManager';
  import type { SpringBoneController } from '../core/SpringBoneController';
  import type { LipSyncEngine } from '../lipsync/LipSyncEngine';
  import type { XRSessionManager } from '../xr/XRSessionManager';
  import type { MMDModelLoader } from '../core/MMDModelLoader';
  import type { VMDManager } from '../core/VMDManager';
  import type { SkeletonController } from '../core/SkeletonController';
  import type { FbxModelLoader } from '../core/FbxModelLoader';
  import type { OrbitController } from '../core/OrbitController';

  export let vrmLoader: VRMLoader | null = null;
  export let animationManager: AnimationManager | null = null;
  export let springBoneController: SpringBoneController | null = null;
  export let lipSyncEngine: LipSyncEngine | null = null;
  export let xrSessionManager: XRSessionManager | null = null;
  export let mmdModelLoader: MMDModelLoader | null = null;
  export let vmdManager: VMDManager | null = null;
  export let skeletonController: SkeletonController | null = null;
  export let fbxModelLoader: FbxModelLoader | null = null;
  export let orbitController: OrbitController | null = null;

  type EditorMode = 'vrm' | 'mmd' | 'fbx';
  type Tab = 'anim' | 'spring' | 'lipsync' | 'xr' | 'bone';
  let editorMode: EditorMode = 'vrm';
  let activeTab: Tab = 'anim';

  const SCALE_STEP = 5;
  let mmdScale = 1;
  let fbxScale = 1;

  function scaleMMD(multiply: boolean): void {
    const mesh = $mmdStore.mesh;
    if (!mesh) return;
    const factor = multiply ? SCALE_STEP : 1 / SCALE_STEP;
    mesh.scale.multiplyScalar(factor);
    mmdScale = Math.round(mesh.scale.x * 10000) / 10000;
    orbitController?.refitToLast();
  }

  function scaleFBX(multiply: boolean): void {
    const root = $fbxStore.root;
    if (!root) return;
    const factor = multiply ? SCALE_STEP : 1 / SCALE_STEP;
    root.scale.multiplyScalar(factor);
    fbxScale = Math.round(root.scale.x * 10000) / 10000;
    orbitController?.refitToLast();
  }

  // モデルが切り替わったらスケールをリセット
  $: if ($mmdStore.mesh) mmdScale = 1;
  $: if ($fbxStore.root) fbxScale = 1;
</script>

<aside class="panel">
  <!-- エディタモード切替 -->
  <div class="mode-selector">
    <button class:active={editorMode === 'vrm'} on:click={() => (editorMode = 'vrm')}>VRM</button>
    <button class:active={editorMode === 'mmd'} on:click={() => (editorMode = 'mmd')}>MMD</button>
    <button class:active={editorMode === 'fbx'} on:click={() => (editorMode = 'fbx')}>FBX</button>
  </div>

  {#if editorMode === 'vrm'}
    <!-- VRM ヘッダー -->
    <div class="header">
      <span class="title">VRM Editor</span>
      <ModelLoader {vrmLoader} {animationManager} />
    </div>

    <!-- VRM タブ -->
    <div class="tabs">
      <button class:active={activeTab === 'anim'}    on:click={() => (activeTab = 'anim')}>アニメ</button>
      <button class:active={activeTab === 'spring'}  on:click={() => (activeTab = 'spring')}>揺れ</button>
      <button class:active={activeTab === 'lipsync'} on:click={() => (activeTab = 'lipsync')}>口パク</button>
      <button class:active={activeTab === 'xr'}      on:click={() => (activeTab = 'xr')}>XR</button>
      <button class:active={activeTab === 'bone'}    on:click={() => (activeTab = 'bone')}>ボーン</button>
    </div>

    <!-- VRM タブコンテンツ -->
    <div class="content">
      {#if activeTab === 'anim'}
        <AnimationList {animationManager} />
        <hr />
        <AnimationControls {animationManager} />
      {:else if activeTab === 'spring'}
        <SpringBonePanel {springBoneController} />
      {:else if activeTab === 'lipsync'}
        <LipSyncPanel {lipSyncEngine} />
      {:else if activeTab === 'xr'}
        <XRControls {xrSessionManager} />
      {:else if activeTab === 'bone'}
        <SkeletonPanel {skeletonController} />
        <hr />
        <BoneMappingPanel {skeletonController} />
        <hr />
        <FbxConverterPanel />
      {/if}
    </div>
  {:else if editorMode === 'mmd'}
    <!-- MMD ヘッダー -->
    <div class="header">
      <span class="title mmd-title">MMD Editor</span>
      <div class="loader-btns">
        <MMDFileLoader {mmdModelLoader} {vmdManager} />
      </div>
    </div>
    <!-- MMD コンテンツ -->
    <div class="content">
      {#if $mmdStore.error}
        <p class="mmd-error">{$mmdStore.error.message}</p>
      {/if}
      {#if $mmdStore.mesh}
        <p class="mmd-ok">✓ モデル読み込み済み</p>
        <div class="scale-row">
          <span class="scale-label">スケール</span>
          <button class="scale-btn" on:click={() => scaleMMD(false)} title="÷5">－</button>
          <span class="scale-val">×{mmdScale}</span>
          <button class="scale-btn" on:click={() => scaleMMD(true)} title="×5">＋</button>
        </div>
      {/if}
      <span class="section-label">モーション</span>
      <VMDList {vmdManager} />
      <hr />
      <VMDControls {vmdManager} />
      <hr />
      <span class="section-label">ボーン</span>
      <SkeletonPanel {skeletonController} />
    </div>
  {:else}
    <!-- FBX ヘッダー -->
    <div class="header">
      <span class="title fbx-title">FBX Editor</span>
    </div>
    <!-- FBX コンテンツ -->
    <div class="content">
      <FbxFileLoader {fbxModelLoader} />
      {#if $fbxStore.root}
        <div class="scale-row">
          <span class="scale-label">スケール</span>
          <button class="scale-btn" on:click={() => scaleFBX(false)} title="÷5">－</button>
          <span class="scale-val">×{fbxScale}</span>
          <button class="scale-btn" on:click={() => scaleFBX(true)} title="×5">＋</button>
        </div>
      {/if}
      <hr />
      <span class="section-label">アニメーション</span>
      <FbxAnimList {fbxModelLoader} />
      <hr />
      <FbxAnimControls {fbxModelLoader} />
      <hr />
      <span class="section-label">ボーン</span>
      <SkeletonPanel {skeletonController} />
    </div>
  {/if}
</aside>

<style>
  .panel {
    position: fixed;
    top: 0; right: 0;
    width: 240px;
    height: 100%;
    background: #1c1c1c;
    border-left: 1px solid #333;
    display: flex;
    flex-direction: column;
    z-index: 10;
    overflow: hidden;
  }
  .mode-selector {
    display: flex;
    border-bottom: 2px solid #333;
    flex-shrink: 0;
  }
  .mode-selector button {
    flex: 1;
    padding: 8px 0;
    background: none;
    border: none;
    color: #666;
    font-size: 12px;
    font-weight: bold;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: color 0.15s, border-color 0.15s;
  }
  .mode-selector button.active { color: #eee; border-bottom-color: #eee; }
  .mode-selector button:hover:not(.active) { color: #aaa; }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  .title { font-size: 14px; font-weight: bold; color: #eee; }
  .tabs {
    display: flex;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  .tabs button {
    flex: 1;
    padding: 8px 0;
    background: none;
    border: none;
    color: #888;
    font-size: 11px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }
  .tabs button.active { color: #4af; border-bottom-color: #4af; }
  .tabs button:hover:not(.active) { color: #ccc; }
  .mmd-title { color: #fa4; }
  .fbx-title { color: #4a8; }
  .loader-btns { display: flex; gap: 4px; }
  .mmd-error { font-size: 11px; color: #f88; margin: 2px 0; }
  .mmd-ok { font-size: 11px; color: #4c4; margin: 2px 0; }
  .scale-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .scale-label {
    font-size: 11px;
    color: #888;
    flex: 1;
  }
  .scale-btn {
    width: 28px;
    height: 28px;
    background: #333;
    border: 1px solid #555;
    border-radius: 4px;
    color: #eee;
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .scale-btn:hover { background: #444; }
  .scale-val {
    font-size: 12px;
    color: #ccc;
    font-family: monospace;
    min-width: 52px;
    text-align: center;
  }
  .section-label {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .content {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  hr { border: none; border-top: 1px solid #333; margin: 4px 0; }
</style>
