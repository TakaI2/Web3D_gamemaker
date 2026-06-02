// story-player.js — 3D ストーリー再生ページ（lib/story-stage の薄いラッパ）
// 設計: .tmp/design.md §8

import { createStoryStage } from '../lib/story-stage.js';

const $ = (id) => document.getElementById(id);

async function fetchStoryList() {
  try { const r = await fetch('../story/manifest.json'); if (r.ok) { const a = await r.json(); if (Array.isArray(a) && a.length) return a; } }
  catch { /* manifest 無し */ }
  return ['sample.story.json'];   // フォールバック
}

async function fetchStory(file) {
  const r = await fetch('../story/' + file);
  if (!r.ok) throw new Error('story 取得失敗: ' + file);
  return r.json();
}

async function main() {
  let stage;
  try {
    stage = await createStoryStage({ container: $('app'), mode: 'play' });
  } catch (e) {
    $('error-detail').textContent = String(e);
    $('error-msg').classList.add('visible');
    $('loading').style.display = 'none';
    return;
  }

  const select = $('story-select');
  const files = await fetchStoryList();
  select.innerHTML = '';
  for (const f of files) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.story\.json$/, ''); select.appendChild(o); }

  const startOverlay = $('start-overlay');
  let current = null;

  async function loadAndArm(file) {
    stage.stop();
    current = await fetchStory(file);
    stage.loadStory(current);
    $('start-title').textContent = current.title || file.replace(/\.story\.json$/, '');
    startOverlay.style.display = 'flex';
  }

  stage.setOnEnd(() => { startOverlay.style.display = 'flex'; });

  function start() {
    if (startOverlay.style.display === 'none') return;
    startOverlay.style.display = 'none';
    stage.play(0);
  }
  startOverlay.addEventListener('click', start);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && startOverlay.style.display !== 'none') { e.preventDefault(); start(); } });

  select.onchange = () => loadAndArm(select.value);

  // 初期ロード（?id= 指定があれば優先）
  const qid = new URLSearchParams(location.search).get('id');
  const first = qid ? (qid.endsWith('.story.json') ? qid : qid + '.story.json') : files[0];
  if (qid && files.includes(first)) select.value = first;
  await loadAndArm(select.value || first);

  $('loading').classList.add('hidden');
  setTimeout(() => { $('loading').style.display = 'none'; }, 400);
}

main().catch(e => {
  console.error(e);
  $('error-detail').textContent = String(e);
  $('error-msg').classList.add('visible');
  $('loading').style.display = 'none';
});
