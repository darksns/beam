/* Beam — service worker: holds the WebSocket to the local hub and turns
 * commands into tab operations / agent injections. */

const DEFAULT_PORT = 8777;

let port = DEFAULT_PORT;
let ws = null;
let connecting = false;
/* One slot per BEAM_SESSION. `default` is every command that names no session,
   so a single agent keeps the old one-window behaviour. */
let sessions = {};
let retry = 0;
let superseded = false; // another copy of the extension took the hub socket

/* Ring of connection events. Session, not memory: the service worker dies and
   takes `ws` with it, and the next one would otherwise have nothing to show. */
const LOG_MAX = 60;
let dbgLog = [];
let workerStarts = 0;
let workerAt = 0;
let lastOpenAt = 0;
let helloSentAt = 0;
let lastClose = null;
let dbgQueued = false;
let debugRestored = false;

function note(event, extra) {
  /* A note that arrives while the previous worker's log is still loading would
     be wiped by the restore. Queue it until that restore has landed. */
  if (!debugRestored) {
    debugReady.then(() => note(event, extra));
    return;
  }
  const row = Object.assign({ t: Date.now(), event }, extra || {});
  dbgLog.push(row);
  if (dbgLog.length > LOG_MAX) dbgLog.splice(0, dbgLog.length - LOG_MAX);
  if (dbgQueued || !chrome.storage.session) return;
  dbgQueued = true;
  setTimeout(() => {
    dbgQueued = false;
    chrome.storage.session.set({
      beamDebug: { log: dbgLog, workerStarts, workerAt, lastOpenAt, helloSentAt, lastClose }
    }).catch(() => {});
  }, 0);
}

const debugReady = (async () => {
  let prevAt = 0;
  try {
    if (chrome.storage.session) {
      const s = await chrome.storage.session.get('beamDebug');
      const d = s && s.beamDebug;
      if (d) {
        if (Array.isArray(d.log)) dbgLog = d.log;
        workerStarts = d.workerStarts || 0;
        prevAt = d.workerAt || 0;
        lastOpenAt = d.lastOpenAt || 0;
        helloSentAt = d.helloSentAt || 0;
        lastClose = d.lastClose || null;
      }
    }
  } catch (e) {}
  workerStarts += 1;
  workerAt = Date.now();
  debugRestored = true;
  note('worker', { n: workerStarts, gap: prevAt ? workerAt - prevAt : 0 });
})();

function noteSkip(why) {
  debugReady.then(() => {
    const last = dbgLog[dbgLog.length - 1];
    if (last && last.event === 'skip' && last.why === why) return;
    note('skip', { why });
  });
}

/* ------------------------------------------------------------ connection */

/* The hub reads BEAM_PORT; the extension cannot, so the port is stored here
   and can be changed from the popup. */
async function loadPort() {
  try {
    const s = await chrome.storage.local.get('port');
    if (s && s.port) port = Number(s.port) || DEFAULT_PORT;
  } catch (e) {}
  return port;
}

async function connect() {
  if (superseded) { noteSkip('superseded'); return; }
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;

  let socket;
  let openedAt = 0;
  try {
    await debugReady;
    if (superseded) { connecting = false; noteSkip('superseded'); return; }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      connecting = false;
      return;
    }
    await loadPort();
    note('connect', { port });
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    connecting = false;
    note('fail', { error: String(e && e.message || e) });
    return schedule();
  }
  ws = socket;
  connecting = false;

  socket.onopen = () => {
    retry = 0;
    openedAt = lastOpenAt = Date.now();
    setBadge('on');
    try {
      socket.send(JSON.stringify({
        type: 'hello',
        info: { ua: navigator.userAgent, id: chrome.runtime.id, version: chrome.runtime.getManifest().version }
      }));
      helloSentAt = Date.now();
      note('open', { hello: true });
    } catch (e) {
      note('open', { hello: false, error: String(e && e.message || e) });
    }
  };
  socket.onmessage = (ev) => {
    let cmd;
    try { cmd = JSON.parse(ev.data); } catch { return; }
    if (cmd.type === 'replaced') {
      superseded = true;
      note('replaced', { by: cmd.by || '' });
      setBadge('dup');
      try { socket.close(); } catch (e) {}
      return;
    }
    if (!cmd.id) return;
    const job = async () => {
      let out;
      try { out = { id: cmd.id, ok: true, result: await dispatch(cmd) }; }
      catch (e) { out = { id: cmd.id, ok: false, error: String(e && e.message || e) }; }
      /* answer on the socket the command came in on: a reconnect in the middle
         of a long command must not send the reply into the new one */
      try { socket.send(JSON.stringify(out)); }
      catch (e) { note('send-fail', { error: String(e && e.message || e) }); }
    };
    /* reloadext must not sit behind a navigation that is about to die with it */
    if (cmd.op === 'reloadext') { job(); return; }
    let name;
    try { name = sessionName(cmd); }
    catch (e) {
      try { socket.send(JSON.stringify({ id: cmd.id, ok: false, error: String(e && e.message || e) })); }
      catch (err) { note('send-fail', { error: String(err && err.message || err) }); }
      return;
    }
    lane(name, job).catch((e) => note('send-fail', { error: String(e && e.message || e) }));
  };
  /* Only the socket that is still the current one may reset the state. An
     older socket closing used to null a perfectly healthy connection. */
  socket.onclose = (ev) => {
    const current = ws === socket;
    note('close', {
      code: ev.code,
      clean: !!ev.wasClean,
      opened: !!openedAt,
      ms: openedAt ? Date.now() - openedAt : 0,
      current
    });
    if (!current) return;
    lastClose = { code: ev.code, at: Date.now(), opened: !!openedAt, clean: !!ev.wasClean };
    ws = null;
    if (superseded) { setBadge('dup'); return; }
    setBadge('off');
    schedule();
  };
  socket.onerror = () => {
    note('error', { opened: !!openedAt });
    try { socket.close(); } catch (e) {}
  };
}

function schedule() {
  if (superseded) return;
  retry = Math.min(retry + 1, 4);        // at most 2s between attempts
  const wait = 500 * retry;
  note('retry', { n: retry, wait });
  setTimeout(connect, wait);
}

function setBadge(state) {
  const text = state === 'on' ? '' : '!';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setTitle({
    title: state === 'on' ? 'Beam — connected'
      : state === 'dup' ? 'Beam — another copy of the extension is connected'
      : 'Beam — disconnected, click for the panel'
  });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => {
  connect();
  chrome.alarms.create('beam-keepalive', { periodInMinutes: 0.5 });
});
chrome.alarms.onAlarm.addListener(connect);
connect();

/* messages from the popup */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'status') {
    (async () => {
      await bindReady;
      const list = [];
      for (const n of Object.keys(sessions)) {
        const s = sessions[n];
        if (s.curTab == null) continue;
        try {
          const t = await chrome.tabs.get(s.curTab);
          list.push({ name: n, tab: t.id, title: t.title, url: t.url });
        } catch (e) {
          s.curTab = null;
          s.curUrl = null;
          await saveSessions();
        }
      }
      const home = list.find((row) => row.name === DEFAULT_SESSION) || null;
      await debugReady;
      reply({
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        superseded,
        port,
        version: chrome.runtime.getManifest().version,
        netLog: await netAllowed(),
        tab: home ? home.tab : null,
        tabTitle: home ? home.title : null,
        tabUrl: home ? home.url : null,
        sessions: list,
        debug: {
          id: chrome.runtime.id,
          ua: navigator.userAgent,
          readyState: ws ? ws.readyState : null,
          connecting,
          retry,
          workerStarts,
          workerAt,
          lastOpenAt,
          helloSentAt,
          lastClose,
          log: dbgLog
        }
      });
    })();
    return true;
  }
  if (msg.type === 'reconnect') {
    superseded = false;
    note('reconnect');
    try { ws && ws.close(); } catch (e) {}
    ws = null;
    connect();
    reply({ ok: true });
    return;
  }
  if (msg.type === 'unbind') {
    (async () => {
      await bindReady;
      for (const n of Object.keys(sessions)) {
        sessions[n].curTab = null;
        sessions[n].curUrl = null;
      }
      await saveSessions();
      reply({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'setport') {
    (async () => {
      port = Number(msg.port) || DEFAULT_PORT;
      await chrome.storage.local.set({ port });
      note('setport', { port });
      superseded = false;
      try { ws && ws.close(); } catch (e) {}
      ws = null;
      connect();
      reply({ ok: true, port });
    })();
    return true;
  }
});

/* ------------------------------------------------------------------- tab */

const DEFAULT_SESSION = 'default';

/* Same session, one at a time: two `nav`/`set` must not trade `curUrl`.
   Different names run together. The stored tail swallows rejections so one
   failed command does not stall the session. */
const lanes = new Map();
function lane(name, fn) {
  const prev = lanes.get(name) || Promise.resolve();
  const run = prev.then(fn, fn);
  lanes.set(name, run.then(() => {}, () => {}));
  return run;
}

/* Creating a window and putting the person's focus back has to be one
   critical section. Two `open`s that each remember "the focused window" and
   then restore it will hand the focus to each other's window. */
let focusChain = Promise.resolve();
function withFocus(fn) {
  const run = focusChain.then(fn, fn);
  focusChain = run.then(() => {}, () => {});
  return run;
}

function sessionName(cmd) {
  const raw = cmd && cmd.session != null && cmd.session !== '' ? String(cmd.session) : DEFAULT_SESSION;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(raw)) throw new Error('invalid session name: ' + raw);
  return raw;
}

function slot(name) {
  return sessions[name] || (sessions[name] = { curTab: null, curUrl: null, beamWindow: null, beamTab: null });
}

function normalizeSlot(s) {
  return {
    curTab: s && s.curTab != null ? s.curTab : null,
    curUrl: s && s.curUrl != null ? s.curUrl : null,
    beamWindow: s && s.beamWindow != null ? s.beamWindow : null,
    beamTab: s && s.beamTab != null ? s.beamTab : null
  };
}

/* Another session's window or tab. `name` is allowed to own them. */
function foreignWindow(windowId, name) {
  if (windowId == null) return null;
  for (const n of Object.keys(sessions)) {
    if (n === name) continue;
    if (sessions[n].beamWindow === windowId) return n;
  }
  return null;
}

function foreignTab(tabId, name) {
  if (tabId == null) return null;
  for (const n of Object.keys(sessions)) {
    if (n === name) continue;
    const s = sessions[n];
    if (s.curTab === tabId || s.beamTab === tabId) return n;
  }
  return null;
}

function assertFree(tabId, name, cmd) {
  if (cmd && cmd.force) return;
  const other = foreignTab(tabId, name);
  if (other) {
    throw new Error(
      'tab ' + tabId + ' belongs to session ' + other +
      '. Repeat with --force if that is what you want.'
    );
  }
}

function ownsTab(tabId) {
  for (const n of Object.keys(sessions)) {
    const s = sessions[n];
    if (s.curTab === tabId || s.beamTab === tabId) return true;
  }
  return false;
}

function beamNames(tabId) {
  const names = [];
  for (const n of Object.keys(sessions)) {
    const s = sessions[n];
    if (s.curTab === tabId || s.beamTab === tabId) names.push(n);
  }
  return names;
}

/* Survives MV3 service-worker death. session, not local: a browser restart
   should not write into yesterday's tab. Queued so two slots cannot persist
   out of order and drop the newer map. */
let saveChain = Promise.resolve();
function saveSessions() {
  const run = saveChain.then(() => {}, () => {}).then(async () => {
    try {
      if (!chrome.storage.session) return;
      await chrome.storage.session.set({ beamSessions: sessions });
      await chrome.storage.session.remove(['curTab', 'curUrl', 'beamWindow', 'beamTab']);
    } catch (e) {}
  });
  saveChain = run.then(() => {}, () => {});
  return run;
}

const bindReady = (async () => {
  try {
    if (!chrome.storage.session) return;
    const s = await chrome.storage.session.get(['beamSessions', 'curTab', 'curUrl', 'beamWindow', 'beamTab']);
    if (s.beamSessions && typeof s.beamSessions === 'object' && !Array.isArray(s.beamSessions)) {
      sessions = {};
      for (const n of Object.keys(s.beamSessions)) {
        if (!/^[A-Za-z0-9._-]{1,40}$/.test(n)) continue;
        sessions[n] = normalizeSlot(s.beamSessions[n]);
      }
      if (s.curTab != null || s.curUrl != null || s.beamWindow != null || s.beamTab != null) {
        await chrome.storage.session.remove(['curTab', 'curUrl', 'beamWindow', 'beamTab']);
      }
    } else if (s.curTab != null || s.curUrl != null || s.beamWindow != null || s.beamTab != null) {
      sessions[DEFAULT_SESSION] = normalizeSlot(s);
      await saveSessions();
    }
  } catch (e) {}
})();

/* A stored tab id can be reused by Chrome after the tab dies. If the id is
   gone, or it no longer sits in the window we created, drop it so the next
   command cannot write into a tab the person opened. */
async function freshen(name) {
  const s = sessions[name];
  if (!s) return;
  let changed = false;
  if (s.beamTab != null) {
    try {
      const t = await chrome.tabs.get(s.beamTab);
      if (s.beamWindow != null && t.windowId !== s.beamWindow) {
        if (s.curTab === s.beamTab) { s.curTab = null; s.curUrl = null; }
        s.beamTab = null;
        s.beamWindow = null;
        changed = true;
      }
    } catch (e) {
      if (s.curTab === s.beamTab) { s.curTab = null; s.curUrl = null; }
      s.beamTab = null;
      s.beamWindow = null;
      changed = true;
    }
  } else if (s.beamWindow != null) {
    try { await chrome.windows.get(s.beamWindow); }
    catch (e) { s.beamWindow = null; changed = true; }
  }
  if (s.curTab != null) {
    try { await chrome.tabs.get(s.curTab); }
    catch (e) { s.curTab = null; s.curUrl = null; changed = true; }
  }
  if (changed) await saveSessions();
}

async function bind(name, tab) {
  const s = slot(name);
  if (tab) {
    s.curTab = tab.id;
    if (tab.url) s.curUrl = tab.url;
  } else {
    s.curTab = null;
    s.curUrl = null;
  }
  await saveSessions();
}

async function bindUrl(name, url) {
  slot(name).curUrl = url;
  await saveSessions();
}

async function targetTab(cmd, name) {
  await bindReady;
  if (cmd.tab) {
    const t = await chrome.tabs.get(Number(cmd.tab));
    assertFree(t.id, name, cmd);
    return t;
  }
  const s = sessions[name];
  if (s && s.curTab) {
    try { return await chrome.tabs.get(s.curTab); }
    catch (e) { await bind(name, null); }
  }
  throw new Error('no tab bound: beam open <url>, or beam use <id>');
}

async function focusedWindowId() {
  try {
    const w = await chrome.windows.getLastFocused();
    return w && w.id;
  } catch (e) { return null; }
}

/* macOS sometimes focuses a window we asked to create in the background.
   Put the person back where they were. */
async function keepUserFocus(prevId) {
  if (prevId == null) return;
  const now = await focusedWindowId();
  if (now == null || now === prevId) return;
  try { await chrome.windows.update(prevId, { focused: true }); } catch (e) {}
}

/* Make the tab the selected one in its session's window. Never focuses the
   window. Returns null when activating it would change the tab the person is
   looking at, or a tab that belongs to them or to another session. */
async function selectWithoutFocus(tab, name) {
  if (tab.active) return tab;
  const s = sessions[name];
  if (!s || s.beamWindow == null || tab.windowId !== s.beamWindow) return null;
  if (foreignWindow(tab.windowId, name)) return null;
  const prev = await focusedWindowId();
  if (prev != null && tab.windowId === prev) return null;
  await chrome.tabs.update(tab.id, { active: true });
  const next = await chrome.tabs.get(tab.id);
  await keepUserFocus(prev);
  return next;
}

async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  return chrome.tabs.get(tab.id);
}

/* This session's window: one tab, never focused unless --focus / beam focus.
   A tab that is active in an unfocused window still has layout, which is
   what hover and Beaver Builder need. Never adopts another session's window. */
async function ensureBeamTab(name, url, opts) {
  opts = opts || {};
  const s = slot(name);
  return withFocus(async () => {
    const prev = await focusedWindowId();
    let reused = false;
    let tab = null;

    if (s.beamTab && !opts.fresh) {
      try {
        tab = await chrome.tabs.get(s.beamTab);
        if ((s.beamWindow != null && tab.windowId !== s.beamWindow) || foreignWindow(tab.windowId, name)) {
          tab = null;
          s.beamTab = null;
          s.beamWindow = null;
        }
      } catch (e) {
        tab = null;
        s.beamTab = null;
        s.beamWindow = null;
      }
    }

    if (tab) {
      await chrome.tabs.update(tab.id, { url: url, active: true });
      await waitLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
      reused = true;
    } else if (opts.fresh && s.beamWindow && !foreignWindow(s.beamWindow, name)) {
      try {
        await chrome.windows.get(s.beamWindow);
        tab = await chrome.tabs.create({ windowId: s.beamWindow, url: url, active: true });
        await waitLoad(tab.id);
        tab = await chrome.tabs.get(tab.id);
      } catch (e) { tab = null; s.beamWindow = null; }
    }

    if (!tab) {
      const win = await chrome.windows.create({ url: url, focused: false, type: 'normal' });
      tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
      await waitLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
    }

    s.beamTab = tab.id;
    s.beamWindow = tab.windowId;
    await saveSessions();

    if (opts.focus) tab = await focusTab(tab);
    else await keepUserFocus(prev);
    return { tab: tab, reused: reused };
  });
}

function waitLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(timer); resolve(); };
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') done(); }).catch(done);
  });
}

/* ---------------------------------------------------------------- network */

/* Observe-only log of the requests made by the tabs Beam drives (the bound
   one and its own). No bodies, no request headers: method, url, type, status,
   timing, content-type. Kept in session storage, because the worker dies
   between commands and would otherwise forget everything. */
const NET_MAX = 500;
const NET_URL_MAX = 2000;
let net = {};            // tabId -> rows, oldest first
let netQueued = false;

const netReady = (async () => {
  try {
    if (!chrome.storage.session) return;
    const s = await chrome.storage.session.get('beamNet');
    if (s && s.beamNet && typeof s.beamNet === 'object') net = s.beamNet;
  } catch (e) {}
})();

function saveNet() {
  if (netQueued || !chrome.storage.session) return;
  netQueued = true;
  setTimeout(() => {
    netQueued = false;
    chrome.storage.session.set({ beamNet: net }).catch(() => {});
  }, 250);
}

function netRow(tabId, requestId) {
  const rows = net[tabId];
  if (!rows) return null;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === requestId) return rows[i];
  return null;
}

/* webRequest is an optional permission: the person turns the log on from the
   panel, and Chrome asks once. When it is granted, the listeners are
   registered synchronously at the top level, so a request wakes the worker;
   the bind and the old log are restored first, then the event is recorded. */
const netFilter = { urls: ['<all_urls>'] };

/* chrome.webRequest can stay defined after the permission is taken back:
   ask for the permission itself */
function netAllowed() {
  return chrome.permissions.contains({ permissions: ['webRequest'] }).catch(() => false);
}

function onNetRequest(d) {
  if (d.tabId < 0) return;
  Promise.all([bindReady, netReady]).then(() => {
    if (!ownsTab(d.tabId)) return;
    const rows = net[d.tabId] || (net[d.tabId] = []);
    rows.push({
      id: d.requestId,
      t: Math.round(d.timeStamp),
      method: d.method,
      url: d.url.length > NET_URL_MAX ? d.url.slice(0, NET_URL_MAX) + '…' : d.url,
      type: d.type,
      frame: d.frameId
    });
    if (rows.length > NET_MAX) rows.splice(0, rows.length - NET_MAX);
    saveNet();
  });
}

function onNetCompleted(d) {
  if (d.tabId < 0) return;
  netReady.then(() => {
    const row = netRow(d.tabId, d.requestId);
    if (!row) return;
    row.status = d.statusCode;
    row.ms = Math.max(0, Math.round(d.timeStamp - row.t));
    if (d.fromCache) row.cache = true;
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    if (ct && ct.value) row.mime = ct.value.split(';')[0].trim();
    saveNet();
  });
}

function onNetError(d) {
  if (d.tabId < 0) return;
  netReady.then(() => {
    const row = netRow(d.tabId, d.requestId);
    if (!row) return;
    row.error = d.error;
    row.ms = Math.max(0, Math.round(d.timeStamp - row.t));
    saveNet();
  });
}

/* Idempotent: the permission can be granted, taken back and granted again
   while the same worker is alive. */
function listenNet(on) {
  const w = chrome.webRequest;
  if (!w) return;
  const pairs = [[w.onBeforeRequest, onNetRequest, []], [w.onCompleted, onNetCompleted, ['responseHeaders']],
    [w.onErrorOccurred, onNetError, []]];
  for (const [ev, fn, extra] of pairs) {
    try {
      if (on && !ev.hasListener(fn)) {
        if (extra.length) ev.addListener(fn, netFilter, extra);
        else ev.addListener(fn, netFilter);
      }
      if (!on && ev.hasListener(fn)) ev.removeListener(fn);
    } catch (e) { /* the permission went away under us */ }
  }
}

listenNet(true);
chrome.permissions.onAdded.addListener((p) => {
  if ((p.permissions || []).indexOf('webRequest') >= 0) listenNet(true);
});
chrome.permissions.onRemoved.addListener((p) => {
  if ((p.permissions || []).indexOf('webRequest') >= 0) listenNet(false);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  bindReady.then(async () => {
    let changed = false;
    for (const n of Object.keys(sessions)) {
      const s = sessions[n];
      if (s.curTab === tabId) { s.curTab = null; s.curUrl = null; changed = true; }
      if (s.beamTab === tabId) { s.beamTab = null; s.beamWindow = null; changed = true; }
    }
    if (changed) await saveSessions();
  });
  netReady.then(() => {
    if (!net[tabId]) return;
    delete net[tabId];
    saveNet();
  });
});

/* webRequest calls fetch() and XHR both "xmlhttprequest" */
const NET_TYPES = { xhr: 'xmlhttprequest', fetch: 'xmlhttprequest', doc: 'main_frame', js: 'script', css: 'stylesheet', img: 'image' };

async function network(tab, cmd) {
  if (!(await netAllowed())) {
    throw new Error('the network log is off: open the Beam panel from the Chrome toolbar and press ' +
      '"Enable network log" (Chrome asks once)');
  }
  await netReady;
  let rows = net[tab.id] || [];
  const total = rows.length;
  if (cmd.type) {
    const want = String(cmd.type).split(',').map((s) => NET_TYPES[s.trim()] || s.trim());
    rows = rows.filter((r) => want.indexOf(r.type) >= 0);
  }
  if (cmd.filter) {
    const f = String(cmd.filter).toLowerCase();
    rows = rows.filter((r) => r.url.toLowerCase().indexOf(f) >= 0);
  }
  if (cmd.method) {
    const m = String(cmd.method).toUpperCase();
    rows = rows.filter((r) => r.method === m);
  }
  if (cmd.failed) rows = rows.filter((r) => r.error || r.status >= 400);
  if (cmd.last) rows = rows.slice(-Number(cmd.last));
  const out = {
    tab: tab.id,
    total,
    count: rows.length,
    requests: rows.map((r) => Object.assign({}, r, { id: undefined }))
  };
  if (cmd.clear) {
    delete net[tab.id];
    saveNet();
    out.cleared = true;
  }
  return out;
}

/* ----------------------------------------------------------------- inject */

const READ_OPS = ['info', 'snap', 'outline', 'fields', 'text', 'html'];
const WRITE_OPS = ['click', 'hover', 'fill', 'set', 'select', 'check', 'press', 'upload'];

function isWrite(cmd) {
  if (WRITE_OPS.indexOf(cmd.op) >= 0) return true;
  if (cmd.op === 'do') return (cmd.steps || []).some(isWrite);
  return false;
}

function needsLayout(cmd) {
  if (cmd.op === 'hover') return true;
  if (cmd.op === 'do') return (cmd.steps || []).some(needsLayout);
  return false;
}

/* A tab can be reused by the person while Beam is working in it. Before
   writing, check the url is still the one the last command left behind: if it
   changed and Beam did not do it, stop. */
function guardUrl(tab, cmd, name) {
  if (!isWrite(cmd) || cmd.force) return;
  const s = sessions[name];
  if (!s || !s.curUrl || tab.id !== s.curTab) return;
  if (tab.url === s.curUrl) return;
  throw new Error(
    'tab ' + tab.id + ' was changed from outside: it is now ' + tab.url +
    ' instead of ' + s.curUrl + '. Re-bind it with `beam use <id>` or `beam nav <url>`' +
    ', or repeat with --force if that is what you want.'
  );
}

/* Rewrites the refs of a result with the frame prefix: @14 -> @3:14, so a
   target stays usable outside the main frame. */
function tagFrame(out, fid) {
  if (!fid || !out || typeof out !== 'object') return out;
  if (typeof out.outline === 'string') out.outline = out.outline.replace(/@(\d+)\b/g, '@' + fid + ':$1');
  if (typeof out.revealed === 'string') out.revealed = out.revealed.replace(/@(\d+)\b/g, '@' + fid + ':$1');
  if (Array.isArray(out.fields)) out.fields.forEach((f) => { f.ref = f.ref.replace(/^@/, '@' + fid + ':'); });
  return out;
}

async function page(tab, cmd) {
  if (/^(chrome|edge|about|devtools|chrome-extension):/.test(tab.url || '')) {
    throw new Error('system page, not injectable: ' + tab.url);
  }
  const all = cmd.frame === 'all' || cmd.frame === true;
  if (all && READ_OPS.indexOf(cmd.op) < 0) {
    throw new Error('--frame all is for reading only; to act, name one frame (beam frames)');
  }

  const target = { tabId: tab.id };
  if (all) target.allFrames = true;
  else if (cmd.frame != null) target.frameIds = [Number(cmd.frame)];

  await chrome.scripting.executeScript({ target, files: ['agent.js'] });
  try { await chrome.scripting.executeScript({ target, files: ['shim.js'], world: 'MAIN' }); }
  catch (e) { /* some frames refuse MAIN-world injection; fills fall back to the DOM */ }
  const results = await chrome.scripting.executeScript({
    target,
    args: [cmd],
    func: async (c) => {
      try { return { ok: true, r: await window.__beam.run(c) }; }
      catch (e) { return { ok: false, e: String(e && e.message || e), partial: e && e.partial }; }
    }
  });

  if (!all) {
    const out = results[0] && results[0].result;
    if (!out) throw new Error('no answer from the page');
    if (!out.ok) {
      const err = new Error(out.e);
      if (out.partial) err.message += ' — partial: ' + JSON.stringify(out.partial);
      throw err;
    }
    /* @n from a named frame is useless on the next command unless it carries
       the frame. snap --frame all already does this; hover's revealed refs
       are the ones an agent clicks next. */
    if (cmd.frame != null && cmd.op === 'hover') return tagFrame(out.r, cmd.frame);
    return out.r;
  }

  /* every frame: keep only the ones that answered */
  const parts = [];
  for (const res of results) {
    const out = res && res.result;
    if (!out || !out.ok) continue;
    parts.push({ frame: res.frameId, data: tagFrame(out.r, res.frameId) });
  }
  if (!parts.length) throw new Error('no frame answered');

  if (cmd.op === 'snap') {
    return {
      url: parts[0].data.url,
      title: parts[0].data.title,
      elements: parts.reduce((n, p) => n + (p.data.elements || 0), 0),
      frames: parts.map((p) => ({ frame: p.frame, url: p.data.url, elements: p.data.elements })),
      outline: parts.map((p) => (p.frame ? '── frame ' + p.frame + ' · ' + p.data.url + ' ──\n' : '') + p.data.outline).join('\n\n')
    };
  }
  if (cmd.op === 'fields') {
    return {
      url: parts[0].data.url,
      count: parts.reduce((n, p) => n + (p.data.count || 0), 0),
      fields: parts.flatMap((p) => p.data.fields || [])
    };
  }
  if (cmd.op === 'text' || cmd.op === 'html') {
    const key = cmd.op === 'text' ? 'text' : 'html';
    return {
      url: parts[0].data.url,
      chars: parts.reduce((n, p) => n + (p.data.chars || 0), 0),
      [key]: parts.map((p) => (p.frame ? '── frame ' + p.frame + ' ──\n' : '') + (p.data[key] || '')).join('\n\n')
    };
  }
  return parts.map((p) => ({ frame: p.frame, result: p.data }));
}

function extFor(mime) {
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
                'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg',
                'application/pdf': '.pdf' };
  return map[String(mime || '').split(';')[0].trim()] || '';
}

/* -------------------------------------------------------------- commands */

async function dispatch(cmd) {
  await bindReady;
  const name = sessionName(cmd);
  if (cmd.op !== 'ping' && cmd.op !== 'reloadext') await freshen(name);
  switch (cmd.op) {

    case 'ping':
      return {
        pong: true,
        id: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        panel: 'chrome-extension://' + chrome.runtime.id + '/popup.html'
      };

    /* reload the extension: needed after editing the service worker */
    case 'reloadext':
      setTimeout(() => chrome.runtime.reload(), 100);
      return { reloading: true };

    case 'tabs': {
      const all = await chrome.tabs.query({});
      const s = sessions[name];
      return all.map((t) => {
        const owned = beamNames(t.id);
        return {
          tab: t.id, active: t.active, current: !!(s && t.id === s.curTab),
          beam: owned.length ? owned.join(',') : false,
          window: t.windowId,
          title: t.title, url: t.url
        };
      });
    }

    case 'sessions': {
      const rows = [];
      for (const n of Object.keys(sessions)) {
        const s = sessions[n];
        if (s.curTab == null && s.beamTab == null) continue;
        const tabId = s.curTab != null ? s.curTab : s.beamTab;
        let title = null, url = s.curUrl;
        try {
          const t = await chrome.tabs.get(tabId);
          title = t.title;
          url = t.url;
        } catch (e) {}
        rows.push({
          session: n, tab: s.curTab, beamTab: s.beamTab, window: s.beamWindow,
          title: title, url: url, current: n === name
        });
      }
      rows.sort((a, b) => a.session < b.session ? -1 : a.session > b.session ? 1 : 0);
      return rows;
    }

    case 'focus': {
      const t = await targetTab(cmd, name);
      const focused = await withFocus(() => focusTab(t));
      return { tab: focused.id, url: focused.url, title: focused.title, focused: true, session: name };
    }

    case 'use': {
      const t = await chrome.tabs.get(Number(cmd.tab));
      assertFree(t.id, name, cmd);
      await bind(name, t);
      if (cmd.focus) await withFocus(() => focusTab(t));
      return { tab: t.id, url: t.url, title: t.title, focused: !!cmd.focus, session: name };
    }

    case 'open': {
      if (!cmd.url) throw new Error('missing url');
      const got = await ensureBeamTab(name, cmd.url, { fresh: cmd.new === true, focus: cmd.focus === true });
      await bind(name, got.tab);
      return {
        tab: got.tab.id, url: got.tab.url, title: got.tab.title,
        window: got.tab.windowId, focused: cmd.focus === true, reused: got.reused,
        session: name
      };
    }

    case 'close': {
      const t = await targetTab(cmd, name);
      await chrome.tabs.remove(t.id);
      for (const n of Object.keys(sessions)) {
        const o = sessions[n];
        if (o.curTab === t.id) { o.curTab = null; o.curUrl = null; }
        if (o.beamTab === t.id) { o.beamTab = null; o.beamWindow = null; }
      }
      await saveSessions();
      return { closed: t.id, session: name };
    }

    case 'reload': {
      const t = await targetTab(cmd, name);
      await chrome.tabs.reload(t.id);
      await waitLoad(t.id);
      await bindUrl(name, (await chrome.tabs.get(t.id)).url);
      return { url: sessions[name].curUrl };
    }

    case 'back':
    case 'forward': {
      const t = await targetTab(cmd, name);
      await (cmd.op === 'back' ? chrome.tabs.goBack(t.id) : chrome.tabs.goForward(t.id));
      await waitLoad(t.id);
      await bindUrl(name, (await chrome.tabs.get(t.id)).url);
      return { url: sessions[name].curUrl };
    }

    case 'frames': {
      const t = await targetTab(cmd, name);
      const nav = await chrome.webNavigation.getAllFrames({ tabId: t.id }).catch(() => []);
      const byId = new Map((nav || []).map((f) => [f.frameId, { frame: f.frameId, parent: f.parentFrameId, url: f.url }]));
      /* injection also finds the frames webNavigation does not list */
      const seen = await page(t, { op: 'info', frame: 'all' });
      for (const p of seen) {
        const row = byId.get(p.frame) || { frame: p.frame, parent: null };
        row.url = p.result.url;
        row.title = p.result.title;
        row.injectable = true;
        byId.set(p.frame, row);
      }
      return [...byId.values()].sort((a, b) => a.frame - b.frame);
    }

    case 'shot': {
      const t = await targetTab(cmd, name);
      const data = await withFocus(async () => {
        const prev = await focusedWindowId();
        const selected = await selectWithoutFocus(t, name);
        const shotOpts = { format: 'jpeg', quality: cmd.quality || 55 };
        let shot = '';
        /* only capture once this tab is the one on screen in its window,
           otherwise we would photograph whatever the person is looking at */
        if (selected) {
          try { shot = await chrome.tabs.captureVisibleTab(selected.windowId, shotOpts); }
          catch (e) { shot = ''; }
        }
        const own = sessions[name] && t.windowId === sessions[name].beamWindow;
        if ((!shot || shot.length < 200) && !own) {
          throw new Error(selected
            ? 'screenshot failed'
            : 'screenshot would switch a tab this session does not own');
        }
        if (!shot || shot.length < 200) {
          await chrome.windows.update(t.windowId, { focused: true });
          await chrome.tabs.update(t.id, { active: true });
          try {
            shot = await chrome.tabs.captureVisibleTab(t.windowId, shotOpts);
          } finally {
            await keepUserFocus(prev);
          }
        }
        return shot;
      });
      if (!data) throw new Error('screenshot failed');
      return { dataUrl: data, bytes: data.length };
    }

    /* the service worker does the fetch: it has the host permissions and is
       not subject to the page's CORS. The bytes reach the agent as base64. */
    case 'upload': {
      const t = await targetTab(cmd, name);
      guardUrl(t, cmd, name);
      const r = await fetch(cmd.url);
      if (!r.ok) throw new Error('download failed: HTTP ' + r.status + ' ' + cmd.url);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      const fname = cmd.name || (new URL(cmd.url).pathname.split('/').pop() || 'file');
      return page(t, {
        op: 'upload',
        target: cmd.target,
        b64: btoa(bin),
        name: /\.[a-z0-9]{2,5}$/i.test(fname) ? fname : fname + extFor(r.headers.get('content-type')),
        mime: cmd.mime || r.headers.get('content-type') || 'application/octet-stream',
        frame: cmd.frame
      });
    }

    case 'network':
      return network(await targetTab(cmd, name), cmd);

    case 'nav': {
      const t = await targetTab(cmd, name);
      await chrome.tabs.update(t.id, { url: cmd.url });
      await waitLoad(t.id);
      await bind(name, await chrome.tabs.get(t.id));
      return { url: sessions[name].curUrl };
    }

    default: {
      const t = await targetTab(cmd, name);
      guardUrl(t, cmd, name);
      /* Layout needs the tab selected in its window, not the window focused.
         A tab the person owns, or another session's, stays where it is. */
      if (needsLayout(cmd)) {
        try { await withFocus(() => selectWithoutFocus(t, name)); } catch (e) {}
      }
      const r = await page(t, cmd);
      /* an action can navigate the page: realign the bookmark */
      try { await bindUrl(name, (await chrome.tabs.get(t.id)).url); } catch (e) {}
      return r;
    }
  }
}
