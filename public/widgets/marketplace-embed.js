/* ============================================================================
   Advantage Marketplace Feed — Brilliant Directories parent embed helper.
   Loaded once on a BD page that embeds one or more marketplace-feed iframes.
   It listens for postMessage from the Railway widget and:
     • resize        → sets the iframe's explicit height (no inner scrollbar)
     • scroll-to-widget → smooth-scrolls the parent to the top of that iframe
   SECURITY: it accepts messages ONLY from https://bid.advantage.bid, ONLY when
   event.source is one of THIS page's registered widget iframes, and ONLY when the
   payload carries the expected source/type/widget fields. No wildcard trust; it
   never reads the widget's cross-origin DOM (postMessage only).

   Embed (per iframe): give the iframe id + data-adv-widget="marketplace-feed",
   then include this script once:
     <iframe id="adv-all-events" data-adv-widget="marketplace-feed"
             src="https://bid.advantage.bid/widgets/marketplace-feed.html?preset=all-events"
             title="Advantage.Bid — All Events" loading="lazy" allow="geolocation"
             style="width:100%;min-height:800px;border:0;display:block"></iframe>
     <script src="https://bid.advantage.bid/widgets/marketplace-embed.js"></script>
   Optional sticky-header offset: <html data-adv-header-offset="90"> (px).
   ========================================================================== */
(function () {
  'use strict';
  var ORIGIN = 'https://bid.advantage.bid';   // the ONLY trusted message origin
  var SRC = 'advantage-bid-widget', WIDGET = 'marketplace-feed';
  var MIN = 400, MAX = 20000;                  // height clamp (px) — sane floor/ceiling

  // PURE decision function (no DOM). Given the parts of a received message, decide what to do.
  // Returns { type:'resize', height } (clamped) | { type:'scroll' } | null (ignore). Exported for tests.
  function decide(evtOrigin, isThisFrame, data, opts) {
    opts = opts || {};
    var min = typeof opts.min === 'number' ? opts.min : MIN;
    var max = typeof opts.max === 'number' ? opts.max : MAX;
    if (evtOrigin !== ORIGIN) return null;                                  // strict origin allowlist
    if (!isThisFrame) return null;                                          // must be one of OUR iframes
    if (!data || data.source !== SRC || data.widget !== WIDGET) return null; // expected envelope
    if (data.type === 'resize') {
      var h = parseInt(data.height, 10);
      if (!isFinite(h)) return null;
      return { type: 'resize', height: Math.max(min, Math.min(max, h)) };   // clamp
    }
    if (data.type === 'scroll-to-widget') return { type: 'scroll' };
    return null;
  }

  function init() {
    var frames = [].slice.call(document.querySelectorAll('iframe[data-adv-widget="' + WIDGET + '"]'));
    if (!frames.length) return;
    var headerOffset = parseInt(document.documentElement.getAttribute('data-adv-header-offset') || '', 10);
    if (!isFinite(headerOffset)) headerOffset = 0;
    window.addEventListener('message', function (e) {
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var action = decide(e.origin, !!f.contentWindow && f.contentWindow === e.source, e.data);
        if (!action) continue;
        if (action.type === 'resize') {
          f.style.minHeight = '0px';                    // release the initial floor so short states shrink
          f.style.height = action.height + 'px';
        } else if (action.type === 'scroll') {
          var y = f.getBoundingClientRect().top + (window.pageYOffset || 0) - headerOffset;
          y = Math.max(0, y);
          try { window.scrollTo({ top: y, behavior: 'smooth' }); } catch (er) { window.scrollTo(0, y); }
        }
        return;                                         // handled by the matching frame
      }
    }, false);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
  // Node/CommonJS test hook — exposes the pure decision fn without running any DOM code.
  if (typeof module !== 'undefined' && module.exports) module.exports = { decide: decide, ORIGIN: ORIGIN, MIN: MIN, MAX: MAX, WIDGET: WIDGET, SRC: SRC };
})();
