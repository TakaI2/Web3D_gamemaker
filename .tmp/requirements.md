# 要件定義書 - NPC セリフ（ダイアログ）システム

## 1. 目的

NPC キャラクターに個性を与えるため、各ステート（idle / alert / attack / taunt / downed / recovering）で
セリフをしゃべらせる仕組みを導入する。Character Editor でステートごとのセリフを編集でき、
ゲーム（まず swing-catch）では画面下部のセリフウィンドウと頭上の吹き出しでセリフを表示する。
本プロジェクトは 3D のため、セリフ再生中は表情変化（ブレンドシェイプ）と口パク（viseme リップシンク）を連動させる。

参考: `C:\Users\t-ito\Programs\RPG-Game`（敵エディタの `dialogs[state].lines[]` 構造、`Dialog.ts` の下部ウィンドウ、
`EnemySpeech.ts` の頭上吹き出し）をモデルにする。

---

## 2. スコープ

| 対象 | 内容 |
|------|------|
| データ拡張 | `*.npc.json` の `character.states[state]` にセリフ定義を追加（後方互換） |
| Character Editor | ステート別セリフ編集UI（行追加・削除・行ごとの表情指定・間隔）を追加 |
| 共通ライブラリ | `lib/` にセリフ再生＋口パク（viseme）コアを新規追加（フレームワーク非依存・素JS） |
| ゲーム統合 | **swing-catch を最初に**対応（下部ウィンドウ＋頭上吹き出し＋表情/口パク連動） |
| 流用 | `/src/lipsync/`（TS）の viseme マッピングロジックを素JSへ移植 |
| イベントbark | 掴まれた / 投げられた / 衝突 の瞬間反応セリフ（swing-catch のみ） |
| 対象外（今回） | fps-cloth-vrm 等への展開（共通lib化により後続で容易にする）、音声/TTS、多言語UI |

---

## 3. 機能要件

### FR-01: セリフデータ構造

| ID | 要件 |
|----|------|
| FR-01-1 | `character.states[state]` に任意フィールド `speech` を追加できる（無い場合は従来通り無発話） |
| FR-01-2 | `speech.lines[]` に複数のセリフ行を持てる。各行は文字列または `{ text, expression?, weight?, holdMs? }` |
| FR-01-3 | `speech.intervalMs` でループ表示時のセリフ間隔（ms）を指定できる |
| FR-01-4 | `speech.mode` で `once`（ステート進入時に1回）または `loop`（ステート滞在中ループ）を指定できる |
| FR-01-5 | 行ごとに `expression`（表情プリセット名）と `weight`（0〜1）を指定でき、未指定ならステートの表情を使用する |
| FR-01-6 | 既存の `*.npc.json`（speech 無し）をそのまま読み込めること（後方互換） |

### FR-02: Character Editor のセリフ編集UI

| ID | 要件 |
|----|------|
| FR-02-1 | ステート選択中に、そのステートの「セリフ」編集セクションを表示する |
| FR-02-2 | セリフ行をテキスト入力で追加・編集・削除（✕ボタン）できる |
| FR-02-3 | 各行に表情プリセット（neutral/happy/angry/sad/relaxed/surprised）と強度を任意指定できるUIを持つ |
| FR-02-4 | `mode`（once/loop）と `intervalMs` を編集できる |
| FR-02-5 | 編集内容は `exportBundle()` 経由で `*.npc.json` に保存される（既存の保存フローに統合） |
| FR-02-6 | 「試聴」ボタンで、編集中の行をエディタのプレビューVRMでしゃべらせ（口パク＋表情）確認できる |

### FR-03: 口パク（リップシンク）コア

| ID | 要件 |
|----|------|
| FR-03-1 | テキストを 1 文字ずつ viseme（aa/ih/ou/ee/oh）へ変換し、時間経過で口を動かす（音声非依存） |
| FR-03-2 | 日本語かな・カナ、英字の母音マッピングに対応する（`/src/lipsync/visemeMaps.ts` を移植） |
| FR-03-3 | `charsPerSecond`（既定 8）で発話速度を制御できる |
| FR-03-4 | 毎フレーム LERP で viseme を平滑化し、`vrm.expressionManager.setValue()` に適用する |
| FR-03-5 | 発話終了時にすべての viseme を 0 へ戻す |
| FR-03-6 | 口パクとステート/行の表情（happy 等）を同時適用できる（口は viseme、表情は別チャンネル） |

### FR-04: 下部セリフウィンドウ（swing-catch）

| ID | 要件 |
|----|------|
| FR-04-1 | 画面下部に話者名＋本文のウィンドウを HTML/CSS オーバーレイで表示する |
| FR-04-2 | 本文はタイピング送り（1文字ずつ）で表示する。表示速度は口パク速度と整合させる |
| FR-04-3 | 複数 NPC が同時発話しうる場合、下部ウィンドウは 1 つを共有し話者を順番に表示する（キュー方式） |
| FR-04-4 | セリフ表示完了後、一定時間または次セリフ到来でフェードアウトする |
| FR-04-5 | 話者名は NPC の `displayName` を用いる |

### FR-05: 頭上吹き出し（swing-catch）

| ID | 要件 |
|----|------|
| FR-05-1 | 発話中の各 NPC の頭上に小さな吹き出し（短文）を表示する |
| FR-05-2 | 吹き出しは NPC のワールド座標を画面座標へ投影して追従させる |
| FR-05-3 | カメラに背を向けている／遠距離／画面外の場合は非表示にする |
| FR-05-4 | 表示・フェードアウトのアニメーションを持つ（参考: EnemySpeech.ts の displayMs+フェード） |

### FR-06: ステート連動トリガ

| ID | 要件 |
|----|------|
| FR-06-1 | ステートマシンのステート遷移を検知し、新ステートに `speech` があれば発話を開始する |
| FR-06-2 | `mode:once` は遷移時に 1 回、`mode:loop` は滞在中 `intervalMs` 間隔で行を巡回する |
| FR-06-3 | 発話開始で口パク・表情・下部ウィンドウ・頭上吹き出しを同時に駆動する |
| FR-06-4 | ステートが変わったら現在の発話を中断し、新ステートのセリフへ切り替える |
| FR-06-5 | `downed` 中はステート発話・口パクを抑制する（任意でうめき声等は許容、既定は抑制） |

### FR-07: イベント反応セリフ（bark）

| ID | 要件 |
|----|------|
| FR-07-1 | `character.events` にイベント別セリフを持てる: `grabbed`（掴まれた）/ `thrown`（投げられた）/ `landed`（衝突・着地） |
| FR-07-2 | 各イベント定義はステートと同じ行フォーマット（文字列 or `{text, expression?, weight?, holdMs?}`）を用いる |
| FR-07-3 | swing-catch で対応イベント発生時（`grabMeguBody`/`tryGrab`、リリース、衝突検出）に該当 bark を再生する |
| FR-07-4 | bark は現在のステート発話に**割り込み**で優先再生し、短く（1行）終わったらステート発話へ戻す |
| FR-07-5 | 同種イベントの連発を防ぐクールダウン（既定 1500ms 程度）を設ける |
| FR-07-6 | `landed` は一定以上の衝突速度（しきい値）でのみ発火し、連続着地での多重発火を抑える |
| FR-07-7 | bark も口パク・表情・下部ウィンドウ/頭上吹き出しを駆動する |
| FR-07-8 | Character Editor でイベント別セリフを編集できる（ステート編集と同じ要領） |

---

## 4. 非機能要件

| ID | 要件 |
|----|------|
| NFR-01 | 共通ロジック（セリフ巡回・口パク）はフレームワーク非依存の素JSで `lib/` に置き、再利用可能にする |
| NFR-02 | TypeScript 不使用（既存の lib/・ゲーム側と同方針） |
| NFR-03 | `any`/`unknown` 相当の曖昧設計を避け、データ構造を明文化する |
| NFR-04 | 既存 `*.npc.json` を壊さない後方互換（speech 欠如時は無発話） |
| NFR-05 | 値のハードコードを避け、速度・間隔・距離等はデータ or 定数定義で管理する |
| NFR-06 | 既存のステートマシン `lib/npc-state-machine.js` の出力契約を壊さず拡張する |

---

## 5. セリフ JSON フォーマット（character.states 拡張）

```jsonc
{
  "character": {
    "schemaVersion": 1,
    "displayName": "lily",
    "states": {
      "attack": {
        "expression": { "angry": 0.8 },
        "lookAtEye": 1.0,
        "lookAtHead": 0.8,
        "speech": {
          "mode": "once",          // "once" | "loop"
          "intervalMs": 1200,       // loop 時の行間隔
          "charsPerSecond": 8,      // 省略時は既定値
          "lines": [
            "かかってきなさい！",
            { "text": "覚悟はいい？", "expression": "happy", "weight": 0.6, "holdMs": 800 }
          ]
        }
      }
    },
    "events": {
      "grabbed": { "lines": ["きゃっ!", { "text": "離して！", "expression": "angry", "weight": 0.7 }] },
      "thrown":  { "lines": ["とぶーー！"] },
      "landed":  { "lines": ["いてて…", { "text": "ひどい…", "expression": "sad", "weight": 0.5 }] }
    }
  }
}
```

- 行が文字列の場合は表情はステートの `expression` を使用。
- 行がオブジェクトの場合は `text` 必須、`expression`/`weight`/`holdMs` は任意。
- `events` の各 bark はステート発話に割り込み優先。クールダウンと衝突しきい値は設計で定義。

---

## 6. 制約・前提

- viseme プリセット（aa/ih/ou/ee/oh）は VRM 表情に存在する前提。存在しない場合は口パクをスキップ（表情のみ）。
- 下部ウィンドウ／頭上吹き出しは HTML/CSS オーバーレイで実装（WebGPU 描画とは独立）。
- swing-catch を対象に実装し、共通 lib 化により他ゲームへ展開できる構造とする。
- 音声・TTS は対象外（テキスト駆動の口パクのみ）。
