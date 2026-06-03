# 設計書 - ゲームフロー（ノード接続）システム ＜フェーズ1＞

要件: `.tmp/requirements.md`
対象: flow-editor / flow-player（新規）＋ lib/flow-runner ＋ story-player/swing-catch のフローモード

---

## 1. 全体アーキテクチャ

```
  flow-editor/  ── 編集 ──▶  public/flow/*.flow.json  ◀── 読込 ──  flow-player/
   （ノードグラフ）                                                  （オーケストレータ）
        │                                                               │
        └── lib/flow-runner.js（nodes/edges 走査・分岐解決・3D非依存）──┘
                                                                        │ iframe + postMessage
                                        ┌───────────────────────────────┴───────────────┐
                                        ▼                                                ▼
                              story-player/?flow=1&id=…                      swing-catch/?flow=1
                              （終了で result:'done'）                  （flow-config 受信→戦闘→result:'win'|'lose'）
```

設計方針:
- **flow-runner はグラフ走査のみ**（3D非依存・純粋）。実行（再生/戦闘）は flow-player が iframe で担当。
- 既存ページ（story-player / swing-catch）を **iframe + postMessage** で再利用。非フロー時は従来動作を維持。
- **戦闘設定は battle ノードの data にインライン**。flow-player が iframe ロード後に postMessage で渡す（別ファイル不要）。

---

## 2. データモデル（*.flow.json）

```jsonc
{
  "version": 1, "id": "chapter1", "title": "第1章",
  "start": "n_intro",
  "nodes": [
    { "id": "n_intro",  "type": "story",  "x": 60,  "y": 120, "data": { "story": "sample.story.json" } },
    { "id": "n_battle1","type": "battle", "x": 340, "y": 120, "data": { "battle": {
        "title": "戦闘1",
        "enemies": ["lily.npc.json", "megu.npc.json"],
        "stage": "stage.json",
        "bgm": "",
        "win":  { "type": "defeatCount", "count": 5 },
        "lose": { "type": "playerHp",    "hp": 5 }
      } } },
    { "id": "n_win",  "type": "story", "x": 620, "y": 40,  "data": { "story": "win.story.json" } },
    { "id": "n_lose", "type": "story", "x": 620, "y": 220, "data": { "story": "lose.story.json" } },
    { "id": "n_end",  "type": "end",   "x": 880, "y": 120, "data": {} }
  ],
  "edges": [
    { "from": "n_intro",  "fromPort": "next", "to": "n_battle1" },
    { "from": "n_battle1","fromPort": "win",  "to": "n_win" },
    { "from": "n_battle1","fromPort": "lose", "to": "n_lose" },
    { "from": "n_win",  "fromPort": "next", "to": "n_end" },
    { "from": "n_lose", "fromPort": "next", "to": "n_end" }
  ]
}
```

ノード種別（lib/flow-ops 相当の定数 `NODE_TYPES`）:
| type | 出力ポート | data |
|------|-----------|------|
| `start` | next | （なし） |
| `story` | next | `{ story: <file> }` |
| `battle`| win, lose | `{ battle: {enemies[], stage, bgm, win, lose} }` |
| `end` | （なし） | （なし） |

戦闘の勝敗条件種別（`WIN_TYPES`/`LOSE_TYPES`）:
- win: `defeatCount`(count) … 撃破累計。将来 `bossHp` を追加。
- lose: `playerHp`(hp) … プレイヤーHP0。将来 `timeout` 等。

---

## 3. lib/flow-runner.js（グラフ走査・3D非依存）

```js
export const NODE_TYPES = {
  start:  { label: '開始', ports: ['next'] },
  story:  { label: 'ストーリー', ports: ['next'] },
  battle: { label: '戦闘', ports: ['win', 'lose'] },
  end:    { label: '終了', ports: [] },
};

export function createFlow(flow) {
  const byId = new Map((flow.nodes || []).map(n => [n.id, n]));
  const edges = flow.edges || [];
  function getStart() {
    if (flow.start && byId.has(flow.start)) return byId.get(flow.start);
    return (flow.nodes || []).find(n => n.type === 'start') || (flow.nodes || [])[0] || null;
  }
  function next(nodeId, port) {
    const e = edges.find(e => e.from === nodeId && e.fromPort === port);
    return e ? (byId.get(e.to) || null) : null;
  }
  return { getStart, getNode: (id) => byId.get(id) || null, next, nodes: flow.nodes || [], edges };
}
```

- story/start 完了 → `next(id, 'next')`。battle → `next(id, 'win'|'lose')`。
- 接続先なし or end → フロー終了。

---

## 4. flow-player/（オーケストレータ）

`index.html`: 全画面 `#frame`(iframe) ＋ `#hud`(現在ノード表示・再開・← 一覧) ＋ ローディング/終了表示。

`flow-player.js`:
```
1. /flow/manifest.json で一覧、?id= or セレクトで *.flow.json 取得 → createFlow。
2. run(node):
   - start  → advance(next(node,'next'))
   - story  → frame.src = '../story-player/?flow=1&id=' + node.data.story
              （result:'done' 受信で advance(next(node,'next')))
   - battle → frame.src = '../swing-catch/?flow=1'
              iframe 'load' で frame.contentWindow.postMessage({type:'flow-config', battle:node.data.battle}, origin)
              （result:'win'|'lose' 受信で advance(next(node, result)))
   - end / null → 終了表示（一覧へ）
3. window 'message' リスナ：origin 検証 → {type:'flow-result', result} で現在ノードを解決し advance。
4. HUD に現在ノード id/type を表示。
```

- 多重発火防止: ノードごとに「結果待ち」を1回だけ受ける（フラグ/トークン）。
- iframe は同一オリジン前提（origin 検証）。

---

## 5. story-player フローモード（最小変更）

- `?flow=1` を検出: 開始オーバーレイを出さず、`?id=` のストーリーを `loadStory` 後すぐ `play(0)`。
- `setOnEnd` で `end` 到達時: `parent.postMessage({type:'flow-result', result:'done'}, location.origin)`。
- 非フロー時は従来（オーバーレイ・セレクト）。

---

## 6. swing-catch フロー(battle)モード（追加・後方互換）

検出: `?flow=1`。親からの `postMessage({type:'flow-config', battle})` を待って戦闘開始。

追加要素（フロー時のみ有効。非フロー時は一切作動させず従来挙動）:
- **敵構成**: `loadMegus()` を `battle.enemies`（指定 npc ファイル群）で行う（非フローは従来 NPC_FILES）。
- **ステージ/BGM**: `battle.stage` を読み込み、`battle.bgm` があれば Audio 再生。
- **プレイヤーHP**: `playerHp`（初期=lose.hp 基準の最大値、例 maxHp=10）。`attack` ステートのNPCが
  カメラ（プレイヤー）に一定距離内へ来たら、クールダウン付きで 1 ダメージ。0 で敗北。
- **撃破カウント**: 射撃命中（`hitMegu`）・投擲（`releaseMegu` 後の着地KO）で `defeatCount++`。
  `win.type==='defeatCount'` の `count` 到達で勝利。
- **HUD**: HP バーと「撃破 n/total」を簡易表示（フロー時のみ）。
- **決着**: 勝敗確定で操作を止め、バナー表示後 `parent.postMessage({type:'flow-result', result})`。

実装の隔離: `const FLOW = new URLSearchParams(location.search).get('flow')==='1';` を入口に、
HP/カウント/HUD/結果通知を `if (FLOW)` で束ねる。既存のゲームループ・操作系はそのまま。

勝敗カウントのフック箇所（既存関数に1行ずつ）:
| 契機 | 箇所 | 処理 |
|------|------|------|
| 射撃命中 | `hitMegu()` | FLOW時 `onDefeat()` |
| 投擲KO | `releaseMegu()`／landed検出 | FLOW時 `onDefeat()`（過剰カウント防止にCD） |
| 被ダメ | `updateMegus`/プレイヤー近接判定（新規） | FLOW時 attackNPC接触で `onPlayerHit()` |

---

## 7. flow-editor/（ノードグラフ編集）

レイアウト: top（flow選択/新規/保存・開始ノード指定・プレイヤーリンク）＋ center（グラフキャンバス）＋ right（選択ノードのプロパティ）。

グラフ実装:
- `#canvas`（パン/ズーム可能な内側 `#world` に transform）。ノードは絶対配置 `div`、エッジは `<svg>` のベジェ path。
- ノード div: ヘッダ（type ラベル＋ id）＋ 入力ポート(左)＋ 出力ポート(右: type ごと next / win,lose)。
- 操作:
  - ノードドラッグ移動（x,y 更新・再描画）。
  - 出力ポート mousedown → ドラッグ → 入力ポート mouseup でエッジ作成（同 fromPort の既存エッジは置換）。
  - エッジクリックで削除（または選択して Delete）。
  - 背景ドラッグでパン、ホイールでズーム。
- ツールバー: ノード追加（start/story/battle/end）、削除、開始ノード指定（選択ノードを start に）、保存、flow 選択読込、新規。
- 右パネル（プロパティ・データ駆動）:
  - story: `story` を `/story/manifest.json` のセレクトで選択。
  - battle: `enemies`（`/npc/manifest.json` から複数選択）、`stage`（`/models/manifest.json`＋stage.json）、`bgm`(text)、
    `win.count`(number)、`lose.hp`(number)。
  - start/end: なし。
- 保存/読込: `POST ../api/save {dir:'flow', filename:'<id>.flow.json', content}`。`/flow/manifest.json` 一覧。

座標は node.x/node.y に保持（RPG-Game の `_editorPositions` 相当をノード自体に持たせる）。

---

## 8. vite.config.ts 変更

```ts
const allowed = { npc:'npc', timeline:'timeline', models:'models', story:'story', flow:'flow' };  // flow 追加
// /flow/manifest.json（*.flow.json 一覧）を npc 同型で追加
```

---

## 9. 新規/変更ファイル

| 種別 | パス | 内容 |
|------|------|------|
| 新規 | `lib/flow-runner.js` | NODE_TYPES・createFlow（走査/分岐） |
| 新規 | `flow-player/index.html` `flow-player.js` | オーケストレータ（iframe + postMessage） |
| 新規 | `flow-editor/index.html` `flow-editor.js` | ノードグラフ編集 |
| 新規 | `public/flow/sample.flow.json` | サンプル（intro→battle→win/lose→end） |
| 変更 | `story-player/story-player.js` | `?flow=1` 自動再生＋終了通知 |
| 変更 | `swing-catch/swing-catch.js` | `?flow=1` 戦闘モード（HP/撃破/HUD/結果通知） |
| 変更 | `vite.config.ts` | flow 保存許可・/flow/manifest.json |
| 変更 | `hub/index.html` | Flow Player / Flow Editor リンク |

---

## 10. 定数（ハードコード回避）

| 定数 | 値 | 場所 |
|------|----|------|
| PLAYER_MAX_HP | 10 | swing-catch(FLOW) |
| HIT_DAMAGE / HIT_COOLDOWN | 1 / 1.0s | swing-catch(FLOW) |
| ATTACK_HIT_RANGE | 2.5m | swing-catch(FLOW) |
| DEFEAT_COOLDOWN | 0.5s | swing-catch(FLOW) |
| NODE_TYPES / WIN_TYPES / LOSE_TYPES | スキーマ | lib/flow-runner（+editor） |

---

## 11. エッジケース・後方互換

- 不正ノード/未接続ポート → フロー終了 or 警告継続（NFR-05）。
- story/battle ファイル欠如 → iframe 側で警告、可能なら即 result 返却（フロー停止回避）。
- swing-catch 非フロー起動 → HP/カウント/HUD/通知を一切作動させない（後方互換）。
- iframe origin 不一致の message は無視。
- 戦闘が決着しない場合に備え、HUD に「降参/敗北」操作（任意）→ フェーズ2で拡充。

---

## 12. 実装順序（tasks.md）

1. lib/flow-runner.js（＋Nodeでロジックテスト）
2. story-player フローモード
3. swing-catch フロー戦闘モード（HP/撃破/HUD/通知）
4. flow-player（オーケストレータ）＋ サンプル flow
5. flow-editor（グラフ編集・保存）
6. vite.config・hub リンク・実機/回帰検証
