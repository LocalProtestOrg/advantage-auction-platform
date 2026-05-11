/**
 * AAPComponents.ErrorState — API/network error message element
 *
 * Usage:
 *   var el = AAPComponents.ErrorState({ message: 'Unable to load. Try again later.' });
 *
 * Options:
 *   message {string} — display text
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.ErrorState) return;

  // Piggybacks on the same aapc-state-styles block as EmptyState (idempotent injection)
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

  window.AAPComponents.ErrorState = function (opts) {
    if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();
    injectStyles();

    var o = opts || {};
    var p = document.createElement('p');
    p.className = 'aapc-error';
    p.setAttribute('role', 'alert');
    p.textContent = o.message || 'Unable to load. Please try again later.';
    return p;
  };

})();
