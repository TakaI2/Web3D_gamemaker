// talk-editor.js — City-Fly ゲーム内会話(public/cityfly/talks.json)の編集。
// 話者マスタ(actors)＋会話ID→行配列(talks)。プレビューはゲームの会話ウィンドウと同じ見た目・同じ表示時間。
const $ = (id) => document.getElementById(id);
const TALK_MIN_SEC = 3.2, TALK_CPS = 9;   // ゲーム(city-fly.js)と同じ自動送り時間

let data = { format: 'cityfly-talks', version: 1, actors: {}, talks: {} };
let curTalk = null, selLine = null, playTimer = null;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 1800); }

async function load() {
  try {
    const j = await (await fetch('../cityfly/talks.json?ts=' + Date.now())).json();
    data = Object.assign({ format: 'cityfly-talks', version: 1 }, j);
    data.actors = data.actors || {}; data.talks = data.talks || {};
  } catch (e) { toast('読込失敗（新規扱い）: ' + e); }
  curTalk = Object.keys(data.talks)[0] || null;
  selLine = null;
  renderAll();
}

async function save() {
  try {
    const r = await fetch('../api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: 'cityfly', filename: 'talks.json', content: JSON.stringify(data, null, 2) }),
    });
    if (r.ok) { toast('保存しました: cityfly/talks.json'); return; }
    toast('保存失敗: ' + r.status);
  } catch (e) { toast('保存失敗: ' + e); }
}

function renderAll() { renderTalkList(); renderLines(); renderActors(); }

// ── 会話ID一覧 ──
function renderTalkList() {
  const el = $('talk-list'); el.innerHTML = '';
  for (const id of Object.keys(data.talks)) {
    const row = document.createElement('div');
    row.className = 'talk-row' + (id === curTalk ? ' active' : '');
    row.innerHTML = `<span>${id}</span><span style="color:#889;font-size:11px">${data.talks[id].length}行</span>`;
    row.onclick = () => { curTalk = id; selLine = null; renderTalkList(); renderLines(); };
    el.appendChild(row);
  }
}

// ── 行編集 ──
function renderLines() {
  const el = $('line-list'); el.innerHTML = '';
  $('lines-title').textContent = curTalk ? `行: ${curTalk}` : '行（未選択）';
  if (!curTalk) return;
  const lines = data.talks[curTalk];
  lines.forEach((ln, i) => {
    const card = document.createElement('div'); card.className = 'line-card';
    const who = document.createElement('select'); who.className = 'who';
    for (const [aid, a] of Object.entries(data.actors)) {
      const o = document.createElement('option'); o.value = aid; o.textContent = a.name || aid; who.appendChild(o);
    }
    if (ln.who && !data.actors[ln.who]) { const o = document.createElement('option'); o.value = ln.who; o.textContent = ln.who + '(未登録)'; who.appendChild(o); }
    who.value = ln.who || '';
    who.onchange = () => { ln.who = who.value; preview(ln); };
    const face = document.createElement('input'); face.className = 'face'; face.placeholder = 'normal';
    face.setAttribute('list', 'face-presets');
    face.value = ln.face || '';
    face.oninput = () => { if (face.value) ln.face = face.value; else delete ln.face; preview(ln); };
    const text = document.createElement('textarea'); text.value = ln.text || '';
    text.oninput = () => { ln.text = text.value; preview(ln); };
    text.onfocus = () => { selLine = i; preview(ln); };
    const ops = document.createElement('div'); ops.className = 'ops';
    ops.appendChild(mini('▲', () => { if (i > 0) { [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]]; renderLines(); } }));
    ops.appendChild(mini('▼', () => { if (i < lines.length - 1) { [lines[i + 1], lines[i]] = [lines[i], lines[i + 1]]; renderLines(); } }));
    ops.appendChild(mini('✕', () => { lines.splice(i, 1); renderLines(); renderTalkList(); }));
    card.appendChild(who); card.appendChild(face); card.appendChild(text); card.appendChild(ops);
    el.appendChild(card);
  });
}
function mini(label, fn) { const b = document.createElement('button'); b.className = 'mini'; b.textContent = label; b.onclick = fn; return b; }

// ── 話者マスタ ──
function renderActors() {
  const el = $('actor-list'); el.innerHTML = '';
  for (const [aid, a] of Object.entries(data.actors)) {
    const row = document.createElement('div'); row.className = 'actor-row';
    const id = document.createElement('input'); id.className = 'aid'; id.value = aid; id.title = '話者ID（顔グラのフォルダ名）';
    id.onchange = () => {
      const nid = id.value.trim();
      if (!nid || nid === aid || data.actors[nid]) { id.value = aid; return; }
      data.actors[nid] = data.actors[aid]; delete data.actors[aid];
      for (const lines of Object.values(data.talks)) for (const ln of lines) if (ln.who === aid) ln.who = nid;
      renderAll();
    };
    const name = document.createElement('input'); name.className = 'aname'; name.value = a.name || ''; name.placeholder = '表示名';
    name.oninput = () => { a.name = name.value; renderLinesSoft(); };
    const color = document.createElement('input'); color.className = 'acolor'; color.type = 'color'; color.value = a.color || '#8899aa';
    color.oninput = () => { a.color = color.value; };
    const vrm = document.createElement('input'); vrm.className = 'avrm'; vrm.value = a.vrm || ''; vrm.placeholder = '立体表示VRM';
    vrm.title = 'public/vrm/ のファイル名。指定すると会話ウィンドウにそのVRMの顔＋リップシンクが出る（例: doctor_mil.vrm）';
    vrm.onchange = () => { if (vrm.value.trim()) a.vrm = vrm.value.trim(); else delete a.vrm; };
    const del = mini('✕', () => { delete data.actors[aid]; renderAll(); });
    row.appendChild(id); row.appendChild(name); row.appendChild(color); row.appendChild(vrm); row.appendChild(del);
    el.appendChild(row);
  }
}
function renderLinesSoft() { /* 名前変更時にselectの表示だけ更新（フォーカスを奪わない） */ }

// ── プレビュー（ゲームと同じ見た目・仮画像フォールバック）──
function preview(ln) {
  const a = (ln && data.actors[ln.who]) || { name: (ln && ln.who) || '？', color: '#889' };
  $('pv-name').textContent = a.name; $('pv-name').style.color = a.color || '#adf';
  $('pv-text').textContent = (ln && ln.text) || '';
  const fb = document.querySelector('#pv-face .fb'), img = document.querySelector('#pv-face img');
  fb.textContent = (a.name || '？').slice(0, 1);
  fb.style.background = a.color || '#445';
  img.style.display = 'none';
  if (ln && ln.who) {
    img.onload = () => { img.style.display = ''; };
    img.onerror = () => { img.style.display = 'none'; };
    img.src = '../scenario2d/face/' + ln.who + '/' + (ln.face || 'normal') + '.png';
  }
}

function stopPlay() { if (playTimer) { clearTimeout(playTimer); playTimer = null; } }
function playPreview() {
  stopPlay();
  if (!curTalk) return;
  const lines = data.talks[curTalk];
  let i = 0;
  const step = () => {
    if (i >= lines.length) { playTimer = null; return; }
    const ln = lines[i++];
    preview(ln);
    playTimer = setTimeout(step, Math.max(TALK_MIN_SEC, (ln.text || '').length / TALK_CPS) * 1000);
  };
  step();
}

// ── init ──
$('btn-reload').onclick = load;
$('btn-save').onclick = save;
$('btn-add-talk').onclick = () => {
  const id = prompt('新しい会話ID（例: t_boss_intro）');
  if (!id || data.talks[id]) return;
  data.talks[id] = [{ who: Object.keys(data.actors)[0] || 'nei', text: '' }];
  curTalk = id; renderAll();
};
$('btn-del-talk').onclick = () => {
  if (!curTalk || !confirm(`会話「${curTalk}」を削除しますか？`)) return;
  delete data.talks[curTalk]; curTalk = Object.keys(data.talks)[0] || null; renderAll();
};
$('btn-rename').onclick = () => {
  if (!curTalk) return;
  const nid = prompt('新しいID', curTalk);
  if (!nid || nid === curTalk || data.talks[nid]) return;
  data.talks[nid] = data.talks[curTalk]; delete data.talks[curTalk]; curTalk = nid; renderAll();
  toast('※ events.json 側の参照IDも手で合わせてください');
};
$('btn-add-line').onclick = () => {
  if (!curTalk) return;
  const lines = data.talks[curTalk];
  const last = lines[lines.length - 1];
  lines.push({ who: (last && last.who) || Object.keys(data.actors)[0] || 'nei', text: '' });
  renderLines(); renderTalkList();
};
$('btn-add-actor').onclick = () => {
  const id = prompt('話者ID（顔グラのフォルダ名。例: elix）');
  if (!id || data.actors[id]) return;
  data.actors[id] = { name: id, color: '#8899aa' };
  renderActors();
};
$('btn-play').onclick = playPreview;
$('btn-stop').onclick = stopPlay;

load();
