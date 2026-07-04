import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// モバイル版は PC版と JS を共有し、index.html を派生させる：
//  (1) 仮想ジョイスティック/ジャンプボタンの DOM・CSS を注入（JS はこの DOM が在るときタッチ操作を有効化する）
//  (2) クリック開始オーバレイ（PC の pointer lock 用）を除去
//  (3) NPC 既定数を下げる（モバイル負荷対策。スライダで増やせる）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src  = path.join(root, 'fps-cloth-vrm');
const dest = path.join(root, 'dist-fps-cloth-vrm-mobile');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(path.join(src, 'fps-cloth-vrm.js'), path.join(dest, 'fps-cloth-vrm.js'));
console.log('copied: fps-cloth-vrm.js (shared with PC)');

const TOUCH_CSS = `
    /* ── Touch controls (mobile) ─────────────────────────────── */
    #joystick-base { position: fixed; width: 140px; height: 140px; border-radius: 50%; background: rgba(255,255,255,0.12); border: 2px solid rgba(255,255,255,0.35); pointer-events: none; z-index: 20; display: none; }
    #joystick-stick { position: absolute; top: 50%; left: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgba(255,255,255,0.45); border: 2px solid rgba(255,255,255,0.75); pointer-events: none; }
    #jump-btn { position: fixed; bottom: 48px; right: 100px; width: 72px; height: 72px; border-radius: 50%; background: rgba(255,255,255,0.18); border: 2px solid rgba(255,255,255,0.5); color: #fff; font-size: 30px; display: none; align-items: center; justify-content: center; z-index: 20; user-select: none; -webkit-user-select: none; touch-action: none; cursor: pointer; }
`;
const TOUCH_DOM = `  <div id="joystick-base"><div id="joystick-stick"></div></div>
  <div id="jump-btn">↑</div>
`;

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

const apply = (label, find, replace) => {
  if (typeof find === 'string' ? !html.includes(find) : !find.test(html)) {
    console.warn(`!! 置換失敗（アンカー未検出）: ${label}`);
    return;
  }
  html = html.replace(find, replace);
  console.log(`applied: ${label}`);
};

apply('touch CSS', '</style>', `${TOUCH_CSS}  </style>`);
apply('touch DOM', '<script type="module"', `${TOUCH_DOM}\n  <script type="module"`);
apply('strip lock-overlay', /\s*<div id="lock-overlay">[\s\S]*?<\/div>/, '');
apply('npc default (slider)', 'id="npc-count" min="1" max="10" step="1" value="5"',
                              'id="npc-count" min="1" max="10" step="1" value="3"');
apply('npc default (label)', '<span class="val" id="npc-count-val">5</span>',
                             '<span class="val" id="npc-count-val">3</span>');

fs.writeFileSync(path.join(dest, 'index.html'), html);
console.log('written: index.html (mobile)');

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

console.log('\ndist-fps-cloth-vrm-mobile/ ready for deployment to /htdocs/fps-cloth-vrm-mobile/');
