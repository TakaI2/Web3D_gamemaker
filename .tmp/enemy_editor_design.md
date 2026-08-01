# AR Vampire — Enemy(敵挙動) エディタ 設計メモ

## 目的
吸血鬼の「行動ステート × 再生アニメ × 効果音」＋主要パラメータをエディタで設定し、ゲームへ反映する。
（state machineの分岐ロジック自体は固定。各stateで“何を再生し・どの音を鳴らし・どんな速度/間隔か”を可変にする）

## 対象ステート（現状の updateVampire）
- hidden（待機。次の出現までの間隔）
- spawn_wall（壁の闇穴から出現→歩き）
- spawn_ceiling（天井から降臨→飛行）
- approach_walk（歩いて接近・回り込み）
- approach_fly（飛んで接近）
- kiss（顔を密着・吸血ダメージ）
- repelled（十字架で撃退→後退→壁へ消滅）

## 設定できる項目（案）
各ステートごと:
- anim: 再生する timeline.json（grip付＝マント掴み）または .vrma（gripなし）
- animSpeed: 再生速度（省略時グローバル）
- sfx: 効果音ファイル / mode: oneshot|loop / vol
グローバル:
- bgm, bgmVol
- params: nightSec, kissToLose, walkSpeed, flySpeed, animSpeed, spawnGap[min,max], ceilingChance, circleChance
- kiss: {fwd,up,gap,lean}（既存 vamp-tune を統合 or 併存）

## データ形式（public/vamp_param/ に保存。/api/save 経由で上書き）
vamp-enemy.json:
```
{
  "states": {
    "spawn_wall":   { "anim": "eri_model_walk.timeline.json", "sfx": "basa.ogg",  "sfxMode": "oneshot", "vol": 0.9 },
    "spawn_ceiling":{ "anim": "eri_Fly_idle.timeline.json",   "sfx": "basa2.ogg", "sfxMode": "oneshot", "vol": 0.9 },
    "approach_walk":{ "anim": "eri_model_walk.timeline.json", "sfx": null },
    "approach_fly": { "anim": "eri_Fly_idle.timeline.json",   "sfx": null },
    "kiss":         { "anim": "eri_Fly_idle.timeline.json",   "sfx": "fat02.ogg", "sfxMode": "loop", "vol": 0.95 },
    "repelled":     { "anim": "eri_model_walk.timeline.json", "sfx": "chupo1.ogg","sfxMode": "oneshot","vol": 0.9 }
  },
  "bgm": "se1.ogg", "bgmVol": 0.5,
  "params": { "nightSec":300, "kissToLose":10, "walkSpeed":0.9, "flySpeed":0.7, "animSpeed":0.8, "spawnGap":[2.5,5.0], "ceilingChance":0.35, "circleChance":0.4 },
  "kiss": { "fwd":0.125, "up":0, "gap":0.045, "lean":0.5 }
}
```

## ゲーム側の対応
- 起動時に vamp-enemy.json を読み、STATE_CFG に格納。
- アニメ再生を汎用化：playStateAnim(stateId) が cfg.states[id].anim を timeline/vrma として都度ロード（キャッシュ）→ mixer で再生＋cape.setTimeline。
- SFX：各stateの begin で cfg.states[id].sfx を再生（loopはstate離脱で停止）。kiss音は現状の loop を汎用SFXに置換。
- params を定数の代わりに使用（既存 NIGHT_SEC 等を cfg 参照へ）。

## エディタUIの候補
A) 俯瞰モードに統合：既存の live シーン＋プロキシを流用し、各stateを「▶再生」ボタンで即実演＋音確認。状態ごとに anim/sfx ドロップダウン。保存は /api/save。
B) 独立ページ ar-enemy-editor/：専用UI。シーンは新規構築（重複）。

推奨：A（重複を避け、実演しながら設定できる）。
