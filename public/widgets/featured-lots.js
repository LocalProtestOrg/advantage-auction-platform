/**
 * Advantage Auction Platform - Featured Lots Widget
 * Version 1.0
 *
 * Embed on any BD or partner page:
 *
 *   <!-- Configure platform variables before widget loads -->
 *   <script>
 *     AAPConfig.set({
 *       'marketplace.cta.url': 'https://auctions.advantage.bid/seller-create.html',
 *     });
 *   </script>
 *
 *   <div id="aap-featured-lots"
 *        data-api-base="https://auctions.advantage.bid"
 *        data-limit="6"
 *        data-theme="light">
 *   </div>
 *   <script src="https://auctions.advantage.bid/widgets/featured-lots.js"></script>
 *
 * Recommended full load order (shared platform layer + components):
 *   <script src=".../widgets/shared/utils.js"></script>
 *   <script src=".../widgets/shared/config.js"></script>
 *   <script src=".../widgets/shared/components/badge.js"></script>
 *   <script src=".../widgets/shared/components/skeleton-card.js"></script>
 *   <script src=".../widgets/shared/components/auction-card.js"></script>
 *   <script src=".../widgets/shared/components/seller-cta.js"></script>
 *   <script src=".../widgets/shared/components/empty-state.js"></script>
 *   <script src=".../widgets/shared/components/error-state.js"></script>
 *   <script src=".../widgets/featured-lots.js"></script>
 *
 * All business-facing variables (badge labels, CTA copy, display limits, shipping
 * messaging) are read from AAPConfig. Per-embed overrides via data-* attributes
 * take precedence over AAPConfig values.
 *
 * Data attributes:
 *   data-api-base           - API host (default: same origin)
 *   data-limit              - cards to show, 1-12 (default: config widget.limit)
 *   data-auction-state      - filter by auction state: 'published'|'active'|'closed'
 *   data-theme              - "light" (default) or "dark"
 *   data-seller-cta-url     - seller CTA link; overrides config marketplace.cta.url
 *   data-seller-cta-headline
 *   data-seller-cta-label
 *
 * API endpoint:
 *   GET /api/public/featured-lots
 *
 * Analytics events (bubble from container element):
 *   aap:widget:loaded   - { widgetId, resultCount, source: 'featured-lots' }
 *   aap:lot:click       - { lotId, lotTitle, auctionId, auctionTitle }
 *   aap:cta:click       - { widgetId }
 *
 * No auth tokens used. Only /api/public/* endpoints called.
 */

(function () {
  'use strict';

  var WIDGET_ID = 'aap-featured-lots';
  var STYLE_ID  = 'aapfl-styles';
  var P         = 'aapfl';   // widget CSS prefix - grid layout only; card content uses aapc-*

  // ── Inline fallback utilities ─────────────────────────────────────────────────
  // Used when shared/utils.js is not loaded.
  var U = window.AAPWidgetUtils || {
    esc: function (s) {
      if (s == null) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
    clamp: function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); },
    parseIntSafe: function (s, fb) { var n = parseInt(s, 10); return isNaN(n) ? fb : n; },
    injectStyle: function (id, css) {
      if (document.getElementById(id)) return;
      var el = document.createElement('style'); el.id = id; el.textContent = css;
      document.head.appendChild(el);
    },
    dispatch: function (el, name, detail) {
      try { el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail || {} })); } catch (e) {}
    },
  };

  // ── Inline component fallbacks ────────────────────────────────────────────────
  // Used when shared/components/*.js are not loaded. Mirrors the AAPComponents API.
  var C = window.AAPComponents || {};

  function fallbackBadge(o) {
    var span = document.createElement('span');
    span.className = 'aapc-badge aapc-badge-' + (o.variant || 'custom');
    span.textContent = o.text || '';
    return span;
  }

  function fallbackSkeletonCard(o) {
    var h = (o && o.imageHeight) || 168;
    var card = document.createElement('div');
    card.setAttribute('aria-hidden', 'true');
    card.style.cssText = 'border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#fff;';
    card.innerHTML =
      '<div style="width:100%;height:' + h + 'px;background:#e2e8f0;animation:aapc-pulse 1.4s ease-in-out infinite"></div>' +
      '<div style="padding:12px 14px">' +
        '<div style="height:11px;width:85%;background:#e2e8f0;border-radius:4px;margin-bottom:9px"></div>' +
        '<div style="height:11px;width:60%;background:#e2e8f0;border-radius:4px;margin-bottom:9px"></div>' +
        '<div style="height:11px;width:72%;background:#e2e8f0;border-radius:4px"></div>' +
      '</div>';
    return card;
  }

  var Badge        = C.Badge        || fallbackBadge;
  var SkeletonCard = C.SkeletonCard || fallbackSkeletonCard;
  var AuctionCard  = C.AuctionCard  || null;
  var SellerCta    = C.SellerCta    || null;
  var EmptyState   = C.EmptyState   || null;
  var ErrorState   = C.ErrorState   || null;

  // ── Widget-level CSS (grid layout only) ───────────────────────────────────────
  var GRID_CSS = [
    '.' + P + '-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    '@media(max-width:480px){.' + P + '-grid{grid-template-columns:1fr;}}',
    // Ensure pulse animation is present even without skeleton component
    '@keyframes aapc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
  ].join('');

  // ── Config resolution ─────────────────────────────────────────────────────────
  // Priority: data-* attribute → AAPConfig → hardcoded platform default
  function cfg(key, dataVal, hardDefault) {
    if (dataVal != null && dataVal !== '') return dataVal;
    var ac = window.AAPConfig;
    if (ac && typeof ac.get === 'function') {
      var v = ac.get(key);
      if (v != null) return v;
    }
    return hardDefault;
  }

  // ── Lot → card options mapper ──────────────────────────────────────────────────
  function lotToCardOpts(lot, container) {
    var ac = window.AAPConfig;

    var endingSoonMs  = (ac ? ac.get('marketplace.badge.ending_soon_threshold_min', 120) : 120) * 60000;
    var closesAt      = lot.closes_at ? new Date(lot.closes_at).getTime() : null;
    var isEndingSoon  = closesAt != null && closesAt > Date.now() && (closesAt - Date.now()) < endingSoonMs;

    var badges = [];
    if (lot.auction_state === 'active') {
      badges.push({ text: cfg('marketplace.badge.live', null, 'LIVE NOW'), variant: 'live' });
    } else {
      badges.push({ text: cfg('marketplace.badge.upcoming', null, 'UPCOMING'), variant: 'upcoming' });
    }
    if (isEndingSoon) {
      badges.push({ text: cfg('marketplace.badge.ending_soon', null, 'Ending Soon'), variant: 'ending-soon' });
    }
    if (lot.shippable && cfg('marketplace.shipping.show_badge', null, true)) {
      badges.push({ text: cfg('marketplace.badge.ships', null, 'Ships nationwide'), variant: 'ships' });
    }

    return {
      image_url:          lot.thumbnail_url,
      title:              lot.title,
      state:              lot.auction_state,
      badges:             badges,
      city:               lot.auction_city,
      address_state:      lot.auction_address_state,
      end_time:           lot.closes_at || lot.auction_end_time,
      current_bid_cents:  lot.current_bid_cents,
      starting_bid_cents: lot.starting_bid_cents,
      bid_count:          lot.bid_count,
      context_label:      lot.auction_title ? 'from ' + lot.auction_title : null,
      config:             window.AAPConfig || null,
      onClick:            function () {
        U.dispatch(container, 'aap:lot:click', {
          lotId:        lot.id,
          lotTitle:     lot.title,
          auctionId:    lot.auction_id,
          auctionTitle: lot.auction_title,
        });
      },
    };
  }

  // ── Inline card renderer (fallback when AuctionCard component not loaded) ──────
  function inlineFallbackCard(lot, container) {
    var U2 = window.AAPWidgetUtils || U;
    var e  = U.esc;
    var loc = [lot.auction_city, lot.auction_address_state].filter(Boolean).join(', ');

    var card = document.createElement('div');
    card.className = 'aapc-card';
    card.setAttribute('role', 'article');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', e(lot.title || 'Lot'));

    var thumb = lot.thumbnail_url
      ? '<img class="aapc-thumb" src="' + e(lot.thumbnail_url) + '" alt="" loading="lazy" style="height:168px" aria-hidden="true">'
      : '<div class="aapc-no-img" style="height:168px" aria-hidden="true">No Image</div>';

    var statusBadge = lot.auction_state === 'active'
      ? '<span class="aapc-badge aapc-badge-live">LIVE NOW</span>'
      : '<span class="aapc-badge aapc-badge-upcoming">UPCOMING</span>';
    var shipBadge = lot.shippable
      ? '<span class="aapc-badge aapc-badge-ships">Ships nationwide</span>'
      : '';

    var bidStr = '';
    if (lot.bid_count > 0 && lot.current_bid_cents) {
      bidStr = '<p class="aapc-bid">$' + (lot.current_bid_cents / 100).toFixed(2) + ' · ' + lot.bid_count + ' bids</p>';
    } else if (lot.starting_bid_cents) {
      bidStr = '<p class="aapc-bid">Starts at $' + (lot.starting_bid_cents / 100).toFixed(2) + '</p>';
    }

    card.innerHTML =
      thumb +
      '<div class="aapc-body">' +
        '<div class="aapc-badges">' + statusBadge + shipBadge + '</div>' +
        '<p class="aapc-title">' + e(lot.title || 'Untitled Lot') + '</p>' +
        (loc ? '<p class="aapc-meta">' + e(loc) + '</p>' : '') +
        bidStr +
        (lot.auction_title ? '<p class="aapc-context">from ' + e(lot.auction_title) + '</p>' : '') +
      '</div>';

    card.addEventListener('click', function () {
      U.dispatch(container, 'aap:lot:click', {
        lotId: lot.id, lotTitle: lot.title,
        auctionId: lot.auction_id, auctionTitle: lot.auction_title,
      });
    });

    return card;
  }

  // ── Inline CTA fallback ────────────────────────────────────────────────────────
  function inlineFallbackCta(ctaCfg, container) {
    var e    = U.esc;
    var card = document.createElement('div');
    card.className = 'aapc-cta';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', 'Seller information');
    card.innerHTML =
      '<p class="aapc-cta-head">' + e(ctaCfg.headline) + '</p>' +
      '<p class="aapc-cta-sub">We auction estates, collections, and commercial inventory nationwide.</p>' +
      '<a class="aapc-cta-btn" href="' + e(ctaCfg.url) + '" target="_blank" rel="noopener noreferrer">' +
        e(ctaCfg.label) +
      '</a>';
    card.querySelector('a').addEventListener('click', function () {
      U.dispatch(container, 'aap:cta:click', { widgetId: WIDGET_ID });
    });
    return card;
  }

  // ── Main ──────────────────────────────────────────────────────────────────────
  async function init() {
    var container = document.getElementById(WIDGET_ID);
    if (!container) return;

    var d      = container.dataset;
    var apiBase = (d.apiBase || '').replace(/\/$/, '');

    // Resolve all config values - data-* > AAPConfig > hardcoded default
    var limit      = U.clamp(U.parseIntSafe(d.limit, cfg('widget.limit', null, 6)), 1, 12);
    var aState     = d.auctionState || null;
    var dark       = d.theme === 'dark';
    var ctaUrl     = d.sellerCtaUrl     || cfg('marketplace.cta.url', null, null);
    var ctaHead    = d.sellerCtaHeadline || cfg('marketplace.cta.headline', null, 'Consigning an Estate?');
    var ctaLabel   = d.sellerCtaLabel   || cfg('marketplace.cta.label', null, 'Learn More');
    var imgH       = cfg('marketplace.card.image_height_px', null, 168);

    U.injectStyle(STYLE_ID, GRID_CSS);

    // ── Loading skeletons ────────────────────────────────────────────────────
    var loadGrid = document.createElement('div');
    loadGrid.className = P + '-grid aapc-root' + (dark ? ' aapc-dark' : '');
    loadGrid.setAttribute('aria-busy', 'true');
    loadGrid.setAttribute('aria-label', 'Loading featured lots');
    for (var i = 0; i < limit; i++) {
      loadGrid.appendChild(SkeletonCard({ imageHeight: imgH, lines: 4 }));
    }
    container.innerHTML = '';
    container.appendChild(loadGrid);

    // ── Fetch ────────────────────────────────────────────────────────────────
    var lots = [];
    try {
      var url = apiBase + '/api/public/featured-lots?limit=' + limit;
      if (aState) url += '&auction_state=' + encodeURIComponent(aState);
      var res  = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var body = await res.json();
      if (!body.success) throw new Error('API error');
      lots = Array.isArray(body.data) ? body.data : [];
    } catch (e) {
      container.innerHTML = '';
      if (ErrorState) {
        container.appendChild(ErrorState({ message: 'Unable to load featured lots. Please try again later.' }));
      } else {
        var ep = document.createElement('p');
        ep.className = 'aapc-error';
        ep.setAttribute('role', 'alert');
        ep.textContent = 'Unable to load featured lots. Please try again later.';
        container.appendChild(ep);
      }
      return;
    }

    // ── Render ───────────────────────────────────────────────────────────────
    container.innerHTML = '';

    if (!lots.length) {
      if (EmptyState) {
        container.appendChild(EmptyState({ message: 'No featured lots currently available. Check back soon!' }));
      } else {
        var ep2 = document.createElement('p');
        ep2.className = 'aapc-empty';
        ep2.setAttribute('role', 'status');
        ep2.textContent = 'No featured lots currently available. Check back soon!';
        container.appendChild(ep2);
      }
      U.dispatch(container, 'aap:widget:loaded', { widgetId: WIDGET_ID, resultCount: 0, source: 'featured-lots' });
      return;
    }

    var grid = document.createElement('div');
    grid.className = P + '-grid aapc-root' + (dark ? ' aapc-dark' : '');
    grid.setAttribute('aria-label', 'Featured lots');

    lots.forEach(function (lot) {
      var cardEl;
      if (AuctionCard) {
        cardEl = AuctionCard(lotToCardOpts(lot, container));
      } else {
        cardEl = inlineFallbackCard(lot, container);
      }
      grid.appendChild(cardEl);
    });

    if (ctaUrl) {
      if (SellerCta) {
        grid.appendChild(SellerCta({
          url:        ctaUrl,
          headline:   ctaHead,
          label:      ctaLabel,
          config:     window.AAPConfig || null,
          onCtaClick: function () { U.dispatch(container, 'aap:cta:click', { widgetId: WIDGET_ID }); },
        }));
      } else {
        grid.appendChild(inlineFallbackCta({ url: ctaUrl, headline: ctaHead, label: ctaLabel }, container));
      }
    }

    container.appendChild(grid);

    U.dispatch(container, 'aap:widget:loaded', {
      widgetId:    WIDGET_ID,
      resultCount: lots.length,
      source:      'featured-lots',
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
