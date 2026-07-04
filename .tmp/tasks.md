# タスクリスト - ゲームフローシステム ＜フェーズ1＞

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md` / テスト: `.tmp/test_design.md`

## 概要
ノード接続のゲームフロー基盤。flow-runner（走査）＋ flow-player（iframe オーケストレータ）＋ flow-editor（グラフ編集）。
既存 story-player / swing-catch にフローモードを後方互換で追加。

---

## フェーズ1-1: ランナー
- [ ] **T1-1**: `lib/flow-runner.js`（NODE_TYPES / WIN_TYPES / LOSE_TYPES / createFlow: getStart/next/getNode）
  - 検証: TC-FR-01〜07（Node）

## フェーズ1-2: 既存ページのフローモード
- [ ] **T2-1**: `story-player`：`?flow=1` 自動再生＋ end で `postMessage(result:'done')`。非フロー従来維持
  - 検証: TC-PLAY-02 / TC-COMPAT-02
- [ ] **T2-2**: `swing-catch`：`?flow=1` 戦闘モード（`flow-config` 受信→enemies/stage/bgm 反映）
- [ ] **T2-3**: 同上：プレイヤーHP・撃破カウント・HUD・決着→`postMessage(result)`。`if(FLOW)` 隔離
  - 検証: TC-BATTLE-01〜07 / TC-COMPAT-01

## フェーズ1-3: プレイヤー
- [ ] **T3-1**: `flow-player/`（iframe + message 受信・origin検証・多重発火防止・HUD・end処理）
- [ ] **T3-2**: `public/flow/sample.flow.json`（intro→battle→win/lose→end）＋ win/lose 用サンプル story
  - 検証: TC-PLAY-01〜07

## フェーズ1-4: エディタ
- [ ] **T4-1**: `flow-editor/index.html` レイアウト（top/center canvas/right props）
- [ ] **T4-2**: グラフ（div ノード＋SVG エッジ、パン/ズーム、ノードドラッグ）
- [ ] **T4-3**: ポート接続/削除（win/lose 分岐対応）、開始ノード指定
- [ ] **T4-4**: プロパティ（story 選択 / battle: enemies・stage・win.count・lose.hp、データ駆動）
- [ ] **T4-5**: 保存・読込（api/save dir:flow、/flow/manifest.json）
  - 検証: TC-ED-01〜11

## フェーズ1-5: サーバ・検証
- [ ] **T5-1**: `vite.config.ts`（flow 保存許可・/flow/manifest.json）
- [ ] **T5-2**: `hub` に Flow Player / Flow Editor リンク
- [ ] **T5-3**: 実機検証（TC-PLAY/TC-BATTLE/TC-ED）＋回帰（TC-REG/TC-COMPAT）

---

## 完了基準（DoD）
- flow-editor でノードを繋ぎ（story→battle→win/lose→end）保存できる。
- flow-player で再生し、戦闘の勝敗で分岐して別ストーリーへ進める。
- swing-catch は非フロー時に従来サンドボックスのまま（後方互換）。
- flow-runner は素JS・3D非依存で TC-FR 通過。

---

## TodoWrite 管理単位
1. flow-runner
2. story-player / swing-catch フローモード
3. flow-player ＋ サンプル
4. flow-editor（グラフ/接続/プロパティ/保存）
5. vite/hub・実機検証
