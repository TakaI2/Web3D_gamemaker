<script lang="ts">
  import type { SpringBoneController } from '../core/SpringBoneController';
  import { vrmStore } from '../stores/vrmStore';

  export let springBoneController: SpringBoneController | null = null;

  let enabled = true;
  let stiffness = 1.0;
  let damping = 0.4;

  $: hasSpringBone = springBoneController?.hasSpringBone ?? false;

  function onEnabled(e: Event) {
    enabled = (e.target as HTMLInputElement).checked;
    springBoneController?.setEnabled(enabled);
  }

  function onStiffness(e: Event) {
    stiffness = parseFloat((e.target as HTMLInputElement).value);
    springBoneController?.setStiffness(stiffness);
  }

  function onDamping(e: Event) {
    damping = parseFloat((e.target as HTMLInputElement).value);
    springBoneController?.setDamping(damping);
  }

  function onReset() {
    springBoneController?.reset();
    stiffness = 1.0;
    damping = 0.4;
  }
</script>

<div class="panel" class:disabled={!$vrmStore.vrm || !hasSpringBone}>
  {#if !$vrmStore.vrm}
    <p class="note">VRM を読み込むと有効になります</p>
  {:else if !hasSpringBone}
    <p class="note">このモデルに Spring Bone はありません</p>
  {:else}
    <label class="row">
      <input type="checkbox" checked={enabled} on:change={onEnabled} />
      Spring Bone 有効
    </label>
    <label class="row" class:disabled={!enabled}>
      剛性 <span class="val">{stiffness.toFixed(2)}</span>
      <input type="range" min="0" max="4" step="0.01" value={stiffness}
        on:input={onStiffness} disabled={!enabled} />
    </label>
    <label class="row" class:disabled={!enabled}>
      減衰 <span class="val">{damping.toFixed(2)}</span>
      <input type="range" min="0" max="1" step="0.01" value={damping}
        on:input={onDamping} disabled={!enabled} />
    </label>
    <button class="reset-btn" on:click={onReset}>リセット</button>
  {/if}
</div>

<style>
  .panel { display: flex; flex-direction: column; gap: 8px; }
  .note { font-size: 12px; color: #666; }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #ccc;
    cursor: pointer;
  }
  .row input[type="range"] { flex: 1; }
  .row.disabled { opacity: 0.4; pointer-events: none; }
  .val { color: #4af; min-width: 36px; text-align: right; font-size: 11px; }
  .reset-btn {
    align-self: flex-start;
    padding: 4px 10px;
    background: #444;
    color: #ccc;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  .reset-btn:hover { background: #555; }
</style>
