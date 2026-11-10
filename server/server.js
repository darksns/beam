#!/usr/bin/env node
/* Beam — local hub between the CLI and the Chrome extension.
 * HTTP for the CLI, WebSocket (hand-rolled, zero dependencies) for Chrome.
 * Binds to 127.0.0.1 only. It executes nothing: it just relays messages.
 *
 * Two doors, two locks:
 *   /cmd  (HTTP)      requires the shared token in `x-beam-token`, and refuses
 *                     any request that carries a cross-site fetch metadata —
 *                     a web page cannot drive your browser through this port.
 *   upgrade (WS)      only accepts an Origin of chrome-extension://…, so a page
 *                     cannot impersonate the extension and hijack the command
 *                     stream. The socket is not adopted until a `hello` frame.
 *                     Pin a single extension with BEAM_EXTENSION_ID.
 *
 * One socket per Chrome profile. Each copy of the extension sends a
 * `profileId` it made up and keeps in its own storage, plus the name the
 * person gave it in the Beam panel. A command goes to the profile it names
 * (`profile`), else to the one its session was opened in, else to the profile
 * that connected first. A new socket with the same profileId is a
 * service-worker restart and replaces the old one.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const PORT = Number(process.env.BEAM_PORT || 8777);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EXT_ID = process.env.BEAM_EXTENSION_ID || '';

const conns = new Map();    // profile key -> {key, sock, info, alive, since}
const pending = new Map();  // id -> {resolve, timer, conn}
const bound = new Map();    // session name -> profile key it was opened in
let seq = 0;

/* ----------------------------------------------------------------- token */

/* One token per machine, generated on first run, readable only by the user.
   The CLI reads the same file: no configuration, no secret in the process list. */
function loadToken() {
  const dir = process.env.BEAM_HOME || path.join(os.homedir(), '.beam');
  const file = path.join(dir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch (e) { /* first run */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

const TOKEN = loadToken();

function authorized(req) {
  /* A browser labels every page-initiated request: an Origin on anything that
     can carry one, and Sec-Fetch-Site on all of them. Neither can be forged by
     a script, and the CLI sends neither — so a document-initiated request is
     refused before the token is even compared. (Sec-Fetch-Mode is not checked:
     Node's own fetch() sends `cors`.) */
  if (req.headers.origin) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'none') return false;
  const got = String(req.headers['x-beam-token'] || '');
  if (got.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

/* ------------------------------------------------------------- websocket */

function wsSend(socket, data, opcode = 1) {
  const payload = Buffer.from(data);
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  socket.write(Buffer.concat([head, payload]));
}

function attachWs(socket) {
  let buf = Buffer.alloc(0);
  let frag = [];
  let identified = false;
  const helloTimer = setTimeout(() => {
    if (!identified) socket.destroy();
  }, 3000);

  function onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!identified) {
      if (msg.type !== 'hello') return;
      identified = true;
      clearTimeout(helloTimer);
      adopt(socket, msg.info || {});
      return;
    }
    const conn = connOf(socket);
    if (msg.type === 'hello') {
      /* the person renamed the profile in the panel; the key stays */
      if (conn) { Object.assign(conn.info, msg.info || {}); conn.alive = true; }
      return;
    }
    if (msg.id && pending.has(msg.id) && conn && pending.get(msg.id).conn === conn) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.slice(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.slice(off + len);

      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) { wsSend(socket, payload, 10); continue; }
      if (opcode === 10) { const c = connOf(socket); if (c) c.alive = true; continue; }
      if (opcode === 0) {
        frag.push(payload);
        if (fin) { onMessage(Buffer.concat(frag).toString('utf8')); frag = []; }
        continue;
      }
      if (!fin) { frag = [payload]; continue; }
      onMessage(payload.toString('utf8'));
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(helloTimer);
    const c = connOf(socket);
    if (c) drop(c, 'the extension closed the connection');
  });
}

function connOf(socket) {
  for (const c of conns.values()) if (c.sock === socket) return c;
  return null;
}

/* Extensions older than profiles send no profileId: their runtime id stands in. */
const keyOf = (info) => String(info.profileId || info.id || '');
const nameOf = (c) => String(c.info.profile || '').trim();
const label = (c) => nameOf(c) || (c.key ? '#' + c.key : 'chrome');

/* Same key is a service-worker restart: the new socket takes the slot, keeps
   its place in the order, and whatever was waiting on the old one fails now
   instead of timing out (the extension answers on the socket a command came
   in on). Put the new socket in before ending the old: a sync 'close' would
   otherwise drop it. */
function adopt(socket, info) {
  const key = keyOf(info);
  const old = conns.get(key);
  const conn = { key, sock: socket, info: Object.assign({}, info), alive: true, since: old ? old.since : Date.now() };
  conns.set(key, conn);
  if (old && old.sock !== socket) {
    failPending(old, 'the extension reconnected while the command was running');
    try { old.sock.end(); } catch (e) {}
  }
}

function failPending(conn, why) {
  for (const [id, p] of pending) {
    if (p.conn !== conn) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ ok: false, error: why });
  }
}

/* A half-open socket — the browser was force-quit, the machine slept, the
   service worker died without a FIN — used to sit here forever, and every
   command would wait out its full timeout. Now it is dropped and whatever was
   in flight fails immediately, with an error that says what to do. */
function drop(conn, why) {
  try { conn.sock.destroy(); } catch (e) {}
  if (conns.get(conn.key) === conn) conns.delete(conn.key);
  failPending(conn, why + ': open the Beam panel in Chrome and press Reconnect');
}

function live() {
  for (const c of [...conns.values()]) {
    if (c.sock.destroyed || !c.sock.writable) drop(c, 'the connection to the extension died');
  }
  return [...conns.values()].sort((a, b) => a.since - b.since);
}

const NOT_CONNECTED = 'extension not connected: open Chrome and check that Beam is enabled in chrome://extensions';

/* A name the person gave in the panel (any case), or the id `beam profiles` prints. */
function find(want) {
  const all = live();
  const w = String(want).trim().replace(/^#/, '');
  const lw = w.toLowerCase();
  const byKey = all.filter((c) => c.key === w);
  if (byKey.length) return { conn: byKey[0] };
  const byName = all.filter((c) => nameOf(c).toLowerCase() === lw);
  if (byName.length === 1) return { conn: byName[0] };
  if (byName.length > 1) {
    return { error: byName.length + ' connected profiles are named "' + w + '": rename one in the Beam panel, ' +
      'or pass its id (' + byName.map((c) => '#' + c.key).join(', ') + ')' };
  }
  return { error: 'no connected Chrome profile is named "' + w + '"' +
    (all.length ? ' (connected: ' + all.map(label).join(', ') + ')' : '') +
    '. Open Chrome on that profile, enable Beam there, and give the profile that name in the Beam panel' };
}

/* explicit profile, else the session's, else the first one connected */
function route(cmd) {
  const session = cmd.session != null && cmd.session !== '' ? String(cmd.session) : 'default';
  if (cmd.profile != null && cmd.profile !== '' && cmd.profile !== true) {
    const r = find(cmd.profile);
    if (r.conn) bound.set(session, r.conn.key);
    return r;
  }
  const all = live();
  if (bound.has(session) && cmd.op !== 'sessions') {
    const c = conns.get(bound.get(session));
    if (c && all.includes(c)) return { conn: c };
    return { error: 'session ' + session + ' was opened in the Chrome profile ' + bound.get(session) +
      ', which is no longer connected: reopen that profile, or `beam end` the session' };
  }
  if (!all.length) return { error: NOT_CONNECTED };
  return { conn: all[0] };
}

function send(conn, cmd, timeoutMs) {
  return new Promise((resolve) => {
    if (conn.sock.destroyed || !conn.sock.writable) drop(conn, 'the connection to the extension died');
    if (conns.get(conn.key) !== conn) return resolve({ ok: false, error: NOT_CONNECTED });
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'the extension is connected but did not answer within ' + timeoutMs +
        'ms. If it keeps happening, check that only one copy of Beam is loaded in chrome://extensions' });
    }, timeoutMs);
    pending.set(id, { resolve, timer, conn });
    const out = Object.assign({}, cmd, { id });
    delete out.profile;
    try { wsSend(conn.sock, JSON.stringify(out)); }
    catch (e) {
      clearTimeout(timer); pending.delete(id);
      resolve({ ok: false, error: String(e) });
    }
  });
}

function profiles() {
  const all = live();
  return all.map((c, i) => ({
    profile: nameOf(c), id: c.key, label: label(c), default: i === 0,
    extension: c.info.id || '', version: c.info.version || '', since: c.since,
    sessions: [...bound].filter(([, k]) => k === c.key).map(([s]) => s)
  }));
}

/* `beam sessions` with no profile named lists every profile's */
async function sessionsEverywhere(cmd, timeoutMs) {
  const all = live();
  if (!all.length) return { ok: false, error: NOT_CONNECTED };
  const out = [];
  const errors = [];
  for (const c of all) {
    const r = await send(c, cmd, timeoutMs);
    if (r.ok && Array.isArray(r.result)) for (const s of r.result) out.push(Object.assign({ profile: label(c) }, s));
    else if (!r.ok) errors.push(label(c) + ': ' + r.error);
  }
  if (!out.length && errors.length) return { ok: false, error: errors.join('; ') };
  return { ok: true, result: out };
}

async function dispatch(cmd) {
  const timeoutMs = cmd.timeout || 30000;
  if (cmd.op === 'profiles') return { ok: true, result: profiles() };
  const explicit = cmd.profile != null && cmd.profile !== '' && cmd.profile !== true;
  if (cmd.op === 'sessions' && !explicit && live().length > 1) return sessionsEverywhere(cmd, timeoutMs);
  const r = route(cmd);
  if (!r.conn) return { ok: false, error: r.error };
  const out = await send(r.conn, cmd, timeoutMs);
  if (cmd.op === 'end') bound.delete(cmd.session != null && cmd.session !== '' ? String(cmd.session) : 'default');
  return out;
}

/* ------------------------------------------------------------------ http */

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
  res.end(b);
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

  if (req.url === '/health') {
    const all = live();
    return json(res, 200, { ok: true, version: VERSION, connected: all.length > 0, browser: all.length ? all[0].info : null,
      profiles: profiles(), pid: process.pid, port: PORT });
  }
  if (req.method !== 'POST' || req.url !== '/cmd') return json(res, 404, { ok: false, error: 'not found' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
  req.on('end', async () => {
    let cmd;
    try { cmd = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: 'invalid json' }); }
    json(res, 200, await dispatch(cmd));
  });
});

/* Only the extension may take this socket. Chrome sends the extension's own
   origin on the handshake; a page would send its site's origin, or none. */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const origin = String(req.headers.origin || '');
  const wanted = EXT_ID ? 'chrome-extension://' + EXT_ID : 'chrome-extension://';
  if (!key || origin.indexOf(wanted) !== 0) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  attachWs(socket);
});

/* Keepalive, two jobs: every message resets the MV3 service worker idle timer,
   and a ping that goes unanswered twice in a row means the socket is dead. */
const PING_MS = Number(process.env.BEAM_PING_MS || 15000);
setInterval(() => {
  for (const c of [...conns.values()]) {
    if (!c.alive) { drop(c, 'the extension stopped answering'); continue; }
    c.alive = false;
    try { wsSend(c.sock, '', 9); } catch (e) { drop(c, 'the connection to the extension died'); }
  }
}, PING_MS);

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('beam server on 127.0.0.1:' + PORT + '\n');
});
server.on('error', (e) => {
  process.stderr.write('beam server: ' + e.message + '\n');
  process.exit(1);
});
