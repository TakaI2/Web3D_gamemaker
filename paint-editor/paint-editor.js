// paint-editor.js — 生成オブジェクト（自作モデル）の面ペイント＋旧戦闘機の3色編集。
// public/models/generated/<id>/model.glb をドロップダウンから選び、
//   ・面をクリック/ドラッグでパレットの色を塗る（右クリック=スポイト）
//   ・「発光で塗る」を選ぶと、その面だけ加算合成で光る（本編と同じ表現）
//   ・前後反転ボタン（機首の向きがモデルによって逆なことがあるため）
// 保存: public/models/generated/<id>/paint.json = {colors:[...], glow:[...], flip180}
// 旧戦闘機（手続き生成）は lib/jet-shapes.js を本編と共有し、3色（本体/アクセント/コクピット発光）を
// public/cityfly/jet-colors.json に保存する。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'https://esm.sh/three@0.184.0/examples/jsm/utils/BufferGeometryUtils.js';
import { TransformControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/TransformControls.js';
import { buildLegacyJet, JET_DEFAULT_COLORS, JET_CUSTOM_LEN } from '../lib/jet-shapes.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const info = (msg) => { $('info').textContent = msg; };

// ── シーン ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141a28);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 4000);
camera.position.set(16, 10, 16);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
app.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
// 排気位置ギズモ（本編と同じ意味の translate。ドラッグ中はOrbitControlsを止める）
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate'); transformControls.size = 0.8;
transformControls.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
scene.add(transformControls.getHelper ? transformControls.getHelper() : transformControls);
let exhaustEditMode = false;
scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x30384a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(10, 16, 8); scene.add(sun);
scene.add(new THREE.GridHelper(60, 24, 0x3a4a68, 0x232c40));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// 進行方向の矢印＝常に「シーンの固定+Z」（root直下の子にすると反転時にモデルと一緒に回ってしまい、
// 反転が合っているかの目印にならない。scene直下に固定して、モデル側をrootごと回して合わせる）
const fwdArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), JET_CUSTOM_LEN * 0.9, 0x3adf7c, JET_CUSTOM_LEN * 0.18, JET_CUSTOM_LEN * 0.1);
fwdArrow.visible = false;
scene.add(fwdArrow);

let current = null;   // { kind:'legacy'|'painted', root, ... }
// ゲーム側はflip180のとき geometry.rotateY(Math.PI) を直接頂点データへ焼き込む(R空間→G空間、(x,y,z)→(-x,y,-z))。
// エディタは表示上rootを回すだけでマーカー自身の座標は常にR空間のまま保つので、保存/読込時にだけ
// この変換（自己逆変換）を掛けて一致させる（掛け忘れると反転時に排気位置がズレる）
function flipXZ(p, flip) { return flip ? { ...p, x: -p.x, z: -p.z } : p; }
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// ══════════ 対象一覧（ドロップダウン） ══════════
const objSel = $('obj');
async function buildObjList() {
  const legacyOpt = document.createElement('option');
  legacyOpt.value = '__legacy__'; legacyOpt.textContent = '旧戦闘機（手続き生成）';
  objSel.appendChild(legacyOpt);
  let items = [];
  try { const r = await fetch('../models/generated-manifest.json'); if (r.ok) items = await r.json(); } catch { /* noop */ }
  for (const it of items.filter((x) => x.hasGlb)) {
    const o = document.createElement('option');
    o.value = it.id; o.textContent = it.id + (it.hasPaint ? '（塗装済）' : '（未塗装）');
    objSel.appendChild(o);
  }
}
objSel.addEventListener('change', () => loadSelected(objSel.value));

function clearCurrent() {
  transformControls.detach();
  setExhaustMode(false);
  if (current?.root) { scene.remove(current.root); current.root.traverse((o) => { o.geometry?.dispose(); }); }
  current = null;
  fwdArrow.visible = false;
  $('flip180').classList.remove('on');
  $('flip180').style.display = ''; $('exhaustMode').style.display = '';   // 塔で隠した戦闘機専用ボタンを戻す
  $('legacySwatches').style.display = 'none';
  $('paintPanel').style.display = 'none';
}
function setExhaustMode(on) {
  exhaustEditMode = on;
  $('exhaustMode')?.classList.toggle('on', on);
  $('exhaustFields').style.display = on ? 'block' : 'none';
  if (current?.kind === 'painted') {
    if (on) transformControls.attach(current.exhaustMarker);
    else transformControls.detach();
  }
}

// ══════════ 旧戦闘機モード（3色スウォッチ） ══════════
async function loadLegacy() {
  clearCurrent();
  let colors = JET_DEFAULT_COLORS;
  try { const r = await fetch('../cityfly/jet-colors.json'); if (r.ok) colors = await r.json(); } catch { /* 既定色のまま */ }
  const built = buildLegacyJet(THREE, colors);
  scene.add(built.group);
  current = { kind: 'legacy', root: built.group, materials: built.materials };
  $('lgBody').value = colors.body; $('lgAccent').value = colors.accent; $('lgGlow').value = colors.glow;
  $('legacySwatches').style.display = 'block';
  $('meta').textContent = '手続き生成（Box/Cone/Sphere等の組み合わせ）';
  info('');
}
function applyLegacyPreview() {
  if (current?.kind !== 'legacy') return;
  const { mBody, mAcc, mGlow } = current.materials;
  mBody.color.set($('lgBody').value);
  mAcc.color.set($('lgAccent').value);
  const g = $('lgGlow').value;
  mGlow.emissive.set(g);
  mGlow.color.set(g).multiplyScalar(0.35);
}
for (const id of ['lgBody', 'lgAccent', 'lgGlow']) $(id).addEventListener('input', applyLegacyPreview);
$('saveLegacy').addEventListener('click', async () => {
  const data = { body: $('lgBody').value, accent: $('lgAccent').value, glow: $('lgGlow').value };
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'cityfly', filename: 'jet-colors.json', content: data }) });
    info(r.ok ? 'jet-colors.json に保存しました（次回のゲーム起動から反映）' : '保存失敗（' + r.status + '）');
  } catch (e) { info('保存失敗: ' + e.message); }
});

// ══════════ 生成オブジェクト・面ペイントモード ══════════
const PALETTE_DEFAULT = ['#16121e', '#5b2fa8', '#9a5cff', '#ffffff', '#ff4a5e', '#3adf7c'];
let palette = [...PALETTE_DEFAULT];
let curColorIdx = 0, brushGlow = false;

function renderPalette() {
  const wrap = $('palette'); wrap.innerHTML = '';
  palette.forEach((hex, i) => {
    const sw = document.createElement('div');
    sw.className = 'sw' + (i === curColorIdx ? ' cur' : '');
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener('click', () => { curColorIdx = i; renderPalette(); });
    wrap.appendChild(sw);
  });
}
$('addColor').addEventListener('click', () => {
  palette.push($('newColor').value);
  curColorIdx = palette.length - 1;
  renderPalette();
});
$('glowOn').addEventListener('click', () => { brushGlow = true; $('glowOn').classList.add('on'); $('glowOff').classList.remove('on'); });
$('glowOff').addEventListener('click', () => { brushGlow = false; $('glowOff').classList.add('on'); $('glowOn').classList.remove('on'); });

async function loadPainted(id) {
  clearCurrent();
  let paint = null;   // 縮尺の基準軸(kind)の判定に使うので、モデルより先に読む
  try { const r = await fetch('../models/generated/' + id + '/paint.json'); if (r.ok) paint = await r.json(); } catch { /* 未塗装 */ }
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(new URL('../models/generated/' + id + '/model.glb', location.href).href);
  gltf.scene.updateMatrixWorld(true);
  const parts = [];
  gltf.scene.traverse((o) => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); parts.push(g); } });
  let merged = parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
  merged = merged.toNonIndexed();   // 面ごとに独立した頂点にする（本編の適用時と同じ規約）
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  const bb = merged.boundingBox, bbSize = bb.getSize(new THREE.Vector3());
  // ゲームと同じ実寸(JET_CUSTOM_LEN)に正規化した縮尺。root配下はこの縮尺の空間＝ここで置いた
  // 排気ギズモの座標がそのままゲーム側(jet.mesh基準)で使える。
  // 塔などの縦長オブジェクトはZ基準だとプレビューが破綻するので、種別で基準軸を変える
  // （kind未保存のものは形状から推定＝高さが最長なら'prop'。戦闘機は従来どおりZ基準のまま）
  const kind = paint?.kind || (bbSize.y > Math.max(bbSize.x, bbSize.z) ? 'prop' : 'jet');
  const isJet = kind !== 'prop';
  const scale = JET_CUSTOM_LEN / Math.max(0.01, isJet ? bbSize.z : Math.max(bbSize.x, bbSize.y, bbSize.z));
  const posY = -bbSize.y * scale / 2 - bb.min.y * scale;
  const triCount = merged.attributes.position.count / 3;

  const colors = (paint?.colors?.length === triCount) ? paint.colors.slice() : new Array(triCount).fill('#888888');
  const glow = (paint?.glow?.length === triCount) ? paint.glow.slice() : new Array(triCount).fill(false);
  let flip180 = !!paint?.flip180;

  const colorAttr = new Float32Array(triCount * 3 * 3);
  const c = new THREE.Color();
  function repaintAttr() {
    for (let t = 0; t < triCount; t++) {
      c.set(colors[t]);
      for (let v = 0; v < 3; v++) { const o = (t * 3 + v) * 3; colorAttr[o] = c.r; colorAttr[o + 1] = c.g; colorAttr[o + 2] = c.b; }
    }
    merged.attributes.color.needsUpdate = true;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
  repaintAttr();

  const root = new THREE.Group();   // このGroup配下はゲーム実寸空間（機体の見た目スケールは内側のvisualGroupへ）
  const visual = new THREE.Group();
  visual.scale.setScalar(scale); visual.position.y = posY;
  root.add(visual);
  const baseMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.45, side: THREE.DoubleSide });
  const baseMesh = new THREE.Mesh(merged, baseMat);
  visual.add(baseMesh);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', merged.attributes.position);
  glowGeo.setAttribute('color', merged.attributes.color);
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.renderOrder = 1;
  visual.add(glowMesh);
  function rebuildGlowIndex() {
    const idx = [];
    for (let t = 0; t < triCount; t++) if (glow[t]) idx.push(t * 3, t * 3 + 1, t * 3 + 2);
    glowGeo.setIndex(idx);
  }
  rebuildGlowIndex();

  if (flip180) root.rotation.y = Math.PI;
  scene.add(root);
  fwdArrow.visible = isJet;   // 固定の目印＝ゲーム内で進む方向。この矢印の先にモデルの機首が向くようrootごと回して合わせる（塔は向きの概念が無いので出さない）

  // 排気ギズモ（root直下＝ゲーム実寸空間。座標がそのまま jet.mesh 基準で使える）
  const exDefault = { x: 0, y: 0, z: -JET_CUSTOM_LEN * 0.42, len: JET_CUSTOM_LEN * 0.6, rad: JET_CUSTOM_LEN * 0.045 };
  // 保存済みはG空間（flip180時点で焼き込み後の座標）なので、R空間で置くエディタのマーカーへ戻す
  const exData = paint?.exhaust ? flipXZ({ ...exDefault, ...paint.exhaust }, flip180) : exDefault;
  const exhaustMarker = new THREE.Group();
  exhaustMarker.position.set(exData.x, exData.y, exData.z);
  const exGeo = new THREE.ConeGeometry(1, 1, 12, 1, true); exGeo.rotateX(-Math.PI / 2); exGeo.translate(0, 0, -0.5);
  const exMat = new THREE.MeshBasicMaterial({ color: 0xffa050, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const exPreview = new THREE.Mesh(exGeo, exMat);
  exPreview.scale.set(exData.rad, exData.rad, exData.len);
  exhaustMarker.add(exPreview);
  root.add(exhaustMarker);
  $('exLen').value = exData.len.toFixed(2); $('exRad').value = exData.rad.toFixed(3);
  const updateExPreview = () => exPreview.scale.set(exData.rad, exData.rad, exData.len);
  exhaustMarker.visible = isJet;
  // 戦闘機専用の操作（前後反転・排気位置）は塔などでは出さない
  $('flip180').style.display = isJet ? '' : 'none';
  $('exhaustMode').style.display = isJet ? '' : 'none';

  current = {
    kind: 'painted', objKind: kind, root, id, mesh: baseMesh, triCount, colors, glow, flip180, exhaustMarker, exData,
    setFlip(v) { flip180 = v; current.flip180 = v; root.rotation.y = flip180 ? Math.PI : 0; },
    paintFace(t, hex, glowOn) { colors[t] = hex; glow[t] = glowOn; repaintAttr(); rebuildGlowIndex(); },
    resetAll() { colors.fill('#888888'); glow.fill(false); repaintAttr(); rebuildGlowIndex(); },
    setExhaustLen(v) { exData.len = v; updateExPreview(); },
    setExhaustRad(v) { exData.rad = v; updateExPreview(); },
    getExhaust() { return flipXZ({ x: exhaustMarker.position.x, y: exhaustMarker.position.y, z: exhaustMarker.position.z, len: exData.len, rad: exData.rad }, flip180); },
  };
  $('flip180').classList.toggle('on', flip180);
  $('meta').textContent = triCount + ' 面 / ' + (paint ? '保存済みの塗装を読込み' : '未塗装（グレー）');
  $('paintPanel').style.display = 'block';
  info('');
}

$('flip180').addEventListener('click', () => {
  if (current?.kind !== 'painted') return;
  current.setFlip(!current.flip180);
  $('flip180').classList.toggle('on', current.flip180);
});
$('exhaustMode').addEventListener('click', () => setExhaustMode(!exhaustEditMode));
$('exLen').addEventListener('input', () => { if (current?.kind === 'painted') current.setExhaustLen(+$('exLen').value || 0.1); });
$('exRad').addEventListener('input', () => { if (current?.kind === 'painted') current.setExhaustRad(+$('exRad').value || 0.05); });
$('resetPaint').addEventListener('click', () => { if (current?.kind === 'painted') current.resetAll(); });
$('savePaint').addEventListener('click', async () => {
  if (current?.kind !== 'painted') return;
  const isJet = current.objKind !== 'prop';
  const data = { kind: current.objKind, colors: current.colors, glow: current.glow, flip180: current.flip180 };
  if (isJet) data.exhaust = current.getExhaust();   // 排気は戦闘機専用。塔などには持たせない
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'models', filename: 'generated/' + current.id + '/paint.json', content: data }) });
    info(r.ok ? 'paint.json に保存しました（次回のゲーム起動から反映）' : '保存失敗（' + r.status + '）');
  } catch (e) { info('保存失敗: ' + e.message); }
});

// ── 面クリック/ドラッグでペイント、右クリックでスポイト ──
let painting = false;
function pickFace(clientX, clientY) {
  if (current?.kind !== 'painted') return -1;
  pointerNdc.x = (clientX / innerWidth) * 2 - 1;
  pointerNdc.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hit = raycaster.intersectObject(current.mesh, false)[0];
  return hit ? hit.faceIndex : -1;
}
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (current?.kind !== 'painted' || exhaustEditMode) return;   // 排気ギズモ編集中は面ペイントを止める
  const t = pickFace(e.clientX, e.clientY);
  if (t < 0) return;
  if (e.button === 2) {   // スポイト
    const hex = current.colors[t];
    if (!palette.includes(hex)) { palette.push(hex); curColorIdx = palette.length - 1; } else curColorIdx = palette.indexOf(hex);
    brushGlow = !!current.glow[t];
    (brushGlow ? $('glowOn') : $('glowOff')).classList.add('on');
    (brushGlow ? $('glowOff') : $('glowOn')).classList.remove('on');
    renderPalette();
    return;
  }
  if (e.button !== 0) return;
  painting = true;
  controls.enabled = false;   // 塗っている間は視点回転を止める
  current.paintFace(t, palette[curColorIdx], brushGlow);
});
window.addEventListener('pointermove', (e) => {
  if (!painting || exhaustEditMode) return;
  const t = pickFace(e.clientX, e.clientY);
  if (t >= 0) current.paintFace(t, palette[curColorIdx], brushGlow);
});
window.addEventListener('pointerup', () => { painting = false; controls.enabled = true; });

async function loadSelected(id) {
  if (id === '__legacy__') await loadLegacy();
  else await loadPainted(id);
}

renderPalette();
buildObjList().then(() => loadSelected(objSel.value));

(function tick() {
  requestAnimationFrame(tick);
  controls.update();
  renderer.render(scene, camera);
})();
