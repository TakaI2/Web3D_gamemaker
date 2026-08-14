// vrm-tk.js — 念力（テレキネシス）の共通部品。ゲーム(vamp-dungeon)と fx-editor プレビューで共用。
//   ・createTkBeam: electric スプライトの4セグメント連結ビーム（中間点3をランダムに振り直す波打ち曲線）
//   ・tkArmRaise:   発射腕を対象へ掲げる（2ボーンIK）
//   ・tkHoverStep:  バネ浮遊＋ランダム回転（swing-catch方式）
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { createBeamFx } from './fx-beam.js';
import { solveTwoBoneIK } from './pose-kit.js';

const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _sp = new THREE.Vector3(), _acc = new THREE.Vector3();

export function createTkBeam(spec = {}) {
  const baseWidth = spec.width ?? 0.4;
  const refLen = spec.refLen ?? 5;    // この距離のとき幅=設定値。近いほど同縮尺で細く（模様の潰れ防止）
  // 単一ビームの経路モード（FXエディタ/City-Flyアルティメットと同じ）：スプライト1枚を中間点3のスプラインで曲げる
  const b = createBeamFx({ ...spec });
  b.setPathMode(true);
  if (b.setEmitting) b.setEmitting(true);
  b.object3D.visible = false;
  const pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  let midT = 0, lastW = -1;
  return {
    objects: [b.object3D],
    show(from, to, dt, camPos) {
      midT -= dt;
      const dist = from.distanceTo(to);
      pts[0].copy(from); pts[4].copy(to);
      if (midT <= 0) {   // 中間点3つを短周期で振り直し＝電撃の波打ち
        midT = 0.09;
        _d.subVectors(to, from).normalize();
        for (let i = 0; i < 3; i++) {
          pts[i + 1].lerpVectors(from, to, (i + 1) / 4);
          _r.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
          _r.addScaledVector(_d, -_d.dot(_r));
          if (_r.lengthSq() > 1e-6) pts[i + 1].addScaledVector(_r.normalize(), dist * (0.05 + Math.random() * 0.1));
        }
      }
      // 距離に応じて幅も同縮尺（短いビームで電撃模様が圧縮されないように）
      const w = baseWidth * Math.min(1.6, Math.max(0.12, dist / refLen));
      if (Math.abs(w - lastW) > 0.003) { lastW = w; b.setParam?.('width', w); }
      b.object3D.visible = true;
      b.setPathPoints(pts, camPos, true);
    },
    hide() { b.object3D.visible = false; },
    dispose() { b.dispose?.(); },
  };
}

/** 発射腕を対象へ掲げる。vrm=正規化リグ。side='left'|'right' */
export function tkArmRaise(vrm, side, targetPos, reach = 0.52) {
  const nb = (n) => vrm.humanoid?.getNormalizedBoneNode(n);
  const arm = { root: nb(side + 'UpperArm'), mid: nb(side + 'LowerArm'), end: nb(side + 'Hand') };
  if (!arm.root || !arm.mid || !arm.end) return;
  arm.root.getWorldPosition(_sp);
  _d.subVectors(targetPos, _sp).normalize();
  _sp.addScaledVector(_d, reach);
  const r = solveTwoBoneIK(arm, _sp);
  if (r) { arm.root.quaternion.copy(r.rootQuat); arm.mid.quaternion.copy(r.midQuat); }
}

/** バネ浮遊1ステップ（vel は呼び出し側が保持する Vector3） */
export function tkHoverStep(obj, hover, spin, vel, dt, k = 20, c = 6) {
  _acc.subVectors(hover, obj.position).multiplyScalar(k);
  vel.addScaledVector(_acc, dt);
  vel.addScaledVector(vel, -Math.min(0.9, c * dt));
  obj.position.addScaledVector(vel, dt);
  if (spin) { obj.rotation.x += spin.x * dt; obj.rotation.y += spin.y * dt; obj.rotation.z += spin.z * dt; }
}
