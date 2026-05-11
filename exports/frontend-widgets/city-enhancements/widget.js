/**
 * Advantage Auction Platform — City Enhancements Loader
 * Export package v1.0.0
 *
 * Pre-configured regional variants of the Featured Near You widget.
 * Each city configuration uses hardcoded coordinates — no browser
 * geolocation prompt is ever triggered.
 *
 * DEPLOYMENT USAGE — specify a city slug via data-city:
 *
 *   <div id="aap-featured-near-you"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-city="dallas-tx"
 *        data-limit="6">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 * Or with custom overrides:
 *
 *   <div id="aap-featured-near-you"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-city="dallas-tx"
 *        data-radius-km="100"
 *        data-limit="9">
 *   </div>
 *   <script src="./widget.js"></script>
 *
 * Available city slugs: dallas-tx, houston-tx, atlanta-ga, chicago-il,
 * phoenix-az, denver-co, nashville-tn, kansas-city-mo, minneapolis-mn,
 * san-antonio-tx
 *
 * For unlisted cities: use the featured-near-you widget directly with
 * data-lat and data-lng attributes.
 *
 * See README.md in this package for the full deployment guide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENGINEERING NOTE:
 * This loader wraps the canonical featured-near-you.js widget.
 * City coordinate data is maintained here — not in the underlying widget.
 * If coordinates need updating, update CITY_CONFIGS in this file and
 * bump the package version in version.json.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var CDN_BASE   = 'https://auctions.advantage.bid';
  var WIDGET_SRC = CDN_BASE + '/widgets/featured-near-you.js';
  var WIDGET_ID  = 'aap-featured-near-you';

  // City configurations — lat/lng are city center coordinates
  // radius_km is the default search radius for each metro area
  var CITY_CONFIGS = {
    'dallas-tx':       { lat: 32.7767,  lng: -96.7970,  radius_km: 150, label: 'Dallas / Fort Worth, TX' },
    'houston-tx':      { lat: 29.7604,  lng: -95.3698,  radius_km: 150, label: 'Houston, TX' },
    'san-antonio-tx':  { lat: 29.4241,  lng: -98.4936,  radius_km: 120, label: 'San Antonio, TX' },
    'atlanta-ga':      { lat: 33.7490,  lng: -84.3880,  radius_km: 150, label: 'Atlanta, GA' },
    'chicago-il':      { lat: 41.8781,  lng: -87.6298,  radius_km: 100, label: 'Chicago, IL' },
    'phoenix-az':      { lat: 33.4484,  lng: -112.0740, radius_km: 150, label: 'Phoenix, AZ' },
    'denver-co':       { lat: 39.7392,  lng: -104.9903, radius_km: 150, label: 'Denver, CO' },
    'nashville-tn':    { lat: 36.1627,  lng: -86.7816,  radius_km: 120, label: 'Nashville, TN' },
    'kansas-city-mo':  { lat: 39.0997,  lng: -94.5786,  radius_km: 150, label: 'Kansas City, MO' },
    'minneapolis-mn':  { lat: 44.9778,  lng: -93.2650,  radius_km: 150, label: 'Minneapolis, MN' },
  };

  if (document.querySelector('script[data-aap-widget="city-enhancements"]')) return;

  var container = document.getElementById(WIDGET_ID);
  if (!container) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] City Enhancements: container #' + WIDGET_ID + ' not found.');
    }
    return;
  }

  var citySlug = container.dataset.city || '';
  var city     = CITY_CONFIGS[citySlug];

  if (!city) {
    if (typeof console !== 'undefined') {
      console.warn('[AAP] City Enhancements: unknown city slug "' + citySlug + '". ' +
        'Available: ' + Object.keys(CITY_CONFIGS).join(', ') + '. ' +
        'Use the featured-near-you widget directly for custom coordinates.');
    }
    return;
  }

  // Apply city coordinates to the container — the underlying widget reads these
  // Container may already have data-lat/data-lng — do not overwrite explicit overrides
  if (!container.dataset.lat)      container.setAttribute('data-lat',      String(city.lat));
  if (!container.dataset.lng)      container.setAttribute('data-lng',      String(city.lng));
  if (!container.dataset.radiusKm && !container.dataset['radius-km']) {
    container.setAttribute('data-radius-km', String(city.radius_km));
  }
  // City enhancements never use browser geolocation — coordinates are always hardcoded
  container.removeAttribute('data-use-geolocation');

  // Load the canonical widget script
  var s = document.createElement('script');
  s.src = WIDGET_SRC;
  s.defer = true;
  s.setAttribute('data-aap-widget', 'city-enhancements');
  s.onerror = function () {
    if (typeof console !== 'undefined') {
      console.error('[AAP] City Enhancements: failed to load widget from CDN.');
    }
  };
  document.head.appendChild(s);

})();
