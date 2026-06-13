/* Shared buyer header/navigation (#6). Self-mounts a sticky top bar with Back,
 * Auctions, My Bids, Watchlist, Account, and a Log in/out affordance. Works on
 * desktop and mobile (links wrap / scroll; no fragile hamburger). Include on any
 * buyer page: <script src="/widgets/shared/buyer-nav.js"></script>
 */
(function () {
  'use strict';
  if (window.__buyerNavInstalled) return;
  window.__buyerNavInstalled = true;

  var CSS =
    '#buyer-nav{position:sticky;top:0;z-index:50;background:#0f172a;color:#fff;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 1px 3px rgba(0,0,0,.18)}' +
    '#buyer-nav .bn-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:6px;' +
      'padding:8px 12px;flex-wrap:wrap}' +
    '#buyer-nav .bn-back{background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:7px;' +
      'padding:7px 12px;font-size:14px;font-weight:600;cursor:pointer}' +
    '#buyer-nav .bn-back:hover{background:rgba(255,255,255,.22)}' +
    '#buyer-nav .bn-brand{font-weight:800;color:#fff;text-decoration:none;margin:0 8px 0 4px;font-size:15px;white-space:nowrap}' +
    '#buyer-nav .bn-links{display:flex;align-items:center;gap:2px;flex:1;flex-wrap:wrap;overflow-x:auto}' +
    '#buyer-nav .bn-links a{color:#cbd5e1;text-decoration:none;padding:7px 12px;border-radius:7px;' +
      'font-size:14px;font-weight:600;white-space:nowrap}' +
    '#buyer-nav .bn-links a:hover{background:rgba(255,255,255,.10);color:#fff}' +
    '#buyer-nav .bn-links a.active{background:#2563eb;color:#fff}' +
    '#buyer-nav .bn-auth a{color:#cbd5e1;text-decoration:none;font-size:14px;font-weight:700;padding:7px 10px;white-space:nowrap}' +
    '#buyer-nav .bn-auth a:hover{color:#fff}' +
    '@media (max-width:600px){#buyer-nav .bn-brand{display:none}#buyer-nav .bn-links a{padding:7px 9px;font-size:13px}}';

  var LINKS = [
    { href: '/', label: 'Auctions', match: ['/', '/index.html'] },
    { href: '/my-bids.html', label: 'My Bids' },
    { href: '/watchlist.html', label: 'Watchlist' },
    { href: '/account.html', label: 'Account' },
  ];

  function sameOriginReferrer() {
    try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { return false; }
  }
  function goBack() {
    if (history.length > 1 && sameOriginReferrer()) history.back();
    else location.href = '/';
  }

  function mount() {
    if (document.getElementById('buyer-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    var token = (function () { try { return localStorage.getItem('token'); } catch (e) { return null; } })();
    var here = location.pathname;
    var linksHtml = LINKS.map(function (l) {
      var active = (l.match ? l.match.indexOf(here) !== -1 : here === l.href);
      return '<a href="' + l.href + '"' + (active ? ' class="active"' : '') + '>' + l.label + '</a>';
    }).join('');

    var authHtml = token
      ? '<a href="#" data-bn-logout>Log out</a>'
      : '<a href="/login.html?next=' + encodeURIComponent(here + location.search) + '">Log in</a>';

    var header = document.createElement('header');
    header.id = 'buyer-nav';
    header.innerHTML =
      '<div class="bn-inner">' +
        '<button class="bn-back" type="button" aria-label="Go back">&#8592; Back</button>' +
        '<a class="bn-brand" href="/">Advantage</a>' +
        '<nav class="bn-links">' + linksHtml + '</nav>' +
        '<div class="bn-auth">' + authHtml + '</div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);

    header.querySelector('.bn-back').addEventListener('click', goBack);
    var logout = header.querySelector('[data-bn-logout]');
    if (logout) logout.addEventListener('click', function (e) {
      e.preventDefault();
      try { localStorage.removeItem('token'); } catch (_) {}
      location.href = '/';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.BuyerNav = { mount: mount, goBack: goBack };
})();
