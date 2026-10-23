/* The idle reaper and `end`: a session window nobody drives is closed, and
   only the tab Beam opened for it. background.js runs in a vm against a fake
   chrome. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fail = 0;
const ok = (name, cond) => {
  if (!cond) fail++;
  console.log((cond ? '✓ ' : '✗ ') + name);
};

const tabs = new Map();
const removed = [];
let focused = null;
const store = {};

const event = () => ({ addListener() {}, removeListener() {} });
const chrome = {
  runtime: { id: 'test', getManifest: () => ({ version: '0' }), reload() {},
    onStartup: event(), onInstalled: event(), onMessage: event() },
  alarms: { create() {}, get: async () => ({ name: 'beam-keepalive' }), onAlarm: event() },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  permissions: { onAdded: event(), onRemoved: event(), contains: async () => false },
  storage: {
    session: {
      get: async (keys) => {
        const out = {};
        for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
        return out;
      },
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
    },
    local: { get: async () => ({}), set: async () => {} }
  },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
      return tabs.get(id);
    },
    remove: async (id) => { removed.push(id); tabs.delete(id); },
    query: async () => [...tabs.values()],
    onUpdated: event(), onRemoved: event()
  },
  windows: {
    get: async (id) => ({ id }),
    getLastFocused: async () => (focused == null ? null : { id: focused })
  },
  webRequest: { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event(), onBeforeSendHeaders: event() }
};

class FakeSocket { constructor() {} send() {} close() {} }

const ctx = vm.createContext({
  chrome, WebSocket: FakeSocket, navigator: { userAgent: 'test' },
  setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Promise, JSON, Math, Object, Error, Map
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), ctx);

const run = (code) => vm.runInContext(code, ctx);
const settle = () => new Promise((r) => setTimeout(r, 50));
const MIN = 60 * 1000;

(async () => {
  await run('bindReady');
  const now = Date.now();
  tabs.set(10, { id: 10, windowId: 1, url: 'https://a.test/' });
  tabs.set(20, { id: 20, windowId: 2, url: 'https://b.test/' });
  tabs.set(30, { id: 30, windowId: 3, url: 'https://c.test/' });
  tabs.set(40, { id: 40, windowId: 9, url: 'https://mine.test/' });
  focused = 3;
  ctx.seed = {
    idle: { curTab: 10, curUrl: 'https://a.test/', beamWindow: 1, beamTab: 10, lastUsed: now - 11 * MIN },
    busy: { curTab: 20, curUrl: 'https://b.test/', beamWindow: 2, beamTab: 20, lastUsed: now - 2 * MIN },
    looked: { curTab: 30, curUrl: 'https://c.test/', beamWindow: 3, beamTab: 30, lastUsed: now - 30 * MIN },
    used: { curTab: 40, curUrl: 'https://mine.test/', beamWindow: null, beamTab: null, lastUsed: now - 30 * MIN }
  };
  run('sessions = seed');

  await run('reapIdle()');
  await settle();
  const names = () => Object.keys(run('sessions')).sort().join(',');
  ok('an idle session loses the tab Beam opened', removed.join(',') === '10');
  ok('an idle session is forgotten', !('idle' in run('sessions')));
  ok('a session used 2 minutes ago keeps its window', 'busy' in run('sessions') && tabs.has(20));
  ok('the window the person last focused stays', 'looked' in run('sessions') && tabs.has(30));
  ok('a tab bound with use is never closed', 'used' in run('sessions') && tabs.has(40));
  ok('the forgotten session is persisted', !('idle' in store.beamSessions));
  ok('the other sessions are untouched', names() === 'busy,looked,used');

  const before = run('sessions.used.lastUsed');
  await run("dispatch({ op: 'tabs', session: 'used' })");
  ok('a command counts as use', run('sessions.used.lastUsed') > before);

  ctx.seed = await run("dispatch({ op: 'end', session: 'busy' })");
  ok('end closes the session tab', ctx.seed.ended === true && ctx.seed.closed === 20 && !tabs.has(20));
  ok('end forgets the session', !('busy' in run('sessions')));

  ctx.seed = await run("dispatch({ op: 'end', session: 'used' })");
  ok('end on a use-only session unbinds without closing', ctx.seed.ended === true && ctx.seed.closed === null && tabs.has(40));

  ctx.seed = await run("dispatch({ op: 'end', session: 'nobody' })");
  ok('end on an unknown session says so', ctx.seed.ended === false && !('nobody' in run('sessions')));

  /* a command queued ahead of the reaper counts as use */
  tabs.set(50, { id: 50, windowId: 5, url: 'https://d.test/' });
  focused = 7;
  ctx.seed = { late: { curTab: 50, curUrl: 'https://d.test/', beamWindow: 5, beamTab: 50, lastUsed: Date.now() - 20 * MIN } };
  run('sessions = Object.assign(sessions, seed)');
  const cmd = run("lane('late', () => dispatch({ op: 'info', session: 'late' }).catch(() => {}))");
  await run('reapIdle()');
  await cmd;
  await settle();
  ok('a command ahead of the reaper keeps the window', tabs.has(50) && 'late' in run('sessions'));

  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
