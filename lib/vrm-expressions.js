// lib/vrm-expressions.js — カスタム表情（合成表情）の実行時登録（素JS・three-vrm 依存）
// 定義: public/cityfly/expressions.json = { "<表情名>": { "<モーフ名>": weight, ... }, ... }
//   モーフ名は VRM内の morph target 名（VRoid標準なら Fcl_EYE_Close_L / Fcl_HA_Fung1 等）。
//   モデルに無いモーフは読み飛ばす＝キャラ間で定義を共用できる（VRoid標準モーフ前提）。
// 登録後は expressionManager.setValue('<表情名>', w) がプリセット表情と同様に使える。
// 頬染め等のテクスチャ系（モーフでないもの）は合成できない点に注意。

import { VRMExpression, VRMExpressionMorphTargetBind } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';

// 状態表情のリセット対象から除外する制御系（口パク母音・まばたき・視線）
const NON_EMOTION = new Set(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']);

// defs のカスタム表情を vrm に登録する（登録済み・定義なしは無視）。
// defs は expressions.json 全体（{expressions:{...}}）でも表情マップ単体でもよい
export function registerCustomExpressions(vrm, defs) {
  const em = vrm && vrm.expressionManager;
  if (!em || !defs) return;
  defs = defs.expressions || defs;
  // モーフ名 → そのモーフを持つメッシュ群と index の対応を先に作る
  const morphMeshes = new Map();
  vrm.scene.traverse((o) => {
    if (!o.isMesh || !o.morphTargetDictionary) return;
    for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
      if (!morphMeshes.has(name)) morphMeshes.set(name, []);
      morphMeshes.get(name).push({ mesh: o, index });
    }
  });
  for (const [exName, morphs] of Object.entries(defs)) {
    if (!morphs || typeof morphs !== 'object') continue;   // format 等のメタキーを除外
    if (em.expressionMap && em.expressionMap[exName]) continue;   // 既存名（プリセット含む）は上書きしない
    const expr = new VRMExpression(exName);
    let bound = 0;
    for (const [mName, w] of Object.entries(morphs || {})) {
      const hits = morphMeshes.get(mName);
      if (!hits) continue;   // このモデルに無いモーフはスキップ
      for (const h of hits) {
        expr.addBind(new VRMExpressionMorphTargetBind({ primitives: [h.mesh], index: h.index, weight: w }));
        bound++;
      }
    }
    if (bound > 0) em.registerExpression(expr);
  }
}

// 感情系の表情（プリセット＋カスタム）を全て 0 に戻す。口パク・まばたき・視線は触らない
export function resetEmotionExpressions(em) {
  if (!em || !em.expressionMap) return;
  for (const name of Object.keys(em.expressionMap)) {
    if (NON_EMOTION.has(name)) continue;
    try { em.setValue(name, 0); } catch { /* noop */ }
  }
}
