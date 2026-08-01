# 生きた街（Living City）設計 — TPS_plan 2026-07-12 改良案の実現方法調査

前提: Web/WebGPUで軽量に。plateau-fly の既存資産（OSM道路グラフ・建物recs・番地シード内装・車システム・speech lib）を最大限流用。

## 調査結果（事実確認）
- **RPG-Game(developer)**: `src/systems/` に **NPCManager.ts / GameClock.ts / WantedSystem.ts / WorldState.ts** が存在。
  - NPCDef: role/movement('patrol'|'scheduled'|'idle')/dialogLines/utilityWeights/home座標
  - ScheduleEntry: **時刻帯トリガ(timeStart/End, 深夜跨ぎ対応)＋waypoints[{x,y,activity,waitMs,speech}]**
  - **timeSkipSchedule**: カリング中NPCは時刻変化時に行程を早送り＝画面外は計算しない設計が既にある → **そのまま概念移植**
  - A*経路探索・ユーティリティスコア(役割で行動選択)・活動別セリフ
- **speechシステム**: tps-flightではなく **swing-catch**。`lib/npc-speech.js`+`lib/speech-ui.js`+`lib/speech-set.js` にライブラリ化済み＝移植容易。public/speech/*.speech.json あり。
- **アセット**: 道路キットに **light-curved/light-square系（街灯）**・road-straight/bend/crossroad 等、車キットに **police.glb**。
- **空**: three.js examples は MIT ライセンス → 利用OK。ただし例の Sky は WebGL ShaderMaterial。**WebGPUは `three/examples/jsm/objects/SkyMesh.js`（ノード版Sky）** を使う。

## 各項目の実現方式（軽量化の勘所）

### A. 昼夜サイクル（最初にやると街が一気に生きる・ほぼ無料）
- gameClock: 1ゲーム日=実10分（可変）。hour(0-24)から太陽方位を計算。
- SkyMesh(WebGPU) の sunPosition・DirectionalLight色/強度・fog色・Ambient を hour で lerp。コストは uniform 更新のみ。
- **ネオン/ランプ**: 建物recsから高層の屋上四隅座標を計算し、**1つの THREE.Points（加算・数千点）** で赤/青ランプ。夜だけ visible。ドローコール+1。
- **車ライト**: 各車にヘッド/テール用の加算スプライト4枚（プール）。夜は遠距離の車本体を非表示にして**ライトだけ描く**（計画通り「光の川」演出＝描画節約）。さらに遠景はメッシュ無しの光点を道路エッジ上で流す偽トラフィックも可。

### B. 道路の実体化＋街灯
- OSM実道路はグリッドでなく任意角度 → Kenneyタイルのグリッド敷設は不向き。**エッジ単位で road-straight を「引き伸ばしインスタンス」**（長さ=エッジ長にscale、向き=atan2）＋交差点(次数3+)ノードに丸/四角パッチ。全て**モデル別InstancedMesh**（建物と同じ方式）＝ドローコール数個。
- **街灯**: エッジに沿って Nメートル間隔・垂直オフセットで light-curved をインスタンス配置（向き=道路向き）。夜は先端に加算スプライト点灯（Points併用）。
- 車は既にエッジ上を走るので**自動的に新道路上を走る**。
- stage-editor のスプライン道路の向き問題は別件（都市モード改修）。plateau-flyはOSM由来なので本方式が正。

### C. 生活NPC（住所×スケジュール）— SimCity方式の3層LODシミュレーション
- **層0=データのみ（全員）**: エージェント200人などを軽量オブジェクトで保持 {id, home:建物rec, work:高層rec, schedule[], 現在地(グラフ上の辺+t), 状態}。更新は1Hz＋時刻変化時（timeSkip早送り＝RPG-Game方式）。コスト無視レベル。
- **層1=近傍のみ実体化（プレイヤー40m以内、上限6-10体）**: **VRMプール**（ken等の基本モデル3種程度を使い回し）から取り出して配置・歩行アニメ・セリフ。離れたらプールへ返却。
- **通勤経路**: 既存のOSM道路グラフで **A***（ノード数~1.5万でも一人分数ms、结果キャッシュ）。歩行は車と同じエッジ追従＋歩道オフセット。
- **住所**: 建物recのインデックス＝番地（既存）。「自宅の内装」は番地シードで既に決定的 → **プレイヤーがNPCの在宅時間に自宅へ入ると、内装スポーン時にそのNPCも配置**（在宅判定はスケジュールから逆算するだけ。データ保存不要）。
- **セリフ**: swing-catch の speech lib を移植。活動別セリフ（ScheduleEntryのspeech）を統合。
- **生活アクション**: 椅子/ベッド/風呂の**アンカーJSON**（家具モデル→[{action:'sit'|'sleep'|'bath', pos, ry}]）。**spot-editor**（entry-editor流用：家具GLBにマーカーを打つ）で調整、bite-editor同様の位置合わせ。アニメはVRMA割当（後日ユーザー用意）。

### D. プロシージャルNPC（VRoid質問への回答）
- **結論: 書き出し済みVRMからVRoidパラメータへは戻れない**（VRoid Studioのパラメータ・髪プリセットは .vroid プロジェクト側にのみあり、VRMはベイク済みメッシュ）。ランタイムでVRoid生成APIも無い。
- **現実解＝少数ベース×バリエーション**（超軽量）:
  1. ベースVRM 3〜5体（体型/性別違い）
  2. **MToonの色係数を個体ごとに変える**（服・髪のhueシフト＝uniformのみ、テクスチャ共有）
  3. 身長スケール±5-8%、（あれば）表情morphの初期値
  → 3体×色8種×身長=見た目約100バリエーション、メモリはVRM3体分だけ。
- どうせ**同時実体化は最大10体**（層1）なので「何百体のモデル」はそもそも不要。数百人はデータ、見えるのはプール＋色替え。

### E. 手配度＋パトカー
- RPG-GameのWantedSystemの概念移植: wanted 0-5。**目撃条件**（近傍にNPCがいる状態でken攻撃/捕食/車破壊）で上昇、時間で減衰。
- パトカー: 既存の車システムに kind:'police' を追加。wanted≥1で数台スポーンし**プレイヤー最寄り道路ノードへA*追跡**。赤青の点滅スプライト＋サイレン(Audioループ, 距離減衰)。wanted高でビーム対象になる敵として拡張余地。

## 段階提案（各段テスト可能）
1. **P1 昼夜＋空＋ネオン＋車ライト**（見た目のインパクト大・独立・軽い）
2. **P2 道路実体化＋街灯**（車が既に走ってるので即映える）
3. **P3 NPC基盤**: gameClock＋エージェント層0＋プールVRM層1＋A*通勤＋speech移植
4. **P4 住所連動**: 在宅NPC（内装に出現）＋生活アクション＋spot-editor
5. **P5 手配度＋パトカー**
6. **P6 NPC見た目バリエーション**（色/身長システム）

## リスク/要確認
- SkyMesh のWebGPU動作（three 0.184で存在確認要。だめなら自作グラデーションドーム＝既にtps-flightにある空の拡張で足りる）
- VRMプールの着せ替え色変更はMToonNodeMaterialのuniformアクセス方法を要確認
- NPC歩行アニメ: Catwalk_Walk_Forward流用（ken実績あり）
