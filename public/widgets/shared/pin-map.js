/**
 * Advantage Pin Map — reusable single-marker map (platform component).
 *
 * Shared map embed for public pages: Marketplace Events use it to show the (privacy-offset) sale
 * location; Auctions can adopt the same component. Self-loads MapLibre GL from the CDN once, uses
 * the CARTO Positron basemap, and drops one Advantage-red pin. Fails silently (hides the container)
 * if the map library or tiles are unavailable — a missing map never breaks the page.
 *
 * Usage:  AdvantagePinMap.mount(el, { lat, lng, zoom?, label? })  -> { destroy }
 */
(function () {
  'use strict';

  var MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
  var MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
  var STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  var PIN = '<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M15 0C6.7 0 0 6.7 0 15c0 10 15 25 15 25s15-15 15-25C30 6.7 23.3 0 15 0z" fill="#B5273B"/>'
    + '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>';

  var loadingPromise = null;
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (loadingPromise) return loadingPromise;
    loadingPromise = new Promise(function (resolve, reject) {
      if (!document.querySelector('link[data-maplibre]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS; link.setAttribute('data-maplibre', '1');
        document.head.appendChild(link);
      }
      var s = document.createElement('script');
      s.src = MAPLIBRE_JS; s.async = true;
      s.onload = function () { window.maplibregl ? resolve(window.maplibregl) : reject(new Error('maplibre missing')); };
      s.onerror = function () { reject(new Error('maplibre load failed')); };
      document.head.appendChild(s);
    });
    return loadingPromise;
  }

  function num(v) { return v == null || v === '' ? NaN : Number(v); }

  function mount(elOrSel, cfg) {
    var root = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
    if (!root) return { destroy: function () {} };
    cfg = cfg || {};
    var lat = num(cfg.lat), lng = num(cfg.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { root.style.display = 'none'; return { destroy: function () {} }; }

    var map = null, destroyed = false;
    root.style.minHeight = root.style.minHeight || '260px';

    loadMapLibre().then(function (maplibregl) {
      if (destroyed) return;
      map = new maplibregl.Map({
        container: root,
        style: STYLE_URL,
        center: [lng, lat],
        zoom: cfg.zoom || 13,
        attributionControl: { compact: true },
        dragRotate: false,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      var el = document.createElement('div');
      el.style.cssText = 'width:30px;height:40px';
      el.innerHTML = PIN;
      if (cfg.label) el.title = cfg.label;
      new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(map);
    }).catch(function () { if (!destroyed) root.style.display = 'none'; });

    return { destroy: function () { destroyed = true; if (map) { try { map.remove(); } catch (e) {} } } };
  }

  window.AdvantagePinMap = { mount: mount };
})();
