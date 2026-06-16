/**
 * Advantage Auction Platform - Featured Auctions Widget
 * Version 1.0
 *
 * Embed on any BD page:
 *
 *   <div id="aap-featured-auctions"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-limit="6"
 *        data-radius-km="200"
 *        data-use-geolocation="true">
 *   </div>
 *   <script src="https://auctions.advantage.bid/widgets/featured-auctions.js"></script>
 *
 * Data attributes:
 *   data-api-base         - API host (default: same origin)
 *   data-limit            - number of cards to show (default 6, max 12)
 *   data-radius-km        - km radius when geolocation is used (default 200)
 *   data-use-geolocation  - "true" to attempt browser geolocation (default "false")
 *   data-theme            - "light" (default) or "dark"
 */

(function () {
  'use strict';

  var CONTAINER_ID = 'aap-featured-auctions';

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch (e) { return ''; }
  }

  function injectStyles(dark) {
    if (document.getElementById('aap-widget-styles')) return;
    var bg    = dark ? '#1e293b' : '#ffffff';
    var fg    = dark ? '#f1f5f9' : '#1e293b';
    var sub   = dark ? '#94a3b8' : '#64748b';
    var bdr   = dark ? '#334155' : '#e2e8f0';
    var livBg = dark ? '#166534' : '#16a34a';
    var upBg  = dark ? '#1d4ed8' : '#3b82f6';
    var noImg = dark ? '#1e293b' : '#f1f5f9';
    var noImgFg = dark ? '#475569' : '#94a3b8';

    var css = [
      '.aap-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.aap-card{border:1px solid ' + bdr + ';border-radius:10px;overflow:hidden;background:' + bg + ';transition:box-shadow .15s;}',
      '.aap-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.12);}',
      '.aap-thumb{width:100%;height:160px;object-fit:cover;display:block;}',
      '.aap-no-img{width:100%;height:160px;display:flex;align-items:center;justify-content:center;background:' + noImg + ';color:' + noImgFg + ';font-size:13px;}',
      '.aap-body{padding:12px 14px;}',
      '.aap-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:6px;}',
      '.aap-live{background:' + livBg + ';color:#fff;}',
      '.aap-upcoming{background:' + upBg + ';color:#fff;}',
      '.aap-title{font-size:15px;font-weight:600;color:' + fg + ';margin:0 0 4px;line-height:1.35;}',
      '.aap-meta{font-size:13px;color:' + sub + ';margin:0 0 3px;}',
      '.aap-lots{font-size:12px;color:' + sub + ';margin:0;}',
      '.aap-empty{color:' + sub + ';font-family:-apple-system,sans-serif;font-size:14px;padding:8px 0;}',
    ].join('');

    var el = document.createElement('style');
    el.id = 'aap-widget-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function buildCard(a) {
    var loc = [a.city, a.address_state].filter(Boolean).join(', ');
    var dist = (a.distance_km != null)
      ? ' &middot; ' + Math.max(1, Math.round(a.distance_km * 0.621371)) + ' mi away'
      : '';
    var badge = a.state === 'active'
      ? '<span class="aap-badge aap-live">LIVE NOW</span>'
      : '<span class="aap-badge aap-upcoming">UPCOMING</span>';
    var thumb = a.cover_image_url
      ? '<img class="aap-thumb" src="' + esc(a.cover_image_url) + '" alt="' + esc(a.title) + '" loading="lazy">'
      : '<div class="aap-no-img">No Image</div>';
    var lots = a.lot_count
      ? '<p class="aap-lots">' + a.lot_count + ' lot' + (a.lot_count !== 1 ? 's' : '') +
        (a.shippable_lot_count ? ' &middot; ' + a.shippable_lot_count + ' ship nationwide' : '') + '</p>'
      : '';
    var endDate = a.end_time ? '<p class="aap-meta">Ends ' + esc(fmtDate(a.end_time)) + '</p>' : '';

    var card = document.createElement('div');
    card.className = 'aap-card';
    card.innerHTML =
      thumb +
      '<div class="aap-body">' +
        badge +
        '<p class="aap-title">' + esc(a.title || 'Untitled Auction') + '</p>' +
        (loc ? '<p class="aap-meta">' + esc(loc) + dist + '</p>' : '') +
        endDate +
        lots +
      '</div>';
    return card;
  }

  function getGeoPosition(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error('unavailable'));
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: timeoutMs || 5000 });
    });
  }

  async function init() {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    var apiBase   = (container.dataset.apiBase || '').replace(/\/$/, '');
    var limit     = Math.min(Math.max(parseInt(container.dataset.limit, 10) || 6, 1), 12);
    var radiusKm  = Math.min(Math.max(parseInt(container.dataset.radiusKm, 10) || 200, 1), 800);
    var useGeo    = container.dataset.useGeolocation === 'true';
    var dark      = container.dataset.theme === 'dark';

    injectStyles(dark);

    var url = apiBase + '/api/public/featured-auctions?limit=' + limit;

    if (useGeo) {
      try {
        var pos = await getGeoPosition(5000);
        url += '&lat=' + pos.coords.latitude + '&lng=' + pos.coords.longitude + '&radius_km=' + radiusKm;
      } catch (e) {
        // Geolocation denied or unavailable - load without location filter
      }
    }

    var auctions;
    try {
      var res  = await fetch(url);
      var body = await res.json();
      auctions = body.data || [];
    } catch (e) {
      container.innerHTML = '<p class="aap-empty">Unable to load featured auctions.</p>';
      return;
    }

    if (!auctions.length) {
      container.innerHTML = '<p class="aap-empty">No featured auctions currently available.</p>';
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'aap-grid';
    auctions.forEach(function (a) { grid.appendChild(buildCard(a)); });
    container.innerHTML = '';
    container.appendChild(grid);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
