# タスクリスト - NPC セリフ（ダイアログ）システム

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md` / テスト: `.tmp/test_design.md`

## 概要

共通 lib（口パク・セリフ制御・UI）を素JSで実装し、swing-catch と Character Editor に統合する。
原則: ステートマシンは無変更、後方互換維持、定数集約。

---

## フェーズ1: 共通ライブラリ（lib/）

- [ ] **T1-1**: `lib/lip-sync.js` 新規作成
  - visemeMaps（JP/EN）・isJapanese・charToViseme を移植（内蔵）
  - `createLipSync(vrm)`：play/stop/update(dtMs)/playing、dt駆動の文字送り＋viseme LERP
  - viseme 非対応VRMの try/catch スキップ
  - 検証: TC-LIP-01〜07

- [ ] **T1-2**: `lib/npc-speech.js` 新規作成
  - 行正規化（normalizeLine）、DEFAULT_CPS / BARK_COOLDOWN_MS 定数
  - `createNpcSpeech(vrm, characterDef, hooks)`：onState / bark / update / speaking / stop
  - once/loop 巡回、bark 割り込み＋CD、行表情の適用と復帰、downed 抑制
  - 検証: TC-NORM, TC-BARK, TC-LOOP

- [ ] **T1-3**: `lib/speech-ui.js` 新規作成
  - CSS 動的注入、下部ウィンドウ（キュー＋タイピング＋hold＋フェード）
  - 頭上吹き出しプール（Map<npc,el>）、project(camera) 追従、背面/画面外/距離フェード
  - showBottom / setBubble / clearBubble / update(dt, npcs)
  - 定数: BOTTOM_HOLD_MS, BUBBLE_MAX_DIST
  - 検証: TC-UI（swing-catch 統合後）

---

## フェーズ2: swing-catch 統合

- [ ] **T2-1**: import 追加・megu 拡張
  - `createNpcSpeech` を import、createMegu で `speech`/`prevState`/`prevCenterY`/`prevVy` を初期化
  - `init()` で `createSpeechUI({camera, dom, getWorldCenter})` 生成、onLineStart 配線

- [ ] **T2-2**: ステート変化検知＋表情適用統合
  - updateMegu の state 決定後に `onState` 呼出（変化時のみ）
  - state表情・まばたき適用の後（vrm.update 前）に `m.speech.update(dt)`
  - 検証: TC-SC-01〜04, TC-EXP-01〜04

- [ ] **T2-3**: イベント bark フック
  - grabMeguBody / grabMeguCloth → `bark('grabbed')`
  - releaseMegu → `bark('thrown')`
  - landed 検出ヒューリスティック（LANDED_SPEED_THRESHOLD/MARGIN、prevVy 追跡）→ `bark('landed')`
  - 検証: TC-EV-01〜07

- [ ] **T2-4**: UI 毎フレーム更新
  - animate ループに `speechUI.update(dt, megus)` を追加
  - 検証: TC-UI-01〜05

---

## フェーズ3: Character Editor 統合

- [ ] **T3-1**: データ層拡張
  - defaultCharacter に `events:{}`、mergeCharacter で speech/events 引継ぎ（後方互換）
  - 検証: TC-CE-10, TC-REG-01

- [ ] **T3-2**: セリフ編集パネル UI
  - index.html にセクション DOM 追加（state用 speech 領域＋イベントセリフ常設セクション）
  - `buildSpeechPanel()`：mode/intervalMs/cps、行リスト（text/表情/weight/削除/追加）
  - selectState から呼出
  - 検証: TC-CE-01〜06

- [ ] **T3-3**: 試聴機能
  - 行ごとの ▶試聴：プレビューVRMに createLipSync で play＋行表情
  - editor update(dt) に試聴用 lip.update を組込
  - 検証: TC-CE-07

- [ ] **T3-4**: 保存クリーンアップ
  - exportBundle 前に空の speech/events を間引く
  - 検証: TC-CE-08, TC-CE-09

---

## フェーズ4: サンプルデータ・検証

- [ ] **T4-1**: 既存 NPC（lily/ayu/megu 等）の1体にセリフ例を付与
  - 各ステート＋イベントに日本語セリフを設定し、Character Editor で保存
  - 注意: *.npc.json は VRM 埋込で大容量＝コミット対象外（gitignore済の運用）。検証用のみ

- [ ] **T4-2**: swing-catch 実機検証
  - TC-SC / TC-EV / TC-UI / TC-EXP を通し確認
  - viseme 非対応VRM での挙動（TC-EXP-03）

- [ ] **T4-3**: 回帰確認（TC-REG）
  - 既存挙動・state-machine 無変更・体感フレームレート

---

## 完了基準（DoD）

- lib/ 3ファイルが素JS（class/TS不使用）で動作。
- swing-catch でステート連動＋3イベント bark＋下部ウィンドウ＋頭上吹き出し＋口パク＋行表情が機能。
- Character Editor で全ステート＋イベントのセリフ編集・試聴・保存・再読込が可能。
- speech 無しの既存 NPC が従来通り動作（後方互換）。
- 定数が定義箇所に集約され、ハードコード散在が無い。

---

## TodoWrite 管理単位（主要タスク）

1. lib 3ファイル実装（T1-1〜T1-3）
2. swing-catch 統合（T2-1〜T2-4）
3. Character Editor 統合（T3-1〜T3-4）
4. サンプル投入・実機検証・回帰（T4-1〜T4-3）
