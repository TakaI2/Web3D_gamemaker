# 設計 — cloth-editor グリップ刷新 ＋ cloth-preview VRMAドロップダウン

## A. cloth-editor グリップ刷新

### 現状
- 2グループ（左手/右手）。`leftGripSet`/`rightGripSet`（頂点index集合）。
- GPU: vertexParams.w の gripCode(0/1/2/3) で識別。グループの全頂点が**単一の手ターゲット**(leftGripTargetUniform 等＝手位置＋単一offset)へ吸着（回転なし）。
- キー: L=左手、R=右手（押下中ON）。
- cloth.json: `leftGripIndices`/`rightGripIndices`/`handGrabOffsets{left,right}`。
- 消費: lib/vrm-cloth.js, fps-cloth-vrm, swing-catch がこの形式を読む（timeline grip トラックで左右手をON）。

### 新仕様（要件）
1. グループを4つに: **L手(leftHand) / R手(rightHand) / L肘(leftLowerArm) / R肘(rightLowerArm)**。
2. 各グループは**任意数のグリップ頂点**を持てる（L手_1, L手_2…）。
3. **頂点の重複禁止**: 1頂点は1グリップ点のみ（他グループ・アンカー・ピンとも排他）。
4. 各頂点は**対応関節の位置＋回転**でオフセット吸着（＝ボーンアンカーと同じ方式。割当時に localOffset を捕捉）。
5. キー: **R=右手 / L=左手 / E=R肘 / K=L肘**（押下中、そのグループの全点をグリップ）。

### データモデル（cloth-editor 内部）
- `gripMap: Map<vertexIdx, { group, boneName, boneNode, localOffset:Vector3 }>`
  - group ∈ {'leftHand','rightHand','leftLowerArm','rightLowerArm'}
  - 割当時に `localOffset = inverse(boneWorldQuat) * (vertexWorld - boneWorld)` を捕捉（位置＋回転追従）。
- 排他: 割当時に当該頂点を pinnedSet / anchorMap / 既存gripMap から除去。

### GPU シミュ改修（グリップ＝活性化アンカー化）
- vertexParams.w(コード) を再定義: `0=なし / 1=アンカー(常時) / 2=L手 / 3=R手 / 4=L肘 / 5=R肘`。
- 既存の per-vertex `bonePinTargetBuffer`(vec3) を **アンカー＋グリップ共用**にする（頂点の吸着先ワールド座標）。
  - 毎フレームCPU更新: アンカー頂点＝従来通り。グリップ頂点＝`boneWorldPos + boneWorldQuat * localOffset` を書く。
- グループ活性マスク `gripMaskUniform`(vec4: x=L手,y=R手,z=L肘,w=R肘, 各0/1)。
- シェーダ: code==1 → 常時 target へ吸着。code 2..5 → 対応マスク>0.5 のとき target へ吸着（力0・位置直接）。
- 旧 leftGrip*/rightGrip* の単一uniformは廃止（per-vertex buffer + mask に統合）。

### UI（左パネル グリップ節を作り替え）
- 編集グループ選択（4ボタン: L手/R手/L肘/R肘 のトグル編集モード）。
- マーカー頂点クリックで現在グループへ追加/削除（重複は自動排他）。色でグループ識別（L手=青/R手=橙/L肘=水/R肘=黄）。
- 各グループの点数表示＋「グリップをリセット」。
- offset は割当時に自動捕捉（手動微調整UIは初版なし）。

### キー（押下中グリップ）
- keydown: R/L/E/K → 対応グループの mask=1。keyup → 0。シミュ実行中のみ有効。

### cloth.json 形式（後方互換）
- **追加**: `gripPoints: [{ vertexIdx, group, boneName, localOffset:[x,y,z] }]`（新リッチ形式）。
- **維持(互換)**: `leftGripIndices`/`rightGripIndices` は leftHand/rightHand グループの頂点で引き続き書き出す。`handGrabOffsets` も維持（左右手グループ先頭点の offset 等で代表値）。
  → これにより **ゲーム(lib/vrm-cloth)・cloth-preview は無改修で従来通り左右手グリップを消費可能**。肘グリップはエディタ専用の新機能（games未対応）。
- 読み込み: `gripPoints` があれば優先（4グループ復元）。無ければ legacy(leftGripIndices/rightGripIndices)＋handGrabOffsets から leftHand/rightHand を復元。

### 影響範囲（games は無改修）
- lib/vrm-cloth.js / fps-cloth-vrm / swing-catch は legacy フィールドを読むので**変更不要**。
- 注意: ゲームは従来の「単一手ターゲット」挙動のまま（per-vertex回転offsetはエディタ表示のみ）。リッチ形式をゲームにも反映するのは別タスク。

## B. cloth-preview VRMAドロップダウン
- 現状: VRMA はファイル選択(input file)のみ。
- 変更: `/vrma/manifest.json` を取得し**ドロップダウン**に一覧表示。選択で `/vrma/<name>` を fetch→Blob→既存 `loadVRMA(file)` で読込（cloth-editor と同じ作法）。
- 既存のファイル読込ボタンは残す（任意）。

## 段階実装
1. (A) gripMap データモデル＋排他ロジック。
2. (A) GPU: vertexParams コード再定義・target buffer 共用・mask uniform・シェーダ分岐。
3. (A) 毎フレーム grip target 更新（位置＋回転）。
4. (A) UI（4グループ編集・色・一覧・リセット）。
5. (A) キー R/L/E/K。
6. (A) cloth.json 書出/読込（gripPoints＋legacy互換）。
7. (B) cloth-preview VRMAドロップダウン。
8. 実機確認（編集→キーでグリップ→書出→再インポート→games読込が壊れない）。

## 確認したい点
- A-6 の互換方針（legacy維持＋gripPoints追加）でよいか。肘グリップは当面エディタ専用（games未対応）で良いか。
- offset は割当時自動捕捉のみ（手動微調整UIなし）で良いか。
