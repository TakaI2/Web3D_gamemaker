# 要件定義 — サイキッカー空中アクション（TPS / swing-catch ベース）

## 概要
`swing-catch`（FPS視点のキャッチ＆投げサンドボックス）をベースに、**TPS（三人称）視点でサイキッカーを操作して空を舞う**アクションを新規作成する。
プレイヤーキャラは可視の VRM（**Joy_reborn**）。ステージは swing-catch と同じ（浮遊オブジェクトもそのまま）、NPC は今回いない。

- 新ディレクトリ: `tps-flight/`（仮。`index.html` + `tps-flight.js`）。hub に登録。
- 既存資産を最大限流用: アリーナ生成・浮遊オブジェクト生成・グラブ/発射ロジック・VRMマント(lib/vrm-cloth)・VRMアニメ。
- レンダラは WebGPU（swing-catch と同じ）。

## 確定した方針（ユーザ確認済み）
1. **アニメ紐付け**: `timeline.json` に **VRMA 参照(`vrma` フィールド)を埋め込む**。cloth-preview を拡張して保存/読込時に保持し、既存 `Joy_reborn_*.timeline.json` にも付与。ゲームは timeline を読むだけで「体(VRMA)＋マント(grip)」を再生。
2. **高度(上下)移動**: **カメラのピッチに追従**。前進方向＝カメラ視線の3D方向（上を向いて前進＝上昇）。
3. **カメラ調整**: ゲーム内に**簡易調整UI**（距離・高さ・追従遅れ・FOV 等、localStorage保存）。専用エディタは作らない。

## 機能要件

### FR-1 プレイヤー（Joy_reborn）
- 起動時に `public/npc/Joy_reborn.npc.json` を読み込み、VRM＋マント(cloth)を生成して可視表示。
- 初期位置はアリーナ中央付近の空中。重力なし（飛行）。

### FR-2 TPS カメラ
- キャラを中心に**球面座標（yaw/pitch/距離）**でカメラが回る。マウス移動で yaw/pitch を変更。
- カメラは**スプリング的にキャラ移動へわずかに遅れて追従**（位置・注視点ともに減衰補間）。
- ピッチには上下limitを設ける（真上/真下で破綻しない）。
- 簡易調整UI: 距離 / 高さオフセット / 追従の遅れ(減衰) / FOV / マウス感度 を調整、localStorageに保存・復元。

### FR-3 移動操作（飛行）
- 入力: `W/↑`前進 `S/↓`後退 `A/←`左平行移動 `D/→`右平行移動。
- 前進方向は**カメラの視線方向(3D)**、左右はカメラ右方向。前進時はキャラの体の向きをその方向へ滑らかに向ける。
- 移動は加減速（加速・減衰）あり。最大速度・加速度はパラメータ化。
- 各状態に対応アニメを再生（下表）。グラブ中は移動アニメを `Fly_f2` に差し替え。

### FR-4 アニメ状態機械（timeline 駆動）
状態ごとに対応 timeline を再生。timeline は `vrma`(体) + grip(マント) を内包。
状態遷移はブレンド（クロスフェード）でなめらかに。

| 状態 | トリガ | timeline (cloth+vrma) | 備考 |
|---|---|---|---|
| 静止 | 入力なし | `Joy_reborn_Fly_idle` | ループ |
| 前進 | W/↑ | `Joy_reborn_Fly_f` | ループ |
| 後退 | S/↓ | `Joy_reborn_Fly_back` | ループ |
| 左移動 | A/← | `Joy_reborn_Fly_L` | ループ |
| 右移動 | D/→ | `Joy_reborn_Fly_R` | ループ |
| グラブ中の移動(全方向共通) | グラブ状態＋移動入力 | `Joy_reborn_Fly_f2` | ループ |
| グラブ動作 | キャッチ発動 | `Joy_reborn_capcher1` | ワンショット |
| ショット | ショット発動 | `Joy_reborn_cas1_L1` | ワンショット（cape_attack_L から変更） |

### FR-5 キャッチ / ショット（マウス）
- swing-catch 同様にマウスボタンで**キャッチ（引き寄せ）**と**ショット（発射）**。
- 対象は浮遊オブジェクト（NPCは今回なし）。
- **キャッチ時**: 引き寄せたオブジェクトは**プレイヤーの目の前に吸着**（Joy_reborn が抱える/引き寄せている見た目）。吸着位置＝キャラ前方の固定アンカー（体の向きに追従）。`capcher1` を再生。
- **ショット時**: 抱えているオブジェクトを前方（カメラ視線方向）へ発射。`cape_attack_L` を再生。
- グラブ中は移動アニメが `Fly_f2` 系に切替（FR-3/FR-4）。

### FR-6 ステージ / オブジェクト
- アリーナ・浮遊オブジェクトは swing-catch のものをそのまま流用（`buildArena` / `spawnObject` / `loadStage` / models）。
- 当たり判定・反射・スピンなど既存挙動を維持。

### FR-7 cloth-preview 拡張（前提作業）
- VRMA をドロップダウン/ファイルで読み込んだとき、その**ファイル名を保持**。
- `exportTimeline()` に `vrma` フィールド（例 `"move_Flying_front.vrma"`）を追加保存。
- timeline 読込時に `vrma` があれば**対応VRMAを自動ロード**（任意）。
- 既存 `Joy_reborn_*.timeline.json` に `vrma` を付与（下記マッピングをユーザ確認のうえバックフィル、または cloth-preview で再保存）。

## VRMA マッピング（要ユーザ確認）
`public/vrma/` に存在する飛行モーション候補から提案。※印は確証なし、確認/指定が必要。

| timeline | 提案する体VRMA | 状態 |
|---|---|---|
| Joy_reborn_Fly_f | `move_Flying_front.vrma` | 前進 |
| Joy_reborn_Fly_back | `move_Flying_back.vrma` | 後退 |
| Joy_reborn_Fly_L | `move_Flying_left.vrma` | 左 |
| Joy_reborn_Fly_R | `move_Flying_right.vrma` | 右 |
| Joy_reborn_Fly_idle | `idle.vrma` ※（浮遊idle、仮。要確認） | 静止 |
| Joy_reborn_Fly_f2 | `move_Flying_front02.vrma` ※（仮。要確認） | グラブ中移動 |
| Joy_reborn_capcher1 | `attack01.vrma` ✅確定 | グラブ |
| Joy_reborn_cas1_L1 | `HumanF@MagicAttackDirect1H01_L - Cast.vrma` ✅確定 | ショット（cape_attack_L から変更） |

→ ✅は確定。※（idle / f2）は仮置き。idleは飛行向きの浮遊idleが望ましいが専用VRMAが無いため `idle.vrma` を仮採用（後で差し替え容易）。
→ VRMA名にスペース/`@`を含むもの（Cast）は fetch 時に `encodeURI` で URL エンコードする。

## 非機能要件
- 60fps目標。WebGPU/TSL。マント布シミュは既存どおり（重くしない）。
- TS/型の制約・class禁止（lib流用部分はJS）。CLAUDE.md準拠。
- モバイル(タッチ)対応は今回は必須としない（将来課題。swing-catchのタッチは流用検討）。

## スコープ外 / 将来課題
- NPC（敵）戦闘、ダメージ/HUD、フロー連携（勝敗postMessage）は今回対象外（土台は残すが無効化）。
- 上下移動の専用キー、カメラ専用エディタ、タッチ最適化。

## 主要リスク / 設計で詰める点
- `lib/vrm-cloth` の `createVRMCloth({timeline})` は生成時に1つの timeline 前提。**状態ごとに grip(掴み)トラックを切り替える**必要 → ランタイムで timeline/グリップ有効グループを差し替えるAPIが要るか確認（Stage2）。
- 体VRMAの**クロスフェード**（AnimationMixer の複数Action / fadeIn/Out）。
- timeline 駆動でのマント grip 再生（フレーム同期）と、移動による基準位置の追従。
- 「目の前に吸着」アンカーの位置・補間と、ショット発射の初速。
