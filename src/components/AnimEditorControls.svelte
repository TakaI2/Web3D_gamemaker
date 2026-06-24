<script lang="ts">
  import type { VRM } from '@pixiv/three-vrm';
  import { animEditorStore } from '../stores/animEditorStore';
  import { buildVrmaBlob } from '../core/VrmaBuilder';
  import type { VrmaTrackInput, VrmaBlendShapeInput } from '../core/VrmaBuilder';
  import * as THREE from 'three';

  export let vrm: VRM;

  $: state = $animEditorStore;
  $: totalFrames = Math.round(state.durationSec * state.fps);

  function play(): void { animEditorStore.setPlaying(true); }
  function stop(): void { animEditorStore.setPlaying(false); }
  function toStart(): void {
    animEditorStore.setPlaying(false);
    animEditorStore.setCurrentFrame(0);
  }
  function toggleLoop(): void { animEditorStore.setLooping(!state.isLooping); }

  function download(): void {
    // T-pose 時の rest quaternion を取得（ヒューマノイドボーン名でルックアップ）。
    // resetNormalizedPose だけでは raw ボーンに反映されない（normalized→raw のコピーは update が行う）。
    // update() を呼ばないと、編集中の「現在ポーズ」が rest として読まれ、書き出しが現在ポーズぶんズレる。
    vrm.humanoid.resetNormalizedPose();
    vrm.humanoid.update();
    vrm.scene.updateWorldMatrix(true, true);

    // ボーントラックを構築（delta = restQuat_inv ⊗ frameQuat）
    const tracks: VrmaTrackInput[] = [];
    const fps = state.fps;

    for (const [boneName, frameMap] of state.boneKeyframes) {
      const frames = [...frameMap.keys()].sort((a, b) => a - b);
      if (frames.length === 0) continue;

      const times = new Float32Array(frames.map((f) => f / fps));
      const values = new Float32Array(frames.length * 4);

      const rawBone = vrm.humanoid.getRawBoneNode(
        boneName as Parameters<typeof vrm.humanoid.getRawBoneNode>[0],
      );
      const restQ = rawBone ? rawBone.quaternion.clone() : new THREE.Quaternion();
      const restInv = restQ.clone().invert();

      frames.forEach((f, i) => {
        const frameQ = frameMap.get(f)!;
        const delta = restInv.clone().multiply(frameQ);
        values[i * 4]     = delta.x;
        values[i * 4 + 1] = delta.y;
        values[i * 4 + 2] = delta.z;
        values[i * 4 + 3] = delta.w;
      });

      tracks.push({ boneName, times, values });
    }

    // ブレンドシェイプトラックを構築
    const blendShapes: VrmaBlendShapeInput[] = [];
    for (const [exprName, frameMap] of state.blendShapeKeyframes) {
      const frames = [...frameMap.keys()].sort((a, b) => a - b);
      if (frames.length === 0) continue;
      const times = new Float32Array(frames.map((f) => f / fps));
      const values = new Float32Array(frames.map((f) => frameMap.get(f)!));
      blendShapes.push({ expressionName: exprName, times, values });
    }

    // hips の rest Y 座標
    let hipsRestY = 0;
    const hipsBone = vrm.humanoid.getRawBoneNode('hips');
    if (hipsBone) {
      const wp = new THREE.Vector3();
      hipsBone.getWorldPosition(wp);
      hipsRestY = wp.y;
    }

    // ヒップ位置トラック（キーフレームが存在する場合のみ）
    let hipPositionTrack: { times: Float32Array; values: Float32Array } | undefined;
    if (state.hipsPositionKeyframes.size > 0) {
      const hFrames = [...state.hipsPositionKeyframes.keys()].sort((a, b) => a - b);
      const hTimes = new Float32Array(hFrames.map((f) => f / fps));
      const hValues = new Float32Array(hFrames.length * 3);
      hFrames.forEach((f, i) => {
        const pos = state.hipsPositionKeyframes.get(f)!;
        hValues[i * 3]     = pos.x;
        hValues[i * 3 + 1] = pos.y;
        hValues[i * 3 + 2] = pos.z;
      });
      hipPositionTrack = { times: hTimes, values: hValues };
    }

    const blob = buildVrmaBlob({
      durationSec: state.durationSec,
      hipsRestY,
      tracks,
      blendShapes: blendShapes.length > 0 ? blendShapes : undefined,
      hipPositionTrack,
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.outputFilename || 'output.vrma';
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="controls-bar">
  <button class="ctrl-btn" on:click={toStart} title="先頭へ">⏮</button>
  {#if state.isPlaying}
    <button class="ctrl-btn active" on:click={stop} title="停止">■</button>
  {:else}
    <button class="ctrl-btn" on:click={play} title="再生">▶</button>
  {/if}
  <button
    class="ctrl-btn"
    class:active={state.isLooping}
    on:click={toggleLoop}
    title="ループ"
  >⟳</button>

  <span class="frame-label">
    {state.currentFrame} / {totalFrames}
    <span class="sec-label">({(state.currentFrame / state.fps).toFixed(2)}s)</span>
  </span>

  <button class="dl-btn" on:click={download}>↓ ダウンロード</button>
</div>

<style>
  .controls-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: #1e1e1e;
    border-top: 1px solid #333;
    border-bottom: 1px solid #333;
  }
  .ctrl-btn {
    background: #2a2a2a;
    border: 1px solid #444;
    color: #ccc;
    padding: 4px 10px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 14px;
    transition: background 0.1s;
  }
  .ctrl-btn:hover { background: #3a3a3a; }
  .ctrl-btn.active { background: #334; color: #88f; border-color: #66c; }
  .frame-label {
    font-size: 12px;
    color: #888;
    margin: 0 8px;
    flex: 1;
  }
  .sec-label { color: #555; }
  .dl-btn {
    background: #1a3a1a;
    border: 1px solid #2a5a2a;
    color: #6d6;
    padding: 4px 14px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .dl-btn:hover { background: #2a4a2a; }
</style>
