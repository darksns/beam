/* exercises agent.js against a fake DOM that mimics a WordPress ACF screen */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = `<!doctype html><html><head><title>Edit page · WP</title></head><body>
<form id="post">
  <h1>Edit page</h1>
  <input type="hidden" id="post_ID" name="post_ID" value="1420">
  <label for="title">Title</label>
  <input type="text" id="title" name="post_title" value="Woven roots">

  <div class="acf-field acf-field-text" data-name="hero_kicker" data-key="field_aa" data-type="text">
    <div class="acf-label"><label>Kicker</label></div>
    <div class="acf-input"><input type="text" name="acf[field_aa]" value="New collection 2026"></div>
  </div>

  <div class="acf-field acf-field-textarea" data-name="hero_description" data-key="field_bb" data-type="textarea">
    <div class="acf-label"><label>Description</label></div>
    <div class="acf-input"><textarea name="acf[field_bb]" required>There is a moment...</textarea></div>
  </div>

  <div class="acf-field" data-name="status" data-key="field_cc" data-type="select">
    <div class="acf-label"><label>Status</label></div>
    <div class="acf-input"><select name="acf[field_cc]">
      <option value="d">Draft</option><option value="p" selected>Published</option>
    </select></div>
  </div>

  <div class="acf-field" data-name="active" data-key="field_dd" data-type="true_false">
    <div class="acf-label"><label>Active</label></div>
    <div class="acf-input"><input type="checkbox" name="acf[field_dd]"></div>
  </div>

  <div class="acf-row">
    <div class="acf-field" data-name="stop_title" data-key="field_ee" data-type="text">
      <div class="acf-label"><label>Stop title</label></div>
      <div class="acf-input"><input type="text" name="acf[field_rep][row-0][field_ee]" value=""></div>
    </div>
  </div>

  <div contenteditable="true" id="rich" aria-label="Notes">rich text</div>
  <a href="/wp-admin/edit.php">All pages</a>
  <button id="publish" type="button">Update</button>
</form></body></html>`;

const dom = new JSDOM(html, { url: 'https://example.com/wp-admin/post.php?post=1420&action=edit', pretendToBeVisual: true });
const { window } = dom;

// jsdom does no layout: make rendered elements "visible"
window.Element.prototype.getClientRects = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none' || this.hidden || this.type === 'hidden') return [];
  return [{ width: 100, height: 20, top: 0, left: 0 }];
};

for (const k of ['window', 'document', 'navigator', 'location', 'CSS', 'Event', 'MouseEvent', 'KeyboardEvent',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'getComputedStyle']) {
  global[k] = window[k];
}
global.window = window;

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'agent.js'), 'utf8');
window.eval(code);
const B = window.__beam;

let fail = 0;
const t = (name, fn) => {
  try { const r = fn(); console.log('✓ ' + name + (r ? '  ' + r : '')); }
  catch (e) { fail++; console.log('✗ ' + name + '  ' + e.message); }
};

t('snap lists the controls', () => {
  const r = B.run({ op: 'snap' });
  const lines = r.outline.split('\n');
  if (!/h1 Edit page/.test(r.outline)) throw new Error('h1 missing');
  if (!/input:text "Kicker" = "New collection 2026"/.test(r.outline)) throw new Error('kicker missing:\n' + r.outline);
  if (!/textarea "Description" .* \*/.test(r.outline)) throw new Error('required not marked');
  if (!/select "Status" = "Published" \{Draft\|Published\}/.test(r.outline)) throw new Error('select badly described');
  if (!/button "Update" #publish/.test(r.outline)) throw new Error('button missing');
  if (!/link "All pages" -> \/wp-admin\/edit\.php/.test(r.outline)) throw new Error('link missing');
  return lines.length + ' lines, ' + r.elements + ' elements';
});

t('fields exposes name and selector', () => {
  const r = B.run({ op: 'fields' });
  const pre = r.fields.find((f) => f.name === 'acf[field_aa]');
  if (!pre) throw new Error('acf field not found');
  if (pre.label !== 'Kicker') throw new Error('wrong label: ' + pre.label);
  const ta = r.fields.find((f) => f.name === 'acf[field_bb]');
  if (!ta.required) throw new Error('required lost');
  return r.count + ' fields';
});

t('fill by label', () => {
  B.run({ op: 'fill', target: 'label=Kicker', value: 'NEW COLLECTION 2026' });
  const v = window.document.querySelector('[name="acf[field_aa]"]').value;
  if (v !== 'NEW COLLECTION 2026') throw new Error('value = ' + v);
  return v;
});

t('fill by name with brackets', () => {
  B.run({ op: 'fill', target: 'name=acf[field_rep][row-0][field_ee]', value: 'Mexico · Cactus' });
  const v = window.document.querySelector('[name="acf[field_rep][row-0][field_ee]"]').value;
  if (v !== 'Mexico · Cactus') throw new Error('value = ' + v);
  return v;
});

t('fill by @n ref', () => {
  const snap = B.run({ op: 'snap' });
  const m = snap.outline.match(/@(\d+) textarea "Description"/);
  if (!m) throw new Error('ref not found');
  B.run({ op: 'fill', target: '@' + m[1], value: 'new text' });
  const v = window.document.querySelector('[name="acf[field_bb]"]').value;
  if (v !== 'new text') throw new Error('value = ' + v);
  return '@' + m[1];
});

t('select by visible label', () => {
  B.run({ op: 'select', target: 'label=Status', value: 'Draft' });
  const v = window.document.querySelector('[name="acf[field_cc]"]').value;
  if (v !== 'd') throw new Error('value = ' + v);
  return 'Draft';
});

t('select with a missing option lists the valid ones', () => {
  try { B.run({ op: 'select', target: 'label=Status', value: 'Nope' }); }
  catch (e) {
    if (!/available: Draft \| Published/.test(e.message)) throw new Error('unhelpful error: ' + e.message);
    return 'explanatory error';
  }
  throw new Error('should have failed');
});

t('check on a true_false field', () => {
  B.run({ op: 'check', target: 'label=Active', value: true });
  if (!window.document.querySelector('[name="acf[field_dd]"]').checked) throw new Error('not checked');
  B.run({ op: 'check', target: 'label=Active', value: false });
  if (window.document.querySelector('[name="acf[field_dd]"]').checked) throw new Error('not unchecked');
  return 'on/off';
});

t('contenteditable', () => {
  B.run({ op: 'fill', target: 'label=Notes', value: 'hello' });
  if (window.document.getElementById('rich').textContent !== 'hello') throw new Error('not written');
  return 'ok';
});

t('set fills in bulk and reports the errors', () => {
  const r = B.run({ op: 'set', map: {
    'name=acf[field_aa]': 'A', 'label=Description': 'B', 'label=Missing': 'C'
  } });
  if (r.filled !== 2) throw new Error('filled = ' + r.filled);
  if (r.errors.length !== 1) throw new Error('errors = ' + JSON.stringify(r.errors));
  return r.filled + ' ok, 1 expected error';
});

t('click fires events', () => {
  let hits = 0;
  window.document.getElementById('publish').addEventListener('click', () => hits++);
  B.run({ op: 'click', target: 'text=Update' });
  if (hits !== 1) throw new Error('clicks received: ' + hits);
  return '1 click';
});

t('input/change events on fill (React-safe)', () => {
  const el = window.document.querySelector('[name="acf[field_aa]"]');
  const seen = [];
  ['input', 'change', 'blur'].forEach((e) => el.addEventListener(e, () => seen.push(e)));
  B.run({ op: 'fill', target: 'name=acf[field_aa]', value: 'X' });
  if (seen.join(',') !== 'input,change,blur') throw new Error('events: ' + seen.join(','));
  return seen.join(' ');
});

t('set --dry shows the diff without writing', () => {
  const before = window.document.querySelector('[name="acf[field_aa]"]').value;
  const r = B.run({ op: 'set', dry: true, map: {
    'name=acf[field_aa]': 'NEW VALUE', 'label=Missing': 'x'
  } });
  if (!r.dry) throw new Error('dry flag missing');
  if (window.document.querySelector('[name="acf[field_aa]"]').value !== before) throw new Error('it actually wrote!');
  const c = r.changes[0];
  if (!c.changed || c.to !== 'NEW VALUE' || c.from !== before) throw new Error('wrong diff: ' + JSON.stringify(c));
  if (r.errors.length !== 1) throw new Error('error not reported');
  return '1 change expected, 1 error';
});

t('refs with a frame prefix', () => {
  const snap = B.run({ op: 'snap' });
  const m = snap.outline.match(/@(\d+) select/);
  B.run({ op: 'fill', target: '@7:' + m[1], value: 'Draft' });
  if (window.document.querySelector('[name="acf[field_cc]"]').value !== 'd') throw new Error('not resolved');
  return '@7:' + m[1];
});

t('visibility: falls back to styles when the page has no layout', () => {
  const orig = window.Element.prototype.getClientRects;
  window.Element.prototype.getClientRects = function () { return []; };
  try {
    const r = B.run({ op: 'snap' });
    if (!/Kicker/.test(r.outline)) throw new Error('field lost without layout');
    if (/Kicker.*\(hidden\)/.test(r.outline)) throw new Error('wrongly marked hidden');
    return r.elements + ' elements seen anyway';
  } finally { window.Element.prototype.getClientRects = orig; }
});

t('fields does not truncate values', () => {
  const long = 'x'.repeat(400);
  B.run({ op: 'fill', target: 'label=Description', value: long });
  const f = B.run({ op: 'fields' }).fields.find((x) => x.name === 'acf[field_bb]');
  if (f.value.length !== 400) throw new Error('truncated at ' + f.value.length);
  const t2 = B.run({ op: 'fields', vlen: 50 }).fields.find((x) => x.name === 'acf[field_bb]');
  if (t2.value.length > 60) throw new Error('--vlen ignored');
  return '400 whole characters, --vlen honoured';
});

t('outline shows the structure', () => {
  const r = B.run({ op: 'outline', depth: 3 });
  if (!/form#post/.test(r.structure)) throw new Error('form missing:\n' + r.structure);
  return r.structure.split('\n').length + ' lines';
});

(async () => {
  const r = await B.run({ op: 'do', steps: [
    { op: 'fill', target: 'label=Kicker', value: 'one' },
    { op: 'fill', target: 'label=Ghost', value: 'two', optional: true },
    { op: 'fill', target: 'label=Description', value: 'three' }
  ] });
  const ok = r.steps.filter((s) => !s.error).length;
  const ko = r.steps.filter((s) => s.error).length;
  console.log((ok === 2 && ko === 1) ? '✓ do: 2 ok, 1 optional failure' : '✗ do: ' + JSON.stringify(r));
  if (!(ok === 2 && ko === 1)) fail++;

  try {
    await B.run({ op: 'do', steps: [{ op: 'fill', target: 'label=Ghost', value: 'x' }, { op: 'info' }] });
    console.log('✗ do: it should have stopped on the non-optional error'); fail++;
  } catch (e) {
    console.log('✓ do stops on a non-optional error');
  }

  const w = await B.run({ op: 'wait', sel: '#publish', timeout: 500 });
  console.log(w.ready ? '✓ wait on a selector' : '✗ wait');

  console.log(fail ? '\n' + fail + ' tests failed' : '\nall tests passed');
  process.exit(fail ? 1 : 0);
})();
