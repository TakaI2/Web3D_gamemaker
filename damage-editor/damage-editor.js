// damage-editor.js — ダメージ損耗エディタ。
// .npc.json（VRM+マント）を読み込み、モデルを構成するメッシュ（服など）とマントを部位単位で選択、
// 部位ごとに溶解エフェクト（方向/範囲/ノイズ/縁色）を設定して、ダメージ割合スライダで損耗を確認する。
// 設定は public/damage/<npc>.damage.json に保存し、ゲーム側（City-Fly）が同じ形式を読む。
//   部位進行 = clamp((ダメージ% - 開始%) / (終了% - 開始%), 0..1) → fx-dissolve の setProgress
import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createDissolve } from '../lib/fx-dissolve.js';
import { createVRMCloth } from '../lib/vrm-cloth.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { $('status').textContent = m; };

let renderer, scene, camera, orbit;
let vrm = null, capeMesh = null, cloth = null;
let mixer = null, vrmaAction = null;
let exprCfg = [];   // ダメージ連動表情 [{name, keys:[{at(0-100), value(0-1)}]}]
let npcName = 'nei_vamp';
const parts = [];            // [{id, label, kind:'mesh'|'cloth', mesh, cfg, dis}]
let selected = null;
let selHelper = null;
let damage = 0;              // 0..100
const clock = new THREE.Clock();

const DEF_CFG = {
  mesh: { enabled: false, mode: 'scatter', range: [20, 100], maxProg: 100, noiseScale: 8, noiseAmt: 0.6, edge: 0.1, rimColor: '#ff6a3a', rimIntensity: 2.4 },
  cloth: { enabled: true, mode: 'bottom', range: [5, 90], maxProg: 100, noiseScale: 6, noiseAmt: 0.6, edge: 0.12, rimColor: '#ff6a3a', rimIntensity: 2.6 },
};

function dataURIToBlob(uri) {
  const [head, b64] = uri.split(',');
  const mime = (head.match(/data:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function init() {
  renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  $('app').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x131722);
  camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(0.9, 1.35, 2.4);
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.target.set(0, 0.95, 0);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30363f, 1.15));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  const grid = new THREE.GridHelper(6, 12, 0x2a3a55, 0x1c2739);
  scene.add(grid);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.domElement.addEventListener('pointerdown', onPick);
  setupUI();
  await populateNpcList();
  await loadNpc(npcName);
  renderer.setAnimationLoop(tick);
}

let clothFrame = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  orbit.update();
  if (mixer) mixer.update(dt);
  if (vrm) vrm.update(dt);
  if (cloth) { clothFrame += dt * 30; try { cloth.update(dt, clothFrame); } catch { /* noop */ } }
  for (const p of parts) p.dis?.update(dt);
  renderer.render(scene, camera);
}

async function populateNpcList() {
  const sel = $('npc-sel');
  try {
    const mf = await (await fetch('../npc/manifest.json')).json();
    const files = (mf.files || mf || []).filter((f) => `${f}`.endsWith('.npc.json'));
    sel.innerHTML = files.map((f) => `<option value="${f}">${f.replace(/\.npc\.json$/, '')}</option>`).join('');
    if (files.includes('nei_vamp.npc.json')) sel.value = 'nei_vamp.npc.json';
  } catch { sel.innerHTML = '<option value="nei_vamp.npc.json">nei_vamp</option>'; }
  sel.addEventListener('change', () => loadNpc(sel.value.replace(/\.npc\.json$/, '')));
}

function clearModel() {
  for (const p of parts) { try { p.dis?.dispose(); } catch { /* noop */ } }
  parts.length = 0;
  selected = null;
  exprCfg = [];
  if (vrmaAction) { try { vrmaAction.stop(); } catch { /* noop */ } vrmaAction = null; }
  mixer = null;
  if (selHelper) { scene.remove(selHelper); selHelper = null; }
  if (cloth) { try { cloth.dispose?.(); } catch { /* noop */ } cloth = null; }
  if (vrm) { scene.remove(vrm.scene); vrm = null; }
  if (capeMesh) { scene.remove(capeMesh); capeMesh = null; }
}

async function loadNpc(name) {
  clearModel();
  npcName = name;
  setStatus(`${name}.npc.json 読込中…`);
  const bundle = await (await fetch(`../npc/${name}.npc.json`)).json();
  // ── VRM ──
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(p, { materialType: MToonNodeMaterial }) }));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  scene.add(vrm.scene);
  vrm.scene.updateMatrixWorld(true);
  // 部位: メッシュ名単位
  const seen = new Map();
  vrm.scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    let label = o.name || 'mesh';
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    if (n > 1) label = `${label}_${n}`;
    parts.push({ id: `mesh:${label}`, label, kind: 'mesh', mesh: o, cfg: { ...DEF_CFG.mesh, range: [...DEF_CFG.mesh.range] }, dis: null });
  });
  // ── マント: 実GPUクロス（lib/vrm-cloth＝ゲームと同一。物理あり）──
  if (bundle.cloth?.positions && bundle.cloth?.indices) {
    try {
      cloth = createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: new THREE.Vector3(0, 0, 0), floorY: 0.005 });
      capeMesh = cloth.clothMesh;
      if (capeMesh) {
        buildClothDamageAttrs(bundle.cloth, capeMesh.geometry);
        parts.push({ id: 'cape', label: 'マント', kind: 'cloth', mesh: capeMesh, cfg: { ...DEF_CFG.cloth, range: [...DEF_CFG.cloth.range] }, dis: null });
      }
    } catch (e) { console.warn('マント生成失敗:', e); }
  }
  // ── 保存済み設定を反映 ──
  try {
    const saved = await (await fetch(`../damage/${name}.damage.json?ts=${Date.now()}`)).json();
    for (const sp of (saved.parts || [])) {
      const p = parts.find((x) => x.id === sp.id);
      if (p) p.cfg = { ...p.cfg, ...sp, range: [...(sp.range || p.cfg.range)] };
    }
    exprCfg = (saved.expressions || []).map((e) => ({ name: e.name, keys: (e.keys || []).map((k) => ({ ...k })) }));
    setStatus(`${name}: 保存済み設定を読込`);
  } catch { setStatus(`${name}: 新規設定（既定値）`); }
  for (const p of parts) rebuildDissolve(p);
  renderParts();
  populateExprSelect();
  renderExprList();
  selectPart(parts.find((p) => p.id === 'cape') || parts[0] || null);
  applyDamage();
}

// ── VRMA 再生 ──
function stripRootMotionXZ(clip) {
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.position')) continue;
    const v = tr.values;
    for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
  }
  return clip;
}
async function playVrma(file) {
  stopVrma();
  if (!file || !vrm) return;
  try {
    const res = await fetch('../vrma/' + encodeURIComponent(file));
    if (!res.ok) { setStatus('VRMA取得失敗: ' + file); return; }
    const al = new GLTFLoader();
    al.register((pl) => new VRMAnimationLoaderPlugin(pl));
    const ag = await al.loadAsync(URL.createObjectURL(await res.blob()));
    const anims = ag.userData.vrmAnimations;
    if (!anims?.length) { setStatus('VRMAにアニメ無し'); return; }
    mixer = new THREE.AnimationMixer(vrm.scene);
    vrmaAction = mixer.clipAction(stripRootMotionXZ(createVRMAnimationClip(anims[0], vrm)));
    vrmaAction.play();
    setStatus('VRMA再生中: ' + file);
  } catch (e) { setStatus('VRMA再生失敗: ' + e.message); }
}
function stopVrma() {
  if (vrmaAction) { try { vrmaAction.stop(); } catch { /* noop */ } vrmaAction = null; }
  mixer = null;
  if (vrm) vrm.humanoid?.resetNormalizedPose?.();
}

// ── ダメージ連動の表情（ブレンドシェイプ）──
function exprNames() {
  const em = vrm?.expressionManager;
  if (!em) return [];
  if (em.expressionMap) return Object.keys(em.expressionMap);
  return (em.expressions || []).map((e) => e.expressionName || e.name).filter(Boolean);
}
function populateExprSelect() {
  const sel = $('expr-sel');
  if (!sel) return;
  sel.innerHTML = exprNames().map((n) => `<option value="${n}">${n}</option>`).join('');
}
// ── 表情タイムライン: 表情ごとに0-100%の帯を描き、キー=ドット・カーブ・現在ダメージ=赤線 ──
//   クリック=キー追加 / ドット ドラッグ=移動 / ダブルクリック=削除
const exprRows = new Map();   // name -> {cv, ctx}
function renderExprList() {   // DOM再構築（キー数や選択が変わった時）
  const box = $('expr-list');
  if (!box) return;
  box.innerHTML = '';
  exprRows.clear();
  const names = [...new Set([$('expr-sel').value, ...exprCfg.map((e) => e.name)])].filter(Boolean);
  if (!names.length) { box.innerHTML = '<div style="color:#678;">（表情を選ぶとタイムラインが出ます）</div>'; return; }
  for (const name of names) {
    const ec = exprCfg.find((e) => e.name === name);
    const row = document.createElement('div');
    row.style.cssText = 'margin:6px 0 10px;';
    const lab = document.createElement('div');
    lab.textContent = name + (ec ? `（${ec.keys.length}キー）` : '（キーなし・帯をクリックで追加）');
    lab.style.cssText = 'color:#9fd0ff;margin-bottom:2px;cursor:pointer;';
    lab.onclick = () => { $('expr-sel').value = name; renderExprList(); };
    const cv = document.createElement('canvas');
    cv.width = 260; cv.height = 42;
    cv.style.cssText = 'width:100%;height:42px;background:#141628;border:1px solid #33395c;border-radius:4px;cursor:crosshair;display:block;touch-action:none;';
    row.appendChild(lab);
    row.appendChild(cv);
    box.appendChild(row);
    exprRows.set(name, { cv, ctx: cv.getContext('2d') });
    bindTimeline(cv, name);
  }
  drawExprTimelines();
}
function tlAt(cv, cx) { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(100, (cx - r.left) / r.width * 100)); }
function tlVal(cv, cy) { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, 1 - (cy - r.top - 5) / (r.height - 12))); }
function bindTimeline(cv, name) {
  let dragKey = null;
  const findKey = (e) => {
    const ec = exprCfg.find((x) => x.name === name);
    if (!ec) return null;
    const r = cv.getBoundingClientRect();
    for (const k of ec.keys) {
      const x = r.left + k.at / 100 * r.width;
      const y = r.top + 5 + (1 - k.value) * (r.height - 12);
      if (Math.abs(e.clientX - x) < 8 && Math.abs(e.clientY - y) < 10) return k;
    }
    return null;
  };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    $('expr-sel').value = name;
    let ec = exprCfg.find((x) => x.name === name);
    let k = findKey(e);
    if (!k) {   // 空きクリック=その位置にキー追加
      if (!ec) { ec = { name, keys: [] }; exprCfg.push(ec); }
      k = { at: Math.round(tlAt(cv, e.clientX)), value: +tlVal(cv, e.clientY).toFixed(2) };
      ec.keys.push(k);
    }
    dragKey = k;
    cv.setPointerCapture(e.pointerId);
    $('expr-val').value = k.value;
    $('expr-val-v').textContent = (+k.value).toFixed(2);
    applyDamage();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragKey) return;
    dragKey.at = Math.round(tlAt(cv, e.clientX));
    dragKey.value = +tlVal(cv, e.clientY).toFixed(2);
    $('expr-val').value = dragKey.value;
    $('expr-val-v').textContent = (+dragKey.value).toFixed(2);
    applyDamage();
  });
  cv.addEventListener('pointerup', () => { if (dragKey) { dragKey = null; renderExprList(); } });
  cv.addEventListener('dblclick', (e) => {
    const ec = exprCfg.find((x) => x.name === name);
    const k = findKey(e);
    if (ec && k) {
      ec.keys = ec.keys.filter((x) => x !== k);
      if (!ec.keys.length) exprCfg = exprCfg.filter((x) => x !== ec);
      applyDamage();
      renderExprList();
    }
  });
}
function drawExprTimelines() {
  for (const [name, row] of exprRows) {
    const { cv, ctx } = row;
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#2a2f4d';   // 25/50/75%の目盛り
    ctx.beginPath();
    for (const gx of [25, 50, 75]) { ctx.moveTo(gx / 100 * w, 0); ctx.lineTo(gx / 100 * w, h); }
    ctx.stroke();
    const ec = exprCfg.find((x) => x.name === name);
    if (ec && ec.keys.length) {
      ctx.strokeStyle = '#6cf';   // 値カーブ
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= 100; x += 2) {
        const px = x / 100 * w, py = 5 + (1 - exprValueAt(ec.keys, x)) * (h - 12);
        x === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = '#ffd45e';   // キー
      for (const k of ec.keys) {
        ctx.beginPath();
        ctx.arc(k.at / 100 * w, 5 + (1 - k.value) * (h - 12), 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.strokeStyle = '#ff5a6e';   // 現在のダメージ位置
    ctx.beginPath();
    ctx.moveTo(damage / 100 * w, 0);
    ctx.lineTo(damage / 100 * w, h);
    ctx.stroke();
  }
}

// 布の溶解基準属性: dmgPos=マントローカル座標(ノイズ用)・dmgH=アンカーからの正規化距離(1=根元,0=先端)
// GPUクロスは position 属性がゼロ埋め（positionNode描画）なので、この属性が唯一の安定基準になる
function buildClothDamageAttrs(clothData, geo) {
  const pos = clothData.positions;
  const n = clothData.vertexCount;
  const anchors = (clothData.anchorAssignments || []).map((a) => a.vertexIdx);
  // アンカー重心・軸ごとのアンカー広がり（広がる軸=幅方向は除外したい）
  const ac = [0, 0, 0], as = [0, 0, 0];
  for (const ai of anchors) for (let k = 0; k < 3; k++) ac[k] += pos[ai * 3 + k];
  for (let k = 0; k < 3; k++) ac[k] /= Math.max(1, anchors.length);
  for (const ai of anchors) for (let k = 0; k < 3; k++) as[k] = Math.max(as[k], Math.abs(pos[ai * 3 + k] - ac[k]));
  // 「アンカーから最も遠くへ伸びる軸」＝裾方向。距離ベースだと放射状（横からも溶ける）になるので軸射影にする
  let axis = 2, bestScore = -1, sign = 1;
  for (let k = 0; k < 3; k++) {
    let mx = 0, sg = 1;
    for (let i = 0; i < n; i++) { const d = pos[i * 3 + k] - ac[k]; if (Math.abs(d) > mx) { mx = Math.abs(d); sg = d >= 0 ? 1 : -1; } }
    const score = mx / (1 + as[k] * 4);
    if (score > bestScore) { bestScore = score; axis = k; sign = sg; }
  }
  const dmgH = new Float32Array(n);
  let tMax = 0.0001;
  for (let i = 0; i < n; i++) { const t = Math.max(0, (pos[i * 3 + axis] - ac[axis]) * sign); dmgH[i] = t; if (t > tMax) tMax = t; }
  for (let i = 0; i < n; i++) dmgH[i] = 1 - dmgH[i] / tMax;   // 1=根元(アンカー側) → 0=裾(先端)
  geo.setAttribute('dmgPos', new THREE.BufferAttribute(Float32Array.from(pos), 3));
  geo.setAttribute('dmgH', new THREE.BufferAttribute(dmgH, 1));
}

// ── 溶解の生成/破棄 ──
function rebuildDissolve(p) {
  if (p.dis) { try { p.dis.dispose(); } catch { /* noop */ } p.dis = null; }
  if (!p.cfg.enabled) return;
  try {
    p.dis = createDissolve(p.mesh, {
      direction: p.cfg.mode,
      noiseScale: p.cfg.noiseScale, noiseAmt: p.cfg.noiseAmt, edge: p.cfg.edge,
      rimColor: p.cfg.rimColor, rimIntensity: p.cfg.rimIntensity,
      puddle: false, doubleSide: true, armed: true,
      space: p.kind === 'cloth' ? 'attributes' : 'geometry',   // 布=dmgPos/dmgH属性・メッシュ=バインド形状基準（なびき/アニメで穴が動かない）
    });
  } catch (e) { console.warn('dissolve生成失敗:', p.id, e); }
}
function partProgress(p) {
  const [s, e] = p.cfg.range;
  const cap = (p.cfg.maxProg ?? 100) / 100;   // 最大溶解%（100未満なら損耗MAXでも布が残る）
  const t = e <= s ? (damage >= e ? 1 : 0) : Math.max(0, Math.min(1, (damage - s) / (e - s)));
  return t * cap;
}
function exprValueAt(keys, dmg) {
  if (!keys.length) return 0;
  const ks = [...keys].sort((a, b) => a.at - b.at);
  if (dmg <= ks[0].at) return ks[0].value;
  if (dmg >= ks[ks.length - 1].at) return ks[ks.length - 1].value;
  for (let i = 0; i < ks.length - 1; i++) {
    if (dmg <= ks[i + 1].at) {
      const t = (dmg - ks[i].at) / Math.max(0.001, ks[i + 1].at - ks[i].at);
      return ks[i].value + (ks[i + 1].value - ks[i].value) * t;
    }
  }
  return ks[ks.length - 1].value;
}
function applyDamage() {
  for (const p of parts) { if (p.dis) p.dis.setProgress(partProgress(p)); }
  const em = vrm?.expressionManager;
  if (em) for (const ec of exprCfg) { try { em.setValue(ec.name, exprValueAt(ec.keys, damage)); } catch { /* noop */ } }
  $('dmg-val').textContent = `${damage}%`;
  renderPartsStatus();
  drawExprTimelines();   // キャンバス再描画のみ（DOM再構築するとドラッグが切れる）
}

// ── UI ──
function renderParts() {
  const box = $('parts');
  box.innerHTML = '';
  for (const p of parts) {
    const div = document.createElement('div');
    div.className = 'part' + (selected === p ? ' sel' : '');
    div.dataset.id = p.id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.cfg.enabled;
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => { p.cfg.enabled = cb.checked; rebuildDissolve(p); applyDamage(); });
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = (p.kind === 'cloth' ? '🧣 ' : '👗 ') + p.label;
    const st = document.createElement('span');
    st.className = 'st';
    div.append(cb, nm, st);
    div.addEventListener('click', () => selectPart(p));
    box.appendChild(div);
  }
  renderPartsStatus();
}
function renderPartsStatus() {
  for (const div of $('parts').children) {
    const p = parts.find((x) => x.id === div.dataset.id);
    if (!p) continue;
    div.querySelector('.st').textContent = p.cfg.enabled ? `${Math.round(partProgress(p) * 100)}%` : '';
    div.classList.toggle('sel', selected === p);
  }
}
function selectPart(p) {
  selected = p;
  if (selHelper) { scene.remove(selHelper); selHelper = null; }
  if (p) {
    selHelper = new THREE.BoxHelper(p.mesh, 0xffe066);
    selHelper.material.depthTest = false;
    scene.add(selHelper);
    $('part-ed').style.display = '';
    $('p-mode').value = p.cfg.mode;
    $('p-start').value = p.cfg.range[0];
    $('p-end').value = p.cfg.range[1];
    $('p-max').value = p.cfg.maxProg ?? 100;
    setR('p-noise', p.cfg.noiseScale); setR('p-namt', p.cfg.noiseAmt); setR('p-edge', p.cfg.edge); setR('p-rimi', p.cfg.rimIntensity);
    $('p-rim').value = p.cfg.rimColor;
  } else $('part-ed').style.display = 'none';
  renderPartsStatus();
}
function setR(id, v) { $(id).value = v; $(id + '-v').textContent = v; }

function onPick(e) {
  if (e.button !== 0 || e.target !== renderer.domElement) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const meshes = parts.map((p) => p.mesh);
  const hit = ray.intersectObjects(meshes, false)[0];
  if (hit) {
    const p = parts.find((x) => x.mesh === hit.object);
    if (p) selectPart(p);
  }
}

function setupUI() {
  $('dmg').addEventListener('input', () => { damage = +$('dmg').value; applyDamage(); });
  const upd = (fn) => { if (!selected) return; fn(selected.cfg); rebuildDissolve(selected); applyDamage(); };
  $('p-mode').addEventListener('change', () => upd((c) => { c.mode = $('p-mode').value; }));
  $('p-start').addEventListener('change', () => upd((c) => { c.range[0] = +$('p-start').value; }));
  $('p-end').addEventListener('change', () => upd((c) => { c.range[1] = +$('p-end').value; }));
  $('p-max').addEventListener('change', () => upd((c) => { c.maxProg = Math.max(0, Math.min(100, +$('p-max').value)); }));
  const slider = (id, key) => $(id).addEventListener('input', () => {
    $(id + '-v').textContent = $(id).value;
    upd((c) => { c[key] = +$(id).value; });
  });
  slider('p-noise', 'noiseScale'); slider('p-namt', 'noiseAmt'); slider('p-edge', 'edge'); slider('p-rimi', 'rimIntensity');
  $('p-rim').addEventListener('input', () => upd((c) => { c.rimColor = $('p-rim').value; }));
  $('btn-save').addEventListener('click', save);
  // VRMA
  fetch('../vrma/manifest.json').then((r) => r.json()).then((mf) => {
    const files = (mf.files || mf || []).filter((f) => `${f}`.endsWith('.vrma'));
    $('vrma-sel').innerHTML = '<option value="">（停止）</option>' + files.map((f) => `<option value="${f}">${f}</option>`).join('');
  }).catch(() => {});
  $('vrma-sel').addEventListener('change', () => { const v = $('vrma-sel').value; if (v) playVrma(v); else stopVrma(); });
  // 表情キー
  $('expr-val').addEventListener('input', () => {
    $('expr-val-v').textContent = (+$('expr-val').value).toFixed(2);
    const em = vrm?.expressionManager;   // プレビュー（キー追加前でも見える）
    if (em && $('expr-sel').value) { try { em.setValue($('expr-sel').value, +$('expr-val').value); } catch { /* noop */ } }
  });
  $('expr-sel').addEventListener('change', renderExprList);   // 選択した表情の空タイムラインを出す
  $('expr-add').addEventListener('click', () => {
    const name = $('expr-sel').value;
    if (!name) return;
    let ec = exprCfg.find((e) => e.name === name);
    if (!ec) { ec = { name, keys: [] }; exprCfg.push(ec); }
    ec.keys = ec.keys.filter((k) => k.at !== damage);
    ec.keys.push({ at: damage, value: +$('expr-val').value });
    applyDamage();
    renderExprList();
    showToastLike(`${name} @ ${damage}% = ${$('expr-val').value}`);
  });
}
function showToastLike(m) { setStatus(m); }

async function save() {
  const data = {
    format: 'damage-config', version: 1, npc: npcName,
    parts: parts.map((p) => ({ id: p.id, kind: p.kind, enabled: p.cfg.enabled, mode: p.cfg.mode, range: [...p.cfg.range], maxProg: p.cfg.maxProg ?? 100,
      noiseScale: p.cfg.noiseScale, noiseAmt: p.cfg.noiseAmt, edge: p.cfg.edge, rimColor: p.cfg.rimColor, rimIntensity: p.cfg.rimIntensity })),
    expressions: exprCfg.map((e) => ({ name: e.name, keys: [...e.keys].sort((a, b) => a.at - b.at) })),
  };
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'damage', filename: `${npcName}.damage.json`, content: JSON.stringify(data, null, 1) }) });
    setStatus(r.ok ? `保存しました → public/damage/${npcName}.damage.json` : `保存失敗: ${r.status}`);
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}

window.__dmg = { get parts() { return parts; }, get vrm() { return vrm; }, setDamage(v) { damage = v; $('dmg').value = v; applyDamage(); }, loadNpc };
init().catch((err) => { console.error(err); setStatus('初期化失敗: ' + err.message); });
