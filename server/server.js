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
 *                     stream. Pin a single extension with BEAM_EXTENSION_ID.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.BEAM_PORT || 8777);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const EXT_ID = process.env.BEAM_EXTENSION_ID || '';

let sock = null;            // the extension's socket
let sockInfo = null;
const pending = new Map();  // id -> {resolve, timer}
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
      if (opcode === 10) continue;
      if (opcode === 0) {
        frag.push(payload);
        if (fin) { handle(Buffer.concat(frag).toString('utf8')); frag = []; }
        continue;
      }
      if (!fin) { frag = [payload]; continue; }
      handle(payload.toString('utf8'));
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => { if (sock === socket) { sock = null; sockInfo = null; } });
}

function handle(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.type === 'hello') { sockInfo = msg.info || {}; return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }
}

function send(cmd, timeoutMs) {
  return new Promise((resolve) => {
    if (!sock) return resolve({ ok: false, error: 'extension not connected: open Chrome and check that Beam is enabled in chrome://extensions' });
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'timed out after ' + timeoutMs + 'ms' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { wsSend(sock, JSON.stringify(Object.assign({}, cmd, { id }))); }
    catch (e) {
      clearTimeout(timer); pending.delete(id);
      resolve({ ok: false, error: String(e) });
    }
  });
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
    return json(res, 200, { ok: true, connected: !!sock, browser: sockInfo, pid: process.pid, port: PORT });
  }
  if (req.method !== 'POST' || req.url !== '/cmd') return json(res, 404, { ok: false, error: 'not found' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
  req.on('end', async () => {
    let cmd;
    try { cmd = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: 'invalid json' }); }
    const out = await send(cmd, cmd.timeout || 30000);
    json(res, 200, out);
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
  if (sock) { try { sock.end(); } catch (e) {} }
  sock = socket;
  attachWs(socket);
});

/* keepalive: every message resets the MV3 service worker idle timer */
setInterval(() => { if (sock) { try { wsSend(sock, '', 9); } catch (e) {} } }, 15000);

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('beam server on 127.0.0.1:' + PORT + '\n');
});
server.on('error', (e) => {
  process.stderr.write('beam server: ' + e.message + '\n');
  process.exit(1);
});
