/* Professional seller demo (/seller-demo). Everything happens in this browser: nothing typed here is sent or stored.
   Built with DOM calls; every value is set as text. Only features that are live today are shown. */
(function () {
  'use strict';
  var COLORS = ['#1d4ed8', '#0f766e', '#7c2d12', '#6d28d9', '#b91c1c', '#0f172a'];
  var TYPES = {
    estate_sale_company: { noun: 'Estate Sales', lots: ['Mid-Century Walnut Credenza', 'Sterling Flatware Service', 'Signed Abstract Oil', 'Persian Wool Rug', 'Art Deco Table Lamp', 'Cut Crystal Decanters'], auction: 'Westside Estate Contents Online Auction' },
    auction_house: { noun: 'Auctions', lots: ['Victorian Mahogany Secretary', '14K Gold Pocket Watch', 'Hudson River School Landscape', 'Chinese Export Porcelain Bowl', 'Bronze Figural Sculpture', 'Georgian Silver Teapot'], auction: 'Fine Art and Antiques Catalog Auction' },
    professional_liquidator: { noun: 'Liquidations', lots: ['Commercial Espresso Machine', 'Pallet of Office Chairs', 'Industrial Shelving Lot', 'Restaurant Range, 6 Burner', 'Laptop Lot, 10 Units', 'Forklift Battery Charger'], auction: 'Business Equipment Liquidation Auction' },
    retail_gallery_studio: { noun: 'Shop', lots: ['Hand Thrown Stoneware Vase', 'Vintage Brass Candlesticks', 'Original Watercolor, Framed', 'Handwoven Throw', 'Restored Oak Side Table', 'Art Pottery Bowl'], auction: 'Studio Collection Online Auction' },
  };
  var TABS = [
    ['storefront', 'Your storefront'], ['website', 'On your website'], ['marketplace', 'On Advantage.Bid'],
    ['catalog', 'Easy cataloging'], ['auction', 'Auction day'], ['consign', 'More consignments'],
  ];
  var state = { name: '', type: 'estate_sale_company', color: COLORS[0], tab: 'storefront' };

  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function nameOf() { return (state.name || '').trim() || 'Your Business Name'; }
  function initials() { var w = nameOf().split(/\s+/).filter(Boolean); return ((w[0] || 'Y')[0] + ((w[1] || '')[0] || '')).toUpperCase(); }
  function slug() { return nameOf().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'your-business'; }
  function shade(i) { var hues = [28, 200, 140, 260, 340, 45]; return 'linear-gradient(135deg,hsl(' + hues[i % 6] + ',35%,42%),hsl(' + hues[i % 6] + ',40%,28%))'; }

  function brandBar(sub) {
    var bar = el('div', null, 'brandbar'); bar.style.background = state.color;
    bar.appendChild(el('div', initials(), 'logo'));
    var t = el('div'); t.appendChild(el('div', nameOf(), 'bname')); t.appendChild(el('div', sub, 'bsub')); bar.appendChild(t);
    return bar;
  }
  function cards(n, meta) {
    var g = el('div', null, 'grid'); var lots = TYPES[state.type].lots;
    for (var i = 0; i < n; i++) {
      var c = el('div', null, 'card'); var th = el('div', 'Lot ' + (101 + i), 'thumb'); th.style.background = shade(i); c.appendChild(th);
      var ct = el('div', lots[i % lots.length], 'ct'); ct.appendChild(el('div', meta(i), 'cm')); c.appendChild(ct); g.appendChild(c);
    }
    return g;
  }
  function section(title, child) { var s = el('div', null, 'sec'); s.appendChild(el('h3', title)); s.appendChild(child); return s; }
  function bidMeta(i) { return 'Current bid $' + [45, 120, 380, 260, 75, 95][i % 6]; }

  // The spreadsheet and photo importer, explained with a small example (Professional Seller storefront inventory).
  function importPanel() {
    var box = el('div', null, 'imp');
    box.appendChild(el('h4', 'Import Your Inventory & Photos'));
    box.appendChild(el('p', 'Bring your entire storefront inventory into Advantage.Bid at once, including product details and matching photos. Upload a CSV or Excel spreadsheet (up to 2,000 rows), match your columns once, and the importer remembers them for next time.'));
    var sc = el('div', null, 'scroll'); var t = el('table'); var rows = [
      ['Inventory Number', 'Item Title', 'Sale Price', 'Photo_1', 'Photo_2', '… Photo_15'],
      ['A1024', TYPES[state.type].lots[0], '450', 'A1024.jpg', 'A1024_2.jpg', ''],
      ['A1025', TYPES[state.type].lots[1], '120', 'A1025.jpg', 'https://…/a1025-back.jpg', ''],
    ];
    rows.forEach(function (r, i) { var tr = el('tr'); r.forEach(function (c) { tr.appendChild(el(i ? 'td' : 'th', c)); }); t.appendChild(tr); });
    sc.appendChild(t); box.appendChild(sc);
    box.appendChild(el('p', 'Photos match each row automatically: by a file name or photo link in the Photo_1 to Photo_15 columns, or by naming photos after the inventory number (A1024.jpg, A1024_2.jpg) or putting them in a folder per item in a ZIP file. You can reorder photos, choose the primary photo and fix anything unmatched before a single item is created.'));
    var sv = el('div', null, 'save');
    var a = el('div'); a.appendChild(el('b', '2,000 uploads')); a.appendChild(document.createTextNode('500 items with 4 photos each, added one at a time'));
    var b = el('div'); b.appendChild(el('b', '2 files')); b.appendChild(document.createTextNode('the same 500 items: one spreadsheet and one ZIP of photos'));
    sv.appendChild(a); sv.appendChild(b); box.appendChild(sv);
    return box;
  }

  var VIEWS = {
    storefront: function (p) {
      p.appendChild(brandBar('bid.advantage.bid/pro/' + slug()));
      p.appendChild(section(TYPES[state.type].auction, cards(6, bidMeta)));
      return ['Your own branded storefront', 'Your logo, your colors and your name on every page buyers see, with your auctions, your items for sale and your policies in one place.',
        ['A public page at your own address on Advantage.Bid', 'Your auctions, catalogs and items for sale, always current', 'Your buyer\'s premium, your terms, your pickup details']];
    },
    website: function (p) {
      var b = el('div', null, 'browser'); b.appendChild(el('span', null, 'dot')); b.appendChild(el('span', null, 'dot')); b.appendChild(el('span', null, 'dot'));
      b.appendChild(el('span', 'www.' + slug().replace(/-/g, '') + '.com', 'url')); p.appendChild(b);
      var site = el('div', null, 'site'); site.appendChild(el('h4', nameOf() + ': current ' + TYPES[state.type].noun.toLowerCase()));
      var emb = el('div', null, 'embed'); emb.appendChild(brandBar('Live from Advantage.Bid')); emb.appendChild(section('Open now', cards(3, bidMeta)));
      site.appendChild(emb); p.appendChild(site);
      return ['Your auctions on your own website', 'Paste one line of embed code into your website. Your auctions, catalogs and lots appear there, branded as yours, and update by themselves.',
        ['Shoppers browse catalogs and photos without leaving your site', 'Bidding opens on Advantage.Bid in a new tab, so your page stays open', 'Copy Embed Code, Copy Widget Link and Preview from your dashboard']];
    },
    marketplace: function (p) {
      var bar = el('div', null, 'brandbar'); bar.style.background = '#0f172a'; bar.appendChild(el('div', 'A', 'logo'));
      var t = el('div'); t.appendChild(el('div', 'Advantage.Bid', 'bname')); t.appendChild(el('div', 'Browse auctions and items for sale', 'bsub')); bar.appendChild(t); p.appendChild(bar);
      p.appendChild(section('Auctions near you and online', cards(6, function (i) { return (i % 2 ? 'By ' + nameOf() : bidMeta(i)); })));
      return ['Two places to sell, one listing', 'Every auction and item you publish also appears on the Advantage.Bid marketplace, in search, categories and location browsing, with a link back to your storefront.',
        ['Buyers who have never heard of you can find you', 'Your name stays on every listing', 'One catalog: nothing to copy or keep in sync']];
    },
    catalog: function (p) {
      p.appendChild(brandBar('Seller dashboard: new listing'));
      var s = el('div', null, 'suggest'); s.appendChild(el('b', 'Smart Catalog Tools suggestion'));
      s.appendChild(el('div', 'Title: ' + TYPES[state.type].lots[0]));
      s.appendChild(el('div', 'Category and a first description, ready for you to review and edit.'));
      p.appendChild(s);
      var ol = el('ol', null, 'steps');
      [['Add your photos', 'Straight from your phone, as many angles as the lot needs.'], ['Review the suggestions', 'Smart Catalog Tools suggests a title, category and description. You decide what is published.'],
        ['Import Your Inventory & Photos', 'Bring your entire storefront inventory into Advantage.Bid at once, including product details and matching photos.'], ['Publish', 'Your items are live on your storefront, your website and the marketplace.']]
        .forEach(function (x) { var li = el('li'); li.appendChild(el('b', x[0])); li.appendChild(el('span', x[1])); ol.appendChild(li); });
      p.appendChild(ol);
      p.appendChild(importPanel());
      return ['Easy cataloging', 'Catalog from your phone as you walk the sale, or bring a whole inventory in at once. You stay in control of every word.',
        ['Smart Catalog Tools for titles, categories and descriptions', 'Spreadsheet import (CSV or Excel, up to 2,000 rows) with up to 15 matched photos per item', 'Review everything before any item is created; save drafts and come back later']];
    },
    auction: function (p) {
      p.appendChild(brandBar(TYPES[state.type].auction));
      var tl = el('div', null, 'tl');
      [['Catalog', 'Lots, photos, starting bids and your buyer\'s premium.'], ['Preview', 'Bidders browse, watch lots and register.'],
        ['Closing', 'Lots close one minute apart. A late bid extends that lot by two minutes.'], ['Pickup', 'Invoices go out automatically; buyers pay online and book pickup.']]
        .forEach(function (x) { var d = el('div'); d.appendChild(el('b', x[0])); d.appendChild(document.createTextNode(x[1])); tl.appendChild(d); });
      p.appendChild(tl);
      return ['Auction management, start to finish', 'Run the whole sale from one dashboard: catalog, bidding, closing, invoices and pickup.',
        ['Soft close lot by lot, so every lot gets its final bids', 'Outbid and reminder notices to bidders', 'Invoices and payment collected online']];
    },
    consign: function (p) {
      p.appendChild(brandBar('A page to show consignors'));
      var ol = el('ol', null, 'steps');
      [['Show your reach', 'Your storefront, your website and the marketplace, all under your name.'], ['Show your results', 'Past auctions stay on your storefront as a record of what you sell.'],
        ['Take more consignments', 'Online auctions reach bidders who cannot come in person, so smaller estates and single collections are worth taking.'], ['Grow', 'Run more sales without more trucks or more weekends.']]
        .forEach(function (x) { var li = el('li'); li.appendChild(el('b', x[0])); li.appendChild(el('span', x[1])); ol.appendChild(li); });
      p.appendChild(ol);
      return ['More consignments, more growth', 'Online auctions are another source of commissions. Your storefront is the page you send to a family deciding who will handle an estate.',
        ['A professional page to share with every prospective consignor', 'Online sales for estates too small for a full in-person sale', 'Your brand, built every time you sell']];
    },
  };

  function render() {
    var tabs = document.getElementById('d-tabs'); while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
    TABS.forEach(function (t) {
      var b = el('button', t[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(state.tab === t[0]));
      b.addEventListener('click', function () { state.tab = t[0]; render(); }); tabs.appendChild(b);
    });
    var p = document.getElementById('d-preview'); while (p.firstChild) p.removeChild(p.firstChild);
    var info = VIEWS[state.tab](p);
    var x = document.getElementById('d-explain'); while (x.firstChild) x.removeChild(x.firstChild);
    x.appendChild(el('h2', info[0])); x.appendChild(el('p', info[1]));
    var ul = el('ul'); info[2].forEach(function (li) { ul.appendChild(el('li', li)); }); x.appendChild(ul);
    document.documentElement.style.setProperty('--brand', state.color);
    // The registration link keeps the chosen seller type and any campaign tags (utm_*) from the outreach link.
    var q = new URLSearchParams(); q.set('seller_type', state.type);
    try { new URLSearchParams(location.search).forEach(function (v, k) { if (/^utm_(source|medium|campaign|content|term)$/.test(k)) q.set(k, v.slice(0, 80)); }); } catch (e) { /* no query */ }
    document.getElementById('d-cta').href = '/become-professional-seller.html?' + q.toString();
    // The single-photo demo sits at the top of the Easy cataloging tab and is hidden on the other tabs.
    var tryEl = document.getElementById('try'); if (tryEl) tryEl.hidden = state.tab !== 'catalog';
    renderTry();
  }

  /* ---------- Try it: catalog one item from a photo ----------
     An honest illustration: the photo is shown with a local object URL (never uploaded, stored or sent), and the sample
     listing is built from the visitor's own choices, with bracketed prompts for facts only the seller knows. */
  var CATS = [['furniture', 'Furniture'], ['fine_art', 'Fine Art'], ['jewelry', 'Jewelry & Watches'], ['clothing', 'Clothing & Apparel'], ['handbags', 'Handbags & Accessories'],
    ['home_decor', 'Home Decor'], ['lighting', 'Lighting'], ['rugs_textiles', 'Rugs & Textiles'], ['ceramics_glass', 'Ceramics & Glass'], ['silver_metalware', 'Silver & Metalware'],
    ['collectibles', 'Collectibles'], ['coins_currency', 'Coins & Currency'], ['books_media', 'Books & Media'], ['electronics', 'Electronics'], ['tools', 'Tools & Equipment'],
    ['antiques', 'Antiques'], ['general', 'General']];
  var KINDS = [
    ['Furniture', 'furniture', 'Wood Dresser with Six Drawers', 'Check inside drawers and on the back for a maker\'s label', 'Large item: buyer brings help and a suitable vehicle.'],
    ['Lighting', 'lighting', 'Table Lamp with Fabric Shade', 'Check the base and socket for a maker or model', 'Fragile: buyer brings packing materials.'],
    ['Art', 'fine_art', 'Framed Landscape Painting', 'Signature, date and any gallery labels on the back', 'Fragile: buyer brings packing materials.'],
    ['Pottery and glass', 'ceramics_glass', 'Art Pottery Vase', 'Marks or stamps on the underside', 'Fragile: buyer brings packing materials.'],
    ['Jewelry', 'jewelry', 'Sterling Silver Bracelet', 'Hallmarks such as 925, 14K or a maker\'s stamp', 'Small item: ready for pickup in a sealed bag.'],
    ['Tools', 'tools', 'Hand Tool Set in Case', 'Brand and model numbers', 'Heavy: buyer brings help to load.'],
    ['Collectible', 'collectibles', 'Vintage Collectible Figurine', 'Maker\'s mark, edition or series', 'Fragile: buyer brings packing materials.'],
    ['Something else', 'general', 'Household Item', 'Brand, maker or model, if any', 'Local pickup during the published pickup window.'],
  ];
  var tryState = { url: null, kind: 0, made: false };
  var SAMPLE_SVG = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8fafc"/><stop offset="1" stop-color="#e2e8f0"/></linearGradient><linearGradient id="v" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#155e75"/><stop offset=".5" stop-color="#0e7490"/><stop offset="1" stop-color="#164e63"/></linearGradient></defs><rect width="400" height="400" fill="url(#w)"/><ellipse cx="200" cy="350" rx="95" ry="12" fill="#cbd5e1"/><path d="M170 70h60v30c0 20 60 50 60 130 0 70-40 118-90 118s-90-48-90-118c0-80 60-110 60-130z" fill="url(#v)"/><path d="M168 64h64v14h-64z" fill="#0f3d4c"/><path d="M130 220c30 18 110 18 140 0" stroke="#a5f3fc" stroke-width="5" fill="none" opacity=".7"/><path d="M128 250c34 18 110 18 144 0" stroke="#a5f3fc" stroke-width="3" fill="none" opacity=".5"/></svg>');

  function titleCase(s) { return s.replace(/\s+/g, ' ').trim().split(' ').map(function (w) { return /^(and|or|of|with|in|the|a|an|for)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function setStep(n) { for (var i = 1; i <= 3; i++) document.getElementById('ts-' + i).classList.toggle('off', i > n); }
  function setPhoto(url, label) {
    if (tryState.url && tryState.url.indexOf('blob:') === 0) URL.revokeObjectURL(tryState.url);
    tryState.url = url;
    var drop = document.getElementById('t-drop'); var txt = document.getElementById('t-drop-text');
    while (txt.firstChild) txt.removeChild(txt.firstChild);
    var im = el('img'); im.src = url; im.alt = label; txt.appendChild(im); txt.appendChild(el('div', 'Change photo', 'small'));
    drop.classList.add('has'); setStep(tryState.made ? 3 : 2); renderTry();
  }
  function makeListing() {
    var k = KINDS[tryState.kind]; var words = document.getElementById('t-words').value.slice(0, 60).trim();
    var title = words ? titleCase(words) : k[2];
    document.getElementById('t-title').value = title;
    document.getElementById('t-cat').value = k[1];
    document.getElementById('t-desc').value = title + '.\n' + k[3] + ': [add what you find].\nCondition: [describe any wear, chips or repairs].\nDimensions: [width x depth x height].\n' + k[4];
    tryState.made = true; setStep(3); renderTry();
  }
  function photoBox(cls) { var d = el('div', null, 'ph' + (cls ? ' ' + cls : '')); if (tryState.url) d.style.backgroundImage = 'url("' + tryState.url.replace(/"/g, '%22') + '")'; else d.textContent = 'Your photo'; return d; }
  function money(v) { var n = parseInt(v, 10); return '$' + ((n >= 1 && n <= 99999) ? n : 45).toLocaleString('en-US'); }
  function renderTry() {
    var store = document.getElementById('t-store'); var market = document.getElementById('t-market'); if (!store) return;
    var title = (document.getElementById('t-title').value || '').trim() || 'Your item title';
    var catKey = document.getElementById('t-cat').value; var cat = CATS.filter(function (c) { return c[0] === catKey; })[0];
    var desc = (document.getElementById('t-desc').value || '').trim(); var price = money(document.getElementById('t-price').value);
    while (store.firstChild) store.removeChild(store.firstChild);
    store.appendChild(brandBar('bid.advantage.bid/pro/' + slug()));
    var sc = el('div', null, 'shopcard'); sc.appendChild(photoBox());
    var info = el('div'); if (cat) info.appendChild(el('span', cat[1], 'catchip')); info.appendChild(el('h4', title)); info.appendChild(el('div', price, 'price'));
    info.appendChild(el('div', 'Local pickup', 'small')); if (desc) info.appendChild(el('p', desc, 'desc'));
    sc.appendChild(info); store.appendChild(sc);
    while (market.firstChild) market.removeChild(market.firstChild);
    var bar = el('div', null, 'mkbar'); var logo = el('img'); logo.src = '/img/brand/advantage-bid-logo-white.png'; logo.alt = 'Advantage.Bid'; bar.appendChild(logo);
    bar.appendChild(el('span', cat ? cat[1] : 'Shop all categories')); market.appendChild(bar);
    var g = el('div', null, 'mkgrid'); var mine = el('div', null, 'mk mine'); mine.appendChild(photoBox());
    var mb = el('div', null, 'b'); mb.appendChild(el('b', title)); mb.appendChild(el('div', price)); mb.appendChild(el('div', 'Sold by ' + nameOf())); mine.appendChild(mb); g.appendChild(mine);
    [['From another seller', 'Nearby'], ['From another seller', 'Ships or local pickup']].forEach(function (x) {
      var c = el('div', null, 'mk ghost'); c.appendChild(el('div', null, 'ph')); var b = el('div', null, 'b'); b.appendChild(el('b', x[0])); b.appendChild(el('div', x[1])); c.appendChild(b); g.appendChild(c);
    });
    market.appendChild(g);
  }
  function initTry() {
    if (!document.getElementById('try')) return;
    var sel = document.getElementById('t-cat'); CATS.forEach(function (c) { var o = el('option', c[1]); o.value = c[0]; sel.appendChild(o); });
    var chips = document.getElementById('t-kinds');
    KINDS.forEach(function (k, i) {
      var b = el('button', k[0]); b.type = 'button'; b.setAttribute('aria-pressed', String(i === 0));
      b.addEventListener('click', function () { tryState.kind = i; Array.prototype.forEach.call(chips.children, function (o) { o.setAttribute('aria-pressed', String(o === b)); }); });
      chips.appendChild(b);
    });
    document.getElementById('t-photo').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      if (!/^image\//.test(f.type) || f.size > 25 * 1024 * 1024) { alertMsg('Please choose a photo (an image file up to 25 MB).'); return; }
      setPhoto(URL.createObjectURL(f), 'Your photo');
    });
    document.getElementById('t-sample').addEventListener('click', function () { setPhoto(SAMPLE_SVG, 'Sample photo of a teal pottery vase'); tryState.kind = 3; chips.children[3].click(); document.getElementById('t-words').value = 'teal art pottery vase'; });
    document.getElementById('t-go').addEventListener('click', makeListing);
    ['t-title', 't-cat', 't-desc', 't-price'].forEach(function (id) { document.getElementById(id).addEventListener('input', renderTry); document.getElementById(id).addEventListener('change', renderTry); });
    window.addEventListener('pagehide', function () { if (tryState.url && tryState.url.indexOf('blob:') === 0) URL.revokeObjectURL(tryState.url); });
  }
  function alertMsg(t) { var p = document.querySelector('#ts-1 .privacy'); p.textContent = t; p.style.color = '#b91c1c'; }

  var sw = document.getElementById('d-colors');
  COLORS.forEach(function (c, i) {
    var b = el('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Brand color ' + (i + 1)); b.setAttribute('aria-pressed', String(i === 0));
    b.addEventListener('click', function () { state.color = c; Array.prototype.forEach.call(sw.children, function (o) { o.setAttribute('aria-pressed', String(o === b)); }); render(); });
    sw.appendChild(b);
  });
  document.getElementById('d-name').addEventListener('input', function (e) { state.name = e.target.value.slice(0, 60); render(); });
  document.getElementById('d-type').addEventListener('change', function (e) { if (TYPES[e.target.value]) { state.type = e.target.value; render(); } });
  try { var t = new URLSearchParams(location.search).get('type'); if (TYPES[t]) { state.type = t; document.getElementById('d-type').value = t; } } catch (e) { /* default */ }
  // A link ending in #try (for example in an email) opens the Easy cataloging tab with the photo demo.
  if (/^#(try|catalog)$/.test(location.hash)) state.tab = 'catalog';
  initTry();
  render();
})();
