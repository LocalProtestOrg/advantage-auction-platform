/**
 * AAPComponents.AuctionCard - unified auction/lot card element
 *
 * Single component for both auction-level and lot-level cards. The caller maps
 * its API data to the options object; conditional sections render based on which
 * options are non-null. This eliminates duplicated card rendering logic across
 * widget implementations.
 *
 * Usage (auction card):
 *   var el = AAPComponents.AuctionCard({
 *     image_url:           auction.cover_image_url,
 *     title:               auction.title,
 *     state:               auction.state,        // controls status badge
 *     city:                auction.city,
 *     address_state:       auction.address_state,
 *     distance_km:         auction.distance_km,  // null hides distance
 *     end_time:            auction.end_time,
 *     lot_count:           auction.lot_count,
 *     shippable_lot_count: auction.shippable_lot_count,
 *     seller_display_name: auction.seller_display_name,
 *     config:              window.AAPConfig,
 *     onClick:             function(e) { ... },
 *   });
 *
 * Usage (lot card):
 *   var el = AAPComponents.AuctionCard({
 *     image_url:            lot.thumbnail_url,
 *     title:                lot.title,
 *     state:                lot.auction_state,
 *     badges:               [...],               // pre-built badge specs
 *     city:                 lot.auction_city,
 *     address_state:        lot.auction_address_state,
 *     end_time:             lot.closes_at || lot.auction_end_time,
 *     current_bid_cents:    lot.current_bid_cents,
 *     starting_bid_cents:   lot.starting_bid_cents,
 *     bid_count:            lot.bid_count,
 *     context_label:        'from ' + lot.auction_title,
 *     config:               window.AAPConfig,
 *     onClick:              function(e) { ... },
 *   });
 *
 * Options:
 *   image_url            {string|null}   - thumbnail/cover image URL
 *   title                {string}        - card headline
 *   state                {string}        - 'active'|'published' (controls status badge when badges not set)
 *   badges               {Array}         - [{text,variant}] overrides auto badge generation
 *   city                 {string|null}
 *   address_state        {string|null}
 *   distance_km          {number|null}   - null hides distance row
 *   end_time             {string|null}   - ISO datetime for relative time label
 *   lot_count            {number|null}   - null hides lot count row
 *   shippable_lot_count  {number|null}
 *   current_bid_cents    {number|null}   - null hides bid row
 *   starting_bid_cents   {number|null}   - shown when current_bid_cents is null/0
 *   bid_count            {number|null}
 *   context_label        {string|null}   - "from [Auction Title]" line
 *   seller_display_name  {string|null}   - null hides seller line
 *   imageHeight          {number}        - override image area height in px
 *   config               {object|null}   - AAPConfig instance
 *   onClick              {function|null} - click handler (receives the card element)
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.AuctionCard) return;

  if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();

  function injectCardStyles() {
    if (document.getElementById('aapc-card-styles')) return;
    var css = [
      // Card shell
      '.aapc-card{border:1px solid var(--aapc-bdr,#e2e8f0);border-radius:10px;overflow:hidden;',
        'background:var(--aapc-bg,#ffffff);transition:box-shadow .15s;cursor:pointer;',
        'display:flex;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.aapc-card:hover{box-shadow:0 4px 20px rgba(0,0,0,.12);}',
      '.aapc-card:focus-visible{outline:2px solid var(--aapc-up,#3b82f6);outline-offset:2px;}',
      // Image
      '.aapc-thumb{width:100%;object-fit:cover;display:block;flex-shrink:0;}',
      '.aapc-no-img{width:100%;display:flex;align-items:center;justify-content:center;',
        'background:var(--aapc-bg2,#f8fafc);color:var(--aapc-sub,#64748b);font-size:13px;flex-shrink:0;}',
      // Body
      '.aapc-body{padding:12px 14px 14px;display:flex;flex-direction:column;flex:1;}',
      // Badges row
      '.aapc-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px;}',
      // Typography
      '.aapc-title{font-size:15px;font-weight:600;color:var(--aapc-fg,#1e293b);',
        'margin:0 0 5px;line-height:1.35;}',
      '.aapc-meta{font-size:13px;color:var(--aapc-sub,#64748b);margin:0 0 3px;line-height:1.4;}',
      '.aapc-dist{font-size:12px;font-weight:600;color:var(--aapc-dist,#0284c7);margin:4px 0 0;}',
      '.aapc-lots{font-size:12px;color:var(--aapc-sub,#64748b);margin:5px 0 0;}',
      '.aapc-bid{font-size:13px;font-weight:600;color:var(--aapc-fg,#1e293b);margin:5px 0 0;}',
      '.aapc-context{font-size:12px;color:var(--aapc-sub,#64748b);margin:4px 0 0;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.aapc-seller{font-size:12px;color:var(--aapc-sub,#64748b);margin:4px 0 0;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-card-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function fmtRelativeTime(iso) {
    if (!iso) return '';
    try {
      var diffMs = new Date(iso).getTime() - Date.now();
      if (diffMs <= 0) return 'Ended';
      var h = Math.floor(diffMs / 3600000);
      if (h < 1) return 'Ends in ' + Math.floor(diffMs / 60000) + 'm';
      if (h < 24) return 'Ends in ' + h + 'h';
      return 'Ends in ' + Math.floor(h / 24) + 'd';
    } catch (e) { return ''; }
  }

  function fmtDistance(km) {
    if (km == null) return null;
    var r = Math.round(km * 0.621371); // km → miles (U.S. users see miles)
    return (r === 0 ? '< 1' : r) + ' mi away';
  }

  function fmtCents(cents) {
    if (cents == null) return null;
    var dollars = (cents / 100).toFixed(2);
    return '$' + dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function cfgGet(config, key, fallback) {
    return config && typeof config.get === 'function' ? config.get(key, fallback) : fallback;
  }

  // ── Badge resolution ─────────────────────────────────────────────────────────

  function resolveBadges(opts) {
    // Caller-supplied badge specs take full precedence
    if (opts.badges && Array.isArray(opts.badges)) return opts.badges;

    var cfg  = opts.config || null;
    var list = [];

    // Status badge
    if (opts.state === 'active') {
      list.push({ text: cfgGet(cfg, 'marketplace.badge.live', 'LIVE NOW'), variant: 'live' });
    } else {
      list.push({ text: cfgGet(cfg, 'marketplace.badge.upcoming', 'UPCOMING'), variant: 'upcoming' });
    }

    // Shipping badge (for auction cards with shippable_lot_count)
    var showShip = cfgGet(cfg, 'marketplace.shipping.show_badge', true);
    if (showShip && opts.shippable_lot_count > 0) {
      list.push({ text: cfgGet(cfg, 'marketplace.badge.ships', 'Ships nationwide'), variant: 'ships' });
    }

    return list;
  }

  // ── Component factory ────────────────────────────────────────────────────────

  window.AAPComponents.AuctionCard = function (opts) {
    if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();
    injectCardStyles();

    // Ensure Badge component is available; inline fallback if not
    var Badge = window.AAPComponents && window.AAPComponents.Badge
      ? window.AAPComponents.Badge
      : function (b) {
          var s = document.createElement('span');
          s.className = 'aapc-badge aapc-badge-' + (b.variant || 'custom');
          s.textContent = b.text || '';
          return s;
        };

    var o          = opts || {};
    var cfg        = o.config || null;
    var imgHeight  = o.imageHeight || cfgGet(cfg, 'marketplace.card.image_height_px', 168);

    // Image area
    var imageEl;
    if (o.image_url) {
      imageEl = document.createElement('img');
      imageEl.className = 'aapc-thumb';
      imageEl.src       = esc(o.image_url);
      imageEl.alt       = '';
      imageEl.loading   = 'lazy';
      imageEl.setAttribute('aria-hidden', 'true');
      imageEl.style.height = imgHeight + 'px';
    } else {
      imageEl = document.createElement('div');
      imageEl.className = 'aapc-no-img';
      imageEl.style.height = imgHeight + 'px';
      imageEl.setAttribute('aria-hidden', 'true');
      imageEl.textContent = 'No Image';
    }

    // Badges
    var badgesRow = document.createElement('div');
    badgesRow.className = 'aapc-badges';
    resolveBadges(o).forEach(function (b) {
      badgesRow.appendChild(Badge({ text: b.text, variant: b.variant }));
    });

    // Title
    var titleEl = document.createElement('p');
    titleEl.className   = 'aapc-title';
    titleEl.textContent = o.title || 'Untitled';

    // Body assembly (order matters for visual hierarchy)
    var bodyEl = document.createElement('div');
    bodyEl.className = 'aapc-body';
    bodyEl.appendChild(badgesRow);
    bodyEl.appendChild(titleEl);

    // Location
    var loc = [o.city, o.address_state].filter(Boolean).join(', ');
    if (loc) {
      var locEl = document.createElement('p');
      locEl.className   = 'aapc-meta';
      locEl.textContent = loc;
      bodyEl.appendChild(locEl);
    }

    // Distance (geo widgets only)
    var dist = fmtDistance(o.distance_km);
    if (dist && cfgGet(cfg, 'marketplace.card.show_distance', true)) {
      var distEl = document.createElement('p');
      distEl.className   = 'aapc-dist';
      distEl.textContent = dist;
      bodyEl.appendChild(distEl);
    }

    // Timing - relative label + date
    if (o.end_time) {
      var rel  = fmtRelativeTime(o.end_time);
      var date = fmtDate(o.end_time);
      var timeEl = document.createElement('p');
      timeEl.className = 'aapc-meta';
      timeEl.textContent = rel
        ? (rel + (date ? ' · ' + date : ''))
        : (date ? 'Ends ' + date : '');
      bodyEl.appendChild(timeEl);
    }

    // Bid info (lot cards)
    var showBid = cfgGet(cfg, 'marketplace.card.show_bid', true);
    if (showBid && (o.current_bid_cents != null || o.starting_bid_cents != null)) {
      var bidEl = document.createElement('p');
      bidEl.className = 'aapc-bid';
      var hasBids = o.bid_count && o.bid_count > 0;
      var bidAmt  = (hasBids && o.current_bid_cents) ? o.current_bid_cents : o.starting_bid_cents;
      var bidStr  = fmtCents(bidAmt) || '';
      if (hasBids) {
        bidEl.textContent = bidStr + ' · ' + o.bid_count + ' bid' + (o.bid_count !== 1 ? 's' : '');
      } else {
        bidEl.textContent = 'Starts at ' + bidStr;
      }
      bodyEl.appendChild(bidEl);
    }

    // Lot count (auction cards)
    var showLots = cfgGet(cfg, 'marketplace.card.show_lot_count', true);
    if (showLots && o.lot_count != null) {
      var lotsEl = document.createElement('p');
      lotsEl.className  = 'aapc-lots';
      var lotsStr = o.lot_count + ' lot' + (o.lot_count !== 1 ? 's' : '');
      if (o.shippable_lot_count > 0) {
        lotsStr += ' · ' + o.shippable_lot_count + ' ship';
      }
      lotsEl.textContent = lotsStr;
      bodyEl.appendChild(lotsEl);
    }

    // Auction context line (lot cards: "from [Auction Title]")
    if (o.context_label) {
      var ctxEl = document.createElement('p');
      ctxEl.className   = 'aapc-context';
      ctxEl.textContent = o.context_label;
      bodyEl.appendChild(ctxEl);
    }

    // Seller name
    var showSeller = cfgGet(cfg, 'marketplace.card.show_seller', true);
    if (showSeller && o.seller_display_name) {
      var sellerEl = document.createElement('p');
      sellerEl.className   = 'aapc-seller';
      sellerEl.textContent = 'by ' + o.seller_display_name;
      bodyEl.appendChild(sellerEl);
    }

    // Assemble card
    var card = document.createElement('div');
    card.className  = 'aapc-card';
    card.setAttribute('role', 'article');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', esc(o.title || 'Auction'));
    card.appendChild(imageEl);
    card.appendChild(bodyEl);

    if (typeof o.onClick === 'function') {
      card.addEventListener('click', o.onClick);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); o.onClick(e); }
      });
    }

    return card;
  };

})();
