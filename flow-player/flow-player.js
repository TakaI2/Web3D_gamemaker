// flow-player.js — ゲームフローのオーケストレータ。ノードに応じて story-player / swing-catch を
// iframe で開き、postMessage の結果(done / win / lose)で次ノードへ分岐する。
// 設計: .tmp/design.md §4

import { createFlow, NODE_TYPES } from '../lib/flow-runner.js';

const $ = (id) => document.getElementById(id);

let flow = null;
let current = null;
let awaiting = false;       // iframe からの結果待ちか
let pendingBattle = null;   // battle iframe の flow-ready を待って渡す設定

async function fetchList() {
  try { const r = await fetch('../flow/manifest.json'); if (r.ok) { const a = await r.json(); if (Array.isArray(a) && a.length) return a; } } catch { /* noop */ }
  return ['sample.flow.json'];
}
async function fetchFlow(file) {
  const r = await fetch('../flow/' + file);
  if (!r.ok) throw new Error('flow 取得失敗: ' + file);
  return r.json();
}

function setHud(node) { $('hud-node').textContent = node ? `${(NODE_TYPES[node.type] || {}).label || node.type} (${node.id})` : '—'; }

function loadFrame(src) { $('frame').src = src; }

function runNode(node) {
  current = node;
  awaiting = false;
  pendingBattle = null;
  setHud(node);
  if (!node) { finish(); return; }
  switch (node.type) {
    case 'start': advance('next'); break;
    case 'end':   finish(); break;
    case 'story':
      awaiting = true;
      loadFrame('../story-player/?flow=1&id=' + encodeURIComponent((node.data && node.data.story) || ''));
      break;
    case 'battle':
      awaiting = true;
      pendingBattle = (node.data && node.data.battle) || {};
      loadFrame('../swing-catch/?flow=1');   // flow-ready 受信で flow-config を送る
      break;
    default:
      console.warn('[flow] 未知ノード種別:', node.type);
      advance('next');
  }
}

function advance(port) {
  if (!current) return;
  runNode(flow.next(current.id, port));
}

function finish() {
  current = null; awaiting = false; setHud(null);
  $('frame').src = 'about:blank';
  $('end-overlay').style.display = 'flex';
}

function startFlow(json) {
  flow = createFlow(json);
  $('end-overlay').style.display = 'none';
  runNode(flow.getStart());
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const d = e.data || {};
  if (d.type === 'flow-ready') {
    // 戦闘 iframe が準備完了 → 設定を渡す
    if (pendingBattle != null) { try { $('frame').contentWindow.postMessage({ type: 'flow-config', battle: pendingBattle }, location.origin); } catch (err) { console.warn(err); } pendingBattle = null; }
    return;
  }
  if (d.type === 'flow-result') {
    if (!awaiting || !current) return;
    awaiting = false;
    if (current.type === 'battle') advance(d.result === 'win' ? 'win' : 'lose');
    else advance('next');
  }
});

async function main() {
  const select = $('flow-select');
  const files = await fetchList();
  select.innerHTML = '';
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.flow\.json$/, ''); select.appendChild(o); }

  const qid = new URLSearchParams(location.search).get('id');
  const first = qid ? (qid.endsWith('.flow.json') ? qid : qid + '.flow.json') : files[0];
  if (files.includes(first)) select.value = first;

  let currentFile = select.value || first;
  async function load(file) { currentFile = file; startFlow(await fetchFlow(file)); }

  select.onchange = () => load(select.value);
  $('btn-restart').onclick = () => load(currentFile);
  $('btn-again').onclick = () => load(currentFile);

  await load(currentFile);
  $('loading').classList.add('hidden');
  setTimeout(() => { $('loading').style.display = 'none'; }, 400);
}

main().catch(e => { console.error(e); $('loading').textContent = 'エラー: ' + e; });
