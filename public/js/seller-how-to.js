/* Seller Academy (/seller-how-to): the grouping Pro Tip animation and the printables (branded lot labels, calibration
   page, inventory worksheet, setup and pickup checklists), built in this browser and printed with the browser's print
   window. Label geometry comes from /js/lot-label-layout.js (shared with the PDF download). Professional Sellers and
   administrators only (sellerResourceGate, server-side). Nothing typed here is sent
   or stored, except the label options placed in the PDF link when the seller asks for the PDF. DOM calls only. */
(function () {
  'use strict';
  var L = window.AdvLotLabels;
  var LOGO = '/img/brand/advantage-bid-logo.png';
  var area = document.getElementById('print-area');
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function val(id) { return document.getElementById(id).value; }
  function num(id, lo, hi, dflt) { var v = parseInt(val(id), 10); if (!(v >= lo && v <= hi)) v = dflt; return v; }
  function clear() { while (area.firstChild) area.removeChild(area.firstChild); }
  function img(src, cls) { var i = el('img', null, cls); i.src = src; i.alt = 'Advantage.Bid'; return i; }
  // Print once every image in the print area has loaded, so the logo is never missing from the printed page.
  function printWhenReady() {
    var imgs = Array.prototype.slice.call(area.querySelectorAll('img'));
    Promise.all(imgs.map(function (i) { return i.complete ? null : new Promise(function (r) { i.onload = i.onerror = r; }); }))
      .then(function () { window.print(); });
  }

  /* ---------- the grouping Pro Tip ---------- */
  var BIDS = [['Sarah', 5], ['Rachel', 10], ['Sarah', 15], ['Rachel', 20], ['Sarah', 25], ['Rachel', 30]];
  var ladder = document.getElementById('cat-ladder'); var play = document.getElementById('cat-play'); var timer = null;
  function showBids(k) {
    while (ladder.firstChild) ladder.removeChild(ladder.firstChild);
    for (var i = 0; i < k; i++) { var li = el('li'); li.appendChild(el('span', BIDS[i][0] + ' bids')); li.appendChild(el('b', '$' + BIDS[i][1])); ladder.appendChild(li); }
    if (k === BIDS.length) {
      var w = el('li', null, 'win'); w.appendChild(el('span', 'Group of three sold, total')); w.appendChild(el('b', '$30 or more')); ladder.appendChild(w);
    }
  }
  if (play) {
    showBids(BIDS.length);
    play.addEventListener('click', function () {
      clearInterval(timer);
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { showBids(BIDS.length); return; }
      var k = 0; showBids(0); play.disabled = true;
      timer = setInterval(function () { k++; showBids(k); if (k >= BIDS.length) { clearInterval(timer); play.disabled = false; play.textContent = 'Watch again'; } }, 650);
    });
  }

  /* ---------- lot labels ---------- */
  function labelOpts() {
    return L.normalize({ from: val('l-from'), to: val('l-to'), seller: val('l-seller'), auction: val('l-auction'),
      web: document.getElementById('l-web').checked, plain: document.getElementById('l-plain').checked });
  }
  function labelEl(n, o) {
    var d = el('div', null, 'lbl' + (o.plain ? ' plain' : ''));
    var top = el('div', null, 'top');
    var nb = el('div', null, 'num'); nb.appendChild(el('small', 'LOT')); var b = el('b', String(n)); b.style.fontSize = L.numberSize(n) + 'pt'; nb.appendChild(b);
    top.appendChild(nb); top.appendChild(img(LOGO, 'logo')); d.appendChild(top);
    if (o.seller || o.auction || o.web) {
      var f = el('div', null, 'foot'); var who = el('div', null, 'who');
      if (o.seller) who.appendChild(el('b', o.seller));
      if (o.auction) who.appendChild(el('span', (o.seller ? '  ·  ' : '') + o.auction));
      f.appendChild(who); if (o.web) f.appendChild(el('span', 'advantage.bid', 'web'));
      d.appendChild(f);
    }
    return d;
  }
  function pdfHref(o, mode) {
    var q = new URLSearchParams();
    if (mode) q.set('mode', mode);
    else {
      q.set('from', o.from); q.set('to', o.to);
      if (o.seller) q.set('seller', o.seller); if (o.auction) q.set('auction', o.auction);
      if (!o.web) q.set('web', '0'); if (o.plain) q.set('plain', '1');
    }
    return '/api/seller-resources/lot-labels.pdf?' + q.toString();
  }
  function preview() {
    var o = labelOpts(); var box = document.getElementById('l-preview'); while (box.firstChild) box.removeChild(box.firstChild);
    for (var n = o.from; n < o.from + Math.min(3, o.count); n++) box.appendChild(labelEl(n, o));
    document.getElementById('l-count').textContent = o.count + (o.count === 1 ? ' label' : ' labels') + ' (lots ' + o.from + ' to ' + o.to + ') on ' + o.sheets + (o.sheets === 1 ? ' sheet' : ' sheets') +
      (o.capped ? '. Up to 600 labels print at a time; print the rest as a second batch.' : '.');
    document.getElementById('d-labels').href = pdfHref(o);
  }
  function labels() {
    var o = labelOpts(); clear(); var sheet = null;
    for (var i = 0; i < o.count; i++) {
      if (i % L.AVERY_5160.perSheet === 0) { sheet = el('div', null, 'lsheet'); area.appendChild(sheet); }
      var p = L.position(i); var d = labelEl(o.from + i, o); d.style.left = p.x + 'in'; d.style.top = p.y + 'in'; sheet.appendChild(d);
    }
    printWhenReady();
  }
  function calibration() {
    clear(); var s = el('div', null, 'lsheet');
    s.appendChild(el('div', 'Advantage.Bid lot labels: calibration sheet (print on plain paper)', 'cal-h'));
    for (var i = 0; i < L.AVERY_5160.perSheet; i++) { var p = L.position(i); var b = el('div', null, 'cal-box'); b.style.left = p.x + 'in'; b.style.top = p.y + 'in'; s.appendChild(b); }
    var p0 = L.position(0);
    var sq = el('div', null, 'cal-sq'); sq.style.left = (p0.x + 0.12) + 'in'; sq.style.top = p0.y + 'in'; s.appendChild(sq);
    [['Square = exactly 1 in', 0.3], ['Label = 2 5/8 in wide', 0.45]].forEach(function (t) { var e = el('div', t[0], 'cal-t'); e.style.left = (p0.x + 1.22) + 'in'; e.style.top = (p0.y + t[1]) + 'in'; s.appendChild(e); });
    var f = el('div', null, 'cal-f');
    ['How to check: print this page at Actual size (100%), then hold it behind a sheet of labels against a window or lamp.',
      'Every outline should sit on a label. If the outlines are smaller, the printer scaled the page: choose Actual size, not Fit.',
      'Turn off headers and footers. If everything is shifted the same way, use the printer\'s alignment setting or manual feed.']
      .forEach(function (t) { f.appendChild(el('div', t)); });
    s.appendChild(f); area.appendChild(s); window.print();
  }

  /* ---------- printed sheets ---------- */
  function header(title, sub, ws) {
    var s = el('div', null, 'psheet' + (ws ? ' ws' : ''));
    var h = el('div', null, 'phead'); h.appendChild(el('h1', title)); h.appendChild(img(LOGO)); s.appendChild(h);
    if (sub) s.appendChild(el('p', sub, 'psub'));
    return s;
  }
  function worksheet() {
    var pages = num('w-pages', 1, 20, 2); var from = num('w-from', 1, 99999, 101);
    var sale = L.clean(val('w-sale'), 70); var date = val('w-date');
    var dateText = ''; if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { var p = date.split('-'); dateText = p[1] + '/' + p[2] + '/' + p[0]; }
    var cols = [['Lot', 0.55], ['Zone', 0.85], ['Item', 1.75], ['Maker, marks and details', 2.05], ['Condition and flaws', 1.6], ['Size', 0.95], ['Qty', 0.45], ['Photos', 0.55], ['Notes', 1.35]];
    clear();
    for (var pg = 0; pg < pages; pg++) {
      var s = header('Inventory Worksheet', null, true);
      var m = el('div', null, 'meta');
      var a = el('div', 'Sale: '); a.appendChild(el('span', sale || ' ')); m.appendChild(a);
      var b = el('div', 'Date: '); b.appendChild(el('span', dateText || ' ', 'short')); m.appendChild(b);
      m.appendChild(el('div', 'Page ' + (pg + 1) + ' of ' + pages)); s.appendChild(m);
      var tb = el('table', null, 'wst'); var cg = el('colgroup');
      cols.forEach(function (c) { var col = el('col'); col.style.width = c[1] + 'in'; cg.appendChild(col); }); tb.appendChild(cg);
      var hr = el('tr'); cols.forEach(function (c) { hr.appendChild(el('th', c[0])); });
      var thead = el('thead'); thead.appendChild(hr); tb.appendChild(thead);
      var body = el('tbody');
      for (var r = 0; r < 12; r++) {
        var tr = el('tr'); tr.appendChild(el('td', String(from + pg * 12 + r), 'lot'));
        for (var c = 1; c < cols.length; c++) tr.appendChild(el('td', c === 7 ? '☐' : '', c === 7 ? 'box' : null));
        body.appendChild(tr);
      }
      tb.appendChild(body); s.appendChild(tb);
      var ft = el('div', null, 'pfoot'); ft.appendChild(el('span', 'Zone: where the lot is staged (Table A, Garage Shelf 2). Match the lot number on the item, this sheet and the catalog.')); ft.appendChild(el('span', 'advantage.bid'));
      s.appendChild(ft); area.appendChild(s);
    }
    printWhenReady();
  }
  function checklist(title, sub, groups) {
    clear(); var s = header(title, sub);
    var cl = el('div', null, 'cl');
    groups.forEach(function (g) {
      var sec = el('section'); sec.appendChild(el('h2', g[0])); var ul = el('ul');
      g[1].forEach(function (x) { ul.appendChild(el('li', x)); }); sec.appendChild(ul); cl.appendChild(sec);
    });
    s.appendChild(cl);
    var n = el('div', null, 'notes'); n.appendChild(el('p', 'Notes', null)); for (var i = 0; i < 3; i++) n.appendChild(el('div')); s.appendChild(n);
    area.appendChild(s); printWhenReady();
  }

  var SETUP = [
    ['Sale scope and excluded property', ['Walk through with the owner and agree what is in the sale', 'Mark, remove or lock away excluded property and keepsakes', 'Note anything that cannot legally be sold or needs special handling', 'Confirm who may enter the property and when']],
    ['Merchandise evaluation and grouping', ['Check marks, signatures, labels and hallmarks', 'Research comparable sold results for notable pieces', 'Consider an appraiser for anything possibly significant', 'Decide what sells individually and what is grouped', 'Keep sets complete; one obvious buyer per lot']],
    ['Inventory locations and lot numbering', ['Set up work tables, a photo station and named zones', 'Number lots in catalog order, zones in runs', 'Label every lot (printable labels or painter\'s tape)', 'Record lot, zone and details on the worksheet']],
    ['Photography and descriptions', ['Primary photo: whole item, clean background, no lot label', 'Supporting photos: sides, back, marks, every flaw', 'Titles: what it is, maker, material, key detail', 'Descriptions say what is included and what is missing']],
    ['Condition and dimensions', ['Describe condition specifically, not just "good"', 'Measure furniture, art and large items', 'Give quantities for grouped lots', 'Add pickup notes for heavy, upstairs or fragile lots']],
    ['Dates, previews, pickup terms and fulfillment', ['Choose the opening and closing dates and times', 'Set the closing schedule for lots shown on the setup page', 'Set preview access if you offer one', 'Publish the pickup dates, window, location and access details', 'Plan helpers, parking and a path for large items']],
    ['Featured lots and marketing', ['Choose featured lots with the best photos and broad appeal', 'Write an auction title buyers would search for', 'Share the auction link with your email list and social media', 'Professional Sellers: show it on your website and storefront']],
    ['Catalog quality review before publication', ['Every lot has a primary photo, title, category and condition', 'Labels, worksheet and catalog numbers all match', 'Spelling, dimensions and quantities checked', 'Pickup terms and dates read correctly', 'Submit or publish the auction']],
  ];
  var PICKUP = [
    ['Before buyers arrive', ['Download or print the list of sold lots and buyers', 'Stage sold lots by lot number or by buyer', 'Keep unsold and excluded items separate', 'Confirm appointments, if used, within the published window', 'Send access instructions: entrance, parking, stairs, what to bring']],
    ['Large and fragile items', ['Clear a path; protect floors, stairs and door frames', 'Have furniture ready to move; note anything that must be disassembled', 'Set fragile lots aside for the buyer to pack', 'Buyers bring their own helpers, tools and packing materials']],
    ['Release only paid lots', ['Check the buyer\'s identity against the invoice name', 'Confirm the invoice shows paid on Advantage.Bid', 'Match each lot number to the label on the item', 'Mark each lot released on the pickup list as it leaves']],
    ['Exceptions and communication', ['Write down anything unusual: missing piece, damage, a substitute person collecting', 'Keep a record of messages with the buyer', 'Uncollected lots: follow the published pickup terms and platform procedures', 'A voluntary accommodation never changes the published terms']],
    ['Seller safety and site security', ['Work with at least one other person', 'Keep cash, keys and valuables out of sight', 'Lock rooms that are not part of the sale', 'Never accept off-platform payments or overpayments', 'Lock up and secure the property at the end of the window']],
  ];

  if (L) {
    ['l-from', 'l-to', 'l-seller', 'l-auction', 'l-web', 'l-plain'].forEach(function (id) { document.getElementById(id).addEventListener('input', preview); document.getElementById(id).addEventListener('change', preview); });
    document.getElementById('p-labels').addEventListener('click', labels);
    document.getElementById('p-calibrate').addEventListener('click', calibration);
    document.getElementById('d-labels').addEventListener('click', function () { this.href = pdfHref(labelOpts()); });
    preview();
  }
  document.getElementById('p-worksheet').addEventListener('click', worksheet);
  document.getElementById('p-setup').addEventListener('click', function () { checklist('Auction Setup Checklist', 'From the first walk-through to a catalog ready to publish. Not every step applies to every sale.', SETUP); });
  document.getElementById('p-pickup').addEventListener('click', function () { checklist('Pickup Day Checklist', 'Release only lots with a paid invoice. Your published pickup terms apply to every lot.', PICKUP); });
})();
