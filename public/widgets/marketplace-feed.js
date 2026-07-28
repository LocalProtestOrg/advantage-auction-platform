/* ============================================================================
   Advantage Marketplace Feed — the unified public List View (auctions + estate sales).
   ONE feed, ONE search, ONE card renderer, powered entirely by Railway
   (/api/public/marketplace/feed). Embeddable on Brilliant Directories' /all-events
   and hostable on Railway. List|Map toggle: Map hands off to the Railway map;
   filters are carried in the URL so switching views never loses context.

   Embed:  <div id="advantage-marketplace-feed"></div>
           <script src="https://bid.advantage.bid/widgets/marketplace-feed.js"></script>
   ========================================================================== */
(function () {
  'use strict';
  var API_BASE = 'https://bid.advantage.bid';
  var MAP_URL  = API_BASE + '/';                 // Railway canonical Map View
  var LIST_URL = 'https://www.advantage.bid/all-events'; // canonical public List View (BD)
  var PAGE = 24;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- filter state: read from this page's URL so an embed inherits BD's query, and so List⇄Map preserves context
  function readFilters() {
    var p; try { p = new URLSearchParams(location.search); } catch (e) { p = new URLSearchParams(''); }
    return {
      q: (p.get('q') || '').trim(),
      city: (p.get('city') || '').trim(),
      state: (p.get('state') || '').trim(),
      zip: (p.get('zip') || '').trim(),
      type: (['auction', 'estate_sale'].indexOf(p.get('type')) !== -1 ? p.get('type') : 'all')
    };
  }
  function qs(f, extra) {
    var p = new URLSearchParams();
    if (f.q) p.set('q', f.q); if (f.city) p.set('city', f.city); if (f.state) p.set('state', f.state);
    if (f.zip) p.set('zip', f.zip); if (f.type && f.type !== 'all') p.set('type', f.type);
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    var s = p.toString(); return s ? ('?' + s) : '';
  }
  function pushUrl(f) { try { history.replaceState(null, '', location.pathname + qs(f)); } catch (e) {} }

  var CSS = ''
    + '.amf{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:1120px;margin:0 auto;padding:0 14px 40px}'
    + '.amf *{box-sizing:border-box}'
    + '.amf-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 6px}'
    + '.amf-search{flex:1;min-width:220px;display:flex;gap:8px;flex-wrap:wrap}'
    + '.amf-inp{flex:1;min-width:150px;font:inherit;font-size:14px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}'
    + '.amf-inp:focus{outline:2px solid #2563eb;border-color:#2563eb}'
    + '.amf-btn{font:inherit;font-weight:700;font-size:14px;padding:10px 16px;border-radius:10px;border:1px solid transparent;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}'
    + '.amf-btn.primary{background:#2563eb;color:#fff}.amf-btn.ghost{background:#fff;color:#0f172a;border-color:#e2e8f0}'
    + '.amf-toggle{display:inline-flex;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}'
    + '.amf-toggle a{padding:9px 15px;font-weight:700;font-size:13.5px;text-decoration:none;color:#475569;background:#fff}'
    + '.amf-toggle a[aria-current="true"]{background:#0f172a;color:#fff}'
    + '.amf-types{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 16px}'
    + '.amf-chip{font-size:12.5px;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;color:#475569;cursor:pointer}'
    + '.amf-chip[aria-pressed="true"]{background:#eef4ff;border-color:#bfd3ff;color:#1d4ed8}'
    + '.amf-count{color:#64748b;font-size:13px;margin:0 2px 10px}'
    + '.amf-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}'
    + '.amf-card{display:block;background:#fff;border:1px solid #e6e9ef;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(15,23,42,.04),0 10px 24px -14px rgba(15,23,42,.2);transition:transform .1s,box-shadow .1s}'
    + '.amf-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(15,23,42,.08),0 24px 44px -20px rgba(15,23,42,.3)}'
    + '.amf-img{width:100%;aspect-ratio:3/2;object-fit:cover;background:#eef1f5;display:block}'
    + '.amf-imgph{width:100%;aspect-ratio:3/2;background:#eef1f5;display:grid;place-items:center;font-size:30px}'
    + '.amf-body{padding:13px 14px 15px}'
    + '.amf-badge{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:6px;margin-bottom:8px}'
    + '.amf-b-live{background:#e7f7f0;color:#059669}.amf-b-soon{background:#fdf3e7;color:#b45309}.amf-b-up{background:#eef4ff;color:#1d4ed8}.amf-b-sale{background:#f3e8ff;color:#7c3aed}'
    + '.amf-title{font-weight:700;font-size:15px;line-height:1.3;margin:0 0 5px}'
    + '.amf-meta{color:#64748b;font-size:12.5px;line-height:1.5}'
    + '.amf-state,.amf-empty{text-align:center;padding:52px 20px;color:#64748b}'
    + '.amf-empty .e{font-size:34px;display:block;margin-bottom:10px}.amf-empty h3{color:#0f172a;font-size:17px;margin:0 0 4px}'
    + '.amf-more{text-align:center;margin-top:22px}'
    + '.amf-skel{border-radius:14px;height:250px;background:linear-gradient(90deg,#eef1f5 25%,#e2e8f0 37%,#eef1f5 63%);background-size:400% 100%;animation:amfsh 1.3s ease infinite}'
    + '@keyframes amfsh{0%{background-position:100% 0}100%{background-position:0 0}}'
    + '@media(max-width:560px){.amf-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}}';

  function relTime(iso, future) {
    if (!iso) return ''; var ms = new Date(iso).getTime() - Date.now(); var a = Math.abs(ms);
    var m = Math.round(a / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
    var v = d >= 1 ? (d + 'd') : (h >= 1 ? (h + 'h') : (Math.max(1, m) + 'm'));
    return future ? (ms > 0 ? ('in ' + v) : 'now') : v;
  }
  function whenLabel(it) {
    if (it.type === 'estate_sale') {
      if (it.starts_at) { try { return new Date(it.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) {} }
      return 'Estate sale';
    }
    if (it.status === 'active' && it.ends_at) return 'Ends ' + relTime(it.ends_at, true);
    if (it.starts_at) { var ms = new Date(it.starts_at).getTime() - Date.now(); if (ms > 0) return 'Starts ' + relTime(it.starts_at, true); }
    return 'Live auction';
  }
  function badge(it) {
    if (it.type === 'estate_sale') return '<span class="amf-badge amf-b-sale">Estate Sale</span>';
    if (it.status === 'active') {
      var soon = it.ends_at && (new Date(it.ends_at).getTime() - Date.now()) < 24 * 3600 * 1000;
      return soon ? '<span class="amf-badge amf-b-soon">Ending soon</span>' : '<span class="amf-badge amf-b-live">Live auction</span>';
    }
    return '<span class="amf-badge amf-b-up">Upcoming</span>';
  }
  function card(it) {
    var loc = [it.city, it.state].filter(Boolean).join(', ');
    var img = it.image_url
      ? '<img class="amf-img" src="' + esc(it.image_url) + '" alt="" loading="lazy">'
      : '<div class="amf-imgph">' + (it.type === 'estate_sale' ? '🏛️' : '🔨') + '</div>';
    var meta = [whenLabel(it), loc, (it.company ? ('by ' + esc(it.company)) : '')].filter(Boolean)
      .map(function (x, i) { return i ? ('<div>' + x + '</div>') : ('<div>' + x + '</div>'); }).join('');
    return '<a class="amf-card" href="' + API_BASE + esc(it.url) + '">' + img +
      '<div class="amf-body">' + badge(it) + '<div class="amf-title">' + esc(it.title || 'Untitled') + '</div>' +
      '<div class="amf-meta">' + meta + '</div></div></a>';
  }

  var root, state = { f: readFilters(), items: [], total: 0, loading: false };

  function controlsHtml() {
    var f = state.f;
    var typ = function (v, label) { return '<button class="amf-chip" data-type="' + v + '" aria-pressed="' + (f.type === v) + '">' + label + '</button>'; };
    return '<div class="amf-bar">' +
      '<form class="amf-search" id="amf-form">' +
        '<input class="amf-inp" id="amf-q" placeholder="Search auctions & estate sales, city, or company" value="' + esc(f.q) + '">' +
        '<input class="amf-inp" id="amf-city" placeholder="City" value="' + esc(f.city) + '" style="max-width:140px">' +
        '<input class="amf-inp" id="amf-state" placeholder="State" value="' + esc(f.state) + '" maxlength="2" style="max-width:74px;text-transform:uppercase">' +
        '<input class="amf-inp" id="amf-zip" placeholder="ZIP" value="' + esc(f.zip) + '" style="max-width:90px">' +
        '<button class="amf-btn primary" type="submit">Search</button>' +
      '</form>' +
      '<div class="amf-toggle"><a href="#" aria-current="true">List</a>' +
        '<a id="amf-map" href="' + MAP_URL + qs(f, { view: 'map' }) + '" target="_top">Map</a></div>' +
    '</div>' +
    '<div class="amf-types">' + typ('all', 'All') + typ('auction', '🔨 Auctions') + typ('estate_sale', '🏛️ Estate Sales') + '</div>' +
    '<div class="amf-count" id="amf-count"></div>';
  }
  function skeletons() { var s = ''; for (var i = 0; i < 8; i++) s += '<div class="amf-skel"></div>'; return '<div class="amf-grid">' + s + '</div>'; }

  function render() {
    root.innerHTML = '<div class="amf">' + controlsHtml() + '<div id="amf-results">' + skeletons() + '</div></div>';
    wire();
    load(true);
  }
  function wire() {
    var form = $('#amf-form', root);
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      state.f.q = $('#amf-q').value.trim(); state.f.city = $('#amf-city').value.trim();
      state.f.state = $('#amf-state').value.trim(); state.f.zip = $('#amf-zip').value.trim();
      apply();
    });
    root.querySelectorAll('[data-type]').forEach(function (b) {
      b.addEventListener('click', function () { state.f.type = b.getAttribute('data-type'); apply(); });
    });
  }
  function apply() { pushUrl(state.f); syncMapLink(); root.querySelectorAll('[data-type]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-type') === state.f.type); }); load(true); }
  function syncMapLink() { var m = $('#amf-map', root); if (m) m.href = MAP_URL + qs(state.f, { view: 'map' }); }

  function load(reset) {
    if (state.loading) return; state.loading = true;
    if (reset) { state.items = []; $('#amf-results', root).innerHTML = skeletons(); }
    var url = API_BASE + '/api/public/marketplace/feed' + qs(state.f, { limit: PAGE, offset: state.items.length });
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      state.loading = false;
      var got = (d && d.data) || []; state.total = (d && d.total) || 0;
      state.items = state.items.concat(got);
      paint(d && d.has_more);
    }).catch(function () { state.loading = false; $('#amf-results', root).innerHTML =
      '<div class="amf-state">We couldn\'t load the marketplace just now. Please try again.</div>'; });
  }
  function paint(hasMore) {
    var host = $('#amf-results', root), cnt = $('#amf-count', root);
    if (!state.items.length) {
      host.innerHTML = '<div class="amf-empty"><span class="e">🔍</span><h3>No events match your search</h3>' +
        '<p>Try a broader search, or browse everything.</p><p style="margin-top:12px">' +
        '<button class="amf-btn ghost" id="amf-clear">Clear filters</button></p></div>';
      var c = $('#amf-clear', root); if (c) c.addEventListener('click', function () { state.f = { q: '', city: '', state: '', zip: '', type: 'all' }; render(); });
      if (cnt) cnt.textContent = ''; return;
    }
    if (cnt) cnt.textContent = state.total + ' event' + (state.total === 1 ? '' : 's');
    host.innerHTML = '<div class="amf-grid">' + state.items.map(card).join('') + '</div>' +
      (hasMore ? '<div class="amf-more"><button class="amf-btn ghost" id="amf-more">Show more</button></div>' : '');
    var more = $('#amf-more', root); if (more) more.addEventListener('click', function () { load(false); });
  }

  function mount() {
    root = document.getElementById('advantage-marketplace-feed');
    if (!root) { root = document.createElement('div'); root.id = 'advantage-marketplace-feed'; document.body.appendChild(root); }
    if (!document.getElementById('amf-style')) { var st = document.createElement('style'); st.id = 'amf-style'; st.textContent = CSS; document.head.appendChild(st); }
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.AdvantageMarketplaceFeed = { mount: mount };
})();
