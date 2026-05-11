/**
 * AAPComponents.Badge — status/type badge element
 *
 * Usage:
 *   var el = AAPComponents.Badge({ text: 'LIVE NOW', variant: 'live' });
 *   container.appendChild(el);
 *
 * Options:
 *   text      {string}  — badge label
 *   variant   {string}  — 'live' | 'upcoming' | 'ships' | 'ending-soon' | 'custom'
 *   className {string}  — additional CSS classes (optional)
 *   ariaLabel {string}  — aria-label override (optional, defaults to text)
 */

window.AAPComponents = window.AAPComponents || {};

(function () {
  'use strict';
  if (window.AAPComponents.Badge) return;

  // ── Root CSS variables — injected once, shared by all components ───────────
  // The host grid element must carry class "aapc-root" (and "aapc-dark" for dark theme).
  // These variables cascade to all child component elements.
  function injectRootStyles() {
    if (document.getElementById('aapc-root-styles')) return;
    var css = [
      '.aapc-root{',
        '--aapc-bg:#ffffff;--aapc-bg2:#f8fafc;--aapc-fg:#1e293b;--aapc-sub:#64748b;',
        '--aapc-bdr:#e2e8f0;--aapc-live:#16a34a;--aapc-up:#3b82f6;--aapc-ship:#0891b2;',
        '--aapc-soon:#ea580c;--aapc-dist:#0284c7;--aapc-cta-bdr:#3b82f6;',
        '--aapc-skel:#e2e8f0;--aapc-err:#dc2626;--aapc-img-h:168px;',
      '}',
      '.aapc-root.aapc-dark{',
        '--aapc-bg:#1e293b;--aapc-bg2:#0f172a;--aapc-fg:#f1f5f9;--aapc-sub:#94a3b8;',
        '--aapc-bdr:#334155;--aapc-live:#166534;--aapc-up:#1d4ed8;--aapc-ship:#164e63;',
        '--aapc-soon:#c2410c;--aapc-dist:#38bdf8;--aapc-cta-bdr:#1d4ed8;',
        '--aapc-skel:#334155;--aapc-err:#f87171;',
      '}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-root-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function injectBadgeStyles() {
    if (document.getElementById('aapc-badge-styles')) return;
    var css = [
      '.aapc-badge{display:inline-block;padding:2px 8px;border-radius:4px;',
        'font-size:11px;font-weight:600;letter-spacing:.04em;line-height:1.6;}',
      '.aapc-badge-live{background:var(--aapc-live,#16a34a);color:#fff;}',
      '.aapc-badge-upcoming{background:var(--aapc-up,#3b82f6);color:#fff;}',
      '.aapc-badge-ships{background:var(--aapc-ship,#0891b2);color:#fff;}',
      '.aapc-badge-ending-soon{background:var(--aapc-soon,#ea580c);color:#fff;}',
      '.aapc-badge-custom{background:var(--aapc-sub,#64748b);color:#fff;}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'aapc-badge-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  window.AAPComponents._injectRootStyles = injectRootStyles;

  window.AAPComponents.Badge = function (opts) {
    injectRootStyles();
    injectBadgeStyles();

    var o       = opts || {};
    var variant = o.variant || 'custom';
    var span    = document.createElement('span');
    span.className = 'aapc-badge aapc-badge-' + variant + (o.className ? ' ' + o.className : '');
    span.setAttribute('aria-label', o.ariaLabel || o.text || '');
    span.textContent = o.text || '';
    return span;
  };

})();
