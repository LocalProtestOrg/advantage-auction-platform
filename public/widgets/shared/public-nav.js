/*
 * public-nav.js — the ONE shared public (marketing) header/navigation for Advantage.Bid.
 *
 * Self-mounting, like buyer-nav.js. Renders the canonical Variant-A header (styled by the existing
 * marketplace.css header classes) with a WORKING mobile hamburger + toggle built in — fixing the pages
 * whose inline header had no hamburger (unreachable mobile nav). Semantic <header><nav aria-label>,
 * active-state by pathname, canonical relative "/" logo. No AI/tracking params.
 *
 * Usage on a public page: replace the inline <header>…</header> with
 *   <div data-adv-public-nav data-variant="default|professional"></div>
 *   <script src="/widgets/shared/public-nav.js" defer></script>
 * (If no mount div is present, it prepends the header to <body>.)
 */
(function () {
  'use strict';

  function build() {
    var mount = document.querySelector('[data-adv-public-nav]');
    var variant = (mount && mount.getAttribute('data-variant')) || window.ADV_PUBLIC_NAV_VARIANT || 'default';
    var path = (location.pathname || '/').toLowerCase();

    // Canonical public nav. "Browse Auctions" → the search/browse marketplace; Start Selling → the
    // marketing funnel. The professional variant swaps in "Sell Professionally".
    var links = [
      { href: '/search.html', label: 'Browse Auctions', match: ['/search'] },
      { href: '/how-it-works.html', label: 'How It Works', match: ['/how-it-works'] },
      (variant === 'professional'
        ? { href: '/professional-sellers.html', label: 'Sell Professionally', match: ['/professional-sellers'] }
        : { href: '/start-selling.html', label: 'Start Selling', match: ['/start-selling', '/become-seller'] }),
      { href: '/faq.html', label: 'FAQ', match: ['/faq'] },
    ];
    var cta = variant === 'professional'
      ? { href: '/become-professional-seller.html', label: 'Become a Seller' }
      : { href: '/start-selling.html', label: 'Start Selling' };

    function isActive(l) { return l.match.some(function (m) { return path === m || path === m + '.html' || path.indexOf(m + '/') === 0; }); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    var navLinks = links.map(function (l) {
      var a = isActive(l);
      return '<a href="' + esc(l.href) + '" class="nav-link' + (a ? ' active' : '') + '"' + (a ? ' aria-current="page"' : '') + '>' + esc(l.label) + '</a>';
    }).join('');

    var headerHtml =
      '<div class="header-inner">' +
        '<a href="/" class="brand" aria-label="Advantage.Bid home">Advantage<span>.Bid</span></a>' +
        '<button type="button" class="mobile-menu-btn adv-pubnav-toggle" aria-label="Menu" aria-expanded="false" aria-controls="adv-pubnav-links">&#9776;</button>' +
        '<nav id="adv-pubnav-links" class="header-nav" aria-label="Main navigation">' + navLinks + '</nav>' +
        '<div class="header-actions"><a class="btn-cta" href="' + esc(cta.href) + '">' + esc(cta.label) + '</a></div>' +
      '</div>';

    var header = document.createElement('header');
    header.className = 'adv-pubnav';
    header.innerHTML = headerHtml;

    if (mount && mount.parentNode) mount.parentNode.replaceChild(header, mount);
    else document.body.insertBefore(header, document.body.firstChild);

    // Self-contained mobile toggle (no dependency on marketplace-components.js). Mirrors the
    // marketplace.css contract: below 920px .header-nav is hidden until .mobile-open is set.
    var btn = header.querySelector('.adv-pubnav-toggle');
    var nav = header.querySelector('.header-nav');
    if (btn && nav) {
      btn.addEventListener('click', function () {
        var open = nav.classList.toggle('mobile-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // Fallback CSS so the hamburger works even if a page lacks the marketplace.css mobile rules.
    if (!document.getElementById('adv-pubnav-style')) {
      var st = document.createElement('style');
      st.id = 'adv-pubnav-style';
      st.textContent =
        '.adv-pubnav .adv-pubnav-toggle{display:none;background:none;border:0;font-size:1.4rem;cursor:pointer;line-height:1}' +
        '@media(max-width:920px){' +
        '.adv-pubnav .adv-pubnav-toggle{display:inline-block}' +
        '.adv-pubnav .header-nav{display:none;flex-direction:column;width:100%}' +
        '.adv-pubnav .header-nav.mobile-open{display:flex}' +
        '}';
      document.head.appendChild(st);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
