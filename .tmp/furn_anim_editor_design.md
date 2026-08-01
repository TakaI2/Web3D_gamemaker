# 家具インタラクション・アニメエディタ 設計書（2026-07-14）

## 要望
- 家具ごとにアニメーションを調整（椅子に座る/ベッドで寝る=家具との位置関係が必須）
- bite-editor的な「家具の吸着点」との相互作用
- FBX/VRMエディタ的な四肢・頭・腰IKつきのアニメーションタイムライン作成
- 作ったアニメを家の中のアクション（くつろぐ/寝る等）に割当

## 再利用する既存資産
| 資産 | 場所 | 用途 |
|---|---|---|
| TwoBoneIK（解析的2ボーンIK・rest向き非依存） | src/core/TwoBoneIK.ts (104行) | 手足のIK → lib/ へJSポート |
| SpineIK | src/core/SpineIK.ts (65行) | 腰→頭の脊椎ならし → 同ポート |
| VrmaBuilder（VRMAバイナリ生成） | src/core/VrmaBuilder.ts (254行) | タイムライン→本物のVRMA書き出し → 同ポート |
| 吸着点＋ギズモ＋キーフレームUI | bite-editor | アンカー編集のUXパターン |
| 生活スケジュール/スポット | lib/room-life.js + room-editor | 再生先（プレビュー/ゲーム共用） |
| 部分ループ | timeline loopStart/End 機構 | 座りゆらぎ等のループ |

## アーキテクチャ
新規 `furn-anim-editor/`（WebGL・hub掲載）。シーン = 家具1点（1.5倍=ゲーム内装スケール）＋ ken VRM。

### 1. 吸着アンカー（bite-editor方式）
- 家具**カテゴリ**（bed/sofa/chair/armchair/toilet/bath/kitchenUnit…= room-genのカテゴリ）単位で
  「NPCの腰の基準位置+向き」をギズモで指定 → 同カテゴリ全モデルに汎化（bite alignと同じ思想）
- 確認用にカテゴリ内のモデルを切替表示（bedSingle/bedDouble等でズレを目視）

### 2. IKポージング
- IKハンドル6+1: **腰(位置+回転)・頭(注視/SpineIK)・左右手・左右足(TwoBoneIK+ポールベクタ)**＋胸(FK回転)
- ハンドルはTransformControlsギズモ。ポーズはVRM正規化ボーンに書き込み
- ミラー（左→右コピー）、リセット（Tポーズ/前キー）

### 3. タイムライン
- キーフレーム方式: 任意時刻に「全ヒューマノイドボーンのローカル回転＋hips位置」をベイクして記録
- 再生=キー間slerp補間。ループ再生トグル（座りゆらぎ等はクリップ全体ループで作る）
- 書き出し=VrmaBuilderで**本物の.vrma**を生成

### 4. 保存とデータフロー
- vite /api/save をbase64バイナリ対応に拡張（encoding:'base64'＋allowlistに vrma→vrma 追加）
  → public/vrma/furn_<cat>_<action>.vrma として保存＝既存の再生系がそのまま読める
- `public/npc/furniture-anims.json` を**v2**へ拡張:
```jsonc
{ "sleep": { "vrma": "furn_bed_sleep.vrma", "cat": "bed",
             "anchor": { "pos": [0, 0.45, 0], "ry": 1.57 } },   // 家具原点基準・スケール後m
  "sit":   { "vrma": "furn_sofa_sit.vrma", "cat": "sofa", "anchor": {...} },
  "walk": "Catwalk_Walk_Forward.vrma" }                          // v1形式(文字列)も後方互換
```
- 再生側（room-editor生活プレビュー→将来はゲームの在宅NPC）:
  スポット到着時に anchor があれば「家具の位置+向き ∘ anchor」へNPCをスナップしてVRMA再生。
  無ければ従来どおり家具の前で待機ポーズ

## 実装フェーズ
- **F1 静止ポーズ版**: エディタ骨格（家具カテゴリ選択/アンカーギズモ/IKポージング）
  ＋1フレームVRMA書き出し＋api/saveバイナリ拡張＋anims.json v2
  ＋room-editor生活プレビューがアンカー再生対応 → **「座る・寝る」が即ゲームの見た目になる**
- **F2 タイムライン**: キーフレーム/補間/ループ/複数フレームVRMA（寝返り・食事の手の動き等）
- **F3 ゲーム統合**: plateau-flyの在宅NPC(spawnResidents lifeSpot)がanims.json v2を再生

## リスク・注意
- VRMAはVRM正規化空間: IK結果を normalized bone へ書く（bite/ragdollで実績あり）
- hips位置トラックの座標系（VRMA=正規化ルート相対）— VrmaBuilderの入力仕様に合わせる
- アンカーはカテゴリ汎化なので個別モデルで数cmズレは許容（気になればモデル別上書きを後付け）
