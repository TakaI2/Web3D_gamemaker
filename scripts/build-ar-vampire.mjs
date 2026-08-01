// ar-vampire の配布ビルド。public/vamp_param/vamp-enemy.json を読み、各ステートで使うアニメ
// (timeline.json→参照vrma) / 効果音 / BGM を動的に収集して dist-ar-vampire に同梱する。
// 使い方: node scripts/build-ar-vampire.mjs [version]   例) node scripts/build-ar-vampire.mjs v13
import fs from 'fs';
import path from 'path';

const OUT = 'dist-ar-vampire';
const VER = process.argv[2] || 'dev';
const rm = (d) => { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); };
const mk = (d) => fs.mkdirSync(d, { recursive: true });
const cp = (src, dst) => { if (fs.existsSync(src)) { mk(path.dirname(dst)); fs.copyFileSync(src, dst); return true; } return false; };

rm(OUT);
for (const d of ['', 'vrma', 'audio', 'BGM', 'timeline']) mk(path.join(OUT, d));

// ライブラリ / スクリプト / HTML（相対import と ?v= を dist 用に書換）
for (const f of ['vrm-cloth-cpu.js', 'vamp-portal.js', 'vrm-ik.js']) cp(path.join('lib', f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, 'ar-vampire.js'), fs.readFileSync('ar-vampire/ar-vampire.js', 'utf8')
  .replace('../lib/vrm-cloth-cpu.js', './vrm-cloth-cpu.js?v=' + VER)
  .replace('../lib/vamp-portal.js', './vamp-portal.js?v=' + VER)
  .replace('../lib/vrm-ik.js', './vrm-ik.js?v=' + VER));
fs.writeFileSync(path.join(OUT, 'index.html'), fs.readFileSync('ar-vampire/index.html', 'utf8')
  .replace('src="./ar-vampire.js"', 'src="./ar-vampire.js?v=' + VER + '"')
  .replace('href="../hub/"', 'href="#"'));

// データ / 設定
cp('public/npc/JOY_vamp.npc.json', path.join(OUT, 'JOY_vamp.npc.json'));
cp('public/npc/char-light.json', path.join(OUT, 'char-light.json'));
cp('public/vamp_param/vamp-tune.json', path.join(OUT, 'vamp-tune.json'));
cp('public/vamp_param/vamp-enemy.json', path.join(OUT, 'vamp-enemy.json'));

// enemy 設定から必要アセットを収集（既定分も必ず含めて部分設定でも動くように）
let enemy = null;
try { enemy = JSON.parse(fs.readFileSync('public/vamp_param/vamp-enemy.json', 'utf8')); } catch { /* 既定のみ */ }
const anims = new Set(['eri_model_walk.timeline.json', 'eri_Fly_idle.timeline.json']);
const sfx = new Set(['fat02.ogg']);
let bgm = 'se1.ogg';
if (enemy) {
  for (const s of Object.values(enemy.states || {})) { if (s.anim) anims.add(s.anim); if (s.sfx) sfx.add(s.sfx); }
  if (enemy.bgm) bgm = enemy.bgm;
}
// anim（timeline.json→参照vrmaも／.vrmaはそのまま）
const vrmas = new Set();
for (const a of anims) {
  if (a.endsWith('.timeline.json')) {
    if (cp(path.join('public/timeline', a), path.join(OUT, 'timeline', a))) {
      try { const tl = JSON.parse(fs.readFileSync(path.join('public/timeline', a), 'utf8')); if (tl.vrma) vrmas.add(tl.vrma); } catch { /* skip */ }
    } else console.warn('  ! timeline 無し:', a);
  } else if (a.endsWith('.vrma')) vrmas.add(a);
}
for (const v of vrmas) { if (!cp(path.join('public/vrma', v), path.join(OUT, 'vrma', v))) console.warn('  ! vrma 無し:', v); }
// 効果音（.ogg と、あれば .m4a フォールバック）
for (const s of sfx) { if (!cp(path.join('public/audio', s), path.join(OUT, 'audio', s))) console.warn('  ! sfx 無し:', s); cp(path.join('public/audio', s.replace(/\.ogg$/, '.m4a')), path.join(OUT, 'audio', s.replace(/\.ogg$/, '.m4a'))); }
// BGM
cp(path.join('public/BGM', bgm), path.join(OUT, 'BGM', bgm));
cp(path.join('public/BGM', bgm.replace(/\.ogg$/, '.m4a')), path.join(OUT, 'BGM', bgm.replace(/\.ogg$/, '.m4a')));
fs.writeFileSync(path.join(OUT, 'favicon.ico'), Buffer.alloc(4));

const dsize = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? dsize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`dist-ar-vampire built (${VER}) — ${(dsize(OUT) / 1048576).toFixed(1)} MB`);
console.log('anims :', [...anims].join(', '));
console.log('vrma  :', [...vrmas].join(', '));
console.log('sfx   :', [...sfx].join(', '), '| bgm:', bgm);
