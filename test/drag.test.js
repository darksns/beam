/* drag & drop and drops of files, against a fake DOM with a hand-made layout: jsdom draws nothing, so every element
 * carries its box in data-rect="x,y,w,h" and elementFromPoint reads them. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><head><title>Board</title></head><body>
<ul id="list">
  <li id="a" draggable="true" data-rect="10,10,200,30">Alpha</li>
  <li id="b" draggable="true" data-rect="10,50,200,30">Beta</li>
  <li id="c" draggable="true" data-rect="10,90,200,30">Gamma</li>
</ul>
<div id="rows" data-rect="300,0,200,200">
  <div class="row" id="r1" data-rect="300,10,200,30"><span class="handle" data-rect="300,10,20,30">≡</span>One</div>
  <div class="row" id="r2" data-rect="300,50,200,30"><span class="handle" data-rect="300,50,20,30">≡</span>Two</div>
</div>
<div id="zone" data-rect="10,300,300,100">Drop files here</div>
<div id="deaf" data-rect="400,300,100,100">Nothing here</div>
<button id="go" data-rect="420,450,80,30">Go</button>
</body></html>`;

const dom = new JSDOM(html, { url: 'https://example.com/board', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

function boxOf(el) {
  const v = el.getAttribute && el.getAttribute('data-rect');
  if (!v) return null;
  const [x, y, w, h] = v.split(',').map(Number);
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y };
}
window.Element.prototype.getBoundingClientRect = function () {
  return boxOf(this) || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
};
window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
window.Element.prototype.scrollIntoView = function () {};
/* the deepest element whose box holds the point */
doc.elementFromPoint = function (x, y) {
  let hit = null;
  for (const el of doc.querySelectorAll('[data-rect]')) {
    const r = boxOf(el);
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = el;
  }
  return hit;
};

/* jsdom has neither DataTransfer nor DragEvent: the agent's fallback path */
class DataTransfer {
  constructor() {
    const files = [];
    this._data = {};
    this.files = files;
    this.items = { add: (f) => { files.push(f); } };
    this.types = [];
  }
  setData(k, v) { this._data[k] = v; if (this.types.indexOf(k) < 0) this.types.push(k); }
  getData(k) { return this._data[k] || ''; }
}
window.DataTransfer = DataTransfer;

for (const k of ['window', 'document', 'navigator', 'location', 'CSS', 'Event', 'MouseEvent', 'KeyboardEvent',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'getComputedStyle', 'File', 'DataTransfer']) {
  global[k] = window[k];
}
global.window = window;

window.eval(fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent.js'), 'utf8'));
const B = window.__beam;

/* a SortableJS-shaped HTML5 list: dragover over an item moves the dragged
   one before it, drop is accepted */
let dragged = null;
const list = doc.getElementById('list');
const log = [];
list.addEventListener('dragstart', (e) => { dragged = e.target; e.dataTransfer.setData('text/plain', e.target.id); log.push('dragstart'); });
list.addEventListener('dragover', (e) => {
  e.preventDefault();
  const li = e.target.closest('li');
  if (li && li !== dragged && e.clientY <= boxOf(li).top + 15) list.insertBefore(dragged, li);
});
list.addEventListener('drop', (e) => { e.preventDefault(); log.push('drop:' + e.dataTransfer.getData('text/plain')); });
list.addEventListener('dragend', () => log.push('dragend'));

/* a jQuery-UI-shaped sortable: mousedown on a handle, mousemove on the
   document, mouseup ends it; the row lands where the pointer is */
let moving = null, lastY = 0, moves = 0;
const rows = doc.getElementById('rows');
rows.addEventListener('mousedown', (e) => { if (e.target.classList.contains('handle') && e.buttons === 1) moving = e.target.parentElement; });
doc.addEventListener('mousemove', (e) => { if (moving) { lastY = e.clientY; moves++; } });
doc.addEventListener('mouseup', () => {
  if (!moving) return;
  const after = [...rows.children].find((r) => r !== moving && lastY > boxOf(r).top);
  if (after) rows.insertBefore(moving, after.nextSibling);
  moving = null;
});

/* a dropzone that takes files */
const got = [];
const zone = doc.getElementById('zone');
zone.addEventListener('dragover', (e) => e.preventDefault());
zone.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) got.push(f.name + ':' + f.size + ':' + f.type);
  if (e.dataTransfer.getData('text/plain')) got.push('text:' + e.dataTransfer.getData('text/plain'));
});

let fail = 0;
const t = async (name, fn) => {
  try { const r = await fn(); console.log('✓ ' + name + (r ? '  ' + r : '')); }
  catch (e) { fail++; console.log('✗ ' + name + '  ' + e.message); }
};
const order = (sel) => [...doc.querySelectorAll(sel)].map((e) => e.id).join(',');

(async () => {
  await t('drag (html5) reorders a draggable list', async () => {
    const r = await B.run({ op: 'drag', target: 'css=#c', to: 'css=#a' });
    if (r.mode !== 'html5') throw new Error('mode ' + r.mode);
    if (!r.accepted) throw new Error('not accepted');
    if (order('#list li') !== 'c,a,b') throw new Error(order('#list li'));
    if (log.join(' ') !== 'dragstart drop:c dragend') throw new Error(log.join(' '));
    return order('#list li');
  });

  await t('drag (mouse) moves a jQuery-UI-style row', async () => {
    const r = await B.run({ op: 'drag', target: 'css=#r1 .handle', to: 'css=#r2', at: '100,25' });
    if (r.mode !== 'mouse') throw new Error('mode ' + r.mode);
    if (moves < 2) throw new Error('only ' + moves + ' moves');
    if (order('#rows .row') !== 'r2,r1') throw new Error(order('#rows .row'));
    return moves + ' moves';
  });

  await t('auto sees a source that turns draggable on pointerdown (SortableJS)', async () => {
    const late = doc.getElementById('a');
    late.removeAttribute('draggable');
    late.addEventListener('pointerdown', () => late.setAttribute('draggable', 'true'), { once: true });
    const r = await B.run({ op: 'drag', target: 'css=#a', to: 'css=#b' });
    if (r.mode !== 'html5') throw new Error('mode ' + r.mode);
  });

  await t('drag says when nothing accepted the drop', async () => {
    doc.getElementById('deaf').setAttribute('draggable', 'false');
    const r = await B.run({ op: 'drag', target: 'css=#go', to: 'css=#deaf', mode: 'html5' });
    if (r.accepted !== false) throw new Error(JSON.stringify(r));
  });

  await t('drag runs inside a do sequence', async () => {
    const r = await B.run({ op: 'do', steps: [{ op: 'drag', target: 'css=#b', to: 'css=#c' }, { op: 'info' }] });
    if (r.steps.length !== 2 || r.steps[0].error) throw new Error(JSON.stringify(r));
  });

  await t('drop delivers files with their bytes and type', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const r = B.run({ op: 'drop', target: 'css=#zone', files: [{ b64, name: 'a.txt', mime: 'text/plain' }, { b64, name: 'b.png', mime: 'image/png' }] });
    if (!r.accepted) throw new Error('not accepted');
    if (got.join(' ') !== 'a.txt:5:text/plain b.png:5:image/png') throw new Error(got.join(' '));
    return r.dropped;
  });

  await t('drop of text', () => {
    got.length = 0;
    B.run({ op: 'drop', target: 'css=#zone', text: 'hi' });
    if (got.join() !== 'text:hi') throw new Error(got.join());
  });

  await t('drop reports a target that ignored it', () => {
    const r = B.run({ op: 'drop', target: 'css=#deaf', text: 'x' });
    if (r.accepted !== false) throw new Error(JSON.stringify(r));
  });

  await t('drop with nothing to drop is refused', () => {
    try { B.run({ op: 'drop', target: 'css=#zone' }); } catch (e) { return e.message; }
    throw new Error('accepted an empty drop');
  });

  console.log(fail ? '\n' + fail + ' tests failed' : '\nall tests passed');
  process.exit(fail ? 1 : 0);
})();
