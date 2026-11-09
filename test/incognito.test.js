/* `open --incognito`: the session window is an Incognito one, the session
   stays Incognito until it ends, and nothing opens when Chrome has not let
   Beam into Incognito. background.js runs in a vm against a fake chrome. */
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
const wins = new Map();
const created = [];
const removed = [];
const store = {};
let allowed = false;
let honour = true;          // does Chrome give the Incognito window it was asked for
let nextId = 100;

const event = () => ({ addListener() {}, removeListener() {} });
const chrome = {
  runtime: { id: 'test', getManifest: () => ({ version: '0' }), reload() {},
    onStartup: event(), onInstalled: event(), onMessage: event() },
  extension: { isAllowedIncognitoAccess: async () => allowed },
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
    create: async (o) => {
      const w = wins.get(o.windowId);
      const t = { id: nextId++, windowId: o.windowId, url: o.url, active: true, status: 'complete', incognito: w.incognito };
      tabs.set(t.id, t);
      return t;
    },
    update: async (id, o) => Object.assign(tabs.get(id), o),
    remove: async (id) => { removed.push(id); tabs.delete(id); },
    query: async (q) => [...tabs.values()].filter((t) => !q || q.windowId == null || t.windowId === q.windowId),
    onUpdated: event(), onRemoved: event()
  },
  windows: {
    get: async (id) => {
      if (!wins.has(id)) throw new Error('No window with id: ' + id);
      return wins.get(id);
    },
    create: async (spec) => {
      created.push(spec);
      const w = { id: nextId++, incognito: !!spec.incognito && honour };
      const t = { id: nextId++, windowId: w.id, url: spec.url, active: true, status: 'complete', incognito: w.incognito };
      wins.set(w.id, w);
      tabs.set(t.id, t);
      return Object.assign({ tabs: [t] }, w);
    },
    remove: async (id) => { wins.delete(id); for (const [k, t] of tabs) if (t.windowId === id) tabs.delete(k); },
    update: async () => {},
    getLastFocused: async () => null
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
const open = (extra) => run(`dispatch(Object.assign({ op: 'open', url: 'https://a.test/' }, ${JSON.stringify(extra || {})}))`);
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  await run('bindReady');

  /* not allowed: nothing opens */
  let err = await fails(() => open({ session: 'x', incognito: true }));
  ok('refused while Chrome keeps Beam out of Incognito', /Allow in Incognito/.test(err || ''));
  ok('nothing opens when refused', created.length === 0);

  /* a normal session first, then it turns Incognito */
  let r = await open({ session: 'x' });
  ok('a plain open is a normal window', r.incognito === false && created[0].incognito === undefined);
  const normalTab = r.tab;

  err = await fails(() => open({ session: 'x', incognito: true }));
  ok('turning Incognito is refused too while not allowed', /Allow in Incognito/.test(err || ''));
  ok('the normal tab survives the refusal', tabs.has(normalTab));

  allowed = true;
  r = await open({ session: 'x', incognito: true });
  ok('--incognito opens an Incognito window', r.incognito === true && created[created.length - 1].incognito === true);
  ok('the normal tab Beam opened is closed', removed.includes(normalTab));
  ok('the session is bound to the Incognito tab', run('sessions.x.curTab') === r.tab);
  ok('the mode is persisted', store.beamSessions.x.incognito === true);
  const incTab = r.tab;

  r = await open({ session: 'x', url: 'https://b.test/' });
  ok('a later open without the flag reuses the Incognito tab', r.tab === incTab && r.reused === true && r.incognito === true);

  const before = created.length;
  r = await open({ session: 'x', new: true });
  ok('--new adds a tab to the same Incognito window', created.length === before && r.incognito === true && r.tab !== incTab);

  const rows = await run("dispatch({ op: 'sessions', session: 'x' })");
  ok('sessions marks it Incognito', rows.length === 1 && rows[0].incognito === true);

  await run("dispatch({ op: 'end', session: 'x' })");
  r = await open({ session: 'x' });
  ok('after end the session is normal again', r.incognito === false);

  /* Chrome hands back a normal window: never use it */
  honour = false;
  const tabsBefore = tabs.size;
  err = await fails(() => open({ session: 'y', incognito: true }));
  ok('a normal window given for Incognito is refused', /Allow in Incognito/.test(err || ''));
  ok('and that window is closed again', tabs.size === tabsBefore && !run("sessions.y && sessions.y.beamTab"));

  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
