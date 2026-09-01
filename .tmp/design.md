# エピソード形式（EP）— 設計メモ

対象: city-fly（CyberBat）本体のステージ選択・進行の一般化
現状: `MAP_NAME === 'tutorial'` の二値で flow / story / talks / events / speech / BGM / 各種ルールを切り替えている（city-fly.js に 36 箇所の `TUTORIAL` 分岐）。
目的: 「OPシナリオ → ゲーム本編 → 分岐ED → 次エピソード」を1つの形式で表現し、EP0(tutorial)・EP1(floz)・以降のEPを同じ仕組みで足せるようにする。

---

## 1. 全体像

```
episodes/index.json        エピソード一覧（順序・タイトル・解放条件）
episodes/ep0.ep.json       EP0 チュートリアル（map=tutorial）
episodes/ep1.ep.json       EP1 フローゼ防衛戦（map=floz）
flow/ep0.flow.json         OP→本編→ED の遷移グラフ（既存 flow をそのまま流用）
story/ep0_op.story.json    OP/ED シナリオ（既存 story 形式のまま）
cityfly/ep0_talks.json     ステージ内会話
cityfly/ep0_events.json    ステージ内イベント（勝敗ポートの発火もここ）
```

エピソード = **1つの flow ＋ その flow が使うデータ束（map/talks/events/speech/BGM）＋ ルール**。
OP・本編・ED の並びは既存 flow グラフ（`lib/flow-runner.js`）がすでに表現できているので、**flow は作り直さない**。足りないのは「エピソード束の定義」と「EP から EP への連結」の2点だけ。

## 2. `<id>.ep.json` 形式

```json
{
  "format": "episode",
  "version": 1,
  "id": "ep1",
  "no": 1,
  "title": "EP1 フローゼ防衛戦",
  "subtitle": "DEAD ATMOS ASSAULT",
  "map": "floz",
  "stage": "city",
  "flow": "ep1.flow.json",
  "data": {
    "talks":  "ep1_talks.json",
    "events": "ep1_events.json",
    "speech": ["ken.speech.json"],
    "bgm":    "Sound_Wave.ogg"
  },
  "rules": {
    "wanted": true,
    "buildingEntry": true,
    "cars": true,
    "agents": true,
    "special": true,
    "paramsHud": true,
    "fixedHour": null
  }
}
```

- `stage`: `"rooms"`（チュートリアル型・実行時に部屋を構築）/ `"city"`（マップから街を生成）。現状 `TUTORIAL` が担っている分岐の本体。
- `flow` / `data.*`: 省略時は `<id>.flow.json` `<id>_talks.json` … と **id 接頭で自動解決**。既存ファイル名を rename すれば設定ゼロで動く。
- `subtitle`: タイトル画面の英字（現在 `TUTORIAL ? 'TRAINING PROGRAM' : 'DEAD ATMOS ASSAULT'` とハードコードされている箇所）。
- `rules`: 現在の `TUTORIAL` ゲート群（手配度・建物進入・車・生活NPC・必殺技解放・戦況パラメータHUD・時刻固定）の置き換え先。既定値は `stage` から導く（rooms → 全部 false・fixedHour 12）ので、EP0 は `rules` を書かなくてよい。

## 3. EP 連結（分岐）

`end` ノードに次エピソードを持たせる。flow-runner は変更不要（`data` を素通しするだけ）。

```json
{ "id": "n_end_good", "type": "end", "data": { "next": "ep2" } },
{ "id": "n_end_bad",  "type": "end", "data": { "next": "ep3" } },
{ "id": "n_end",      "type": "end" }
```

- `next` あり → そのエピソードへ遷移。
- `next` なし → 従来どおりタイトルへ（EP0 はこれ。一本道なので分岐 ED を持たない）。
- **分岐の判定は既存の仕組みをそのまま使う**: `battle` ノードのポート（win / bad / lose）を `events.json` が発火 → ポートごとに別の ED story → その先の `end` の `next` が次 EP を決める。つまり「EP1 での行動 → EP2 か EP3 か」は events とグラフの結線だけで表現できる。
- ポートを増やしたい場合: `NODE_TYPES.battle.ports` の固定3つをやめ、ノード側 `data.ports` があればそれを使う（flow-editor も同様）。既定は現状の3つ。

### 遷移の実装
- 次EPが**同じ map** → `softRestart()` 相当（VRM/シェーダを保持したままステージだけ作り直す。実測 7秒 → 0.1秒）。
- 次EPが**別の map** → `location.href = '?ep=<id>'`（地形・建物キットごと入れ替わるためリロードが素直）。
- 進行の保存: `localStorage['cyberbat.progress'] = { cleared: ['ep0'], branch: { ep1: 'good' }, last: 'ep2' }`。タイトルから続きを選ぶ・EP選択画面を出す土台。

## 4. 解決順（どの EP を起動するか）

1. `?ep=<id>` があればそれ。
2. なければ `window.DEFAULT_EP`（dist ビルド時に注入。現在の `DEFAULT_MAP` と同じ方式）。
3. なければ `?map=<name>` から `episodes/index.json` を引いて `map` が一致する EP。
4. どれも無ければ**現状の二値フォールバック**（`map=tutorial` → tutorial_*、それ以外 → cityfly_*）。既存 URL とビルドを壊さないための保険。

`MAP_NAME` は EP 決定後に `ep.map` で上書きする。`?map=` 単独指定は今までどおり動く。

## 5. ビルドスクリプトへの反映

`EP=ep1 npm run build:cityfly` で、
- 既定エピソードを `window.DEFAULT_EP` として注入（`DEFAULT_MAP` も EP から導出）。
- **同梱するデータをエピソード定義から決める**: `ep.map` のマップ1本、flow から到達可能な story 群、`data.*` の talks/events/speech/BGM。
- 現在の `const TUT = DEFAULT_MAP === 'tutorial'` による「街用アセットを丸ごと除外」も、`ep.stage === 'rooms'` に置き換え。これで floz ビルド時に「全マップ同梱」（build-cityfly.mjs:63）や不要キットの混入を避けられる。dist-cityfly が 147MB、dist-cyberbat が 69MB という差はここに効く。

## 6. 段階計画

- **Phase 1（骨格）**: `ep.json` 形式・解決順・データ選択の一般化（flow/story/talks/events/speech/BGM/タイトル文言）。`TUTORIAL` は `ep.stage === 'rooms'` に置換。EP0/EP1 の定義ファイルを追加。既存ファイルは EP 名へ rename（別名を残すなら `data` に明記）。
- **Phase 2（ルール化）**: 36箇所の `TUTORIAL` ゲートを `rules.*` 参照へ置き換え。
- **Phase 3（連結）**: `end.next` による EP 遷移、localStorage 進行保存、タイトルの続きから開始。
- **Phase 4（ビルド）**: `EP=` 駆動の同梱決定。flow-editor に `end.next` と可変ポートの編集UI。

## 7. 未確定事項

- EP2 / EP3 の中身（マップ・条件）は未定。形式だけ先に用意する。
- EP1 の分岐条件（何をすると good / bad / secret か）は events 側の設計待ち。
- 既存 `mytown`（cityfly_*）を EP として扱うか、フォールバックのまま残すか。

---

## 8. OP裏読み込みの実測（2026-09-01 / ?prof=1）

計測基盤: `profPhase()` で工程ごとの所要時間とコマ落ちを記録、`profTimeline` が50ms超のコマ落ちを
gameMode・走っていた工程つきで時系列に残す。`__fly.buildProf` / `__fly.profTimeline`。

### 判明したこと

- **OP中のコマ落ちは全部、裏の読み込みが原因**。シナリオ側（話者切替・GIF背景・行送り）由来はゼロ件。
- チュートリアルOPの内訳（対策前）: 1684ms=部屋ステージのcompileAsync / 1223ms=NPC・ドール（?nonpc=1で消滅） / 960ms=部位溶解ウォーム / 94ms=着弾FX
- 街(floz)の建物工程 4481ms のうち、実作業（配置生成・GLB読込・インスタンス集約・ネオン・カーブ材質）は
  **計190msでコマ落ちゼロ**。フリーズは **compileAsync の3455ms（単発2172ms）に集中**。
- 公園389ms・森167ms・FX・NPC読込はコマ落ちほぼゼロ＝OP裏に置いて安全。

### compileAsync は分割できない（重要）

`compileAsync(サブツリー, camera, scene)` に割って間でフレームを譲っても、コマ落ちは減らない。
**「シーンに新しい中身が入った後の最初の1回」が全部を払う**作りで、渡したのが板ポリ1枚
(MeshBasicMaterial) でも同じ約3秒がかかった。ユニットの順序を逆にすると、先頭に来た別のユニットが
同じコストを払う＝オブジェクト固有ではないことを確認済み。
→ **ステージのコンパイルはOP再生より前に済ませるしかない**。

### 部位溶解ウォームの罠

`dmgWarmT` を「秒」で数えていたため、読み込み中の低fps（1フレーム数百ms、dtは1/30に丸め）では
実時間で10秒近くかかり、タイトル中に終わらずOP再生中にコンパイルが走っていた。
→ **実描画フレーム数で数える**方式へ変更（8フレーム）。パイプラインは初回描画で焼かれるので数フレームで足りる。

### 振り分け（rules.startWhen）

- `'world'`（既定）= ステージ構築＋コンパイルまで待ってからタイトルを解禁。**OP中のコマ落ち0件**（実測）
- `'cast'` = 会話キャストが揃えば開始し、ステージはOPの裏で構築。開始は早いが1〜2秒のコマ落ちが出る
- 実測ではこの機体で解禁 10.5秒('world') vs 10.9秒('cast')＝**ステージ構築の方がキャスト先読みより早く終わるため、'world'にしても実質待たされない**
- OP前に必須: プレイヤーVRM / 会話キャスト / **捕食アセット(2138ms・単発2030msのフリーズ)** / 部位溶解ウォーム / ステージのcompileAsync
- OP裏で安全: 道路網の各サブ工程・建物の実作業・公園・森・FX・NPC読込（いずれも実測でコマ落ちほぼゼロ）
