// Seller settlement policy — 0% platform fee at launch + shared status/audit vocab.
const sp = require('../src/lib/settlementPolicy');

describe('settlementPolicy', () => {
  test('seller platform fee is 0% at launch', () => {
    expect(sp.PLATFORM_FEE_RATE).toBe(0);
  });

  test('platformFeeCents is always 0 while the rate is 0 (cents-safe)', () => {
    expect(sp.platformFeeCents(0)).toBe(0);
    expect(sp.platformFeeCents(12345)).toBe(0);
    expect(sp.platformFeeCents(99999999)).toBe(0);
    // never throws / never NaN on bad input
    expect(sp.platformFeeCents(undefined)).toBe(0);
    expect(sp.platformFeeCents(null)).toBe(0);
    expect(sp.platformFeeCents(NaN)).toBe(0);
    expect(Number.isInteger(sp.platformFeeCents(50050))).toBe(true);
  });

  test('net = gross when platform fee is 0 (the retired 10% is gone)', () => {
    const gross = 250000; // $2,500.00
    const fee = sp.platformFeeCents(gross);
    expect(fee).toBe(0);
    expect(gross - fee).toBe(gross);
  });

  test('exposes the approved 5-state settlement status workflow', () => {
    expect(sp.SETTLEMENT_STATUS).toEqual({
      PENDING_REVIEW: 'pending_review',
      APPROVED: 'approved',
      READY_FOR_PAYMENT: 'ready_for_payment',
      PAID: 'paid',
      ON_HOLD: 'on_hold',
    });
    expect(sp.SETTLEMENT_STATUS_LABEL[sp.SETTLEMENT_STATUS.READY_FOR_PAYMENT]).toBe('Ready for Payment');
    expect(sp.SETTLEMENT_STATUS_LABEL[sp.SETTLEMENT_STATUS.ON_HOLD]).toBe('On Hold');
  });

  test('status + audit maps are frozen (immutable source of truth)', () => {
    expect(Object.isFrozen(sp.SETTLEMENT_STATUS)).toBe(true);
    expect(Object.isFrozen(sp.SETTLEMENT_AUDIT_EVENTS)).toBe(true);
  });

  test('defines the material settlement audit events', () => {
    const keys = Object.keys(sp.SETTLEMENT_AUDIT_EVENTS);
    ['PAYOUT_PREF_ADDED', 'SETTLEMENT_CREATED', 'ADJUSTMENT_ADDED', 'SETTLEMENT_APPROVED',
     'SETTLEMENT_MARKED_PAID', 'REFUND_OR_CREDIT_APPLIED', 'MARKETING_CHARGE_INCLUDED']
      .forEach(k => expect(keys).toContain(k));
    // every value is namespaced under settlement.*
    Object.values(sp.SETTLEMENT_AUDIT_EVENTS).forEach(v => expect(v.startsWith('settlement.')).toBe(true));
  });
});
