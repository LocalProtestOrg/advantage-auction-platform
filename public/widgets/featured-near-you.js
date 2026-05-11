/**
 * Advantage Auction Platform — Featured Auctions Near You Widget
 * Version 1.0
 *
 * Embed on any BD or partner page:
 *
 *   <div id="aap-featured-near-you"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-limit="6"
 *        data-radius-km="200"
 *        data-use-geolocation="true"
 *        data-seller-cta-url="https://auctions.advantage.bid/seller-create.html">
 *   </div>
 *   <!-- optional: load shared utils first when using multiple widgets on one page -->
 *   <script src="https://auctions.advantage.bid/widgets/shared/utils.js"></script>
 *   <script src="https://auctions.advantage.bid/widgets/featured-near-you.js"></script>
 *
 * Data attributes:
 *   data-api-base            — API host (default: same origin)
 *   data-limit               — auction cards to show, 1–12 (default 6)
 *   data-radius-km           — geo search radius in km, 1–800 (default 200)
 *   data-use-geolocation     — "true" to request browser location (default "false")
 *   data-geo-timeout-ms      — geolocation timeout in ms, 1000–15000 (default 5000)
 *   data-theme               — "light" (default) or "dark"
 *   data-seller-cta-url      — seller CTA card link (omit to hide CTA card)
 *   data-seller-cta-headline — CTA card headline (default "Consigning an Estate?")
 *   data-seller-cta-label    — CTA button label (default "Learn More")
 *
 * Fetch strategy:
 *   1. Geo granted  → GET /api/public/featured-auctions?lat=…&lng=…&radius_km=…
 *      If that returns 0 results → GET /api/public/auctions/near?lat=…&lng=…&radius_km=…
 *   2. Geo denied / unavailable / not requested
 *      → GET /api/public/featured-auctions  (national featured feed)
 *
 * Analytics events (bubble from the container element — listen with addEventListener):
 *   aap:widget:loaded   — { widgetId, resultCount, source: 'featured'|'near'|'national' }
 *   aap:widget:fallback — { reason: 'geo-denied'|'geo-unavailable'|'geo-timeout'|'no-results' }
 *   aap:auction:click   — { auctionId, title, distanceKm, source }
 *   aap:cta:click       — { widgetId }
 *
 * No auth tokens are used. All API calls are anonymous GETs to /api/public/* only.
 */

(function () {
  'use strict';

  var WIDGET_ID  = 'aap-featured-near-you';
  var STYLE_ID   = 'aapny-styles';
  var P          = 'aapny';    // CSS class prefix — never collides with aap- widget

  // ── Inline fallback utilities ────────────────────────────────────────────────
  // Used when shared/utils.js is not loaded. If AAPWidgetUtils is present its
  // implementations take precedence (loaded once, shared across all widgets).
  var U = window.AAPWidgetUtils || {
    esc: function (str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    fmtDate: function (iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch (e) { return ''; }
    },
    fmtRelativeTime: function (iso) {
      if (!iso) return '';
      try {
        var diffMs = new Date(iso).getTime() - Date.now();
        if (diffMs <= 0) return 'Ended';
        var h = Math.floor(diffMs / 3600000);
        if (h < 1) return 'Ends in ' + Math.floor(diffMs / 60000) + 'm';
        if (h < 24) return 'Ends in ' + h + 'h';
        return 'Ends in ' + Math.floor(h / 24) + 'd';
      } catch (e) { return ''; }
    },
    fmtDistance: function (km) {
      if (km == null) return null;
      var r = Math.round(km);
      return (r === 0 ? '< 1' : r) + ' km away';
    },
    clamp: function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); },
    parseIntSafe: function (s, fb) { var n = parseInt(s, 10); return isNaN(n) ? fb : n; },
    getGeoPosition: function (ms) {
      return new Promise(function (resolve, reject) {
        if (!navigator.geolocation) {
          var e = new Error('unavailable'); e.code = 2; return reject(e);
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: ms || 5000, maximumAge: 300000,
        });
      });
    },
    injectStyle: function (id, css) {
      if (document.getElementById(id)) return;
      var el = document.createElement('style');
      el.id = id; el.textContent = css;
      document.head.appendChild(el);
    },
    dispatch: function (el, name, detail) {
      try { el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} })); } catch (e) {}
    },
  };

  // ── CSS ──────────────────────────────────────────────────────────────────────
  // Uses CSS custom properties so dark/light theme is toggled by a class on the
  // grid element — allows multiple instances with different themes on one page
  // without re-injecting the style block.
  var CSS = [
    // Theme tokens — light (default)
    '.' + P + '-grid{',
      '--' + P + '-bg:#ffffff;',
      '--' + P + '-bg-secondary:#f8fafc;',
      '--' + P + '-fg:#1e293b;',
      '--' + P + '-sub:#64748b;',
      '--' + P + '-bdr:#e2e8f0;',
      '--' + P + '-live:#16a34a;',
      '--' + P + '-up:#3b82f6;',
      '--' + P + '-ship:#0891b2;',
      '--' + P + '-dist:#0284c7;',
      '--' + P + '-cta-bdr:#3b82f6;',
      '--' + P + '-skel:#e2e8f0;',
      '--' + P + '-err:#dc2626;',
    '}',
    // Theme tokens — dark
    '.' + P + '-grid.' + P + '-dark{',
      '--' + P + '-bg:#1e293b;',
      '--' + P + '-bg-secondary:#0f172a;',
      '--' + P + '-fg:#f1f5f9;',
      '--' + P + '-sub:#94a3b8;',
      '--' + P + '-bdr:#334155;',
      '--' + P + '-live:#166534;',
      '--' + P + '-up:#1d4ed8;',
      '--' + P + '-ship:#164e63;',
      '--' + P + '-dist:#38bdf8;',
      '--' + P + '-cta-bdr:#1d4ed8;',
      '--' + P + '-skel:#334155;',
      '--' + P + '-err:#f87171;',
    '}',
    // Grid layout
    '.' + P + '-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '@media(max-width:480px){.' + P + '-grid{grid-template-columns:1fr;}}',
    // Auction card
    '.' + P + '-card{border:1px solid var(--' + P + '-bdr);border-radius:10px;overflow:hidden;background:var(--' + P + '-bg);transition:box-shadow .15s;cursor:pointer;display:flex;flex-direction:column;}',
    '.' + P + '-card:hover{box-shadow:0 4px 20px rgba(0,0,0,.13);}',
    '.' + P + '-card:focus-visible{outline:2px solid var(--' + P + '-up);outline-offset:2px;}',
    // Thumbnail
    '.' + P + '-thumb{width:100%;height:168px;object-fit:cover;display:block;flex-shrink:0;}',
    '.' + P + '-no-img{width:100%;height:168px;display:flex;align-items:center;justify-content:center;background:var(--' + P + '-bg-secondary);color:var(--' + P + '-sub);font-size:13px;flex-shrink:0;}',
    // Card body
    '.' + P + '-body{padding:12px 14px 14px;display:flex;flex-direction:column;flex:1;}',
    // Badges
    '.' + P + '-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px;}',
    '.' + P + '-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.04em;}',
    '.' + P + '-live{background:var(--' + P + '-live);color:#fff;}',
    '.' + P + '-upcoming{background:var(--' + P + '-up);color:#fff;}',
    '.' + P + '-ships{background:var(--' + P + '-ship);color:#fff;}',
    // Text
    '.' + P + '-title{font-size:15px;font-weight:600;color:var(--' + P + '-fg);margin:0 0 5px;line-height:1.35;}',
    '.' + P + '-meta{font-size:13px;color:var(--' + P + '-sub);margin:0 0 3px;line-height:1.4;}',
    '.' + P + '-dist{font-size:12px;font-weight:600;color:var(--' + P + '-dist);margin:4px 0 0;}',
    '.' + P + '-lots{font-size:12px;color:var(--' + P + '-sub);margin:6px 0 0;}',
    '.' + P + '-seller{font-size:12px;color:var(--' + P + '-sub);margin:4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    // CTA card
    '.' + P + '-cta{border:2px dashed var(--' + P + '-cta-bdr);border-radius:10px;background:var(--' + P + '-bg-secondary);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;min-height:220px;}',
    '.' + P + '-cta-head{font-size:17px;font-weight:700;color:var(--' + P + '-fg);margin:0 0 8px;}',
    '.' + P + '-cta-sub{font-size:13px;color:var(--' + P + '-sub);margin:0 0 20px;line-height:1.6;max-width:220px;}',
    '.' + P + '-cta-btn{display:inline-block;padding:10px 22px;background:#2563eb;color:#fff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;transition:background .15s;}',
    '.' + P + '-cta-btn:hover{background:#1d4ed8;}',
    '.' + P + '-cta-btn:focus-visible{outline:2px solid #93c5fd;outline-offset:2px;}',
    // States
    '.' + P + '-empty{color:var(--' + P + '-sub);font-family:-apple-system,sans-serif;font-size:14px;padding:8px 0;}',
    '.' + P + '-error{color:var(--' + P + '-err);font-family:-apple-system,sans-serif;font-size:14px;padding:8px 0;}',
    // Loading skeleton
    '.' + P + '-skeleton{border:1px solid var(--' + P + '-bdr);border-radius:10px;overflow:hidden;background:var(--' + P + '-bg);}',
    '.' + P + '-skel-img{width:100%;height:168px;background:var(--' + P + '-skel);animation:' + P + '-pulse 1.4s ease-in-out infinite;}',
    '.' + P + '-skel-body{padding:12px 14px 14px;}',
    '.' + P + '-skel-line{height:12px;border-radius:4px;background:var(--' + P + '-skel);margin-bottom:9px;animation:' + P + '-pulse 1.4s ease-in-out infinite;}',
    '@keyframes ' + P + '-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  ].join('');

  // ── Skeleton card (shown during fetch) ───────────────────────────────────────
  function buildSkeleton() {
    var card = document.createElement('div');
    card.className = P + '-skeleton';
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML =
      '<div class="' + P + '-skel-img"></div>' +
      '<div class="' + P + '-skel-body">' +
        '<div class="' + P + '-skel-line" style="width:38%;height:10px;margin-bottom:10px"></div>' +
        '<div class="' + P + '-skel-line" style="width:88%"></div>' +
        '<div class="' + P + '-skel-line" style="width:60%"></div>' +
        '<div class="' + P + '-skel-line" style="width:72%;height:10px;margin-top:4px"></div>' +
      '</div>';
    return card;
  }

  // ── Auction card ─────────────────────────────────────────────────────────────
  function buildCard(auction, source, container) {
    var a   = auction;
    var loc = [a.city, a.address_state].filter(Boolean).join(', ');
    var dist = U.fmtDistance(a.distance_km);
    var rel  = a.end_time ? U.fmtRelativeTime(a.end_time) : '';
    var date = a.end_time ? U.fmtDate(a.end_time) : '';

    var statusBadge = a.state === 'active'
      ? '<span class="' + P + '-badge ' + P + '-live" aria-label="Live auction">LIVE NOW</span>'
      : '<span class="' + P + '-badge ' + P + '-upcoming" aria-label="Upcoming auction">UPCOMING</span>';

    var shipBadge = (a.shippable_lot_count > 0)
      ? '<span class="' + P + '-badge ' + P + '-ships">Ships nationwide</span>'
      : '';

    var thumb = a.cover_image_url
      ? '<img class="' + P + '-thumb" src="' + U.esc(a.cover_image_url) + '" alt="" loading="lazy" aria-hidden="true">'
      : '<div class="' + P + '-no-img" aria-hidden="true">No Image</div>';

    var distEl = dist
      ? '<p class="' + P + '-dist">' + U.esc(dist) + '</p>'
      : '';

    var timeEl = '';
    if (rel && date) {
      timeEl = '<p class="' + P + '-meta">' + U.esc(rel) + ' &middot; ' + U.esc(date) + '</p>';
    } else if (date) {
      timeEl = '<p class="' + P + '-meta">Ends ' + U.esc(date) + '</p>';
    }

    var lotsEl = '';
    if (a.lot_count) {
      var lotLabel = a.lot_count + ' lot' + (a.lot_count !== 1 ? 's' : '');
      if (a.shippable_lot_count > 0) {
        lotLabel += ' &middot; ' + a.shippable_lot_count + ' ship';
      }
      lotsEl = '<p class="' + P + '-lots">' + lotLabel + '</p>';
    }

    var sellerEl = a.seller_display_name
      ? '<p class="' + P + '-seller">by ' + U.esc(a.seller_display_name) + '</p>'
      : '';

    var card = document.createElement('div');
    card.className = P + '-card';
    card.setAttribute('role', 'article');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', U.esc(a.title || 'Auction'));
    card.setAttribute('data-auction-id', U.esc(a.id || ''));

    card.innerHTML =
      thumb +
      '<div class="' + P + '-body">' +
        '<div class="' + P + '-badges">' + statusBadge + shipBadge + '</div>' +
        '<p class="' + P + '-title">' + U.esc(a.title || 'Untitled Auction') + '</p>' +
        (loc ? '<p class="' + P + '-meta">' + U.esc(loc) + '</p>' : '') +
        distEl +
        timeEl +
        lotsEl +
        sellerEl +
      '</div>';

    card.addEventListener('click', function () {
      U.dispatch(container, 'aap:auction:click', {
        auctionId:  a.id,
        title:      a.title,
        distanceKm: a.distance_km != null ? a.distance_km : null,
        source:     source,
      });
    });

    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') card.click();
    });

    return card;
  }

  // ── Seller CTA card ──────────────────────────────────────────────────────────
  function buildCtaCard(cfg, container) {
    var card = document.createElement('div');
    card.className = P + '-cta';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', 'Seller information');

    card.innerHTML =
      '<p class="' + P + '-cta-head">' + U.esc(cfg.headline || 'Consigning an Estate?') + '</p>' +
      '<p class="' + P + '-cta-sub">We auction estates, collections, and commercial inventory nationwide.</p>' +
      '<a class="' + P + '-cta-btn"' +
         ' href="' + U.esc(cfg.url) + '"' +
         ' target="_blank"' +
         ' rel="noopener noreferrer">' +
        U.esc(cfg.label || 'Learn More') +
      '</a>';

    card.querySelector('a').addEventListener('click', function () {
      U.dispatch(container, 'aap:cta:click', { widgetId: WIDGET_ID });
    });

    return card;
  }

  // ── API fetch (no auth) ──────────────────────────────────────────────────────
  async function apiFetch(url) {
    var res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json();
    if (!body.success) throw new Error('API returned success:false');
    return Array.isArray(body.data) ? body.data : [];
  }

  // ── Main ─────────────────────────────────────────────────────────────────────
  async function init() {
    var container = document.getElementById(WIDGET_ID);
    if (!container) return;

    // Parse configuration from data attributes
    var apiBase    = (container.dataset.apiBase || '').replace(/\/$/, '');
    var limit      = U.clamp(U.parseIntSafe(container.dataset.limit, 6), 1, 12);
    var radiusKm   = U.clamp(U.parseIntSafe(container.dataset.radiusKm, 200), 1, 800);
    var useGeo     = container.dataset.useGeolocation === 'true';
    var geoTimeout = U.clamp(U.parseIntSafe(container.dataset.geoTimeoutMs, 5000), 1000, 15000);
    var dark       = container.dataset.theme === 'dark';

    var ctaCfg = container.dataset.sellerCtaUrl
      ? { url: container.dataset.sellerCtaUrl,
          headline: container.dataset.sellerCtaHeadline,
          label: container.dataset.sellerCtaLabel }
      : null;

    // Inject shared styles once — CSS variables handle theming per-instance
    U.injectStyle(STYLE_ID, CSS);

    // ── Loading skeletons ──────────────────────────────────────────────────────
    var loadGrid = document.createElement('div');
    loadGrid.className = P + '-grid' + (dark ? ' ' + P + '-dark' : '');
    loadGrid.setAttribute('aria-busy', 'true');
    loadGrid.setAttribute('aria-label', 'Loading featured auctions');
    for (var i = 0; i < limit; i++) {
      loadGrid.appendChild(buildSkeleton());
    }
    container.innerHTML = '';
    container.appendChild(loadGrid);

    // ── Geolocation attempt ────────────────────────────────────────────────────
    var geoPos = null;

    if (useGeo) {
      try {
        geoPos = await U.getGeoPosition(geoTimeout);
      } catch (e) {
        var code = e && e.code;
        var reason = code === 1 ? 'geo-denied' : code === 3 ? 'geo-timeout' : 'geo-unavailable';
        U.dispatch(container, 'aap:widget:fallback', { reason: reason });
        // Continue — will fetch national feed below
      }
    }

    // ── Fetch strategy ─────────────────────────────────────────────────────────
    var auctions = [];
    var source   = 'national';

    try {
      if (geoPos) {
        var lat = geoPos.coords.latitude;
        var lng = geoPos.coords.longitude;

        // Primary: geo-filtered featured auctions
        var featUrl = apiBase + '/api/public/featured-auctions?limit=' + limit
          + '&lat=' + lat + '&lng=' + lng + '&radius_km=' + radiusKm;
        auctions = await apiFetch(featUrl);
        source = 'featured';

        // Secondary: if no featured results near the user, broaden to all nearby
        if (!auctions.length) {
          U.dispatch(container, 'aap:widget:fallback', { reason: 'no-results' });
          var nearUrl = apiBase + '/api/public/auctions/near?limit=' + limit
            + '&lat=' + lat + '&lng=' + lng + '&radius_km=' + radiusKm;
          auctions = await apiFetch(nearUrl);
          source = 'near';
        }
      } else {
        // No geo — national featured feed
        var natUrl = apiBase + '/api/public/featured-auctions?limit=' + limit;
        auctions = await apiFetch(natUrl);
        source = 'national';
      }
    } catch (e) {
      container.innerHTML = '<p class="' + P + '-error">Unable to load auctions. Please try again later.</p>';
      return;
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    if (!auctions.length) {
      container.innerHTML = '<p class="' + P + '-empty">No featured auctions found in your area. Check back soon!</p>';
      U.dispatch(container, 'aap:widget:loaded', { widgetId: WIDGET_ID, resultCount: 0, source: source });
      return;
    }

    var grid = document.createElement('div');
    grid.className = P + '-grid' + (dark ? ' ' + P + '-dark' : '');
    grid.setAttribute('aria-label', 'Featured auctions near you');

    auctions.forEach(function (a) {
      grid.appendChild(buildCard(a, source, container));
    });

    if (ctaCfg) {
      grid.appendChild(buildCtaCard(ctaCfg, container));
    }

    container.innerHTML = '';
    container.appendChild(grid);

    U.dispatch(container, 'aap:widget:loaded', {
      widgetId:    WIDGET_ID,
      resultCount: auctions.length,
      source:      source,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
