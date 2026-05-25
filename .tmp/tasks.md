# タスクリスト - FPS ステージエディタ

## 概要

- 総タスク数: 13
- 優先度: 高
- 実装方針: 設計書 `.tmp/design.md` に従い、ストア → Three.js コア → UI の順で積み上げる

---

## タスク一覧

### Phase 1: 基盤（型・ストア・AppMode 統合）

#### Task 1.1: 型定義の作成

- [ ] `src/stage-editor/types.ts` を新規作成
  - `ShapeType`, `ToolMode`, `SnapSize`, `MaterialDef`, `StageObjectDef`, `SceneDef` を定義
  - `DEFAULT_MATERIAL` 定数を定義
- [ ] `src/types/index.ts` に `AppMode` へ `'stage-editor'` を追加
- **完了条件**: TypeScript コンパイルエラーなし
- **依存**: なし
- **推定時間**: 0.5h

#### Task 1.2: Svelte ストアの実装

- [ ] `src/stores/stageEditorStore.ts` を新規作成
  - `StageEditorState` 型定義
  - `createStageEditorStore()` ファクトリ関数
  - `addObject`, `updateObject`, `removeObject`, `setSelected`, `setToolMode`, `setActiveShape`, `setSnapSize`, `setPreviewGlbUrl` を実装
- [ ] `src/stage-editor/stageEditorStore.test.ts` を新規作成し T001–T203 の自動テストを実装
- [ ] `npm test` で全テスト PASS を確認
- **完了条件**: T001–T203 全 PASS
- **依存**: Task 1.1
- **推定時間**: 1.5h

#### Task 1.3: AppMode 統合（ルーティング）

- [ ] `src/stores/appModeStore.ts` に `toStageEditor()` を追加
- [ ] `src/App.svelte` の mode 分岐に `'stage-editor'` → `StageEditorViewport` を追加（コンポーネントはスタブで OK）
- [ ] `src/components/ModeToggle.svelte` に「ステージエディタ」ボタンを追加
- **完了条件**: トップページからステージエディタ画面に遷移できる（中身は空でよい）
- **依存**: Task 1.1
- **推定時間**: 0.5h

---

### Phase 2: Three.js コア

#### Task 2.1: グリッドスナップ関数 + テスト

- [ ] `src/stage-editor/snapToGrid.ts` に `snapToGrid(value: number, snapSize: number): number` を実装
- [ ] `src/stage-editor/snapToGrid.test.ts` に T301–T308 のテストを実装
- [ ] `npm test` で全テスト PASS を確認
- **完了条件**: T301–T308 全 PASS
- **依存**: なし（Task 1.1 と並行可）
- **推定時間**: 0.5h

#### Task 2.2: Three.js シーン初期化

- [ ] `src/stage-editor/StageEditorScene.ts` を新規作成
  - `createStageEditorScene(canvas: HTMLCanvasElement)` ファクトリ関数
  - WebGLRenderer（antialias, shadowMap）初期化
  - PerspectiveCamera（fov:60）+ 初期位置 (10, 15, 20)、lookAt (0,0,0)
  - HemisphereLight + DirectionalLight（castShadow）
  - GridHelper（100×100、step:1）
  - `OrbitControls`（three/addons、damping 有効、minDistance:1, maxDistance:200）
  - `animate()` レンダーループ（controls.update + renderer.render）
  - `resize(w, h)` / `dispose()` 関数
- **完了条件**: `StageEditorViewport.svelte` に組み込んでグリッドが表示される
- **依存**: Task 1.3
- **推定時間**: 2h

#### Task 2.3: Mesh 生成・同期ロジック

- [ ] `src/stage-editor/StageEditorMeshSync.ts` を新規作成
  - `createGeometry(shape: ShapeType): THREE.BufferGeometry`（box/sphere/cylinder/cone）
  - `materialDefToThreeMaterial(def: MaterialDef): THREE.MeshStandardMaterial`
    - `textureDataUrl` がある場合は `TextureLoader().load(dataUrl)` でテクスチャ生成
  - `createMesh(def: StageObjectDef): THREE.Mesh`（geometry + material + transform 適用）
  - `syncUpdate(def: StageObjectDef, mesh: THREE.Mesh): void`（transform + material 更新）
  - `syncRemove(mesh: THREE.Mesh): void`（geometry/material/texture dispose）
- [ ] `src/stage-editor/materialDef.test.ts` に T601–T604 の自動テストを実装
- [ ] `npm test` で全テスト PASS を確認
- **完了条件**: T601–T604 全 PASS、Box がシーンに追加されて表示される
- **依存**: Task 2.2
- **推定時間**: 2h

#### Task 2.4: ゴーストプレビュー・選択ハイライト

- [ ] `src/stage-editor/StageEditorGizmo.ts` を新規作成
  - `createStageEditorGizmo(scene: THREE.Scene)` ファクトリ関数
  - `showGhost(shape: ShapeType, pos: THREE.Vector3): void`
    - 半透明マテリアル（color:#4488ff, opacity:0.4）
    - shape 変更時に geometry を差し替え
  - `hideGhost(): void`
  - `setSelection(mesh: THREE.Mesh): void`（emissive ハイライト）
  - `clearSelection(): void`（元マテリアルに戻す）
  - `dispose(): void`
- **完了条件**: マウスオーバーでゴーストが表示され、クリックで選択ハイライトが機能する
- **依存**: Task 2.2
- **推定時間**: 1.5h

---

### Phase 3: UI コンポーネント

#### Task 3.1: メインビューポート（canvas + イベント）

- [ ] `src/components/StageEditorViewport.svelte` を新規作成
  - `onMount` で `createStageEditorScene` を初期化
  - `mousemove` → `getSnappedPosition` → gizmo.showGhost（Place モード時）
  - `click`（drag < 4px のみ）→ Place モード: `stageEditorStore.addObject`, Select モード: Raycaster で選択
  - `keydown Delete` → 選択オブジェクト削除
  - `$: { ... }` で `stageEditorStore.objects` の変化を監視し `meshMap` を同期
  - `ResizeObserver` でリサイズ対応
  - `onDestroy` でリソース全破棄
- **完了条件**: Box を置けて選択・Delete 削除できる
- **依存**: Task 2.3, Task 2.4, Task 1.2
- **推定時間**: 3h

#### Task 3.2: 図形パネル + オブジェクトリスト

- [ ] `src/components/StageEditorShapePanel.svelte` を新規作成
  - 図形ボタン 4 個（Box/Sphere/Cylinder/Cone）→ `setActiveShape`
  - アクティブ図形をハイライト表示
  - オブジェクトリスト: `$stageEditorStore.objects` を一覧表示
    - リストアイテムクリック → `setSelected(id)` + Select モードに切替
    - 削除ボタン（×）→ `removeObject(id)`
- **完了条件**: 図形選択とオブジェクトリストが連動する
- **依存**: Task 1.2, Task 3.1
- **推定時間**: 1.5h

#### Task 3.3: プロパティパネル（位置・回転・スケール・マテリアル）

- [ ] `src/components/StageEditorPropsPanel.svelte` を新規作成
  - 選択オブジェクトの position/rotation/scale を数値入力（各 X/Y/Z）
  - 入力変更時に `updateObject` を呼ぶ
  - カラーピッカー（`<input type="color">`）→ `material.color` 更新
  - Roughness スライダー（0–1）→ `material.roughness` 更新
  - Metalness スライダー（0–1）→ `material.metalness` 更新
  - テクスチャアップロード（`<input type="file" accept="image/*">`）
    - FileReader で data URL に変換 → `material.textureDataUrl` 更新
  - 選択なし時はパネルを非アクティブ表示
- **完了条件**: プロパティ変更がビューポートに即座に反映される
- **依存**: Task 1.2, Task 3.1
- **推定時間**: 2h

#### Task 3.4: ツールバー

- [ ] `src/components/StageEditorToolbar.svelte` を新規作成
  - 「← エディタ」ボタン → `appModeStore.toEditor()`
  - Place / Select トグルボタン → `setToolMode`
  - スナップサイズセレクタ（0.5/1/2/4）→ `setSnapSize`
  - 「JSON 保存」ボタン → Exporter の `saveJson`
  - 「JSON 読み込み」ボタン → ファイル選択 → Exporter の `loadJson` → store に反映
  - 「GLB エクスポート」ボタン → Exporter の `exportGlb` → ダウンロード
  - 「🎮 FPS でテスト」ボタン → Exporter で GLB 生成 → Blob URL を store に保存 → `appModeStore.toFps()`
- **完了条件**: 各ボタンが期待通りに動作する
- **依存**: Task 3.1（Exporter は Task 4.1 完成後にフル動作）
- **推定時間**: 1.5h

---

### Phase 4: エクスポート機能

#### Task 4.1: JSON/GLB エクスポーター

- [ ] `src/stage-editor/StageEditorExporter.ts` を新規作成
  - `serializeScene(objects: StageObjectDef[]): string`（JSON 文字列）
  - `deserializeScene(json: string): SceneDef`（バージョンチェック + バリデーション）
  - `saveJson(objects: StageObjectDef[]): void`（Blob ダウンロード）
  - `loadJson(file: File): Promise<SceneDef>`
  - `exportGlb(meshMap: Map<string, THREE.Mesh>): Promise<ArrayBuffer>`
    - `GLTFExporter` を使い、Mesh を clone して transform を焼き込んでからエクスポート
    - `{ binary: true }` でテクスチャを GLB に埋め込む
  - `downloadBlob(blob: Blob, filename: string): void`（ヘルパー）
- [ ] `src/stage-editor/StageEditorExporter.test.ts` に T401–T504 のテストを実装
- [ ] `npm test` で全テスト PASS を確認
- **完了条件**: T401–T504 全 PASS、JSON 保存・読み込みが往復で一致する
- **依存**: Task 1.1
- **推定時間**: 2.5h

---

### Phase 5: FPS プレビュー連携

#### Task 5.1: FpsViewport の改修

- [ ] `src/components/FpsViewport.svelte` を改修
  - `stageEditorStore` から `previewGlbUrl` を読み取る
  - `previewGlbUrl` がある場合は `collision-world.glb` の代わりに Blob URL を使用
  - 「エディタへ戻る」ボタンの処理に以下を追加:
    - `URL.revokeObjectURL(previewGlbUrl)` でメモリ解放
    - `stageEditorStore.setPreviewGlbUrl(null)`
    - `appModeStore.toStageEditor()`
- **完了条件**: シナリオ 4（FPS プレビューフロー）が手動テストで通る
- **依存**: Task 3.4, Task 4.1
- **推定時間**: 1h

---

### Phase 6: 検証・仕上げ

#### Task 6.1: 自動テスト全実行

- [ ] `npm test` で全テストファイルを実行
- [ ] カバレッジ確認（`npx vitest run --coverage`）
- [ ] 失敗したテストを修正
- **完了条件**: 全テスト PASS、ストア + エクスポーターのカバレッジ 80% 以上
- **依存**: Task 1.2, Task 2.1, Task 2.3, Task 4.1
- **推定時間**: 0.5h

#### Task 6.2: 手動統合テスト

- [ ] シナリオ 1: 基本的なステージ作成フロー
- [ ] シナリオ 2: JSON 保存 → 読み込みの往復
- [ ] シナリオ 3: マテリアル適用 + GLB エクスポート
- [ ] シナリオ 4: FPS プレビューフロー（Octree 衝突確認）
- [ ] シナリオ 5: Delete キーによるオブジェクト削除
- **完了条件**: 全シナリオが期待結果通りに動作する
- **依存**: Task 5.1
- **推定時間**: 1h

#### Task 6.3: メモリリーク確認

- [ ] Chrome DevTools → Performance → Memory で FPS プレビュー前後のヒープサイズを確認
- [ ] `URL.revokeObjectURL` が正しく呼ばれていることをログで確認
- [ ] コンポーネント destroy 後に Three.js リソースが解放されることを確認
- **完了条件**: 明らかなメモリリークがない
- **依存**: Task 6.2
- **推定時間**: 0.5h

---

## 実装順序

```
Task 1.1（型定義）
  ├─ Task 1.2（ストア）→ Task 3.1（Viewport）→ Task 3.2, 3.3（パネル類）
  ├─ Task 1.3（AppMode 統合）
  └─ Task 2.1（スナップ関数）← 並行可

Task 2.2（Three.js シーン）
  ├─ Task 2.3（MeshSync）→ Task 3.1
  └─ Task 2.4（Gizmo）→ Task 3.1

Task 4.1（Exporter）→ Task 3.4（Toolbar フル動作）→ Task 5.1（FPS 連携）

Task 6.1（自動テスト）→ Task 6.2（手動テスト）→ Task 6.3（メモリ確認）
```

**クリティカルパス**: 1.1 → 1.2 → 2.2 → 2.3 → 3.1 → 4.1 → 5.1 → 6.2

---

## リスクと対策

- **GLTFExporter + Octree 互換性**: Task 6.2 シナリオ 4 で最優先確認。Mesh の transform を `applyMatrix4` で焼き込むことで対処
- **jsdom での `crypto.randomUUID` 未定義**: vitest setup ファイルで `vi.stubGlobal` を設定
- **Blob URL メモリリーク**: Task 6.3 で Chrome DevTools を使い実測

---

## 注意事項

- `class` は使わない（既存コード規約）。すべてファクトリ関数パターンで実装
- `any` / `unknown` 型禁止
- 各タスク完了後に `npm test` を実行してリグレッションを防ぐ
- Three.js オブジェクトは必ず `dispose()` を呼ぶ

---

## 実装開始ガイド

1. このタスクリストに従って順次実装を進めてください
2. 各タスクの開始時に TodoWrite で `in_progress` に更新
3. 完了時は `completed` に更新
4. 問題発生時は速やかに報告してください
