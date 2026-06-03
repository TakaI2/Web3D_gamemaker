# 要件定義書 - ゲームフロー（ノード接続）システム ＜フェーズ1＞

## 1. 目的

ストーリーと戦闘（swing-catch ベース）をノードで繋ぎ、戦闘結果（勝ち/負け）で次のノードへ分岐できる
「ゲームフロー」を作る。参考は RPG-Game の gameflow-editor（ノードグラフ）と GameFlowManager（結果で分岐）。
本プロジェクトは 3D・Web。フェーズ1ではフロー基盤＋ノードエディタ＋分岐と、戦闘の薄い結着（勝敗を返す）までを作る。

決定事項（ユーザー確認済み）:
- ロードマップ採用。**フェーズ1＝ノードエディタ＋ランナー＋story/battle分岐**から。
- 戦闘は **swing-catch ベース**（掴んで投げる＋射撃の両方を内蔵）。操作は現行の PC/スマホUIをそのまま。
- 実行形態は **専用フロープレイヤーページ**。

---

## 2. スコープ

| 対象 | 内容 |
|------|------|
| データ | `public/flow/*.flow.json`（nodes + edges。battle は win/lose の分岐出力） |
| 新規 lib | `lib/flow-runner.js`（ノード走査・分岐解決・3D非依存） |
| 新規ページ | `flow-editor/`（ノードグラフ編集）, `flow-player/`（連続再生＝オーケストレータ） |
| 流用 | 既存 `story-player/`（ストーリー再生）, `swing-catch/`（戦闘）を iframe で内包し postMessage で結果連携 |
| 変更 | `story-player`：埋め込み時に終了を親へ通知。`swing-catch`：フロー(battle)モード（設定受取＋勝敗判定＋結果通知） |
| 変更 | `vite.config.ts`：save 許可 dir に `flow`、`/flow/manifest.json` 配信 |
| 対象外（フェーズ1） | ボスのHP/フェーズ/攻撃パターン作り込み、ライフUIの作り込み、ステージギミック、ボス×ステージ高度な組合せ、チャプタ概念（→ フェーズ2/3） |

---

## 3. データモデル（*.flow.json）

```jsonc
{
  "version": 1,
  "id": "chapter1",
  "title": "第1章",
  "start": "n_intro",                    // 開始ノードid（または start ノード種別）
  "nodes": [
    { "id": "n_intro", "type": "story",  "x": 60,  "y": 80,
      "data": { "story": "sample.story.json" } },
    { "id": "n_battle1", "type": "battle", "x": 320, "y": 80,
      "data": { "battle": "battle1.battle.json" } },     // 戦闘設定（フェーズ1は最小）
    { "id": "n_win",  "type": "story", "x": 600, "y": 20, "data": { "story": "win.story.json" } },
    { "id": "n_lose", "type": "story", "x": 600, "y": 160, "data": { "story": "lose.story.json" } },
    { "id": "n_end",  "type": "end",   "x": 860, "y": 80, "data": {} }
  ],
  "edges": [
    { "from": "n_intro",  "fromPort": "next", "to": "n_battle1" },
    { "from": "n_battle1","fromPort": "win",  "to": "n_win" },
    { "from": "n_battle1","fromPort": "lose", "to": "n_lose" },
    { "from": "n_win",    "fromPort": "next", "to": "n_end" },
    { "from": "n_lose",   "fromPort": "next", "to": "n_end" }
  ]
}
```

ノード種別と出力ポート:
| type | 役割 | 出力ポート |
|------|------|------------|
| `start` | 開始（任意。無ければ start フィールドで指定） | `next` |
| `story` | ストーリー再生（story-player） | `next` |
| `battle` | 戦闘（swing-catch） | `win` / `lose` |
| `end` | 終了（タイトル/フロー終了） | （なし） |

戦闘設定 `*.battle.json`（フェーズ1・最小）:
```jsonc
{
  "version": 1, "id": "battle1", "title": "戦闘1",
  "stage": "stage.json",            // 流用ステージ（任意）
  "enemies": ["lily.npc.json", "megu.npc.json"],   // 出現NPC
  "bgm": "battle.ogg",              // 任意（無ければ無音）
  "win":  { "type": "defeatCount", "count": 5 },    // 撃破(ラグドール化)累計で勝利
  "lose": { "type": "playerHp", "hp": 5 }           // プレイヤーHP 0 で敗北
}
```

---

## 4. 機能要件

### FR-01: フローランナー（lib/flow-runner.js・3D非依存）
| ID | 要件 |
|----|------|
| FR-01-1 | nodes/edges を保持し、start から現在ノードを管理する |
| FR-01-2 | `nextNode(currentId, port)` で指定ポートのエッジを辿り次ノードを返す |
| FR-01-3 | story ノードは完了で `next` ポート、battle ノードは結果 `win`/`lose` ポートで分岐 |
| FR-01-4 | 接続先が無い／end ノードでフロー終了とする |
| FR-01-5 | 不正ノード/エッジは警告しスキップ（停止しない） |
| FR-01-6 | 任意ノードから開始できる（エディタのテスト用） |

### FR-02: ノードグラフエディタ（flow-editor/）
| ID | 要件 |
|----|------|
| FR-02-1 | キャンバスにノードを配置し、ドラッグで移動・座標を保存できる |
| FR-02-2 | ノード追加（start/story/battle/end）・削除ができる |
| FR-02-3 | 出力ポート→入力ポートをドラッグで接続（エッジ作成）、削除できる |
| FR-02-4 | battle ノードは win/lose の2出力ポートを持ち、それぞれ別ノードへ繋げる |
| FR-02-5 | ノード選択でプロパティ編集（story ノード→story選択、battle ノード→battle設定/作成） |
| FR-02-6 | エッジは SVG 等で結線表示、パン/ズームできる |
| FR-02-7 | `*.flow.json` を `public/flow/` へ保存・読み込みできる |
| FR-02-8 | 開始ノードを指定できる |

### FR-03: フロープレイヤー（flow-player/・オーケストレータ）
| ID | 要件 |
|----|------|
| FR-03-1 | `*.flow.json` を読み込み、start ノードから順に実行する |
| FR-03-2 | story ノード：`story-player` を iframe で開き（?id=指定・フローモード）、終了通知で `next` へ |
| FR-03-3 | battle ノード：`swing-catch` を iframe で開き（?battle=指定・フローモード）、結果(win/lose)で分岐 |
| FR-03-4 | iframe からの `postMessage`（{type:'flow-result', result}）を受けて次ノードへ進む |
| FR-03-5 | end ノードでフロー終了（タイトル/一覧へ戻る） |
| FR-03-6 | フロー進行状態（現在ノード）を簡易表示できる（デバッグ） |

### FR-04: story-player のフローモード
| ID | 要件 |
|----|------|
| FR-04-1 | `?flow=1` 時、`end` 到達で親へ `postMessage({type:'flow-result', result:'done'})` を送る |
| FR-04-2 | `?id=` で指定ストーリーを自動再生（開始オーバーレイをスキップ可） |

### FR-05: swing-catch のフロー(battle)モード
| ID | 要件 |
|----|------|
| FR-05-1 | `?battle=<file>` 等で戦闘設定を読み込み、enemies/stage/bgm を反映する |
| FR-05-2 | 勝利条件（defeatCount 等）と敗北条件（playerHp 0）を判定する |
| FR-05-3 | プレイヤーHP を持ち、攻撃NPC接触等で減少、HP/勝敗を簡易表示する |
| FR-05-4 | 決着時に親へ `postMessage({type:'flow-result', result:'win'|'lose'})` を送る |
| FR-05-5 | 通常（非フロー）起動時は従来のサンドボックス挙動を維持する（後方互換） |
| FR-05-6 | 操作は現行の PC/スマホUIをそのまま使う |

---

## 5. 非機能要件

| ID | 要件 |
|----|------|
| NFR-01 | flow-runner は素JS・3D非依存（hooks/結果注入）。TypeScript/class 不使用 |
| NFR-02 | 既存ページ（story-player/swing-catch）を極力そのまま再利用（iframe + postMessage） |
| NFR-03 | 既存のスタンドアロン挙動を壊さない（?flow/?battle 無し時は従来動作） |
| NFR-04 | データ駆動。ノード種別・既定値・勝敗条件種別は定数/スキーマで管理 |
| NFR-05 | 不正データで停止しない（警告して継続） |
| NFR-06 | 外部依存は esm.sh CDN のみ（他ページと同方針） |

---

## 6. 制約・前提

- ストーリーは既存 `*.story.json`、戦闘は新規 `*.battle.json`、フローは `*.flow.json`。
- フェーズ1の battle は「最小で勝敗が出る」レベル（撃破累計 win / プレイヤーHP0 lose）。ボスHP/フェーズ/攻撃や
  ステージギミックはフェーズ2/3。
- iframe は同一オリジン（dev server）前提で postMessage 連携。
- フェーズ2でボス（volg_boss相当のHP/フェーズ/攻撃）・ライフUI・BGM/ステージ組合せ、フェーズ3でギミックを追加。
