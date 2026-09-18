/* Beam — service worker: holds the WebSocket to the local hub and turns
 * commands into tab operations / agent injections. */

const DEFAULT_PORT = 8777;

let port = DEFAULT_PORT;
let ws = null;
let connecting = false;
let curTab = null;
let curUrl = null;      // the tab's url as of the last command
let retry = 0;

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
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;

  let socket;
  try {
    await loadPort();
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) { connecting = false; return schedule(); }
  ws = socket;
  connecting = false;

  socket.onopen = () => {
    retry = 0;
    setBadge('on');
    socket.send(JSON.stringify({ type: 'hello', info: { ua: navigator.userAgent } }));
  };
  socket.onmessage = async (ev) => {
    let cmd;
    try { cmd = JSON.parse(ev.data); } catch { return; }
    let out;
    try { out = { id: cmd.id, ok: true, result: await dispatch(cmd) }; }
    catch (e) { out = { id: cmd.id, ok: false, error: String(e && e.message || e) }; }
    /* answer on the socket the command came in on: a reconnect in the middle
       of a long command must not send the reply into the new one */
    try { socket.send(JSON.stringify(out)); } catch (e) {}
  };
  /* Only the socket that is still the current one may reset the state. An
     older socket closing used to null a perfectly healthy connection. */
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setBadge('off');
    schedule();
  };
  socket.onerror = () => { try { socket.close(); } catch (e) {} };
}

function schedule() {
  retry = Math.min(retry + 1, 4);        // at most 2s between attempts
  setTimeout(connect, 500 * retry);
}

function setBadge(state) {
  chrome.action.setBadgeText({ text: state === 'on' ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  chrome.action.setTitle({
    title: state === 'on' ? 'Beam — connected' : 'Beam — disconnected, click for the panel'
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
      let tabTitle = null, tabUrl = null;
      if (curTab) {
        try {
          const t = await chrome.tabs.get(curTab);
          tabTitle = t.title; tabUrl = t.url;
        } catch (e) { curTab = null; curUrl = null; }
      }
      reply({
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        port,
        version: chrome.runtime.getManifest().version,
        tab: curTab, tabTitle, tabUrl
      });
    })();
    return true;
  }
  if (msg.type === 'reconnect') { try { ws && ws.close(); } catch (e) {} ws = null; connect(); reply({ ok: true }); return; }
  if (msg.type === 'unbind') { curTab = null; curUrl = null; reply({ ok: true }); return; }
  if (msg.type === 'setport') {
    (async () => {
      port = Number(msg.port) || DEFAULT_PORT;
      await chrome.storage.local.set({ port });
      try { ws && ws.close(); } catch (e) {}
      ws = null;
      connect();
      reply({ ok: true, port });
    })();
    return true;
  }
});

/* ------------------------------------------------------------------- tab */

async function targetTab(cmd) {
  if (cmd.tab) {
    const t = await chrome.tabs.get(Number(cmd.tab));
    return t;
  }
  if (curTab) {
    try { return await chrome.tabs.get(curTab); } catch (e) { curTab = null; }
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('no active tab');
  curTab = t.id;
  return t;
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
const WRITE_OPS = ['click', 'fill', 'set', 'select', 'check', 'press', 'upload'];

/* A tab can be reused by the person while Beam is working in it. Before
   writing, check the url is still the one the last command left behind: if it
   changed and Beam did not do it, stop. */
function guardUrl(tab, cmd) {
  if (WRITE_OPS.indexOf(cmd.op) < 0 || cmd.force) return;
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
        tab: t.id, active: t.active, current: t.id === curTab,
        title: t.title, url: t.url
      }));
    }

    case 'use': {
      const t = await chrome.tabs.get(Number(cmd.tab));
      curTab = t.id;
      curUrl = t.url;
      await chrome.tabs.update(t.id, { active: true });
      return { tab: t.id, url: t.url, title: t.title };
    }

    case 'open': {
      let t;
      if (cmd.newTab === false) {
        t = await targetTab(cmd);
        await chrome.tabs.update(t.id, { url: cmd.url });
      } else {
        t = await chrome.tabs.create({ url: cmd.url, active: cmd.background !== true });
      }
      curTab = t.id;
      await waitLoad(t.id);
      t = await chrome.tabs.get(t.id);
      curUrl = t.url;
      return { tab: t.id, url: t.url, title: t.title };
    }

    case 'close': {
      const t = await targetTab(cmd);
      await chrome.tabs.remove(t.id);
      if (curTab === t.id) curTab = null;
      return { closed: t.id };
    }

    case 'reload': {
      const t = await targetTab(cmd);
      await chrome.tabs.reload(t.id);
      await waitLoad(t.id);
      curUrl = (await chrome.tabs.get(t.id)).url;
      return { url: curUrl };
    }

    case 'back':
    case 'forward': {
      const t = await targetTab(cmd);
      await (cmd.op === 'back' ? chrome.tabs.goBack(t.id) : chrome.tabs.goForward(t.id));
      await waitLoad(t.id);
      curUrl = (await chrome.tabs.get(t.id)).url;
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
      await chrome.tabs.update(t.id, { active: true });
      const data = await chrome.tabs.captureVisibleTab(t.windowId, {
        format: 'jpeg', quality: cmd.quality || 55
      });
      return { dataUrl: data, bytes: data.length };
    }

    /* the service worker does the fetch: it has the host permissions and is
       not subject to the page's CORS. The bytes reach the agent as base64. */
    case 'upload': {
      const t = await targetTab(cmd);
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
      curTab = t.id;
      curUrl = (await chrome.tabs.get(t.id)).url;
      return { url: curUrl };
    }

    default: {
      const t = await targetTab(cmd);
      guardUrl(t, cmd);
      const r = await page(t, cmd);
      /* an action can navigate the page: realign the bookmark */
      try { curUrl = (await chrome.tabs.get(t.id)).url; } catch (e) {}
      return r;
    }
  }
}
