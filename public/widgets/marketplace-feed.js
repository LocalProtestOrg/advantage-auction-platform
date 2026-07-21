/**
 * marketplace-feed.js — the unified Advantage.Bid discovery feed (one grid, many content types).
 *
 * Renders Auctions + Marketplace Events (and, later, Marketplace Listings) together as a SINGLE
 * discovery experience — one grid, one visual language — through the shared MktComponents card
 * framework. Every item, whatever its type, is rendered by the single entry point
 * MktComponents.makeMarketplaceCard(item), which dispatches to the type-specific card by
 * `content_type`. There is no separate auctions grid and no duplicate rendering logic.
 *
 * Embed (BD /all-events or any page):
 *   <link rel="stylesheet" href="https://bid.advantage.bid/marketplace.css">
 *   <script src="https://bid.advantage.bid/marketplace-components.js"></script>
 *   <script src="https://bid.advantage.bid/widgets/marketplace-feed.js"
 *           data-api-base="https://bid.advantage.bid"
 *           data-types="auctions,events"
 *           data-container="marketplace-feed"></script>
 *   …with <div id="marketplace-feed"></div> on the page.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var rawBase = script && script.dataset.apiBase;
  var API_BASE = (rawBase === undefined ? 'https://bid.advantage.bid' : String(rawBase).replace(/\/$/, ''));
  var TYPES = ((script && script.dataset.types) || 'auctions,events').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var CONTAINER_ID = (script && script.dataset.container) || 'marketplace-feed';

  var allItems = [];
  var activeFilter = 'all';

  ensureStyles();

  function ensureStyles() {
    if (document.getElementById('mkt-feed-styles')) return;
    var s = document.createElement('style');
    s.id = 'mkt-feed-styles';
    s.textContent = [
      '.mkt-filter{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}',
      '.mkt-chip{border:1px solid #dce3ea;background:#fff;color:#33475b;font:600 13px/1 system-ui,sans-serif;padding:9px 15px;border-radius:999px;cursor:pointer}',
      '.mkt-chip:hover{border-color:#2F6BFF;color:#2F6BFF}',
      '.mkt-chip.on{background:#0B1B2B;border-color:#0B1B2B;color:#fff}',
      '.mkt-empty{padding:48px 16px;text-align:center;color:#637488;font:500 15px/1.5 system-ui,sans-serif}'
    ].join('');
    document.head.appendChild(s);
  }

  function getJSON(url) {
    return fetch(url).then(function (r) { return r.json().catch(function () { return { data: [] }; }); })
      .catch(function () { return { data: [] }; });
  }

  // Auctions: merge the featured feed (priority + badge) with the full published/active feed, deduped.
  function loadAuctions() {
    return Promise.all([
      getJSON(API_BASE + '/api/public/featured-auctions?limit=48'),
      getJSON(API_BASE + '/api/public/auctions?limit=100')
    ]).then(function (res) {
      var featured = (res[0] && res[0].data) || [];
      var all = (res[1] && res[1].data) || [];
      var seen = {}, out = [];
      featured.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = 1; a.content_type = 'auction'; a._featured = true; out.push(a); } });
      all.forEach(function (a) { if (a && a.id && !seen[a.id]) { seen[a.id] = 1; a.content_type = 'auction'; out.push(a); } });
      return out;
    });
  }

  function loadEvents() {
    return getJSON(API_BASE + '/api/public/events?limit=48').then(function (json) {
      return ((json && json.data) || []).map(function (e) { e.content_type = 'event'; e._featured = !!e.is_featured; return e; });
    });
  }

  // Unified ordering: featured first, then soonest-relevant date (auction closing / event start).
  function sortDate(it) {
    if (it.content_type === 'event') return it.start_at ? new Date(it.start_at).getTime() : Infinity;
    var d = it.end_time || it.start_time;
    return d ? new Date(d).getTime() : Infinity;
  }
  function unifiedSort(a, b) {
    var fa = a._featured ? 0 : 1, fb = b._featured ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return sortDate(a) - sortDate(b);
  }

  function countByType(type) {
    return allItems.filter(function (it) { return it.content_type === type; }).length;
  }

  function render(MC) {
    var feed = document.getElementById(CONTAINER_ID);
    if (!feed) return;
    feed.innerHTML = '';

    // Type filter — only when more than one type is actually present (keeps a single experience).
    var haveA = countByType('auction'), haveE = countByType('event');
    if (haveA && haveE) {
      var bar = document.createElement('div');
      bar.className = 'mkt-filter';
      [['all', 'All', haveA + haveE], ['auction', 'Auctions', haveA], ['event', 'Events', haveE]].forEach(function (f) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mkt-chip' + (activeFilter === f[0] ? ' on' : '');
        b.textContent = f[1] + ' (' + f[2] + ')';
        b.addEventListener('click', function () { activeFilter = f[0]; render(MC); });
        bar.appendChild(b);
      });
      feed.appendChild(bar);
    }

    var items = activeFilter === 'all' ? allItems : allItems.filter(function (it) { return it.content_type === activeFilter; });
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'mkt-empty';
      empty.textContent = 'Nothing to show here yet — check back soon.';
      feed.appendChild(empty);
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'auctions-grid';
    items.forEach(function (it) {
      // ONE entry point for every content type — the card framework dispatches by content_type.
      grid.appendChild(MC.makeMarketplaceCard(it, { base: API_BASE, featuredBadge: !!it._featured }));
    });
    feed.appendChild(grid);
    if (MC.updateTimers) MC.updateTimers();
  }

  function activate(MC) {
    var feed = document.getElementById(CONTAINER_ID);
    if (!feed) return;
    MC.renderSkeletons(feed, 8);
    Promise.all([
      TYPES.indexOf('auctions') >= 0 ? loadAuctions() : Promise.resolve([]),
      TYPES.indexOf('events') >= 0 ? loadEvents() : Promise.resolve([])
    ]).then(function (res) {
      allItems = (res[0] || []).concat(res[1] || []);
      allItems.sort(unifiedSort);
      render(MC);
    }).catch(function () { feed.innerHTML = ''; });
  }

  if (window.MktComponents) {
    activate(window.MktComponents);
  } else {
    document.addEventListener('DOMContentLoaded', function () { if (window.MktComponents) activate(window.MktComponents); });
  }
})();
