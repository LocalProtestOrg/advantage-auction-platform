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
        ['Or import a spreadsheet', 'Bring your storefront inventory in at once, photos included.'], ['Publish', 'Your lot is live on your storefront, your website and the marketplace.']]
        .forEach(function (x) { var li = el('li'); li.appendChild(el('b', x[0])); li.appendChild(el('span', x[1])); ol.appendChild(li); });
      p.appendChild(ol);
      return ['Easy cataloging', 'Catalog from your phone as you walk the sale. You stay in control of every word.',
        ['Smart Catalog Tools for titles, categories and descriptions', 'Bulk spreadsheet import, with photos, for storefront inventory', 'Save drafts and come back later']];
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
  }

  var sw = document.getElementById('d-colors');
  COLORS.forEach(function (c, i) {
    var b = el('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Brand color ' + (i + 1)); b.setAttribute('aria-pressed', String(i === 0));
    b.addEventListener('click', function () { state.color = c; Array.prototype.forEach.call(sw.children, function (o) { o.setAttribute('aria-pressed', String(o === b)); }); render(); });
    sw.appendChild(b);
  });
  document.getElementById('d-name').addEventListener('input', function (e) { state.name = e.target.value.slice(0, 60); render(); });
  document.getElementById('d-type').addEventListener('change', function (e) { if (TYPES[e.target.value]) { state.type = e.target.value; render(); } });
  try { var t = new URLSearchParams(location.search).get('type'); if (TYPES[t]) { state.type = t; document.getElementById('d-type').value = t; } } catch (e) { /* default */ }
  render();
})();
