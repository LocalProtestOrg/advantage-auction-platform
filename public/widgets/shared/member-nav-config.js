/* ============================================================================
   Advantage member navigation model + role-aware visibility.
   Pure + isomorphic: usable in the browser (window.AdvNav) AND requirable in Node
   (module.exports) so navigation-by-role is unit-testable without a DOM.
   Role/permission data comes from the existing server-enforced model:
     role ∈ {buyer, seller, admin}; isSeller derived from a seller_profile.
   Client visibility is cosmetic only — the server remains authoritative.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdvNav = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Every destination. `roles` = which base roles see it; `sellerOnly` items appear for a buyer
  // who also has a seller profile (buyer+seller) and for sellers. `primaryMobile` marks the ≤5 items
  // shown in the mobile bottom nav (highest-frequency); the rest live in the "More" sheet.
  var NAV = [
    { id: 'home',      label: 'Home',      emoji: '🏠', href: '#home',      roles: ['buyer', 'seller', 'admin'], primaryMobile: true },
    { id: 'auctions',  label: 'Auctions',  emoji: '🔨', href: '#auctions',  roles: ['buyer', 'seller', 'admin'], primaryMobile: true },
    { id: 'watchlist', label: 'Watchlist', emoji: '❤️', href: '#watchlist', roles: ['buyer', 'seller', 'admin'], primaryMobile: true },
    { id: 'purchases', label: 'Purchases', emoji: '📦', href: '#purchases', roles: ['buyer', 'seller', 'admin'], primaryMobile: true },
    { id: 'sellers',   label: 'Sellers',   emoji: '🏪', href: '#sellers',   roles: ['buyer', 'seller', 'admin'] },
    { id: 'sell',      label: 'Sell',      emoji: '📈', href: '#sell',      roles: ['buyer', 'seller', 'admin'] },
    { id: 'analytics', label: 'Analytics', emoji: '📊', href: '#analytics', roles: ['seller', 'admin'] },
    { id: 'messages',  label: 'Messages',  emoji: '💬', href: '#messages',  roles: ['buyer', 'seller', 'admin'] },
    { id: 'account',   label: 'Account',   emoji: '⚙️', href: '#account',   roles: ['buyer', 'seller', 'admin'], primaryMobile: true }
  ];

  // Normalize the identity signals into a base role we trust.
  function normalizeRole(role) {
    var r = String(role || '').toLowerCase();
    return (r === 'buyer' || r === 'seller' || r === 'admin') ? r : null;
  }

  /**
   * visibleNavFor({ role, isSeller }) → ordered nav items this member should see.
   * - No/invalid role (logged-out) → [] (the shell shows the logged-out state instead).
   * - Buyer → all buyer items (Analytics hidden: buyer analytics ships in a later phase).
   * - Buyer WITH a seller profile → buyer items + seller-only items (Analytics).
   * - Seller/Admin → their full set. Admin sees everything (superset), server-guarded.
   * Note: "Sell" is always visible — for a non-seller it's the education/enroll surface.
   */
  function visibleNavFor(ctx) {
    ctx = ctx || {};
    var role = normalizeRole(ctx.role);
    if (!role) return [];
    var isSeller = role === 'seller' || role === 'admin' || !!ctx.isSeller;
    return NAV.filter(function (item) {
      if (item.roles.indexOf(role) !== -1) return true;
      // seller-scoped items (e.g. Analytics) also show for a buyer who has a seller profile
      if (isSeller && item.roles.indexOf('seller') !== -1) return true;
      return false;
    });
  }

  function primaryMobileNav(ctx) {
    return visibleNavFor(ctx).filter(function (i) { return i.primaryMobile; });
  }

  function byId(id) {
    for (var i = 0; i < NAV.length; i++) if (NAV[i].id === id) return NAV[i];
    return null;
  }

  return { NAV: NAV, normalizeRole: normalizeRole, visibleNavFor: visibleNavFor,
           primaryMobileNav: primaryMobileNav, byId: byId };
});
