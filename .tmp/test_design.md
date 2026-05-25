# テスト設計書 - FPS ステージエディタ

## 1. テスト概要

### 1.1 テスト目的

- `stageEditorStore` のストア操作が正しく状態を管理することを保証する
- `StageEditorMeshSync` のデータ変換ロジック（図形生成・マテリアル変換）が正確であることを検証する
- `StageEditorExporter` の JSON/GLB シリアライズが往復（serialize → deserialize）後に同一データを再現できることを確認する
- グリッドスナップ計算が全 snapSize で正しく機能することを検証する

### 1.2 テスト範囲

**対象（自動テスト可能なピュアロジック）:**
- `stageEditorStore` — 状態管理・ミューテーション
- グリッドスナップ関数 — 座標計算
- シーン JSON シリアライズ/デシリアライズ — `StageEditorExporter`
- `StageObjectDef` のマテリアル変換ロジック
- SceneDef バージョン検証

**対象外（WebGL/DOM 依存のため手動テスト）:**
- Three.js レンダリング結果
- OrbitControls の操作感
- Raycaster のクリック判定
- GLB エクスポートファイルの実際の衝突動作
- FPS プレビューモードの統合フロー

### 1.3 テスト環境

- 環境: jsdom（vitest、既存 `vite.config.ts` の `test.environment: 'jsdom'` を流用）
- テストフレームワーク: vitest
- ファイル配置: `src/stage-editor/*.test.ts`

---

## 2. テストケース設計

### 2.1 stageEditorStore のテストケース

#### 2.1.1 正常系テスト

| ID   | テストケース名 | 操作 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T001 | オブジェクト追加 | `addObject({ shape: 'box', position: [0,0,0], rotation: [0,0,0], scale: [1,1,1], material: DEFAULT_MATERIAL })` | `objects` に 1 件追加、返値は UUID 文字列 | High |
| T002 | 複数オブジェクト追加 | `addObject` を 3 回呼ぶ | `objects.length === 3`、各 id が異なる | High |
| T003 | オブジェクト更新 | T001 後に `updateObject(id, { position: [1,2,3] })` | `objects[0].position === [1,2,3]`、他フィールドは不変 | High |
| T004 | オブジェクト削除 | T001 後に `removeObject(id)` | `objects.length === 0` | High |
| T005 | 選択 ID 設定 | `setSelected('abc')` | `selectedId === 'abc'` | High |
| T006 | 選択解除 | `setSelected('abc')` → `setSelected(null)` | `selectedId === null` | High |
| T007 | ツールモード切替 | `setToolMode('select')` | `toolMode === 'select'` | Medium |
| T008 | スナップサイズ切替 | `setSnapSize(2)` | `snapSize === 2` | Medium |
| T009 | 図形タイプ切替 | `setActiveShape('sphere')` | `activeShape === 'sphere'` | Medium |
| T010 | previewGlbUrl 設定・クリア | `setPreviewGlbUrl('blob:...')` → `setPreviewGlbUrl(null)` | null に戻る | Medium |

#### 2.1.2 異常系テスト

| ID   | テストケース名 | 操作 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T101 | 存在しない id の更新 | `updateObject('nonexistent', { position: [1,0,0] })` | `objects` が変化しない（例外なし） | High |
| T102 | 存在しない id の削除 | `removeObject('nonexistent')` | `objects` が変化しない（例外なし） | High |
| T103 | 削除後に同 id を再削除 | `addObject` → `removeObject(id)` → `removeObject(id)` | 2 回目は何も起きない | Medium |

#### 2.1.3 境界値テスト

| ID   | テストケース名 | 入力 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T201 | position に極大値 | `position: [1e6, 1e6, 1e6]` | そのまま格納される | Low |
| T202 | scale に 0 | `scale: [0, 0, 0]` | そのまま格納される（Three.js 側の問題） | Low |
| T203 | material.roughness 境界 | `roughness: 0`, `roughness: 1` | それぞれ正常に格納 | Medium |

---

### 2.2 グリッドスナップ関数のテストケース

`snapToGrid(value: number, snapSize: number): number` を単体テスト

#### 2.2.1 正常系テスト

| ID   | テストケース名 | 入力 (value, snap) | 期待結果 | 優先度 |
|------|--------------|-------------------|----------|--------|
| T301 | snap=1, ちょうど整数 | (3.0, 1) | 3 | High |
| T302 | snap=1, 切り上げ | (3.6, 1) | 4 | High |
| T303 | snap=1, 切り捨て | (3.4, 1) | 3 | High |
| T304 | snap=2, 偶数境界 | (3.0, 2) | 4 | High |
| T305 | snap=0.5, 小数 | (1.3, 0.5) | 1.5 | High |
| T306 | snap=4, 負の値 | (-3.0, 4) | -4 | High |
| T307 | snap=1, ゼロ | (0.0, 1) | 0 | Medium |
| T308 | snap=2, 負の小数 | (-1.1, 2) | 0 (← -2 でなく 0) | Medium |

---

### 2.3 StageEditorExporter のテストケース

#### 2.3.1 JSON シリアライズ/デシリアライズ（往復テスト）

| ID   | テストケース名 | 操作 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T401 | 空シーンの往復 | `serializeScene([])` → `deserializeScene(json)` | `objects.length === 0` | High |
| T402 | 単一 Box の往復 | box オブジェクトを serialize → deserialize | 全フィールドが元と一致 | High |
| T403 | テクスチャあり往復 | `textureDataUrl: 'data:image/png;base64,abc'` を含む往復 | dataUrl が保持される | High |
| T404 | 4 図形全種の往復 | box/sphere/cylinder/cone 各 1 個 | shape フィールドが正しく復元 | High |
| T405 | version フィールドの存在 | serialize 結果 | `{ version: 1, objects: [...] }` | Medium |

#### 2.3.2 デシリアライズ異常系

| ID   | テストケース名 | 入力 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T501 | 不正 JSON | `deserializeScene('not json')` | エラーをスロー or null 返却 | High |
| T502 | version 不一致 | `{ version: 99, objects: [] }` | エラーをスロー or null 返却 | High |
| T503 | objects が配列でない | `{ version: 1, objects: null }` | エラーをスロー or null 返却 | High |
| T504 | 必須フィールド欠損 | `shape` フィールドなしのオブジェクト | そのオブジェクトをスキップ or エラー | Medium |

---

### 2.4 マテリアル変換ロジックのテストケース

`materialDefToThree(def: MaterialDef): THREE.MeshStandardMaterialParameters` を単体テスト

| ID   | テストケース名 | 入力 | 期待結果 | 優先度 |
|------|--------------|------|----------|--------|
| T601 | 色変換 | `color: '#ff0000'` | `three.color === new Color('#ff0000')` | High |
| T602 | roughness 変換 | `roughness: 0.3` | `three.roughness === 0.3` | High |
| T603 | metalness 変換 | `metalness: 0.8` | `three.metalness === 0.8` | High |
| T604 | テクスチャなし | `textureDataUrl: null` | `three.map === null` | High |

---

### 2.5 統合テストシナリオ（手動）

#### シナリオ 1: 基本的なステージ作成フロー

1. **前提条件**: ステージエディタが開いている（Place モード、snapSize=1）
2. **手順**:
   - Step 1: 図形パレットで「Box」を選択
   - Step 2: ビューポートでマウスを動かし、グリッド上にゴーストが表示されることを確認
   - Step 3: (0,0,0) 付近でクリック → Box が配置される
   - Step 4: さらに (2,0,0) にクリック → 2 個目の Box が配置される
   - Step 5: Select モードに切り替え、1 個目の Box をクリック
   - Step 6: プロパティパネルで Y 位置を 2 に変更
   - Step 7: JSON 保存ボタンを押す
3. **期待結果**:
   - `stage.json` がダウンロードされる
   - JSON に 2 オブジェクトが含まれ、1 個目の `position[1] === 2`

#### シナリオ 2: JSON 保存 → 読み込みの往復

1. **前提条件**: シナリオ 1 完了後
2. **手順**:
   - Step 1: ページリロード（またはシーンクリア）
   - Step 2: 「JSON 読み込み」で `stage.json` をアップロード
3. **期待結果**:
   - 保存前と同じ 2 個の Box が同じ位置に復元される

#### シナリオ 3: マテリアル適用

1. **前提条件**: Box が 1 個配置済み
2. **手順**:
   - Step 1: Box を選択
   - Step 2: カラーピッカーで赤 (`#ff0000`) を設定 → ビューポートの Box が即座に赤くなる
   - Step 3: テクスチャ画像（PNG）をアップロード → テクスチャが適用される
   - Step 4: GLB エクスポート
3. **期待結果**: GLB ファイルがダウンロードされ、ファイルサイズが非ゼロ

#### シナリオ 4: FPS プレビューフロー

1. **前提条件**: 床になる Box（scale: [20, 0.5, 20], position: [0, -0.25, 0]）が配置済み
2. **手順**:
   - Step 1: 「FPS でテスト」ボタンを押す
   - Step 2: FPS ビューポートが起動しキャンバスをクリック（PointerLock 取得）
   - Step 3: WASD で移動し、床の上を歩けることを確認
   - Step 4: 「エディタへ戻る」ボタンを押す
3. **期待結果**:
   - エディタに戻り、配置したオブジェクトが維持されている
   - ブラウザのメモリに Blob URL が残留していない（devtools で確認）

#### シナリオ 5: Delete キーによるオブジェクト削除

1. **前提条件**: Box が 3 個配置済み
2. **手順**:
   - Step 1: Select モードで中央の Box をクリック（ハイライトされる）
   - Step 2: Delete キーを押す
3. **期待結果**: ビューポートから中央の Box が消え、オブジェクトリストが 2 件になる

---

## 3. テストデータ設計

### 3.1 標準テストオブジェクト

```typescript
const TEST_BOX: StageObjectDef = {
  id: 'test-id-box',
  name: 'Box_001',
  shape: 'box',
  position: [1, 0, 2],
  rotation: [0, 45, 0],
  scale: [1, 2, 1],
  material: {
    color: '#4488cc',
    roughness: 0.5,
    metalness: 0.1,
    textureDataUrl: null,
  },
};

const TEST_SCENE_DEF: SceneDef = {
  version: 1,
  objects: [TEST_BOX],
};
```

### 3.2 異常系データ

```typescript
const INVALID_JSON = 'not-valid-json{{{';
const WRONG_VERSION = JSON.stringify({ version: 99, objects: [] });
const MISSING_SHAPE = JSON.stringify({
  version: 1,
  objects: [{ id: 'x', position: [0,0,0] }],  // shape フィールドなし
});
```

---

## 4. パフォーマンステスト

### 4.1 オブジェクト数スケール

| 条件 | 期待値 |
|---|---|
| 100 オブジェクト配置時のフレームレート | 60fps 維持 |
| 500 オブジェクト配置時のフレームレート | 30fps 以上 |
| 100 オブジェクトの JSON シリアライズ時間 | 10ms 以下 |
| 100 オブジェクトの GLB エクスポート時間 | 3 秒以下 |

### 4.2 テクスチャメモリ

| 条件 | 期待値 |
|---|---|
| 1024px テクスチャ 10 枚適用 | GPU メモリ急増なし（漸増）|
| テクスチャ削除後 | `dispose()` により GPU メモリが解放される |

---

## 5. セキュリティテスト

### 5.1 入力検証

| 項目 | テスト内容 | 期待結果 |
|---|---|---|
| JSON インジェクション | `name` フィールドに `<script>alert(1)</script>` | そのまま文字列として扱われる（innerHTML 不使用） |
| 巨大テクスチャ | 10MB の PNG をアップロード | リサイズ処理 or エラーメッセージ（ブラウザクラッシュなし） |
| 不正 data URL | `textureDataUrl: 'javascript:alert(1)'` | `data:image/` プレフィックスチェックで拒否 |

### 5.2 Blob URL 管理

| 項目 | 期待結果 |
|---|---|
| FPS プレビュー終了後 | `URL.revokeObjectURL` が呼ばれている |
| コンポーネント破棄時 | 残存 Blob URL がすべて revoke される |

---

## 6. テスト実行計画

### 6.1 自動テスト（vitest）

実行コマンド: `npm test` または `npx vitest run`

| テストファイル | 対象 | 自動化優先度 |
|---|---|---|
| `src/stage-editor/stageEditorStore.test.ts` | T001–T203 | High |
| `src/stage-editor/snapToGrid.test.ts` | T301–T308 | High |
| `src/stage-editor/StageEditorExporter.test.ts` | T401–T504 | High |
| `src/stage-editor/materialDef.test.ts` | T601–T604 | Medium |

### 6.2 手動テスト

- シナリオ 1–5 は実装完了後に手動実行
- FPS プレビューは実際の `Octree` 衝突を検証するため必ず手動確認

### 6.3 合格基準

- 自動テスト: 全ケース PASS、カバレッジ 80% 以上（ストア・エクスポータのロジック層）
- 手動テスト: シナリオ 1–5 全て期待結果通り
- GLB → FPS Octree: 床 Box の上を歩けること

---

## 7. リスクと対策

| リスク | 影響度 | 発生確率 | 対策 |
|---|---|---|---|
| GLTFExporter API の breaking change | High | Low | `three` のバージョンを固定し、エクスポート後に FPS で必ず動作確認 |
| jsdom で `crypto.randomUUID` が未定義 | Medium | Medium | vitest の setup で `vi.stubGlobal('crypto', { randomUUID: () => 'test-id' })` |
| data URL のサイズが JSON を肥大化 | Medium | High | テスト用 data URL は最小 PNG (`data:image/png;base64,iVBOR...`) を使う |
| Blob URL が revoke されずメモリリーク | High | Medium | onDestroy フックで必ず revoke する実装をテストシナリオで手動確認 |

---

## 8. テスト自動化戦略

### 8.1 自動化対象

- ストア操作（CRUD）: 純粋な JS ロジックなので 100% 自動化
- スナップ計算: 数値計算なので 100% 自動化
- JSON シリアライズ: ファイル I/O を除く変換ロジックを自動化

### 8.2 自動化対象外（理由）

- Three.js の Mesh 生成・GPU 操作: WebGL コンテキストが jsdom では使えない
- OrbitControls: DOM イベントと requestAnimationFrame に依存
- GLB バイナリ構造: バイナリ差分テストは費用対効果が低い

### 8.3 CI/CD 統合

既存の `vite.config.ts` の `test` 設定を流用。新規テストファイルは `src/stage-editor/*.test.ts` に配置するだけで自動検出される。
