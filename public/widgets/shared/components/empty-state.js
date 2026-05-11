/**
 * AAPComponents.EmptyState — empty results message element
 *
 * Usage:
 *   var el = AAPComponents.EmptyState({ message: 'No auctions found.' });
 *
 * Options:
 *   message {string} — display text
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.EmptyState) return;

  if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();

  function injectStyles() {
    if (document.getElementById('aapc-state-styles')) return;
    var css = [
      '.aapc-empty{color:var(--aapc-sub,#64748b);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        'font-size:14px;padding:8px 0;margin:0;}',
      '.aapc-error{color:var(--aapc-err,#dc2626);',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        'font-size:14px;padding:8px 0;margin:0;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-state-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  window.AAPComponents.EmptyState = function (opts) {
    if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();
    injectStyles();

    var o = opts || {};
    var p = document.createElement('p');
    p.className = 'aapc-empty';
    p.setAttribute('role', 'status');
    p.textContent = o.message || 'No results available.';
    return p;
  };

})();
