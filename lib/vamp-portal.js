// vamp-portal.js — WebGL用「壁/床/天井に開く闇の穴」エフェクト。ノイズ縁で穴が広がり(0→1)、
// 内側は闇、縁は淡い発光。ここから吸血鬼が出入りする。WebGPU版 fx-dissolve の代替(AR=WebGL用)。
import * as THREE from 'https://esm.sh/three@0.184.0';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uProg;      // 穴の広がり 0..1
uniform vec3 uVoid, uRim; // 闇色 / 縁の発光色
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c * vec2(1.15, 1.0)) * 2.0;          // 縦長楕円（人型に近い穴）
  float n = (vnoise(vUv * 7.0) - 0.5) * 0.26 + (vnoise(vUv * 18.0) - 0.5) * 0.10;
  float rr = r + n;
  float edge = 0.13;
  float inside = 1.0 - smoothstep(uProg - edge, uProg + edge, rr);   // 穴の内側=1
  if (inside < 0.02) discard;
  float rim = smoothstep(uProg - edge, uProg - edge * 0.2, rr);      // 縁付近で明るく
  vec3 col = mix(uVoid, uRim, rim * 0.9);
  gl_FragColor = vec4(col, inside);
}`;

// createPortal(parent) → { group, setProgress, place(pos, lookAt), update, dispose }
export function createPortal(parent, opts = {}) {
  const w = opts.width ?? 1.5, h = opts.height ?? 2.2;
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, side: THREE.DoubleSide,
    depthWrite: false,
    uniforms: {
      uProg: { value: 0 },
      uVoid: { value: new THREE.Color(opts.voidColor ?? '#04010a') },
      uRim: { value: new THREE.Color(opts.rimColor ?? '#5a1030') },
    },
  });
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = -1;   // 背景寄り（吸血鬼が前に出る）
  group.add(mesh);
  group.visible = false;
  parent.add(group);

  const _look = new THREE.Vector3();
  return {
    group,
    setProgress(p) { mat.uniforms.uProg.value = Math.max(0, Math.min(1.05, p)); group.visible = p > 0.001; },
    // 穴を pos に置き、lookAt(通常プレイヤー)の方を向ける（穴の面はプレイヤーに正対）
    place(pos, lookAt) {
      group.position.copy(pos);
      if (lookAt) { _look.copy(lookAt); _look.y = pos.y; group.lookAt(_look); }
    },
    update() { /* 予備 */ },
    dispose() { parent.remove(group); mesh.geometry.dispose(); mat.dispose(); },
  };
}
