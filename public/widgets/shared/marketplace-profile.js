/* Marketplace Profile — canonical business-profile card for the Advantage.Bid Marketplace.
 *
 * A framework-free, build-free shared component (matches the widgets/shared IIFE convention).
 * It owns, in ONE place, the three things every Marketplace surface needs so they never drift:
 *   1. Company identity + SINGULAR category labels (cards say "Estate Sale Company", never the
 *      plural legend label "Estate Sale Companies").
 *   2. Policy-respecting image resolution: an approved photo/logo (chosen server-side) fills the
 *      header; otherwise branded, per-category artwork is drawn (inline SVG, zero requests); a
 *      monogram is the final identity fallback. No Brilliant Directories / unclaimed-org logos.
 *   3. Premium, depth-consistent markup + styles (injected once).
 *
 * Variants share one foundation so future surfaces (search results, listing pages, profile
 * pages) can reuse it without duplicating identity/image logic:
 *   - 'popup'    compact map card (default; rendered inside a MapLibre popup)
 *   - 'standard' directory card (self-contained, for grids/lists)
 * Public API:  MarketplaceProfile.cardHTML(company, {variant})  ->  inner HTML string
 *              MarketplaceProfile.actionsHTML(company, {viewHref})
 *              MarketplaceProfile.injectStyles()
 *              MarketplaceProfile.CATS / .categoryFor(key) / .artwork(key)
 */
(function () {
  'use strict';

  // ── Category registry — singular labels + brand colors + watermark glyph ──────────
  // color/colorDeep drive the header gradient + accent; `glyph` is the artwork watermark.
  var CATS = {
    estate_sale_companies: { label: 'Estate Sale Companies', singular: 'Estate Sale Company', color: '#16A34A', colorDeep: '#0B6B33', glyph: 'house' },
    auction_houses:        { label: 'Auction Houses',        singular: 'Auction House',       color: '#2F6BFF', colorDeep: '#1E3F9E', glyph: 'gavel' },
    appraisers:            { label: 'Appraisers',            singular: 'Appraiser',           color: '#E0A82E', colorDeep: '#A76F12', glyph: 'gem'   },
    estate_services:       { label: 'Other Estate Services', singular: 'Estate Service',      color: '#475569', colorDeep: '#28313F', glyph: 'box'   }
  };
  var DEFAULT_CAT = CATS.estate_services;
  function categoryFor(key) { return (key && CATS[key]) || DEFAULT_CAT; }

  // Watermark glyph paths (24x24 viewBox), drawn large + faint inside the artwork.
  var GLYPHS = {
    house: 'M12 3 3 10v11h6v-6h6v6h6V10z',
    gavel: 'M14 3l7 7-3 3-7-7zM3 18l7-7 3 3-7 7zM2 22h9v-2H2z',
    gem:   'M6 3h12l3 5-9 13L3 8zM3 8h18M9 3l-3 5 6 13 6-13-3-5',
    box:   'M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10'
  };

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ── Branded category artwork (inline SVG data URI) ────────────────────────────────
  // A layered gradient + soft highlight + faint watermark glyph. Deterministic per
  // category, no external assets, crisp at any size, implies no specific property/objects.
  function artwork(categoryKey) {
    var c = categoryFor(categoryKey);
    var g = GLYPHS[c.glyph] || GLYPHS.box;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice">' +
        '<defs>' +
          '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="' + c.color + '"/>' +
            '<stop offset="1" stop-color="' + c.colorDeep + '"/>' +
          '</linearGradient>' +
          '<radialGradient id="h" cx="0.26" cy="0.2" r="0.9">' +
            '<stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>' +
            '<stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>' +
          '</radialGradient>' +
        '</defs>' +
        '<rect width="400" height="225" fill="url(#g)"/>' +
        '<rect width="400" height="225" fill="url(#h)"/>' +
        // faint concentric arcs, lower-right, for subtle depth
        '<g fill="none" stroke="#ffffff" stroke-opacity="0.10" stroke-width="1.5">' +
          '<circle cx="360" cy="210" r="60"/><circle cx="360" cy="210" r="100"/><circle cx="360" cy="210" r="140"/>' +
        '</g>' +
        // watermark glyph, upper-left
        '<g transform="translate(30,44) scale(4.6)" fill="#ffffff" fill-opacity="0.14" stroke="#ffffff" stroke-opacity="0.16" stroke-width="0.5" stroke-linejoin="round">' +
          '<path d="' + g + '"/>' +
        '</g>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function monogram(name) {
    var parts = String(name || '').split(/\s+/).filter(Boolean);
    var s = parts.slice(0, 2).map(function (w) { return w[0]; }).join('');
    return (s || '•').toUpperCase().slice(0, 2);
  }

  // ── Header: photo-fill vs. contained-logo vs. branded artwork + monogram ──────────
  function headerHTML(company) {
    var cat = categoryFor(company.categoryKey);
    var img = company.image || null;                       // { url, kind:'logo'|'photo' } | null
    var alt = esc(company.name || 'Business') + ' — ' + esc(company.categorySingular || cat.singular);
    if (img && img.url) {
      if (img.kind === 'logo') {
        // Contained logo on a soft branded surface — never cropped or stretched.
        return '<div class="mpc2-hd mpc2-hd-logo" style="--cat:' + cat.color + '">' +
                 '<img class="mpc2-logo" src="' + esc(img.url) + '" alt="' + alt + '" loading="lazy" ' +
                 'onerror="this.closest(\'.mpc2-hd\').classList.add(\'mpc2-hd-failed\')">' +
               '</div>';
      }
      // Photographic cover — fill with a bottom scrim for legibility.
      return '<div class="mpc2-hd mpc2-hd-photo">' +
               '<img class="mpc2-cover" src="' + esc(img.url) + '" alt="' + alt + '" loading="lazy" ' +
               'onerror="this.closest(\'.mpc2-hd\').classList.add(\'mpc2-hd-failed\')">' +
               '<span class="mpc2-scrim" aria-hidden="true"></span>' +
             '</div>';
    }
    // No approved image — branded category artwork with a monogram identity chip.
    return '<div class="mpc2-hd mpc2-hd-art" style="background-image:url(&quot;' + artwork(company.categoryKey) + '&quot;)">' +
             '<span class="mpc2-mono" aria-hidden="true">' + esc(monogram(company.name)) + '</span>' +
           '</div>';
  }

  // ── Trust chips — data-driven ONLY (never invented) ───────────────────────────────
  function trustHTML(company) {
    var chips = [];
    if (company.linked) chips.push('<span class="mpc2-chip mpc2-chip-seller">Advantage Seller</span>');
    if (company.hasAuctions) chips.push('<span class="mpc2-chip mpc2-chip-live"><span class="mpc2-dot"></span>Active Auctions</span>');
    if (!chips.length) return '';
    return '<div class="mpc2-trust">' + chips.join('') + '</div>';
  }

  // ── Actions — one primary, restrained secondaries; only supported controls ────────
  function actionsHTML(company, opts) {
    opts = opts || {};
    var web = company.website ? mpSafeUrl(company.website) : null;
    var dir = company.dir || null;
    var viewHref = opts.viewHref || null;
    var out = '';
    if (viewHref) out += '<a class="mpc2-btn mpc2-btn-primary mpc2-btn-full" href="' + esc(viewHref) + '">View Auctions</a>';
    if (web) out += '<a class="mpc2-btn ' + (viewHref ? 'mpc2-btn-ghost' : 'mpc2-btn-primary') + '" href="' + esc(web) + '" target="_blank" rel="noopener noreferrer">Visit Website</a>';
    if (dir) out += '<a class="mpc2-btn mpc2-btn-ghost" href="' + esc(dir) + '" target="_blank" rel="noopener noreferrer">Get Directions</a>';
    return out;
  }

  // Force an http(s) absolute URL; reject anything else (mirrors index.html's mpSafeUrl).
  function mpSafeUrl(u) {
    if (!u) return null;
    var s = String(u).trim();
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try { var url = new URL(s); if (url.protocol !== 'http:' && url.protocol !== 'https:') return null; return url.href; }
    catch (e) { return null; }
  }

  // ── Card assembly ─────────────────────────────────────────────────────────────────
  function cardHTML(company, opts) {
    opts = opts || {};
    var variant = opts.variant || 'popup';
    var cat = categoryFor(company.categoryKey);
    var singular = company.categorySingular || cat.singular;
    var loc = [company.city, company.state].filter(Boolean).join(', ');
    var aucSlot = company.hasAuctions
      ? '<div class="mpc2-auctions"><div class="mpc2-auc-load">Loading auctions…</div></div>'
      : '';
    return '' +
      '<article class="mpc2 mpc2-v-' + esc(variant) + '" style="--cat:' + cat.color + ';--cat-deep:' + cat.colorDeep + '">' +
        headerHTML(company) +
        '<div class="mpc2-body">' +
          '<div class="mpc2-idrow">' +
            '<h3 class="mpc2-name">' + esc(company.name) + '</h3>' +
            '<span class="mpc2-cat"><span class="mpc2-cat-dot"></span>' + esc(singular) + '</span>' +
          '</div>' +
          (loc ? '<div class="mpc2-loc"><svg class="mpc2-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>' + esc(loc) + '</div>' : '') +
          (company.blurb ? '<p class="mpc2-blurb">' + esc(company.blurb) + '</p>' : '') +
          trustHTML(company) +
          aucSlot +
          '<div class="mpc2-actions">' + actionsHTML(company, opts) + '</div>' +
        '</div>' +
      '</article>';
  }

  // ── Styles (injected once) — premium depth, theme-aware text, reduced-motion safe ──
  var STYLE_ID = 'mpc2-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
    /* popup shell: let our article own the surface + radius */
    '.maplibregl-popup.mp-card2 .maplibregl-popup-content{padding:0;background:none;border-radius:20px;box-shadow:none;width:312px;max-width:88vw}' +
    '.maplibregl-popup.mp-card2 .maplibregl-popup-tip{border-top-color:#fff;filter:drop-shadow(0 6px 6px rgba(8,16,28,.06))}' +
    '.maplibregl-popup.mp-card2 .maplibregl-popup-close-button{width:28px;height:28px;font-size:18px;line-height:1;color:#fff;top:8px;right:8px;border-radius:50%;background:rgba(8,16,28,.42);backdrop-filter:blur(4px);z-index:3;transition:background .15s}' +
    '.maplibregl-popup.mp-card2 .maplibregl-popup-close-button:hover{background:rgba(8,16,28,.62)}' +

    /* card surface: layered elevation + top edge highlight */
    '.mpc2{position:relative;background:#fff;border-radius:20px;overflow:hidden;color:var(--ink,#0B1B2B);' +
      'box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 0 0 1px rgba(8,16,28,.06),0 10px 22px rgba(8,16,28,.10),0 26px 54px rgba(8,16,28,.20);' +
      'font-family:inherit;-webkit-font-smoothing:antialiased}' +

    /* header (16:9) */
    '.mpc2-hd{position:relative;aspect-ratio:16/9;overflow:hidden;background:#eef1f5}' +
    '@supports not (aspect-ratio:1){.mpc2-hd{height:176px}}' +
    '.mpc2-cover{width:100%;height:100%;object-fit:cover;display:block}' +
    '.mpc2-scrim{position:absolute;inset:auto 0 0 0;height:52%;background:linear-gradient(to top,rgba(8,16,28,.34),transparent);pointer-events:none}' +
    '.mpc2-hd-logo{display:flex;align-items:center;justify-content:center;padding:20px;' +
      'background:linear-gradient(135deg,color-mix(in srgb,var(--cat) 12%,#fff),color-mix(in srgb,var(--cat) 4%,#fff))}' +
    '.mpc2-logo{max-width:78%;max-height:74%;object-fit:contain;display:block;filter:drop-shadow(0 6px 14px rgba(8,16,28,.14))}' +
    '.mpc2-hd-art{background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center}' +
    '.mpc2-mono{width:64px;height:64px;border-radius:18px;display:flex;align-items:center;justify-content:center;' +
      'font-weight:800;font-size:24px;letter-spacing:.02em;color:#fff;background:rgba(255,255,255,.18);' +
      'border:1px solid rgba(255,255,255,.35);box-shadow:0 8px 20px rgba(8,16,28,.22);backdrop-filter:blur(3px)}' +
    /* if a photo/logo fails to load, reveal a neutral branded surface (no broken-image icon) */
    '.mpc2-hd-failed{background:linear-gradient(135deg,color-mix(in srgb,var(--cat) 16%,#fff),color-mix(in srgb,var(--cat) 5%,#fff))}' +
    '.mpc2-hd-failed img,.mpc2-hd-failed .mpc2-scrim{display:none}' +

    /* body */
    '.mpc2-body{padding:14px 16px 15px}' +
    '.mpc2-idrow{margin-bottom:9px}' +
    '.mpc2-name{margin:0;font-size:16.5px;line-height:1.2;font-weight:800;letter-spacing:-.01em;' +
      'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}' +
    '.mpc2-cat{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;font-weight:800;' +
      'letter-spacing:.02em;color:var(--cat-deep,var(--cat));background:color-mix(in srgb,var(--cat) 12%,#fff);' +
      'border:1px solid color-mix(in srgb,var(--cat) 26%,#fff);border-radius:999px;padding:3px 10px 3px 8px}' +
    '.mpc2-cat-dot{width:6px;height:6px;border-radius:50%;background:var(--cat)}' +
    '.mpc2-loc{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:var(--muted,#5b6b7e);margin-bottom:8px}' +
    '.mpc2-ic{width:13px;height:13px;flex:0 0 auto;fill:var(--cat)}' +
    '.mpc2-blurb{margin:0 0 11px;font-size:12.5px;line-height:1.5;color:#3a4757;' +
      'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}' +
    '.mpc2-trust{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}' +
    '.mpc2-chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:800;letter-spacing:.02em;' +
      'padding:4px 9px;border-radius:999px;line-height:1}' +
    '.mpc2-chip-seller{color:#1E3F9E;background:rgba(47,107,255,.10);border:1px solid rgba(47,107,255,.24)}' +
    '.mpc2-chip-live{color:#8f1d2c;background:rgba(181,39,59,.10);border:1px solid rgba(181,39,59,.22)}' +
    '.mpc2-dot{width:6px;height:6px;border-radius:50%;background:var(--live,#B5273B);box-shadow:0 0 0 3px rgba(181,39,59,.16)}' +

    /* lazy-loaded linked auctions */
    '.mpc2-auctions{margin:0 0 12px;border-top:1px solid #eef1f5;padding-top:11px}' +
    '.mpc2-auc-load{font-size:11.5px;font-weight:700;color:var(--muted,#5b6b7e)}' +
    '.mpc2-auc-h{font-size:9.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--muted,#5b6b7e);margin:2px 0 6px}' +
    '.mpc2-auc-item+.mpc2-auc-h{margin-top:10px}' +
    '.mpc2-auc-item{display:flex;justify-content:space-between;gap:9px;align-items:center;text-decoration:none;color:var(--ink,#0B1B2B);' +
      'background:#f6f8fb;border:1px solid #eef1f5;border-radius:11px;padding:8px 11px;margin-bottom:6px;font-weight:700;font-size:12px;transition:background .14s,transform .14s}' +
    '.mpc2-auc-item:hover{background:#eef3fb;transform:translateY(-1px)}' +
    '.mpc2-auc-live{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--live,#B5273B);box-shadow:0 0 0 3px rgba(181,39,59,.16)}' +
    '.mpc2-auc-up{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--coming,#1FB6A6)}' +
    '.mpc2-auc-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}' +
    '.mpc2-auc-m{flex:0 0 auto;font-size:10.5px;font-weight:800;color:var(--muted,#5b6b7e)}' +

    /* actions */
    '.mpc2-actions{display:flex;flex-wrap:wrap;gap:8px}' +
    '.mpc2-btn{flex:1 1 44%;text-align:center;text-decoration:none;font-weight:800;font-size:12.5px;padding:11px 10px;' +
      'border-radius:12px;white-space:nowrap;transition:transform .14s,box-shadow .14s,filter .14s,background .14s;cursor:pointer}' +
    '.mpc2-btn-full{flex:1 1 100%}' +
    '.mpc2-btn-primary{color:#fff;background:linear-gradient(180deg,var(--cat),var(--cat-deep));' +
      'box-shadow:0 4px 12px color-mix(in srgb,var(--cat) 40%,transparent)}' +
    '.mpc2-btn-primary:hover{transform:translateY(-1px);filter:brightness(1.05);box-shadow:0 7px 18px color-mix(in srgb,var(--cat) 46%,transparent)}' +
    '.mpc2-btn-ghost{color:var(--ink,#0B1B2B);background:#eef1f5;border:1px solid rgba(8,16,28,.05)}' +
    '.mpc2-btn-ghost:hover{background:#e4e9f0;transform:translateY(-1px)}' +
    '.mpc2-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--cat) 45%,#fff)}' +

    /* standard (self-contained) variant — same DNA, own surface for grids/lists */
    '.mpc2-v-standard{width:320px;max-width:100%}' +

    /* mobile: turn the map popup into a bottom sheet */
    '@media (max-width:880px){' +
      '.maplibregl-popup.mp-card2{max-width:100%!important;width:100%!important;left:0!important;bottom:0!important;top:auto!important;right:auto!important;transform:none!important}' +
      '.maplibregl-popup.mp-card2 .maplibregl-popup-content{width:100%;max-width:100%}' +
      '.maplibregl-popup.mp-card2 .maplibregl-popup-tip{display:none}' +
      '.mpc2{border-radius:22px 22px 0 0;box-shadow:0 -12px 34px rgba(8,16,28,.24),0 0 0 1px rgba(8,16,28,.06)}' +
      '.mpc2::before{content:"";position:absolute;top:8px;left:50%;transform:translateX(-50%);width:40px;height:4px;border-radius:999px;background:rgba(8,16,28,.16);z-index:4}' +
      '.mpc2-hd{aspect-ratio:21/9}' +
      '.mpc2-body{padding-top:16px}' +
    '}' +

    /* dark theme (index.html swaps --ink/--muted; give the card a matching dark surface) */
    ':root[data-theme="dark"] .mpc2,html.theme-dark .mpc2{background:#141c27;color:#eaf0f7}' +
    ':root[data-theme="dark"] .mpc2-blurb,html.theme-dark .mpc2-blurb{color:#c2ccd8}' +
    ':root[data-theme="dark"] .mpc2-btn-ghost,html.theme-dark .mpc2-btn-ghost{background:#232f3d;color:#eaf0f7;border-color:rgba(255,255,255,.06)}' +
    ':root[data-theme="dark"] .mpc2-auc-item,html.theme-dark .mpc2-auc-item{background:#1c2733;border-color:#26313f;color:#eaf0f7}' +

    /* reduced motion */
    '@media (prefers-reduced-motion:reduce){.mpc2 *{transition:none!important}}';

    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  window.MarketplaceProfile = {
    CATS: CATS,
    categoryFor: categoryFor,
    artwork: artwork,
    monogram: monogram,
    cardHTML: cardHTML,
    actionsHTML: actionsHTML,
    injectStyles: injectStyles,
    safeUrl: mpSafeUrl
  };
})();
