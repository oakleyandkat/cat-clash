// Cat Clash: Yarn Wars — tiny server.
// 1) Serves the game (public/index.html) over HTTP.
// 2) Relays online-multiplayer "presence" between players in the same room over WebSocket (/ws).
// The game is host-authoritative: the host's browser runs the game and publishes snapshots;
// guests publish their inputs. This server only forwards messages — it has no game logic.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_MSG = 8 * 1024;        // presence objects are capped at ~4 KB by the client
const MAX_PEERS_PER_ROOM = 8;
const ROOM_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/catclash-health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ catclash: true, rooms: rooms.size }));
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// rooms: Map<roomName, Map<peerId, { ws, data }>>
const rooms = new Map();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });

function broadcast(roomName, msg, exceptPeer) {
  const room = rooms.get(roomName);
  if (!room) return;
  const s = JSON.stringify(msg);
  for (const [peer, m] of room) if (peer !== exceptPeer && m.ws.readyState === 1) m.ws.send(s);
}
function leave(ws, roomName) {
  const room = rooms.get(roomName);
  if (!room || !ws.peer || room.get(ws.peer)?.ws !== ws) return;
  room.delete(ws.peer);
  ws.rooms.delete(roomName);
  if (room.size === 0) rooms.delete(roomName);
  else broadcast(roomName, { t: 'left', room: roomName, peer: ws.peer });
}

wss.on('connection', (ws) => {
  ws.rooms = new Set();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.room !== 'string' || !ROOM_RE.test(m.room)) return;
    if (m.t === 'join') {
      if (typeof m.peer !== 'string' || m.peer.length > 32) return;
      ws.peer = ws.peer || m.peer;
      let room = rooms.get(m.room);
      if (!room) { room = new Map(); rooms.set(m.room, room); }
      if (!room.has(ws.peer) && room.size >= MAX_PEERS_PER_ROOM) return;
      room.set(ws.peer, { ws, data: room.get(ws.peer)?.data || {} });
      ws.rooms.add(m.room);
      ws.send(JSON.stringify({ t: 'snap', room: m.room, peers: [...room].map(([peer, v]) => ({ peer, data: v.data })) }));
      broadcast(m.room, { t: 'p', room: m.room, peer: ws.peer, data: room.get(ws.peer).data }, ws.peer);
    } else if (m.t === 'presence') {
      const room = rooms.get(m.room);
      const me = room && room.get(ws.peer);
      if (!me || me.ws !== ws || typeof m.data !== 'object' || m.data === null) return;
      me.data = m.data;
      broadcast(m.room, { t: 'p', room: m.room, peer: ws.peer, data: m.data }, ws.peer);
    } else if (m.t === 'leave') {
      leave(ws, m.room);
    }
  });
  ws.on('close', () => { for (const r of [...ws.rooms]) leave(ws, r); });
});

// drop dead connections so "host left" is detected
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

server.listen(PORT, () => console.log(`Cat Clash running on http://localhost:${PORT}`));
