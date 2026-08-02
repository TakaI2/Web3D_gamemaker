// vamp-dungeon の配布ビルド。ページを g/ サブディレクトリに置くことで
// ソース中の相対パス（../lib/ ../models/ ../npc/ 等）を書き換えずにそのまま使う。
// 使い方: node scripts/build-vamp-dungeon.mjs [version]   例) node scripts/build-vamp-dungeon.mjs v1
import fs from 'fs';
import path from 'path';

const OUT = 'dist-vamp-dungeon';
const VER = process.argv[2] || 'dev';
const rm = (d) => { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); };
const mk = (d) => fs.mkdirSync(d, { recursive: true });
const cp = (src, dst) => { if (fs.existsSync(src)) { mk(path.dirname(dst)); fs.copyFileSync(src, dst); return true; } return false; };
const cpDir = (src, dst, filter) => {
  if (!fs.existsSync(src)) { console.warn('  ! ディレクトリ無し:', src); return; }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d, filter);
    else if (!filter || filter(e.name)) cp(s, d);
  }
};

rm(OUT);
mk(path.join(OUT, 'g'));

// ── 本体（g/ 配下。../xxx が dist ルートを指す）──
fs.writeFileSync(path.join(OUT, 'g', 'vamp-dungeon.js'), fs.readFileSync('vamp-dungeon/vamp-dungeon.js', 'utf8'));
fs.writeFileSync(path.join(OUT, 'g', 'index.html'), fs.readFileSync('vamp-dungeon/index.html', 'utf8')
  .replace('src="./vamp-dungeon.js"', 'src="./vamp-dungeon.js?v=' + VER + '"')
  .replace('href="../hub/"', 'href="#"'));
fs.writeFileSync(path.join(OUT, 'index.html'),
  '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=./g/">');

// ── ライブラリ一式（内部の ./xxx import がそのまま解決する）──
cpDir('lib', path.join(OUT, 'lib'), (n) => n.endsWith('.js'));

// ── モデル（建築＝fantasyキット / 家具＝kenneyキット。部屋生成がキット全域を使うため全コピー）──
cpDir('public/models/fantasy_GLB format', path.join(OUT, 'models', 'fantasy_GLB format'));   // Textures/ 含む
cpDir('public/models/kenney_furniture-kit/Models/GLTF format', path.join(OUT, 'models', 'kenney_furniture-kit', 'Models', 'GLTF format'));
cpDir('public/models/GLB retro_fantasy', path.join(OUT, 'models', 'GLB retro_fantasy'));

// ── NPC（吸血鬼と職員のみ）＋ラグドール ──
for (const f of ['JOY_vamp.npc.json', 'JOY_vamp.vrm', 'JOY_vamp.meta.json', 'ken.npc.json', 'ken.vrm', 'ken.meta.json', 'char-light.json'])
  cp(path.join('public/npc', f), path.join(OUT, 'npc', f));
cp('public/ragdoll/ken.ragdoll.json', path.join(OUT, 'ragdoll', 'ken.ragdoll.json'));

// ── アニメ：敵設定から必要な timeline/vrma を収集＋職員の歩き ──
let enemy = null;
try { enemy = JSON.parse(fs.readFileSync('public/vamp_param/vamp-enemy.json', 'utf8')); } catch { /* 既定 */ }
const anims = new Set(['eri_model_walk.timeline.json', 'eri_Fly_idle.timeline.json']);
if (enemy) for (const st of Object.values(enemy.states || {})) if (st.anim) anims.add(st.anim);
const vrmas = new Set(['Catwalk_Walk_Forward.vrma']);   // 職員の歩き
for (const a of anims) {
  if (a.endsWith('.timeline.json')) {
    if (cp(path.join('public/timeline', a), path.join(OUT, 'timeline', a))) {
      try { const tl = JSON.parse(fs.readFileSync(path.join('public/timeline', a), 'utf8')); if (tl.vrma) vrmas.add(tl.vrma); } catch { /* skip */ }
    } else console.warn('  ! timeline 無し:', a);
  } else if (a.endsWith('.vrma')) vrmas.add(a);
}
for (const v of vrmas) if (!cp(path.join('public/vrma', v), path.join(OUT, 'vrma', v))) console.warn('  ! vrma 無し:', v);

// ── 設定・データ ──
cpDir('public/vamp_param', path.join(OUT, 'vamp_param'), (n) => n.endsWith('.json'));
cpDir('public/speech', path.join(OUT, 'speech'), (n) => n.endsWith('.json'));
cpDir('public/fx', path.join(OUT, 'fx'), (n) => n.endsWith('.json'));
cpDir('public/rooms', path.join(OUT, 'rooms'));   // ユニット（エディタ用・小さい）

// ── 音（audio/sound/bgm はどれも小さいので全コピー）──
cpDir('public/audio', path.join(OUT, 'audio'));
cpDir('public/sound', path.join(OUT, 'sound'));
cpDir('public/bgm', path.join(OUT, 'bgm'));

fs.writeFileSync(path.join(OUT, 'favicon.ico'), Buffer.alloc(4));

const dsize = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? dsize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`dist-vamp-dungeon built (${VER}) — ${(dsize(OUT) / 1048576).toFixed(1)} MB`);
