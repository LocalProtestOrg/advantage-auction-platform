/* Shared loader for the terms pages (/terms.html and /buyer-terms.html).
 * Both render the CURRENT published terms version from GET /api/terms/current through the same safe renderer
 * (md-render.js: escaped text, allow-listed links, heading anchors), so the two pages always show the same document.
 * Requires md-render.js to be loaded first. Markup is built with DOM calls or the renderer's escaped output.
 *
 *   AdvTermsPage.mount({ docId, metaId, acceptId, fallbackId }) -> Promise<terms|null>
 *   AdvTermsPage.render(terms, docEl, metaEl)                     -> renders one version into the page
 */
(function () {
  'use strict';
  function fmtDate(d) {
    try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; }
  }
  function render(t, docEl, metaEl) {
    var html = window.renderMarkdown(t.body_markdown || '');
    docEl.className = 'doc';
    docEl.innerHTML = (window.renderMarkdownToc ? window.renderMarkdownToc(html, 4) : '') + html;
    if (metaEl) {
      metaEl.hidden = false;
      metaEl.textContent = 'Version ' + t.version_int + (t.effective_at ? ' · Effective ' + fmtDate(t.effective_at) : '');
    }
    // A deep link (#section) points at a heading that only exists once rendered.
    if (location.hash) { var target = document.getElementById(location.hash.slice(1)); if (target) target.scrollIntoView(); }
  }
  function token() { try { return localStorage.getItem('token'); } catch (e) { return null; } }
  function link(href, text) { var a = document.createElement('a'); a.href = href; a.textContent = text; return a; }

  async function acceptState(versionInt, el) {
    if (!el) return;
    var tk = token();
    el.hidden = false; el.textContent = '';
    if (!tk) {
      el.appendChild(document.createTextNode('Members accept the current version when they create an account. '));
      el.appendChild(link('/login.html?tab=register', 'Create an Account'));
      return;
    }
    try {
      var r = await fetch('/api/terms/me/acceptance', { headers: { Authorization: 'Bearer ' + tk } });
      if (!r.ok) { el.hidden = true; return; }
      var d = await r.json();
      if (d && d.success && d.data && d.data.accepted_current) {
        el.textContent = 'You have accepted the current version (version ' + versionInt + ').';
      } else {
        el.appendChild(document.createTextNode('Our terms have been updated. '));
        el.appendChild(link('/buyer-terms.html?next=' + encodeURIComponent(location.pathname), 'Review and Accept'));
      }
    } catch (e) { el.hidden = true; }
  }

  async function mount(o) {
    var docEl = document.getElementById(o.docId), metaEl = o.metaId ? document.getElementById(o.metaId) : null;
    var acceptEl = o.acceptId ? document.getElementById(o.acceptId) : null;
    try {
      var res = await fetch('/api/terms/current');
      var data = await res.json();
      if (data && data.success && data.data) {
        render(data.data, docEl, metaEl);
        acceptState(data.data.version_int, acceptEl);
        return data.data;
      }
    } catch (e) { /* fall through to the saved copy */ }
    var fb = o.fallbackId ? document.getElementById(o.fallbackId) : null;
    if (fb && (fb.textContent || '').trim()) {
      docEl.innerHTML = window.renderMarkdown(fb.textContent);
      if (metaEl) { metaEl.hidden = false; metaEl.textContent = 'We could not load the current version just now. This is a saved copy; please refresh the page to see the current version.'; }
    } else {
      docEl.textContent = 'The terms could not be loaded. Please refresh the page or contact info@advantage.bid.';
    }
    return null;
  }

  window.AdvTermsPage = { mount: mount, render: render };
})();
