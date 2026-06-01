# テスト設計書 - NPC セリフ（ダイアログ）システム

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md`

## 1. テスト方針

- このプロジェクトは自動テスト基盤（jest 等）が整備されていない素JS構成のため、**手動シナリオ検証**を主とする。
- 純粋ロジック（lip-sync の viseme 変換、行正規化、bark クールダウン、loop タイミング）は副作用が無いため、必要に応じてブラウザ Console で関数を直接呼ぶ簡易確認を行う。
- VRM 表情・UI・投影は実機（swing-catch / Character Editor）での目視確認とする。
- 各テストは「正常系 / 異常系 / 後方互換」を網羅する。

---

## 2. ユニット相当テスト（ロジック・Console 確認可）

### TC-LIP: lip-sync 母音変換
| ID | 入力 | 期待 |
|----|------|------|
| TC-LIP-01 | `charToViseme('あ')` | `'aa'` |
| TC-LIP-02 | `charToViseme('き')` | `'ih'` |
| TC-LIP-03 | `charToViseme('ん')` / `'っ'` / `'ー'` | `'neutral'` |
| TC-LIP-04 | `charToViseme('A')` / `'e'` | `'aa'` / `'ee'` |
| TC-LIP-05 | `charToViseme('!')`（記号） | `'neutral'` |
| TC-LIP-06 | `play('あい',8)` 後 `update(125ms)` ×2 | target が 'aa'→'ih' と進み、完了後 `playing=false` |
| TC-LIP-07 | viseme 表情を持たない VRM で `update` | 例外を投げず無視（口パク無効） |

### TC-NORM: 行（line）正規化
| ID | 入力 | 期待 |
|----|------|------|
| TC-NORM-01 | `"こんにちは"` | `{text:"こんにちは", expression:null, weight:1, holdMs:0}` |
| TC-NORM-02 | `{text:"やぁ", expression:"happy", weight:0.6}` | weight=0.6, holdMs=0 補完 |
| TC-NORM-03 | `{expression:"sad"}`（text欠如） | スキップ or 空文字で無害（落ちない） |

### TC-BARK: bark クールダウン
| ID | 手順 | 期待 |
|----|------|------|
| TC-BARK-01 | `bark('grabbed')` 連続2回（<1500ms） | 2回目はスキップ |
| TC-BARK-02 | `bark('grabbed')` → 1500ms 後再度 | 2回目発火 |
| TC-BARK-03 | `events` に該当イベント無し | 何も起きない（落ちない） |

### TC-LOOP: ステート発話巡回
| ID | 手順 | 期待 |
|----|------|------|
| TC-LOOP-01 | mode='once' 2行 | 2行を順に再生し終了、以後無発話 |
| TC-LOOP-02 | mode='loop' 2行 intervalMs | 行→interval待機→次行→…と循環 |
| TC-LOOP-03 | onState(同一state)連続 | 2回目は無視（再生継続） |
| TC-LOOP-04 | speech 無し state へ onState | stop() のみ（無発話） |
| TC-LOOP-05 | onState('downed') | 既定で stop（ステート発話抑制） |

---

## 3. 統合テスト（swing-catch 実機）

### TC-SC: ステート連動
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-SC-01 | speech 付き NPC が attack に遷移 | attack のセリフが下部ウィンドウ＋頭上吹き出しに表示、口パク・行表情が動く |
| TC-SC-02 | attack→idle 遷移 | attack 発話が中断、idle に speech あれば切替 |
| TC-SC-03 | loop ステートで滞在継続 | intervalMs 間隔で行が循環表示 |
| TC-SC-04 | speech 無しの既存 NPC | 一切発話せず従来通り動作（後方互換） |

### TC-EV: イベント bark
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-EV-01 | NPC 本体を掴む | `grabbed` bark が割り込み再生 |
| TC-EV-02 | マントを掴む | `grabbed` bark 再生 |
| TC-EV-03 | 掴んだ NPC を離す（投げる） | `thrown` bark 再生 |
| TC-EV-04 | 投げた NPC が床/壁に衝突 | `landed` bark 再生（しきい値以上の落下のみ） |
| TC-EV-05 | 低速で着地（しきい値未満） | landed 発火しない |
| TC-EV-06 | bark 後の復帰 | loop ステートなら元のステート発話へ戻る、once は戻らない |
| TC-EV-07 | 連続衝突（バウンド） | CD により多重発火しない |

### TC-UI: 表示
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-UI-01 | 1体が発話 | 下部ウィンドウに話者名＋本文をタイピング表示 |
| TC-UI-02 | 複数体が同時発話 | 下部ウィンドウはキューで順番表示、頭上吹き出しは各自並行 |
| TC-UI-03 | 発話 NPC がカメラ背面/画面外/遠距離 | 頭上吹き出しは非表示/フェード |
| TC-UI-04 | 発話完了後 | BOTTOM_HOLD_MS 保持→フェードアウト |
| TC-UI-05 | 表示中にカメラ移動 | 吹き出しが NPC 頭上に追従 |

### TC-EXP: 表情/口パク連動
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-EXP-01 | 行に expression 指定 | その表情が発話中に乗る、行終了で state 表情へ戻る |
| TC-EXP-02 | 行に expression 未指定 | ステートの表情のまま口だけ動く |
| TC-EXP-03 | viseme 非対応 VRM | 口パク無し・表情/UI は機能、エラー無し |
| TC-EXP-04 | 発話中のまばたき | 既存まばたきと衝突せず動作 |

---

## 4. Character Editor テスト

| ID | シナリオ | 期待 |
|----|----------|------|
| TC-CE-01 | ステート選択でセリフパネル表示 | 該当 state の speech 編集UIが出る |
| TC-CE-02 | 「セリフを追加」 | 空の speech が生成され行追加できる |
| TC-CE-03 | 行追加・編集・削除 | lines が即時反映 |
| TC-CE-04 | 行に表情・weight 指定 | データに保存される |
| TC-CE-05 | mode=loop で intervalMs 表示 | once 時は非表示 |
| TC-CE-06 | イベントセリフ編集（grabbed/thrown/landed） | events に保存される |
| TC-CE-07 | ▶試聴 | プレビューVRMが該当行を口パク＋表情で再生 |
| TC-CE-08 | 保存（exportBundle） | *.npc.json に speech/events が含まれる、空は間引かれる |
| TC-CE-09 | speech/events を含む json を再読込 | 編集内容が復元される |
| TC-CE-10 | speech 無しの既存 json 読込 | 落ちずに空状態で開く（後方互換） |

---

## 5. 回帰・非機能

| ID | 観点 | 期待 |
|----|------|------|
| TC-REG-01 | 既存 NPC 挙動（ステート遷移・ラグドール・マント） | speech 導入後も変化なし |
| TC-REG-02 | npc-state-machine.js | 変更なし（出力契約維持） |
| TC-REG-03 | 複数NPC×発話のフレームレート | 体感で顕著な低下が無い（DOM更新は最小限） |
| TC-NFR-01 | TypeScript / class 不使用 | lib/* は素JS関数factoryのみ |
| TC-NFR-02 | ハードコード回避 | §8 定数が定義箇所に集約 |
