# テスト設計書 - VRM対応3Dキャラクターエディタ（Web/WebXR）

## 1. テスト概要

### 1.1 テスト目的

- 各コアモジュールが仕様通りに動作することを確認する
- データフロー（VRM読み込み→アニメーション→リップシンク）が正しく連携することを確認する
- WebXR セッション切り替えが Quest 3 / 通常ブラウザ両方で安全に動作することを確認する
- パフォーマンス要件（Quest 3 で 72fps）を満たすことを確認する

### 1.2 テスト範囲

**対象:**
- `VRMLoader` — ファイル読み込み・破棄
- `AnimationManager` — VRMA 読み込み・再生制御
- `SpringBoneController` — パラメータ操作
- `LipSyncEngine` / `JapaneseLipSync` / `EnglishLipSync` — テキスト→Viseme変換
- `XRSessionManager` — VR/AR セッションライフサイクル
- `SceneManager` — 初期化・リサイズ
- Svelte ストア — 状態管理の整合性
- 統合シナリオ — VRM読み込み→アニメーション→リップシンクの一連操作

**対象外:**
- three-mesh-ui XR パネルのビジュアル確認（手動確認）
- Quest 3 実機での最終動作確認（手動確認）
- Blender アドオンによる VRMA 変換（別工程）
- 布シミュレーション（低優先度・後フェーズ）

### 1.3 テスト環境

| 環境 | 内容 |
|---|---|
| 単体・統合テスト | Vitest（Vite ネイティブ、JSDOM） |
| ブラウザテスト | Playwright（Chrome / Firefox） |
| 実機確認 | Quest 3 Meta Browser（手動） |
| VRM テストデータ | Pixiv公式サンプルVRM（Alicia Solid）+ 最小構成自作VRM |
| VRMA テストデータ | @pixiv/three-vrm-animation 付属サンプル |
| モック | Three.js WebGLRenderer（JSDOM では WebGL 非対応のためモック） |

---

## 2. テストケース設計

### 2.1 VRMLoader のテストケース

#### 2.1.1 正常系テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T001 | VRM 1.0 ファイルの正常読み込み | 有効な `.vrm`（VRM 1.0）ファイル | VRM オブジェクトが返り、vrmStore.vrm が非 null になる | High |
| T002 | VRM 0.x ファイルの正常読み込み | 有効な `.vrm`（VRM 0.x）ファイル | VRM オブジェクトが返り、vrmStore.vrm が非 null になる | High |
| T003 | 読み込み中フラグ確認 | 有効な `.vrm` ファイル | 読み込み開始時に `vrmStore.loading === true`、完了後に `false` になる | High |
| T004 | モデル差し替え（旧モデル破棄） | 1体目 VRM 読み込み後、2体目を読み込む | 旧モデルの `dispose()` が呼ばれ、新モデルがシーンに追加される | High |
| T005 | Object URL の解放 | 有効な `.vrm` ファイル | 読み込み完了後に `URL.revokeObjectURL()` が呼ばれる | Medium |

#### 2.1.2 異常系テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T101 | 非VRMファイルの読み込み | `.png` ファイル | `vrmStore.error.type === 'load'` がセットされ、シーンは変化しない | High |
| T102 | 破損VRMファイルの読み込み | バイナリ破損した `.vrm` | `vrmStore.error.type === 'load'` がセットされる | High |
| T103 | ゼロバイトファイルの読み込み | 空ファイル | エラーになり既存モデルが保持される | Medium |
| T104 | 読み込み中に再度読み込み | 読み込み中に別ファイルをD&D | 2つ目の読み込みが無視されるか、1つ目がキャンセルされて2つ目が開始される（どちらでも可、挙動が一定であること） | Medium |

#### 2.1.3 境界値テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T201 | 大容量VRMの読み込み | 50MB の VRM | 読み込み完了（5秒以内）またはタイムアウトエラー | Medium |
| T202 | Spring Bone なしVRM | Spring Bone を持たない VRM | SpringBoneController が存在しない場合でもエラーにならない | Medium |
| T203 | Expression なしVRM | BlendShape/Expression を持たない VRM | リップシンク再生がサイレントにスキップされる | Medium |

---

### 2.2 AnimationManager のテストケース

#### 2.2.1 正常系テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T301 | VRMA ファイルの読み込み | 有効な `.vrma` ファイル | `animationStore.animations` に1件追加される | High |
| T302 | 複数 VRMA の読み込み | 3つの `.vrma` ファイル | リストに3件表示される | High |
| T303 | アニメーション再生 | リストから1件選択 | `isPlaying === true`、AnimationAction が play 状態になる | High |
| T304 | アニメーション停止 | 再生中に停止ボタン | `isPlaying === false`、ポーズが停止時の状態で固定される | High |
| T305 | ループ切り替え | ループOFF | 1回再生後に停止、`isPlaying === false` になる | High |
| T306 | 再生速度変更（0.25x） | speed: 0.25 | AnimationAction の timeScale が 0.25 になる | Medium |
| T307 | 再生速度変更（2.0x） | speed: 2.0 | AnimationAction の timeScale が 2.0 になる | Medium |
| T308 | シーク操作 | progress: 0.5 | アニメーションが中間フレームに移動する | Medium |
| T309 | Tポーズリセット | 任意アニメーション再生後 | 全ボーンがデフォルト回転/位置に戻る | High |
| T310 | 重複ファイル名のリネーム | 同名ファイル2回読み込み | `name_1` 形式でリネームされ両方がリストに存在する | Low |

#### 2.2.2 異常系テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T401 | VRM 未ロード時の VRMA 読み込み | VRM なし状態で `.vrma` ファイル | `animationStore.error` がセットされるか、ロード後の適用待ち状態になる | High |
| T402 | 非 VRMA ファイルの読み込み | `.fbx` ファイル | エラー通知、リストは変化しない | High |
| T403 | VRM 差し替え後の再生継続 | VRM 差し替え後、既存アニメを再生 | 新しい VRM に対して AnimationMixer が再生成され再生が継続する | High |

#### 2.2.3 境界値テスト

| ID | テストケース名 | 入力データ | 期待結果 | 優先度 |
|---|---|---|---|---|
| T501 | 0秒アニメーション | duration: 0 のクリップ | エラーにならずに停止状態になる | Low |
| T502 | シーク 0.0（先頭） | progress: 0.0 | 先頭フレームに移動 | Medium |
| T503 | シーク 1.0（末尾） | progress: 1.0 | 末尾フレームに移動 | Medium |

---

### 2.3 LipSyncEngine のテストケース

#### 2.3.1 正常系テスト（JapaneseLipSync）

| ID | テストケース名 | 入力 | 期待 Viseme シーケンス | 優先度 |
|---|---|---|---|---|
| T601 | あ行の変換 | `"あいうえお"` | `[aa, ih, ou, ee, oh]` | High |
| T602 | か行の変換 | `"かきくけこ"` | `[aa, ih, ou, ee, oh]` | High |
| T603 | 長文の変換 | `"こんにちは"` | `[oh, neutral, ih, ih, aa]` | High |
| T604 | 促音・撥音 | `"まっか"` / `"まんが"` | `[aa, neutral, aa]` / `[aa, neutral, aa]` | Medium |
| T605 | カタカナの変換 | `"アイウエオ"` | `[aa, ih, ou, ee, oh]` | High |
| T606 | タイプライター同期 | `"こんにちは"` / 速度: 5文字/秒 | 0.2秒ごとに1文字表示 + Viseme 切り替わり | High |
| T607 | 再生完了後の口閉じ | テキスト末尾まで再生 | `currentViseme === 'neutral'` になる | High |

#### 2.3.2 正常系テスト（EnglishLipSync）

| ID | テストケース名 | 入力 | 期待 Viseme シーケンス | 優先度 |
|---|---|---|---|---|
| T701 | 母音の変換 | `"aeiou"` | `[aa, ee, ih, oh, ou]` | High |
| T702 | 子音のみの単語 | `"rhythm"` | 子音は `neutral`、`y` は `ih` | Medium |
| T703 | 大文字の変換 | `"HELLO"` | `[neutral, ee, neutral, neutral, oh]` | Medium |
| T704 | 混在テキスト（日英） | `"こんにちはHello"` | 日本語部分→JP変換、英語部分→EN変換 | High |

#### 2.3.3 異常系テスト

| ID | テストケース名 | 入力 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T801 | 記号・数字 | `"！？123"` | すべて `neutral` にフォールバック | Medium |
| T802 | 空文字列 | `""` | 再生されず `isPlaying === false` のまま | Medium |
| T803 | VRM Expression 未定義 | Expression のない VRM で再生 | エラーにならずサイレントスキップ | High |
| T804 | 再生中に stop() 呼び出し | 再生中に停止 | 即座に停止し `currentViseme === 'neutral'` になる | High |

#### 2.3.4 境界値テスト

| ID | テストケース名 | 入力 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T901 | 速度: 最小（1文字/秒） | charsPerSecond: 1 | 1秒ごとに1文字進む | Medium |
| T902 | 速度: 最大（20文字/秒） | charsPerSecond: 20 | 50msごとに1文字進む、Viseme補間が追いつくこと | Medium |
| T903 | 1文字テキスト | `"あ"` | `aa` が1回適用されて終了 | Low |

---

### 2.4 XRSessionManager のテストケース

#### 2.4.1 正常系テスト

| ID | テストケース名 | 前提条件 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T1001 | VR サポート確認（対応ブラウザ） | WebXR 対応環境 | `isSupported('vr') === true` | High |
| T1002 | AR サポート確認（対応ブラウザ） | WebXR 対応環境 | `isSupported('ar') === true` | High |
| T1003 | VR セッション開始 | WebXR 対応、VRM 読み込み済み | `xrStore.activeMode === 'vr'`、OrbitControls が無効化される | High |
| T1004 | AR セッション開始 | WebXR 対応、VRM 読み込み済み | `xrStore.activeMode === 'ar'`、背景が透明になる | High |
| T1005 | XR セッション終了 | VR セッション中 | `xrStore.isActive === false`、OrbitControls が再有効化される | High |
| T1006 | VR→AR 切り替え | VR セッション中 | VR セッション終了→AR セッション開始の順で実行される | High |

#### 2.4.2 異常系テスト

| ID | テストケース名 | 前提条件 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T1101 | VR 非対応ブラウザ | WebXR 非対応環境 | `isSupported('vr') === false`、VRボタンがグレーアウト | High |
| T1102 | AR 非対応ブラウザ | VR対応・AR非対応環境 | `isSupported('ar') === false`、ARボタンのみグレーアウト | High |
| T1103 | セッション確立失敗 | WebXR 対応だが権限拒否 | `xrStore.error` がセット、セッション状態がリセットされる | Medium |

---

### 2.5 SceneManager のテストケース

#### 2.5.1 正常系テスト

| ID | テストケース名 | 操作 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T1201 | 初期化 | `init(canvas)` 呼び出し | scene / camera / renderer が生成される | High |
| T1202 | リサイズ | ウィンドウリサイズ | camera.aspect と renderer.size が更新される | Medium |
| T1203 | グリッド表示切替 | GridHelper ON/OFF | グリッドがシーンに追加/削除される | Low |

---

### 2.6 Svelte ストアのテストケース

| ID | テストケース名 | 操作 | 期待結果 | 優先度 |
|---|---|---|---|---|
| T1301 | vrmStore 初期状態 | ストア読み込み | `{ vrm: null, loading: false, error: null }` | Medium |
| T1302 | animationStore 更新伝播 | `animationStore.set(...)` 後に subscribe | 購読コールバックが新しい値で呼ばれる | Medium |
| T1303 | エラー後のリセット | エラー発生後に再読み込み | `error` が `null` にリセットされる | High |

---

## 3. 統合テストシナリオ

### シナリオ 1: VRM 読み込み → アニメーション再生

1. **前提条件**: アプリ初期状態（VRM 未ロード）
2. **手順**:
   - Step 1: VRM ファイルをD&Dで読み込む
   - Step 2: VRMA ファイルをD&Dで読み込む
   - Step 3: アニメーションリストから1件を選択して再生
   - Step 4: 再生中に速度を 0.5x に変更
   - Step 5: タイムラインをシークして 50% 位置に移動
   - Step 6: 停止ボタンを押す
3. **期待結果**:
   - VRM が正常表示され Spring Bone が動作している
   - アニメーションが正しい速度で再生される
   - シーク後の姿勢が正しいフレームを表示している
   - 停止後にポーズが固定されている

### シナリオ 2: リップシンクの一連動作

1. **前提条件**: VRM 読み込み済み
2. **手順**:
   - Step 1: リップシンクパネルに `"こんにちはHello"` を入力
   - Step 2: 速度スライダーを 8文字/秒 に設定
   - Step 3: 再生ボタンを押す
   - Step 4: 再生完了を待つ
3. **期待結果**:
   - タイプライター表示が 8文字/秒 で進行する
   - `こ→お→ん→neutral→に→い→ち→い→は→aa` の順で Viseme が変化する
   - `Hello` 部分で英語変換に切り替わる
   - 完了後に口が閉じる（neutral）

### シナリオ 3: VRM 差し替えの安全性確認

1. **前提条件**: VRM + VRMA 読み込み済み、アニメーション再生中
2. **手順**:
   - Step 1: 再生中に別の VRM ファイルをD&Dで読み込む
3. **期待結果**:
   - 旧 VRM が正しく `dispose()` される（メモリリークなし）
   - 新 VRM が表示される
   - アニメーションリストは保持されたまま新 VRM に再適用される
   - シーン上に旧 VRM のオブジェクトが残らない

### シナリオ 4: WebXR セッション切り替え

1. **前提条件**: Quest 3 実機 / WebXR 対応環境、VRM 読み込み済み
2. **手順**:
   - Step 1: VR ボタンを押して VR モードに入る
   - Step 2: XR パネルでアニメーションを再生する
   - Step 3: XR セッション終了ボタンを押す
   - Step 4: AR ボタンを押して AR モードに入る
   - Step 5: AR モードでパススルー越しにモデルが見えることを確認
   - Step 6: XR セッション終了
3. **期待結果**:
   - VR モードでモデルが空間に表示される
   - XR パネルの操作でアニメーションが制御できる
   - AR モードで背景が透明になり現実空間が見える
   - 各セッション終了後に OrbitControls が復帰する

### シナリオ 5: エラーリカバリー

1. **前提条件**: アプリ初期状態
2. **手順**:
   - Step 1: `.png` ファイルをD&Dして読み込みエラーを発生させる
   - Step 2: エラートーストが表示されることを確認
   - Step 3: 正しい `.vrm` ファイルをD&Dして再読み込み
3. **期待結果**:
   - エラートーストが 3秒後に消える
   - 再読み込みでエラーがクリアされ VRM が正常表示される

---

## 4. テストデータ設計

### 4.1 テスト用ファイル

| ファイル | 内容 | 用途 |
|---|---|---|
| `tests/fixtures/valid_vrm1.vrm` | Pixiv公式サンプル（VRM 1.0） | 正常系 |
| `tests/fixtures/valid_vrm0.vrm` | VRM 0.x サンプル | 正常系 |
| `tests/fixtures/minimal.vrm` | Spring Bone / Expression なし最小VRM | 境界値 |
| `tests/fixtures/sample.vrma` | @pixiv/three-vrm-animation サンプル | アニメーション正常系 |
| `tests/fixtures/broken.vrm` | バイナリ破損ファイル | 異常系 |
| `tests/fixtures/empty.vrm` | 0バイトファイル | 境界値 |
| `tests/fixtures/not_vrm.png` | PNG画像 | 異常系 |

### 4.2 LipSync テストデータ

```typescript
export const LIPSYNC_TEST_CASES = {
  japanese: [
    { input: 'あいうえお', expected: ['aa','ih','ou','ee','oh'] },
    { input: 'こんにちは', expected: ['oh','neutral','ih','ih','aa'] },
    { input: 'アイウエオ', expected: ['aa','ih','ou','ee','oh'] },
    { input: 'まっか',    expected: ['aa','neutral','aa'] },
  ],
  english: [
    { input: 'aeiou',  expected: ['aa','ee','ih','oh','ou'] },
    { input: 'hello',  expected: ['neutral','ee','neutral','neutral','oh'] },
    { input: 'HELLO',  expected: ['neutral','ee','neutral','neutral','oh'] },
  ],
  mixed: [
    { input: 'こんにちはHello', expected: ['oh','neutral','ih','ih','aa','neutral','ee','neutral','neutral','oh'] },
  ],
  edge: [
    { input: '',      expected: [] },
    { input: '！？1', expected: ['neutral','neutral','neutral'] },
  ],
} as const;
```

### 4.3 モックデータ

```typescript
// Three.js WebGLRenderer モック（JSDOM用）
export const mockRenderer = {
  xr: {
    enabled: false,
    isPresenting: false,
    setSession: vi.fn(),
    getSession: vi.fn(() => null),
  },
  setPixelRatio: vi.fn(),
  setSize: vi.fn(),
  setClearAlpha: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
};

// WebXR navigator.xr モック
export const mockXR = {
  isSessionSupported: vi.fn(async (mode: string) => mode === 'immersive-vr'),
  requestSession: vi.fn(),
};
```

---

## 5. パフォーマンステスト

### 5.1 フレームレートテスト（Quest 3 実機）

| シナリオ | 計測方法 | 合格基準 |
|---|---|---|
| VRM 表示のみ（Spring Bone あり） | `renderer.info.render.calls` + raf delta 計測 | 72fps 以上（13ms/frame以内） |
| VRM + アニメーション再生 | 同上 | 72fps 以上 |
| VRM + アニメーション + リップシンク | 同上 | 72fps 以上 |
| VRM + WebXR VRモード | 同上 | 72fps 以上 |

### 5.2 読み込み時間テスト

| 対象 | 計測方法 | 合格基準 |
|---|---|---|
| VRM 読み込み（~10MB） | `performance.now()` 差分 | 5秒以内 |
| VRMA 読み込み（~1MB） | `performance.now()` 差分 | 1秒以内 |

### 5.3 メモリリークテスト

| シナリオ | 確認方法 | 合格基準 |
|---|---|---|
| VRM を 5回 差し替え | Chrome DevTools Heap Snapshot | ヒープサイズが線形増加しない |
| VRMA を 10個 読み込み後に全削除 | 同上 | 削除後にメモリが解放される |

---

## 6. セキュリティテスト

### 6.1 入力検証テスト

| ID | テストケース | 入力 | 期待結果 |
|---|---|---|---|
| S001 | XSS: テキスト入力 | `<script>alert(1)</script>` | エスケープされて文字として表示される、スクリプト実行なし |
| S002 | XSS: ファイル名表示 | `"><img onerror=alert(1)>.vrm` | エスケープされて表示される |
| S003 | Object URL 解放確認 | VRM 読み込み後 | `URL.revokeObjectURL()` が呼ばれている（spy 確認） |

### 6.2 ファイルアクセステスト

| ID | テストケース | 期待結果 |
|---|---|---|
| S101 | ローカルファイル以外からの読み込み | `fetch()` 等による外部URLアクセスが発生しない |
| S102 | MIME タイプ検証 | `.vrm` 拡張子以外は読み込み前にリジェクトされる |

---

## 7. テスト実行計画

### 7.1 実行順序

```
1. 単体テスト（Vitest）
   ├─ LipSyncEngine / JapaneseLipSync / EnglishLipSync  ← 最優先（純粋関数、モック不要）
   ├─ Svelte ストア
   ├─ VRMLoader（Three.js モック使用）
   ├─ AnimationManager（Three.js モック使用）
   └─ XRSessionManager（navigator.xr モック使用）

2. 統合テスト（Vitest + Playwright）
   ├─ シナリオ 1: VRM → アニメーション
   ├─ シナリオ 2: リップシンク
   ├─ シナリオ 3: VRM 差し替え安全性
   └─ シナリオ 5: エラーリカバリー

3. パフォーマンステスト（手動 / Chrome DevTools）
   ├─ フレームレート計測
   └─ メモリリークチェック

4. 実機テスト（Quest 3 手動）
   └─ シナリオ 4: WebXR セッション切り替え
```

### 7.2 合格基準

| 区分 | 基準 |
|---|---|
| 単体テスト | カバレッジ 80% 以上、全ケース PASS |
| 統合テスト | シナリオ 1〜3, 5 が PASS |
| パフォーマンス | Quest 3 で 72fps 以上（主要シナリオ） |
| セキュリティ | XSS テスト全件 PASS |
| 実機 | シナリオ 4 が PASS（手動確認） |

---

## 8. リスクと対策

| リスク | 影響度 | 発生確率 | 対策 |
|---|---|---|---|
| JSDOM で Three.js が動作しない | High | High | WebGLRenderer を完全モック化。レンダリング結果の正確な検証は Playwright で行う |
| Quest 3 実機テストの実施タイミング | High | Medium | 早期に WebXR セッション管理のみ実機確認し、問題を前倒しで検出する |
| VRM サンプルファイルのライセンス | Medium | Low | テスト用に Pixiv 公式サンプル（利用許諾済み）を使用。リポジトリには含めず gitignore |
| LipSync の Viseme 補間タイミング | Medium | Medium | setInterval の精度はブラウザ依存。テストでは厳密な ms ではなく「n文字目が表示された後」で検証 |
| VRM Expression 名称の差異（VRM0 vs VRM1） | Medium | High | `@pixiv/three-vrm` の抽象 API（`expressionManager`）を使うことでバージョン差を吸収。テストはどちらのバージョンでも実施 |

---

## 9. テスト自動化戦略

### 9.1 自動化対象

| 対象 | ツール | 自動化率 |
|---|---|---|
| LipSync 変換ロジック | Vitest | 100%（純粋関数） |
| Svelte ストア操作 | Vitest | 100% |
| VRMLoader / AnimationManager | Vitest（モック） | 80% |
| XRSessionManager | Vitest（navigator.xr モック） | 70% |
| 統合シナリオ 1〜3, 5 | Playwright | 60% |
| WebXR 実機確認 | 手動 | 0%（自動化不可） |
| パフォーマンス計測 | 手動 / DevTools | 0%（自動化困難） |

### 9.2 CI/CD 統合

```yaml
# GitHub Actions 想定（.github/workflows/test.yml）
on: [push, pull_request]
jobs:
  test:
    steps:
      - run: npm install
      - run: npm run test          # Vitest 単体テスト
      - run: npm run test:e2e      # Playwright 統合テスト（Chrome headless）
      - run: npm run build         # ビルド成功確認
```

### 9.3 テストコマンド設計

```json
// package.json scripts
{
  "test":         "vitest run",
  "test:watch":   "vitest",
  "test:coverage":"vitest run --coverage",
  "test:e2e":     "playwright test"
}
```
