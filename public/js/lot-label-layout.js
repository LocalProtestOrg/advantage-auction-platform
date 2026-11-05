/* Lot label geometry: ONE definition for the printed page (/seller-how-to) and the PDF download
   (/api/public/printables/lot-labels.pdf). Avery 5160 / 8160 and compatible: 30 labels per US Letter sheet,
   3 columns x 10 rows, each 2 5/8 in x 1 in; 0.5 in top margin, 3/16 in side margins, 1/8 in between columns.
   All measurements are inches. Works in the browser (window.AdvLotLabels) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AdvLotLabels = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var AVERY_5160 = Object.freeze({
    name: 'Avery 5160', pageW: 8.5, pageH: 11, cols: 3, rows: 10, perSheet: 30,
    labelW: 2.625, labelH: 1, top: 0.5, left: 0.1875, gapX: 0.125, gapY: 0,
  });
  var MAX_LOT = 99999;
  var MAX_LABELS = 600; // 20 sheets per print or download

  // Top-left corner of label i (0-based, across then down) on its sheet.
  function position(i, f) {
    f = f || AVERY_5160;
    var k = i % f.perSheet; var col = k % f.cols; var row = Math.floor(k / f.cols);
    return { sheet: Math.floor(i / f.perSheet), x: f.left + col * (f.labelW + f.gapX), y: f.top + row * (f.labelH + f.gapY) };
  }

  function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

  // Normalizes the form values. Returns { from, to, count, sheets, seller, auction, web, plain, capped }.
  function normalize(o) {
    o = o || {};
    var from = parseInt(o.from, 10); var to = parseInt(o.to, 10);
    if (!(from >= 1 && from <= MAX_LOT)) from = 101;
    if (!(to >= 1 && to <= MAX_LOT)) to = from + 29;
    if (to < from) { var t = to; to = from; from = t; }
    var capped = false;
    if (to - from + 1 > MAX_LABELS) { to = from + MAX_LABELS - 1; capped = true; }
    var count = to - from + 1;
    return {
      from: from, to: to, count: count, sheets: Math.ceil(count / AVERY_5160.perSheet), capped: capped,
      seller: clean(o.seller, 60), auction: clean(o.auction, 70),
      web: !(o.web === false || o.web === '0' || o.web === 'false'),
      plain: o.plain === true || o.plain === '1' || o.plain === 'true',
    };
  }

  // The lot number's type size (points) so up to five digits always fit beside the logo.
  function numberSize(n) { var d = String(n).length; return d <= 3 ? 30 : d === 4 ? 27 : 23; }

  return { AVERY_5160: AVERY_5160, MAX_LOT: MAX_LOT, MAX_LABELS: MAX_LABELS, position: position, normalize: normalize, numberSize: numberSize, clean: clean,
    LOGO_W: 1.40, LOGO_RATIO: 900 / 234, PAD_X: 0.11, PAD_Y: 0.075, NAVY: '#0f1f3d', BLUE: '#1a56db' };
}));
