# タスクリスト - Cloth Preview

## 概要
- 総タスク数: 9
- 実装方式: スタンドアロン HTML/JS（`cloth-preview/` ディレクトリ新設）
- 流用元: `cloth-editor/cloth-editor.js`

---

## タスク一覧

### T1: HTML シェル + UI レイアウト
**ファイル**: `cloth-preview/index.html`

- 上部ツールバー: [VRM読込] [VRMA読込] [マント読込] [TL読込] [TL保存] ボタン
- 左 70%: `<div id="app">` ビューポート
- 右 30%: 右パネル（再生コントロール / 布シミュ / ブレンドシェイプ追加 / 選択KF値）
- 下部 240px 固定: タイムライン `<canvas id="timeline">`
- FPS カウンター、WebGPU 警告バナー、トースト、ローディングオーバーレイ
- CSS: ビューポート高さ `calc(100vh - toolbar - timeline)`

---

### T2: VRM 読み込み + シーンセットアップ + ハンドグラブポイント
**ファイル**: `cloth-preview/cloth-preview.js`

cloth-editor.js から以下をコピー・流用:
- `loadVRM()` / `unloadVRM()`（MToon→NodeMaterial 変換含む）
- `buildCollidersFromVRM()` / `addCollider()` / `syncColliderDataArr()`
- `initHandGrabPoints()` / `disposeHandGrabPoints()` / `updateHandGrabPoints()` / `_syncHgpOffsetUI()`
- グラブポイントドラッグ（setupGrabEvents の HGP ドラッグ部分のみ）

追加:
- VRM 読み込み後に `expressionManager` から表情一覧を取得し、右パネルのドロップダウンに設定

削除（不要）:
- ピン編集 / グリップ編集 UI / メッシュ選択 UI / analyzeMesh / initMarkers

---

### T3: マント読み込み + 布シミュレーション
**ファイル**: `cloth-preview/cloth-preview.js`

cloth-editor.js から以下をコピー・流用:
- `loadMantleJSON()` / `clearMantle()` / `applyMantleTransform()` / `updateMantleMarkers()`
- `buildSimulation()` / `disposeSimulation()` / `scheduleReadbacks()`
- `_buildMantleAnalysis()`
- uniform 初期化（stiffness / dampening / wind）

UI:
- シミュ開始 / 停止ボタン
- Stiffness / Wind スライダー（右パネル）

---

### T4: VRMA プレイヤー
**ファイル**: `cloth-preview/cloth-preview.js`

```js
// 新規実装
async function loadVRMA(file)      // GLTFLoader + VRMAnimationLoaderPlugin
function vrmaPlay()
function vrmaPause()
function vrmaSeek(frame)           // mixer.setTime(frame / fps)
function vrmaSetSpeed(speed)
function vrmaSetLoop(enabled)
function unloadVRMA()
```

- `@pixiv/three-vrm-animation` を esm.sh CDN からインポート
- VRMA 読み込み時に `timeline.durationFrames = Math.round(clip.duration * timeline.fps)`
- 再生中は `mixer.update(dt)` → currentFrame 計算 → `dispatchTimelineEvents()` 呼び出し
- アニメーション終端検出（LoopOnce + finished イベント）でプレイヘッド停止

---

### T5: タイムライン状態管理
**ファイル**: `cloth-preview/cloth-preview.js`

```js
const timeline = {
  fps: 30,
  durationFrames: 90,
  currentFrame: 0,
  grip: {
    gripLeft: new Set(), gripRight: new Set(),
    releaseLeft: new Set(), releaseRight: new Set(),
  },
  blendShape: new Map(),   // name → Map<frame, value>
  selected: null,          // { kind, name, frame } | null
};

function toggleGripEvent(type, frame)
function addBlendShapeTrack(name)         // 重複チェック付き
function setBlendShapeKF(name, frame, value)
function removeBlendShapeKF(name, frame)
function selectBlendShapeKF(name, frame)
function exportTimeline()                 // → JSON オブジェクト
function importTimeline(json)
```

---

### T6: タイムライン Canvas 描画
**ファイル**: `cloth-preview/cloth-preview.js`

```js
// 定数
const HEADER_W = 160, ROW_H = 22, RULER_H = 24;
const GRIP_ROWS = [
  { kind:'grip', type:'gripLeft',     label:'Grip L',     color:'#44aaff' },
  { kind:'grip', type:'gripRight',    label:'Grip R',     color:'#ff6644' },
  { kind:'grip', type:'releaseLeft',  label:'Release L',  color:'#88ccff' },
  { kind:'grip', type:'releaseRight', label:'Release R',  color:'#ffaa88' },
];

function renderTimeline()              // 全体再描画（ユーザー操作時）
function renderTimelinePlayhead()      // プレイヘッドのみ差分更新（毎フレーム）
function frameToX(frame)
function xToFrame(x)
function rowToY(rowIdx)
function allRows()                     // GRIP_ROWS + blendShape 行を結合
```

描画内容:
- 背景・グリッド（10f ごと）・ルーラー（フレーム番号）
- トラック行（グリップ=◆、ブレンドシェイプ=●）
- ブレンドシェイプ補間折れ線
- プレイヘッド（赤縦線）
- 選択キーフレーム（黄枠）

---

### T7: タイムライン操作イベント
**ファイル**: `cloth-preview/cloth-preview.js`

```js
function screenToTrack(offsetX, offsetY)  // → { row, frame } | null
function setupTimelineEvents(canvas)
```

イベント:
- `click`: グリップトグル / ブレンドシェイプKF配置・選択
- `contextmenu`: ブレンドシェイプKF削除
- `wheel`: tlPxPerFrame ズーム（2〜60px/f）
- `mousedown` on ルーラー → `mousemove` → `mouseup`: プレイヘッドドラッグ
- `scroll` (横): tlScrollX 更新
- `keydown Delete`: 選択KF削除

選択KF値の編集:
- 右パネルの数値インプット（0〜1）で `setBlendShapeKF()` を呼ぶ

---

### T8: Event Dispatcher + ブレンドシェイプ補間
**ファイル**: `cloth-preview/cloth-preview.js`

```js
let _lastDispatchedFrame = -1;

function dispatchTimelineEvents(frame)
function applyBlendShapesAt(frame)
function interpolateBlendShape(kfMap, frame)   // 線形補間
```

グリップイベント発火順序: `gripLeft → gripRight → releaseLeft → releaseRight`
ブレンドシェイプ: VRMA 再生中は VRMA 優先（expressionManager は VRMA の update 後に呼ぶ）

エラー処理:
- `simData` が null → グリップイベントをスキップ
- `expressionManager.setValue` 例外 → try/catch でトーストを出す

---

### T9: UI Manager + Render Loop 統合
**ファイル**: `cloth-preview/cloth-preview.js`

```js
function setupUI()    // ファイル入力・再生コントロール・スライダー・ブレンドシェイプ追加
async function render()
async function init()
```

render ループ:
```
1. timer.update() / updateFPS()
2. if (mixer && vrmaPlaying) mixer.update(dt)
3. currentFrame 更新 → dispatchTimelineEvents()
4. renderTimelinePlayhead()
5. currentVRM?.update(dt)
6. updateHandGrabPoints()
7. if (simRunning) compute spring + vertex forces
8. scheduleReadbacks()
9. renderer.render(scene, camera)
```

index.html のランディングページにリンク追加（`/cloth-preview/` へ）

---

## 実装順序

```
T1 (HTML) → T2 (VRM+HGP) → T3 (マント+シミュ) → T4 (VRMA)
         → T5 (TL状態)   → T6 (TL描画)         → T7 (TL操作)
         → T8 (Dispatcher) → T9 (統合)
```

T2 完了時点で VRM + グラブポイントが確認できる。
T4 完了時点で VRMA 再生が確認できる。
T6 完了時点でタイムラインの見た目が確認できる。
T8〜T9 完了で全機能が揃う。

---

## 手動テスト対応表

| テスト | 対応タスク |
|--------|-----------|
| TF-01〜08 | T2, T3, T4, T9 |
| TV-01〜06 | T2, T3, T9 |
| TA-01〜07 | T4, T9 |
| TT-01〜05 | T6, T7, T9 |
| TG-01〜06 | T5, T7, T8 |
| TB-01〜08 | T5, T7, T8 |
| TJ-01〜04 | T5 |
| TE-01〜04 | T8 |
