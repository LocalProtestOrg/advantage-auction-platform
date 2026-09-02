/* Advantage.Bid white-label company auction widget — loader (safe to publish on any company website).
   Install:
     <div data-advantage-auctions data-key="wgt_..."></div>
     <script src="https://bid.advantage.bid/widgets/company-auctions.js" async></script>
   The data-key is an OPAQUE public token (no secret). This loader creates a cross-origin iframe to the
   white-label host and auto-resizes it via a STRICTLY VALIDATED postMessage handshake (message must come
   from THIS widget origin AND from the specific iframe's contentWindow AND carry only a numeric height).
   The iframe is browser-isolated from the host page; the only channel is that validated height message. */
(function () {
  var KEY_RE = /^wgt_[a-f0-9]{36}$/;

  function widgetOrigin() {
    var s = document.currentScript;
    if (!s) { var all = document.getElementsByTagName('script'); s = all[all.length - 1]; }
    try { return new URL(s.src).origin; } catch (e) { return 'https://bid.advantage.bid'; }
  }
  var ORIGIN = widgetOrigin();

  function mount(el) {
    if (el.getAttribute('data-adv-wl-mounted')) return;
    el.setAttribute('data-adv-wl-mounted', '1');
    var key = (el.getAttribute('data-key') || '').trim();
    if (!KEY_RE.test(key)) return; // invalid/absent key → render nothing (never inject arbitrary URLs)
    var iframe = document.createElement('iframe');
    iframe.src = ORIGIN + '/embed/auctions.html?key=' + encodeURIComponent(key);
    iframe.title = 'Auctions';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.minHeight = '320px';
    el.appendChild(iframe);
    el._advIframe = iframe;
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN) return;                                   // only our widget origin
    var d = e.data;
    if (!d || d.type !== 'adv-wl-height' || typeof d.height !== 'number') return;
    var h = Math.max(120, Math.min(20000, d.height | 0));              // clamp to a sane range
    var nodes = document.querySelectorAll('[data-adv-wl-mounted="1"]');
    for (var i = 0; i < nodes.length; i++) {
      var f = nodes[i]._advIframe;
      if (f && f.contentWindow === e.source) { f.style.height = h + 'px'; break; }  // match the exact sender
    }
  }, false);

  function init() {
    var els = document.querySelectorAll('[data-advantage-auctions][data-key]');
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
