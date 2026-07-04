// fx-tornado.js — WebGPU(TSL) 手続き的トルネードVFX。
// three.js 公式サンプル webgpu_tsl_vfx_tornado を移植し、FXエディタ/ゲームから使える
// 「エフェクト1個」として小さなインターフェイスで公開する。
//
// 使い方（fx-particles の createFxSystem と同形）:
//   const fx = createTornado({ color:'#ff8b4d', scale:1.5 });
//   scene.add(fx.object3D);
//   fx.setEmitting(true|false);   // 表示ON/OFF
//   // 毎フレーム fx.update(dt)（TSLのtimeは自動更新なので実質no-op）
//   fx.dispose();
//
// 構成: ねじれ円柱(emissive=内側・dark=外側) ＋ 床グロー の3メッシュをGroupにまとめる。
// 見た目の発光は本来 bloom を併用するが、ここでは emissive 色のみ（bloom無しでも渦は見える）。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  luminance, cos, min, time, uniform, PI, color,
  positionLocal, sin, texture, Fn, uv, vec2, vec3, vec4,
} from 'https://esm.sh/three@0.184.0/tsl';
import * as TSL from 'https://esm.sh/three@0.184.0/tsl';

// atan の2引数(atan2)はバージョンで揺れるため、atan2 があればそれ、無ければ atan(y,x)。
const atan2 = TSL.atan2 || TSL.atan;

// perlin ノイズ（RGB各chを別ノイズに使う）。three.js 公式テクスチャを利用。全トルネードで共有。
const PERLIN_URL = 'https://threejs.org/examples/textures/noises/perlin/rgb-256x256.png';
let _perlinTex = null;
function getPerlin() {
  if (_perlinTex) return _perlinTex;
  _perlinTex = new THREE.TextureLoader().load(PERLIN_URL);
  _perlinTex.wrapS = THREE.RepeatWrapping;
  _perlinTex.wrapT = THREE.RepeatWrapping;
  return _perlinTex;
}

export function createTornado(opts = {}) {
  const perlinTexture = getPerlin();
  const TWO_PI = PI.mul(2);

  // ── TSL ヘルパ ──
  const toRadialUv = Fn(([uvN, multiplier, rotation, offset]) => {
    const centeredUv = uvN.sub(0.5).toVar();
    const distanceToCenter = centeredUv.length();
    const angle = atan2(centeredUv.y, centeredUv.x);
    const radialUv = vec2(angle.add(PI).div(TWO_PI), distanceToCenter).toVar();
    radialUv.mulAssign(multiplier);
    radialUv.x.addAssign(rotation);
    radialUv.y.addAssign(offset);
    return radialUv;
  });

  const toSkewedUv = Fn(([uvN, skew]) => {
    return vec2(uvN.x.add(uvN.y.mul(skew.x)), uvN.y.add(uvN.x.mul(skew.y)));
  });

  const twistedCylinder = Fn(([position, pStrength, pOffset, pAmplitude, t]) => {
    const angle = atan2(position.z, position.x).toVar();
    const elevation = position.y;
    const radius = pStrength.mul(position.y.sub(pOffset)).pow(2).add(pAmplitude).toVar();
    radius.addAssign(sin(elevation.sub(t).mul(20).add(angle.mul(2))).mul(0.05));
    return vec3(cos(angle).mul(radius), elevation, sin(angle).mul(radius));
  });

  // ── uniforms ──
  const emissiveColor   = uniform(color(opts.color ?? '#ff8b4d'));
  const timeScale       = uniform(opts.timeScale ?? 0.2);
  const parabolStrength  = uniform(opts.parabolStrength ?? 1);
  const parabolOffset    = uniform(opts.parabolOffset ?? 0.3);
  const parabolAmplitude = uniform(opts.parabolAmplitude ?? 0.2);

  const group = new THREE.Group();

  // ── 床グロー ──
  const floorMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true });
  floorMaterial.outputNode = Fn(() => {
    const scaledTime = time.mul(timeScale);
    const noise1Uv = toRadialUv(uv(), vec2(0.5, 0.5), scaledTime, scaledTime);
    noise1Uv.assign(toSkewedUv(noise1Uv, vec2(-1, 0)));
    noise1Uv.mulAssign(vec2(4, 1));
    const noise1 = texture(perlinTexture, noise1Uv, 1).r.remap(0.45, 0.7);
    const noise2Uv = toRadialUv(uv(), vec2(2, 8), scaledTime.mul(2), scaledTime.mul(8));
    noise2Uv.assign(toSkewedUv(noise2Uv, vec2(-0.25, 0)));
    noise2Uv.mulAssign(vec2(2, 0.25));
    const noise2 = texture(perlinTexture, noise2Uv, 1).b.remap(0.45, 0.7);
    const distanceToCenter = uv().sub(0.5).toVar();
    const outerFade = min(
      distanceToCenter.length().oneMinus().smoothstep(0.5, 0.9),
      distanceToCenter.length().smoothstep(0, 0.2),
    );
    const effect = noise1.mul(noise2).mul(outerFade).toVar();
    return vec4(emissiveColor.mul(effect.step(0.2)).mul(3), effect.smoothstep(0, 0.01));
  })();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), floorMaterial);
  floor.rotation.x = -Math.PI * 0.5;
  group.add(floor);

  // ── 円柱（emissive/dark で共有）──
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 20, 20, true);
  cylinderGeometry.translate(0, 0.5, 0);

  // ── 内側 emissive ──
  const emissiveMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
  emissiveMaterial.positionNode = twistedCylinder(positionLocal, parabolStrength, parabolOffset, parabolAmplitude.sub(0.05), time.mul(timeScale));
  emissiveMaterial.outputNode = Fn(() => {
    const scaledTime = time.mul(timeScale);
    const noise1Uv = uv().add(vec2(scaledTime, scaledTime.negate())).toVar();
    noise1Uv.assign(toSkewedUv(noise1Uv, vec2(-1, 0)));
    noise1Uv.mulAssign(vec2(2, 0.25));
    const noise1 = texture(perlinTexture, noise1Uv, 1).r.remap(0.45, 0.7);
    const noise2Uv = uv().add(vec2(scaledTime.mul(0.5), scaledTime.negate())).toVar();
    noise2Uv.assign(toSkewedUv(noise2Uv, vec2(-1, 0)));
    noise2Uv.mulAssign(vec2(5, 1));
    const noise2 = texture(perlinTexture, noise2Uv, 1).g.remap(0.45, 0.7);
    const outerFade = min(uv().y.smoothstep(0, 0.1), uv().y.oneMinus().smoothstep(0, 0.4));
    const effect = noise1.mul(noise2).mul(outerFade);
    const lum = luminance(emissiveColor);
    return vec4(emissiveColor.mul(1.2).div(lum), effect.smoothstep(0, 0.1));
  })();
  group.add(new THREE.Mesh(cylinderGeometry, emissiveMaterial));

  // ── 外側 dark ──
  const darkMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.DoubleSide });
  darkMaterial.positionNode = twistedCylinder(positionLocal, parabolStrength, parabolOffset, parabolAmplitude, time.mul(timeScale));
  darkMaterial.outputNode = Fn(() => {
    const scaledTime = time.mul(timeScale).add(123.4);
    const noise1Uv = uv().add(vec2(scaledTime, scaledTime.negate())).toVar();
    noise1Uv.assign(toSkewedUv(noise1Uv, vec2(-1, 0)));
    noise1Uv.mulAssign(vec2(2, 0.25));
    const noise1 = texture(perlinTexture, noise1Uv, 1).g.remap(0.45, 0.7);
    const noise2Uv = uv().add(vec2(scaledTime.mul(0.5), scaledTime.negate())).toVar();
    noise2Uv.assign(toSkewedUv(noise2Uv, vec2(-1, 0)));
    noise2Uv.mulAssign(vec2(5, 1));
    const noise2 = texture(perlinTexture, noise2Uv, 1).b.remap(0.45, 0.7);
    const outerFade = min(uv().y.smoothstep(0, 0.2), uv().y.oneMinus().smoothstep(0, 0.4));
    const effect = noise1.mul(noise2).mul(outerFade);
    return vec4(vec3(0), effect.smoothstep(0, 0.01));
  })();
  group.add(new THREE.Mesh(cylinderGeometry, darkMaterial));

  group.scale.setScalar(opts.scale ?? 1.5);
  group.visible = false;

  function setEmitting(on) { group.visible = !!on; }
  function update() { /* TSL time は自動更新。位置は object3D 側で制御 */ }
  function burst() { group.visible = true; }   // 単発でも一応表示（基本は range 用）
  function setColor(hex) { emissiveColor.value.set(hex); }
  // 単体パラメータをライブ更新（FXエディタの調整UIから）
  function setParam(key, val) {
    if (key === 'color') emissiveColor.value.set(val);
    else if (key === 'timeScale') timeScale.value = val;
    else if (key === 'parabolStrength') parabolStrength.value = val;
    else if (key === 'parabolOffset') parabolOffset.value = val;
    else if (key === 'parabolAmplitude') parabolAmplitude.value = val;
    else if (key === 'scale') group.scale.setScalar(val);
  }
  function dispose() {
    cylinderGeometry.dispose();
    floor.geometry.dispose();
    floorMaterial.dispose();
    emissiveMaterial.dispose();
    darkMaterial.dispose();
    // perlinTexture は共有のため dispose しない
  }

  return { object3D: group, update, setEmitting, burst, setColor, setParam, dispose };
}
