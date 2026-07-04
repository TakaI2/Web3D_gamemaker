<script lang="ts">
  import { tick } from 'svelte';
  import type { Quaternion, Vector3 } from 'three';
  import { animEditorStore } from '../stores/animEditorStore';

  const ROW_HEIGHT = 24;
  const HEADER_WIDTH = 140;
  const MIN_PPF = 2;
  const MAX_PPF = 60;

  let pixelPerFrame = 8;
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

  // 行数 +1（最下段の「ルート位置」行）
  $: hipsRowIndex = boneRows.length + exprRows.length;
  $: hipsY = 24 + hipsRowIndex * ROW_HEIGHT;

  // SVG サイズ
  $: timelineWidth = Math.max(400, totalFrames * pixelPerFrame + HEADER_WIDTH + 20);
  $: timelineHeight = Math.max(120, (allRows.length + 1) * ROW_HEIGHT + 30);

  // プレイヘッド X 座標
  $: playheadX = HEADER_WIDTH + state.currentFrame * pixelPerFrame;

  // トリム範囲（In/Out）。outFrame<0 は未設定＝末尾(totalFrames)。
  let inFrame = 0;
  let outFrame = -1;
  $: effOut = outFrame < 0 ? totalFrames : Math.max(0, Math.min(outFrame, totalFrames));
  $: effIn = Math.max(0, Math.min(inFrame, effOut));

  // 選択キーフレーム（複数選択）。id = "<kind>|<track>|<frame>"。kind: 'b'=ボーン / 'e'=表情 / 'h'=ルート位置
  type KeyKind = 'b' | 'e' | 'h';
  let selectedKeys = new Set<string>();
  const keyId = (track: string, frame: number, kind: KeyKind) => `${kind}|${track}|${frame}`;
  function parseKeyId(id: string): { track: string; frame: number; kind: KeyKind } {
    const kind = id[0] as KeyKind;
    const rest = id.slice(id.indexOf('|') + 1);
    const lastSep = rest.lastIndexOf('|');
    return { track: rest.slice(0, lastSep), frame: Number(rest.slice(lastSep + 1)), kind };
  }
  function deleteKeyId(id: string): void {
    const { track, frame, kind } = parseKeyId(id);
    if (kind === 'b') animEditorStore.removeBoneKeyframe(track, frame);
    else if (kind === 'e') animEditorStore.removeBlendShapeKeyframe(track, frame);
    else animEditorStore.removeHipsPositionKeyframe(frame);
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
    const collect = (track: string, frames: Iterable<number>, rowIndex: number, kind: KeyKind) => {
      const ky = rowY(rowIndex) + ROW_HEIGHT / 2;
      if (ky < minY || ky > maxY) return;
      for (const f of frames) {
        const kx = frameToX(f);
        if (kx >= minX && kx <= maxX) next.add(keyId(track, f, kind));
      }
    };
    boneRows.forEach((b, i) => collect(b, state.boneKeyframes.get(b)?.keys() ?? [], i, 'b'));
    exprRows.forEach((ex, i) => collect(ex, state.blendShapeKeyframes.get(ex)?.keys() ?? [], boneRows.length + i, 'e'));
    collect('', state.hipsPositionKeyframes.keys(), boneRows.length + exprRows.length, 'h');
    selectedKeys = next;
  }

  // ホイール:
  //  ・上部タイムスケール（ルーラー帯, y<24）上 / Ctrl(⌘) = カーソル中心ズーム
  //  ・Shift = 横スクロール
  //  ・それ以外 = 行の縦スクロール（キーが増えても見られる）
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const svgY = e.clientY - svgEl.getBoundingClientRect().top;   // SVG ローカル y（スクロール込み）
    const overRuler = svgY < 24;
    if (e.shiftKey && !overRuler) { containerEl.scrollLeft += e.deltaY; return; }   // 横スクロール
    if (!overRuler && !e.ctrlKey && !e.metaKey) { containerEl.scrollTop += e.deltaY; return; }   // 縦スクロール（既定）
    // ズーム（カーソル下のフレームを中心に）
    const rect = containerEl.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const frameAtCursor = Math.max(0, (containerEl.scrollLeft + mouseX - HEADER_WIDTH) / pixelPerFrame);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newPpf = Math.max(MIN_PPF, Math.min(MAX_PPF, pixelPerFrame * factor));
    if (newPpf === pixelPerFrame) return;
    pixelPerFrame = newPpf;
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
  function onKeyMouseDown(e: MouseEvent, track: string, frame: number, kind: KeyKind): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    const id = keyId(track, frame, kind);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const next = new Set(selectedKeys);
      if (next.has(id)) next.delete(id); else next.add(id);
      selectedKeys = next;
    } else {
      selectedKeys = new Set([id]);
    }
  }

  // キーフレーム右クリック：その1個を削除
  function onKeyContext(track: string, frame: number, kind: KeyKind): void {
    deleteKeyId(keyId(track, frame, kind));
    const next = new Set(selectedKeys); next.delete(keyId(track, frame, kind)); selectedKeys = next;
  }

  // キーのコピー＆ペースト。最小フレームを基準に相対オフセットを保持し、現在フレームへ貼り付ける。
  type ClipItem = { track: string; kind: KeyKind; offset: number; quat?: Quaternion; value?: number; pos?: Vector3 };
  let clipboard: ClipItem[] = [];

  function copySelected(): void {
    if (selectedKeys.size === 0) return;
    let anchor = Infinity;
    for (const id of selectedKeys) { const { frame } = parseKeyId(id); if (frame < anchor) anchor = frame; }
    const items: ClipItem[] = [];
    for (const id of selectedKeys) {
      const { track, frame, kind } = parseKeyId(id);
      const offset = frame - anchor;
      if (kind === 'b') {
        const q = state.boneKeyframes.get(track)?.get(frame);
        if (q) items.push({ track, kind, offset, quat: q.clone() });
      } else if (kind === 'e') {
        const v = state.blendShapeKeyframes.get(track)?.get(frame);
        if (v != null) items.push({ track, kind, offset, value: v });
      } else {
        const p = state.hipsPositionKeyframes.get(frame);
        if (p) items.push({ track, kind, offset, pos: p.clone() });
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
      if (it.kind === 'b' && it.quat) {
        animEditorStore.setBoneKeyframe(it.track, f, it.quat.clone());
        next.add(keyId(it.track, f, 'b'));
      } else if (it.kind === 'e' && it.value != null) {
        animEditorStore.setBlendShapeKeyframe(it.track, f, it.value);
        next.add(keyId(it.track, f, 'e'));
      } else if (it.kind === 'h' && it.pos) {
        animEditorStore.setHipsPositionKeyframe(f, it.pos.clone());
        next.add(keyId('', f, 'h'));
      }
    }
    selectedKeys = next;   // 貼り付けたキーを選択状態に
  }

  // ── トリム / 範囲操作 ──（詰める真のトリム。範囲は In/Out・全トラック対象）
  function clearSel(): void { selectedKeys = new Set(); }
  function doTrimBefore(): void { animEditorStore.trimBefore(state.currentFrame); inFrame = 0; outFrame = -1; clearSel(); }
  function doTrimAfter(): void { animEditorStore.trimAfter(state.currentFrame); clearSel(); }
  function setIn(): void { inFrame = state.currentFrame; }
  function setOut(): void { outFrame = state.currentFrame; }
  function doCopyRange(): void { animEditorStore.copyRange(effIn, effOut); }
  function doDeleteRange(): void { animEditorStore.deleteRange(effIn, effOut); inFrame = 0; outFrame = -1; clearSel(); }
  function doPasteRange(): void { animEditorStore.pasteRange(state.currentFrame); clearSel(); }

  // Del=一括削除 / Ctrl(⌘)+C=コピー / Ctrl(⌘)+V=現在フレームへ貼り付け / I,O=In,Out設定
  function onKeyDown(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement | null;
    if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'c' || e.key === 'C')) { copySelected(); return; }
    if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteAtCurrent(); return; }
    if (!mod && (e.key === 'i' || e.key === 'I')) { inFrame = state.currentFrame; return; }
    if (!mod && (e.key === 'o' || e.key === 'O')) { outFrame = state.currentFrame; return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedKeys.size === 0) return;
      e.preventDefault();
      for (const id of selectedKeys) deleteKeyId(id);
      selectedKeys = new Set();
    }
  }
</script>

<svelte:window on:keydown={onKeyDown} />

<div style="display:flex;flex-direction:column;height:100%;">
<!-- トリム/範囲ツールバー -->
<div class="trim-bar">
  <span class="lbl">トリム</span>
  <button on:click={doTrimBefore} title="現在フレームより前を削除して詰める">⟤前を削除</button>
  <button on:click={doTrimAfter} title="現在フレームより後を削除">後を削除⟥</button>
  <span class="sep"></span>
  <span style="color:#3c9;">範囲 {effIn}–{effOut}</span>
  <button on:click={setIn} title="現在フレームをInに (I)">In=現在</button>
  <button on:click={setOut} title="現在フレームをOutに (O)">Out=現在</button>
  <button on:click={doCopyRange} title="範囲の全トラックをコピー">コピー</button>
  <button on:click={doDeleteRange} title="範囲を削除して詰める">範囲削除</button>
  <button on:click={doPasteRange} title="現在フレームへ貼り付け">貼付</button>
</div>

<div
  bind:this={containerEl}
  style="flex:1;min-height:0;overflow-x:auto;overflow-y:auto;background:#1a1a1a;user-select:none;"
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
        {@const sel = selectedKeys.has(keyId(boneName, frame, 'b'))}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={sel ? '#ffaa00' : '#4af'}
          stroke={sel ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:mousedown={(e) => onKeyMouseDown(e, boneName, frame, 'b')}
          on:contextmenu|preventDefault|stopPropagation={() => onKeyContext(boneName, frame, 'b')}
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
        {@const sel = selectedKeys.has(keyId(exprName, frame, 'e'))}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <polygon
          points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
          fill={sel ? '#ffaa00' : '#f8a'}
          stroke={sel ? '#fff' : 'none'}
          stroke-width="1"
          style="cursor:pointer"
          on:mousedown={(e) => onKeyMouseDown(e, exprName, frame, 'e')}
          on:contextmenu|preventDefault|stopPropagation={() => onKeyContext(exprName, frame, 'e')}
        />
      {/each}
    {/each}

    <!-- ルート位置（腰移動）行 -->
    <rect x={0} y={hipsY} width={timelineWidth} height={ROW_HEIGHT} fill={hipsRowIndex % 2 === 0 ? '#1e2a1e' : '#22301f'} />
    <text x={4} y={hipsY + 15} fill="#8d8" font-size="11">⌖ ルート位置</text>
    {#each [...state.hipsPositionKeyframes.keys()] as frame}
      {@const kx = frameToX(frame)}
      {@const ky = hipsY + ROW_HEIGHT / 2}
      {@const sel = selectedKeys.has(keyId('', frame, 'h'))}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <polygon
        points="{kx},{ky - 6} {kx + 5},{ky} {kx},{ky + 6} {kx - 5},{ky}"
        fill={sel ? '#ffaa00' : '#6c6'}
        stroke={sel ? '#fff' : 'none'}
        stroke-width="1"
        style="cursor:pointer"
        on:mousedown={(e) => onKeyMouseDown(e, '', frame, 'h')}
        on:contextmenu|preventDefault|stopPropagation={() => onKeyContext('', frame, 'h')}
      />
    {/each}

    <!-- トリム範囲（In/Out）帯 -->
    {#if effOut > effIn}
      <rect x={frameToX(effIn)} y={0} width={Math.max(0, frameToX(effOut) - frameToX(effIn))} height={timelineHeight}
        fill="#33cc88" fill-opacity="0.08" pointer-events="none" />
      <line x1={frameToX(effIn)} y1={0} x2={frameToX(effIn)} y2={timelineHeight} stroke="#33cc88" stroke-width="1.5" pointer-events="none" />
      <line x1={frameToX(effOut)} y1={0} x2={frameToX(effOut)} y2={timelineHeight} stroke="#33cc88" stroke-width="1.5" pointer-events="none" />
    {/if}

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
</div>

<style>
  .trim-bar { flex-shrink: 0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 3px 6px; background: #111; border-bottom: 1px solid #333; font-size: 11px; color: #aaa; }
  .trim-bar .lbl { color: #777; }
  .trim-bar .sep { width: 1px; height: 14px; background: #333; margin: 0 2px; }
  .trim-bar button { background: #2a2a2a; color: #ccd; border: 1px solid #444; border-radius: 3px; padding: 2px 7px; font-size: 11px; cursor: pointer; }
  .trim-bar button:hover { background: #3a3a3a; }
</style>
