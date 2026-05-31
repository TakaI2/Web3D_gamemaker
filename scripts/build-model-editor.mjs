import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'model-editor');
const dest = path.join(root, 'dist-model-editor');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['index.html', 'model-editor.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log(`copied: ${f}`);
}
console.log('\ndist-model-editor/ ready for deployment to /htdocs/model-editor/');
