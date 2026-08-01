# 捕食（predation）機能 設計メモ — tps-flight

## 仕様（ユーザー確定）
- 右クリックで ken(kind:'mob') をキャッチ。ken 照準時のみキャッチ、外していれば従来のラージショット。
- 右クリックを押している間だけ保持。離すと落とす（捕食前）。
- 保持した ken が地面付近で一定時間 → 自動で捕食開始。
- 捕食動作 = プレイヤー feed.vrma＋ken attack_drain_victim02.vrma を再生し、bite アラインで ken の首をプレイヤーの口へ固定。
- 捕食完了 → ken をディソルブで消滅（既存 startNpcDissolve）→ reconcileMobs で再スポーン。

## bite アライン計算（bite-editor 再現）
- 口: player.head bone world pos/quat ＋ mouthOffset(quatで回転)
- 噛点: ken.neck bone world pos/quat ＋ biteOffset
- root目標quat = mouthQuat * Euler(align.rotEuler[deg], 'YXZ')
- root目標bite = mouthPos + align.pos(mouthQuatで回転)
- root.quat=目標→noteMatrix→現噛点world測定→delta=目標bite-現噛点→root.pos+=delta
- ランタイムは blendIn(0.15s) で 0→1 ランプしてスナップ。

## 状態
- player: prey(保持中ken|null), eating(bool), eatT
- mob(ken): eating, eatBlend, preyGroundT, victimAction

## フロー/更新順（render）
updateFlight(eating→凍結) → updatePlayerAnim(eating→feed再生) → updateNpcs(eating ken→victim再生＋bite align) → updatePredation(保持中の地面タイマー) → …
プレイヤー頭は updatePlayerAnim で先に姿勢確定 → 同フレームで ken 側 align が正しく読める。

## 資産プリロード（init, loadPlayer後）
- bite.cfg = ../bitealign/ken.bite.json
- bite.victimAnim = ../vrma/attack_drain_victim02.vrma の生アニメ（ken毎に clip 化）
- bite.feedAction = ../vrma/feed.vrma を player.vrm へ clip 化した action
- bite.ready 揃わなければ捕食無効（右クリックはラージショットのまま）

## ロック/安全
- eating 中は mousedown 無効、RMB up 無視、projectile命中スキップ、removeMob スキップ。
- 保持/eating の ken は既存 grab と衝突しないよう releaseNpc で player.prey もクリア。
