import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'swing-catch');
const dest = path.join(root, 'dist-swing-catch');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// index.html はそのままコピー
fs.copyFileSync(path.join(src, 'index.html'), path.join(dest, 'index.html'));
console.log('copied: index.html');

// swing-catch.js は共有 lib の import を dist 内ローカル参照に書き換えてコピー
const jsSrc = fs.readFileSync(path.join(src, 'swing-catch.js'), 'utf8')
  .replace(/\.\.\/lib\//g, './');
fs.writeFileSync(path.join(dest, 'swing-catch.js'), jsSrc);
console.log('copied: swing-catch.js (import rewritten)');

// 共有モジュールを同梱（lib 内の相互 import も ./ に書き換え）
for (const f of ['vrm-ragdoll.js', 'vrm-cloth.js']) {
  const libSrc = fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/\.\.\/lib\//g, './');
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// Megu バンドル（.npc.json）を同梱（loadMegu の ./npc/ 候補で解決）
const npcSrc = path.join(root, 'public', 'npc');
if (fs.existsSync(npcSrc)) {
  const npcDest = path.join(dest, 'npc');
  fs.mkdirSync(npcDest, { recursive: true });
  for (const f of fs.readdirSync(npcSrc)) {
    if (f.endsWith('.npc.json')) {
      fs.copyFileSync(path.join(npcSrc, f), path.join(npcDest, f));
      console.log(`copied: npc/${f}`);
    }
  }
}

console.log('\ndist-swing-catch/ ready for deployment to /htdocs/swing-catch/');
