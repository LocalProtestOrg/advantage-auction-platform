'use strict';

/**
 * PR J — seller closeout robustness.
 *
 * Bug: runSellerCloseoutScan stamped auctions.seller_closeout_sent_at as long as
 * generateAndSend did not THROW. But generateAndSend returns {sent:false,skipped:true}
 * (not a throw) for a missing seller email, unconfigured SMTP, or a missing auction —
 * so a skipped closeout was permanently marked "sent" and never retried.
 *
 * Fix: only stamp when the result is a genuine success ({sent:true}); skips/failures
 * are left unstamped and therefore retry-eligible on the next scan.
 *
 * The notification worker self-runs its schedulers on require (setInterval + an
 * immediate call), so it is not safe to import in a unit test. These tests assert the
 * source contract of the stamping decision — mirroring the SEV-1 render-resilience
 * approach — and the generateAndSend result shape the decision relies on.
 */

const fs = require('fs');
const path = require('path');

const WORKER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'workers', 'notificationWorker.js'), 'utf8'
);

function scanBody() {
  const i = WORKER.indexOf('async function runSellerCloseoutScan(');
  expect(i).toBeGreaterThan(-1);
  return WORKER.slice(i, i + 2400);
}

describe('runSellerCloseoutScan stamps only on success', () => {
  test('the stamp UPDATE is guarded by a success check on the result', () => {
    const body = scanBody();
    // The generateAndSend result is captured...
    expect(body).toMatch(/const result = await sellerCloseoutService\.generateAndSend/);
    // ...and the stamp only runs inside a success branch (result.sent).
    expect(body).toMatch(/if \(result && result\.sent\)/);
  });

  test('the stamp is INSIDE the success branch, not unconditional', () => {
    const body = scanBody();
    const guardIdx = body.indexOf('if (result && result.sent)');
    const stampIdx = body.indexOf('seller_closeout_sent_at = now()');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(guardIdx);   // stamp comes after (within) the guard
    // And there is no stamp that runs before the guard (the old unconditional path).
    expect(body.slice(0, guardIdx)).not.toMatch(/seller_closeout_sent_at = now\(\)/);
  });

  test('a non-success outcome is logged as retry-eligible, not stamped', () => {
    const body = scanBody();
    expect(body).toMatch(/left retry-eligible|retry-eligible/i);
  });
});

describe('generateAndSend result shape the guard depends on', () => {
  // Mock db + email so requiring the service does not touch a real DB/SMTP.
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
  jest.doMock('../src/services/emailService', () => ({ sendEmail: jest.fn() }));
  const svc = require('../src/services/sellerCloseoutService');

  test('returns a NON-sent result (skipped) when the seller has no email — no throw', async () => {
    const db = require('../src/db');
    // loadSellerAndAuction → a row with no seller_email.
    db.query.mockResolvedValueOnce({ rows: [{ id: 'a1', title: 'T', seller_email: null }] });
    const r = await svc.generateAndSend('a1');
    expect(r).toMatchObject({ sent: false, skipped: true });
    expect(r.sent).not.toBe(true);   // the guard would NOT stamp
  });

  test('returns skipped (not a throw) when the auction is not found', async () => {
    const db = require('../src/db');
    db.query.mockResolvedValueOnce({ rows: [] });   // loadSellerAndAuction → none
    const r = await svc.generateAndSend('missing');
    expect(r).toMatchObject({ sent: false });
    expect(r.sent).not.toBe(true);
  });
});
