# 振り回しキャッチ（Swing Catch）設計書

要件: `.tmp/grab_game_requirements.md`

## 1. 全体構成

既存単体デモ（`fps-cloth/`）の構成・コードスタイルを踏襲する。

```
swing-catch/
  index.html         # fps-cloth/index.html ベース。UI/操作説明/HUD を本ゲーム用に差し替え
  swing-catch.js     # ゲーム本体（FPS制御 + 飛行体 + 発射体 + 掴み/スプリング/投擲）
scripts/
  build-swing-catch.mjs   # index.html + swing-catch.js を dist-swing-catch/ にコピー
package.json         # "build:swing-catch" スクリプト追加
```

- Three.js v0.184 `webgpu` + 必要なら最小限の TSL。マテリアルは基本 `MeshStandardMaterial`（標準でOK）。
- `class` は使わず、状態はプレーンオブジェクト + モジュールスコープ変数 + 関数で表現。

## 2. シーン / レンダラ / カメラ

`fps-cloth.js` の `init()` を踏襲。

- `WebGPURenderer({ antialias:true })`、`setPixelRatio(min(dpr,2))`、`NeutralToneMapping`。
- `PerspectiveCamera(75, aspect, 0.05, 200)`、`rotation.order = 'YXZ'`。
- ライト: Ambient + Directional + Hemisphere。
- 背景色 + 薄いフォグ。
- 非WebGPU環境は `#error-msg` を表示して終了（fps-cloth と同パターン）。

## 3. アリーナ（FR-9）

閉じた箱型ルーム。

- 内寸を定数化: `ROOM = { x: 14, y: 9, z: 14 }`（中心原点、`±x/2` 等が内壁）。
- 床・天井・4壁を `BoxGeometry` で作成（壁は内側が見えるよう `BackSide` か、薄い箱を外側に配置）。
- プレイヤー衝突用に床と壁を `Octree` に登録（既存 `Capsule`/`Octree` 流用）。
- 飛行体・発射体の壁衝突は **解析的に**処理（Octree レイキャストは使わず、内壁平面とのクランプ＋反射）。
  - 有効移動域: `[-ROOM.x/2 + r, +ROOM.x/2 - r]`（y,z も同様。床は y=0 基準に合わせ `[r, ROOM.y - r]`）。

## 4. プレイヤー制御（FR-1, FR-2）

`fps-cloth.js` の以下をほぼそのまま流用:

- ポインターロック（canvas クリックでロック、ESC で解放、`#lock-overlay` 表示制御）。
- `mousemove` → `playerYaw/playerPitch`（感度 0.002、pitch クランプ）。
- `keydown/keyup` → WASD + Space ジャンプ、`Capsule` + `Octree.capsuleIntersect` で衝突・床判定。
- `camera.position = playerCollider.end`、`camera.rotation.set(pitch, yaw, 0, 'YXZ')`。
- 落下時リスポーン（箱型ルームなので床があるため通常は不要だが保険として残す）。

追加: `mousedown/mouseup/contextmenu` を**ゲーム操作**に割り当てる（§7）。

## 5. 飛行オブジェクト（FR-3）

### 状態（プレーンオブジェクト）
```js
{
  mesh,                 // THREE.Mesh
  radius,               // 衝突半径（形状の外接球）
  pos: Vector3,         // 物理位置（mesh.position と同期）
  vel: Vector3,         // 速度（無重力なので等速、壁で反射）
  spin: Vector3,        // 視覚用の角速度（毎フレーム mesh.rotation に加算）
  grabbed: false,       // 掴まれているか
}
```

### 生成
- 個数 `objectCount`（既定 8、UIスライダーで 1–16）。
- 形状をランダムに選択: 球（Icosahedron）/ 箱（Box）/ 多面体（Octahedron/Dodecahedron）。
- 色は HSL で鮮やかにランダム（`MeshStandardMaterial`, roughness ~0.5, metalness ~0.1）。
- 初期位置: ルーム内のランダム。初速: ランダム方向 × 既定速度（例 3–6 /s）。
- `radius` は形状サイズから外接球で算出（簡易に固定 0.4 前後）。

### 更新（free モード = 非 grabbed）
- 無重力: `pos += vel * dt`。
- 壁反射: 各軸で有効域を超えたら位置クランプ + その軸の `vel` 符号反転 × `restitution`（既定 0.92）。
- 速度減衰: 既定なし（漂い続ける）。任意で極小ドラッグ。
- `mesh.rotation += spin * dt`（見た目の回転）。

## 6. 掴み・スプリング・投擲（FR-5, FR-6, FR-7）

### 手アンカー（hand anchor）
- 毎フレーム計算: `anchor = camera.position + forward * GRAB_DISTANCE`（既定 2.5）。
  - `forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`（カメラ前方ベクトル）。
- 視点を振ると anchor が半径 `GRAB_DISTANCE` の球面上を高速移動 → 振り回しの源。

### 掴む（左クリック down）
- すでに掴み中なら無視（同時に掴むのは1個）。
- `Raycaster` を `camera` から発射（中央照準方向）。`intersectObjects(meshes)` で範囲 `GRAB_RANGE`（既定 30）内の最手前を取得。
- ヒットしたオブジェクトを `grabbed = true`。free 積分を止め、スプリング積分に切替。

### スプリング積分（grabbed モード、保持中）
- バネ＋ダンパでアンカーへ追従:
  - `F = (anchor - pos) * STIFFNESS - vel * DAMPING`
  - `vel += F * dt`（質量1）、`pos += vel * dt`
- `STIFFNESS`（既定 60）/ `DAMPING`（既定 6）は低めダンピングで**オーバーシュート＝ブンブン感**を出す。
- 速度上限 `MAX_SPEED`（既定 40）でクランプ（破綻防止）。
- 壁めり込み防止: grabbed 中も壁クランプは行う（反射はしない）。

### 投げる（左クリック up）
- `grabbed = false` にしてスプリング解除。
- 解除時の `vel` をそのまま free 積分に引き継ぐ → 勢いがあれば飛んでいく。
- 任意で `vel *= RELEASE_BOOST`（既定 1.0、UIで増減可）。

## 7. 発射体（右クリック）（FR-4）

### 状態
```js
{ mesh, radius, pos: Vector3, vel: Vector3, ttl }
```

### 発射（右クリック down）
- `pos = camera.position`、`vel = forward * PROJECTILE_SPEED`（既定 40）。
- 小さな球メッシュ。`ttl`（既定 3秒）。
- `contextmenu` は `preventDefault()`。

### 更新
- `pos += vel * dt`（無重力）。`ttl -= dt`、0以下で消滅。
- 壁に当たったら消滅（または1回反射してもよい→既定は消滅）。
- **オブジェクト命中判定**: 各オブジェクトと球-球判定（`dist < r_proj + r_obj`）。
  - 命中時: そのオブジェクトに撃力 `obj.vel += dir * IMPULSE`（`dir` = 発射体進行方向 or proj→obj 方向、`IMPULSE` 既定 18）。発射体は消滅。
  - grabbed オブジェクトにも命中可（スプリングと撃力がせめぎ合う＝カオス感）。

## 8. 物理ステップ（NFR-2）

`fps-cloth.js` の固定タイムステップ方式を踏襲。

- `STEP_HZ = 120`、`MAX_STEPS_FRAME = 5`。
- 毎フレーム `dt = min(delta, 1/30)` を蓄積し、`1/STEP_HZ` 刻みで以下を実行:
  1. 手アンカー更新
  2. 全オブジェクト更新（grabbed→スプリング / free→等速+壁反射）
  3. 全発射体更新（移動・命中・壁/ttl 消滅）
- ステップ後に `mesh.position/rotation`（発射体は position）を状態から同期。

## 9. UI / HUD（FR-8）

`index.html`（fps-cloth ベース）を以下に差し替え:

- タイトル / `#lock-overlay` 操作説明:
  - `WASD` 移動 / `Space` ジャンプ / マウス 視点
  - 左クリック（押しっぱ） キャッチ＆振り回し / 離す 投げる
  - 右クリック 球を発射
- `#crosshair`（中央 `+`）、`#fps-counter`、`#loading`、`#error-msg`、`← 戻る`。
- 設定パネル `#ui`（スライダー、`input` で即時反映）:
  - Object 数（1–16、変更で再生成）
  - Throw Stiffness（スプリング剛性）
  - Throw Damping（スプリング減衰）
  - Projectile Speed
  - Impulse（吹っ飛ばし強さ）
  - Restitution（壁の反発）

## 10. 定数・チューニング初期値（まとめ）

| 名前 | 既定値 | 説明 |
|------|--------|------|
| ROOM | 14×9×14 | アリーナ内寸 |
| objectCount | 8 | 飛行体数 |
| OBJ_SPEED_INIT | 3–6 | 初速レンジ |
| restitution | 0.92 | 壁反発 |
| GRAB_DISTANCE | 2.5 | 手アンカー距離 |
| GRAB_RANGE | 30 | 掴み可能距離 |
| STIFFNESS | 60 | スプリング剛性 |
| DAMPING | 6 | スプリング減衰 |
| MAX_SPEED | 40 | 速度上限 |
| RELEASE_BOOST | 1.0 | 投擲倍率 |
| PROJECTILE_SPEED | 40 | 発射速度 |
| IMPULSE | 18 | 吹っ飛ばし撃力 |
| PROJECTILE_TTL | 3 | 発射体寿命(s) |
| STEP_HZ | 120 | 物理ステップ |

## 11. 今回スコープ外（設計上の割り切り）

- **オブジェクト同士の衝突なし**（壁・発射体・掴みのみ反応）。必要なら後続で球-球衝突を追加可能な構造にしておく。
- 同時に掴めるのは1個。
- サウンド・パーティクル・スコアなし。

## 12. リスクと対策

- **高速時のトンネリング**（壁/命中をすり抜け）: 速度上限 + 120Hz 固定ステップで緩和。なお残る場合はステップ数増 or スイープ判定を検討。
- **スプリング発散**: 低剛性寄り初期値 + `MAX_SPEED` クランプ + 固定ステップで安定化。
- **WebGPU 非対応**: 既存と同じエラー表示で明示。
