/* Shared admin header/navigation. Self-mounts one sticky top bar on every admin page:
 * Back, brand (-> Admin Home), the core Admin sections, an ADMIN badge, and Log out -
 * so every admin page has a consistent header and a one-click return to Admin Home
 * (canonical route: /admin/). Include on any admin page:
 *   <script src="/widgets/shared/admin-nav.js"></script>
 * This is presentation only: it renders static links and never bypasses the per-page
 * auth checks or the server-side admin authorization that remain authoritative.
 * Pages may define window.adminLogout(); otherwise a default clear+redirect runs.
 */
(function () {
  'use strict';
  if (window.__adminNavInstalled) return;
  window.__adminNavInstalled = true;

  // Admin pages historically did not load the shared session guard, so their tokens never slid and a
  // single transient 401 hard-logged the admin out. Load auth-refresh.js (idempotent) here so every
  // admin page gets sliding refresh + resilient 401 handling (re-verify before logout), matching the
  // hardened buyer pages. Load ASAP so it wraps fetch before the page's API calls resolve.
  if (!window.__authRefreshInstalled && !document.querySelector('script[data-auth-refresh]')) {
    var ar = document.createElement('script');
    ar.src = '/widgets/shared/auth-refresh.js';
    ar.setAttribute('data-auth-refresh', '');
    (document.head || document.documentElement).appendChild(ar);
  }

  var HOME = '/admin/'; // canonical Admin Home route (serves admin/index.html)

  var CSS =
    '#admin-nav{position:sticky;top:0;z-index:60;background:#111827;color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
    '#admin-nav .an-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:6px;padding:8px 12px;flex-wrap:wrap}' +
    '#admin-nav .an-back{background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:7px;padding:7px 12px;font-size:14px;font-weight:600;cursor:pointer}' +
    '#admin-nav .an-back:hover{background:rgba(255,255,255,.22)}' +
    '#admin-nav .an-brand{font-weight:800;color:#fff;text-decoration:none;margin:0 8px 0 4px;font-size:15px;white-space:nowrap}' +
    '#admin-nav .an-links{display:flex;align-items:center;gap:2px;flex:1;flex-wrap:wrap}' +
    '#admin-nav .an-links a{color:#cbd5e1;text-decoration:none;padding:7px 12px;border-radius:7px;font-size:14px;font-weight:600;white-space:nowrap}' +
    '#admin-nav .an-links a:hover{background:rgba(255,255,255,.10);color:#fff}' +
    '#admin-nav .an-links a.active{background:#2563eb;color:#fff}' +
    '#admin-nav .an-badge{font-size:11px;font-weight:800;letter-spacing:.05em;color:#fbbf24;border:1px solid rgba(251,191,36,.5);border-radius:99px;padding:2px 8px;margin-right:6px}' +
    '#admin-nav .an-auth a{color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:700;padding:7px 10px;white-space:nowrap;cursor:pointer}' +
    '#admin-nav .an-auth a:hover{color:#fff}' +
    '#admin-nav a:focus-visible,#admin-nav button:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}' +
    '@media (max-width:600px){#admin-nav .an-brand{display:none}}';

  // Sections in production. `perm` (optional) is the permission required to SEE the link for a
  // non-Super-Admin staff member; links with no `perm` are Super-Admin-only. Super Admins see all.
  // This is presentation only; server-side authorization (requirePermission / role gates) is
  // authoritative and blocks any direct navigation a link might otherwise imply.
  var LINKS = [
    { href: HOME, label: 'Admin Home' },
    { href: '/admin/moderation.html', label: 'Moderation' },
    { href: '/admin/compliance.html', label: 'Compliance' },
    { href: '/admin/users.html', label: 'Users' },
    { href: '/admin/buyers.html', label: 'Buyers' },
    { href: '/admin/verification.html', label: 'Verification' },
    { href: '/admin/agreements.html', label: 'Agreements' },
    { href: '/admin/events.html', label: 'Events' },
    { href: '/admin/business-listings.html', label: 'Business Listings' },
    { href: '/admin/imported-events.html', label: 'Imported Events' },
    { href: '/admin/invoices.html', label: 'Invoices' },
    { href: '/admin/pricing.html', label: 'Pricing & Fees', perm: 'seller_platform_fee.view' },
    { href: '/admin/marketplace-config.html', label: 'Marketplace Config' },
    { href: '/admin/follower-emails.html', label: 'Follower Emails' },
    { href: '/admin/subscribers.html', label: 'Subscribers', perm: 'members.view' },
    { href: '/admin/marketing-campaigns.html', label: 'Campaigns', perm: 'members.view' },
    { href: '/admin/audiences.html', label: 'Audiences', perm: 'members.view' },
    { href: '/admin/director.html', label: 'Director', perm: 'members.view' },
    { href: '/admin/sales.html', label: 'Sales & Marketing', perm: 'sales.view' },
    { href: '/admin/staff.html', label: 'Staff & Permissions', perm: 'staff.view' },
  ];

  // Resolved from /api/admin/staff/me. Until it resolves we render nothing sensitive (only chrome).
  var STAFF = { is_super_admin: false, permissions: [], staff_role: null, loaded: false };
  function canSee(link) {
    if (STAFF.is_super_admin) return true;
    return !!(link.perm && STAFF.permissions.indexOf(link.perm) !== -1);
  }
  function badgeLabel() {
    if (STAFF.is_super_admin) return 'ADMIN';
    if (STAFF.staff_role === 'marketing') return 'MARKETING';
    if (STAFF.staff_role) return String(STAFF.staff_role).toUpperCase();
    return 'STAFF';
  }

  function isActive(href) {
    var p = location.pathname;
    if (href === HOME) return p === '/admin/' || p === '/admin' || p === '/admin/index.html';
    if (p === href) return true;
    // Detail pages belong to their parent section.
    if (href === '/admin/invoices.html' && p === '/admin/invoice-detail.html') return true;
    if (href === '/admin/events.html' && p === '/admin/event-detail.html') return true;
    return false;
  }
  function sameOriginReferrer() {
    try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { return false; }
  }
  function goBack() {
    if (history.length > 1 && sameOriginReferrer()) history.back();
    else location.href = HOME;
  }
  // Route every admin logout through the central /logout endpoint (clears the server session
  // cookie, then the client token, then redirects to login). Loaded AFTER each admin page's inline
  // adminLogout(), so this override makes all admin logout buttons invalidate the full session.
  function doLogout(e) {
    if (e) e.preventDefault();
    location.href = '/logout';
  }
  window.adminLogout = doLogout;

  // Publish the ACTUAL rendered header height as a CSS variable (--admin-nav-h) on <html>, so any admin
  // page can offset fixed/absolute overlays (e.g. side drawers, modals) by the real height rather than a
  // hardcoded guess. The header is sticky (in normal flow), so page CONTENT needs no offset — this var is
  // for elements taken OUT of flow. It stays correct when the nav wraps to multiple lines (measured live).
  function setNavHeightVar(header) {
    try {
      var h = Math.ceil((header.getBoundingClientRect && header.getBoundingClientRect().height) || header.offsetHeight || 0);
      if (h > 0) document.documentElement.style.setProperty('--admin-nav-h', h + 'px');
    } catch (e) { /* non-fatal: overlays fall back to 0px */ }
  }

  function renderLinks(header) {
    var linksHtml = LINKS.filter(canSee).map(function (l) {
      var active = isActive(l.href);
      return '<a href="' + l.href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + l.label + '</a>';
    }).join('');
    var nav = header.querySelector('.an-links'); if (nav) nav.innerHTML = linksHtml;
    var badge = header.querySelector('.an-badge'); if (badge) badge.textContent = badgeLabel();
    setNavHeightVar(header); // links/badge just changed the height — republish
  }

  function mount() {
    if (document.getElementById('admin-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var header = document.createElement('header');
    header.id = 'admin-nav';
    header.innerHTML =
      '<div class="an-inner">' +
        '<button class="an-back" type="button" aria-label="Go back">&#8592; Back</button>' +
        '<a class="an-brand" href="' + HOME + '">Advantage Admin</a>' +
        '<nav class="an-links" aria-label="Admin sections"></nav>' +
        '<span class="an-badge">&nbsp;</span>' +
        '<div class="an-auth"><a data-an-logout tabindex="0" role="button">Log out</a></div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);
    header.querySelector('.an-back').addEventListener('click', goBack);
    header.querySelector('[data-an-logout]').addEventListener('click', doLogout);

    // Measure now and keep --admin-nav-h in sync as the header wraps/unwraps (viewport resize, link
    // population, font load). ResizeObserver catches multi-line wrap changes that a resize event misses.
    setNavHeightVar(header);
    try {
      if (typeof ResizeObserver === 'function') { new ResizeObserver(function () { setNavHeightVar(header); }).observe(header); }
    } catch (e) { /* ignore */ }
    window.addEventListener('resize', function () { setNavHeightVar(header); });
    window.addEventListener('load', function () { setNavHeightVar(header); });

    // Resolve the caller's permissions, then render only the links they may use. The nav starts empty
    // (no sensitive links shown before we know who they are).
    var tok = null; try { tok = localStorage.getItem('token'); } catch (e) {}
    fetch('/api/admin/staff/me', { headers: tok ? { Authorization: 'Bearer ' + tok } : {} })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.success && j.data) {
          STAFF.is_super_admin = !!j.data.is_super_admin;
          STAFF.permissions = j.data.permissions || [];
          STAFF.staff_role = j.data.staff_role;
        }
        STAFF.loaded = true;
        renderLinks(header);
      })
      .catch(function () { STAFF.loaded = true; renderLinks(header); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.AdminNav = { mount: mount, goBack: goBack };
})();
