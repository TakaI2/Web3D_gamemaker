// チュートリアルステージ用の平坦マップを生成（部屋群は city-fly 側で実行時構築）
// 実行: node scripts/gen-tutorial-map.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTerrainData, serializeTerrain } from '../lib/terrain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 3600, RES = 65;

const T = makeTerrainData({ size: SIZE, res: RES, base: 0 });
// games_fps 風のライトグレー床（terrain の頂点色）
for (let i = 0; i < RES * RES; i++) {
  const o = i * 3;
  T.colors[o] = 168; T.colors[o + 1] = 172; T.colors[o + 2] = 178;
}

const out = {
  format: 'city-map',
  version: 1,
  name: 'tutorial',
  terrain: serializeTerrain(T),
  roads: [],
  water: [],
  parks: [],
  rotaries: [],
  buildings: { removed: [], moved: {}, added: [] },
};
const dest = path.join(__dirname, '..', 'public', 'maps', 'tutorial.map.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log('wrote', dest, (fs.statSync(dest).size / 1024).toFixed(1) + 'KB');
