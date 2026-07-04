// fx-builder.js — エフェクト・プリセット作成エディタ。
// 基本図形＋テクスチャ＋色/合成/スクロール/ねじれ/自転/脈動 のレイヤーを重ねて *.fx.json を作る。
// 生成は lib/fx-mesh.createMeshFx を共有（fx-editor の実体と同一の見た目）。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { positionWorld, mix, color, pass } from 'https://esm.sh/three@0.184.0/tsl';
import { bloom } from 'https://esm.sh/three@0.184.0/examples/jsm/tsl/display/BloomNode.js';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { createMeshFx, FX_GEOMETRIES } from '../lib/fx-mesh.js';
import { BUILTIN_TEXTURES } from '../lib/fx-textures.js';
import { FX_PRESETS } from '../lib/fx-particles.js';

let renderer, scene, camera, controls;
const timer = new THREE.Timer();
let post = null, bloomPass = null;
const bloomParams = { strength: 1.2, radius: 0.2, threshold: 0.6 };

let fx = null;
let specDirty = false;
let previewContinuous = true;   // 連続プレビュー。OFF＝単発（発射ボタンでバースト）
let selectedLayer = 0;
let fpsFrames = 0, fpsLast = performance.now();

const PARTICLE_PRESETS = ['fire', 'smoke', 'spark', 'frost'];

// public/ 直下のスプライトシート画像（manifest から取得）。{ value:'../name', label:'name' }
let sheetTextures = [];
async function loadSheetManifest() {
  try {
    const files = await (await fetch('../sheets/manifest.json')).json();
    sheetTextures = (Array.isArray(files) ? files : []).map(f => ({ value: '../' + f, label: f }));
  } catch { sheetTextures = []; }
}

function defaultMeshLayer() {
  return {
    type: 'mesh', geom: 'cylinder', size: 1, height: 1.5, color: '#ff8b4d', opacity: 1, emissive: 1.4,
    texture: 'builtin:perlin', repeat: [2, 1], scroll: [0, 0.3], alphaSource: 'luminance', texAngle: 0,
    twist: 0, spin: 0.4, pulse: 0, blending: 'additive', doubleSide: true, fadeEdges: true,
    pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
  };
}
function defaultParticleLayer() {
  const p = FX_PRESETS.fire;
  return {
    type: 'particle', preset: 'fire', colorStart: p.color.start, colorEnd: p.color.end,
    spawnRate: p.spawnRate, sizeStart: p.size.start, sizeEnd: p.size.end,
    texture: 'builtin:soft', blending: 'additive', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
  };
}
function defaultTornadoLayer() {
  return {
    type: 'tornado', color: '#ff8b4d', timeScale: 0.2, parabolStrength: 1, parabolOffset: 0.3, parabolAmplitude: 0.2,
    pos: [0, 0, 0], rot: [0, 0, 0], scale: [1.5, 1.5, 1.5],
  };
}
function defaultTslLayer() {
  return {
    type: 'tsl', geom: 'cylinder', size: 1.4, height: 1.5, blending: 'additive', doubleSide: true,
    pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1],
    code: [
      "// loadTex(src) でテクスチャ取得。TSL関数は素の名前で使える。",
      "// 返り値: { positionNode?, colorNode?, opacityNode?, outputNode? }",
      "const tex = loadTex('builtin:perlin');",
      "const col = uniform(color('#66ccff'));",
      "const outputNode = Fn(() => {",
      "  const t = time.mul(0.3);",
      "  const u = uv().mul(vec2(2, 1)).add(vec2(0, t));",
      "  const n = texture(tex, u, 1).r.remap(0.4, 0.75);",
      "  const fade = min(uv().y.smoothstep(0, 0.1), uv().y.oneMinus().smoothstep(0, 0.4));",
      "  return vec4(col.mul(n).mul(2), n.mul(fade));",
      "})();",
      "return { outputNode };",
    ].join('\n'),
  };
}

// トルネードの実シェーダを 3 TSLレイヤー(floor / emissive / dark) として取り込み（直接編集用）。
const TORNADO_SKEW = "const toSkewedUv = Fn(([uvN, sk]) => vec2(uvN.x.add(uvN.y.mul(sk.x)), uvN.y.add(uvN.x.mul(sk.y))));";
const TORNADO_TWIST = [
  "const twisted = Fn(([p, ps, po, pa, t]) => {",
  "  const ang = atan2(p.z, p.x).toVar();",
  "  const el = p.y;",
  "  const r = ps.mul(p.y.sub(po)).pow(2).add(pa).toVar();",
  "  r.addAssign(sin(el.sub(t).mul(20).add(ang.mul(2))).mul(0.05));",
  "  return vec3(cos(ang).mul(r), el, sin(ang).mul(r));",
  "});",
].join('\n');

function tornadoTslLayers() {
  const floor = {
    type: 'tsl', geom: 'plane', size: 2, height: 1, blending: 'additive', doubleSide: true,
    pos: [0, 0, 0], rot: [-90, 0, 0], scale: [1.5, 1.5, 1.5],
    code: [
      "const perlinTexture = loadTex('builtin:perlin');",
      "const emissiveColor = uniform(color('#ff8b4d'));",
      "const timeScale = uniform(0.2);",
      "const TWO_PI = PI.mul(2);",
      "const toRadialUv = Fn(([uvN, mul, rot, off]) => {",
      "  const c = uvN.sub(0.5).toVar();",
      "  const d = c.length();",
      "  const ang = atan2(c.y, c.x);",
      "  const r = vec2(ang.add(PI).div(TWO_PI), d).toVar();",
      "  r.mulAssign(mul); r.x.addAssign(rot); r.y.addAssign(off);",
      "  return r;",
      "});",
      TORNADO_SKEW,
      "const outputNode = Fn(() => {",
      "  const t = time.mul(timeScale);",
      "  const n1 = toRadialUv(uv(), vec2(0.5,0.5), t, t);",
      "  n1.assign(toSkewedUv(n1, vec2(-1,0))); n1.mulAssign(vec2(4,1));",
      "  const noise1 = texture(perlinTexture, n1, 1).r.remap(0.45,0.7);",
      "  const n2 = toRadialUv(uv(), vec2(2,8), t.mul(2), t.mul(8));",
      "  n2.assign(toSkewedUv(n2, vec2(-0.25,0))); n2.mulAssign(vec2(2,0.25));",
      "  const noise2 = texture(perlinTexture, n2, 1).b.remap(0.45,0.7);",
      "  const dd = uv().sub(0.5).toVar();",
      "  const fade = min(dd.length().oneMinus().smoothstep(0.5,0.9), dd.length().smoothstep(0,0.2));",
      "  const eff = noise1.mul(noise2).mul(fade).toVar();",
      "  return vec4(emissiveColor.mul(eff.step(0.2)).mul(3), eff.smoothstep(0,0.01));",
      "})();",
      "return { outputNode };",
    ].join('\n'),
  };
  const emissive = {
    type: 'tsl', geom: 'cylinder', size: 2, height: 1, blending: 'additive', doubleSide: true,
    pos: [0, 0, 0], rot: [0, 0, 0], scale: [1.5, 1.5, 1.5],
    code: [
      "const perlinTexture = loadTex('builtin:perlin');",
      "const emissiveColor = uniform(color('#ff8b4d'));",
      "const timeScale = uniform(0.2);",
      "const parabolStrength = uniform(1), parabolOffset = uniform(0.3), parabolAmplitude = uniform(0.2);",
      TORNADO_SKEW,
      TORNADO_TWIST,
      "const positionNode = twisted(positionLocal, parabolStrength, parabolOffset, parabolAmplitude.sub(0.05), time.mul(timeScale));",
      "const outputNode = Fn(() => {",
      "  const t = time.mul(timeScale);",
      "  const n1 = uv().add(vec2(t, t.negate())).toVar();",
      "  n1.assign(toSkewedUv(n1, vec2(-1,0))); n1.mulAssign(vec2(2,0.25));",
      "  const noise1 = texture(perlinTexture, n1, 1).r.remap(0.45,0.7);",
      "  const n2 = uv().add(vec2(t.mul(0.5), t.negate())).toVar();",
      "  n2.assign(toSkewedUv(n2, vec2(-1,0))); n2.mulAssign(vec2(5,1));",
      "  const noise2 = texture(perlinTexture, n2, 1).g.remap(0.45,0.7);",
      "  const fade = min(uv().y.smoothstep(0,0.1), uv().y.oneMinus().smoothstep(0,0.4));",
      "  const eff = noise1.mul(noise2).mul(fade);",
      "  const lum = luminance(emissiveColor);",
      "  return vec4(emissiveColor.mul(1.2).div(lum), eff.smoothstep(0,0.1));",
      "})();",
      "return { positionNode, outputNode };",
    ].join('\n'),
  };
  const dark = {
    type: 'tsl', geom: 'cylinder', size: 2, height: 1, blending: 'normal', doubleSide: true,
    pos: [0, 0, 0], rot: [0, 0, 0], scale: [1.5, 1.5, 1.5],
    code: [
      "const perlinTexture = loadTex('builtin:perlin');",
      "const timeScale = uniform(0.2);",
      "const parabolStrength = uniform(1), parabolOffset = uniform(0.3), parabolAmplitude = uniform(0.2);",
      TORNADO_SKEW,
      TORNADO_TWIST,
      "const positionNode = twisted(positionLocal, parabolStrength, parabolOffset, parabolAmplitude, time.mul(timeScale));",
      "const outputNode = Fn(() => {",
      "  const t = time.mul(timeScale).add(123.4);",
      "  const n1 = uv().add(vec2(t, t.negate())).toVar();",
      "  n1.assign(toSkewedUv(n1, vec2(-1,0))); n1.mulAssign(vec2(2,0.25));",
      "  const noise1 = texture(perlinTexture, n1, 1).g.remap(0.45,0.7);",
      "  const n2 = uv().add(vec2(t.mul(0.5), t.negate())).toVar();",
      "  n2.assign(toSkewedUv(n2, vec2(-1,0))); n2.mulAssign(vec2(5,1));",
      "  const noise2 = texture(perlinTexture, n2, 1).b.remap(0.45,0.7);",
      "  const fade = min(uv().y.smoothstep(0,0.2), uv().y.oneMinus().smoothstep(0,0.4));",
      "  const eff = noise1.mul(noise2).mul(fade);",
      "  return vec4(vec3(0), eff.smoothstep(0,0.01));",
      "})();",
      "return { positionNode, outputNode };",
    ].join('\n'),
  };
  return [floor, emissive, dark];
}

let spec = { format: 'fx-preset', version: 1, name: 'new_effect', layers: [defaultMeshLayer()] };

// ============================================================
// 生成
// ============================================================
function rebuildFx() {
  if (fx) { scene.remove(fx.object3D); fx.dispose(); }
  fx = createMeshFx(spec);
  scene.add(fx.object3D);
  fx.setEmitting(previewContinuous);   // 連続プレビュー / 単発は発射ボタンで
  if (!previewContinuous) fx.object3D.visible = true;   // 単発でも配置は見せる（発射待ち）
}
// 単発（バースト）を1回。発射系・爆発系の試し用。
function testFire() {
  if (!fx) return;
  fx.object3D.visible = true;
  fx.burst(10);
}
function markDirty() { specDirty = true; }

// ============================================================
// UI ヘルパ
// ============================================================
function uiRow(label) {
  const r = document.createElement('div'); r.className = 'row';
  const l = document.createElement('label'); l.textContent = label; r.appendChild(l);
  return r;
}
function uiSlider(host, label, val, min, max, step, on) {
  const r = uiRow(label);
  const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = val; i.style.flex = '1';
  const v = document.createElement('span'); v.className = 'val'; v.textContent = Number(val).toFixed(2);
  i.addEventListener('input', () => { const x = parseFloat(i.value); v.textContent = x.toFixed(2); on(x); });
  r.appendChild(i); r.appendChild(v); host.appendChild(r);
}
function uiColor(host, label, val, on) {
  const r = uiRow(label);
  const i = document.createElement('input'); i.type = 'color'; i.value = val;
  i.addEventListener('input', () => on(i.value));
  r.appendChild(i); host.appendChild(r);
}
function uiSelect(host, label, opts, val, on) {
  const r = uiRow(label);
  const s = document.createElement('select'); s.style.flex = '1';
  for (const o of opts) { const e = document.createElement('option'); e.value = o.value; e.textContent = o.label; s.appendChild(e); }
  s.value = val;
  s.addEventListener('change', () => on(s.value));
  r.appendChild(s); host.appendChild(r);
}
function uiCheck(host, label, val, on) {
  const r = uiRow(label);
  const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!val;
  i.addEventListener('change', () => on(i.checked));
  r.appendChild(i); host.appendChild(r);
}
function uiVecN(host, label, arr, n, step, on) {
  const r = uiRow(label);
  for (let k = 0; k < n; k++) {
    const i = document.createElement('input'); i.type = 'number'; i.step = step; i.value = arr[k]; i.style.width = '48px';
    i.addEventListener('change', () => { arr[k] = parseFloat(i.value) || 0; on(); });
    r.appendChild(i);
  }
  host.appendChild(r);
}
function uiVec(host, label, arr, step, on) { uiVecN(host, label, arr, 3, step, on); }
function uiVec2(host, label, arr, step, on) { uiVecN(host, label, arr, 2, step, on); }
function uiTexture(host, layer) {
  const r = uiRow('テクスチャ');
  const sel = document.createElement('select'); sel.style.flex = '1';
  const addOpt = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); };
  for (const t of BUILTIN_TEXTURES) addOpt('builtin:' + t.id, t.label);
  for (const s of sheetTextures) addOpt(s.value, '🎞 ' + s.label);   // public/ のシート画像
  addOpt('__upload', '画像を選ぶ…');
  const known = [...BUILTIN_TEXTURES.map(t => 'builtin:' + t.id), ...sheetTextures.map(s => s.value)];
  if (layer.texture && known.includes(layer.texture)) sel.value = layer.texture;
  else if (layer.texture && !layer.texture.startsWith('builtin:')) { addOpt(layer.texture, '(アップロード画像)'); sel.value = layer.texture; }
  else sel.value = layer.texture || 'builtin:soft';
  sel.addEventListener('change', () => {
    if (sel.value === '__upload') pickTexture(layer, sel);
    else { layer.texture = sel.value; markDirty(); }
  });
  r.appendChild(sel); host.appendChild(r);
}
function uiFrames(host, l) {
  if (!l.frames) l.frames = { cols: 1, rows: 1, fps: 12 };
  const r = uiRow('タイル 列/行/fps');
  const mk = (key) => {
    const i = document.createElement('input'); i.type = 'number'; i.min = 1; i.step = 1; i.value = l.frames[key]; i.style.width = '44px'; i.title = key;
    i.addEventListener('change', () => { l.frames[key] = Math.max(1, parseInt(i.value) || 1); markDirty(); });
    return i;
  };
  r.appendChild(mk('cols')); r.appendChild(mk('rows')); r.appendChild(mk('fps'));
  host.appendChild(r);
  const h = document.createElement('div'); h.style.cssText = 'font-size:10px;color:#667;margin:-2px 0 4px 0;'; h.textContent = '列×行>1 でタイルをパラパラ再生（thunder等のシート）'; host.appendChild(h);
}

function pickTexture(layer, sel) {
  const inp = document.getElementById('tex-file');
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) { sel.value = layer.texture || 'builtin:soft'; return; }
    const rd = new FileReader();
    rd.onload = () => { layer.texture = rd.result; markDirty(); rebuildLayerEditor(); };
    rd.readAsDataURL(f); inp.value = '';
  };
  inp.click();
}

// ============================================================
// レイヤー一覧 / 選択レイヤーエディタ
// ============================================================
function layerLabel(l) {
  if (l.type === 'particle') return l.preset + ' 粒子';
  if (l.type === 'tornado') return 'トルネード';
  if (l.type === 'tsl') return 'TSL: ' + (FX_GEOMETRIES.find(g => g.id === l.geom)?.label || l.geom);
  return FX_GEOMETRIES.find(g => g.id === l.geom)?.label || l.geom;
}
function layerTag(l) { return l.type === 'particle' ? '粒子' : l.type === 'tornado' ? '竜巻' : l.type === 'tsl' ? 'TSL' : 'メッシュ'; }

function rebuildLayerList() {
  const host = document.getElementById('layer-list'); host.innerHTML = '';
  spec.layers.forEach((l, i) => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (i === selectedLayer ? ' sel' : '');
    const tag = document.createElement('span'); tag.className = 'tag ' + (l.type === 'particle' ? 'particle' : 'mesh'); tag.textContent = layerTag(l);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = layerLabel(l);
    item.appendChild(tag); item.appendChild(nm);
    item.addEventListener('click', () => { selectedLayer = i; rebuildLayerList(); rebuildLayerEditor(); });
    host.appendChild(item);
  });
}

function rebuildLayerEditor() {
  const host = document.getElementById('layer-editor'); host.innerHTML = '';
  const l = spec.layers[selectedLayer];
  if (!l) { host.innerHTML = '<div style="font-size:11px;color:#667;">レイヤーがありません</div>'; return; }

  if (l.type === 'mesh') {
    uiSelect(host, '図形', FX_GEOMETRIES.map(g => ({ value: g.id, label: g.label })), l.geom, v => { l.geom = v; markDirty(); rebuildLayerList(); });
    uiSlider(host, 'サイズ', l.size, 0.1, 5, 0.05, v => { l.size = v; markDirty(); });
    uiSlider(host, '高さ', l.height, 0.1, 5, 0.05, v => { l.height = v; markDirty(); });
    uiTexture(host, l);
    uiFrames(host, l);
    uiSelect(host, 'アルファ', [{ value: 'alpha', label: 'テクスチャα' }, { value: 'luminance', label: '輝度' }, { value: 'red', label: '赤ch' }], l.alphaSource || 'alpha', v => { l.alphaSource = v; markDirty(); });
    uiColor(host, '色', l.color, v => { l.color = v; markDirty(); });
    uiSlider(host, '発光', l.emissive, 0, 4, 0.05, v => { l.emissive = v; markDirty(); });
    uiSlider(host, '不透明度', l.opacity, 0, 1, 0.02, v => { l.opacity = v; markDirty(); });
    uiSelect(host, '合成', [{ value: 'additive', label: '加算' }, { value: 'normal', label: '通常' }], l.blending, v => { l.blending = v; markDirty(); });
    uiVec2(host, 'リピートUV', l.repeat, 0.5, () => markDirty());
    uiVec2(host, 'スクロールUV', l.scroll, 0.05, () => markDirty());
    uiSlider(host, 'テクスチャ角度', l.texAngle || 0, 0, 360, 5, v => { l.texAngle = v; markDirty(); });
    uiSlider(host, 'ねじれ', l.twist, -5, 5, 0.05, v => { l.twist = v; markDirty(); });
    uiSlider(host, '自転', l.spin, -3, 3, 0.05, v => { l.spin = v; markDirty(); });
    uiSlider(host, '脈動', l.pulse, 0, 1, 0.02, v => { l.pulse = v; markDirty(); });
    uiCheck(host, '端をフェード', l.fadeEdges, v => { l.fadeEdges = v; markDirty(); });
    uiCheck(host, '両面', l.doubleSide, v => { l.doubleSide = v; markDirty(); });
  } else if (l.type === 'tornado') {
    uiColor(host, '色', l.color, v => { l.color = v; markDirty(); });
    uiSlider(host, '回転速度', l.timeScale, -1, 1, 0.01, v => { l.timeScale = v; markDirty(); });
    uiSlider(host, '広がり', l.parabolStrength, 0, 2, 0.01, v => { l.parabolStrength = v; markDirty(); });
    uiSlider(host, '中心高', l.parabolOffset, 0, 1, 0.01, v => { l.parabolOffset = v; markDirty(); });
    uiSlider(host, '太さ', l.parabolAmplitude, 0, 2, 0.01, v => { l.parabolAmplitude = v; markDirty(); });
  } else if (l.type === 'tsl') {
    uiSelect(host, '図形', FX_GEOMETRIES.map(g => ({ value: g.id, label: g.label })), l.geom, v => { l.geom = v; markDirty(); rebuildLayerList(); });
    uiSlider(host, 'サイズ', l.size, 0.1, 5, 0.05, v => { l.size = v; markDirty(); });
    uiSlider(host, '高さ', l.height, 0.1, 5, 0.05, v => { l.height = v; markDirty(); });
    uiSelect(host, '合成', [{ value: 'additive', label: '加算' }, { value: 'normal', label: '通常' }], l.blending, v => { l.blending = v; markDirty(); });
    uiCheck(host, '両面', l.doubleSide, v => { l.doubleSide = v; markDirty(); });
    const ta = document.createElement('textarea');
    ta.value = l.code || ''; ta.spellcheck = false;
    ta.style.cssText = 'width:100%;height:220px;font-family:monospace;font-size:11px;background:#0c0c1a;color:#cde;border:1px solid #3a3a60;border-radius:4px;padding:6px;margin-top:4px;white-space:pre;overflow:auto;';
    host.appendChild(ta);
    const applyRow = document.createElement('div'); applyRow.className = 'row-wrap'; applyRow.style.marginTop = '4px';
    const btn = document.createElement('button'); btn.textContent = '適用 (Ctrl+Enter)';
    const apply = () => { l.code = ta.value; markDirty(); };
    btn.addEventListener('click', apply);
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } });
    applyRow.appendChild(btn);
    const hint = document.createElement('span'); hint.style.cssText = 'font-size:10px;color:#667;'; hint.textContent = '返り値: { positionNode?, colorNode?, opacityNode?, outputNode? }（失敗時マゼンタ・consoleに詳細）';
    applyRow.appendChild(hint);
    host.appendChild(applyRow);
  } else {
    uiSelect(host, 'ベース', PARTICLE_PRESETS.map(p => ({ value: p, label: p })), l.preset, v => { applyParticlePreset(l, v); markDirty(); rebuildLayerList(); rebuildLayerEditor(); });
    uiColor(host, '開始色', l.colorStart, v => { l.colorStart = v; markDirty(); });
    uiColor(host, '終了色', l.colorEnd, v => { l.colorEnd = v; markDirty(); });
    uiSlider(host, '発生/秒', l.spawnRate, 0, 200, 1, v => { l.spawnRate = v; markDirty(); });
    uiSlider(host, '開始サイズ', l.sizeStart, 0.02, 1.5, 0.01, v => { l.sizeStart = v; markDirty(); });
    uiSlider(host, '終了サイズ', l.sizeEnd, 0.02, 1.5, 0.01, v => { l.sizeEnd = v; markDirty(); });
    const presetCfg = FX_PRESETS[l.preset] || FX_PRESETS.fire;
    uiSlider(host, '重力(Y)', l.gravity != null ? l.gravity : presetCfg.acceleration[1], -20, 20, 0.1, v => { l.gravity = v; markDirty(); });
    uiSlider(host, '抵抗', l.drag != null ? l.drag : presetCfg.drag, 0, 3, 0.05, v => { l.drag = v; markDirty(); });
    uiSlider(host, 'ストレッチ', l.stretch != null ? l.stretch : 0, 0, 0.5, 0.01, v => { l.stretch = v; markDirty(); });
    // 床コリジョン（地面で弾ける/消える）
    uiSelect(host, '床衝突', [{ value: 'none', label: 'なし' }, { value: 'bounce', label: 'バウンド(はじける)' }, { value: 'kill', label: '消滅' }], l.floorMode || 'none', v => { l.floorMode = v; markDirty(); });
    uiSlider(host, '地面Y(世界)', l.floorY != null ? l.floorY : 0, -5, 5, 0.05, v => { l.floorY = v; markDirty(); });
    uiSlider(host, '反発', l.bounce != null ? l.bounce : 0.4, 0, 1, 0.05, v => { l.bounce = v; markDirty(); });
    // エミッタ（発生位置の形状・方向・拡散・速度）
    uiSelect(host, '発生形状', [{ value: 'point', label: '点' }, { value: 'disc', label: '円(平面)' }, { value: 'box', label: '箱' }], l.shape || presetCfg.emitter.shape, v => { l.shape = v; markDirty(); });
    uiSlider(host, '半径(円)', l.radius != null ? l.radius : presetCfg.emitter.radius, 0, 2, 0.01, v => { l.radius = v; markDirty(); });
    { const bsz = l.boxSize || presetCfg.emitter.size.slice(); uiVec(host, '箱サイズ', bsz, 0.05, () => { l.boxSize = bsz; markDirty(); }); }
    { const sp = l.speed || presetCfg.velocity.speed.slice(); uiVec2(host, '速度 min/max', sp, 0.1, () => { l.speed = sp; markDirty(); }); }
    { const dir = l.dir || presetCfg.emitter.rotation.slice(); uiVec(host, '発生方向(度)', dir, 5, () => { l.dir = dir; markDirty(); }); }
    uiSlider(host, '拡散(度)', l.spread != null ? l.spread : presetCfg.velocity.spreadDeg, 0, 90, 1, v => { l.spread = v; markDirty(); });
    // 回転（初期角度・回転速度 各 min/max）。※ストレッチ>0 のときは速度方向整列が優先
    { const ss = l.spinStart || (presetCfg.spin ? presetCfg.spin.startDeg.slice() : [0, 0]); uiVec2(host, '初期角 min/max', ss, 5, () => { l.spinStart = ss; markDirty(); }); }
    { const sv = l.spinSpeed || (presetCfg.spin ? presetCfg.spin.speedDeg.slice() : [0, 0]); uiVec2(host, '回転速度 min/max', sv, 5, () => { l.spinSpeed = sv; markDirty(); }); }
    uiTexture(host, l);
    uiFrames(host, l);   // スプライトシート（タイル）アニメ
    uiSelect(host, 'コマ再生', [{ value: 'overLife', label: '寿命で1巡' }, { value: 'loop', label: 'ループ' }, { value: 'once', label: '1回' }], (l.frames && l.frames.mode) || 'overLife', v => { if (!l.frames) l.frames = { cols: 1, rows: 1, fps: 12 }; l.frames.mode = v; markDirty(); });
    uiSelect(host, '合成', [{ value: 'additive', label: '加算' }, { value: 'normal', label: '通常' }], l.blending, v => { l.blending = v; markDirty(); });
  }
  // 共通：トランスフォーム
  const div = document.createElement('div'); div.style.cssText = 'border-top:1px solid #24264a;margin-top:6px;padding-top:6px;'; host.appendChild(div);
  uiVec(div, '位置', l.pos, 0.05, () => markDirty());
  uiVec(div, '回転(度)', l.rot, 5, () => markDirty());
  uiVec(div, 'スケール', l.scale, 0.05, () => markDirty());
}

function applyParticlePreset(l, preset) {
  const p = FX_PRESETS[preset]; if (!p) return;
  l.preset = preset; l.colorStart = p.color.start; l.colorEnd = p.color.end;
  l.spawnRate = p.spawnRate; l.sizeStart = p.size.start; l.sizeEnd = p.size.end;
}

// ============================================================
// レイヤー操作
// ============================================================
function addLayer(layer) { spec.layers.push(layer); selectedLayer = spec.layers.length - 1; rebuildLayerList(); rebuildLayerEditor(); markDirty(); }
function delLayer() { if (spec.layers.length <= 1) { toast('最低1レイヤー必要です', 'warn'); return; } spec.layers.splice(selectedLayer, 1); selectedLayer = Math.max(0, selectedLayer - 1); rebuildLayerList(); rebuildLayerEditor(); markDirty(); }
function dupLayer() { const c = JSON.parse(JSON.stringify(spec.layers[selectedLayer])); spec.layers.splice(selectedLayer + 1, 0, c); selectedLayer++; rebuildLayerList(); rebuildLayerEditor(); markDirty(); }
function moveLayer(d) { const j = selectedLayer + d; if (j < 0 || j >= spec.layers.length) return; const t = spec.layers[selectedLayer]; spec.layers[selectedLayer] = spec.layers[j]; spec.layers[j] = t; selectedLayer = j; rebuildLayerList(); rebuildLayerEditor(); markDirty(); }

// ============================================================
// 保存 / 読込
// ============================================================
function toast(msg, type = 'info') {
  const el = document.getElementById('toast'); el.textContent = msg; el.className = 'visible' + (type !== 'info' ? ' ' + type : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.className = ''; }, 2200);
}

async function savePreset() {
  const name = document.getElementById('preset-name').value.trim();
  const base = name.replace(/\.fx\.json$/i, '').replace(/[^\w\-]/g, '_');
  if (!base) { toast('名前が不正です', 'warn'); return; }
  spec.name = base;
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'fx', filename: `${base}.fx.json`, content: JSON.stringify(spec, null, 2) }) });
    const j = await r.json();
    if (j.ok) { toast(`保存: ${j.path}`); populateLoad(`${base}.fx.json`); } else toast('保存失敗', 'error');
  } catch (e) { toast(`保存失敗: ${e}`, 'error'); }
}

function populateLoad(selectName) {
  const sel = document.getElementById('load-select');
  fetch('../fx/manifest.json').then(r => r.ok ? r.json() : []).then(files => {
    sel.innerHTML = '<option value="">-- 読込 (fx) --</option>';
    for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.fx\.json$/, ''); if (f === selectName) o.selected = true; sel.appendChild(o); }
  }).catch(() => {});
}

async function loadPreset(file) {
  try {
    const j = await (await fetch('../fx/' + file)).json();
    if (!Array.isArray(j.layers)) throw new Error('無効なプリセット');
    spec = j; selectedLayer = 0;
    document.getElementById('preset-name').value = spec.name || file.replace(/\.fx\.json$/, '');
    rebuildLayerList(); rebuildLayerEditor(); markDirty();
    toast(`読込: ${spec.name}`);
  } catch (e) { toast(`読込失敗: ${e.message}`, 'error'); }
}

// ============================================================
// シーン / レンダ
// ============================================================
function buildRoom() {
  const grid = new THREE.GridHelper(8, 16, 0x4488ff, 0x223044);
  grid.material.transparent = true; grid.material.opacity = 0.4; scene.add(grid);
}
function updateFPS() {
  fpsFrames++; const now = performance.now(), el = now - fpsLast;
  if (el >= 500) { const f = Math.round(fpsFrames / (el / 1000)); document.getElementById('fps-counter').textContent = `${f} FPS`; document.getElementById('fps-toolbar').textContent = `${f} FPS`; fpsFrames = 0; fpsLast = now; }
}
function render() {
  timer.update(); const dt = Math.min(timer.getDelta(), 1 / 20); updateFPS();
  if (specDirty) { specDirty = false; rebuildFx(); }
  if (fx) fx.update(dt);
  controls.update();
  if (post) post.render(); else renderer.render(scene, camera);
}

function setupUI() {
  document.getElementById('btn-add-mesh').addEventListener('click', () => addLayer(defaultMeshLayer()));
  document.getElementById('btn-add-particle').addEventListener('click', () => addLayer(defaultParticleLayer()));
  document.getElementById('btn-add-tornado').addEventListener('click', () => addLayer(defaultTornadoLayer()));
  document.getElementById('btn-add-tsl').addEventListener('click', () => addLayer(defaultTslLayer()));
  // 既存エフェクトを取り込んで編集（spec をその内容で置き換え）
  const importSel = document.getElementById('import-base');
  importSel.addEventListener('change', () => {
    const kind = importSel.value; importSel.value = '';
    if (!kind) return;
    let layers;
    if (kind === 'tornado') layers = tornadoTslLayers();   // 実シェーダ3レイヤー(floor/emissive/dark)
    else { const l = defaultParticleLayer(); applyParticlePreset(l, kind); layers = [l]; }
    spec = { format: 'fx-preset', version: 1, name: document.getElementById('preset-name').value || kind, layers };
    selectedLayer = 0; rebuildLayerList(); rebuildLayerEditor(); markDirty();
    toast(`取り込み: ${kind}（${layers.length}レイヤー）`);
  });
  document.getElementById('btn-dup-layer').addEventListener('click', dupLayer);
  document.getElementById('btn-del-layer').addEventListener('click', delLayer);
  document.getElementById('btn-up-layer').addEventListener('click', () => moveLayer(-1));
  document.getElementById('btn-down-layer').addEventListener('click', () => moveLayer(1));
  document.getElementById('btn-save').addEventListener('click', savePreset);
  document.getElementById('btn-fire').addEventListener('click', testFire);
  const cbCont = document.getElementById('cb-continuous');
  if (cbCont) cbCont.addEventListener('change', () => {
    previewContinuous = cbCont.checked;
    if (fx) { fx.setEmitting(previewContinuous); if (!previewContinuous) fx.object3D.visible = true; }
  });
  document.getElementById('btn-new').addEventListener('click', () => { spec = { format: 'fx-preset', version: 1, name: document.getElementById('preset-name').value || 'new_effect', layers: [defaultMeshLayer()] }; selectedLayer = 0; rebuildLayerList(); rebuildLayerEditor(); markDirty(); });
  const loadSel = document.getElementById('load-select');
  loadSel.addEventListener('change', () => { if (loadSel.value) loadPreset(loadSel.value); });
  populateLoad();

  const bind = (id, on) => { const sl = document.getElementById(id), vl = document.getElementById(id + '-val'); if (!sl) return; sl.addEventListener('input', () => { const v = parseFloat(sl.value); if (vl) vl.textContent = v.toFixed(2); on(v); }); };
  bind('bloom-strength', v => { bloomParams.strength = v; if (bloomPass) bloomPass.strength.value = v; });
  bind('bloom-radius', v => { bloomParams.radius = v; if (bloomPass) bloomPass.radius.value = v; });
  bind('bloom-threshold', v => { bloomParams.threshold = v; if (bloomPass) bloomPass.threshold.value = v; });
}

async function init() {
  const app = document.getElementById('app'), loading = document.getElementById('loading');
  if (!navigator.gpu) { document.getElementById('webgpu-warning').style.display = 'block'; throw new Error('WebGPU 非対応のブラウザです'); }

  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  app.appendChild(renderer.domElement);
  await renderer.init();
  const setSize = () => { const w = app.clientWidth, h = app.clientHeight; renderer.setSize(w, h); if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); } };
  setSize();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e18);
  camera = new THREE.PerspectiveCamera(45, app.clientWidth / app.clientHeight, 0.01, 100);
  camera.position.set(2.2, 1.5, 3.0);

  const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const skyT = positionWorld.normalize().y.mul(0.5).add(0.5).clamp(0, 1);
  skyMat.colorNode = mix(color(0x161a2a), color(0x080810), skyT);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 24, 12), skyMat); sky.frustumCulled = false; scene.add(sky);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.7, 0); controls.update();
  buildRoom();

  try {
    post = new THREE.PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode();
    bloomPass = bloom(sceneColor, bloomParams.strength, bloomParams.radius, bloomParams.threshold);
    post.outputNode = sceneColor.add(bloomPass);
  } catch (e) { console.warn('Bloom 初期化失敗:', e); post = null; bloomPass = null; }

  timer.connect(document);
  await loadSheetManifest();   // public/ のシート画像をテクスチャ選択へ
  setupUI();
  rebuildLayerList(); rebuildLayerEditor();
  rebuildFx();

  window.addEventListener('resize', setSize);
  loading.classList.add('hidden'); setTimeout(() => { loading.style.display = 'none'; }, 400);
  renderer.setAnimationLoop(render);
}

init().catch(err => { console.error(err); const l = document.getElementById('loading'); if (l) l.textContent = `初期化失敗: ${err.message}`; });
