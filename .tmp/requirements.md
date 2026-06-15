# 要件定義 — Ragdoll Editor（ラグドール調整エディタ）

## 背景・目的
swing-catch / fps-cloth-vrm のラグドール（`lib/vrm-ragdoll.js`・自前PBD）が、被弾/掴みで崩れる際に
**関節が不自然な方向に曲がる**。原因は角度制限が「レスト方向からの対称コーン（`maxBend`半角）」のため、
膝・肘が横や逆方向にも許容角内で曲がること。これを **対象NPCで実際に崩しながら、関節ごとに回転制限を
調整し、即シミュレーションで確認** できる専用エディタを作る。チューニング結果はゲーム側で読み込んで適用する。

## 対象ユーザー・利用文脈
- 開発者（本人）が hub から開いて、各NPCのラグドール挙動を視覚的に詰める。

## 機能要件（FR）

### FR-1 hub への追加・新規ページ
- `ragdoll-editor/`（index.html + ragdoll-editor.js）を新設し、hub の「エディタ」セクションにカードを追加。
- WebGPU、OrbitControls、床・ライト・HDR は character-editor の定型を踏襲。

### FR-2 NPC 選択と読込
- `public/npc/manifest.json` から `.npc.json` 一覧を取得し select で選択。
- npc.json の base64 VRM を Blob 化 → GLTFLoader+VRMLoaderPlugin で読込（character-editor の `fetchBundle`/`dataURIToBlob`/`loadBundleObject` 準拠）。
- VRMA（アイドル）があれば再生（ラグドール解除時の見栄え用）。
- VRMファイルの直接読込（`<input type=file accept=.vrm>`）も可能にする（任意のVRMで試せる）。

### FR-3 ラグドール ON/OFF
- ボタンで `setRagdollActive(rd, true/false)` を切替。ON中はアニメmixerを止め `updateRagdoll` を毎フレーム実行、
  OFFで `updateRagdollRecovery` により姿勢復帰（character-editor の update 順序準拠）。
- 「もう一度落とす（Re-drop）」: 現在のボーン姿勢から再スナップして落下し直す。

### FR-4 グラブポイント固定シミュレーション
- 主要ボーン（hand/foot/head/hips/chest 等）をチェックで **ピン対象** に指定。
- ピンしたボーン粒子をその時点のワールド位置に固定し、そこから吊り下がるようにシミュレーション。
  - 単一ピン＝既存 `env.pinBone/pinPos`。
  - **複数ピン**＝`lib/vrm-ragdoll.js` に `env.pins=[{bone,pos}]`（配列）対応を追加（後方互換・加点的拡張）。
- ピン位置はギズモ等で動かせると理想だが、初版は「現在位置で固定」で可（移動は任意）。

### FR-5 関節・剛体の可視化
- ラグドール中、`rd.particles`（関節）を球、`rd.constraints`（骨リンク）を線で重畳表示（トグルON/OFF）。
- 可能なら各関節の角度制限（コーン）を半透明で可視化（任意・段階実装）。
- 可視化は VRMメッシュの上に `renderOrder` を上げて描画（cloth-editor のマーカー球準拠）。

### FR-6 関節ごとの回転制限調整（即シミュ）
- 関節（angleLimits の対象＝childを持つ関節）ごとに **`maxBend`(度)** スライダーを用意。
- スライダー変更を **走行中のラグドールへ即反映**（`rd.angleLimits` の該当 maxBend を live 更新）。
- 「全リセット（既定値へ）」ボタン。

### FR-7 保存・読込
- 調整した `boneMaxBend`（関節名→度）と主要パラメータ（gravity/stiffness/iterations/foldLimit など任意）を
  JSON として保存。保存先は `public/ragdoll/<npc名>.ragdoll.json`（保存API許可dirに `ragdoll` を追加）。
- 同ファイルを読込して再現できる。
- ゲーム側（swing-catch / fps-cloth-vrm）が createRagdoll 時に `boneMaxBend` を読み込んで適用できる導線
  （初版はエディタでの保存まで。ゲーム側適用は別タスクでも可）。

## 非機能要件（NFR）
- WebGPU（`three@0.184/webgpu`）。既存 `lib/vrm-ragdoll.js` を再利用（lib改変は後方互換の加点のみ）。
- 60fps を維持（1体・可視化込み）。重い依存を増やさない。
- 既存ゲームの挙動を壊さない（lib拡張は引数追加で既存呼び出しに無影響）。

## スコープ外（初版では実装しない／論点B次第）
- 「曲げの方向（軸）」を限定する **ヒンジ型/非対称の角度制限**（膝・肘を一方向のみに）→ 効果が大きいが lib の
  制約モデル拡張が必要。
- ツイスト（捻り）制限の追加。
- npc.json への埋め込み保存（初版は別ファイル `ragdoll.json`）。

## 確認したい論点（設計前に決めたい）
- **A. 出力と消費**: 別ファイル `public/ragdoll/<npc>.ragdoll.json` に保存しゲームが読込適用、で良いか。
- **B. 回転制限の深さ**: 初版は「関節ごとの maxBend(度) 調整」までか、「膝/肘を一方向のみに曲げるヒンジ型制限」まで含めるか。
- **C. 複数ピン**: グラブ点固定は複数同時対応すべきか（lib拡張要）。単一でも良いか。
