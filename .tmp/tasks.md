# タスクリスト - 3D ストーリーシステム

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md` / テスト: `.tmp/test_design.md`

## 概要

共通lib（ops/runner/actors/stage）を素JSで実装し、story-player と story-editor を新規作成。
既存lib（npc-speech/lip-sync/speech-ui/vrm-cloth/vrm-ragdoll）と stage.json/vrma を流用。

---

## フェーズ1: 実行コア（lib）

- [ ] **T1-1**: `lib/story-ops.js`
  - STORY_OPS（op→label/blocking/fields/def）、OP_ORDER、applyDefaults(op) ヘルパ
  - 検証: TC-OPS, TC-LINE

- [ ] **T1-2**: `lib/story-runner.js`
  - createStoryRunner(script, hooks)：run(fromPc)/stop/pc/running、blocking判定、未知op/例外スキップ
  - 検証: TC-RUN-01〜09（Node + mock hooks）

---

## フェーズ2: アクター管理（lib）

- [ ] **T2-1**: `lib/story-actors.js` 骨格
  - createActorManager、show（npc.json→VRM/cloth/ragdoll/lip）、hide、get、headWorldPos、update、clear
- [ ] **T2-2**: 動作系
  - move（tween+進行方向向き・Promise）、face（camera/actor/座標）、anim（vrma crossFade・Promise）、
    expression（補間）、ragdoll、speak（lip+行表情）
  - 検証: TC-PLAY-03〜06,10（player 統合後）

---

## フェーズ3: 再生エンジン（lib）

- [ ] **T3-1**: `lib/story-stage.js` シーン構築
  - WebGPURenderer + sky/floor/lights + camera（swing-catch init 簡略移植）
  - speechUI 生成、cameraTween（moveTo/update）、fadeOverlay（in/out）、audio（bgm/se）、stageLoader（stage.json）
- [ ] **T3-2**: hooks 実装＋ループ
  - 全 op の hooks（§6）、loadStory/play/stop、setAnimationLoop で actor/camera/speechUI 更新
  - say フロー（クリック送り・口パく・UI）
  - 検証: TC-PLAY-07〜09,11,12 / TC-ROBUST

---

## フェーズ4: プレイヤー

- [ ] **T4-1**: `story-player/index.html` + `story-player.js`
  - story-stage(mode:play) ラッパ、/story/manifest.json 一覧 or ?id= 取得、クリックで play、end でセレクトへ
- [ ] **T4-2**: サンプル `public/story/sample.story.json`
  - lily/megu 登場→say→move→anim→camera→fade→end の確認用
  - 検証: TC-PLAY 全般 / TC-ROBUST

---

## フェーズ5: エディタ

- [ ] **T5-1**: `story-editor/index.html` レイアウト（左:リスト / 中:プレビュー / 右:フォーム / top:メタ）
- [ ] **T5-2**: `story-editor.js` コマンドリスト
  - script 行表示・選択・▲▼並べ替え・✕削除・＋追加（op ピッカー＋def）
- [ ] **T5-3**: パラメータフォーム（STORY_OPS 駆動）
  - field.type 別UI（actorRef/npcRef/vrmaRef/stageRef/expr/vec3/lines/text/number/bool）
  - 一覧は /npc, /vrma, /models manifest から取得
  - アクター一覧編集（id↔npc）
  - 検証: TC-ED-01〜06
- [ ] **T5-4**: 埋め込みプレビュー
  - story-stage(mode:edit) を中央に、▶最初から/▶ここから/⏹、編集中 story を loadStory
  - 検証: TC-ED-07,08,11
- [ ] **T5-5**: 保存・読込
  - api/save(dir:'story')、/story/manifest.json 一覧→取得→上書き
  - 検証: TC-ED-09,10

---

## フェーズ6: サーバ・検証

- [ ] **T6-1**: `vite.config.ts`
  - save 許可に story 追加、/story/manifest.json 配信、（任意）ビルド時 manifest 生成
  - 検証: TC-REG-02
- [ ] **T6-2**: 実機検証
  - TC-PLAY / TC-ROBUST / TC-ED 一式、player↔editorプレビュー一致
- [ ] **T6-3**: 回帰
  - 既存ページ（swing-catch/character-editor/cloth）に影響なし（TC-REG-01）

---

## 完了基準（DoD）

- story-player で サンプル story が登場→セリフ(口パク)→移動→モーション→カメラ→フェード→終了まで通る。
- story-editor で コマンド追加/編集/並べ替え/削除・アクター/VRMA/ステージ選択・保存/読込・プレビューが機能。
- runner は素JS・3D非依存で TC-RUN を通過。未知op/欠損で落ちない。
- 既存lib/ページに影響なし。op追加が STORY_OPS への追記で済むデータ駆動。

---

## TodoWrite 管理単位

1. 実行コア（ops/runner）
2. アクター管理（actors）
3. 再生エンジン（stage）
4. プレイヤー＋サンプル
5. エディタ（リスト/フォーム/プレビュー/保存）
6. vite設定・実機検証・回帰
