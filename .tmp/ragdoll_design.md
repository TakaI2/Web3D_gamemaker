# VRM ラグドール・モジュール 設計書

## 0. 目的・要件（合意済み）

- **トリガー連動**: 被弾などのイベントから呼べる。`grab` のように **関数で ON/OFF** 切替。
- **本格ラグドール**: 全身が重力で崩れ落ち、床に倒れる。
- **再利用可能**: `fps-cloth-vrm`（Megu NPC）と将来的に `swing-catch` でも使う。特定シーンに依存しない。
- 既存方針に従い **物理エンジン不使用**・自前 PBD（Position Based Dynamics）。`class` 不使用。

## 1. 方式: PBD スケルタルラグドール

各ボーン関節を「粒子」、ボーンを「距離拘束」として扱う Verlet/PBD。
布シミュと同系統の安定した手法。

### 1.1 関節（粒子）とボーンチェーン

VRM humanoid 標準ボーンから以下の関節ツリーを構築（`getNormalizedBoneNode` で取得できたものだけ採用）:

```
hips ─┬─ spine ─ chest ─ (upperChest) ─ neck ─ head
      ├─ leftUpperLeg ─ leftLowerLeg ─ leftFoot
      ├─ rightUpperLeg ─ rightLowerLeg ─ rightFoot
      └─ (chest起点) leftShoulder ─ leftUpperArm ─ leftLowerArm ─ leftHand
                     rightShoulder ─ rightUpperArm ─ rightLowerArm ─ rightHand
```

- **粒子** = 各ボーンノードのワールド位置（生成時にキャプチャ）。
- **距離拘束** = 親子粒子間の距離（= 生成時のボーン長）を一定に保つ。
- **コライダー半径** = 既存定義（head 0.10, chest 0.14, hips 0.13 …）を流用し、床・任意で自己衝突に使用。

### 1.2 物理ステップ（active 時のみ）

1. 各粒子に重力を加算（固定 fixed=false。hips も自由）。
2. Verlet 積分（`x += (x - xPrev) * (1-drag) + g*dt²`）。
3. 距離拘束を N 回（既定 8）反復で満たす。
4. 床衝突: `y < groundY + r` を `groundY + r` にクランプ＋接地摩擦。任意で `env.bounds`（箱）にクランプ＝swing-catch アリーナ対応。
5. （任意・後回し）関節角度制限・自己衝突。

### 1.3 ボーンへの書き戻し（実装の山場）

各ボーンについて:
- 生成時に「親→子方向の**レスト方向**（正規化ボーン空間）」と、正規化親ノードのワールド回転を記録。
- 毎フレーム、現在の `子粒子 - 親粒子` 方向を計算。
- レスト方向→現在方向 への回転（`Quaternion.setFromUnitVectors`）でワールド回転を求め、
  正規化親のワールド回転で割って**ローカル回転**に変換 → `normalizedNode.quaternion` に代入。
- `hips` は正規化ノードの **position** も粒子位置（モデルローカル換算）で更新。
- ツイスト（軸回り捻り）は再現しない（スイングのみ）。ラグドールには十分。
- 呼び出し側が毎フレーム既に行う `vrm.update(dt)` で実ボーンへ反映される。

## 2. 公開API（grab ライクなトグル）

```js
// lib/vrm-ragdoll.js
export function createRagdoll(vrm, opts);     // 関節/拘束/レスト姿勢を構築。生成のみ（非アクティブ）
export function setRagdollActive(rd, active);  // ON/OFF。ON時は現在姿勢を粒子へスナップ
export function updateRagdoll(rd, dt, env);    // active時のみ物理+書き戻し。非activeは即return
export function applyRagdollImpulse(rd, impulse, boneName); // 被弾の撃力（boneName省略で全身）
export function disposeRagdoll(rd);            // 後始末
```

- `opts`: `{ gravity=-20, drag=0.02, iterations=8, collisionRadiusScale=1, bones?=customList }`
- `env`（シーン非依存の衝突抽象）:
  - `{ floorY: number }` … 最小構成（水平床）。
  - 任意 `{ bounds: {min,max} }` … 箱型アリーナ（swing-catch）。
  - 任意 `resolveCollision(pos, r) => correctedPos` … 高度な衝突（octree等）。
- `rd`（内部状態・プレーンオブジェクト）: `{ vrm, particles[], constraints[], bones[], active, restQuats(Map), ... }`

### 呼び出し側の責務
- ラグドール **ON 時**: VRMA アニメの更新を止める（`mixer.stopAllAction()` 等）。
- 毎フレーム: `updateRagdoll(rd, dt, env)` → その後 `vrm.update(dt)`。
- **OFF（復帰）時**: `setRagdollActive(rd,false)` で記録済みレスト回転へ戻し、アニメ再開。
  - v1 は瞬時復帰。任意で数フレームの lerp ブレンドを後追加可能。

## 3. 配置・共有戦略

- 単一ソース: **`lib/vrm-ragdoll.js`**（CDN three を import、ローカル依存なし）。
- ソースのデモは `import { ... } from '../lib/vrm-ragdoll.js'`（vite dev でそのまま動く）。
- **ビルド時**: 各 `scripts/build-*.mjs` が
  1. `lib/vrm-ragdoll.js` を `dist-*/vrm-ragdoll.js` へコピー、
  2. デモ js 内の `../lib/vrm-ragdoll.js` を `./vrm-ragdoll.js` に置換してコピー。
  - → dist は自己完結（単一ソースを維持しつつデプロイ可能）。

## 4. fps-cloth-vrm への統合（第1ターゲット）

- NPC 読み込み後に `npc.ragdoll = createRagdoll(npc.vrm, {...})`。
- **トリガー**: 既存の被弾/当たり判定（無ければ簡易に「クリックでレイキャスト命中したNPC」）で
  `setRagdollActive(npc.ragdoll, true)` ＋ 撃力 `applyRagdollImpulse(...)` ＋ アニメ停止。
- 復帰: キー（例 `R`）or 一定時間後に `setRagdollActive(false)` ＋ アニメ再開。
- 床: `env = { floorY: <NPC足元のステージ床Y> }`。
- 群衆クローン（9体）は v1 では対象外 or 全員ラグドール化はオプション。

## 5. swing-catch への展開（将来）

- 現状 swing-catch は VRM 非搭載。NPC を出すなら VRM ロードを追加。
- ラグドール物理は `env.bounds` で箱アリーナにクランプ。
- グラブ機構と組み合わせ: 掴んだら hips 粒子を手アンカーに拘束 → 投げると崩れ落ちる、等に発展可能。

## 6. リスク・割り切り

| 項目 | 対応 |
|------|------|
| ボーン回転書き戻しの正確さ | 実機で姿勢を見ながら調整。まず方向追従のみ、捻り無視。 |
| 不自然なポーズ（関節制限なし） | v1 は制限なしで様子見。破綻するなら円錐制限を追加。 |
| 自己衝突なし（腕が胴に貫通） | v1 許容。気になればカプセル間押し出しを追加。 |
| 正規化↔実ボーン空間 | `getNormalizedBoneNode` + `vrm.update()` 経由で吸収。 |
| 復帰の見た目 | v1 瞬時。違和感あれば lerp ブレンド。 |

## 7. v1 スコープ

- [x] PBD 全身ラグドール（重力＋距離拘束＋床衝突）
- [x] `create/setActive/update/applyImpulse/dispose` API
- [x] fps-cloth-vrm の主役 NPC#0 に統合＋トリガー＋復帰
- [ ] 関節制限・自己衝突・復帰ブレンド（必要時に追加）
- [ ] swing-catch 統合（別ターゲット）
