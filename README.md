# Web3D GameMaker

Three.js + Svelte 4 + TypeScript で構築した、ブラウザ上で動く **3D キャラクターエディタ & ゲーム**。

**デプロイ先**: https://www.netowl.jp/htdocs/3d_game/

---

## 機能概要

### エディタモード

| タブ | 内容 |
|---|---|
| **VRM** | VRM モデルの読み込み・VRMA アニメーション再生・スプリングボーン・リップシンク・WebXR・ボーン表示 |
| **MMD** | PMX モデルの読み込み・VMD モーション再生・スケール調整・ボーン表示 |
| **FBX** | FBX モデルの読み込み・埋め込みアニメーション再生・スケール調整・ボーン表示 |

- OrbitControls（回転・ズーム・パン）
- **Shift + 左ドラッグ**でモデルスケールを連続変更
- サーバーの `public/` フォルダにあるファイルをワンクリック読み込み

### 比較ビュー（リターゲット確認）

左右に独立したビューポートを並べ、変換元と変換先を同時に表示・再生して比較できる。

- 左右それぞれで VRM / MMD / FBX を自由に組み合わせて読み込み
- VRMA / VMD アニメーションの追加読み込み・再生・ループ制御
- スケール調整（ボタン・Shift ドラッグ）
- サーバーファイルピッカー対応

### ゲームモード

3D フィールドでの三人称視点サバイバル。

- WASD / 矢印キーで移動（カメラ相対方向）
- 5 体のエネミーが追跡してくる
- 生存時間スコア・ローカルストレージハイスコア
- WebXR (Quest 3) 対応 — 左スティックで移動

### FBX → VRMA コンバーター

Mixamo FBX アニメーションを VRM 対応 VRMA フォーマットに変換する。

- `skeleton.boneInverses` からバインドポーズを取得し FBX の PreRotation を除去
- ボーンマッピング（Mixamo → VRM humanoid）
- ブラウザ上でダウンロードまで完結

### FPS スタンドアローンモード

WebGPU ベースの FPS デモ（`src/fps/`）。

- WASD 移動・マウス視点（Pointer Lock）
- Octree + Capsule によるコリジョン物理
- 高低差のあるプロシージャルレベル（階段・プラットフォーム・柱）

デプロイ先: `/htdocs/fps/`

### 布シミュレーション（cloth）

WebGPU コンピュートシェーダーによる布物理シミュレーション（`cloth/`）。

- TSL（Three.js Shader Language）の `instancedArray` + `Fn` で Verlet 積分
- 布枚数・セグメント数・剛性・風力をリアルタイム変更
- 球コリジョン・シェーン（Sheen）マテリアル対応
- **布形状パラメータ**: 四角 / 台形 / 半円、上端幅・下端幅・高さ・ピン数・上端曲率（肩フィット用）
- 作成した布形状を **`.cloth.json`** としてエクスポート（布エディタへの入力）
- **WebGPU 必須**（HTTPS 接続が必要）

デプロイ先: `/htdocs/cloth/`

```bash
npm run build:cloth   # dist-cloth/ に出力
```

### 布エディタ（cloth-editor）

VRM モデルに布シミュレーションを適用する専用エディタ（`cloth-editor/`）。スタンドアローン HTML+JS。

**機能:**
- VRM モデルを読み込み、任意のメッシュを布シミュレーションに変換
- `/cloth/` で作成した `.cloth.json`（マントなど）を読み込んでキャラに着せる
- ピン頂点の手動指定（`P` キーで編集モード、黄色マーカー表示）
- VRM ヒューマノイドボーンから球コライダーを自動生成（布が体を貫通しない）
- 剛性 / 減衰 / 風のリアルタイム調整
- マウスドラッグによる頂点グラブ操作

**手グリップシステム:**

ゲーム中にキャラがマントを掴む動作をプログラム制御できる仕組み。

- シミュ停止中に L手 / R手 グリップ頂点を指定（青・橙マーカー）
- シミュ実行中に **`L` / `R` キー長押し**でグリップ動作をテスト（頂点がマウスカーソルに追従）
- `window.clothAPI` 経由でゲームコードから呼び出し可能

```js
clothAPI.gripLeft(x, y, z)   // 左手グリップ ON + ワールド座標をターゲットに設定
clothAPI.gripRight(x, y, z)  // 右手グリップ ON
clothAPI.releaseLeft()        // 左手グリップ解放
clothAPI.releaseRight()       // 右手グリップ解放
```

**技術的特記事項:**
- WebGPU ストレージバッファ上限（8 個）対策として、グリップマスクを `vertexParamsBuffer (uvec4)` の `.w` に格納
- MToon v0 (`ShaderMaterial`) → `MeshPhysicalNodeMaterial` の自動変換（WebGPU NodeBuilder 互換化）

デプロイ先: `/htdocs/cloth-editor/`（ビルド不要、そのままコピー）

### FPS + 布シミュレーション複合デモ（fps-cloth）

FPS 移動と布シミュレーションを組み合わせたデモ（`fps-cloth/`）。

- 高低差のあるプロシージャルレベル（`buildLevel()`）+ Octree コリジョン
- WebGPU コンピュートシェーダーによる布物理（最大 10 枚）
- ポインターロック解除なしにセッティングパネルを操作可能
- **WebGPU 必須**（HTTPS 接続が必要）

デプロイ先: `/htdocs/fps-cloth/`

```bash
npm run build:fps-cloth   # dist-fps-cloth/ に出力
```

> **注意**: 布シミュレーションおよび FPS-cloth デモは WebGPU を使用するため **HTTPS** でアクセスする必要があります。HTTP 環境では WebGL2 にフォールバックしますが、布の物理演算が正常に動作しません。

### FPS + VRM NPC + ラグドール（fps-cloth-vrm）

FPS 視点で VRM NPC（マント付き布シミュ）と対話するデモ（`fps-cloth-vrm/`）。

- VRM NPC + VRMA アニメ再生 + マント布シミュ（GPU）+ タイムライン再生
- NPC 一括バンドル（`.npc.json` = VRM+VRMA+Cloth+Timeline）読込・群衆クローン（最大 10 体）
- **右クリックで球を発射** → NPC 命中で**ラグドール化**（崩れ落ち）。倒れた体も追撃で小突ける
- **R キー**で倒れている全 NPC が**滑らかに起き上がる**（復帰ブレンド）
- マントは**床との当たり判定**付き（立ち時・ラグドール時とも床に乗る）
- NPC#0・群衆 NPC ともラグドール対応

デプロイ先: `/htdocs/fps-cloth-vrm/`

```bash
npm run build:fps-cloth-vrm   # dist-fps-cloth-vrm/ に出力（lib 同梱・import 書換）
```

### 振り回しキャッチ（swing-catch）

FPS 視点のサンドボックスゲーム（`swing-catch/`）。空中を漂うオブジェクトを相手に遊ぶ。

- **左クリック長押し**で照準先をキャッチ → スプリングで繋がりブンブン振り回し → 離すと勢いそのまま投擲
- **右クリック**で球を発射してオブジェクトを吹っ飛ばす
- 無重力で漂い壁で反射する多形状オブジェクト（箱型アリーナ）
- 物理はすべて自前実装（固定タイムステップ・スプリング・運動量保存）

デプロイ先: `/htdocs/swing-catch/`

```bash
npm run build:swing-catch   # dist-swing-catch/ に出力
```

### VRM ラグドールシステム（lib/vrm-ragdoll.js）

物理エンジン不使用の自前 **PBD スケルタルラグドール**。複数デモで再利用できる共有モジュール。

- humanoid ボーンを粒子 + 距離拘束として扱い、重力で崩して床に倒す（Verlet/PBD）
- **部位別の角度制限（コーン）**で首 180°折れや関節の過伸展を防止
- 関節粒子の AABB から境界球を算出し、**VRM 単位のフラスタムカリング**（多数体でも軽い）
- `grab` ライクなトグル API:

```js
const rd = createRagdoll(vrm, { boneMaxBend: { neck: 40, lowerLeg: 95 } });
setRagdollActive(rd, true);                                 // 崩れ落ち開始（呼び出し側でアニメ停止）
applyRagdollImpulse(rd, dir.multiplyScalar(0.3), 'chest');  // 被弾の撃力
// 毎フレーム: updateRagdoll(rd, dt, { floorY: 0, frustum }) → vrm.update(dt)
setRagdollActive(rd, false);                                // 復帰（updateRagdollRecovery で補間）
```

---

## 最近の追加

- **`lib/vrm-ragdoll.js`**: 再利用可能な VRM ラグドール（被弾トリガー・部位別角度制限・復帰ブレンド・VRM 単位カリング）
- **`fps-cloth-vrm`**: 右クリック発射体 + NPC ラグドール（NPC#0 + 群衆）+ マントの床当たり判定
- **`swing-catch`**: 飛行オブジェクトのキャッチ＆振り回しサンドボックス（新規ゲーム）

---

## 技術スタック

| カテゴリ | ライブラリ |
|---|---|
| 3D レンダリング | [Three.js](https://threejs.org/) v0.170（メインアプリ）/ v0.184 CDN（cloth・fps-cloth） |
| VRM | [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) v3.4 |
| VRMA | [@pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm) v3.4 |
| UI フレームワーク | [Svelte 4](https://svelte.dev/) |
| ビルドツール | [Vite 5](https://vitejs.dev/) |
| 言語 | TypeScript (strict) |
| テスト | Vitest + jsdom |
| XR | WebXR API (`immersive-vr`) |

---

## ディレクトリ構成

```
cloth/
├── index.html        # 布シミュレーション UI（形状パラメータ・エクスポート対応）
└── cloth.js          # WebGPU 布物理（スタンドアローン）

cloth-editor/
├── index.html        # 布エディタ UI
└── cloth-editor.js   # VRM 布変換・ピン/グリップ指定・GPU シミュ・clothAPI

fps-cloth/
├── index.html        # FPS+布デモ UI
└── fps-cloth.js      # WebGPU 布物理 + FPS 移動 + Octree レベル

fps-cloth-vrm/
├── index.html        # FPS+VRM NPC+ラグドール UI
└── fps-cloth-vrm.js  # VRM NPC + マント布 + 発射体 + ラグドール統合

swing-catch/
├── index.html        # 振り回しキャッチ UI
└── swing-catch.js    # 飛行オブジェクトのキャッチ・振り回し・投擲（自前物理）

lib/
└── vrm-ragdoll.js    # 再利用可能な VRM PBD ラグドール（共有モジュール）

scripts/
├── build-cloth.mjs           # cloth のビルドスクリプト
├── build-fps-cloth.mjs       # fps-cloth のビルドスクリプト
├── build-fps-cloth-vrm.mjs   # fps-cloth-vrm のビルド（lib 同梱・import 書換）
└── build-swing-catch.mjs     # swing-catch のビルドスクリプト

src/
├── components/       # Svelte UI コンポーネント
│   ├── Viewport.svelte          # エディタ用メインビューポート
│   ├── RetargetViewport.svelte  # 比較ビュー（左右 2 画面）
│   ├── GameViewport.svelte      # ゲームモード用ビューポート
│   ├── ControlPanel.svelte      # 右側コントロールパネル
│   └── ...
├── core/             # Three.js 操作・モデル管理
│   ├── FbxModelLoader.ts        # FBX 読み込み・アニメーション
│   ├── FbxToVrmaConverter.ts    # FBX→VRMA 変換
│   ├── RetargetSlot.ts          # 比較ビュー用統合スロット
│   ├── SkeletonController.ts    # SkeletonHelper・ボーン選択
│   └── ...
├── game/             # ゲームモード実装
│   ├── InputManager.ts
│   ├── EnemyManager.ts
│   ├── PlayerController.ts
│   └── ...
├── stores/           # Svelte stores（状態管理）
├── utils/
│   ├── shiftDragScale.ts        # Shift+ドラッグスケール共通処理
│   └── ...
└── types/index.ts    # 共通型定義

public/
├── vrm/     # VRM モデル置き場
├── vrma/    # VRMA アニメーション置き場
├── pmx/     # PMX モデル置き場
├── vmd/     # VMD モーション置き場
└── fbx/     # FBX モデル・アニメーション置き場
```

---

## セットアップ

```bash
npm install
npm run dev           # 開発サーバー起動 (https://localhost:5173/htdocs/3d_game/)
npm run build         # メインアプリ本番ビルド → dist/
npm run build:cloth   # 布シミュレーション → dist-cloth/
npm run build:fps-cloth        # FPS+布デモ → dist-fps-cloth/
npm run build:fps-cloth-vrm    # FPS+VRM NPC+ラグドール → dist-fps-cloth-vrm/
npm run build:swing-catch      # 振り回しキャッチ → dist-swing-catch/
npm test              # Vitest でユニットテスト実行
```

> HTTPS が必要なため `@vitejs/plugin-basic-ssl` を使用。初回アクセス時にブラウザのセキュリティ警告を手動で許可してください。

---

## public/ へのファイル追加

各フォルダにファイルを置くだけで、開発サーバー・ビルド時に自動で `manifest.json` が生成されアプリ内のサーバーピッカーに表示されます。

| フォルダ | 対応形式 |
|---|---|
| `public/vrm/` | `.vrm` |
| `public/vrma/` | `.vrma` |
| `public/pmx/` | `.pmx`（サブフォルダ可） |
| `public/vmd/` | `.vmd`（サブフォルダ可） |
| `public/fbx/` | `.fbx` |
