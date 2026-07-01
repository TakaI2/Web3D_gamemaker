// fx-beam.js — 2点(from→to)を結ぶビームVFX（電撃／将来レーザー）。
// 「基準点から任意の点（相手・着弾点）まで一直線に伸びる」エフェクト。setEndpoints(from,to,camPos)
// で向き・長さ・カメラ向きを毎フレーム更新する。見た目はギザギザの稲妻（時間でパチパチ変化）。
//
// 使い方（他のfxと同形）:
//   const fx = createBeamFx({ texture:'../electric.png', color:'#bfe0ff', ... });
//   scene.add(fx.object3D);
//   fx.setEmitting(true);                       // 表示ON/OFF
//   fx.setEndpoints(fromVec3, toVec3, camPos);  // 毎フレーム（camPosはビルボード整列用・省略可）
//   fx.update(dt);                              // TSL time は自動更新なので実質no-op
//   fx.dispose();
//
// 構成: 幅方向がカメラを向く1枚の帯(Plane)。長さ方向にelectricスプライトシートをタイル＆スクロール、
//   コマを時間で切替えてパチパチ、頂点を長さに沿って横揺れさせてギザギザにする。両端は固定(taper)。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { color, time, uniform, positionLocal, sin, texture, uv, vec2, vec3, float, floor, mod, fract, max, clamp, normalWorld, positionWorld, cameraPosition } from 'https://esm.sh/three@0.184.0/tsl';
import { loadFxTexture } from './fx-textures.js';

export function createBeamFx(spec = {}) {
  const width = spec.width ?? 0.4;

  // ── ライブ調整用 uniforms ──
  // スプライトシートは実行時に差し替え可能（setTexture）。コマ数もuniformなのでシートを跨いで変更できる。
  const uCols = uniform(spec.frames?.cols ?? 4);
  const uRows = uniform(spec.frames?.rows ?? 4);
  const uFps  = uniform(spec.frames?.fps ?? 18);
  const uColor    = uniform(color(spec.color ?? '#bfe0ff'));
  const uEmissive = uniform(spec.emissive ?? 1.6);
  const uJitter   = uniform(spec.jitter ?? 0.28);   // ギザギザ振幅（ワールド単位）
  const uFreq     = uniform(spec.freq ?? 15);       // ギザギザの細かさ
  const uScroll   = uniform(spec.scroll ?? 0.6);    // テクスチャの流れ
  const uRepeat   = uniform(spec.repeat ?? 3);      // 長さ方向のタイル密度
  const uCore     = uniform(spec.core ?? 2.0);      // 中心の芯の鋭さ
  const uCoreAmt  = uniform(spec.coreAmt ?? 0.4);   // 芯の明るさ（テクスチャ無しでも繋がる連続ビーム成分）
  const uTexAmt   = uniform(spec.texAmt ?? 1.0);    // 稲妻テクスチャの寄与
  // 円筒（チューブ）：基準↔到達点を結ぶ発光シリンダ。フレネルで縁が光る＋長さ方向に流れる＋ねじれ。
  const uTubeColor = uniform(color(spec.tubeColor ?? '#5aa0ff'));
  const uTubeEmis  = uniform(spec.tubeEmissive ?? 1.4);
  const uTubeOpac  = uniform(spec.tubeOpacity ?? 0.7);
  const uTubeScroll = uniform(spec.tubeScroll ?? 0.8);
  const uTubeRepeat = uniform(spec.tubeRepeat ?? 2);
  const uTubeFres  = uniform(spec.tubeFresnel ?? 1.6);
  const uTubeTwist = uniform(spec.tubeTwist ?? 0.6);            // 螺旋のねじれ量
  const uTubeCols  = uniform(spec.tubeFrames?.cols ?? 1);       // 円筒テクスチャのシート列
  const uTubeRows  = uniform(spec.tubeFrames?.rows ?? 1);
  const uTubeFps   = uniform(spec.tubeFrames?.fps ?? 12);

  // 長さ方向(X)にだけ細分化した帯。X∈[-0.5,0.5]=長さ, Y∈[-w/2,w/2]=幅（Yはスケール1なのでワールド幅）
  const geo = new THREE.PlaneGeometry(1, width, 64, 1);

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.blending = THREE.AdditiveBlending;
  mat.colorNode = uColor.mul(uEmissive);   // 発光は加算＋bloom前提

  // スタイル: 'jagged'（手続きでギザギザ生成）/ 'sheet'（雷スプライト1枚を2点間に伸ばす）
  const style = spec.style === 'sheet' ? 'sheet' : 'jagged';

  // ── シート上のコマ（共通）──
  const uTotal = uCols.mul(uRows);
  const fi = mod(floor(time.mul(uFps)), uTotal);
  const fcol = mod(fi, uCols);
  const frow = floor(fi.div(uCols));
  const ends = uv().x.smoothstep(0, 0.03).mul(uv().x.oneMinus().smoothstep(0, 0.03));   // 両端フェード

  let beamTex;
  if (style === 'sheet') {
    // シートそのまま：1コマを帯全体に伸ばす（横揺れ無し＝まっすぐ）。スプライトの形＝ビームの形。
    const cellU = fcol.add(uv().x).div(uCols);                              // 長さ方向＝コマ1枚
    const cellV = float(1).sub(frow.add(float(1).sub(uv().y)).div(uRows));  // 幅方向＝コマ高さ全体
    beamTex = texture(loadFxTexture(spec.texture ?? '../electric.png'), vec2(cellU, cellV));
    const texLum = max(max(beamTex.r, beamTex.g), beamTex.b);
    const edge = uv().y.smoothstep(0, 0.05).mul(uv().y.oneMinus().smoothstep(0, 0.05));   // 幅端をなじませる
    mat.opacityNode = clamp(texLum.mul(uTexAmt).mul(edge).mul(ends), 0, 1);
  } else {
    // ギザギザ：頂点を長さに沿って横(Y)へ揺らす。両端はtaperで0＝端点にピタリ繋ぐ。
    const along = positionLocal.x.add(0.5);
    const wob = sin(along.mul(uFreq).add(time.mul(9)))
      .add(sin(along.mul(uFreq.mul(2.3)).add(time.mul(15))).mul(0.5))
      .add(sin(along.mul(uFreq.mul(4.7)).add(time.mul(23))).mul(0.25));
    const taper = clamp(along.mul(along.oneMinus()).mul(4), 0, 1);
    mat.positionNode = vec3(positionLocal.x, positionLocal.y.add(wob.mul(uJitter).mul(taper)), positionLocal.z);
    // 不透明度：コマ切替＋長さタイル＋スクロール × 芯(中心ほど明るい) × 端フェード
    const uAlong = uv().x.mul(uRepeat).add(time.mul(uScroll));
    const cellU = fcol.add(fract(uAlong)).div(uCols);
    const cellV = float(1).sub(frow.add(float(1).sub(uv().y)).div(uRows));
    beamTex = texture(loadFxTexture(spec.texture ?? '../electric.png'), vec2(cellU, cellV));
    const texLum = max(max(beamTex.r, beamTex.g), beamTex.b);
    const across = clamp(uv().y.sub(0.5).abs().mul(2), 0, 1);
    const core = across.oneMinus().pow(uCore);
    mat.opacityNode = clamp(core.mul(texLum.mul(uTexAmt).add(uCoreAmt)).mul(ends), 0, 1);
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  // ── 円筒（チューブ）：X軸に沿った単位シリンダ。半径は mesh.scale(Y,Z) で可変。────
  const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  tubeGeo.rotateZ(Math.PI / 2);   // 高さ軸(Y)→長さ軸(X)。uv().y が長さ方向になる。
  const tubeMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  tubeMat.blending = THREE.AdditiveBlending;
  tubeMat.colorNode = uTubeColor.mul(uTubeEmis);
  // フレネル（視線に対し縁ほど明るい）＋長さ方向の流れ(perlin)＋端フェード
  const _viewDir = cameraPosition.sub(positionWorld).normalize();
  const fres = clamp(float(1).sub(normalWorld.normalize().dot(_viewDir).abs()), 0, 1).pow(uTubeFres);
  // 円筒テクスチャ（差替可・シート対応）：周方向にねじれ＋長さ方向に流れる。
  const tTotal = uTubeCols.mul(uTubeRows);
  const tfi = mod(floor(time.mul(uTubeFps)), tTotal);
  const tfcol = mod(tfi, uTubeCols);
  const tfrow = floor(tfi.div(uTubeCols));
  const around = uv().x.add(uv().y.mul(uTubeTwist));                  // 周方向＝ねじれ（螺旋）
  const alongF = uv().y.mul(uTubeRepeat).add(time.mul(uTubeScroll));   // 長さ方向＝流れ
  const tU = tfcol.add(fract(around)).div(uTubeCols);
  const tV = float(1).sub(tfrow.add(float(1).sub(fract(alongF))).div(uTubeRows));
  const tubeTexNode = texture(loadFxTexture(spec.tubeTexture ?? 'builtin:perlin'), vec2(tU, tV));
  const flow = max(max(tubeTexNode.r, tubeTexNode.g), tubeTexNode.b).mul(0.75).add(0.25);
  const endsT = uv().y.smoothstep(0, 0.05).mul(uv().y.oneMinus().smoothstep(0, 0.05));
  tubeMat.opacityNode = clamp(fres.add(0.12).mul(flow).mul(endsT).mul(uTubeOpac), 0, 1);
  const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
  tubeMesh.frustumCulled = false;
  let tubeRadius = spec.tubeRadius ?? 0.16;
  tubeMesh.scale.set(1, tubeRadius, tubeRadius);
  tubeMesh.visible = spec.tube !== false;   // 既定ON

  const group = new THREE.Group();
  group.add(mesh);
  group.add(tubeMesh);
  group.matrixAutoUpdate = false;   // 行列は setEndpoints で直接組む
  group.visible = false;

  // ── 端点更新（向き・長さ・カメラ向きの帯を組む）──
  const _from = new THREE.Vector3(), _to = new THREE.Vector3(), _mid = new THREE.Vector3();
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _cam = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
  function setEndpoints(from, to, camPos) {
    _from.copy(from); _to.copy(to);
    _mid.addVectors(_from, _to).multiplyScalar(0.5);
    _x.subVectors(_to, _from);
    const len = _x.length();
    if (len < 1e-4) { group.visible = false; return; }
    _x.multiplyScalar(1 / len);
    // 幅方向(Y)＝ビーム軸に直交かつカメラを向く向き
    if (camPos) _cam.subVectors(camPos, _mid); else _cam.set(0, 0, 1);
    _y.crossVectors(_x, _cam);
    if (_y.lengthSq() < 1e-6) _y.crossVectors(_x, _up);   // 視線とほぼ平行なとき退避
    _y.normalize();
    _z.crossVectors(_x, _y).normalize();
    _m.makeBasis(_x, _y, _z);
    _m.setPosition(_mid);
    _m.scale(_s.set(len, 1, 1));      // 長さ方向のみ伸縮（幅はgeometryで固定）
    group.matrix.copy(_m);
    group.matrixWorldNeedsUpdate = true;
  }

  function setEmitting(on) { group.visible = !!on; }
  function update() { /* TSL time は自動更新 */ }
  function burst() { group.visible = true; }
  // スプライトシート差し替え（電撃以外の帯テクスチャに）。cols/rows/fps 未指定は据え置き。
  // ※テクスチャは fx-textures 側でキャッシュ共有のため dispose しない。
  function setTexture(src, cols, rows, fps) {
    if (src != null) beamTex.value = loadFxTexture(src);
    if (cols) uCols.value = cols;
    if (rows) uRows.value = rows;
    if (fps) uFps.value = fps;
  }
  function setParam(key, val) {
    if (key === 'color') uColor.value.set(val);
    else if (key === 'emissive') uEmissive.value = val;
    else if (key === 'jitter') uJitter.value = val;
    else if (key === 'freq') uFreq.value = val;
    else if (key === 'scroll') uScroll.value = val;
    else if (key === 'repeat') uRepeat.value = val;
    else if (key === 'core') uCore.value = val;
    else if (key === 'coreAmt') uCoreAmt.value = val;
    else if (key === 'texAmt') uTexAmt.value = val;
    else if (key === 'tube') tubeMesh.visible = !!val;
    else if (key === 'tubeRadius') { tubeRadius = val; tubeMesh.scale.set(1, val, val); }
    else if (key === 'tubeColor') uTubeColor.value.set(val);
    else if (key === 'tubeEmissive') uTubeEmis.value = val;
    else if (key === 'tubeOpacity') uTubeOpac.value = val;
    else if (key === 'tubeScroll') uTubeScroll.value = val;
    else if (key === 'tubeFresnel') uTubeFres.value = val;
    else if (key === 'tubeTwist') uTubeTwist.value = val;
  }
  // 円筒テクスチャ（スプライトシート）差替。cols/rows/fps 未指定は据え置き。
  function setTubeTexture(src, cols, rows, fps) {
    if (src != null) tubeTexNode.value = loadFxTexture(src);
    if (cols) uTubeCols.value = cols;
    if (rows) uTubeRows.value = rows;
    if (fps) uTubeFps.value = fps;
  }
  function dispose() { geo.dispose(); mat.dispose(); tubeGeo.dispose(); tubeMat.dispose(); }

  return { object3D: group, update, setEmitting, burst, setEndpoints, setParam, setTexture, setTubeTexture, dispose };
}
