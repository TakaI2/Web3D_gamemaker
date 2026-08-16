// fx-dissolve.js — 液体溶解ディソルブ。対象(VRM sceneや単一メッシュ)の全マテリアルへ後付けで
// 「上→下へ溶けて消える(ノイズ縁+発光rim) → 高さが下がる(上から消えるので自然に) → 接地に淡色の液だまり(パドル)が広がる」
// を合成する。透明ソート不要(alphaTestでdiscard)・ノイズ1呼び・変形なしで“多用しても軽い”設計。
//
// 対応: MToonNodeMaterial(VRM) / MeshStandard等のNodeMaterial(一般メッシュ)。
//   非NodeMaterial(素のMeshStandardMaterial等)は MeshStandardNodeMaterial へ差し替えて適用し、dispose で戻す。
//
// 使い方:
//   const dis = createDissolve(vrm.scene, { rimColor:'#66ddff', liquidColor:'#aee6ff' });
//   dis.setProgress(0..1);   // 溶解進行（0=無傷, 1=消滅+液だまり）
//   dis.update(dt);          // 追従/自動再生
//   dis.dispose();           // 元マテリアルへ復帰＋パドル破棄

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { uniform, color, float, positionWorld, positionGeometry, attribute, mx_noise_float, mix, uv, clamp, time } from 'https://esm.sh/three@0.184.0/tsl';

export function createDissolve(target, opts = {}) {
  const cfg = {
    noiseScale: opts.noiseScale ?? 5.0,
    noiseAmt: opts.noiseAmt ?? 0.45,
    edge: opts.edge ?? 0.10,
    rimColor: opts.rimColor ?? '#7fe6ff',
    rimIntensity: opts.rimIntensity ?? 2.4,
    liquidColor: opts.liquidColor ?? '#bfeaff',
    puddle: opts.puddle ?? true,
    puddleScale: opts.puddleScale ?? 1.9,
    puddleAlpha: opts.puddleAlpha ?? 0.7,
    doubleSide: opts.doubleSide ?? true,
    autoSpeed: opts.autoSpeed ?? 0,
    groundY: opts.groundY ?? null,     // 指定するとパドルをこのワールドYへ固定（倒れて床にめり込む対象で有効）
    armed: opts.armed ?? true,         // false で事前生成(prewarm)。素の見た目のまま待機し setArmed(true) で起動
    direction: opts.direction ?? 'top',   // 'top'=上から消える / 'bottom'=下(裾・先端)から / 'scatter'=ノイズだけ＝穴が散らばる
    space: opts.space ?? 'world',         // 'world'=ワールド座標（倒れて溶ける死体など） / 'geometry'=変形前の頂点座標
                                          //   ※布のなびきやスキニングで動く対象は 'geometry'。穴が布地に固定される
                                          // 'attributes'=呼び出し側がジオメトリに仕込んだ dmgPos(vec3)/dmgH(float 0=先端..1=根元) を使う
                                          //   ※GPUクロス（position属性がゼロ埋めで positionNode 描画）向け
  };

  // ── 共有 uniforms（全マテリアルで共有＝一括制御）──
  const uP = uniform(0);        // 溶解しきい値（pMax でスケール）
  const uP01 = uniform(0);      // 公開進行 0..1（色遷移/パドル用）
  const uBaseY = uniform(0);    // 対象の底ワールドY
  const uHeight = uniform(1);   // 対象の高さ
  const uNoiseScale = uniform(cfg.noiseScale);
  const uNoiseAmt = uniform(cfg.noiseAmt);
  const uEdge = uniform(cfg.edge);
  const uRimColor = uniform(color(cfg.rimColor));
  const uRimInt = uniform(cfg.rimIntensity);
  const uLiquid = uniform(color(cfg.liquidColor));
  const uOn = uniform(cfg.armed ? 1 : 0);   // 0=未起動（完全不透明・リム無し＝素の見た目）

  // p=1 で確実に消えるための上限（dc の最大: top/bottom ≒ 1+noiseAmt, scatter=1。+edge の余白）
  const pMaxOf = (amt, edge) => (cfg.direction === 'scatter' ? 1 : 1 + amt) + edge + 0.06;
  let pMax = pMaxOf(cfg.noiseAmt, cfg.edge);

  // マテリアルごとに新規ノード式を作る（uniform は共有）。
  function buildNodes(prevOpacity) {
    const pRef = cfg.space === 'attributes' ? attribute('dmgPos', 'vec3')
      : cfg.space === 'geometry' ? positionGeometry : positionWorld;   // geometry=バインド/初期形状基準＝動いても模様が布に付いてくる
    const hNorm = cfg.space === 'attributes' ? clamp(attribute('dmgH', 'float'), 0, 1)
      : clamp(pRef.y.sub(uBaseY).div(uHeight), 0, 1);   // 0=底(先端) 1=上(根元)
    // ノイズは正側バイアス[0..1]＝progress 0 でどの頂点も dc>=0（先端が最初から欠けない）
    const n01 = mx_noise_float(pRef.mul(uNoiseScale)).mul(0.5).add(0.5);
    const dc = cfg.direction === 'bottom' ? hNorm.add(n01.mul(uNoiseAmt))                 // 下（裾）ほど小＝先に消える
      : cfg.direction === 'scatter' ? n01                                                 // 高さ無関係＝ノイズの穴が散らばる
      : hNorm.oneMinus().add(n01.mul(uNoiseAmt));                                         // 既定: 上ほど小（先に消える）
    const aRaw = dc.smoothstep(uP.sub(uEdge), uP);
    const base = prevOpacity != null ? prevOpacity : float(1);             // 未起動時は元の不透明度を保持
    const alpha = mix(base, aRaw, uOn);                  // 未起動(uOn=0)は素の見た目、起動で溶解alphaへ
    const rimT = clamp(float(1).sub(dc.sub(uP).abs().div(uEdge)), 0, 1);
    const rimCol = mix(uRimColor, uLiquid, uP01);
    const emissive = rimCol.mul(uRimInt).mul(rimT).mul(uOn).mul(uP01.smoothstep(float(0), float(0.02)));  // 未起動/進行0はリム発光なし
    return { alpha, emissive };
  }

  // ── マテリアル適用（NodeMaterial化＋ノード付与）──
  const saved = [];
  function toNodeMaterial(mat) {
    const nm = new THREE.MeshStandardNodeMaterial();
    nm.copy(mat);
    return nm;
  }
  function applyToMaterial(nodeMat) {
    const prev = { opacityNode: nodeMat.opacityNode, emissiveNode: nodeMat.emissiveNode, alphaTest: nodeMat.alphaTest, side: nodeMat.side };
    const { alpha, emissive } = buildNodes(prev.opacityNode);   // 未起動時に元の不透明度を保つため prev を渡す
    nodeMat.opacityNode = alpha;
    nodeMat.emissiveNode = emissive;
    nodeMat.alphaTest = Math.max(nodeMat.alphaTest || 0, 0.5);
    if (cfg.doubleSide && !nodeMat.isOutline) nodeMat.side = THREE.DoubleSide;
    nodeMat._dissolveApplied = true;
    nodeMat.needsUpdate = true;
    return { prev, alpha, emissive };
  }

  target.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const isArr = Array.isArray(obj.material);
    const mats = isArr ? obj.material : [obj.material];
    mats.forEach((mat, i) => {
      if (!mat || mat._dissolveApplied) return;
      let nodeMat = mat, swapped = false;
      if (!mat.isNodeMaterial) {
        nodeMat = toNodeMaterial(mat);
        if (isArr) obj.material[i] = nodeMat; else obj.material = nodeMat;
        swapped = true;
      }
      const ap = applyToMaterial(nodeMat);
      saved.push({ obj, i, isArr, orig: mat, nodeMat, swapped, prev: ap.prev, alpha: ap.alpha, emissive: ap.emissive });
    });
  });

  // ── バウンディングボックス→底Y/高さ/フットプリント（移動追従オフセット保持）──
  const _box = new THREE.Box3();
  if (cfg.space === 'geometry') {
    _box.makeEmpty();
    target.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _box.union(o.geometry.boundingBox);
    });
    if (_box.isEmpty()) _box.setFromObject(target);
  } else _box.setFromObject(target);
  const _wp = new THREE.Vector3();
  target.getWorldPosition(_wp);
  const baseY0 = Number.isFinite(_box.min.y) ? _box.min.y : _wp.y;
  const height0 = Math.max(0.01, (_box.max.y - _box.min.y) || 1);
  let baseYOffset = baseY0 - _wp.y;
  uBaseY.value = baseY0;
  uHeight.value = height0;
  const cx = (_box.min.x + _box.max.x) / 2, cz = (_box.min.z + _box.max.z) / 2;
  let cxOff = cx - _wp.x, czOff = cz - _wp.z;   // recenter() で取り直すため let
  let footR = Math.max((_box.max.x - _box.min.x), (_box.max.z - _box.min.z)) * 0.5 || 0.3;

  // ── 液だまり(パドル)：完全な円ではなく、ノイズで縁を凸凹にして“水たまり”らしくする ──
  let puddle = null;
  const uPudA = uniform(0);
  if (cfg.puddle) {
    const geo = new THREE.CircleGeometry(1, 64);
    geo.rotateX(-Math.PI / 2);
    const pmat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const seed = cx * 1.7 + cz * 2.3;                             // 個体ごとに輪郭を変える種
    const pc  = uv().sub(0.5).mul(2.0);                           // 中心=0、縁で長さ ~1
    const rr  = pc.length();
    const wob = mx_noise_float(pc.mul(2.2).add(seed)).mul(0.30);  // 縁を不規則に凹ませる
    const shape = rr.add(wob);                                    // 不規則な“半径”
    const body  = shape.smoothstep(0.55, 0.86).oneMinus();       // 内側=1 → 外側へ0（凸凹輪郭）
    const safe  = rr.smoothstep(0.90, 0.99).oneMinus();          // 幾何円の縁は必ず消して直線エッジを防ぐ
    const ripple = mx_noise_float(pc.mul(6.0).add(time.mul(0.3))).mul(0.10).add(0.92);  // 内部のさざ波
    const soft = body.mul(safe).mul(ripple);
    pmat.colorNode = uLiquid.mul(1.15);
    pmat.opacityNode = soft.mul(uPudA);
    puddle = new THREE.Mesh(geo, pmat);
    puddle.renderOrder = 2;
    puddle.position.set(cx, (cfg.groundY != null ? cfg.groundY : baseY0) + 0.012, cz);
    puddle.scale.setScalar(0.0001);
    (target.parent || target).add(puddle);
  }

  let progress = 0;
  function refreshFollow() {
    if (cfg.space !== 'world') return;   // ジオメトリ/属性基準は静的（追従不要）
    target.getWorldPosition(_wp);
    uBaseY.value = _wp.y + baseYOffset;
    if (puddle) {
      const py = (cfg.groundY != null) ? cfg.groundY + 0.012 : _wp.y + baseYOffset + 0.012;
      puddle.position.set(_wp.x + cxOff, py, _wp.z + czOff);
    }
  }
  function setProgress(p) {
    progress = Math.max(0, Math.min(1, p));
    uP.value = progress * pMax;
    uP01.value = progress;
    if (puddle) {
      const pp = THREE.MathUtils.smoothstep(progress, 0.10, 0.85);
      puddle.scale.setScalar(Math.max(0.0001, footR * cfg.puddleScale * pp));
      uPudA.value = pp * cfg.puddleAlpha;
    }
    refreshFollow();
  }

  function update(dt) {
    if (cfg.autoSpeed > 0 && progress < 1) setProgress(progress + cfg.autoSpeed * dt);
    else refreshFollow();
  }

  function setParam(key, val) {
    if (key === 'noiseScale') uNoiseScale.value = val;
    else if (key === 'baseYOffset') { baseYOffset = val; refreshFollow(); }   // 対象原点からの底Yオフセット（GPUクロス等、bboxが当てにならない対象向け）
    else if (key === 'height') uHeight.value = Math.max(0.01, val);
    else if (key === 'noiseAmt') { uNoiseAmt.value = val; pMax = pMaxOf(val, uEdge.value); setProgress(progress); }
    else if (key === 'edge') { uEdge.value = val; pMax = pMaxOf(uNoiseAmt.value, val); setProgress(progress); }
    else if (key === 'rimColor') uRimColor.value.set(val);
    else if (key === 'rimIntensity') uRimInt.value = val;
    else if (key === 'liquidColor') uLiquid.value.set(val);
    else if (key === 'puddleScale') { cfg.puddleScale = val; setProgress(progress); }
    else if (key === 'autoSpeed') cfg.autoSpeed = val;
  }

  let activeOn = true;
  function setActive(on) {   // 進行0の間は元の材質/ノードへ戻し、溶解ノイズのGPUコストを止める
    // 注意: 切替ストール防止のため、呼び出し側でON/OFF両状態を起動時に一度ずつ描画してパイプラインを温めること
    on = !!on;
    if (on === activeOn) return;
    activeOn = on;
    for (const s of saved) {
      if (s.swapped) {
        if (s.isArr) s.obj.material[s.i] = on ? s.nodeMat : s.orig;
        else s.obj.material = on ? s.nodeMat : s.orig;
      } else {
        s.nodeMat.opacityNode = on ? s.alpha : s.prev.opacityNode;
        s.nodeMat.emissiveNode = on ? s.emissive : s.prev.emissiveNode;
        s.nodeMat.alphaTest = on ? Math.max(s.prev.alphaTest || 0, 0.5) : s.prev.alphaTest;
        s.nodeMat.needsUpdate = true;
      }
    }
    if (puddle) puddle.visible = on;
  }
  function dispose() {
    for (const s of saved) {
      if (s.swapped) {
        if (s.isArr) s.obj.material[s.i] = s.orig; else s.obj.material = s.orig;
        s.nodeMat.dispose();
      } else {
        s.nodeMat.opacityNode = s.prev.opacityNode;
        s.nodeMat.emissiveNode = s.prev.emissiveNode;
        s.nodeMat.alphaTest = s.prev.alphaTest;
        s.nodeMat.side = s.prev.side;
        s.nodeMat._dissolveApplied = false;
        s.nodeMat.needsUpdate = true;
      }
    }
    saved.length = 0;
    if (puddle) { if (puddle.parent) puddle.parent.remove(puddle); puddle.geometry.dispose(); puddle.material.dispose(); puddle = null; }
  }

  function setArmed(on) { uOn.value = on ? 1 : 0; }   // prewarm(false生成)→死亡時 true でシェーダ再コンパイル無しに起動

  // 現在の実姿勢へパドル中心・高さ・フットプリントを取り直す。
  // prewarm は立ち姿勢で中心オフセットを固定するため、ラグドールで倒れて移動した後に一度呼ぶとズレが直る。
  function recenter() {
    target.updateMatrixWorld(true);
    _box.setFromObject(target);
    target.getWorldPosition(_wp);
    const nBaseY = Number.isFinite(_box.min.y) ? _box.min.y : _wp.y;
    const ncx = (_box.min.x + _box.max.x) / 2, ncz = (_box.min.z + _box.max.z) / 2;
    baseYOffset = nBaseY - _wp.y;
    cxOff = ncx - _wp.x; czOff = ncz - _wp.z;
    uHeight.value = Math.max(0.01, (_box.max.y - _box.min.y) || 1);   // 倒れて縦が縮んだ分も反映
    footR = Math.max((_box.max.x - _box.min.x), (_box.max.z - _box.min.z)) * 0.5 || 0.3;
    setProgress(progress);   // フットプリント/高さの変更をパドルスケール等へ反映
    refreshFollow();
  }

  // パドルのワールドXZ中心を明示指定。スキンメッシュ(VRM)は setFromObject が
  // ボーン変形を反映しないため、ラグドール/ボーンの実位置をここへ渡す。以後 update() でも維持。
  function setPuddleCenter(x, z) {
    target.getWorldPosition(_wp);
    cxOff = x - _wp.x;
    czOff = z - _wp.z;
    refreshFollow();
  }

  // パドルの固定ワールドYを後から変更（地形上で死亡位置の地面高さに合わせる用）
  function setGroundY(y) { cfg.groundY = y; refreshFollow(); }

  setProgress(0);
  return { setProgress, update, setParam, setArmed, setActive, recenter, setPuddleCenter, setGroundY, dispose, get progress() { return progress; }, puddle };
}
