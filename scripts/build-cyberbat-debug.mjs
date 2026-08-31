// build-cyberbat-debug.mjs — CyberBat の実機切り分け用ビルド（画面ログつき）。
// 中身は dist-cyberbat と同じだが window.CB_DEBUG=true を注入し、
// 起動の各工程・console・例外・メモリを画面左上のパネルへ出す（スマホでコンソールが見られないため）。
//   npm run build:cyberbat-debug  →  dist-cyberbat-debug/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = 'dist-cyberbat-debug';

process.env.OUT = OUT;
process.env.MAP = process.env.MAP || 'tutorial';
await import('./build-cityfly.mjs');

// index.html へデバッグフラグを注入（既存の DEFAULT_MAP 注入スクリプトの直後に足す）
const idx = path.join(root, OUT, 'index.html');
const html = fs.readFileSync(idx, 'utf8').replace('<script type="module"', '<script>window.CB_DEBUG = true;</script>\n  <script type="module"');
fs.writeFileSync(idx, html);
console.log(`\n${OUT}/ に画面ログ(window.CB_DEBUG)を注入しました`);
