// fx-textures.js — VFX 用テクスチャの調達。
// 内蔵プロシージャル（canvas生成）＋ 外部URL（threejs公式 perlin 等）＋ アップロード(dataURL) を一元化。
//
//   const tex = loadFxTexture('builtin:soft');     // 内蔵
//   const tex = loadFxTexture('data:image/png;...'); // アップロード
//   const tex = loadFxTexture('https://.../x.png');  // URL
//
// 内蔵一覧は BUILTIN_TEXTURES（fx-builder のドロップダウン用）。

import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';

export const BUILTIN_TEXTURES = [
  { id: 'soft',     label: 'ソフト円' },
  { id: 'glow',     label: 'グロー' },
  { id: 'ring',     label: 'リング' },
  { id: 'gradient', label: '縦グラデ' },
  { id: 'stripes',  label: 'ストライプ' },
  { id: 'spark',    label: 'スパーク' },
  { id: 'dots',     label: 'ドット' },
  { id: 'perlin',   label: 'perlinノイズ' },
  { id: 'thunder',  label: 'thunder（雷シート）' },
];

const PERLIN_URL = 'https://threejs.org/examples/textures/noises/perlin/rgb-256x256.png';
// ルートに置かれた thunder.png（各FXアプリは1階層下なので '../' で参照）
const THUNDER_URL = '../thunder.png';
const _cache = new Map();   // key(src) -> THREE.Texture

function makeCanvas(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  return { cv, g: cv.getContext('2d'), s: size };
}
function toTexture(cv) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function builtinCanvas(name) {
  const { cv, g, s } = makeCanvas(256);
  const c = s / 2;
  if (name === 'soft' || name === 'glow') {
    const inner = name === 'glow' ? 0.25 : 0.5;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(inner, name === 'glow' ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
  } else if (name === 'ring') {
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0.0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0)');
    grad.addColorStop(0.78, 'rgba(255,255,255,1)');
    grad.addColorStop(0.9, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
  } else if (name === 'gradient') {
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
  } else if (name === 'stripes') {
    g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, s, s);
    const n = 8;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * s;
      const grad = g.createLinearGradient(x - s / n / 2, 0, x + s / n / 2, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(x - s / n / 2, 0, s / n, s);
    }
  } else if (name === 'spark') {
    g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, s, s);
    const grad = g.createRadialGradient(c, c, 0, c, c, c * 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(c, c, c * 0.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3;
    for (let a = 0; a < 4; a++) {
      const ang = a * Math.PI / 2;
      g.beginPath(); g.moveTo(c, c);
      g.lineTo(c + Math.cos(ang) * c, c + Math.sin(ang) * c); g.stroke();
    }
  } else if (name === 'dots') {
    g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(255,255,255,1)';
    // 固定配置（乱数を使わず再現可能に）
    for (let i = 0; i < 40; i++) {
      const x = ((i * 67) % 250) + 3, y = ((i * 113) % 250) + 3, r = 2 + (i % 4);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  } else {
    g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  }
  return cv;
}

function drawBuiltin(name) { return toTexture(builtinCanvas(name)); }

// 粒子(lib/fx-particles)用に、texture src を「読み込める文字列(URL/dataURL/null)」へ解決する。
export function fxTextureSrc(src) {
  if (!src || !src.startsWith('builtin:')) return src || null;
  const name = src.slice('builtin:'.length);
  if (name === 'perlin') return PERLIN_URL;
  if (name === 'thunder') return THUNDER_URL;
  if (name === 'soft') return null;   // fx-particles 既定のソフト円
  return builtinCanvas(name).toDataURL();
}

/** src を解決してテクスチャを返す（キャッシュ付き）。null は内蔵 soft。 */
export function loadFxTexture(src) {
  if (!src) src = 'builtin:soft';
  if (_cache.has(src)) return _cache.get(src);
  let tex;
  if (src.startsWith('builtin:')) {
    const name = src.slice('builtin:'.length);
    // perlin はノイズ「データ」なので sRGB 変換しない（NoColorSpace）。これを sRGB にすると
    // .g/.b 値がずれて remap 後にほぼ常時1になり、dark 等の alpha が真っ黒で潰れる。
    if (name === 'perlin') tex = loadUrlTexture(PERLIN_URL, THREE.NoColorSpace);
    else if (name === 'thunder') tex = loadUrlTexture(THUNDER_URL, THREE.SRGBColorSpace);   // 色画像（雷シート）
    else tex = drawBuiltin(name);
  } else {
    tex = loadUrlTexture(src, THREE.SRGBColorSpace);   // dataURL or http(s)（色画像）
  }
  _cache.set(src, tex);
  return tex;
}

function loadUrlTexture(url, colorSpace) {
  const tex = new THREE.TextureLoader().load(url);
  tex.colorSpace = colorSpace ?? THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
