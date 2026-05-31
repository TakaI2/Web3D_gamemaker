import fs from 'fs';
import path from 'path';

// selection.json(飛行体) と stage.json(置物) で実際に使う GLB だけを dist/models へコピーする。
// 各 GLB はキットフォルダ相対の Textures/colormap.png を参照するため、使用キットの colormap も同梱する。
export function copyUsedModels(root, dest) {
  const modelsSrc = path.join(root, 'public', 'models');
  const modelsDest = path.join(dest, 'models');
  if (!fs.existsSync(modelsSrc)) { console.warn('public/models が無いためモデル同梱をスキップ'); return; }

  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(modelsSrc, f), 'utf8')); } catch { return null; } };
  const used = new Set();
  const sel = readJson('selection.json');
  if (sel && Array.isArray(sel.models)) for (const m of sel.models) used.add(m);
  const stage = readJson('stage.json');
  if (stage && Array.isArray(stage.items)) for (const it of stage.items) if (it.model) used.add(it.model);

  fs.mkdirSync(modelsDest, { recursive: true });

  const kitDirs = new Set();
  for (const rel of used) {
    const srcFile = path.join(modelsSrc, rel);
    if (!fs.existsSync(srcFile)) { console.warn('使用モデルが見つかりません:', rel); continue; }
    const destFile = path.join(modelsDest, rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    kitDirs.add(rel.split('/').slice(0, -1).join('/'));   // GLB のあるフォルダ（キット）
  }

  // 使用キットの colormap（Textures/colormap.png）だけ同梱
  let texCount = 0;
  for (const kit of kitDirs) {
    const texSrc = path.join(modelsSrc, kit, 'Textures', 'colormap.png');
    if (fs.existsSync(texSrc)) {
      const texDest = path.join(modelsDest, kit, 'Textures', 'colormap.png');
      fs.mkdirSync(path.dirname(texDest), { recursive: true });
      fs.copyFileSync(texSrc, texDest);
      texCount++;
    }
  }

  // selection.json / stage.json 本体（ゲームが読む）
  for (const f of ['selection.json', 'stage.json']) {
    const s = path.join(modelsSrc, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(modelsDest, f));
  }

  console.log(`copied: models/ (使用GLB ${used.size}個 + colormap ${texCount}枚 のみ)`);
}
