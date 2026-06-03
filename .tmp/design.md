# 設計書 - ゲームフロー フェーズ2a：敵の攻撃とライフ

要件: `.tmp/requirements.md`
対象: swing-catch（戦闘モード）中心 ＋ Character Editor（attackHit/menace イベント）＋ サンプルNPCデータ

---

## 1. 方針
- 追加要素はすべて `FLOW`（?flow=1）かつ `battleCfg` ありで作動。非フロー時は一切動かさない（後方互換）。
- 敵の戦闘は **per-enemy 戦闘コントローラ**（combat）を毎フレーム駆動。state-machine とは独立に「攻撃」を制御し、
  攻撃中のみ移動を上書きする。表情/視線は従来どおり state-machine。
- 被弾セリフは既存 bark 機構（npc-speech）に `attackHit`（被弾）/`menace`（予備動作）イベントを足すだけ。

---

## 2. 定数（swing-catch・FLOW戦闘）
```
MELEE_DMG=3, BALL_DMG=1, THROW_DMG=2, TOUCH_DMG=1
TELEGRAPH_TIME=1.0s, LUNGE_TIME=0.7s
MELEE_TRIGGER_DIST=7m, MELEE_HIT_RADIUS=1.6m
TELEGRAPH_SPEED=4, LUNGE_SPEED=14
RANGED_CD=[2.5,4.0]s, MELEE_CD=3.0s（敵ごとに乱数初期化）
ENEMY_BALL_SPEED=16, THROW_SPEED=22, THROW_REACH=8m, HAZARD_TIME=2.0s
INVULN=0.8s, PLAYER_HIT_R=0.5m
ENEMY_PROJ_TTL=4s
```

## 3. 敵 combat コントローラ（swing-catch）
createMegu（FLOW時）に追加: `m.combat = { mode:'idle', t:0, cd: randRange(1.5,3.5) }`。

`updateEnemyCombat(m, dt)`（FLOW時、updateMegu 内で呼ぶ。ragdoll/held/downed は return）:
```
dist = distanceToPlayer(m)
switch m.combat.mode:
  'idle':
    cd -= dt
    if cd<=0:
      if dist < MELEE_TRIGGER_DIST: startMelee(m)         // 近接：予備動作へ
      else: doRanged(m, dist)                              // 遠距離：弾 or 投擲
  'telegraph':                                             // 挑発（寄る＋menace bark＋angry表情）
    approachPlayer(m, dt, TELEGRAPH_SPEED); faceToPlayer(m,dt)
    t-=dt; if t<=0 { mode='lunge'; t=LUNGE_TIME }
  'lunge':                                                 // 踏み込み（速い）
    approachPlayer(m, dt, LUNGE_SPEED); faceToPlayer(m,dt)
    if dist < MELEE_HIT_RADIUS { onPlayerDamaged(MELEE_DMG, m); endMelee(m) }
    else { t-=dt; if t<=0 endMelee(m) }
```
- startMelee: mode='telegraph', t=TELEGRAPH_TIME, `m.speech?.bark('menace')`, 一時的に angry 表情をcombat側で付与。
- endMelee: mode='idle', cd=MELEE_CD。
- doRanged: オブジェクトが近くにあれば 50% で `throwObjectAt(m)`、なければ/残り50% で `fireEnemyBall(m)`。cd=randRange(RANGED_CD)。
- 攻撃中（telegraph/lunge）は updateMegu の通常移動を抑止（combat が移動を担当）。

## 4. 敵の飛び道具
- **敵弾**: `enemyProjectiles[]`（{mesh,pos,vel,ttl,radius,source}）。`fireEnemyBall(m)`= meguCenter から (player-center) 方向へ ENEMY_BALL_SPEED。
  `stepEnemyProjectiles(dt)`: 移動・壁/ttl で消滅・プレイヤー命中(dist<radius+PLAYER_HIT_R)で `onPlayerDamaged(BALL_DMG, source)`＋消滅。色を赤系にしてプレイヤー弾と区別。
- **投擲オブジェクト**: `throwObjectAt(m)`= 最近傍 object(≤THROW_REACH) の vel を player 方向 THROW_SPEED に。`obj.thrownBy=m; obj.hazardT=HAZARD_TIME`。
  既存 stepObjects はそのまま（飛んでいく）。

## 5. 浮遊オブジェクトの対プレイヤー判定（FLOW）
`updateObjectHazards(dt)`（毎フレーム）:
```
for obj in objects:
  if obj.hazardT>0: obj.hazardT-=dt
  d = distance(obj.pos, camera)
  if d < obj.radius + PLAYER_HIT_R:
    dmg = obj.hazardT>0 ? THROW_DMG : TOUCH_DMG
    src = obj.hazardT>0 ? obj.thrownBy : null
    onPlayerDamaged(dmg, src)
    // プレイヤーから跳ね返す
    obj.vel.addScaledVector(dirFromPlayer, +); obj.hazardT=0; obj.thrownBy=null
```

## 6. プレイヤー被弾・ライフ・演出
- `onPlayerDamaged(amount, src)`:
  - battleOver/無敵中(battleTime-lastHitT<INVULN) は無視。
  - lastHitT=battleTime; playerHp=max(0,playerHp-amount); updateBattleHud()。
  - VFX: 赤ヴィネット(#battle-vfx 不透明度パルス) ＋ カメラシェイク(shakeT=0.25)。
  - `src?.speech?.bark('attackHit')`（当てた NPC がしゃべる）。
  - playerHp<=0 → endBattle('lose')。
- 既存 `updateBattleDamage`（attack状態の近接判定）は撤去し combat の melee に一本化。
- HUD は既存 buildBattleHud を流用（HP バー＋撃破）。VFX 用 `#battle-vfx`（全画面・pointerEvents none）を追加。
- カメラシェイク: render で shakeT>0 の間、camera.rotation に微小ランダム付与（毎フレーム減衰）。

## 7. データ／エディタ
- npc `events` に `attackHit`（被弾時）/`menace`（予備動作）を追加可能に。
- Character Editor `buildEventSpeechPanel` の EVENTS に `['attackHit','攻撃ヒット'],['menace','威嚇']` を追加。
- サンプル NPC（lily/megu/ayu）に attackHit/menace のセリフを付与（node スクリプトで add-only 注入）。

## 8. 変更ファイル
| 種別 | パス | 内容 |
|------|------|------|
| 変更 | `swing-catch/swing-catch.js` | combat コントローラ・敵弾・投擲・接触ダメ・被弾/ライフ/VFX |
| 変更 | `character-editor/character-editor.js` | イベント種別に attackHit/menace |
| データ | `public/npc/*.npc.json` | attackHit/menace セリフ（コミット対象外・検証用） |

## 9. エッジ/後方互換
- 非フロー：combat/敵弾/接触ダメ/VFX/HUD すべて未作動。
- 敵が ragdoll/held/downed 中は攻撃しない。撃破された敵は攻撃停止。
- 敵弾/投擲オブジェクトはプレイヤーのみ対象（敵同士・自分には当てない）。
- 無敵時間で多段ヒットの即死を防止。
