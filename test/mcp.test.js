/* beam-mcp end to end: a real hub, a fake extension behind it, and the MCP
 * server spoken to over stdio the way Claude Desktop or Cursor would. Checks
 * the handshake, the tool list, that a tool call becomes the right command
 * (session included), that a screenshot comes back as an image, and that the
 * setup commands stay out of reach. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 9000 + ((process.pid + 400) % 900);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-mcp-test-'));
const ENV = Object.assign({}, process.env, { BEAM_PORT: String(PORT), BEAM_HOME: HOME });
delete ENV.BEAM_SESSION;
delete ENV.CLAUDE_CODE_SESSION_ID;
delete ENV.CURSOR_CONVERSATION_ID;

let fail = 0;
const ok = (name, cond, extra) => {
  if (!cond) fail++;
  console.log((cond ? '✓ ' : '✗ ') + name + (extra ? '  ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env: ENV, stdio: 'ignore' });
let mcp = null;
const done = (code) => {
  try { hub.kill(); } catch (e) {}
  try { mcp && mcp.kill(); } catch (e) {}
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(code);
};
process.on('uncaughtException', (e) => { console.log('✗ ' + e.message); done(1); });

/* ------------------------------------------------------- fake extension */

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

/* a 1x1 jpeg */
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const seen = [];

function connectExtension() {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': 13
      }
    });
    req.on('upgrade', (res, socket) => {
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
          const cmd = JSON.parse(payload);
          seen.push(cmd);
          let result;
          if (cmd.op === 'snap') result = { title: 'T', url: 'https://x.test/', elements: 1, outline: '@0 button "Go"' };
          else if (cmd.op === 'shot') {
            result = { dataUrl: 'data:image/jpeg;base64,' + JPEG, bytes: JPEG.length };
          } else if (cmd.op === 'set') {
            result = { dry: true, resolved: 1, errors: [], changes: [{ target: 'label=Title', label: 'Title', changed: true, from: '', to: cmd.map['label=Title'] }] };
          } else result = { ok: true };
          sendMasked(socket, JSON.stringify({ id: cmd.id, ok: true, result }));
        }
      });
      sendMasked(socket, JSON.stringify({ type: 'hello', info: { ua: 'mcp.test' } }));
      resolve(socket);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/* --------------------------------------------------------------- client */

let nextId = 1;
const waiting = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, 15000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
const callTool = (name, args) => rpc('tools/call', { name, arguments: args });

(async () => {
  await sleep(600);
  if (!(await connectExtension())) { ok('fake extension connects', false); return done(1); }
  await sleep(200);

  mcp = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'beam-mcp')], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  mcp.stdout.on('data', (c) => {
    out += c;
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl); out = out.slice(nl + 1);
      const m = JSON.parse(line);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  ok('initialize answers with the protocol asked for', init.result && init.result.protocolVersion === '2025-06-18');
  ok('initialize carries the working rules', /ask the user before saving/.test(init.result.instructions || ''));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const old = await rpc('initialize', { protocolVersion: '1999-01-01' });
  ok('an unknown protocol gets the newest one supported', old.result.protocolVersion === '2025-06-18');

  const list = await rpc('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name);
  ok('tools/list has the page tools', ['beam_open', 'beam_snap', 'beam_set', 'beam_shot', 'beam_command']
    .every((n) => names.indexOf(n) >= 0), names.length + ' tools');
  ok('every tool has an object schema', list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  const snap = await callTool('beam_snap', { sel: 'main', hidden: true });
  ok('beam_snap returns the CLI text', snap.result && /@0 button "Go"/.test(snap.result.content[0].text));
  const sc = seen.find((c) => c.op === 'snap');
  ok('a tool call becomes the command, flags included', sc && sc.sel === 'main' && sc.hidden === true);
  ok('the window is named `mcp`, not the default one', sc && sc.session === 'mcp', sc && sc.session);

  const set = await callTool('beam_set', { map: { 'label=Title': "it's here" }, dry: true });
  const setc = seen.find((c) => c.op === 'set');
  ok('beam_set passes the map intact (apostrophes too), and --dry',
    !set.result.isError && setc && setc.map['label=Title'] === "it's here" && setc.dry === true);

  const shot = await callTool('beam_shot', {});
  const img = shot.result && shot.result.content.find((c) => c.type === 'image');
  ok('beam_shot returns an image', img && img.mimeType === 'image/jpeg' && img.data === JPEG);
  ok('the screenshot file is not left behind', !fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('beam-mcp-' + mcp.pid)));

  const nav = await callTool('beam_command', { args: ['nav', 'https://x.test/b'] });
  ok('beam_command runs any page command', !nav.result.isError && seen.some((c) => c.op === 'nav' && c.url === 'https://x.test/b'));

  /* pipelined: sent together, they must still reach the page in order */
  const before = seen.length;
  await Promise.all(['1', '2', '3', '4'].map((n) => callTool('beam_command', { args: ['nav', 'https://x.test/' + n] })));
  const navs = seen.slice(before).filter((c) => c.op === 'nav').map((c) => c.url.slice(-1)).join('');
  ok('pipelined calls run one at a time, in order', navs === '1234', navs);

  const setup = await callTool('beam_command', { args: ['server', '--stop'] });
  ok('setup commands are out of reach', setup.result.isError === true && /terminal/.test(setup.result.content[0].text));

  const bad = await callTool('beam_command', { args: [] });
  ok('an empty argument list is refused', bad.result.isError === true);

  const unknown = await callTool('beam_nope', {});
  ok('an unknown tool is a JSON-RPC error', unknown.error && unknown.error.code === -32602);

  const nomethod = await rpc('resources/list', {});
  ok('an unknown method is a JSON-RPC error', nomethod.error && nomethod.error.code === -32601);

  console.log(fail ? '\n' + fail + ' tests failed' : '\nall tests passed');
  done(fail ? 1 : 0);
})();
