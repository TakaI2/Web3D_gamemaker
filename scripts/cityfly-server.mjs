// cityfly-server.mjs — CityFly本番(dist-cityfly)の静的配信＋マルチプレイWSリレーを兼ねる単体サーバ。
// 使い方:  node scripts/cityfly-server.mjs   （PORT=8788 環境変数で変更可）
//   ホストPC:  http://localhost:8788/?mp=1&name=ホスト
//   他のPC :  http://<ホストのIP>:8788/?mp=1&name=名前   （同一LAN。ファイアウォールでポート許可）
// リレーは vite.config.ts 開発用と同一プロトコル（/cityfly-mp）。
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', process.env.DIST || 'dist-cityfly-mp');   // MP専用ビルドを配信（DIST=で変更可）
const PORT = Number(process.env.PORT) || 8788;
const MP_MAX = Number(process.env.MP_MAX) || 5;   // ルームごとの参加人数上限

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(path.basename(DIST) + ' が見つかりません。先に  MP=1 node scripts/build-plateau-fly.mjs  を実行してください。');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.vrm': 'application/octet-stream',
  '.vrma': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/cityfly-mp-status') {   // 参加前の人数確認（ルームごと）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ max: MP_MAX, rooms: [...rooms.entries()].map(([name, m]) => ({ name, players: m.size })) }));
      return;
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(DIST, urlPath));
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }   // パストラバーサル防止
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message || e));
  }
});

// ── マルチプレイ中継（ルーム制: ?room=名前 ごとに独立した戦場・独立した人数上限）──
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();   // roomName -> Map<ws, { id, name, state }>
let nextId = 1;
const roomNameOf = (req) => {
  try { return (new URL(req.url, 'http://x').searchParams.get('room') || 'lobby').trim().slice(0, 24) || 'lobby'; }
  catch { return 'lobby'; }
};
wss.on('connection', (sock, req) => {
  const roomName = roomNameOf(req);
  let room = rooms.get(roomName);
  if (!room) rooms.set(roomName, room = new Map());
  if (room.size >= MP_MAX) {   // このルームは満員
    sock.send(JSON.stringify({ t: 'full', max: MP_MAX }));
    sock.close();
    console.log(`[mp] ルーム「${roomName}」満員のため接続拒否（${MP_MAX}人上限）`);
    return;
  }
  const roomcast = (obj, except) => {
    const str = JSON.stringify(obj);
    for (const c of room.keys()) if (c !== except && c.readyState === WebSocket.OPEN) c.send(str);
  };
  const rec = { id: nextId++, name: 'P' + nextId, state: null };
  room.set(sock, rec);
  sock.send(JSON.stringify({
    t: 'welcome', id: rec.id,
    players: [...room.values()].filter((p) => p.id !== rec.id).map((p) => ({ id: p.id, name: p.name, state: p.state })),
  }));
  roomcast({ t: 'join', id: rec.id, name: rec.name }, sock);
  console.log(`[mp] 参加 #${rec.id} → ルーム「${roomName}」（${room.size}人）`);
  sock.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.t === 'hello' && typeof m.name === 'string') {
      rec.name = m.name.slice(0, 16) || rec.name;
      roomcast({ t: 'rename', id: rec.id, name: rec.name }, sock);
      return;
    }
    m.id = rec.id;
    if (m.t === 'state') rec.state = m;
    roomcast(m, sock);
  });
  sock.on('close', () => {
    room.delete(sock);
    if (!room.size) rooms.delete(roomName);
    roomcast({ t: 'leave', id: rec.id });
    console.log(`[mp] 退出 #${rec.id} ← ルーム「${roomName}」（${room.size}人）`);
  });
  sock.on('error', () => { /* closeに任せる */ });
});
server.on('upgrade', (req, socket, head) => {
  if (!(req.url || '').includes('/cityfly-mp')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (sock) => wss.emit('connection', sock, req));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CityFly マルチプレイサーバ起動（ルームごと最大 ${MP_MAX} 人・MP_MAX で変更可）:`);
  console.log(`  ローカル:  http://localhost:${PORT}/?mp=1&name=ホスト`);
  console.log(`  LAN側   :  http://<このPCのIP>:${PORT}/?mp=1&name=名前`);
  console.log('  （IPは ipconfig の IPv4 アドレス。Windowsファイアウォールの許可が出たら「アクセスを許可」）');
});
