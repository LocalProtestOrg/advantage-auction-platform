/* ============================================================================
   Advantage member navigation model — ONE account, THREE experiences.
   "Stupid Easy": the interface adapts to the user's current task (Buying / Selling /
   Administration) instead of forcing one combined nav on everyone. Pure + isomorphic:
   usable in the browser (window.AdvNav) AND requirable in Node so navigation-by-mode
   is unit-testable without a DOM. Client visibility is cosmetic; the server remains
   authoritative for who is actually a seller/admin.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdvNav = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Section ids map to in-shell loaders; items with `external:true` deep-link out of the shell.
  // `primaryMobile` marks the items shown in the mobile bottom nav (highest-frequency; ≤5).

  // ── BUYING experience — feels like a marketplace, never like auction software ──
  var BUYING = [
    { id: 'home',      label: 'Dashboard Home',      emoji: '🏠', href: '#home',      primaryMobile: true },
    { id: 'watchlist', label: 'Watchlist', emoji: '❤️', href: '#watchlist', primaryMobile: true },
    { id: 'auctions',  label: 'My Bids',   emoji: '🎟️', href: '#auctions',  primaryMobile: true },
    { id: 'purchases', label: 'Purchases', emoji: '📦', href: '#purchases', primaryMobile: true },
    { id: 'messages',  label: 'Messages',  emoji: '💬', href: '#messages' },
    { id: 'account',   label: 'Account',   emoji: '⚙️', href: '#account',   primaryMobile: true }
  ];

  // ── SELLING experience — an efficient operational workspace ──
  var SELLING = [
    { id: 'home',      label: 'Dashboard Home',           emoji: '🏠', href: '#home',                    primaryMobile: true },
    { id: 'sell',      label: 'My Auctions',    emoji: '🔨', href: '#sell',                    primaryMobile: true },
    { id: 'create',    label: 'Create Auction', emoji: '➕', href: '/seller-create.html', external: true, primaryMobile: true },
    { id: 'analytics', label: 'Sale Stats',     emoji: '📊', href: '#analytics' },
    { id: 'payments',  label: 'Payments',       emoji: '💰', href: '/seller-settlements.html', external: true },
    { id: 'messages',  label: 'Messages',       emoji: '💬', href: '#messages' },
    { id: 'account',   label: 'Account',        emoji: '⚙️', href: '#account',                 primaryMobile: true }
  ];

  // ── ADMINISTRATION experience — a dedicated operational workspace ──
  var ADMIN = [
    { id: 'home',     label: 'Dashboard Home',       emoji: '🏠', href: '#home',                 primaryMobile: true },
    { id: 'moderate', label: 'Moderation', emoji: '📋', href: '/admin/moderation.html', external: true, primaryMobile: true },
    { id: 'invoices', label: 'Invoices',   emoji: '🧾', href: '/admin/invoices.html',  external: true, primaryMobile: true },
    { id: 'members',  label: 'Members',    emoji: '👤', href: '/admin/users.html',     external: true },
    { id: 'messages', label: 'Messages',   emoji: '💬', href: '#messages' },
    { id: 'account',  label: 'Account',    emoji: '⚙️', href: '#account',              primaryMobile: true }
  ];

  var MODES = { buying: BUYING, selling: SELLING, admin: ADMIN };

  // ── Cross-application link — "Business Administration" (BD member area) ──
  // Appended to every experience for members who came from BD (ctx.isBdMember), so a professional can
  // move back to Business Administration (billing / membership / directory) the same way they came in.
  // `external` deep-links out of the shell; `primaryMobile` keeps it reachable in the mobile bottom nav
  // (the rail is hidden ≤860px). The href is server-authoritative (passed in via ctx.businessAdminUrl).
  function businessAdminItem(url) {
    return { id: 'bizadmin', label: 'Business Administration', emoji: '🏢', href: String(url), external: true, primaryMobile: true };
  }

  // ── Marketplace event management (for provisioned professionals — ctx.isEventOrganizer) ──
  // My Events / Create Event live in the organization workspace; deep-link out of the shell so an
  // eligible professional reaches event creation/management straight from the Marketplace dashboard.
  function eventOrganizerItems() {
    return [
      { id: 'events',      label: 'My Events',    emoji: '📅', href: '/org/events.html',   external: true, primaryMobile: true },
      { id: 'createEvent', label: 'Create Event', emoji: '➕', href: '/org/event-new.html', external: true }
    ];
  }

  // ── Online-auction management (for sellers who completed Marketplace setup — ctx.sellerReady) ──
  // A DIFFERENT workflow/product from events (Create Event ≠ Create Online Auction — kept separate).
  // "Manage Online Auctions" reuses the in-shell seller workspace (#sell); "Create Online Auction"
  // deep-links to the hosted-auction builder.
  function auctionSellerItems() {
    return [
      { id: 'storefront',    label: 'My Storefront',          emoji: '🏪', href: '/seller-storefront.html', external: true, primaryMobile: true },
      { id: 'mpOrders',      label: 'Marketplace Orders',     emoji: '📦', href: '/seller-orders.html', external: true },
      { id: 'createAuction', label: 'Create Online Auction',  emoji: '🔨', href: '/seller-create.html', external: true },
      { id: 'sell',          label: 'Manage Online Auctions', emoji: '📊', href: '#sell' }
    ];
  }

  // A capability-aware account (an event organizer and/or a Marketplace-ready seller) gets a single
  // professional-first list instead of the buyer-first mode nav.
  function isProfessionalExperience(ctx) { return !!(ctx && (ctx.isEventOrganizer || ctx.sellerReady)); }

  // ── Professional Marketplace features — DATA-DRIVEN registry ──
  // Every professional tool is one entry: an entitlement predicate + the item(s) it contributes, in
  // display order. Future features (Seller Analytics, My Lots, Invoices, Settlements, …) are added by
  // inserting a row here — the section, headings, and rendering need no restructuring.
  var PROFESSIONAL_FEATURES = [
    { key: 'events',   when: function (c) { return c.isEventOrganizer; },              items: function () { return eventOrganizerItems(); } }, // My Events, Create Event
    { key: 'auctions', when: function (c) { return c.sellerReady; },                   items: function () { return auctionSellerItems(); } }, // Create/Manage Online Auction
    // ── future professional tools slot in here (capability-gated), e.g.:
    // { key: 'analytics',   when: function (c) { return c.sellerReady; }, items: function () { return [{ id:'analytics', label:'Seller Analytics', emoji:'📈', href:'#analytics' }]; } },
    // { key: 'lots',        when: function (c) { return c.sellerReady; }, items: function () { return [{ id:'lots', label:'My Lots', emoji:'📦', href:'/dashboard/lots.html', external:true }]; } },
    // { key: 'invoices',    when: function (c) { return c.sellerReady; }, items: function () { return [{ id:'sellerInvoices', label:'Invoices', emoji:'🧾', href:'/invoices.html', external:true }]; } },
    // { key: 'settlements', when: function (c) { return c.sellerReady; }, items: function () { return [{ id:'settlements', label:'Settlements', emoji:'💰', href:'/seller-settlements.html', external:true }]; } },
    // (Business Administration is no longer here — it is pinned to the TOP of the nav; see visibleSectionsFor.)
  ];
  function professionalMarketplaceItems(ctx) {
    var out = [];
    PROFESSIONAL_FEATURES.forEach(function (f) { if (f.when(ctx)) out = out.concat(f.items(ctx)); });
    return out;
  }

  // Professional-first, grouped into labelled sections (Business Administration is pinned above these
  // by visibleSectionsFor). Professional Marketplace tools, then Buying, are preserved below.
  function professionalSections(ctx) {
    var sections = [{ id: 'home', heading: null, items: [BUYING[0]] }]; // Dashboard Home (no heading)
    var pro = professionalMarketplaceItems(ctx);
    if (pro.length) sections.push({ id: 'professional', heading: 'Professional Marketplace', items: pro });
    sections.push({ id: 'buying', heading: 'Buying', items: [BUYING[1], BUYING[2], BUYING[3]] }); // Watchlist, My Bids, Purchases
    sections.push({ id: 'general', heading: null, items: [BUYING[4], BUYING[5]] });               // Messages, Account
    return sections;
  }

  function normalizeRole(role) {
    var r = String(role || '').toLowerCase();
    return (r === 'buyer' || r === 'seller' || r === 'admin') ? r : null;
  }

  // Which experiences a user may switch between (progressive disclosure — no switch for a pure buyer).
  function availableModes(ctx) {
    ctx = ctx || {};
    var role = normalizeRole(ctx.role);
    if (!role) return [];
    if (role === 'admin') return ['admin', 'selling', 'buying']; // admin default + "view as" for testing
    if (role === 'seller' || ctx.isSeller) return ['buying', 'selling']; // buyer-first, can switch to selling
    return ['buying']; // pure buyer — never sees a switch
  }

  // The experience a user lands in by default: buyer-first for everyone except admins.
  function defaultMode(ctx) {
    var modes = availableModes(ctx);
    if (!modes.length) return null;
    return modes[0];
  }

  // Resolve a requested mode to one the user is actually allowed (falls back to their default).
  function resolveMode(ctx, requested) {
    var modes = availableModes(ctx);
    if (requested && modes.indexOf(requested) !== -1) return requested;
    return modes[0] || null;
  }

  /**
   * visibleNavFor({ role, isSeller, mode }) → ordered nav items for the resolved experience.
   * No/invalid role (logged-out) → []. An unavailable/absent mode resolves to the user's default.
   */
  /**
   * visibleSectionsFor(ctx) → ordered [{ id, heading|null, items:[...] }]. The single source of nav
   * structure. Professionals get grouped sections (Dashboard Home / Professional Marketplace / Buying /
   * general); everyone else gets one unlabelled section (the mode nav). Rail rendering reads sections
   * (headings); flat consumers read visibleNavFor (below).
   */
  function visibleSectionsFor(ctx) {
    ctx = ctx || {};
    var mode = resolveMode(ctx, ctx.mode);
    if (!mode) return [];
    // Business Administration is the gateway BACK to the BD admin area. Pin it to the very TOP for any
    // member who came from BD, so if they land in the Railway app it is the first thing they see. Its
    // own section (no heading) → the existing inter-section spacing separates it from the app nav below.
    var sections = [];
    if (ctx.isBdMember && ctx.businessAdminUrl) {
      sections.push({ id: 'bizadmin', heading: null, items: [businessAdminItem(ctx.businessAdminUrl)] });
    }
    if (mode !== 'admin' && isProfessionalExperience(ctx)) return sections.concat(professionalSections(ctx));
    return sections.concat([{ id: mode, heading: null, items: MODES[mode].slice() }]);
  }

  // Flat ordered items (backward-compatible) — the concatenation of every section's items.
  function visibleNavFor(ctx) {
    var out = [];
    visibleSectionsFor(ctx).forEach(function (s) { out = out.concat(s.items); });
    return out;
  }

  function primaryMobileNav(ctx) {
    return visibleNavFor(ctx).filter(function (i) { return i.primaryMobile; });
  }

  // Look up an item within a given (or resolved) experience.
  function byId(id, ctx) {
    var list = (ctx ? visibleNavFor(ctx) : BUYING.concat(SELLING, ADMIN));
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  return {
    MODES: MODES, BUYING: BUYING, SELLING: SELLING, ADMIN: ADMIN,
    normalizeRole: normalizeRole, availableModes: availableModes, defaultMode: defaultMode,
    resolveMode: resolveMode, visibleSectionsFor: visibleSectionsFor, visibleNavFor: visibleNavFor,
    isProfessionalExperience: isProfessionalExperience, primaryMobileNav: primaryMobileNav, byId: byId
  };
});
