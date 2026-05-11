/**
 * Advantage Auction Platform — Shared Widget Configuration
 * window.AAPConfig
 *
 * Centralised configuration-consumption layer for all marketplace widgets.
 * Widgets read from this object instead of hardcoding business variables.
 * Safe, typed defaults for every key. Supports four configuration sources
 * in priority order (highest wins):
 *
 *   1. AAPConfig.set() calls in the host page script (explicit local overrides)
 *   2. Remote config fetched via AAPConfig.loadRemote() (admin-editable via API)
 *   3. <script id="aap-config" type="application/json"> inline block
 *   4. Built-in platform defaults in DEFAULTS below
 *
 * Explicit local overrides (source 1) are tracked separately and always win
 * over remote values — calling loadRemote() never clobbers values the host
 * page has intentionally set.
 *
 * Remote config is cached in localStorage (default 5 min TTL) so repeat page
 * loads do not incur a network round-trip on every widget init. Widgets remain
 * fully functional if the remote endpoint is unavailable — they fall back to
 * inline config and platform defaults.
 *
 * Load before any widget or component:
 *   <script src="https://auctions.advantage.bid/widgets/shared/config.js"></script>
 *
 * Typical usage:
 *   <script>
 *     AAPConfig.set({ 'marketplace.cta.url': 'https://...', 'widget.limit': 8 });
 *   </script>
 *   <script>
 *     AAPConfig.loadRemote('/api/public/config').then(function() {
 *       // widget initialisation continues after config is merged
 *     });
 *   </script>
 */

window.AAPConfig = (function () {
  'use strict';

  // Already loaded — return existing instance unchanged
  if (window.AAPConfig && window.AAPConfig._v) return window.AAPConfig;

  // ── Platform defaults ──────────────────────────────────────────────────────
  // Every marketplace-facing variable that a widget consumes must have a safe
  // default here. This is the single source of truth for what "configurable"
  // means on this platform.
  var DEFAULTS = {

    // ── Widget display behaviour ─────────────────────────────────────────────
    'widget.limit':           6,
    'widget.radius_km':       200,
    'widget.geo_timeout_ms':  5000,

    // ── Status / type badge labels ───────────────────────────────────────────
    'marketplace.badge.live':                        'LIVE NOW',
    'marketplace.badge.upcoming':                    'UPCOMING',
    'marketplace.badge.ships':                       'Ships nationwide',
    'marketplace.badge.ending_soon':                 'Ending Soon',
    'marketplace.badge.ending_soon_threshold_min':   120,

    // ── Seller CTA card ───────────────────────────────────────────────────────
    'marketplace.cta.url':      null,
    'marketplace.cta.headline': 'Consigning an Estate?',
    'marketplace.cta.subtext':  'We auction estates, collections, and commercial inventory nationwide.',
    'marketplace.cta.label':    'Learn More',

    // ── Card display controls ─────────────────────────────────────────────────
    'marketplace.card.image_height_px':  168,
    'marketplace.card.show_seller':      true,
    'marketplace.card.show_lot_count':   true,
    'marketplace.card.show_distance':    true,
    'marketplace.card.show_bid':         true,

    // ── Shipping messaging ────────────────────────────────────────────────────
    'marketplace.shipping.show_badge':   true,

    // ── Homepage feed controls ────────────────────────────────────────────────
    'marketplace.homepage.featured_limit':  6,
    'marketplace.homepage.near_you_limit':  6,

    // ── Analytics ─────────────────────────────────────────────────────────────
    'analytics.enabled':   true,
    'analytics.namespace': 'aap',

  };

  // ── Safe namespace prefixes for remote merge ───────────────────────────────
  // Only keys with these prefixes are accepted from remote config.
  // This prevents a compromised or misconfigured remote endpoint from injecting
  // arbitrary keys into the config store.
  var SAFE_PREFIXES = ['marketplace.', 'widget.', 'analytics.'];

  function _isSafeKey(key) {
    for (var i = 0; i < SAFE_PREFIXES.length; i++) {
      if (key.indexOf(SAFE_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  // ── Internal stores ────────────────────────────────────────────────────────
  var _store          = {};  // working store: defaults + inline + remote
  var _localOverrides = {};  // values set explicitly via set() — always win over remote

  Object.keys(DEFAULTS).forEach(function (k) { _store[k] = DEFAULTS[k]; });

  // ── Remote config cache (localStorage) ────────────────────────────────────
  var CACHE_KEY    = 'aap_cfg_remote';
  var CACHE_TS_KEY = 'aap_cfg_remote_ts';

  function _cacheLoad(ttlSeconds) {
    try {
      var ts  = parseInt(localStorage.getItem(CACHE_TS_KEY) || '0', 10);
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw || !ts) return null;
      if (Date.now() - ts > ttlSeconds * 1000) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function _cacheSave(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) { /* storage disabled or quota exceeded — silently skip */ }
  }

  function _cacheInvalidate() {
    try {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_TS_KEY);
    } catch (e) { /* ignore */ }
  }

  // ── Remote merge ──────────────────────────────────────────────────────────
  // Merges remote data into _store. Skips:
  //   - keys not in SAFE_PREFIXES (namespace guard)
  //   - keys in _localOverrides (local override preservation)
  function _mergeRemote(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    Object.keys(data).forEach(function (k) {
      if (!_isSafeKey(k)) return;
      if (Object.prototype.hasOwnProperty.call(_localOverrides, k)) return;
      _store[k] = data[k];
    });
  }

  // ── Read from inline <script id="aap-config" type="application/json"> ─────
  function _readInlineBlock() {
    try {
      var el = document.getElementById('aap-config');
      if (!el || el.getAttribute('type') !== 'application/json') return;
      var parsed = JSON.parse(el.textContent || el.innerHTML || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.keys(parsed).forEach(function (k) { _store[k] = parsed[k]; });
      }
    } catch (e) { /* invalid JSON or no inline block — silently ignore */ }
  }

  _readInlineBlock();

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    _v: 2,
    DEFAULTS: DEFAULTS,

    // Get a config value. Local overrides checked first, then the working store.
    // Returns fallback if key not found; null if no fallback provided.
    get: function (key, fallback) {
      if (Object.prototype.hasOwnProperty.call(_localOverrides, key)) return _localOverrides[key];
      if (Object.prototype.hasOwnProperty.call(_store, key)) return _store[key];
      return fallback !== undefined ? fallback : null;
    },

    // Set one key or a flat object of keys.
    // Values set here are tracked as local overrides and survive loadRemote().
    // Chainable.
    set: function (keyOrObj, value) {
      if (typeof keyOrObj === 'string') {
        _localOverrides[keyOrObj] = value;
        _store[keyOrObj]          = value;
      } else if (keyOrObj && typeof keyOrObj === 'object' && !Array.isArray(keyOrObj)) {
        Object.keys(keyOrObj).forEach(function (k) {
          _localOverrides[k] = keyOrObj[k];
          _store[k]          = keyOrObj[k];
        });
      }
      return this;
    },

    // Re-read the inline config block (call if config.js ran before the DOM element)
    readInlineBlock: _readInlineBlock,

    // Reset store and local overrides to platform defaults.
    // Also invalidates the localStorage remote cache.
    reset: function () {
      _store          = {};
      _localOverrides = {};
      Object.keys(DEFAULTS).forEach(function (k) { _store[k] = DEFAULTS[k]; });
      _cacheInvalidate();
      return this;
    },

    // Load admin-editable config from a remote endpoint and merge it.
    //
    // Options:
    //   cacheTtlSeconds {number}  — cache TTL in seconds (default: 300)
    //   bypassCache     {boolean} — if true, skip cache and always fetch
    //
    // Behaviour:
    //   1. If a fresh cache entry exists (within TTL), merge it immediately.
    //   2. Otherwise fetch from url, cache the response, then merge.
    //   3. On any error (network, non-200, parse failure): return self unchanged.
    //   4. Local overrides (from set()) are NEVER clobbered by remote values.
    //   5. Only keys with safe prefixes (marketplace.*, widget.*, analytics.*)
    //      are merged — all others are silently dropped.
    //
    // Returns a Promise that resolves to self when done (always resolves; never rejects).
    loadRemote: function (url, opts) {
      var self = this;
      var ttl         = (opts && opts.cacheTtlSeconds != null) ? opts.cacheTtlSeconds : 300;
      var bypassCache = (opts && opts.bypassCache) ? true : false;

      if (!bypassCache) {
        var cached = _cacheLoad(ttl);
        if (cached) {
          _mergeRemote(cached);
          return Promise.resolve(self);
        }
      }

      if (!url) return Promise.resolve(self);

      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (body) {
          // Endpoint may return { success: true, data: {...} } or a flat object
          var data = (body && body.success && body.data) ? body.data : body;
          _cacheSave(data);
          _mergeRemote(data);
          return self;
        })
        .catch(function () {
          // Remote config load failed — continue with current store unchanged
          return self;
        });
    },

    // Invalidate the localStorage remote config cache.
    // Useful after an admin updates config so the next loadRemote() fetches fresh.
    invalidateCache: function () {
      _cacheInvalidate();
      return this;
    },

    // Returns a snapshot of all current config values (for debugging)
    dump: function () {
      var out = {};
      Object.keys(_store).forEach(function (k) { out[k] = _store[k]; });
      return out;
    },

    // Returns a snapshot of values explicitly set via set() (for debugging)
    dumpOverrides: function () {
      var out = {};
      Object.keys(_localOverrides).forEach(function (k) { out[k] = _localOverrides[k]; });
      return out;
    },
  };

})();
