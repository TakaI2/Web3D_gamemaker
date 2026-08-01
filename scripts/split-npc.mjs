// split-npc.mjs — .npc.json に base64 で埋め込まれた VRM/VRMA をバイナリの別ファイルへ切り出す。
//
// 埋め込みは base64 のぶん 1.33倍に膨らみ、さらに巨大な JSON 文字列の JSON.parse と
// atob → Blob 変換が起動時のメインスレッドを塞ぐ。分離すると転送量が減り、
// VRM は fetch → arrayBuffer のまま GLTFLoader に渡せる。
//
//   node scripts/split-npc.mjs                 … public/npc/*.npc.json を全部
//   node scripts/split-npc.mjs JOY_vamp ken    … 名前を指定
//
// 出力（元の .npc.json は消さない＝従来どおり読めるまま）:
//   public/npc/<name>.vrm        VRM 本体
//   public/npc/<name>.vrma       VRMA（あれば）
//   public/npc/<name>.meta.json  vrm/vrma を URL 参照に置き換えた残り（cloth など）

import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = 'public/npc';

function decodeDataURI(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0 || !/^data:/.test(uri)) return null;
  return Buffer.from(uri.slice(comma + 1), 'base64');
}

async function split(name) {
  const src = path.join(DIR, name + '.npc.json');
  const raw = await fs.readFile(src, 'utf8');
  const bundle = JSON.parse(raw);
  const meta = { ...bundle };
  const out = [];

  for (const key of ['vrm', 'vrma']) {
    const v = bundle[key];
    if (typeof v !== 'string' || !v.startsWith('data:')) continue;
    const bin = decodeDataURI(v);
    if (!bin) continue;
    const file = name + '.' + key;
    await fs.writeFile(path.join(DIR, file), bin);
    delete meta[key];
    meta[key + 'Url'] = './' + file;
    out.push(`${file} ${(bin.length / 1048576).toFixed(2)}MB`);
  }
  if (!out.length) { console.log(`${name}: 埋め込みデータなし（スキップ）`); return; }

  const metaJson = JSON.stringify(meta);
  await fs.writeFile(path.join(DIR, name + '.meta.json'), metaJson);
  console.log(`${name}: ${(raw.length / 1048576).toFixed(2)}MB → ${out.join(' + ')} + meta ${(metaJson.length / 1048576).toFixed(2)}MB`);
}

const names = process.argv.slice(2);
if (!names.length) {
  for (const f of await fs.readdir(DIR)) if (f.endsWith('.npc.json')) names.push(f.replace(/\.npc\.json$/, ''));
}
for (const n of names) {
  try { await split(n); } catch (e) { console.error(`${n}: 失敗 — ${e.message}`); }
}
