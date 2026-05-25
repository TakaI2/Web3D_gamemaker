<script lang="ts">
  import { stageEditorStore } from '../stores/stageEditorStore';
  import type { ShapeType } from '../stage-editor/types';

  const shapes: { type: ShapeType; label: string; icon: string }[] = [
    { type: 'box',      label: 'Box',      icon: '⬛' },
    { type: 'sphere',   label: 'Sphere',   icon: '🔵' },
    { type: 'cylinder', label: 'Cylinder', icon: '🥫' },
    { type: 'cone',     label: 'Cone',     icon: '🔺' },
  ];

  $: activeShape = $stageEditorStore.activeShape;
  $: objects = $stageEditorStore.objects;
  $: selectedId = $stageEditorStore.selectedId;
</script>

<div class="shape-panel">
  <section class="panel-section">
    <div class="panel-title">図形</div>
    <div class="shape-grid">
      {#each shapes as s}
        <button
          class="shape-btn"
          class:active={activeShape === s.type}
          on:click={() => {
            stageEditorStore.setActiveShape(s.type);
            stageEditorStore.setToolMode('place');
          }}
        >
          <span class="shape-icon">{s.icon}</span>
          <span>{s.label}</span>
        </button>
      {/each}
    </div>
  </section>

  <section class="panel-section object-list-section">
    <div class="panel-title">オブジェクト ({objects.length})</div>
    <ul class="object-list">
      {#each objects as obj (obj.id)}
        <li
          class="object-item"
          class:selected={selectedId === obj.id}
          on:click={() => {
            stageEditorStore.setSelected(obj.id);
            stageEditorStore.setToolMode('select');
          }}
        >
          <span class="obj-name">{obj.name}</span>
          <button
            class="obj-delete"
            on:click|stopPropagation={() => stageEditorStore.removeObject(obj.id)}
            title="削除"
          >×</button>
        </li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .shape-panel {
    width: 200px;
    min-width: 200px;
    background: #161625;
    border-right: 1px solid #2a2a3e;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel-section {
    padding: 10px 8px;
    border-bottom: 1px solid #2a2a3e;
  }
  .object-list-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-bottom: none;
  }
  .panel-title {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .shape-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }
  .shape-btn {
    background: #1e1e2e;
    border: 1px solid #2a2a3e;
    border-radius: 4px;
    color: #aaa;
    padding: 8px 4px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    transition: background 0.1s;
  }
  .shape-btn:hover { background: #252535; color: #ddd; }
  .shape-btn.active { background: #2a3a5e; border-color: #4488cc; color: #7ab; }
  .shape-icon { font-size: 18px; }

  .object-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
  }
  .object-item {
    display: flex;
    align-items: center;
    padding: 6px 8px;
    cursor: pointer;
    border-bottom: 1px solid #1e1e2e;
    gap: 4px;
  }
  .object-item:hover { background: #1e1e2e; }
  .object-item.selected { background: #1e2e3e; border-left: 2px solid #4488cc; }
  .obj-name { flex: 1; font-size: 12px; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .obj-delete {
    background: none;
    border: none;
    color: #555;
    cursor: pointer;
    padding: 2px 4px;
    font-size: 14px;
    line-height: 1;
    border-radius: 2px;
  }
  .obj-delete:hover { color: #e55; background: #2a1a1a; }
</style>
