<script lang="ts">
  import { boneMappingStore, type BoneMappingEntry } from '../stores/boneMappingStore';
  import { skeletonStore } from '../stores/skeletonStore';
  import type { SkeletonController } from '../core/SkeletonController';

  export let skeletonController: SkeletonController | null = null;

  let showFingers = false;

  $: groups = buildGroups($boneMappingStore.entries, showFingers);

  function buildGroups(
    entries: BoneMappingEntry[],
    fingers: boolean,
  ): Array<[string, BoneMappingEntry[]]> {
    const filtered = fingers ? entries : entries.filter((e) => !e.group.endsWith('指'));
    const map = new Map<string, BoneMappingEntry[]>();
    for (const e of filtered) {
      if (!map.has(e.group)) map.set(e.group, []);
      map.get(e.group)!.push(e);
    }
    return [...map.entries()];
  }

  function handleClick(e: BoneMappingEntry) {
    if (e.boneIndex === null) return;
    const next = $skeletonStore.selectedBoneIndex === e.boneIndex ? null : e.boneIndex;
    skeletonController?.selectBone(next);
  }
</script>

{#if $boneMappingStore.entries.length === 0}
  <p class="empty">VRM モデルを読み込むとマッピングが表示されます</p>
{:else}
  <div class="header-row">
    <span class="section-title">ヒューマノイド マッピング</span>
    <button
      class="finger-toggle"
      class:on={showFingers}
      on:click={() => (showFingers = !showFingers)}
    >指 {showFingers ? '▲' : '▼'}</button>
  </div>

  <div class="mapping-list">
    {#each groups as [groupName, entries]}
      <div class="group-header">{groupName}</div>
      {#each entries as entry (entry.vrmBoneName)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="mapping-row"
          class:mapped={entry.boneIndex !== null}
          class:unmapped-required={entry.required && entry.boneIndex === null}
          class:selected={$skeletonStore.selectedBoneIndex === entry.boneIndex && entry.boneIndex !== null}
          on:click={() => handleClick(entry)}
        >
          <span class="vrm-label">{entry.label}</span>
          <span class="actual-name" title={entry.actualBoneName ?? ''}>
            {entry.actualBoneName ?? '−'}
          </span>
        </div>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .empty {
    font-size: 11px;
    color: #555;
    margin: 4px 0;
  }
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .section-title {
    font-size: 10px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .finger-toggle {
    font-size: 10px;
    padding: 2px 8px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 10px;
    color: #888;
    cursor: pointer;
  }
  .finger-toggle.on { border-color: #4af; color: #4af; }
  .mapping-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border: 1px solid #2a2a2a;
    border-radius: 4px;
    overflow: hidden;
  }
  .group-header {
    font-size: 9px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 3px 6px 1px;
    background: #1a1a1a;
    border-top: 1px solid #2a2a2a;
  }
  .mapping-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px;
    background: #1e1e1e;
    transition: background 0.1s;
  }
  .mapping-row.mapped { cursor: pointer; }
  .mapping-row.mapped:hover { background: #2a2a2a; }
  .mapping-row.selected {
    background: #2a1f00;
    outline: 1px solid #fa0;
    outline-offset: -1px;
  }
  .vrm-label {
    font-size: 10px;
    color: #777;
    width: 46px;
    flex-shrink: 0;
  }
  .mapping-row.unmapped-required .vrm-label { color: #f66; }
  .actual-name {
    font-size: 10px;
    color: #aaa;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .mapping-row.unmapped-required .actual-name { color: #666; }
  .mapping-row.selected .actual-name { color: #ffd080; }
</style>
