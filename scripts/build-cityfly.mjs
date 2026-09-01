import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeEpisode } from '../lib/episode.js';

// CityFlyを自己完結の dist-cityfly/ に書き出す。
// three / three-vrm 等は CDN（esm.sh / jsdelivr）から実行時取得するため同梱不要。
// ローカル参照（lib / npc / timeline / vrma / roads / models / maps）だけを dist 内へコピーし、
// 相対パスを ./ 起点へ書き換える。DEFAULT_MAP を index.html に注入＝起動時から自作マップで動く
// （外部配信へはアクセスしない。道路スプライン未保存のマップはOSMフォールバック＝OSM表記が自動表示される）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'city-fly');
const MP_BUILD = process.env.MP === '1';   // MP=1 → マルチプレイ専用ビルド（別出力・ログイン画面つき）
const pub  = path.join(root, 'public');
// エピソード（EP=ep0 で指定）。既定マップは EP から導出する。MAP を明示した場合はそちらが優先。
const EP_ID = process.env.EP || null;
let epDef = null;
if (EP_ID) {
  try { epDef = normalizeEpisode(JSON.parse(fs.readFileSync(path.join(root, 'public', 'episodes', EP_ID + '.ep.json'), 'utf8')), EP_ID); }
  catch (e) { console.warn(`エピソード定義を読めません（EP=${EP_ID}）: ` + e.message); }
}
const DEFAULT_MAP = process.env.MAP || (epDef ? epDef.map : 'mytown');   // 既定マップ（MAP=名前 npm run build:cityfly で変更可）
// OUT=名前 で出力先を変更（例: CyberBat配信ビルド → OUT=dist-cyberbat MAP=tutorial）
const dest = path.join(root, process.env.OUT || (MP_BUILD ? 'dist-cityfly-mp' : 'dist-cityfly'));
const OUT_NAME = path.basename(dest);
// チュートリアル専用ビルド: 街（道路網・Kenney建物・車・公園/森・家具）は一切使わないので同梱しない
const TUT = DEFAULT_MAP === 'tutorial';

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// index.html: DEFAULT_MAP を注入してコピー
const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
  .replace('<script type="module"', `<script>window.DEFAULT_MAP = '${DEFAULT_MAP}';${epDef ? ` window.DEFAULT_EP = '${epDef.id}';` : ''}${MP_BUILD ? ' window.MP_BUILD = true;' : ''}</script>\n  <script type="module"`);
fs.writeFileSync(path.join(dest, 'index.html'), html);
console.log(`copied: index.html (DEFAULT_MAP=${DEFAULT_MAP}${epDef ? ' / EP=' + epDef.id : ''}${MP_BUILD ? ' / MPビルド' : ''})`);
// エピソード定義（一覧＋各EP。数KBなので全部入れる。起動時の解決に使う）
const epSrc = path.join(pub, 'episodes');
if (fs.existsSync(epSrc)) {
  fs.cpSync(epSrc, path.join(dest, 'episodes'), { recursive: true });
  console.log('copied: episodes/');
}

// city-fly.js: ローカル相対参照を dist 内ローカル（./）へ書き換え
const jsSrc = fs.readFileSync(path.join(src, 'city-fly.js'), 'utf8')
  .replace(/\.\.\/lib\//g, './')
  .replace(/\.\.\/models\//g, './models/')
  .replace(/\.\.\/npc\//g, './npc/')
  .replace(/\.\.\/timeline\//g, './timeline/')
  .replace(/\.\.\/vrma\//g, './vrma/')
  .replace(/\.\.\/vrm\//g, './vrm/')   // 会話ポートレート用VRM（vrma より後に置くと誤置換するので順序注意）
  .replace(/\.\.\/roads\//g, './roads/')
  .replace(/\.\.\/maps\//g, './maps/')
  .replace(/\.\.\/fx\//g, './fx/')
  .replace(/\.\.\/ragdoll\//g, './ragdoll/')
  .replace(/\.\.\/bitealign\//g, './bitealign/')
  .replace(/\.\.\/audio\//g, './audio/')
  .replace(/\.\.\/sound/g, './sound')          // 効果音（'../sound' と '../sound/' の両方）
  .replace(/\.\.\/cityfly\//g, './cityfly/')   // イベント・会話定義
  .replace(/\.\.\/story\//g, './story/')       // 2Dシナリオ
  .replace(/\.\.\/flow\//g, './flow/')         // ゲームフロー
  .replace(/\.\.\/damage\//g, './damage/')     // ダメージ損耗設定
  .replace(/\.\.\/scenario2d/g, './scenario2d')   // 顔グラ・背景（未配置なら404→仮表示）
  .replace(/\.\.\/api\//g, './api/')   // api/save は開発サーバ専用（本番は保存ボタンが失敗表示になるだけ）
  .replace(/const PUB_ROOT = '\.\.\/'/, "const PUB_ROOT = './'")   // BGM/gif等の動的パスの基点
  .replace(/\.\.\/([\w\-]+\.png)/g, './tex/$1');   // コード直参照のテクスチャ（electric.png等）は tex/ へ
fs.writeFileSync(path.join(dest, 'city-fly.js'), jsSrc);
console.log('copied: city-fly.js (paths rewritten)');

// 自作マップ（.map.json）。植生が参照する木モデル（forest.model）も収集して後で同梱
const mapsSrc = path.join(pub, 'maps');
const forestModels = new Set();
if (fs.existsSync(mapsSrc)) {
  const mapsDest = path.join(dest, 'maps'); fs.mkdirSync(mapsDest, { recursive: true });
  const mapFiles = fs.readdirSync(mapsSrc).filter((f) => f.endsWith('.map.json'))
    .filter((f) => !TUT || f === DEFAULT_MAP + '.map.json');   // 専用ビルドは既定マップだけ同梱
  for (const f of mapFiles) {
    fs.copyFileSync(path.join(mapsSrc, f), path.join(mapsDest, f));
    try {
      const fm = JSON.parse(fs.readFileSync(path.join(mapsSrc, f), 'utf8')).forest?.model;
      if (fm) forestModels.add(fm);
    } catch { /* 壊れたマップは無視 */ }
  }
  console.log('copied: maps/*.map.json');
}

// timeline/fx が参照する public 直下のテクスチャpng（例 ../electric.png）を集めて同梱し、パスを ./ へ書き換え
const texPngs = new Set(['electric.png']);   // アルティメット乱射のシート（コードから直接参照）
const rewriteTexPaths = (text) => text.replace(/\.\.\/([\w\-. %@]+\.png)/g, (_, name) => { texPngs.add(name); return './tex/' + name; });
// 共有 lib（すべて CDN 依存のみ。念のため ../lib/ を ./ へ）
for (const f of ['vrm-cloth.js', 'sheen-util.js', 'cityfly-mp.js', 'kenney-buildings.js', 'room-gen.js', 'terrain.js', 'fx-mesh.js', 'fx-beam.js', 'fx-tornado.js', 'fx-particles.js', 'fx-textures.js', 'fx-dissolve.js', 'vrm-ragdoll.js', 'npc-speech.js', 'speech-ui.js', 'speech-set.js', 'lip-sync.js', 'scenario2d.js', 'flow-runner.js', 'episode.js','vrm-expressions.js', 'vrm-tk.js', 'pose-kit.js', 'grab-shapes.js']) {
  const libSrc = rewriteTexPaths(fs.readFileSync(path.join(root, 'lib', f), 'utf8')
    .replace(/\.\.\/lib\//g, './')
    .replace(/\.\.\/speech\//g, './speech/'));   // speech-set.js は import.meta.url 相対（distではlibがルート直下）
  // ↑ lib内のテクスチャ既定値（fx-beam.js の '../electric.png' 等）も tex/ へ書き換える。
  //   ここを忘れると本番でアプリの1つ上の階層を探しに行って404になる
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// NPCバンドル（nei_vamp=プレイヤー / ken=地上NPC・捕食対象）
const npcDest = path.join(dest, 'npc');
fs.mkdirSync(npcDest, { recursive: true });
for (const n of ['nei_v2.npc.json', 'ken.npc.json']) {
  fs.copyFileSync(path.join(pub, 'npc', n), path.join(npcDest, n));
  console.log(`copied: npc/${n}`);
}
const clSrc = path.join(pub, 'npc', 'char-light.json');
if (fs.existsSync(clSrc)) { fs.copyFileSync(clSrc, path.join(npcDest, 'char-light.json')); console.log('copied: npc/char-light.json'); }

// timeline（飛行＋攻撃＋トーテム）+ それが参照する vrma
const timelines = [
  'Joy_reborn_Fly_idle', 'Joy_reborn_groggy', 'Joy_reborn_Fly_f', 'Joy_reborn_front_down', 'Joy_reborn_Fly_back', 'Joy_reborn_Fly_L', 'Joy_reborn_Fly_R',
  'Joy_reborn_Fly_f2', 'Joy_reborn_capcher1', 'Joy_reborn_throw', 'Joy_reborn_cas1_L1', 'Joy_reborn_large_shot_load', 'Joy_reborn_large_beam', 'Joy_reborn_lightning', 'Joy_reborn_totem',
  'Joy_reborn_drain_0', 'Joy_reborn_drain_1',   // アルティメット（電撃乱射）
];
const tlDest = path.join(dest, 'timeline'); fs.mkdirSync(tlDest, { recursive: true });
const vrmaDest = path.join(dest, 'vrma'); fs.mkdirSync(vrmaDest, { recursive: true });
// ken/ドールの歩行VRMAは city-fly.js の KEN_WALK_VRMA を実読み（定数を変えたのに dist へ入らず
// T ポーズになる事故を防ぐ）
const kenWalkVrma = (jsSrc.match(/KEN_WALK_VRMA = '([^']+)'/) || [])[1] || 'Catwalk_Walk_Forward.vrma';
const vrmaSet = new Set([kenWalkVrma, 'hit_front.vrma', 'dead03.vrma', 'HumanM@Idle01.vrma']);   // ken歩行＋プレイヤー被弾/死亡
for (const t of timelines) {
  const file = path.join(pub, 'timeline', t + '.timeline.json');
  const text = rewriteTexPaths(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(path.join(tlDest, t + '.timeline.json'), text);
  const v = JSON.parse(text).vrma;
  if (v) vrmaSet.add(v);
  console.log(`copied: timeline/${t}.timeline.json`);
}
// 捕食（bite align）設定＋参照 vrma＋効果音
const biteSrc = path.join(pub, 'bitealign', 'ken.bite.json');
if (fs.existsSync(biteSrc)) {
  const baDest = path.join(dest, 'bitealign'); fs.mkdirSync(baDest, { recursive: true });
  fs.copyFileSync(biteSrc, path.join(baDest, 'ken.bite.json'));
  const cfg = JSON.parse(fs.readFileSync(biteSrc));
  vrmaSet.add(cfg.anim?.playerVrma || 'feed.vrma');
  vrmaSet.add(cfg.anim?.victimVrma || 'attack_drain_victim02.vrma');
  if (cfg.anim?.sound) {
    const aDest = path.join(dest, 'audio'); fs.mkdirSync(aDest, { recursive: true });
    const aSrc = path.join(pub, 'audio', cfg.anim.sound);
    if (fs.existsSync(aSrc)) { fs.copyFileSync(aSrc, path.join(aDest, cfg.anim.sound)); console.log(`copied: audio/${cfg.anim.sound}`); }
  }
  console.log('copied: bitealign/ken.bite.json');
}
for (const v of vrmaSet) {
  const src = path.join(pub, 'vrma', v);
  if (!fs.existsSync(src)) { console.warn(`skip missing vrma: ${v}`); continue; }
  fs.copyFileSync(src, path.join(vrmaDest, v));
  console.log(`copied: vrma/${v}`);
}
// セリフ（ken住民）。speech-set.js は lib 相対 '../speech/' を見るので dist ルートに speech/ を置く
fs.mkdirSync(path.join(dest, 'speech'), { recursive: true });
for (const sp of ['ken.speech.json', ...(TUT ? ['dummydoll.speech.json', 'pneuma.speech.json'] : [])]) {
  const spSrc = path.join(pub, 'speech', sp);
  if (!fs.existsSync(spSrc)) { console.warn(`skip missing speech: ${sp}`); continue; }
  fs.copyFileSync(spSrc, path.join(dest, 'speech', sp));
  console.log(`copied: speech/${sp}`);
}

// ラグドール調整値（ken＋プレイヤー nei_vamp）
for (const rg of ['ken.ragdoll.json', 'nei_v2.ragdoll.json']) {
  const ragSrc = path.join(pub, 'ragdoll', rg);
  if (!fs.existsSync(ragSrc)) { console.warn(`skip missing ragdoll: ${rg}`); continue; }
  const rDest = path.join(dest, 'ragdoll'); fs.mkdirSync(rDest, { recursive: true });
  fs.copyFileSync(ragSrc, path.join(rDest, rg));
  console.log(`copied: ragdoll/${rg}`);
}
// ダメージ損耗設定（プレイヤー）
const dmgSrc = path.join(pub, 'damage', 'nei_v2.damage.json');
if (fs.existsSync(dmgSrc)) {
  const dDest = path.join(dest, 'damage'); fs.mkdirSync(dDest, { recursive: true });
  fs.copyFileSync(dmgSrc, path.join(dDest, 'nei_v2.damage.json'));
  console.log('copied: damage/nei_v2.damage.json');
}
// 効果音（SFX。ビーム/爆発/雷）
const sndSrc = path.join(pub, 'sound');
if (fs.existsSync(sndSrc)) {
  const sDest = path.join(dest, 'sound'); fs.mkdirSync(sDest, { recursive: true });
  let n = 0;
  // .m4a も同梱（iOS/Safari は Ogg Vorbis を再生できないため audioSrc() が .m4a を参照する）
  for (const f of fs.readdirSync(sndSrc).filter((f) => /\.(ogg|m4a)$/i.test(f))) { fs.copyFileSync(path.join(sndSrc, f), path.join(sDest, f)); n++; }
  console.log(`copied: ${n} sound files`);
}
// ゲームループ定義（イベント・会話・2Dシナリオ・フロー）
fs.mkdirSync(path.join(dest, 'cityfly'), { recursive: true });
// 会話ポートレート用VRM（talks.json の actor.vrm）
try {
  const tj = JSON.parse(fs.readFileSync(path.join(pub, 'cityfly', TUT ? 'tutorial_talks.json' : 'talks.json'), 'utf8'));
  const acts = Object.values(tj.actors || {});
  const needVrm = [...new Set(acts.map((a) => a && a.vrm).filter(Boolean))];
  const needNpc = [...new Set(acts.map((a) => a && a.npc).filter(Boolean))];   // .npc.json バンドル（マント付き）
  if (needVrm.length) {
    const vDest = path.join(dest, 'vrm'); fs.mkdirSync(vDest, { recursive: true });
    for (const f of needVrm) {
      const src2 = path.join(pub, 'vrm', f);
      if (!fs.existsSync(src2)) { console.warn('skip missing portrait vrm: ' + f); continue; }
      fs.copyFileSync(src2, path.join(vDest, f));
      console.log('copied: vrm/' + f + ' (portrait)');
    }
  }
  for (const f of needNpc) {
    const src2 = path.join(pub, 'npc', f);
    if (!fs.existsSync(src2)) { console.warn('skip missing portrait npc: ' + f); continue; }
    fs.mkdirSync(path.join(dest, 'npc'), { recursive: true });
    fs.copyFileSync(src2, path.join(dest, 'npc', f));
    console.log('copied: npc/' + f + ' (portrait)');
  }
} catch (e) { console.warn('ポートレートVRMの収集に失敗:', e.message); }
for (const dir of ['BGM', 'gif']) {   // BGM・シナリオ背景GIF
  const srcD = path.join(pub, dir);
  if (fs.existsSync(srcD)) {
    const dd = path.join(dest, dir);
    fs.mkdirSync(dd, { recursive: true });
    for (const f of fs.readdirSync(srcD)) fs.copyFileSync(path.join(srcD, f), path.join(dd, f));
    console.log('copied: ' + dir + '/*');
  }
}
const cityflyJson = TUT
  ? ['tutorial_events.json', 'tutorial_talks.json', 'expressions.json', 'grabhit.json']
  : ['events.json', 'talks.json', 'expressions.json', 'grabhit.json'];
for (const f of cityflyJson) {
  const src2 = path.join(pub, 'cityfly', f);
  if (fs.existsSync(src2)) {
    fs.copyFileSync(src2, path.join(dest, 'cityfly', f));
    console.log(`copied: cityfly/${f}`);
  } else if (f === 'grabhit.json') {   // 未保存でも空で置く（本番で404を出さない）
    fs.writeFileSync(path.join(dest, 'cityfly', f), JSON.stringify({ format: 'grabhit', version: 1, kinds: {} }));
    console.log('written: cityfly/grabhit.json (空)');
  } else console.warn(`skip missing cityfly/${f}`);
}
fs.mkdirSync(path.join(dest, 'story'), { recursive: true });
const storyPrefix = TUT ? 'tutorial_' : 'cityfly_';
for (const f of fs.readdirSync(path.join(pub, 'story')).filter((f) => f.startsWith(storyPrefix) && f.endsWith('.story.json'))) {
  fs.copyFileSync(path.join(pub, 'story', f), path.join(dest, 'story', f));
  console.log(`copied: story/${f}`);
}
fs.mkdirSync(path.join(dest, 'flow'), { recursive: true });
const flowFile = TUT ? 'tutorial.flow.json' : 'cityfly.flow.json';
fs.copyFileSync(path.join(pub, 'flow', flowFile), path.join(dest, 'flow', flowFile));
console.log(`copied: flow/${flowFile}`);
// 2D素材（顔グラ/背景。まだ無ければスキップ=ゲーム側が仮表示にフォールバック）
const s2dSrc = path.join(pub, 'scenario2d');
if (fs.existsSync(s2dSrc)) {
  fs.cpSync(s2dSrc, path.join(dest, 'scenario2d'), { recursive: true });
  console.log('copied: scenario2d/');
}
// FXプリセット（timeline 埋め込み custom:* ＋着弾 explosion ＋トーテム）。テクスチャ参照も ./ へ
const fxSrcDir = path.join(pub, 'fx');
if (fs.existsSync(fxSrcDir)) {
  const fxDest = path.join(dest, 'fx'); fs.mkdirSync(fxDest, { recursive: true });
  for (const f of fs.readdirSync(fxSrcDir).filter((f) => f.endsWith('.fx.json'))) {
    fs.writeFileSync(path.join(fxDest, f), rewriteTexPaths(fs.readFileSync(path.join(fxSrcDir, f), 'utf8')));
  }
  console.log('copied: fx/*.fx.json');
}
// 参照テクスチャpng を dist/tex/ へ（全アセットをフォルダ配下に揃える＝FTPでの取りこぼし防止）
const texDest = path.join(dest, 'tex'); fs.mkdirSync(texDest, { recursive: true });
for (const name of texPngs) {
  const src = path.join(pub, name);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(texDest, name)); console.log(`copied: tex/${name}`); }
  else console.warn(`skip missing texture: ${name}`);
}
// 追加 lib（fx-mesh/fx-tornado/fx-particles/fx-dissolve/vrm-ragdoll）

// 掴み対象のコンテナ（チュートリアルのプロップ／街の港。lib/grab-shapes.js が参照）
{
  const wfSrc = path.join(pub, 'models', 'waterfront_GLB format');
  if (fs.existsSync(wfSrc)) {
    const wfDest = path.join(dest, 'models', 'waterfront_GLB format');
    fs.mkdirSync(path.join(wfDest, 'Textures'), { recursive: true });
    const wfModels = TUT ? ['cargo-container-a'] : fs.readdirSync(wfSrc).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));
    for (const m of wfModels) {
      const f = path.join(wfSrc, m + '.glb');
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(wfDest, m + '.glb'));
    }
    const wfTex = path.join(wfSrc, 'Textures', 'colormap.png');
    if (fs.existsSync(wfTex)) fs.copyFileSync(wfTex, path.join(wfDest, 'Textures', 'colormap.png'));
    console.log(`copied: ${wfModels.length} waterfront models`);
  }
}

// 車モデル（CAR_KIT）＋ 共有 colormap テクスチャ
const CAR_KIT = ['sedan', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'police', 'van', 'delivery', 'truck', 'hatchback-sports'];
if (!TUT) {   // 車は道路網（loadRoads→finishRoads→spawnCars）専用＝チュートリアルでは出ない
  const carSrc = path.join(pub, 'models', 'car_GLB format');
  const carDest = path.join(dest, 'models', 'car_GLB format');
  fs.mkdirSync(path.join(carDest, 'Textures'), { recursive: true });
  for (const c of CAR_KIT) fs.copyFileSync(path.join(carSrc, c + '.glb'), path.join(carDest, c + '.glb'));
  fs.copyFileSync(path.join(carSrc, 'Textures', 'colormap.png'), path.join(carDest, 'Textures', 'colormap.png'));
  console.log(`copied: ${CAR_KIT.length} car models + colormap.png`);
}

// Kenney 建物キット（KENNEY_CITY モード用）＋ 各キットの colormap
// suburban には街路樹(tree-large/small)も追加。roads キットは道路実体化・交差点・信号で使用
const letters = (a, z) => Array.from({ length: z.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i));
const BLD = [
  { dir: 'city_GLB format', models: [...letters('a', 'n').map((c) => 'building-' + c), ...letters('a', 'e').map((c) => 'building-skyscraper-' + c)] },
  { dir: 'kenney_city-kit-suburban_20/Models/GLB format', models: [...letters('a', 'u').map((c) => 'building-type-' + c), 'tree-large', 'tree-small'] },
  { dir: 'kenney_city-kit-roads/Models/GLB format', models: ['road-straight', 'light-curved', 'light-square', 'road-crossroad-path', 'road-intersection-path', 'road-bend-sidewalk', 'road-crossing', 'road-straight-barrier'] },
];
for (const kit of (TUT ? [] : BLD)) {   // Kenney建物/道路キットは街専用
  const s = path.join(pub, 'models', kit.dir);
  const d = path.join(dest, 'models', kit.dir);
  fs.mkdirSync(path.join(d, 'Textures'), { recursive: true });
  for (const m of kit.models) fs.copyFileSync(path.join(s, m + '.glb'), path.join(d, m + '.glb'));
  fs.copyFileSync(path.join(s, 'Textures', 'colormap.png'), path.join(d, 'Textures', 'colormap.png'));
  console.log(`copied: ${kit.models.length} building models from ${kit.dir}`);
}

// 公園モデル（生垣/ゲート/噴水/ランタン＝buildParksが固定参照。チュートリアルは公園なし）
if (!TUT) for (const m of ['hedge', 'hedge-gate', 'fountain-round-detail', 'fountain-square-detail', 'lantern']) {
  forestModels.add('fantasy_GLB format/' + m + '.glb');
}
// 森の木モデル（マップの forest.model が参照）＋公園モデル。同キットの colormap もあれば同梱
for (const rel of forestModels) {
  const srcF = path.join(pub, 'models', rel);
  if (!fs.existsSync(srcF)) { console.warn(`skip missing forest model: ${rel}`); continue; }
  const dstF = path.join(dest, 'models', rel);
  fs.mkdirSync(path.dirname(dstF), { recursive: true });
  fs.copyFileSync(srcF, dstF);
  const kitDir = path.dirname(rel);
  const tex = path.join(pub, 'models', kitDir, 'Textures', 'colormap.png');
  if (fs.existsSync(tex)) {
    fs.mkdirSync(path.join(dest, 'models', kitDir, 'Textures'), { recursive: true });
    fs.copyFileSync(tex, path.join(dest, 'models', kitDir, 'Textures', 'colormap.png'));
  }
  console.log(`copied: forest model ${rel}`);
}

// hk ビル（Building Generator 書き出し。public/models/hk_GLB format/）があれば同梱＋静的 models manifest
const hkSrc = path.join(pub, 'models', 'hk_GLB format');
const hkFiles = fs.existsSync(hkSrc) ? fs.readdirSync(hkSrc).filter((f) => f.toLowerCase().endsWith('.glb')) : [];
if (hkFiles.length) {
  const hkDest = path.join(dest, 'models', 'hk_GLB format'); fs.mkdirSync(hkDest, { recursive: true });
  for (const f of hkFiles) fs.copyFileSync(path.join(hkSrc, f), path.join(hkDest, f));
  console.log(`copied: ${hkFiles.length} hk buildings`);
}
// city-fly は ../models/manifest.json から hk ビルを検出する（本番用に静的生成。hk のみで十分）
const modelsDest = path.join(dest, 'models'); fs.mkdirSync(modelsDest, { recursive: true });
fs.writeFileSync(path.join(modelsDest, 'manifest.json'), JSON.stringify(hkFiles.map((f) => 'hk_GLB format/' + f)));
console.log('written: models/manifest.json (hk entries)');

// 家具キット（建物内装の生成用）＋進入マーカー
const furnSrc = path.join(pub, 'models', 'kenney_furniture-kit', 'Models', 'GLTF format');
if (!TUT && fs.existsSync(furnSrc)) {   // 建物内装＝街専用（チュートリアルは進入なし）
  const furnDest = path.join(dest, 'models', 'kenney_furniture-kit', 'Models', 'GLTF format');
  fs.mkdirSync(furnDest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(furnSrc).filter((f) => f.endsWith('.glb'))) { fs.copyFileSync(path.join(furnSrc, f), path.join(furnDest, f)); n++; }
  console.log(`copied: ${n} furniture models`);
}
const entriesSrc = path.join(pub, 'models', 'building-entries.json');
if (fs.existsSync(entriesSrc)) { fs.copyFileSync(entriesSrc, path.join(dest, 'models', 'building-entries.json')); console.log('copied: building-entries.json'); }

// 道路グラフ + 静的 manifest（本番は vite ミドルウェアが無いので静的ファイルが必須）
const roadSrc = path.join(pub, 'roads');
const roadDest = path.join(dest, 'roads'); fs.mkdirSync(roadDest, { recursive: true });
const roadFiles = (!TUT && fs.existsSync(roadSrc)) ? fs.readdirSync(roadSrc).filter((f) => f.endsWith('.json') && f !== 'manifest.json') : [];
for (const f of roadFiles) fs.copyFileSync(path.join(roadSrc, f), path.join(roadDest, f));
fs.writeFileSync(path.join(roadDest, 'manifest.json'), JSON.stringify(roadFiles));
console.log(`copied: ${roadFiles.length} road tiles + static manifest.json`);

console.log('\n' + OUT_NAME + '/ ready for deployment（既定マップ: ' + DEFAULT_MAP + (TUT ? ' / チュートリアル専用構成' : '') + '）');
if (MP_BUILD) console.log('マルチプレイ配信:  node scripts/cityfly-server.mjs');
