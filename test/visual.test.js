/* points (xy= / --at), screen boxes and the data behind `shot <target>` and
 * `shot --marks`, against a fake DOM with a hand-made layout: jsdom draws nothing, so every element
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
<canvas id="chart" aria-label="Sales" data-rect="10,450,400,200"></canvas>
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
window.devicePixelRatio = 2;

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

/* a canvas that wants coordinates */
const clicks = [];
doc.getElementById('chart').addEventListener('click', (e) => clicks.push(e.clientX + ',' + e.clientY));
doc.getElementById('chart').addEventListener('mousedown', (e) => clicks.push('down:' + e.buttons));

let fail = 0;
const t = async (name, fn) => {
  try { const r = await fn(); console.log('✓ ' + name + (r ? '  ' + r : '')); }
  catch (e) { fail++; console.log('✗ ' + name + '  ' + e.message); }
};
const order = (sel) => [...doc.querySelectorAll(sel)].map((e) => e.id).join(',');

(async () => {
  await t('click --at hits a point inside a canvas, with coordinates', () => {
    const r = B.run({ op: 'click', target: 'css=#chart', at: '100,40' });
    if (clicks.join(' ') !== 'down:1 110,490') throw new Error(clicks.join(' '));
    return r.x + ',' + r.y;
  });

  await t('xy= targets whatever is drawn there', () => {
    clicks.length = 0;
    const r = B.run({ op: 'click', target: 'xy=50,500' });
    if (clicks.join(' ') !== 'down:1 50,500') throw new Error(clicks.join(' '));
    const b = B.run({ op: 'click', target: 'xy=430,460' });
    if (b.clicked !== 'Go') throw new Error(JSON.stringify(b));
    return r.clicked;
  });

  await t('a bad --at is refused', () => {
    try { B.run({ op: 'click', target: 'css=#chart', at: '100' }); } catch (e) { return e.message.slice(0, 30); }
    throw new Error('accepted');
  });

  await t('snap --boxes adds boxes and lists the canvas', () => {
    const s = B.run({ op: 'snap', boxes: true }).outline;
    if (!/canvas "Sales" #chart \[10,450 400x200\]/.test(s)) throw new Error(s);
    if (!/button "Go" #go \[420,450 80x30\]/.test(s)) throw new Error(s);
    const plain = B.run({ op: 'snap' }).outline;
    if (/\[\d+,\d+ /.test(plain) || /canvas/.test(plain)) throw new Error('boxes without --boxes');
  });

  await t('rect gives the crop box and the pixel ratio', () => {
    const r = B.run({ op: 'rect', target: 'css=#chart' });
    if (r.x !== 10 || r.y !== 450 || r.w !== 400 || r.dpr !== 2) throw new Error(JSON.stringify(r));
  });

  await t('marks returns the boxes of the refs on screen', () => {
    window.innerWidth = 600; window.innerHeight = 500;
    const m = B.run({ op: 'marks' });
    const go = m.boxes.find((b) => m.outline.indexOf('@' + b.ref + ' button "Go"') >= 0);
    if (!go || go.x !== 420) throw new Error(JSON.stringify(m.boxes));
    /* the canvas starts at y=450 and is on screen; nothing below 500 is */
    if (m.boxes.some((b) => b.y > 500)) throw new Error('off-screen box');
    return m.boxes.length + ' boxes';
  });

  console.log(fail ? '\n' + fail + ' tests failed' : '\nall tests passed');
  process.exit(fail ? 1 : 0);
})();
