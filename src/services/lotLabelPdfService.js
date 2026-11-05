'use strict';

/**
 * lotLabelPdfService: printable lot labels as a PDF at exact size (Seller How To Center, owner request 2026-11-05).
 * The geometry comes from public/js/lot-label-layout.js, the same file the print page uses, so the PDF and the
 * browser print match. Avery 5160 (30 per US Letter sheet) or plain paper with cut lines, plus a one-page
 * calibration sheet. Made on request from the query values; nothing is stored.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const L = require('../../public/js/lot-label-layout');

const PT = 72;
const LOGO = path.join(__dirname, '..', '..', 'public', 'img', 'brand', 'advantage-bid-logo.png');
const F = L.AVERY_5160;

// Shortens text with an ellipsis until it fits the width at the doc's current font and size.
function fit(doc, text, width) {
  if (!text || doc.widthOfString(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.widthOfString(s + '…') > width) s = s.slice(0, -1);
  return s.replace(/\s+$/, '') + '…';
}

function drawLabel(doc, logo, n, at, o) {
  const x = at.x * PT; const y = at.y * PT; const w = F.labelW * PT; const h = F.labelH * PT;
  const px = L.PAD_X * PT; const py = L.PAD_Y * PT; const innerW = w - 2 * px;
  if (o.plain) doc.save().lineWidth(0.5).dash(2, { space: 2 }).strokeColor('#94a3b8').roundedRect(x, y, w, h, 5).stroke().undash().restore();
  const footer = Boolean(o.seller || o.auction || o.web);
  const footH = footer ? 14 : 0;
  const topH = h - 2 * py - footH;

  // Lot number (largest element), with a small LOT caption above it.
  const size = L.numberSize(n);
  const blockH = 7 + size * 0.74;
  const by = y + py + Math.max(0, (topH - blockH) / 2);
  doc.fillColor(L.NAVY).font('Helvetica-Bold').fontSize(6.5).text('LOT', x + px, by, { characterSpacing: 1.6, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(size).text(String(n), x + px - size * 0.04, by + 6.2, { lineBreak: false });

  // The official logo, right-aligned in the upper area.
  const lw = L.LOGO_W * PT; const lh = lw / L.LOGO_RATIO;
  doc.image(logo, x + w - px - lw, y + py + (topH - lh) / 2, { width: lw });

  if (footer) {
    const fy = y + h - py - footH + 3.5;
    doc.save().lineWidth(0.6).strokeColor(L.BLUE).moveTo(x + px, fy).lineTo(x + w - px, fy).stroke().restore();
    let room = innerW;
    const ty = fy + 3.2;
    if (o.web) {
      doc.font('Helvetica-Bold').fontSize(6.3).fillColor(L.BLUE);
      const ww = doc.widthOfString('advantage.bid');
      doc.text('advantage.bid', x + w - px - ww, ty + 0.4, { lineBreak: false });
      room -= ww + 6;
    }
    let cx = x + px;
    if (o.seller) {
      doc.font('Helvetica-Bold').fontSize(6.8).fillColor(L.NAVY);
      const s = fit(doc, o.seller, o.auction ? room * 0.55 : room);
      doc.text(s, cx, ty, { lineBreak: false }); const sw = doc.widthOfString(s); cx += sw; room -= sw;
    }
    if (o.auction && room > 20) {
      doc.font('Helvetica').fontSize(6.8).fillColor('#334155');
      const lead = o.seller ? '  ·  ' : '';
      doc.text(fit(doc, lead + o.auction, room), cx, ty, { lineBreak: false });
    }
  }
}

function drawCalibration(doc) {
  doc.fillColor(L.NAVY).font('Helvetica-Bold').fontSize(9)
    .text('Advantage.Bid lot labels: calibration sheet (print on plain paper)', 0.25 * PT, 0.18 * PT, { lineBreak: false });
  for (let i = 0; i < F.perSheet; i++) {
    const p = L.position(i);
    doc.save().lineWidth(0.5).strokeColor('#64748b').roundedRect(p.x * PT, p.y * PT, F.labelW * PT, F.labelH * PT, 5).stroke().restore();
  }
  // A 1 inch square and a 2 5/8 inch line inside the first label: measure them on the printed page.
  const p = L.position(0);
  doc.save().lineWidth(0.8).strokeColor('#b91c1c').rect((p.x + 0.12) * PT, (p.y + 0.0) * PT, PT, PT).stroke().restore();
  doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(6.5)
    .text('Square = exactly 1 in', (p.x + 1.22) * PT, (p.y + 0.3) * PT, { lineBreak: false })
    .text('Label = 2 5/8 in wide', (p.x + 1.22) * PT, (p.y + 0.45) * PT, { lineBreak: false });
  const lines = [
    'How to check: print this page at Actual size (100%), then hold it behind a sheet of labels against a window or lamp.',
    'Every outline should sit on a label. If the outlines are smaller, the printer scaled the page: choose Actual size, not Fit.',
    'Turn off headers and footers. If everything is shifted the same way, use the printer\'s alignment setting or manual feed.',
  ];
  doc.font('Helvetica').fontSize(7.5).fillColor('#0f172a');
  lines.forEach((t, k) => doc.text(t, 0.25 * PT, (10.62 + k * 0.12) * PT, { lineBreak: false }));
}

/** Streams the PDF into `out` (a writable stream). Returns the normalized options. */
function render(query, out) {
  const o = L.normalize(query || {});
  const calibrate = query && (query.mode === 'calibrate');
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: false,
    info: { Title: calibrate ? 'Advantage.Bid lot label calibration sheet' : 'Advantage.Bid lot labels ' + o.from + ' to ' + o.to, Author: 'Advantage.Bid', Creator: 'Advantage.Bid' } });
  doc.pipe(out);
  if (calibrate) { doc.addPage(); drawCalibration(doc); doc.end(); return Object.assign(o, { calibrate: true }); }
  const logo = doc.openImage(LOGO);
  for (let i = 0; i < o.count; i++) {
    if (i % F.perSheet === 0) doc.addPage();
    drawLabel(doc, logo, o.from + i, L.position(i), o);
  }
  doc.end();
  return o;
}

module.exports = { render, fit };
