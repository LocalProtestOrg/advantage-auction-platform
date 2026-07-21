/**
 * Advantage Gallery — reusable image gallery + lightbox (platform component).
 *
 * Shared across the Advantage platform: Marketplace Events use it first; Auctions/Lots can adopt
 * the same component so both products share one gallery system. Dependency-free, CSP-safe (no
 * external libraries), keyboard + touch aware.
 *
 * Usage:  AdvantageGallery.mount(el, images, opts)
 *   images: ['https://…'] or [{ url }]
 *   opts:   { alt?: string, start?: number }
 * Returns { destroy }.
 */
(function () {
  'use strict';

  var STYLE_ID = 'ag-styles';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.ag{display:flex;flex-direction:column;gap:10px}',
      '.ag-main{position:relative;aspect-ratio:16/10;max-height:520px;border-radius:16px;overflow:hidden;background:#eef0f3 center/cover no-repeat;cursor:zoom-in;border:1px solid rgba(0,0,0,.06)}',
      '.ag-count{position:absolute;bottom:10px;right:12px;background:rgba(8,16,28,.66);color:#fff;font:600 12px/1 system-ui,sans-serif;padding:6px 9px;border-radius:999px}',
      '.ag-thumbs{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}',
      '.ag-thumb{flex:0 0 auto;width:84px;height:64px;border-radius:10px;background:#eef0f3 center/cover no-repeat;cursor:pointer;border:2px solid transparent;opacity:.72;transition:opacity .12s,border-color .12s}',
      '.ag-thumb:hover{opacity:1}',
      '.ag-thumb.ag-on{opacity:1;border-color:#2F6BFF}',
      '.ag-lb{position:fixed;inset:0;z-index:9999;background:rgba(8,12,20,.94);display:none;align-items:center;justify-content:center}',
      '.ag-lb.ag-open{display:flex}',
      '.ag-lb-img{max-width:92vw;max-height:86vh;object-fit:contain;border-radius:8px;user-select:none}',
      '.ag-nav{position:absolute;top:50%;transform:translateY(-50%);width:52px;height:52px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:26px;cursor:pointer}',
      '.ag-nav:hover{background:rgba(255,255,255,.26)}',
      '.ag-prev{left:16px}.ag-next{right:16px}',
      '.ag-close{position:absolute;top:16px;right:18px;width:44px;height:44px;border:0;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:22px;cursor:pointer}',
      '.ag-lb-count{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#dfe6ee;font:600 13px/1 system-ui,sans-serif}',
      '@media (max-width:640px){.ag-nav{width:44px;height:44px;font-size:22px}}',
      '@media (prefers-reduced-motion: reduce){.ag-thumb{transition:none}}'
    ].join('');
    document.head.appendChild(s);
  }

  function urlOf(x) { return typeof x === 'string' ? x : (x && x.url) || ''; }

  function mount(elOrSel, images, opts) {
    injectStyles();
    var root = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
    if (!root) return { destroy: function () {} };
    opts = opts || {};
    var urls = (images || []).map(urlOf).filter(Boolean);
    if (!urls.length) { root.innerHTML = ''; return { destroy: function () {} }; }

    var i = Math.min(Math.max(opts.start || 0, 0), urls.length - 1);
    var alt = opts.alt || '';

    root.className = 'ag';
    var multi = urls.length > 1;
    root.innerHTML =
      '<div class="ag-main" role="button" tabindex="0" aria-label="Open photo">'
      + (multi ? '<span class="ag-count"></span>' : '') + '</div>'
      + (multi ? '<div class="ag-thumbs"></div>' : '');

    var main = root.querySelector('.ag-main');
    var countEl = root.querySelector('.ag-count');
    var thumbs = root.querySelector('.ag-thumbs');

    // Lightbox (one per page, appended to body)
    var lb = document.createElement('div');
    lb.className = 'ag-lb';
    lb.innerHTML =
      '<button class="ag-close" aria-label="Close">✕</button>'
      + (multi ? '<button class="ag-nav ag-prev" aria-label="Previous">‹</button>' : '')
      + '<img class="ag-lb-img" alt="' + alt.replace(/"/g, '&quot;') + '">'
      + (multi ? '<button class="ag-nav ag-next" aria-label="Next">›</button>' : '')
      + (multi ? '<div class="ag-lb-count"></div>' : '');
    document.body.appendChild(lb);
    var lbImg = lb.querySelector('.ag-lb-img');
    var lbCount = lb.querySelector('.ag-lb-count');

    function setMain() {
      main.style.backgroundImage = "url('" + urls[i].replace(/'/g, "%27") + "')";
      if (countEl) countEl.textContent = (i + 1) + ' / ' + urls.length;
      if (thumbs) Array.prototype.forEach.call(thumbs.children, function (t, k) { t.classList.toggle('ag-on', k === i); });
    }
    function setLb() {
      lbImg.src = urls[i];
      if (lbCount) lbCount.textContent = (i + 1) + ' / ' + urls.length;
    }
    function go(d) { i = (i + d + urls.length) % urls.length; setMain(); if (lb.classList.contains('ag-open')) setLb(); }
    function open() { setLb(); lb.classList.add('ag-open'); document.addEventListener('keydown', onKey); }
    function close() { lb.classList.remove('ag-open'); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); }

    if (thumbs) {
      urls.forEach(function (u, k) {
        var t = document.createElement('div');
        t.className = 'ag-thumb' + (k === i ? ' ag-on' : '');
        t.style.backgroundImage = "url('" + u.replace(/'/g, "%27") + "')";
        t.addEventListener('click', function () { i = k; setMain(); });
        thumbs.appendChild(t);
      });
    }

    main.addEventListener('click', open);
    main.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    lb.querySelector('.ag-close').addEventListener('click', close);
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    var prev = lb.querySelector('.ag-prev'), next = lb.querySelector('.ag-next');
    if (prev) prev.addEventListener('click', function () { go(-1); });
    if (next) next.addEventListener('click', function () { go(1); });

    // Touch swipe on the lightbox
    var sx = null;
    lb.addEventListener('touchstart', function (e) { sx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (sx == null) return; var dx = e.changedTouches[0].clientX - sx; sx = null;
      if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
    });

    setMain();
    return { destroy: function () { close(); if (lb.parentNode) lb.parentNode.removeChild(lb); root.innerHTML = ''; } };
  }

  window.AdvantageGallery = { mount: mount };
})();
