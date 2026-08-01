<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
  import { VRMLoaderPlugin } from '@pixiv/three-vrm';
  import { vrmStore } from '../stores/vrmStore';
  import { appModeStore } from '../stores/appModeStore';
  import { animEditorStore } from '../stores/animEditorStore';
  import AnimEditorViewport from './AnimEditorViewport.svelte';
  import AnimEditorTimeline from './AnimEditorTimeline.svelte';
  import AnimEditorFacial from './AnimEditorFacial.svelte';
  import AnimEditorControls from './AnimEditorControls.svelte';
  import type { VRM } from '@pixiv/three-vrm';
  import type { IKTarget } from '../types';
  import type { AnimEditorSceneHandle, IKGizmoMode } from '../core/AnimEditorScene';

  // ダイアログ状態
  type DialogMode = 'choose' | 'new' | 'open' | 'ready';
  let dialogMode: DialogMode = 'choose';
  let newDurationSec = 3;
  let vrmaFile: File | null = null;
  let vrm: VRM | null = null;
  let editorScene: AnimEditorSceneHandle | null = null;
  let loadError = '';
  // public フォルダからの読み込み用（VRM=/vrm、VRMA=/vrma）
  let vrmFiles: string[] = [];
  let vrmaFiles: string[] = [];
  let selectedVrm = '';
  let selectedVrma = '';
  let vrmLoadError = '';

  // Undo 可否（$animEditorStore が変わるたび再評価）
  $: canUndo = ((): boolean => { void $animEditorStore; return animEditorStore.canUndo(); })();

  // IK スイッチ
  const IK_TARGETS: IKTarget[] = ['rightHand', 'leftHand', 'rightFoot', 'leftFoot'];
  const IK_LABELS: Record<IKTarget, string> = {
    rightHand: '右手', leftHand: '左手', rightFoot: '右足', leftFoot: '左足',
  };
  $: ikEnabled = $animEditorStore.ikEnabled;

  // アクティブ IK ターゲットとギズモモード
  let activeIKTarget: IKTarget | null = null;
  let ikGizmoMode: IKGizmoMode = 'translate';

  function setIKGizmoMode(mode: IKGizmoMode): void {
    ikGizmoMode = mode;
    editorScene?.setIKGizmoMode(mode);
  }

  onMount(() => {
    // VRM 未読込でも編集画面に入れる（ここで読み込める）。既に読込済みなら流用。
    const state = get(vrmStore);
    if (state.vrm) vrm = state.vrm;
    void fetchList('vrm');
    void fetchList('vrma');
  });

  async function fetchList(mode: 'vrm' | 'vrma'): Promise<void> {
    try {
      const res = await fetch(`/${mode}/manifest.json`);
      const files: string[] = res.ok ? await res.json() : [];
      if (mode === 'vrm') vrmFiles = files; else vrmaFiles = files;
    } catch {
      if (mode === 'vrm') vrmFiles = []; else vrmaFiles = [];
    }
  }

  // ── VRM 読み込み（public/vrm フォルダ または ファイル）──
  async function loadVrmFromUrl(url: string): Promise<void> {
    vrmLoadError = '';
    try {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(url);
      const loaded = gltf.userData.vrm as VRM | undefined;
      if (!loaded) throw new Error('VRM データが見つかりません');
      vrm = loaded;
      vrmStore.setVRM(loaded);
    } catch (e) {
      vrmLoadError = e instanceof Error ? e.message : String(e);
    }
  }
  async function loadSelectedVrm(): Promise<void> {
    if (!selectedVrm) return;
    await loadVrmFromUrl(`/vrm/${encodeURIComponent(selectedVrm)}`);
  }
  async function loadVrmFile(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try { await loadVrmFromUrl(url); } finally { URL.revokeObjectURL(url); }
  }

  function goBack(): void {
    animEditorStore.close();
    appModeStore.toEditor();
  }

  function startNew(): void {
    animEditorStore.open(newDurationSec);
    dialogMode = 'ready';
  }

  // raw VRMAnimation を URL から取得してストアへインポート（AnimationManager 非経由）
  async function importVrmaFromUrl(url: string): Promise<void> {
    if (!vrm) return;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrmAnim = gltf.userData.vrmAnimations?.[0];
    if (!vrmAnim) throw new Error('VRMA データが見つかりません');
    animEditorStore.importFromVrmAnimation(vrmAnim, vrm);
    dialogMode = 'ready';
  }

  async function openVrma(): Promise<void> {
    if (!vrmaFile || !vrm) return;
    loadError = '';
    const url = URL.createObjectURL(vrmaFile);
    try {
      await importVrmaFromUrl(url);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function openVrmaFromServer(): Promise<void> {
    if (!selectedVrma || !vrm) return;
    loadError = '';
    try {
      await importVrmaFromUrl(`/vrma/${encodeURIComponent(selectedVrma)}`);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  function onSceneReady(scene: AnimEditorSceneHandle): void {
    editorScene = scene;
    scene.onBoneRotated = (boneName, quat) => {
      animEditorStore.setBoneKeyframe(boneName, $animEditorStore.currentFrame, quat);
    };
    scene.onBoneClicked = (boneName) => {
      animEditorStore.setSelectedBone(boneName);
    };
    scene.onIKSolved = (results) => {
      const frame = $animEditorStore.currentFrame;
      for (const [, res] of Object.entries(results)) {
        if (!res) continue;
        animEditorStore.setBoneKeyframe(res.root, frame, res.rootQ);
        animEditorStore.setBoneKeyframe(res.mid, frame, res.midQ);
      }
    };
    scene.onIKTargetSelected = (target) => {
      activeIKTarget = target;
      if (target === null) ikGizmoMode = 'translate';
    };
    scene.onHipsMoved = (pos) => {
      animEditorStore.setHipsPositionKeyframe($animEditorStore.currentFrame, pos);
    };
  }

  // ルート(腰)移動 / 背骨IK のトグル（互いに排他）
  let rootMove = false;
  let spineIK = false;
  function toggleRootMove(): void {
    rootMove = !rootMove;
    if (rootMove) spineIK = false;
    editorScene?.setRootEnabled(rootMove);
  }
  function toggleSpineIK(): void {
    spineIK = !spineIK;
    if (spineIK) rootMove = false;
    editorScene?.setSpineEnabled(spineIK);
  }

  // LookAt（顔/視線）と 手グラブ（指の開閉）
  let lookAt = false;
  let leftGrab = 0;
  let rightGrab = 0;
  function toggleLookAt(): void {
    lookAt = !lookAt;
    if (lookAt) { rootMove = false; spineIK = false; }
    editorScene?.setLookAtEnabled(lookAt);
  }
  function onGrab(side: 'left' | 'right', e: Event): void {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (side === 'left') leftGrab = v; else rightGrab = v;
    editorScene?.setHandGrab(side, v);
  }

  function toggleIK(target: IKTarget): void {
    const next = !ikEnabled[target];
    animEditorStore.setIKEnabled(target, next);
    editorScene?.setIKEnabled(target, next);
  }

  $: outputFilename = $animEditorStore.outputFilename;
  function onFilenameInput(e: Event): void {
    animEditorStore.setOutputFilename((e.target as HTMLInputElement).value);
  }

  // タイムライン縦リサイズ（上端のバーをドラッグ）
  let timelineHeight = 220;
  let resizingTl = false;
  let tlStartY = 0, tlStartH = 0;
  function onTlResizeDown(e: PointerEvent): void {
    resizingTl = true;
    tlStartY = e.clientY; tlStartH = timelineHeight;
    e.preventDefault();
    window.addEventListener('pointermove', onTlResizeMove);
    window.addEventListener('pointerup', onTlResizeUp);
  }
  function onTlResizeMove(e: PointerEvent): void {
    if (!resizingTl) return;
    const dy = tlStartY - e.clientY;   // 上ドラッグで高くなる
    timelineHeight = Math.max(120, Math.min(window.innerHeight - 180, tlStartH + dy));
  }
  function onTlResizeUp(): void {
    resizingTl = false;
    window.removeEventListener('pointermove', onTlResizeMove);
    window.removeEventListener('pointerup', onTlResizeUp);
  }
</script>

<!-- ダイアログ（起動時） -->
{#if dialogMode === 'choose'}
  <div class="overlay">
    <div class="dialog">
      <h2>アニメーション編集</h2>
      <!-- VRM モデル読み込み（public/vrm フォルダ または ファイル） -->
      <div class="load-section">
        <div class="section-label">
          VRM モデル {#if vrm}<span class="ok">✓ 読込済み</span>{:else}<span class="warn">未読込</span>{/if}
        </div>
        <div class="load-row">
          <select bind:value={selectedVrm}>
            <option value="">— public/vrm から選択 —</option>
            {#each vrmFiles as f}<option value={f}>{f}</option>{/each}
          </select>
          <button on:click={loadSelectedVrm} disabled={!selectedVrm}>読込</button>
        </div>
        <label class="file-label">またはファイル: <input type="file" accept=".vrm" on:change={loadVrmFile} /></label>
        {#if vrmLoadError}<p class="error">{vrmLoadError}</p>{/if}
      </div>
      <div class="dialog-btns">
        <button class="big-btn" on:click={() => (dialogMode = 'new')} disabled={!vrm}>
          ＋ 新規作成
        </button>
        <button class="big-btn" on:click={() => (dialogMode = 'open')} disabled={!vrm}>
          📂 VRMA を開く
        </button>
      </div>
      {#if !vrm}<p class="hint">まず VRM を読み込むと編集を開始できます。</p>{/if}
      <button class="back-link" on:click={goBack}>← エディタへ戻る</button>
    </div>
  </div>

{:else if dialogMode === 'new'}
  <div class="overlay">
    <div class="dialog">
      <h2>新規アニメーション</h2>
      <label>
        長さ（秒）:
        <input type="number" min="0.1" max="60" step="0.1" bind:value={newDurationSec} />
      </label>
      <div class="dialog-btns">
        <button class="big-btn" on:click={startNew}>作成</button>
        <button on:click={() => (dialogMode = 'choose')}>← 戻る</button>
      </div>
    </div>
  </div>

{:else if dialogMode === 'open'}
  <div class="overlay">
    <div class="dialog">
      <h2>VRMA を開く</h2>
      <div class="load-row">
        <select bind:value={selectedVrma}>
          <option value="">— public/vrma から選択 —</option>
          {#each vrmaFiles as f}<option value={f}>{f}</option>{/each}
        </select>
        <button on:click={openVrmaFromServer} disabled={!selectedVrma}>読込</button>
      </div>
      <label class="file-label">またはファイル: <input type="file" accept=".vrma" on:change={(e) => (vrmaFile = e.currentTarget.files?.[0] ?? null)} /></label>
      {#if loadError}<p class="error">{loadError}</p>{/if}
      <div class="dialog-btns">
        <button class="big-btn" on:click={openVrma} disabled={!vrmaFile}>ファイルを読み込む</button>
        <button on:click={() => (dialogMode = 'choose')}>← 戻る</button>
      </div>
    </div>
  </div>

{:else if dialogMode === 'ready' && vrm}
  <!-- メインエディタ画面 -->
  <div class="anim-editor">
    <!-- ヘッダーバー -->
    <div class="header-bar">
      <button class="back-btn" on:click={goBack}>← 戻る</button>
      <button class="back-btn undo-btn" on:click={() => animEditorStore.undo()} disabled={!canUndo} title="元に戻す (Ctrl+Z)">↶ 元に戻す</button>
      <input
        class="filename-input"
        value={outputFilename}
        on:input={onFilenameInput}
        placeholder="output.vrma"
      />
    </div>

    <!-- メインエリア -->
    <div class="main-area">
      <!-- 3D ビューポート -->
      <div class="viewport-area">
        <AnimEditorViewport {vrm} {onSceneReady} />
      </div>

      <!-- 右パネル -->
      <div class="right-panel">
        <!-- IK スイッチ -->
        <div class="ik-section">
          <div class="section-title">IK コントロール</div>
          {#each IK_TARGETS as target}
            <label class="ik-toggle">
              <input
                type="checkbox"
                checked={ikEnabled[target]}
                on:change={() => toggleIK(target)}
              />
              {IK_LABELS[target]}
            </label>
          {/each}
          {#if activeIKTarget !== null}
            <div class="ik-gizmo-mode">
              <span class="section-label">ギズモ</span>
              <div class="mode-btns">
                <button
                  class="mode-btn"
                  class:active={ikGizmoMode === 'translate'}
                  on:click={() => setIKGizmoMode('translate')}
                  title="移動 (T)"
                >移動</button>
                <button
                  class="mode-btn"
                  class:active={ikGizmoMode === 'rotate'}
                  on:click={() => setIKGizmoMode('rotate')}
                  title="回転 (R)"
                >回転</button>
              </div>
            </div>
          {/if}

          <!-- ルート移動 / 背骨IK / LookAt -->
          <div class="ik-gizmo-mode">
            <span class="section-label">ルート / 背骨 / 視線</span>
            <label class="ik-toggle">
              <input type="checkbox" checked={rootMove} on:change={toggleRootMove} />
              ルート(腰)移動
            </label>
            <label class="ik-toggle">
              <input type="checkbox" checked={spineIK} on:change={toggleSpineIK} />
              背骨IK(頭を引く)
            </label>
            <label class="ik-toggle">
              <input type="checkbox" checked={lookAt} on:change={toggleLookAt} />
              LookAt(顔/視線)
            </label>
          </div>

          <!-- 手グラブ（指の開閉） -->
          <div class="ik-gizmo-mode">
            <span class="section-label">手グラブ（0=開 1=握）</span>
            <div class="grab-row">
              <span>左</span>
              <input type="range" min="0" max="1" step="0.05" value={leftGrab} on:input={(e) => onGrab('left', e)} />
            </div>
            <div class="grab-row">
              <span>右</span>
              <input type="range" min="0" max="1" step="0.05" value={rightGrab} on:input={(e) => onGrab('right', e)} />
            </div>
          </div>
        </div>

        <!-- フェイシャル -->
        <AnimEditorFacial {vrm} />
      </div>
    </div>

    <!-- 再生コントロール -->
    <AnimEditorControls {vrm} />

    <!-- タイムライン縦リサイズハンドル -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="timeline-resizer" on:pointerdown={onTlResizeDown} title="ドラッグで高さ変更"></div>

    <!-- タイムライン -->
    <div class="timeline-area" style="height:{timelineHeight}px">
      <AnimEditorTimeline />
    </div>
  </div>
{/if}

<style>
  /* オーバーレイ・ダイアログ */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    background: #222;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 32px;
    min-width: 300px;
    color: #ddd;
  }
  .dialog h2 { margin: 0 0 20px; font-size: 18px; }
  .dialog label { display: block; margin-bottom: 12px; font-size: 13px; }
  .dialog input[type="number"] { margin-left: 8px; width: 80px; }
  .dialog-btns { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
  .big-btn {
    flex: 1;
    padding: 14px 20px;
    background: #333;
    border: 1px solid #555;
    color: #ddd;
    cursor: pointer;
    border-radius: 6px;
    font-size: 14px;
  }
  .big-btn:hover { background: #3a3a3a; }
  .big-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .back-link { background: none; border: none; color: #888; cursor: pointer; margin-top: 12px; font-size: 12px; }
  .warn { color: #fa8; }
  .ok { color: #8f8; }
  .error { color: #f66; font-size: 12px; }
  .hint { color: #888; font-size: 12px; margin: 8px 0 0; }
  .load-section { border: 1px solid #3a3a3a; border-radius: 6px; padding: 10px; margin-bottom: 14px; }
  .load-row { display: flex; gap: 6px; margin: 6px 0; }
  .load-row select { flex: 1; background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 4px; max-width: 260px; }
  .load-row button { background: #333; border: 1px solid #555; color: #ddd; border-radius: 4px; padding: 4px 12px; cursor: pointer; }
  .load-row button:disabled { opacity: 0.4; cursor: not-allowed; }
  .file-label { font-size: 12px; color: #aaa; }
  .undo-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* メインエディタ */
  .anim-editor {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: #111;
    color: #ddd;
    overflow: hidden;
  }
  .header-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  .back-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ccc;
    padding: 4px 12px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .back-btn:hover { background: #333; }
  .filename-input {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ddd;
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 12px;
    width: 200px;
  }

  .main-area {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }
  .viewport-area {
    flex: 1;
    overflow: hidden;
    position: relative;
  }
  .right-panel {
    width: 200px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #1a1a1a;
    border-left: 1px solid #333;
    overflow-y: auto;
  }

  .ik-section {
    padding: 8px;
    border-bottom: 1px solid #333;
  }
  .section-title {
    font-size: 11px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .ik-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #bbb;
    margin-bottom: 4px;
    cursor: pointer;
  }
  .ik-gizmo-mode {
    margin-top: 8px;
    border-top: 1px solid #333;
    padding-top: 6px;
  }
  .section-label {
    font-size: 10px;
    color: #666;
    display: block;
    margin-bottom: 4px;
  }
  .grab-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #bbb;
    margin-bottom: 3px;
  }
  .grab-row span { width: 16px; }
  .grab-row input[type="range"] { flex: 1; accent-color: #4af; }
  .mode-btns {
    display: flex;
    gap: 4px;
  }
  .mode-btn {
    flex: 1;
    padding: 3px 0;
    background: #2a2a2a;
    border: 1px solid #444;
    color: #999;
    cursor: pointer;
    border-radius: 3px;
    font-size: 11px;
  }
  .mode-btn:hover { background: #333; }
  .mode-btn.active { background: #1a3a5a; border-color: #4af; color: #4af; }

  .timeline-resizer {
    flex-shrink: 0;
    height: 6px;
    cursor: ns-resize;
    background: #2a2a2a;
    border-top: 1px solid #1a1a1a;
  }
  .timeline-resizer:hover { background: #4a6aa0; }
  .timeline-area {
    flex-shrink: 0;
    overflow: hidden;
    border-top: 1px solid #333;
  }
</style>
