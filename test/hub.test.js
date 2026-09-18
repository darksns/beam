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

function upgrade(headers) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/',
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

/* the extension side of the socket: answers every command with a payload of
   the requested size, so the server's framing is exercised at every width */
function beExtension(socket) {
  function send(str) {
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
      if (opcode !== 1) continue;             // ping/pong/close: nothing to do
      const msg = JSON.parse(payload);
      const size = msg.op === 'big' ? 200000 : msg.op === 'mid' ? 1000 : 10;
      send(JSON.stringify({ id: msg.id, ok: true, result: { echo: msg.op, size, data: 'x'.repeat(size) } }));
    }
  });

  send(JSON.stringify({ type: 'hello', info: { ua: 'hub.test' } }));
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
