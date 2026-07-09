import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// plateau-fly を自己完結の dist-plateau-fly/ に書き出す（/htdocs/plateau-fly/ へ配置）。
// three / three-vrm / 3d-tiles-renderer / DRACO・KTX2 デコーダは全て CDN（esm.sh / jsdelivr）から
// 実行時取得するため同梱不要。ローカル参照（lib / npc / timeline / vrma / roads / models）だけを
// dist 内へコピーし、相対パスを ./ 起点へ書き換える。
// PLATEAU(reearth) と 地理院タイル(GSI) はリモート配信なのでネット接続が必要。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'plateau-fly');
const dest = path.join(root, 'dist-plateau-fly');
const pub  = path.join(root, 'public');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// index.html はそのままコピー
fs.copyFileSync(path.join(src, 'index.html'), path.join(dest, 'index.html'));
console.log('copied: index.html');

// plateau-fly.js: ローカル相対参照を dist 内ローカル（./）へ書き換え
const jsSrc = fs.readFileSync(path.join(src, 'plateau-fly.js'), 'utf8')
  .replace(/\.\.\/lib\//g, './')
  .replace(/\.\.\/models\//g, './models/')
  .replace(/\.\.\/npc\//g, './npc/')
  .replace(/\.\.\/timeline\//g, './timeline/')
  .replace(/\.\.\/vrma\//g, './vrma/')
  .replace(/\.\.\/roads\//g, './roads/');
fs.writeFileSync(path.join(dest, 'plateau-fly.js'), jsSrc);
console.log('copied: plateau-fly.js (paths rewritten)');

// 共有 lib（すべて CDN 依存のみ。念のため ../lib/ を ./ へ）
for (const f of ['vrm-cloth.js', 'kenney-buildings.js', 'fx-mesh.js', 'fx-beam.js', 'fx-tornado.js', 'fx-particles.js', 'fx-textures.js', 'fx-dissolve.js', 'vrm-ragdoll.js']) {
  const libSrc = fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/\.\.\/lib\//g, './');
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// NPCバンドル（Joy=プレイヤー / ken=地上NPC・捕食対象）
const npcDest = path.join(dest, 'npc');
fs.mkdirSync(npcDest, { recursive: true });
for (const n of ['Joy_reborn.npc.json', 'ken.npc.json']) {
  fs.copyFileSync(path.join(pub, 'npc', n), path.join(npcDest, n));
  console.log(`copied: npc/${n}`);
}

// timeline（飛行＋攻撃＋トーテム）+ それが参照する vrma
const timelines = [
  'Joy_reborn_Fly_idle', 'Joy_reborn_Fly_f', 'Joy_reborn_front_down', 'Joy_reborn_Fly_back', 'Joy_reborn_Fly_L', 'Joy_reborn_Fly_R',
  'Joy_reborn_Fly_f2', 'Joy_reborn_capcher1', 'Joy_reborn_throw', 'Joy_reborn_cas1_L1', 'Joy_reborn_large_shot_load', 'Joy_reborn_large_beam', 'Joy_reborn_lightning', 'Joy_reborn_totem',
];
const tlDest = path.join(dest, 'timeline'); fs.mkdirSync(tlDest, { recursive: true });
const vrmaDest = path.join(dest, 'vrma'); fs.mkdirSync(vrmaDest, { recursive: true });
const vrmaSet = new Set(['Catwalk_Walk_Forward.vrma']);   // ken 歩行
// timeline/fx が参照する public 直下のテクスチャpng（例 ../electric.png）を集めて同梱し、パスを ./ へ書き換え
const texPngs = new Set();
const rewriteTexPaths = (text) => text.replace(/\.\.\/([\w\-. %@]+\.png)/g, (_, name) => { texPngs.add(name); return './' + name; });
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
// ラグドール調整値（ken）
const ragSrc = path.join(pub, 'ragdoll', 'ken.ragdoll.json');
if (fs.existsSync(ragSrc)) {
  const rDest = path.join(dest, 'ragdoll'); fs.mkdirSync(rDest, { recursive: true });
  fs.copyFileSync(ragSrc, path.join(rDest, 'ken.ragdoll.json'));
  console.log('copied: ragdoll/ken.ragdoll.json');
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
// 参照テクスチャpng を dist 直下へ
for (const name of texPngs) {
  const src = path.join(pub, name);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, name)); console.log(`copied: ${name}`); }
  else console.warn(`skip missing texture: ${name}`);
}
// 追加 lib（fx-mesh/fx-tornado/fx-particles/fx-dissolve/vrm-ragdoll）

// 車モデル（CAR_KIT）＋ 共有 colormap テクスチャ
const CAR_KIT = ['sedan', 'sedan-sports', 'suv', 'suv-luxury', 'taxi', 'police', 'van', 'delivery', 'truck', 'hatchback-sports'];
const carSrc = path.join(pub, 'models', 'car_GLB format');
const carDest = path.join(dest, 'models', 'car_GLB format');
fs.mkdirSync(path.join(carDest, 'Textures'), { recursive: true });
for (const c of CAR_KIT) fs.copyFileSync(path.join(carSrc, c + '.glb'), path.join(carDest, c + '.glb'));
fs.copyFileSync(path.join(carSrc, 'Textures', 'colormap.png'), path.join(carDest, 'Textures', 'colormap.png'));
console.log(`copied: ${CAR_KIT.length} car models + colormap.png`);

// Kenney 建物キット（KENNEY_CITY モード用）＋ 各キットの colormap
const letters = (a, z) => Array.from({ length: z.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i));
const BLD = [
  { dir: 'city_GLB format', models: [...letters('a', 'n').map((c) => 'building-' + c), ...letters('a', 'e').map((c) => 'building-skyscraper-' + c)] },
  { dir: 'kenney_city-kit-suburban_20/Models/GLB format', models: letters('a', 'u').map((c) => 'building-type-' + c) },
];
for (const kit of BLD) {
  const s = path.join(pub, 'models', kit.dir);
  const d = path.join(dest, 'models', kit.dir);
  fs.mkdirSync(path.join(d, 'Textures'), { recursive: true });
  for (const m of kit.models) fs.copyFileSync(path.join(s, m + '.glb'), path.join(d, m + '.glb'));
  fs.copyFileSync(path.join(s, 'Textures', 'colormap.png'), path.join(d, 'Textures', 'colormap.png'));
  console.log(`copied: ${kit.models.length} building models from ${kit.dir}`);
}

// 道路グラフ + 静的 manifest（本番は vite ミドルウェアが無いので静的ファイルが必須）
const roadSrc = path.join(pub, 'roads');
const roadDest = path.join(dest, 'roads'); fs.mkdirSync(roadDest, { recursive: true });
const roadFiles = fs.existsSync(roadSrc) ? fs.readdirSync(roadSrc).filter((f) => f.endsWith('.json') && f !== 'manifest.json') : [];
for (const f of roadFiles) fs.copyFileSync(path.join(roadSrc, f), path.join(roadDest, f));
fs.writeFileSync(path.join(roadDest, 'manifest.json'), JSON.stringify(roadFiles));
console.log(`copied: ${roadFiles.length} road tiles + static manifest.json`);

console.log('\ndist-plateau-fly/ ready for deployment to /htdocs/plateau-fly/');
