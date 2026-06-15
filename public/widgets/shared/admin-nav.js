/* Shared admin header/navigation (ADMIN-CTRL Phase 1B). Self-mounts a sticky top
 * bar with Back, brand, Moderation / Buyers links, and Log out — giving every
 * admin page a consistent nav + a Back affordance (previously missing on
 * moderation.html). Include on any admin page:
 *   <script src="/widgets/shared/admin-nav.js"></script>
 * Pages may define window.adminLogout(); otherwise a default clear+redirect runs.
 */
(function () {
  'use strict';
  if (window.__adminNavInstalled) return;
  window.__adminNavInstalled = true;

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
    '@media (max-width:600px){#admin-nav .an-brand{display:none}}';

  var LINKS = [
    { href: '/admin/moderation.html', label: 'Moderation' },
    { href: '/admin/users.html', label: 'Users' },
    { href: '/admin/buyers.html', label: 'Buyers' },
  ];

  function sameOriginReferrer() {
    try { return document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) { return false; }
  }
  function goBack() {
    if (history.length > 1 && sameOriginReferrer()) history.back();
    else location.href = '/admin/moderation.html';
  }
  function doLogout(e) {
    if (e) e.preventDefault();
    if (typeof window.adminLogout === 'function') { window.adminLogout(); return; }
    try { localStorage.removeItem('token'); sessionStorage.clear(); } catch (_) {}
    location.href = '/login.html';
  }

  function mount() {
    if (document.getElementById('admin-nav')) return;
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    var here = location.pathname;
    var linksHtml = LINKS.map(function (l) {
      var active = here === l.href || here.indexOf(l.href) === 0;
      return '<a href="' + l.href + '"' + (active ? ' class="active"' : '') + '>' + l.label + '</a>';
    }).join('');
    var header = document.createElement('header');
    header.id = 'admin-nav';
    header.innerHTML =
      '<div class="an-inner">' +
        '<button class="an-back" type="button" aria-label="Go back">&#8592; Back</button>' +
        '<a class="an-brand" href="/admin/moderation.html">Advantage Admin</a>' +
        '<nav class="an-links">' + linksHtml + '</nav>' +
        '<span class="an-badge">ADMIN</span>' +
        '<div class="an-auth"><a data-an-logout>Log out</a></div>' +
      '</div>';
    document.body.insertBefore(header, document.body.firstChild);
    header.querySelector('.an-back').addEventListener('click', goBack);
    header.querySelector('[data-an-logout]').addEventListener('click', doLogout);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.AdminNav = { mount: mount, goBack: goBack };
})();
