<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { readable } from 'svelte/store';
  import type { Readable } from 'svelte/store';
  import { SceneManager } from '../core/SceneManager';
  import { RenderLoop } from '../core/RenderLoop';
  import { OrbitController } from '../core/OrbitController';
  import { createRetargetSlot } from '../core/RetargetSlot';
  import { appModeStore } from '../stores/appModeStore';
  import { attachShiftDragScale } from '../utils/shiftDragScale';
  import type { RetargetSlot } from '../core/RetargetSlot';
  import type { SlotModelType, SlotState } from '../types';

  // キャンバスは常に DOM に存在させる（onMount で使用するため）
  let leftCanvas: HTMLCanvasElement;
  let rightCanvas: HTMLCanvasElement;
  let leftModelInput: HTMLInputElement;
  let rightModelInput: HTMLInputElement;
  let leftAnimInput: HTMLInputElement;
  let rightAnimInput: HTMLInputElement;

  let leftSlot: RetargetSlot | undefined;
  let rightSlot: RetargetSlot | undefined;
  let leftOrbit: OrbitController | undefined;
  let rightOrbit: OrbitController | undefined;
  let leftRL: RenderLoop | undefined;
  let rightRL: RenderLoop | undefined;

  // $記法で使うためのストア変数（onMount で再代入）
  const defaultState: SlotState = {
    modelType: 'vrm', loaded: false, loading: false, error: null,
    animNames: [], currentAnim: null, isPlaying: false, isLooping: true, scale: 1,
  };
  let leftState: Readable<SlotState> = readable(defaultState);
  let rightState: Readable<SlotState> = readable(defaultState);

  // サーバーファイルピッカー
  type PickerMode = 'model' | 'anim';
  type PickerSide = 'left' | 'right';
  let pickerSide: PickerSide = 'left';
  let pickerMode: PickerMode = 'model';
  let pickerFiles: string[] = [];
  let pickerOpen = false;

  async function openServerPicker(side: PickerSide, mode: PickerMode) {
    pickerSide = side;
    pickerMode = mode;
    pickerFiles = [];
    pickerOpen = true;
    const state = side === 'left' ? $leftState : $rightState;
    const endpoint = mode === 'model'
      ? `/${state.modelType === 'mmd' ? 'pmx' : state.modelType}/manifest.json`
      : `/${state.modelType === 'vrm' ? 'vrma' : 'vmd'}/manifest.json`;
    try {
      const res = await fetch(endpoint);
      pickerFiles = res.ok ? await res.json() : [];
    } catch {
      pickerFiles = [];
    }
  }

  async function selectServerFile(file: string) {
    pickerOpen = false;
    const slot  = pickerSide === 'left' ? leftSlot  : rightSlot;
    const orbit = pickerSide === 'left' ? leftOrbit : rightOrbit;
    const state = pickerSide === 'left' ? $leftState : $rightState;

    let url: string;
    if (pickerMode === 'model') {
      const folder = state.modelType === 'mmd' ? 'pmx' : state.modelType;
      url = file.includes('/') ? `/${file}` : `/${folder}/${file}`;
      const obj = await slot?.loadModelFromUrl(url, file) ?? null;
      if (obj && orbit) orbit.fitToObject(obj);
    } else {
      const folder = state.modelType === 'vrm' ? 'vrma' : 'vmd';
      url = file.includes('/') ? `/${file}` : `/${folder}/${file}`;
      const baseName = file.split('/').pop()?.replace(/\.(vrma|vmd)$/i, '') ?? file;
      await slot?.loadAnimFromUrl(url, baseName);
    }
  }

  onMount(() => {
    const leftSM  = new SceneManager(leftCanvas,  { fov: 30, far: 100 });
    const rightSM = new SceneManager(rightCanvas, { fov: 30, far: 100 });

    leftOrbit  = new OrbitController(leftSM);
    rightOrbit = new OrbitController(rightSM);

    leftSlot  = createRetargetSlot(leftSM);
    rightSlot = createRetargetSlot(rightSM);

    // store 変数を slot の state に差し替え → $leftState / $rightState が反応
    leftState  = leftSlot.state;
    rightState = rightSlot.state;

    leftRL  = new RenderLoop(leftSM);
    rightRL = new RenderLoop(rightSM);

    leftRL.addCallback((delta)  => { leftSlot?.update(delta);  leftOrbit?.update(); });
    rightRL.addCallback((delta) => { rightSlot?.update(delta); rightOrbit?.update(); });

    leftRL.start();
    rightRL.start();

    // Shift+ドラッグ スケール（左右それぞれ）
    const cleanupLeftDrag = attachShiftDragScale(
      leftCanvas,
      () => leftSlot?.currentObject ?? null,
      () => { leftOrbit?.refitToLast(); },
      (enabled) => leftOrbit?.setEnabled(enabled),
    );
    const cleanupRightDrag = attachShiftDragScale(
      rightCanvas,
      () => rightSlot?.currentObject ?? null,
      () => { rightOrbit?.refitToLast(); },
      (enabled) => rightOrbit?.setEnabled(enabled),
    );

    const obs = new ResizeObserver(() => {
      leftSM.resize(leftCanvas.clientWidth,   leftCanvas.clientHeight);
      rightSM.resize(rightCanvas.clientWidth, rightCanvas.clientHeight);
    });
    obs.observe(leftCanvas);
    obs.observe(rightCanvas);

    return () => {
      obs.disconnect();
      cleanupLeftDrag();
      cleanupRightDrag();
    };
  });

  onDestroy(() => {
    leftRL?.stop();
    rightRL?.stop();
    leftSlot?.dispose();
    rightSlot?.dispose();
    leftOrbit?.dispose();
    rightOrbit?.dispose();
  });

  function scaleAndRefit(side: 'left' | 'right', multiply: boolean) {
    const slot  = side === 'left' ? leftSlot  : rightSlot;
    const orbit = side === 'left' ? leftOrbit : rightOrbit;
    slot?.scaleModel(multiply);
    orbit?.refitToLast();
  }

  async function onModelFile(side: 'left' | 'right', e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const slot  = side === 'left' ? leftSlot  : rightSlot;
    const orbit = side === 'left' ? leftOrbit : rightOrbit;
    const obj = await slot?.loadModel(file) ?? null;
    if (obj && orbit) orbit.fitToObject(obj);
    (e.target as HTMLInputElement).value = '';
  }

  async function onAnimFile(side: 'left' | 'right', e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const slot = side === 'left' ? leftSlot : rightSlot;
    await slot?.loadAnim(file);
    (e.target as HTMLInputElement).value = '';
  }

  function setType(side: 'left' | 'right', t: string) {
    const slot = side === 'left' ? leftSlot : rightSlot;
    slot?.setModelType(t as SlotModelType);
  }

  function animAccept(type: SlotModelType): string {
    return type === 'vrm' ? '.vrma' : type === 'mmd' ? '.vmd' : '';
  }
  function animBtnLabel(type: SlotModelType): string {
    return type === 'vrm' ? '+ VRMA' : type === 'mmd' ? '+ VMD' : '';
  }
</script>

<div class="retarget-root">
  <!-- ヘッダー -->
  <header class="retarget-header">
    <button class="back-btn" on:click={() => appModeStore.toEditor()}>← エディタ</button>
    <span class="title">リターゲット 比較ビュー</span>
  </header>

  <!-- メインエリア：左右分割 -->
  <div class="retarget-main">

    <!-- ===== 左 ===== -->
    <div class="side">
      <!-- コントロールパネル（常に表示） -->
      <div class="side-panel">
        <span class="side-label src">変換元 (Source)</span>

        <div class="type-tabs">
          {#each ['vrm','mmd','fbx'] as t}
            <button
              class="type-tab"
              class:active={$leftState.modelType === t}
              on:click={() => setType('left', t)}
            >{t.toUpperCase()}</button>
          {/each}
        </div>

        <div class="load-row">
          <button class="load-btn" on:click={() => leftModelInput.click()} disabled={$leftState.loading || !leftSlot}>
            {$leftState.loading ? '読込中...' : '📂 ローカル'}
          </button>
          <button class="server-btn" on:click={() => openServerPicker('left', 'model')} disabled={$leftState.loading || !leftSlot} title="サーバーから読込">
            🌐
          </button>
          {#if $leftState.loaded}
            <button class="unload-btn" on:click={() => leftSlot?.unload()}>✕</button>
          {/if}
        </div>

        {#if $leftState.loaded && $leftState.modelType !== 'fbx'}
          <div class="load-row">
            <button class="anim-btn" on:click={() => leftAnimInput.click()}>
              {animBtnLabel($leftState.modelType)} ローカル
            </button>
            <button class="anim-server-btn" on:click={() => openServerPicker('left', 'anim')} title="サーバーからアニメ追加">
              🌐 {animBtnLabel($leftState.modelType)}
            </button>
          </div>
        {/if}

        {#if $leftState.error}
          <p class="err">{$leftState.error}</p>
        {:else if $leftState.loaded}
          <p class="ok">✓ 読込済</p>
        {/if}

        {#if $leftState.loaded}
          <div class="scale-row">
            <span class="scale-lbl">スケール</span>
            <button class="scale-btn" on:click={() => scaleAndRefit('left', false)}>－</button>
            <span class="scale-val">×{$leftState.scale}</span>
            <button class="scale-btn" on:click={() => scaleAndRefit('left', true)}>＋</button>
          </div>
        {/if}

        {#if $leftState.animNames.length > 0}
          <div class="anim-list">
            {#each $leftState.animNames as name}
              <button
                class="anim-item"
                class:active={$leftState.currentAnim === name}
                on:click={() => leftSlot?.play(name)}
                title={name}
              >{name}</button>
            {/each}
          </div>
          <div class="play-row">
            <button
              class="play-btn"
              disabled={!$leftState.currentAnim}
              on:click={() => $leftState.isPlaying ? leftSlot?.stop() : leftSlot?.play($leftState.currentAnim ?? '')}
            >{$leftState.isPlaying ? '⏹ 停止' : '▶ 再生'}</button>
            <label class="loop-lbl">
              <input type="checkbox" checked={$leftState.isLooping}
                on:change={() => leftSlot?.setLoop(!$leftState.isLooping)} />
              ループ
            </label>
          </div>
        {/if}
      </div>

      <!-- キャンバス（常に DOM に存在） -->
      <canvas bind:this={leftCanvas} class="side-canvas" />

      <input bind:this={leftModelInput} type="file" accept=".vrm,.pmx,.fbx" style="display:none"
        on:change={(e) => onModelFile('left', e)} />
      <input bind:this={leftAnimInput} type="file" accept={animAccept($leftState.modelType)} style="display:none"
        on:change={(e) => onAnimFile('left', e)} />
    </div>

    <!-- 仕切り -->
    <div class="divider" />

    <!-- ===== 右 ===== -->
    <div class="side">
      <div class="side-panel">
        <span class="side-label dst">変換先 (Target)</span>

        <div class="type-tabs">
          {#each ['vrm','mmd','fbx'] as t}
            <button
              class="type-tab"
              class:active={$rightState.modelType === t}
              on:click={() => setType('right', t)}
            >{t.toUpperCase()}</button>
          {/each}
        </div>

        <div class="load-row">
          <button class="load-btn" on:click={() => rightModelInput.click()} disabled={$rightState.loading || !rightSlot}>
            {$rightState.loading ? '読込中...' : '📂 ローカル'}
          </button>
          <button class="server-btn" on:click={() => openServerPicker('right', 'model')} disabled={$rightState.loading || !rightSlot} title="サーバーから読込">
            🌐
          </button>
          {#if $rightState.loaded}
            <button class="unload-btn" on:click={() => rightSlot?.unload()}>✕</button>
          {/if}
        </div>

        {#if $rightState.loaded && $rightState.modelType !== 'fbx'}
          <div class="load-row">
            <button class="anim-btn" on:click={() => rightAnimInput.click()}>
              {animBtnLabel($rightState.modelType)} ローカル
            </button>
            <button class="anim-server-btn" on:click={() => openServerPicker('right', 'anim')} title="サーバーからアニメ追加">
              🌐 {animBtnLabel($rightState.modelType)}
            </button>
          </div>
        {/if}

        {#if $rightState.error}
          <p class="err">{$rightState.error}</p>
        {:else if $rightState.loaded}
          <p class="ok">✓ 読込済</p>
        {/if}

        {#if $rightState.loaded}
          <div class="scale-row">
            <span class="scale-lbl">スケール</span>
            <button class="scale-btn" on:click={() => scaleAndRefit('right', false)}>－</button>
            <span class="scale-val">×{$rightState.scale}</span>
            <button class="scale-btn" on:click={() => scaleAndRefit('right', true)}>＋</button>
          </div>
        {/if}

        {#if $rightState.animNames.length > 0}
          <div class="anim-list">
            {#each $rightState.animNames as name}
              <button
                class="anim-item"
                class:active={$rightState.currentAnim === name}
                on:click={() => rightSlot?.play(name)}
                title={name}
              >{name}</button>
            {/each}
          </div>
          <div class="play-row">
            <button
              class="play-btn"
              disabled={!$rightState.currentAnim}
              on:click={() => $rightState.isPlaying ? rightSlot?.stop() : rightSlot?.play($rightState.currentAnim ?? '')}
            >{$rightState.isPlaying ? '⏹ 停止' : '▶ 再生'}</button>
            <label class="loop-lbl">
              <input type="checkbox" checked={$rightState.isLooping}
                on:change={() => rightSlot?.setLoop(!$rightState.isLooping)} />
              ループ
            </label>
          </div>
        {/if}
      </div>

      <canvas bind:this={rightCanvas} class="side-canvas" />

      <input bind:this={rightModelInput} type="file" accept=".vrm,.pmx,.fbx" style="display:none"
        on:change={(e) => onModelFile('right', e)} />
      <input bind:this={rightAnimInput} type="file" accept={animAccept($rightState.modelType)} style="display:none"
        on:change={(e) => onAnimFile('right', e)} />
    </div>

  </div>
</div>

{#if pickerOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="picker-overlay" on:click={() => (pickerOpen = false)}>
    <div class="picker-dialog" on:click|stopPropagation>
      <div class="picker-header">
        <span>
          {pickerMode === 'model' ? 'モデル選択' : 'アニメーション選択'}
          <span class="picker-type">({pickerSide === 'left' ? '変換元' : '変換先'})</span>
        </span>
        <button class="close-btn" on:click={() => (pickerOpen = false)}>✕</button>
      </div>
      {#if pickerFiles.length === 0}
        <p class="picker-empty">ファイルがありません</p>
      {:else}
        {#each pickerFiles as f}
          <button class="picker-item" on:click={() => selectServerFile(f)}>
            {f.split('/').pop()}
            {#if f.includes('/')}
              <span class="picker-path">{f.split('/').slice(0, -1).join('/')}</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style>
  .retarget-root {
    width: 100%; height: 100%;
    display: flex; flex-direction: column;
    background: #111; overflow: hidden;
  }
  .retarget-header {
    display: flex; align-items: center; gap: 12px;
    padding: 0 16px; height: 44px;
    background: #1a1a1a; border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  .back-btn {
    padding: 5px 12px; background: #2a2a2a;
    border: 1px solid #444; border-radius: 4px;
    color: #ccc; font-size: 12px; cursor: pointer;
  }
  .back-btn:hover { background: #333; color: #fff; }
  .title { font-size: 14px; font-weight: bold; color: #eee; }
  .retarget-main {
    flex: 1; display: flex; overflow: hidden;
  }
  .side {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
  }
  .side-panel {
    flex-shrink: 0; background: #1a1a1a; border-bottom: 1px solid #333;
    padding: 8px 12px; display: flex; flex-direction: column; gap: 6px;
    max-height: 280px; overflow-y: auto;
  }
  .side-canvas {
    flex: 1; display: block; width: 100%; min-height: 0;
  }
  .divider { width: 1px; background: #333; flex-shrink: 0; }
  .side-label { font-size: 11px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; }
  .side-label.src { color: #7bf; }
  .side-label.dst { color: #fa4; }
  .type-tabs { display: flex; gap: 3px; }
  .type-tab {
    padding: 3px 10px; background: #2a2a2a;
    border: 1px solid #444; border-radius: 3px;
    color: #888; font-size: 11px; font-weight: bold; cursor: pointer;
    transition: background 0.1s, color 0.1s;
  }
  .type-tab.active { background: #1a3a5c; border-color: #4af; color: #4af; }
  .type-tab:hover:not(.active) { color: #ccc; }
  .load-row { display: flex; gap: 4px; }
  .load-btn {
    flex: 1; padding: 6px 8px; background: #2a3a4a;
    border: 1px solid #47a; border-radius: 4px;
    color: #7bf; font-size: 12px; cursor: pointer; transition: background 0.15s;
  }
  .load-btn:hover:not(:disabled) { background: #334455; }
  .load-btn:disabled { opacity: 0.5; cursor: default; }
  .unload-btn {
    padding: 6px 10px; background: #3a2a2a;
    border: 1px solid #755; border-radius: 4px;
    color: #f88; font-size: 12px; cursor: pointer;
  }
  .unload-btn:hover { background: #4a3333; }
  .server-btn {
    padding: 6px 8px; background: #2a3a4a;
    border: 1px solid #47a; border-radius: 4px;
    color: #7bf; font-size: 12px; cursor: pointer;
  }
  .server-btn:hover:not(:disabled) { background: #334455; }
  .server-btn:disabled { opacity: 0.5; cursor: default; }
  .anim-btn {
    flex: 1; padding: 5px 8px; background: #2a3a2a;
    border: 1px solid #484; border-radius: 4px;
    color: #8d8; font-size: 11px; cursor: pointer;
  }
  .anim-btn:hover { background: #333; }
  .anim-server-btn {
    padding: 5px 8px; background: #2a3a2a;
    border: 1px solid #484; border-radius: 4px;
    color: #8d8; font-size: 11px; cursor: pointer;
  }
  .anim-server-btn:hover { background: #333; }
  /* ピッカーダイアログ */
  .picker-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6); z-index: 200;
    display: flex; align-items: center; justify-content: center;
  }
  .picker-dialog {
    background: #2a2a2a; border: 1px solid #555;
    border-radius: 8px; padding: 12px;
    min-width: 280px; max-height: 60vh;
    overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
  }
  .picker-header {
    display: flex; justify-content: space-between; align-items: center;
    color: #eee; font-size: 13px; font-weight: bold; margin-bottom: 4px;
  }
  .picker-type { color: #888; font-size: 11px; font-weight: normal; margin-left: 6px; }
  .close-btn {
    background: none; border: none; color: #888; cursor: pointer; font-size: 14px; padding: 0 4px;
  }
  .close-btn:hover { color: #fff; }
  .picker-item {
    padding: 7px 8px; background: #333; border: none;
    border-radius: 4px; color: #ccc; font-size: 12px; cursor: pointer;
    text-align: left; display: flex; flex-direction: column; gap: 1px;
  }
  .picker-item:hover { background: #444; color: #fff; }
  .picker-path { font-size: 10px; color: #666; }
  .picker-empty { font-size: 12px; color: #666; text-align: center; margin: 4px 0; }
  .err  { font-size: 11px; color: #f88; margin: 0; }
  .ok   { font-size: 11px; color: #4c4; margin: 0; }
  .scale-row { display: flex; align-items: center; gap: 5px; }
  .scale-lbl { font-size: 11px; color: #888; flex: 1; }
  .scale-btn {
    width: 26px; height: 26px; background: #333;
    border: 1px solid #555; border-radius: 3px;
    color: #eee; font-size: 15px; cursor: pointer; line-height: 1;
  }
  .scale-btn:hover { background: #444; }
  .scale-val { font-size: 11px; color: #ccc; font-family: monospace; min-width: 48px; text-align: center; }
  .anim-list {
    display: flex; flex-direction: column; gap: 2px;
    max-height: 100px; overflow-y: auto;
    border: 1px solid #2a2a2a; border-radius: 3px; padding: 2px;
  }
  .anim-item {
    padding: 4px 6px; background: #222; border: 1px solid #2a2a2a;
    border-radius: 3px; color: #bbb; font-size: 11px; cursor: pointer;
    text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: background 0.1s;
  }
  .anim-item:hover { background: #2a2a2a; color: #eee; }
  .anim-item.active { background: #1a3a5c; border-color: #4af; color: #4af; }
  .play-row { display: flex; align-items: center; gap: 8px; }
  .play-btn {
    flex: 1; padding: 6px 0; background: #2a4a3a;
    border: 1px solid #4a8; border-radius: 4px;
    color: #4a8; font-size: 11px; cursor: pointer; transition: background 0.15s;
  }
  .play-btn:hover:not(:disabled) { background: #356a4a; }
  .play-btn:disabled { opacity: 0.4; cursor: default; }
  .loop-lbl {
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; color: #aaa; cursor: pointer; user-select: none; white-space: nowrap;
  }
  .loop-lbl input { cursor: pointer; }
</style>
