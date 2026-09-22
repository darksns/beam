/* Beam agent — lives in the isolated world of every tab.
 * Reads the page structure as compact text and acts on the DOM through a
 * closed set of operations (no eval, no arbitrary code).
 * No screenshots: everything that comes back is text. */
(function () {
  'use strict';
  /* the version lets a newer agent replace one that is already injected */
  var VERSION = 6;
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

  /* TinyMCE / jQuery live in the page world. We reach them through the MAIN
     shim: a sync DOM event plus attributes, which both worlds share. */
  var markN = 0;
  function pageCall(req) {
    var root = document.documentElement;
    if (!root) return null;
    try {
      root.setAttribute('data-beam-shim', JSON.stringify(req));
      root.removeAttribute('data-beam-shim-r');
      document.dispatchEvent(new Event('__beam-shim'));
      var raw = root.getAttribute('data-beam-shim-r');
      root.removeAttribute('data-beam-shim');
      root.removeAttribute('data-beam-shim-r');
      if (!raw) return null;
      var out = JSON.parse(raw);
      return out && out.ok ? out.r : null;
    } catch (e) {
      try { root.removeAttribute('data-beam-shim'); root.removeAttribute('data-beam-shim-r'); } catch (e2) {}
      return null;
    }
  }
  function pageCallOn(el, req) {
    if (!el || el.nodeType !== 1) return pageCall(req);
    var mark = 'b' + (++markN);
    el.setAttribute('data-beam-el', mark);
    req.mark = mark;
    try { return pageCall(req); }
    finally { el.removeAttribute('data-beam-el'); }
  }

  function cssPath(el) {
    if (el.id) return '#' + esc(el.id);
    var parts = [], cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth++ < 4) {
      var p = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
      var cls = (cur.className && typeof cur.className === 'string')
        ? cur.className.trim().split(/\s+/).slice(0, 2) : [];
      if (cls.length) p += '.' + cls.map(esc).join('.');
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
    if ((m = s.match(/^title=([\s\S]+)$/))) return byTitle(m[1]);
    try { var el = document.querySelector(s); if (el) return el; } catch (e) {}
    return byText(s) || byLabel(s);
  }

  function byText(t) {
    var want = t.toLowerCase().trim();
    var pool = document.querySelectorAll(INTERACTIVE + ',label,h1,h2,h3,h4,td,th,li,span,p');
    var exact = null, part = null;
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      /* icon controls (Beaver Builder wrench) have no text, only a title */
      var s = clean(el.value || el.textContent, 200).toLowerCase();
      if (!s) s = clean(el.getAttribute('title') || el.getAttribute('aria-label') || '', 200).toLowerCase();
      if (!s) continue;
      if (s === want) { if (!exact && visible(el)) exact = el; }
      else if (!part && s.indexOf(want) > -1 && s.length < want.length + 40 && visible(el)) part = el;
    }
    return exact || part;
  }

  /* title= stays usable when the control is still display:none — a click fires anyway */
  function byTitle(t) {
    var want = t.toLowerCase().trim();
    var pool = document.querySelectorAll('[title]');
    var hidden = null, part = null;
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      var s = clean(el.getAttribute('title'), 200).toLowerCase();
      if (!s) continue;
      if (s === want) {
        if (visible(el)) return el;
        if (!hidden) hidden = el;
      } else if (!part && s.indexOf(want) > -1 && s.length < want.length + 40 && visible(el)) part = el;
    }
    return hidden || part;
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
    if (tag === 'textarea' || tag === 'select') return tag;
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
      if (el.id) {
        var fromEd = pageCall({ op: 'tinymceGet', id: el.id });
        if (fromEd != null) return fromEd;
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
    pageCallOn(el, { op: 'notify', value: el.value });
  }

  function fill(target, value) {
    var el = need(target);
    var tag = el.tagName.toLowerCase();

    /* a form control keeps its own value even when something stuck
       contenteditable on it (WordPress does this to wp-editor-area) */
    if (editable(el) && !/^(textarea|input|select)$/.test(tag)) {
      el.focus();
      el.textContent = String(value);
      fireAll(el, ['input', 'change', 'blur']);
      return { filled: clean(value, 60) };
    }
    if (tag === 'select') return select(target, value);
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      return check(target, value !== false && value !== 'off' && value !== '0');
    }

    /* WordPress / TinyMCE: the editor object is in the page world. The shim
       tells us if it exists; we still write the textarea so the text tab
       stays in sync. */
    var html = /<[a-z][\s\S]*>/i.test(value) ? String(value)
      : String(value).split(/\n{2,}/).map(function (p) { return '<p>' + p.replace(/\n/g, '<br />') + '</p>'; }).join('');
    var via = el.id ? pageCall({ op: 'tinymceSet', id: el.id, html: html }) : null;
    el.focus();
    nativeSet(el, (via && via.via) ? html : String(value));
    fireAll(el, ['input', 'change', 'blur']);
    if (via && via.via) return { filled: clean(value, 60), via: 'tinymce' };
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
    fireAll(el, ['input', 'change']);
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

  /* A synthetic event never puts the pointer in :hover, and Beaver Builder
     (VamTam uses it) does not keep the wrench in the DOM: the overlay is built
     on mousemove, and only if clientX/clientY land inside the node — a
     coordinateless event is treated as "outside" and the overlay is removed
     on the same bubble. So: real coordinates, plus a copy of every :hover
     rule keyed off [data-beam-hover] for stylesheets that show the control
     with CSS alone. */
  function pointOf(el) {
    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) {}
    if (!r || (!r.width && !r.height)) return { x: 1, y: 1, layout: false };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, layout: true };
  }

  function mouseEvt(type, x, y, related) {
    var enter = type === 'mouseenter' || type === 'pointerenter';
    var PE = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    var Ctor = type.indexOf('pointer') === 0 ? PE : MouseEvent;
    var init = {
      bubbles: !enter,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      relatedTarget: related || null,
      button: 0,
      buttons: 0
    };
    if (Ctor !== MouseEvent) {
      init.pointerId = 1;
      init.pointerType = 'mouse';
      init.isPrimary = true;
    }
    try { return new Ctor(type, init); }
    catch (e) { return new MouseEvent(type, init); }
  }

  function markHover(el) {
    var prev = document.querySelectorAll('[data-beam-hover]');
    for (var i = 0; i < prev.length; i++) prev[i].removeAttribute('data-beam-hover');
    var cur = el;
    while (cur && cur.nodeType === 1) {
      cur.setAttribute('data-beam-hover', '');
      cur = cur.parentElement;
    }
  }

  function harvestHover(rules, out, depth) {
    if (!rules || depth > 8) return;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.selectorText && rule.selectorText.indexOf(':hover') !== -1 && rule.style) {
        var sel = rule.selectorText.replace(/:hover/g, '[data-beam-hover]');
        var css = rule.style.cssText;
        if (sel !== rule.selectorText && css) out.push(sel + '{' + css + '}');
      }
      if (rule.styleSheet) {
        try { harvestHover(rule.styleSheet.cssRules, out, depth + 1); } catch (e) {}
      } else if (rule.cssRules && !rule.selectorText) {
        var inner = [];
        harvestHover(rule.cssRules, inner, depth + 1);
        if (!inner.length) continue;
        if (rule.conditionText && rule.type === 4) out.push('@media ' + rule.conditionText + '{' + inner.join('') + '}');
        else if (rule.conditionText && rule.type === 12) out.push('@supports ' + rule.conditionText + '{' + inner.join('') + '}');
        else out.push(inner.join(''));
      }
    }
  }

  function forceCssHover() {
    var found = [];
    var sheets = [];
    try { sheets = Array.prototype.slice.call(document.styleSheets || []); } catch (e) {}
    if (document.adoptedStyleSheets && document.adoptedStyleSheets.length) {
      sheets = sheets.concat(Array.prototype.slice.call(document.adoptedStyleSheets));
    }
    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      if (sheet.ownerNode && sheet.ownerNode.id === 'beam-hover-css') continue;
      try { harvestHover(sheet.cssRules, found, 0); } catch (e) {}
    }
    var style = document.getElementById('beam-hover-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'beam-hover-css';
      (document.head || document.documentElement).appendChild(style);
    }
    var ss = style.sheet;
    if (!ss) return found.length;
    while (ss.cssRules.length) ss.deleteRule(0);
    var n = 0;
    for (var j = 0; j < found.length && n < 1500; j++) {
      try { ss.insertRule(found[j], ss.cssRules.length); n++; } catch (e2) {}
    }
    return n;
  }

  var REVEALED = INTERACTIVE + ',[title],[aria-label],.fl-block-settings,.fl-block-remove,.fl-block-copy,.fl-block-move';

  function hover(target) {
    var el = need(target);
    if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    }
    var before = new Set();
    var beforeVis = new Map();
    var prior = document.querySelectorAll(REVEALED);
    for (var i = 0; i < prior.length; i++) {
      before.add(prior[i]);
      beforeVis.set(prior[i], visible(prior[i]));
    }

    markHover(el);
    forceCssHover();
    var pt = pointOf(el);
    var related = document.documentElement && document.documentElement !== el && !el.contains(document.documentElement)
      ? document.documentElement : null;
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach(function (type) {
      el.dispatchEvent(mouseEvt(type, pt.x, pt.y, related));
    });

    /* BB 2.11+ puts the overlay in a popover. If the builder's own showPopover
       threw (the handler aborts, the node is already in the DOM), open it.
       manual popovers do not need a user gesture. */
    var pops = document.querySelectorAll('.fl-block-overlay[popover]');
    for (var p = 0; p < pops.length; p++) {
      try {
        if (typeof pops[p].showPopover !== 'function') continue;
        var open = false;
        try { open = pops[p].matches(':popover-open'); } catch (e2) {}
        if (!open) pops[p].showPopover();
      } catch (e3) {}
    }

    var found = [];
    var after = document.querySelectorAll(REVEALED);
    for (var k = 0; k < after.length; k++) {
      var node = after[k];
      if (node === el) continue;
      var tag = node.tagName;
      if (/^(SCRIPT|STYLE|LINK|META|HTML|BODY)$/.test(tag)) continue;
      var now = visible(node);
      var isNew = !before.has(node);
      var became = before.has(node) && !beforeVis.get(node) && now;
      if (isNew || became) found.push(node);
    }
    found.sort(function (a, b) {
      function rank(n) {
        var c = typeof n.className === 'string' ? n.className : '';
        if (/settings/.test(c)) return 0;
        if (/fl-block-|overlay/.test(c)) return 1;
        return 2;
      }
      return rank(a) - rank(b);
    });
    if (found.length > 40) found = found.slice(0, 40);

    var lines = found.map(function (node) {
      var name = clean(node.getAttribute('title') || node.getAttribute('aria-label') || node.textContent, 70);
      var line = '@' + ref(node) + ' ' + ctlKind(node);
      if (name) line += ' "' + name + '"';
      var c = typeof node.className === 'string' ? node.className : '';
      var hit = c.split(/\s+/).filter(function (x) { return /settings|fl-block-/.test(x); }).slice(0, 2);
      if (hit.length) line += ' .' + hit.join('.');
      if (!visible(node)) line += ' (hidden)';
      return line;
    });

    return {
      hovered: clean(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || el.tagName, 60),
      x: Math.round(pt.x),
      y: Math.round(pt.y),
      layout: pt.layout,
      count: lines.length,
      revealed: lines.join('\n')
    };
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
    hover: function (c) { return hover(c.target); },
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
