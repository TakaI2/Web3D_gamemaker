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

---

## 技術スタック

| カテゴリ | ライブラリ |
|---|---|
| 3D レンダリング | [Three.js](https://threejs.org/) v0.170 |
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
npm run dev       # 開発サーバー起動 (https://localhost:5173/htdocs/3d_game/)
npm run build     # 本番ビルド → dist/
npm test          # Vitest でユニットテスト実行
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
