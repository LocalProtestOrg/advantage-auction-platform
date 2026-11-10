/* seller-page-chrome.js: the seller dashboard frame on every seller page (owner 2026-11-10).
 *
 * Puts the SAME shared dashboard frame the dashboard uses (member-chrome.js: the dark sidebar with the Buying / Selling
 * switch on desktop; the header switch, bottom bar and full seller Menu on a phone) around a standalone seller page such
 * as My Storefront, Manage Inventory, Orders, Create Auction, Payouts and Auction Payments. No second navigation system:
 * the menu, its sections, who sees what and the sign-in rules all come from member-nav-config.js / member-chrome.js and
 * the server.
 *
 * The page's own content node (its first top-level .wrap) is moved, not copied, into the frame, so its scripts, event
 * handlers and anything already typed are kept. The page's own heading stays; the frame's header says "Seller Dashboard"
 * so the two never repeat each other. The buyer top bar some pages carry is not shown inside the frame.
 *
 * Include after member-nav-config.js and member-chrome.js. Pages with tabs (My Storefront) keep the matching menu item
 * highlighted as the tab changes.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__advSellerChrome) return;
  window.__advSellerChrome = true;
  window.__buyerNavInstalled = true;   // the frame replaces the buyer top bar on these pages

  var STOREFRONT = '/seller-storefront.html';
  var TAB_ITEMS = { store: 'store', market: 'market', widget: 'widget' };   // tabs that have their own menu item
  function storefrontHref(tab) { return STOREFRONT + '?tab=' + (TAB_ITEMS[tab] || 'store'); }
  function currentHref() {
    if (location.pathname === STOREFRONT) {
      var t = null; try { t = new URLSearchParams(location.search).get('tab'); } catch (e) {}
      return storefrontHref(t);
    }
    return location.pathname;
  }
  function ensureCss() {
    if (document.querySelector('link[href="/widgets/shared/advantage-ds.css"]')) return;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/widgets/shared/advantage-ds.css';
    document.head.appendChild(l);
  }

  async function mount() {
    if (!window.AdvChrome || !window.AdvNav) return;
    var content = document.querySelector('body > .wrap') || document.querySelector('[data-seller-page]');
    if (!content) return;
    if (!content.id) content.id = 'seller-page-content';
    ensureCss();
    var st = document.createElement('style'); st.id = 'adv-seller-frame-css';
    // Some seller pages style bare elements (body padding, every button, every header). Inside the frame those rules
    // must not reach the sidebar, header or phone menu.
    // The frame's own look (advantage-ds.css) restated at a higher specificity, for the framed page only.
    var F = 'body.adv-framed ';
    st.textContent = 'body.adv-framed{padding:0;margin:0}' + F + '.adv-main{min-width:0}'
      + [' .adv-rail', ' .adv-header', ' .adv-bottomnav', ' .adv-moresheet'].map(function (r) { return 'body.adv-framed' + r + ' button'; }).join(',')
      + '{margin:0;box-shadow:none;text-transform:none;letter-spacing:normal;line-height:normal;min-height:0;width:auto}'   // the frame only, never the page's own buttons
      + F + '.adv .adv-nav-item{padding:9px 11px;border:0;background:transparent;font-size:14px;font-weight:600;width:100%;text-decoration:none;color:#aab6cc}'
      + F + '.adv-rail .adv-nav-item:hover,' + F + '.adv-rail .adv-nav-item[aria-current="page"]{color:#fff}'
      + F + '.adv-rail .adv-nav-item[aria-current="page"]{background:rgba(91,139,255,.16)}'
      + F + '.adv-bottomnav .adv-nav-item,' + F + '.adv-moresheet .adv-nav-item{color:var(--text-2)}'
      + F + '.adv-bottomnav .adv-nav-item[aria-current="page"],' + F + '.adv-moresheet .adv-nav-item[aria-current="page"]{color:var(--accent)}'
      + F + '.adv-moresheet .adv-nav-item{padding:11px 12px}'
      + '@media (max-width:860px){' + F + '.adv-bottomnav .adv-nav-item{padding:6px 2px;font-size:10.5px}}'
      + F + '.adv-header .adv-icon-btn{width:38px;height:38px;padding:0;border-radius:11px;border:1px solid var(--line);background:var(--surface);color:var(--text-2);font-size:16px}'
      + F + '.adv .adv-mode-opt{padding:7px 10px;border:0;border-radius:999px;background:transparent;font-size:13px;font-weight:700;width:auto}'
      + F + '.adv .adv-mode-opt.on{background:#fff}'
      + F + '.adv-header .adv-mode-mini .adv-mode-opt{padding:5px 10px;border:1px solid rgba(15,23,42,.15);background:#fff;color:#0f172a}'
      + F + '.adv-moresheet-close{padding:5px 12px;border:1px solid rgba(15,23,42,.15);background:#fff;color:#0f172a;border-radius:999px;font-size:13px}'
      + F + '.adv-header h1{font-size:18px;font-weight:800;margin:0;font-family:inherit}';
    document.head.appendChild(st);
    document.body.classList.add('adv-framed');
    var root = document.createElement('div'); root.id = 'adv-shell-root';
    document.body.insertBefore(root, document.body.firstChild);
    var ctx = await window.AdvChrome.mountStandalone({ rootId: 'adv-shell-root', contentId: content.id, activeHref: currentHref(), title: 'Seller Dashboard' });
    if (!ctx) return;
    var bn = document.getElementById('buyer-nav'); if (bn && bn.parentNode) bn.parentNode.removeChild(bn);
    // My Storefront's tabs: keep the menu highlight on the tab being shown
    if (location.pathname === STOREFRONT && typeof window.tab === 'function') {
      var orig = window.tab;
      window.tab = function (n) { var r = orig.apply(this, arguments); window.AdvChrome.setActiveHref(storefrontHref(n)); return r; };
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
