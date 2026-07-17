/* Shared buyer header/navigation (#6). Self-mounts a sticky top bar for the
 * Advantage.Bid marketplace. Layout: contextual Back + brand on the left; a
 * compact set of controls on the right.
 *   • Signed OUT → Sign In / Sign Up (+ the marketplace hamburger menu).
 *   • Signed IN  → Profile menu (person icon), Watchlist (heart), hamburger menu.
 * The hamburger opens a grouped "mega" menu (Auctions · Categories · Sell ·
 * How It Works · Help). All dropdowns open on click, close on outside-click /
 * Escape, and are keyboard-accessible (button + aria-expanded).
 *
 * Preserved behavior hooks (do not remove):
 *   - Contextual Back button + goBack() + window.BUYER_NAV_BACK
 *   - Bid-sound toggle + window.BuyerChime
 *   - Token-based auth detection (localStorage 'token') + logout
 *   - Active-link highlighting
 *   - No desktop horizontal scrollbar (nav links live inside dropdowns, so the
 *     bar itself never overflows).
 * Include on any buyer page: <script src="/widgets/shared/buyer-nav.js"></script>
 */
(function () {
  'use strict';
  if (window.__buyerNavInstalled) return;
  window.__buyerNavInstalled = true;

  var MOBILE = 640;
  var CSS =
    '#buyer-nav{position:sticky;top:0;z-index:50;background:#0f172a;color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.18)}' +
    '#buyer-nav *{box-sizing:border-box}' +
    '#buyer-nav .bn-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:8px;' +
      'padding:8px 14px;position:relative;min-width:0}' +
    // P8: the action cluster must be allowed to shrink (min-width:0) so the header
    // never forces the row wider than the viewport on narrow phones.
    '#buyer-nav .bn-actions{min-width:0}' +
    // ── left: Back + brand ──
    '#buyer-nav .bn-back{flex:0 0 auto;background:rgba(255,255,255,.10);color:#fff;border:none;border-radius:8px;' +
      'padding:8px 12px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;min-height:38px}' +
    '#buyer-nav .bn-back:hover{background:rgba(255,255,255,.20)}' +
    // min-width:0 lets the brand actually shrink (ellipsis) in the flex row on narrow
    // phones so the header never overflows the viewport (P8). The action cluster stays
    // intact; the brand yields space only when there isn't enough for everything.
    '#buyer-nav .bn-brand{flex:0 1 auto;min-width:0;font-weight:800;color:#fff;text-decoration:none;margin:0 4px 0 0;font-size:16px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}' +
    '#buyer-nav .bn-spacer{flex:1 1 auto;min-width:8px}' +
    // ── right: action cluster ──
    '#buyer-nav .bn-actions{flex:0 0 auto;display:flex;align-items:center;gap:6px}' +
    '#buyer-nav .bn-icon{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;' +
      'background:rgba(255,255,255,.08);border:none;border-radius:9px;color:#e2e8f0;cursor:pointer;padding:0;text-decoration:none}' +
    '#buyer-nav .bn-icon:hover{background:rgba(255,255,255,.18);color:#fff}' +
    '#buyer-nav .bn-icon svg{width:20px;height:20px;display:block}' +
    '#buyer-nav .bn-icon[aria-expanded="true"]{background:#2563eb;color:#fff}' +
    '#buyer-nav .bn-sound{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;' +
      'background:rgba(255,255,255,.08);border:none;border-radius:9px;color:#cbd5e1;font-size:16px;line-height:1;cursor:pointer;padding:0}' +
    '#buyer-nav .bn-sound:hover{background:rgba(255,255,255,.18);color:#fff}' +
    // ── signed-out auth links ──
    '#buyer-nav .bn-signin{color:#e2e8f0;text-decoration:none;font-size:14px;font-weight:700;padding:9px 12px;' +
      'border-radius:8px;white-space:nowrap}' +
    '#buyer-nav .bn-signin:hover{color:#fff;background:rgba(255,255,255,.10)}' +
    '#buyer-nav .bn-signup{color:#fff;background:#2563eb;text-decoration:none;font-size:14px;font-weight:700;' +
      'padding:9px 14px;border-radius:8px;white-space:nowrap}' +
    '#buyer-nav .bn-signup:hover{background:#1d4ed8}' +
    // ── dropdown shells ──
    '#buyer-nav .bn-pop{position:absolute;top:calc(100% + 6px);right:8px;background:#0f172a;' +
      'border:1px solid rgba(255,255,255,.10);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.45);' +
      'padding:8px;display:none;z-index:60}' +
    '#buyer-nav .bn-profile-pop{width:210px}' +
    '#buyer-nav .bn-profile-pop.open{display:block}' +
    '#buyer-nav .bn-pop a,#buyer-nav .bn-pop button.bn-item{display:block;width:100%;text-align:left;' +
      'color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:600;padding:10px 12px;border-radius:8px;' +
      'background:none;border:none;cursor:pointer;font-family:inherit}' +
    '#buyer-nav .bn-pop a:hover,#buyer-nav .bn-pop button.bn-item:hover{background:rgba(255,255,255,.10);color:#fff}' +
    '#buyer-nav .bn-pop a.active{background:#1e293b;color:#fff}' +
    '#buyer-nav .bn-pop hr{border:none;border-top:1px solid rgba(255,255,255,.10);margin:6px 4px}' +
    // ── grouped mega menu ──
    '#buyer-nav .bn-menu-pop{width:min(700px,calc(100vw - 16px));grid-template-columns:repeat(3,1fr);' +
      'gap:8px 18px;padding:16px}' +
    '#buyer-nav .bn-menu-pop.open{display:grid}' +
    '#buyer-nav .bn-group{min-width:0}' +
    '#buyer-nav .bn-group h4{margin:0 0 4px;padding:0 8px;font-size:11px;font-weight:800;letter-spacing:.08em;' +
      'text-transform:uppercase;color:#94a3b8}' +
    '#buyer-nav .bn-group a{display:block;color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:600;' +
      'padding:8px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#buyer-nav .bn-group a:hover{background:rgba(255,255,255,.10);color:#fff}' +
    '#buyer-nav .bn-group a.active{background:#2563eb;color:#fff}' +
    // ── mobile ──
    '@media (max-width:' + MOBILE + 'px){' +
      '#buyer-nav .bn-brand{font-size:15px}' +
      // P8: on phones the sound toggle (off by default) is dropped from the top bar so
      // the brand + primary actions fit without overflowing / collapsing the logo.
      '#buyer-nav .bn-sound{display:none}' +
      '#buyer-nav .bn-back{padding:8px 10px}' +
      '#buyer-nav .bn-icon,#buyer-nav .bn-sound{width:44px;height:44px}' +
      '#buyer-nav .bn-signin{padding:11px 10px}' +
      '#buyer-nav .bn-signup{padding:11px 12px}' +
      '#buyer-nav .bn-pop{left:8px;right:8px}' +
      '#buyer-nav .bn-profile-pop{width:auto}' +
      '#buyer-nav .bn-menu-pop{width:auto;grid-template-columns:1fr;max-height:calc(100vh - 66px);overflow-y:auto}' +
      '#buyer-nav .bn-group{border-bottom:1px solid rgba(255,255,255,.07);padding-bottom:6px;margin-bottom:2px}' +
      '#buyer-nav .bn-group:last-child{border-bottom:none}' +
      '#buyer-nav .bn-group a{padding:11px 8px}' +
    '}';

  // ── Grouped hamburger menu ─────────────────────────────────────────────────
  // NOTE: some destinations reuse existing pages/anchors because dedicated pages
  // do not exist yet. See the FLAGGED list in the delivery report.
  var MENU = [
    { title: 'Auctions', items: [
      { href: '/search.html?status=active',   label: 'Live Auctions' },
      { href: '/search.html?status=upcoming', label: 'Upcoming Auctions' },
      { href: '/past-auctions.html',          label: 'Past Auctions' },
    ] },
    { title: 'Categories', items: [
      // Route to the always-populated Categories page (avoids empty results when a
      // category label doesn't exactly match a seeded name). Owner directive.
      { href: '/browse-categories.html', label: 'Art' },
      { href: '/browse-categories.html', label: 'Furniture' },
      { href: '/browse-categories.html', label: 'Antiques' },
      { href: '/browse-categories.html', label: 'Jewelry' },
      { href: '/browse-categories.html', label: 'Household' },
      { href: '/browse-categories.html', label: 'All Categories' },
    ] },
    { title: 'Sell', items: [
      { href: '/how-it-works',              label: 'How Selling Works' },
      { href: '/start-selling.html',        label: 'Sell on Advantage' },
      { href: '/after-estate-sale.html',    label: 'Estate Sales' },
      { href: '/downsizing-liquidation.html', label: 'Moving Sales' },
      { href: '/downsizing-liquidation.html', label: 'Senior Downsizing' },
      { href: '/downsizing-liquidation.html', label: 'Business Liquidation' },
      { href: '/start-selling.html',        label: 'Reseller Auctions' },
    ] },
    { title: 'How It Works', items: [
      { href: '/how-it-works',               label: 'How Selling Works' },
      { href: '/how-to-buy.html',            label: 'Buying' },
      { href: '/how-it-works',               label: 'Selling' },
    ] },
    { title: 'Help', items: [
      { href: 'mailto:info@advantage.bid', label: 'Support' },
      { href: '/buyer-faq.html',              label: 'FAQ' },
    ] },
  ];

  // Inline SVG icons (currentColor, no external assets).
  var ICON_USER = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z"/></svg>';
  var ICON_HEART = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 21s-7.2-4.35-9.6-8.6C.9 9.2 2.5 5.4 6.1 5.4c2 0 3.3 1.15 3.9 2.2.6-1.05 1.9-2.2 3.9-2.2 3.6 0 5.2 3.8 3.7 7C19.2 16.65 12 21 12 21Z"/></svg>';
  var ICON_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 6h18M3 12h18M3 18h18"/></svg>';

  function sameOriginReferrer() {
    try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { return false; }
  }
  function goBack() {
    // A page may declare an explicit, DETERMINISTIC destination for the header Back
    // control via window.BUYER_NAV_BACK (e.g. Lot Detail sets it to '/' so its header
    // Back always returns to the homepage discovery/map, regardless of history). When
    // set it wins outright — no browser-history guessing. Only pages that opt in are
    // affected; every other buyer page keeps the in-app history behavior below.
    if (typeof window.BUYER_NAV_BACK === 'string' && window.BUYER_NAV_BACK) {
      location.href = window.BUYER_NAV_BACK; return;
    }
    // Default: return to the previous same-origin page, else Home.
    if (history.length > 1 && sameOriginReferrer()) { history.back(); return; }
    location.href = '/';
  }

  // ── #14 bid chime — delegated, never reimplemented ───────────────────────────
  // This file used to carry a SECOND chime implementation that overwrote
  // window.BuyerChime, dropping isMuted/setMuted (which threw on the live auction
  // pages), keying off 'bidSound', and defaulting OFF. buyer-chime.js is now the
  // single source of truth: one storage key, one preference, default ON.
  //
  // Most nav pages do not include buyer-chime.js, so load it on demand rather than
  // adding a script tag to 19 pages. Fail-open: no chime module → no sound control,
  // never a broken nav.
  function ensureChime(cb) {
    if (window.BuyerChime) return cb();
    var existing = document.querySelector('script[data-buyer-chime]');
    if (existing) { existing.addEventListener('load', cb); existing.addEventListener('error', cb); return; }
    var s = document.createElement('script');
    s.src = '/widgets/shared/buyer-chime.js';
    s.setAttribute('data-buyer-chime', '');
    s.onload = cb;
    s.onerror = cb;
    document.head.appendChild(s);
  }

  function mount() {
    if (document.getElementById('buyer-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    var token = (function () { try { return localStorage.getItem('token'); } catch (e) { return null; } })();
    var here = location.pathname;
    var next = encodeURIComponent(here + location.search);

    // Active-link test: match pathname; when the target carries a query string
    // (e.g. ?status=active), require the current query to match exactly.
    function isActive(href) {
      if (href.charAt(0) !== '/') return false; // mailto: etc.
      var path = href, query = '';
      var qi = href.indexOf('?'); if (qi !== -1) { path = href.slice(0, qi); query = href.slice(qi); }
      var hi = path.indexOf('#'); if (hi !== -1) path = path.slice(0, hi);
      if (path !== here) return false;
      if (query) return query === (location.search || '');
      return true;
    }
    function menuLink(it) {
      return '<a href="' + it.href + '"' + (isActive(it.href) ? ' class="active"' : '') + '>' + it.label + '</a>';
    }
    var menuHtml = MENU.map(function (g) {
      return '<div class="bn-group"><h4>' + g.title + '</h4>' + g.items.map(menuLink).join('') + '</div>';
    }).join('');

    var soundBtn = '<button class="bn-sound" type="button" aria-label="Toggle bid sounds" title="Bid sounds (off by default)"></button>';
    var burgerBtn = '<button class="bn-icon bn-burger" type="button" aria-haspopup="true" aria-expanded="false" ' +
      'aria-controls="bn-menu-pop" aria-label="Browse menu">' + ICON_MENU + '</button>';

    var actionsHtml;
    if (token) {
      actionsHtml =
        soundBtn +
        '<button class="bn-icon bn-profile" type="button" aria-haspopup="true" aria-expanded="false" ' +
          'aria-controls="bn-profile-pop" aria-label="Account menu">' + ICON_USER + '</button>' +
        '<a class="bn-icon" href="/watchlist.html" aria-label="Watchlist" title="Watchlist">' + ICON_HEART + '</a>' +
        burgerBtn;
    } else {
      actionsHtml =
        soundBtn +
        '<a class="bn-signin" href="/login.html?next=' + next + '">Sign In</a>' +
        '<a class="bn-signup" href="/login.html?tab=register&next=' + next + '">Sign Up</a>' +
        burgerBtn;
    }

    var profilePop = token
      ? '<div class="bn-pop bn-profile-pop" id="bn-profile-pop" role="menu">' +
          '<a href="/account.html" role="menuitem">Profile</a>' +
          '<a href="/account.html" role="menuitem">Account</a>' +
          '<a href="/search.html?status=active" role="menuitem">Register to Bid</a>' +
          '<hr>' +
          '<button type="button" class="bn-item" data-bn-logout role="menuitem">Logout</button>' +
        '</div>'
      : '';

    var menuPop = '<div class="bn-pop bn-menu-pop" id="bn-menu-pop" role="menu">' + menuHtml + '</div>';

    var header = document.createElement('header');
    header.id = 'buyer-nav';
    // Header Back button removed (browser Back + the Advantage.Bid logo already
    // return users home); the brand sits fully left in the header.
    header.innerHTML =
      '<div class="bn-inner">' +
        '<a class="bn-brand" href="/">Advantage.Bid</a>' +
        '<div class="bn-spacer"></div>' +
        '<div class="bn-actions">' + actionsHtml + '</div>' +
        profilePop +
        menuPop +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    // Logout (present inside the profile menu when signed in).
    Array.prototype.forEach.call(header.querySelectorAll('[data-bn-logout]'), function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        try { localStorage.removeItem('token'); } catch (_) {}
        location.href = '/';
      });
    });

    // ── Dropdown manager (profile menu + hamburger mega menu) ────────────────
    var pops = [];
    function closeAll() {
      pops.forEach(function (p) { p.pop.classList.remove('open'); p.btn.setAttribute('aria-expanded', 'false'); });
    }
    function register(btn, pop) {
      if (!btn || !pop) return;
      pops.push({ btn: btn, pop: pop });
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = pop.classList.contains('open');
        closeAll();
        if (!isOpen) { pop.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      });
    }
    register(header.querySelector('.bn-profile'), header.querySelector('#bn-profile-pop'));
    register(header.querySelector('.bn-burger'),  header.querySelector('#bn-menu-pop'));

    // Close on outside click; also collapse after choosing a link inside a pop.
    document.addEventListener('click', function (e) {
      if (!header.contains(e.target)) { closeAll(); return; }
      if (e.target.closest('.bn-pop a')) closeAll();
    });
    // Close on Escape.
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Esc') closeAll(); });
    // Collapse when crossing back to desktop width (avoids stuck-open panels).
    window.addEventListener('resize', closeAll);

    // ── #14 bid-sound toggle ─────────────────────────────────────────────────
    // Reads and writes the ONE shared preference. Repaints on 'buyerchime:change'
    // so this and a page's own toggle (Lot Detail has one) never disagree.
    var sound = header.querySelector('.bn-sound');
    if (sound) {
      ensureChime(function () {
        if (!window.BuyerChime) { sound.style.display = 'none'; return; }
        var paint = function () {
          var on = !window.BuyerChime.isMuted();
          sound.textContent = on ? '🔊' : '🔇';
          sound.style.opacity = on ? '1' : '0.6';
          sound.setAttribute('aria-label', on ? 'Turn bid sounds off' : 'Turn bid sounds on');
          sound.setAttribute('aria-pressed', on ? 'false' : 'true');
        };
        paint();
        window.addEventListener('buyerchime:change', paint);
        sound.addEventListener('click', function () {
          var nowMuted = window.BuyerChime.toggle();
          // Confirm audibly when switching ON, matching the previous behavior.
          if (!nowMuted) window.BuyerChime.play('bid');
        });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.BuyerNav = { mount: mount, goBack: goBack };
})();
