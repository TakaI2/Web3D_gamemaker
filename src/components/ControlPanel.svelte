<script lang="ts">
  import AnimationList from './AnimationList.svelte';
  import AnimationControls from './AnimationControls.svelte';
  import SpringBonePanel from './SpringBonePanel.svelte';
  import LipSyncPanel from './LipSyncPanel.svelte';
  import XRControls from './XRControls.svelte';
  import ModelLoader from './ModelLoader.svelte';
  import type { VRMLoader } from '../core/VRMLoader';
  import type { AnimationManager } from '../core/AnimationManager';
  import type { SpringBoneController } from '../core/SpringBoneController';
  import type { LipSyncEngine } from '../lipsync/LipSyncEngine';
  import type { XRSessionManager } from '../xr/XRSessionManager';

  export let vrmLoader: VRMLoader | null = null;
  export let animationManager: AnimationManager | null = null;
  export let springBoneController: SpringBoneController | null = null;
  export let lipSyncEngine: LipSyncEngine | null = null;
  export let xrSessionManager: XRSessionManager | null = null;

  type Tab = 'anim' | 'spring' | 'lipsync' | 'xr';
  let activeTab: Tab = 'anim';
</script>

<aside class="panel">
  <!-- ヘッダー -->
  <div class="header">
    <span class="title">VRM Editor</span>
    <ModelLoader {vrmLoader} {animationManager} />
  </div>

  <!-- タブ -->
  <div class="tabs">
    <button class:active={activeTab === 'anim'}    on:click={() => (activeTab = 'anim')}>アニメ</button>
    <button class:active={activeTab === 'spring'}  on:click={() => (activeTab = 'spring')}>揺れ</button>
    <button class:active={activeTab === 'lipsync'} on:click={() => (activeTab = 'lipsync')}>口パク</button>
    <button class:active={activeTab === 'xr'}      on:click={() => (activeTab = 'xr')}>XR</button>
  </div>

  <!-- タブコンテンツ -->
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
    {/if}
  </div>
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
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid #333;
  }
  .title { font-size: 14px; font-weight: bold; color: #eee; }
  .tabs {
    display: flex;
    border-bottom: 1px solid #333;
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
