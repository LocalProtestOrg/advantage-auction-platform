/*
 * AdvGallery — the product photo gallery (standalone item page and the embedded seller storefront).
 *
 *   AdvGallery.mount(container, { images: [url, ...], alts: [text, ...], title: 'Item title' })
 *
 * - The main photo is shown whole (scaled to fit, never cropped); thumbnails switch it.
 * - Clicking the main photo opens a full-screen viewer: Previous / Next, a thumbnail strip, "2 of 5", arrow keys,
 *   Escape to close, swipe on touch screens. Focus moves into the viewer, stays there, and returns to the photo on close.
 * - The viewer is fixed to the window, so inside a website widget it fills the widget's frame (never the host page).
 * - Photos are shown exactly as uploaded (no edits, no generated images). Only http(s) addresses are used.
 * - Built with DOM calls only (no HTML strings), so nothing in a title or caption can become markup.
 */
(function () {
  'use strict';
  if (window.AdvGallery) return;

  var CSS = [
    '.advg{display:flex;flex-direction:column;gap:10px}',
    '.advg-main{position:relative;display:block;width:100%;padding:0;margin:0;border:1px solid #e6eaef;border-radius:14px;background:#f3f5f8;cursor:zoom-in;overflow:hidden;aspect-ratio:4/3}',
    '.advg-main img{width:100%;height:100%;object-fit:contain;display:block}',
    '.advg-main:focus-visible{outline:3px solid #2563eb;outline-offset:2px}',
    '.advg-hint{position:absolute;right:10px;bottom:10px;background:rgba(15,23,42,.72);color:#fff;font:600 13px/1 system-ui,sans-serif;padding:6px 9px;border-radius:999px;pointer-events:none}',
    '.advg-thumbs{display:flex;gap:8px;flex-wrap:wrap}',
    '.advg-thumb{width:68px;height:68px;padding:0;border:2px solid transparent;border-radius:9px;background:#f3f5f8;cursor:pointer;overflow:hidden}',
    '.advg-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.advg-thumb[aria-current="true"]{border-color:#2563eb}',
    '.advg-thumb:focus-visible{outline:3px solid #2563eb;outline-offset:2px}',
    '.advg-box{position:fixed;inset:0;z-index:2147483000;background:rgba(10,14,22,.94);display:flex;flex-direction:column;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '.advg-top{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;flex:none}',
    '.advg-count{font-size:15px;font-weight:600;opacity:.9}',
    '.advg-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 52px;touch-action:pan-y}',
    '.advg-stage img{max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}',
    '.advg-btn{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:999px;width:44px;height:44px;font-size:22px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.advg-btn:hover{background:rgba(255,255,255,.24)}',
    '.advg-btn:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}',
    '.advg-prev,.advg-next{position:absolute;top:50%;transform:translateY(-50%)}',
    '.advg-prev{left:6px}.advg-next{right:6px}',
    '.advg-strip{display:flex;gap:6px;overflow-x:auto;padding:10px 12px;flex:none;justify-content:center}',
    '.advg-strip .advg-thumb{width:56px;height:56px;flex:none;background:#1f2937}',
    '.advg-strip .advg-thumb[aria-current="true"]{border-color:#93c5fd}',
    '.advg-cap{text-align:center;font-size:14px;opacity:.85;padding:0 12px;flex:none}',
    '@media (max-width:560px){.advg-stage{padding:0 4px}.advg-prev,.advg-next{width:40px;height:40px;background:rgba(15,23,42,.6)}.advg-strip .advg-thumb{width:46px;height:46px}}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('advg-css')) return;
    var st = document.createElement('style'); st.id = 'advg-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  function el(tag, cls, attrs) {
    var e = document.createElement(tag); if (cls) e.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function photo(src, alt) { var i = el('img', null, { src: src, alt: alt || '', decoding: 'async' }); return i; }

  function mount(container, opts) {
    if (!container) return null;
    injectCss();
    opts = opts || {};
    var images = (opts.images || []).filter(function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u); });
    var title = opts.title || 'Item';
    var alts = images.map(function (_, i) { var a = (opts.alts || [])[i]; return (a && String(a).trim()) || (i === 0 ? title : title + ' - photo ' + (i + 1)); });
    while (container.firstChild) container.removeChild(container.firstChild);
    var wrap = el('div', 'advg');
    container.appendChild(wrap);
    if (!images.length) {
      var none = el('div', 'advg-main', { role: 'img', 'aria-label': 'No photo available' });
      none.style.cursor = 'default'; none.style.display = 'flex'; none.style.alignItems = 'center'; none.style.justifyContent = 'center';
      none.style.color = '#64748b'; none.textContent = 'No photo available';
      wrap.appendChild(none);
      return { count: 0 };
    }
    var current = 0;
    var main = el('button', 'advg-main', { type: 'button' });
    var mainImg = photo(images[0], alts[0]);
    main.appendChild(mainImg);
    var hint = el('span', 'advg-hint', { 'aria-hidden': 'true' }); hint.textContent = images.length > 1 ? 'View all ' + images.length + ' photos' : 'Enlarge';
    main.appendChild(hint);
    wrap.appendChild(main);
    var thumbs = [];
    if (images.length > 1) {
      var row = el('div', 'advg-thumbs', { role: 'group', 'aria-label': 'Photos' });
      images.forEach(function (src, i) {
        var b = el('button', 'advg-thumb', { type: 'button', 'aria-label': 'Show photo ' + (i + 1) + ' of ' + images.length });
        b.appendChild(photo(src, '')); b.querySelector('img').setAttribute('loading', 'lazy');
        b.addEventListener('click', function () { show(i); });
        row.appendChild(b); thumbs.push(b);
      });
      wrap.appendChild(row);
    }
    function show(i) {
      current = (i + images.length) % images.length;
      mainImg.src = images[current]; mainImg.alt = alts[current];
      main.setAttribute('aria-label', 'Enlarge photo ' + (current + 1) + ' of ' + images.length + ': ' + alts[current]);
      thumbs.forEach(function (t, k) { t.setAttribute('aria-current', k === current ? 'true' : 'false'); });
    }
    show(0);
    main.addEventListener('click', function () { openViewer(current); });

    function openViewer(start) {
      var opener = document.activeElement;
      var idx = start;
      var box = el('div', 'advg-box', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photos of ' + title });
      var top = el('div', 'advg-top');
      var count = el('div', 'advg-count', { 'aria-live': 'polite' });
      var close = el('button', 'advg-btn advg-close', { type: 'button', 'aria-label': 'Close photos' }); close.textContent = '×';
      top.appendChild(count); top.appendChild(close);
      var stage = el('div', 'advg-stage');
      var big = photo(images[idx], alts[idx]);
      stage.appendChild(big);
      var prev, next;
      if (images.length > 1) {
        prev = el('button', 'advg-btn advg-prev', { type: 'button', 'aria-label': 'Previous photo' }); prev.textContent = '‹';
        next = el('button', 'advg-btn advg-next', { type: 'button', 'aria-label': 'Next photo' }); next.textContent = '›';
        stage.appendChild(prev); stage.appendChild(next);
        prev.addEventListener('click', function () { go(idx - 1); });
        next.addEventListener('click', function () { go(idx + 1); });
      }
      var cap = el('div', 'advg-cap');
      var strip = el('div', 'advg-strip', { role: 'group', 'aria-label': 'All photos' });
      var stripBtns = [];
      if (images.length > 1) images.forEach(function (src, i) {
        var b = el('button', 'advg-thumb', { type: 'button', 'aria-label': 'Photo ' + (i + 1) + ' of ' + images.length });
        b.appendChild(photo(src, '')); b.addEventListener('click', function () { go(i); });
        strip.appendChild(b); stripBtns.push(b);
      });
      box.appendChild(top); box.appendChild(stage); box.appendChild(cap); if (stripBtns.length) box.appendChild(strip);
      function go(i) {
        idx = (i + images.length) % images.length;
        big.src = images[idx]; big.alt = alts[idx];
        count.textContent = 'Photo ' + (idx + 1) + ' of ' + images.length;
        cap.textContent = alts[idx] === title ? '' : alts[idx];
        stripBtns.forEach(function (b, k) { b.setAttribute('aria-current', k === idx ? 'true' : 'false'); });
        if (stripBtns[idx] && stripBtns[idx].scrollIntoView) { try { stripBtns[idx].scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* older browsers */ } }
      }
      function done() {
        document.removeEventListener('keydown', onKey, true);
        if (box.parentNode) box.parentNode.removeChild(box);
        document.documentElement.style.overflow = prevOverflow;
        show(idx);
        if (opener && opener.focus) opener.focus();
      }
      function focusables() { return Array.prototype.slice.call(box.querySelectorAll('button')); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(); }
        else if (e.key === 'ArrowLeft' && images.length > 1) { e.preventDefault(); go(idx - 1); }
        else if (e.key === 'ArrowRight' && images.length > 1) { e.preventDefault(); go(idx + 1); }
        else if (e.key === 'Tab') {
          var f = focusables(); if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      close.addEventListener('click', done);
      box.addEventListener('click', function (e) { if (e.target === box || e.target === stage) done(); });
      var sx = null, sy = null;
      stage.addEventListener('touchstart', function (e) { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (sx == null || images.length < 2) return;
        var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = sy = null;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(idx + (dx < 0 ? 1 : -1));
      });
      var prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.appendChild(box);
      document.addEventListener('keydown', onKey, true);
      go(idx);
      close.focus();
    }
    return { count: images.length, show: show, open: function (i) { openViewer(i || 0); } };
  }

  window.AdvGallery = { mount: mount };
})();
