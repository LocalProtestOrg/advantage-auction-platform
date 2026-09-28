'use strict';

/**
 * Invoice status follows a refund (2026-09-28). Found in the first LIVE test: after a full $4.99 refund the payment
 * said "refunded" but the buyer's invoices still said "paid".
 *   - both refund paths (admin processRefund + the charge.refunded webhook) move the invoices in the SAME transaction;
 *   - full refund → 'refunded' (also upgrades a partial); partial → 'partially_refunded' (never downgrades a full one);
 *   - a refunded invoice is never chased for payment, marked failed, re-settled to "paid", or offered "Pay Now";
 *   - settlement still counts it as collected (the refund is subtracted once, from the payment) — no double count;
 *   - admin totals show it as refunded, not unpaid.
 */

jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { syncInvoicesForPayment } = require('../src/services/invoiceRefundStatus');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function recorder(paymentStatus) {
  const calls = [];
  return { calls, query: jest.fn(async (sql, params) => {
    calls.push([sql, params]);
    if (/SELECT status FROM payments/.test(sql)) return { rows: paymentStatus ? [{ status: paymentStatus }] : [] };
    return { rowCount: 1, rows: [] };
  }) };
}

describe('syncInvoicesForPayment', () => {
  test('full refund → per-lot and combined invoices become refunded (from paid or partially refunded)', async () => {
    const r = recorder();
    const out = await syncInvoicesForPayment(r, 'pay-1', 'refunded');
    expect(out).toEqual({ status: 'refunded', invoices: 1, combined: 1 });
    const [inv, bai] = r.calls;
    expect(inv[0]).toMatch(/^UPDATE invoices SET status = \$2 WHERE payment_id = \$1 AND status = ANY\(\$3::text\[\]\)$/);
    expect(inv[1]).toEqual(['pay-1', 'refunded', ['paid', 'partially_refunded']]);
    expect(bai[0]).toMatch(/UPDATE buyer_auction_invoices SET status = \$2, updated_at = now\(\) WHERE payment_id = \$1/);
    expect(bai[1]).toEqual(['pay-1', 'refunded', ['paid', 'partially_refunded']]);
    expect(r.calls.some(([s]) => /SELECT status FROM payments/.test(s))).toBe(false);   // status passed in: no extra read
  });
  test('partial refund → partially_refunded, and only from paid (never downgrades a full refund)', async () => {
    const r = recorder();
    await syncInvoicesForPayment(r, 'pay-1', 'partially_refunded');
    expect(r.calls[0][1]).toEqual(['pay-1', 'partially_refunded', ['paid']]);
    expect(r.calls[1][1]).toEqual(['pay-1', 'partially_refunded', ['paid']]);
  });
  test('reads the payment when no status is given; a non-refund status changes nothing', async () => {
    const paid = recorder('paid');
    await expect(syncInvoicesForPayment(paid, 'pay-1')).resolves.toEqual({ status: null, invoices: 0, combined: 0 });
    expect(paid.calls).toHaveLength(1);
    const refunded = recorder('refunded');
    await expect(syncInvoicesForPayment(refunded, 'pay-1')).resolves.toMatchObject({ status: 'refunded' });
  });
});

describe('both refund paths update the invoices inside the refund transaction', () => {
  const src = read('src', 'services', 'paymentService.js');
  test('admin processRefund: sync runs on the persist client before COMMIT, with the new status', () => {
    const i = src.indexOf("syncInvoicesForPayment(persistClient, paymentId, newStatus)");
    expect(i).toBeGreaterThan(-1);
    expect(src.indexOf("await persistClient.query('COMMIT')", i)).toBeGreaterThan(i);
  });
  test('webhook charge.refunded (refund made outside the app): same, plus an idempotent re-sync on an echo', () => {
    const i = src.indexOf("syncInvoicesForPayment(client, payment.id, newStatus)");
    expect(i).toBeGreaterThan(-1);
    expect(src.indexOf("await client.query('COMMIT')", i)).toBeGreaterThan(i);
    expect(src).toMatch(/already reconciled[\s\S]{0,400}syncInvoicesForPayment\(db, payment\.id\)/);
  });
});

describe('a refunded invoice is settled history', () => {
  const cis = require('../src/services/combinedInvoiceService');
  test('never "still unpaid" (no payment reminders or charges)', async () => {
    for (const st of ['refunded', 'partially_refunded', 'paid', 'void']) {
      db.query.mockResolvedValueOnce({ rows: [{ status: st }] });
      await expect(cis.stillUnpaid('ci-1')).resolves.toBe(false);
    }
  });
  test('a late or replayed payment success never flips it back to paid', async () => {
    const client = { query: jest.fn(async (sql) => (/FROM buyer_auction_invoices WHERE id = \$1 FOR UPDATE/.test(sql)
      ? { rows: [{ id: 'ci-1', auction_id: 'a', buyer_user_id: 'b', status: 'refunded' }] } : { rows: [] })), release: jest.fn() };
    db.connect.mockResolvedValueOnce(client);
    await expect(cis.settleCombined('ci-1', 'pi_1', 'pay-1')).resolves.toEqual({ alreadyPaid: true });
    expect(client.query.mock.calls.some(([s]) => /^\s*UPDATE\b/.test(s))).toBe(false);   // (SELECT … FOR UPDATE is the lock)
  });
  test('never marked "payment required", never offered Pay Now, still counted as an invoice record', () => {
    expect(read('src', 'services', 'combinedInvoiceService.js')).toMatch(/WHEN status IN \('paid', 'void', 'refunded', 'partially_refunded'\) THEN status/);
    expect(read('src', 'routes', 'invoices.js')).toMatch(/i2\.status NOT IN \('paid', 'refunded', 'partially_refunded', 'void'\)/);
    expect(read('src', 'services', 'auctionService.js')).toMatch(/status IN \('issued','paid','partially_refunded','refunded'\)\)\s+AS invoices_open/);
  });
  test('settlement still counts it as collected (refunds are subtracted once, from payments)', () => {
    const se = read('src', 'services', 'settlementEngine.js');
    expect(se).toMatch(/SUM\(total_cents\) FILTER \(WHERE status IN \('paid','partially_refunded','refunded'\)\),0\)::bigint\s+AS collected/);
    expect(se).toMatch(/SUM\(hammer_cents\) FILTER \(WHERE status IN \('paid','partially_refunded','refunded'\)\)/);
    expect(se).toMatch(/FILTER \(WHERE status NOT IN \('paid','partially_refunded','refunded','void'\)\),0\)::bigint AS outstanding/);
    expect(se).toMatch(/p\.status === 'paid' \|\| p\.status === 'partially_refunded' \|\| p\.status === 'refunded'/);   // refunds read from payments
  });
});

describe('what people see', () => {
  test('admin invoice totals: refunded is its own bucket, never "unpaid"', () => {
    const a = read('src', 'routes', 'admin.js');
    expect(a).toMatch(/is_paid: !isRefunded\(r\) && \(r\.status === 'paid' \|\| r\.payment_status === 'paid'\)/);
    expect(a).toMatch(/const isUnpaid = \(i\) => !i\.is_paid && !i\.is_refunded;/);
    expect(a).toMatch(/refunded_cents: tot\(enriched\.filter\(\(i\) => i\.is_refunded\), lineTotal\)/);
    const page = read('public', 'admin', 'invoices.html');
    expect(page).toMatch(/<button class="pill" data-s="refunded">Refunded<\/button>/);
    expect(page).toMatch(/i\.status==='refunded'\|\|i\.status==='partially_refunded'/);
  });
  test('buyer page labels full and partial refunds', () => {
    const b = read('public', 'invoices.html');
    expect(b).toMatch(/if\(st==='refunded'\)return\['Refunded','refunded'\];/);
    expect(b).toMatch(/if\(st==='partially_refunded'\)return\['Partially Refunded','refunded'\];/);
  });
  test('migration 179 allows the refund states on combined invoices and backfills from refunded payments', () => {
    const m = read('db', 'migrations', '179_invoice_refund_status.sql');
    expect(m).toMatch(/CHECK \(status IN \('issued', 'payment_required', 'paid', 'void', 'refunded', 'partially_refunded'\)\)/);
    expect(m).toMatch(/UPDATE buyer_auction_invoices b SET status = 'refunded'/);
    expect(m.replace(/--.*$/gm, '')).not.toMatch(/\bDELETE\b|DROP TABLE/i);
  });
});
