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

// 共有 lib（vrm-cloth は CDN 依存のみ。kenney-buildings は純関数。念のため ../lib/ を ./ へ）
for (const f of ['vrm-cloth.js', 'kenney-buildings.js']) {
  const libSrc = fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/\.\.\/lib\//g, './');
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// Joy_reborn バンドル（VRM＋マント埋め込み・約27MB）
const npcDest = path.join(dest, 'npc');
fs.mkdirSync(npcDest, { recursive: true });
fs.copyFileSync(path.join(pub, 'npc', 'Joy_reborn.npc.json'), path.join(npcDest, 'Joy_reborn.npc.json'));
console.log('copied: npc/Joy_reborn.npc.json');

// 飛行アニメの timeline + それが参照する vrma
const timelines = ['Joy_reborn_Fly_idle', 'Joy_reborn_Fly_f', 'Joy_reborn_front_down', 'Joy_reborn_Fly_back', 'Joy_reborn_Fly_L', 'Joy_reborn_Fly_R'];
const tlDest = path.join(dest, 'timeline'); fs.mkdirSync(tlDest, { recursive: true });
const vrmaDest = path.join(dest, 'vrma'); fs.mkdirSync(vrmaDest, { recursive: true });
const vrmaSet = new Set();
for (const t of timelines) {
  const file = path.join(pub, 'timeline', t + '.timeline.json');
  fs.copyFileSync(file, path.join(tlDest, t + '.timeline.json'));
  const v = JSON.parse(fs.readFileSync(file)).vrma;
  if (v) vrmaSet.add(v);
  console.log(`copied: timeline/${t}.timeline.json`);
}
for (const v of vrmaSet) {
  fs.copyFileSync(path.join(pub, 'vrma', v), path.join(vrmaDest, v));
  console.log(`copied: vrma/${v}`);
}

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
