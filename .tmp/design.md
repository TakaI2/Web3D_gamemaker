# 設計書 - NPC セリフ（ダイアログ）システム

要件: `.tmp/requirements.md`
対象: Character Editor（編集UI）＋ swing-catch（再生）＋ 共通 lib

---

## 1. 全体アーキテクチャ

```
                    ┌─────────────────────────────┐
  Character Editor  │ states[state].speech / events │  ← 編集・保存
  （UI 追加）        └───────────────┬─────────────┘
                                    │  *.npc.json（後方互換拡張）
                                    ▼
  swing-catch  ──┬─ createNpcStateMachine(character)  （既存・据置）
                 │
                 ├─ createNpcSpeech(vrm, character)    ← lib/npc-speech.js（新規）
                 │     ├─ createLipSync(vrm)           ← lib/lip-sync.js（新規）
                 │     └─ 行巡回・bark割り込み・CD管理
                 │
                 └─ createSpeechUI({ camera, dom })    ← lib/speech-ui.js（新規）
                       ├─ 下部ウィンドウ（キュー）
                       └─ 頭上吹き出し（投影追従）
```

責務分離：
- **state-machine**: ステート決定のみ（既存契約を一切変えない）。
- **npc-speech**: 「いま何をしゃべるか」を決め、口パク＋行表情を VRM に書く。表示テキストは UI へ通知。
- **lip-sync**: テキスト→viseme→`expressionManager` への適用（口チャンネルのみ）。
- **speech-ui**: DOM 表示（下部ウィンドウ・頭上吹き出し）。3D描画とは独立。

副作用の境界: state-machine は副作用なし（既存方針）。npc-speech と lip-sync は VRM 表情へ書き込む副作用を持つ（明示）。

---

## 2. データモデル（*.npc.json の character 拡張）

`character.states[state].speech`（任意）と `character.events`（任意）を追加。**いずれも欠如時は従来通り無発話**。

```jsonc
{
  "character": {
    "schemaVersion": 1,                      // 据置（speech 追加は後方互換のため version は上げない）
    "states": {
      "attack": {
        "expression": { "angry": 0.8 },       // 既存
        "lookAtEye": 1.0, "lookAtHead": 0.8,  // 既存
        "speech": {
          "mode": "loop",                     // "once" | "loop"（既定 "once"）
          "intervalMs": 1500,                 // loop 時の行間インターバル（既定 1500）
          "charsPerSecond": 8,                // 省略時 DEFAULT_CPS
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

行（line）の正規化:
- `string` → `{ text, expression: null, weight: 1, holdMs: 0 }`
- `object` → `text` 必須、`expression`/`weight`/`holdMs` は任意。
- `holdMs`: 文字送り完了後にこの行を保持する追加時間（既定 0、once 用の余韻）。

---

## 3. lib/lip-sync.js（新規）

`/src/lipsync/*.ts` を素JSへ移植（store依存を除去、dt駆動に変更）。

```js
// VISEME_MAP（JP かな/カナ→aa/ih/ou/ee/oh/neutral）と EN_VOWEL_MAP を内蔵（visemeMaps.ts を移植）
// isJapanese(ch), charToViseme(ch) を内蔵

export function createLipSync(vrm) {
  const VISEMES = ['aa','ih','ou','ee','oh'];
  let chars = [], idx = 0, acc = 0, interval = 1000/8, playing = false, target = 'neutral';

  return {
    get playing() { return playing; },
    play(text, cps = 8) { chars = [...(text||'')]; idx = 0; acc = 0; interval = 1000/Math.max(1,cps); playing = !!chars.length; target = 'neutral'; },
    stop() { playing = false; target = 'neutral'; },              // update 側で 0 へ LERP
    // dt 駆動：文字送り（acc 加算）＋ viseme LERP。ゲームループから毎フレーム。
    update(dtMs) {
      if (playing) {
        acc += dtMs;
        while (acc >= interval && idx < chars.length) { target = charToViseme(chars[idx++]); acc -= interval; }
        if (idx >= chars.length) playing = false;                 // 送り完了（口は閉じへ）
      }
      const em = vrm.expressionManager; if (!em) return;
      const k = 0.3;
      for (const v of VISEMES) {
        const t = (playing && v === target) ? 1 : 0;
        const cur = em.getValue(v) ?? 0;
        try { em.setValue(v, cur + (t - cur) * k); } catch {}     // viseme 未定義 VRM は無視
      }
    },
  };
}
```

設計判断:
- 原実装は `setInterval`。ゲームループ統合のため **dt 駆動**へ変更（一時停止・フレーム整合・タイマードリフト回避）。
- store（svelte）依存は持たない。表示テキスト送りは speech-ui 側で別管理。
- viseme が無い VRM では口パクをスキップ（`try/catch`）し、表情のみ機能（FR-03 の前提）。

---

## 4. lib/npc-speech.js（新規）

NPC 1体ごとに生成。ステート発話の巡回、bark 割り込み、行表情の適用を担う。

```js
import { createLipSync } from './lip-sync.js';

const DEFAULT_CPS = 8;
const BARK_COOLDOWN_MS = 1500;

export function createNpcSpeech(vrm, characterDef, hooks = {}) {
  // hooks.onLineStart(speaker, text, cps)  → 下部ウィンドウ＆吹き出しへ
  // hooks.onLineEnd()                      → UI フェード合図（任意）
  const lip = createLipSync(vrm);
  // 内部状態: source('state'|'event'|null), curState, queue[], lineIdx, mode, intervalMs, cps,
  //           waitMs（loop インターバル/holdMs 計測）, activeExprName/Weight, lastBarkAt{event->ms}, clockMs

  return {
    onState(state) { /* speech が無ければ stop。あれば queue 構築し source='state' で開始 */ },
    bark(event) { /* CD 判定→ events[event].lines から1行選び source='event' で割り込み開始 */ },
    update(dt) { /* lip.update + 行送り完了/holdMs/loop 判定 + 行表情適用 */ },
    get speaking() { /* ... */ },
    stop() { lip.stop(); /* 行表情リセット */ },
  };
}
```

### 4.1 発話開始ロジック
- `onState(state)`:
  - 同じ state への再通知は無視（連続発話防止）。
  - `states[state].speech` が無ければ `stop()`。`downed` は既定で `stop()`（FR-06-5）。
  - あれば `lines` を正規化して queue 化、`mode`/`intervalMs`/`cps` を設定し、先頭行から `startLine(0)`。
- `bark(event)`:
  - `now - lastBarkAt[event] < BARK_COOLDOWN_MS` ならスキップ（FR-07-5）。
  - `events[event].lines` から1行（複数あればランダム）を選び、**現在の発話に割り込み**（source='event'）。bark は1行で終了し、終わったら直近の state 発話を `onState` 経由で再開（記憶した curState で再構築、loop のみ）。

### 4.2 startLine(i) / update(dt)
- `startLine(i)`: `lip.play(text, cps)`、`activeExprName/Weight` を行 expression に設定、`hooks.onLineStart(displayName, text, cps)`。
- `update(dt)`:
  1. `clockMs += dt*1000`、`lip.update(dt*1000)`。
  2. 行表情適用: `activeExprName` があれば `em.setValue(activeExprName, weight)`。**state 表情適用の後**に呼ばれる前提（§5）。
  3. 行送り完了（`!lip.playing`）かつ `holdMs` 経過 → 次の行へ。
     - source='event': 終了 → state 発話へ復帰（loop時）/ idle。
     - source='state' once: 全行終了で停止（行表情を0へ戻す）。
     - source='state' loop: `intervalMs` 待機後、次の行（末尾なら先頭へ循環）。
  4. 行終了時 `activeExprName` を 0 へ戻す（state ループが次フレームで state 値を復元）。

設計判断（行表情と state 表情の衝突回避）:
- viseme（口）と行表情（happy 等）は別チャンネル。
- 行表情名が state 表情名と重なる場合、毎フレーム「state 適用→speech 上書き」の順で上書きされ、行終了時に speech が 0 を書き、その次フレームで state ループが state 値へ戻す。よって破綻しない。
- 行表情名が state に無い名前のときも、speech が行終了時に明示的に 0 を書くため戻る。

---

## 5. swing-catch への統合

### 5.1 megu オブジェクト拡張（createMegu, :469-482）
- 追加: `speech: createNpcSpeech(vrm, bundle.character, { onLineStart, onLineEnd })`
- 追加: `prevState: null`（ステート変化検知用）、`prevCenterY`/`prevVy`（landed 速度推定用）。

### 5.2 ステート変化検知（updateMegu, :694 直後）
```js
const cur = m.dir ? m.dir.state : null;
if (cur && cur !== m.prevState) { m.speech.onState(cur); m.prevState = cur; }
```

### 5.3 表情適用順（updateMegu, :749-765 の直後 / vrm.update :766 の前）
state 表情・まばたきを設定した**後**に speech を適用（viseme/行表情が最後に勝つ）:
```js
if (m.speech) m.speech.update(dt);
```
- `m.sm.expressionNames` の reset ループは既存のまま。viseme と行表情は speech が管理。

### 5.4 イベント bark フック
| イベント | 発火箇所 | 条件 |
|----------|----------|------|
| grabbed | `grabMeguBody`(:551) / `grabMeguCloth`(:558) 末尾 | `m.speech.bark('grabbed')` |
| thrown  | `releaseMegu`(:566) 末尾 | `m.speech.bark('thrown')` |
| landed  | `updateMegu` 内 ragdoll 中の落下衝突検出 | 下記ヒューリスティック |

landed 検出（ヒューリスティック・新規）:
- `meguCenter(m, c)` で中心を取得し、`vy = (c.y - m.prevCenterY)/dt` を毎フレーム算出。
- 直前まで下降（`prevVy < -LANDED_SPEED_THRESHOLD`）かつ 今フレームで床近傍（`c.y <= floorY + LANDED_MARGIN`）または速度急減（反発）→ `bark('landed')`。
- 定数: `LANDED_SPEED_THRESHOLD = 4.0`(m/s), `LANDED_MARGIN = 0.5`(m)。bark 側 CD と二重で多重発火を抑制（FR-07-6）。
- ragdoll 非アクティブ（飛行 idle）時は landed 判定しない。

### 5.5 UI 生成と更新（init / animate）
- `init()` 末尾で `speechUI = createSpeechUI({ camera, dom: document.body, getWorldCenter })`。
- 毎フレーム `speechUI.update(dt, megus)`：
  - 下部ウィンドウのタイピング送り・フェードを進める。
  - 各 NPC の頭上吹き出しを `meguCenter` のワールド座標→画面投影で追従更新。

`onLineStart(speaker, text, cps)` の中身（swing-catch 側で配線）:
```js
speechUI.showBottom(speaker, text, cps);   // 下部ウィンドウ（キュー）
speechUI.setBubble(m, text);                // 頭上吹き出し（短文）
```

---

## 6. lib/speech-ui.js（新規・DOM オーバーレイ）

```js
export function createSpeechUI({ camera, dom = document.body, getWorldCenter }) {
  // 下部ウィンドウ要素（1個・キュー）と、吹き出しプール（NPC ごと）を生成。CSS は動的注入。
  return {
    showBottom(speaker, text, cps) { /* キューに積む。表示中なら次へ */ },
    setBubble(npc, text) { /* npc に短文吹き出しを表示 */ },
    clearBubble(npc) { /* フェードアウト */ },
    update(dt, npcs) {
      // 下部: 現在行のタイピング送り（cps と整合）→ 完了後 holdMs→ フェード→ キュー次へ。
      // 吹き出し: 各 npc の getWorldCenter(npc) を camera で投影し、画面内なら配置、画面外/背面は隠す。
    },
  };
}
```

### 6.1 下部ウィンドウ（FR-04）
- 構造: `<div class="sc-dialog"><span class="name"></span><span class="msg"></span></div>`、画面下中央固定、半透明背景。
- キュー: `showBottom` で `{speaker,text,cps}` を push。空き時に次を pop して表示。
- タイピング: `cps`（文字/秒）で1文字ずつ表示。完了後 `BOTTOM_HOLD_MS`（既定 1200ms）保持→フェードアウト。
- 複数NPC同時発話は1ウィンドウを共有し順番表示（FR-04-3）。

### 6.2 頭上吹き出し（FR-05）
- NPC ごとに `<div class="sc-bubble">` を1つ用意（Map<npc, el> プール）。
- `update` で `getWorldCenter(npc)`（= meguCenter + 頭上オフセット）を取得し、
  `v.project(camera)` で NDC→ピクセル変換。`v.z < 1` かつ画面内なら表示、背面/画面外は `display:none`。
- 距離フェード: カメラから遠い（既定 > 25m）は薄く/非表示。
- 表示時間: bark/行に同期し、`clearBubble` でフェード（参考 EnemySpeech の displayMs+フェード）。

---

## 7. Character Editor 統合（編集UI）

### 7.1 defaultCharacter()（:36-51）
`states` 各値はそのまま（speech は付けない＝既定無発話）。`events: {}` を追加。

### 7.2 mergeCharacter()（:151-157）
- 各 state に `c.states[s].speech` があれば引き継ぐ（読込時はそのまま保持）。
- `out.events = c.events || {}` を追加（後方互換）。

### 7.3 セリフ編集パネル（新規 `buildSpeechPanel()`）
- `selectState()`（:257）から `buildExprPanel/buildLookPanel` に続けて `buildSpeechPanel()` を呼ぶ。
- 対象ステートの `speech` を編集（無ければ「セリフを追加」ボタンで生成）:
  - mode（once/loop セレクト）、intervalMs（loop時のみ表示）、charsPerSecond。
  - 行リスト: テキスト入力＋ 表情セレクト（空=ステート表情 / neutral/happy/angry/sad/relaxed/surprised）＋ weight スライダ ＋ ✕削除。＋「行追加」。
- 別途「イベントセリフ」セクション（ステート非依存・常設）: grabbed/thrown/landed の3グループで同様の行リスト編集。
  - 配置: 右パネル下部の常設セクションとする。

### 7.4 試聴（FR-02-6）
- `buildSpeechPanel` の各行に「▶試聴」。クリックで editor の `vrm` に対し一時的な `createLipSync` を `play(text, cps)`、行表情も適用。
- editor の `update(dt)`（:208）に試聴用 lip-sync の `update` を1つ差し込む（単一プレビューVRMなので1インスタンスで足りる）。

### 7.5 保存（exportBundle, :340-364）
- 既存フローのまま（`out.character = characterDef`）。speech/events は characterDef に含まれるため自動保存。
- 空の speech/events は保存前に間引く（クリーンアップ）。

---

## 8. 定数一覧（ハードコード回避）

| 定数 | 値 | 場所 |
|------|----|------|
| DEFAULT_CPS | 8 | lib/npc-speech.js |
| BARK_COOLDOWN_MS | 1500 | lib/npc-speech.js |
| LIPSYNC_LERP | 0.3 | lib/lip-sync.js |
| BOTTOM_HOLD_MS | 1200 | lib/speech-ui.js |
| BUBBLE_MAX_DIST | 25 (m) | lib/speech-ui.js |
| LANDED_SPEED_THRESHOLD | 4.0 (m/s) | swing-catch.js |
| LANDED_MARGIN | 0.5 (m) | swing-catch.js |

---

## 9. 後方互換・エッジケース

- speech/events 欠如の既存 `*.npc.json` → 無発話（onState で stop のみ）。
- viseme 表情を持たない VRM → 口パク無効、行表情・UI は機能。
- downed 中はステート発話抑制。ただし bark（grabbed/thrown/landed）は許可（被弾リアクションを出すため）。
- 複数 NPC 同時発話 → 下部ウィンドウはキュー、頭上吹き出しは各自並行。
- ステート切替で発話中断 → `onState` が現発話を停止し新ステートへ。
- bark 割り込み後の復帰 → loop ステートのみ再開、once は再開しない。

---

## 10. 新規/変更ファイル一覧

| 種別 | パス | 内容 |
|------|------|------|
| 新規 | `lib/lip-sync.js` | viseme 口パクコア（dt駆動・素JS） |
| 新規 | `lib/npc-speech.js` | セリフ巡回・bark・行表情 |
| 新規 | `lib/speech-ui.js` | 下部ウィンドウ＋頭上吹き出し（DOM） |
| 変更 | `swing-catch/swing-catch.js` | speech 統合・bark フック・UI 更新・landed 検出 |
| 変更 | `character-editor/character-editor.js` | セリフ編集パネル・試聴・default/merge 拡張 |
| 変更 | `character-editor/index.html` | セリフ編集セクションの DOM 追加 |
| （任意）| `fps-cloth-vrm/*` | 後続展開（今回対象外） |
