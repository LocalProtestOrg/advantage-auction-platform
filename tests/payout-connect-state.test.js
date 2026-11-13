'use strict';
/**
 * Direct deposit setup states shown on the Payout Profile page (owner 2026-11-12): Not Connected, Setup Incomplete,
 * Verification Required, Ready for Payouts. Derived only from the stored row; the Stripe account id is never returned.
 */
const { connectState, CONNECT_STATE_LABEL } = require('../src/lib/payoutProfile');

test('no payout record, a mailed check, or no Stripe account yet: Not Connected', () => {
  expect(connectState(null)).toBe('not_connected');
  expect(connectState({ payout_method: 'check', check_payee_name: 'X' })).toBe('not_connected');
  expect(connectState({ payout_method: 'ach' })).toBe('not_connected');
});

test('Stripe account started but the form is not finished: Setup Incomplete', () => {
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_status: 'onboarding' })).toBe('setup_incomplete');
});

test('details submitted, restricted, or disabled: Verification Required', () => {
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_details_submitted: true })).toBe('verification_required');
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_status: 'restricted' })).toBe('verification_required');
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_disabled_reason: 'requirements.past_due' })).toBe('verification_required');
  // payouts on but transfers not yet active is still not ready
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_details_submitted: true, connect_payouts_enabled: true })).toBe('verification_required');
});

test('transfers and payouts both active: Ready for Payouts', () => {
  expect(connectState({ payout_method: 'ach', stripe_account_id: 'acct_x', connect_details_submitted: true,
    connect_transfers_active: true, connect_payouts_enabled: true })).toBe('ready');
});

test('every state has the owner-specified label', () => {
  expect(CONNECT_STATE_LABEL).toEqual({ not_connected: 'Not Connected', setup_incomplete: 'Setup Incomplete',
    verification_required: 'Verification Required', ready: 'Ready for Payouts' });
});
