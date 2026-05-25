import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/htdocs/cloth/',
  publicDir: false,
  plugins: [
    {
      name: 'cloth-static',
      // 開発サーバー: cloth.js をそのまま返す（Viteの変換をバイパス）
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && (req.url.includes('cloth.js') || req.url.endsWith('cloth/') || req.url.endsWith('cloth/index.html'))) {
            const filePath = req.url.endsWith('cloth.js')
              ? path.resolve(__dirname, 'cloth/cloth.js')
              : path.resolve(__dirname, 'cloth/index.html');
            if (fs.existsSync(filePath)) {
              const ext = filePath.endsWith('.js') ? 'application/javascript' : 'text/html';
              res.setHeader('Content-Type', ext + '; charset=utf-8');
              res.end(fs.readFileSync(filePath, 'utf-8'));
              return;
            }
          }
          next();
        });
      },
      // ビルド: cloth/ をそのまま dist-cloth/ にコピー
      closeBundle() {
        const src  = path.resolve(__dirname, 'cloth');
        const dest = path.resolve(__dirname, 'dist-cloth');
        fs.mkdirSync(dest, { recursive: true });
        for (const f of ['index.html', 'cloth.js']) {
          fs.copyFileSync(path.join(src, f), path.join(dest, f));
        }
      },
    },
  ],
  build: {
    target: 'es2020' as const,
    outDir: 'dist-cloth',
    emptyOutDir: true,
    // ビルドはプラグインの closeBundle に任せるので rollupInput は空
    rollupOptions: {
      input: {},
    },
    assetsInlineLimit: 0,
  },
});
