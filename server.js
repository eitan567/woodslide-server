// Wood Slide match server. No dependencies: run with `node server.js`.
// Listens on PORT (default 8080). Players connect with ws://<address>:<port> (or wss:// behind https).
const http = require('http'), crypto = require('crypto');
const PORT = process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TIERS = [[0, 19], [20, 39], [40, 59]];
const rooms = new Map();
const lobby = new Set(); let nextId = 1;
function cleanName(n, c) {
  n = String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!n) n = 'Player';
  const used = new Set([...lobby].filter(o => o !== c).map(o => o.name));
  let out = n, k = 2; while (used.has(out)) out = n.slice(0, 13) + ' ' + (k++);
  return out;
}
function status(c) { return c.room && !c.room.over ? 'busy' : (c.avail ? 'avail' : 'idle'); }
function broadcastLobby() {
  const players = [...lobby].filter(c => !c.dead).slice(0, 60).map(c => ({ id: c.id, name: c.name, s: status(c) }));
  lobby.forEach(c => send(c, { t: 'lobby', you: c.id, players }));
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Wood Slide server OK. Rooms: ' + rooms.size + '\n');
});

// ---- minimal RFC 6455 framing (text frames, <= 64 KB, masked client frames)
function frame(str) {
  const p = Buffer.from(str), n = p.length;
  const h = n < 126 ? Buffer.from([0x81, n]) : Buffer.from([0x81, 126, n >> 8, n & 255]);
  return Buffer.concat([h, p]);
}
function send(c, obj) { if (c && !c.dead) { try { c.socket.write(frame(JSON.stringify(obj))); } catch (e) {} } }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, dead: false, room: null, idx: -1, buf: Buffer.alloc(0) };
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const op = b[0] & 15; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { socket.destroy(); return; }
      const masked = (b[1] & 128) !== 0, need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload.map((v, i) => v ^ m[i & 3])); }
      c.buf = b.subarray(need);
      if (op === 8) { socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); continue; }
      if (op === 1) { let m; try { m = JSON.parse(payload.toString()); } catch (e) { continue; } onMsg(c, m); }
    }
  });
  const close = () => { if (c.dead) return; c.dead = true; leave(c); if (lobby.delete(c)) broadcastLobby(); };
  socket.on('close', close); socket.on('error', close);
});

function newCode() { for (;;) { const k = String(1000 + Math.floor(Math.random() * 9000)); if (!rooms.has(k)) return k; } }
const SC = parseFloat(process.env.TIME_SCALE || '1'); const LIMITS = [60, 90, 120].map(v => v * SC); // seconds per challenge: easy, medium, hard
function pickRounds(tier, n) {
  const [a, b] = TIERS[Math.max(0, Math.min(2, tier | 0))];
  const pool = []; for (let i = a; i <= b; i++) pool.push(i);
  const r = []; while (r.length < n) { if (!pool.length) for (let i = a; i <= b; i++) pool.push(i); r.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); }
  return r;
}
function finishRound(R, winner) {
  clearTimeout(R.rtimer); R.solvedThis = true;
  if (winner >= 0) R.scores[winner]++;
  const last = R.r >= R.rounds.length - 1;
  if (last) {
    R.over = true;
    const w = R.scores[0] === R.scores[1] ? -1 : (R.scores[0] > R.scores[1] ? 0 : 1);
    R.players.forEach(p => send(p, { t: 'matchEnd', roundWinner: winner, winner: w, scores: R.scores, r: R.r }));
  } else {
    R.players.forEach(p => send(p, { t: 'roundEnd', winner, scores: R.scores, r: R.r }));
    R.timer = setTimeout(() => { R.r++; startRound(R); }, 3500);
  }
}
function leave(c) {
  const R = c.room; if (!R) return; c.room = null;
  clearTimeout(R.timer); clearTimeout(R.rtimer);
  const o = R.players[1 - c.idx];
  if (o && !o.dead && !R.over) send(o, { t: 'oppLeft' });
  if (o && o.room === R) { o.room = null; o.avail = false; }
  rooms.delete(R.code);
  if (lobby.has(c) || (o && lobby.has(o))) setTimeout(broadcastLobby, 0);
}
function startRound(R) {
  R.solvedThis = false; R.moves = [0, 0];
  const limit = LIMITS[Math.max(0, Math.min(2, R.tier))];
  R.players.forEach(p => send(p, { t: 'round', r: R.r, total: R.rounds.length, level: R.rounds[R.r], scores: R.scores, limit, countdown: 3 }));
  clearTimeout(R.rtimer);
  R.rtimer = setTimeout(() => { if (!R.solvedThis && !R.over) finishRound(R, -1); }, (3 + limit) * 1000 + 500);
}
function onMsg(c, m) {
  if (m.t === 'ping') return send(c, { t: 'pong' });
  if (m.t === 'lobby') {
    leave(c);
    c.name = cleanName(m.name, c); c.id = c.id || nextId++; c.avail = false; lobby.add(c);
    broadcastLobby(); return;
  }
  if (m.t === 'avail') {
    if (!lobby.has(c) || (c.room && !c.room.over)) return;
    c.avail = !!m.on; broadcastLobby(); return;
  }
  if (m.t === 'pick') {
    if (!lobby.has(c) || (c.room && !c.room.over)) return send(c, { t: 'err', e: 'taken' });
    const o = [...lobby].find(x => x.id === (m.id | 0));
    if (!o || o === c || o.dead || !o.avail || (o.room && !o.room.over)) { send(c, { t: 'err', e: 'taken' }); return broadcastLobby(); }
    leave(c); leave(o);
    const code = newCode();
    const R = { code, players: [o, c], tier: m.tier | 0, n: [5, 10, 15, 20].includes(m.rounds | 0) ? m.rounds | 0 : 5, rounds: [], r: 0, scores: [0, 0], solvedThis: false, moves: [0, 0], over: false };
    rooms.set(code, R); o.room = R; o.idx = 0; c.room = R; c.idx = 1; o.avail = false; c.avail = false;
    R.rounds = pickRounds(R.tier, R.n);
    R.players.forEach((p, i) => send(p, { t: 'start', you: i, tier: R.tier, n: R.n, opp: R.players[1 - i].name }));
    broadcastLobby();
    return setTimeout(() => startRound(R), 800);
  }
  if (m.t === 'create') {
    leave(c);
    const code = newCode();
    const R = { code, players: [c], tier: m.tier | 0, n: [5, 10, 15, 20].includes(m.rounds | 0) ? m.rounds | 0 : 5, rounds: [], r: 0, scores: [0, 0], solvedThis: false, moves: [0, 0], over: false };
    rooms.set(code, R); c.room = R; c.idx = 0;
    return send(c, { t: 'created', code });
  }
  if (m.t === 'join') {
    leave(c);
    const R = rooms.get(String(m.code || ''));
    if (!R) return send(c, { t: 'err', e: 'notfound' });
    if (R.players.length >= 2) return send(c, { t: 'err', e: 'full' });
    R.players.push(c); c.room = R; c.idx = 1;
    R.rounds = pickRounds(R.tier, R.n); R.r = 0; R.scores = [0, 0];
    R.players.forEach((p, i) => send(p, { t: 'start', you: i, tier: R.tier, n: R.n }));
    return setTimeout(() => startRound(R), 800);
  }
  const R = c.room; if (!R || R.players.length < 2 || R.over) return;
  if (m.t === 'state') { const o = R.players[1 - c.idx]; return send(o, { t: 'opp', moves: m.n | 0, p: Array.isArray(m.p) ? m.p.slice(0, 16).map(v => v | 0) : null }); }
  if (m.t === 'moves') { const o = R.players[1 - c.idx]; return send(o, { t: 'opp', moves: m.n | 0 }); }
  if (m.t === 'solved' && !R.solvedThis) finishRound(R, c.idx);
}
server.listen(PORT, () => console.log('Wood Slide server listening on port ' + PORT));
