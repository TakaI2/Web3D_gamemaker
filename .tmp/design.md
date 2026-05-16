# 詳細設計書 - VRM対応3Dキャラクターエディタ（Web/WebXR）

## 1. アーキテクチャ概要

### 1.1 システム構成図

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser / Quest 3                       │
│                                                             │
│  ┌───────────────────┐    ┌──────────────────────────────┐  │
│  │   Svelte UI Layer │    │      Three.js Core Layer     │  │
│  │                   │    │                              │  │
│  │  ControlPanel     │◄──►│  SceneManager                │  │
│  │  AnimationList    │    │  ├─ VRMLoader                │  │
│  │  LipSyncPanel     │    │  ├─ AnimationManager         │  │
│  │  SpringBonePanel  │    │  ├─ SpringBoneController     │  │
│  │  XRControls       │    │  ├─ RenderLoop               │  │
│  │  ModelLoader      │    │  └─ OrbitController          │  │
│  └─────────┬─────────┘    └──────────────┬───────────────┘  │
│            │                             │                   │
│            ▼                             ▼                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Svelte Stores                       │    │
│  │   vrmStore │ animationStore │ xrStore │ lipSyncStore │    │
│  └─────────────────────────────────────────────────────┘    │
│            │                             │                   │
│            ▼                             ▼                   │
│  ┌───────────────────┐    ┌──────────────────────────────┐  │
│  │   LipSync Layer   │    │        XR Layer              │  │
│  │                   │    │                              │  │
│  │  LipSyncEngine    │    │  XRSessionManager            │  │
│  │  JapaneseLipSync  │    │  XRUIManager (three-mesh-ui) │  │
│  │  EnglishLipSync   │    │                              │  │
│  └───────────────────┘    └──────────────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              <canvas> WebGL Viewport                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 技術スタック

| カテゴリ | ライブラリ / ツール | バージョン目安 | 用途 |
|---|---|---|---|
| レンダリング | three | ^0.170 | 3D描画エンジン |
| VRMサポート | @pixiv/three-vrm | ^3.x | VRM 0.x / 1.0 読み込み・SpringBone |
| VRMアニメーション | @pixiv/three-vrm-animation | ^3.x | .vrma 再生 |
| UI フレームワーク | svelte | ^5.x | リアクティブUI（コンパイル後バニラJS） |
| XR UI | three-mesh-ui | ^6.5.4 | WebXR内浮遊パネル |
| ビルド | vite | ^6.x | バンドル / HMR |
| 言語 | typescript | ^5.x | 型安全 |
| 型定義 | @types/three | three対応版 | Three.js型 |

---

## 2. ディレクトリ構成

```
src/
├── main.ts                      # エントリーポイント
├── App.svelte                   # ルートコンポーネント
│
├── core/                        # Three.js コアロジック
│   ├── SceneManager.ts          # シーン・カメラ・レンダラー管理
│   ├── VRMLoader.ts             # VRMファイル読み込み/破棄
│   ├── AnimationManager.ts      # VRMAアニメーション管理
│   ├── SpringBoneController.ts  # Spring Bone パラメータ制御
│   ├── OrbitController.ts       # OrbitControls ラッパー
│   └── RenderLoop.ts            # requestAnimationFrame ループ
│
├── xr/                          # WebXR 関連
│   ├── XRSessionManager.ts      # VR/ARセッションライフサイクル
│   └── XRUIManager.ts           # three-mesh-ui XRパネル
│
├── lipsync/                     # リップシンク処理
│   ├── LipSyncEngine.ts         # 統合エントリーポイント
│   ├── JapaneseLipSync.ts       # 仮名→Viseme変換
│   ├── EnglishLipSync.ts        # 英字パターン→Viseme変換
│   └── visemeMaps.ts            # マッピングテーブル定数
│
├── stores/                      # Svelte ストア（状態管理）
│   ├── vrmStore.ts
│   ├── animationStore.ts
│   ├── xrStore.ts
│   └── lipSyncStore.ts
│
├── components/                  # Svelte UIコンポーネント
│   ├── Viewport.svelte          # canvasコンテナ
│   ├── ControlPanel.svelte      # サイドバー統括
│   ├── ModelLoader.svelte       # D&Dドロップゾーン
│   ├── AnimationList.svelte     # アニメーション一覧
│   ├── AnimationControls.svelte # 再生・タイムライン
│   ├── SpringBonePanel.svelte   # SpringBone制御UI
│   ├── LipSyncPanel.svelte      # テキスト入力・口パク
│   └── XRControls.svelte        # VR/ARボタン
│
├── types/
│   └── index.ts                 # 共通型定義
│
└── utils/
    └── fileHelpers.ts           # File API ユーティリティ
```

---

## 3. コンポーネント設計

### 3.1 コンポーネント一覧

| コンポーネント | 責務 | 依存 |
|---|---|---|
| SceneManager | Three.js シーン・カメラ・レンダラーの初期化と管理 | RenderLoop |
| VRMLoader | VRMファイルのパース・シーン追加・メモリ解放 | SceneManager |
| AnimationManager | VRMAのロード・AnimationMixer管理・再生制御 | VRMLoader |
| SpringBoneController | VRM.springBoneManagerへのアクセス・パラメータ調整 | VRMLoader |
| OrbitController | OrbitControlsの有効/無効切り替え（XR中は無効） | SceneManager |
| RenderLoop | RAF ループ・delta時間管理・全更新処理の呼び出し | — |
| XRSessionManager | immersive-vr / immersive-ar セッション管理 | SceneManager |
| XRUIManager | three-mesh-uiでXRパネルを構築・コントローラーレイキャスト | XRSessionManager |
| LipSyncEngine | テキスト→Visemeシーケンス生成・タイマー駆動再生 | AnimationManager |
| JapaneseLipSync | ひらがな/カタカナ→母音→Viseme変換 | visemeMaps |
| EnglishLipSync | ASCII英字パターン→Viseme変換 | visemeMaps |

### 3.2 各コンポーネントの詳細

#### SceneManager

- **目的**: Three.js の Scene / PerspectiveCamera / WebGLRenderer を初期化・管理する唯一の窓口
- **公開インターフェース**:
  ```typescript
  interface SceneManagerAPI {
    readonly scene: THREE.Scene;
    readonly camera: THREE.PerspectiveCamera;
    readonly renderer: THREE.WebGLRenderer;
    init(canvas: HTMLCanvasElement): void;
    resize(width: number, height: number): void;
    dispose(): void;
  }
  ```
- **内部実装方針**:
  - `renderer.xr.enabled = true` でWebXR対応を有効化
  - DirectionalLight（intensity: 1.0）+ AmbientLight（intensity: 0.5）のデフォルト照明
  - GridHelper をオプション表示（Svelte storeの値を参照）
  - `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` でPixelRatio上限を2に制限（Quest 3 負荷対策）

#### VRMLoader

- **目的**: VRMファイルの読み込み・シーンへの追加・既存モデルの破棄
- **公開インターフェース**:
  ```typescript
  interface VRMLoaderAPI {
    load(file: File): Promise<VRM>;
    unload(): void;
    readonly current: VRM | null;
  }
  ```
- **内部実装方針**:
  - `GLTFLoader` に `VRMLoaderPlugin` を登録
  - `File` → `URL.createObjectURL()` → GLTFLoader で読み込み
  - 読み込み後に `URL.revokeObjectURL()` でメモリ解放
  - 既存 VRM の `dispose()` を呼び出してからシーン削除
  - VRM0/VRM1 の差異は `@pixiv/three-vrm` の抽象APIが吸収するためローダー側では意識しない

#### AnimationManager

- **目的**: 複数のVRMAファイルを管理し、AnimationMixerによる再生を制御する
- **公開インターフェース**:
  ```typescript
  type AnimationEntry = { name: string; clip: THREE.AnimationClip };

  interface AnimationManagerAPI {
    loadVRMA(file: File): Promise<void>;
    play(name: string): void;
    stop(): void;
    setLoop(enabled: boolean): void;
    setSpeed(multiplier: number): void;
    seek(normalizedTime: number): void;  // 0.0 〜 1.0
    resetTPose(): void;
    update(delta: number): void;
    readonly animations: AnimationEntry[];
    readonly currentAction: THREE.AnimationAction | null;
    readonly progress: number;  // 0.0 〜 1.0
  }
  ```
- **内部実装方針**:
  - VRMAロード: `GLTFLoader` + `VRMAnimationLoaderPlugin`
  - `createVRMAnimationClip(vrmAnimation, vrm)` でAnimationClipを生成
  - AnimationMixerは VRM 切り替え時に再生成
  - `animations` は `Map<string, THREE.AnimationClip>` で管理（ファイル名をキー）
  - 重複ファイル名は `name_1`, `name_2` 形式でリネーム

#### SpringBoneController

- **目的**: VRM Spring Bone の有効/無効切り替えとパラメータのリアルタイム調整
- **公開インターフェース**:
  ```typescript
  interface SpringBoneControllerAPI {
    setEnabled(enabled: boolean): void;
    setStiffness(value: number): void;   // 0.0 〜 4.0
    setDamping(value: number): void;     // 0.0 〜 1.0
    reset(): void;
    update(delta: number): void;
  }
  ```
- **内部実装方針**:
  - `vrm.springBoneManager` が存在しない場合はno-op
  - パラメータ変更は各JointのsettingsオブジェクトをVRM APIで書き換え
  - 無効時は `update()` をスキップしてCPU負荷を削減

#### LipSyncEngine

- **目的**: テキストをVisemeシーケンスに変換し、タイプライター表示と同期してVRM Expressionをアニメーションする
- **公開インターフェース**:
  ```typescript
  type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'neutral';

  interface LipSyncEngineAPI {
    play(text: string, charsPerSecond: number): void;
    stop(): void;
    readonly displayedText: string;   // タイプライター表示用（Storeに反映）
    readonly isPlaying: boolean;
  }
  ```
- **内部実装方針**:
  - テキストを1文字ずつ処理するタイマーを `setInterval` で駆動
  - 各文字を `JapaneseLipSync` / `EnglishLipSync` に振り分け（文字ごとにUnicode範囲チェック）
  - Viseme適用: `vrm.expressionManager.setValue(visemeKey, weight)` を `requestAnimationFrame` 内で補間
  - 停止・完了時は `setValue('neutral', 1.0)` で閉口状態に戻す
  - 次の Viseme への遷移は線形補間（LERP、係数0.3/frame）でなめらかに

#### XRSessionManager

- **目的**: immersive-vr / immersive-ar セッションのライフサイクルを管理する
- **公開インターフェース**:
  ```typescript
  type XRMode = 'vr' | 'ar';

  interface XRSessionManagerAPI {
    isSupported(mode: XRMode): Promise<boolean>;
    enterXR(mode: XRMode): Promise<void>;
    exitXR(): Promise<void>;
    readonly activeMode: XRMode | null;
    readonly isActive: boolean;
  }
  ```
- **内部実装方針**:
  - `navigator.xr.isSessionSupported()` で事前にサポート確認
  - セッション開始: `renderer.xr.setSession()` で Three.js に委譲
  - VR↔AR切り替え: 現セッション終了 → 新セッション開始（1フレーム待機）
  - セッション中は OrbitControls を無効化
  - AR時: `sessionInit.requiredFeatures = ['local-floor', 'hit-test']`, Quest 3パススルー用に `'dom-overlay'` をオプションで追加

#### XRUIManager

- **目的**: three-mesh-ui を使ってXRセッション中に浮遊する操作パネルを表示する
- **内部実装方針**:
  - セッション開始時にカメラ正面1.5m の位置にパネルをスポーン
  - アニメーションリスト・再生ボタン・リップシンク入力の主要3機能を提供
  - コントローラーの `selectstart` イベントでレイキャストを実行しボタン判定
  - デスクトップUIのSvelteストアと同一ストアを参照して状態を同期

---

## 4. データフロー

### 4.1 VRM読み込みフロー

```
[ユーザー: ファイルD&D]
        │
        ▼
  ModelLoader.svelte
  (FileList取得)
        │
        ▼
  VRMLoader.load(file)
  ├─ URL.createObjectURL()
  ├─ GLTFLoader + VRMLoaderPlugin
  └─ URL.revokeObjectURL()
        │
        ▼
  vrmStore.set(vrm)
        │
        ├──► AnimationManager.setVRM(vrm)  (Mixer再生成)
        ├──► SpringBoneController.setVRM(vrm)
        └──► LipSyncEngine.setVRM(vrm)
```

### 4.2 アニメーション再生フロー

```
[ユーザー: リスト選択]
        │
        ▼
  AnimationList.svelte
        │
        ▼
  animationStore.selectAnimation(name)
        │
        ▼
  AnimationManager.play(name)
  ├─ mixer.clipAction(clip)
  ├─ action.setLoop(LoopRepeat / LoopOnce)
  └─ action.play()
        │
        ▼
  RenderLoop.update(delta)
  └─ mixer.update(delta)
```

### 4.3 リップシンクフロー

```
[ユーザー: テキスト入力 → 再生ボタン]
        │
        ▼
  LipSyncPanel.svelte
        │
        ▼
  LipSyncEngine.play(text, speed)
        │
        ▼
  文字ループ (setInterval)
  ├─ isJapanese(char) → JapaneseLipSync.toViseme(char)
  └─ isAscii(char)    → EnglishLipSync.toViseme(char)
        │
        ▼
  lipSyncStore.update({ displayedText, currentViseme })
        │
        ▼
  RenderLoop内でVRM Expression補間
  └─ vrm.expressionManager.setValue(viseme, weight)
```

### 4.4 WebXR切り替えフロー

```
[ユーザー: VR/ARボタン押下]
        │
        ▼
  XRControls.svelte
        │
        ▼
  XRSessionManager.enterXR(mode)
  ├─ 既存セッションがあれば exitXR() を先に実行
  ├─ navigator.xr.requestSession(mode, sessionInit)
  ├─ renderer.xr.setSession(session)
  └─ OrbitController.setEnabled(false)
        │
        ▼
  xrStore.set({ activeMode: mode, isActive: true })
        │
        ▼
  XRUIManager.spawn()  ← XRパネルをカメラ正面に配置
```

---

## 5. 型定義

```typescript
// src/types/index.ts

import type { VRM } from '@pixiv/three-vrm';
import type * as THREE from 'three';

// Viseme
export type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'neutral';

// アニメーションエントリー
export type AnimationEntry = {
  readonly name: string;
  readonly clip: THREE.AnimationClip;
  readonly duration: number;
};

// アニメーション再生速度プリセット
export type SpeedPreset = 0.25 | 0.5 | 1.0 | 2.0;

// XRモード
export type XRMode = 'vr' | 'ar';

// XRサポート状態
export type XRSupportState = {
  readonly vr: boolean;
  readonly ar: boolean;
};

// アプリケーション全体エラー
export type AppError = {
  readonly type: 'load' | 'xr' | 'animation' | 'lipsync';
  readonly message: string;
  readonly detail?: string;
};

// Spring Bone パラメータ
export type SpringBoneParams = {
  stiffness: number;   // 0.0 〜 4.0
  damping: number;     // 0.0 〜 1.0
  enabled: boolean;
};

// vrmStore の状態
export type VRMState = {
  readonly vrm: VRM | null;
  readonly loading: boolean;
  readonly error: AppError | null;
};

// animationStore の状態
export type AnimationState = {
  readonly animations: AnimationEntry[];
  readonly currentName: string | null;
  readonly isPlaying: boolean;
  readonly isLooping: boolean;
  readonly speed: SpeedPreset;
  readonly progress: number;
};

// lipSyncStore の状態
export type LipSyncState = {
  readonly isPlaying: boolean;
  readonly displayedText: string;
  readonly currentViseme: VisemeKey;
  readonly charsPerSecond: number;
};

// xrStore の状態
export type XRState = {
  readonly support: XRSupportState;
  readonly activeMode: XRMode | null;
  readonly isActive: boolean;
};
```

---

## 6. Visemeマッピング設計

```typescript
// src/lipsync/visemeMaps.ts

export const JP_VISEME_MAP: Readonly<Record<string, VisemeKey>> = {
  // あ行
  'あ':'aa','ア':'aa',
  // い行
  'い':'ih','イ':'ih',
  // う行
  'う':'ou','ウ':'ou',
  // え行
  'え':'ee','エ':'ee',
  // お行
  'お':'oh','オ':'oh',
  // か行 → 母音で決定
  'か':'aa','き':'ih','く':'ou','け':'ee','こ':'oh',
  'カ':'aa','キ':'ih','ク':'ou','ケ':'ee','コ':'oh',
  // （さ〜わ行、濁音、半濁音、拗音を同様に列挙）
  // 拗音（きゃ等）は直前の小文字に従う
  // ん・ッ → neutral
  'ん':'neutral','ン':'neutral','っ':'neutral','ッ':'neutral',
};

// 英語: 母音文字 → Viseme
export const EN_VOWEL_MAP: Readonly<Record<string, VisemeKey>> = {
  'a':'aa','A':'aa',
  'e':'ee','E':'ee',
  'i':'ih','I':'ih',
  'o':'oh','O':'oh',
  'u':'ou','U':'ou',
};
// 子音はデフォルト neutral
```

**言語判定ロジック**:
```typescript
const isJapanese = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return (code >= 0x3040 && code <= 0x309F)   // ひらがな
      || (code >= 0x30A0 && code <= 0x30FF);  // カタカナ
};
```

---

## 7. Svelte ストア設計

```typescript
// src/stores/vrmStore.ts
import { writable } from 'svelte/store';
import type { VRMState } from '../types';

export const vrmStore = writable<VRMState>({
  vrm: null,
  loading: false,
  error: null,
});

// src/stores/animationStore.ts
export const animationStore = writable<AnimationState>({
  animations: [],
  currentName: null,
  isPlaying: false,
  isLooping: true,
  speed: 1.0,
  progress: 0,
});

// src/stores/xrStore.ts
export const xrStore = writable<XRState>({
  support: { vr: false, ar: false },
  activeMode: null,
  isActive: false,
});

// src/stores/lipSyncStore.ts
export const lipSyncStore = writable<LipSyncState>({
  isPlaying: false,
  displayedText: '',
  currentViseme: 'neutral',
  charsPerSecond: 8,
});
```

---

## 8. エラーハンドリング

### 8.1 エラー分類と対処

| エラータイプ | 原因例 | ユーザー通知 | 処理 |
|---|---|---|---|
| `load` | 非VRMファイル・破損 | トーストで「読み込み失敗」 | vrmStore.error にセット |
| `animation` | 非VRMAファイル・VRM未ロード時の読み込み | トーストで警告 | animationStore は変更しない |
| `xr` | WebXR非対応・セッション確立失敗 | ボタンをグレーアウト + ツールチップ | xrStore に反映 |
| `lipsync` | VRM Expression 未定義 | サイレント（該当文字をneutralに変換） | フォールバック |

### 8.2 エラー通知

- エラーは `AppError` 型で統一
- UI通知はトーストコンポーネント（3秒自動消去）
- `console.error` でスタックトレースをコンソールに出力
- XSS対策: テキスト挿入は Svelte の `{text}` バインディング経由のみ（`@html` 不使用）

---

## 9. セキュリティ設計

| 項目 | 対策 |
|---|---|
| XSS | Svelte テンプレートの `{text}` 経由のみで描画（`@html` 禁止） |
| ファイル読み込み | `File` オブジェクトのみ受付（`fetch` 等での外部URLアクセスなし） |
| Object URL | 使用後は必ず `URL.revokeObjectURL()` で解放 |
| MIME チェック | 拡張子確認（`.vrm` / `.vrma`）+ GLTFLoader 失敗時のエラー処理 |

---

## 10. パフォーマンス最適化

### 10.1 レンダリング

- `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` — Quest 3 の高解像度ディスプレイによる過負荷を防止
- `renderer.shadowMap.enabled = false` — エディタ段階では影なし
- MToon シェーダーの `isCutoff` モード（アルファ判定の簡略化）を推奨
- フレームループ内での GC 発生を防ぐため Vector3/Quaternion は再利用

### 10.2 Spring Bone

- Spring Bone 無効時は `update()` をスキップ
- ボーン数が多い VRM の場合はワーニングを出し、ユーザーに Spring Bone オフを促す

### 10.3 アニメーション

- VRMA の AnimationClip は `animations Map` に保持してファイル再読み込みを不要にする
- シーク操作時の `mixer.setTime()` は重いため、スライダーの `input` イベントではなく `change` イベントで実行

### 10.4 メモリ

- VRM 差し替え時に旧モデルの `.dispose()` を呼び GeometryBuffer を確実に解放
- テクスチャは `texture.dispose()` を明示的に呼び出す
- VRMA ファイルは削除ボタンで `animations Map` から削除可能にする（将来対応）

---

## 11. デプロイメント

### 11.1 ビルド設定（vite.config.ts）

```typescript
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: 'es2020',      // Quest 3 Meta Browser 対応
    outDir: 'dist',
    assetsInlineLimit: 0,  // バイナリ系アセットをインライン化しない
  },
});
```

### 11.2 Netowl デプロイ手順

1. `npm run build` で `dist/` を生成
2. FTP/SFTP で `dist/` 配下のファイルをサーバーにアップロード
3. Netowl コントロールパネルで SSL 証明書（Let's Encrypt）を有効化
4. **WebXR は HTTPS 必須** — `https://` でアクセスされることを確認
5. 将来 Rapier.js 導入時: `.htaccess` に `AddType application/wasm .wasm` を追加

---

## 12. 実装上の注意事項

1. **OrbitControls と WebXR の共存**: `renderer.xr.isPresenting` が `true` の間は OrbitControls の `enabled` を `false` にすること。XR セッション中に OrbitControls が有効だとカメラ行列が競合する。

2. **VRM の `update()` 呼び出し順**: `vrm.update(delta)` は `mixer.update(delta)` の **後** に呼ぶこと。Spring Bone はアニメーション後のボーン位置を基準に演算するため順序が重要。

3. **VRM Expression と LipSync の競合**: アニメーションクリップが Expression を書き換える場合と LipSync が書き換える場合が競合する。LipSync 中はアニメーション側の Expression トラックのウェイトを 0 にする処理が必要。

4. **Svelte 5 の runes モード**: Svelte 5 では `$state` / `$derived` / `$effect` runes を使用する。`writable` との混在は避け、ストア設計を統一する（プロジェクト開始前に Svelte 4/5 どちらを使うか確定すること）。

5. **three-mesh-ui のフォント**: XR パネルでテキストを表示するには `MSDF` フォントファイルが必要。`three-mesh-ui` 付属のサンプルフォントを初期使用し、日本語表示が必要な場合は日本語対応 MSDF フォントを別途生成すること。

6. **Quest 3 AR モードの背景**: AR（パススルー）時は `renderer.setClearAlpha(0)` を設定してシーン背景を透明にすること。デフォルトでは黒背景になり現実が見えなくなる。
