// Seller Payout Profile — pure status + masking (Increment 5). Security-critical:
// masked output must never expose routing/account numbers or the Stripe reference.
const pp = require('../src/lib/payoutProfile');

describe('payoutProfileStatus', () => {
  test('no profile / no method → Incomplete', () => {
    expect(pp.payoutProfileStatus(null)).toBe(pp.PAYOUT_STATUS.INCOMPLETE);
    expect(pp.payoutProfileStatus({})).toBe(pp.PAYOUT_STATUS.INCOMPLETE);
  });
  test('check: partial → Needs Attention, full → Ready', () => {
    expect(pp.payoutProfileStatus({ payout_method: 'check', check_payee_name: 'Jane Roe' })).toBe(pp.PAYOUT_STATUS.NEEDS_ATTENTION);
    expect(pp.payoutProfileStatus({
      payout_method: 'check', check_payee_name: 'Jane Roe', check_address_line1: '1 Main St',
      check_city: 'Detroit', check_state: 'MI', check_postal_code: '48226',
    })).toBe(pp.PAYOUT_STATUS.READY);
  });
  test('ach: no Stripe ref → Needs Attention, with ref → Ready', () => {
    expect(pp.payoutProfileStatus({ payout_method: 'ach' })).toBe(pp.PAYOUT_STATUS.NEEDS_ATTENTION);
    expect(pp.payoutProfileStatus({ payout_method: 'ach', stripe_bank_account_ref: 'ba_123' })).toBe(pp.PAYOUT_STATUS.READY);
  });
});

describe('maskedPayoutSummary — never leaks confidential banking data', () => {
  const achRow = {
    payout_method: 'ach',
    stripe_bank_account_ref: 'ba_SECRET_TOKEN_123',
    ach_routing_last4: '9999',      // even a last4 routing must not surface
    ach_account_last4: '4831',
    ach_account_name: 'Jane Roe',
    bank_name: 'Example Bank',
    ach_account_type: 'checking',
    is_verified: true,
  };
  test('ACH masked summary exposes only safe display fields', () => {
    const m = pp.maskedPayoutSummary(achRow);
    expect(m).toEqual({ method: 'ach', status: 'ready', bank_name: 'Example Bank', account_type: 'checking', last4: '4831', verified: true });
  });
  test('the serialized ACH summary contains no Stripe ref / routing / account-name', () => {
    const json = JSON.stringify(pp.maskedPayoutSummary(achRow));
    expect(json).not.toContain('ba_SECRET_TOKEN_123');
    expect(json).not.toContain('stripe_bank_account_ref');
    expect(json).not.toContain('9999');                // routing last4
    expect(json).not.toContain('ach_routing_last4');
    expect(json).not.toContain('Jane Roe');            // account holder name not surfaced for ACH
    expect(json).toContain('4831');                    // account last4 IS shown (safe display)
  });
  test('check masked summary shows the mailing address (needed to mail the check), no bank secrets', () => {
    const m = pp.maskedPayoutSummary({
      payout_method: 'check', check_payee_name: 'Jane Roe', check_address_line1: '1 Main St',
      check_city: 'Detroit', check_state: 'MI', check_postal_code: '48226',
      stripe_bank_account_ref: 'ba_should_not_appear',
    });
    expect(m.method).toBe('check');
    expect(m.payee_name).toBe('Jane Roe');
    expect(m.city).toBe('Detroit');
    const json = JSON.stringify(m);
    expect(json).not.toContain('ba_should_not_appear');
    expect(json).not.toContain('stripe_bank_account_ref');
  });
  test('no method → minimal incomplete summary', () => {
    expect(pp.maskedPayoutSummary({})).toEqual({ method: null, status: 'incomplete' });
  });
});

describe('tax placeholder', () => {
  test('exposes the three future statuses with labels', () => {
    expect(pp.TAX_STATUS).toEqual({ NOT_STARTED: 'not_started', IN_PROGRESS: 'in_progress', COMPLETED: 'completed' });
    expect(pp.TAX_STATUS_LABEL.not_started).toBe('Not Started');
  });
});
