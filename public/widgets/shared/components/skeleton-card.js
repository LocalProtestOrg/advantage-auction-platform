/**
 * AAPComponents.SkeletonCard - animated loading placeholder card
 *
 * Usage:
 *   var el = AAPComponents.SkeletonCard({ imageHeight: 168, lines: 4 });
 *
 * Options:
 *   imageHeight {number} - image area height in px (default: 168)
 *   lines       {number} - number of text skeleton lines (default: 4)
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.SkeletonCard) return;

  if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();

  function injectSkeletonStyles() {
    if (document.getElementById('aapc-skeleton-styles')) return;
    var css = [
      '.aapc-skeleton{border:1px solid var(--aapc-bdr,#e2e8f0);border-radius:10px;',
        'overflow:hidden;background:var(--aapc-bg,#ffffff);}',
      '.aapc-skel-img{width:100%;background:var(--aapc-skel,#e2e8f0);',
        'animation:aapc-pulse 1.4s ease-in-out infinite;}',
      '.aapc-skel-body{padding:12px 14px 14px;}',
      '.aapc-skel-line{height:11px;border-radius:4px;background:var(--aapc-skel,#e2e8f0);',
        'margin-bottom:9px;animation:aapc-pulse 1.4s ease-in-out infinite;}',
      '@keyframes aapc-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-skeleton-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  window.AAPComponents.SkeletonCard = function (opts) {
    if (window.AAPComponents._injectRootStyles) window.AAPComponents._injectRootStyles();
    injectSkeletonStyles();

    var o          = opts || {};
    var imgHeight  = o.imageHeight || 168;
    var lineCount  = o.lines || 4;

    var lines = '';
    var widths = ['88%', '65%', '75%', '50%', '80%', '55%'];
    for (var i = 0; i < lineCount; i++) {
      var w = widths[i % widths.length];
      var mb = (i === 0) ? 'margin-bottom:12px;' : '';
      lines += '<div class="aapc-skel-line" style="width:' + w + ';' + mb + '" aria-hidden="true"></div>';
    }

    var card = document.createElement('div');
    card.className = 'aapc-skeleton';
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML =
      '<div class="aapc-skel-img" style="height:' + imgHeight + 'px" aria-hidden="true"></div>' +
      '<div class="aapc-skel-body">' + lines + '</div>';
    return card;
  };

})();
