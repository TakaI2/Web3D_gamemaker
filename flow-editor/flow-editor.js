// flow-editor.js — ゲームフローのノードグラフ編集。div ノード＋SVGエッジ、パン/ズーム、
// ポートドラッグ接続（battle は win/lose 分岐）、データ駆動プロパティ、public/flow へ保存。
// 設計: .tmp/design.md §7

import { NODE_TYPES, WIN_TYPES, LOSE_TYPES } from '../lib/flow-runner.js';

const $ = (id) => document.getElementById(id);
const NODE_W = 160, HD = 28, PORT_SP = 18;

let flow = newFlow();
let selected = null;
let storyFiles = [], npcFiles = [], stageFiles = [];
const view = { x: 40, y: 40, scale: 1 };
let nodeSeq = 1;

function newFlow() { return { version: 1, id: 'untitled', title: '', start: '', nodes: [], edges: [] }; }
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1800); }
function genId(type) { return `n_${type}_${nodeSeq++}`; }

// ── 座標 ──
function applyView() { $('world').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`; }
function inAnchor(n)  { return { x: n.x, y: n.y + HD + 6 }; }
function outAnchor(n, i) { return { x: n.x + NODE_W, y: n.y + HD + 6 + i * PORT_SP }; }
function outIndex(type, port) { return (NODE_TYPES[type] || {}).ports?.indexOf(port) ?? 0; }

// ── 描画 ──
function redraw() {
  const world = $('world');
  // ノード除去（svg は残す）
  [...world.querySelectorAll('.node')].forEach(el => el.remove());
  for (const n of flow.nodes) world.appendChild(buildNode(n));
  drawEdges();
  applyView();
}

function buildNode(n) {
  const el = document.createElement('div');
  el.className = 'node ' + n.type + (n.id === selected ? ' sel' : '');
  el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
  const def = NODE_TYPES[n.type] || { label: n.type, ports: [] };
  const star = (flow.start === n.id) ? '★' : '';
  el.innerHTML = `<div class="hd">${star}${def.label}<span class="nid">${n.id}</span></div><div class="bd">${summarize(n)}</div>`;
  // 入力ポート（start 以外）
  if (n.type !== 'start') {
    const pin = document.createElement('div'); pin.className = 'port in'; pin.dataset.node = n.id; pin.dataset.kind = 'in';
    el.appendChild(pin);
  }
  // 出力ポート
  def.ports.forEach((port, i) => {
    const po = document.createElement('div'); po.className = 'port out'; po.style.top = (HD + i * PORT_SP) + 'px';
    po.dataset.node = n.id; po.dataset.port = port; po.dataset.kind = 'out';
    if (port === 'win') po.style.background = '#7d7'; else if (port === 'lose') po.style.background = '#d77';
    el.appendChild(po);
    if (def.ports.length > 1) { const lb = document.createElement('div'); lb.className = 'port-label'; lb.style.top = (HD + i * PORT_SP - 2) + 'px'; lb.textContent = port; el.appendChild(lb); }
  });
  // ヘッダドラッグ＝移動 / クリック＝選択
  const hd = el.querySelector('.hd');
  hd.addEventListener('pointerdown', (e) => startNodeDrag(e, n));
  el.addEventListener('pointerdown', () => { selected = n.id; renderProps(); redraw(); }, true);
  // 出力ポートドラッグ＝接続
  el.querySelectorAll('.port.out').forEach(po => po.addEventListener('pointerdown', (e) => startConnect(e, n.id, po.dataset.port)));
  return el;
}

function summarize(n) {
  if (n.type === 'story') return 'story: ' + ((n.data && n.data.story) || '—');
  if (n.type === 'battle') { const b = (n.data && n.data.battle) || {}; return `敵 ${(b.enemies || []).length} / 勝:撃破${b.win?.count ?? '-'} / 負:HP${b.lose?.hp ?? '-'}`; }
  return '';
}

function drawEdges() {
  const svg = $('edges');
  svg.innerHTML = '';
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  for (const e of flow.edges) {
    const from = byId.get(e.from), to = byId.get(e.to);
    if (!from || !to) continue;
    const a = outAnchor(from, outIndex(from.type, e.fromPort));
    const b = inAnchor(to);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', e.fromPort === 'win' ? '#7d7' : e.fromPort === 'lose' ? '#d77' : '#88a');
    path.setAttribute('stroke-width', '2');
    path.style.pointerEvents = 'stroke'; path.style.cursor = 'pointer';
    path.addEventListener('click', () => { if (confirm('このエッジを削除しますか？')) { flow.edges = flow.edges.filter(x => x !== e); redraw(); } });
    svg.appendChild(path);
  }
  if (tempPath) svg.appendChild(tempPath);
}

// ── パン/ズーム ──
function screenToWorld(cx, cy) { const r = $('canvas').getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.scale, y: (cy - r.top - view.y) / view.scale }; }

$('canvas').addEventListener('pointerdown', (e) => {
  if (e.target.id !== 'canvas' && e.target.id !== 'world' && e.target.id !== 'edges') return;
  selected = null; renderProps();
  const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
  const mv = (ev) => { view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyView(); };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); redraw(); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
});
$('canvas').addEventListener('wheel', (e) => {
  e.preventDefault();
  const w = screenToWorld(e.clientX, e.clientY);
  const ns = Math.min(2, Math.max(0.3, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
  const r = $('canvas').getBoundingClientRect();
  view.x = (e.clientX - r.left) - w.x * ns; view.y = (e.clientY - r.top) - w.y * ns;
  view.scale = ns; applyView();
}, { passive: false });

// ── ノードドラッグ ──
function startNodeDrag(e, n) {
  e.stopPropagation();
  const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y;
  const mv = (ev) => { n.x = ox + (ev.clientX - sx) / view.scale; n.y = oy + (ev.clientY - sy) / view.scale; const el = [...$('world').querySelectorAll('.node')].find(d => d.querySelector('.nid')?.textContent === n.id); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; } drawEdges(); };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// ── ポート接続 ──
let tempPath = null;
function startConnect(e, fromId, fromPort) {
  e.stopPropagation();
  const from = flow.nodes.find(n => n.id === fromId);
  const a = outAnchor(from, outIndex(from.type, fromPort));
  tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tempPath.setAttribute('fill', 'none'); tempPath.setAttribute('stroke', '#fff'); tempPath.setAttribute('stroke-dasharray', '4 3'); tempPath.setAttribute('stroke-width', '2');
  const mv = (ev) => { const w = screenToWorld(ev.clientX, ev.clientY); const dx = Math.max(40, Math.abs(w.x - a.x) * 0.5); tempPath.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${w.x - dx} ${w.y}, ${w.x} ${w.y}`); drawEdges(); };
  const up = (ev) => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    const tgt = document.elementFromPoint(ev.clientX, ev.clientY);
    tempPath = null;
    if (tgt && tgt.classList.contains('port') && tgt.dataset.kind === 'in') {
      const toId = tgt.dataset.node;
      if (toId !== fromId) {
        flow.edges = flow.edges.filter(x => !(x.from === fromId && x.fromPort === fromPort));   // 同 fromPort は置換
        flow.edges.push({ from: fromId, fromPort, to: toId });
      }
    }
    redraw();
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// ── ノード追加/削除 ──
function addNode(type) {
  const w = screenToWorld(window.innerWidth / 2 - 130, 200);
  const n = { id: genId(type), type, x: Math.round(w.x), y: Math.round(w.y), data: defaultData(type) };
  flow.nodes.push(n);
  if (type === 'start' && !flow.start) flow.start = n.id;
  selected = n.id; redraw(); renderProps();
}
function defaultData(type) {
  if (type === 'story') return { story: storyFiles[0] || '' };
  if (type === 'battle') return { battle: { title: '戦闘', enemies: npcFiles.slice(0, 2), stage: 'stage.json', bgm: '', win: { type: 'defeatCount', count: 5 }, lose: { type: 'playerHp', hp: 5 } } };
  return {};
}
function deleteNode(id) {
  flow.nodes = flow.nodes.filter(n => n.id !== id);
  flow.edges = flow.edges.filter(e => e.from !== id && e.to !== id);
  if (flow.start === id) flow.start = '';
  selected = null; redraw(); renderProps();
}

// ── プロパティ ──
function renderProps() {
  const panel = $('prop-panel');
  panel.innerHTML = '';
  const n = flow.nodes.find(x => x.id === selected);
  if (!n) { $('prop-title').textContent = 'ノード未選択'; return; }
  $('prop-title').textContent = `${(NODE_TYPES[n.type] || {}).label || n.type} (${n.id})`;

  if (n.type === 'story') {
    panel.appendChild(rowSelect('ストーリー', storyFiles, n.data.story || '', v => { n.data.story = v; redraw(); }));
  } else if (n.type === 'battle') {
    const b = n.data.battle = n.data.battle || defaultData('battle').battle;
    panel.appendChild(rowText('タイトル', b.title || '', v => { b.title = v; }));
    const h = document.createElement('h4'); h.textContent = '出現NPC'; panel.appendChild(h);
    for (const f of npcFiles) {
      const wrap = document.createElement('label'); wrap.className = 'chk';
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = (b.enemies || []).includes(f);
      c.onchange = () => { const s = new Set(b.enemies || []); c.checked ? s.add(f) : s.delete(f); b.enemies = [...s]; redraw(); };
      wrap.appendChild(c); wrap.appendChild(document.createTextNode(f.replace(/\.npc\.json$/, ''))); panel.appendChild(wrap);
    }
    panel.appendChild(rowSelect('ステージ', ['stage.json', ...stageFiles], b.stage || '', v => { b.stage = v; }));
    panel.appendChild(rowText('BGM', b.bgm || '', v => { b.bgm = v; }));
    b.win = b.win || { type: 'defeatCount', count: 5 };
    b.lose = b.lose || { type: 'playerHp', hp: 5 };
    panel.appendChild(rowNum('勝利:撃破数', b.win.count ?? 5, v => { b.win.count = v; redraw(); }));
    panel.appendChild(rowNum('敗北:HP', b.lose.hp ?? 5, v => { b.lose.hp = v; redraw(); }));
  }

  const star = document.createElement('button'); star.className = 'act'; star.textContent = flow.start === n.id ? '★ 開始ノード' : '開始ノードにする';
  star.onclick = () => { flow.start = n.id; redraw(); renderProps(); };
  panel.appendChild(star);
  const del = document.createElement('button'); del.className = 'act danger'; del.textContent = '✕ ノード削除'; del.onclick = () => deleteNode(n.id);
  panel.appendChild(del);
}
function rowText(label, val, on) { const r = document.createElement('div'); r.className = 'row'; r.innerHTML = `<label>${label}</label>`; const i = document.createElement('input'); i.type = 'text'; i.value = val; i.oninput = () => on(i.value); r.appendChild(i); return r; }
function rowNum(label, val, on) { const r = document.createElement('div'); r.className = 'row'; r.innerHTML = `<label>${label}</label>`; const i = document.createElement('input'); i.type = 'number'; i.value = val; i.onchange = () => on(parseFloat(i.value)); r.appendChild(i); return r; }
function rowSelect(label, opts, val, on) { const r = document.createElement('div'); r.className = 'row'; r.innerHTML = `<label>${label}</label>`; const s = document.createElement('select'); for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); } s.value = val; s.onchange = () => on(s.value); r.appendChild(s); return r; }

// ── 保存/読込 ──
function syncMeta() { flow.id = $('flow-id').value || 'untitled'; flow.title = $('flow-title').value; }
function applyMeta() { $('flow-id').value = flow.id || ''; $('flow-title').value = flow.title || ''; }

async function save() {
  syncMeta();
  const filename = (flow.id || 'untitled') + '.flow.json';
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'flow', filename, content: flow }) });
    if (r.ok) { const j = await r.json(); toast('保存: ' + j.path); await refreshList(filename); return; }
  } catch { /* fallback */ }
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  toast('ダウンロードしました');
}

function setFlow(json) {
  flow = Object.assign(newFlow(), json);
  flow.nodes = flow.nodes || []; flow.edges = flow.edges || [];
  selected = null;
  // nodeSeq をユニーク維持
  let max = 0; for (const n of flow.nodes) { const m = /_(\d+)$/.exec(n.id); if (m) max = Math.max(max, +m[1]); } nodeSeq = max + 1;
  applyMeta(); redraw(); renderProps();
}

async function fetchList(url, fb = []) { try { const r = await fetch(url); if (r.ok) { const a = await r.json(); if (Array.isArray(a)) return a; } } catch { /* noop */ } return fb; }
async function refreshList(current) {
  const files = await fetchList('../flow/manifest.json', []);
  const sel = $('flow-select'); sel.innerHTML = '<option value="">(新規)</option>';
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.flow\.json$/, ''); sel.appendChild(o); }
  if (current && files.includes(current)) sel.value = current;
}

// ── init ──
async function init() {
  [storyFiles, npcFiles, stageFiles] = await Promise.all([
    fetchList('../story/manifest.json', []),
    fetchList('../npc/manifest.json', []),
    fetchList('../models/manifest.json', []),
  ]);
  const picker = $('node-picker'); picker.innerHTML = '';
  for (const t of Object.keys(NODE_TYPES)) { const o = document.createElement('option'); o.value = t; o.textContent = NODE_TYPES[t].label; picker.appendChild(o); }

  $('btn-add').onclick = () => addNode(picker.value);
  $('btn-save').onclick = save;
  $('btn-new').onclick = () => { setFlow(newFlow()); $('flow-select').value = ''; };
  $('flow-id').oninput = syncMeta; $('flow-title').oninput = syncMeta;
  $('flow-select').onchange = async () => { const f = $('flow-select').value; if (!f) { setFlow(newFlow()); return; } const j = await fetch('../flow/' + f).then(r => r.ok ? r.json() : null).catch(() => null); if (j) setFlow(j); else toast('読込失敗'); };
  window.addEventListener('keydown', (e) => { if (e.key === 'Delete' && selected) deleteNode(selected); });

  await refreshList(null);
  const files = await fetchList('../flow/manifest.json', []);
  if (files.includes('sample.flow.json')) { const j = await fetch('../flow/sample.flow.json').then(r => r.json()).catch(() => null); if (j) { setFlow(j); $('flow-select').value = 'sample.flow.json'; return; } }
  setFlow(newFlow());
}

void WIN_TYPES; void LOSE_TYPES;   // 将来の勝敗種別拡張で使用
init().catch(e => { console.error(e); toast('初期化失敗: ' + e); });
