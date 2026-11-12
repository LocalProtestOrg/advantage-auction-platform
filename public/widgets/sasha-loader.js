/*
 * Sasha help button: one loader for bid.advantage.bid AND www.advantage.bid (Brilliant Directories).
 *
 *   <script src="https://bid.advantage.bid/widgets/sasha-loader.js" async></script>
 *
 * Draws a red floating help button; clicking it opens Sasha (an iframe served from bid.advantage.bid, so the same chat
 * and the same session work on both sites). Loads after the page, touches nothing else on it (no SEO/structured-data
 * impact), and shows NOTHING when chat is switched off for that site or on the live bidding pages.
 */
(function () {
  if (window.__sashaLoader) return; window.__sashaLoader = 1;
  var BASE = 'https://bid.advantage.bid';
  try { var s = document.currentScript && document.currentScript.src; if (s) BASE = new URL(s).origin; } catch (e) {}
  var host = location.hostname.toLowerCase();
  var SITE = /(^|\.)bid\.advantage\.bid$/.test(host) || host === 'localhost' || /railway\.app$/.test(host) ? 'bid' : 'www';

  // Never on the live bidding experience (lot pages and the auction catalog / bidding view), or inside frames.
  var p = location.pathname.toLowerCase();
  var LIVE_BIDDING = [/^\/lot(\.html)?$/, /^\/lots?\//, /^\/auction-view(\.html)?$/, /^\/auction\/[^/]+\/live/, /^\/live(-|\/|\.html|$)/];
  if (LIVE_BIDDING.some(function (re) { return re.test(p); })) return;
  if (window.top !== window.self) return;

  function ready(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }
  ready(function () {
    fetch(BASE + '/api/public/sasha/config?site=' + SITE, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.enabled) mount(); })
      .catch(function () {});
  });

  function mount() {
    // Phones (owner 2026-11-12): a compact button that sits ABOVE anything fixed along the bottom of the screen (the
    // dashboard's bottom menu, a page's own bottom actions) instead of on top of it; room reserved at the end of the page
    // so its last controls can scroll clear of the button; and an open chat that is a full-screen sheet sized to what is
    // actually visible (on-screen keyboard included), with the page behind it unable to move sideways.
    var css = document.createElement('style');
    css.textContent =
      '.sasha-btn{position:fixed;right:calc(18px + env(safe-area-inset-right,0px));bottom:calc(var(--sasha-lift,0px) + 18px + env(safe-area-inset-bottom,0px));'
      + 'z-index:2147483000;width:60px;height:60px;margin:0;padding:0;border-radius:50%;'
      + 'background:#D9534F;color:#fff;border:0;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center;'
      + 'transition:transform .15s ease,background .15s ease}'
      + '.sasha-btn:hover{background:#b8403c;transform:translateY(-2px)}.sasha-btn:focus-visible{outline:3px solid #006FBB;outline-offset:3px}'
      + '.sasha-btn svg{width:30px;height:30px}'
      + '.sasha-frame{position:fixed;right:18px;bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147483001;width:380px;max-width:calc(100% - 36px);'
      + 'height:min(600px,calc(100vh - 110px));border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);background:#fff;display:none}'
      + '.sasha-frame.open{display:block}'
      + '@media (max-width:768px){.sasha-btn{width:46px;height:46px;right:calc(12px + env(safe-area-inset-right,0px));'
      + 'bottom:calc(var(--sasha-lift,0px) + 12px + env(safe-area-inset-bottom,0px));box-shadow:0 4px 12px rgba(0,0,0,.25)}'
      + '.sasha-btn svg{width:24px;height:24px}'
      + 'html.sasha-room body{padding-bottom:calc(var(--sasha-lift,0px) + 70px + env(safe-area-inset-bottom,0px))}}'
      + '@media (max-width:520px){.sasha-frame{left:0;right:0;top:0;bottom:auto;width:100%;max-width:100%;height:100%;height:100dvh;border-radius:0;box-shadow:none}'
      + 'html.sasha-open,html.sasha-open body{overflow:hidden;overscroll-behavior:none}'
      + '.sasha-open .sasha-btn{display:none}}'
      + '@media (prefers-reduced-motion:reduce){.sasha-btn{transition:none}}';
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sasha-btn';
    btn.setAttribute('aria-label', 'Help: chat with Sasha'); btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Help';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/></svg>';
    document.body.appendChild(btn);
    var root = document.documentElement, frame = null;
    root.classList.add('sasha-room');

    // Lift the button above anything fixed or sticky along the bottom of the screen under it (bottom menus, action bars,
    // banners), measured on the live page, so every buyer, seller and admin page is covered without per-page settings.
    function bottomBar(el) {
      for (var n = el; n && n !== document.body && n !== root; n = n.parentElement) {
        if (n === btn || n === frame) return null;
        var pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') {
          var r = n.getBoundingClientRect();
          return (r.height > 0 && r.top > window.innerHeight * 0.45) ? r : null;   // a bar, not a full-screen sheet or dialog
        }
      }
      return null;
    }
    function place() {
      if (!document.elementsFromPoint) return;
      root.style.setProperty('--sasha-lift', '0px');
      var lift = 0, pad = 6;
      for (var i = 0; i < 4; i++) {
        var b = btn.getBoundingClientRect(), top = Infinity;
        if (!b.width) return;
        var xs = [b.left - pad, b.left + b.width / 2, b.right + pad], ys = [b.top - pad, b.top + b.height / 2, b.bottom + pad];
        for (var x = 0; x < 3; x++) for (var y = 0; y < 3; y++) {
          var hits = document.elementsFromPoint(Math.min(Math.max(xs[x], 0), window.innerWidth - 1), Math.min(Math.max(ys[y], 0), window.innerHeight - 1));
          for (var h = 0; h < hits.length; h++) { var r = bottomBar(hits[h]); if (r && r.top < top) top = r.top; }
        }
        if (top >= b.bottom + pad) break;
        lift += (b.bottom + pad + 2) - top;
        root.style.setProperty('--sasha-lift', Math.ceil(lift) + 'px');
      }
    }
    var queued = 0;
    function schedule() { if (queued) return; queued = setTimeout(function () { queued = 0; try { place(); } catch (e) {} }, 120); }
    schedule(); [600, 1500, 4000].forEach(function (t) { setTimeout(schedule, t); });
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] }); } catch (e) {}

    // On a phone the open chat follows the visible area, so the message box stays above the on-screen keyboard.
    function fit() {
      if (!frame) return;
      var vv = window.visualViewport;
      if (vv && frame.classList.contains('open') && window.innerWidth <= 520) { frame.style.height = vv.height + 'px'; frame.style.top = vv.offsetTop + 'px'; }
      else { frame.style.height = ''; frame.style.top = ''; }
    }
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fit); window.visualViewport.addEventListener('scroll', fit); }
    function open() {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'sasha-frame'; frame.title = 'Chat with Sasha, Advantage.Bid customer service';
        frame.src = BASE + '/widgets/sasha.html?site=' + SITE;
        frame.setAttribute('allow', 'clipboard-write');
        document.body.appendChild(frame);
      }
      frame.classList.add('open'); root.classList.add('sasha-open');
      btn.setAttribute('aria-expanded', 'true');
      fit();
    }
    function close() {
      if (frame) frame.classList.remove('open');
      root.classList.remove('sasha-open');
      fit();
      btn.setAttribute('aria-expanded', 'false'); btn.focus();
      schedule();
    }
    btn.addEventListener('click', function () { if (frame && frame.classList.contains('open')) close(); else open(); });
    window.addEventListener('message', function (e) {
      if (e.origin === BASE && e.data && e.data.sasha === 'close') close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && frame && frame.classList.contains('open')) close(); });
  }
})();
