/* Beam page shim — MAIN world. TinyMCE and jQuery live here; the isolated
 * agent cannot see them. Talks through a DOM event + attributes, not the
 * page's JS namespace beyond the two libraries it needs. */
(function () {
  'use strict';
  var VERSION = 1;
  if (window.__beamShim === VERSION) return;
  window.__beamShim = VERSION;

  document.addEventListener('__beam-shim', function () {
    var root = document.documentElement;
    var raw = root.getAttribute('data-beam-shim');
    root.removeAttribute('data-beam-shim');
    var req, out;
    try { req = JSON.parse(raw); } catch (e) { return; }
    try { out = { ok: true, r: handle(req) }; }
    catch (e) { out = { ok: false, e: String(e && e.message || e) }; }
    root.setAttribute('data-beam-shim-r', JSON.stringify(out));
  }, true);

  function elOf(req) {
    if (!req || !req.mark) return null;
    return document.querySelector('[data-beam-el="' + req.mark + '"]');
  }

  function handle(req) {
    if (req.op === 'tinymceGet') {
      var ed = window.tinymce && window.tinymce.get(req.id);
      if (!ed || ed.isHidden()) return null;
      return ed.getContent({ format: 'text' });
    }
    if (req.op === 'tinymceSet') {
      var edSet = window.tinymce && window.tinymce.get(req.id);
      if (!edSet) return { via: null };
      if (!edSet.isHidden()) {
        edSet.setContent(req.html);
        edSet.fire('change');
        edSet.save();
      }
      return { via: 'tinymce' };
    }
    if (req.op === 'notify') {
      var el = elOf(req);
      var jq = window.jQuery;
      if (!el || !jq) return null;
      try {
        if (el.tagName === 'SELECT' && jq(el).data && jq(el).data('select2')) {
          jq(el).val(el.value).trigger('change');
          return { via: 'select2' };
        }
        jq(el).trigger('change');
        return { via: 'jquery' };
      } catch (e) { return null; }
    }
    return null;
  }
})();
