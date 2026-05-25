# 設計書 - FPS ステージエディタ

## 1. アーキテクチャ概観

```
既存 App.svelte
  └─ AppMode: 'stage-editor' を追加
       └─ StageEditorViewport.svelte（メインコンテナ）
            ├─ StageEditorToolbar.svelte     ← 上部ツールバー
            ├─ StageEditorShapePanel.svelte  ← 左パネル（図形選択・オブジェクト一覧）
            ├─ <canvas>                      ← Three.js ビューポート
            └─ StageEditorPropsPanel.svelte  ← 右パネル（位置・回転・スケール・マテリアル）
```

### 状態フロー

```
stageEditorStore（Svelte writable）
  ├─ objects: StageObjectDef[]      ← 正規データ（SSoT）
  ├─ selectedId: string | null
  ├─ toolMode: 'place' | 'select'
  ├─ activeShape: ShapeType
  ├─ snapSize: 0.5 | 1 | 2 | 4
  └─ previewGlbUrl: string | null   ← FPS プレビュー用 Blob URL

Three.js Scene（命令型）
  └─ meshMap: Map<id, THREE.Mesh>   ← store の objects と 1:1 同期
```

**UI → Store → Scene の一方向データフロー**を維持する。
Svelte の `$: { ... }` リアクティブ文で store の変化を検知し、meshMap を同期する。

---

## 2. ファイル構成

```
src/
  stage-editor/
    types.ts                    # 型定義（ShapeType, StageObjectDef, SceneDef）
    StageEditorScene.ts         # Three.js 初期化・グリッド・ライト・レンダーループ
    StageEditorGizmo.ts         # ゴーストプレビュー + 選択ハイライト
    StageEditorExporter.ts      # JSON 保存/読み込み + GLB エクスポート
    StageEditorMeshSync.ts      # store.objects ↔ meshMap の同期ロジック

  stores/
    stageEditorStore.ts         # エディタ全体の Svelte writable store

  components/
    StageEditorViewport.svelte  # メインコンポーネント（canvas + イベント制御）
    StageEditorToolbar.svelte   # モード切替・スナップ・保存・エクスポート・FPS プレビュー
    StageEditorShapePanel.svelte # 図形パレット + オブジェクトリスト
    StageEditorPropsPanel.svelte # 位置/回転/スケール + マテリアル設定
```

---

## 3. データモデル（types.ts）

```typescript
export type ShapeType = 'box' | 'sphere' | 'cylinder' | 'cone';

export type ToolMode = 'place' | 'select';

export type SnapSize = 0.5 | 1 | 2 | 4;

export type MaterialDef = {
  color: string;                 // CSS hex e.g. "#4488cc"
  roughness: number;             // 0.0 - 1.0
  metalness: number;             // 0.0 - 1.0
  textureDataUrl: string | null; // data:image/... or null
};

export type StageObjectDef = {
  id: string;                        // crypto.randomUUID()
  name: string;                      // 表示名 e.g. "Box_001"
  shape: ShapeType;
  position: readonly [number, number, number];  // world XYZ
  rotation: readonly [number, number, number];  // degrees XYZ (Euler)
  scale: readonly [number, number, number];      // XYZ
  material: MaterialDef;
};

export type SceneDef = {
  version: 1;
  objects: StageObjectDef[];
};
```

### デフォルトマテリアル
```typescript
export const DEFAULT_MATERIAL: MaterialDef = {
  color: '#888888',
  roughness: 0.7,
  metalness: 0.0,
  textureDataUrl: null,
};
```

---

## 4. ストア設計（stageEditorStore.ts）

```typescript
type StageEditorState = {
  objects: StageObjectDef[];
  selectedId: string | null;
  toolMode: ToolMode;
  activeShape: ShapeType;
  snapSize: SnapSize;
  previewGlbUrl: string | null;
};

// writable + 操作関数を返すファクトリ
export const stageEditorStore = createStageEditorStore();
```

操作関数（ミューテーション）:
- `addObject(def: Omit<StageObjectDef, 'id' | 'name'>): string` → id 返却
- `updateObject(id: string, partial: Partial<StageObjectDef>): void`
- `removeObject(id: string): void`
- `setSelected(id: string | null): void`
- `setToolMode(mode: ToolMode): void`
- `setActiveShape(shape: ShapeType): void`
- `setSnapSize(size: SnapSize): void`
- `setPreviewGlbUrl(url: string | null): void`

---

## 5. Three.js シーン設計（StageEditorScene.ts）

### 初期化
```
renderer: WebGLRenderer（antialias, shadows）
scene: Scene
  ├─ HemisphereLight (sky: #8dc1de, ground: #445544, intensity: 1.5)
  ├─ DirectionalLight (castShadow, position: (10,20,10))
  ├─ GridHelper (size: 100, divisions: 100, step: 1)  ← 補助グリッド
  └─ [動的 Mesh 群]
camera: PerspectiveCamera (fov: 60)
  └─ 初期位置: (10, 15, 20), lookAt: (0, 0, 0)
```

### OrbitControls 設定
```typescript
// three/addons/controls/OrbitControls.js を直接使用
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1;
controls.maxDistance = 200;
controls.maxPolarAngle = Math.PI * 0.49;  // 地面下まで回らない
```

`OrbitController.ts`（class 実装）は流用しない。
ステージエディタ専用のファクトリ関数 `createStageEditorOrbit` として実装し、class 禁止規約に従う。

### レンダーループ
```typescript
renderer.setAnimationLoop(() => {
  controls.update();   // damping
  ghost.update();      // ゴースト位置更新
  renderer.render(scene, camera);
});
```

---

## 6. グリッドスナップとレイキャスト（StageEditorScene.ts）

### XZ 平面への投影
```typescript
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);  // y=0 平面

function getSnappedPosition(event: MouseEvent, snapSize: number): THREE.Vector3 | null {
  raycaster.setFromCamera(ndc(event, canvas), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
  return new THREE.Vector3(
    Math.round(hit.x / snapSize) * snapSize,
    0,
    Math.round(hit.z / snapSize) * snapSize,
  );
}
```

- **配置モード**: mousemove → `getSnappedPosition` → ゴーストを移動
- **選択モード**: click → `raycaster.intersectObjects(meshes)` → 最近傍を選択

### OrbitControls との競合回避
- `mousemove` は常に処理（OrbitControls は dragstart/dragend で管理）
- `click` は `mousedown` からのドラッグ距離 < 3px の場合のみ処理

---

## 7. ゴーストプレビュー（StageEditorGizmo.ts）

```typescript
type StageEditorGizmo = {
  showGhost(shape: ShapeType, pos: THREE.Vector3): void;
  hideGhost(): void;
  setSelection(mesh: THREE.Mesh | null): void;
  clearSelection(): void;
  dispose(): void;
};
```

### ゴーストメッシュ
- 半透明マテリアル: `MeshStandardMaterial({ color: 0x4488ff, opacity: 0.4, transparent: true })`
- shape が切り替わるたびに geometry を差し替え
- シーンには常時 1 つだけ存在（配置確定時は `visible = false`）

### 選択ハイライト
- 選択時に対象 Mesh のマテリアルを clone し `emissive = 0x224422` を設定
- 選択解除時に元のマテリアルに戻す

---

## 8. Mesh 生成（StageEditorMeshSync.ts）

### 図形 → Geometry マッピング
```typescript
function createGeometry(shape: ShapeType): THREE.BufferGeometry {
  switch (shape) {
    case 'box':      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':   return new THREE.SphereGeometry(0.5, 16, 12);
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
    case 'cone':     return new THREE.ConeGeometry(0.5, 1, 16);
  }
}
```

### マテリアル → Three.js MeshStandardMaterial
- `textureDataUrl` がある場合: `TextureLoader().load(dataUrl)` でテクスチャ生成
- テクスチャは `Blob URL` ではなく `data: URL` で保持（JSON シリアライズ可能）

### store 変化 → meshMap 同期
```typescript
// 追加
function syncAdd(def: StageObjectDef): void { ... }

// 更新（position/rotation/scale/material）
function syncUpdate(def: StageObjectDef, mesh: THREE.Mesh): void { ... }

// 削除
function syncRemove(id: string): void { mesh.geometry.dispose(); ... }
```

---

## 9. エクスポート（StageEditorExporter.ts）

### JSON 保存
```typescript
function saveJson(objects: StageObjectDef[]): void {
  const def: SceneDef = { version: 1, objects };
  const blob = new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' });
  downloadBlob(blob, 'stage.json');
}
```

### JSON 読み込み
```typescript
function loadJson(file: File): Promise<SceneDef>
// → JSON.parse + バージョンチェック + 型バリデーション
```

### GLB エクスポート
```typescript
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

async function exportGlb(scene: THREE.Scene, meshMap: Map<string, THREE.Mesh>): Promise<ArrayBuffer> {
  // グリッドヘルパー等を除いた Mesh だけのグループを作る
  const exportGroup = new THREE.Group();
  for (const mesh of meshMap.values()) exportGroup.add(mesh.clone());

  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(exportGroup, (result) => resolve(result as ArrayBuffer), reject, { binary: true });
  });
}
```

- `Octree.fromGraphNode()` は `THREE.Mesh` を再帰的に収集するので、エクスポートグループに Mesh が含まれていれば衝突が機能する
- テクスチャは `binary: true` で GLB に埋め込まれる

---

## 10. FPS プレビューモード

### フロー
```
[FPS でテスト] ボタン
  → exportGlb() → ArrayBuffer
  → Blob → URL.createObjectURL()
  → stageEditorStore.setPreviewGlbUrl(url)
  → appModeStore.toFps()

FpsViewport.svelte
  → previewGlbUrl が store にあれば collision-world.glb の代わりに使用
  → 「エディタへ戻る」ボタン
       → URL.revokeObjectURL(url)  ← メモリ解放
       → stageEditorStore.setPreviewGlbUrl(null)
       → appModeStore.toStageEditor()
```

### FpsViewport の改修
```typescript
// 既存の load 呼び出しを変更
const mapUrl = get(stageEditorStore).previewGlbUrl
  ?? `${base}models/gltf/collision-world.glb`;
world.load(scene, mapUrl, ...);
```

### AppMode の拡張
```typescript
// src/types/index.ts
export type AppMode = 'editor' | 'game' | 'retarget' | 'anim-editor' | 'fps' | 'stage-editor';

// src/stores/appModeStore.ts
toStageEditor(): void { set('stage-editor'); },
```

---

## 11. UI レイアウト

```
┌──────────────────────────────────────────────────────────────────┐
│ [← エディタ]  [Place|Select]  スナップ:[1▼]  [JSON保存][JSON読込]  │  ← Toolbar (48px)
│                               [GLBエクスポート]  [🎮 FPSでテスト] │
├──────────┬───────────────────────────────────┬───────────────────┤
│          │                                   │ Properties        │
│ 図形     │                                   │ ─────────────     │
│ [Box]    │       3D Viewport (canvas)        │ 位置 X Y Z        │
│ [Sphere] │                                   │ 回転 X Y Z        │
│ [Cylind] │                                   │ スケール X Y Z    │
│ [Cone]   │                                   │ ─────────────     │
│ ─────    │                                   │ マテリアル        │
│ Objects  │                                   │ Color [   ]       │
│ Box_001  │                                   │ Roughness ─●──    │
│ Box_002  │                                   │ Metalness ●────   │
│ Sphere_1 │                                   │ Texture [upload]  │
└──────────┴───────────────────────────────────┴───────────────────┘
  220px            flex: 1                          240px
```

---

## 12. 既存コードへの統合変更

| ファイル | 変更内容 |
|---|---|
| `src/types/index.ts` | `AppMode` に `'stage-editor'` を追加 |
| `src/stores/appModeStore.ts` | `toStageEditor()` メソッドを追加 |
| `src/components/ModeToggle.svelte` | ステージエディタへの遷移ボタンを追加 |
| `src/components/FpsViewport.svelte` | `previewGlbUrl` を参照してマップ URL を切り替え |
| `src/App.svelte`（または相当コンポーネント） | `mode === 'stage-editor'` で `StageEditorViewport` をレンダリング |

**vite.config.ts の変更は不要**（既存アプリの AppMode として統合するため）。

---

## 13. 技術リスクと対策

| リスク | 詳細 | 対策 |
|---|---|---|
| Octree 互換性 | `fromGraphNode` は `Mesh` ノードが world transform を持つことを前提 | エクスポートグループに `clone()` を使い、`applyMatrix4` で transform を焼き込む |
| data: URL サイズ | テクスチャを data URL で JSON に埋め込むと巨大になる | テクスチャは 1024px 上限でリサイズしてから格納 |
| Blob URL リーク | FPS プレビュー後に URL が残る | `appModeStore` の subscribe で `fps → 他` の遷移を検知し自動 revoke |
| OrbitControls + Raycaster 競合 | ドラッグ中に click 判定が誤発火 | `mousedown` 座標と `mouseup` 座標の距離が 4px 未満の場合のみ配置/選択を実行 |

---

## 14. 実装順序（タスク分割の指針）

1. `types.ts` + `stageEditorStore.ts` の型・ストア骨格
2. `StageEditorScene.ts` — Three.js 初期化・グリッド・OrbitControls
3. `StageEditorMeshSync.ts` — 図形生成・meshMap 管理
4. `StageEditorGizmo.ts` — ゴーストプレビュー・選択ハイライト
5. `StageEditorViewport.svelte` — canvas・イベント制御・store → scene 同期
6. `StageEditorShapePanel.svelte` + `StageEditorPropsPanel.svelte`
7. `StageEditorToolbar.svelte`
8. `StageEditorExporter.ts` — JSON / GLB
9. AppMode 統合（types, store, ModeToggle, App.svelte）
10. FPS プレビュー連携（FpsViewport 改修）
