// cloth-demo-common.js — CPU版 / WebGL2(GPGPU)版 の布デモ共通部品。
// どちらもWebGLRenderer（＝WebGPU非依存・XRで動く前提）で、シーン・素材・スフィア運動・
// グリッド生成・HUDを共有し、「シミュレーションの実装だけ」を差し替えて公平に比較する。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { VRButton } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/VRButton.js';
import { ARButton } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/ARButton.js';

// 布の配置（両版で共通）
export const CLOTH = { width: 1.2, height: 1.2, topY: 0.6 };
export const SPHERE_R = 0.25;

export function sphereCenter(t, out) {
  out.set(Math.sin(t * 2.1) * 0.12, -0.05, Math.sin(t * 0.8) * 0.9);
  return out;
}

// グリッド生成: 頂点(N+1)²・上端行ピン・三角形index・texture参照UV。
export function buildGrid(N) {
  const per = N + 1, count = per * per;
  const initPos = new Float32Array(count * 3);
  const pinned = new Uint8Array(count);
  const ref = new Float32Array(count * 2);   // GPU版: 位置テクスチャ参照UV
  const s = CLOTH.width / N;                  // セル間隔（正方グリッド）
  const idx = (i, j) => j * per + i;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = idx(i, j);
      initPos[k * 3]     = (i / N - 0.5) * CLOTH.width;
      initPos[k * 3 + 1] = CLOTH.topY - (j / N) * CLOTH.height;
      initPos[k * 3 + 2] = 0;
      pinned[k] = j === 0 ? 1 : 0;            // 上端行を固定
      ref[k * 2]     = (i + 0.5) / per;
      ref[k * 2 + 1] = (j + 0.5) / per;
    }
  }
  const indices = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(initPos.slice(), 3));
  geo.setAttribute('ref', new THREE.BufferAttribute(ref, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { N, per, count, s, initPos, pinned, ref, geometry: geo };
}

// 布マテリアル（両版共通の見た目）: MeshPhysicalMaterial + sheen + 表裏色。
// mode='gpu' のときだけ頂点位置・法線を位置テクスチャから読む（onBeforeCompile注入）。
export function makeClothMaterial(mode, { front = '#2f56b0', back = '#b0402f', texRes = 0 } = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide, roughness: 1.0, metalness: 0.0,
    sheen: 1.0, sheenRoughness: 0.5, sheenColor: new THREE.Color('#ffffff'),
  });
  const uFront = { value: new THREE.Color(front) };
  const uBack = { value: new THREE.Color(back) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFront = uFront;
    shader.uniforms.uBack = uBack;
    // 表裏で色を分ける（折り目が読みやすい）
    shader.fragmentShader = 'uniform vec3 uFront;\nuniform vec3 uBack;\n' + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  diffuseColor.rgb = gl_FrontFacing ? uFront : uBack;',
    );
    if (mode === 'gpu') {
      shader.uniforms.posTex = { value: null };
      shader.uniforms.texRes = { value: texRes };
      shader.vertexShader = 'uniform sampler2D posTex;\nuniform float texRes;\nattribute vec2 ref;\n' + shader.vertexShader;
      // 位置＝テクスチャ、法線＝近傍テクセルの差分から
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        'vec3 transformed = texture2D(posTex, ref).xyz;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        [
          'float _tx = 1.0 / texRes;',
          'vec3 _pR = texture2D(posTex, ref + vec2(_tx, 0.0)).xyz;',
          'vec3 _pL = texture2D(posTex, ref - vec2(_tx, 0.0)).xyz;',
          'vec3 _pU = texture2D(posTex, ref + vec2(0.0, _tx)).xyz;',
          'vec3 _pD = texture2D(posTex, ref - vec2(0.0, _tx)).xyz;',
          'vec3 objectNormal = normalize(cross(_pR - _pL, _pD - _pU));',
        ].join('\n'),
      );
    }
    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'cloth-' + mode;
  return { material: mat, uFront, uBack };
}

export function initDemo() {
  const app = document.getElementById('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });   // alpha=ARパススルー用
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.xr.enabled = true;   // WebXR（没入VR/AR）を有効化
  renderer.setClearColor(0x000000, 0);
  app.appendChild(renderer.domElement);
  // VR/AR 両方のボタン（左右に並べる）
  const vrBtn = VRButton.createButton(renderer);
  const arBtn = ARButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
  vrBtn.style.left = 'calc(50% - 130px)'; vrBtn.style.width = '110px';
  arBtn.style.left = 'calc(50% + 20px)'; arBtn.style.width = '110px';
  document.body.appendChild(vrBtn);
  document.body.appendChild(arBtn);

  const scene = new THREE.Scene();
  const BG = new THREE.Color(0x1a1a2e);
  scene.background = BG;
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
  camera.position.set(0.15, 0.0, 2.5);
  scene.add(camera);   // カメラを scene に入れる＝子のFPSパネルが描画される
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.update();

  // 布・スフィアを入れる「コンテンツ群」。ARでは現実の目の前へ移動（シミュは原点空間で走る＝影響なし）
  const content = new THREE.Group();
  scene.add(content);

  // AR（パススルー）判定: セッションが透過モードなら背景を消してコンテンツを目の前へ
  renderer.xr.addEventListener('sessionstart', () => {
    const s = renderer.xr.getSession();
    const ar = s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque';
    if (ar) { scene.background = null; content.position.set(0, 1.1, -0.8); }
    else { scene.background = BG; content.position.set(0, 0, 0); }
  });
  renderer.xr.addEventListener('sessionend', () => { scene.background = BG; content.position.set(0, 0, 0); });

  // ── XR用 FPSパネル（頭部追従・没入中だけ表示）。DOMのHUDはXRで見えないため ──
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 160;
  const ctx = cv.getContext('2d');
  const panelTex = new THREE.CanvasTexture(cv);
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.156),
    new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthTest: false }),
  );
  panel.position.set(0, 0.28, -1.0);   // 視界のやや上・1m前（頭部追従）
  panel.renderOrder = 999;
  panel.visible = false;
  camera.add(panel);
  const fpsPanel = {
    mesh: panel, renderer,
    draw(lines) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(12,16,28,0.82)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.textBaseline = 'top';
      lines.forEach((ln, i) => {
        ctx.font = i === 0 ? 'bold 30px system-ui' : '34px monospace';
        ctx.fillStyle = i === 0 ? '#9fd0ff' : (ln.includes('FPS') ? '#8fe98f' : '#e6ecf5');
        ctx.fillText(ln, 16, 12 + i * 44);
      });
      panelTex.needsUpdate = true;
    },
  };

  // ライトは常設（HDRが読めなくても布が見える）。HDRはsheenの質感向上に追加で使う
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(1, 2, 1.5); scene.add(dl);
  new UltraHDRLoader()
    .loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
    .then((tex) => { tex.mapping = THREE.EquirectangularReflectionMapping; scene.environment = tex; })
    .catch(() => { /* HDR無しでもライトで見える */ });

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R * 0.97, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.4, metalness: 0.1 }),
  );
  content.add(sphere);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  return { renderer, scene, camera, controls, sphere, fpsPanel, content };
}

// HUD（FPS・頂点数・解像度スライダ）
export function initHud({ label, onResolution, onWind, onWire, fpsPanel }) {
  document.getElementById('hud-label').textContent = label;
  const fpsEl = document.getElementById('hud-fps');
  const vEl = document.getElementById('hud-verts');
  const rEl = document.getElementById('res');
  const rVal = document.getElementById('res-val');
  const wEl = document.getElementById('wind');
  const wireEl = document.getElementById('wire');
  let frames = 0, last = performance.now(), curFps = 0, curVerts = 0;
  rEl.addEventListener('input', () => {
    const n = parseInt(rEl.value, 10);
    rVal.textContent = `${n}×${n}`;
    clearTimeout(rEl._t);
    rEl._t = setTimeout(() => onResolution(n), 250);
  });
  if (wEl) wEl.addEventListener('input', () => onWind(parseFloat(wEl.value)));
  if (wireEl && onWire) wireEl.addEventListener('change', () => onWire(wireEl.checked));
  return {
    tick(verts) {
      frames++;
      if (verts != null) curVerts = verts;
      const now = performance.now();
      if (now - last >= 500) {
        curFps = Math.round(frames / ((now - last) / 1000));
        frames = 0; last = now;
        fpsEl.textContent = curFps + ' FPS';
        vEl.textContent = curVerts.toLocaleString() + ' 頂点';
        if (fpsPanel) fpsPanel.draw([label, curFps + ' FPS', curVerts.toLocaleString() + ' 頂点']);
      }
      // XR没入中だけ頭部追従パネルを表示（DOMのHUDは見えないため）
      if (fpsPanel) fpsPanel.mesh.visible = !!fpsPanel.renderer.xr.isPresenting;
    },
  };
}
