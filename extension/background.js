/* Beam — service worker: holds the WebSocket to the local hub and turns
 * commands into tab operations / agent injections. */

const DEFAULT_PORT = 8777;

let port = DEFAULT_PORT;
let ws = null;
let connecting = false;
let curTab = null;
let curUrl = null;      // the tab's url as of the last command
let beamWindow = null;  // the unfocused window Beam owns
let beamTab = null;     // the one tab inside it, reused by every open
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
  socket.onmessage = async (ev) => {
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
    let out;
    try { out = { id: cmd.id, ok: true, result: await dispatch(cmd) }; }
    catch (e) { out = { id: cmd.id, ok: false, error: String(e && e.message || e) }; }
    /* answer on the socket the command came in on: a reconnect in the middle
       of a long command must not send the reply into the new one */
    try { socket.send(JSON.stringify(out)); }
    catch (e) { note('send-fail', { error: String(e && e.message || e) }); }
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
      let tabTitle = null, tabUrl = null;
      if (curTab) {
        try {
          const t = await chrome.tabs.get(curTab);
          tabTitle = t.title; tabUrl = t.url;
        } catch (e) { await bind(null); }
      }
      await debugReady;
      reply({
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        superseded,
        port,
        version: chrome.runtime.getManifest().version,
        tab: curTab, tabTitle, tabUrl,
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
  if (msg.type === 'unbind') { bind(null).then(() => reply({ ok: true })); return true; }
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

/* Survives MV3 service-worker death. session, not local: a browser restart
   should not write into yesterday's tab. */
async function saveBind() {
  try {
    if (chrome.storage.session) await chrome.storage.session.set({ curTab, curUrl, beamWindow, beamTab });
  } catch (e) {}
}

const bindReady = (async () => {
  try {
    if (!chrome.storage.session) return;
    const s = await chrome.storage.session.get(['curTab', 'curUrl', 'beamWindow', 'beamTab']);
    if (s.curTab != null) curTab = s.curTab;
    if (s.curUrl != null) curUrl = s.curUrl;
    if (s.beamWindow != null) beamWindow = s.beamWindow;
    if (s.beamTab != null) beamTab = s.beamTab;
  } catch (e) {}
})();

async function bind(tab) {
  if (tab) {
    curTab = tab.id;
    if (tab.url) curUrl = tab.url;
  } else {
    curTab = null;
    curUrl = null;
  }
  await saveBind();
}

async function bindUrl(url) {
  curUrl = url;
  await saveBind();
}

async function targetTab(cmd) {
  await bindReady;
  if (cmd.tab) {
    const t = await chrome.tabs.get(Number(cmd.tab));
    return t;
  }
  if (curTab) {
    try { return await chrome.tabs.get(curTab); } catch (e) { await bind(null); }
  }
  throw new Error('niente tab agganciata: beam open <url> oppure beam use <id>');
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

/* Make the tab the selected one in its own window. Never focuses the window.
   Returns null when the tab is in the window the person is using and is not
   the one they are looking at: switching it would take their screen. */
async function selectWithoutFocus(tab) {
  if (tab.active) return tab;
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

/* Beam's own window: one tab, never focused unless --focus / beam focus.
   A tab that is active in an unfocused window still has layout, which is
   what hover and Beaver Builder need. */
async function ensureBeamTab(url, opts) {
  opts = opts || {};
  const prev = await focusedWindowId();
  let reused = false;
  let tab = null;

  if (beamTab && !opts.fresh) {
    try { tab = await chrome.tabs.get(beamTab); }
    catch (e) { tab = null; beamTab = null; beamWindow = null; }
  }

  if (tab) {
    await chrome.tabs.update(tab.id, { url: url, active: true });
    await waitLoad(tab.id);
    tab = await chrome.tabs.get(tab.id);
    reused = true;
  } else if (opts.fresh && beamWindow) {
    try {
      await chrome.windows.get(beamWindow);
      tab = await chrome.tabs.create({ windowId: beamWindow, url: url, active: true });
      await waitLoad(tab.id);
      tab = await chrome.tabs.get(tab.id);
    } catch (e) { tab = null; beamWindow = null; }
  }

  if (!tab) {
    const win = await chrome.windows.create({ url: url, focused: false, type: 'normal' });
    tab = (win.tabs && win.tabs[0]) || (await chrome.tabs.query({ windowId: win.id }))[0];
    await waitLoad(tab.id);
    tab = await chrome.tabs.get(tab.id);
  }

  beamTab = tab.id;
  beamWindow = tab.windowId;
  await saveBind();

  if (opts.focus) {
    tab = await focusTab(tab);
  } else {
    await keepUserFocus(prev);
  }
  return { tab: tab, reused: reused };
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
function guardUrl(tab, cmd) {
  if (!isWrite(cmd) || cmd.force) return;
  if (!curUrl || tab.id !== curTab) return;
  if (tab.url === curUrl) return;
  throw new Error(
    'tab ' + tab.id + ' was changed from outside: it is now ' + tab.url +
    ' instead of ' + curUrl + '. Re-bind it with `beam use <id>` or `beam nav <url>`' +
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
      return all.map((t) => ({
        tab: t.id, active: t.active, current: t.id === curTab, beam: t.id === beamTab,
        window: t.windowId,
        title: t.title, url: t.url
      }));
    }

    case 'focus': {
      const t = await focusTab(await targetTab(cmd));
      return { tab: t.id, url: t.url, title: t.title, focused: true };
    }

    case 'use': {
      const t = await chrome.tabs.get(Number(cmd.tab));
      await bind(t);
      if (cmd.focus) await focusTab(t);
      return { tab: t.id, url: t.url, title: t.title, focused: !!cmd.focus };
    }

    case 'open': {
      if (!cmd.url) throw new Error('missing url');
      const got = await ensureBeamTab(cmd.url, { fresh: cmd.new === true, focus: cmd.focus === true });
      await bind(got.tab);
      return {
        tab: got.tab.id, url: got.tab.url, title: got.tab.title,
        window: got.tab.windowId, focused: cmd.focus === true, reused: got.reused
      };
    }

    case 'close': {
      const t = await targetTab(cmd);
      const wasBeam = t.id === beamTab;
      await chrome.tabs.remove(t.id);
      if (curTab === t.id) await bind(null);
      if (wasBeam) {
        beamTab = null;
        beamWindow = null;
        await saveBind();
      }
      return { closed: t.id };
    }

    case 'reload': {
      const t = await targetTab(cmd);
      await chrome.tabs.reload(t.id);
      await waitLoad(t.id);
      await bindUrl((await chrome.tabs.get(t.id)).url);
      return { url: curUrl };
    }

    case 'back':
    case 'forward': {
      const t = await targetTab(cmd);
      await (cmd.op === 'back' ? chrome.tabs.goBack(t.id) : chrome.tabs.goForward(t.id));
      await waitLoad(t.id);
      await bindUrl((await chrome.tabs.get(t.id)).url);
      return { url: curUrl };
    }

    case 'frames': {
      const t = await targetTab(cmd);
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
      const t = await targetTab(cmd);
      const prev = await focusedWindowId();
      const selected = await selectWithoutFocus(t);
      const shotOpts = { format: 'jpeg', quality: cmd.quality || 55 };
      let data = '';
      /* only capture once this tab is the one on screen in its window,
         otherwise we would photograph whatever the person is looking at */
      if (selected) {
        try { data = await chrome.tabs.captureVisibleTab(selected.windowId, shotOpts); }
        catch (e) { data = ''; }
      }
      if (!data || data.length < 200) {
        await chrome.windows.update(t.windowId, { focused: true });
        await chrome.tabs.update(t.id, { active: true });
        try {
          data = await chrome.tabs.captureVisibleTab(t.windowId, shotOpts);
        } finally {
          await keepUserFocus(prev);
        }
      }
      if (!data) throw new Error('screenshot failed');
      return { dataUrl: data, bytes: data.length };
    }

    /* the service worker does the fetch: it has the host permissions and is
       not subject to the page's CORS. The bytes reach the agent as base64. */
    case 'upload': {
      const t = await targetTab(cmd);
      guardUrl(t, cmd);
      const r = await fetch(cmd.url);
      if (!r.ok) throw new Error('download failed: HTTP ' + r.status + ' ' + cmd.url);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      }
      const name = cmd.name || (new URL(cmd.url).pathname.split('/').pop() || 'file');
      return page(t, {
        op: 'upload',
        target: cmd.target,
        b64: btoa(bin),
        name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : name + extFor(r.headers.get('content-type')),
        mime: cmd.mime || r.headers.get('content-type') || 'application/octet-stream',
        frame: cmd.frame
      });
    }

    case 'nav': {
      const t = await targetTab(cmd);
      await chrome.tabs.update(t.id, { url: cmd.url });
      await waitLoad(t.id);
      await bind(await chrome.tabs.get(t.id));
      return { url: curUrl };
    }

    default: {
      const t = await targetTab(cmd);
      guardUrl(t, cmd);
      /* Layout needs the tab selected in its window, not the window focused.
         In the person's own window, leave their tab alone. */
      if (needsLayout(cmd)) {
        try { await selectWithoutFocus(t); } catch (e) {}
      }
      const r = await page(t, cmd);
      /* an action can navigate the page: realign the bookmark */
      try { await bindUrl((await chrome.tabs.get(t.id)).url); } catch (e) {}
      return r;
    }
  }
}
