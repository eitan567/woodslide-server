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
function status(c) { return (c.room && !c.room.over) || c.inv ? 'busy' : (c.avail ? 'avail' : 'idle'); }
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
const GO_MS = 3200, GRACE_MS = 1500;
function elArr(R) { return R.solves ? R.solves.map(s => s ? s.el : null) : [null, null]; }
function decideRound(R) {
  if (R.solvedThis || R.over) return;
  clearTimeout(R.pendT);
  const s = R.solves; let w;
  if (s[0] && s[1]) w = s[0].el !== s[1].el ? (s[0].el < s[1].el ? 0 : 1) : (s[0].at <= s[1].at ? 0 : 1);
  else w = s[0] ? 0 : 1;
  finishRound(R, w);
}
function finishRound(R, winner) {
  clearTimeout(R.rtimer); clearTimeout(R.pendT); R.pendT = null; R.solvedThis = true;
  if (winner >= 0) R.scores[winner]++;
  const last = R.r >= R.rounds.length - 1;
  if (last) {
    R.over = true;
    const w = R.scores[0] === R.scores[1] ? -1 : (R.scores[0] > R.scores[1] ? 0 : 1);
    R.players.forEach(p => send(p, { t: 'matchEnd', roundWinner: winner, winner: w, scores: R.scores, r: R.r, el: elArr(R) }));
  } else {
    R.players.forEach(p => send(p, { t: 'roundEnd', winner, scores: R.scores, r: R.r, el: elArr(R) }));
    R.timer = setTimeout(() => { R.r++; startRound(R); }, 3500);
  }
}
function cancelInvite(c, why) {
  const v = c.inv; if (!v) return;
  clearTimeout(v.timer); v.from.inv = null; v.to.inv = null;
  if (why) { send(v.from, { t: 'declined', why }); send(v.to, { t: 'inviteGone' }); }
  setTimeout(broadcastLobby, 0);
}
function leave(c) {
  cancelInvite(c, 'gone');
  const R = c.room; if (!R) return; c.room = null;
  clearTimeout(R.timer); clearTimeout(R.rtimer); clearTimeout(R.pendT);
  const o = R.players[1 - c.idx];
  if (o && !o.dead && !R.over) send(o, { t: 'oppLeft' });
  if (o && o.room === R) { o.room = null; o.avail = false; }
  rooms.delete(R.code);
  if (lobby.has(c) || (o && lobby.has(o))) setTimeout(broadcastLobby, 0);
}
function startRound(R) {
  R.solvedThis = false; R.moves = [0, 0]; R.solves = [null, null]; R.goAt = Date.now() + GO_MS; clearTimeout(R.pendT); R.pendT = null;
  const limit = LIMITS[Math.max(0, Math.min(2, R.tier))];
  R.players.forEach(p => send(p, { t: 'round', r: R.r, total: R.rounds.length, level: R.rounds[R.r], scores: R.scores, limit, countdown: 3 }));
  clearTimeout(R.rtimer);
  R.limitMs = limit * 1000;
  R.rtimer = setTimeout(() => { if (R.solvedThis || R.over) return; if (R.solves[0] || R.solves[1]) decideRound(R); else finishRound(R, -1); }, GO_MS + limit * 1000 + 2000);
}
function onMsg(c, m) {
  if (m.t === 'ping') return send(c, { t: 'pong', c: m.c });
  if (m.t === 'lobby') {
    leave(c);
    c.name = cleanName(m.name, c); c.id = c.id || nextId++; c.avail = !!m.avail; lobby.add(c);
    broadcastLobby(); return;
  }
  if (m.t === 'avail') {
    if (!lobby.has(c) || (c.room && !c.room.over)) return;
    c.avail = !!m.on; broadcastLobby(); return;
  }
  if (m.t === 'pick') {
    if (!lobby.has(c) || (c.room && !c.room.over) || c.inv) return send(c, { t: 'err', e: 'taken' });
    const o = [...lobby].find(x => x.id === (m.id | 0));
    if (!o || o === c || o.dead || !o.avail || o.inv || (o.room && !o.room.over)) { send(c, { t: 'err', e: 'taken' }); return broadcastLobby(); }
    c.avail = true; // picking an opponent makes the picker available automatically
    const v = { from: c, to: o, tier: m.tier | 0, n: [5, 10, 15, 20].includes(m.rounds | 0) ? m.rounds | 0 : 5 };
    v.timer = setTimeout(() => cancelInvite(v.from, 'timeout'), 25000);
    c.inv = v; o.inv = v;
    send(o, { t: 'invite', id: c.id, name: c.name, tier: v.tier, n: v.n });
    send(c, { t: 'inviting', name: o.name });
    return broadcastLobby();
  }
  if (m.t === 'decline') { if (c.inv && c.inv.to === c) cancelInvite(c, 'declined'); return; }
  if (m.t === 'cancel') { if (c.inv && c.inv.from === c) cancelInvite(c, 'cancel'); return; }
  if (m.t === 'accept') {
    const v = c.inv; if (!v || v.to !== c || v.from.dead) return;
    clearTimeout(v.timer); v.from.inv = null; v.to.inv = null;
    const o = c, p = v.from;
    leave(p); leave(o);
    const code = newCode();
    const R = { code, players: [o, p], tier: v.tier, n: v.n, rounds: [], r: 0, scores: [0, 0], solvedThis: false, moves: [0, 0], over: false };
    rooms.set(code, R); o.room = R; o.idx = 0; p.room = R; p.idx = 1; o.avail = false; p.avail = false;
    R.rounds = pickRounds(R.tier, R.n);
    R.players.forEach((q, i) => send(q, { t: 'start', you: i, tier: R.tier, n: R.n, opp: R.players[1 - i].name }));
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
  if (m.t === 'solved' && !R.solvedThis && !R.solves[c.idx]) {
    const now = Date.now(), srvEl = Math.max(0, now - R.goAt);
    // client-measured time since its own GO; bounded by what the server saw so it cannot be far off (old clients send none: use arrival time)
    let el = Number.isFinite(+m.el) && m.el !== undefined ? Math.round(+m.el) : srvEl;
    el = Math.max(srvEl - 3000, Math.min(srvEl + 300, el)); el = Math.max(0, el);
    if (el > R.limitMs + 300) return;
    R.solves[c.idx] = { el, at: now };
    if (R.solves[0] && R.solves[1]) return decideRound(R);
    if (!R.pendT) R.pendT = setTimeout(() => decideRound(R), GRACE_MS);
  }
}
server.listen(PORT, () => console.log('Wood Slide server listening on port ' + PORT));
