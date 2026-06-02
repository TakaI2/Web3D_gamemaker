# テスト設計書 - 3D ストーリーシステム

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md`

## 1. テスト方針

- 自動テスト基盤は限定的（vitest あり）。純粋ロジック（runner の実行順序・blocking判定・op正規化）は **Node + mock hooks** で検証可能。
- 3D描画・VRM・UI・カメラ・口パくは **実機（story-player / story-editor）での目視確認**。
- 各テストは「正常系 / 異常系（未知op・欠損）/ 同期制御」を網羅。

---

## 2. ユニット相当（Node・mock hooks で検証可）

### TC-RUN: story-runner 実行順序・同期
| ID | 手順 | 期待 |
|----|------|------|
| TC-RUN-01 | 線形 script を run() | op が pc 順に1つずつ hook 呼び出し |
| TC-RUN-02 | blocking op(say/delay) の hook が遅延 Promise | 完了まで次 op に進まない |
| TC-RUN-03 | ノンブロッキング op(actor.show) | hook 呼出後すぐ次へ（Promise を待たない） |
| TC-RUN-04 | ノンブロッキング op に `wait:true` | その Promise 完了まで待つ |
| TC-RUN-05 | 未知 op | スキップ＋警告、再生継続 |
| TC-RUN-06 | hook が例外 | catch して継続（落ちない） |
| TC-RUN-07 | `end` op | ループ終了、running=false |
| TC-RUN-08 | run(fromPc=k) | k 番目から開始（プレビュー用） |
| TC-RUN-09 | stop() 呼出 | 次 op へ進まず終了 |

### TC-OPS: story-ops スキーマ
| ID | 手順 | 期待 |
|----|------|------|
| TC-OPS-01 | STORY_OPS の各 op に fields/label | 全 op 定義あり、OP_ORDER と一致 |
| TC-OPS-02 | 既定値 def の補完関数 | 欠損フィールドが def で埋まる |
| TC-OPS-03 | blocking フラグ | say/wait/delay/fade.in/fade.out が blocking=true |

### TC-LINE: say lines 正規化（lip-sync/npc-speech と整合）
| ID | 入力 | 期待 |
|----|------|------|
| TC-LINE-01 | `"こんにちは"` | `{text, expression:null, weight:1}` |
| TC-LINE-02 | `{text:"やぁ", expression:"happy", weight:0.6}` | そのまま保持 |

---

## 3. 統合（story-player 実機）

### TC-PLAY: 再生
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-PLAY-01 | サンプル story 読込→再生 | actor 登場→say→move→anim→end が順に進む |
| TC-PLAY-02 | say でクリック/Space | 行送り、全行後に次 op |
| TC-PLAY-03 | say 中に口パク・行表情 | 該当アクターが口パク＋表情、下部ウィンドウ＋頭上吹き出し表示 |
| TC-PLAY-04 | actor.move(wait:true) | 移動完了まで次 op を待つ／進行方向へ向く |
| TC-PLAY-05 | actor.move(wait:false)＋say | 歩きながらしゃべる（並行） |
| TC-PLAY-06 | actor.anim(vrma) | 指定 VRMA が再生・loop指定が効く |
| TC-PLAY-07 | camera(duration) | カメラが滑らかに移動・注視 |
| TC-PLAY-08 | fade.in/out・delay | 画面フェード・待機が機能 |
| TC-PLAY-09 | stage 指定 | stage.json の GLB 配置が出る |
| TC-PLAY-10 | actor.ragdoll active | 既存ラグドールで崩れる |
| TC-PLAY-11 | end 到達 | 停止しセレクトへ戻る |
| TC-PLAY-12 | bgm.play/stop（音源あり） | 再生・停止（無ければ無音継続・警告のみ） |

### TC-ROBUST: 異常系
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-ROBUST-01 | 未登場 id を move/say | 警告しスキップ、再生継続 |
| TC-ROBUST-02 | 存在しない vrma 名 | 警告し当該 anim スキップ |
| TC-ROBUST-03 | stage/BGM 欠如 | 床＋空・無音で継続 |
| TC-ROBUST-04 | viseme 非対応 VRM | 口パク無効・表情/UI は機能 |

---

## 4. story-editor 実機

| ID | シナリオ | 期待 |
|----|----------|------|
| TC-ED-01 | ＋でコマンド追加（op選択） | 既定値付きで script 末尾/選択位置に追加 |
| TC-ED-02 | 行選択→右フォーム | op に応じた項目が表示・編集が script に反映 |
| TC-ED-03 | ▲▼ 並べ替え / ✕削除 | 順序変更・削除が反映 |
| TC-ED-04 | actorRef/vrmaRef/stageRef | 一覧 select から選べる（手入力不要） |
| TC-ED-05 | say lines 複数行＋行表情 | 編集が保存データに入る |
| TC-ED-06 | アクター一覧編集（id↔npc） | story.actors に反映 |
| TC-ED-07 | ▶最初から / ▶ここから | プレビューが該当 pc から再生 |
| TC-ED-08 | ⏹停止 | プレビュー停止 |
| TC-ED-09 | 保存（api/save） | public/story/<id>.story.json に保存 |
| TC-ED-10 | 既存 story を開く | manifest 一覧→取得→編集→上書き |
| TC-ED-11 | プレビューと player の一致 | 同一 story-stage のため挙動一致 |

---

## 5. 回帰・非機能

| ID | 観点 | 期待 |
|----|------|------|
| TC-REG-01 | 既存 lib（npc-speech/lip-sync/speech-ui/vrm-cloth/vrm-ragdoll） | 変更なしで流用、既存ページ（swing-catch/character-editor）に影響なし |
| TC-REG-02 | vite.config 変更 | 既存 save(npc/models/timeline) と manifest が従来通り動作 |
| TC-NFR-01 | TS/class 不使用 | lib/* は素JS factory のみ |
| TC-NFR-02 | データ駆動 | editor フォームが STORY_OPS から生成、op追加が容易 |
| TC-NFR-03 | エンジン単一 | player/editor が story-stage を共用 |
