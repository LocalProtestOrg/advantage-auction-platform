'use strict';

/**
 * Batch B — Invoices + thumbnail fix.
 *   #6  hide-when-zero financial rows in the combined receipt/invoice emails.
 *   thumbnail  fetchImageBuffer follows HTTP 3xx redirects to the final 200.
 *
 * Pure / local-server only — no live Stripe, no live DB, no external network.
 */

const http = require('http');
const combinedReceipt = require('../src/services/combinedReceiptService');
const documentService = require('../src/services/documentService');

function baseData(summary) {
  return {
    invoiceNumber: 'AAC-C-000123',
    auctionTitle: 'Test Auction',
    lines: [{ lotNumber: 1, title: 'A lamp', hammerCents: 5000 }],
    pickup: {},
    summary,
  };
}

// ── #6 hide-when-zero ────────────────────────────────────────────────────────
describe('#6 combined email summary hides zero rows', () => {
  test('at launch (all extras 0) shows only Hammer + Grand Total', () => {
    const email = combinedReceipt.buildSuccessPackageEmail(baseData({
      hammerCents: 5000, buyerPremiumCents: 0, salesTaxCents: 0,
      shippingCents: 0, creditsCents: 0, totalCents: 5000,
    }));
    expect(email.html).toContain('Hammer Total');
    expect(email.html).toContain('Grand Total');
    expect(email.html).not.toContain('Buyer Premium');
    expect(email.html).not.toContain('Sales Tax');
    expect(email.html).not.toContain('Shipping');
    expect(email.html).not.toContain('Credits / Refunds');
    // text body too
    expect(email.text).toContain('Hammer Total:');
    expect(email.text).toContain('Grand Total:');
    expect(email.text).not.toContain('Buyer Premium:');
    expect(email.text).not.toContain('Sales Tax:');
  });

  test('non-zero extras are shown', () => {
    const email = combinedReceipt.buildPaymentRequiredEmail(baseData({
      hammerCents: 5000, buyerPremiumCents: 750, salesTaxCents: 413,
      shippingCents: 0, creditsCents: 200, totalCents: 5963,
    }), { reminderNo: 1 });
    expect(email.html).toContain('Buyer Premium');
    expect(email.html).toContain('Sales Tax');
    expect(email.html).toContain('Credits / Refunds');
    expect(email.html).not.toContain('Shipping'); // still 0 → hidden
    expect(email.text).toContain('Buyer Premium: $7.50');
    expect(email.text).toContain('Credits / Refunds: -$2.00');
  });
});

// ── thumbnail: follow 3xx redirects ──────────────────────────────────────────
describe('documentService.fetchImageBuffer follows redirects', () => {
  let server, base;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

  beforeAll((done) => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: base + '/final.png' });
        return res.end();
      }
      if (req.url === '/final.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(PNG);
      }
      if (req.url === '/loop') { // endless redirect to exercise the cap
        res.writeHead(302, { Location: base + '/loop' });
        return res.end();
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; done(); });
  });

  afterAll((done) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => done());
  });

  test('follows a 302 to the final 200 image', async () => {
    const buf = await documentService.fetchImageBuffer(base + '/redirect');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(PNG)).toBe(true);
  });

  test('direct 200 still works', async () => {
    const buf = await documentService.fetchImageBuffer(base + '/final.png');
    expect(buf.equals(PNG)).toBe(true);
  });

  test('gives up (null) past the redirect cap, never throws', async () => {
    const buf = await documentService.fetchImageBuffer(base + '/loop', { maxRedirects: 3 });
    expect(buf).toBeNull();
  });
});
