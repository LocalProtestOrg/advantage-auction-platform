// return-to-auction.js — persistent "RETURN TO AUCTION" anchor so a buyer never feels stranded away
// from the live auction they're participating in (OAT Issue 6).
//
// Live auction pages call ReturnToAuction.set({id,title,endTime}) on load (and .clear() when the
// auction closes). Every OTHER member page lazy-loads this script (via buyer-nav / the member shell)
// and, if a non-stale active auction is remembered AND we're not currently on that auction/lot page,
// renders a fixed red button linking back. Reuses the Advantage red (#d62828) and the ab_* storage
// convention already used on the homepage. No API, no dependency.
(function () {
  'use strict';
  var KEY = 'ab_active_auction';
  var RED = '#d62828';

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function stale(a) {
    if (!a || !a.id) return true;
    if (a.endTime) { var t = new Date(a.endTime).getTime(); if (!isNaN(t) && Date.now() > t + 10 * 60000) return true; } // 10m grace past close
    if (a.ts && Date.now() - a.ts > 12 * 3600 * 1000) return true; // forget after 12h
    return false;
  }
  // Are we currently ON the remembered auction (its catalog or one of its lots)? Then no button.
  function onThatAuction(a) {
    try {
      var p = location.pathname, q = location.search;
      if (p.indexOf('/auction-view.html') === 0 && q.indexOf(a.id) !== -1) return true;
      if (p.indexOf('/lot.html') === 0 && (a.id ? false : false)) return true; // lot pages set/refresh instead
      return false;
    } catch (e) { return false; }
  }

  var api = {
    set: function (a) {
      if (!a || !a.id) return;
      write({ id: a.id, title: a.title || 'the auction', href: '/auction-view.html?auctionId=' + encodeURIComponent(a.id), endTime: a.endTime || null, ts: Date.now() });
    },
    clear: function () { try { localStorage.removeItem(KEY); } catch (e) {} var el = document.getElementById('rta-btn'); if (el) el.remove(); },
    render: function () {
      if (window.RTA_SUPPRESS) return;   // live auction/lot pages set+clear but render their own nav
      if (document.getElementById('rta-btn')) return;
      var a = read();
      if (stale(a)) { if (a) api.clear(); return; }
      if (onThatAuction(a)) return;
      var wrap = document.createElement('a');
      wrap.id = 'rta-btn';
      wrap.href = a.href;
      wrap.setAttribute('aria-label', 'Return to the auction you are participating in');
      wrap.textContent = '↩ Return to auction';
      wrap.style.cssText = 'position:fixed;right:14px;bottom:max(14px,env(safe-area-inset-bottom));z-index:2147483000;'
        + 'background:' + RED + ';color:#fff;font:700 14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
        + 'text-decoration:none;padding:11px 16px;border-radius:999px;box-shadow:0 6px 20px -6px rgba(0,0,0,.5);'
        + 'display:inline-flex;align-items:center;gap:6px';
      // keep clear of a mobile bottom-nav if one exists
      if (document.querySelector('.adv-bottomnav')) wrap.style.bottom = 'calc(72px + env(safe-area-inset-bottom))';
      (document.body || document.documentElement).appendChild(wrap);
    }
  };

  window.ReturnToAuction = api;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.render);
  else api.render();
})();
