/* Status panel: asks the service worker how it is doing and offers the three
   things that actually matter — reconnect, release the tab, change the port. */

const $ = (id) => document.getElementById(id);
let editingPort = false;

function paint(s) {
  const on = !!s.connected;
  const dup = !!s.superseded;
  $('dot').className = 'dot ' + (on ? 'on' : 'off');
  $('label').textContent = on ? 'Connected' : dup ? 'Another copy is connected' : 'Not connected';
  $('sub').textContent = on
    ? 'ready for commands'
    : dup
      ? 'disable the leftover in chrome://extensions'
      : 'the local hub is not answering';
  if (!editingPort) $('port').value = s.port;
  $('ver').textContent = s.version;

  if (s.tab) {
    $('tab').textContent = s.tabTitle || ('#' + s.tab);
    $('tab').title = s.tabUrl || '';
  } else {
    $('tab').textContent = 'none';
    $('tab').title = '';
  }

  $('hint').textContent = on
    ? ''
    : dup
      ? 'This copy lost the hub socket. Unload the other Beam in chrome://extensions, or hit Reconnect to take over.'
      : 'Run any command in the terminal (the hub starts by itself), or hit Reconnect. If you set BEAM_PORT, match it here.';

  paintDebug(formatDebug(s));
}

const READY = ['connecting', 'open', 'closing', 'closed'];
const CLOSE_GLOSS = {
  1000: '1000 normal close',
  1001: '1001 going away (worker stopped or hub closed it)',
  1005: '1005 closed with no status',
  1006: '1006 refused or dropped — hub not listening, or the socket died without a close frame'
};

function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'm ago';
  return Math.round(m / 60) + 'h ago';
}

function pad(n) { return String(n).padStart(2, '0'); }

function hhmmss(t) {
  const d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/* Local time, same clock as the rows below. The offset is there so a paste
   from another country still lines up. */
function stamp(t) {
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + hhmmss(t) + sign + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
}

function browserLine(ua) {
  const chrome = (String(ua || '').match(/Chrome\/[\d.]+/) || ['Chrome/?'])[0];
  const os = /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : 'other';
  return chrome + ' on ' + os;
}

function formatRow(row) {
  switch (row.event) {
    case 'worker': {
      const gap = row.gap ? ' (' + Math.round(row.gap / 1000) + 's since previous start)' : '';
      return 'worker start #' + (row.n || '?') + gap;
    }
    case 'connect': return 'connect :' + row.port;
    case 'open': return row.hello ? 'open, hello sent' : 'open, hello failed: ' + (row.error || '?');
    case 'close': {
      const when = row.opened ? 'after ' + Math.max(0, Math.round((row.ms || 0) / 1000)) + 's' : 'before open';
      return 'close ' + row.code + ' ' + when + (row.current ? '' : ' stale');
    }
    case 'error': return 'error ' + (row.opened ? 'after open' : 'before open');
    case 'retry': return 'retry ' + row.n + ' in ' + row.wait + 'ms';
    case 'replaced': return 'replaced' + (row.by ? ' by ' + row.by : '');
    case 'reconnect': return 'reconnect from panel';
    case 'setport': return 'port set to ' + row.port;
    case 'skip': return 'skipped (' + row.why + ')';
    case 'fail': return 'connect failed: ' + (row.error || '?');
    case 'send-fail': return 'send failed: ' + (row.error || '?');
    default: return row.event;
  }
}

function formatDebug(s) {
  const d = s.debug || {};
  const down = d.readyState == null;
  const socket = s.superseded ? 'superseded'
    : down ? (d.connecting ? 'starting' : 'down')
    : (READY[d.readyState] || String(d.readyState));
  const last = d.lastClose;
  const lines = [
    'Beam ' + (s.version || '?') + '   ' + stamp(Date.now()),
    'extension  ' + (d.id || chrome.runtime.id),
    'browser    ' + browserLine(d.ua),
    'port       ' + s.port,
    'socket     ' + socket + (last && !s.connected ? '   last close ' + last.code + (last.opened ? ' after open' : ' before open') : ''),
    'retry      ' + (d.retry || 0) + (d.connecting ? '   handshake in progress' : ''),
    'worker     ' + (d.workerStarts || 0) + ' starts, this one ' + ago(d.workerAt),
    'last open  ' + ago(d.lastOpenAt) + '   hello ' + (d.helloSentAt ? ago(d.helloSentAt) : 'not sent'),
    ''
  ];
  const rows = d.log || [];
  if (!rows.length) lines.push('(no events yet)');
  for (const row of rows) lines.push(hhmmss(row.t) + '  ' + formatRow(row));
  const codes = {};
  for (const row of rows) if (row.event === 'close' && CLOSE_GLOSS[row.code]) codes[row.code] = CLOSE_GLOSS[row.code];
  const gloss = Object.keys(codes).map((k) => codes[k]);
  if (gloss.length) lines.push('', gloss.join('\n'));
  if (d.ua) lines.push('', d.ua);
  return lines.join('\n');
}

function deadDump(err) {
  return [
    'Beam ' + chrome.runtime.getManifest().version + '   ' + stamp(Date.now()),
    'extension  ' + chrome.runtime.id,
    'service worker did not answer',
    String(err && err.message || err),
    '',
    'Reload Beam in chrome://extensions. The log lives in the worker; if the worker is dead there is nothing to copy yet.'
  ].join('\n');
}

function paintDebug(text) {
  const el = $('debug-out');
  if (el.textContent === text) return;
  /* Keep the diagnosis (the lines at the top) in view. Only a person who
     scrolled the log keeps their place across the 2s refresh. */
  const top = el.scrollTop;
  el.textContent = text;
  el.scrollTop = top;
}

async function refresh() {
  try { paint(await chrome.runtime.sendMessage({ type: 'status' })); }
  catch (e) {
    $('dot').className = 'dot off';
    $('label').textContent = 'Extension needs a reload';
    $('sub').textContent = e.message;
    paintDebug(deadDump(e));
  }
}

$('reconnect').addEventListener('click', async () => {
  $('label').textContent = 'Reconnecting…';
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 600);
});

$('unbind').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unbind' });
  refresh();
});

$('port').addEventListener('focus', () => { editingPort = true; });
$('port').addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'setport', port: Number($('port').value) });
  editingPort = false;
  setTimeout(refresh, 600);
});
$('port').addEventListener('blur', () => { editingPort = false; });

$('copy').addEventListener('click', async () => {
  const text = $('debug-out').textContent;
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const r = document.createRange();
    r.selectNodeContents($('debug-out'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand('copy');
  }
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1200);
});

chrome.storage.session.get('debugOpen').then((s) => {
  if (s && s.debugOpen) $('debug').open = true;
}).catch(() => {});
$('debug').addEventListener('toggle', () => {
  chrome.storage.session.set({ debugOpen: $('debug').open }).catch(() => {});
});

refresh();
setInterval(refresh, 2000);
