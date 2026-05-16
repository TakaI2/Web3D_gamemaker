import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  plugins: [
    svelte(),
    basicSsl(),
    // public/vrm/ のVRMファイル一覧を manifest.json として配信
    {
      name: 'vrm-manifest',
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
