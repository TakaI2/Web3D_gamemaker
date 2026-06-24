<script lang="ts">
  import { tick } from 'svelte';
  import type { Quaternion } from 'three';
  import { animEditorStore } from '../stores/animEditorStore';

  const ROW_HEIGHT = 24;
  const HEADER_WIDTH = 140;
  const MIN_PPF = 2;
  const MAX_PPF = 60;

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

  // 選択キーフレーム（複数選択）。id = "b|track|frame"（bone）/ "e|track|frame"（expr）
  let selectedKeys = new Set<string>();
  const keyId = (track: string, frame: number, isBone: boolean) => `${isBone ? 'b' : 'e'}|${track}|${frame}`;
  function parseKeyId(id: string): { track: string; frame: number; isBone: boolean } {
    const isBone = id[0] === 'b';
    const rest = id.slice(id.indexOf('|') + 1);
    const lastSep = rest.lastIndexOf('|');
    return { track: rest.slice(0, lastSep), frame: Number(rest.slice(lastSep + 1)), isBone };
  }
  function deleteKeyId(id: string): void {
    const { track, frame, isBone } = parseKeyId(id);
    if (isBone) animEditorStore.removeBoneKeyframe(track, frame);
    else animEditorStore.removeBlendShapeKeyframe(track, frame);
  }

  function frameToX(frame: number): number {
    return HEADER_WIDTH + frame * pixelPerFrame;
  }

  function rowY(index: number): number {
    return 24 + index * ROW_HEIGHT;
  }

  // svg ローカル座標
  function svgXY(e: MouseEvent): { x: number; y: number } {
    const r = svgEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // プレイヘッドドラッグ
  let draggingPlayhead = false;
  function onPlayheadMouseDown(e: MouseEvent): void {
    draggingPlayhead = true;
    e.stopPropagation();
  }

  // 背景の mousedown：マーキー（ボックス選択）開始 or クリックでシーク。中ボタン/Alt はパンに委ねる。
  let marqueeStart: { x: number; y: number } | null = null;
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  function onSvgMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || e.altKey) return;   // 左ボタンのみ。Alt+左/中ボタンはパン
    const p = svgXY(e);
    marqueeStart = p;
    marquee = null;
  }
  function onSvgMouseMove(e: MouseEvent): void {
    if (draggingPlayhead) {
      const x = svgXY(e).x - HEADER_WIDTH;
      animEditorStore.setCurrentFrame(Math.max(0, Math.min(totalFrames, Math.round(x / pixelPerFrame))));
      return;
    }
    if (marqueeStart) {
      const p = svgXY(e);
      if (Math.abs(p.x - marqueeStart.x) + Math.abs(p.y - marqueeStart.y) > 3) {
        marquee = { x0: marqueeStart.x, y0: marqueeStart.y, x1: p.x, y1: p.y };
      }
    }
  }
  function onSvgMouseUp(e: MouseEvent): void {
    if (draggingPlayhead) { draggingPlayhead = false; return; }
    if (marquee) {
      finalizeMarquee();
      marquee = null; marqueeStart = null;
      return;
    }
    // ドラッグなし＝クリック → シーク（パン直後/Alt は無視）
    marqueeStart = null;
    if (panMoved) { panMoved = false; return; }
    if (e.altKey) return;
    const x = svgXY(e).x - HEADER_WIDTH;
    if (x < 0) return;
    animEditorStore.setCurrentFrame(Math.max(0, Math.min(totalFrames, Math.round(x / pixelPerFrame))));
  }

  // マーキー矩形内のキーフレームを一括選択
  function finalizeMarquee(): void {
    if (!marquee) return;
    const minX = Math.min(marquee.x0, marquee.x1), maxX = Math.max(marquee.x0, marquee.x1);
    const minY = Math.min(marquee.y0, marquee.y1), maxY = Math.max(marquee.y0, marquee.y1);
    const next = new Set<string>();
    const collect = (track: string, frames: Iterable<number>, rowIndex: number, isBone: boolean) => {
      const ky = rowY(rowIndex) + ROW_HEIGHT / 2;
      if (ky < minY || ky > maxY) return;
      for (const f of frames) {
        const kx = frameToX(f);
        if (kx >= minX && kx <= maxX) next.add(keyId(track, f, isBone));
      }
    };
    boneRows.forEach((b, i) => collect(b, state.boneKeyframes.get(b)?.keys() ?? [], i, true));
    exprRows.forEach((ex, i) => collect(ex, state.blendShapeKeyframes.get(ex)?.keys() ?? [], boneRows.length + i, false));
    selectedKeys = next;
  }

  // ホイール: 通常=カーソル下のフレームを中心に拡大縮小 / Shift=行の縦スクロール
  // （cloth-preview と同じ操作感。Ctrl は不要）
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.shiftKey) {
      containerEl.scrollTop += e.deltaY;
      return;
    }
    const rect = containerEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const frameAtCursor = Math.max(0, (containerEl.scrollLeft + mouseX - HEADER_WIDTH) / pixelPerFrame);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newPpf = Math.max(MIN_PPF, Math.min(MAX_PPF, pixelPerFrame * factor));
    if (newPpf === pixelPerFrame) return;
    pixelPerFrame = newPpf;
    // 幅が変わってから、カーソル下のフレームが同じ画面位置に来るようスクロール補正
    tick().then(() => {
      containerEl.scrollLeft = Math.max(0, frameAtCursor * newPpf - (mouseX - HEADER_WIDTH));
    });
  }

  // パン（平行移動）: 中ボタン or Alt+左ドラッグで縦横スクロール
  let panning = false;
  let panMoved = false;
  let panButton = -1;
  let panStartX = 0, panStartY = 0, panScrollLeft = 0, panScrollTop = 0;
  function onPanDown(e: PointerEvent): void {
    if (e.button !== 1 && !(e.button === 0 && e.altKey)) return;
    e.preventDefault();
    panning = true; panMoved = false; panButton = e.button;
    panStartX = e.clientX; panStartY = e.clientY;
    panScrollLeft = containerEl.scrollLeft; panScrollTop = containerEl.scrollTop;
    window.addEventListener('pointermove', onPanMove);
    window.addEventListener('pointerup', onPanUp);
  }
  function onPanMove(e: PointerEvent): void {
    if (!panning) return;
    const dx = e.clientX - panStartX, dy = e.clientY - panStartY;
    if (Math.abs(dx) + Math.abs(dy) > 2) panMoved = true;
    containerEl.scrollLeft = Math.max(0, panScrollLeft - dx);
    containerEl.scrollTop  = Math.max(0, panScrollTop  - dy);
  }
  function onPanUp(): void {
    panning = false;
    // 中ボタンは後続クリックが無いので即リセット。Alt+左はこの後の mouseup(シーク)を panMoved で抑制する。
    if (panButton !== 0) panMoved = false;
    panButton = -1;
    window.removeEventListener('pointermove', onPanMove);
    window.removeEventListener('pointerup', onPanUp);
  }

  // キーフレーム mousedown：単体選択（Shift/Ctrl で追加トグル）。マーキー/シークは抑制。
  function onKeyMouseDown(e: MouseEvent, track: string, frame: number, isBone: boolean): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    const id = keyId(track, frame, isBone);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selectedKeys);
      if (next.has(id)) next.delete(id); else next.add(id);
      selectedKeys = next;
    } else {
      selectedKeys = new Set([id]);
    }
  }

  // キーフレーム右クリック：その1個を削除
  function onKeyContext(track: string, frame: number, isBone: boolean): void {
    if (isBone) animEditorStore.removeBoneKeyframe(track, frame);
    else animEditorStore.removeBlendShapeKeyframe(track, frame);
    const next = new Set(selectedKeys); next.delete(keyId(track, frame, isBone)); selectedKeys = next;
  }

  // キーのコピー＆ペースト。最小フレームを基準に相対オフセットを保持し、現在フレームへ貼り付ける。
  type ClipItem = { track: string; isBone: boolean; offset: number; quat?: Quaternion; value?: number };
  let clipboard: ClipItem[] = [];

  function copySelected(): void {
    if (selectedKeys.size === 0) return;
    let anchor = Infinity;
    for (const id of selectedKeys) { const { frame } = parseKeyId(id); if (frame < anchor) anchor = frame; }
    const items: ClipItem[] = [];
    for (const id of selectedKeys) {
      const { track, frame, isBone } = parseKeyId(id);
      if (isBone) {
        const q = state.boneKeyframes.get(track)?.get(frame);
        if (q) items.push({ track, isBone: true, offset: frame - anchor, quat: q.clone() });
      } else {
        const v = state.blendShapeKeyframes.get(track)?.get(frame);
        if (v != null) items.push({ track, isBone: false, offset: frame - anchor, value: v });
      }
    }
    clipboard = items;
  }

  function pasteAtCurrent(): void {
    if (clipboard.length === 0) return;
    const base = state.currentFrame;
    const next = new Set<string>();
    for (const it of clipboard) {
      const f = Math.max(0, Math.min(totalFrames, base + it.offset));
      if (it.isBone && it.quat) {
        animEditorStore.setBoneKeyframe(it.track, f, it.quat.clone());
        next.add(keyId(it.track, f, true));
      } else if (!it.isBone && it.value != null) {
        animEditorStore.setBlendShapeKeyframe(it.track, f, it.value);
        next.add(keyId(it.track, f, false));
      }
    }
    selectedKeys = next;   // 貼り付けたキーを選択状態に
  }

  // Del=一括削除 / Ctrl(⌘)+C=コピー / Ctrl(⌘)+V=現在フレームへ貼り付け
  function onKeyDown(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'c' || e.key === 'C')) { copySelected(); return; }
    if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteAtCurrent(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedKeys.size === 0) return;
      e.preventDefault();
      for (const id of selectedKeys) deleteKeyId(id);
      selectedKeys = new Set();
    }
  }
</script>

<svelte:window on:keydown={onKeyDown} />

<div
  bind:this={containerEl}
  style="overflow-x:auto;overflow-y:auto;background:#1a1a1a;user-select:none;height:100%;"
  on:wheel|nonpassive={onWheel}
  on:pointerdown={onPanDown}
>
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <svg
    bind:this={svgEl}
    width={timelineWidth}
    height={timelineHeight}
    on:mousedown={onSvgMouseDown}
    on:mousemove={onSvgMouseMove}
    on:mouseup={onSvgMouseUp}
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
        {@const sel = selectedKeys.has(keyId(boneName, frame, true))}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={sel ? '#ffaa00' : '#4af'}
          stroke={sel ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:mousedown={(e) => onKeyMouseDown(e, boneName, frame, true)}
          on:contextmenu|preventDefault|stopPropagation={() => onKeyContext(boneName, frame, true)}
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
        {@const sel = selectedKeys.has(keyId(exprName, frame, false))}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={sel ? '#ffaa00' : '#f8a'}
          stroke={sel ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:mousedown={(e) => onKeyMouseDown(e, exprName, frame, false)}
          on:contextmenu|preventDefault|stopPropagation={() => onKeyContext(exprName, frame, false)}
        />
      {/each}
    {/each}

    <!-- マーキー（ボックス選択）矩形 -->
    {#if marquee}
      <rect
        x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
        width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
        fill="#4af" fill-opacity="0.15" stroke="#4af" stroke-width="1" stroke-dasharray="4 3"
      />
    {/if}

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
