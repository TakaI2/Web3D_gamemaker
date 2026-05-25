<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
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
    const state = get(vrmStore);
    if (!state.vrm) {
      appModeStore.toEditor();
      return;
    }
    vrm = state.vrm;
  });

  function goBack(): void {
    animEditorStore.close();
    appModeStore.toEditor();
  }

  function startNew(): void {
    animEditorStore.open(newDurationSec);
    dialogMode = 'ready';
  }

  async function openVrma(): Promise<void> {
    if (!vrmaFile || !vrm) return;
    loadError = '';
    try {
      // AnimationManager を経由せず raw VRMAnimation を直接取得する
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      const url = URL.createObjectURL(vrmaFile);
      try {
        const gltf = await loader.loadAsync(url);
        const vrmAnim = gltf.userData.vrmAnimations?.[0];
        if (!vrmAnim) throw new Error('VRMA データが見つかりません');
        animEditorStore.importFromVrmAnimation(vrmAnim, vrm);
        dialogMode = 'ready';
      } finally {
        URL.revokeObjectURL(url);
      }
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
</script>

<!-- ダイアログ（起動時） -->
{#if dialogMode === 'choose'}
  <div class="overlay">
    <div class="dialog">
      <h2>アニメーション編集</h2>
      {#if !vrm}
        <p class="warn">VRM が読み込まれていません。エディタに戻ってください。</p>
        <button on:click={goBack}>← エディタへ戻る</button>
      {:else}
        <div class="dialog-btns">
          <button class="big-btn" on:click={() => (dialogMode = 'new')}>
            ＋ 新規作成
          </button>
          <button class="big-btn" on:click={() => (dialogMode = 'open')}>
            📂 VRMA を開く
          </button>
        </div>
        <button class="back-link" on:click={goBack}>← キャンセル</button>
      {/if}
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
      <input type="file" accept=".vrma" on:change={(e) => (vrmaFile = e.currentTarget.files?.[0] ?? null)} />
      {#if loadError}<p class="error">{loadError}</p>{/if}
      <div class="dialog-btns">
        <button class="big-btn" on:click={openVrma} disabled={!vrmaFile}>読み込む</button>
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
        </div>

        <!-- フェイシャル -->
        <AnimEditorFacial {vrm} />
      </div>
    </div>

    <!-- 再生コントロール -->
    <AnimEditorControls {vrm} />

    <!-- タイムライン -->
    <div class="timeline-area">
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
  .error { color: #f66; font-size: 12px; }

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

  .timeline-area {
    flex-shrink: 0;
    height: 220px;
    overflow: hidden;
    border-top: 1px solid #333;
  }
</style>
