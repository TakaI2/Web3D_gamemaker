# plateau-fly 大型アップデート実装計画（TPS_plan.txt 2026-07-10版）

方針: **tps-flight(1819行, 同じWebGPUスタック)から実証済みシステムを移植**し、plateau-fly固有の適応（地形Y・都市スケール・負荷対策）を最小限加える。Web前提＝負荷ガードを全フェーズ共通で入れる。

## 検証済みの前提
- 移植元 tps-flight に計画の数値・機能が全て存在:
  - cam { dist:4.0, height:1.2, follow:8, fov:70, sens:1.0 } / MOUSE_SENS_BASE=0.0024
  - PREY_GROUND_Y=0.25 / PREY_GROUND_TIME=0.7 / PREDATION_EAT_TIME=4.5
  - チャージ攻撃: TAP_THRESHOLD=0.18 / MAX_CHARGE_TIME=1.5、shot=Joy_reborn_cas1_L1
  - timeline埋め込みFXの再生エンジン (makeEffectFx / computeEffectTransform / 爆発プール)
  - ken一式: MOB_CHAR='ken.npc.json'、HP・ラグドール・ディソルブ死・再スポーン、捕食(bite align feed)
- アセット: `Joy_reborn_cas1_L1 / _large_beam / _lightning / _totem .timeline.json`、`totem.fx.json`、`ken.npc.json`、`ken.bite.json`、`lib/fx-tornado.js`・`fx-mesh.js`・`fx-particles.js` 全て存在
- plateau-fly固有の差分: **地面Yが0でない(DEM地形)** → 接地判定は groundGroup レイキャスト(既存 groundCollide)の地面Y基準に置換。都市スケールは同じメートル系。

## フェーズ構成（各フェーズ単体でテスト可能）

### Phase 1: 操作感統一＋車増量（小）
- cam を tps-flight 値に: dist4.0/height1.2/follow8/FOV70/感度 1.0×0.0024
- flight.maxSpeed=8（ホイール増速は残す）、accel は tps-flight の32へ
- CAR_COUNT 40→120程度・スポーンをプレイヤー近傍優先に（掴みテスト可能な密度）
- 負荷: 車はテンプレclone済みで増量のみ。問題なし

### Phase 2: 攻撃システム移植（中大）＝入力・状態機械・FX再生エンジンの土台
- tps-flightから移植: timeline FX再生 (makeEffectFx/computeEffectTransform/_fxSpecCache)、爆発プール
- 状態追加: shot(cas1_L1)/largeLoad(チャージ)/large(Joy_reborn_large_beam)
- 入力を tps-flight と統一: 左タップ=通常ショット / 長押し0.18s超=チャージ→離すと large_beam（5秒間 貫通・連続照射、建物/車/kenに継続ダメージ）
- **スーパービーム(新規)**: 通常ショット連続3発目で Joy_reborn_lightning 発射（コンボカウンタ＋リセット時間）
- 掴み→射出も tps-flight方式に統一（「投げる動作はTPS-flightと同じ」＝抱えた物をショットで前方射出）
- 負荷: FXはプール＋同時数キャップ＋カメラ距離カリング

### Phase 3: ビル破壊の改善（中）
- **HP制**: tier×サイズでHP（house小 / mid中 / tower大。フットプリント・高さ係数）
- カーブ命中=ダメージ。HP0で即崩壊（既存の沈降＋上→下ディソルブ）
- **延焼崩壊**: 一度でも被弾した建物は毎秒スローでHP減少＋**ゆっくり傾き**(基部エッジ軸の微小回転をbaseMatrixに合成)→自然にHP0で崩壊。追撃すれば即壊せる
- **着弾FX**: 炎＋煙（fx-particles/fx-mesh、プール・同時キャップ・近距離のみ）
- 負荷: 被弾建物は既に単体メッシュ化済み(damaged Map)なので傾き/減衰はレコード毎の軽い更新

### Phase 4: NPC ken＋捕食の移植（大）
- ken を街路（プレイヤー近傍の道路上、地形Yに接地）にスポーン。HP・被弾ラグドール・ディソルブ死・再スポーン
- 掴み(既存統一入力)→**地面付近(地面Y+0.25相対)で0.7s保持→捕食開始**(bite align feed、4.5s)→ディソルブ＋再スポーン
- 適応: PREY_GROUND_Y 等の絶対Y判定を「地面レイキャストYとの相対」に置換
- 負荷: ken同時数は少数(3〜5体)から

### Phase 5: トーテム設置（中）
- 条件: **接地中＋捕食対象を持っていない＋左クリック長押し** → Joy_reborn_totem timeline再生 → その場にトーネード発生（largeチャージと排他: 空中=チャージ / 接地=トーテム）
- 小さく発生→現行サイズへ成長。別の場所で再設置→移動
- 投げ込まれた npc/車/破片はトーネード周囲を旋回しつつ徐々にダメージ→最後はディソルブで溶け消える→**そのたびトーテムが成長**
- 実装: lib/fx-tornado の createTornado＋totem.fx.json、旋回はパラメトリック軌道(物理なし=軽い)

### Phase 6: ビル生成リサーチ（調査・任意）
- BuildingGeneratorThreeJS (MIT, TS, kit.glb+InstancedMesh, HK風) の検証:
  1. エディタページ化して hub に追加（コア generator を ESM 移植 or ビルド成果物を同梱）
  2. ステージ利用は「生成ビルK種→**1ジオメトリにベイク**→既存のモデル単位InstancedMeshパイプラインへ追加」が軽量経路（パーツ個別インスタンスのままだと窓×棟数でインスタンス爆発）
  3. 1棟プロトタイプ→頂点数/描画時間を計測→ダメなら現行モデル続行（計画通り）
- 破壊は既存カーブ材質がベイク済みジオメトリにそのまま適用可

## 共通の負荷ガード
- FX/破片/煙は全てプール＋同時数キャップ＋距離カリング
- 毎フレームのアロケーション禁止（既存スタイル踏襲）
- 新規シェーダは最小限（既存カーブ/ディソルブ再利用）

## 実装順の理由
1(体感)→2(入力/FX土台。3,4,5が依存)→3(独立・見せ場)→4(掴み系に依存)→5(2のFX＋4の投擲対象に依存)→6(独立リサーチ)
