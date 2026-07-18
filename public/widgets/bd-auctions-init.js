/**
 * bd-auctions-init.js
 * Activates live inventory feeds on the Advantage.Bid /auctions page (BD shell).
 *
 * BD page embed order (canonical origin):
 *   1. <link rel="stylesheet" href="https://bid.advantage.bid/marketplace.css">
 *   2. <script src="https://bid.advantage.bid/marketplace-components.js"></script>
 *   3. <script src="https://bid.advantage.bid/widgets/bd-auctions-init.js"
 *               data-api-base="https://bid.advantage.bid"></script>
 *
 * Container IDs BD page must expose:
 *   #featured-auctions-feed   - auction card grid (ALL publicly-published + live auctions;
 *                               featured ones sort first with a badge)
 *   #ending-soon-scroll       - lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *   #trending-scroll          - lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *   #just-listed-scroll       - lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *
 * All sections self-hide if the API returns empty results. The grid reads the LIVE platform
 * feed, so any auction published on bid.advantage.bid appears automatically and edits/closes
 * are reflected on the next load — nothing is stored or duplicated on the BD side.
 */
(function () {
  'use strict';

  var script  = document.currentScript;
  var API_BASE = (script && script.dataset.apiBase
    ? script.dataset.apiBase.replace(/\/$/, '')
    : 'https://bid.advantage.bid');

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

  function activate(MC) {
    /* ── Auctions grid — EVERY publicly-published + live auction ─────────
       The old behavior showed only "featured" auctions (marketplace_priority > 0), so a plain
       published auction never appeared. We now merge the featured feed (for the badge + priority
       order) with the full published+active syndicated feed (/api/public/auctions with no state
       returns both), de-duplicated by id, so any auction published on the platform shows here. */
    var featuredFeed = document.getElementById('featured-auctions-feed');
    if (featuredFeed) {
      MC.renderSkeletons(featuredFeed, 6);
      Promise.all([
        fetch(API_BASE + '/api/public/featured-auctions?limit=48').then(jsonOrEmpty).catch(function () { return { data: [] }; }),
        fetch(API_BASE + '/api/public/auctions?limit=100').then(jsonOrEmpty).catch(function () { return { data: [] }; })
      ])
        .then(function (res) {
          var featured = (res[0] && res[0].data) || [];
          var all      = (res[1] && res[1].data) || [];
          var seen = {}, ordered = [];
          // Featured first (keep their badge + priority order)…
          featured.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = true; ordered.push({ a: a, featured: true }); } });
          // …then every remaining published/active auction, in the API's ranked order.
          all.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = true; ordered.push({ a: a, featured: false }); } });

          featuredFeed.innerHTML = '';
          if (!ordered.length) { featuredFeed.style.display = 'none'; return; }
          var grid = document.createElement('div');
          grid.className = 'auctions-grid';
          ordered.forEach(function (o) {
            grid.appendChild(MC.makeAuctionCard(o.a, { featuredBadge: o.featured, base: API_BASE }));
          });
          featuredFeed.appendChild(grid);
        })
        .catch(function () { featuredFeed.style.display = 'none'; });
    }

    /* ── Ending Soon ───────────────────────────────────────────────── */
    var endingSoonScroll = document.getElementById('ending-soon-scroll');
    if (endingSoonScroll) {
      ensureRailClass(endingSoonScroll);
      MC.loadDiscoveryRail(
        endingSoonScroll,
        API_BASE + '/api/public/lots/ending-soon',
        { limit: 12, base: API_BASE }
      );
    }

    /* ── Trending ──────────────────────────────────────────────────── */
    var trendingScroll = document.getElementById('trending-scroll');
    if (trendingScroll) {
      ensureRailClass(trendingScroll);
      MC.loadDiscoveryRail(
        trendingScroll,
        API_BASE + '/api/public/lots/trending',
        { limit: 12, base: API_BASE }
      );
    }

    /* ── Just Listed ───────────────────────────────────────────────── */
    var justListedScroll = document.getElementById('just-listed-scroll');
    if (justListedScroll) {
      ensureRailClass(justListedScroll);
      MC.loadDiscoveryRail(
        justListedScroll,
        API_BASE + '/api/public/lots/recently-added',
        { limit: 12, base: API_BASE }
      );
    }
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
