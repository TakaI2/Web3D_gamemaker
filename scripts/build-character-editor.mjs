import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'character-editor');
const dest = path.join(root, 'dist-character-editor');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(path.join(src, 'index.html'), path.join(dest, 'index.html'));
console.log('copied: index.html');

// 本体 js：共有 lib の import を dist 内ローカル参照へ書き換え
const js = fs.readFileSync(path.join(src, 'character-editor.js'), 'utf8').replace(/\.\.\/lib\//g, './');
fs.writeFileSync(path.join(dest, 'character-editor.js'), js);
console.log('copied: character-editor.js (import rewritten)');

// 共有モジュール（相互 import も ./ へ）
for (const f of ['vrm-ragdoll.js', 'vrm-cloth.js', 'npc-state-machine.js']) {
  const libSrc = fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/\.\.\/lib\//g, './');
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// NPC バンドル同梱
const npcSrc = path.join(root, 'public', 'npc');
if (fs.existsSync(npcSrc)) {
  const npcDest = path.join(dest, 'npc');
  fs.mkdirSync(npcDest, { recursive: true });
  for (const f of fs.readdirSync(npcSrc)) {
    if (f.endsWith('.npc.json')) { fs.copyFileSync(path.join(npcSrc, f), path.join(npcDest, f)); console.log(`copied: npc/${f}`); }
  }
}

console.log('\ndist-character-editor/ ready for deployment to /htdocs/character-editor/');
