// vrm-ragdoll.js — VRM 用 自前 PBD ラグドール（物理エンジン不使用）
// 設計: .tmp/ragdoll_design.md
//
// 使い方（grab ライクなトグル）:
//   const rd = createRagdoll(vrm, { gravity: -22 });
//   setRagdollActive(rd, true);            // 崩れ落ち開始（呼び出し側でアニメ更新を止める）
//   applyRagdollImpulse(rd, dirVec.multiplyScalar(0.25), 'chest');  // 被弾の撃力
//   // 毎フレーム: updateRagdoll(rd, dt, { floorY: 0 }) → その後 vrm.update(dt)
//   setRagdollActive(rd, false);           // 復帰（アニメ再開）
//
// three は各デモと同一の URL を import（同一モジュールインスタンス＝instanceof 互換）。
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';

// 追跡する humanoid 標準ボーン（存在するものだけ採用）
const TRACKED = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
];

// 各ボーンが「向く」主要な子（=骨の軸方向）。欠損ボーンはチェーンを辿って解決する。
const PRIMARY_CHILD = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
};

// 部位ごとの角度制限の既定値（度。レスト方向からの許容逸脱角）。
// 未掲載の関節は opts.maxBend（ラジアン）にフォールバック。opts.boneMaxBend（度）で上書き可。
const DEFAULT_BONE_MAXBEND_DEG = {
  neck:          40,   // 首：固め（180度折れ防止）
  spine:         35,
  chest:         30,
  upperChest:    30,
  leftShoulder:  30,  rightShoulder:  30,   // 鎖骨：固め
  leftUpperArm:  90,  rightUpperArm:  90,   // 肩の振り：広め
  leftLowerArm:  90,  rightLowerArm:  90,   // 肘：よく曲がる
  leftUpperLeg:  70,  rightUpperLeg:  70,   // 股関節
  leftLowerLeg:  95,  rightLowerLeg:  95,   // 膝：深く曲がる
};

const DEFAULTS = {
  gravity:       -22,    // 重力加速度 (m/s^2)
  drag:          0.015,  // 空気抵抗（速度減衰）
  iterations:    8,      // 距離拘束の反復回数
  stiffness:     1.0,    // 拘束の硬さ (0..1)
  jointRadius:   0.07,   // 関節の床衝突半径
  floorFriction: 0.6,    // 接地時の水平摩擦 (0..1)
  foldLimit:     0.6,    // 曲げ拘束の最小距離比（小さいほど深く折れる。骨折防止）
  maxBend:       1.2,    // 角度制限：親骨方向からの逸脱の許容角(rad ≒ 69°)。小さいほど硬い
  boundsMargin:  0.3,    // カリング用境界球の余裕（肉付き分。m）
  recoverDur:    0.45,   // 復帰ブレンド時間(秒)。R復帰時にラグドール姿勢→アニメ姿勢へ補間
};

// ============================================================
// 構築
// ============================================================

export function createRagdoll(vrm, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const humanoid = vrm.humanoid;
  if (!humanoid) throw new Error('createRagdoll: vrm.humanoid がありません');

  vrm.scene.updateMatrixWorld(true);

  // ラグドール中はメッシュのフラスタムカリングを切り（バインド姿勢基準の境界球で誤カリングするため）、
  // 代わりに粒子から算出した「VRM単位」の境界球でカリングする（多数体でも軽い）。メッシュ参照を収集。
  const meshes = [];
  vrm.scene.traverse((obj) => { if (obj.isMesh) meshes.push(obj); });
  const meshOrigCull = meshes.map((m) => m.frustumCulled);

  // 存在するボーンのノードを収集
  const nodes = {};
  for (const b of TRACKED) {
    const n = humanoid.getNormalizedBoneNode(b);
    if (n) nodes[b] = n;
  }
  const exists = (b) => !!nodes[b];

  // 関節粒子（ワールド位置）
  const particles = [];
  const idxOf = {};
  const wpos = new THREE.Vector3();
  for (const b of TRACKED) {
    if (!exists(b)) continue;
    nodes[b].getWorldPosition(wpos);
    idxOf[b] = particles.length;
    particles.push({ pos: wpos.clone(), prev: wpos.clone(), radius: o.jointRadius, bone: b });
  }

  // 最も近い「追跡対象の祖先」ボーン名を返す（欠損ボーンを自動スキップ）
  const trackedParent = (b) => {
    let p = nodes[b].parent;
    while (p) {
      for (const name of TRACKED) if (nodes[name] === p) return name;
      p = p.parent;
    }
    return null;
  };

  // 距離拘束（骨の長さを保つ）
  const constraints = [];
  for (const b of TRACKED) {
    if (!exists(b)) continue;
    const pb = trackedParent(b);
    if (pb == null) continue;
    constraints.push({ i: idxOf[b], j: idxOf[pb], rest: particles[idxOf[b]].pos.distanceTo(particles[idxOf[pb]].pos) });
  }

  // 向き先の子を解決
  const orientChild = (b) => {
    let c = PRIMARY_CHILD[b];
    while (c && !exists(c)) c = PRIMARY_CHILD[c];
    return c && exists(c) ? c : null;
  };

  // ボーン書き戻し記述子
  const bones = [];
  for (const b of TRACKED) {
    if (!exists(b)) continue;
    const node  = nodes[b];
    const child = orientChild(b);
    const desc = {
      bone: b, node,
      selfIdx:  idxOf[b],
      childIdx: child ? idxOf[child] : -1,
      restLocalQuat:  node.quaternion.clone(),
      restLocalPos:   node.position.clone(),
      restWorldQuat:  node.getWorldQuaternion(new THREE.Quaternion()),
      restDir: null,
      depth: 0,
    };
    if (child) {
      desc.restDir = particles[idxOf[child]].pos.clone().sub(particles[idxOf[b]].pos).normalize();
    }
    bones.push(desc);
  }

  // ツリー深さでソート（親→子の順で書き戻すため）
  for (const d of bones) {
    let depth = 0, p = d.node.parent;
    while (p) { if (bones.some(x => x.node === p)) depth++; p = p.parent; }
    d.depth = depth;
  }
  bones.sort((a, b) => a.depth - b.depth);

  // 曲げ拘束：同じ関節を共有する2辺の外側端点間に「最小距離」を設け、胴体の過剰な折れ（骨折）を防ぐ
  const neighbors = particles.map(() => []);
  for (const c of constraints) { neighbors[c.i].push(c.j); neighbors[c.j].push(c.i); }
  const bendConstraints = [];
  const seenBend = new Set();
  for (let p = 0; p < particles.length; p++) {
    const ns = neighbors[p];
    for (let a = 0; a < ns.length; a++) {
      for (let b = a + 1; b < ns.length; b++) {
        const i = ns[a], j = ns[b];
        const key = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (seenBend.has(key)) continue;
        seenBend.add(key);
        bendConstraints.push({ i, j, rest: particles[i].pos.distanceTo(particles[j].pos) });
      }
    }
  }

  // 角度制限（コーン）：各関節で「親骨方向からの逸脱角」を部位別の maxBend に収め、首180度などを防ぐ
  const bendTable = opts.boneMaxBend || {};
  const angleLimits = [];
  for (const d of bones) {
    if (d.childIdx < 0) continue;
    const pb = trackedParent(d.bone);
    if (pb == null) continue;
    const ai = idxOf[pb], bi = d.selfIdx, ci = d.childIdx;
    const dirP = particles[bi].pos.clone().sub(particles[ai].pos).normalize();
    const dirW = particles[ci].pos.clone().sub(particles[bi].pos).normalize();
    const restAngle = Math.acos(Math.max(-1, Math.min(1, dirP.dot(dirW))));
    const deg = bendTable[d.bone] != null ? bendTable[d.bone] : DEFAULT_BONE_MAXBEND_DEG[d.bone];
    const maxBend = deg != null ? deg * Math.PI / 180 : o.maxBend;
    angleLimits.push({ bone: d.bone, a: ai, b: bi, c: ci, restAngle, maxBend });
  }

  return {
    vrm, opts: o, particles, constraints, bendConstraints, angleLimits, bones, idxOf,
    meshes, meshOrigCull, boundsSphere: new THREE.Sphere(), active: false,
    recovering: false, recoverT: 0, freezeQuats: null, freezeHipsPos: new THREE.Vector3(),
  };
}

// ============================================================
// ON / OFF
// ============================================================

export function setRagdollActive(rd, active) {
  if (!rd || active === rd.active) return;
  rd.active = active;
  if (active) {
    rd.recovering = false;
    // 現在の姿勢から開始（粒子を現在のボーンワールド位置へスナップ）
    rd.vrm.scene.updateMatrixWorld(true);
    const w = new THREE.Vector3();
    for (const p of rd.particles) {
      const n = rd.vrm.humanoid.getNormalizedBoneNode(p.bone);
      if (!n) continue;
      n.getWorldPosition(w);
      p.pos.copy(w);
      p.prev.copy(w);
    }
    // ラグドール中はメッシュのカリングを無効化（誤カリング防止。代わりに VRM単位の境界球でカリング）
    for (const m of rd.meshes) m.frustumCulled = false;
  } else {
    // 復帰：現在のラグドール姿勢を freeze として保持し、ブレンド開始（updateRagdollRecovery が補間）
    rd.freezeQuats = rd.bones.map((d) => d.node.quaternion.clone());
    const hips = rd.bones.find((d) => d.bone === 'hips');
    if (hips) rd.freezeHipsPos.copy(hips.node.position);
    rd.recovering = true;
    rd.recoverT = 0;
    rd.vrm.scene.visible = true;   // ブレンド中は必ず表示（カリング復元はブレンド完了時）
  }
}

// R復帰のブレンド：mixer がアニメ姿勢を書いた“後”に呼ぶ。freeze 姿勢→アニメ姿勢へ補間する。
export function updateRagdollRecovery(rd, dt) {
  if (!rd || !rd.recovering) return;
  rd.recoverT += dt / rd.opts.recoverDur;
  const t = rd.recoverT >= 1 ? 1 : rd.recoverT;
  const s = t * t * (3 - 2 * t);   // smoothstep
  for (let i = 0; i < rd.bones.length; i++) {
    const node = rd.bones[i].node;
    _recQ.copy(rd.freezeQuats[i]).slerp(node.quaternion, s);
    node.quaternion.copy(_recQ);
  }
  const hips = rd.bones.find((d) => d.bone === 'hips');
  if (hips) {
    _recV.copy(rd.freezeHipsPos).lerp(hips.node.position, s);
    hips.node.position.copy(_recV);
  }
  if (t >= 1) {
    rd.recovering = false;
    for (let i = 0; i < rd.meshes.length; i++) rd.meshes[i].frustumCulled = rd.meshOrigCull[i];
  }
}

// 速度キック（prev をずらすことで Verlet 速度を加える）。
// impulse は「1ステップ分の変位」スケール。boneName 省略時は全身へ。
export function applyRagdollImpulse(rd, impulse, boneName) {
  if (!rd) return;
  const kick = (p, s) => {
    p.prev.x -= impulse.x * s;
    p.prev.y -= impulse.y * s;
    p.prev.z -= impulse.z * s;
  };
  if (boneName != null && rd.idxOf[boneName] != null) kick(rd.particles[rd.idxOf[boneName]], 1.0);
  for (const p of rd.particles) kick(p, 0.25);  // 全身に少し伝える
}

// ============================================================
// 更新（active 時のみ）
// ============================================================

const _d   = new THREE.Vector3();
const _pq  = new THREE.Quaternion();
const _qW  = new THREE.Quaternion();
const _dq  = new THREE.Quaternion();
const _d1  = new THREE.Vector3();
const _lp  = new THREE.Vector3();
const _angP    = new THREE.Vector3();
const _angW    = new THREE.Vector3();
const _angAxis = new THREE.Vector3();
const _angQ    = new THREE.Quaternion();
const _recQ    = new THREE.Quaternion();
const _recV    = new THREE.Vector3();

export function updateRagdoll(rd, dt, env = {}) {
  if (!rd || !rd.active) return;
  const o = rd.opts;
  const floorY = env.floorY ?? 0;
  const dt2 = dt * dt;
  const keep = 1 - o.drag;
  // ピン：指定ボーン粒子を env.pinPos に固定（掴み＝手アンカーへ追従。離すと解除）
  const pinIdx = (env.pinBone != null && rd.idxOf[env.pinBone] != null) ? rd.idxOf[env.pinBone] : -1;
  // テザー：指定ボーン粒子を env.tetherPos へ緩く引き寄せ（吊り下げてぶらぶら）。ハードピンより自然。
  const tetherIdx = (env.tetherBone != null && rd.idxOf[env.tetherBone] != null) ? rd.idxOf[env.tetherBone] : -1;
  // 複数ピン：env.pins=[{bone,pos}] の各粒子をその位置に固定（編集ツール用。既存の単一ピンと併用可）。
  const pinList = Array.isArray(env.pins)
    ? env.pins.map((p) => ({ idx: rd.idxOf[p.bone], pos: p.pos })).filter((p) => p.idx != null && p.pos)
    : null;

  // Verlet 積分
  for (const p of rd.particles) {
    const px = p.pos.x, py = p.pos.y, pz = p.pos.z;
    p.pos.x += (p.pos.x - p.prev.x) * keep;
    p.pos.y += (p.pos.y - p.prev.y) * keep + o.gravity * dt2;
    p.pos.z += (p.pos.z - p.prev.z) * keep;
    p.prev.set(px, py, pz);
  }

  // ソフトテザー：掴んだ点へ緩く引き寄せ（手元へスナップせず、吊り下げてぶらぶら）
  if (tetherIdx >= 0 && env.tetherPos) {
    const p = rd.particles[tetherIdx];
    const k = env.tetherStrength != null ? env.tetherStrength : 0.12;
    p.pos.x += (env.tetherPos.x - p.pos.x) * k;
    p.pos.y += (env.tetherPos.y - p.pos.y) * k;
    p.pos.z += (env.tetherPos.z - p.pos.z) * k;
  }

  // 距離拘束 + 床/箱衝突の反復
  for (let it = 0; it < o.iterations; it++) {
    for (const c of rd.constraints) {
      const a = rd.particles[c.i], b = rd.particles[c.j];
      _d.copy(b.pos).sub(a.pos);
      const dist = _d.length() || 1e-6;
      _d.multiplyScalar((dist - c.rest) / dist * 0.5 * o.stiffness);
      a.pos.add(_d);
      b.pos.sub(_d);
    }
    // 曲げ拘束（片側＝最小距離のみ）で過剰な折れ＝骨折を抑制
    for (const c of rd.bendConstraints) {
      const a = rd.particles[c.i], b = rd.particles[c.j];
      _d.copy(b.pos).sub(a.pos);
      const dist = _d.length() || 1e-6;
      const minDist = c.rest * o.foldLimit;
      if (dist < minDist) {
        _d.multiplyScalar((dist - minDist) / dist * 0.5);
        a.pos.add(_d);
        b.pos.sub(_d);
      }
    }
    // 角度制限（コーン）：親骨方向からの逸脱を抑え、首・肘の180度折れを防ぐ
    for (const L of rd.angleLimits) {
      const A = rd.particles[L.a].pos, B = rd.particles[L.b].pos, C = rd.particles[L.c].pos;
      _angP.copy(B).sub(A).normalize();
      _angW.copy(C).sub(B);
      const len = _angW.length() || 1e-6;
      _angW.multiplyScalar(1 / len);
      const beta = Math.acos(Math.max(-1, Math.min(1, _angP.dot(_angW))));
      const mb = L.maxBend != null ? L.maxBend : o.maxBend;
      const lo = L.restAngle - mb, hi = L.restAngle + mb;
      const target = beta < lo ? lo : (beta > hi ? hi : beta);
      if (target !== beta) {
        _angAxis.crossVectors(_angP, _angW);
        if (_angAxis.lengthSq() < 1e-10) {
          _angAxis.set(1, 0, 0).cross(_angP);
          if (_angAxis.lengthSq() < 1e-10) _angAxis.set(0, 1, 0).cross(_angP);
        }
        _angAxis.normalize();
        _angQ.setFromAxisAngle(_angAxis, target - beta);
        _angW.applyQuaternion(_angQ);
        C.copy(B).addScaledVector(_angW, len);
      }
    }
    for (const p of rd.particles) {
      const minY = floorY + p.radius;
      if (p.pos.y < minY) {
        p.pos.y = minY;
        // 接地摩擦：水平の prev を pos に寄せて速度を減衰
        p.prev.x += (p.pos.x - p.prev.x) * o.floorFriction;
        p.prev.z += (p.pos.z - p.prev.z) * o.floorFriction;
      }
      if (env.bounds) {
        const r = p.radius, mn = env.bounds.min, mx = env.bounds.max;
        p.pos.x = Math.min(mx.x - r, Math.max(mn.x + r, p.pos.x));
        p.pos.z = Math.min(mx.z - r, Math.max(mn.z + r, p.pos.z));
        if (mx.y != null) p.pos.y = Math.min(mx.y - r, p.pos.y);
      }
    }
    if (pinIdx >= 0) rd.particles[pinIdx].pos.copy(env.pinPos);
    if (pinList) for (const pn of pinList) rd.particles[pn.idx].pos.copy(pn.pos);
  }
  if (pinIdx >= 0) rd.particles[pinIdx].prev.copy(env.pinPos);
  if (pinList) for (const pn of pinList) rd.particles[pn.idx].prev.copy(pn.pos);

  writeBackBones(rd);

  // VRM単位の境界球を粒子から算出 → frustum が渡されていれば scene.visible でカリング（多数体でも軽い）
  computeRagdollBounds(rd);
  if (env.frustum) rd.vrm.scene.visible = env.frustum.intersectsSphere(rd.boundsSphere);
}

// 粒子の AABB から境界球を更新（中心＝AABB中心、半径＝半対角＋余裕）
function computeRagdollBounds(rd) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (const p of rd.particles) {
    const x = p.pos.x, y = p.pos.y, z = p.pos.z;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const cx = (minx + maxx) * 0.5, cy = (miny + maxy) * 0.5, cz = (minz + maxz) * 0.5;
  const dx = maxx - cx, dy = maxy - cy, dz = maxz - cz;
  rd.boundsSphere.center.set(cx, cy, cz);
  rd.boundsSphere.radius = Math.sqrt(dx * dx + dy * dy + dz * dz) + rd.opts.boundsMargin;
}

// 粒子位置 → 正規化ボーンの回転/位置 へ反映（親→子の順）
function writeBackBones(rd) {
  for (const desc of rd.bones) {
    const node = desc.node;

    if (desc.bone === 'hips') {
      _lp.copy(rd.particles[desc.selfIdx].pos);
      if (node.parent) node.parent.worldToLocal(_lp);
      node.position.copy(_lp);
    }

    if (desc.childIdx >= 0 && desc.restDir) {
      _d1.copy(rd.particles[desc.childIdx].pos).sub(rd.particles[desc.selfIdx].pos).normalize();
      _dq.setFromUnitVectors(desc.restDir, _d1);
      _qW.copy(_dq).multiply(desc.restWorldQuat);
      if (node.parent) {
        node.parent.getWorldQuaternion(_pq);
        node.quaternion.copy(_pq.invert().multiply(_qW));
      } else {
        node.quaternion.copy(_qW);
      }
    } else {
      node.quaternion.copy(desc.restLocalQuat);
    }

    // 子が現在の親ワールド回転を読めるよう、このノードのワールド行列を更新
    node.updateWorldMatrix(false, false);
  }
}

// ============================================================
// 後始末
// ============================================================

// 関節の角度制限(度)を走行中に即時更新（ラグドール調整エディタ用）。
export function setBoneMaxBend(rd, bone, deg) {
  if (!rd) return;
  const rad = deg * Math.PI / 180;
  for (const L of rd.angleLimits) if (L.bone === bone) L.maxBend = rad;
}

// 角度制限を持つ関節の一覧 [{bone, deg}] を返す（編集UIのスライダー生成用）。
export function listBoneLimits(rd) {
  if (!rd) return [];
  return rd.angleLimits.map((L) => ({ bone: L.bone, deg: L.maxBend * 180 / Math.PI }));
}

export function disposeRagdoll(rd) {
  if (!rd) return;
  // カリング設定・表示を復元（ブレンドは挟まず即座に）
  for (let i = 0; i < rd.meshes.length; i++) rd.meshes[i].frustumCulled = rd.meshOrigCull[i];
  rd.vrm.scene.visible = true;
  rd.particles.length = 0;
  rd.constraints.length = 0;
  rd.bones.length = 0;
  rd.active = false;
  rd.recovering = false;
}
