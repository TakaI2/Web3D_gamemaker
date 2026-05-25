import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'cloth');
const dest = path.join(root, 'dist-cloth');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const f of ['index.html', 'cloth.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log(`copied: ${f}`);
}

console.log('\ndist-cloth/ ready for deployment to /htdocs/cloth/');
