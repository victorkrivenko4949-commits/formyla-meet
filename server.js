/* server.js — сервер встреч FORMYLA Meet: статика + WebSocket-сигнализация для WebRTC.
   Запуск: node server.js  (порт из PORT, по умолчанию 8787) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

/* ---------- статика (для локальной разработки и режима «один сервис») ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: [...rooms.values()].reduce((a, r) => a + r.peers.size, 0), turn: iceCache.list.length > 0 })); }
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || /^\/(server\.js|package.*|node_modules|\.git|build_package\.py|formyla_package|formyla_meet_package\.zip)/.test(p)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  });
});

/* ---------- комнаты ---------- */
const rooms = new Map(); // id -> room
const PALETTE = ['linear-gradient(135deg,#38bdf8,#4c7dff)', 'linear-gradient(135deg,#8b5cf6,#ec4899)', 'linear-gradient(135deg,#38ef7d,#11998e)', 'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#6366f1,#38bdf8)', 'linear-gradient(135deg,#f472b6,#8b5cf6)', 'linear-gradient(135deg,#14b8a6,#22c55e)', 'linear-gradient(135deg,#fb7185,#f59e0b)'];
const SOLID = ['#38bdf8', '#8b5cf6', '#22c55e', '#f59e0b', '#6366f1', '#ec4899', '#14b8a6', '#fb7185'];
const initials = n => String(n || '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'У';
const clean = (s, n = 80) => String(s || '').replace(/[<>]/g, '').slice(0, n);
let seq = 0;
const uid = () => (Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6));

function getRoom(id, create) {
  let r = rooms.get(id);
  if (!r && create) {
    r = { id, topic: 'Встреча FORMYLA', pw: '', hostId: null, created: Date.now(), colorSeq: 0,
      settings: { locked: false, waitingRoom: true, allowShare: true, allowChat: true, allowRename: true, allowUnmute: true, muteOnEntry: false },
      peers: new Map(), waiting: new Map(), chat: [], polls: [], rooms: [], wb: null, annot: null, sharingId: null, spotlight: null };
    rooms.set(id, r);
  }
  return r;
}
const pub = p => ({ id: p.id, name: p.name, initials: p.initials, color: p.color, solid: p.solid, mic: p.mic, cam: p.cam, hand: p.hand, sharing: p.sharing, room: p.room || null, host: p.host, cohost: p.cohost, spotlight: p.spotlight });
const roomPub = r => ({ id: r.id, topic: r.topic, hasPw: !!r.pw, settings: r.settings, polls: r.polls, rooms: r.rooms, wb: r.wb, annot: r.annot, sharingId: r.sharingId, spotlight: r.spotlight, chat: r.chat.slice(-100) });
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (r, msg, exceptId) => { for (const p of r.peers.values()) if (p.id !== exceptId) send(p.ws, msg); };
const toHosts = (r, msg) => { for (const p of r.peers.values()) if (p.host || p.cohost) send(p.ws, msg); };
const now = () => Date.now();

function sysChat(r, text) { const m = { sys: true, text, time: now() }; r.chat.push(m); if (r.chat.length > 300) r.chat.shift(); broadcast(r, { t: 'chat', msg: m }); }

function admit(r, w) {
  r.waiting.delete(w.id);
  const p = w; p.waiting = false; p.mic = r.settings.muteOnEntry ? false : p.mic;
  r.peers.set(p.id, p);
  if (!r.hostId) { r.hostId = p.id; p.host = true; }
  send(p.ws, { t: 'joined', you: pub(p), peers: [...r.peers.values()].filter(x => x !== p).map(pub), room: roomPub(r), waiting: p.host || p.cohost ? [...r.waiting.values()].map(pub) : [] });
  broadcast(r, { t: 'peer', peer: pub(p) }, p.id);
  sysChat(r, `${p.name} присоединился к встрече`);
  toHosts(r, { t: 'waitlist', list: [...r.waiting.values()].map(pub) });
}

function leave(p, reason) {
  const r = p.room_; if (!r) return;
  if (p.waiting) { r.waiting.delete(p.id); toHosts(r, { t: 'waitlist', list: [...r.waiting.values()].map(pub) }); }
  else if (r.peers.has(p.id)) {
    r.peers.delete(p.id);
    if (r.sharingId === p.id) r.sharingId = null;
    if (r.spotlight === p.id) r.spotlight = null;
    let newHost = null;
    if (r.hostId === p.id) { r.hostId = null; const next = [...r.peers.values()].find(x => x.cohost) || [...r.peers.values()][0]; if (next) { next.host = true; r.hostId = next.id; newHost = next.id; } }
    broadcast(r, { t: 'left', id: p.id, newHost, reason: reason || 'left', sharingId: r.sharingId, spotlight: r.spotlight });
    sysChat(r, `${p.name} ${reason === 'removed' ? 'удалён организатором' : 'покинул встречу'}`);
  }
  p.room_ = null;
  if (!r.peers.size && !r.waiting.size) rooms.delete(r.id);
}

const wss = new WebSocketServer({ server, path: '/ws' });
/* TURN/STUN для клиентов. Задаётся переменными окружения на сервере:
   METERED_DOMAIN + METERED_API_KEY  — Open Relay / Metered (https://www.metered.ca, бесплатно 20 ГБ/мес), или
   TURN_URLS (через запятую) + TURN_USERNAME + TURN_CREDENTIAL — любой TURN (ExpressTURN, Cloudflare, свой coturn). */
let iceCache = { at: 0, list: [] };
async function getIce() {
  if (Date.now() - iceCache.at < 3600e3 && iceCache.list.length) return iceCache.list;
  let list = [];
  try {
    if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
      const d = process.env.METERED_DOMAIN.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const res = await fetch(`https://${d}/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`);
      if (res.ok) { const arr = await res.json(); if (Array.isArray(arr)) list = list.concat(arr.filter(x => /^turns?:/.test(String(x.urls)))); }
      else console.warn('Metered TURN', res.status);
    }
    if (process.env.TURN_URLS) {
      list.push({ urls: process.env.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    }
  } catch (e) { console.warn('ICE config', e.message); }
  if (list.length) iceCache = { at: Date.now(), list };
  return list;
}
getIce().then(l => console.log(l.length ? `TURN: ${l.length} записей` : 'TURN не настроен (только STUN) — задайте METERED_DOMAIN/METERED_API_KEY или TURN_URLS'));

wss.on('connection', ws => {
  let me = null; ws.isAlive = true;
  getIce().then(ice => send(ws, { t: 'hello', ice, turn: ice.length > 0 })).catch(() => send(ws, { t: 'hello', ice: [], turn: false }));
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join') return onJoin(m);
    if (!me || !me.room_) return;
    const r = me.room_, isHost = me.host || me.cohost;
    switch (m.t) {
      case 'signal': { const to = r.peers.get(m.to); if (to && !me.waiting) send(to.ws, { t: 'signal', from: me.id, data: m.data }); break; }
      case 'state': {
        if (me.waiting) break;
        if ('mic' in m) { if (m.mic && !r.settings.allowUnmute && !isHost) { send(ws, { t: 'host', action: 'mute', reason: 'Организатор запретил включать микрофон' }); m.mic = false; } me.mic = !!m.mic; }
        if ('cam' in m) me.cam = !!m.cam;
        if ('hand' in m) me.hand = !!m.hand;
        if ('sharing' in m) { if (m.sharing && !r.settings.allowShare && !isHost) { send(ws, { t: 'toast', text: 'Организатор запретил демонстрацию экрана', kind: 'bad' }); m.sharing = false; } me.sharing = !!m.sharing; if (me.sharing) { r.sharingId = me.id; r.annot = null; if (r.wb) { r.wb.open = false; broadcast(r, { t: 'wb', action: 'close', from: me.id }); } } else if (r.sharingId === me.id) { r.sharingId = null; r.annot = null; } }
        if ('name' in m && (r.settings.allowRename || isHost)) { me.name = clean(m.name, 40) || me.name; me.initials = initials(me.name); }
        broadcast(r, { t: 'state', id: me.id, peer: pub(me), sharingId: r.sharingId });
        break;
      }
      case 'chat': {
        if (me.waiting || (!r.settings.allowChat && !isHost)) { send(ws, { t: 'toast', text: 'Чат отключён организатором', kind: 'bad' }); break; }
        const msg = { from: me.id, name: me.name, initials: me.initials, color: me.color, text: clean(m.text, 2000), file: m.file ? clean(m.file, 120) : undefined, fileName: m.fileName ? clean(m.fileName, 120) : undefined, data: typeof m.data === 'string' && m.data.length <= 4.5 * 1048576 && /^data:/.test(m.data) ? m.data : undefined, to: m.to && m.to !== 'all' ? m.to : 'all', time: now() };
        if (m.file && !msg.data) break;
        if (msg.to === 'all') { r.chat.push(msg.data ? Object.assign({}, msg, { data: undefined, file: msg.file + ' (файл доступен участникам, которые были во встрече)' }) : msg); if (r.chat.length > 300) r.chat.shift(); broadcast(r, { t: 'chat', msg }); }
        else { const to = r.peers.get(msg.to); if (to) { msg.toName = to.name; send(to.ws, { t: 'chat', msg }); send(ws, { t: 'chat', msg }); } }
        break;
      }
      case 'react': broadcast(r, { t: 'react', id: me.id, emoji: clean(m.emoji, 8) }); break;
      case 'wbcur': if (typeof m.x === 'number' && typeof m.y === 'number') broadcast(r, { t: 'wbcur', id: me.id, name: me.name.split(' ')[0], color: me.solid, kind: m.kind === 'annot' ? 'annot' : 'wb', x: m.x, y: m.y }, me.id); break;
      case 'caption': broadcast(r, { t: 'caption', id: me.id, name: me.name, text: clean(m.text, 400) }, me.id); break;
      case 'wb': {
        if (m.action === 'open') { if (!r.settings.allowShare && !isHost) break; r.wb = { open: true, by: me.id, title: clean(m.title, 80), pages: m.pages || [{ shapes: [] }], page: m.page || 0, bg: m.bg || 'dots' }; r.sharingId = null; r.annot = null; }
        else if (m.action === 'close') { if (r.wb) r.wb.open = false; }
        else if (m.action === 'sync' && r.wb) { if (m.pages) r.wb.pages = m.pages; if ('page' in m) r.wb.page = m.page; if (m.bg) r.wb.bg = m.bg; if (m.title) r.wb.title = clean(m.title, 80); }
        broadcast(r, { t: 'wb', action: m.action, from: me.id, wb: r.wb }, me.id);
        break;
      }
      case 'annot': {
        if (m.action === 'open') r.annot = { open: true, by: me.id, pages: m.pages || [{ shapes: [] }] };
        else if (m.action === 'close') r.annot = null;
        else if (m.action === 'sync' && r.annot && m.pages) r.annot.pages = m.pages;
        broadcast(r, { t: 'annot', action: m.action, from: me.id, annot: r.annot }, me.id);
        break;
      }
      case 'poll': {
        if (m.action === 'new' && isHost) r.polls.unshift({ id: uid(), q: clean(m.q, 300), opts: (m.opts || []).slice(0, 10).map(o => clean(o, 120)), votes: {}, anon: !!m.anon, open: true, by: me.name });
        const p = r.polls.find(x => x.id === m.id);
        if (m.action === 'vote' && p && p.open && Number.isInteger(m.opt) && m.opt >= 0 && m.opt < p.opts.length) p.votes[me.id] = m.opt;
        if (m.action === 'end' && p && isHost) p.open = false;
        if (m.action === 'share' && p && isHost) sysChat(r, `Итоги опроса «${p.q}»: ` + p.opts.map((o, j) => `${o} — ${Object.values(p.votes).filter(v => v === j).length}`).join(', '));
        if (m.action === 'new') sysChat(r, `Организатор запустил опрос: «${r.polls[0].q}»`);
        broadcast(r, { t: 'polls', polls: r.polls });
        break;
      }
      case 'rooms': {
        if (!isHost) break;
        if (m.action === 'create') { r.rooms = (m.rooms || []).slice(0, 20).map(x => ({ name: clean(x.name, 60), open: false })); const ids = [...r.peers.values()].filter(x => !x.host); ids.forEach((p, i) => p.room = m.mode === 'auto' ? (i % r.rooms.length) + 1 : null); }
        if (m.action === 'assign') { const p = r.peers.get(m.target); if (p) p.room = m.room || null; }
        if (m.action === 'open') { r.rooms.forEach(x => x.open = !!m.open); if (!m.open) for (const p of r.peers.values()) p.room = null; sysChat(r, m.open ? 'Сессионные залы открыты' : 'Сессионные залы закрыты, все возвращаются в основной зал'); }
        if (m.action === 'bcast') { const text = clean(m.text, 500); for (const p of r.peers.values()) if (m.room == null || p.room === m.room) send(p.ws, { t: 'toast', text: `Сообщение организатора: ${text}`, kind: 'info', ms: 8000 }); }
        broadcast(r, { t: 'rooms', rooms: r.rooms, members: [...r.peers.values()].map(p => [p.id, p.room || null]) });
        break;
      }
      case 'host': {
        if (!isHost) break;
        const tgt = r.peers.get(m.target);
        switch (m.action) {
          case 'settings': Object.keys(m.settings || {}).forEach(k => { if (k in r.settings) r.settings[k] = !!m.settings[k]; }); broadcast(r, { t: 'settings', settings: r.settings }); break;
          case 'muteAll': for (const p of r.peers.values()) if (!p.host) { p.mic = false; send(p.ws, { t: 'host', action: 'mute', reason: 'Организатор выключил звук всем участникам' }); } broadcast(r, { t: 'peers', peers: [...r.peers.values()].map(pub) }); break;
          case 'lowerAll': for (const p of r.peers.values()) { p.hand = false; send(p.ws, { t: 'host', action: 'lowerHand' }); } broadcast(r, { t: 'peers', peers: [...r.peers.values()].map(pub) }); break;
          case 'mute': if (tgt) { tgt.mic = false; send(tgt.ws, { t: 'host', action: 'mute', reason: 'Организатор выключил ваш микрофон' }); broadcast(r, { t: 'state', id: tgt.id, peer: pub(tgt), sharingId: r.sharingId }); } break;
          case 'askUnmute': if (tgt) send(tgt.ws, { t: 'host', action: 'askUnmute' }); break;
          case 'camOff': if (tgt) { tgt.cam = false; send(tgt.ws, { t: 'host', action: 'camOff' }); broadcast(r, { t: 'state', id: tgt.id, peer: pub(tgt), sharingId: r.sharingId }); } break;
          case 'askCam': if (tgt) send(tgt.ws, { t: 'host', action: 'askCam' }); break;
          case 'lowerHand': if (tgt) { tgt.hand = false; send(tgt.ws, { t: 'host', action: 'lowerHand' }); broadcast(r, { t: 'state', id: tgt.id, peer: pub(tgt), sharingId: r.sharingId }); } break;
          case 'rename': if (tgt) { tgt.name = clean(m.name, 40) || tgt.name; tgt.initials = initials(tgt.name); send(tgt.ws, { t: 'host', action: 'rename', name: tgt.name }); broadcast(r, { t: 'state', id: tgt.id, peer: pub(tgt), sharingId: r.sharingId }); } break;
          case 'spotlight': for (const p of r.peers.values()) p.spotlight = false; r.spotlight = tgt && m.value ? tgt.id : null; if (tgt) tgt.spotlight = !!m.value; broadcast(r, { t: 'spotlight', id: r.spotlight }); break;
          case 'cohost': if (tgt) { tgt.cohost = !!m.value; send(tgt.ws, { t: 'host', action: 'cohost', value: tgt.cohost }); broadcast(r, { t: 'state', id: tgt.id, peer: pub(tgt), sharingId: r.sharingId }); if (tgt.cohost) send(tgt.ws, { t: 'waitlist', list: [...r.waiting.values()].map(pub) }); } break;
          case 'makeHost': if (tgt && me.host) { me.host = false; tgt.host = true; tgt.cohost = false; r.hostId = tgt.id; broadcast(r, { t: 'peers', peers: [...r.peers.values()].map(pub) }); send(tgt.ws, { t: 'host', action: 'youHost' }); sysChat(r, `${tgt.name} назначен организатором`); } break;
          case 'toWaiting': if (tgt && !tgt.host) { r.peers.delete(tgt.id); tgt.waiting = true; r.waiting.set(tgt.id, tgt); send(tgt.ws, { t: 'waiting', topic: r.topic, reason: 'Организатор переместил вас в зал ожидания' }); broadcast(r, { t: 'left', id: tgt.id, reason: 'waiting' }); toHosts(r, { t: 'waitlist', list: [...r.waiting.values()].map(pub) }); } break;
          case 'remove': if (tgt && !tgt.host) { send(tgt.ws, { t: 'removed' }); leave(tgt, 'removed'); try { tgt.ws.close(); } catch (e) { } } break;
          case 'admit': { const w = r.waiting.get(m.target); if (w) admit(r, w); break; }
          case 'admitAll': for (const w of [...r.waiting.values()]) admit(r, w); break;
          case 'deny': { const w = r.waiting.get(m.target); if (w) { send(w.ws, { t: 'denied' }); r.waiting.delete(w.id); w.room_ = null; toHosts(r, { t: 'waitlist', list: [...r.waiting.values()].map(pub) }); try { w.ws.close(); } catch (e) { } } break; }
          case 'end': { if (!me.host) break; broadcast(r, { t: 'ended' }); for (const p of [...r.peers.values(), ...r.waiting.values()]) { p.room_ = null; try { p.ws.close(); } catch (e) { } } rooms.delete(r.id); break; }
          case 'timer': broadcast(r, { t: 'timer', mins: Math.max(1, Math.min(180, +m.mins || 10)), by: me.name }, me.id); sysChat(r, `Организатор запустил таймер на ${Math.max(1, Math.min(180, +m.mins || 10))} мин`); break;
          case 'topic': r.topic = clean(m.topic, 120) || r.topic; broadcast(r, { t: 'topic', topic: r.topic }); break;
        }
        break;
      }
      case 'leave': leave(me, 'left'); me = null; break;
    }
  });
  ws.on('close', () => { if (me) leave(me, 'left'); me = null; });

  function onJoin(m) {
    if (me) leave(me, 'left');
    const id = String(m.room || '').replace(/\D/g, '');
    if (id.length < 9 || id.length > 11) return send(ws, { t: 'error', code: 'badid', text: 'Неверный идентификатор встречи' });
    const existed = rooms.has(id);
    const r = getRoom(id, true);
    // Комнату по-настоящему открывает только организатор (create: true). Гость, пришедший по ссылке раньше
    // организатора, ждёт его; случайный чужой идентификатор ничего не создаёт и никого не делает организатором.
    const started = existed && !r.placeholder;
    if (!started && m.create) {
      r.placeholder = false; r.topic = clean(m.topic, 120) || r.topic; r.pw = String(m.pw || '').slice(0, 20); r.settings.waitingRoom = m.waiting !== false;
    } else if (!started) { r.placeholder = true; }
    if (started && r.pw && String(m.pw || '') !== r.pw) return send(ws, { t: 'error', code: 'badpw', text: 'Неверный код доступа' });
    if (started && r.settings.locked) return send(ws, { t: 'error', code: 'locked', text: 'Встреча заблокирована организатором — вход закрыт' });
    const ci = r.colorSeq++ % 8;
    me = { id: uid(), ws, room_: r, name: clean(m.name, 40) || 'Участник', mic: !!m.mic, cam: !!m.cam, hand: false, sharing: false, room: null, host: false, cohost: false, spotlight: false, waiting: false, color: PALETTE[ci], solid: SOLID[ci] };
    me.initials = initials(me.name);
    if (r.placeholder) {
      me.waiting = true; r.waiting.set(me.id, me);
      return send(ws, { t: 'waiting', topic: r.topic, reason: 'nohost' });
    }
    const becomesHost = !r.hostId && !r.peers.size;
    if (becomesHost || !r.settings.waitingRoom) {
      admit(r, me);
      if (becomesHost && r.waiting.size) {
        // организатор пришёл к уже ожидающим гостям
        const waiting = [...r.waiting.values()];
        if (!r.settings.waitingRoom) { for (const w of waiting) { r.waiting.delete(w.id); w.waiting = false; admit(r, w); } }
        else { toHosts(r, { t: 'waitlist', list: waiting.map(pub) }); for (const w of waiting) { send(w.ws, { t: 'waiting', topic: r.topic, reason: 'waiting' }); toHosts(r, { t: 'knock', peer: pub(w) }); } }
      }
      return;
    }
    me.waiting = true; r.waiting.set(me.id, me);
    send(ws, { t: 'waiting', topic: r.topic, reason: 'waiting' });
    toHosts(r, { t: 'waitlist', list: [...r.waiting.values()].map(pub) });
    toHosts(r, { t: 'knock', peer: pub(me) });
  }
});

/* пинг для удержания соединений и очистки «мёртвых» */
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }); }, 25000);

server.listen(PORT, () => console.log(`FORMYLA Meet server: http://localhost:${PORT}  (ws: /ws)`));
