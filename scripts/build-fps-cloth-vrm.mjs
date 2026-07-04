import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'fps-cloth-vrm');
const dest = path.join(root, 'dist-fps-cloth-vrm');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// index.html はそのままコピー
fs.copyFileSync(path.join(src, 'index.html'), path.join(dest, 'index.html'));
console.log('copied: index.html');

// fps-cloth-vrm.js は共有 lib の import を dist 内ローカル参照に書き換えてコピー
const jsSrc = fs.readFileSync(path.join(src, 'fps-cloth-vrm.js'), 'utf8')
  .replace(/\.\.\/lib\/vrm-ragdoll\.js/g, './vrm-ragdoll.js');
fs.writeFileSync(path.join(dest, 'fps-cloth-vrm.js'), jsSrc);
console.log('copied: fps-cloth-vrm.js (import rewritten)');

// 共有ラグドールモジュールを同梱
fs.copyFileSync(path.join(root, 'lib', 'vrm-ragdoll.js'), path.join(dest, 'vrm-ragdoll.js'));
console.log('copied: vrm-ragdoll.js');

// NPC バンドル（起動時に自動ロードする megu.npc.json など）を同梱。
// fetchNPCBundle() が `./npc/...`（モジュール同梱）を候補に含むのでこの配置で解決できる。
const npcSrc  = path.join(root, 'public', 'npc');
const npcDest = path.join(dest, 'npc');
if (fs.existsSync(npcSrc)) {
  fs.mkdirSync(npcDest, { recursive: true });
  for (const f of fs.readdirSync(npcSrc)) {
    if (f.endsWith('.npc.json')) {
      fs.copyFileSync(path.join(npcSrc, f), path.join(npcDest, f));
      console.log(`copied: npc/${f}`);
    }
  }
}

console.log('\ndist-fps-cloth-vrm/ ready for deployment to /htdocs/fps-cloth-vrm/');
