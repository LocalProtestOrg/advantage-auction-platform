/* ============================================================================
   Advantage.Bid — "Featured Items Available Now" widget.
   A premium, image-first visual discovery grid of eligible ACTIVE auction lots,
   ranked + diversified by the Railway discovery service. Each card links to the
   canonical Railway lot-detail page. Reuses the proven Event-Feed embed pattern:
   dynamic iframe height + parent-scroll on paging via postMessage (handled by the
   shared marketplace-embed.js parent helper), true numbered pagination (12/page,
   up to 6 pages). Railway is the sole source of truth; the widget only requests.

   Embed (iframe): /widgets/featured-items.html?placement=event_feed_footer
   ========================================================================== */
(function () {
  'use strict';
  var API_BASE = 'https://bid.advantage.bid';
  var PAGE_SIZE = 12;          // fixed for this placement (server also enforces)
  var MAX_PAGES = 6;
  var WIDGET_ID = 'featured-items', MSG_SRC = 'advantage-bid-widget';
  var ACTIVE_AUCTIONS_URL = 'https://www.advantage.bid/all-auctions';
  // placement identifies WHERE this widget is embedded. V1: used only to tag analytics + preserve URL
  // state (and server-side for cache partitioning). It does NOT change the layout or the items shown —
  // every placement renders the same ranked inventory and the same grid. Reserved as a future extension
  // point (placement-aware discovery) without changing this widget.
  var PLACEMENTS = ['event_feed_footer', 'auctions_footer', 'estate_sales_footer', 'homepage', 'standalone'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, r) { return (r || document).querySelector(sel); }

  // ---- analytics (no PII) ----
  function track(event, data) {
    try {
      var payload = Object.assign({ widget: WIDGET_ID, placement: state.placement }, data || {});
      if (window.dataLayer && window.dataLayer.push) window.dataLayer.push(Object.assign({ event: 'adv_fi_' + event }, payload));
      document.dispatchEvent(new CustomEvent('advantage:featured:' + event, { detail: payload }));
    } catch (e) {}
  }

  // ---- parent (BD) iframe coordination (mirrors the proven Event-Feed contract) ----
  var lastPostedHeight = 0, heightTimer = null;
  function inIframe() { try { return window.parent && window.parent !== window; } catch (e) { return true; } }
  function parentTargetOrigin() {
    try { var o = new URL(document.referrer).origin;
      if (o === 'https://www.advantage.bid' || o === 'https://advantage.bid') return o; } catch (e) {}
    return '*';
  }
  function post(msg) { if (!inIframe()) return; try { window.parent.postMessage(msg, parentTargetOrigin()); } catch (e) {} }
  function measureHeight() {
    // TRUE content-wrapper height (viewport-INDEPENDENT). Never document(Element).scrollHeight: <html>
    // fills the iframe viewport so its scrollHeight tracks the parent-assigned height and (with a buffer)
    // creeps the iframe taller every cycle. The wrapper height is stable → converges. body.scrollHeight
    // is a safe fallback (does not inflate to the viewport). Matters most in the short empty state.
    var el = root || document.getElementById('advantage-featured-items');
    var h = el ? el.getBoundingClientRect().height : 0;
    if (!h && document.body) h = document.body.scrollHeight;
    return Math.ceil(h) + 2;
  }
  function postHeight(force) { var h = measureHeight(); if (!force && Math.abs(h - lastPostedHeight) < 3) return;
    lastPostedHeight = h; post({ source: MSG_SRC, type: 'resize', widget: WIDGET_ID, height: h }); }
  function scheduleHeight() { if (heightTimer) return; heightTimer = setTimeout(function () { heightTimer = null; postHeight(false); }, 100); }
  function postScroll() { post({ source: MSG_SRC, type: 'scroll-to-widget', widget: WIDGET_ID, target: 'results-top' }); }
  function resetInternalScroll() { try { window.scrollTo(0, 0); } catch (e) {} }
  function isTrustedParentOrigin(o) { return o === 'https://www.advantage.bid' || o === 'https://advantage.bid'; }
  function onParentMessage(e) { try {
    if (!isTrustedParentOrigin(e.origin)) return;
    var d = e.data; if (!d || d.source !== 'advantage-bid-embed' || d.widget !== WIDGET_ID) return;
    if (d.type === 'request-resize') postHeight(true);
  } catch (err) {} }
  function observeSize() {
    try { if (window.ResizeObserver) { new ResizeObserver(scheduleHeight).observe(document.body); } } catch (e) {}
    try { window.addEventListener('resize', scheduleHeight); } catch (e) {}
    try { window.addEventListener('load', function () { postHeight(true); }); } catch (e) {}
    try { document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IMG') scheduleHeight(); }, true); } catch (e) {}
    try { window.addEventListener('message', onParentMessage); } catch (e) {}
  }

  var CSS = ''
    + '.fi{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a;max-width:1180px;margin:0 auto;padding:0 14px 40px}'
    + '.fi *{box-sizing:border-box}'
    + '.fi-head{margin:16px 2px 6px}'
    + '.fi-h{font-size:23px;font-weight:800;letter-spacing:-.01em;margin:0}'
    + '.fi-sub{color:#64748b;font-size:14.5px;margin:4px 0 0}'
    + '.fi-count{color:#64748b;font-size:13px;margin:12px 2px 12px}'
    + '.fi-grid{display:grid;gap:18px;grid-template-columns:repeat(4,1fr)}'
    + '@media(max-width:1024px){.fi-grid{grid-template-columns:repeat(3,1fr)}}'
    + '@media(max-width:760px){.fi-grid{grid-template-columns:repeat(2,1fr)}}'
    + '@media(max-width:520px){.fi-grid{grid-template-columns:1fr}}'
    + '.fi-card{display:flex;flex-direction:column;background:#fff;border:1px solid #e6e9ef;border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 26px -16px rgba(15,23,42,.24);transition:transform .12s,box-shadow .12s}'
    + '.fi-card:hover{transform:translateY(-3px);box-shadow:0 6px 16px rgba(15,23,42,.09),0 26px 48px -22px rgba(15,23,42,.34)}'
    + '.fi-card:focus-visible{outline:2px solid #2563eb;outline-offset:2px}'
    + '.fi-imgwrap{position:relative;width:100%;aspect-ratio:4/3;background:#eef1f5}'
    + '.fi-img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.fi-imgph{width:100%;height:100%;display:grid;place-items:center;font-size:34px;color:#94a3b8}'
    + '.fi-badges{position:absolute;top:10px;left:10px;display:flex;gap:6px;flex-wrap:wrap;max-width:calc(100% - 20px)}'
    + '.fi-badge{font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;padding:4px 8px;border-radius:7px;background:rgba(15,23,42,.82);color:#fff;backdrop-filter:blur(2px)}'
    + '.fi-badge.soon{background:#b45309}.fi-badge.new{background:#1d4ed8}.fi-badge.nobids{background:#0f766e}.fi-badge.pop{background:#7c3aed}.fi-badge.ship{background:#0369a1}.fi-badge.pickup{background:#475569}'
    + '.fi-body{padding:13px 14px 15px;display:flex;flex-direction:column;gap:5px;flex:1}'
    + '.fi-title{font-weight:700;font-size:15px;line-height:1.3;margin:0}'
    + '.fi-price{font-weight:800;font-size:15.5px;margin:2px 0 0}'
    + '.fi-price .lbl{font-weight:600;color:#64748b;font-size:12.5px;display:block}'
    + '.fi-meta{color:#64748b;font-size:12.5px;line-height:1.5;margin-top:auto}'
    + '.fi-cta{margin-top:9px;font-size:13px;font-weight:700;color:#2563eb}'
    + '.fi-state{text-align:center;padding:44px 20px;color:#64748b}'
    + '.fi-state h3{color:#0f172a;font-size:17px;margin:0 0 6px}'
    + '.fi-btn{display:inline-block;margin-top:6px;font-weight:700;font-size:14px;padding:10px 16px;border-radius:11px;background:#2563eb;color:#fff;text-decoration:none}'
    + '.fi-skel{border-radius:16px;overflow:hidden;background:#fff;border:1px solid #e6e9ef}'
    + '.fi-skel .b{background:linear-gradient(90deg,#eef1f5 25%,#e2e8f0 37%,#eef1f5 63%);background-size:400% 100%;animation:fish 1.3s ease infinite}'
    + '.fi-skel .im{width:100%;aspect-ratio:4/3}.fi-skel .l{height:12px;margin:12px 14px;border-radius:5px}'
    + '@keyframes fish{0%{background-position:100% 0}100%{background-position:0 0}}'
    + '.fi-pag{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center;margin:26px 0 4px}'
    + '.fi-pg{font:inherit;font-weight:700;font-size:14px;min-width:40px;height:40px;padding:0 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;color:#0f172a;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}'
    + '.fi-pg:hover:not(:disabled):not(.on){background:#f1f5f9;border-color:#cbd5e1}'
    + '.fi-pg:focus-visible{outline:2px solid #2563eb;outline-offset:2px}'
    + '.fi-pg.on{background:#0f172a;color:#fff;border-color:#0f172a;cursor:default}'
    + '.fi-pg:disabled{opacity:.4;cursor:not-allowed}.fi-pg-ell{min-width:24px;text-align:center;color:#94a3b8;font-weight:700}'
    + '.fi-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}'
    + '@media(max-width:560px){.fi-pg-prev,.fi-pg-next{width:100%;order:1;margin-top:4px}}'
    + '@media(prefers-reduced-motion:reduce){.fi-skel .b{animation-duration:2.4s}.fi-card{transition:none}}';

  var BADGE_MAP = {
    ending_soon: ['soon', 'Ending Soon'], new_today: ['new', 'New Today'], just_listed: ['new', 'Just Listed'],
    no_bids_yet: ['nobids', 'No Bids Yet'], popular: ['pop', 'Popular'],
    shipping_available: ['ship', 'Ships'], local_pickup: ['pickup', 'Local Pickup'],
  };
  function relTime(iso) { if (!iso) return ''; var ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'closing'; var m = Math.round(ms / 60000), h = Math.round(m / 60), d = Math.round(h / 24);
    return 'in ' + (d >= 1 ? d + 'd' : (h >= 1 ? h + 'h' : Math.max(1, m) + 'm')); }
  function money(v) { return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: (v % 1 ? 2 : 0), maximumFractionDigits: 2 }); }
  function priceHtml(it) {
    var p = it.pricing || {};
    if (p.currentBid != null) return '<div class="fi-price"><span class="lbl">Current bid · ' + (p.bidCount || 0) + ' bid' + (p.bidCount === 1 ? '' : 's') + '</span>' + esc(money(p.currentBid)) + '</div>';
    if (p.startingPrice != null) return '<div class="fi-price"><span class="lbl">Starting bid · no bids yet</span>' + esc(money(p.startingPrice)) + '</div>';
    return '';
  }
  function badgesHtml(it) {
    var arr = (it.badges || []).slice();
    // priority: urgency → recency → engagement → fulfillment; cap 2 to avoid overload
    var order = ['ending_soon', 'new_today', 'just_listed', 'popular', 'no_bids_yet', 'shipping_available', 'local_pickup'];
    arr.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    return arr.slice(0, 2).map(function (code) { var m = BADGE_MAP[code]; return m ? '<span class="fi-badge ' + m[0] + '">' + esc(m[1]) + '</span>' : ''; }).join('');
  }
  function card(it) {
    var loc = [it.location && it.location.city, it.location && it.location.state].filter(Boolean).join(', ');
    var img = (it.primaryImage && it.primaryImage.url)
      ? '<img class="fi-img" src="' + esc(it.primaryImage.url) + '" alt="' + esc(it.primaryImage.alt || it.title) + '" loading="lazy" decoding="async">'
      : '<div class="fi-imgph" aria-hidden="true">🖼️</div>';
    var closes = it.availability && it.availability.closesAt ? ('Ends ' + relTime(it.availability.closesAt)) : '';
    var auctionLine = (it.auction && it.auction.title) ? ('<div>from ' + esc(it.auction.title) + '</div>') : '';
    var meta = [closes ? '<div>' + esc(closes) + '</div>' : '', loc ? '<div>' + esc(loc) + '</div>' : '', auctionLine].filter(Boolean).join('');
    return '<a class="fi-card" href="' + esc(it.canonicalUrl) + '" data-lot="' + esc(it.id) + '">' +
      '<div class="fi-imgwrap">' + img + '<div class="fi-badges">' + badgesHtml(it) + '</div></div>' +
      '<div class="fi-body"><h3 class="fi-title">' + esc(it.title || 'Untitled lot') + '</h3>' +
      priceHtml(it) + '<div class="fi-meta">' + meta + '</div><div class="fi-cta">View item →</div></div></a>';
  }

  // ---- state ----
  var root, reqSeq = 0, state = { placement: 'standalone', page: 1, items: [], total: 0, totalPages: 1, loading: false };

  function updateUrl() {
    try { var u = new URL(window.location.href); u.searchParams.set('placement', state.placement);
      if (state.page > 1) u.searchParams.set('page', String(state.page)); else u.searchParams.delete('page');
      window.history.replaceState(null, '', u.toString()); } catch (e) {}
  }
  function scrollToResults() { try { var el = $('#fi-results', root) || root;
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + (window.pageYOffset || 0) - 8), behavior: 'smooth' }); } catch (e) {} }

  function load(showSkeleton, scrollTop) {
    var seq = ++reqSeq; state.loading = true;
    if (showSkeleton) { var h = $('#fi-results', root); if (h) h.innerHTML = skeletons(); }
    var url = API_BASE + '/api/public/discovery/items?page=' + state.page + '&limit=' + PAGE_SIZE +
      '&placement=' + encodeURIComponent(state.placement) + '&sort=featured';
    fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      if (seq !== reqSeq) return; state.loading = false;
      state.items = (d && d.data) || []; var pg = (d && d.pagination) || {};
      state.total = pg.total || 0; state.totalPages = Math.min(MAX_PAGES, pg.totalPages || 0);
      if (pg.page) state.page = pg.page;
      paint(); postHeight(true);
      if (scrollTop) { if (inIframe()) { resetInternalScroll(); postScroll(); } else scrollToResults(); }
    }).catch(function () { if (seq !== reqSeq) return; state.loading = false; renderError(); postHeight(true); });
  }

  function skeletons() { var s = ''; for (var i = 0; i < PAGE_SIZE; i++) s += '<div class="fi-skel"><div class="im b"></div><div class="l b" style="width:80%"></div><div class="l b" style="width:55%"></div></div>'; return '<div class="fi-grid">' + s + '</div>'; }

  function goToPage(n) { n = parseInt(n, 10);
    if (!n || n < 1 || n > state.totalPages || n === state.page) return;
    state.page = n; updateUrl(); track('pagination', { page: n }); load(true, true); }
  function pageWindow(cur, total) { var out = [];
    if (total <= 7) { for (var i = 1; i <= total; i++) out.push(i); return out; }
    var start = Math.max(2, cur - 1), end = Math.min(total - 1, cur + 1);
    if (cur <= 3) { start = 2; end = 4; } if (cur >= total - 2) { start = total - 3; end = total - 1; }
    out.push(1); if (start > 2) out.push('…'); for (var j = start; j <= end; j++) out.push(j);
    if (end < total - 1) out.push('…'); out.push(total); return out; }
  function paginationHtml() { var cur = state.page, tp = state.totalPages; if (tp <= 1) return '';
    var parts = ['<nav class="fi-pag" role="navigation" aria-label="Featured items pagination">'];
    parts.push('<button class="fi-pg fi-pg-prev" type="button" data-page="' + (cur - 1) + '"' + (cur <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹ Previous</button>');
    pageWindow(cur, tp).forEach(function (p) { if (p === '…') { parts.push('<span class="fi-pg-ell" aria-hidden="true">…</span>'); return; }
      parts.push('<button class="fi-pg' + (p === cur ? ' on' : '') + '" type="button" data-page="' + p + '"' + (p === cur ? ' aria-current="page"' : '') + ' aria-label="' + (p === cur ? 'Current page, page ' + p : 'Go to page ' + p) + '">' + p + '</button>'); });
    parts.push('<button class="fi-pg fi-pg-next" type="button" data-page="' + (cur + 1) + '"' + (cur >= tp ? ' disabled' : '') + ' aria-label="Next page">Next ›</button>');
    parts.push('</nav>'); return parts.join(''); }

  function paint() {
    var host = $('#fi-results', root), cnt = $('#fi-count', root);
    if (!state.items.length) { if (state.page > 1) { state.page = 1; updateUrl(); load(true, false); return; }
      renderEmpty(); if (cnt) cnt.textContent = ''; track('empty', {}); return; }
    if (cnt) cnt.textContent = state.total + ' featured item' + (state.total === 1 ? '' : 's') + ' available now';
    host.innerHTML = '<div class="fi-grid">' + state.items.map(card).join('') + '</div>' + paginationHtml();
    root.querySelectorAll('.fi-pg[data-page]').forEach(function (b) { if (b.disabled) return;
      b.addEventListener('click', function () { goToPage(b.getAttribute('data-page')); }); });
    host.querySelectorAll('.fi-card').forEach(function (a) {
      a.addEventListener('click', function () { track('item_click', { lotId: a.getAttribute('data-lot'), page: state.page }); }); });
    track('items_rendered', { count: state.items.length, page: state.page });
  }
  function renderEmpty() { $('#fi-results', root).innerHTML =
    '<div class="fi-state"><h3>New items are being added</h3><p>Explore active auctions available now.</p>' +
    '<a class="fi-btn" href="' + esc(ACTIVE_AUCTIONS_URL) + '" target="_top">Browse active auctions</a></div>'; }
  function renderError() { $('#fi-results', root).innerHTML =
    '<div class="fi-state"><h3>Featured items are taking a moment</h3><p>Please try again shortly.</p>' +
    '<a class="fi-btn" href="' + esc(ACTIVE_AUCTIONS_URL) + '" target="_top">Browse active auctions</a></div>'; }

  function render() {
    root.innerHTML = '<section class="fi" aria-labelledby="fi-h">' +
      '<div class="fi-head"><h2 class="fi-h" id="fi-h">Featured Items Available Now</h2>' +
      '<p class="fi-sub">Discover standout finds from auctions happening now.</p></div>' +
      '<div class="fi-count" id="fi-count" role="status" aria-live="polite"></div>' +
      '<div id="fi-results">' + skeletons() + '</div></section>';
    load(true, false);
    track('impression', { page: state.page });
  }

  function mount() {
    root = document.getElementById('advantage-featured-items');
    if (!root) { root = document.createElement('div'); root.id = 'advantage-featured-items'; document.body.appendChild(root); }
    var mp = (root.getAttribute('data-placement') || '').toLowerCase();
    var up = ''; try { up = (new URLSearchParams(location.search).get('placement') || '').toLowerCase(); } catch (e) {}
    state.placement = PLACEMENTS.indexOf(mp) !== -1 ? mp : (PLACEMENTS.indexOf(up) !== -1 ? up : 'standalone');
    try { var pg = parseInt(new URLSearchParams(location.search).get('page'), 10); if (pg >= 1) state.page = pg; } catch (e) {}
    if (!document.getElementById('fi-style')) { var st = document.createElement('style'); st.id = 'fi-style'; st.textContent = CSS; document.head.appendChild(st); }
    render(); observeSize(); postHeight(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.AdvantageFeaturedItems = { mount: mount };
})();
