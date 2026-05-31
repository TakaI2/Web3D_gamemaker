# VRM NPC キャラクターエディタ ＋ NPC ステートマシン 設計書

最終更新: 2026-05-31 / ステータス: 設計（実装未着手）

本書は調査結果（参照RPG-Game / 既存エディタ・ゲーム基盤 / swing-catch NPC 実装 / timeline・表情形式）を統合し、
「VRM NPC にキャラクター性とステートを与え、エディタで設定 → データ出力 → swing-catch 等で駆動する」仕組みを設計する。

---

## 1. 概要とゴール

### 1.1 目的
- NPC（現状 swing-catch の `megu` 系）に**キャラクター性**を持たせる。
- NPC に**ステート（状態）**を定義し、状態に応じて自律動作・timeline 再生・表情（ブレンドシェイプ）変更を行う。
- これらを**キャラクターエディタ**上で設定し、**データとして出力** → swing-catch / fps-cloth-vrm で読み込んで駆動する。

### 1.2 ゴール（成果物）
1. NPC ステートマシン仕様（状態・遷移トリガー・各状態の挙動）。
2. キャラクターデータ形式（既存 `fps-npc-bundle` v1 の拡張スキーマ）。
3. キャラクターエディタの設置方針と UI 構成。
4. ゲーム側の共有ランタイム（`lib/npc-state-machine`）設計。
5. 段階的実装計画。

### 1.3 現状の出発点（根拠）
- swing-catch の `megu` は **明示的な state フィールドを持たない**。挙動は `updateMegu()`（swing-catch.js L464）の
  `ragdoll.active / ragdoll.recovering / それ以外（飛行）` の 3 分岐で暗黙的に決まる。
- ラグドール制御は `vrm-ragdoll.js` の公開 API（`createRagdoll / setRagdollActive / updateRagdoll /
  updateRagdollRecovery / applyRagdollImpulse`）で完結している。
- 表情（`vrm.expressionManager`）は **swing-catch では未使用**（grep で参照ゼロ）。基盤（VRM の expressionManager）は存在。
- NPC バンドルは `public/npc/*.npc.json`、`format: "fps-npc-bundle", version: 1`、キーは
  `{ format, version, name, vrm, vrma, cloth, timeline }`。
- `timeline` は `{ version:2, fps:30, durationFrames, tracks:[{ kind:"grip", side, ranges:[{start,end}] }] }`。
  **現状 timeline は「手グリップ（grip）」のフレーム範囲のみ**。表情トラックは含まれない（表情は VRMA クリップ内に内包）。
- cloth-editor のエクスポート（cloth-editor.js L1410-1459）が bundle を生成。timeline は外部 JSON 添付方式。

---

## 2. NPC ステートマシン設計

### 2.1 状態一覧

ユーザー要望「通常 / 撃墜・ダウン（被弾・掴み） / 撃墜からの復帰 / 攻撃」を、swing-catch の既存挙動に対応づける。

| 状態 (state) | 意味 | 既存挙動との対応 |
|---|---|---|
| `idle` (通常/飛行) | 平常時の自律移動（飛行・壁反射）＋アニメ/timeline 再生 | `updateMegu` の else 分岐（L486-492） |
| `downed` (撃墜/ダウン) | 被弾または掴みでラグドール化、物理崩れ | `ragdoll.active === true`（L466-481）。被弾=`hitMegu`、本体掴み=`grabbed`、マント掴み=`clothGrabbed` |
| `recovering` (復帰) | ラグドール姿勢→アニメ姿勢へ smoothstep 補間 | `ragdoll.recovering === true`（L482-485） |
| `attack` (攻撃) | プレイヤー方向へ接近/威嚇する自律行動（新規） | **現状なし**（新規追加） |
| `alert` (警戒, 任意) | プレイヤー検知時の予備動作（attack への前段） | **現状なし**（任意） |

> 注: `downed` は被弾・本体掴み・マント掴みを内包する。これらは**サブステート**（`downedReason: 'hit' / 'bodyGrab' / 'clothGrab'`）として区別し、
> ピン/テザーの env 設定を切り替える（既存 L470-476 のロジックをそのまま流用）。

### 2.2 状態遷移図

```
                 (検知 sightRange内 & detectChance)
        idle ──────────────────────────────► alert ──(alertTimer満了)──► attack
         ▲ ▲                                    │                          │
         │ │                                    │(被弾/掴み)               │(attackTimer満了 / 見失い)
         │ │                                    ▼                          │
         │ └───────────(recover完了)──── recovering ◄──(recoverTimer<=0)── downed ◄──┘(被弾/掴み)
         │                                                                   ▲
         └──────────────(recover完了 & 攻撃性なし)──────────────────────────┘
            被弾/掴み はどの状態からでも downed へ割り込み可能（最優先）
```

### 2.3 遷移トリガー（RPG-Game の EnemyAI / NPCManager を参考）

| 遷移 | トリガー条件（根拠: RPG-Game の dist判定・time判定パターン） |
|---|---|
| `* → downed` | 被弾（`hitMegu`）または掴み（`grabMeguBody`/`grabMeguCloth`）。**最優先・割り込み**。`setRagdollActive(true)` |
| `downed → recovering` | 非保持（`!grabbed && !clothGrabbed`）かつ `recoverTimer <= 0` → `setRagdollActive(false)`（既存 L478-480） |
| `recovering → idle` | `ragdoll.recovering === false`（補間完了, `onMeguRecovered`）かつ攻撃性パラメータ無効 |
| `recovering → attack` | 補間完了かつキャラ定義 `behavior.aggressiveOnRecover === true`（要望「復帰からの攻撃」） |
| `idle → alert` | プレイヤーがカメラ/ターゲット距離 `sightRange` 内（RPG `dist < vision` 相当）＋確率 `detectChance` |
| `alert → attack` | `alertTimer` 満了（RPG の windupDuration 相当） |
| `attack → idle` | `attackTimer` 満了、またはターゲットを見失う（`dist > loseRange`） |

> 自律行動の有無・攻撃性は**完全にデータ駆動**（キャラ定義の `behavior`）。攻撃性 0 のキャラは `idle⇄downed⇄recovering` のみを循環し、
> 現状 swing-catch と完全に同一挙動になる（後方互換）。

### 2.4 各状態と「ラグドール / timeline / 表情」の対応

| 状態 | ラグドール | timeline フレーム供給 | 表情（expressionManager） |
|---|---|---|---|
| `idle` | inactive | アニメ有: `action.time*fps` / アニメ無: `tlClock` 加算（既存 L499-503） | `expressions.idle`（例 neutral） |
| `downed` | active（pin/tether を reason で切替） | **凍結**（既存: ラグドール中は `tlClock` 加算停止 L502） | `expressions.downed`（例 目閉じ blink=1, sad=0.5） |
| `recovering` | recovering（補間中） | アニメ再生再開 | `expressions.recovering`（補間 t に応じ angry を上げる等） |
| `attack` | inactive | アニメ再生（attack 用クリップがあれば差替え） | `expressions.attack`（例 angry=1） |
| `alert` | inactive | アニメ再生 | `expressions.alert`（例 surprised） |

表情適用は **状態 → 表情マップ** を毎フレーム `expressionManager.setValue(name, value)` で適用し、`vrm.update(dt)` で反映（既存 L494 の直前/直後）。
表情はオプション・キーが VRM に無ければ try-catch で無視（timeline 形式調査の指針）。

### 2.5 現状 swing-catch からの差分（実装インパクト）

| 項目 | 現状 | 変更後 |
|---|---|---|
| state 表現 | 暗黙（3 分岐） | `m.state` 明示フィールド ＋ `stateTimer` / `target` / `downedReason` 追加（`createMegu` L356-363 の戻り値拡張） |
| `updateMegu` | ragdoll.active/recovering/else の 3 分岐 | 先頭で「状態遷移判定」、その後 `switch(m.state)` で各 `updateMeguXxx(m,dt)` へ委譲（L464 を置換） |
| `hitMegu` | `setRagdollActive(true)` | 加えて `m.state='downed'; m.downedReason='hit'`（L401-407） |
| 掴み | `grabbed/clothGrabbed` | 加えて `m.state='downed'; m.downedReason='bodyGrab'/'clothGrab'` |
| `onMeguRecovered` | 速度リセットのみ | 加えて `behavior.aggressiveOnRecover` なら `state='attack'`、それ以外は `state='idle'`（L454-456） |
| 表情 | 未使用 | 各状態で `applyExpression(m, state)` を呼ぶ（新規） |
| 攻撃行動 | なし | `updateMeguAttack`（ターゲット方向加速 ＋ attack 表情/アニメ）新規 |
| cloth grip | frame 駆動 | **変更なし**（既存 L495-506 のまま動作） |

> 既存ラグドール API・cloth API は**そのまま再利用**し、変更は「state 層の追加」と「表情層の追加」に限定する。これがリスク最小の差し込み方針。

---

## 3. キャラクターデータ形式

### 3.1 方針: 既存 `fps-npc-bundle` を v2 へ拡張（新形式は作らない）— 推奨

**推奨理由**:
- 既存ローダ（swing-catch `fetchBundle`/`createMegu`、fps-cloth-vrm の一括読込）が `format:"fps-npc-bundle"` を前提に動いており、
  VRM/VRMA/cloth/timeline の梱包・base64 デコード経路が確立済み。新形式は二重メンテになる。
- 追加するのは `character`（ステート・表情・行動）という**1 ブロックのみ**で、既存キーには触れない。
  `version` を 2 に上げ、ローダは `character` 不在時に従来挙動（後方互換）。
- cloth-editor のエクスポータ（L1410-1459）に 1 フィールド追記するだけで出力可能。

代替案（新規 `*.character.json`）は VRM バイナリ（数十 MB）と分離できる利点があるが、配布・読込経路が増え、当面の単一バンドル運用に合わない。**却下**。

### 3.2 拡張スキーマ（`character` ブロック）

```jsonc
{
  "format": "fps-npc-bundle",
  "version": 2,                         // 1 → 2 へ。character 無しは従来扱い
  "name": "megu",
  "vrm":  "data:...",                   // 既存（変更なし）
  "vrma": "data:...",                   // 既存：idle 用デフォルトクリップ
  "cloth": { /* 既存 */ },
  "timeline": {                         // 既存：grip トラック（v2 形式）
    "version": 2, "fps": 30, "durationFrames": 354,
    "tracks": [ { "kind": "grip", "side": "left", "ranges": [ { "start": 59, "end": 350 } ] } ]
  },

  "character": {                        // ★ 追加ブロック
    "schemaVersion": 1,
    "displayName": "メグ",
    "behavior": {                       // 行動パラメータ（RPG-Game stats を参考）
      "aggressiveOnRecover": true,      // 復帰後に attack へ遷移するか
      "sightRange": 8.0,                // alert へ入る距離(m)
      "loseRange": 14.0,                // attack を抜ける距離(m)
      "detectChance": 0.6,              // idle→alert 確率(0-1)
      "moveSpeed": 4.0,                 // idle 飛行速度(m/s)
      "approachAccel": 5.0,             // attack 接近加速度(m/s^2)
      "recoverDelaySec": 2.5            // downed→recovering までの遅延（既存 MEGU_RECOVER_DELAY のキャラ別上書き）
    },
    "defaultState": "idle",
    "states": {
      "idle": {
        "animation": { "source": "bundle", "loop": true },   // bundle 内 vrma を使用
        "timelineClip": null,                                 // 専用 timeline 区間を使う場合に指定（後述）
        "expression": { "neutral": 1.0 },                     // expressionName → weight (0-1)
        "transitions": [
          { "to": "alert", "trigger": "playerInSight" }
        ]
      },
      "alert": {
        "animation": { "source": "bundle", "loop": true },
        "expression": { "surprised": 0.8 },
        "durationSec": 0.6,
        "transitions": [ { "to": "attack", "trigger": "timeout" } ]
      },
      "attack": {
        "animation": { "source": "url", "url": "data:...vrma...", "loop": true }, // 任意：攻撃専用クリップ
        "expression": { "angry": 1.0 },
        "durationSec": 3.0,
        "transitions": [
          { "to": "idle", "trigger": "timeout" },
          { "to": "idle", "trigger": "targetLost" }
        ]
      },
      "downed": {
        "animation": null,              // ラグドール制御（アニメ停止）
        "expression": { "blink": 1.0, "sad": 0.4 },
        "transitions": [ { "to": "recovering", "trigger": "recoverTimerElapsed" } ]
      },
      "recovering": {
        "animation": { "source": "bundle", "loop": true },
        "expressionTimeline": [         // 補間 t(0-1) に沿った表情遷移（任意）
          { "t": 0.0, "expression": { "angry": 0.5 } },
          { "t": 1.0, "expression": { "angry": 0.0 } }
        ],
        "transitions": [
          { "to": "attack", "trigger": "recoverComplete", "condition": "aggressiveOnRecover" },
          { "to": "idle",   "trigger": "recoverComplete" }
        ]
      }
    }
  }
}
```

### 3.3 設計上の決定

- **状態ごとの「アニメ供給」3 方式**:
  1. `source:"bundle"` … 同梱 `vrma`（既存ロード経路をそのまま使用）。
  2. `source:"url"` … 状態専用 VRMA（攻撃モーション等）。複数クリップは `AnimationMixer.clipAction()` を状態数ぶん生成（timeline 調査の指針）。
  3. `timelineClip:{startFrame,endFrame}` … 1 本のアニメ内のフレーム区間を `mixer.setTime(sec)` でループ（区間再生）。
- **表情**は `expressionName → weight` の単純マップ。`recovering` 等の遷移演出が要るものだけ `expressionTimeline`（t は補間進捗 `ragdoll.recoverT`）。
- **grip timeline は据え置き**（既存 `timeline.tracks` の grip）。将来「表情トラック」を timeline に統合する案もあるが、
  現状は VRMA 内包＋本スキーマの expression で足り、混乱を避けるため**分離維持**。
- `downedReason`（hit/bodyGrab/clothGrab）はランタイムが付与する内部状態であり、データには持たせない（既存の grabbed/clothGrabbed から決定）。

---

## 4. キャラクターエディタ

### 4.1 設置方針の比較と推奨

| 案 | 内容 | 評価 |
|---|---|---|
| A. cloth-editor 流スタンドアロン（`character-editor/` ＋ build スクリプト） | swing-catch/cloth-edit+VRM ランタイム（Three.js + three-vrm + vrm-ragdoll.js + vrm-cloth.js）を**直接 import** できる | **推奨**。状態プレビューに実ランタイム（ラグドール・grip・表情）をそのまま使え、ゲームとの挙動乖離が出ない |
| B. 既存 Svelte アプリにモード追加（`appModeStore` に `'character-editor'`） | AnimEditor/StageEditor の UI 部品・ストアを再利用 | UI 部品は強力だが、Svelte アプリは three-vrm 系の TS 経路、ランタイムは素の JS（swing-catch 系）で**実装系統が分断**。プレビューの挙動再現にラグドール/cloth を移植する手間が大 |
| C. 完全新規 | — | 既存資産を捨てるため非推奨 |

**推奨: 案 A（スタンドアロン）**。理由は「状態プレビューは実ランタイム（vrm-ragdoll.js / vrm-cloth.js）で動かすのが最も確実」かつ、
出力先が swing-catch/fps-cloth-vrm（いずれも素 JS バンドル系）であり、実装系統が揃うため。
UI レイアウトは cloth-editor（左パネル 210px ＋ 中央 Canvas ＋ 右パネル 200px）を踏襲。
ビルドは既存 `scripts/build-fps-cloth-vrm.mjs` 等と同パターンで `scripts/build-character-editor.mjs` を追加。

> 補足: AnimEditor のタイムライン/表情編集 UI（Svelte/TS）は将来の表情キーフレーム作成に有用だが、本エディタの主目的は
> 「状態への割り当て」であり、表情はフレーム列ではなく**状態あたりの固定 weight マップ**が中心。よって Svelte 統合は必須ではない。

### 4.2 UI 構成（案 A）

```
┌──────────┬────────────────────────────┬──────────────┐
│ 左:状態リスト │        中央: 3D プレビュー        │ 右:状態プロパティ │
│           │ (VRM + cloth + ragdoll 実行)   │               │
│ ○ idle    │                              │ ▼ アニメ        │
│ ○ alert   │  [プレビュー再生] [状態強制]    │  source:bundle │
│ ● attack  │  ▶ idle / downed / recover…   │  loop ☑        │
│ ○ downed  │                              │ ▼ 表情          │
│ ○ recover │  [被弾シミュ] [掴みシミュ]      │  neutral [1.0] │
│ + 状態追加 │                              │  angry   [___] │
│           │  グリップ/cloth はそのまま表示    │ ▼ 行動          │
│           │                              │  sightRange    │
│ behavior  │                              │  moveSpeed …   │
│ 設定       │                              │ ▼ 遷移          │
│           │                              │  +to/trigger   │
├──────────┴────────────────────────────┴──────────────┤
│ [VRM/VRMA/cloth 読込]  [character 編集]  [.npc.json v2 書き出し] │
└────────────────────────────────────────────────────────┘
```

- **状態リスト**: 状態の追加/削除/選択。選択状態をプレビューに反映。
- **プレビュー**: 実ランタイムで選択状態を再生。「被弾シミュ」「掴みシミュ」ボタンで `hitMegu/grabMeguBody/grabMeguCloth` 相当を発火し、
  downed→recovering→(idle/attack) の遷移を目視確認。
- **状態プロパティ（右）**: アニメ供給方式、表情 weight スライダー（VRM の expression 一覧を `expressionManager` から列挙）、遷移リスト編集。
- **behavior 設定**: sightRange / moveSpeed / aggressiveOnRecover 等（StageEditor のプロパティパネル流の数値入力 ×N）。
- **エクスポート**: 既存 cloth-editor のバンドル書き出し（L1410-1459）に `character` ブロックを差し込み、`version:2` で出力。

### 4.3 再利用できる既存部品（根拠つき）

| 部品 | 場所 | 用途 |
|---|---|---|
| バンドル読込/書き出し | `cloth-editor/cloth-editor.js` L1410-1459, `fetchBundle`/`dataURIToBlob`（swing-catch L322-324） | VRM/VRMA/cloth/timeline の入出力経路 |
| ラグドール API | `vrm-ragdoll.js`（create/set/update/recovery/impulse） | downed/recovering プレビュー |
| cloth ＋ grip | `vrm-cloth.js`（`createVRMCloth`, `cloth.update(dt,frame)`） | マント・手グリップ表示（frame 駆動） |
| 表情 | `vrm.expressionManager.setValue/update` | 表情プレビュー・列挙 |
| 3 ペインレイアウト | `cloth-editor/index.html`（210/Canvas/200） | UI 骨格 |
| プロパティパネル様式 | `src/stage-editor/StageEditorPropsPanel.svelte`（Vector3 数値入力） | 参考（案 A では HTML で再現） |
| ビルドスクリプト | `scripts/build-fps-cloth-vrm.mjs` | `build-character-editor.mjs` の雛形 |

---

## 5. ゲーム側統合

### 5.1 共有モジュール `lib/npc-state-machine`（フレームワーク非依存の素 JS）

swing-catch と fps-cloth-vrm の双方から import できる、Three.js 非依存に近いステート駆動コアを切り出す。

```js
// lib/npc-state-machine.js  （データと毎フレーム入力を受け、状態と適用すべき効果を返す）
export function createNpcStateMachine(characterDef) {
  // 戻り値: { state, downedReason, target,
  //          transition(event), update(dt, ctx) => { state, expression, animationDirective } }
}
```

- **入出力契約**:
  - 入力 `ctx`: `{ ragdollActive, ragdollRecovering, recoverT, distanceToPlayer, held, recoverTimer }`
  - 出力: 次状態、適用すべき `expression`（name→weight）、`animationDirective`（再生/差替/区間）。
- **副作用は持たない**。ラグドールの `setRagdollActive`、`expressionManager.setValue`、`mixer` 操作は**呼び出し側（ゲーム）**が行う。
  これにより swing-catch（素 JS）と fps-cloth-vrm（素 JS）の双方で同一コアを共有でき、Svelte/TS 側にも将来移植しやすい。

### 5.2 swing-catch への組み込み（最小差分）

1. `createMegu`（L356）戻り値に `stateMachine`（5.1）、`state`、`target` を追加。`character` 不在なら従来オブジェクトのまま。
2. `updateMegu`（L464）冒頭で `ctx` を構築 → `sm.update(dt, ctx)` → 戻りの効果を適用:
   - 状態に応じ既存 3 分岐の処理を呼ぶ（`downed`=ラグドール / `recovering`=補間 / `idle`=飛行 / `attack`=接近 ＋ 新規）。
   - `expression` を `m.vrm.expressionManager.setValue(...)` で適用（VRM に無いキーは無視）。
   - `animationDirective` に応じ `mixer`/`action` を制御。
3. `hitMegu`/`grab*`/`releaseMegu`/`onMeguRecovered` は `sm.transition('hit'|'grab'|'release'|'recoverComplete')` を呼ぶだけに薄くする。
4. cloth grip（L495-506）は無改変。

### 5.3 fps-cloth-vrm での再利用
同コア `lib/npc-state-machine.js` を import し、各 VRM NPC に同様に適用。
fps-cloth-vrm は既に `importTimeline` で grip を解釈しているため、`character` ブロックの解釈を足すだけで状態駆動が乗る。

---

## 6. 段階的実装計画

### フェーズ 0: 準備（スキーマ確定）
- `character` v2 スキーマ確定（本書 3.2）。`version:2` ローダの後方互換分岐を決める。

### フェーズ 1: 最小動作（MVP）★最初に動かす
**目標: 状態機械 ＋ 既存ラグドール接続 ＋ 1 表情、を swing-catch で動かす。**
- `lib/npc-state-machine.js` の最小版（`idle / downed / recovering` のみ、attack/alert なし）。
- swing-catch の `updateMegu` を state 委譲へ置換（既存挙動を完全再現すること）。
- `downed` で 1 表情（例 `blink=1` 目閉じ）を適用、`idle` で解除。
- 受け入れ基準: 被弾→倒れ（目閉じ）→復帰→飛行 が従来同等に動き、被弾時のみ表情が変わる。

### フェーズ 2: データ駆動化
- `character` ブロックを読み、状態→表情マップ・behavior をデータから適用。
- `character` 無しバンドルは従来挙動（後方互換）を確認。

### フェーズ 3: attack / alert と自律行動
- `idle→alert→attack→idle` 遷移、`updateMeguAttack`（ターゲット接近）、`aggressiveOnRecover`。
- 攻撃専用 VRMA（`source:"url"`）の差替再生。

### フェーズ 4: キャラクターエディタ（案 A）
- `character-editor/` スタンドアロン作成、3 ペイン UI、実ランタイムプレビュー、`.npc.json v2` 書き出し。
- `scripts/build-character-editor.mjs` 追加。

### フェーズ 5: fps-cloth-vrm への展開・調整
- 共有コアを fps-cloth-vrm にも適用、複数 NPC でのパフォーマンス確認。

---

## 7. リスク・割り切り・ユーザーへの確認事項

### 7.1 リスクと割り切り
- **表情キー名の不確定**: VRM ごとに preset/custom 名が異なる。`expressionManager` から実際の名前を列挙し、無いキーは無視（try-catch）。
  エディタはスライダーを「読み込んだ VRM が持つ式」だけ表示する。
- **複数 VRMA クリップの管理**: 状態別アニメは `clipAction()` を状態数ぶん作る方式（負荷とメモリ増）。MVP では `idle` 1 本のみとし段階導入。
- **timeline と表情の二系統**: grip は `timeline.tracks`、表情は `character.states[].expression`。本書では**意図的に分離**（混乱・移行コスト回避）。将来統合は別途検討。
- **実装系統の二重化**: swing-catch/fps-cloth-vrm は素 JS、Svelte アプリは TS。共有コアを素 JS にすることで当面回避するが、Svelte 側エディタ案（案 B）は採らない。
- **パフォーマンス**: 多数 NPC で毎フレーム expression 適用・距離計算が増える。state 評価は軽量に保ち、cloth refresh のラウンドロビン（既存 L511-516）と同様の間引きを検討。

### 7.2 ユーザーへの確認事項（曖昧点）
1. **エディタ設置**: 案 A（cloth-editor 流スタンドアロン）で進めてよいか？ それとも既存 Svelte アプリのモード追加（案 B）を希望するか？
2. **データ形式**: 既存 `.npc.json` を v2 拡張（推奨）でよいか？ 別ファイル（`*.character.json`）に分離したいか？
3. **攻撃の中身**: 「攻撃」は「プレイヤーへ接近する自律移動＋威嚇表情」までで足りるか？ それとも**弾を撃つ等の攻撃アクション**（RPG-Game の attacks[] / 弾幕相当）まで必要か？
4. **プレイヤー検知の対象**: swing-catch は一人称カメラ。ターゲットは「カメラ位置」でよいか？（マルチ NPC で誰を狙うか等の指定は不要か）
5. **状態セット**: `idle/alert/attack/downed/recovering` の 5 状態で十分か？ 追加状態（例: 死亡/退場、特殊勝利演出）は要るか？
6. **表情の粒度**: 状態あたり固定 weight（本書方針）で足りるか？ 状態内で表情を時間変化させたい場面（recovering 以外）はあるか？
7. **grip timeline の扱い**: 当面 grip と表情を分離維持でよいか？（将来 timeline へ統合したい意向があれば設計を寄せる）

---

## 8. 決定事項（ユーザー確認済み 2026-05-31）

1. **エディタ設置**: スタンドアロン（案A）。加えて **「エディタ一覧（ハブ）ページ」** を新設し、各エディタ（cloth / cloth-editor / character-editor 等）とゲーム本編（swing-catch / fps-cloth-vrm 等）へ遷移できるようにする（参照 RPG-Game のランチャー方式）。
2. **データ形式**: `.npc.json` v2 拡張（`character` ブロック追加）。エディタのプレビューは **マント（cloth）を付けた状態**でキャラを表示する。
3. **攻撃**: 「プレイヤーへ接近＋威嚇表情」まで（弾発射等のアクションは当面不要）。
4. **状態数**: `idle / alert / attack / downed / recovering` の5状態でOK。

### 8.1 追加機能: 視線・顔のプレイヤー追従（lookAt）

特定ステート中に NPC の **視線（目）／顔（頭）をプレイヤー（カメラ）へ向ける**。状態ごとに設定可能。

- **視線（目）**: `vrm.lookAt.target = camera` を設定し `vrm.update(dt)` で目がカメラを追従（three-vrm 標準 VRMLookAt）。
- **顔（頭）**: 任意で head/neck ボーンをカメラ方向へ向ける（重み・最大角でクランプ、アニメ/ラグドールと両立）。MVP は視線（目）から。
- **データ**: 各 state に `lookAt: { eye: 0-1, head: 0-1 }`（または簡易 `lookAt: true/false`）を追加。`downed` は通常 OFF。
- **エディタ**: 状態プロパティに「視線追従（目／顔）」のトグル＋強さスライダーを追加。

### 8.2 実装順（改訂）

- **フェーズ1（今回着手）**: `lib/npc-state-machine.js`（素JS共有コア）＋ swing-catch を明示ステート化。既存挙動を完全再現したうえで、**視線追従（目）＋ downed 表情**を追加。攻撃/検知はデフォルト無効（`sightRange:0`）で後方互換。
- フェーズ2: `character` ブロックのデータ駆動化（表情・lookAt・behavior をデータから）。
- フェーズ3: attack/alert と自律接近、`aggressiveOnRecover`。
- フェーズ4: character-editor（スタンドアロン, マント付きプレビュー）＋ **エディタ一覧ハブページ** ＋ build スクリプト。
- フェーズ5: fps-cloth-vrm 展開・調整。
