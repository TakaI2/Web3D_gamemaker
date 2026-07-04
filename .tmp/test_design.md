# テスト設計書 - ゲームフローシステム ＜フェーズ1＞

要件: `.tmp/requirements.md` / 設計: `.tmp/design.md`

## 1. 方針
- flow-runner（グラフ走査）は **Node でロジックテスト**。
- iframe + postMessage 連携・戦闘・エディタは **実機（ブラウザ）目視**。
- 後方互換（swing-catch 非フロー）を必ず確認。

---

## 2. ユニット相当（Node）

### TC-FR: flow-runner
| ID | 手順 | 期待 |
|----|------|------|
| TC-FR-01 | createFlow→getStart() | flow.start のノード、無ければ start 種別、無ければ先頭 |
| TC-FR-02 | next('n_intro','next') | エッジ先ノード |
| TC-FR-03 | battle next('n_battle','win') / ('...','lose') | それぞれ別ノードへ |
| TC-FR-04 | 接続なしポート next() | null（＝終了） |
| TC-FR-05 | end ノード | ports 空、next は null |
| TC-FR-06 | 未知ノードid getNode | null（落ちない） |
| TC-FR-07 | NODE_TYPES に start/story/battle/end | 定義あり・battle は win/lose ポート |

---

## 3. 統合（実機）

### TC-PLAY: flow-player オーケストレーション
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-PLAY-01 | sample.flow 再生 | story→battle→（win/lose）→story→end と進む |
| TC-PLAY-02 | story ノード | story-player iframe が自動再生、end で次へ |
| TC-PLAY-03 | battle ノード勝利 | win 側ストーリーへ分岐 |
| TC-PLAY-04 | battle ノード敗北 | lose 側ストーリーへ分岐 |
| TC-PLAY-05 | end 到達 | 終了表示・一覧へ戻れる |
| TC-PLAY-06 | HUD | 現在ノード種別/idが分かる |
| TC-PLAY-07 | 別オリジン/不正 message | 無視（誤進行しない） |

### TC-BATTLE: swing-catch フロー戦闘
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-BATTLE-01 | flow-config 受信 | enemies/stage/bgm が反映され戦闘開始 |
| TC-BATTLE-02 | 撃破（射撃命中） | 撃破カウント+1、HUD更新 |
| TC-BATTLE-03 | 撃破（掴んで投げKO） | 撃破カウント+1（過剰カウントしない=CD） |
| TC-BATTLE-04 | count 到達 | result:'win' 通知、操作停止・バナー |
| TC-BATTLE-05 | attackNPC 接触継続 | プレイヤーHP 減少（CDあり）、HUD更新 |
| TC-BATTLE-06 | HP 0 | result:'lose' 通知 |
| TC-BATTLE-07 | PC操作（マウス/キー）・スマホ操作 | 現行UIで掴む/投げる/撃てる |

### TC-COMPAT: 後方互換
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-COMPAT-01 | swing-catch 通常起動（?flow なし） | HP/カウント/HUD/通知が一切出ず従来サンドボックス |
| TC-COMPAT-02 | story-player 通常起動（?flow なし） | 従来のセレクト＋開始オーバーレイ |

---

## 4. flow-editor（実機）
| ID | シナリオ | 期待 |
|----|----------|------|
| TC-ED-01 | ノード追加（start/story/battle/end） | キャンバスに出る |
| TC-ED-02 | ノードドラッグ移動 | x,y 更新・保存に反映 |
| TC-ED-03 | 出力→入力ポート接続 | エッジ生成・SVG描画 |
| TC-ED-04 | battle の win/lose を別ノードへ | 2本のエッジが別先へ |
| TC-ED-05 | エッジ削除 | 消える |
| TC-ED-06 | story ノード props | story 一覧から選択 |
| TC-ED-07 | battle ノード props | enemies複数選択・stage・win.count・lose.hp 編集 |
| TC-ED-08 | 開始ノード指定 | flow.start 反映 |
| TC-ED-09 | 保存 | public/flow/<id>.flow.json |
| TC-ED-10 | 既存 flow 読込 | manifest→取得→編集→上書き |
| TC-ED-11 | パン/ズーム | キャンバス移動・拡縮 |

---

## 5. 回帰・非機能
| ID | 観点 | 期待 |
|----|------|------|
| TC-REG-01 | 既存ページ（story/cloth/character等） | 影響なし |
| TC-REG-02 | vite.config（既存 save/manifest） | 従来通り＋flow追加が動作 |
| TC-NFR-01 | flow-runner | 素JS・3D非依存、TC-FR通過 |
| TC-NFR-02 | データ駆動 | NODE/WIN/LOSE 種別が定数、editor がそれを参照 |
