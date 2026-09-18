/* Starts a real hub, pretends to be the extension, and checks the WebSocket
 * handshake, the frame sizes (7/16/64-bit lengths) and the two locks on the
 * door: the token on /cmd, the chrome-extension:// origin on the upgrade. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.BEAM_PORT || (9000 + (process.pid % 900)));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FAKE_EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let fail = 0;
const ok = (name, cond, extra) => {
  if (!cond) fail++;
  console.log((cond ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''));
};

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  env: Object.assign({}, process.env, { BEAM_PORT: String(PORT), BEAM_HOME: HOME }),
  stdio: 'ignore'
});

const done = (code) => { try { server.kill(); } catch (e) {} fs.rmSync(HOME, { recursive: true, force: true }); process.exit(code); };
process.on('uncaughtException', (e) => { console.log('✗ ' + e.message); done(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST', headers },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(body);
  });
}

function upgrade(headers, destPort) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: destPort || PORT, path: '/',
      headers: Object.assign({
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13
      }, headers)
    });
    req.on('upgrade', (res, socket) => resolve({ socket, key, res }));
    req.on('error', () => resolve(null));
    req.on('response', () => resolve(null));
    req.end();
    setTimeout(() => resolve(null), 1500);
  });
}

function sendMasked(socket, str) {
  const p = Buffer.from(str);
  const mask = crypto.randomBytes(4);
  let head;
  if (p.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | p.length; }
  else if (p.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
  head[0] = 0x81;
  const masked = Buffer.from(p);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  socket.write(Buffer.concat([head, mask, masked]));
}

function readText(socket, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.removeListener('data', onData); resolve(null); }, timeout || 800);
    let buf = Buffer.alloc(0);
    function onData(c) {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf[1] & 0x80) off += 4;
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len).toString();
        buf = buf.slice(off + len);
        if (opcode === 9 || opcode === 10) continue;
        clearTimeout(t);
        socket.removeListener('data', onData);
        resolve(opcode === 1 ? payload : null);
        return;
      }
    }
    socket.on('data', onData);
  });
}

function beExtension(socket) {
  let buf = Buffer.alloc(0);
  socket.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString();
      buf = buf.slice(off + len);
      if (opcode !== 1) continue;
      const msg = JSON.parse(payload);
      const size = msg.op === 'big' ? 200000 : msg.op === 'mid' ? 1000 : 10;
      sendMasked(socket, JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.op, size, data: 'x'.repeat(size) } }));
    }
  });

  sendMasked(socket, JSON.stringify({ type: 'hello', info: { ua: 'hub.test' } }));
}

(async () => {
  await sleep(600);
  const token = fs.readFileSync(path.join(HOME, 'token'), 'utf8').trim();
  ok('the hub generates a token on first run', token.length >= 32, token.length + ' chars');
  ok('the token file is readable by its owner only',
    (fs.statSync(path.join(HOME, 'token')).mode & 0o077) === 0, 'mode 600');

  /* --- the door: what a web page would send ------------------------------ */
  const noToken = await post('{"op":"snap"}', { 'content-type': 'application/json' });
  ok('POST /cmd without a token is refused', noToken.status === 401, 'HTTP ' + noToken.status);

  const fromPage = await post('{"op":"snap"}', {
    'content-type': 'text/plain', 'x-beam-token': token,
    Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors'
  });
  ok('POST /cmd from a web page is refused even with a token', fromPage.status === 401, 'HTTP ' + fromPage.status);

  const sameSite = await post('{"op":"snap"}', {
    'x-beam-token': token, 'Sec-Fetch-Site': 'same-origin'
  });
  ok('POST /cmd labelled by a browser is refused', sameSite.status === 401, 'HTTP ' + sameSite.status);

  const wrong = await post('{"op":"snap"}', { 'x-beam-token': 'f'.repeat(token.length) });
  ok('POST /cmd with the wrong token is refused', wrong.status === 401, 'HTTP ' + wrong.status);

  /* Node's fetch() sends `Sec-Fetch-Mode: cors` on its own: the CLI must still
     get through. This is exactly what a too-eager check once broke. */
  const nodeLike = await post('{"op":"snap"}', {
    'content-type': 'application/json', 'x-beam-token': token,
    accept: '*/*', 'sec-fetch-mode': 'cors'
  });
  ok('the CLI (Node fetch) is let through', nodeLike.status !== 401, 'HTTP ' + nodeLike.status);

  const pageSocket = await upgrade({ Origin: 'https://evil.example' });
  ok('a page cannot take the extension socket', pageSocket === null);

  /* --- the extension ------------------------------------------------------ */
  const up = await upgrade({ Origin: FAKE_EXT });
  if (!up) { ok('the extension can open the socket', false); return done(1); }
  const expect = crypto.createHash('sha1').update(up.key + GUID).digest('base64');
  ok('handshake accept is correct', up.res.headers['sec-websocket-accept'] === expect);
  beExtension(up.socket);
  await sleep(300);

  const health = await post('', { 'x-beam-token': token });   // 404, but authorized
  ok('an authorized request gets through', health.status !== 401, 'HTTP ' + health.status);

  for (const [op, size] of [['snap', 10], ['mid', 1000], ['big', 200000]]) {
    const r = await post(JSON.stringify({ op }), { 'content-type': 'application/json', 'x-beam-token': token });
    let parsed = {};
    try { parsed = JSON.parse(r.body); } catch (e) {}
    ok('round trip with a ' + size + " byte payload",
      parsed.ok === true && parsed.result && parsed.result.data.length === size,
      parsed.result ? parsed.result.data.length + ' bytes back' : r.body.slice(0, 80));
  }

  /* leftover copy: last-wins, the old socket is told so it stops retrying */
  const PORT3 = PORT + 2;
  const HOME3 = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));
  const hub3 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { BEAM_PORT: String(PORT3), BEAM_HOME: HOME3, BEAM_PING_MS: '30000' }),
    stdio: 'ignore'
  });
  await sleep(600);
  const a = await upgrade({ Origin: FAKE_EXT }, PORT3);
  const bWait = a && a.socket ? readText(a.socket, 1200) : Promise.resolve(null);
  if (a) sendMasked(a.socket, JSON.stringify({ type: 'hello', info: { id: 'ext-a' } }));
  await sleep(150);
  const b = await upgrade({ Origin: FAKE_EXT }, PORT3);
  if (b) sendMasked(b.socket, JSON.stringify({ type: 'hello', info: { id: 'ext-b' } }));
  const replacedRaw = await bWait;
  let replaced = {};
  try { replaced = JSON.parse(replacedRaw || ''); } catch (e) {}
  ok('a leftover copy is told it was replaced',
    replaced.type === 'replaced' && replaced.by === 'ext-b',
    replacedRaw ? replacedRaw.slice(0, 80) : 'no frame');

  const silentP = b && b.socket ? readText(b.socket, 400) : Promise.resolve('missing');
  const c = await upgrade({ Origin: FAKE_EXT }, PORT3);
  if (c) sendMasked(c.socket, JSON.stringify({ type: 'hello', info: { id: 'ext-b' } }));
  const silent = await silentP;
  let silentMsg = null;
  try { silentMsg = silent && JSON.parse(silent); } catch (e) {}
  ok('a service-worker restart with the same id is silent',
    !silentMsg || silentMsg.type !== 'replaced',
    silent == null ? 'close/empty' : String(silent).slice(0, 60));
  try { hub3.kill(); } catch (e) {}
  fs.rmSync(HOME3, { recursive: true, force: true });

  /* a socket that stops answering must be dropped, not waited on: this is what
     turned a dead service worker into a 30-second timeout on every command */
  const PORT2 = PORT + 1;
  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-test-'));
  const hub2 = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { BEAM_PORT: String(PORT2), BEAM_HOME: HOME2, BEAM_PING_MS: '150' }),
    stdio: 'ignore'
  });
  await sleep(600);
  const token2 = fs.readFileSync(path.join(HOME2, 'token'), 'utf8').trim();
  const mute = await new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const r = http.request({
      host: '127.0.0.1', port: PORT2, path: '/',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key,
                 'Sec-WebSocket-Version': 13, Origin: FAKE_EXT }
    });
    r.on('upgrade', (res, socket) => resolve(socket));
    r.on('error', () => resolve(null));
    r.end();
  });
  /* it says hello, then never answers another frame — a half-open socket */
  if (mute) mute.write(Buffer.from([0x81, 0x1e, ...Buffer.from('{"type":"hello","info":{"ua":"x"}}').subarray(0, 30)]));
  await sleep(700);
  const started = Date.now();
  const dead = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT2, path: '/cmd', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beam-token': token2 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); });
    req.on('error', () => resolve(''));
    req.end('{"op":"snap"}');
  });
  const took = Date.now() - started;
  let parsedDead = {};
  try { parsedDead = JSON.parse(dead); } catch (e) {}
  ok('a silent socket is dropped instead of timing out',
    parsedDead.ok === false && /not connected|stopped answering/.test(parsedDead.error || '') && took < 3000,
    took + 'ms · ' + (parsedDead.error || dead).slice(0, 60));
  try { hub2.kill(); } catch (e) {}
  fs.rmSync(HOME2, { recursive: true, force: true });

  /* the real CLI against the real hub: the one path the unit tests cannot see */
  const cli = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'beam'), 'server'], {
    env: Object.assign({}, process.env, { BEAM_PORT: String(PORT), BEAM_HOME: HOME })
  });
  let out = '';
  cli.stdout.on('data', (c) => { out += c; });
  cli.stderr.on('data', (c) => { out += c; });
  await new Promise((r) => cli.on('close', r));
  let status = {};
  try { status = JSON.parse(out); } catch (e) {}
  ok('`beam server` talks to the hub it started', status.ok === true && status.port === PORT, out.trim().slice(0, 120));

  console.log(fail ? '\n' + fail + ' tests failed' : '\nall tests passed');
  done(fail ? 1 : 0);
})();
