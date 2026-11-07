/*
 * AdvWebsiteWidgets: "Website Widgets", one place, one layout for a Professional Seller's two website widgets
 * (owner request 2026-11-03). Used on the seller dashboard and in Storefront Settings > Website Widgets.
 *
 *   AdvWebsiteWidgets.mount(container, { token, first: 'auctions' | 'storefront' })
 *
 *   Auctions widget    GET /api/sellers/me/widget          auctions, catalogs and lots on the company's own website
 *   Storefront widget  GET /api/seller-storefront/widget   fixed-price items on the company's own website
 *
 * Each widget the seller can use gets the same card: what it shows, its status, Copy Embed Code, Copy Widget Link, Preview
 * Widget and the install steps. The server decides from the signed-in session which widgets (and whose) are shown; a
 * widget the seller cannot use is simply not listed. Built with DOM calls only (no HTML strings from data).
 */
(function () {
  'use strict';
  if (window.AdvWebsiteWidgets) return;

  var CSS = [
    '.aww{display:grid;gap:14px}',
    '.aww-card{border:1px solid #e2e8f0;border-radius:12px;padding:16px;background:#fff}',
    '.aww-card h3{font-size:1.02rem;font-weight:800;margin:0 0 4px;color:#0f172a}',
    '.aww-what{font-size:.88rem;color:#475569;line-height:1.5;margin:0 0 8px}',
    '.aww-status{font-size:.85rem;border-radius:8px;padding:.5rem .7rem;margin:0 0 10px}',
    '.aww-ok{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}',
    '.aww-warn{background:#fffbeb;color:#92400e;border:1px solid #fde68a}',
    '.aww-lbl{display:block;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:8px 0 4px}',
    '.aww-code{width:100%;box-sizing:border-box;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;padding:.6rem;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#0f172a;resize:vertical}',
    '.aww-link{width:100%;box-sizing:border-box;font-size:.82rem;padding:.5rem .6rem;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#0f172a}',
    '.aww-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}',
    '.aww-btn{border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;border-radius:8px;padding:.55rem 1rem;font-weight:700;font-size:.85rem;cursor:pointer;min-height:40px}',
    '.aww-btn.aww-ghost{background:#fff;color:#1e293b;border-color:#cbd5e1}',
    '.aww-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.aww-msg{font-size:.82rem;color:#166534;align-self:center}',
    '.aww-steps{font-size:.86rem;line-height:1.6;color:#334155;margin:.4rem 0 0 1.1rem;padding:0}',
    '.aww-steps-t{cursor:pointer;font-weight:700;font-size:.86rem;color:#0f172a}',
    '.aww-prev{border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-top:10px;background:#fff}',
    '.aww-prev iframe{display:block;width:100%;height:640px;border:0}',
    '.aww-none{font-size:.9rem;color:#64748b}',
  ].join('');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function api(url, token) {
    return fetch(url, { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  function copy(value, input, msg) {
    function done(ok) { msg.textContent = ok ? 'Copied.' : 'Select the text and copy it.'; setTimeout(function () { msg.textContent = ''; }, 2500); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function () { done(true); }, function () { input.select(); done(false); });
    else { input.select(); try { done(document.execCommand('copy')); } catch (e) { done(false); } }
  }

  // One widget card. w: { id, title, what, status: { text, ok }, code, link, linkHelp, preview, steps: [..] }
  function card(w) {
    var c = el('section', 'aww-card'); c.id = 'aww-' + w.id; c.setAttribute('aria-labelledby', 'aww-' + w.id + '-h');
    var h = el('h3', null, w.title); h.id = 'aww-' + w.id + '-h'; c.appendChild(h);
    c.appendChild(el('p', 'aww-what', w.what));
    if (w.status) c.appendChild(el('p', 'aww-status ' + (w.status.ok ? 'aww-ok' : 'aww-warn'), w.status.text));
    var codeL = el('label', 'aww-lbl', 'Embed code (paste into your website)'); var code = el('textarea', 'aww-code');
    code.readOnly = true; code.rows = 4; code.value = w.code || ''; code.id = 'aww-' + w.id + '-code'; codeL.htmlFor = code.id;
    var linkL = el('label', 'aww-lbl', 'Widget link (for websites that cannot embed)'); var link = el('input', 'aww-link');
    link.readOnly = true; link.value = w.link || ''; link.id = 'aww-' + w.id + '-link'; linkL.htmlFor = link.id;
    c.appendChild(codeL); c.appendChild(code); c.appendChild(linkL); c.appendChild(link);
    var row = el('div', 'aww-row'); var msg = el('span', 'aww-msg'); msg.setAttribute('aria-live', 'polite');
    var bCode = el('button', 'aww-btn', 'Copy Embed Code'); bCode.type = 'button'; bCode.disabled = !w.code;
    bCode.addEventListener('click', function () { copy(w.code, code, msg); });
    var bLink = el('button', 'aww-btn aww-ghost', 'Copy Widget Link'); bLink.type = 'button'; bLink.disabled = !w.link;
    bLink.addEventListener('click', function () { copy(w.link, link, msg); });
    var bPrev = el('button', 'aww-btn aww-ghost', 'Preview Widget'); bPrev.type = 'button'; bPrev.disabled = !w.preview;
    bPrev.setAttribute('aria-expanded', 'false');
    var prev = el('div', 'aww-prev'); prev.hidden = true;
    bPrev.addEventListener('click', function () {
      var open = prev.hidden;
      if (open && !prev.firstChild) {
        // the preview loads from this site (the dashboard and the widget are served by the same platform)
        var src = w.preview; try { var u = new URL(w.preview, location.href); src = u.pathname + u.search; } catch (e) { /* keep as given */ }
        var f = el('iframe'); f.title = w.title + ' preview'; f.src = src; f.loading = 'lazy'; prev.appendChild(f);
      }
      prev.hidden = !open; bPrev.setAttribute('aria-expanded', open ? 'true' : 'false'); bPrev.textContent = open ? 'Hide Preview' : 'Preview Widget';
    });
    row.appendChild(bCode); row.appendChild(bLink); row.appendChild(bPrev); row.appendChild(msg); c.appendChild(row);
    var det = el('details'); var sum = el('summary', 'aww-steps-t', 'How to add it to your website'); det.appendChild(sum);
    var ol = el('ol', 'aww-steps'); w.steps.forEach(function (s) { ol.appendChild(el('li', null, s)); }); det.appendChild(ol);
    c.appendChild(det); c.appendChild(prev);
    return c;
  }
  var STEPS = function (linkWord) {
    return ['Click Copy Embed Code.',
      'In your website editor, add a block for custom HTML or embed code (WordPress: "Custom HTML" block; Squarespace: "Code" block; Wix: "Embed HTML"; Brilliant Directories: a custom HTML widget or content area).',
      'Paste the code, save, and publish your page. The widget fits the width of your page on phones, tablets and computers, and updates by itself.',
      'If your website does not allow embed code, click Copy Widget Link and add it as a link or button to your ' + linkWord + '.',
      'Prefer help? Send the code to the person who manages your website, or ask Advantage.Bid.'];
  };

  function auctionsCard(d) {
    if (!d || !d.success) return null;
    if (d.demo) {
      var c = el('section', 'aww-card'); c.id = 'aww-auctions';
      c.appendChild(el('h3', null, 'Auctions widget'));
      c.appendChild(el('p', 'aww-what', 'Once you publish auctions on Advantage.Bid, they can appear on your own company website.'));
      var a = el('a', 'aww-btn', 'See How This Looks on Your Website'); a.href = d.example_url || '/demo/example-company-website.html'; a.target = '_blank'; a.rel = 'noopener';
      a.style.textDecoration = 'none'; a.style.display = 'inline-block'; c.appendChild(a); return c;
    }
    if (!d.eligible) return null;
    var n = d.auction_count || 0;
    return card({ id: 'auctions', title: 'Auctions widget',
      what: 'Shows your live and upcoming auctions on your own website. Shoppers open each catalog, browse the lots and view every photo without leaving your site; to bid, they continue to Advantage.Bid in a new tab.',
      status: n ? { ok: true, text: 'Your auctions widget is on and showing ' + n + ' auction' + (n === 1 ? '' : 's') + '.' }
        : { ok: false, text: 'You have no published auctions yet. Install the widget now: it shows your auctions as soon as they go live.' },
      code: d.embed_code, link: d.preview_url, preview: d.preview_url, steps: STEPS('auctions page') });
  }
  function storefrontCard(r) {
    if (!r || !r.success || !r.data || !r.data.eligible) return null;
    var d = r.data, st;
    if (!d.storefront_url) st = { ok: false, text: 'Choose your storefront address in Storefront Settings to get your widget.' };
    else if (!d.active) st = { ok: false, text: 'Publish your storefront to turn on your widget. Until then it shows "not available" on your website.' };
    else if (d.shop_hidden) st = { ok: false, text: 'Your Shop section is hidden on your storefront, so your widget shows no items. Turn the Shop section back on to show them.' };
    else st = { ok: true, text: 'Your storefront widget is on and showing ' + d.item_count + ' item' + (d.item_count === 1 ? '' : 's') + '.' };
    return card({ id: 'storefront', title: 'Storefront widget',
      what: 'Shows the items you have for sale on your own website. Shoppers open each item\'s details and photos right inside it. Online purchasing through Advantage.Bid checkout is not open yet. Once it opens, a sale that starts here and continues to Advantage.Bid checkout is a website sale (5% commission instead of 9%).',
      status: st, code: d.embed_code, link: d.storefront_url, preview: d.active ? d.embed_url : null, steps: STEPS('shop page') });
  }

  function mount(container, opts) {
    opts = opts || {};
    if (!container || !opts.token) return Promise.resolve(0);
    if (!document.getElementById('aww-css')) { var s = document.createElement('style'); s.id = 'aww-css'; s.textContent = CSS; document.head.appendChild(s); }
    container.textContent = 'Loading...';
    return Promise.all([api('/api/sellers/me/widget', opts.token), api('/api/seller-storefront/widget', opts.token)]).then(function (res) {
      var cards = { auctions: auctionsCard(res[0]), storefront: storefrontCard(res[1]) };
      var order = opts.first === 'storefront' ? ['storefront', 'auctions'] : ['auctions', 'storefront'];
      container.textContent = '';
      var wrap = el('div', 'aww'); var n = 0;
      order.forEach(function (k) { if (cards[k]) { wrap.appendChild(cards[k]); n++; } });
      if (!n) wrap.appendChild(el('p', 'aww-none', 'Website widgets are available to Professional Sellers.'));
      container.appendChild(wrap);
      return n;
    });
  }
  window.AdvWebsiteWidgets = { mount: mount };
})();
