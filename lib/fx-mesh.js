// fx-mesh.js — データ駆動メッシュVFX。
// 「基本図形＋テクスチャ＋色/加算合成＋UVスクロール/ねじれ/自転/脈動」のレイヤーを重ねて
// 1つのエフェクトを構成する。粒子(lib/fx-particles)もレイヤーとして混在可。
//
// spec(*.fx.json):
//   { format:'fx-preset', version:1, name, layers:[ <layer> ... ] }
//   mesh layer:
//     { type:'mesh', geom:'cylinder', size:1, height:1, color:'#ff8b4d', opacity:1, emissive:1.4,
//       texture:'builtin:perlin', repeat:[2,1], scroll:[0,0.2], alphaSource:'luminance',
//       twist:0, spin:0, pulse:0, blending:'additive', doubleSide:true, fadeEdges:true,
//       pos:[0,0,0], rot:[0,0,0], scale:[1,1,1] }
//   particle layer:
//     { type:'particle', preset:'fire', colorStart, colorEnd, spawnRate, sizeStart, sizeEnd,
//       texture:'builtin:soft', blending:'additive', pos:[..], rot:[..], scale:[..] }
//
// 公開IF（他のfxと同形）: { object3D, update(dt), setEmitting(on), dispose }

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { uv, vec2, vec3, vec4, texture, time, color, sin, cos, min, positionLocal, Fn, float, uniform, PI, luminance, floor, mod } from 'https://esm.sh/three@0.184.0/tsl';
import * as TSL from 'https://esm.sh/three@0.184.0/tsl';
import { createFxSystem, cloneFxConfig, FX_PRESETS } from './fx-particles.js';
import { loadFxTexture, fxTextureSrc } from './fx-textures.js';
import { createTornado } from './fx-tornado.js';

const atan2 = TSL.atan2 || TSL.atan;   // 2引数 atan の互換

export const FX_GEOMETRIES = [
  { id: 'plane', label: '平面' }, { id: 'disc', label: '円盤' }, { id: 'ring', label: 'リング' },
  { id: 'cylinder', label: '円柱' }, { id: 'cone', label: '円錐' }, { id: 'sphere', label: '球' },
  { id: 'box', label: '箱' }, { id: 'torus', label: 'トーラス' }, { id: 'icosa', label: '多面体' },
];

function buildGeom(layer) {
  const sz = layer.size ?? 1, h = layer.height ?? 1;
  switch (layer.geom) {
    case 'disc':     return new THREE.CircleGeometry(sz * 0.5, 48);
    case 'ring':     return new THREE.RingGeometry(sz * 0.28, sz * 0.5, 48);
    case 'cylinder': { const g = new THREE.CylinderGeometry(sz * 0.5, sz * 0.5, h, 24, 20, true); g.translate(0, h / 2, 0); return g; }
    case 'cone':     { const g = new THREE.ConeGeometry(sz * 0.5, h, 24, 20, true); g.translate(0, h / 2, 0); return g; }
    case 'sphere':   return new THREE.SphereGeometry(sz * 0.5, 24, 16);
    case 'box':      return new THREE.BoxGeometry(sz, sz, sz);
    case 'torus':    return new THREE.TorusGeometry(sz * 0.4, sz * 0.15, 16, 36);
    case 'icosa':    return new THREE.IcosahedronGeometry(sz * 0.5, 1);
    case 'plane':
    default:         return new THREE.PlaneGeometry(sz, sz);
  }
}

// 高さに比例してY軸まわりにねじる（円柱/円錐向け。amount は定数）
function twistedPositionNode(amount) {
  const p = positionLocal;
  const a = p.y.mul(amount);
  const s = sin(a), c = cos(a);
  return vec3(p.x.mul(c).sub(p.z.mul(s)), p.y, p.x.mul(s).add(p.z.mul(c)));
}

function buildMeshLayer(layer) {
  const geom = buildGeom(layer);
  const tex = loadFxTexture(layer.texture);
  const repeat = layer.repeat || [1, 1];
  const scroll = layer.scroll || [0, 0];
  // スプライトシート（タイル）アニメ：frames.cols×rows>1 ならコマを時間で切替（thunder.png 等）
  const fr = layer.frames;
  let uvNode;
  if (fr && (fr.cols || 1) * (fr.rows || 1) > 1) {
    const cols = fr.cols || 1, rows = fr.rows || 1, fps = fr.fps || 12, total = cols * rows;
    const fi = mod(floor(time.mul(fps)), total);     // ループ再生のコマ番号
    const fcol = mod(fi, cols);
    const frow = floor(fi.div(cols));
    uvNode = vec2(
      fcol.add(uv().x).div(cols),
      float(1).sub(frow.add(float(1).sub(uv().y)).div(rows)),   // frame0=左上
    );
  } else {
    uvNode = uv().mul(vec2(repeat[0], repeat[1])).add(vec2(scroll[0], scroll[1]).mul(time));
  }
  const texNode = texture(tex, uvNode);
  const tint = color(layer.color || '#ffffff');
  const emissive = layer.emissive ?? 1.0;

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false,
    side: layer.doubleSide === false ? THREE.FrontSide : THREE.DoubleSide,
  });
  mat.blending = (layer.blending === 'normal') ? THREE.NormalBlending : THREE.AdditiveBlending;
  mat.colorNode = texNode.rgb.mul(tint).mul(emissive);

  // アルファの取り方（テクスチャにより alpha / 輝度 / 赤 を選択）
  let aNode;
  if (layer.alphaSource === 'luminance') aNode = texNode.r.add(texNode.g).add(texNode.b).div(3);
  else if (layer.alphaSource === 'red')  aNode = texNode.r;
  else aNode = texNode.a;

  // 端のフェード（円柱/円錐=縦 / それ以外=中心からの放射）
  let opacityNode = aNode.mul(layer.opacity ?? 1);
  if (layer.fadeEdges) {
    let fade;
    if (layer.geom === 'cylinder' || layer.geom === 'cone') {
      fade = min(uv().y.smoothstep(0, 0.12), uv().y.oneMinus().smoothstep(0, 0.35));
    } else {
      fade = uv().sub(0.5).length().oneMinus().smoothstep(0.0, 0.5);
    }
    opacityNode = opacityNode.mul(fade);
  }
  mat.opacityNode = opacityNode;

  if (layer.twist) mat.positionNode = twistedPositionNode(layer.twist);

  const mesh = new THREE.Mesh(geom, mat);
  applyTransform(mesh, layer);
  return { mesh, mat, geom, baseScale: mesh.scale.clone(), spin: layer.spin || 0, pulse: layer.pulse || 0 };
}

// TSLレイヤー：layer.code（JS本体）を評価して { positionNode, colorNode, opacityNode, outputNode } を得る。
// コードからは TSL関数を素の名前で使える（uv(), time, texture, Fn ...）。loadTex(src) でテクスチャ取得。
// 開発専用ツールのため eval を許容。コンパイル失敗時はマゼンタ半透明にフォールバック。
const TSL_ARG_NAMES = ['THREE', 'Fn', 'uv', 'vec2', 'vec3', 'vec4', 'texture', 'time', 'color', 'sin', 'cos', 'min', 'atan2', 'positionLocal', 'float', 'PI', 'uniform', 'luminance', 'loadTex'];
const TSL_ARG_VALUES = [THREE, Fn, uv, vec2, vec3, vec4, texture, time, color, sin, cos, min, atan2, positionLocal, float, PI, uniform, luminance, loadFxTexture];

function buildTslMaterial(layer) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false,
    side: layer.doubleSide === false ? THREE.FrontSide : THREE.DoubleSide,
  });
  mat.blending = (layer.blending === 'normal') ? THREE.NormalBlending : THREE.AdditiveBlending;
  try {
    const fn = new Function(...TSL_ARG_NAMES, layer.code || 'return {};');
    const res = fn(...TSL_ARG_VALUES) || {};
    if (res.positionNode) mat.positionNode = res.positionNode;
    if (res.colorNode) mat.colorNode = res.colorNode;
    if (res.opacityNode) mat.opacityNode = res.opacityNode;
    if (res.outputNode) mat.outputNode = res.outputNode;
  } catch (e) {
    console.warn('TSLレイヤー compile失敗:', e);
    mat.colorNode = color('#ff00ff'); mat.opacityNode = float(0.35);
    mat._tslError = String(e && e.message || e);
  }
  return mat;
}

function buildTslLayer(layer) {
  const geom = buildGeom(layer);
  const mat = buildTslMaterial(layer);
  const mesh = new THREE.Mesh(geom, mat);
  applyTransform(mesh, layer);
  return { mesh, mat, geom, baseScale: mesh.scale.clone(), spin: layer.spin || 0, pulse: layer.pulse || 0 };
}

function buildParticleLayer(layer) {
  const cfg = cloneFxConfig(FX_PRESETS[layer.preset] || FX_PRESETS.fire);
  if (layer.colorStart != null) cfg.color.start = layer.colorStart;
  if (layer.colorEnd != null) cfg.color.end = layer.colorEnd;
  if (layer.spawnRate != null) cfg.spawnRate = layer.spawnRate;
  if (layer.sizeStart != null) cfg.size.start = layer.sizeStart;
  if (layer.sizeEnd != null) cfg.size.end = layer.sizeEnd;
  if (layer.blending) cfg.blending = layer.blending;
  if (layer.texture) cfg.texture = fxTextureSrc(layer.texture);
  const fx = createFxSystem(cfg);
  applyTransform(fx.object3D, layer);
  return { fx };
}

// トルネード（lib/fx-tornado の専用TSL）をレイヤーとして組み込む。サイズは layer.scale で制御。
function buildTornadoLayer(layer) {
  const tor = createTornado({
    color: layer.color, timeScale: layer.timeScale,
    parabolStrength: layer.parabolStrength, parabolOffset: layer.parabolOffset,
    parabolAmplitude: layer.parabolAmplitude,
  });
  applyTransform(tor.object3D, layer);
  return { tor };
}

function applyTransform(obj, layer) {
  const p = layer.pos || [0, 0, 0], r = layer.rot || [0, 0, 0], s = layer.scale || [1, 1, 1];
  obj.position.set(p[0], p[1], p[2]);
  obj.rotation.set(THREE.MathUtils.degToRad(r[0]), THREE.MathUtils.degToRad(r[1]), THREE.MathUtils.degToRad(r[2]));
  obj.scale.set(s[0], s[1], s[2]);
}

export function createMeshFx(spec) {
  const group = new THREE.Group();
  const meshLayers = [];
  const particles = [];
  const tornados = [];
  const layers = spec?.layers || [];
  layers.forEach((layer, i) => {
    try {
      if (layer.type === 'particle') {
        const pl = buildParticleLayer(layer);
        group.add(pl.fx.object3D);
        particles.push(pl);
      } else if (layer.type === 'tornado') {
        const tl = buildTornadoLayer(layer);
        group.add(tl.tor.object3D);
        tornados.push(tl);
      } else {
        const ml = (layer.type === 'tsl') ? buildTslLayer(layer) : buildMeshLayer(layer);
        // 重ね順をレイヤー順で固定（半透明ソートで崩れ、加算→通常合成の重なりが乱れるのを防ぐ）
        ml.mesh.renderOrder = i + 1;
        group.add(ml.mesh);
        meshLayers.push(ml);
      }
    } catch (e) { console.warn('レイヤー生成失敗:', layer, e); }
  });
  group.visible = false;
  let localTime = 0;

  function update(dt) {
    localTime += dt;
    for (const ml of meshLayers) {
      if (ml.spin) ml.mesh.rotation.y += ml.spin * dt;
      if (ml.pulse) {
        const k = 1 + ml.pulse * 0.25 * Math.sin(localTime * 3);
        ml.mesh.scale.copy(ml.baseScale).multiplyScalar(k);
      }
    }
    for (const pl of particles) pl.fx.update(dt);
    for (const tl of tornados) tl.tor.update(dt);
  }
  function setEmitting(on) {
    group.visible = !!on;
    for (const pl of particles) pl.fx.setEmitting(!!on);
    for (const tl of tornados) tl.tor.setEmitting(!!on);
  }
  function burst(n) {
    group.visible = true;
    for (const pl of particles) pl.fx.burst(n || 16);
    for (const tl of tornados) tl.tor.burst(n);
  }
  function dispose() {
    for (const ml of meshLayers) { ml.geom.dispose(); ml.mat.dispose(); }
    for (const pl of particles) pl.fx.dispose();
    for (const tl of tornados) tl.tor.dispose();
  }

  return { object3D: group, update, setEmitting, burst, dispose };
}
