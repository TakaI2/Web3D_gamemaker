// speech-set.js — 反応セリフ（state別bark＋events）を npc.json から分離した *.speech.json を扱う。
// 設計: .tmp/requirements.md / design
//
// speech.json は軽量ファイル（KB級）。npc-speech 本体は変更せず、ここで「合成 characterDef」を作って渡す。
//
// 使い方:
//   const data = await fetchSpeechSet('lily.speech.json');             // or null
//   const speechChar = buildSpeechCharacter(data, 'lily');
//   const speech = createNpcSpeech(vrm, speechChar, hooks);            // 既存 npc-speech に渡す
//
// 解決順（呼び出し側で）: アクター指定 override → defaultSpeechFile(npcファイル) → 無し（無発話）

// npc ファイル名から規約の speech ファイル名を導く（lily.npc.json → lily.speech.json）
export function defaultSpeechFile(npcFile) {
  if (!npcFile) return null;
  return String(npcFile).replace(/\.npc\.json$/i, '').replace(/\.json$/i, '') + '.speech.json';
}

// lib 相対で public/speech/<file> を解決
export function speechUrl(file) {
  return new URL('../speech/' + String(file).split('/').map(encodeURIComponent).join('/'), import.meta.url).href;
}

// speech.json を取得（無ければ null）。file は 'lily.speech.json' 等。
export async function fetchSpeechSet(file) {
  if (!file) return null;
  try { const r = await fetch(speechUrl(file)); if (r.ok) return await r.json(); } catch { /* noop */ }
  return null;
}

// speech.json → npc-speech が読む characterDef 形（{displayName, states:{s:{speech}}, events}）
export function buildSpeechCharacter(speechData, fallbackName) {
  const states = {};
  if (speechData && speechData.states) {
    for (const [k, v] of Object.entries(speechData.states)) states[k] = { speech: v };
  }
  return {
    displayName: (speechData && speechData.displayName) || fallbackName || '',
    states,
    events: (speechData && speechData.events) || {},
  };
}

// npc バンドルの旧形式（character 内インライン speech）からの後方互換抽出。
// 既存 npc.json をその場で使う場合のフォールバック（移行前データ救済）。
export function speechFromLegacyCharacter(character) {
  if (!character) return null;
  const states = {};
  for (const [k, st] of Object.entries(character.states || {})) {
    if (st && st.speech) states[k] = st.speech;
  }
  const hasStates = Object.keys(states).length > 0;
  const hasEvents = character.events && Object.keys(character.events).length > 0;
  if (!hasStates && !hasEvents) return null;
  return { displayName: character.displayName, states, events: character.events || {} };
}
