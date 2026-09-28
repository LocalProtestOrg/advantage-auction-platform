/*
 * Sasha help button — one loader for bid.advantage.bid AND www.advantage.bid (Brilliant Directories).
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
    var css = document.createElement('style');
    css.textContent =
      '.sasha-btn{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:2147483000;width:60px;height:60px;border-radius:50%;'
      + 'background:#D9534F;color:#fff;border:0;box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center;'
      + 'transition:transform .15s ease,background .15s ease}'
      + '.sasha-btn:hover{background:#b8403c;transform:translateY(-2px)}.sasha-btn:focus-visible{outline:3px solid #006FBB;outline-offset:3px}'
      + '.sasha-btn svg{width:30px;height:30px}'
      + '.sasha-frame{position:fixed;right:18px;bottom:calc(88px + env(safe-area-inset-bottom,0px));z-index:2147483001;width:380px;height:min(600px,calc(100vh - 110px));'
      + 'border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);background:#fff;display:none}'
      + '.sasha-frame.open{display:block}'
      + '@media (max-width:520px){.sasha-frame{right:0;left:0;bottom:0;top:0;width:100%;height:100%;border-radius:0}'
      + '.sasha-open .sasha-btn{display:none}}'
      + '@media (prefers-reduced-motion:reduce){.sasha-btn{transition:none}}';
    document.head.appendChild(css);

    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'sasha-btn';
    btn.setAttribute('aria-label', 'Help — chat with Sasha'); btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Help';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17h.01"/></svg>';
    document.body.appendChild(btn);

    var frame = null;
    function open() {
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'sasha-frame'; frame.title = 'Chat with Sasha, Advantage.Bid customer service';
        frame.src = BASE + '/widgets/sasha.html?site=' + SITE;
        frame.setAttribute('allow', 'clipboard-write');
        document.body.appendChild(frame);
      }
      frame.classList.add('open'); document.documentElement.classList.add('sasha-open');
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      if (frame) frame.classList.remove('open');
      document.documentElement.classList.remove('sasha-open');
      btn.setAttribute('aria-expanded', 'false'); btn.focus();
    }
    btn.addEventListener('click', function () { if (frame && frame.classList.contains('open')) close(); else open(); });
    window.addEventListener('message', function (e) {
      if (e.origin === BASE && e.data && e.data.sasha === 'close') close();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && frame && frame.classList.contains('open')) close(); });
  }
})();
