import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'stage-editor');
const dest = path.join(root, 'dist-stage-editor');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['index.html', 'stage-editor.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log(`copied: ${f}`);
}
console.log('\ndist-stage-editor/ ready for deployment to /htdocs/stage-editor/');
