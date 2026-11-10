/* ============================================================================
   Advantage Member Chrome — the ONE shared renderer for the unified Marketplace
   shell (rail + header + mobile bottom nav + mode context + identity). Both the
   full SPA (member-shell.js on /app.html) AND the professional workspace pages
   (/org/*) render their surrounding navigation from THIS module, so there is a
   single source of truth for the sidebar — never a hand-maintained copy.

   Nav DEFINITIONS come from AdvNav (member-nav-config.js). This module only turns
   a context object into the chrome HTML, and (in the browser) can mount that
   chrome around an existing page's content.

   ctx = { user, isSeller, sellerType, mode, isBdMember, businessAdminUrl,
           isEventOrganizer, inShell, activeRoute, activeHref }
     inShell=true  → in-shell items hash-route in place (data-route; member-shell wires them)
     inShell=false → in-shell items are plain links to /app.html#… (navigate to the shell)
   ========================================================================== */
(function (root, factory) {
  var Nav = (typeof module === 'object' && module.exports) ? require('./member-nav-config.js')
    : (typeof self !== 'undefined' ? self.AdvNav : this.AdvNav);
  var api = factory(Nav);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdvChrome = api;
})(typeof self !== 'undefined' ? self : this, function (Nav) {
  'use strict';

  var MODE_META = {
    buying: { label: 'Buying', sub: 'Marketplace' },
    selling: { label: 'Selling', sub: 'Seller workspace' },
    admin: { label: 'Admin', sub: 'Operations' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function initials(u) {
    u = u || {};
    var n = (u.full_name || u.email || '?').trim();
    var p = n.split(/\s+/);
    return ((p[0] || '')[0] || '') + (p.length > 1 ? (p[p.length - 1][0] || '') : '');
  }
  function navContext(ctx) { return { role: ctx.user && ctx.user.role, isSeller: ctx.isSeller, mode: ctx.mode, isBdMember: ctx.isBdMember, businessAdminUrl: ctx.businessAdminUrl, isEventOrganizer: ctx.isEventOrganizer, sellerReady: ctx.sellerReady, storefrontEligible: ctx.storefrontEligible }; }

  // A single nav item. External items are plain links (active by href). In-shell items either
  // hash-route in place (inShell) or navigate to the shell app (/app.html#…) from a standalone page.
  function navItem(item, ctx) {
    var inner = '<span class="adv-nav-emoji" aria-hidden="true">' + item.emoji + '</span><span>' + esc(item.label) + '</span>';
    if (item.external) {
      var extCur = (ctx.activeHref && item.href === ctx.activeHref) ? ' aria-current="page"' : '';
      return '<a class="adv-nav-item" href="' + item.href + '"' + extCur + '>' + inner + '</a>';
    }
    if (ctx.inShell) {
      var cur = item.id === ctx.activeRoute ? ' aria-current="page"' : '';
      return '<a class="adv-nav-item" href="' + item.href + '" data-route="' + item.id + '"' + cur + '>' + inner + '</a>';
    }
    // Standalone page (e.g. /org/*): in-shell sections live in the SPA — link there.
    return '<a class="adv-nav-item" href="/app.html' + item.href + '">' + inner + '</a>';
  }

  // The Buying / Selling switch (owner 2026-11-10: always available to sellers, like a travel marketplace's host switch).
  // A pure buyer has one experience and sees "Start selling" instead. Admins also get "view as" buttons.
  function modeButtons(ctx, compact) {
    var modes = Nav.availableModes(navContext(ctx));
    if (modes.length <= 1) return '';
    return modes.map(function (m) {
      var meta = MODE_META[m] || { label: m };
      if (m === ctx.mode) {
        return '<span class="adv-mode-opt on" aria-current="true">' + esc(meta.label) + '</span>';
      }
      var attrs = ctx.inShell ? ' data-mode="' + m + '"' : ' data-mode="' + m + '" data-mode-href="/app.html"';
      return '<button type="button" class="adv-mode-opt"' + attrs + ' aria-label="Switch to ' + esc(meta.label) + '">' +
        (compact ? 'Switch to ' : '') + esc(meta.label) + '</button>';
    }).join('');
  }
  function modeSwitch(ctx) {
    var modes = Nav.availableModes(navContext(ctx));
    if (modes.length <= 1) {
      return '<a class="adv-nav-item" href="/become-seller.html">' +
        '<span class="adv-nav-emoji" aria-hidden="true">📈</span><span>Start selling</span></a>';
    }
    return '<div class="adv-mode-switch" role="group" aria-label="Buying or Selling">' + modeButtons(ctx, false) + '</div>';
  }
  // An event organizer who has not finished Marketplace seller setup gets one onboarding link under the menu.
  function setupLink(ctx) {
    if (ctx.isEventOrganizer && !ctx.sellerReady && !ctx.isSeller) {
      return '<a class="adv-nav-item" href="/become-seller.html">' +
        '<span class="adv-nav-emoji" aria-hidden="true">🧾</span><span>Complete Marketplace Seller Setup</span></a>';
    }
    return '';
  }
  var MODE_SWITCH_CSS = '<style id="adv-mode-switch-css">' +
    '.adv-mode-switch{display:flex;gap:4px;padding:4px;margin:4px 0 10px;border-radius:999px;background:rgba(15,23,42,.06)}' +
    '.adv-mode-opt{flex:1;border:0;background:transparent;border-radius:999px;padding:7px 10px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;color:inherit;text-align:center}' +
    '.adv-mode-opt.on{background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.18)}' +
    '.adv-mode-opt:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
    '.adv-header .adv-mode-mini{display:none;margin-left:8px}' +
    '.adv-header .adv-mode-mini .adv-mode-opt{flex:0 0 auto;padding:5px 10px;border:1px solid rgba(15,23,42,.15);background:#fff}' +
    '.adv-header .adv-mode-mini .adv-mode-opt.on{display:none}' +
    '@media (max-width:860px){.adv-header .adv-mode-mini{display:flex}}' +
    '</style>';

  function rail(ctx) {
    // Grouped, labelled sections (Storefront / Online Auctions / …) come from the shared nav model.
    var navHtml = Nav.visibleSectionsFor(navContext(ctx)).map(function (s) {
      var head = s.heading ? '<div class="adv-nav-section" role="presentation">' + esc(s.heading) + '</div>' : '';
      return head + s.items.map(function (i) { return navItem(i, ctx); }).join('');
    }).join('');
    var m = MODE_META[ctx.mode] || MODE_META.buying;
    var modes = Nav.availableModes(navContext(ctx));
    return MODE_SWITCH_CSS + '<aside class="adv-rail">' +
      '<a class="adv-brand" href="https://advantage.bid" style="text-decoration:none" aria-label="Advantage.Bid home"><div class="adv-brand-mark">A</div>' +
        '<div><div class="adv-brand-name">Advantage</div><div class="adv-brand-sub">' + esc(m.sub) + '</div></div></a>' +
      (modes.length > 1 ? '<div id="adv-mode-switch">' + modeSwitch(ctx) + '</div>' : '') +
      '<nav class="adv-nav" aria-label="Primary">' + navHtml + '</nav>' +
      '<div class="adv-rail-foot">' + (modes.length > 1 ? '' : modeSwitch(ctx)) + setupLink(ctx) + '</div>' +
      '<div class="adv-rail-foot"><button class="adv-nav-item" id="adv-logout">' +
        '<span class="adv-nav-emoji" aria-hidden="true">↩︎</span><span>Log out</span></button></div>' +
    '</aside>';
  }

  // Mobile bottom nav: up to 4 primary items, and a compact "More" sheet when the experience has more than 5 (never cram
  // equal-width items).
  function bottomNav(ctx) {
    var nctx = navContext(ctx);
    var all = Nav.visibleNavFor(nctx);
    var itemsHtml, sheetHtml = '';
    // Buying and admin keep their flat primary set; Selling has more tools than fit a row, so it gets a More sheet.
    if (ctx.mode === 'selling' && all.length > 5) {
      var primary = all.filter(function (i) { return i.primaryMobile; }).slice(0, 4);
      if (primary.length < 4) primary = primary.concat(all.filter(function (i) { return primary.indexOf(i) === -1; }).slice(0, 4 - primary.length));
      var overflow = all.filter(function (i) { return primary.indexOf(i) === -1; });
      itemsHtml = primary.map(function (i) { return navItem(i, ctx); }).join('');
      itemsHtml += '<button class="adv-nav-item" id="adv-more-btn" type="button" aria-expanded="false" aria-controls="adv-more">' +
        '<span class="adv-nav-emoji" aria-hidden="true">⋯</span><span>More</span></button>';
      sheetHtml = '<div class="adv-moresheet" id="adv-more" hidden><nav class="adv-nav" aria-label="More">' +
        overflow.map(function (i) { return navItem(i, ctx); }).join('') + '</nav></div>';
    } else {
      itemsHtml = Nav.primaryMobileNav(nctx).map(function (i) { return navItem(i, ctx); }).join('');
    }
    return '<nav class="adv-bottomnav" aria-label="Primary mobile">' + itemsHtml + '</nav>' + sheetHtml;
  }

  // Toggle the mobile "More" sheet. Shared by the SPA and standalone pages.
  function wireMore() {
    var btn = document.getElementById('adv-more-btn'), sheet = document.getElementById('adv-more');
    if (!btn || !sheet) return;
    btn.addEventListener('click', function () {
      var willOpen = sheet.hidden;
      sheet.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    });
  }

  function header(ctx) {
    var u = ctx.user || {}, m = MODE_META[ctx.mode] || MODE_META.buying;
    var titleText = ctx.title || 'Dashboard Home';
    return '<header class="adv-header">' +
      '<a class="adv-mobile-brand" href="https://advantage.bid" style="text-decoration:none" aria-label="Advantage.Bid home"><div class="adv-brand-mark">A</div><div class="adv-brand-name">Advantage</div></a>' +
      '<h1 id="adv-title">' + esc(titleText) + '</h1>' +
      '<span class="adv-chip info" id="adv-mode-chip" style="margin-left:8px">' + esc(m.label) + '</span>' +
      (Nav.availableModes(navContext(ctx)).length > 1 ? '<div class="adv-mode-mini">' + modeButtons(ctx, true) + '</div>' : '') +
      '<div class="adv-header-spacer"></div>' +
      '<button class="adv-icon-btn" id="adv-bell" aria-label="Updates and notifications">🔔<span class="adv-dot"></span></button>' +
      '<div class="adv-user"><div class="adv-avatar" aria-hidden="true">' + esc(initials(u).toUpperCase()) + '</div>' +
        '<div class="adv-user-meta"><div class="adv-user-name">' + esc(u.full_name || u.email || '') + '</div>' +
        '<div class="adv-user-role">' + esc(m.label) + '</div></div></div>' +
    '</header>';
  }

  // Full frame; main content is filled by the caller (member-shell routes into it; /org pages slot their body).
  function frame(ctx, mainInnerHtml) {
    return '<div class="adv"><div class="adv-app">' + rail(ctx) + header(ctx) +
      '<main class="adv-main" id="adv-main">' + (mainInnerHtml || '') + '</main>' + bottomNav(ctx) + '</div></div>';
  }

  // ── Browser-only: build a context from the real identity endpoints, and mount the chrome around a
  //    standalone professional page (/org/*). No-ops under Node (tests use the pure builders above). ──
  function haveDom() { return typeof document !== 'undefined' && typeof window !== 'undefined'; }
  function token() { try { return localStorage.getItem('token'); } catch (e) { return null; } }

  async function apiGet(path) {
    var headers = {}; var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
    var res = await fetch(path, { headers: headers, credentials: 'same-origin' });
    var body = null; try { body = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, body: body };
  }

  // Fetch identity + role → ctx (mode resolved from the persisted preference). null → not authenticated.
  async function buildContext() {
    var me = await apiGet('/api/auth/me');
    if (me.status === 401 || !me.ok || !me.body || !me.body.data) return null;
    var d = me.body.data;
    var isSeller = false, sellerType = null;
    try {
      var s = await apiGet('/api/sellers/me');
      var sp = s.ok && s.body && (s.body.data || s.body);
      isSeller = !!(sp && (sp.seller_profile || sp.seller_type || sp.id));
      sellerType = (sp && (sp.seller_type || (sp.seller_profile && sp.seller_profile.seller_type))) || null;
    } catch (e) {}
    var stored = null; try { stored = localStorage.getItem('ab_active_mode'); } catch (e) {}
    var mode = Nav.resolveMode({ role: d.role, isSeller: isSeller, isEventOrganizer: d.event_organizer === true }, stored);
    return {
      user: d, isSeller: isSeller, sellerType: sellerType, mode: mode,
      isBdMember: d.bd_member === true, businessAdminUrl: d.business_admin_url || null,
      isEventOrganizer: d.event_organizer === true, sellerReady: d.seller_ready === true,
      storefrontEligible: d.storefront_eligible === true,
    };
  }

  function wireStandalone() {
    var lo = document.getElementById('adv-logout');
    if (lo) lo.addEventListener('click', function () { location.href = '/logout'; });
    var bell = document.getElementById('adv-bell');
    if (bell) bell.addEventListener('click', function () { location.href = '/app.html#messages'; });
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        try { localStorage.setItem('ab_active_mode', b.getAttribute('data-mode')); } catch (e) {}
        location.href = b.getAttribute('data-mode-href') || '/app.html';
      });
    });
    wireMore();
  }

  /**
   * Mount the unified chrome around a standalone professional page.
   * opts = { rootId='adv-shell-root', contentId='org-content', activeHref, title, requireEventOrganizer,
   *          onReady(ctx) }.
   * Moves the page's existing content node into the shell's main area, suppresses any legacy header,
   * and returns the ctx (or null if unauthenticated → it redirects to login preserving the return path).
   */
  async function mountStandalone(opts) {
    opts = opts || {};
    if (!haveDom()) return null;
    var root = document.getElementById(opts.rootId || 'adv-shell-root');
    if (!root) return null;
    var ctx = await buildContext();
    if (!ctx) { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); return null; }
    ctx.inShell = false;
    ctx.activeHref = opts.activeHref || (location.pathname);
    // A workspace page that belongs to Selling (My Events, Create Event…) opens in Selling, so its own menu item is shown
    // even when the remembered mode is Buying.
    var hasHref = function (c) { return Nav.visibleNavFor(navContext(c)).some(function (i) { return i.href === ctx.activeHref; }); };
    if (!hasHref(ctx) && Nav.availableModes(navContext(ctx)).indexOf('selling') !== -1 && hasHref(Object.assign({}, ctx, { mode: 'selling' }))) {
      ctx.mode = 'selling';
      try { localStorage.setItem('ab_active_mode', 'selling'); } catch (e) {}
    }
    ctx.title = opts.title || document.title.replace(/\s*[-|].*$/, '');
    // Optional entitlement guard (e.g. a native buyer should never see the org pages directly).
    if (opts.requireEventOrganizer && !ctx.isEventOrganizer) { location.replace('/app.html#home'); return null; }
    root.innerHTML = frame(ctx, '');
    // Slot the page's existing content into the shared main area, then reveal it.
    var content = document.getElementById(opts.contentId || 'org-content');
    var main = document.getElementById('adv-main');
    if (content && main) { main.appendChild(content); content.hidden = false; }
    // Suppress any legacy standalone header the page shipped with.
    var legacy = document.getElementById('hdr'); if (legacy) legacy.parentNode && legacy.parentNode.removeChild(legacy);
    wireStandalone();
    if (typeof opts.onReady === 'function') { try { opts.onReady(ctx); } catch (e) {} }
    return ctx;
  }

  return {
    MODE_META: MODE_META, esc: esc, initials: initials,
    navItem: navItem, modeSwitch: modeSwitch, rail: rail, bottomNav: bottomNav, header: header, frame: frame,
    buildContext: buildContext, wireStandalone: wireStandalone, wireMore: wireMore, mountStandalone: mountStandalone,
  };
});
