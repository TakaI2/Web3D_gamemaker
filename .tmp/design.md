# 設計 — グリップの名前付きグループ化 ＋ タイムライン グループ単位有効化

決定: 名前付きグループを任意数 / ゲーム(lib/vrm-cloth)でも動く。後方互換は維持。

## 現状
- cloth-editor: グリップは L手/R手/L肘/R肘 の**4固定グループ**（各=ボーン+グラブ点offset+頂点集合）。GPUは per-vertexターゲット+vec4マスク。
- cloth-preview / lib/vrm-cloth(ゲーム): **旧2ハンドモデル**（leftGripSet/rightGripSet, leftGripActiveUniform, timeline grip track は side:left/right）。
- ゲームは npc.json の timeline grip(left/right) で NPC が自分のマントを握る（lib/vrm-cloth）。

## 新データモデル
### grip グループ（任意数・名前付き）
1グループ = `{ id, name, bone, offset:[x,y,z], vertices:[..] }`。
- bone: VRM humanoid ボーン名（leftHand/rightHand/leftLowerArm/rightLowerArm/… 既定4つ＋任意）。
- 同じ bone に複数グループ可（例 L手_開 / L手_閉）。
- グラブ点 worldPos = boneWorldPos + boneWorldQuat × offset（位置+回転追従）。各グループの全頂点がその点に吸着。
- 頂点は1グループのみ（重複禁止、ピン/アンカーとも排他）。

### cloth.json（後方互換）
```jsonc
"gripGroups": [ { "id":"leftHand","name":"L手","bone":"leftHand","offset":[x,y,z],"vertices":[..] }, … ],
// 互換(旧games/preview): leftHand/rightHand bone のグループから合成
"leftGripIndices":[..], "rightGripIndices":[..], "handGrabOffsets":{ "left":[..],"right":[..] }
```
読込: gripGroups があれば優先。無ければ旧 leftGripIndices/rightGripIndices → 既定 leftHand/rightHand グループへ。

### timeline.json（後方互換）
```jsonc
{ "kind":"grip", "groupId":"leftHand", "ranges":[{start,end}] }
```
読込: groupId があれば優先。無ければ旧 `side:'left'/'right'` → groupId 'leftHand'/'rightHand'。

## GPU モデル（3アプリ共通へ統一）
グループ数に依存しない per-vertex 方式に統一（vec4マスクを廃止）:
- vertexParams.w(code): 0=なし / 1=アンカー(常時) / 2=グリップ。
- `pinTargetBuffer`(vec3, per-vertex): アンカー=bone+rot×localOffset / グリップ=所属グループのグラブ点worldPos。
- `gripActiveBuffer`(float, per-vertex): グリップ頂点で「所属グループがactiveなら1」。アンカーは無視。
- シェーダ: code==1 → 常時 target吸着。code==2 && active>0.5 → target吸着。
- CPU毎フレーム: アンカー target更新／各グループのグラブ点worldPos算出→所属頂点の target & active を書く。

## cloth-editor UI
- 「グリップグループ」セクション: グループ一覧（追加/複製/削除/リネーム）。各行: 色・名前・bone選択・頂点数・選択(編集対象)・active(プレビュー)トグル。
- 選択グループが編集対象: マント頂点クリックで割当/解除（重複排他）。色付きマーカー＋オフセットスライダー＋直接ドラッグ＋移動ギズモはその選択グループに対して動作。
- プレビュー: 各グループ active トグル or キー（既定4つは R/L/E/K を割当、追加グループはトグル）。シミュ中に吸着確認。
- 既定で4グループ(L手/R手/L肘/R肘)を自動生成。

## cloth-preview
- timeline grip トラックを**グループ単位**に: グループごとに1トラック（範囲ON/OFF）。グループ一覧から追加。
- 適用: lib同様 per-vertex active/target。マント読込時に gripGroups からトラック候補を作る。
- 後方互換: 旧 side:left/right トラックは groupId leftHand/rightHand として読む。

## lib/vrm-cloth.js（ゲーム）
- gripGroups を読み、per-vertex target/active(GPU)化。timeline の groupId 範囲で各グループ ON/OFF。
- 後方互換: cloth.leftGripIndices/rightGripIndices + timeline side:left/right を leftHand/rightHand グループとして扱う。
- これで fps-cloth-vrm/swing-catch は無改修で従来の左右手グリップ継続＋新グループも反映。

## 段階実装
- **Stage 1**: データモデル＋cloth-editor（名前付きグループUI・GPU per-vertex active化・cloth.json gripGroups）。
- **Stage 2**: cloth-preview（timeline グループ単位・GPU更新・互換読込）。
- **Stage 3**: lib/vrm-cloth（ゲーム）名前付きグループ＋per-group timeline。fps-cloth-vrm/swing-catch で確認。
- 各 Stage 後に実機確認。後方互換（既存 npc.json/cloth.json/timeline.json）を全 Stage で担保。

## リスク・留意
- cloth-editor の GPU を vec4マスク→per-vertex active へ作り替え（既存4グループ動作を維持）。
- 旧 cloth.json（leftGripIndices）・旧 timeline（side）・旧 npc.json は読めること。
- グループ数の上限は設けない（per-vertex方式のため）。
