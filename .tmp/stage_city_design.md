# プロシージャル都市：Stage Editor 改良 設計（TPS_plan.txt 準拠）

## 推奨アーキテクチャ：Spline-Authored, Grid-Baked, Chunk-Streamed City
道路/線路を**編集可能な CatmullRom スプライン**で描き（計画の明示要件）、それを**固定1.0ユニットのグリッドにラスタライズ**、**シード付き・チャンク単位でベイク**した item 列を生成。**ゾーン塗り**で kit/密度/高さを制御。衝突は swing-catch の Octree+Capsule に**安価なボックスプロキシ**を食わせて再利用 → 屋上が「normal.y>0」判定で自動的に歩ける。tps-flight に Capsule コントローラと **FLY↔WALK** を移植し、降下して屋上に着地できる。

（審査スコア: SPLINE案 matchesPlan 9 / Hybrid editorUsability 8。統合で両者の強みを採り、冗長フォーマットを排除して simplicity を確保。）

## 実測グラウンドトゥルース（推測でなく計測）
- **MODULE = 1.0**（GLB の POSITION 境界で確認）。road-straight/bend/crossroad = 1×1、road-curve = 2×2、road-roundabout = 3×3。tile-high 天面 = 0.25。全タイル原点中心なので n·90° 回転で綺麗に接続。**ただし runtime は road-straight の Box3.x から cell を1回だけ導出**（ハードコードしない）。
- **建物はグリッド非タイル**：bbox で自由配置。suburban ~1.0–1.4幅、city 0.84–2.32幅・最大3.15高、skyscraper ~1.3幅・最大5.47高。全モデルは y-min=0（接地）。
- **テクスチャは全キット外部参照**：各GLBが `Textures/colormap.png`（相対URI）を参照。**GLBと同じ相対位置にTexturesフォルダを配置**しないと無地になる。3キットで colormap は別物（共有不可）。→ dist で各キットの `Textures/` を同居させる（or gltf-transform で埋め込み）。
- **swing-catch の衝突はそのまま流用可**：`Octree.fromGraphNode`、`capsuleIntersect`、`playerOnFloor = normal.y>0`、GRAVITY 25 / JUMP 9 / STEP_HZ 120。上向き天面のボックスは自動で「立てる」。
- **tps-flight は衝突ゼロ**（ROOM=30 への数値クランプのみ）・**build スクリプトも無し**（新規要）。
- **LODシルエットは不一致**：low-detail-building-a(0.5×0.5×2.0) ≠ building-a(0.88×0.94×1.29)。クロスフェード不可 → 遠距離での swap＋距離で隠す。suburban/skyscraperは真のlow無し → col から**箱インポスタ**生成。
- **パレット除外**：models manifest は `*_GLB format` のみ拾う → Kenney の `*/Models/GLB format` を追加で拾うようフィルタ拡張が必要。

## データ形式 `.city.json`（v3, 保存先 public/cities/, /api/save に `city->cities` 追加）
2層のみ：**authored**（再生成元＝スプライン/ゾーン/seed/params/手置き）＋ **chunks**（ベイク済みストリーミング単位）。冗長表現なし。swing-catch互換は任意の `.stage.json` 併記で対応。
```jsonc
{ "version":3, "kind":"city", "seed":1337,
  "world": { "cellRef":1.0, "chunkCells":16, "grid":{"cols":128,"rows":128,"origin":[-64,0,-64]}, "bounds":[-64,-64,64,64] },
  "kits": { "roads":"kenney_city-kit-roads/Models/GLB format", "suburban":"kenney_city-kit-suburban_20/Models/GLB format", "downtown":"city_GLB format" },
  "authored": {
    "splines": [ { "id":"s1","kind":"road","closed":false,"tension":0.5,"points":[[x0,z0],[x1,z1]] } ],
    "zones": { "cell":4.0,"cols":32,"rows":32,"origin":[-64,-64],"data":"<base64 Uint8: 0empty 1suburb 2downtown 3station 4park>" },
    "stations": [ {"x":12,"z":-8} ],
    "params": { "suburbSpacing":2,"suburbSetback":0.6,"downtownFill":0.85,"stationRadiusCells":8,"parkTreeDensity":0.35,"jitterDeg":6,"jitterPos":0.15 },
    "manualProps": [ { "model":"city_GLB format/building-c.glb","x":0,"y":0,"z":0,"ry":0,"scale":1,"col":{"hx":0.44,"hy":1.3,"hz":0.47,"walkTop":true} } ]
  },
  "chunks": [ { "id":"3_5","cell":[3,5],"bounds":[minX,minZ,maxX,maxZ],
    "items":[ { "model":"...","x":12.5,"y":0,"z":-3.5,"ry":1.5708,"scale":1,"kind":"building","col":{"hx":0.44,"hy":1.29,"hz":0.47,"walkTop":true},"low":"...low-detail-building-a.glb" } ] } ]
}
```
- item は既存 `{model,x,y,z,ry,scale}` の厳密なスーパーセット（旧リーダー互換）。`ry` はラジアン、`y=0` 接地。`col` は Box3×scale/2 を事前計算（runtime は bbox 計算ゼロ）。`walkTop:true`＝着地可能な平天面。`low` が無い kit は col から箱インポスタ。
- **決定性契約**：`generate(seed, authored) -> chunks[]` は純関数。per-cell RNG = `mulberry32(hash(seed,col,row))`。1スプライン編集は触れたセルだけ再ロール、未編集チャンクはバイト同一。chunks[] は authored から再構築可能なキャッシュ。

## 生成ルール（ゾーン別）
1. **道路ラスタライズ**：各スプラインを弧長 `getPointAt(u)` で cell 間隔サンプル→ROADセル化＋接線保存。4近傍接続でタイル選択（対2=straight / 隣接2=bend / 3=T(intersection) / 4=crossroad / 1=end）、ry は近傍ビットマスクの n·90°。高曲率2×2=curve(2×2予約)、駅ハブ=roundabout(3×3予約)。占有グリッドで重複防止。
2. **前面＋向き**：道路隣接の非道路セルが建設可、向きは道路方向（atan2）＝正面が道路向き。
3. **ゾーン別配置**：SUBURB=frontageに `building-type-*` を spacing 間隔＋fence/path/tree。DOWNTOWN=`building-a..n` を fill 率で（>1cellは2×2予約）＋detail装飾。STATION=半径内で skyscraper/高層バイアス（半径falloff）＋hub タイル。PARK=建物無し・blue-noiseで木/planter散布・歩ける地面。
4. **コライダ発生**：solid item に `col=Box3*scale/2, walkTop=true`。木/フェンス/awningは col 無し（視覚のみ）。各配置を chunk へ割当。
5. **手置き**：`authored.manualProps[]` は再生成で不変（v1は per-item override 無し＝regenerateが正）。

## LOD＋ストリーミング（真上俯瞰の最悪ケース対策）
- **チャンク**（16×16 cells）ごとに**単一ティア LOD**（per-instance で隠せないため per-chunk）：
  1. **NEAR**：(model)ごと `InstancedMesh`（full）＋衝突。
  2. **FAR**：low LOD or 箱インポスタの InstancedMesh（衝突なし）。
  3. **AERIAL**（高高度で全景）：チャンクを **1枚の統合スカイラインメッシュ**（`mergeGeometries`）へ。道路も1枚に統合。→ 描画コール ≈ 2×可視チャンク数（建物数に非依存）＝俯瞰が軽い核心。
- **高度連動半径**でnear/far/aerialを切替。**1フレーム1チャンク**の build/dispose（`disposeObject`流用）。GLBテンプレは**共有グローバルキャッシュに一度だけ**（~40メッシュのみfetch）。frustumCulled＋チャンクAABBカリング＋FogExp2、camera.far拡張。
- eager=`.city.json`＋~40テンプレ＋chunk index / on-demand=チャンクメッシュ構築（CPU行列埋めのみ）。

## 衝突＋歩ける屋上
swing-catch の Octree+Capsule を**そのまま**、**箱プロキシ**を食わせる（GLB三角スープは 120Hz×5 で高コスト＝罠）。NEARチャンク load 時に col ごとの `BoxGeometry` 群＋地面タイルで `Octree.fromGraphNode`、unload で dispose。プレイヤーは重なる1〜3チャンクの octree と衝突（都市サイズに非依存）。箱の天面 normal.y>0 で屋上=地面と同じく立てる。`collisionRadius≈1` リングのみ octree 構築。

## エディタUX（stage-editor 拡張）
俯瞰OrbitControls＋raycast-to-ground を土台に、ground/GridHelper を grid.cols×rows へ拡大。左にモードツールバー：
1. **SPLINE**：地面クリックで制御点、ハンドルドラッグ（pickInstance流用）→dirtyチャンクのみdebounce再生成。右クリックで点削除。road/rail切替。
2. **ZONE**：ゾーンラスタをブラシ塗り（4色＋消しゴム、半透明オーバーレイ）。
3. **STATION**：駅点スタンプ。
4. **PARAMS**：seed＋各パラメータ、**REGENERATE**（runtimeと同じInstancedMesh経路＝性能確認兼用）、コライダ枠/LOD強制トグル。
5. **PROP(旧)**：手置きprop→manualProps[]。
6. **PALETTE FIX**：manifest フィルタ拡張で Kenney タイルを表示、kitタイルは scale=1 固定。
7. **SAVE**：`{dir:'city', filename:'<id>.city.json'}`、任意で `.stage.json` 併記。

## ランタイム消費（tps-flight）
新 `loadCity(cityRef)`：city.json 読込→共有テンプレキャッシュ構築（modelURL encode＋bottom-center）。**Textures 同居必須**。ストリーミングループ（1チャンク/フレーム）。NEARチャンクで箱octree構築＋Capsule＋FLY/WALK。降下時 capsuleIntersect normal.y>0.5＋低降下速度→WALK（gravity25/jump9/capsule r0.35）。推進/ジャンプでFLY復帰。ROOMクランプは world.bounds 安全網へ。旧 `.stage.json` は従来 loadStage で温存、swing-catch 無改変。**deploy**：`build:tps-flight.mjs` 追加、`_copy-used-models.mjs` を chunks/manualProps のmodel＋各kitの `Textures/colormap.png` 収集へ拡張。

## 段階計画
- **Phase 0（1–2日）Plumbing**：/api/save に `city:'cities'`＋ manifest、models manifest に `*/Models/GLB format` 追加、mulberry32＋MODULE導出、共有GLBテンプレキャッシュ抽出。
- **Phase 1（5–7日）最小縦断**：1本の道路スプライン→数軒自動配置（道路向き）＋箱col→保存→tps-flightで飛ぶ→降下→**屋上に着地・歩行**。tps-flightにCapsule+updatePlayer移植＋FLY/WALK＋着地判定＋single Octree。
- **Phase 2（5–7日）ゾーン＋本生成器**：ゾーン塗り＋駅スタンプ＋PARAMS→Regenerateで一貫都市（suburb/downtown/station/park）、決定性・dirtyチャンク再生成。curve/crossroad/roundabout の多セル自動タイル。
- **Phase 3（6–9日）Instancing＋LOD＋ストリーミング**：InstancedMesh化（editor WebGLで先に検証→tps-flight WebGPU）、3ティア（NEAR/FAR/AERIAL統合メッシュ）、高度連動チャンクマネージャ、真上俯瞰の描画/FPS検証。
- **Phase 4（4–6日）ストリーミング衝突＋着地堅牢化**：per-chunk箱octreeのbuild/dispose、FLYでのdeflection、WALK歩行、屋上端ジッタ/めり込み対策、ROOM=30 撤去→world.bounds。
- **Phase 5（2–3日）Deploy＋仕上げ**：build:tps-flight.mjs、_copy-used-models 拡張（kit Textures同梱）、LODポップ調整、任意 .stage.json エクスポート。

## 要確認（統合の推奨付き）
1. **線路(rail)**：どのキットにも鉄道アセット無し。→**推奨: 保留**（schemaに kind:'rail' 予約のみ、Phase3後に実アセット導入時に同機構で対応）。
2. **swing-catch互換**：flat items を読む。→**推奨: 併記 .stage.json エクスポート**（無改変・冗長なし）。
3. **遠景LODソース**：low-detailはシルエット不一致・suburban/skyscraperは無し。→**推奨: AERIALは col から箱インポスタ統一**（俯瞰に最適）、downtown a..n の中距離のみ真のlowを任意併用。
4. **手編集の上書き**：→**推奨: v1は manualProps のみ保持（regenerateが正）**。フル override は desync 리스크で見送り。
