// vrm-look.js — VRMの首・頭（＋任意で背骨）を注視点へ向ける共通モジュール。
//
// モデルの向き規約（VRM0/1・+Z/-Z正面・正規化リグの軸）に一切依存しない:
// 生成時に休止ポーズで「実際の顔の向き」を脚ボーンの位置関係から実測し、
// 各ボーンのローカル空間へベイクする（forward = cross(左脚-右脚, 上)。pose-kit の実績方式）。
// 以後は毎フレーム「現在のワールド顔向き→目標方向」の回転を重み付きで積むだけ。
//
//   const look = createHeadLook(vrm);            // 読み込み・シーン追加・updateMatrixWorld 後に
//   look.update(targetWorld, 1.0);               // 毎フレーム、アニメ適用後・vrm.update() の前に
//
// 首の可動域は「体の正面」基準でクランプ（真後ろを向かない）。
import * as THREE from 'https://esm.sh/three@0.184.0';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3(), _dirB = new THREE.Vector3(), _face = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qd = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0), _fwdNow = new THREE.Vector3();

/** 休止ポーズの脚ボーン位置から体の正面（ワールド）を実測。VRM0/1どちらでも正しい */
function measureForward(vrm, out) {
  const nb = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
  const lL = nb('leftUpperLeg'), lR = nb('rightUpperLeg');
  if (lL && lR) {
    lL.getWorldPosition(_v); lR.getWorldPosition(_v2);
    _v3.crossVectors(_v.sub(_v2), _up);   // (左-右)×上 = 前
    if (_v3.lengthSq() > 1e-8) return out.copy(_v3.normalize());
  }
  // 脚が無いモデルは lookAt の向き（無ければ +Z）
  if (vrm.lookAt?.faceFront) return out.copy(vrm.lookAt.faceFront).applyQuaternion(vrm.scene.getWorldQuaternion(_q)).normalize();
  return out.set(0, 0, 1);
}

export function createHeadLook(vrm, opts = {}) {
  const nb = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
  const maxYaw = (opts.maxYawDeg ?? 70) * Math.PI / 180;
  const maxUp = (opts.maxUpDeg ?? 35) * Math.PI / 180;
  const maxDown = (opts.maxDownDeg ?? 60) * Math.PI / 180;
  // 分配: 頭は全量、首・背骨は控えめ（覗き込みの体の同調）
  const shares = opts.shares ?? { spine: 0.06, chest: 0.1, neck: 0.3, head: 1.0 };
  const bones = [];   // 適用順=根本から
  const baked = { fwdRootLocal: new THREE.Vector3(0, 0, 1) };

  function bake() {
    vrm.scene.updateMatrixWorld(true);
    measureForward(vrm, _face);                       // 休止ポーズの正面（ワールド）
    vrm.scene.getWorldQuaternion(_q);
    baked.fwdRootLocal.copy(_face).applyQuaternion(_q2.copy(_q).invert());   // ルート基準の正面
    bones.length = 0;
    for (const name of ['spine', 'chest', 'upperChest', 'neck', 'head']) {
      const node = nb(name);
      const share = name === 'upperChest' ? (shares.chest ?? 0) * 0.8 : (shares[name] ?? 0);
      if (!node || share <= 0) continue;
      node.getWorldQuaternion(_q3);
      bones.push({
        node, share,
        // 休止時の顔向きをこのボーンのローカルへ（アニメ中も「実際の顔向き」を復元できる）
        faceLocal: _face.clone().applyQuaternion(_q2.copy(_q3).invert()).normalize(),
        upLocal: _up.clone().applyQuaternion(_q2.copy(_q3).invert()).normalize(),
      });
    }
  }
  bake();

  /** 目標へ向ける。アニメ適用後・vrm.update() 前に呼ぶ。w=0..1 */
  function update(targetWorld, w = 1) {
    if (!bones.length || w <= 0 || !targetWorld) return;
    const headB = bones[bones.length - 1];
    // 体の正面＝毎フレーム脚の実測（アニメが腰をどう回していても骨盤の実際の向きが基準になる）
    vrm.scene.updateMatrixWorld(true);
    measureForward(vrm, _fwdNow);
    // 可動域クランプ（体の正面基準のヨー/ピッチ・すべてワールドで計算）
    headB.node.getWorldPosition(_v);
    _dir.copy(targetWorld).sub(_v);
    if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();
    const baseYaw = Math.atan2(_fwdNow.x, _fwdNow.z);
    let dyaw = Math.atan2(_dir.x, _dir.z) - baseYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2; while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    dyaw = Math.max(-maxYaw, Math.min(maxYaw, dyaw));
    const pitch = Math.max(-maxDown, Math.min(maxUp, Math.asin(Math.max(-1, Math.min(1, _dir.y)))));
    const cy = baseYaw + dyaw, cp = Math.cos(pitch);
    _dir.set(Math.sin(cy) * cp, Math.sin(pitch), Math.cos(cy) * cp);   // クランプ済み目標方向（ワールド）

    // 根本から順に「現在の顔向き→目標」の回転を share*w で適用
    for (const b of bones) {
      b.node.updateWorldMatrix(true, false);
      b.node.getWorldQuaternion(_q3);
      _face.copy(b.faceLocal).applyQuaternion(_q3).normalize();   // このボーン基準の現在の顔向き
      const ang = _face.angleTo(_dir);
      if (ang < 1e-5) continue;
      _qd.setFromUnitVectors(_face, _dir);
      _q2.identity().slerp(_qd, Math.min(1, b.share * w));
      // ワールド回転として合成 → ローカルへ戻す
      _q2.multiply(_q3);
      // ロール抑制: 顔の上方向が世界の上へ寄るようにねじれを補正（頭のみ・軽く）
      if (b === headB) {
        _v2.copy(b.upLocal).applyQuaternion(_q2);
        _v3.copy(b.faceLocal).applyQuaternion(_q2);
        const upT = _v.copy(_up).addScaledVector(_v3, -_up.dot(_v3));   // 顔向きに直交な上
        const upC = _v2.addScaledVector(_v3, -_v2.dot(_v3));
        if (upT.lengthSq() > 1e-6 && upC.lengthSq() > 1e-6) {
          _qd.setFromUnitVectors(upC.normalize(), upT.normalize());
          _q3.identity().slerp(_qd, 0.5 * Math.min(1, w));
          _q2.premultiply(_q3);
        }
      }
      b.node.parent.getWorldQuaternion(_q3);
      b.node.quaternion.copy(_q3.invert().multiply(_q2)).normalize();
    }
  }

  /** 現在の頭の顔向き（ワールド）。デバッグ・検証用 */
  function faceDir(out) {
    const headB = bones[bones.length - 1];
    if (!headB) return out.set(0, 0, 1);
    headB.node.updateWorldMatrix(true, false);
    headB.node.getWorldQuaternion(_q3);
    return out.copy(headB.faceLocal).applyQuaternion(_q3).normalize();
  }
  function headPos(out) {
    const headB = bones[bones.length - 1];
    if (!headB) return out.set(0, 0, 0);
    return headB.node.getWorldPosition(out);
  }
  return { update, bake, faceDir, headPos };
}
