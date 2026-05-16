import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  base: '/htdocs/3d_game/',
  plugins: [
    svelte(),
    basicSsl(),
    // VRM/VRMA ファイル一覧を manifest.json として配信・ビルド時に自動生成
    {
      name: 'vrm-manifest',
      // 開発サーバー: 動的に返す
      configureServer(server) {
        server.middlewares.use('/vrm/manifest.json', (_req, res) => {
          const dir = path.resolve(__dirname, 'public/vrm');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith('.vrm'))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        server.middlewares.use('/vrma/manifest.json', (_req, res) => {
          const dir = path.resolve(__dirname, 'public/vrma');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith('.vrma'))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
      },
      // ビルド時: public/ の実ファイルを元に manifest.json を上書き生成
      closeBundle() {
        const outDir = path.resolve(__dirname, 'dist');
        for (const { folder, ext } of [
          { folder: 'vrm', ext: '.vrm' },
          { folder: 'vrma', ext: '.vrma' },
        ]) {
          const srcDir = path.resolve(__dirname, `public/${folder}`);
          const files = fs.existsSync(srcDir)
            ? fs.readdirSync(srcDir).filter((f) => f.endsWith(ext))
            : [];
          const destDir = path.join(outDir, folder);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(
            path.join(destDir, 'manifest.json'),
            JSON.stringify(files),
          );
        }
      },
    },
  ],
  build: {
    target: 'es2020' as const,
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          vrm: ['@pixiv/three-vrm', '@pixiv/three-vrm-animation'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
