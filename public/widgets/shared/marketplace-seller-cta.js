/**
 * AAPMarketplaceSellerCta  v1
 *
 * Lightweight, config-driven seller acquisition strip for Advantage.Bid
 * marketplace-owned auction experiences.
 *
 * PURPOSE
 *   Converts buyers browsing marketplace auctions into future sellers by
 *   surfacing a subtle, professional nudge at the natural exit point of
 *   the auction detail page - after the lot grid, before leaving the page.
 *
 * SCOPE - MARKETPLACE ONLY
 *   This module must NEVER be loaded in white-label or partner-branded
 *   auction environments. The `is_marketplace` option (default true) must
 *   be set to false on any non-Advantage.Bid surface.
 *
 * USAGE
 *   var mount = document.getElementById('marketplace-seller-cta-mount');
 *   AAPMarketplaceSellerCta.init(mount, {
 *     context: { auction_id: 'uuid', city: 'Dallas', state_code: 'TX' }
 *   });
 *
 * OPTIONS
 *   context.auction_id  {string}  - UUID for telemetry enrichment
 *   context.city        {string}  - city for telemetry enrichment
 *   context.state_code  {string}  - state for telemetry enrichment
 *   headline   {string}  - overrides default/config headline
 *   subtext    {string}  - overrides default/config subtext
 *   label      {string}  - overrides default/config button label
 *   url        {string}  - overrides default/config destination URL
 *   enabled    {boolean} - hard override (default: read from AAPConfig, else true)
 *   is_marketplace {boolean} - must be true for CTA to render (default true)
 *   variant    {string}  - A/B test variant identifier (passed through to telemetry)
 *
 * TELEMETRY
 *   seller_cta_impression - fires once when the strip scrolls into view (≥25% visible)
 *   seller_cta_click      - fires when the "Start Selling" button is clicked
 *   Both events carry: cta_variant, destination, auction_id, city, state_code
 *
 * CONFIG KEYS (via AAPConfig)
 *   marketplace.seller_cta.enabled   - boolean, default true
 *   marketplace.seller_cta.headline  - string
 *   marketplace.seller_cta.subtext   - string
 *   marketplace.seller_cta.label     - string
 *   marketplace.seller_cta.url       - string
 *   marketplace.is_marketplace       - boolean, default true
 *
 * FUTURE HOOKS
 *   - Set variant: opts.variant = 'treatment_a' for A/B experiments
 *   - Disable: AAPConfig.set('marketplace.seller_cta.enabled', false)
 *   - Attribution is appended as query params to the destination URL
 *
 * Load order: include after shared/config.js and shared/analytics.js
 */

window.AAPMarketplaceSellerCta = (function () {
  'use strict';

  if (window.AAPMarketplaceSellerCta && window.AAPMarketplaceSellerCta._v) {
    return window.AAPMarketplaceSellerCta;
  }

  var STYLE_ID        = 'aap-msc-styles';
  var DEFAULT_URL     = 'https://www.advantage.bid/start-selling';
  var DEFAULT_HEAD    = 'Ready to Sell?';
  var DEFAULT_SUB     = 'Turn your collection into cash with Advantage.Bid.';
  var DEFAULT_LABEL   = 'Start Selling';
  var DEFAULT_VARIANT = 'default';

  // ── CSS - injected once, scoped to .msc-* ─────────────────────────────────
  var CSS = [
    '.msc-section{',
      'border-top:1px solid #e4e4e7;',
      'background:#fff;',
      'padding:1.25rem 1.5rem;',
    '}',
    '.msc-inner{',
      'max-width:1200px;',
      'margin:0 auto;',
      'display:flex;',
      'align-items:center;',
      'justify-content:space-between;',
      'gap:1.25rem;',
      'flex-wrap:wrap;',
    '}',
    '.msc-text{',
      'display:flex;',
      'flex-direction:column;',
      'gap:0.15rem;',
      'min-width:0;',
    '}',
    '.msc-headline{',
      'font-size:0.95rem;',
      'font-weight:700;',
      'color:#111;',
      'margin:0;',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '.msc-subtext{',
      'font-size:0.83rem;',
      'color:#52525b;',
      'margin:0;',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '.msc-line{',
      'font-size:0.8rem;',
      'color:#71717a;',
      'margin:0.15rem 0 0;',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '.msc-emph{',
      'font-size:0.82rem;',
      'font-weight:700;',
      'color:#047857;',
      'margin:0.2rem 0 0;',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '.msc-btn{',
      'display:inline-flex;',
      'align-items:center;',
      'gap:0.3rem;',
      'padding:0.55rem 1.2rem;',
      'background:#2563eb;',
      'color:#fff;',
      'border-radius:6px;',
      'font-size:0.875rem;',
      'font-weight:600;',
      'text-decoration:none;',
      'white-space:nowrap;',
      'flex-shrink:0;',
      'transition:background .15s;',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '.msc-btn:hover{background:#1d4ed8;}',
    '.msc-btn:focus-visible{outline:2px solid #93c5fd;outline-offset:2px;}',
    '.msc-arrow{font-size:0.75rem;opacity:0.85;}',
    '@media(max-width:600px){',
      '.msc-inner{flex-direction:column;align-items:flex-start;}',
    '}',
  ].join('');

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id          = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cfgGet(cfg, key, fallback) {
    if (cfg && typeof cfg.get === 'function') return cfg.get(key, fallback);
    return fallback;
  }

  // Appends ?source=marketplace_cta&auction_id=<id> for landing page attribution.
  function buildUrl(base, auctionId) {
    try {
      var url   = new URL(base);
      url.searchParams.set('source', 'marketplace_cta');
      if (auctionId) url.searchParams.set('auction_id', auctionId);
      return url.toString();
    } catch (_) {
      return base; // fallback: URL constructor not available (very old browser)
    }
  }

  function trackEvent(eventType, variant, url, context) {
    try {
      if (!window.AAPAnalytics || typeof window.AAPAnalytics.track !== 'function') return;
      window.AAPAnalytics.track(
        eventType,
        { cta_variant: variant || DEFAULT_VARIANT, destination: url },
        {
          widget_name: 'marketplace-seller-cta',
          auction_id:  context.auction_id  || null,
          seller_id:   context.seller_id   || null,
          city:        context.city        || null,
          state_code:  context.state_code  || null,
        }
      );
    } catch (_) { /* swallow - telemetry must not affect UX */ }
  }

  // ── init ──────────────────────────────────────────────────────────────────
  /**
   * Render the seller acquisition strip inside `container`.
   *
   * @param {HTMLElement} container   - mount point element
   * @param {object}      opts        - see module header for option reference
   * @returns {HTMLElement|null}      - the rendered section, or null if skipped
   */
  function init(container, opts) {
    if (!container || !(container instanceof Element)) return null;

    var o   = opts   || {};
    var ctx = o.context || {};
    var cfg = window.AAPConfig || null;

    // ── Guard: enabled ────────────────────────────────────────────────────
    var enabled = o.enabled != null
      ? Boolean(o.enabled)
      : cfgGet(cfg, 'marketplace.seller_cta.enabled', true);
    if (!enabled) return null;

    // ── Guard: marketplace context ────────────────────────────────────────
    var isMarketplace = o.is_marketplace != null
      ? Boolean(o.is_marketplace)
      : cfgGet(cfg, 'marketplace.is_marketplace', true);
    if (!isMarketplace) return null;

    // ── Resolve copy and URL ──────────────────────────────────────────────
    var headline = o.headline || cfgGet(cfg, 'marketplace.seller_cta.headline', DEFAULT_HEAD);
    var subtext  = o.subtext  || cfgGet(cfg, 'marketplace.seller_cta.subtext',  DEFAULT_SUB);
    var label    = o.label    || cfgGet(cfg, 'marketplace.seller_cta.label',     DEFAULT_LABEL);
    var baseUrl  = o.url      || cfgGet(cfg, 'marketplace.seller_cta.url',       DEFAULT_URL);
    var variant  = o.variant  || cfgGet(cfg, 'marketplace.seller_cta.variant',   DEFAULT_VARIANT);

    // Attribution URL enrichment
    var finalUrl = buildUrl(baseUrl, ctx.auction_id);

    injectStyles();

    // ── Build DOM ─────────────────────────────────────────────────────────
    var section = document.createElement('div');
    section.className = 'msc-section';
    section.setAttribute('data-aap-cta', 'marketplace-seller');
    section.setAttribute('data-cta-variant', variant);
    section.setAttribute('role', 'complementary');
    section.setAttribute('aria-label', 'Selling opportunity');

    var inner = document.createElement('div');
    inner.className = 'msc-inner';

    var textGroup = document.createElement('div');
    textGroup.className = 'msc-text';
    textGroup.innerHTML =
      '<p class="msc-headline">' + esc(headline) + '</p>' +
      '<p class="msc-subtext">'  + esc(subtext)  + '</p>' +
      '<p class="msc-line">Most sellers complete their auction catalog in a single afternoon.</p>' +
      '<p class="msc-emph">Zero Seller Fees from Advantage.</p>';

    var btn = document.createElement('a');
    btn.className = 'msc-btn';
    btn.href      = finalUrl;
    btn.target    = '_blank';
    btn.rel       = 'noopener noreferrer';
    btn.innerHTML = esc(label) + ' <span class="msc-arrow" aria-hidden="true">→</span>';

    btn.addEventListener('click', function () {
      trackEvent('seller_cta_click', variant, finalUrl, ctx);
    });

    inner.appendChild(textGroup);
    inner.appendChild(btn);
    section.appendChild(inner);
    container.appendChild(section);

    // ── Impression tracking (fires once at ≥25% visibility) ──────────────
    if (typeof IntersectionObserver !== 'undefined') {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          observer.disconnect();
          trackEvent('seller_cta_impression', variant, finalUrl, ctx);
        }
      }, { threshold: 0.25 });
      observer.observe(section);
    }

    return section;
  }

  return {
    init: init,
    _v:   1,
  };

})();
