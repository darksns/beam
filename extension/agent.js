/* Beam agent — lives in the isolated world of every tab.
 * Reads the page structure as compact text and acts on the DOM through a
 * closed set of operations (no eval, no arbitrary code).
 * No screenshots: everything that comes back is text. */
(function () {
  'use strict';
  /* the version lets a newer agent replace one that is already injected */
  var VERSION = 4;
  if (window.__beam && window.__beam.version === VERSION) return;

  var MAXREF = 1500;

  /* ------------------------------------------------------------- helpers */

  function clean(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    n = n || 80;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function visible(el) {
    if (el.getClientRects().length) return true;
    /* A tab never brought to the front has no layout: getClientRects() is empty
       for everything. In that case fall back to computed styles. */
    if (document.body && document.body.getClientRects().length) return false;
    var cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops++ < 12) {
      if (cur.hidden) return false;
      var st = getComputedStyle(cur);
      if (!st) break;
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  /* CSS.escape is not everywhere (old webviews, test environments) */
  function esc(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function cssPath(el) {
    if (el.id) return '#' + el.id;
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth++ < 4) {
      var p = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + cur.id); break; }
      var cls = (cur.className && typeof cur.className === 'string')
        ? cur.className.trim().split(/\s+/).slice(0, 2) : [];
      if (cls.length) p += '.' + cls.join('.');
      var self = cur;
      var sibs = cur.parentElement
        ? Array.prototype.filter.call(cur.parentElement.children, function (s) { return s.tagName === self.tagName; })
        : [];
      if (sibs.length > 1) p += ':nth-of-type(' + (Array.prototype.indexOf.call(sibs, cur) + 1) + ')';
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /* a control's label: label[for], wrapping label, aria, placeholder, name */
  function labelOf(el) {
    var t;
    if (el.id) {
      var l = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (l && (t = clean(l.textContent, 60))) return t;
    }
    var wrap = el.closest('label');
    if (wrap && (t = clean(wrap.textContent, 60))) return t;
    if ((t = el.getAttribute('aria-label'))) return clean(t, 60);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var r = document.getElementById(lb);
      if (r && (t = clean(r.textContent, 60))) return t;
    }
    /* admin panels (ACF, Gutenberg, tables) keep the label in a sibling, so walk
       up a few levels and stop at the first nearby candidate */
    var box = el.parentElement, hops = 0;
    while (box && hops++ < 4 && !/^(FORM|BODY|HTML)$/.test(box.tagName)) {
      var cand = box.querySelector('.acf-label label, .components-base-control__label, legend, label, .label, th');
      if (cand && !cand.contains(el)) {
        var forId = cand.getAttribute('for');
        if (!forId || forId === el.id) {
          if ((t = clean(cand.textContent, 60))) return t;
        }
      }
      box = box.parentElement;
    }
    if ((t = el.getAttribute('placeholder'))) return clean(t, 60);
    if ((t = el.getAttribute('name'))) return clean(t, 60);
    return '';
  }

  function editable(el) {
    return el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  }

  function accName(el) {
    return clean(el.getAttribute('aria-label') || el.value || el.textContent || el.getAttribute('title') || '', 70);
  }

  var INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
    '[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=switch],[role=option],' +
    '[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';

  /* ------------------------------------------------------------- targets */

  function resolve(target) {
    if (target == null) return null;
    if (typeof target === 'number') return B.refs[target] || null;
    var s = String(target).trim(), m;
    if ((m = s.match(/^@(?:\d+:)?(\d+)$/))) return B.refs[Number(m[1])] || null;
    if ((m = s.match(/^css=([\s\S]+)$/))) return document.querySelector(m[1]);
    if ((m = s.match(/^text=([\s\S]+)$/))) return byText(m[1]);
    if ((m = s.match(/^label=([\s\S]+)$/))) return byLabel(m[1]);
    if ((m = s.match(/^name=([\s\S]+)$/))) return document.querySelector('[name="' + esc(m[1]) + '"]');
    try { var el = document.querySelector(s); if (el) return el; } catch (e) {}
    return byText(s) || byLabel(s);
  }

  function byText(t) {
    var want = t.toLowerCase().trim();
    var pool = document.querySelectorAll(INTERACTIVE + ',label,h1,h2,h3,h4,td,th,li,span,p');
    var exact = null, part = null;
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      var s = clean(el.value || el.textContent, 200).toLowerCase();
      if (!s) continue;
      if (s === want) { if (!exact && visible(el)) exact = el; }
      else if (!part && s.indexOf(want) > -1 && s.length < want.length + 40 && visible(el)) part = el;
    }
    return exact || part;
  }

  function byLabel(t) {
    var want = t.toLowerCase().trim();
    var pool = document.querySelectorAll('input,select,textarea,[contenteditable="true"]');
    for (var i = 0; i < pool.length; i++) {
      if (labelOf(pool[i]).toLowerCase().indexOf(want) > -1) return pool[i];
    }
    return null;
  }

  function need(target) {
    var el = resolve(target);
    if (!el) throw new Error('element not found: ' + target);
    return el;
  }

  function ref(el) {
    var i = B.refs.indexOf(el);
    if (i > -1) return i;
    if (B.refs.length >= MAXREF) return -1;
    B.refs.push(el);
    return B.refs.length - 1;
  }

  /* ----------------------------------------------------------- snapshot */

  function ctlKind(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') return 'input:' + (el.type || 'text');
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    if (editable(el)) return 'editable';
    return tag;
  }

  function valueOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      var o = el.options[el.selectedIndex];
      return o ? o.textContent.trim() : '';
    }
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'on' : 'off';
    if (tag === 'input' || tag === 'textarea') {
      if (window.tinymce && el.id) {
        var ed = window.tinymce.get(el.id);
        if (ed && !ed.isHidden()) return ed.getContent({ format: 'text' });
      }
      return el.value;
    }
    if (editable(el)) return el.innerText;
    return '';
  }

  function describe(el, opts) {
    var kind = ctlKind(el);
    var line = '@' + ref(el) + ' ' + kind;
    var lab = (kind === 'button' || kind === 'link') ? accName(el) : labelOf(el);
    if (lab) line += ' "' + lab + '"';
    if (/^(input|textarea|select|editable)/.test(kind)) {
      var v = valueOf(el);
      line += ' = ' + (v ? JSON.stringify(clean(v, opts.vlen || 90)) : '""');
      if (el.tagName.toLowerCase() === 'select' && opts.options !== false) {
        line += ' {' + Array.prototype.slice.call(el.options, 0, 12)
          .map(function (o) { return o.textContent.trim(); }).join('|') + '}';
      }
      if (el.required) line += ' *';
    }
    if (kind === 'link' && el.href && opts.href !== false) line += ' -> ' + clean(el.getAttribute('href'), 70);
    if (el.disabled) line += ' (disabled)';
    if (!visible(el)) line += ' (hidden)';
    if (el.id) line += ' #' + el.id;
    return line;
  }

  function snap(opts) {
    opts = opts || {};
    B.refs = [];
    var root = opts.sel ? document.querySelector(opts.sel) : document.body;
    if (!root) throw new Error('selector not found: ' + opts.sel);
    var max = opts.max || 400;
    var out = [], count = 0, skipped = 0;
    var sel = INTERACTIVE + (opts.headings === false ? '' : ',h1,h2,h3,h4,legend,[role=heading]');
    var nodes = root.querySelectorAll(sel);

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (/^(H[1-4]|LEGEND)$/.test(el.tagName) || el.getAttribute('role') === 'heading') {
        var h = clean(el.textContent, 100);
        if (h) out.push(el.tagName.toLowerCase() + ' ' + h);
        continue;
      }
      if (el.type === 'hidden') continue;
      if (!opts.hidden && !visible(el) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { skipped++; continue; }
      if (count >= max) { skipped++; continue; }
      out.push(describe(el, opts));
      count++;
    }
    return {
      url: location.href,
      title: document.title,
      elements: count,
      truncated: skipped ? skipped + ' elements not shown (raise --max)' : undefined,
      outline: out.join('\n')
    };
  }

  /* structure: a tree of blocks, to grasp the layout without reading all the HTML */
  function outline(opts) {
    opts = opts || {};
    var root = opts.sel ? document.querySelector(opts.sel) : document.body;
    if (!root) throw new Error('selector not found: ' + opts.sel);
    var maxDepth = opts.depth || 5, lines = [], n = 0, cap = opts.max || 300;

    (function walk(el, d) {
      if (n >= cap || d > maxDepth) return;
      var kids = Array.prototype.filter.call(el.children, function (c) {
        return !/^(SCRIPT|STYLE|NOSCRIPT|LINK|META)$/.test(c.tagName);
      });
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (!opts.hidden && !visible(c)) continue;
        var tag = c.tagName.toLowerCase();
        var id = c.id ? '#' + c.id : '';
        var cls = (typeof c.className === 'string' && c.className.trim())
          ? '.' + c.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        var own = c.children.length ? '' : clean(c.textContent, 60);
        lines.push(new Array(d + 1).join('  ') + tag + id + cls + (own ? '  · ' + own : ''));
        n++;
        walk(c, d + 1);
      }
    })(root, 0);

    return { url: location.href, title: document.title, structure: lines.join('\n') };
  }

  /* the page's form fields, each with a stable selector — for data entry */
  function fields(opts) {
    opts = opts || {};
    var root = opts.sel ? document.querySelector(opts.sel) : document;
    if (!root) throw new Error('selector not found: ' + opts.sel);
    var nodes = root.querySelectorAll('input,select,textarea,[contenteditable="true"]');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.type === 'hidden' && !opts.hidden) continue;
      if (/^(submit|button|image)$/.test(el.type)) continue;
      out.push({
        ref: '@' + ref(el),
        label: labelOf(el),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        type: ctlKind(el),
        /* whole value by default: truncating here has already caused wrong
           readings. Whoever renders the result does the cutting, if needed. */
        value: opts.vlen ? clean(valueOf(el), opts.vlen) : valueOf(el),
        required: !!el.required,
        hidden: !visible(el),
        selector: cssPath(el)
      });
    }
    return { url: location.href, count: out.length, fields: out };
  }

  /* ------------------------------------------------------------ actions */

  function nativeSet(el, value) {
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
  }

  function fireAll(el, types) {
    types.forEach(function (t) {
      var ev = /^(click|mousedown|mouseup)$/.test(t)
        ? new MouseEvent(t, { bubbles: true, cancelable: true, view: window })
        : new Event(t, { bubbles: true });
      el.dispatchEvent(ev);
    });
    if (window.jQuery) { try { window.jQuery(el).trigger('change'); } catch (e) {} }
  }

  function fill(target, value) {
    var el = need(target);
    var tag = el.tagName.toLowerCase();

    if (editable(el)) {
      el.focus();
      el.textContent = String(value);
      fireAll(el, ['input', 'change', 'blur']);
      return { filled: clean(value, 60) };
    }
    if (tag === 'select') return select(target, value);
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      return check(target, value !== false && value !== 'off' && value !== '0');
    }

    /* WordPress / TinyMCE wysiwyg */
    var ed = window.tinymce && el.id && window.tinymce.get(el.id);
    if (ed) {
      var html = /<[a-z][\s\S]*>/i.test(value) ? value
        : String(value).split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br />') + '</p>'; }).join('');
      nativeSet(el, html);
      fireAll(el, ['input', 'change']);
      if (!ed.isHidden()) { ed.setContent(html); ed.fire('change'); ed.save(); }
      return { filled: clean(value, 60), via: 'tinymce' };
    }

    el.focus();
    nativeSet(el, value);
    fireAll(el, ['input', 'change', 'blur']);
    return { filled: clean(value, 60) };
  }

  function select(target, value) {
    var el = need(target);
    if (el.tagName.toLowerCase() !== 'select') throw new Error('not a <select>');
    var opt = Array.prototype.find.call(el.options, function (o) {
      return o.value === String(value) || o.textContent.trim() === String(value);
    });
    if (!opt) throw new Error('option "' + value + '" is missing; available: ' +
      Array.prototype.map.call(el.options, function (o) { return o.textContent.trim(); }).slice(0, 15).join(' | '));
    nativeSet(el, opt.value);
    var jq = window.jQuery;
    if (jq && jq(el).data && jq(el).data('select2')) jq(el).val(opt.value).trigger('change');
    else fireAll(el, ['input', 'change']);
    return { selected: opt.textContent.trim() };
  }

  function check(target, on) {
    var el = need(target);
    on = on === undefined ? true : !!on;
    /* native click: it toggles and fires the right events. No synthetic click
       after forcing .checked, or the state would flip back. */
    if (el.checked !== on && typeof el.click === 'function') el.click();
    if (el.checked !== on) { el.checked = on; fireAll(el, ['input', 'change']); }
    return { checked: el.checked };
  }

  function click(target) {
    var el = need(target);
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) {} }
    fireAll(el, ['mousedown', 'mouseup']);
    el.click();
    return { clicked: clean(accName(el) || el.tagName, 60), url: location.href };
  }

  function press(key, target) {
    var el = target ? need(target) : (document.activeElement || document.body);
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      el.dispatchEvent(new KeyboardEvent(t, { key: key, code: key, bubbles: true, cancelable: true }));
    });
    if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    return { pressed: key };
  }

  function setMany(map, dry) {
    var ok = [], err = [], changes = [];
    Object.keys(map).forEach(function (k) {
      try {
        if (dry) {
          var el = need(k);
          var before = valueOf(el);
          var after = String(map[k]);
          changes.push({
            target: k,
            label: labelOf(el) || ctlKind(el),
            changed: clean(before, 1e6) !== clean(after, 1e6),
            from: clean(before, 120),
            to: clean(after, 120)
          });
        } else {
          fill(k, map[k]);
        }
        ok.push(k);
      } catch (e) { err.push(k + ': ' + e.message); }
    });
    if (dry) return { dry: true, resolved: ok.length, errors: err, changes: changes };
    return { filled: ok.length, ok: ok, errors: err };
  }

  /* takes the bytes from the service worker (which fetched them free of CORS)
     and drops them into an input[type=file] the way a person would */
  function upload(cmd) {
    var el = need(cmd.target);
    if (el.tagName.toLowerCase() !== 'input' || el.type !== 'file') {
      throw new Error('the target is not an input[type=file]');
    }
    var bin = atob(cmd.b64);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    var file = new File([buf], cmd.name, { type: cmd.mime || 'application/octet-stream' });
    var dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    fireAll(el, ['input', 'change']);
    return { uploaded: cmd.name, bytes: buf.length, type: file.type };
  }

  function text(opts) {
    opts = opts || {};
    var el = opts.sel ? document.querySelector(opts.sel) : document.body;
    if (!el) throw new Error('selector not found: ' + opts.sel);
    var t = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    var from = opts.from || 0, max = opts.max || 20000;
    return { url: location.href, title: document.title, chars: t.length, text: t.slice(from, from + max) };
  }

  function html(opts) {
    opts = opts || {};
    var el = opts.sel ? document.querySelector(opts.sel) : document.body;
    if (!el) throw new Error('selector not found: ' + opts.sel);
    var h = el.outerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    return { chars: h.length, html: h.slice(0, opts.max || 30000) };
  }

  function wait(opts) {
    opts = opts || {};
    var deadline = Date.now() + (opts.timeout || 8000);
    return new Promise(function (resolve, reject) {
      (function tick() {
        var hit = null;
        if (opts.sel) hit = document.querySelector(opts.sel);
        else if (opts.text) hit = byText(opts.text);
        else if (opts.gone) hit = document.querySelector(opts.gone) ? null : document.body;
        else if (document.readyState === 'complete') hit = document.body;
        if (hit) return resolve({ ready: true, url: location.href });
        if (Date.now() > deadline) return reject(new Error('wait timed out: ' + JSON.stringify(opts)));
        setTimeout(tick, 100);
      })();
    });
  }

  function scroll(opts) {
    opts = opts || {};
    if (opts.sel) { var e = document.querySelector(opts.sel); if (e) e.scrollIntoView({ block: 'center' }); }
    else window.scrollBy(0, opts.by === undefined ? window.innerHeight * 0.9 : opts.by);
    return { y: window.scrollY, height: document.body.scrollHeight };
  }

  /* ---------------------------------------------------------------- run */

  var OPS = {
    info: function () { return { url: location.href, title: document.title, ready: document.readyState }; },
    snap: snap, outline: outline, fields: fields, text: text, html: html,
    click: function (c) { return click(c.target); },
    fill: function (c) { return fill(c.target, c.value); },
    set: function (c) { return setMany(c.map || {}, !!c.dry); },
    select: function (c) { return select(c.target, c.value); },
    check: function (c) { return check(c.target, c.value); },
    press: function (c) { return press(c.key, c.target); },
    scroll: scroll,
    wait: wait,
    upload: upload
  };

  function runOne(cmd) {
    var op = OPS[cmd.op];
    if (!op) throw new Error('unknown op: ' + cmd.op);
    return op(cmd);
  }

  var B = window.__beam = {
    version: VERSION,
    refs: [],
    run: function (cmd) {
      if (cmd.op !== 'do') return runOne(cmd);
      var steps = cmd.steps || [];
      return steps.reduce(function (chain, s, i) {
        return chain.then(function (acc) {
          /* new Promise also catches synchronous throws from runOne, which
             would otherwise skip this step's error handler */
          return new Promise(function (res) { res(runOne(s)); }).then(function (r) {
            acc.push({ step: i, op: s.op, result: r });
            return acc;
          }, function (e) {
            acc.push({ step: i, op: s.op, error: e.message });
            if (s.optional) return acc;
            var err = new Error('step ' + i + ' (' + s.op + '): ' + e.message);
            err.partial = acc;
            throw err;
          });
        });
      }, Promise.resolve([])).then(function (acc) { return { steps: acc }; });
    }
  };
})();
