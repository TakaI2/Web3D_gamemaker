# 要件定義書 - 3D ストーリー（シナリオ）システム

## 1. 目的

参考プロジェクト（RPG-Game）の「ストーリーエディタ＋ストーリー再生」を本プロジェクトへ移植する。
ただし本プロジェクトは 3D のため、2D 立ち絵(portrait)ではなく **3D キャラ（npc.json）にしゃべらせながらアクションさせる**。
ストーリーは op の線形スクリプトとして表現し、専用の再生ページとエディタページを新規に作る。

参考: RPG-Game の `StoryRunner.ts`（op を1つずつ実行・`say` でクリック待ち）、`gameflow-editor`（編集UI）。
本プロジェクトの既存資産（`lib/npc-speech` 口パク・セリフ、`speech-ui` 下部ウィンドウ、`vrm-cloth`/`vrm-ragdoll`、VRMA、stage.json）を流用する。

---

## 2. スコープ

| 対象 | 内容 |
|------|------|
| 新規ページ | `story-player/`（3D再生）, `story-editor/`（コマンド編集） |
| 新規 lib | `lib/story-runner.js`（線形スクリプト実行）, `lib/story-actors.js`（アクター=VRM管理） |
| 流用 | `lib/npc-speech.js` / `lib/lip-sync.js` / `lib/speech-ui.js` / `lib/vrm-cloth.js` / `lib/vrm-ragdoll.js`、`public/npc/*.npc.json`、`public/vrma/*.vrma`、`public/models/stage.json` |
| データ | `public/story/*.story.json`（新フォーマット） |
| 対象外（v1） | 分岐・選択肢・フラグ・条件分岐（参考プロジェクトも未実装）、音声/TTS、ゲーム本編フローへの統合 |

決定事項（ユーザー確認済み）:
- 構成: **専用ページ新規（editor + player）**
- コマンド範囲: **基本セット（線形・分岐なし）**
- 背景/舞台: **stage-editor のステージ(stage.json)を流用**

---

## 3. ストーリーデータ形式（*.story.json）

```jsonc
{
  "version": 1,
  "id": "intro",
  "title": "プロローグ",
  "stage": "stage.json",                 // public/models/ のステージ（任意）
  "actors": [                            // 使用アクターの宣言（事前ロード用）
    { "id": "lily", "npc": "lily.npc.json" },
    { "id": "megu", "npc": "megu.npc.json" }
  ],
  "script": [
    { "op": "fade.in", "duration": 500 },
    { "op": "bgm.play", "name": "bgm1.ogg", "loop": true, "volume": 0.6 },
    { "op": "actor.show", "id": "lily", "x": 0, "y": 0, "z": 0, "ry": 180, "scale": 1 },
    { "op": "camera", "pos": [0, 1.4, 3], "target": [0, 1.2, 0], "duration": 0 },
    { "op": "actor.face", "id": "lily", "target": "camera" },
    { "op": "say", "actor": "lily", "lines": ["こんにちは。", "今日はいい天気ね。"] },
    { "op": "actor.anim", "id": "lily", "vrma": "004_hello_1.vrma", "loop": false },
    { "op": "actor.move", "id": "lily", "x": 2, "z": 1, "duration": 1500, "wait": true },
    { "op": "actor.expression", "id": "lily", "expression": "happy", "weight": 0.8 },
    { "op": "delay", "duration": 600 },
    { "op": "fade.out", "duration": 500 },
    { "op": "actor.hide", "id": "lily" },
    { "op": "end" }
  ]
}
```

---

## 4. コマンド（op）仕様

実行の同期種別:
- **ブロッキング**（runner が完了まで待つ）: `say`(クリック待ち), `delay`, `fade.in`, `fade.out`, および任意 op に `"wait": true` を付けた場合（その op の duration を待つ）。
- **ノンブロッキング**（開始して即次へ）: `actor.*`, `camera`, `bgm.*`, `se`, `stage`, `bg`（`wait:true` で待たせられる）。
  → これにより「歩かせながら同時にしゃべる」等が表現できる。

| op | 用途 | 主パラメータ | 同期 |
|----|------|--------------|------|
| `say` | アクターがしゃべる（口パク＋下部ウィンドウ＋頭上吹き出し） | `actor`(id), `lines[]`, `cps?`, `expression?` | ブロッキング（クリック/Spaceで送り） |
| `wait` | クリック待ちのみ（テキストなし） | - | ブロッキング |
| `actor.show` | npc.json を読み込み舞台に登場 | `id`, `x,y,z`, `ry`, `scale?`, `fade?` | ノン（`wait`可） |
| `actor.hide` | アクター退場 | `id`, `fade?` | ノン |
| `actor.move` | 指定座標へ移動（向きも進行方向へ） | `id`, `x,z`, `duration`, `face?` | ノン（`wait`で完了待ち） |
| `actor.face` | 向きを変える | `id`, `target`: `camera`/`actorId`/`[x,z]` | ノン |
| `actor.anim` | VRMA モーション再生 | `id`, `vrma`(public/vrma名), `loop?`, `fade?` | ノン（`wait`で1周待ち可） |
| `actor.expression` | 表情を直接指定 | `id`, `expression`, `weight?`, `duration?` | ノン |
| `actor.ragdoll` | 崩れる/起き上がる（既存ragdoll流用） | `id`, `active`(bool) | ノン |
| `camera` | カメラ移動・注視点 | `pos:[x,y,z]`, `target:[x,y,z]`, `duration?` | ノン（`wait`可） |
| `stage` | ステージ(GLB配置)を読み込み | `name`(models/配下) | ノン（`wait`可） |
| `bg` | 背景色/空の切替 | `color?`, `image?` | ノン |
| `bgm.play` | BGM 再生 | `name`, `loop?`, `volume?`, `fade?` | ノン |
| `bgm.stop` | BGM 停止 | `fade?` | ノン |
| `se` | SE 再生 | `name`, `volume?` | ノン |
| `delay` | 一定時間待つ | `duration`(ms) | ブロッキング |
| `fade.in` | 画面フェードイン | `color?`, `duration?` | ブロッキング |
| `fade.out` | 画面フェードアウト | `color?`, `duration?` | ブロッキング |
| `end` | ストーリー終了 | - | 終了 |

---

## 5. 機能要件

### FR-01: ストーリー再生エンジン（lib/story-runner.js）
| ID | 要件 |
|----|------|
| FR-01-1 | 線形 script を pc（プログラムカウンタ）で1コマンドずつ実行する |
| FR-01-2 | op 種別ごとに hooks（onSay/onActorShow/onCamera…）を呼ぶ。runner は3D非依存 |
| FR-01-3 | ブロッキング op は hook の Promise を await してから次へ進む |
| FR-01-4 | ノンブロッキング op は開始のみ。`wait:true` 指定時は完了を await |
| FR-01-5 | `say`/`wait` はクリックまたは Space キーで次へ送る |
| FR-01-6 | 任意位置から再生開始（pc 指定）できる（エディタのプレビュー用） |
| FR-01-7 | スキップ/中断（stop）できる |

### FR-02: アクター管理（lib/story-actors.js）
| ID | 要件 |
|----|------|
| FR-02-1 | npc.json を読み込み VRM を scene に追加、位置/回転/スケールを設定 |
| FR-02-2 | マント(cloth)・表情・口パクを既存 lib で駆動（npc-speech / vrm-cloth） |
| FR-02-3 | actor.move を duration で線形/イージング補間（毎フレーム更新） |
| FR-02-4 | actor.face で camera/別アクター/座標の方へ向ける |
| FR-02-5 | actor.anim で public/vrma の VRMA を読み込み AnimationMixer で再生（差し替え・フェード） |
| FR-02-6 | actor.expression で表情を一定時間かけて設定 |
| FR-02-7 | actor.ragdoll で既存 vrm-ragdoll を有効/無効化 |
| FR-02-8 | say 時に該当アクターが口パク＋表情（行ごと表情指定可、既存仕様流用） |

### FR-03: ストーリープレイヤー（story-player/）
| ID | 要件 |
|----|------|
| FR-03-1 | WebGPU で 3D シーン（床＋空＋ライト）を構築、stage.json を流用可 |
| FR-03-2 | URL もしくはセレクタで *.story.json を読み込み再生 |
| FR-03-3 | 下部セリフウィンドウ・頭上吹き出し（speech-ui 流用）を表示 |
| FR-03-4 | クリック/Space で say を送る。フェード・delay・BGM が機能する |
| FR-03-5 | カメラ・アクター移動・モーションが毎フレーム滑らかに更新される |
| FR-03-6 | 再生完了（end）でタイトルへ戻る/停止する |

### FR-04: ストーリーエディタ（story-editor/）
| ID | 要件 |
|----|------|
| FR-04-1 | コマンド列をリスト表示し、追加・削除・並べ替え（上下移動）できる |
| FR-04-2 | 各コマンドは op 選択＋パラメータ編集フォーム（op に応じて項目が変わる） |
| FR-04-3 | アクター一覧（id↔npc.json）とステージを設定できる |
| FR-04-4 | `say` の lines は複数行編集でき、行ごとの表情も指定できる |
| FR-04-5 | アクター/VRMA/ステージはプロジェクト内の一覧から選択（手入力に頼らない） |
| FR-04-6 | ライブ 3D プレビュー：選択コマンドから再生、または全体再生で確認できる |
| FR-04-7 | `*.story.json` を `public/story/` へ保存（api/save）・読み込みできる |
| FR-04-8 | 既存ストーリーを開いて編集・上書き保存できる |

---

## 6. 非機能要件

| ID | 要件 |
|----|------|
| NFR-01 | runner はフレームワーク非依存の素JS（hooks 注入式）。TypeScript/class 不使用 |
| NFR-02 | 既存 lib（npc-speech/lip-sync/speech-ui/vrm-cloth/vrm-ragdoll）を再利用し重複実装しない |
| NFR-03 | データ駆動。op 種別・既定値は定数/スキーマで管理しハードコードを避ける |
| NFR-04 | 不正/未知 op はスキップしコンソール警告（再生を止めない） |
| NFR-05 | WebGPU 非対応時は警告表示 |
| NFR-06 | 外部依存は esm.sh CDN のみ（他ページと同方針、ビルドなしで動く） |

---

## 7. 制約・前提

- アクターは `public/npc/*.npc.json`（VRM/cloth/character 同梱）を使用。
- モーションは `public/vrma/*.vrma`（dogeza/hello/gekirei/walk/idle 等が既存）。
- ステージは `public/models/stage.json`（stage-editor 出力）を流用。
- BGM/SE 音源は `public/assets/...` 等に配置（無ければ無音で継続）。
- v1 は分岐なしの線形。将来 `choice`/`if`/`flag` op を追加できる拡張余地を残す。
