# 設計 — Ragdoll Editor

決定: B=関節ごとの maxBend(度) 調整のみ / A=別ファイル `public/ragdoll/<npc>.ragdoll.json` / C=複数ピン対応。

## 全体構成
- 新規ページ `ragdoll-editor/index.html` + `ragdoll-editor/ragdoll-editor.js`（素のJS・WebGPU）。
- 初期化・VRM読込・更新順序は `character-editor` を踏襲。
- `lib/vrm-ragdoll.js` を再利用。**後方互換の加点的拡張**を3点のみ加える（既存ゲームへ無影響）。
- 保存APIの許可dirに `ragdoll` を追加（`vite.config.ts`）。`public/ragdoll/` を新設。

## lib/vrm-ragdoll.js 拡張（後方互換）
1. **複数ピン**: `updateRagdoll(rd, dt, env)` に `env.pins = [{bone, pos}]` を追加。
   - 反復ループ内で、各ピン粒子を `pos` に固定（既存の単一 `env.pinBone/pinPos` はそのまま温存）。
   - ループ後に該当粒子の `prev` も `pos` に合わせ速度を消す。
2. **angleLimit にボーン名付与**: `createRagdoll` で各 `angleLimits` 要素に `bone: d.bone` を追加（編集UIの紐付け用）。
3. **API追加**:
   - `setBoneMaxBend(rd, bone, deg)`: `rd.angleLimits` の該当 `maxBend` を `deg*π/180` に即時更新（走行中反映）。
   - `listBoneLimits(rd)`: `[{bone, deg}]` を返す（UI構築用）。
   - 関節/骨リンクは既存の `rd.particles`/`rd.constraints` を直接参照（新関数不要）。

## データ形式 `*.ragdoll.json`（`public/ragdoll/`）
```jsonc
{
  "version": 1,
  "id": "lily",
  "boneMaxBend": {          // 関節名 → 許容逸脱角(度)
    "neck": 40, "spine": 35, "chest": 30, "upperChest": 30,
    "leftShoulder": 30, "rightShoulder": 30,
    "leftUpperArm": 90, "rightUpperArm": 90,
    "leftLowerArm": 90, "rightLowerArm": 90,
    "leftUpperLeg": 70, "rightUpperLeg": 70,
    "leftLowerLeg": 95, "rightLowerLeg": 95
  },
  "params": { "gravity": -22, "stiffness": 1.0, "iterations": 8, "foldLimit": 0.6 }  // 任意
}
```
- ゲーム側適用（別タスク可）: `createRagdoll(vrm, { boneMaxBend, ...params })`。

## 画面構成
- **左パネル**（操作）: VRMソース(NPC select＋VRMファイル読込) / ラグドール「崩す・戻す」トグル＋「もう一度落とす」 /
  「関節・骨を可視化」チェック / ピン用 主要ボーンのチェックリスト / 「保存」「読込」。
- **右パネル**（調整）: 関節ごとの maxBend(度) スライダー（`listBoneLimits` で生成・`setBoneMaxBend` 即反映）/
  「既定値にリセット」 / （任意）gravity/stiffness/iterations/foldLimit。

## 可視化
- `vizGroup`（scene直下・ワールド座標）。ラグドール中＆可視化ON時に毎フレーム更新。
  - 関節: 共有 SphereGeometry の Mesh を粒子数ぶん。位置=`rd.particles[i].pos`。ピン中は色変更（黄）。
  - 骨リンク: `LineSegments`（`rd.constraints` の i,j から2点ずつ）。position 属性を毎フレーム更新。
  - `renderOrder` 上げ＋`depthTest:false` でメッシュ上に表示。OFF/非ラグドール時は `vizGroup.visible=false`。

## 更新ループ（character-editor 準拠）
```
const dt = clock.getDelta();
if (ragdoll && ragdoll.active) {
  const env = { floorY: 0 };
  if (pins.size) env.pins = [...pins].map(b => ({ bone: b, pos: pinPos[b] }));
  updateRagdoll(ragdoll, dt, env);
} else if (ragdoll && ragdoll.recovering) {
  updateRagdollRecovery(ragdoll, dt);
} else if (mixer) { mixer.update(dt); }
if (vrm) vrm.update(dt);
updateViz();
controls.update();
renderer.render(scene, camera);
```

## ピンの扱い
- `pins: Set<boneName>`、`pinPos: {bone: Vector3}`。
- ON: その時点の `rd.particles[idxOf[bone]].pos` を `pinPos[bone]` にスナップ。OFF: pins から除外。
- Re-drop: `setRagdollActive(false)`→アイドル姿勢へ→`setRagdollActive(true)` で再スナップ。ピン位置も取り直し。

## 保存API拡張
- `vite.config.ts` の `allowed` に `ragdoll: 'ragdoll'` を追加。`public/ragdoll/` を作成。初版は「保存/読込（ファイル名=id）」。

## 段階実装（タスク）
1. lib 拡張（複数ピン・bone付与・setBoneMaxBend/listBoneLimits）＋既存ゲーム無影響確認。
2. vite.config.ts に ragdoll 許可dir追加、public/ragdoll 作成。
3. ragdoll-editor ページ雛形（WebGPU初期化・VRM読込・ON/OFF）。
4. 可視化（関節球＋骨線）。 5. ピン固定（複数）。 6. maxBend スライダー（即反映）＋リセット。
7. 保存/読込。 8. hub にカード追加。 9. 実機確認。

## リスク・留意
- ラグドール中の可視化は毎フレーム BufferAttribute 更新＝1体なら軽い。
- 可視化は粒子のワールド座標をそのまま使い、VRM scene のスケール/回転に依存しない。
- 既存ゲームは `env.pins` を渡さないので複数ピン拡張の影響なし。
