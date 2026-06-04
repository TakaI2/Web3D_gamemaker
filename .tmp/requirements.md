# 要件定義書 - 反応セリフの分離（speech.json）とアクター単位の差し替え

## 1. 目的

キャラの「反応セリフ」（events ＝ grabbed/thrown/landed/menace/attackHit、および state 別の bark）を
npc.json（VRM同梱の巨大ファイル）から**独立した軽量ファイル `*.speech.json` に完全分離**する。
さらに、同じキャラが別ステージで別のセリフを話せるよう、**バトル/ストーリーのアクター単位で speech セットを差し替え**可能にする。

決定事項（ユーザー確認済み）:
- 完全分離（npc.json から反応セリフを除去し speech.json へ）。npc.json は表情/視線/behavior のみ。
- 編集は character-editor を拡張（セリフ部は speech.json に保存）。
- 上書き単位は**アクター単位**（バトルの enemies / ストーリーの actors ごとに speech 指定）。

注: ストーリーの脚本セリフ（`say` op の lines）は従来どおり story.json 内（変更なし）。本件は反応セリフのみ。

---

## 2. スコープ

| 対象 | 内容 |
|------|------|
| データ | 新フォーマット `public/speech/*.speech.json`（displayName / states[state] / events） |
| 新規 lib | `lib/speech-set.js`（speech.json → npc-speech 用の合成 characterDef を生成） |
| 変更 | swing-catch：enemies の speech 解決（規約＋アクター上書き）、createMegu でセリフを sidecar から |
| 変更 | story-actors / story-stage：actors の speech 上書き対応 |
| 変更 | character-editor：speech.json の読込/保存に切替（npc.json からセリフを除去） |
| 変更 | flow-editor / story-editor：アクターごとに speech ファイルを選べるUI |
| 変更 | vite.config：save 許可 dir に `speech`、`/speech/manifest.json` |
| 移行 | 既存 npc.json のセリフを speech.json へ抽出する移行スクリプト（lily/megu/ayu 等） |
| 不変 | npc-speech 本体（合成 characterDef を受け取り従来通り動作） |

---

## 3. データモデル（*.speech.json）

```jsonc
{
  "version": 1,
  "id": "lily",
  "displayName": "lily",
  "states": {                                  // state 名 → speech オブジェクト
    "idle":   { "mode": "loop", "intervalMs": 2500, "lines": [ "…ひま。", "だれかこないかな" ] },
    "attack": { "mode": "loop", "intervalMs": 1500, "lines": [ "そこっ！" ] }
  },
  "events": {
    "grabbed":   { "lines": [ "きゃっ!", { "text": "離して！", "expression": "angry", "weight": 0.7 } ] },
    "menace":    { "lines": [ "いくよっ！" ] },
    "attackHit": { "lines": [ "当たった♪" ] }
  }
}
```

### 解決順（アクターの speech セット決定）
1. アクター指定の override（`enemies[i].speech` / `actors[i].speech`）。
2. 規約: `<npcファイル名(.npc.json除去)>.speech.json`（例 `lily.npc.json` → `lily.speech.json`）。
3. 無ければ反応セリフ無し（口パク/表情/UI は従来どおり機能）。

### enemies / actors の指定形式（後方互換）
- 文字列: `"lily.npc.json"`（規約の speech を使用）。
- オブジェクト: `{ "npc": "lily.npc.json", "speech": "lily_dark.speech.json" }`（override）。
- story actors: `{ "id": "lily", "npc": "lily.npc.json", "speech": "..." }`。

---

## 4. 機能要件

### FR-01: speech-set ローダ（lib/speech-set.js）
| ID | 要件 |
|----|------|
| FR-01-1 | `speechUrl(file)`：lib 相対（import.meta.url）で `../speech/<file>` を解決 |
| FR-01-2 | `buildSpeechCharacter(speechData, fallbackName)`：npc-speech が読む `{displayName, states:{s:{speech}}, events}` を生成 |
| FR-01-3 | speechData 無し時は空（events/states 無し＝無発話）を返す（落ちない） |
| FR-01-4 | npc ファイル名から規約の speech ファイル名を導く `defaultSpeechFile(npcFile)` |

### FR-02: swing-catch（戦闘）
| ID | 要件 |
|----|------|
| FR-02-1 | enemies の各要素（string/object）から npc と speech を解決 |
| FR-02-2 | createMegu が speech ファイルを読み、buildSpeechCharacter→createNpcSpeech に渡す |
| FR-02-3 | speech 未指定/無しでも従来どおり動作（無発話） |

### FR-03: story（アクター）
| ID | 要件 |
|----|------|
| FR-03-1 | story.actors の `speech` 上書きに対応（無ければ規約） |
| FR-03-2 | story-stage が speech を読み、actorManager.show に渡す |

### FR-04: character-editor（speech.json 編集）
| ID | 要件 |
|----|------|
| FR-04-1 | NPC 読込時に対応する `<name>.speech.json` を読み（無ければ空で開始） |
| FR-04-2 | セリフ編集（state別＋events）は speech データを編集する |
| FR-04-3 | 「セリフ保存」で speech.json を `public/speech/` に保存（軽量・npc.json は触らない） |
| FR-04-4 | 「NPC保存」（exportBundle）時、character からセリフ（speech/events）を除去して保存 |
| FR-04-5 | 試聴は従来どおりプレビューVRMで口パク＋表情 |

### FR-05: エディタからの差し替え指定
| ID | 要件 |
|----|------|
| FR-05-1 | flow-editor の battle ノードで、enemies ごとに speech ファイルを選択できる |
| FR-05-2 | story-editor の actors で、各アクターに speech ファイルを選択できる |
| FR-05-3 | 一覧は `/speech/manifest.json` から取得（手入力に頼らない） |

### FR-06: 移行
| ID | 要件 |
|----|------|
| FR-06-1 | 既存 npc.json の `character.states[].speech` と `character.events` を `<name>.speech.json` に抽出 |
| FR-06-2 | 抽出後、npc.json 側からセリフを除去（任意・character-editor 保存時にも除去される） |

---

## 5. 非機能要件
| ID | 要件 |
|----|------|
| NFR-01 | npc-speech 本体は無変更（合成 characterDef 経由）。既存の bark/口パク仕様を維持 |
| NFR-02 | 後方互換：speech 無しのアクターは無発話で従来動作 |
| NFR-03 | TypeScript/class 不使用、データ駆動、ハードコード回避 |
| NFR-04 | speech.json は KB 級の軽量ファイル（巨大 npc.json を触らずセリフ編集） |

---

## 6. 制約・前提
- npc.json には引き続き表情/視線/behavior（character.states の expression/lookAt 等）が残る。state 別 bark のみ speech.json へ。
- 既存 npc.json（VRM同梱・大容量）はコミット対象外運用のまま。speech.json は軽量なのでコミット可。
