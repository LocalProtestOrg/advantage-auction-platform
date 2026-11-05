'use strict';

// Lot label geometry (shared by the print page and the PDF) and the PDF renderer: Avery 5160 positions, input
// normalization, and exact Letter pages with 30 labels per sheet.

const { PassThrough } = require('stream');
const L = require('../public/js/lot-label-layout');
const pdf = require('../src/services/lotLabelPdfService');

function render(q) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough(); const chunks = [];
    out.on('data', (c) => chunks.push(c)); out.on('end', () => resolve(Buffer.concat(chunks).toString('latin1'))); out.on('error', reject);
    pdf.render(q, out);
  });
}

describe('Avery 5160 geometry', () => {
  test('30 labels, 3 across and 10 down, filling the sheet exactly', () => {
    const f = L.AVERY_5160;
    expect(f.cols * f.rows).toBe(f.perSheet);
    expect(f.left * 2 + f.cols * f.labelW + (f.cols - 1) * f.gapX).toBeCloseTo(f.pageW, 6);
    expect(f.top * 2 + f.rows * f.labelH).toBeCloseTo(f.pageH, 6);
    expect(L.position(0)).toEqual({ sheet: 0, x: 0.1875, y: 0.5 });
    expect(L.position(2)).toEqual({ sheet: 0, x: 0.1875 + 2 * 2.75, y: 0.5 });
    expect(L.position(29)).toEqual({ sheet: 0, x: 0.1875 + 2 * 2.75, y: 9.5 });
    expect(L.position(30)).toEqual({ sheet: 1, x: 0.1875, y: 0.5 });
  });
  test('normalize: swaps a reversed range, caps at 600 labels, cleans text, keeps defaults for bad input', () => {
    expect(L.normalize({ from: '140', to: '101' })).toMatchObject({ from: 101, to: 140, count: 40, sheets: 2, capped: false });
    expect(L.normalize({ from: '1', to: '5000' })).toMatchObject({ from: 1, to: 600, count: 600, sheets: 20, capped: true });
    expect(L.normalize({ from: 'x', to: '-3' })).toMatchObject({ from: 101, to: 130, count: 30 });
    expect(L.normalize({ seller: '<b>Harbor</b>\n Sales', web: '0', plain: '1' })).toMatchObject({ seller: 'b Harbor /b Sales', web: false, plain: true });
    expect(L.normalize({}).web).toBe(true);
  });
  test('five-digit lot numbers get a smaller size so they always fit beside the logo', () => {
    expect([L.numberSize(7), L.numberSize(101), L.numberSize(1001), L.numberSize(99999)]).toEqual([30, 30, 27, 23]);
  });
});

describe('PDF', () => {
  const pages = (s) => (s.match(/\/Type \/Page\b/g) || []).length;
  test('Letter pages, one per 30 labels; the logo image is embedded once', async () => {
    const s = await render({ from: '101', to: '161', seller: 'Harbor Estate Sales', auction: 'Westside' });
    expect(s.slice(0, 5)).toBe('%PDF-');
    expect(pages(s)).toBe(3);
    expect(s).toMatch(/\/MediaBox \[0 0 612 792\]/);
    expect((s.match(/\/Subtype \/Image/g) || []).length).toBeLessThanOrEqual(2); // the logo (plus its transparency mask)
  });
  test('calibration sheet is a single page', async () => {
    expect(pages(await render({ mode: 'calibrate' }))).toBe(1);
  });
  test('fit() shortens long names with an ellipsis', async () => {
    const PDFDocument = require('pdfkit'); const doc = new PDFDocument(); doc.font('Helvetica').fontSize(7);
    const s = pdf.fit(doc, 'A Very Long Business Name That Keeps Going and Going', 60);
    expect(s.endsWith('…')).toBe(true); expect(doc.widthOfString(s)).toBeLessThanOrEqual(60);
  });
});
