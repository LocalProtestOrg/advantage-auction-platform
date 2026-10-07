/* Shared admin header/navigation. Self-mounts one sticky top bar on every admin page:
 * Back, brand (-> Admin Home), the Admin sections organised into a few groups, a role badge, and Log out -
 * so every admin page has a consistent header and a one-click return to Admin Home
 * (canonical route: /admin/). Include on any admin page:
 *   <script src="/widgets/shared/admin-nav.js"></script>
 *
 * Desktop (> 1000px): one compact row. Each group is a button that opens a dropdown of its pages; the group
 * holding the current page is highlighted. Mobile (<= 1000px): brand + a Menu button; the grouped menu is
 * CLOSED by default and opens as a panel under the header (close button, Escape, backdrop tap, or choosing a
 * page closes it), so page content stays visible at the top of the screen.
 *
 * This is presentation only: it renders static links and never bypasses the per-page auth checks or the
 * server-side admin authorization that remain authoritative.
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
  var MOBILE_MAX = 1000; // px: at or below this width the grouped menu collapses behind a Menu button

  var CSS =
    '#admin-nav{position:sticky;top:0;z-index:60;background:#111827;color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
    '#admin-nav *{box-sizing:border-box}' +
    '#admin-nav .an-inner{max-width:1280px;margin:0 auto;display:flex;align-items:center;gap:6px;padding:8px 12px;flex-wrap:nowrap;min-width:0}' +
    '#admin-nav .an-back{background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:7px;padding:7px 12px;font-size:14px;font-weight:600;cursor:pointer;flex:none;white-space:nowrap}' +
    '#admin-nav .an-back:hover{background:rgba(255,255,255,.22)}' +
    '#admin-nav .an-brand{font-weight:800;color:#fff;text-decoration:none;margin:0 8px 0 4px;font-size:15px;white-space:nowrap;flex:none}' +
    '#admin-nav .an-links{display:flex;align-items:center;gap:2px;flex:1;min-width:0}' +
    '#admin-nav .an-top{color:#cbd5e1;text-decoration:none;padding:7px 11px;border-radius:7px;font-size:14px;font-weight:600;white-space:nowrap;' +
      'background:none;border:none;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px;line-height:1.3}' +
    '#admin-nav .an-top:hover,#admin-nav .an-top[aria-expanded="true"]{background:rgba(255,255,255,.10);color:#fff}' +
    '#admin-nav .an-top.active{background:#2563eb;color:#fff}' +
    '#admin-nav .an-caret{font-size:10px;opacity:.8}' +
    '#admin-nav .an-group{position:relative}' +
    '#admin-nav .an-menu{position:absolute;top:calc(100% + 6px);left:0;min-width:230px;background:#fff;color:#0f172a;border-radius:10px;' +
      'box-shadow:0 10px 30px rgba(15,23,42,.25);padding:6px;z-index:70}' +
    '#admin-nav .an-menu a{display:block;color:#1e293b;text-decoration:none;padding:8px 12px;border-radius:7px;font-size:14px;font-weight:600;white-space:nowrap}' +
    '#admin-nav .an-menu a:hover,#admin-nav .an-menu a:focus-visible{background:#eff6ff;color:#1d4ed8}' +
    '#admin-nav .an-menu a.active{background:#2563eb;color:#fff}' +
    '#admin-nav .an-badge{font-size:11px;font-weight:800;letter-spacing:.05em;color:#fbbf24;border:1px solid rgba(251,191,36,.5);border-radius:99px;padding:2px 8px;margin-right:6px;flex:none;white-space:nowrap}' +
    '#admin-nav .an-auth{flex:none}' +
    '#admin-nav .an-auth a{color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:700;padding:7px 10px;white-space:nowrap;cursor:pointer}' +
    '#admin-nav .an-auth a:hover{color:#fff}' +
    '#admin-nav .an-menubtn{display:none;margin-left:auto;background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:700;' +
      'cursor:pointer;font-family:inherit;flex:none;min-height:40px}' +
    '#admin-nav a:focus-visible,#admin-nav button:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}' +
    // Mobile panel (rendered inside the header; fixed below it, scrolls on its own)
    '#admin-nav .an-panel{position:fixed;left:0;right:0;top:var(--admin-nav-h,56px);bottom:0;z-index:65;display:flex;flex-direction:column}' +
    '#admin-nav .an-panel[hidden]{display:none}' +
    '#admin-nav .an-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.45);border:none;padding:0;cursor:pointer}' +
    '#admin-nav .an-sheet{position:relative;background:#fff;color:#0f172a;max-height:calc(100% - 56px);border-radius:0 0 14px 14px;overflow-y:auto;overscroll-behavior:contain;' +
      'padding:8px 16px 16px;box-shadow:0 12px 30px rgba(15,23,42,.3)}' +
    '#admin-nav .an-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0 4px}' +
    '#admin-nav .an-sheet-head b{font-size:15px}' +
    '#admin-nav .an-close{background:#f1f5f9;color:#0f172a;border:none;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:700;cursor:pointer;min-height:40px;font-family:inherit}' +
    '#admin-nav .an-sec{border-top:1px solid #e2e8f0;padding:8px 0}' +
    '#admin-nav .an-sec h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:4px 0 4px;font-weight:800}' +
    '#admin-nav .an-sec a{display:flex;align-items:center;min-height:44px;padding:0 12px;border-radius:8px;color:#1e293b;text-decoration:none;font-size:15px;font-weight:600;overflow-wrap:anywhere}' +
    '#admin-nav .an-sec a:hover{background:#eff6ff}' +
    '#admin-nav .an-sec a.active{background:#2563eb;color:#fff}' +
    '#admin-nav .an-sec .an-logout-m{color:#991b1b}' +
    'html.an-locked,html.an-locked body{overflow:hidden}' +
    '@media (max-width:' + MOBILE_MAX + 'px){' +
      '#admin-nav .an-links,#admin-nav .an-auth{display:none}' +
      '#admin-nav .an-menubtn{display:inline-flex;align-items:center}' +
      '#admin-nav .an-inner{padding:8px 12px;gap:8px}' +
      '#admin-nav .an-brand{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
      '#admin-nav .an-badge{display:none}' +
    '}' +
    '@media (min-width:' + (MOBILE_MAX + 1) + 'px){#admin-nav .an-panel{display:none!important}}' +
    '@media (max-width:420px){#admin-nav .an-back{padding:7px 10px}#admin-nav .an-back .an-back-t{display:none}}' +
    '@media (prefers-reduced-motion:no-preference){#admin-nav .an-menu,#admin-nav .an-sheet{animation:anIn .12s ease-out}}' +
    '@keyframes anIn{from{transform:translateY(-4px)}to{transform:none}}';

  // Sections in production, grouped. `perm` (optional) is the permission required to SEE the link for a
  // non-Super-Admin staff member; links with no `perm` are Super-Admin-only. Super Admins see all.
  // This is presentation only; server-side authorization (requirePermission / role gates) is
  // authoritative and blocks any direct navigation a link might otherwise imply. A group with no
  // visible links is not shown.
  var GROUPS = [
    { key: 'ops', label: 'Operations', title: 'Operations', links: [
      { href: '/admin/moderation.html', label: 'Moderation' },
      { href: '/admin/compliance.html', label: 'Compliance' },
      { href: '/admin/events.html', label: 'Events' },
      { href: '/admin/imported-events.html', label: 'Imported Events' },
      { href: '/admin/invoices.html', label: 'Invoices' },
      { href: '/admin/marketplace-orders.html', label: 'Storefront Orders' },
    ] },
    { key: 'people', label: 'People & Sellers', title: 'People & Sellers', links: [
      { href: '/admin/users.html', label: 'Users' },
      { href: '/admin/buyers.html', label: 'Buyers' },
      { href: '/admin/verification.html', label: 'Verification' },
      { href: '/admin/agreements.html', label: 'Agreements' },
      { href: '/admin/business-listings.html', label: 'Business Listings' },
      { href: '/admin/founding-partners.html', label: 'Auction Partners' },
      { href: '/admin/event-partners.html', label: 'Event Partners', perm: 'event_partners.view' },
      { href: '/admin/staff.html', label: 'Staff & Permissions', perm: 'staff.view' },
    ] },
    { key: 'growth', label: 'Marketing', title: 'Marketing & Growth', links: [
      { href: '/admin/director.html', label: 'Marketing Director', perm: 'members.view' },
      { href: '/admin/marketing-agency.html', label: 'Marketing Agency', perm: 'members.view' },
      { href: '/admin/sales.html', label: 'Sales & Marketing', perm: 'sales.view' },
      { href: '/admin/subscribers.html', label: 'Subscribers', perm: 'members.view' },
      { href: '/admin/marketing-campaigns.html', label: 'Campaigns', perm: 'members.view' },
      { href: '/admin/audiences.html', label: 'Audiences', perm: 'members.view' },
      { href: '/admin/follower-emails.html', label: 'Follower Emails' },
      { href: '/admin/marketing-packages.html', label: 'Marketing Packages' },
      { href: '/admin/social-destinations.html', label: 'Social Destinations' },
    ] },
    { key: 'support', label: 'Customer Service', title: 'Sasha & Customer Service', links: [
      { href: '/admin/sasha-inbox.html', label: 'Customer Service', perm: 'support.view' },
      { href: '/admin/sasha.html', label: 'Sasha Settings & Knowledge', perm: 'support.view' },
    ] },
    { key: 'platform', label: 'Platform', title: 'Platform', links: [
      { href: '/admin/pricing.html', label: 'Pricing & Fees', perm: 'seller_platform_fee.view' },
      { href: '/admin/marketplace-config.html', label: 'Marketplace Config' },
      { href: '/admin/launch-readiness.html', label: 'Launch Readiness' },
    ] },
  ];
  // Flat list (kept for callers/tests): Home + every grouped destination.
  var LINKS = [{ href: HOME, label: 'Admin Home' }].concat(GROUPS.reduce(function (a, g) { return a.concat(g.links); }, []));

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
    if (href === '/admin/moderation.html' && p === '/admin/settlement-review.html') return true;
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
  // for elements taken OUT of flow. The mobile menu panel is position:fixed, so it never changes the height.
  function setNavHeightVar(header) {
    try {
      var bar = header.querySelector('.an-inner') || header;
      var h = Math.ceil((bar.getBoundingClientRect && bar.getBoundingClientRect().height) || bar.offsetHeight || 0);
      if (h > 0) document.documentElement.style.setProperty('--admin-nav-h', h + 'px');
    } catch (e) { /* non-fatal: overlays fall back to 0px */ }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function linkHtml(l) {
    var active = isActive(l.href);
    return '<a href="' + l.href + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
  }
  function visibleGroups() {
    return GROUPS.map(function (g) { return { g: g, links: g.links.filter(canSee) }; }).filter(function (x) { return x.links.length; });
  }

  // ── desktop dropdowns ────────────────────────────────────────────────────────────────────────────────
  var openGroup = null;
  function closeMenus(focusButton) {
    if (!openGroup) return;
    var btn = openGroup.querySelector('.an-top'); var menu = openGroup.querySelector('.an-menu');
    btn.setAttribute('aria-expanded', 'false'); menu.hidden = true;
    if (focusButton) btn.focus();
    openGroup = null;
  }
  function openMenu(group, focusFirst) {
    if (openGroup && openGroup !== group) closeMenus(false);
    var btn = group.querySelector('.an-top'); var menu = group.querySelector('.an-menu');
    btn.setAttribute('aria-expanded', 'true'); menu.hidden = false; openGroup = group;
    // Keep the dropdown inside the viewport (right-align when it would overflow).
    menu.style.left = '0'; menu.style.right = 'auto';
    var r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { menu.style.left = 'auto'; menu.style.right = '0'; }
    if (focusFirst) { var a = menu.querySelector('a'); if (a) a.focus(); }
  }
  function menuKeys(e) {
    var group = e.currentTarget; var items = Array.prototype.slice.call(group.querySelectorAll('.an-menu a'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenus(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (group !== openGroup) openMenu(group, true); else (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (group === openGroup) (items[i - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'Tab' && group === openGroup && i === items.length - 1 && !e.shiftKey) closeMenus(false);
  }

  // ── mobile panel ─────────────────────────────────────────────────────────────────────────────────────
  var lastFocus = null;
  function panelOpen(header) { return !header.querySelector('.an-panel').hidden; }
  function setPanel(header, open) {
    var panel = header.querySelector('.an-panel'); var btn = header.querySelector('.an-menubtn');
    if (open === panelOpen(header)) return;
    if (open) {
      setNavHeightVar(header);
      lastFocus = document.activeElement;
      panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Close';
      document.documentElement.classList.add('an-locked');
      var c = panel.querySelector('.an-close'); if (c) c.focus();
    } else {
      panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Menu';
      document.documentElement.classList.remove('an-locked');
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } } else btn.focus();
    }
  }
  function trapFocus(header, e) {
    if (e.key !== 'Tab' || !panelOpen(header)) return;
    var f = Array.prototype.slice.call(header.querySelectorAll('.an-menubtn, .an-sheet a, .an-sheet button'));
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function renderLinks(header) {
    var groups = visibleGroups();
    var desktop = '<a class="an-top' + (isActive(HOME) ? ' active' : '') + '" href="' + HOME + '"' + (isActive(HOME) ? ' aria-current="page"' : '') + '>Home</a>' +
      groups.map(function (x) {
        var id = 'an-menu-' + x.g.key;
        var active = x.links.some(function (l) { return isActive(l.href); });
        return '<div class="an-group" data-group="' + x.g.key + '">' +
          '<button type="button" class="an-top' + (active ? ' active' : '') + '" aria-expanded="false" aria-controls="' + id + '" aria-haspopup="true"' +
            ' title="' + esc(x.g.title) + '">' + esc(x.g.label) + '<span class="an-caret" aria-hidden="true">&#9662;</span></button>' +
          '<div class="an-menu" id="' + id + '" role="group" aria-label="' + esc(x.g.title) + '" hidden>' + x.links.map(linkHtml).join('') + '</div></div>';
      }).join('');
    var nav = header.querySelector('.an-links'); if (nav) nav.innerHTML = desktop;
    var mobile = '<div class="an-sec"><a href="' + HOME + '"' + (isActive(HOME) ? ' class="active" aria-current="page"' : '') + '>Admin Home</a></div>' +
      groups.map(function (x) { return '<div class="an-sec"><h3>' + esc(x.g.title) + '</h3>' + x.links.map(linkHtml).join('') + '</div>'; }).join('') +
      '<div class="an-sec"><a href="/logout" class="an-logout-m" data-an-logout>Log out</a></div>';
    var list = header.querySelector('.an-sheet-list'); if (list) list.innerHTML = mobile;
    var badge = header.querySelector('.an-badge'); if (badge) badge.textContent = badgeLabel();
    var who = header.querySelector('.an-who'); if (who) who.textContent = badgeLabel() === 'ADMIN' ? 'Signed in as Admin' : 'Signed in as ' + badgeLabel().charAt(0) + badgeLabel().slice(1).toLowerCase();
    // Wire the freshly rendered controls.
    Array.prototype.forEach.call(header.querySelectorAll('.an-group'), function (group) {
      group.querySelector('.an-top').addEventListener('click', function () { if (openGroup === group) closeMenus(false); else openMenu(group, false); });
      group.addEventListener('keydown', menuKeys);
    });
    Array.prototype.forEach.call(header.querySelectorAll('.an-sheet [data-an-logout]'), function (a) { a.addEventListener('click', doLogout); });
    Array.prototype.forEach.call(header.querySelectorAll('.an-sheet-list a:not([data-an-logout])'), function (a) {
      a.addEventListener('click', function () { setPanel(header, false); });
    });
    setNavHeightVar(header); // links/badge just changed the height — republish
  }

  function mount() {
    if (document.getElementById('admin-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var header = document.createElement('header');
    header.id = 'admin-nav';
    header.innerHTML =
      '<div class="an-inner">' +
        '<button class="an-back" type="button" aria-label="Go back">&#8592;<span class="an-back-t"> Back</span></button>' +
        '<a class="an-brand" href="' + HOME + '">Advantage Admin</a>' +
        '<nav class="an-links" aria-label="Admin sections"></nav>' +
        '<span class="an-badge">&nbsp;</span>' +
        '<div class="an-auth"><a data-an-logout tabindex="0" role="button">Log out</a></div>' +
        '<button class="an-menubtn" type="button" aria-expanded="false" aria-controls="an-panel">Menu</button>' +
      '</div>' +
      '<div class="an-panel" id="an-panel" hidden>' +
        '<button class="an-backdrop" type="button" tabindex="-1" aria-label="Close menu"></button>' +
        '<nav class="an-sheet" aria-label="Admin sections">' +
          '<div class="an-sheet-head"><b class="an-who">Admin menu</b><button class="an-close" type="button">Close menu</button></div>' +
          '<div class="an-sheet-list"></div>' +
        '</nav>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);
    header.querySelector('.an-back').addEventListener('click', goBack);
    header.querySelector('.an-auth [data-an-logout]').addEventListener('click', doLogout);
    header.querySelector('.an-auth [data-an-logout]').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') doLogout(e); });
    header.querySelector('.an-menubtn').addEventListener('click', function () { setPanel(header, !panelOpen(header)); });
    header.querySelector('.an-close').addEventListener('click', function () { setPanel(header, false); });
    header.querySelector('.an-backdrop').addEventListener('click', function () { setPanel(header, false); });
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelOpen(header)) { e.preventDefault(); setPanel(header, false); }
      trapFocus(header, e);
    });
    document.addEventListener('click', function (e) { if (openGroup && !openGroup.contains(e.target)) closeMenus(false); });
    document.addEventListener('focusin', function (e) { if (openGroup && !openGroup.contains(e.target)) closeMenus(false); });
    // Leaving the mobile layout with the panel open must not leave the page scroll-locked.
    window.addEventListener('resize', function () { if (window.innerWidth > MOBILE_MAX && panelOpen(header)) setPanel(header, false); });

    // Measure now and keep --admin-nav-h in sync as the header changes (viewport resize, link
    // population, font load). ResizeObserver catches layout changes that a resize event misses.
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
  window.AdminNav = { mount: mount, goBack: goBack, groups: GROUPS, links: LINKS };
})();
