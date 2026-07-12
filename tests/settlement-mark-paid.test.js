// Mark Paid pure validation + payout-preference completeness (Increment 4).
const { assertMarkPaidAllowed, payoutPreferenceComplete, MarkPaidError } = require('../src/services/settlementEngine');
const { SETTLEMENT_STATUS } = require('../src/lib/settlementPolicy');

const goodState = { hasSettlementRow: true, settlementStatus: SETTLEMENT_STATUS.APPROVED, netProceedsCents: 12345, payoutPreferenceComplete: true };
const goodInput = { paymentMethod: 'check', paymentReference: 'CHK-10542', paidAt: '2026-07-15', finalAmountCents: 12345, confirmedCompleted: true };

describe('assertMarkPaidAllowed (pure)', () => {
  test('allows when everything is valid and the amount matches', () => {
    expect(assertMarkPaidAllowed(goodState, goodInput)).toEqual({ ok: true });
  });
  test('rejects when no settlement exists', () => {
    expect(() => assertMarkPaidAllowed({ ...goodState, hasSettlementRow: false }, goodInput)).toThrow(MarkPaidError);
  });
  test('rejects when already paid (immutable)', () => {
    expect(() => assertMarkPaidAllowed({ ...goodState, settlementStatus: SETTLEMENT_STATUS.PAID }, goodInput)).toThrow(/already paid/i);
  });
  test('rejects an invalid payment method', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, paymentMethod: 'wire' })).toThrow(/ach.*check/i);
  });
  test('rejects when the payout preference is incomplete', () => {
    expect(() => assertMarkPaidAllowed({ ...goodState, payoutPreferenceComplete: false }, goodInput)).toThrow(/preference is incomplete/i);
  });
  test('rejects a missing payment reference', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, paymentReference: '  ' })).toThrow(/reference is required/i);
  });
  test('rejects a missing payment date', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, paidAt: null })).toThrow(/payment date is required/i);
  });
  test('rejects without explicit completion confirmation', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, confirmedCompleted: false })).toThrow(/confirmation/i);
  });
  test('rejects when the final amount does not match the calculated settlement', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, finalAmountCents: 12000 })).toThrow(/does not match/i);
  });
  test('rejects a missing/NaN final amount', () => {
    expect(() => assertMarkPaidAllowed(goodState, { ...goodInput, finalAmountCents: undefined })).toThrow(/final net payment amount/i);
  });
  test('accepts each approved reference format', () => {
    ['CHK-10542', 'ACH-20260715-0012', 'WIRE-20260715-04', 'STRIPE-PO-39483'].forEach(ref => {
      const method = ref.startsWith('ACH') ? 'ach' : 'check';
      expect(assertMarkPaidAllowed(goodState, { ...goodInput, paymentMethod: method, paymentReference: ref })).toEqual({ ok: true });
    });
  });
});

describe('payoutPreferenceComplete (pure)', () => {
  test('null preference is incomplete', () => {
    expect(payoutPreferenceComplete(null)).toBe(false);
  });
  test('check requires payee + address', () => {
    expect(payoutPreferenceComplete({ payout_method: 'check', check_payee_name: 'Jane Roe', check_address_line1: '1 Main St' })).toBe(true);
    expect(payoutPreferenceComplete({ payout_method: 'check', check_payee_name: 'Jane Roe' })).toBe(false);
  });
  test('ach requires a stored reference (last4 or Stripe-managed ref)', () => {
    expect(payoutPreferenceComplete({ payout_method: 'ach', ach_account_last4: '6789' })).toBe(true);
    expect(payoutPreferenceComplete({ payout_method: 'ach', stripe_bank_account_ref: 'ba_123' })).toBe(true);
    expect(payoutPreferenceComplete({ payout_method: 'ach' })).toBe(false);
  });
  test('unknown method is incomplete', () => {
    expect(payoutPreferenceComplete({ payout_method: 'crypto' })).toBe(false);
  });
});
