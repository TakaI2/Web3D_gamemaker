# Room Editor 設計（Phase 1: 単一部屋）

目的: kenney_furniture-kit(140 GLB, 壁/床/ドア/窓/階段＋家具) で「部屋の外殻＋家具配置」をプロシージャル生成し、手動調整して .room.json に保存する新規エディタ。

## アーキテクチャ（city-gen 方式の踏襲）
- `lib/room-gen.js` … 純関数・決定的(mulberry32)。座標はセル単位（実寸はランタイムが floorFull の bbox から TILE を実測して換算）
  - generateRoom({type, w, d, seed, windowRate}) → { shell:[{model,x,z,ry}], items:[{model,x,z,ry,fp,stackOn?}] , door:{side,cell} }
  - 外殻: 床タイル全セル + 外周壁（wall / wallWindow* / wallDoorway*、四隅 wallCorner）
  - 家具: 部屋タイプ別ルール表（壁付け大物→中央→コーナー→ラグ/小物）。占有グリッドで重なり禁止・ドア前1セルは空ける
  - stackOn: TV/PC画面など「台の上に載る」item は базbase モデル名を持ち、ランタイムが base の高さに y を合わせる
- `room-editor/` … WebGL three(esm.sh)。Orbit + TransformControls
  - パラメータ: タイプ(寝室/リビング/キッチン/風呂/書斎)・W/D(3..12)・シード・窓率 → [生成]
  - 手動: クリック選択→移動(XZ)/回転Y(Rキー切替)/Delete削除、パレット(セレクト)から追加（manual層＝再生成でも保持。生成物の編集は再生成で破棄）
  - 保存/読込: public/rooms/*.room.json（/api/save dir:'room'、/rooms/manifest.json）
- vite.config.ts: allowlist room→rooms、/rooms/manifest.json 追加
- hub にカード追加

## 検証
- .tmp/test_room_gen.mjs: 全タイプ×複数シードで 重なり0・ドア存在・決定性 を node で確認
- 壁の向き/オフセットは実物ピボット依存 → エディタで目視調整前提（WALL_OFFSET 定数化）

## 将来（Phase 2+）
フロア間取り（部屋分割＋廊下＋ドア接続）／plateau-fly のビル断面に部屋を差し込む／FPS屋内ステージ

## Phase 2: 家まるごと生成（generateHouse）設計 2026-07-11
- **BSP分割**: 家の外形W×D(〜20)を長軸で再帰分割（最小辺3・目標面積≤24）→部屋矩形リスト
- **タイプ割当**: 南辺接触の最大部屋=living(玄関)、living隣接=kitchen、最小=bathroom、残=bedroom/office
- **壁**: 外周=wall/窓(窓率)＋南のliving区間に玄関wallDoorway。内壁=隣接部屋境界(x+0.5,z)ry±π/2 / (x,z+0.5)ry=π を部屋ペアごと1回だけ
- **接続**: 部屋隣接グラフ→livingからBFS全域木→木の辺の共有境界の中央セルをwallDoorwayに。ドア前後セルは両部屋でreserved(occ=2)
- **リファクタ**: generateRoomの家具配置部を furnishRoom({type,w,d,rng,occ(reserved済),zones}) に抽出（генgenerateRoomは従来API維持）。houseは部屋ごとに hash(seed,roomIdx) のrngで furnishRoom→アイテムを部屋原点でオフセット。**id/flush.targetはidBase加算で全体一意化、run.backはz0加算**
- **出力**: {shell,items,rooms:[{type,x0,z0,w,d}],w,d} …エディタのbuildRoom/packAndFlushそのまま動く
- **エディタ**: タイプに'house'追加(w/d max20)。regenerateで分岐
- **テスト**: 複数シードで 部屋数≥3・全部屋にドア≥1・玄関あり・id一意・flush先存在・決定性
