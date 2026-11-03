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
    if (!d || typeof d !== 'object') return;
    var f = null, nodes = document.querySelectorAll('[data-adv-wl-mounted="1"]');
    for (var i = 0; i < nodes.length; i++) { if (nodes[i]._advIframe && nodes[i]._advIframe.contentWindow === e.source) { f = nodes[i]._advIframe; break; } }  // the exact sender
    if (!f) return;
    if (d.type === 'adv-wl-height' && typeof d.height === 'number') {
      var h = Math.max(120, Math.min(20000, d.height | 0));            // clamp to a sane range
      f._advHeight = h;
      if (!f._advFull) f.style.height = h + 'px';
    } else if (d.type === 'adv-wl-top') {
      // the shopper opened another view (catalog, lot): bring the top of the widget into view if it is above the screen
      try { if (f.getBoundingClientRect().top < 0) f.scrollIntoView({ block: 'start' }); } catch (err) { /* older browsers */ }
    } else if (d.type === 'adv-wl-viewer' && typeof d.open === 'boolean') {
      // the photo viewer: the frame fills the screen while it is open (only this frame, only its own size and position)
      f._advFull = d.open;
      if (d.open) { f.style.position = 'fixed'; f.style.top = '0'; f.style.left = '0'; f.style.width = '100%'; f.style.height = '100%'; f.style.zIndex = '2147483000'; }
      else { f.style.position = ''; f.style.top = ''; f.style.left = ''; f.style.width = '100%'; f.style.zIndex = ''; f.style.height = (f._advHeight || 320) + 'px'; }
    }
  }, false);

  function init() {
    var els = document.querySelectorAll('[data-advantage-auctions][data-key]');
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
