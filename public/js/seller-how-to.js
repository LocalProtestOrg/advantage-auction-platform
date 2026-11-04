/* Seller How To Center printables (/seller-how-to): lot labels, inventory worksheet and checklists, built in this
   browser and printed with the browser's print window. Nothing typed here is sent or stored. DOM calls only. */
(function () {
  'use strict';
  var area = document.getElementById('print-area');
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
  function num(id, lo, hi, dflt) { var v = parseInt(document.getElementById(id).value, 10); if (!(v >= lo && v <= hi)) v = dflt; return v; }
  function txt(id, max) { return String(document.getElementById(id).value || '').trim().slice(0, max); }
  function clear() { while (area.firstChild) area.removeChild(area.firstChild); }
  function print() { window.print(); }

  function labels() {
    var from = num('l-from', 1, 99999, 101); var to = num('l-to', 1, 99999, from + 29);
    if (to < from) { var t = to; to = from; from = t; }
    if (to - from > 599) to = from + 599;   // at most 20 sheets at once
    var seller = txt('l-seller', 50); var auction = txt('l-auction', 60);
    clear();
    var sheet = null;
    for (var n = from, i = 0; n <= to; n++, i++) {
      if (i % 30 === 0) { sheet = el('div', null, 'labels'); if (i) sheet.style.breakBefore = 'page'; area.appendChild(sheet); }
      var l = el('div', null, 'label');
      l.appendChild(el('div', 'LOT ' + n, 'ln'));
      if (auction) l.appendChild(el('div', auction, 'lt'));
      var b = el('div', null, 'lb'); if (seller) b.appendChild(document.createTextNode(seller + ' · '));
      var brand = el('b', 'Advantage.Bid'); b.appendChild(brand); l.appendChild(b);
      sheet.appendChild(l);
    }
    print();
  }

  function worksheet() {
    var pages = num('w-pages', 1, 20, 2); var from = num('w-from', 1, 99999, 101);
    clear();
    for (var pg = 0; pg < pages; pg++) {
      var s = el('div', null, 'sheet'); if (pg) s.style.breakBefore = 'page';
      s.appendChild(el('h1', 'Advantage.Bid Inventory Worksheet'));
      s.appendChild(el('p', 'Sale: ______________________   Date: ____________   Page ' + (pg + 1) + ' of ' + pages));
      var tb = el('table'); var hr = el('tr');
      ['Lot', 'Title', 'Description', 'Condition', 'Dimensions', 'Photos', 'Notes'].forEach(function (h) { hr.appendChild(el('th', h)); });
      var thead = el('thead'); thead.appendChild(hr); tb.appendChild(thead);
      var body = el('tbody');
      for (var r = 0; r < 15; r++) {
        var tr = el('tr'); tr.appendChild(el('td', String(from + pg * 15 + r)));
        for (var c = 0; c < 6; c++) tr.appendChild(el('td', c === 4 ? '☐' : ''));
        body.appendChild(tr);
      }
      tb.appendChild(body); s.appendChild(tb); area.appendChild(s);
    }
    print();
  }

  function checklist(title, intro, items) {
    clear();
    var s = el('div', null, 'sheet'); s.appendChild(el('h1', title)); s.appendChild(el('p', intro));
    var ul = el('ul', null, 'check'); items.forEach(function (x) { ul.appendChild(el('li', x)); }); s.appendChild(ul);
    area.appendChild(s); print();
  }
  var SETUP = ['Walk through and decide what is in the sale and what is not', 'Close off rooms and items that are not for sale',
    'Set up tables with good light and a walkway around each', 'Group items by room or category; decide box lots',
    'Print lot labels and the inventory worksheet', 'Number lots in closing order; label each with painter\'s tape or a printed label',
    'Record every lot on the worksheet as it is numbered', 'Photograph each lot: whole item first, then sides, marks and flaws',
    'Measure furniture and large items', 'Catalog lots on Advantage.Bid; review every description', 'Choose your three featured lots',
    'Set the pickup date and window', 'Check the catalog against the labels and the worksheet', 'Submit or publish the auction'];
  var PICKUP = ['Have the list of sold lots and their buyers ready', 'Stage sold lots in lot-number order', 'Set up the pickup table: list, pen, tape, bags and boxes',
    'Clear a path for furniture and large items', 'Have at least one other person with you', 'Check each buyer\'s name and paid invoice before releasing lots',
    'Mark each lot collected on the pickup list', 'Keep to the published pickup window', 'Note any lot not collected and contact Advantage.Bid support',
    'Lock up and secure anything not in the sale'];

  document.getElementById('p-labels').addEventListener('click', labels);
  document.getElementById('p-worksheet').addEventListener('click', worksheet);
  document.getElementById('p-setup').addEventListener('click', function () { checklist('Advantage.Bid Auction Setup Checklist', 'From the first walk-through to publishing your catalog.', SETUP); });
  document.getElementById('p-pickup').addEventListener('click', function () { checklist('Advantage.Bid Pickup Day Checklist', 'Release only lots with a paid invoice.', PICKUP); });
})();
