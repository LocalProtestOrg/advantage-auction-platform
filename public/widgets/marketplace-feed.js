/* ============================================================================
   Advantage Marketplace Feed — the canonical Railway event-feed engine.
   ONE engine, THREE server-enforced presets: all-events · auctions · estate-sales.
   Location search (free-text → geocode → lat/lng), radius slider, Use-My-Location,
   one shared event-card renderer, List|Map continuity, cross-preset persistence,
   analytics, accessibility. Railway is the sole source of truth; the server enforces
   eligibility, type, privacy, and seller anonymity — the client only requests.

   Embed:
     <div id="advantage-marketplace-feed" data-preset="all-events"></div>
     <script src="https://bid.advantage.bid/widgets/marketplace-feed.js"></script>
   Presets: data-preset="all-events" | "auctions" | "estate-sales"
   ========================================================================== */
(function () {
  'use strict';
  var API_BASE = 'https://bid.advantage.bid';
  var MAP_URL  = API_BASE + '/';
  var LIST_URL = 'https://www.advantage.bid/all-events';
  var LOC_KEY  = 'ab_feed_loc';          // shared across all three presets
  var PAGE_SIZE = 12;                     // event cards per page (server default is the same, centralized)
  var PRESET_TYPE = { 'all-events': 'all', 'auctions': 'auction', 'estate-sales': 'estate_sale' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, r) { return (r || document).querySelector(sel); }

  // ---- analytics (no precise/typed address ever in a payload) ----
  function track(event, data) {
    try {
      var payload = Object.assign({ widget: 'marketplace_feed', preset: state.preset }, data || {});
      if (window.dataLayer && window.dataLayer.push) window.dataLayer.push(Object.assign({ event: 'adv_' + event }, payload));
      document.dispatchEvent(new CustomEvent('advantage:feed:' + event, { detail: payload }));
    } catch (e) {}
  }

  // ---- persisted location (shared) ----
  function loadLoc() { try { return JSON.parse(localStorage.getItem(LOC_KEY) || 'null'); } catch (e) { return null; } }
  function saveLoc(l) { try { l ? localStorage.setItem(LOC_KEY, JSON.stringify(l)) : localStorage.removeItem(LOC_KEY); } catch (e) {} }

  // ---- parent (Brilliant Directories) iframe coordination via postMessage ----
  // The widget measures its own rendered height and asks the parent to size the iframe to it, so the
  // iframe never grows its own inner scrollbar. On an intentional pagination action it also asks the
  // parent to scroll to the top of the widget. Only layout data (a height integer / a scroll intent)
  // ever leaves the frame; we never read the parent DOM. The parent validates every message strictly.
  var WIDGET_ID = 'marketplace-feed', MSG_SRC = 'advantage-bid-widget';
  var lastPostedHeight = 0, heightTimer = null;
  function inIframe() { try { return window.parent && window.parent !== window; } catch (e) { return true; } }
  // Restrict the outgoing target to the approved BD parent origin when derivable from the referrer;
  // fall back to '*' only for this non-sensitive layout payload (the parent still validates on receipt).
  function parentTargetOrigin() {
    try { var o = new URL(document.referrer).origin;
      if (o === 'https://www.advantage.bid' || o === 'https://advantage.bid') return o; } catch (e) {}
    return '*';
  }
  function post(msg) { if (!inIframe()) return; try { window.parent.postMessage(msg, parentTargetOrigin()); } catch (e) {} }
  function measureHeight() {
    // Measure the TRUE content-wrapper height (the widget's own root element), which shrink-wraps its
    // content and is INDEPENDENT of the iframe's assigned viewport height. Do NOT use
    // document(Element).scrollHeight: <html> fills the iframe viewport, so its scrollHeight equals the
    // parent-assigned iframe height whenever content is shorter — combined with a growth buffer that made
    // every cycle report a taller value, creeping the iframe down forever. Content height is stable, so
    // measuring the wrapper converges. body.scrollHeight is a safe fallback (body shrink-wraps content;
    // unlike <html> it does NOT inflate to the viewport).
    var el = root || document.getElementById('advantage-marketplace-feed');
    var h = el ? el.getBoundingClientRect().height : 0;
    if (!h && document.body) h = document.body.scrollHeight;
    return Math.ceil(h) + 2;
  }
  // Debounced + oscillation-guarded height post (skips sub-3px jitter to avoid resize loops).
  function postHeight(force) {
    var h = measureHeight();
    if (!force && Math.abs(h - lastPostedHeight) < 3) return;
    lastPostedHeight = h;
    post({ source: MSG_SRC, type: 'resize', widget: WIDGET_ID, height: h });
  }
  function scheduleHeight() { if (heightTimer) return; heightTimer = setTimeout(function () { heightTimer = null; postHeight(false); }, 100); }
  function postScroll() { post({ source: MSG_SRC, type: 'scroll-to-widget', widget: WIDGET_ID, target: 'results-top' }); }
  function resetInternalScroll() { try { window.scrollTo(0, 0); } catch (e) {} } // reset any residual inner scroll
  // The BD parent may attach its listener AFTER we've already posted our initial height (its helper
  // loads from footer scripts). So we also answer an explicit height request from a trusted BD parent —
  // this closes the load-order race deterministically. We validate the parent origin + envelope (req 16).
  function isTrustedParentOrigin(o) { return o === 'https://www.advantage.bid' || o === 'https://advantage.bid'; }
  function onParentMessage(e) {
    try {
      if (!isTrustedParentOrigin(e.origin)) return;
      var d = e.data;
      if (!d || d.source !== 'advantage-bid-embed' || d.widget !== WIDGET_ID) return;
      if (d.type === 'request-resize') postHeight(true);
    } catch (err) {}
  }
  function observeSize() {
    try { if (window.ResizeObserver) { new ResizeObserver(scheduleHeight).observe(document.body); } } catch (e) {}
    // Fallbacks for no ResizeObserver + genuine responsive/layout/image events (height-only, never scroll).
    try { window.addEventListener('resize', scheduleHeight); } catch (e) {}
    try { window.addEventListener('load', function () { postHeight(true); }); } catch (e) {}
    try { document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') scheduleHeight(); }, true); } catch (e) {}
    try { window.addEventListener('message', onParentMessage); } catch (e) {}
  }

  var CSS = ''
    + '.amf{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:1120px;margin:0 auto;padding:0 14px 40px}'
    + '.amf *{box-sizing:border-box}'
    + '.amf-controls{background:#fff;border:1px solid #e6e9ef;border-radius:16px;padding:16px;margin:14px 0 18px;box-shadow:0 1px 2px rgba(15,23,42,.04)}'
    + '.amf-locrow{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}'
    + '.amf-field{flex:1;min-width:220px}'
    + '.amf-lab{display:block;font-size:12px;font-weight:700;color:#475569;margin:0 0 5px;letter-spacing:.01em}'
    + '.amf-inp{width:100%;font:inherit;font-size:15px;padding:11px 13px;border:1px solid #e2e8f0;border-radius:11px;background:#fff}'
    + '.amf-inp:focus{outline:2px solid #2563eb;border-color:#2563eb}'
    + '.amf-btn{font:inherit;font-weight:700;font-size:14px;padding:11px 16px;border-radius:11px;border:1px solid transparent;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}'
    + '.amf-btn.primary{background:#2563eb;color:#fff}.amf-btn.ghost{background:#fff;color:#0f172a;border-color:#e2e8f0}.amf-btn.link{background:none;border:0;color:#2563eb;padding:6px 4px}'
    + '.amf-loc-status{font-size:12.5px;color:#475569;margin-top:9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
    + '.amf-loc-status b{color:#0f172a}'
    + '.amf-radius{margin-top:14px}'
    + '.amf-radius-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}'
    + '.amf-radius-top .v{font-weight:700;font-size:13.5px}'
    + '.amf-range{width:100%;accent-color:#2563eb;height:26px}'
    + '.amf-range:disabled{opacity:.45}'
    + '.amf-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin:0 0 12px}'
    + '.amf-types{display:inline-flex;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}'
    + '.amf-types button{padding:8px 14px;font-weight:700;font-size:13px;border:0;background:#fff;color:#475569;cursor:pointer}'
    + '.amf-types button[aria-pressed="true"]{background:#0f172a;color:#fff}'
    + '.amf-right{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'
    + '.amf-sort{font:inherit;font-size:13px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:10px;background:#fff}'
    + '.amf-toggle{display:inline-flex;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}'
    + '.amf-toggle a{padding:8px 14px;font-weight:700;font-size:13px;text-decoration:none;color:#475569;background:#fff}'
    + '.amf-toggle a[aria-current="true"]{background:#0f172a;color:#fff}'
    + '.amf-count{color:#64748b;font-size:13px;margin:0 2px 10px}'
    + '.amf-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}'
    + '.amf-card{display:block;background:#fff;border:1px solid #e6e9ef;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(15,23,42,.04),0 10px 24px -14px rgba(15,23,42,.2);transition:transform .1s,box-shadow .1s}'
    + '.amf-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(15,23,42,.08),0 24px 44px -20px rgba(15,23,42,.3)}'
    + '.amf-card:focus-visible{outline:2px solid #2563eb;outline-offset:2px}'
    + '.amf-img{width:100%;aspect-ratio:3/2;object-fit:cover;background:#eef1f5;display:block}'
    + '.amf-imgph{width:100%;aspect-ratio:3/2;background:#eef1f5;display:grid;place-items:center;font-size:30px}'
    + '.amf-body{padding:13px 14px 15px}'
    + '.amf-badge{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:6px;margin-bottom:8px}'
    + '.amf-b-live{background:#e7f7f0;color:#059669}.amf-b-soon{background:#fdf3e7;color:#b45309}.amf-b-up{background:#eef4ff;color:#1d4ed8}.amf-b-sale{background:#f3e8ff;color:#7c3aed}'
    + '.amf-title{font-weight:700;font-size:15px;line-height:1.3;margin:0 0 5px}'
    + '.amf-meta{color:#64748b;font-size:12.5px;line-height:1.5}'
    + '.amf-dist{color:#2563eb;font-weight:700}'
    + '.amf-cta{margin-top:10px;font-size:13px;font-weight:700;color:#2563eb}'
    + '.amf-state,.amf-empty{text-align:center;padding:48px 20px;color:#64748b}'
    + '.amf-empty .e{font-size:34px;display:block;margin-bottom:10px}.amf-empty h3{color:#0f172a;font-size:17px;margin:0 0 4px}'
    + '.amf-empty .acts{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:14px}'
    + '.amf-more{text-align:center;margin-top:22px}'
    + '.amf-pag{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center;margin:26px 0 4px}'
    + '.amf-pg{font:inherit;font-weight:700;font-size:14px;min-width:40px;height:40px;padding:0 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#0f172a;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}'
    + '.amf-pg:hover:not(:disabled):not(.is-active){background:#f1f5f9;border-color:#cbd5e1}'
    + '.amf-pg:focus-visible{outline:2px solid #2563eb;outline-offset:2px}'
    + '.amf-pg.is-active{background:#0f172a;color:#fff;border-color:#0f172a;cursor:default}'
    + '.amf-pg:disabled{opacity:.4;cursor:not-allowed}'
    + '.amf-pg-ell{min-width:24px;text-align:center;color:#94a3b8;font-weight:700}'
    + '@media(max-width:560px){.amf-pg-prev,.amf-pg-next{width:100%;order:1;margin-top:4px}}'
    + '.amf-skel{border-radius:14px;height:250px;background:linear-gradient(90deg,#eef1f5 25%,#e2e8f0 37%,#eef1f5 63%);background-size:400% 100%;animation:amfsh 1.3s ease infinite}'
    + '@keyframes amfsh{0%{background-position:100% 0}100%{background-position:0 0}}'
    + '.amf-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}'
    + '@media(max-width:560px){.amf-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}.amf-field{min-width:100%}}'
    + '@media(prefers-reduced-motion:reduce){.amf-skel{animation-duration:2.4s}.amf-card{transition:none}}';

  // ---- card rendering (the ONE renderer; distance shown when present) ----
  function relTime(iso) { if (!iso) return ''; var ms = new Date(iso).getTime() - Date.now(); var a = Math.abs(ms);
    var m = Math.round(a / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
    var v = d >= 1 ? (d + 'd') : (h >= 1 ? (h + 'h') : (Math.max(1, m) + 'm')); return ms > 0 ? ('in ' + v) : v; }
  // STATUS line (timing) — separate from the TYPE badge. Never returns a type word.
  function whenLabel(it) {
    if (it.type === 'estate_sale') { if (it.starts_at) { try { return new Date(it.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) {} } return ''; }
    if (it.status === 'active' && it.ends_at) return 'Ends ' + relTime(it.ends_at);
    if (it.starts_at && new Date(it.starts_at).getTime() > Date.now()) return 'Starts ' + relTime(it.starts_at);
    return 'Live now';
  }
  // Primary badge is the customer-facing event TYPE, never a timing status like "Coming soon". Timing
  // status is shown separately in the meta line (whenLabel). Mirrors the event-detail type vocabulary.
  function badge(it) {
    // Owner-locked vocabulary from the canonical API (family_label): Advantage.Bid Auctions /
    // Auction Partner Events / Estate Sales. Falls back to the legacy label for back-compat.
    var lbl = it.family_label || (it.type === 'estate_sale' ? 'Estate Sales' : 'Auction');
    var cls = it.type === 'estate_sale' ? 'amf-b-sale' : 'amf-b-up';
    return '<span class="amf-badge ' + cls + '">' + esc(lbl) + '</span>';
  }
  function cta(it) { return it.type === 'estate_sale' ? 'View estate sale →' : (it.status === 'active' ? 'Bid now →' : 'View auction →'); }
  function card(it) {
    var loc = [it.city, it.state].filter(Boolean).join(', ');
    var img = it.image_url
      ? '<img class="amf-img" src="' + esc(it.image_url) + '" alt="' + esc(it.title || 'Event') + '" loading="lazy">'
      : '<div class="amf-imgph" aria-hidden="true">' + (it.type === 'estate_sale' ? '🏛️' : '🔨') + '</div>';
    var dist = (it.distance_mi != null) ? ('<div class="amf-dist">' + it.distance_mi + ' mi away</div>') : '';
    var meta = ['<div>' + esc(whenLabel(it)) + '</div>', loc ? ('<div>' + esc(loc) + '</div>') : '',
      it.company ? ('<div>by ' + esc(it.company) + '</div>') : '', dist].filter(Boolean).join('');
    // target="_top" so a card opens the canonical Railway detail page in the TOP window. Without it,
    // a click inside the BD iframe navigates the iframe to event.html/auction-view.html, which Railway
    // refuses to frame cross-origin (X-Frame-Options: SAMEORIGIN) → a blank/gray frame. The Map link
    // uses _top for the same reason.
    return '<a class="amf-card" target="_top" href="' + API_BASE + esc(it.url) + '" data-cardtype="' + it.type + '">' + img +
      '<div class="amf-body">' + badge(it) + '<h3 class="amf-title">' + esc(it.title || 'Untitled event') + '</h3>' +
      '<div class="amf-meta">' + meta + '</div><div class="amf-cta">' + cta(it) + '</div></div></a>';
  }

  // ---- state ----
  var root, reqSeq = 0, state = {
    preset: 'all-events', type: 'all', loc: null, radius: 50, sort: null,
    items: [], total: 0, page: 1, totalPages: 1, loading: false
  };

  function activeType() { // server-enforced by preset; type chips only apply within all-events
    if (state.preset !== 'all-events') return PRESET_TYPE[state.preset];
    return state.type;
  }
  function apiParams(extra) {
    var p = new URLSearchParams();
    p.set('preset', state.preset);
    if (state.preset === 'all-events' && state.type !== 'all') p.set('type', state.type);
    if (state.loc) { p.set('lat', state.loc.lat); p.set('lng', state.loc.lng);
      p.set('radius', state.radius === 'nationwide' ? 'nationwide' : state.radius); }
    if (state.sort) p.set('sort', state.sort);
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    return p;
  }
  function mapHref() { var p = apiParams({ view: 'map' }); var s = p.toString(); return MAP_URL + (s ? '?' + s : ''); }

  // ---- geocoding ----
  function geocode(query) {
    return fetch(API_BASE + '/api/public/geocode?q=' + encodeURIComponent(query))
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, reason: 'unavailable' }; });
  }

  // ---- controls markup ----
  function radiusLabel() { return state.radius === 'nationwide' ? 'Nationwide' : ('Within ' + state.radius + ' miles'); }
  function controlsHtml() {
    var typeSeg = state.preset === 'all-events'
      ? '<div class="amf-types" role="group" aria-label="Event type">' +
          '<button data-type="all" aria-pressed="' + (state.type === 'all') + '">All</button>' +
          '<button data-type="auction" aria-pressed="' + (state.type === 'auction') + '">🔨 Auctions</button>' +
          '<button data-type="estate_sale" aria-pressed="' + (state.type === 'estate_sale') + '">🏛️ Estate Sales</button>' +
        '</div>' : '';
    var sortOpts = state.loc
      ? [['nearest', 'Nearest'], ['', 'Ending soon'], ['newest', 'Recently added']]
      : [['', 'Ending soon'], ['newest', 'Recently added']];
    var sortSel = '<label class="amf-sr" for="amf-sort">Sort</label><select class="amf-sort" id="amf-sort" aria-label="Sort events">' +
      sortOpts.map(function (o) { return '<option value="' + o[0] + '"' + ((state.sort || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
    // The distance slider is ALWAYS interactive — from first page load, before any search. A first-time
    // visitor can set the radius up front and have it apply to their very first location search. (It was
    // previously gated on state.loc, so it stayed locked until a location resolved — i.e. until after the
    // first search fired.) Radius only reaches the server once a location is set (see apiParams), so an
    // always-on slider changes nothing about nationwide results; it just lets the value be chosen early.
    var radiusDisabled = '';
    return '<div class="amf-controls">' +
      '<div class="amf-locrow">' +
        '<div class="amf-field"><label class="amf-lab" for="amf-loc">Location</label>' +
          '<input class="amf-inp" id="amf-loc" type="text" placeholder="Enter a location" autocomplete="off" value="' + esc(state.loc ? state.loc.label : '') + '"></div>' +
        '<button class="amf-btn primary" id="amf-loc-go" type="button">Search</button>' +
        '<button class="amf-btn ghost" id="amf-geo" type="button" title="Use my current location">📍 Use my location</button>' +
      '</div>' +
      '<div class="amf-loc-status" id="amf-loc-status" aria-live="polite">' + locStatusHtml() + '</div>' +
      '<div class="amf-radius">' +
        '<div class="amf-radius-top"><label class="amf-lab" for="amf-radius" style="margin:0">Distance</label>' +
          '<span class="v" id="amf-radius-v">' + esc(radiusLabel()) + '</span></div>' +
        '<input class="amf-range" id="amf-radius" type="range" min="5" max="255" step="5" value="' +
          (state.radius === 'nationwide' ? 255 : state.radius) + '"' + radiusDisabled +
          ' aria-label="Search distance in miles" aria-valuetext="' + esc(radiusLabel()) + '">' +
      '</div>' +
    '</div>' +
    '<div class="amf-bar">' + typeSeg +
      '<div class="amf-right">' + sortSel +
        '<div class="amf-toggle"><a href="#" aria-current="true">List View</a>' +
        '<a id="amf-map" href="' + mapHref() + '" target="_top">Map View</a></div></div>' +
    '</div>' +
    '<div class="amf-count" id="amf-count" role="status" aria-live="polite"></div>';
  }
  function locStatusHtml() {
    if (state.loc) return 'Showing events near <b>' + esc(state.loc.label) + '</b> · <button class="amf-btn link" id="amf-loc-clear" type="button">Clear</button>';
    return 'Showing events <b>nationwide</b> — enter a location to search nearby.';
  }
  function skeletons() { var s = ''; for (var i = 0; i < 8; i++) s += '<div class="amf-skel"></div>'; return '<div class="amf-grid">' + s + '</div>'; }

  function render() {
    root.innerHTML = '<section class="amf" aria-label="Advantage marketplace events">' + controlsHtml() +
      '<div id="amf-results">' + skeletons() + '</div></section>';
    wire();
    if (!bootDeferLoad) load(true, false);   // a pending city-page geocode does the first load instead
    bootDeferLoad = false;
    track('loaded', { has_location: !!state.loc, radius: state.radius });
  }

  var radiusTimer = null;
  function wire() {
    var go = $('#amf-loc-go', root), inp = $('#amf-loc', root);
    if (go) go.addEventListener('click', function () { resolveLocation(inp.value); });
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); resolveLocation(inp.value); } });
    var geo = $('#amf-geo', root); if (geo) geo.addEventListener('click', useMyLocation);
    var clr = $('#amf-loc-clear', root); if (clr) clr.addEventListener('click', function () { setLocation(null); });
    root.querySelectorAll('[data-type]').forEach(function (b) { b.addEventListener('click', function () { state.type = b.getAttribute('data-type'); track('type_filter_changed', { type: state.type }); refreshControls(); apply(); }); });
    var sort = $('#amf-sort', root); if (sort) sort.addEventListener('change', function () { state.sort = sort.value || null; track('sort_changed', { sort: state.sort || 'default' }); apply(); });
    var rg = $('#amf-radius', root);
    if (rg) {
      rg.addEventListener('input', function () { // live label, debounced fetch (avoid API spam while dragging)
        var v = parseInt(rg.value, 10); state.radius = v >= 255 ? 'nationwide' : v;
        var vlab = $('#amf-radius-v', root); if (vlab) vlab.textContent = radiusLabel(); rg.setAttribute('aria-valuetext', radiusLabel());
      });
      // On release: keep the chosen value (state.radius is already live from 'input'; persist it) and
      // re-search ONLY when a location is set — radius has no effect on nationwide results. When no
      // location yet, the value is retained so it applies to the visitor's first location search.
      rg.addEventListener('change', function () { track('radius_changed', { radius: state.radius }); persist(); if (state.loc) apply(); });
    }
  }
  function refreshControls() { root.querySelectorAll('[data-type]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-type') === state.type); }); }
  function syncStatus() { var s = $('#amf-loc-status', root); if (s) { s.innerHTML = locStatusHtml(); var c = $('#amf-loc-clear', root); if (c) c.addEventListener('click', function () { setLocation(null); }); }
    var m = $('#amf-map', root); if (m) m.href = mapHref(); }

  function persist() { saveLoc(state.loc ? { label: state.loc.label, lat: state.loc.lat, lng: state.loc.lng, radius: state.radius } : null); }

  function resolveLocation(query) {
    query = String(query || '').trim();
    if (!query) { setLocation(null); return; }
    track('location_submitted', { length: query.length });
    var s = $('#amf-loc-status', root); if (s) s.innerHTML = 'Finding <b>' + esc(query) + '</b>…';
    geocode(query).then(function (r) {
      if (r && r.ok) { track('location_resolved', {}); setLocation({ label: r.label || query, lat: r.lat, lng: r.lng }); }
      else if (r && r.reason === 'unavailable') { track('location_resolution_failed', { reason: 'unavailable' });
        if (s) s.innerHTML = 'Location search is being enabled — showing <b>nationwide</b> results. <button class="amf-btn link" id="amf-loc-clear" type="button">OK</button>';
        state.loc = null; enableRadius(false); apply(); }
      else { track('location_resolution_failed', { reason: 'no_match' });
        if (s) s.innerHTML = 'We couldn\'t find <b>' + esc(query) + '</b>. Try a city, ZIP, or "City, State".'; }
    });
  }
  function setLocation(loc) {
    state.loc = loc;
    if (loc && (state.radius == null)) state.radius = 50;
    if (loc && !state.sort) state.sort = 'nearest';
    if (!loc) state.sort = state.sort === 'nearest' ? null : state.sort;
    persist(); enableRadius(!!loc); syncStatus(); refreshSort(); apply();
  }
  // The slider stays interactive regardless of location (the `on` arg now only reflects whether a
  // location is set, for callers' readability); we keep the control enabled and just sync its value/label.
  function enableRadius(on) { var rg = $('#amf-radius', root); if (rg) { rg.disabled = false; if (state.radius !== 'nationwide') rg.value = state.radius; var v = $('#amf-radius-v', root); if (v) v.textContent = radiusLabel(); } }
  function refreshSort() { var sort = $('#amf-sort', root); if (!sort) return;
    var opts = state.loc ? [['nearest', 'Nearest'], ['', 'Ending soon'], ['newest', 'Recently added']] : [['', 'Ending soon'], ['newest', 'Recently added']];
    sort.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '"' + ((state.sort || '') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join(''); }

  function useMyLocation() {
    track('use_my_location', {});
    if (!navigator.geolocation) { var s = $('#amf-loc-status', root); if (s) s.innerHTML = 'Your browser can\'t share location — type one instead.'; return; }
    var s = $('#amf-loc-status', root); if (s) s.innerHTML = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      setLocation({ label: 'your location', lat: +pos.coords.latitude.toFixed(4), lng: +pos.coords.longitude.toFixed(4) });
    }, function () { if (s) s.innerHTML = 'Location permission was declined — type a location instead.'; }, { timeout: 8000, maximumAge: 300000 });
  }

  // ANY filter/search/sort/location/radius change resets to page 1 (req 9).
  function apply() { state.page = 1; updateUrl(); syncStatus(); load(true, false); }

  // Persist the current page (and preset) in the iframe's own URL so a refresh/back keeps the page.
  function updateUrl() {
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('preset', state.preset);
      if (state.page > 1) u.searchParams.set('page', String(state.page)); else u.searchParams.delete('page');
      window.history.replaceState(null, '', u.toString());
    } catch (e) {}
  }

  // load(showSkeleton, scrollTop) — fetches ONLY the current page from the server. A monotonic
  // request token (reqSeq) makes stale responses no-ops, preventing races on rapid page/filter changes.
  function load(showSkeleton, scrollTop) {
    var seq = ++reqSeq;
    state.loading = true;
    if (showSkeleton) { var h = $('#amf-results', root); if (h) h.innerHTML = skeletons(); }
    fetch(API_BASE + '/api/public/marketplace/feed?' + apiParams({ page: state.page, pageSize: PAGE_SIZE }).toString())
      .then(function (r) { return r.json(); }).then(function (d) {
        if (seq !== reqSeq) return;                 // a newer request superseded this one — ignore
        state.loading = false;
        state.items = (d && d.data) || [];
        var pg = (d && d.pagination) || {};
        state.total = pg.totalItems != null ? pg.totalItems : ((d && d.total) || 0);
        state.totalPages = pg.totalPages || 1;
        if (pg.currentPage) state.page = pg.currentPage;
        paint();
        postHeight(true);                                  // content changed → resize the iframe
        if (scrollTop) {                                   // intentional pagination action only
          if (inIframe()) { resetInternalScroll(); postScroll(); }
          else scrollToResults();                          // standalone (non-embedded) fallback
        }
      }).catch(function () { if (seq !== reqSeq) return; state.loading = false; renderError(); postHeight(true); });
  }

  // Move the viewport to the top of the RESULT area only — within the iframe's own document
  // (a cross-origin iframe cannot and must not scroll the parent BD page).
  function scrollToResults() {
    try {
      var el = $('#amf-results', root) || root;
      var top = el.getBoundingClientRect().top + (window.pageYOffset || 0) - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch (e) {}
  }

  function goToPage(n) {
    n = parseInt(n, 10);
    if (!n || n < 1 || n > state.totalPages || n === state.page) return;  // no duplicate/invalid requests
    state.page = n; updateUrl(); track('page_changed', { page: n });
    load(true, true);
  }

  // Compact page window with ellipses, e.g. 1 … 7 8 9 … 24 (req 6). Up to 7 pages render in full.
  function pageWindow(cur, total) {
    var out = [];
    if (total <= 7) { for (var i = 1; i <= total; i++) out.push(i); return out; }
    var start = Math.max(2, cur - 1), end = Math.min(total - 1, cur + 1);
    if (cur <= 3) { start = 2; end = 4; }
    if (cur >= total - 2) { start = total - 3; end = total - 1; }
    out.push(1);
    if (start > 2) out.push('…');
    for (var j = start; j <= end; j++) out.push(j);
    if (end < total - 1) out.push('…');
    out.push(total);
    return out;
  }
  function paginationHtml() {
    var cur = state.page, tp = state.totalPages;
    if (tp <= 1) return '';
    var parts = ['<nav class="amf-pag" role="navigation" aria-label="Pagination">'];
    parts.push('<button class="amf-pg amf-pg-prev" type="button" data-page="' + (cur - 1) + '"' +
      (cur <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹ Previous</button>');
    pageWindow(cur, tp).forEach(function (p) {
      if (p === '…') { parts.push('<span class="amf-pg-ell" aria-hidden="true">…</span>'); return; }
      parts.push('<button class="amf-pg amf-pg-num' + (p === cur ? ' is-active' : '') + '" type="button" data-page="' + p + '"' +
        (p === cur ? ' aria-current="page"' : '') + ' aria-label="' + (p === cur ? 'Current page, page ' + p : 'Go to page ' + p) + '">' + p + '</button>');
    });
    parts.push('<button class="amf-pg amf-pg-next" type="button" data-page="' + (cur + 1) + '"' +
      (cur >= tp ? ' disabled' : '') + ' aria-label="Next page">Next ›</button>');
    parts.push('</nav>');
    return parts.join('');
  }
  function countLabel() {
    var start = (state.page - 1) * PAGE_SIZE + 1, end = start + state.items.length - 1;
    return start + '–' + end + ' of ' + state.total + ' event' + (state.total === 1 ? '' : 's') + (state.loc ? (' near ' + state.loc.label) : '');
  }

  function paint() {
    var host = $('#amf-results', root), cnt = $('#amf-count', root);
    if (!state.items.length) {
      // Empty page beyond the first (e.g. a stale deep link) — fall back to page 1 once.
      if (state.page > 1) { state.page = 1; updateUrl(); load(true, false); return; }
      renderEmpty(); track('no_results', { has_location: !!state.loc, radius: state.radius }); if (cnt) cnt.textContent = ''; return;
    }
    if (cnt) cnt.textContent = countLabel();
    host.innerHTML = '<div class="amf-grid">' + state.items.map(card).join('') + '</div>' + paginationHtml();
    root.querySelectorAll('.amf-pg[data-page]').forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener('click', function () { goToPage(b.getAttribute('data-page')); });
    });
    host.querySelectorAll('.amf-card').forEach(function (a) { a.addEventListener('click', function () { track('card_opened', { type: a.getAttribute('data-cardtype') }); }); });
  }
  function renderEmpty() {
    var near = state.loc ? (' within ' + (state.radius === 'nationwide' ? 'the country' : state.radius + ' miles') + ' of ' + esc(state.loc.label)) : '';
    $('#amf-results', root).innerHTML = '<div class="amf-empty"><span class="e">🔍</span>' +
      '<h3>No events found' + near + '</h3><p>Try widening your search.</p>' +
      '<div class="acts">' +
        (state.loc ? '<button class="amf-btn ghost" id="amf-e-wider">Increase distance</button>' : '') +
        '<button class="amf-btn ghost" id="amf-e-nation">View nationwide</button>' +
        '<button class="amf-btn ghost" id="amf-e-clear">Clear filters</button>' +
      '</div></div>';
    var w = $('#amf-e-wider', root); if (w) w.addEventListener('click', function () { state.radius = 'nationwide'; enableRadius(true); persist(); apply(); });
    var n = $('#amf-e-nation', root); if (n) n.addEventListener('click', function () { state.radius = 'nationwide'; enableRadius(true); persist(); apply(); });
    var c = $('#amf-e-clear', root); if (c) c.addEventListener('click', function () { state.type = 'all'; state.sort = null; setLocation(null); render(); });
  }
  function renderError() {
    $('#amf-results', root).innerHTML = '<div class="amf-state"><p>We couldn\'t load events just now.</p>' +
      '<p style="margin-top:10px"><button class="amf-btn primary" id="amf-retry">Try again</button></p></div>';
    var b = $('#amf-retry', root); if (b) b.addEventListener('click', function () { load(true, false); });
  }

  // ── City-page context from the iframe URL ──────────────────────────────────────
  // A BD city/location page embeds the widget with its own city/state (or coordinates) so the visitor
  // sees nearby events on first load WITHOUT retyping the city. Accepts either explicit coordinates
  // (lat/lng[/label]) or a city+state to geocode honestly, plus an optional radius (miles or
  // 'nationwide'). No per-city hardcoding — the embedding page supplies the values via dynamic tags.
  function readUrlLocation() {
    try {
      var q = new URLSearchParams(location.search);
      var out = {};
      var lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
          && !(lat === 0 && lng === 0)) {
        out.coords = { lat: lat, lng: lng };
      }
      var city = (q.get('city') || '').trim();
      var stat = (q.get('state') || '').trim();
      var label = (q.get('label') || '').trim();
      if (city) out.city = city;
      if (stat) out.state = stat;
      out.label = label || (city && stat ? city + ', ' + stat : (city || stat || ''));
      var r = (q.get('radius') || '').trim().toLowerCase();
      if (r === 'nationwide') out.radius = 'nationwide';
      else if (r) { var n = parseInt(r, 10); if (Number.isFinite(n) && n > 0) out.radius = Math.min(255, Math.max(5, n)); }
      return (out.coords || out.city || out.state) ? out : null;
    } catch (e) { return null; }
  }

  // Honest geocode of the BD city-page context, reusing the shared geocode → setLocation path (status
  // line, radius slider, sort, persistence, page-1 reset, load). Runs after first paint. On success the
  // results snap to the city; on failure it degrades truthfully to nationwide (never fabricates a market).
  function initFromCityPage(query, label) {
    track('city_page_init', {});               // distinct from a user-typed 'location_submitted'
    var s = $('#amf-loc-status', root); if (s) s.innerHTML = 'Finding <b>' + esc(label || query) + '</b>…';
    geocode(query).then(function (r) {
      if (r && r.ok) {
        track('location_resolved', { source: 'city_page' });
        var inp = $('#amf-loc', root); if (inp) inp.value = label || r.label || query;
        setLocation({ label: label || r.label || query, lat: r.lat, lng: r.lng });
      } else {
        track('location_resolution_failed', { reason: (r && r.reason) || 'no_match', source: 'city_page' });
        var st = $('#amf-loc-status', root); if (st) st.innerHTML = locStatusHtml();  // truthful nationwide
        apply();
      }
    });
  }

  var bootDeferLoad = false;  // when true, render() skips its initial load (a pending city geocode owns it)

  function mount() {
    root = document.getElementById('advantage-marketplace-feed');
    if (!root) { root = document.createElement('div'); root.id = 'advantage-marketplace-feed'; document.body.appendChild(root); }
    // preset: mount data-preset → URL ?preset → default all-events (server enforces the type regardless)
    var mp = (root.getAttribute('data-preset') || '').toLowerCase();
    var up = ''; try { up = (new URLSearchParams(location.search).get('preset') || '').toLowerCase(); } catch (e) {}
    state.preset = PRESET_TYPE[mp] ? mp : (PRESET_TYPE[up] ? up : 'all-events');
    // restore the requested page from the URL (?page=), so a refresh/back keeps the result page
    try { var pg = parseInt(new URLSearchParams(location.search).get('page'), 10); if (pg >= 1) state.page = pg; } catch (e) {}
    // ── Location precedence ────────────────────────────────────────────────────────
    // 1/2. Explicit widget coords OR BD city-page city/state (from the iframe URL)  → wins.
    //   4. Stored visitor preference (shared ab_feed_loc across presets)            → fallback.
    //   5. Nationwide (no location)                                                 → last resort.
    // (3. A visitor-entered location overrides during the session via setLocation, which persists.)
    var urlLoc = readUrlLocation();
    if (urlLoc && urlLoc.radius != null) state.radius = urlLoc.radius;   // honor ?radius= incl. 'nationwide'
    var pendingGeocode = null;
    if (urlLoc && urlLoc.coords) {
      // Explicit coordinates: use directly (no geocode round-trip).
      state.loc = { label: urlLoc.label || 'your area', lat: urlLoc.coords.lat, lng: urlLoc.coords.lng };
      if (!state.sort) state.sort = 'nearest';
    } else if (urlLoc && (urlLoc.city || urlLoc.state)) {
      // City/state from the BD page: geocode honestly after first paint. Suppress the initial nationwide
      // load so the visitor never sees a wrong-market flash before the city resolves.
      pendingGeocode = { query: [urlLoc.city, urlLoc.state].filter(Boolean).join(', '), label: urlLoc.label };
      bootDeferLoad = true;
    } else {
      // No city-page context → restore the visitor's stored preference.
      var saved = loadLoc();
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) { state.loc = { label: saved.label || 'your location', lat: saved.lat, lng: saved.lng }; if (saved.radius != null) state.radius = saved.radius; state.sort = 'nearest'; }
    }
    if (!document.getElementById('amf-style')) { var st = document.createElement('style'); st.id = 'amf-style'; st.textContent = CSS; document.head.appendChild(st); }
    render();
    if (pendingGeocode) initFromCityPage(pendingGeocode.query, pendingGeocode.label);  // deferred honest geocode
    observeSize();       // begin measuring + posting height to the parent iframe (embedded case only)
    postHeight(true);    // initial height ASAP (before results arrive), so the parent can size the frame
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.AdvantageMarketplaceFeed = { mount: mount };
})();
