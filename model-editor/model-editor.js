// model-editor.js — public/models/ の GLB をサムネ一覧表示し、選択を models/selection.json に保存。
// 選択したモデルが swing-catch に飛行オブジェクトとして登場する。
// サムネは WebGLRenderer(コア three) で各モデルを1枚ずつ描画して toDataURL でキャプチャ。

import * as THREE from 'https://esm.sh/three@0.184.0';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin } from 'https://esm.sh/@pixiv/three-vrm@3.4.0?deps=three@0.184.0';

const THUMB = 256;
const selected = new Set();
const scales = new Map();   // file -> スケール倍率（未設定はゲーム側で自動正規化）
let files = [];

function dataURIToBlob(uri) {
  const [head, data] = uri.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(data); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const $ = (id) => document.getElementById(id);
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2500); }

// ── サムネ用レンダラ ──
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setSize(THUMB, THUMB);
renderer.setClearColor(0x222a38, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(2, 3, 2.5); scene.add(dl);
const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5); dl2.position.set(-2, 1, -2); scene.add(dl2);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);

const loader = new GLTFLoader();
const _box = new THREE.Box3(), _size = new THREE.Vector3(), _center = new THREE.Vector3();

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    }
  });
}

// 1モデルをロード→フレーミング→描画→dataURL
// パス内のスペース等を安全にエンコード（フォルダ名 "car_GLB format" 対応）
function modelURL(file) {
  return new URL('../models/' + file.split('/').map(encodeURIComponent).join('/'), window.location.href).href;
}

async function renderThumb(file) {
  const url = modelURL(file);
  const gltf = await loader.loadAsync(url);
  const obj = gltf.scene;
  scene.add(obj);
  _box.setFromObject(obj);
  _box.getSize(_size); _box.getCenter(_center);
  obj.position.sub(_center);                       // 原点へ中心合わせ
  const maxDim = Math.max(_size.x, _size.y, _size.z) || 1;
  const dist = (maxDim * 0.5) / Math.tan((40 * Math.PI / 180) / 2) * 1.5;
  camera.position.set(dist * 0.6, dist * 0.5, dist * 0.9);
  camera.near = dist / 100; camera.far = dist * 100; camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  const dataURL = renderer.domElement.toDataURL('image/png');
  scene.remove(obj);
  disposeObject(obj);
  return dataURL;
}

// ── グリッド構築 ──
function buildGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  for (const file of files) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (selected.has(file) ? ' sel' : '');
    cell.dataset.file = file;
    const name = file.replace(/\.glb$/i, '').replace(/^.*\//, '');
    cell.innerHTML = `<img alt="${name}"><div class="row"><input type="checkbox" ${selected.has(file) ? 'checked' : ''}><span class="name" title="${file}">${name}</span></div>`;
    const cb = cell.querySelector('input');
    const toggle = (on) => { if (on) selected.add(file); else selected.delete(file); cb.checked = on; cell.classList.toggle('sel', on); };
    cell.onclick = (e) => { if (e.target === cb) return; toggle(!selected.has(file)); };
    cb.onchange = () => toggle(cb.checked);
    cell.querySelector('img').onclick = (e) => { e.stopPropagation(); openScaleModal(file); };   // サムネクリックで大きさ調整
    grid.appendChild(cell);
  }
}

async function generateThumbs() {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    $('status').textContent = `サムネ生成 ${i + 1}/${files.length} … ${file}`;
    const img = document.querySelector(`.cell[data-file="${CSS.escape(file)}"] img`);
    try { const url = await renderThumb(file); if (img) img.src = url; }
    catch (e) { console.warn('thumb 失敗', file, e); if (img) img.alt = '読込失敗'; }
    await new Promise(r => setTimeout(r, 0));   // UI に制御を返す
  }
  $('status').textContent = `${files.length} モデル / 選択 ${selected.size}`;
}

async function loadSelection() {
  try {
    const r = await fetch('../models/selection.json');
    if (r.ok) {
      const j = await r.json();
      (j.models || []).forEach(m => selected.add(m));
      if (j.scales) for (const k in j.scales) scales.set(k, j.scales[k]);
    }
  } catch { /* 無ければ未選択 */ }
}

// ── 大きさ調整モーダル（VRoid 基準で比較しながらスケール設定） ──
let mRenderer, mScene, mCamera, mControls, mRaf = 0, refVRM = null, modalModel = null, modalFile = null, modalRawMax = 1;

async function initModal() {
  if (mRenderer) return;
  mRenderer = new THREE.WebGLRenderer({ antialias: true });
  mRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mRenderer.setSize(560, 460);
  mRenderer.outputColorSpace = THREE.SRGBColorSpace;
  $('modal-canvas').appendChild(mRenderer.domElement);
  mScene = new THREE.Scene(); mScene.background = new THREE.Color(0x2a3242);
  mCamera = new THREE.PerspectiveCamera(45, 560 / 460, 0.05, 200);
  mCamera.position.set(2.6, 1.7, 4.2);
  mControls = new OrbitControls(mCamera, mRenderer.domElement);
  mControls.target.set(0, 1.0, 0); mControls.enableDamping = true;
  mScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(3, 5, 4); mScene.add(dl);
  mScene.add(new THREE.GridHelper(10, 20, 0x44557a, 0x33405e));
  await loadRefVRM();
}

async function loadRefVRM() {
  try {
    const r = await fetch('../npc/megu.npc.json'); if (!r.ok) return;
    const j = await r.json(); if (!j.vrm) return;
    const l = new GLTFLoader(); l.register(p => new VRMLoaderPlugin(p));
    const gltf = await l.loadAsync(URL.createObjectURL(dataURIToBlob(j.vrm)));
    refVRM = gltf.userData.vrm.scene;
    refVRM.position.set(-1.0, 0, 0);
    mScene.add(refVRM);
  } catch (e) { console.warn('参照VRM 読込失敗', e); }
}

function applyModalScale(scale) {
  if (!modalModel) return;
  modalModel.position.set(1.0, 0, 0);
  modalModel.scale.setScalar(scale);
  modalModel.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(modalModel);
  modalModel.position.y = -b.min.y;   // 下端を接地
  scales.set(modalFile, scale);
}

async function openScaleModal(file) {
  $('modal').classList.add('show');
  $('modal-name').textContent = file.replace(/^.*\//, '').replace(/\.glb$/i, '');
  await initModal();
  if (modalModel) { mScene.remove(modalModel); disposeObject(modalModel); modalModel = null; }
  const gltf = await loader.loadAsync(modelURL(file));
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  modalRawMax = Math.max(size.x, size.y, size.z) || 1;
  obj.position.sub(center);
  const wrap = new THREE.Group(); wrap.add(obj);
  mScene.add(wrap); modalModel = wrap; modalFile = file;
  const scale = scales.get(file) || (1.5 / modalRawMax);   // 既定: 最大寸法 ~1.5m
  applyModalScale(scale);
  const range = $('size-range');
  range.value = String(scale * modalRawMax);
  $('size-val').textContent = (scale * modalRawMax).toFixed(1);
  if (!mRaf) loopModal();
}

function loopModal() {
  if (!$('modal').classList.contains('show')) { mRaf = 0; return; }
  mRaf = requestAnimationFrame(loopModal);
  mControls.update();
  mRenderer.render(mScene, mCamera);
}

function closeModal() { $('modal').classList.remove('show'); if (mRaf) { cancelAnimationFrame(mRaf); mRaf = 0; } }

async function save() {
  try {
    const r = await fetch('../api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'models', filename: 'selection.json', content: { models: [...selected], scales: Object.fromEntries(scales) } }),
    });
    if (r.ok) { const j = await r.json(); toast(`保存: ${j.path}（${selected.size}個）`); return; }
    toast('保存に失敗（開発サーバーが必要）');
  } catch { toast('保存に失敗（開発サーバーが必要）'); }
}

async function init() {
  try { const r = await fetch('../models/manifest.json'); if (r.ok) files = await r.json(); } catch { /* noop */ }
  files = (files || []).filter(f => /\.glb$/i.test(f)).sort();
  await loadSelection();
  buildGrid();
  $('status').textContent = `${files.length} モデル`;
  $('btn-save').onclick = save;
  $('btn-all').onclick = () => { files.forEach(f => selected.add(f)); buildGrid(); $('status').textContent = `選択 ${selected.size}`; };
  $('btn-none').onclick = () => { selected.clear(); buildGrid(); $('status').textContent = `選択 0`; };
  $('size-range').oninput = () => { const m = parseFloat($('size-range').value); $('size-val').textContent = m.toFixed(1); applyModalScale(m / modalRawMax); };
  $('modal-ok').onclick = () => { closeModal(); toast('スケール記録。「選択を保存」でゲームに反映'); };
  $('modal-close').onclick = closeModal;
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
  if (!files.length) { $('status').textContent = 'public/models/ に GLB が見つかりません'; return; }
  generateThumbs();
}

init();
