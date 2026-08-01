# §2 マップエディタ（脱PLATEAU）設計書（2026-07-13）

## 目的
plateau-fly の世界データを **PLATEAU / 地理院タイル / OSM 依存から自作データへ置き換え可能**にし、
ライセンス表記を不要化する。あわせて地形・道路・建物・水面を編集できるエディタを提供する。

## 現状の外部依存（置き換え対象）
| 要素 | 現在 | ゲーム内の消費者 |
|---|---|---|
| 地形 | 地理院DEM(z14)+航空写真(z16) 11×11タイル(±3.3km) → buildAerialGround | groundGroup（groundYAtレイキャスト・着地・NPC足元） |
| 建物(旧) | PLATEAU 3D Tiles | （Kenneyモードでは未使用・表記のみ残存） |
| 道路 | OSMタイル public/roads/*.json → roadNodes/activeEdges | 道路メッシュ/車/エージェントA*/パトカー/建物生成 |
| 建物 | generateBuildings(edges, seed) 自動配置 | bldModels（描画/衝突/入室/住人） |

**重要**: ゲーム側は roadNodes / activeEdges / bldModels / groundGroup という4つの抽象しか
見ていない。この4つを .map.json から作れば全システム（昼夜/NPC/手配度/内装…）は無改修で動く。
道路一式は roadGroup 化済み＝再構築可能（2026-07-13対応済み）。

## ライセンスの注意
地理院DEMをインポートして編集した地形は**派生物＝出典表記が必要なまま**。
表記を完全に消すには「フラット or プロシージャルノイズから手作り」を選ぶこと。
エディタは両方サポートし、DEMインポート使用時はマップに `attribution:true` を記録して
ゲームが表記を自動表示する（消し忘れ防止）。

## データ形式 `.map.json`（public/maps/、/api/save に map→maps を追加）
```jsonc
{
  "format": "plateau-map", "version": 1, "name": "mytown",
  "terrain": {
    "size": 6400,           // 一辺(m)。原点中心
    "res": 257,             // 頂点数/辺（256セル、25m/セル）
    "heights": "<base64 Uint16>",   // 0..65535 → hMin..hMax へ量子化
    "hMin": 0, "hMax": 800,
    "colors": "<base64 RGB Uint8>", // 頂点色（省略時は標高/傾斜の自動配色）
    "autoColor": { "sea": "#3a6f8f", "flat": "#8a7a5f", "hill": "#4f7f47", "steep": "#7d7d7d", "flatMax": 80, "hillMin": 120, "steepSlope": 0.55 },
    "attribution": false    // DEMインポート起点なら true（表記自動表示）
  },
  "roads": [ { "id": "r1", "points": [[x,z],...], "closed": false } ],  // スプライン制御点（Y無し＝地形に追従）
  "buildings": {
    "seed": 20260706,
    "removed": ["<autoId>"],                     // 自動配置から除外
    "added": [ { "kit": "city", "model": "building-a", "x": 0, "z": 0, "ry": 0, "s": 1 } ],
    "moved": { "<autoId>": { "x":0, "z":0, "ry":0 } }
  },
  "water": [ { "x":0, "z":0, "w":400, "d":300, "level": 12 } ]
}
```
- autoId = 自動配置インスタンスの決定的ID（`kit|model|round(x)_round(z)`）。シード生成に差分だけ保存。
- heights の base64(Uint16 257²≒129KB) は JSON でも実用サイズ。

## エディタ: 新規 `map-editor/`（WebGL・hub掲載）
ユーザー要望は「ステージエディタにて」だが、stage-editor は Kenneyグリッド都市(.city.json)＋
swing-catchステージ用で座標系も保存形式も別物。**スプラインUXだけ流用した専用エディタ**を推奨
（stage-editorの cityモードはそのまま残す）。

### ツール（左パネルでモード切替）
1. **地形**: ブラシ（盛り上げ/掘り下げ/なだらか化/平坦化・半径/強さスライダ）。
   マウスレイ→地形ヒット→半径内の頂点をガウス加重で増減。Shift=反転。
   開始地形: フラット / ノイズ生成(シード) / 地理院DEMインポート(表記フラグON)。
2. **ペイント**: 自動配色（標高: 平地=茶/山=緑＋傾斜: 急=灰。しきい値スライダ）を
   ワンボタン適用 → 手動ブラシ（色選択）で上塗り。頂点カラー方式（テクスチャ不要＝軽量）。
3. **道路**: スプライン追加/点の挿入・移動・削除（stage-editor同様のハンドル操作）。
   端点スナップ（他スプラインの端/中点に吸着＝交差点）。プレビュー=ポリライン描画。
   Y は保存せず**常に地形からサンプル**（地形を変えると自動追従）。
4. **建物**: 「自動配置プレビュー」(lib/kenney-buildings.js を道路サンプル結果で実行)
   → クリック選択で移動/回転/削除、パレットから追加。差分(removed/added/moved)のみ保存。
5. **水面**: 矩形をドラッグで置き、水位(level)をスライダ調整。
6. 保存/読込: public/maps/*.map.json。

### 地形メッシュ（エディタ・ゲーム共通 → `lib/terrain.js` 新規）
- 257×257 頂点を **8×8 チャンク（各33×33頂点）** に分割した BufferGeometry 群。
  編集時は触れたチャンクだけ position/color/normal を更新（軽量）。
- vertexColors: true の MeshStandardMaterial（or Lambert）1つ＝1マテリアル。
- `heightAt(x,z)` を配列から双線形補間で提供 → plateau-fly の groundYAt を
  「マップモード時は配列参照」に差し替え（レイキャスト不要＝高速化）。
  groundGroup へのレイキャスト互換も維持（チャンクメッシュを groundGroup に入れる）。

## ゲーム統合（plateau-fly）
- 起動パラメータ `?map=<name>` で **マップモード**:
  1. terrain: lib/terrain.js でチャンクメッシュ→groundGroup（GSI/DEMフェッチをスキップ）
  2. roads: スプライン→20m間隔サンプル→ roadNodes(adj付き)/activeEdges を構築
     （交差点=スナップ済み共有点）→ buildRoadMeshes() 等は無改修
  3. buildings: generateBuildings(edges, seed) → removed/moved/added 差分適用
  4. water: 水面メッシュ（下記）
  5. 帰属表示: terrain.attribution が false なら PLATEAU/GSI 表記を非表示
- 未指定時は従来どおり八王子（後方互換）。

### 水面（軽量方針）
- 近距離(<400m): 1平面＋小シェーダ（法線テクスチャ2枚スクロール or 頂点sin波＋フレネル半透明）。
- 遠距離: マテリアル差し替えで**静的半透明平面**（アニメ無し）。カメラ距離で切替（水面ごと）。
- WebGPU注意: マテリアル種類は起動時に両方 prewarm。

## 実装フェーズ（各フェーズでユーザー確認）
- **M1 地形**: lib/terrain.js＋map-editor骨格（スカルプト/ペイント/自動配色/保存読込）
  ＋plateau-fly ?map= の地形のみ読込（道路/建物は従来のOSM継続＝混在OK）
- **M2 道路**: スプライン編集＋グラフ化＋ゲーム読込（roadGroup再構築・地形追従）。
  この時点で車/NPC/パトカーが自作道路を走る
- **M3 建物**: 自動配置プレビュー＋差分編集＋ゲーム適用
- **M4 水面**: 矩形水面＋LODシェーダ
- **M5 仕上げ**: 表記自動切替・dist ビルド対応（maps同梱）・メモリ/資料更新

## リスク・未決
- 地形25m/セルの粗さ: 道路の細かい起伏は表現されない（必要なら res=513 へ。保存サイズ4倍）
- OSM道路網(数千エッジ)を手で引き直すのは非現実的 → 脱PLATEAUマップは「新しい小さめの街」
  から始めるのが現実的（既存八王子はそのまま残す）
- 建物の自動ID: 移動/削除の追跡に座標由来IDを使うため、道路を変えると差分が無効化される
  （道路確定→建物調整、の順で使う運用とする）
