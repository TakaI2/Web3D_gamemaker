import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyUsedModels } from './_copy-used-models.mjs';

// モバイル版は PC版と JS を共有し、index.html を派生：
//  (1) 仮想ジョイスティック/ジャンプボタンの DOM・CSS を注入（JS は #joystick-base がある時タッチ操作を有効化）
//  (2) スライダーパネル(#ui)とクリック開始オーバレイ(#lock-overlay)を CSS で非表示
// 操作: 左半分=移動 / 右半分=ドラッグで視点・短タップで発射・長押しでグラブ→離すと投擲

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'swing-catch');
const dest = path.join(root, 'dist-swing-catch-mobile');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// JS（PC版と共有。lib/models のパスを dist 内ローカルへ）
const jsSrc = fs.readFileSync(path.join(src, 'swing-catch.js'), 'utf8')
  .replace(/\.\.\/lib\//g, './')
  .replace(/\.\.\/models\//g, './models/');
fs.writeFileSync(path.join(dest, 'swing-catch.js'), jsSrc);
console.log('copied: swing-catch.js (shared, paths rewritten)');

// index.html を派生
const TOUCH_CSS = `
    #ui { display: none !important; }              /* モバイル: 調整パネル非表示 */
    #lock-overlay { display: none !important; }     /* モバイル: オーバレイ非表示 */
    #joystick-base { position: fixed; width: 140px; height: 140px; border-radius: 50%; background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.35); pointer-events: none; z-index: 20; display: none; }
    #joystick-stick { position: absolute; top: 50%; left: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgba(255,255,255,0.45); border: 2px solid rgba(255,255,255,0.75); pointer-events: none; }
    #jump-btn { position: fixed; bottom: 48px; right: 36px; width: 76px; height: 76px; border-radius: 50%; background: rgba(255,255,255,0.18); border: 2px solid rgba(255,255,255,0.5); color: #fff; font-size: 30px; display: none; align-items: center; justify-content: center; z-index: 20; user-select: none; -webkit-user-select: none; touch-action: none; }
`;
const TOUCH_DOM = `  <div id="joystick-base"><div id="joystick-stick"></div></div>
  <div id="jump-btn">↑</div>
`;

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
if (!html.includes('</style>') || !html.includes('<script type="module"')) {
  throw new Error('index.html のアンカーが見つかりません');
}
html = html.replace('</style>', `${TOUCH_CSS}  </style>`);
html = html.replace('<script type="module"', `${TOUCH_DOM}\n  <script type="module"`);
fs.writeFileSync(path.join(dest, 'index.html'), html);
console.log('written: index.html (mobile, touch DOM injected)');

// 共有モジュール
for (const f of ['vrm-ragdoll.js', 'vrm-cloth.js', 'npc-state-machine.js']) {
  const libSrc = fs.readFileSync(path.join(root, 'lib', f), 'utf8').replace(/\.\.\/lib\//g, './');
  fs.writeFileSync(path.join(dest, f), libSrc);
  console.log(`copied: ${f}`);
}

// NPC バンドル
const npcSrc = path.join(root, 'public', 'npc');
if (fs.existsSync(npcSrc)) {
  const npcDest = path.join(dest, 'npc');
  fs.mkdirSync(npcDest, { recursive: true });
  for (const f of fs.readdirSync(npcSrc)) {
    if (f.endsWith('.npc.json')) { fs.copyFileSync(path.join(npcSrc, f), path.join(npcDest, f)); console.log(`copied: npc/${f}`); }
  }
}

// 実際に使う GLB＋必要な colormap だけ同梱
copyUsedModels(root, dest);

console.log('\ndist-swing-catch-mobile/ ready for deployment to /htdocs/swing-catch-mobile/');
