# Web3D GameMaker — システム仕様・機能概要

> ブラウザ上で動く 3D（VRM）ゲーム制作スイート。VRMキャラクター・布・ラグドール・セリフ・ストーリー・
> 戦闘・ゲームフローを、複数のエディタとプレイヤーで制作・再生できる。
> パッケージ名: `web3d-gamemaker` (v0.1.0)

---

## 1. 全体像

「キャラ」「布（マント）」「ステージ」「セリフ」「ストーリー」「戦闘」「ゲームフロー」をそれぞれ
専用エディタで作り、JSON として保存し、プレイヤー／ゲームで読み込んで再生する **データ駆動** の構成。

```
  ┌─────────── エディタ群（作る） ───────────┐      ┌──── プレイヤー/ゲーム（遊ぶ） ────┐
  Character / Cloth / Model / Stage /            npc.json / speech.json / cloth.json /
  Story / Flow / (本体)VRM-MMD-FBX     ──JSON──▶  story.json / flow.json / stage.json
  └──────────────────────────────────────┘      Swing Catch / Story Player / Flow Player …
                                                 └──────────────────────────────────┘
```

### 技術スタック
- **Three.js v0.184（WebGPU）** + TSL … 3D描画・GPU布シミュ（esm.sh CDN, ビルド不要で各ページ動作）
- **@pixiv/three-vrm 3.4 / three-vrm-animation** … VRM・VRMA（VRMアニメーション）
- **Svelte + Vite + TypeScript** … 本体エディタ（VRM/MMD/FBX）と開発サーバ
- 各ゲーム/エディタは **素のJS（モジュール）** で実装（`lib/` の共通モジュールを共有）
- 動作要件: **WebGPU 対応ブラウザ**（多くの 3D ページ）

---

## 2. アプリ構成（ページ一覧）

### ゲーム（再生・プレイ）
| 名称 | パス | 概要 |
|------|------|------|
| **Swing Catch** | `/swing-catch/` | FPS視点で空中オブジェクト/VRM NPC を掴む・振り回す・投げる・撃つサンドボックス。NPCはステート/表情/ラグドール/セリフ。`?flow=1` で**戦闘モード**（HP・勝敗・敵の攻撃） |
| **FPS VRM NPC + Cloth** | `/fps-cloth-vrm/` | FPS視点でマント付きVRM NPC＋布シミュ。射撃→ラグドール |
| **FPS + Cloth** | `/fps-cloth/` | FPS移動＋GPU布シミュ |
| **Cloth Sim** | `/cloth/` | WebGPU 布物理シミュ（形状パラメータ・cloth.json 書き出し） |
| **Story Player** | `/story-player/` | 3Dキャラ(npc.json)がしゃべり・動く線形ストーリーを再生 |
| **Flow Player** | `/flow-player/` | ストーリー→戦闘→勝敗で分岐するゲームフローを連続再生（iframe オーケストレータ） |

### エディタ（制作・書き出し）
| 名称 | パス | 概要 | 出力 |
|------|------|------|------|
| **Character Editor** | `/character-editor/` | VRM NPC のステート別 表情・視線・行動(behavior)を設定。セリフは speech.json へ | `.npc.json` / `.speech.json` |
| **Cloth Editor** | `/cloth-editor/` | VRMにマント等の布を着せ、ピン/コライダー/手グリップを設定 | `.cloth.json` |
| **Cloth Preview** | `/cloth-preview/` | VRM＋マント＋VRMA再生でグリップ/ブレンドシェイプをタイムライン編集 | `.timeline.json` |
| **Model Editor** | `/model-editor/` | `public/models/` の GLB をサムネ一覧から選び、ゲーム登場物を選別 | `selection.json` |
| **Stage Editor** | `/stage-editor/` | 俯瞰ビューでモデルを配置。**複数ステージ**を名前付き保存 | `stages/<id>.stage.json` |
| **Story Editor** | `/story-editor/` | ストーリーのコマンド列を編集（アクター/セリフ/移動/モーション/カメラ）＋3Dプレビュー | `.story.json` |
| **Flow Editor** | `/flow-editor/` | ストーリー/戦闘ノードを接続し勝敗で分岐するゲームフローを編集 | `.flow.json` |
| **VRM / MMD / FBX Editor（本体）** | `/` | モデル読込・アニメ再生・リターゲット・FBX→VRMA 変換などの中核エディタ（Svelte） | VRMA 等 |
| **Hub** | `/hub/` | 全ページへのランチャー |

---

## 3. 共通ライブラリ（`lib/`）

フレームワーク非依存の素JSモジュール。各ゲーム/エディタが共有する。

| モジュール | 役割 |
|------------|------|
| `vrm-cloth.js` | VRM用 GPUクロス（マント）シミュ。ボーン追従・コライダー・手グリップ |
| `vrm-ragdoll.js` | VRM用 自前PBDラグドール（物理エンジン不使用）。崩れ落ち・被弾撃力・復帰 |
| `npc-state-machine.js` | NPCステートマシン（idle/alert/attack/taunt/downed/recovering）。副作用なしの純粋コア |
| `lip-sync.js` | テキスト駆動の口パク（viseme aa/ih/ou/ee/oh）。日本語かな/カナ・英字対応 |
| `npc-speech.js` | セリフ制御。ステート発話(once/loop)巡回・イベントbark割込・行ごと表情 |
| `speech-ui.js` | セリフ表示UI（下部ウィンドウ＋頭上吹き出し、投影追従） |
| `speech-set.js` | speech.json → npc-speech 用の合成characterDef生成・規約名解決 |
| `story-ops.js` | ストーリー op のスキーマ（種別/blocking/フィールド/既定値） |
| `story-runner.js` | ストーリーの線形スクリプト実行（pc管理・blocking待ち） |
| `story-actors.js` | ストーリーのVRMアクター管理（登場/移動/モーション/向き/表情/崩れ/発話） |
| `story-stage.js` | ストーリー再生エンジン（シーン/カメラ/アクター/UI/フェード/音声/ステージ統合）。player/editor共用 |
| `flow-runner.js` | ゲームフローのノードグラフ走査・分岐解決 |

---

## 4. データフォーマット

すべて `public/<種別>/` 配下に保存。開発サーバの保存API（`POST /api/save`）と一覧API（`/<種別>/manifest.json`）で読み書き。

### 4.1 `*.npc.json`（キャラバンドル｜`public/npc/`）
VRM本体＋付随データを1ファイルに同梱。**大容量**（VRMをbase64同梱）。
```jsonc
{
  "format": "fps-npc-bundle", "version": 2, "name": "lily",
  "vrm":  "data:application/octet-stream;base64,…",   // VRM本体
  "vrma": "data:application/octet-stream;base64,…",   // 既定アイドルVRMA
  "cloth": { … },        // マント設定（任意）
  "timeline": { … },     // 手グリップ/ブレンドシェイプのタイムライン（任意）
  "character": {         // ゲーム挙動（表情/視線/行動）。※セリフは speech.json へ分離
    "schemaVersion": 1, "displayName": "lily", "defaultState": "idle",
    "behavior": { "sightRange": 0, "detectChance": 0.6, "tauntChance": 0.12, … },
    "states": {
      "idle":   { "expression": {},                 "lookAtEye": 1.0, "lookAtHead": 0.35 },
      "attack": { "expression": { "angry": 1.0 },   "lookAtEye": 1.0, "lookAtHead": 0.8 },
      …  // alert / taunt / downed / recovering
    }
  }
}
```

### 4.2 `*.speech.json`（反応セリフ｜`public/speech/`）★軽量
キャラの反応セリフ（state別bark＋イベントbark）。npc.json から分離。**アクター単位で差し替え可能**（同じキャラでもステージで別セリフ）。
```jsonc
{
  "version": 1, "id": "lily", "displayName": "lily",
  "states": {                              // ステート滞在中の発話
    "idle":   { "mode": "loop", "intervalMs": 2500, "lines": [ "…ひま。", "だれかこないかな" ] },
    "attack": { "mode": "loop", "lines": [ "そこっ！" ] }
  },
  "events": {                              // 瞬間リアクション
    "grabbed":   { "lines": [ "きゃっ!", { "text": "離して！", "expression": "angry", "weight": 0.7 } ] },
    "thrown":    { "lines": [ "とぶーー！" ] },
    "landed":    { "lines": [ "いたた…" ] },
    "menace":    { "lines": [ "いくよっ！" ] },        // 攻撃の予備動作
    "attackHit": { "lines": [ "当たった♪" ] }          // プレイヤーに命中
  }
}
```
- 行は文字列 or `{ text, expression?, weight?, holdMs? }`。
- 解決順: アクター指定の override → 規約 `<npc名>.speech.json` → 無し（無発話）。

### 4.3 `*.story.json`（ストーリー｜`public/story/`）
op の線形スクリプト。脚本セリフ（`say`）はここに書く（ストーリーごとに別）。
```jsonc
{
  "version": 1, "id": "intro", "title": "プロローグ",
  "stage": "stage.json",
  "actors": [ { "id": "lily", "npc": "lily.npc.json" }, … ],
  "script": [
    { "op": "fade.in", "duration": 500 },
    { "op": "actor.show", "id": "lily", "x": 0, "z": 0, "ry": 0 },
    { "op": "say", "actor": "lily", "lines": ["こんにちは。", "今日はいい天気ね。"] },
    { "op": "actor.anim", "id": "lily", "vrma": "004_hello_1.vrma" },
    { "op": "actor.move", "id": "lily", "x": 2, "z": 1, "duration": 1500, "wait": true },
    { "op": "camera", "pos": [0,1.4,3], "target": [0,1.2,0], "duration": 1000 },
    { "op": "end" }
  ]
}
```
**op 一覧**: `say` / `wait` / `actor.show` / `actor.hide` / `actor.move` / `actor.face` / `actor.anim` /
`actor.expression` / `actor.ragdoll` / `camera` / `stage` / `bg` / `bgm.play` / `bgm.stop` / `se` /
`delay` / `fade.in` / `fade.out` / `end`。
- 同期: `say`/`wait`/`delay`/`fade.*` はブロッキング（クリック/Space送りや待機）、`actor.*`/`camera` はノンブロッキング（`wait:true`で完了待ち＝「歩きながら喋る」可）。

### 4.4 `*.flow.json`（ゲームフロー｜`public/flow/`）
ノード（start/story/battle/end）をエッジで接続。**戦闘ノードは win/lose の2出力で分岐**。
```jsonc
{
  "version": 1, "id": "chapter1", "title": "第1章", "start": "n_intro",
  "nodes": [
    { "id": "n_intro",  "type": "story",  "x": 60,  "y": 120, "data": { "story": "intro.story.json" } },
    { "id": "n_battle", "type": "battle", "x": 340, "y": 120, "data": { "battle": {
        "enemies": [ "lily.npc.json", { "npc": "megu.npc.json", "speech": "megu_dark.speech.json" } ],
        "stage": "town.stage.json", "bgm": "",
        "win":  { "type": "defeatCount", "count": 5 },
        "lose": { "type": "playerHp", "hp": 10 } } } },
    { "id": "n_win",  "type": "story", "data": { "story": "win.story.json" } },
    { "id": "n_lose", "type": "story", "data": { "story": "lose.story.json" } },
    { "id": "n_end",  "type": "end" }
  ],
  "edges": [
    { "from": "n_intro",  "fromPort": "next", "to": "n_battle" },
    { "from": "n_battle", "fromPort": "win",  "to": "n_win" },
    { "from": "n_battle", "fromPort": "lose", "to": "n_lose" },
    { "from": "n_win",  "fromPort": "next", "to": "n_end" },
    { "from": "n_lose", "fromPort": "next", "to": "n_end" }
  ]
}
```
- battle の `enemies` は文字列（規約セリフ）か `{ npc, speech }`（セリフ差し替え）。

### 4.5 `*.stage.json`（ステージ｜`public/stages/`）
配置済みモデルのリスト（複数ステージを名前付きで保存）。
```jsonc
{ "version": 1, "room": 30, "items": [ { "model": "city_GLB format/building-a.glb", "x": 4, "y": 0, "z": -2, "ry": 0, "scale": 1 }, … ] }
```
（旧サンドボックス既定は `public/models/stage.json`）

### 4.6 その他
- **`selection.json`**（`public/models/`）: ゲーム登場モデルの選別とスケール `{ models:[…], scales:{…} }`。
- **`*.cloth.json`**（布）: `shapeParams` ＋ `positions/springs/indices` ＋ material ＋ グリップ/コライダー。手続き形状（rect/台形/半円・**裾ギザギザ**）はジオメトリに焼き込み。
- **`*.timeline.json`**: 手グリップイベント・ブレンドシェイプのキーフレーム。

---

## 5. 主要機能の詳細

### 5.1 セリフ・口パく・表情
- **口パク**: テキストを viseme(aa/ih/ou/ee/oh) に変換し時間送りで口を動かす（音声非依存）。
- **2系統のセリフ**:
  - *脚本セリフ*（ストーリーの `say`）→ story.json（場面ごとに別）。
  - *反応セリフ*（bark：掴まれた/投げられた/衝突/威嚇/攻撃ヒット、ステート別つぶやき）→ speech.json（キャラ＋文脈で差し替え）。
- **表示**: 画面下部のセリフウィンドウ（タイピング送り）＋頭上吹き出し（ワールド→画面投影で追従）。
- 行ごとに表情（happy/angry/sad/relaxed/surprised）と強度を指定可。

### 5.2 ステートマシン・表情・視線・ラグドール（Swing Catch / FPS系）
- NPCは idle/alert/attack/taunt/downed/recovering を behavior（検知距離・確率等）で遷移。
- 各ステートに 表情ブレンド・視線（目/頭の追従）を設定。被弾/掴みで PBDラグドール化→復帰。
- マント（GPUクロス）はボーン追従＋手グリップで一緒に飛ぶ。

### 5.3 戦闘モード（Swing Catch `?flow=1`）
- **プレイヤーHP**（HPバー＋赤ヴィネット＋カメラシェイク）、無敵時間あり。
- **勝敗**: 撃破累計(`defeatCount`)で勝利 / HP0 で敗北 → 親へ `win`/`lose` を通知。
- **敵の攻撃**（フェーズ2a）:
  - 近接: 接近→威嚇(menace bark/怒り表情)→踏み込み大ダメージ→離脱。
  - 遠距離: プレイヤーへ弾を発射 / 周囲の浮遊オブジェクトを掴んで投擲。
  - 浮遊オブジェクトは接触でダメージ＆跳ね返り。
  - 被弾時、当てたNPCが `attackHit` セリフ。
- **非フロー時（通常起動）は従来のサンドボックスのまま**（HP/攻撃は作動しない）。

### 5.4 ストーリー再生
- `story-stage` が 3Dシーン＋カメラ補間＋フェード＋音声＋アクター＋セリフUI を統合。
- アクター＝npc.json（VRM・マント・表情・口パク）。VRMAモーション差し替え、移動/向き/表情/崩れ。
- player と editor のプレビューは**同じエンジン**を共用。

### 5.5 ゲームフロー
- `flow-player` が iframe で `story-player` / `swing-catch` を順に開き、`postMessage` の結果
  （done / win / lose）で次ノードへ分岐（`flow-ready` ハンドシェイクで戦闘設定を渡す）。
- 既存ページをほぼそのまま再利用するオーケストレータ方式。

---

## 6. 制作ワークフロー（例）

1. **キャラ**: Character Editor で表情/視線/behaviorを設定 → `.npc.json`、セリフは「セリフ保存」→ `.speech.json`。
2. **マント**: Cloth Editor で布を着せて `.cloth.json`（npc.json に同梱も可）。
3. **ステージ**: Stage Editor でモデル配置 → `<id>.stage.json`。
4. **ストーリー**: Story Editor でコマンド列＋セリフ→ `.story.json`（3Dプレビューで確認）。
5. **フロー**: Flow Editor でストーリー/戦闘ノードを接続し勝敗分岐 → `.flow.json`。戦闘ノードで敵・ステージ・セリフ差し替え・勝敗条件を指定。
6. **再生**: Flow Player で通し再生。

---

## 7. 開発・ビルド

- **開発サーバ**: `npm run dev`（Vite, https://localhost:5173/htdocs/3d_game/）。
- **保存API**（dev限定）: `POST /api/save { dir, filename, content }`。許可 dir: `npc / timeline / models / story / flow / speech / stage`。
- **一覧API**: `/<種別>/manifest.json`（npc/models/timeline/vrm/vrma/pmx/vmd/fbx/story/flow/speech/stages）。
- **ビルド**: 各ページ個別の `build:*`（swing-catch / character-editor / cloth / fps-cloth(-vrm)(-mobile) 等）＋ mobile 版。`dist-*/` 出力（gitignore 済み）。
- **テスト**: 純粋ロジック（state-machine / lip-sync / npc-speech / flow-runner 等）は Node + mock で検証可。E2E は playwright（任意）。

---

## 8. アセット出所（参考）

| 種別 | 出所 | ライセンス |
|------|------|------------|
| GLBキット（car / city / fantasy） | **Kenney.nl** | CC0（商用可・クレジット不要） |
| FBXモーション（Catwalk Walk Forward, Standing Idle 等） | **Mixamo (Adobe)** | Mixamo規約（無料） |
| PMXモデル（ドライツェーン等） | BOOTH / ニコニ立体 等（MMD） | 各モデル同梱規約に従う |
| VRMキャラ（lily/megu/ayu） | VRoid 系（推定） | 各モデル規約 |

---

## 9. 今後（ロードマップ）

- **フェーズ2b**: ボス（HP/フェーズ/専用攻撃パターン）、戦闘ごとのBGM/ステージの高度な組み合わせ。
- **フェーズ3**: ステージギミック（動く/飛んでくる障害物・ハザード）。
- その他: 戦闘バランス調整、ストーリーへの分岐/選択肢、音声/TTS連携（現状は未対応）。

---

*このドキュメントはシステムの現状（2026年6月時点）をまとめたもの。詳細仕様は `.tmp/` の各 requirements/design や `lib/` 各モジュール冒頭コメントを参照。*
