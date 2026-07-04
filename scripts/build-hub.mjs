import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'dist-hub');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(path.join(root, 'hub', 'index.html'), path.join(dest, 'index.html'));
console.log('copied: index.html\ndist-hub/ ready for deployment to /htdocs/hub/');
