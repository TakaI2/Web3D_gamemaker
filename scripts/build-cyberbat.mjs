// build-cyberbat.mjs — CyberBat の配信ビルド（チュートリアル専用構成）。
// 実体は build-cityfly.mjs。出力先と既定マップだけ固定して呼び出す。
//   npm run build:cyberbat  →  dist-cyberbat/（maps は tutorial のみ同梱）
process.env.OUT = process.env.OUT || 'dist-cyberbat';
process.env.MAP = process.env.MAP || 'tutorial';
await import('./build-cityfly.mjs');
