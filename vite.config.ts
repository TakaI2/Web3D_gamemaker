import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** public/ 以下を再帰的にスキャンして特定拡張子のファイルを返す（パスは public/ からの相対） */
function findFilesRecursive(
  dir: string,
  ext: string,
  baseDir: string,
  depth = 0,
  skipDirs: string[] = [],
): string[] {
  if (depth > 3 || !fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(full, ext, baseDir, depth + 1, skipDirs));
    } else if (entry.name.toLowerCase().endsWith(ext)) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

export default defineConfig({
  base: '/htdocs/3d_game/',
  plugins: [
    svelte(),
    basicSsl(),
    // VRM/VRMA/PMX/VMD ファイル一覧を manifest.json として配信・ビルド時に自動生成
    {
      name: 'asset-manifest',
      // 開発サーバー: 動的に返す
      configureServer(server) {
        const pub = path.resolve(__dirname, 'public');

        // basic-ssl の TLS ソケットで、クライアント切断(ECONNRESET)が「未処理 error イベント」となり
        // dev サーバのプロセスごと落ちるのを防ぐ。ソケット単位の error は握りつぶす（接続断は無害）。
        const hs = server.httpServer;
        if (hs) {
          const ignore = (socket: import('net').Socket) => socket.on('error', () => { /* 接続断は無視 */ });
          hs.on('connection', ignore);
          hs.on('secureConnection', ignore as (socket: unknown) => void);
          hs.on('clientError', (_err, socket) => { try { (socket as import('net').Socket).destroy(); } catch { /* noop */ } });
        }

        // VRMA 直接配信: ファイル名に '@' や空白を含む VRMA は vite/sirv が正しく解決できず
        // SPA の index.html(HTML) を返してしまう（GLTFLoader が JSON.parse して "Unexpected token '<'"）。
        // ここでデコードして public/vrma から直接ストリーミングし、確実に配信する。
        server.middlewares.use((req, res, next) => {
          const pathOnly = (req.url || '').split('?')[0];
          const m = pathOnly.match(/\/vrma\/([^/]+\.vrma)$/i);
          if (!m) return next();
          let name = m[1];
          try { name = decodeURIComponent(name); } catch { /* そのまま */ }
          const file = path.join(pub, 'vrma', path.basename(name));
          if (!fs.existsSync(file)) return next();
          res.setHeader('Content-Type', 'model/gltf-binary');
          // 開発中はキャッシュさせない（VRMA を編集・差し替えたら即反映されるように）
          res.setHeader('Cache-Control', 'no-store, max-age=0');
          fs.createReadStream(file).pipe(res);
        });

        // 開発用 保存エンドポイント: エディタ出力を public/<dir>/ に書き込む（dir は npc / timeline のみ許可）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (req.method !== 'POST' || !url.endsWith('/api/save')) return next();
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            try {
              const { dir, filename, content } = JSON.parse(body);
              const allowed: Record<string, string> = { npc: 'npc', timeline: 'timeline', models: 'models', story: 'story', flow: 'flow', speech: 'speech', stage: 'stages', ragdoll: 'ragdoll', fx: 'fx', bitealign: 'bitealign', city: 'cities', room: 'rooms' };
              const sub = allowed[dir];
              const safe = path.basename(String(filename || ''));
              if (!sub || !safe) { res.statusCode = 400; res.end('bad request'); return; }
              const outDir = path.join(pub, sub);
              fs.mkdirSync(outDir, { recursive: true });
              const text = typeof content === 'string' ? content : JSON.stringify(content);
              fs.writeFileSync(path.join(outDir, safe), text);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, path: `public/${sub}/${safe}` }));
            } catch (e) {
              res.statusCode = 500; res.end(String(e));
            }
          });
        });

        // FX プリセット一覧（fx-builder が保存した *.fx.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/fx/manifest.json')) return next();
          const dir = path.join(pub, 'fx');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.fx.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // スプライトシート画像一覧（public/ 直下の画像。FXビルダーのテクスチャ選択用）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/sheets/manifest.json')) return next();
          const files = fs.existsSync(pub)
            ? fs.readdirSync(pub).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 捕食アライン一覧（public/bitealign/*.bite.json。bite-editor が保存）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/bitealign/manifest.json')) return next();
          const dir = path.join(pub, 'bitealign');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bite.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 音声一覧（public/audio/ 直下。タイムラインの発射音等）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/audio/manifest.json')) return next();
          const dir = path.join(pub, 'audio');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f)) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // NPC バンドル一覧（base に依らずパス末尾で判定）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/npc/manifest.json')) return next();
          const dir = path.join(pub, 'npc');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.npc.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // ストーリー一覧（public/story/*.story.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/story/manifest.json')) return next();
          const dir = path.join(pub, 'story');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.story.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // ゲームフロー一覧（public/flow/*.flow.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/flow/manifest.json')) return next();
          const dir = path.join(pub, 'flow');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.flow.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 反応セリフ一覧（public/speech/*.speech.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/speech/manifest.json')) return next();
          const dir = path.join(pub, 'speech');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.speech.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // ステージ一覧（public/stages/*.stage.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/stages/manifest.json')) return next();
          const dir = path.join(pub, 'stages');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.stage.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 都市一覧（public/cities/*.city.json。stage-editor の都市モードが保存）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/cities/manifest.json')) return next();
          const dir = path.join(pub, 'cities');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.city.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 部屋一覧（public/rooms/*.room.json。room-editor が保存）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/rooms/manifest.json')) return next();
          const dir = path.join(pub, 'rooms');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.room.json') || f.endsWith('.unit.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // 道路グラフ一覧（public/roads/*.json。参照プロジェクトのOSM道路。plateau-fly の車走行用）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/roads/manifest.json')) return next();
          const dir = path.join(pub, 'roads');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json') : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // マント一覧（public/cloth/*.cloth.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/cloth/manifest.json')) return next();
          const dir = path.join(pub, 'cloth');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.cloth.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // ラグドール設定一覧（public/ragdoll/*.ragdoll.json）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/ragdoll/manifest.json')) return next();
          const dir = path.join(pub, 'ragdoll');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ragdoll.json')) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // モデル(GLB)一覧（public/models/ 以下を再帰スキャン、相対パスで返す）
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.endsWith('/models/manifest.json')) return next();
          const dir = path.join(pub, 'models');
          const all = findFilesRecursive(dir, '.glb', dir, 0, ['node_modules', '.git', 'gltf']);
          // 自前 colormap を持つキットのみ採用: トップ階層「*_GLB format」＋ Kenney の入れ子「*/Models/GLB format」。
          // （無印 GLB format / kenney_car-kit 等の重複・無テクスチャを除外。都市エディタが road/suburban キットを使う）
          const kits = all.filter((f) => f.split('/')[0].endsWith('_GLB format') || f.includes('/Models/GLB format/') || f.includes('/Models/GLTF format/'));
          const files = kits.length ? kits : all;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        // タイムライン一覧: 既定は VRMA モーション(.vrma)。?ext=timeline.json で TL(JSON) を返す
        server.middlewares.use((req, res, next) => {
          const [urlPath, query] = (req.url || '').split('?');
          if (!urlPath.endsWith('/timeline/manifest.json')) return next();
          const ext = new URLSearchParams(query || '').get('ext') === 'timeline.json' ? '.timeline.json' : '.vrma';
          const dir = path.join(pub, 'timeline');
          const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });

        server.middlewares.use('/vrm/manifest.json', (_req, res) => {
          const dir = path.join(pub, 'vrm');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith('.vrm'))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        server.middlewares.use('/vrma/manifest.json', (_req, res) => {
          const dir = path.join(pub, 'vrma');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.endsWith('.vrma'))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        // PMX: public/ 以下を再帰スキャン（vrm/vrma/vmd は除外）
        server.middlewares.use('/pmx/manifest.json', (_req, res) => {
          const files = findFilesRecursive(pub, '.pmx', pub, 0, ['vrm', 'vrma', 'vmd', 'node_modules', '.git']);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        // VMD: public/ 以下を再帰スキャン（vrm/vrma は除外）
        server.middlewares.use('/vmd/manifest.json', (_req, res) => {
          const files = findFilesRecursive(pub, '.vmd', pub, 0, ['vrm', 'vrma', 'node_modules', '.git']);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        // FBX: public/fbx/ 以下をフラットスキャン
        server.middlewares.use('/fbx/manifest.json', (_req, res) => {
          const dir = path.join(pub, 'fbx');
          const files = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fbx'))
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        });
        // Unicodeパスを含む静的ファイルをViteのデフォルトサーバーが配信できない場合のフォールバック
        // PMX/VMD/テクスチャ類を直接 fs.createReadStream で配信する
        const STATIC_EXTS = new Set([
          '.vrm', '.vrma',
          '.pmx', '.pmd', '.vmd', '.vpd',
          '.fbx',
          '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.spa', '.sph',
        ]);
        server.middlewares.use((req, res, next) => {
          if (!req.url) return next();
          const urlPath = decodeURIComponent(req.url.split('?')[0]);
          const ext = path.extname(urlPath).toLowerCase();
          if (!STATIC_EXTS.has(ext)) return next();
          const filePath = path.join(pub, urlPath);
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Access-Control-Allow-Origin', '*');
          fs.createReadStream(filePath).pipe(res as import('stream').Writable);
        });
      },
      // ビルド時: public/ の実ファイルを元に manifest.json を上書き生成
      closeBundle() {
        const pub = path.resolve(__dirname, 'public');
        const outDir = path.resolve(__dirname, 'dist');
        // VRM / VRMA (フラット)
        for (const { folder, ext } of [
          { folder: 'vrm', ext: '.vrm' },
          { folder: 'vrma', ext: '.vrma' },
        ]) {
          const srcDir = path.join(pub, folder);
          const files = fs.existsSync(srcDir)
            ? fs.readdirSync(srcDir).filter((f) => f.endsWith(ext))
            : [];
          const destDir = path.join(outDir, folder);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(files));
        }
        // PMX (再帰スキャン)
        const pmxFiles = findFilesRecursive(pub, '.pmx', pub, 0, ['vrm', 'vrma', 'vmd', 'node_modules', '.git']);
        const pmxDir = path.join(outDir, 'pmx');
        if (!fs.existsSync(pmxDir)) fs.mkdirSync(pmxDir, { recursive: true });
        fs.writeFileSync(path.join(pmxDir, 'manifest.json'), JSON.stringify(pmxFiles));
        // VMD (再帰スキャン)
        const vmdFiles = findFilesRecursive(pub, '.vmd', pub, 0, ['vrm', 'vrma', 'node_modules', '.git']);
        const vmdDir = path.join(outDir, 'vmd');
        if (!fs.existsSync(vmdDir)) fs.mkdirSync(vmdDir, { recursive: true });
        fs.writeFileSync(path.join(vmdDir, 'manifest.json'), JSON.stringify(vmdFiles));
        // FBX (フラット)
        const fbxSrcDir = path.join(pub, 'fbx');
        const fbxFiles = fs.existsSync(fbxSrcDir)
          ? fs.readdirSync(fbxSrcDir).filter((f) => f.toLowerCase().endsWith('.fbx'))
          : [];
        const fbxManDir = path.join(outDir, 'fbx');
        if (!fs.existsSync(fbxManDir)) fs.mkdirSync(fbxManDir, { recursive: true });
        fs.writeFileSync(path.join(fbxManDir, 'manifest.json'), JSON.stringify(fbxFiles));
      },
    },
  ],
  build: {
    target: 'es2020' as const,
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
