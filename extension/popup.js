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
}

async function refresh() {
  try { paint(await chrome.runtime.sendMessage({ type: 'status' })); }
  catch (e) {
    $('label').textContent = 'Extension needs a reload';
    $('sub').textContent = e.message;
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

refresh();
setInterval(refresh, 2000);
