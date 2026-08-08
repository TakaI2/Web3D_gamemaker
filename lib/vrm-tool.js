// vrm-tool.js — 道具の「持ち方」定義と装着（tool-editor で作成 → ゲームで再生）。
//
// .tool.json:
//   { name, ref: {proc:'rifle'} | {dir,file}, scale,
//     main: { bone:'rightHand', pos:[x,y,z], rotDeg:[x,y,z] },   // 道具のローカルTRS（持ち手ボーンの子）
//     sub?: { bone:'leftHand', pos:[..], rotDeg:[..] } }         // 道具ローカルの添え手（IK目標）
//
// ボーンは正規化リグ（getNormalizedBoneNode）に統一:
//   ・rest回転ゼロ＝エディタとゲームで座標系が一致する
//   ・mixer更新直後に正しいワールドが得られる（rawへのコピー前でも遅延なし）
import * as THREE from 'https://esm.sh/three@0.184.0';

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);

export function applyMainTransform(toolObj, def) {
  const mn = def.main || {};
  toolObj.position.fromArray(mn.pos || [0, 0, 0]);
  const r = mn.rotDeg || [0, 0, 0];
  toolObj.rotation.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180);
  toolObj.scale.setScalar(def.scale || 1);
}

/** 道具を持たせる。戻り値の subGrip() で添え手のワールド目標（IK用）が得られる */
export function holdTool(vrm, toolObj, def) {
  const boneName = def.main?.bone || 'rightHand';
  const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
  if (!bone) return null;
  bone.add(toolObj);
  applyMainTransform(toolObj, def);
  return {
    obj: toolObj,
    def,
    bone: boneName,
    release() { if (toolObj.parent) toolObj.parent.remove(toolObj); },
    /** 添え手のワールド位置/向き。無ければ null。outQuat は省略可 */
    subGrip(outPos, outQuat) {
      const sub = def.sub;
      if (!sub) return null;
      toolObj.updateWorldMatrix(true, false);
      const r = sub.rotDeg || [0, 0, 0];
      _m.compose(
        _p.fromArray(sub.pos || [0, 0, 0]),
        _q.setFromEuler(_e.set(r[0] * Math.PI / 180, r[1] * Math.PI / 180, r[2] * Math.PI / 180)),
        _s.set(1, 1, 1),
      );
      _m.premultiply(toolObj.matrixWorld);
      outPos.setFromMatrixPosition(_m);
      if (outQuat) outQuat.setFromRotationMatrix(_m);
      return sub.bone || 'leftHand';
    },
  };
}
