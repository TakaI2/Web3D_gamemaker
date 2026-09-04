# 設計: 海からの侵攻（スパイダーキャリア母艦化）

要件: `.tmp/requirements.md`

## 全体方針

海の位置は `.map.json` の `water[]` から実行時に算出する（座標のハードコード無し）。母艦モードは
**エピソードのルール** `rules.seaCarrier` で有効化し、EP2（arden）だけに適用する。EP1（floz）は
「戦闘機が海側から飛来する」だけが効き、母艦は従来どおり分岐後に市街へ湧く＝既存フローを壊さない。

## 1. 海ジオメトリの算出（新規）

`mapWater` のうち **`level === 0` かつ 最大矩形の面積の10%以上** を海タイルとみなす
（河川の末端も level が 0 付近になるため、面積で相対的に弾く）。

```
seaInfo = {
  rects,                 // 海タイル
  x0,x1,z0,z1,           // 和集合BBox
  cx,cz,                 // 面積重心
  level,                 // 水面高（=0）
  dirX,dirZ,             // 市街中心 → 海重心 の単位ベクトル
  shoreX,shoreZ,         // 市街中心から dir 方向に進んで最初に海に入る点（＝海岸）
}
```

- 市街中心は `collBoxes`（建物コリジョン）の範囲中心。ステージ構築後に一度だけ算出して保持。
- 海岸点は市街中心から dir 方向に 20m 刻みで前進し、最初に海タイル内に入った点。

| 関数 | 役割 |
| --- | --- |
| `ensureSeaInfo()` | 未計算なら算出して返す（`collBoxes` が要るので遅延実行） |
| `inSeaXZ(x,z)` | 海タイル内判定 |
| `seaAngleFrom(pos)` | 指定地点から見た海の方角（`jetAirPos` の角度規約 x=cos, z=sin に合わせる） |

## 2. スパイダーキャリア（母艦）

`SP` へ追加する定数: `offshore: 900`（海岸からの沖出し距離）／`deckClear: 42`（水面から胴体までの高さ）

### 出現（`spawnSpider`）

| | 母艦モード（`rules.seaCarrier` かつ海あり） | 従来モード |
| --- | --- | --- |
| 位置 | 海岸点 + dir × `SP.offshore`（海BBox内にクランプ） | 現状どおり市街内ランダム |
| 胴体高 | 水面 + `SP.deckClear`（脚を伸ばして直立） | 接地 + `SP.hipY` |
| 足先 | 海底（`groundYAt`＝最深 -47m。脚リーチ `L1+L2=126` 以内に収まる） | 地面 |
| 状態 | `carrier:true, mode:'wait', invuln:true` | `carrier:false, mode:'roam'` |

### 更新（`updateSpider`）

- `mode === 'wait'`: 徘徊・脚ステップ・なぎ倒し・接地追従を**スキップ**。武装（主砲/ミサイル/腹部砲門）と
  脚IK（画面内のみ）は従来どおり動かす。
- `spiderAdvance()`（分岐トリガ）: `mode='advance'`, `invuln=false`, `target=海岸点`, `retargetT=999`。
  以降は**既存の徘徊コードがそのまま動く**（海岸へ歩く → 到着すると自動で市街内のランダム目標へ切替＝蹂躙開始）。
- `spiderHit()`: `invuln` の間はダメージを通さず、弾かれる演出（ヒットFX＋金属音）のみ。

## 3. 発進

### 戦闘機（`jetAirPos`）

```
母艦が健在(carrier) → 甲板上のランダム点（半径30〜70, 高さ 胴体上面）から発進
それ以外            → 海の方角 ±60° のランダム角・距離 r で飛来（従来の全方位ランダムを置換）
海が無いマップ      → 従来どおり全方位ランダム（mytown 等の後方互換）
```

### ウォーカー（`spawnWalker`）

母艦が健在なら**母艦の真下の海底**に出現し、`target = 海岸点` / `retargetT = 999` を与える。
既存の徘徊コードが海岸へ歩かせ、到着後は自動で市街目標に切り替わる＝上陸してそのまま蹂躙。
解禁条件（`spawnAllow.walker`＝損耗50%のイベント）は**現行のまま**。

## 4. イベント連携

- `runEvAction()` に `{"type":"advance","enemy":"spider"}` を追加 → `spiderAdvance()`。
- `ep1_events.json` の `attr75`（badRoute 分岐）に上記アクションを追加。既存の `spawn` は残すので
  EP1（母艦なし）は従来どおり市街に spider が湧く。
- `enemyAllowed()`:
  - `spider`: `rules.seaCarrier` なら本編開始時から許可（沖に常駐させるため）。
  - `walker`: 排他ルールを `spider && !spider.carrier` に限定（母艦は供給源なので排他しない）。

## 5. 影響範囲

| ファイル | 変更 |
| --- | --- |
| `city-fly/city-fly.js` | 海算出の新規関数群、`spawnSpider`/`updateSpider`/`spiderHit`/`jetAirPos`/`spawnWalker`/`enemyAllowed`/`runEvAction` |
| `public/episodes/ep2.ep.json` | `rules.seaCarrier: true` |
| `public/cityfly/ep1_events.json` | `attr75` に `advance` アクション追加 |

## 6. 検証観点

1. arden で母艦が沖に立ち、胴体が水面より上／脚が海底に届いている。
2. 戦闘機が母艦から発進し、海側から街へ来る。
3. 待機中の母艦は無敵（HPが減らない）。
4. `advance` 発火で海岸へ歩き出し、上陸後に市街を徘徊・破壊する。
5. ウォーカー解禁後、母艦直下に湧いて海中を歩き上陸する。
6. floz（EP1）は従来どおり動く（母艦は分岐後に市街へ湧く／戦闘機は海側から飛来）。
7. mytown（海なし）で従来どおり動く。
