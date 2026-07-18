/**
 * bd-auctions-init.js
 * Activates live inventory feeds on the Advantage.Bid /auctions page (BD shell).
 *
 * Two modes (canonical auction distribution — read live from bid.advantage.bid, never copy):
 *
 *   GLOBAL mode (main Advantage.Bid /auctions page) — no org attribute:
 *     <link rel="stylesheet" href="https://bid.advantage.bid/marketplace.css">
 *     <script src="https://bid.advantage.bid/marketplace-components.js"></script>
 *     <script src="https://bid.advantage.bid/widgets/bd-auctions-init.js"
 *             data-api-base="https://bid.advantage.bid"></script>
 *   → shows ALL eligible public (published + live) auctions; featured ones sort first + badged.
 *
 *   ORGANIZATION mode (a single seller / estate-sale-company / auction-house website):
 *     …same three tags PLUS  data-organization-id="<org-uuid>"  (or data-seller-id="<seller-uuid>")
 *   → shows ONLY that organization's auctions (filtered server-side by a STABLE UUID, never by
 *     company name). The global lot-discovery rails are suppressed so a company page can never
 *     surface another organization's inventory.
 *
 * Container IDs the BD page must expose:
 *   #featured-auctions-feed   - auction card grid
 *   #ending-soon-scroll / #trending-scroll / #just-listed-scroll  - global lot rails (GLOBAL mode only)
 *
 * All sections self-hide when empty. The grid reads the LIVE platform feed, so any auction
 * published on bid.advantage.bid appears automatically and edits/closes/cancellations reflect on
 * the next load — nothing is stored or duplicated on the external side.
 */
(function () {
  'use strict';

  var script  = document.currentScript;
  var API_BASE = (script && script.dataset.apiBase
    ? script.dataset.apiBase.replace(/\/$/, '')
    : 'https://bid.advantage.bid');

  // Organization mode when a stable org/seller UUID is supplied; otherwise global mode.
  var ORG_ID    = (script && script.dataset.organizationId || '').trim();
  var SELLER_ID = (script && script.dataset.sellerId || '').trim();
  var ORG_MODE  = !!(ORG_ID || SELLER_ID);

  var CARD_OPTS = { base: API_BASE };

  /* Ensure the discovery-rail-scroll class is present so marketplace.css
     mobile styles (overflow-x, min-width, scroll-snap) always apply,
     regardless of whether the BD page template includes the class. */
  function ensureRailClass(el) {
    if (el && !el.classList.contains('discovery-rail-scroll')) {
      el.classList.add('discovery-rail-scroll');
    }
  }

  function jsonOrEmpty(r) { return r.json().catch(function () { return { data: [] }; }); }
  function getJSON(url) { return fetch(url).then(jsonOrEmpty).catch(function () { return { data: [] }; }); }

  function renderGrid(feed, MC, ordered) {
    feed.innerHTML = '';
    if (!ordered.length) { feed.style.display = 'none'; return; }
    var grid = document.createElement('div');
    grid.className = 'auctions-grid';
    ordered.forEach(function (o) {
      grid.appendChild(MC.makeAuctionCard(o.a, { featuredBadge: o.featured, base: API_BASE }));
    });
    feed.appendChild(grid);
  }

  /* GLOBAL: every eligible published + live auction. Merge the featured feed (for badge + priority
     order) with the full published+active syndicated feed, de-duplicated by id, so any published
     auction appears (not only marketplace_priority > 0). */
  function loadGlobal(feed, MC) {
    Promise.all([
      getJSON(API_BASE + '/api/public/featured-auctions?limit=48'),
      getJSON(API_BASE + '/api/public/auctions?limit=100')
    ]).then(function (res) {
      var featured = (res[0] && res[0].data) || [];
      var all      = (res[1] && res[1].data) || [];
      var seen = {}, ordered = [];
      featured.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = true; ordered.push({ a: a, featured: true }); } });
      all.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = true; ordered.push({ a: a, featured: false }); } });
      renderGrid(feed, MC, ordered);
    }).catch(function () { feed.style.display = 'none'; });
  }

  /* ORGANIZATION: only this org's/seller's auctions, filtered server-side by a stable UUID. */
  function loadOrganization(feed, MC) {
    var qs = ORG_ID ? 'organization_id=' + encodeURIComponent(ORG_ID)
                    : 'seller_id=' + encodeURIComponent(SELLER_ID);
    getJSON(API_BASE + '/api/public/auctions?' + qs + '&limit=100').then(function (json) {
      var all = (json && json.data) || [];
      renderGrid(feed, MC, all.map(function (a) { return { a: a, featured: false }; }));
    }).catch(function () { feed.style.display = 'none'; });
  }

  function activate(MC) {
    /* ── Auctions grid ─────────────────────────────────────────────── */
    var feed = document.getElementById('featured-auctions-feed');
    if (feed) {
      MC.renderSkeletons(feed, 6);
      if (ORG_MODE) loadOrganization(feed, MC);
      else          loadGlobal(feed, MC);
    }

    // Global lot-discovery rails — GLOBAL mode only. In organization mode they are suppressed so a
    // company page never surfaces another organization's lots (the lot feeds are cross-org).
    if (ORG_MODE) return;

    var rails = [
      ['ending-soon-scroll',  '/api/public/lots/ending-soon'],
      ['trending-scroll',     '/api/public/lots/trending'],
      ['just-listed-scroll',  '/api/public/lots/recently-added']
    ];
    rails.forEach(function (r) {
      var el = document.getElementById(r[0]);
      if (el) { ensureRailClass(el); MC.loadDiscoveryRail(el, API_BASE + r[1], { limit: 12, base: API_BASE }); }
    });
  }

  /* Wait for MktComponents whether script is sync or async */
  if (window.MktComponents) {
    activate(window.MktComponents);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      if (window.MktComponents) activate(window.MktComponents);
    });
  }

})();
