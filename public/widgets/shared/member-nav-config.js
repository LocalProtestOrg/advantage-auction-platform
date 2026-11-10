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
    { id: 'howto',     label: 'Seller How To Center', emoji: '📘', href: '/seller-how-to', external: true, proOnly: true },
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
      { id: 'createEvent', label: 'Create Event', emoji: '➕', href: '/org/event-new.html', external: true },
      { id: 'importEvents', label: 'Import My Events', emoji: '🔄', href: '/org/event-promotion.html', external: true }
    ];
  }

  // ── Online auctions (any seller) ──
  // A DIFFERENT workflow/product from events (Create Event is not Create Online Auction). "Manage Online Auctions" is the
  // in-shell seller workspace (#sell); "Create Online Auction" deep-links to the hosted-auction builder.
  function auctionItems() {
    return [
      { id: 'createAuction', label: 'Create Online Auction',  emoji: '🔨', href: '/seller-create.html', external: true },
      { id: 'sell',          label: 'Manage Online Auctions', emoji: '📊', href: '#sell' },
      { id: 'analytics',     label: 'Sale Stats',             emoji: '📈', href: '#analytics' },
      { id: 'payments',      label: 'Auction Payments',       emoji: '💵', href: '/seller-settlements.html', external: true }
    ];
  }

  // ── Professional Storefront (ctx.storefrontEligible: server-computed from the canonical isProfessional rule) ──
  // The storefront workspace comes first in Selling (owner 2026-11-10): Add Item, Manage Inventory, My Storefront,
  // Orders, then the widgets and payouts. Individual Sellers never see Storefront actions they cannot use.
  function storefrontItems() {
    return [
      { id: 'addItem',        label: 'Add Item',         emoji: '🏷️', href: '/seller-storefront.html?tab=market', external: true, primaryMobile: true },
      { id: 'inventory',      label: 'Manage Inventory', emoji: '🗂️', href: '/seller-inventory.html', external: true, primaryMobile: true },
      { id: 'storefront',     label: 'My Storefront',    emoji: '🏪', href: '/seller-storefront.html?tab=store', external: true, primaryMobile: true },
      { id: 'mpOrders',       label: 'Orders',           emoji: '📦', href: '/seller-orders.html', external: true, primaryMobile: true },
      // Both website widgets (auctions and storefront) in one place (owner request 2026-11-03).
      { id: 'websiteWidgets', label: 'Website Widgets',  emoji: '🧩', href: '/seller-storefront.html?tab=widget', external: true },
      { id: 'payouts',        label: 'Payouts',          emoji: '🏦', href: '/payout-profile.html', external: true }
    ];
  }
  var SELLER_SETTINGS = { id: 'account', label: 'Seller Settings', emoji: '⚙️', href: '#account', primaryMobile: true };
  var HOW_TO = { id: 'howto', label: 'Seller How To Center', emoji: '📘', href: '/seller-how-to', external: true, proOnly: true };
  // An Individual Seller's way to a storefront (self-service: /become-professional-seller.html).
  var GO_PRO = { id: 'goPro', label: 'Open a Professional Storefront', emoji: '🏪', href: '/become-professional-seller.html', external: true };
  // A seller who has not finished Marketplace setup (the seller agreement) sees this one step instead of tools it cannot use.
  var FINISH_SETUP = { id: 'finishSetup', label: 'Finish seller setup', emoji: '📝', href: '/sign-agreement.html?onboarding=1', external: true, primaryMobile: true };

  // Kept for callers that ask "does this account have professional tools?" (event organizer or Marketplace-ready seller).
  function isProfessionalExperience(ctx) { return !!(ctx && (ctx.isEventOrganizer || ctx.sellerReady)); }

  function isSellerCtx(ctx) { return !!(ctx && (ctx.isSeller || normalizeRole(ctx.role) === 'seller')); }

  // The SELLING experience, in labelled sections. The Buying/Selling switch always decides what is shown.
  function sellingSections(ctx) {
    var out = [{ id: 'home', heading: null, items: [SELLING[0]] }];
    var ready = !!ctx.sellerReady;   // seller profile + satisfied agreement gate (server-computed)
    if (isSellerCtx(ctx) && !ready) out.push({ id: 'setup', heading: null, items: [FINISH_SETUP] });
    if (ctx.storefrontEligible && ready) out.push({ id: 'storefront', heading: 'Storefront', items: storefrontItems() });
    if (isSellerCtx(ctx) && ready) out.push({ id: 'auctions', heading: 'Online Auctions', items: auctionItems() });
    if (ctx.isEventOrganizer) out.push({ id: 'events', heading: 'Events', items: eventOrganizerItems() });
    var general = [];
    if (!ctx.storefrontEligible && isSellerCtx(ctx)) general.push(GO_PRO);
    general.push(HOW_TO, SELLING[5], SELLER_SETTINGS);   // How To Center (Professional only), Messages, Seller Settings
    out.push({ id: 'general', heading: null, items: general });
    return out;
  }


  function normalizeRole(role) {
    var r = String(role || '').toLowerCase();
    return (r === 'buyer' || r === 'seller' || r === 'admin') ? r : null;
  }

  // Which experiences a user may switch between (progressive disclosure: no switch for a pure buyer). Sellers and event
  // organizers switch between Buying and Selling.
  function availableModes(ctx) {
    ctx = ctx || {};
    var role = normalizeRole(ctx.role);
    if (!role) return [];
    if (role === 'admin') return ['admin', 'selling', 'buying']; // admin default + "view as" for testing
    if (role === 'seller' || ctx.isSeller || ctx.isEventOrganizer) return ['buying', 'selling'];
    return ['buying']; // pure buyer: never sees a switch
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
   * visibleSectionsFor(ctx) → ordered [{ id, heading|null, items:[...] }]: the single source of nav structure. The active
   * mode (Buying / Selling / admin) always decides what is shown.
   */
  function visibleSectionsFor(ctx) {
    ctx = ctx || {};
    var mode = resolveMode(ctx, ctx.mode);
    if (!mode) return [];
    // Business Administration is the gateway BACK to the BD admin area: pinned on top in every experience.
    var sections = [];
    if (ctx.isBdMember && ctx.businessAdminUrl) {
      sections.push({ id: 'bizadmin', heading: null, items: [businessAdminItem(ctx.businessAdminUrl)] });
    }
    // buying = the buyer list (professionals included); selling = Storefront / Online Auctions / Events / general.
    if (mode === 'selling') sections = sections.concat(sellingSections(ctx));
    else sections = sections.concat([{ id: mode, heading: null, items: MODES[mode].slice() }]);
    // proOnly items (the Seller How To Center) only for Professional Sellers and admins; the server enforces it too.
    var pro = !!ctx.storefrontEligible || normalizeRole(ctx.role) === 'admin';
    return sections.map(function (sec) { return pro ? sec : { id: sec.id, heading: sec.heading, items: sec.items.filter(function (i) { return !i.proOnly; }) }; })
      .filter(function (sec) { return sec.items.length; });
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
