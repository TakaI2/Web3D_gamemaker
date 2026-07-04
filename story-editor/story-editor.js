// story-editor.js — 3D ストーリー編集ページ。コマンド列の編集＋埋め込みプレビュー（lib/story-stage 共用）。
// 設計: .tmp/design.md §9

import { createStoryStage } from '../lib/story-stage.js';
import { STORY_OPS, OP_ORDER, makeOp, EXPR_PRESETS } from '../lib/story-ops.js';

const $ = (id) => document.getElementById(id);
let stage = null;
let story = newStory();
let selected = null;            // 選択中コマンドの index
let npcFiles = [], vrmaFiles = [], stageFiles = [];

function newStory() { return { version: 1, id: 'untitled', title: '', stage: '', actors: [], script: [] }; }

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1800); }

// ── マニフェスト ──
async function fetchList(url, fallback = []) {
  try { const r = await fetch(url); if (r.ok) { const a = await r.json(); if (Array.isArray(a)) return a; } } catch { /* noop */ }
  return fallback;
}

// ── コマンドリスト ──
function summarize(op) {
  const d = STORY_OPS[op.op]; if (!d) return '';
  const parts = [];
  for (const f of d.fields) {
    if (op[f.key] === undefined) continue;
    if (f.type === 'lines') { const n = Array.isArray(op.lines) ? op.lines.length : 0; parts.push(`${n}行`); continue; }
    if (f.type === 'vec3') { parts.push(`${f.key}=[${(op[f.key] || []).join(',')}]`); continue; }
    parts.push(`${f.key}=${op[f.key]}`);
  }
  return parts.join(' ');
}

function renderCmdList() {
  const el = $('cmd-list'); el.innerHTML = '';
  story.script.forEach((op, i) => {
    const d = STORY_OPS[op.op];
    const row = document.createElement('div');
    row.className = 'cmd' + (i === selected ? ' active' : '');
    row.innerHTML = `<span class="idx">${i}</span><span class="op">${d ? d.label : op.op}</span><span class="sum">${summarize(op)}</span>`;
    row.onclick = (e) => { if (e.target.classList.contains('mini')) return; selected = i; renderCmdList(); buildForm(); };
    const up = mini('▲', () => moveCmd(i, -1));
    const dn = mini('▼', () => moveCmd(i, +1));
    const del = mini('✕', () => delCmd(i));
    row.appendChild(up); row.appendChild(dn); row.appendChild(del);
    el.appendChild(row);
  });
}
function mini(label, fn) { const b = document.createElement('button'); b.className = 'mini'; b.textContent = label; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; }

function addCmd() {
  const opName = $('op-picker').value;
  const op = makeOp(opName);
  const at = selected != null ? selected + 1 : story.script.length;
  story.script.splice(at, 0, op);
  selected = at; renderCmdList(); buildForm();
}
function delCmd(i) { story.script.splice(i, 1); if (selected === i) selected = null; else if (selected > i) selected--; renderCmdList(); buildForm(); }
function moveCmd(i, dir) {
  const j = i + dir; if (j < 0 || j >= story.script.length) return;
  const a = story.script; [a[i], a[j]] = [a[j], a[i]];
  if (selected === i) selected = j; else if (selected === j) selected = i;
  renderCmdList(); buildForm();
}

// ── パラメータフォーム（STORY_OPS 駆動） ──
function buildForm() {
  const panel = $('form-panel'); panel.innerHTML = '';
  if (selected == null || !story.script[selected]) { $('form-title').textContent = 'コマンド未選択'; return; }
  const op = story.script[selected];
  const d = STORY_OPS[op.op];
  $('form-title').textContent = `${d ? d.label : op.op} (${op.op})`;
  if (!d) return;
  for (const f of d.fields) panel.appendChild(buildField(op, f));
}

function rowEl(labelText, node) {
  const r = document.createElement('div'); r.className = 'row';
  const l = document.createElement('label'); l.textContent = labelText; r.appendChild(l); r.appendChild(node); return r;
}

function buildField(op, f) {
  const t = f.type;
  if (t === 'lines') return buildLinesField(op);
  if (t === 'bool') {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!op[f.key];
    c.onchange = () => { op[f.key] = c.checked; renderCmdList(); };
    const r = rowEl(f.key, c); r.querySelector('input').style.flex = 'none'; return r;
  }
  if (t === 'vec3') {
    const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:4px;flex:1;';
    const vec = Array.isArray(op[f.key]) ? op[f.key].slice() : [0, 0, 0];
    ['x', 'y', 'z'].forEach((_, idx) => {
      const n = document.createElement('input'); n.type = 'number'; n.step = '0.1'; n.value = vec[idx] ?? 0; n.style.width = '33%';
      n.onchange = () => { vec[idx] = parseFloat(n.value); op[f.key] = vec.slice(); renderCmdList(); };
      wrap.appendChild(n);
    });
    return rowEl(f.key, wrap);
  }
  if (t === 'expr') {
    const sel = selectEl(['', ...EXPR_PRESETS], op[f.key] ?? '', (v) => { op[f.key] = v; renderCmdList(); }, '(なし)');
    return rowEl(f.key, sel);
  }
  if (t === 'actorRef') {
    const ids = story.actors.map(a => a.id);
    const sel = selectEl(ids, op[f.key] ?? '', (v) => { op[f.key] = v; renderCmdList(); }, '(アクター)');
    return rowEl(f.key, sel);
  }
  if (t === 'npcRef')  return rowEl(f.key, selectEl(npcFiles, op[f.key] ?? '', (v) => { op[f.key] = v; renderCmdList(); }, '(npc)'));
  if (t === 'vrmaRef') return rowEl(f.key, selectEl(vrmaFiles, op[f.key] ?? '', (v) => { op[f.key] = v; renderCmdList(); }, '(vrma)'));
  if (t === 'stageRef')return rowEl(f.key, selectEl(['', ...stageFiles], op[f.key] ?? '', (v) => { op[f.key] = v; renderCmdList(); }, '(stage)'));
  // text / number
  const inp = document.createElement('input');
  inp.type = t === 'number' ? 'number' : 'text';
  if (t === 'number') inp.step = 'any';
  inp.value = op[f.key] ?? '';
  inp.oninput = () => { op[f.key] = t === 'number' ? parseFloat(inp.value) : inp.value; renderCmdList(); };
  return rowEl(f.key, inp);
}

function selectEl(options, value, onChange, placeholder) {
  const sel = document.createElement('select');
  if (placeholder && !options.includes('')) { const o = document.createElement('option'); o.value = ''; o.textContent = placeholder; sel.appendChild(o); }
  for (const opt of options) { const o = document.createElement('option'); o.value = opt; o.textContent = opt === '' ? (placeholder || '(なし)') : opt; sel.appendChild(o); }
  sel.value = value;
  sel.onchange = () => onChange(sel.value);
  return sel;
}

// say の lines 編集（文字列 or {text,expression,weight}）
function buildLinesField(op) {
  const box = document.createElement('div');
  if (!Array.isArray(op.lines)) op.lines = [];
  const lines = op.lines;
  const refresh = () => { const nb = buildLinesField(op); box.replaceWith(nb); renderCmdList(); };
  lines.forEach((line, i) => {
    const v = typeof line === 'string' ? { text: line, expression: '', weight: 1 } : { text: line.text || '', expression: line.expression || '', weight: line.weight != null ? line.weight : 1 };
    const wr = document.createElement('div'); wr.className = 'line-row';
    const txt = document.createElement('input'); txt.type = 'text'; txt.value = v.text; txt.placeholder = 'セリフ';
    txt.style.cssText = 'width:100%;background:#222;color:#ddd;border:1px solid #3a3a60;border-radius:3px;padding:3px;';
    txt.oninput = () => { v.text = txt.value; writeLine(lines, i, v); };
    wr.appendChild(txt);
    const ctl = document.createElement('div'); ctl.style.cssText = 'display:flex;gap:4px;margin-top:4px;align-items:center;';
    const sel = selectEl(['', ...EXPR_PRESETS], v.expression, (val) => { v.expression = val; writeLine(lines, i, v); refresh(); }, '(状態表情)');
    sel.style.flex = '1'; ctl.appendChild(sel);
    if (v.expression) {
      const w = document.createElement('input'); w.type = 'range'; w.min = '0'; w.max = '1'; w.step = '0.05'; w.value = v.weight; w.style.cssText = 'flex:1;min-width:0;';
      w.oninput = () => { v.weight = parseFloat(w.value); writeLine(lines, i, v); };
      ctl.appendChild(w);
    }
    const del = document.createElement('button'); del.className = 'mini'; del.textContent = '✕'; del.onclick = () => { lines.splice(i, 1); refresh(); };
    ctl.appendChild(del);
    wr.appendChild(ctl);
    box.appendChild(wr);
  });
  const add = document.createElement('button'); add.className = 'act'; add.textContent = '＋ 行追加'; add.onclick = () => { lines.push(''); refresh(); };
  box.appendChild(add);
  return box;
}
function writeLine(lines, i, v) { lines[i] = v.expression ? { text: v.text, expression: v.expression, weight: v.weight } : v.text; }

// ── アクター一覧 ──
function renderActors() {
  const el = $('actor-list'); el.innerHTML = '';
  story.actors.forEach((a, i) => {
    const row = document.createElement('div'); row.className = 'actor-row';
    const id = document.createElement('input'); id.type = 'text'; id.value = a.id; id.placeholder = 'id';
    id.oninput = () => { a.id = id.value; };
    const sel = selectEl(npcFiles, a.npc || '', (v) => { a.npc = v; }, '(npc)');
    const del = document.createElement('button'); del.className = 'mini'; del.textContent = '✕'; del.onclick = () => { story.actors.splice(i, 1); renderActors(); };
    row.appendChild(id); row.appendChild(sel); row.appendChild(del);
    el.appendChild(row);
  });
}

// ── メタ・保存・読込 ──
function syncMeta() { story.id = $('story-id').value || 'untitled'; story.title = $('story-title').value; story.stage = $('story-stage').value; }
function applyMetaInputs() { $('story-id').value = story.id || ''; $('story-title').value = story.title || ''; $('story-stage').value = story.stage || ''; }

async function save() {
  syncMeta();
  const filename = (story.id || 'untitled') + '.story.json';
  try {
    const r = await fetch('../api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'story', filename, content: story }) });
    if (r.ok) { const j = await r.json(); toast('保存しました: ' + j.path); await refreshStoryList(filename); return; }
  } catch { /* フォールバックへ */ }
  const blob = new Blob([JSON.stringify(story, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  toast('ダウンロードしました（サーバー保存不可）');
}

function setStory(json) {
  story = Object.assign(newStory(), json);
  story.actors = story.actors || []; story.script = story.script || [];
  selected = null;
  applyMetaInputs(); renderActors(); renderCmdList(); buildForm();
}

async function refreshStoryList(current) {
  const files = await fetchList('../story/manifest.json', []);
  const sel = $('story-select'); sel.innerHTML = '';
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '(新規)'; sel.appendChild(o0);
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.story\.json$/, ''); sel.appendChild(o); }
  if (current && files.includes(current)) sel.value = current;
}

// ── プレビュー ──
function playAll() { stage.loadStory(story); stage.play(0); }
async function playHere() { stage.loadStory(story); await stage.prime(selected || 0); stage.play(selected || 0); }
function stopPreview() { stage.stop(); }

// ── init ──
async function init() {
  [npcFiles, vrmaFiles, stageFiles] = await Promise.all([
    fetchList('../npc/manifest.json', []),
    fetchList('../vrma/manifest.json', []),
    fetchList('../models/manifest.json', []),
  ]);

  // op ピッカー
  const picker = $('op-picker'); picker.innerHTML = '';
  for (const name of OP_ORDER) { const o = document.createElement('option'); o.value = name; o.textContent = `${STORY_OPS[name].label} (${name})`; picker.appendChild(o); }
  // ステージ選択
  const ss = $('story-stage'); ss.innerHTML = '<option value="">(なし)</option>';
  for (const f of ['stage.json', ...stageFiles]) { const o = document.createElement('option'); o.value = f; o.textContent = f; ss.appendChild(o); }

  // プレビュー（WebGPU）
  try { stage = await createStoryStage({ container: $('preview'), mode: 'edit' }); }
  catch (e) { toast('プレビュー初期化失敗: ' + e); console.error(e); }

  // イベント
  $('btn-add').onclick = addCmd;
  $('btn-add-actor').onclick = () => { story.actors.push({ id: 'actor' + (story.actors.length + 1), npc: npcFiles[0] || '' }); renderActors(); };
  $('btn-save').onclick = save;
  $('btn-new').onclick = () => { setStory(newStory()); $('story-select').value = ''; };
  $('story-id').oninput = syncMeta; $('story-title').oninput = syncMeta; $('story-stage').onchange = syncMeta;
  $('btn-play-all').onclick = () => stage && playAll();
  $('btn-play-here').onclick = () => stage && playHere();
  $('btn-stop').onclick = () => stage && stopPreview();
  $('story-select').onchange = async () => {
    const f = $('story-select').value;
    if (!f) { setStory(newStory()); return; }
    const j = await fetch('../story/' + f).then(r => r.ok ? r.json() : null).catch(() => null);
    if (j) setStory(j); else toast('読込失敗: ' + f);
  };

  await refreshStoryList(null);
  // 初期はサンプルを読み込む（あれば）
  const sampleList = await fetchList('../story/manifest.json', []);
  if (sampleList.includes('sample.story.json')) {
    const j = await fetch('../story/sample.story.json').then(r => r.json()).catch(() => null);
    if (j) { setStory(j); $('story-select').value = 'sample.story.json'; }
  } else { setStory(newStory()); }
}

init().catch(e => { console.error(e); toast('初期化失敗: ' + e); });
