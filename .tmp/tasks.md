# タスクリスト - VRM対応3Dキャラクターエディタ（Web/WebXR）

## 概要

- 総タスク数: 24
- 推定作業時間: 約 40〜50時間
- 優先度: 高

## タスク一覧

---

### Phase 1: プロジェクト初期設定

#### Task 1.1: プロジェクトのスキャフォールディング

- [ ] `npm create vite@latest` で Svelte + TypeScript テンプレートを生成
- [ ] 依存パッケージをインストール: `three`, `@pixiv/three-vrm`, `@pixiv/three-vrm-animation`, `three-mesh-ui`
- [ ] 開発用依存をインストール: `vitest`, `@playwright/test`, `@sveltejs/vite-plugin-svelte`
- [ ] `vite.config.ts` を設定（target: es2020, assetsInlineLimit: 0）
- [ ] `tsconfig.json` で strict モードを有効化
- [ ] `.gitignore` に `public/vrm/*.vrm`, `public/vrm/*.vrma` を追加
- [ ] `public/vrm/.gitkeep` を作成
- [ ] GitHub リポジトリ `TakaI2/Web3D_gamemaker` に初回 push
- **完了条件**: `npm run dev` でブラウザに Svelte デフォルト画面が表示される
- **依存**: なし
- **推定時間**: 1時間

#### Task 1.2: 型定義・定数ファイルの作成

- [ ] `src/types/index.ts` に全共通型を定義（`VisemeKey`, `AnimationEntry`, `SpeedPreset`, `XRMode`, `AppError`, `SpringBoneParams`, `VRMState`, `AnimationState`, `LipSyncState`, `XRState`）
- [ ] `src/lipsync/visemeMaps.ts` に日本語・英語 Viseme マッピングテーブルを定義（ひらがな・カタカナ全文字）
- [ ] `src/utils/fileHelpers.ts` にファイル拡張子チェック関数を実装
- **完了条件**: TypeScript コンパイルエラーなし、`any`/`unknown` 型不使用
- **依存**: Task 1.1
- **推定時間**: 1.5時間

#### Task 1.3: Svelte ストアの作成

- [ ] `src/stores/vrmStore.ts` 作成（`VRMState` 初期値設定）
- [ ] `src/stores/animationStore.ts` 作成（`AnimationState` 初期値設定）
- [ ] `src/stores/xrStore.ts` 作成（`XRState` 初期値設定）
- [ ] `src/stores/lipSyncStore.ts` 作成（`LipSyncState` 初期値設定）
- [ ] 各ストアの Vitest 単体テストを作成・実行（初期状態・更新伝播・エラーリセット）
- **完了条件**: ストアの単体テスト全件 PASS
- **依存**: Task 1.2
- **推定時間**: 1.5時間

---

### Phase 2: Three.js コア実装

#### Task 2.1: SceneManager の実装

- [ ] `src/core/SceneManager.ts` を作成
- [ ] `PerspectiveCamera`（fov: 30, near: 0.1, far: 20）の初期化
- [ ] `WebGLRenderer`（antialias: true, alpha: true）の初期化
- [ ] `renderer.xr.enabled = true` で WebXR 有効化
- [ ] `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` の設定
- [ ] `DirectionalLight`（intensity: 1.0）+ `AmbientLight`（intensity: 0.5）の追加
- [ ] `GridHelper` のオン/オフ切り替え実装（`gridStore` を参照）
- [ ] ウィンドウリサイズ対応（`resize()` メソッド）
- [ ] `dispose()` でレンダラーを解放
- **完了条件**: canvas にグリッドフロアと照明のシーンが表示される
- **依存**: Task 1.1
- **推定時間**: 2時間

#### Task 2.2: RenderLoop の実装

- [ ] `src/core/RenderLoop.ts` を作成
- [ ] `requestAnimationFrame` ループの開始・停止管理
- [ ] `delta` 時間の計算（`THREE.Clock` 使用）
- [ ] 更新順序の定義: `mixer.update(delta)` → `vrm.update(delta)` → `renderer.render()`
- [ ] `SceneManager` / `AnimationManager` / `SpringBoneController` / `LipSyncEngine` の更新コールバック登録機構
- **完了条件**: `renderer.info.render.calls` がフレームごとに更新される
- **依存**: Task 2.1
- **推定時間**: 1.5時間

#### Task 2.3: VRMLoader の実装

- [ ] `src/core/VRMLoader.ts` を作成
- [ ] `GLTFLoader` + `VRMLoaderPlugin` の設定
- [ ] `File` → `URL.createObjectURL()` → ロード → `URL.revokeObjectURL()` の実装
- [ ] ロード開始時に `vrmStore.loading = true`、完了/失敗で `false` に戻す
- [ ] 既存 VRM の `scene.traverse()` + `dispose()` によるメモリ解放
- [ ] VRM 読み込み完了後に `vrmStore.vrm` を更新
- [ ] ロード失敗時に `vrmStore.error` に `AppError` をセット
- [ ] 拡張子が `.vrm` 以外のファイルは即エラー
- **完了条件**: VRM ファイルをロードしてシーンにモデルが表示される
- **依存**: Task 2.1, Task 1.3
- **推定時間**: 2時間

#### Task 2.4: OrbitController の実装

- [ ] `src/core/OrbitController.ts` を作成
- [ ] `OrbitControls`（`three/addons/controls/OrbitControls.js`）のラッパー実装
- [ ] `setEnabled(boolean)` で有効/無効を切り替え
- [ ] タッチ操作（ピンチズーム・スワイプ）が機能することを確認
- [ ] カメラリセット機能（モデルの BoundingBox に基づいて最適距離に移動）
- **完了条件**: マウス操作でカメラがモデルを周回できる
- **依存**: Task 2.1
- **推定時間**: 1時間

#### Task 2.5: AnimationManager の実装

- [ ] `src/core/AnimationManager.ts` を作成
- [ ] `GLTFLoader` + `VRMAnimationLoaderPlugin` で VRMA 読み込み
- [ ] `createVRMAnimationClip(vrmAnimation, vrm)` で AnimationClip 生成
- [ ] `Map<string, THREE.AnimationClip>` で複数アニメーション管理
- [ ] 重複ファイル名のリネーム処理（`name_1` 形式）
- [ ] `play()` / `stop()` / `setLoop()` / `setSpeed()` / `seek()` の実装
- [ ] `resetTPose()` の実装（AnimationMixer をリセット + デフォルトポーズ復元）
- [ ] VRM 差し替え時の AnimationMixer 再生成
- [ ] `animationStore` への進捗（`progress`）の定期更新
- **完了条件**: VRMA を読み込んでリストに表示し、再生・停止できる
- **依存**: Task 2.3, Task 2.2
- **推定時間**: 3時間

#### Task 2.6: SpringBoneController の実装

- [ ] `src/core/SpringBoneController.ts` を作成
- [ ] `vrm.springBoneManager` の有無チェック（存在しない場合は no-op）
- [ ] `setEnabled()` で Spring Bone の更新スキップ制御
- [ ] `setStiffness()` / `setDamping()` で全 Joint のパラメータ一括変更
- [ ] `reset()` でオリジナルパラメータに戻す
- [ ] RenderLoop への `update(delta)` 登録
- **完了条件**: Spring Bone の ON/OFF でモデルの揺れが制御できる
- **依存**: Task 2.3, Task 2.2
- **推定時間**: 1.5時間

---

### Phase 3: リップシンク実装

#### Task 3.1: Viseme 変換ロジックの実装とテスト

- [ ] `src/lipsync/JapaneseLipSync.ts` を作成（ひらがな・カタカナ→Viseme 変換）
- [ ] `src/lipsync/EnglishLipSync.ts` を作成（英字→Viseme 変換）
- [ ] 言語判定関数 `isJapanese()` / `isAscii()` を実装
- [ ] Vitest 単体テストを作成・全件実行（`LIPSYNC_TEST_CASES` を使用）
  - 日本語正常系 4ケース、英語正常系 3ケース、混在・異常系・境界値 各ケース
- **完了条件**: `vitest run` で LipSync 関連テスト全件 PASS
- **依存**: Task 1.2
- **推定時間**: 2時間

#### Task 3.2: LipSyncEngine の実装

- [ ] `src/lipsync/LipSyncEngine.ts` を作成
- [ ] `setInterval` ベースのタイプライタータイマー実装
- [ ] 文字ごとの言語判定 → 変換 → Viseme キュー生成
- [ ] `play()` 開始時に `lipSyncStore.isPlaying = true`、`displayedText` を順次更新
- [ ] RenderLoop 内での Viseme LERP 補間（係数 0.3/frame）
- [ ] `stop()` / 完了時の neutral 戻し処理
- [ ] `setVRM()` で VRM Expression Manager への参照を更新
- [ ] VRM Expression 未定義時のサイレントスキップ
- **完了条件**: テキスト入力→再生でモデルの口が動く
- **依存**: Task 3.1, Task 2.3, Task 2.2
- **推定時間**: 2.5時間

---

### Phase 4: WebXR 実装

#### Task 4.1: XRSessionManager の実装

- [ ] `src/xr/XRSessionManager.ts` を作成
- [ ] `navigator.xr.isSessionSupported()` による VR/AR サポート確認
- [ ] `enterXR('vr')`: `immersive-vr` セッション開始、`renderer.xr.setSession()` に委譲
- [ ] `enterXR('ar')`: `immersive-ar` セッション開始（`requiredFeatures: ['local-floor']`）、AR時 `renderer.setClearAlpha(0)` で透明背景
- [ ] `exitXR()`: セッション終了 + `OrbitController.setEnabled(true)` 復帰
- [ ] VR↔AR 切り替え: `exitXR()` → 1フレーム待機 → `enterXR(newMode)`
- [ ] `xrStore` への状態反映
- [ ] セッション失敗時の `xrStore.error` セット
- **完了条件**: `xrStore.activeMode` が正しく切り替わる（ブラウザモックで確認）
- **依存**: Task 2.1, Task 2.4, Task 1.3
- **推定時間**: 2.5時間

#### Task 4.2: XRUIManager の実装（three-mesh-ui）

- [ ] `src/xr/XRUIManager.ts` を作成
- [ ] `three-mesh-ui` で XR パネルを構築（アニメーションリスト・再生ボタン・リップシンク入力の3機能）
- [ ] セッション開始時にカメラ正面 1.5m にパネルをスポーン
- [ ] コントローラーの `selectstart` イベントでレイキャスト → ボタン判定
- [ ] パネルの各操作を `animationStore` / `lipSyncStore` に反映
- [ ] セッション終了時にパネルをシーンから除去
- [ ] three-mesh-ui 用 MSDF フォントファイルを `public/fonts/` に配置
- **完了条件**: WebXR 中にパネルが表示されコントローラーで操作できる（Quest 3 手動確認）
- **依存**: Task 4.1, Task 2.5, Task 3.2
- **推定時間**: 4時間

---

### Phase 5: Svelte UI 実装

#### Task 5.1: Viewport と App ルートの実装

- [ ] `src/App.svelte` を作成（全コンポーネントの統括・初期化）
- [ ] `src/components/Viewport.svelte` を作成（`<canvas>` コンテナ、SceneManager 初期化、リサイズ監視）
- [ ] SceneManager / RenderLoop / VRMLoader / AnimationManager / SpringBoneController / LipSyncEngine / XRSessionManager のインスタンスを App で生成し各コンポーネントに提供
- [ ] `onMount` / `onDestroy` でライフサイクル管理
- **完了条件**: ブラウザで canvas が全画面表示され Three.js シーンが描画される
- **依存**: Task 2.1〜2.6, Phase 3, Phase 4
- **推定時間**: 2時間

#### Task 5.2: ModelLoader コンポーネントの実装

- [ ] `src/components/ModelLoader.svelte` を作成
- [ ] ドラッグ&ドロップゾーンの実装（`dragover` / `drop` イベント）
- [ ] ファイル選択ダイアログ（`<input type="file" accept=".vrm">`）
- [ ] `vrmStore.loading` 中のローディングスピナー表示
- [ ] `vrmStore.error` 発生時のエラートースト表示（3秒自動消去）
- **完了条件**: D&D または選択で VRM が読み込まれシーンに表示される
- **依存**: Task 5.1, Task 2.3
- **推定時間**: 1.5時間

#### Task 5.3: AnimationList・AnimationControls コンポーネントの実装

- [ ] `src/components/AnimationList.svelte` を作成（アニメーション一覧、選択ハイライト）
- [ ] VRMA ファイルの D&D / ファイル選択による追加読み込み
- [ ] `src/components/AnimationControls.svelte` を作成
  - 再生・停止ボタン
  - ループ切り替えトグル
  - 速度セレクタ（0.25x / 0.5x / 1.0x / 2.0x）
  - タイムラインスライダー（`change` イベントでシーク）
  - Tポーズリセットボタン
- [ ] `animationStore` と双方向バインディング
- **完了条件**: UI から全アニメーション操作が可能
- **依存**: Task 5.1, Task 2.5
- **推定時間**: 2時間

#### Task 5.4: SpringBonePanel コンポーネントの実装

- [ ] `src/components/SpringBonePanel.svelte` を作成
- [ ] Spring Bone ON/OFF トグル
- [ ] 剛性（stiffness）スライダー（0.0〜4.0）
- [ ] 減衰（damping）スライダー（0.0〜1.0）
- [ ] VRM に Spring Bone がない場合はパネルをグレーアウト
- **完了条件**: スライダー操作でモデルの揺れ方がリアルタイムに変化する
- **依存**: Task 5.1, Task 2.6
- **推定時間**: 1時間

#### Task 5.5: LipSyncPanel コンポーネントの実装

- [ ] `src/components/LipSyncPanel.svelte` を作成
- [ ] テキスト入力フィールド（XSS 対策: `{text}` バインディングのみ使用）
- [ ] 再生・停止ボタン
- [ ] 発話速度スライダー（1〜20 文字/秒）
- [ ] タイプライター表示エリア（`lipSyncStore.displayedText` を表示）
- **完了条件**: テキスト入力→再生でタイプライター表示と口パクが同期する
- **依存**: Task 5.1, Task 3.2
- **推定時間**: 1.5時間

#### Task 5.6: XRControls コンポーネントの実装

- [ ] `src/components/XRControls.svelte` を作成
- [ ] VR 開始ボタン / AR 開始ボタン
- [ ] `xrStore.support` を確認し非対応時はグレーアウト + ツールチップ
- [ ] `xrStore.isActive` 中は「XR終了」ボタンに切り替え
- [ ] VR↔AR 切り替え時に「セッションを再起動します」メッセージを表示
- **完了条件**: XR ボタンでセッションが開始・終了できる
- **依存**: Task 5.1, Task 4.1
- **推定時間**: 1時間

#### Task 5.7: ControlPanel の統合

- [ ] `src/components/ControlPanel.svelte` でサイドバーに全パネルを統合
- [ ] タブまたはアコーディオンで「モデル」「アニメーション」「SpringBone」「リップシンク」「XR」を切り替え
- [ ] レスポンシブ対応（モバイル時はボトムシートに変更）
- [ ] グリッド表示 ON/OFF トグルをパネル上部に配置
- **完了条件**: 全機能が1つのコントロールパネルから操作できる
- **依存**: Task 5.2〜5.6
- **推定時間**: 1.5時間

---

### Phase 6: テスト・品質確認

#### Task 6.1: 単体テストの実装と実行

- [ ] `VRMLoader` の Vitest テスト（T001〜T203）— Three.js モック使用
- [ ] `AnimationManager` の Vitest テスト（T301〜T503）— Three.js モック使用
- [ ] `XRSessionManager` の Vitest テスト（T1001〜T1103）— `navigator.xr` モック使用
- [ ] `SceneManager` の Vitest テスト（T1201〜T1203）
- [ ] セキュリティテスト（S001〜S102）
- [ ] `vitest run --coverage` でカバレッジ 80% 以上を確認
- **完了条件**: `npm run test` が全件 PASS、カバレッジ 80% 以上
- **依存**: Phase 2〜5 完了
- **推定時間**: 3時間

#### Task 6.2: 統合テストの実装と実行

- [ ] Playwright で統合シナリオ 1〜3, 5 を実装
- [ ] VRM / VRMA テスト用フィクスチャファイルを `tests/fixtures/` に配置
- [ ] `npm run test:e2e` で全シナリオ PASS を確認
- **完了条件**: Playwright テスト全件 PASS
- **依存**: Task 6.1
- **推定時間**: 2時間

#### Task 6.3: パフォーマンス確認

- [ ] Chrome DevTools で VRM + アニメーション + Spring Bone 時の FPS を計測
- [ ] ヒープスナップショットで VRM 5回差し替え後のメモリリークがないことを確認
- [ ] Quest 3 実機で VR / AR モードの 72fps 維持を確認（手動）
- **完了条件**: デスクトップ Chrome で 60fps 以上、Quest 3 実機で 72fps 以上
- **依存**: Task 6.2
- **推定時間**: 2時間

---

### Phase 7: デプロイ・仕上げ

#### Task 7.1: ビルドと Netowl デプロイ

- [ ] `npm run build` で `dist/` を生成しエラーがないことを確認
- [ ] Netowl サーバーに FTP/SFTP でアップロード
- [ ] Netowl コントロールパネルで Let's Encrypt SSL を有効化
- [ ] `https://` で VRM 読み込み・アニメーション・リップシンクの基本動作を確認
- [ ] Quest 3 実機で本番 URL に HTTPS アクセスし WebXR が動作することを確認
- **完了条件**: 本番 URL で全機能が動作する（受け入れテスト 5.2 全項目 PASS）
- **依存**: Task 6.3
- **推定時間**: 1.5時間

---

## 実装順序

```
Phase 1（初期設定）
  └─ Task 1.1 → Task 1.2 → Task 1.3

Phase 2（Three.js コア）
  ├─ Task 2.1（SceneManager）
  ├─ Task 2.4（OrbitController）  ← Task 2.1 後、並行可
  ├─ Task 2.2（RenderLoop）       ← Task 2.1 後
  ├─ Task 2.3（VRMLoader）        ← Task 2.2 後
  ├─ Task 2.5（AnimationManager） ← Task 2.3 後
  └─ Task 2.6（SpringBoneController） ← Task 2.3 後、Task 2.5 と並行可

Phase 3（LipSync）
  ├─ Task 3.1（変換ロジック + テスト） ← Task 1.2 後、Phase 2 と並行可
  └─ Task 3.2（LipSyncEngine）    ← Task 3.1 + Task 2.3 後

Phase 4（WebXR）
  ├─ Task 4.1（XRSessionManager） ← Task 2.1, 2.4 後
  └─ Task 4.2（XRUIManager）      ← Task 4.1, 2.5, 3.2 後

Phase 5（Svelte UI）
  ├─ Task 5.1（App + Viewport）   ← Phase 2〜4 後
  ├─ Task 5.2〜5.6（各パネル）   ← Task 5.1 後、並行可
  └─ Task 5.7（ControlPanel統合） ← Task 5.2〜5.6 後

Phase 6（テスト）
  ├─ Task 6.1（単体テスト）       ← Phase 2〜5 後
  ├─ Task 6.2（統合テスト）       ← Task 6.1 後
  └─ Task 6.3（パフォーマンス）   ← Task 6.2 後

Phase 7（デプロイ）
  └─ Task 7.1                     ← Phase 6 後
```

### 並行実行できるタスク

| セット | タスク |
|---|---|
| A | Task 2.4 と Task 2.2（どちらも Task 2.1 依存） |
| B | Task 2.5 と Task 2.6（どちらも Task 2.3 依存） |
| C | Task 3.1 と Phase 2（Task 1.2 さえ完了していれば並行可） |
| D | Task 5.2〜5.6（どれも Task 5.1 依存だが互いに独立） |

---

## クリティカルパス

```
1.1 → 1.2 → 2.1 → 2.2 → 2.3 → 2.5 → 3.2 → 4.2 → 5.1 → 5.7 → 6.1 → 6.2 → 6.3 → 7.1
```

**最も影響が大きいリスク箇所**: `Task 4.2`（XRUIManager）と `Task 6.3`（Quest 3 実機確認）。これらは手戻りが発生しやすく、早期に着手することを推奨。

---

## リスクと対策

| リスク | 対策 |
|---|---|
| three-mesh-ui の日本語非対応 | XR パネルのテキストは英語表記を基本とし、日本語 MSDF フォントは後フェーズで対応 |
| Quest 3 実機でのテスト環境確保 | Task 4.1 完了後すぐに実機確認。UI なしで XR セッションが開始できるかを先行チェック |
| Svelte 5 runes モードの学習コスト | Svelte 4 の `writable` store で統一してもよい。開始前にどちらで進めるか確定すること |
| VRM Expression 名称の VRM0/1 差異 | `@pixiv/three-vrm` の `expressionManager` を使えば吸収される。直接 GLB の名前にアクセスしない |
| VRMA 変換パイプラインの未確立 | Blender アドオンの動作確認を Task 2.5 と並行して行う |

---

## 注意事項

- 各タスクはコミット単位で完結させる
- `vrm.update(delta)` は必ず `mixer.update(delta)` の **後** に呼ぶこと（設計書 §12-2 参照）
- WebXR AR モードは `renderer.setClearAlpha(0)` を忘れずに設定すること（設計書 §12-6 参照）
- `@html` ディレクティブは XSS リスクのため使用禁止
- `any` / `unknown` 型の使用禁止

---

## 実装開始ガイド

1. このタスクリストに従って Phase 1 から順次実装を進めてください
2. 各タスクの開始時に TodoWrite で `in_progress` に更新
3. 完了時は `completed` に更新
4. 問題発生時は速やかに報告してください
5. Svelte のバージョン（4 か 5）を **Task 1.1 着手前** に確定してください
