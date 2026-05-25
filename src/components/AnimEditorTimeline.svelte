<script lang="ts">
  import { animEditorStore } from '../stores/animEditorStore';

  const ROW_HEIGHT = 24;
  const HEADER_WIDTH = 140;
  const MIN_PPF = 2;
  const MAX_PPF = 40;

  let pixelPerFrame = 8;
  let scrollY = 0;
  let svgEl: SVGSVGElement;
  let containerEl: HTMLDivElement;

  // VRM 主要ヒューマノイドボーン（常に表示）
  const HUMANOID_BONES = [
    'hips','spine','chest','upperChest','neck','head',
    'leftShoulder','leftUpperArm','leftLowerArm','leftHand',
    'rightShoulder','rightUpperArm','rightLowerArm','rightHand',
    'leftUpperLeg','leftLowerLeg','leftFoot','leftToes',
    'rightUpperLeg','rightLowerLeg','rightFoot','rightToes',
  ];

  $: state = $animEditorStore;
  $: totalFrames = Math.round(state.durationSec * state.fps);

  // ボーン行: キーフレームのあるボーンを先に、残りの標準ボーンを追加
  $: {
    const keyed = [...state.boneKeyframes.keys()];
    const rest = HUMANOID_BONES.filter((b) => !keyed.includes(b));
    boneRows = [...keyed, ...rest];
  }
  let boneRows: string[] = HUMANOID_BONES;
  $: exprRows = [...state.blendShapeKeyframes.keys()];
  $: allRows = [...boneRows, ...exprRows];

  // SVG サイズ
  $: timelineWidth = Math.max(400, totalFrames * pixelPerFrame + HEADER_WIDTH + 20);
  $: timelineHeight = Math.max(120, allRows.length * ROW_HEIGHT + 30);

  // プレイヘッド X 座標
  $: playheadX = HEADER_WIDTH + state.currentFrame * pixelPerFrame;

  // 選択キーフレーム
  let selectedKey: { track: string; frame: number; isBone: boolean } | null = null;

  function frameToX(frame: number): number {
    return HEADER_WIDTH + frame * pixelPerFrame;
  }

  function rowY(index: number): number {
    return 24 + index * ROW_HEIGHT;
  }

  // プレイヘッドドラッグ
  let draggingPlayhead = false;
  function onPlayheadMouseDown(e: MouseEvent): void {
    draggingPlayhead = true;
    e.stopPropagation();
  }
  function onSvgMouseMove(e: MouseEvent): void {
    if (!draggingPlayhead) return;
    const rect = svgEl.getBoundingClientRect();
    const x = e.clientX - rect.left - HEADER_WIDTH;
    const frame = Math.max(0, Math.min(totalFrames, Math.round(x / pixelPerFrame)));
    animEditorStore.setCurrentFrame(frame);
  }
  function onSvgMouseUp(): void {
    draggingPlayhead = false;
  }

  // タイムライン背景クリックでシーク
  function onBgClick(e: MouseEvent): void {
    const rect = svgEl.getBoundingClientRect();
    const x = e.clientX - rect.left - HEADER_WIDTH;
    if (x < 0) return;
    const frame = Math.max(0, Math.min(totalFrames, Math.round(x / pixelPerFrame)));
    animEditorStore.setCurrentFrame(frame);
  }

  // Ctrl+Wheel でズーム、通常Wheelはスクロールに委ねる
  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -1 : 1;
    pixelPerFrame = Math.max(MIN_PPF, Math.min(MAX_PPF, pixelPerFrame + delta));
  }

  // キーフレームクリック
  function onKeyClick(e: MouseEvent, track: string, frame: number, isBone: boolean): void {
    e.stopPropagation();
    selectedKey = { track, frame, isBone };
  }

  // Delete キー
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Delete' || !selectedKey) return;
    if (selectedKey.isBone) {
      animEditorStore.removeBoneKeyframe(selectedKey.track, selectedKey.frame);
    } else {
      animEditorStore.removeBlendShapeKeyframe(selectedKey.track, selectedKey.frame);
    }
    selectedKey = null;
  }
</script>

<svelte:window on:keydown={onKeyDown} />

<div
  bind:this={containerEl}
  style="overflow-x:auto;overflow-y:auto;background:#1a1a1a;user-select:none;height:100%;"
  on:wheel={onWheel}
>
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <svg
    bind:this={svgEl}
    width={timelineWidth}
    height={timelineHeight}
    on:mousemove={onSvgMouseMove}
    on:mouseup={onSvgMouseUp}
    on:click={onBgClick}
    style="display:block;"
  >
    <!-- 背景グリッド -->
    {#each Array(Math.ceil(totalFrames / 10) + 1) as _, i}
      {@const x = HEADER_WIDTH + i * 10 * pixelPerFrame}
      <line x1={x} y1={0} x2={x} y2={timelineHeight} stroke="#333" stroke-width="1" />
      <text x={x + 2} y={14} fill="#666" font-size="10">{i * 10}</text>
    {/each}

    <!-- トラック行 -->
    {#each boneRows as boneName, i}
      {@const y = rowY(i)}
      <!-- 行背景 -->
      <rect x={0} y={y} width={timelineWidth} height={ROW_HEIGHT}
        fill={i % 2 === 0 ? '#1e1e1e' : '#222'} />
      <!-- ラベル -->
      <text x={4} y={y + 15} fill="#aaa" font-size="11">{boneName}</text>
      <!-- キーフレームマーカー（菱形） -->
      {#each [...(state.boneKeyframes.get(boneName)?.keys() ?? [])] as frame}
        {@const kx = frameToX(frame)}
        {@const ky = y + ROW_HEIGHT / 2}
        {@const isSelected = selectedKey?.track === boneName && selectedKey.frame === frame}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={isSelected ? '#ffaa00' : '#4af'}
          stroke={isSelected ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:click={(e) => onKeyClick(e, boneName, frame, true)}
        />
      {/each}
    {/each}

    {#each exprRows as exprName, i}
      {@const rowIdx = boneRows.length + i}
      {@const y = rowY(rowIdx)}
      <rect x={0} y={y} width={timelineWidth} height={ROW_HEIGHT}
        fill={rowIdx % 2 === 0 ? '#1e1e2a' : '#22222a'} />
      <text x={4} y={y + 15} fill="#b8a" font-size="11">😊 {exprName}</text>
      {#each [...(state.blendShapeKeyframes.get(exprName)?.keys() ?? [])] as frame}
        {@const kx = frameToX(frame)}
        {@const ky = y + ROW_HEIGHT / 2}
        {@const isSelected = selectedKey?.track === exprName && selectedKey.frame === frame}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={isSelected ? '#ffaa00' : '#f8a'}
          stroke={isSelected ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:click={(e) => onKeyClick(e, exprName, frame, false)}
        />
      {/each}
    {/each}

    <!-- プレイヘッド -->
    <line
      x1={playheadX} y1={0} x2={playheadX} y2={timelineHeight}
      stroke="#ff4" stroke-width="2"
    />
    <!-- プレイヘッドのドラッグハンドル -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <polygon
      points="{playheadX - 6},0 {playheadX + 6},0 {playheadX},10"
      fill="#ff4"
      style="cursor:ew-resize"
      on:mousedown={onPlayheadMouseDown}
    />
  </svg>
</div>
