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
  function visibleNavFor(ctx) {
    ctx = ctx || {};
    var mode = resolveMode(ctx, ctx.mode);
    if (!mode) return [];
    var items = MODES[mode].slice();
    // Provisioned professionals get marketplace event management (My Events / Create Event) surfaced
    // right in the dashboard. Server decides eligibility (org member + events capability).
    if (ctx.isEventOrganizer) items = items.concat(eventOrganizerItems());
    // BD members get a "Business Administration" return link appended to their nav (never for
    // native-only accounts, which have no BD member area). Server decides who is a BD member.
    if (ctx.isBdMember && ctx.businessAdminUrl) items.push(businessAdminItem(ctx.businessAdminUrl));
    return items;
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
    resolveMode: resolveMode, visibleNavFor: visibleNavFor, primaryMobileNav: primaryMobileNav, byId: byId
  };
});
