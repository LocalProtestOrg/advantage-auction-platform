/**
 * AAPComponents.SellerCta - seller call-to-action card
 *
 * Reads configuration from AAPConfig if available, with per-call overrides.
 * All copy and URL values come from config - nothing is hardcoded.
 *
 * Usage:
 *   var el = AAPComponents.SellerCta({
 *     config: window.AAPConfig,   // optional - provides defaults
 *     url:      'https://...',    // overrides config
 *     headline: 'Consigning?',   // overrides config
 *     subtext:  'We can help.', // overrides config
 *     label:    'Get Started',   // overrides config
 *     onCtaClick: function(e) { ... },
 *   });
 *
 * Options:
 *   config     {object}   - AAPConfig instance (optional)
 *   url        {string}   - CTA link href (required; falls back to config.marketplace.cta.url)
 *   headline   {string}   - card headline
 *   subtext    {string}   - supporting copy under headline
 *   label      {string}   - button label
 *   onCtaClick {function} - called when button is clicked (before navigation)
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.SellerCta) return;

  if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();

  function injectCtaStyles() {
    if (document.getElementById('aapc-cta-styles')) return;
    var css = [
      '.aapc-cta{border:2px dashed var(--aapc-cta-bdr,#3b82f6);border-radius:10px;',
        'background:var(--aapc-bg2,#f8fafc);display:flex;flex-direction:column;',
        'align-items:center;justify-content:center;padding:32px 20px;text-align:center;',
        'min-height:220px;box-sizing:border-box;}',
      '.aapc-cta-head{font-size:17px;font-weight:700;color:var(--aapc-fg,#1e293b);',
        'margin:0 0 8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.aapc-cta-sub{font-size:13px;color:var(--aapc-sub,#64748b);margin:0 0 20px;',
        'line-height:1.6;max-width:240px;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.aapc-cta-btn{display:inline-block;padding:10px 22px;background:#2563eb;color:#fff;',
        'border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;',
        'transition:background .15s;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '.aapc-cta-btn:hover{background:#1d4ed8;}',
      '.aapc-cta-btn:focus-visible{outline:2px solid #93c5fd;outline-offset:2px;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-cta-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cfgGet(config, key, fallback) {
    return config && typeof config.get === 'function' ? config.get(key, fallback) : fallback;
  }

  window.AAPComponents.SellerCta = function (opts) {
    if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();
    injectCtaStyles();

    var o       = opts || {};
    var cfg     = o.config || null;
    var url     = o.url      != null ? o.url      : cfgGet(cfg, 'marketplace.cta.url', null);
    var headline = o.headline != null ? o.headline : cfgGet(cfg, 'marketplace.cta.headline', 'Consigning an Estate?');
    var subtext  = o.subtext  != null ? o.subtext  : cfgGet(cfg, 'marketplace.cta.subtext', 'We auction estates, collections, and commercial inventory nationwide.');
    var label    = o.label    != null ? o.label    : cfgGet(cfg, 'marketplace.cta.label', 'Learn More');

    var card = document.createElement('div');
    card.className = 'aapc-cta';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', 'Seller information');

    card.innerHTML =
      '<p class="aapc-cta-head">' + esc(headline) + '</p>' +
      '<p class="aapc-cta-sub">'  + esc(subtext)  + '</p>' +
      '<a class="aapc-cta-btn"' +
         ' href="' + esc(url || '#') + '"' +
         ' target="_blank"' +
         ' rel="noopener noreferrer">' +
        esc(label) +
      '</a>';

    if (typeof o.onCtaClick === 'function') {
      card.querySelector('.aapc-cta-btn').addEventListener('click', o.onCtaClick);
    }

    return card;
  };

})();
