// cityfly-mp.js — CityFly マルチプレイのWebSocketクライアント（トランスポート層のみ・three非依存）。
// サーバは vite.config.ts 同居のリレー（/cityfly-mp）: 参加者全員に状態/イベントを中継する。
//
// プロトコル（JSON, サーバが m.id を付与して中継）:
//   → {t:'hello', name}                     参加名
//   ← {t:'welcome', id, players:[...]}      自分のid＋既存プレイヤー
//   ← {t:'join'|'leave'|'rename', id, name}
//   ⇄ {t:'state', p:[x,y,z], yaw}           位置・向き（15Hz）
//   ⇄ {t:'shot', from:[..], to:[..], c, thick}  射撃の見た目
//   ⇄ {t:'hit', target, dmg, kind}          命中（撃った側が判定＝target側が適用）
//   ⇄ {t:'hp', hp} / {t:'die', by}          体力共有・撃墜通知

export function createCityflyMp({ url, name, room = 'lobby', handlers = {} }) {
  const wsUrl = url + (url.includes('?') ? '&' : '?') + 'room=' + encodeURIComponent((room || 'lobby').slice(0, 24));
  let ws = null, myId = 0, connected = false, closed = false, wasFull = false;
  const remotes = new Map();   // id -> { id, name }
  const emit = (k, ...a) => { try { handlers[k]?.(...a); } catch (e) { console.warn('[mp]', k, e); } };
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      connected = true;
      send({ t: 'hello', name });
      emit('connect');
    };
    ws.onclose = () => {
      connected = false;
      for (const id of [...remotes.keys()]) { remotes.delete(id); emit('leave', id); }
      emit('disconnect');
      if (!closed) setTimeout(connect, wasFull ? 5000 : 2000);   // 自動再接続（満員時はゆっくり）
      wasFull = false;
    };
    ws.onerror = () => { /* closeが続く */ };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'welcome':
          myId = m.id;
          for (const p of m.players || []) {
            remotes.set(p.id, { id: p.id, name: p.name });
            emit('join', p.id, p.name, p.state);
          }
          break;
        case 'join':
          remotes.set(m.id, { id: m.id, name: m.name });
          emit('join', m.id, m.name, null);
          break;
        case 'rename': {
          const r = remotes.get(m.id);
          if (r) r.name = m.name;
          emit('rename', m.id, m.name);
          break;
        }
        case 'leave':
          remotes.delete(m.id);
          emit('leave', m.id);
          break;
        case 'state': emit('state', m.id, m); break;
        case 'shot':  emit('shot', m.id, m); break;
        case 'hit':   emit('hit', m); break;
        case 'hp':    emit('hp', m.id, m.hp); break;
        case 'die':   emit('die', m.id, m.by); break;
        case 'full':  wasFull = true; emit('full', m.max); break;
      }
    };
  }
  connect();

  return {
    get id() { return myId; },
    get connected() { return connected; },
    remotes,
    sendState: (st) => send({ t: 'state', ...st }),
    sendShot:  (sh) => send({ t: 'shot', ...sh }),
    sendHit:   (target, dmg, kind) => send({ t: 'hit', target, dmg, kind }),
    sendHp:    (hp) => send({ t: 'hp', hp }),
    sendDie:   (by) => send({ t: 'die', by }),
    dispose:   () => { closed = true; try { ws?.close(); } catch { /* noop */ } },
  };
}
