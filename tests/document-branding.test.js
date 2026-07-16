'use strict';

/**
 * PR H — Advantage.Bid document branding.
 *
 * The PDF logo lockup is drawn with native pdfkit primitives (pdfkit cannot embed
 * SVG and we deliberately avoid a rasterizer dependency). These tests drive the real
 * drawing functions against a recording mock of a pdfkit document and assert the
 * badge + "Advantage.Bid" wordmark are drawn in the brand colors — no image render
 * needed. The email header is asserted as a string.
 */

const doc = require('../src/services/documentService');

// Minimal chainable recorder that mimics the pdfkit surface the brand code uses.
function mockDoc() {
  const calls = { text: [], fill: [], fillColor: [], roundedRect: [], rect: [], font: [], fontSize: [] };
  const d = {
    page: { width: 612, height: 792, margins: { left: 50, right: 50, top: 50, bottom: 50 } },
    y: 50,
    save() { return d; },
    restore() { return d; },
    moveDown() { return d; },
    roundedRect(x, y, w, h) { calls.roundedRect.push({ x, y, w, h }); return d; },
    rect(x, y, w, h) { calls.rect.push({ x, y, w, h }); return d; },
    fill(color) { if (color) calls.fill.push(color); return d; },
    fillColor(c) { calls.fillColor.push(c); return d; },
    font(f) { calls.font.push(f); return d; },
    fontSize(s) { calls.fontSize.push(s); return d; },
    text(t) { calls.text.push(String(t)); return d; },
    widthOfString() { return 90; },
    lineWidth() { return d; },
    strokeColor() { return d; },
    moveTo() { return d; },
    lineTo() { return d; },
    stroke() { return d; },
  };
  return { d, calls };
}

describe('PDF brand lockup', () => {
  test('draws a blue badge, a serif "A", and the "Advantage" + ".Bid" wordmark', () => {
    const { d, calls } = mockDoc();
    const w = doc.drawBrandLockup(d, 50, 50, { badge: 26 });

    // Blue rounded badge.
    expect(calls.roundedRect.length).toBeGreaterThan(0);
    expect(calls.fill).toContain(doc.BRAND.blue);

    // The badge glyph + both wordmark segments.
    expect(calls.text).toContain('A');
    expect(calls.text).toContain('Advantage');
    expect(calls.text).toContain('.Bid');

    // Wordmark uses the two brand colors (navy for "Advantage", blue for ".Bid").
    expect(calls.fillColor).toContain(doc.BRAND.navy);
    expect(calls.fillColor).toContain(doc.BRAND.blue);

    // Reports a positive width for right-alignment callers.
    expect(w).toBeGreaterThan(26);
  });

  test('right-aligns within a given right edge', () => {
    const { d, calls } = mockDoc();
    const rightEdge = 500;
    doc.drawBrandLockup(d, 0, 50, { badge: 24, rightEdge });
    const badgeX = calls.roundedRect[0].x;
    // Badge starts left of the right edge by roughly the lockup width (26+8+90).
    expect(badgeX).toBeLessThan(rightEdge);
    expect(badgeX).toBeGreaterThan(rightEdge - 200);
  });

  test('drawBrandHeader renders a valid invoice PDF via the real pipeline', async () => {
    const buf = await doc.renderPdf((d) => {
      doc.drawBrandHeader(d, { docTitle: 'INVOICE', docSubtitle: '#AAC-000123' });
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('BRAND name is the canonical Advantage.Bid wordmark', () => {
    expect(doc.BRAND.name).toBe('Advantage.Bid');
  });
});

describe('email brand header', () => {
  const html = doc.emailBrandHeader();

  test('is an email-safe inline-styled badge + Advantage.Bid wordmark (no external image)', () => {
    expect(html).toContain('Advantage');
    expect(html).toContain('.Bid');
    expect(html).toContain('#2563eb');            // brand blue badge/accent
    expect(html).toMatch(/display:inline-block/); // inline-block badge, email-safe
    expect(html).not.toMatch(/<img|src=/);        // no image to be stripped
    expect(html).not.toMatch(/cloudinary|railway|neon|postmark/i); // no vendor names
  });

  test('renders as one self-contained header string', () => {
    expect(html.startsWith('<div')).toBe(true);
    expect(html.trim().endsWith('</div>')).toBe(true);
  });
});
