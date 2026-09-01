// episode.js — エピソード定義（OP → 本編 → 分岐ED → 次EP）の解釈。素JS・DOM非依存。
// 設計: .tmp/design.md
//
// エピソード = 1つのフローグラフ ＋ そのフローが使うデータ束（map/talks/events/speech/BGM）＋ ルール。
// OP・本編・EDの並びと分岐は既存のフローグラフ（lib/flow-runner.js）がすでに表現できるので、
// ここが持つのは「どのデータ束を使うか」と「EP間の連結」だけ。
//
// 入出力はしない（fetch も fs も使わない）。JSONを渡す側が読み込む＝ゲームとビルドスクリプトの両方から使える。

// ステージ種別ごとのルール既定値。エピソード側の rules で個別に上書きできる。
export const STAGE_RULES = {
  rooms: { wanted: false, buildingEntry: false, cars: false, agents: false, special: false, paramsHud: false, fixedHour: 12 },
  city:  { wanted: true,  buildingEntry: true,  cars: true,  agents: true,  special: true,  paramsHud: true,  fixedHour: null },
};

// エピソードJSONを正規化する。未指定のファイル名は <id>_ 接頭で解決＝定義ファイルはほぼ空でよい。
export function normalizeEpisode(json, fallbackId) {
  const j = json || {};
  const id = String(j.id || fallbackId || 'ep0');
  const stage = j.stage === 'rooms' ? 'rooms' : 'city';
  const d = j.data || {};
  return {
    id,
    no: Number.isFinite(j.no) ? j.no : 0,
    title: j.title || id,
    subtitle: j.subtitle || '',
    map: j.map || id,
    stage,
    flow: j.flow || d.flow || (id + '.flow.json'),
    talks: d.talks || (id + '_talks.json'),
    events: d.events || (id + '_events.json'),
    speech: Array.isArray(d.speech) ? d.speech : [],   // 追加で同梱する speech（ビルドの同梱判断に使う）
    bgm: d.bgm || null,
    rules: { ...STAGE_RULES[stage], ...(j.rules || {}) },
  };
}

// エピソード定義が無いとき、旧構成（map=tutorial か否かの二値）から合成する。既存URL/ビルドの後方互換。
export function legacyEpisode(mapName) {
  const tut = mapName === 'tutorial';
  return normalizeEpisode({
    id: tut ? 'ep0' : 'cityfly',
    no: tut ? 0 : 1,
    title: tut ? 'EP0 訓練プログラム' : 'City-Fly 本編',
    subtitle: tut ? 'TRAINING PROGRAM' : 'DEAD ATMOS ASSAULT',
    map: mapName,
    stage: tut ? 'rooms' : 'city',
    flow: tut ? 'tutorial.flow.json' : 'cityfly.flow.json',
    data: {
      talks: tut ? 'tutorial_talks.json' : 'talks.json',
      events: tut ? 'tutorial_events.json' : 'events.json',
      speech: tut ? ['dummydoll.speech.json', 'pneuma.speech.json'] : [],
      bgm: tut ? 'zensen-he-totugekiseyo.ogg' : 'Sound_Wave.ogg',
    },
  });
}

// index.json から起動するエピソードのファイル名を決める。
//   epId 指定あり → そのID / 指定なし → map が一致するエピソード（無ければ null＝旧構成へ）
export function episodeFileFor(index, epId, mapName) {
  const list = Array.isArray(index) ? index : [];
  const e = epId ? list.find((x) => x.id === epId) : list.find((x) => x.map === mapName);
  if (e) return e.file || (e.id + '.ep.json');
  return epId ? epId + '.ep.json' : null;   // index に無いIDでも直接ファイルを試す
}

// end ノードが指す次エピソードID。無ければ null＝フロー終了（タイトルへ）
export function nextEpisodeOf(node) {
  return (node && node.data && node.data.next) || null;
}

// フローグラフから参照している .story.json を列挙する（ビルドの同梱判断用）
export function storiesOfFlow(flow) {
  const nodes = (flow && Array.isArray(flow.nodes)) ? flow.nodes : [];
  const out = [];
  for (const n of nodes) {
    const s = n && n.data && n.data.story;
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
