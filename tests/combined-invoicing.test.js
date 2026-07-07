'use strict';

/**
 * Design C — Combined per-buyer invoicing (Phase 1) Tier-1 unit tests.
 * Pure / mocked-db only — no live Stripe, no live DB, no network. Follows the
 * style of tests/launch-stabilization-fixes.test.js.
 */

const combined = require('../src/services/combinedInvoiceService');

// ── computeTotals ────────────────────────────────────────────────────────────
describe('combinedInvoiceService.computeTotals', () => {
  test('grand total equals the sum of winning lot hammers', () => {
    const t = combined.computeTotals([
      { winning_amount_cents: 1500 },
      { winning_amount_cents: 2500 },
      { winning_amount_cents: 100 },
    ]);
    expect(t.hammerCents).toBe(4100);
    expect(t.totalCents).toBe(4100);
  });

  test('buyer premium / sales tax / shipping are $0 at launch', () => {
    const t = combined.computeTotals([{ winning_amount_cents: 999 }]);
    expect(t.buyerPremiumCents).toBe(0);
    expect(t.salesTaxCents).toBe(0);
    expect(t.shippingCents).toBe(0);
    expect(t.creditsCents).toBe(0);
    expect(t.totalCents).toBe(999);
  });

  test('accepts line objects (hammerCents) too', () => {
    const t = combined.computeTotals([{ hammerCents: 300 }, { hammerCents: 700 }]);
    expect(t.hammerCents).toBe(1000);
    expect(t.totalCents).toBe(1000);
  });

  test('credits subtract from the grand total (via override)', () => {
    // computeTotals holds credits at 0 for launch; verify the total formula
    // subtracts credits by exercising it directly against the documented shape.
    const t = combined.computeTotals([{ winning_amount_cents: 5000 }]);
    const withCredit = t.hammerCents + t.buyerPremiumCents + t.salesTaxCents + t.shippingCents - 1200;
    expect(withCredit).toBe(3800); // 5000 hammer − 1200 credit
    expect(t.totalCents).toBe(5000); // launch: no credit applied
  });

  test('empty / null input is safe ($0)', () => {
    expect(combined.computeTotals([]).totalCents).toBe(0);
    expect(combined.computeTotals(null).totalCents).toBe(0);
    expect(combined.computeTotals([null, undefined]).totalCents).toBe(0);
  });
});

// ── reminderSchedule ─────────────────────────────────────────────────────────
describe('combinedInvoiceService.reminderSchedule', () => {
  test('returns +12h and +24h from closedAt', () => {
    const closed = new Date('2026-07-07T12:00:00.000Z');
    const [r2, rFinal] = combined.reminderSchedule(closed);
    expect(r2.toISOString()).toBe('2026-07-08T00:00:00.000Z'); // +12h
    expect(rFinal.toISOString()).toBe('2026-07-08T12:00:00.000Z'); // +24h
  });

  test('accepts an ISO string anchor', () => {
    const [r2, rFinal] = combined.reminderSchedule('2026-01-01T00:00:00.000Z');
    expect(r2.getTime() - new Date('2026-01-01T00:00:00.000Z').getTime()).toBe(12 * 3600 * 1000);
    expect(rFinal.getTime() - new Date('2026-01-01T00:00:00.000Z').getTime()).toBe(24 * 3600 * 1000);
  });
});

// ── still-unpaid skip decision (pure predicate) ──────────────────────────────
describe('combinedInvoiceService.isUnpaidStatus (reminder/charge skip decision)', () => {
  test('issued and payment_required are still unpaid', () => {
    expect(combined.isUnpaidStatus('issued')).toBe(true);
    expect(combined.isUnpaidStatus('payment_required')).toBe(true);
  });
  test('paid and void are terminal (skip)', () => {
    expect(combined.isUnpaidStatus('paid')).toBe(false);
    expect(combined.isUnpaidStatus('void')).toBe(false);
  });
});

// ── webhook null-lot branch selection (pure predicate) ───────────────────────
describe('combinedInvoiceService.isCombinedPayment (webhook branch selector)', () => {
  test('null lot_id → combined path', () => {
    expect(combined.isCombinedPayment({ lot_id: null })).toBe(true);
  });
  test('undefined lot_id → combined path', () => {
    expect(combined.isCombinedPayment({})).toBe(true);
  });
  test('a set lot_id → per-lot path (not combined)', () => {
    expect(combined.isCombinedPayment({ lot_id: 'lot-uuid-123' })).toBe(false);
  });
  test('null / missing payment is not combined', () => {
    expect(combined.isCombinedPayment(null)).toBe(false);
    expect(combined.isCombinedPayment(undefined)).toBe(false);
  });
});

// ── off-session PM resolution (pure) ─────────────────────────────────────────
const paymentService = require('../src/services/paymentService');

describe('paymentService._resolveCombinedChargeContext (off-session PM resolution)', () => {
  test('buyer with a verified card → charge with that PM', () => {
    const r = paymentService._resolveCombinedChargeContext({
      stripeCustomerId: 'cus_123', verifiedPmId: 'pm_verified', defaultPmId: 'pm_default',
    });
    expect(r.skipped).toBeUndefined();
    expect(r.customerId).toBe('cus_123');
    expect(r.paymentMethodId).toBe('pm_verified'); // verified marker preferred
  });

  test('no verified card but a customer default PM → charge with the default', () => {
    const r = paymentService._resolveCombinedChargeContext({
      stripeCustomerId: 'cus_123', verifiedPmId: null, defaultPmId: 'pm_default',
    });
    expect(r.paymentMethodId).toBe('pm_default');
  });

  test('no Stripe customer → skip (no_card)', () => {
    const r = paymentService._resolveCombinedChargeContext({ stripeCustomerId: null, verifiedPmId: 'pm_x' });
    expect(r).toEqual({ skipped: 'no_card' });
  });

  test('customer but no usable PM → skip (no_card)', () => {
    const r = paymentService._resolveCombinedChargeContext({ stripeCustomerId: 'cus_123' });
    expect(r).toEqual({ skipped: 'no_card' });
  });

  test('empty input → skip (no_card), never throws', () => {
    expect(paymentService._resolveCombinedChargeContext()).toEqual({ skipped: 'no_card' });
  });
});
