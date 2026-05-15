/**
 * bd-auctions-init.js
 * Activates live inventory feeds on the Advantage.Bid /auctions page (BD shell).
 *
 * BD page embed order:
 *   1. <link rel="stylesheet" href="https://auctions.advantage.bid/marketplace.css">
 *   2. <script src="https://auctions.advantage.bid/marketplace-components.js"></script>
 *   3. <script src="https://auctions.advantage.bid/widgets/bd-auctions-init.js"
 *               data-api-base="https://auctions.advantage.bid"></script>
 *
 * Container IDs BD page must expose:
 *   #featured-auctions-feed   — auction card grid (replaces static feature cards)
 *   #ending-soon-scroll       — lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *   #trending-scroll          — lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *   #just-listed-scroll       — lot discovery rail (inside .discovery-rail > .discovery-rail-inner)
 *
 * All sections self-hide if the API returns empty results.
 */
(function () {
  'use strict';

  var script  = document.currentScript;
  var API_BASE = (script && script.dataset.apiBase
    ? script.dataset.apiBase.replace(/\/$/, '')
    : 'https://auctions.advantage.bid');

  var CARD_OPTS = { base: API_BASE };

  function activate(MC) {
    /* ── Featured Auctions ─────────────────────────────────────────── */
    var featuredFeed = document.getElementById('featured-auctions-feed');
    if (featuredFeed) {
      MC.renderSkeletons(featuredFeed, 6);
      fetch(API_BASE + '/api/public/featured-auctions?limit=24')
        .then(function (r) { return r.json(); })
        .then(function (json) {
          featuredFeed.innerHTML = '';
          var data = json && json.data ? json.data : [];
          if (!data.length) {
            featuredFeed.style.display = 'none';
            return;
          }
          var grid = document.createElement('div');
          grid.className = 'auctions-grid';
          data.forEach(function (a) {
            grid.appendChild(MC.makeAuctionCard(a, { featuredBadge: true, base: API_BASE }));
          });
          featuredFeed.appendChild(grid);
        })
        .catch(function () { featuredFeed.style.display = 'none'; });
    }

    /* ── Ending Soon ───────────────────────────────────────────────── */
    var endingSoonScroll = document.getElementById('ending-soon-scroll');
    if (endingSoonScroll) {
      MC.loadDiscoveryRail(
        endingSoonScroll,
        API_BASE + '/api/public/lots/ending-soon',
        { limit: 12, base: API_BASE }
      );
    }

    /* ── Trending ──────────────────────────────────────────────────── */
    var trendingScroll = document.getElementById('trending-scroll');
    if (trendingScroll) {
      MC.loadDiscoveryRail(
        trendingScroll,
        API_BASE + '/api/public/lots/trending',
        { limit: 12, base: API_BASE }
      );
    }

    /* ── Just Listed ───────────────────────────────────────────────── */
    var justListedScroll = document.getElementById('just-listed-scroll');
    if (justListedScroll) {
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
