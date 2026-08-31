// grab-editor.js — City-Fly の掴み対象（プロップ／コンテナ）の当たり判定を確認・調整するエディタ。
// 形状は lib/grab-shapes.js を本編と共有し、判定は本編と同じ「ローカルOBB」方式で表示・射線テストする。
// 保存先: public/cityfly/grabhit.json（City-Fly が起動時に読んで上書き適用）。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { GRAB_SHAPES, makeGrabGeo, fitHitBox } from '../lib/grab-shapes.js';

const $ = (id) => document.getElementById(id);
const app = $('app');

// ── シーン ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141a28);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 4000);
camera.position.set(45, 26, 45);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x30384a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(60, 90, 40); scene.add(sun);
scene.add(new THREE.GridHelper(200, 40, 0x3a4a68, 0x232c40));

// 実寸の目安になる人型（ネイ相当 1.6m）
const human = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.05, 4, 10), new THREE.MeshStandardMaterial({ color: 0xe05a7a, roughness: 0.7 }));
human.position.set(0, 0.81, 0);
scene.add(human);

// ── 状態 ──
let cfg = { format: 'grabhit', version: 1, kinds: {} };
let cur = null;   // { kind, mesh, geo, scale, box:{c,h}, wire }
const kindSel = $('kind');
for (const [k, d] of Object.entries(GRAB_SHAPES)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = `${d.label}（${k}）　質量${d.mass}`;
  kindSel.appendChild(o);
}

const wireMat = new THREE.LineBasicMaterial({ color: 0x36ff9a });
const glbCache = new Map();

async function loadGeo(kind) {   // 本編と同じ正規化（底面y=0・XZ中心／GLBは長軸をXへ）
  const d = GRAB_SHAPES[kind];
  if (!d.glb) return { geo: makeGrabGeo(THREE, kind), scale: 1 };
  if (!glbCache.has(kind)) {
    const url = '../models/' + d.glb.split('/').map(encodeURIComponent).join('/');
    const gltf = await new GLTFLoader().loadAsync(new URL(url, location.href).href);
    let geo = null;
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse((o) => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); parts.push(g); } });
    geo = parts[0];
    for (let i = 1; i < parts.length; i++) {   // 単純結合（位置属性のみ使う）
      const merged = new THREE.BufferGeometry();
      const a = geo.attributes.position.array, b = parts[i].attributes.position.array;
      const arr = new Float32Array(a.length + b.length); arr.set(a); arr.set(b, a.length);
      merged.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      geo = merged;
    }
    geo.computeBoundingBox();
    let bb = geo.boundingBox;
    if ((bb.max.z - bb.min.z) > (bb.max.x - bb.min.x)) { geo.rotateY(Math.PI / 2); geo.computeBoundingBox(); bb = geo.boundingBox; }
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geo.computeBoundingBox();
    geo.computeVertexNormals();
    glbCache.set(kind, geo);
  }
  const geo = glbCache.get(kind);
  const sx = geo.boundingBox.max.x - geo.boundingBox.min.x;
  return { geo, scale: d.fitX / Math.max(0.01, sx) };
}

async function selectKind(kind) {
  if (cur) { scene.remove(cur.mesh); if (cur.wire) scene.remove(cur.wire); }
  const { geo, scale } = await loadGeo(kind);
  const d = GRAB_SHAPES[kind];
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0.75 }));
  mesh.scale.setScalar(scale);
  scene.add(mesh);
  const base = fitHitBox(THREE, geo);                       // 実寸の既定値（ローカル）
  const ov = cfg.kinds[kind];
  const box = { c: base.c.clone(), h: base.h.clone() };
  if (ov) { box.h.set(ov.hx / scale, ov.hy / scale, ov.hz / scale); if (ov.cy != null) box.c.y = ov.cy / scale; }
  cur = { kind, mesh, geo, scale, box, wire: null };
  rebuildWire();
  const size = base.h.clone().multiplyScalar(2 * scale);
  controls.target.set(0, size.y / 2, 0);
  const r = Math.max(size.x, size.y, size.z);
  camera.position.set(r * 0.9, r * 0.6 + 3, r * 0.9);
  controls.update();
  syncInputs();
}

function rebuildWire() {
  if (cur.wire) scene.remove(cur.wire);
  const g = new THREE.EdgesGeometry(new THREE.BoxGeometry(cur.box.h.x * 2, cur.box.h.y * 2, cur.box.h.z * 2));
  const w = new THREE.LineSegments(g, wireMat);
  w.position.copy(cur.box.c).multiplyScalar(cur.scale);
  w.scale.setScalar(cur.scale);
  scene.add(w);
  cur.wire = w;
}

function syncInputs() {
  const k = cur.scale;
  $('hx').value = (cur.box.h.x * 2 * k).toFixed(2);
  $('hy').value = (cur.box.h.y * 2 * k).toFixed(2);
  $('hz').value = (cur.box.h.z * 2 * k).toFixed(2);
  $('cy').value = (cur.box.c.y * k).toFixed(2);
  const base = fitHitBox(THREE, cur.geo);
  const bs = base.h.clone().multiplyScalar(2 * k);
  const d = GRAB_SHAPES[cur.kind];
  const diff = Math.abs(cur.box.h.x - base.h.x) + Math.abs(cur.box.h.y - base.h.y) + Math.abs(cur.box.h.z - base.h.z) > 1e-4;
  $('meta').innerHTML = `見た目の実寸: ${bs.x.toFixed(2)} × ${bs.y.toFixed(2)} × ${bs.z.toFixed(2)} m　質量${d.mass}`
    + (diff ? '<br><span style="color:#ffd76a">※判定が実寸と不一致</span>' : '<br><span style="color:#7fe0a0">判定＝実寸で一致</span>');
}

function setField(f, val) {
  const k = cur.scale;
  if (f === 'cy') cur.box.c.y = val / k;
  else cur.box.h[f === 'hx' ? 'x' : f === 'hy' ? 'y' : 'z'] = Math.max(0.05, val / 2 / k);
  rebuildWire();
  syncInputs();
}

for (const b of document.querySelectorAll('button.stp')) {
  b.onclick = () => setField(b.dataset.f, parseFloat($(b.dataset.f).value) + parseFloat(b.dataset.d));
}
for (const f of ['hx', 'hy', 'hz', 'cy']) $(f).onchange = () => setField(f, parseFloat($(f).value) || 0);
kindSel.onchange = () => selectKind(kindSel.value);
$('fit').onclick = () => { const b = fitHitBox(THREE, cur.geo); cur.box.c.copy(b.c); cur.box.h.copy(b.h); rebuildWire(); syncInputs(); $('info').textContent = '実寸に合わせました'; };
$('reset').onclick = () => { delete cfg.kinds[cur.kind]; selectKind(cur.kind); $('info').textContent = '保存値を破棄（実寸に戻しました）'; };
$('save').onclick = async () => {
  const k = cur.scale;
  cfg.kinds[cur.kind] = {
    hx: +(cur.box.h.x * k).toFixed(3), hy: +(cur.box.h.y * k).toFixed(3),
    hz: +(cur.box.h.z * k).toFixed(3), cy: +(cur.box.c.y * k).toFixed(3),
  };
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'cityfly', name: 'grabhit.json', data: cfg }) });
    $('info').textContent = r.ok ? 'grabhit.json に保存しました' : '保存失敗（' + r.status + '）';
  } catch (e) { $('info').textContent = '保存失敗: ' + e.message; }
};

// ── 射線テスト（本編 rayHitObj と同じローカルOBB判定）──
const shots = [];
const _inv = new THREE.Matrix4(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
function rayHitObb(o, d, mesh, box, maxT) {
  mesh.updateMatrixWorld();
  _inv.copy(mesh.matrixWorld).invert();
  _o.copy(o).applyMatrix4(_inv);
  _d.copy(d).transformDirection(_inv);
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const oc = _o[ax] - box.c[ax], dd = _d[ax], h = box.h[ax];
    if (Math.abs(dd) < 1e-9) { if (Math.abs(oc) > h) return Infinity; continue; }
    let t1 = (-h - oc) / dd, t2 = (h - oc) / dd;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }
  const tl = tmin > 0 ? tmin : (tmax > 0 ? tmax : Infinity);
  if (tl === Infinity) return Infinity;
  _p.copy(_o).addScaledVector(_d, tl).applyMatrix4(mesh.matrixWorld);
  const tw = _p.distanceTo(o);
  return tw <= maxT ? tw : Infinity;
}
const _ndc = new THREE.Vector2(), _ray = new THREE.Raycaster();
renderer.domElement.addEventListener('click', (e) => {   // クリック方向へ射線を撃って命中を確認
  if (!cur) return;
  _ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  const t = rayHitObb(_ray.ray.origin, _ray.ray.direction, cur.mesh, cur.box, 4000);
  const hit = t < Infinity;
  const end = _ray.ray.origin.clone().addScaledVector(_ray.ray.direction, hit ? t : 300);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([_ray.ray.origin.clone(), end]),
    new THREE.LineBasicMaterial({ color: hit ? 0xff5a5a : 0x666f88 }));
  scene.add(line);
  shots.push({ line, t: 0 });
  if (shots.length > 12) { const s = shots.shift(); scene.remove(s.line); }
  $('info').textContent = hit ? `命中（${t.toFixed(2)} m）` : '外れ';
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

(async () => {
  try { const r = await fetch('../cityfly/grabhit.json'); if (r.ok) cfg = await r.json(); } catch { /* 未保存 */ }
  if (!cfg.kinds) cfg.kinds = {};
  await selectKind(kindSel.value || 'beam');
  kindSel.value = cur.kind;
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
})();
