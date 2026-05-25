import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/htdocs/fps/',
  plugins: [
    svelte(),
    {
      name: 'fps-assets',
      closeBundle() {
        // collision-world.glb だけコピー（public/ 全体はコピーしない）
        const glbSrc = path.resolve(__dirname, 'public/models/gltf/collision-world.glb');
        const glbDest = path.resolve(__dirname, 'dist-fps/models/gltf/collision-world.glb');
        fs.mkdirSync(path.dirname(glbDest), { recursive: true });
        fs.copyFileSync(glbSrc, glbDest);

        // fps.html → index.html にリネーム
        const htmlSrc = path.resolve(__dirname, 'dist-fps/fps.html');
        const htmlDest = path.resolve(__dirname, 'dist-fps/index.html');
        if (fs.existsSync(htmlSrc)) {
          fs.renameSync(htmlSrc, htmlDest);
        }
      },
    },
  ],
  publicDir: false,
  build: {
    target: 'es2020' as const,
    outDir: 'dist-fps',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        fps: path.resolve(__dirname, 'fps.html'),
      },
    },
    assetsInlineLimit: 0,
  },
});
