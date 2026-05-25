<script lang="ts">
  import { stageEditorStore } from '../stores/stageEditorStore';

  $: selectedId = $stageEditorStore.selectedId;
  $: selected = selectedId
    ? ($stageEditorStore.objects.find((o) => o.id === selectedId) ?? null)
    : null;

  function updateVec(
    field: 'position' | 'rotation' | 'scale',
    axis: 0 | 1 | 2,
    raw: string,
  ): void {
    if (!selected) return;
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const current = [...selected[field]] as [number, number, number];
    current[axis] = val;
    stageEditorStore.updateObject(selected.id, { [field]: current });
  }

  function onVecChange(field: 'position' | 'rotation' | 'scale', i: number) {
    return (e: Event) => {
      updateVec(field, i as 0 | 1 | 2, (e.currentTarget as HTMLInputElement).value);
    };
  }

  function updateMaterialColor(e: Event): void {
    if (!selected) return;
    const val = (e.currentTarget as HTMLInputElement).value;
    stageEditorStore.updateObject(selected.id, {
      material: { ...selected.material, color: val },
    });
  }

  function updateRoughness(e: Event): void {
    if (!selected) return;
    const val = parseFloat((e.currentTarget as HTMLInputElement).value);
    stageEditorStore.updateObject(selected.id, {
      material: { ...selected.material, roughness: val },
    });
  }

  function updateMetalness(e: Event): void {
    if (!selected) return;
    const val = parseFloat((e.currentTarget as HTMLInputElement).value);
    stageEditorStore.updateObject(selected.id, {
      material: { ...selected.material, metalness: val },
    });
  }

  function onTextureUpload(e: Event): void {
    if (!selected) return;
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result;
      if (typeof dataUrl !== 'string') return;
      stageEditorStore.updateObject(selected!.id, {
        material: { ...selected!.material, textureDataUrl: dataUrl },
      });
    };
    reader.readAsDataURL(file);
  }

  function clearTexture(): void {
    if (!selected) return;
    stageEditorStore.updateObject(selected.id, {
      material: { ...selected.material, textureDataUrl: null },
    });
  }
</script>

<div class="props-panel" class:inactive={!selected}>
  {#if selected}
    <section class="panel-section">
      <div class="panel-title">位置</div>
      <div class="vec3">
        {#each ['X', 'Y', 'Z'] as axis, i}
          <label class="vec-label">
            <span>{axis}</span>
            <input
              type="number"
              step="0.1"
              value={selected.position[i]}
              on:change={onVecChange('position', i)}
            />
          </label>
        {/each}
      </div>
    </section>

    <section class="panel-section">
      <div class="panel-title">回転 (度)</div>
      <div class="vec3">
        {#each ['X', 'Y', 'Z'] as axis, i}
          <label class="vec-label">
            <span>{axis}</span>
            <input
              type="number"
              step="1"
              value={selected.rotation[i]}
              on:change={onVecChange('rotation', i)}
            />
          </label>
        {/each}
      </div>
    </section>

    <section class="panel-section">
      <div class="panel-title">スケール</div>
      <div class="vec3">
        {#each ['X', 'Y', 'Z'] as axis, i}
          <label class="vec-label">
            <span>{axis}</span>
            <input
              type="number"
              step="0.1"
              min="0.01"
              value={selected.scale[i]}
              on:change={onVecChange('scale', i)}
            />
          </label>
        {/each}
      </div>
    </section>

    <section class="panel-section">
      <div class="panel-title">マテリアル</div>

      <div class="prop-row">
        <span class="prop-label">カラー</span>
        <input
          type="color"
          value={selected.material.color}
          on:input={updateMaterialColor}
        />
      </div>

      <div class="prop-row">
        <span class="prop-label">Roughness</span>
        <input
          type="range"
          min="0" max="1" step="0.01"
          value={selected.material.roughness}
          on:input={updateRoughness}
        />
        <span class="prop-val">{selected.material.roughness.toFixed(2)}</span>
      </div>

      <div class="prop-row">
        <span class="prop-label">Metalness</span>
        <input
          type="range"
          min="0" max="1" step="0.01"
          value={selected.material.metalness}
          on:input={updateMetalness}
        />
        <span class="prop-val">{selected.material.metalness.toFixed(2)}</span>
      </div>

      <div class="prop-row texture-row">
        <span class="prop-label">テクスチャ</span>
        <label class="texture-btn">
          アップロード
          <input type="file" accept="image/png,image/jpeg" on:change={onTextureUpload} />
        </label>
        {#if selected.material.textureDataUrl}
          <button class="texture-clear" on:click={clearTexture}>クリア</button>
        {/if}
      </div>
      {#if selected.material.textureDataUrl}
        <div class="texture-preview">
          <img src={selected.material.textureDataUrl} alt="texture preview" />
        </div>
      {/if}
    </section>
  {:else}
    <div class="no-selection">オブジェクトを選択してください</div>
  {/if}
</div>

<style>
  .props-panel {
    width: 220px;
    min-width: 220px;
    background: #161625;
    border-left: 1px solid #2a2a3e;
    overflow-y: auto;
  }
  .props-panel.inactive { opacity: 0.4; }
  .panel-section {
    padding: 10px 10px;
    border-bottom: 1px solid #2a2a3e;
  }
  .panel-title {
    font-size: 11px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .vec3 { display: flex; flex-direction: column; gap: 4px; }
  .vec-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .vec-label span { width: 12px; color: #888; }
  .vec-label input {
    flex: 1;
    background: #0d0d1a;
    border: 1px solid #2a2a3e;
    border-radius: 3px;
    color: #ccc;
    padding: 3px 6px;
    font-size: 12px;
  }

  .prop-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .prop-label { font-size: 11px; color: #888; min-width: 60px; }
  .prop-val { font-size: 11px; color: #aaa; min-width: 28px; text-align: right; }

  input[type="color"] {
    width: 32px;
    height: 24px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    background: none;
    padding: 0;
  }
  input[type="range"] {
    flex: 1;
    accent-color: #4488cc;
  }

  .texture-row { flex-wrap: wrap; gap: 4px; }
  .texture-btn {
    background: #252535;
    border: 1px solid #2a2a3e;
    border-radius: 3px;
    color: #aaa;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }
  .texture-btn input { display: none; }
  .texture-btn:hover { background: #2a2a40; }

  .texture-clear {
    background: #3a1a1a;
    border: 1px solid #5a2a2a;
    border-radius: 3px;
    color: #e88;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }

  .texture-preview {
    margin-top: 4px;
  }
  .texture-preview img {
    width: 100%;
    border-radius: 3px;
    object-fit: cover;
    max-height: 80px;
  }

  .no-selection {
    padding: 20px 10px;
    text-align: center;
    color: #555;
    font-size: 12px;
  }
</style>
