// build-cyberbat.mjs — CyberBat の配信ビルド（EP0=チュートリアル専用構成）。
// 実体は build-cityfly.mjs。出力先と既定エピソードだけ固定して呼び出す。
//   npm run build:cyberbat  →  dist-cyberbat/（maps は tutorial のみ同梱）
// EP1(floz)を出したいときは:  EP=ep1 OUT=dist-floz npm run build:cityfly
process.env.OUT = process.env.OUT || 'dist-cyberbat';
process.env.EP = process.env.EP || 'ep0';   // 既定マップ・会話・フローは ep0.ep.json から導出される
await import('./build-cityfly.mjs');
