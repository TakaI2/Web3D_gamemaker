# 設計書 - Cloth Preview

## 1. アーキテクチャ概要

### 1.1 ファイル構成

```
cloth-preview/
  index.html          # UI レイアウト・スタイル
  cloth-preview.js    # ロジック全体（ES Module）
```

### 1.2 モジュール構成（cloth-preview.js 内）

```
┌─────────────────────────────────────────────────────────┐
│  Init / Render Loop                                      │
├──────────────┬──────────────┬───────────────────────────┤
│  VRM Loader  │  Cloth Sim   │  VRMA Player               │
│  (流用)      │  (流用)      │  (AnimationMixer)          │
├──────────────┴──────────────┴───────────────────────────┤
│  Hand Grab Points (流用)                                 │
├─────────────────────────────────────────────────────────┤
│  Timeline State                                          │
│  ┌──────────────────┬──────────────────────────────┐   │
│  │ Grip Event Tracks│ BlendShape Tracks             │   │
│  │ (Set<frame> × 4) │ (Map<name, Map<frame,value>>) │   │
│  └──────────────────┴──────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  Timeline Renderer (Canvas 2D)                          │
├─────────────────────────────────────────────────────────┤
│  Event Dispatcher (再生中フレーム監視 → clothAPI 呼び出し)│
├─────────────────────────────────────────────────────────┤
│  BlendShape Interpolator (線形補間 → expressionManager) │
└─────────────────────────────────────────────────────────┘
```

### 1.3 CDN 依存

```js
import * as THREE          from 'https://esm.sh/three@0.184.0/webgpu';
import { ... }             from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls }   from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }      from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip }
                           from 'https://esm.sh/@pixiv/three-vrm-animation@3.4.0?deps=three@0.184.0,@pixiv/three-vrm@3.4.0';
```

---

## 2. 状態変数設計

### 2.1 流用する状態（cloth-editor.js から移植）

```js
// シーン
let renderer, scene, camera, controls;
const timer = new THREE.Timer();

// VRM
let currentVRM = null;

// マント（cloth.json）
let mantleData = null;
let mantleOrigPos = null;
const mantleTransform = { tx:0, ty:0, tz:0, ry:0, scale:1.0 };

// 布シミュ
let simRunning = false;
let simData = null;
let stiffnessUniform, dampeningUniform, windUniform;

// ピン・グリップセット（cloth.json から復元）
const pinnedSet = new Set();
const leftGripSet = new Set();
const rightGripSet = new Set();

// ハンドグラブポイント
const handGrabPoints = { left: {...}, right: {...} };
```

### 2.2 新規追加する状態

```js
// ── VRMA ──────────────────────────────────────────────
let mixer = null;              // THREE.AnimationMixer
let vrmaAction = null;         // THREE.AnimationAction
let vrmaClip = null;           // THREE.AnimationClip
let vrmaPlaying = false;
let vrmaLoop = true;
let vrmaSpeed = 1.0;

// ── タイムライン ─────────────────────────────────────
const TL_FPS = 30;             // デフォルト FPS

const timeline = {
  fps: TL_FPS,
  durationFrames: 90,          // VRMA 読み込み時に上書き
  currentFrame: 0,
  // グリップイベント: type → Set<frameIndex>
  grip: {
    gripLeft:     new Set(),
    gripRight:    new Set(),
    releaseLeft:  new Set(),
    releaseRight: new Set(),
  },
  // ブレンドシェイプ: exprName → Map<frameIndex, value(0-1)>
  blendShape: new Map(),
  // 選択中キーフレーム（ブレンドシェイプ編集用）
  selected: null,  // { kind:'blendShape', name, frame } | null
};

// ── タイムライン Canvas ───────────────────────────────
let tlCanvas, tlCtx;
let tlPxPerFrame = 8;          // ズーム
let tlScrollX = 0;             // 横スクロールオフセット (px)
let tlDraggingPlayhead = false;

// ── 直前フレーム（イベント二重発火防止）────────────────
let _lastDispatchedFrame = -1;
```

---

## 3. モジュール設計

### 3.1 VRM Loader（cloth-editor.js から流用・軽量化）

cloth-editor.js の `loadVRM()` / `unloadVRM()` / `buildCollidersFromVRM()` / `initHandGrabPoints()` をほぼそのままコピー。
差分：ピン・グリップ編集 UI は不要なので `updateMeshList()` / `selectMesh()` は削除。

### 3.2 Mantle Loader（流用）

`loadMantleJSON()` / `clearMantle()` / `applyMantleTransform()` をそのまま流用。
cloth.json 内の `leftGripIndices` / `rightGripIndices` / `pinnedIndices` を復元する。

### 3.3 Cloth Simulator（流用）

`buildSimulation()` / `disposeSimulation()` / `scheduleReadbacks()` をそのまま流用。
シミュ開始ボタンで `buildSimulation(mantleAnalysis)` を呼ぶ。

### 3.4 Hand Grab Points（流用）

`initHandGrabPoints()` / `updateHandGrabPoints()` / `disposeHandGrabPoints()` を流用。
`updateHandGrabPoints()` は render ループ内で毎フレーム呼ぶ。

### 3.5 VRMA Player（新規）

```js
// VRMA 読み込み
async function loadVRMA(file) {
  const loader = new GLTFLoader();
  loader.register(p => new VRMAnimationLoaderPlugin(p));
  const url = URL.createObjectURL(file);
  const gltf = await loader.loadAsync(url);
  URL.revokeObjectURL(url);

  const vrmAnim = gltf.userData.vrmAnimations?.[0];
  if (!vrmAnim) throw new Error('VRMA データが見つかりません');

  vrmaClip = createVRMAnimationClip(vrmAnim, currentVRM);
  mixer = new THREE.AnimationMixer(currentVRM.scene);
  vrmaAction = mixer.clipAction(vrmaClip);
  vrmaAction.setLoop(vrmaLoop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  vrmaAction.timeScale = vrmaSpeed;

  // タイムライン尺を VRMA に合わせる
  timeline.durationFrames = Math.round(vrmaClip.duration * timeline.fps);
  timeline.currentFrame = 0;
  _lastDispatchedFrame = -1;
  renderTimeline();
}

// 再生 / 停止
function vrmaPlay() { vrmaAction?.play(); vrmaPlaying = true; }
function vrmaPause() { vrmaAction?.paused = true; vrmaPlaying = false; }

// シーク（フレーム単位）
function vrmaSeek(frame) {
  if (!vrmaAction) return;
  const t = frame / timeline.fps;
  mixer.setTime(t);
  timeline.currentFrame = frame;
  _lastDispatchedFrame = frame - 1; // シーク後は再発火を許可
}
```

### 3.6 Timeline Renderer（新規・Canvas 2D）

SVG より Canvas 2D の方がスクロール・ズーム実装が軽量なため Canvas を採用。

```
定数:
  HEADER_W = 160    // トラック名エリア幅
  ROW_H    = 22     // 行高さ
  RULER_H  = 24     // ルーラー高さ

描画レイヤー:
  1. 背景・グリッド線（10フレームごと）
  2. ルーラー（フレーム番号）
  3. トラック行（グリップ4行 + ブレンドシェイプ n行）
  4. キーフレームマーカー（グリップ=ひし形、ブレンドシェイプ=丸、選択中=黄枠）
  5. ブレンドシェイプ補間カーブ（折れ線）
  6. プレイヘッド（赤縦線）
```

### 3.7 Timeline Interaction（新規）

```js
// クリック判定
tlCanvas.addEventListener('click', e => {
  const { row, frame } = screenToTrack(e.offsetX, e.offsetY);
  if (row.kind === 'grip') {
    toggleGripEvent(row.type, frame);
  } else if (row.kind === 'blendShape') {
    addOrSelectBlendShapeKF(row.name, frame);
  }
  renderTimeline();
});

// 右クリック削除
tlCanvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { row, frame } = screenToTrack(e.offsetX, e.offsetY);
  if (row.kind === 'blendShape') removeBlendShapeKF(row.name, frame);
  renderTimeline();
});

// ホイールズーム
tlCanvas.addEventListener('wheel', e => {
  tlPxPerFrame = clamp(tlPxPerFrame * (e.deltaY < 0 ? 1.15 : 0.87), 2, 60);
  renderTimeline();
});

// プレイヘッドドラッグ
// → mousedown on ルーラー → mousemove → mouseup
```

### 3.8 Event Dispatcher（新規）

render ループ内でフレームが変わるたびに実行。

```js
function dispatchTimelineEvents(frame) {
  if (frame === _lastDispatchedFrame) return;
  _lastDispatchedFrame = frame;

  // グリップイベント
  for (const [type, frameSet] of Object.entries(timeline.grip)) {
    if (!frameSet.has(frame)) continue;
    const hp = handGrabPoints;
    if (type === 'gripLeft'    && simData) simData.leftGripActiveUniform.value = 1;
    if (type === 'gripRight'   && simData) simData.rightGripActiveUniform.value = 1;
    if (type === 'releaseLeft' && simData) simData.leftGripActiveUniform.value = 0;
    if (type === 'releaseRight'&& simData) simData.rightGripActiveUniform.value = 0;
  }

  // ブレンドシェイプ補間
  applyBlendShapesAt(frame);
}

function applyBlendShapesAt(frame) {
  if (!currentVRM?.expressionManager) return;
  for (const [name, kfMap] of timeline.blendShape) {
    const value = interpolateBlendShape(kfMap, frame);
    currentVRM.expressionManager.setValue(name, value);
  }
  currentVRM.expressionManager.update();
}

// 線形補間
function interpolateBlendShape(kfMap, frame) {
  if (kfMap.size === 0) return 0;
  const frames = [...kfMap.keys()].sort((a, b) => a - b);
  if (frame <= frames[0]) return kfMap.get(frames[0]);
  if (frame >= frames.at(-1)) return kfMap.get(frames.at(-1));
  for (let i = 0; i < frames.length - 1; i++) {
    const f0 = frames[i], f1 = frames[i + 1];
    if (frame >= f0 && frame <= f1) {
      const t = (frame - f0) / (f1 - f0);
      return kfMap.get(f0) + t * (kfMap.get(f1) - kfMap.get(f0));
    }
  }
  return 0;
}
```

### 3.9 Render Loop（新規）

```js
async function render() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 1/60);

  // VRMA 更新
  if (mixer && vrmaPlaying) {
    mixer.update(dt);
    // 現在フレームを計算
    const t = vrmaAction?.time ?? 0;
    timeline.currentFrame = Math.min(
      Math.round(t * timeline.fps),
      timeline.durationFrames,
    );
    dispatchTimelineEvents(timeline.currentFrame);
    renderTimelinePlayhead(); // プレイヘッドのみ再描画
  }

  // VRM 更新
  currentVRM?.update(dt);

  // ハンドグラブポイント追従
  updateHandGrabPoints();

  // 布シミュ
  if (simRunning && simData) {
    // ... compute (cloth-editor 流用)
  }

  renderer.render(scene, camera);
}
```

### 3.10 Timeline JSON 入出力

```js
function exportTimeline() {
  const tracks = [];
  // グリップ
  for (const [type, frameSet] of Object.entries(timeline.grip)) {
    if (frameSet.size > 0)
      tracks.push({ kind: 'grip', type, frames: [...frameSet].sort((a,b)=>a-b) });
  }
  // ブレンドシェイプ
  for (const [name, kfMap] of timeline.blendShape) {
    tracks.push({
      kind: 'blendShape', name,
      keyframes: [...kfMap.entries()]
        .sort(([a],[b])=>a-b)
        .map(([frame,value]) => ({ frame, value })),
    });
  }
  return { version:1, fps: timeline.fps, durationFrames: timeline.durationFrames, tracks };
}

function importTimeline(json) {
  timeline.fps = json.fps ?? 30;
  timeline.durationFrames = json.durationFrames ?? 90;
  // grip リセット
  for (const s of Object.values(timeline.grip)) s.clear();
  timeline.blendShape.clear();
  for (const track of json.tracks ?? []) {
    if (track.kind === 'grip') {
      for (const f of track.frames) timeline.grip[track.type]?.add(f);
    } else if (track.kind === 'blendShape') {
      const m = new Map();
      for (const { frame, value } of track.keyframes) m.set(frame, value);
      timeline.blendShape.set(track.name, m);
    }
    // kind === 'effect' は将来対応（無視してスキップ）
  }
  renderTimeline();
}
```

---

## 4. UI レイアウト

```
┌─────────────────────────────────────────────────────────────────┐
│  [VRM読込] [VRMA読込] [マント読込] [TL読込] [TL保存]    FPS表示  │  ← 上部ツールバー
├──────────────────────────────────────────┬──────────────────────┤
│                                          │  右パネル             │
│         3D ビューポート (WebGPU)          │  ▶ 再生 ⏹ 停止       │
│                                          │  速度: [1.0x ▼]      │
│                                          │  ────────────────    │
│                                          │  布シミュ             │
│                                          │  [シミュ開始/停止]    │
│                                          │  Stiffness / Wind    │
│                                          │  ────────────────    │
│                                          │  ブレンドシェイプ追加 │
│                                          │  [表情名 ▼] [追加]   │
│                                          │  ────────────────    │
│                                          │  選択KF値: [0.00]    │
├──────────────────────────────────────────┴──────────────────────┤
│  タイムライン (Canvas 2D)                                         │
│  ┌─────────────┬──────────────────────────────────────────────┐ │
│  │ gripLeft    │  ◆         ◆                                  │ │
│  │ gripRight   │       ◆                                       │ │
│  │ releaseLeft │               ◆                               │ │
│  │ releaseRight│                    ◆                          │ │
│  ├─────────────┼──────────────────────────────────────────────┤ │
│  │ happy       │  ●─────●                                      │ │
│  │ sad         │              ●─────●                          │ │
│  └─────────────┴──────────────────────────────────────────────┘ │
│  [←スクロール→]   ズーム: ホイール   プレイヘッド: ドラッグ         │
└─────────────────────────────────────────────────────────────────┘
```

**タイムラインパネル高さ**: 固定 240px（下部固定）
**ビューポート高さ**: `calc(100vh - ツールバー高 - タイムライン高)`

---

## 5. タイムライン Canvas 詳細

### 5.1 座標変換

```js
// フレーム → スクリーン X
function frameToX(frame) {
  return HEADER_W + frame * tlPxPerFrame - tlScrollX;
}
// スクリーン X → フレーム
function xToFrame(x) {
  return Math.round((x - HEADER_W + tlScrollX) / tlPxPerFrame);
}
// 行インデックス → スクリーン Y
function rowToY(rowIdx) {
  return RULER_H + rowIdx * ROW_H;
}
```

### 5.2 行構成

```js
const GRIP_ROWS = [
  { kind: 'grip', type: 'gripLeft',     label: 'Grip L',     color: '#44aaff' },
  { kind: 'grip', type: 'gripRight',    label: 'Grip R',     color: '#ff6644' },
  { kind: 'grip', type: 'releaseLeft',  label: 'Release L',  color: '#88ccff' },
  { kind: 'grip', type: 'releaseRight', label: 'Release R',  color: '#ffaa88' },
];
// ブレンドシェイプ行は timeline.blendShape.keys() から動的生成
```

### 5.3 キーフレームの当たり判定

クリック座標からフレームと行を特定する `screenToTrack(offsetX, offsetY)` 関数。
スナップ精度: ±4px 以内のフレームに吸着。

---

## 6. ブレンドシェイプ追加 UI

1. 右パネルに VRM から取得した表情名のドロップダウン
2. 「追加」ボタンでタイムラインに行を追加（`timeline.blendShape.set(name, new Map())`）
3. タイムライン行をクリック → 選択フレームにキーフレーム配置（デフォルト値 1.0）
4. 右パネルの「選択KF値」インプットで値を変更
5. Delete キーで選択キーフレームを削除

---

## 7. データフロー

```
[VRM 読み込み]
  └→ initHandGrabPoints()
  └→ 表情一覧をドロップダウンに表示

[Mantle 読み込み]
  └→ loadMantleJSON()  ← cloth-editor 流用
  └→ pinnedSet / leftGripSet / rightGripSet 復元

[VRMA 読み込み]
  └→ loadVRMA()
  └→ mixer / vrmaAction 生成
  └→ timeline.durationFrames = Math.round(duration * fps)

[再生ボタン]
  └→ vrmaPlay()
  └→ render() で mixer.update(dt)
  └→ currentFrame 更新
  └→ dispatchTimelineEvents(frame)
      └→ グリップ uniform 切替
      └→ applyBlendShapesAt(frame)

[タイムラインクリック]
  └→ screenToTrack() でトラック/フレーム特定
  └→ toggleGripEvent() or addOrSelectBlendShapeKF()
  └→ renderTimeline()
```

---

## 8. 流用・非流用の整理

| 機能 | cloth-editor.js から | 変更点 |
|------|---------------------|--------|
| VRM 読み込み（MToon変換） | ✅ 流用 | なし |
| buildCollidersFromVRM | ✅ 流用 | なし |
| buildSimulation / disposeSimulation | ✅ 流用 | なし |
| scheduleReadbacks | ✅ 流用 | なし |
| initHandGrabPoints / updateHandGrabPoints | ✅ 流用 | なし |
| setupGrabEvents（マウスグラブ） | ✅ 流用 | なし |
| loadMantleJSON / applyMantleTransform | ✅ 流用 | なし |
| ピン編集 UI（pinMode, togglePin） | ❌ 不要 | 削除 |
| グリップ編集 UI（gripEditMode） | ❌ 不要 | cloth.json から自動復元 |
| メッシュ選択 UI | ❌ 不要 | マントのみ |
| マント変換スライダー | 🔶 簡略化 | 左パネルに最小限 |
| VRMA 再生 | ❌ 新規 | 追加 |
| タイムライン | ❌ 新規 | 追加 |
