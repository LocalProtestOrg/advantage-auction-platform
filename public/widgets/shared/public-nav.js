/*
 * public-nav.js: the ONE shared public header and navigation for Advantage.Bid (owner-approved unified design,
 * 2026-11-20). Used by the marketing pages, the marketplace, item pages, professional seller storefronts and the
 * auction and estate sale discovery pages.
 *
 *   Row 1: logo (home) · search · account
 *   Row 2: Auctions Near You · Estate Sales Near You · Buy Now Marketplace · Find Professionals · [Start Selling]
 *
 * Self-mounting and self-styled (every rule is scoped under .adv-pubnav, so it looks the same on any page).
 * Usage: <div data-adv-public-nav></div> + <script src="/widgets/shared/public-nav.js" defer></script>
 * (with no mount div it is prepended to <body>).
 *
 * data-variant="minimal" (or window.ADV_PUBLIC_NAV_VARIANT = 'minimal'): logo and account only. Used when a buyer
 * arrives from a seller's own website, so the page does not lead them away from that seller.
 *
 * NEVER loaded by the embedded storefront widget (/embed/storefront.html): a seller's website stays seller-branded.
 */
(function () {
  'use strict';
  if (window.__advPublicNavInstalled) return;
  window.__advPublicNavInstalled = true;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Signed-in state: the same token the rest of the site uses. Only its role is read, to offer the right dashboard;
  // every private page is still checked by the server.
  function session() {
    var token = null; try { token = localStorage.getItem('token'); } catch (e) {}
    if (!token) return null;
    try {
      var p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (p && p.exp && p.exp * 1000 < Date.now()) return null;
      return { role: (p && p.role) || 'buyer' };
    } catch (e) { return { role: 'buyer' }; }
  }

  var ICON = {
    search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    user: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
    menu: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
  };

  function build() {
    var mount = document.querySelector('[data-adv-public-nav]');
    var variant = window.ADV_PUBLIC_NAV_VARIANT || (mount && mount.getAttribute('data-variant')) || 'default';
    var minimal = variant === 'minimal';
    var path = (location.pathname || '/').toLowerCase();
    var show = ''; try { show = (new URLSearchParams(location.search).get('show') || '').toLowerCase(); } catch (e) {}

    // The approved navigation. Each destination is an existing page: the map opens showing only that kind of listing.
    var links = [
      { href: '/?show=auctions', label: 'Auctions Near You', on: function () { return (path === '/' && show === 'auctions') || /^\/(search|auction|auction-view|lot|ending-soon|featured-auctions|past-auctions)(\.html)?$/.test(path); } },
      { href: '/?show=estate-sales', label: 'Estate Sales Near You', on: function () { return (path === '/' && show === 'estate-sales') || /^\/(events|event)(\.html)?$/.test(path); } },
      { href: '/shop', label: 'Buy Now Marketplace', on: function () { return path === '/shop' || path.indexOf('/shop/') === 0 || path.indexOf('/pro/') === 0 || path === '/item.html' || path === '/items'; } },
      { href: '/?show=professionals', label: 'Find Professionals', on: function () { return path === '/' && show === 'professionals'; } }
    ];
    var cta = { href: '/start-selling.html', label: 'Start Selling' };
    // Help pages stay one click away, in the account menu.
    var help = [
      { href: '/how-it-works.html', label: 'How It Works' },
      { href: '/faq.html', label: 'FAQ' }
    ];

    var navLinks = links.map(function (l) {
      var a = l.on();
      return '<a href="' + esc(l.href) + '" class="abn-link' + (a ? ' active' : '') + '"' + (a ? ' aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
    }).join('');

    var me = session();
    var next = encodeURIComponent(location.pathname + location.search);
    var acct = [];
    if (me) {
      acct.push({ href: '/app.html', label: 'My Account' });
      acct.push({ href: '/marketplace-purchases.html', label: 'My Purchases' });
      acct.push({ href: '/my-bids.html', label: 'My Bids' });
      acct.push({ href: '/watchlist.html', label: 'Watchlist' });
      if (me.role === 'seller' || me.role === 'admin') acct.push({ href: '/seller-dashboard.html', label: 'Seller Dashboard' });
      if (me.role === 'admin') acct.push({ href: '/admin/', label: 'Admin' });
    } else {
      acct.push({ href: '/login.html?next=' + next, label: 'Sign In' });
      acct.push({ href: '/login.html?tab=register&next=' + next, label: 'Create Account' });
    }
    var acctHtml = acct.map(function (l) { return '<a role="menuitem" href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('') +
      '<div class="abn-sep" role="separator"></div>' +
      help.map(function (l) { return '<a role="menuitem" href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('') +
      (me ? '<div class="abn-sep" role="separator"></div><a role="menuitem" href="/logout">Log Out</a>' : '');

    var search = minimal ? '<div class="abn-grow"></div>' :
      '<form class="abn-search" role="search" action="/search.html" method="get">' +
        '<label class="abn-sr" for="abn-q">Search Advantage.Bid</label>' +
        '<input id="abn-q" name="q" type="search" placeholder="Search auctions and items..." autocomplete="off" maxlength="120">' +
        '<button type="submit" aria-label="Search">' + ICON.search + '</button>' +
      '</form>';

    var headerHtml =
      '<div class="abn-top"><div class="abn-inner">' +
        '<a href="/" class="brand abn-brand" aria-label="Advantage.Bid home"><img src="/img/brand/advantage-bid-logo.png" alt="Advantage.Bid" width="170" height="46"></a>' +
        search +
        '<div class="abn-acct">' +
          '<button type="button" class="abn-acct-btn" aria-haspopup="true" aria-expanded="false" aria-controls="abn-acct-menu">' + ICON.user + '<span>' + (me ? 'My Account' : 'Sign In') + '</span></button>' +
          '<div class="abn-menu" id="abn-acct-menu" role="menu" hidden>' + acctHtml + '</div>' +
        '</div>' +
        (minimal ? '' : '<button type="button" class="mobile-menu-btn adv-pubnav-toggle" aria-label="Menu" aria-expanded="false" aria-controls="adv-pubnav-links">' + ICON.menu + '</button>') +
      '</div></div>' +
      (minimal ? '' :
        '<div class="abn-bar"><div class="abn-inner">' +
          '<nav id="adv-pubnav-links" class="abn-nav" aria-label="Main navigation">' + navLinks +
            '<a class="btn-header-cta" href="' + esc(cta.href) + '">' + esc(cta.label) + '</a>' +
          '</nav>' +
        '</div></div>');

    var header = document.createElement('header');
    header.className = 'adv-pubnav' + (minimal ? ' adv-pubnav-minimal' : '');
    header.innerHTML = headerHtml;

    if (mount && mount.parentNode) mount.parentNode.replaceChild(header, mount);
    else document.body.insertBefore(header, document.body.firstChild);

    // Mobile menu: below 920px the navigation row is hidden until .mobile-open is set.
    var btn = header.querySelector('.adv-pubnav-toggle');
    var nav = header.querySelector('.abn-nav');
    if (btn && nav) {
      btn.addEventListener('click', function () {
        var open = nav.classList.toggle('mobile-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // Account menu: opens on click, closes on outside click or Escape.
    var ab = header.querySelector('.abn-acct-btn'), menu = header.querySelector('.abn-menu');
    function closeMenu() { if (!menu.hidden) { menu.hidden = true; ab.setAttribute('aria-expanded', 'false'); } }
    ab.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      ab.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) closeMenu(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeMenu(); } });

    if (!document.getElementById('adv-pubnav-style')) {
      var st = document.createElement('style');
      st.id = 'adv-pubnav-style';
      st.textContent =
        '.adv-pubnav{position:relative;top:auto;z-index:200;background:#fff;color:#0f172a;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.3;box-shadow:0 1px 0 #e2e8f0;text-align:left}' +
        '.adv-pubnav *,.adv-pubnav *::before,.adv-pubnav *::after{box-sizing:border-box}' +
        '.adv-pubnav .abn-inner{max-width:1200px;margin:0 auto;padding:0 18px;display:flex;align-items:center;gap:18px}' +
        '.adv-pubnav .abn-top{background:#fff}' +
        '.adv-pubnav .abn-top .abn-inner{min-height:72px;padding-top:10px;padding-bottom:10px}' +
        '.adv-pubnav .abn-brand{flex:0 0 auto;display:block;line-height:0;margin:0;padding:0}' +
        '.adv-pubnav .abn-brand img{height:46px;width:auto;max-width:none;display:block}' +
        '.adv-pubnav .abn-grow{flex:1 1 auto}' +
        '.adv-pubnav .abn-search{flex:1 1 auto;display:flex;min-width:0;max-width:640px;margin:0 auto;border:1.5px solid #cbd5e1;border-radius:9px;background:#fff;overflow:hidden}' +
        '.adv-pubnav .abn-search:focus-within{border-color:#14356b;box-shadow:0 0 0 3px rgba(20,53,107,.15)}' +
        '.adv-pubnav .abn-search input{flex:1 1 auto;min-width:0;width:auto;border:0;outline:0;background:transparent;padding:10px 12px;font:inherit;font-size:14.5px;color:#0f172a;margin:0;border-radius:0}' +
        '.adv-pubnav .abn-search button{flex:0 0 auto;border:0;background:#14356b;color:#fff;width:44px;margin:3px;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}' +
        '.adv-pubnav .abn-search button:hover{background:#0f2a57}' +
        '.adv-pubnav .abn-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
        '.adv-pubnav .abn-acct{position:relative;flex:0 0 auto}' +
        '.adv-pubnav .abn-acct-btn{display:flex;flex-direction:column;align-items:center;gap:2px;background:none;border:0;color:#0f172a;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;padding:6px 8px;border-radius:8px;min-height:44px;width:auto}' +
        '.adv-pubnav .abn-acct-btn:hover,.adv-pubnav .abn-acct-btn[aria-expanded="true"]{background:#f1f5f9}' +
        '.adv-pubnav .abn-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:210px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 14px 34px rgba(15,23,42,.16);padding:6px;z-index:210}' +
        '.adv-pubnav .abn-menu[hidden]{display:none}' +
        '.adv-pubnav .abn-menu a{display:block;padding:10px 12px;border-radius:8px;color:#0f172a;text-decoration:none;font-size:14.5px;font-weight:600}' +
        '.adv-pubnav .abn-menu a:hover,.adv-pubnav .abn-menu a:focus-visible{background:#eef2f8;color:#14356b}' +
        '.adv-pubnav .abn-sep{height:1px;background:#e2e8f0;margin:6px 4px}' +
        '.adv-pubnav .abn-bar{background:#14356b}' +
        '.adv-pubnav .abn-nav{flex:1 1 auto;display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:50px}' +
        '.adv-pubnav .abn-link{color:#fff;text-decoration:none;font-weight:600;font-size:14.5px;padding:8px 12px;border-radius:7px;white-space:nowrap}' +
        '.adv-pubnav .abn-link:hover{background:rgba(255,255,255,.12);color:#fff}' +
        '.adv-pubnav .abn-link.active{background:rgba(255,255,255,.16);color:#fff}' +
        '.adv-pubnav a:focus-visible,.adv-pubnav button:focus-visible{outline:3px solid #fbbf24;outline-offset:2px}' +
        // The Start Selling button (brand red, white text).
        '.adv-pubnav .btn-header-cta{display:inline-block;background:#d62828;color:#fff;border-radius:8px;font-weight:700;font-size:14.5px;text-decoration:none;padding:.5rem 1.15rem;white-space:nowrap;border:0;height:auto;line-height:1.3}' +
        '.adv-pubnav .btn-header-cta:hover{background:#b81f1f;color:#fff}' +
        '.adv-pubnav .adv-pubnav-toggle{display:none;background:none;border:0;color:#0f172a;cursor:pointer;line-height:0;padding:8px;border-radius:8px;min-width:44px;min-height:44px;align-items:center;justify-content:center;font-size:0}' +
        '@media(max-width:920px){' +
        '.adv-pubnav .adv-pubnav-toggle{display:inline-flex}' +
        '.adv-pubnav .abn-top .abn-inner{flex-wrap:wrap;gap:8px 10px;min-height:0}' +
        '.adv-pubnav .abn-brand{margin-right:auto}' +
        '.adv-pubnav .abn-brand img{height:38px}' +
        '.adv-pubnav .abn-search{order:5;flex:1 1 100%;max-width:none}' +
        '.adv-pubnav .abn-acct-btn span{display:none}' +
        '.adv-pubnav .abn-bar .abn-inner{padding:0 10px}' +
        '.adv-pubnav .abn-nav{display:none;flex-direction:column;align-items:stretch;width:100%;padding:8px 0 12px;gap:2px}' +
        '.adv-pubnav .abn-nav.mobile-open{display:flex}' +
        '.adv-pubnav .abn-link{padding:12px 12px;font-size:15.5px}' +
        '.adv-pubnav .btn-header-cta{text-align:center;margin:6px 4px 0;padding:.7rem 1rem}' +
        '}';
      document.head.appendChild(st);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
