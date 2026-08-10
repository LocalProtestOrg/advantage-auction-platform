'use strict';

/**
 * Version 1.0 Stripe Connect manual-control Direct Deposit.
 * Covers the money-movement SAFEGUARDS (pure guards), the Connect account-status mapper,
 * the webhook handlers (db-mocked), the launch flag, and security/source invariants.
 * Buyer-charge + Stripe-Tax architecture regressions are asserted at the source level.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Mock the DB so services load and webhook handlers can be exercised without a database.
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');

const { stripeConnectEnabled } = require('../src/lib/launchGuards');
const connect = require('../src/services/stripeConnectService');
const engine = require('../src/services/settlementEngine');

beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); });

// ── Launch flag (default OFF) ────────────────────────────────────────────────────────────
describe('STRIPE_CONNECT_ENABLED launch flag', () => {
  test('default (unset) is OFF', () => {
    expect(stripeConnectEnabled({})).toBe(false);
    expect(stripeConnectEnabled({ STRIPE_CONNECT_ENABLED: 'false' })).toBe(false);
    expect(stripeConnectEnabled({ STRIPE_CONNECT_ENABLED: '1' })).toBe(false);
  });
  test("ON only when exactly 'true'", () => {
    expect(stripeConnectEnabled({ STRIPE_CONNECT_ENABLED: 'true' })).toBe(true);
  });
});

// ── PURE: Connect account-status mapper (no raw bank data ever) ──────────────────────────
describe('mapAccountToStatus (pure)', () => {
  test('fully onboarded → ready + safe bank display', () => {
    const m = connect.mapAccountToStatus({
      id: 'acct_1', capabilities: { transfers: 'active' }, payouts_enabled: true, details_submitted: true,
      requirements: { disabled_reason: null },
      external_accounts: { data: [{ object: 'bank_account', bank_name: 'Test Bank', last4: '6789', routing_number: '110000000', account_number: 'SECRET' }] },
    });
    expect(m.connect_status).toBe('ready');
    expect(m.connect_transfers_active).toBe(true);
    expect(m.connect_payouts_enabled).toBe(true);
    expect(m.connect_details_submitted).toBe(true);
    expect(m.connect_bank_name).toBe('Test Bank');
    expect(m.connect_bank_last4).toBe('6789');
    // SECURITY: mapper never carries routing/account numbers.
    const json = JSON.stringify(m);
    expect(json).not.toContain('110000000');
    expect(json).not.toContain('SECRET');
    expect(Object.keys(m)).not.toContain('routing_number');
    expect(Object.keys(m)).not.toContain('account_number');
  });
  test('incomplete onboarding → onboarding', () => {
    const m = connect.mapAccountToStatus({ id: 'acct_2', capabilities: { transfers: 'inactive' }, payouts_enabled: false, details_submitted: false });
    expect(m.connect_status).toBe('onboarding');
    expect(connect.isConnectReady(m)).toBe(false);
  });
  test('restricted (disabled_reason) → restricted', () => {
    const m = connect.mapAccountToStatus({ id: 'acct_3', capabilities: { transfers: 'inactive' }, payouts_enabled: false, details_submitted: true, requirements: { disabled_reason: 'requirements.past_due' } });
    expect(m.connect_status).toBe('restricted');
    expect(m.connect_disabled_reason).toBe('requirements.past_due');
  });
  test('isConnectReady requires transfers active AND payouts enabled', () => {
    expect(connect.isConnectReady({ connect_transfers_active: true, connect_payouts_enabled: true })).toBe(true);
    expect(connect.isConnectReady({ connect_transfers_active: true, connect_payouts_enabled: false })).toBe(false);
    expect(connect.isConnectReady({ connect_transfers_active: false, connect_payouts_enabled: true })).toBe(false);
  });
});

// ── PURE: connectPayoutReady ─────────────────────────────────────────────────────────────
describe('connectPayoutReady (pure)', () => {
  test('true only with acct id + transfers active + payouts enabled', () => {
    expect(engine.connectPayoutReady({ stripe_account_id: 'acct_1', connect_transfers_active: true, connect_payouts_enabled: true })).toBe(true);
    expect(engine.connectPayoutReady({ connect_transfers_active: true, connect_payouts_enabled: true })).toBe(false); // no acct id
    expect(engine.connectPayoutReady({ stripe_account_id: 'acct_1', connect_transfers_active: false, connect_payouts_enabled: true })).toBe(false);
    expect(engine.connectPayoutReady(null)).toBe(false);
  });
});

// ── PURE: assertPaySellerAllowed — every money-movement safeguard ─────────────────────────
describe('assertPaySellerAllowed (pure) — Direct Deposit money guard', () => {
  const good = {
    hasSettlementRow: true, settlementStatus: 'approved', existingTransferId: null,
    payoutMethod: 'ach', connectReady: true, netProceedsCents: 5000,
  };
  const goodInput = { finalAmountCents: 5000, confirmedCompleted: true };

  test('allows a valid Direct Deposit release', () => {
    expect(engine.assertPaySellerAllowed(good, goodInput)).toEqual({ ok: true });
  });
  test('blocks when no settlement exists', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, hasSettlementRow: false }, goodInput)).toThrow(engine.PaySellerError);
  });
  test('blocks when already paid (immutable)', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, settlementStatus: 'paid' }, goodInput)).toThrow(/already paid/i);
  });
  test('blocks a duplicate transfer (existing transfer id)', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, existingTransferId: 'tr_1' }, goodInput)).toThrow(/already exists/i);
  });
  test('blocks when payout method is not Direct Deposit', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, payoutMethod: 'check' }, goodInput)).toThrow(/not Direct Deposit/i);
  });
  test('blocks when Connect not ready (onboarding incomplete / payouts disabled)', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, connectReady: false }, goodInput)).toThrow(/not ready/i);
  });
  test('blocks without explicit fulfillment confirmation', () => {
    expect(() => engine.assertPaySellerAllowed(good, { ...goodInput, confirmedCompleted: false })).toThrow(/confirmation/i);
  });
  test('blocks when the final amount does not match the calculated net', () => {
    expect(() => engine.assertPaySellerAllowed(good, { ...goodInput, finalAmountCents: 4000 })).toThrow(/does not match/i);
  });
  test('blocks a missing/NaN final amount', () => {
    expect(() => engine.assertPaySellerAllowed(good, { ...goodInput, finalAmountCents: undefined })).toThrow(/final net payment amount/i);
  });
  test('blocks a non-positive net', () => {
    expect(() => engine.assertPaySellerAllowed({ ...good, netProceedsCents: 0 }, { ...goodInput, finalAmountCents: 0 })).toThrow(/greater than zero/i);
  });
});

// ── Webhook handlers (db-mocked) ─────────────────────────────────────────────────────────
describe('webhook: applyTransferEvent', () => {
  test('transfer.created flips processing → released (idempotent, matches transfer id)', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const r = await engine.applyTransferEvent('transfer.created', { id: 'tr_9' });
    expect(r).toEqual({ updated: 1, payout_status: 'released' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/payout_status='released'/);
    expect(sql).toMatch(/stripe_transfer_id=\$1 AND payout_status='processing'/);
    expect(params).toEqual(['tr_9']);
  });
  test('transfer.reversed marks reversed', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const r = await engine.applyTransferEvent('transfer.reversed', { id: 'tr_9' });
    expect(r.payout_status).toBe('reversed');
    expect(db.query.mock.calls[0][0]).toMatch(/payout_status='reversed'/);
  });
  test('ignores unrelated transfer events / missing id', async () => {
    expect(await engine.applyTransferEvent('transfer.updated', { id: 'tr_9' })).toEqual({ updated: 0 });
    expect(await engine.applyTransferEvent('transfer.created', {})).toEqual({ updated: 0 });
  });
});

describe('webhook: applyAccountUpdated / applyPayoutEvent', () => {
  test('account.updated persists mapped status keyed by connected account id', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const r = await connect.applyAccountUpdated({ id: 'acct_7', capabilities: { transfers: 'active' }, payouts_enabled: true, details_submitted: true });
    expect(r.updated).toBe(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE seller_payout_preferences/);
    expect(sql).toMatch(/WHERE stripe_account_id=\$1/);
    expect(params[0]).toBe('acct_7');
  });
  test('account.updated with no id is a no-op', async () => {
    expect(await connect.applyAccountUpdated({})).toEqual({ updated: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
  test('applyPayoutEvent updates by connected account id', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    const r = await connect.applyPayoutEvent('acct_7', { failed: true, failureMessage: 'account_closed' });
    expect(r.updated).toBe(1);
    expect(db.query.mock.calls[0][1][0]).toBe('acct_7');
  });
});

// ── Security + regression (source-level, deterministic) ──────────────────────────────────
describe('security: no raw bank credentials stored', () => {
  test('migration 108 adds no routing/account-number columns', () => {
    const sql = read('db/migrations/108_seller_connect_payouts.sql');
    expect(sql).not.toMatch(/routing/i);
    expect(sql).not.toMatch(/account_number/i);
    expect(sql).toMatch(/stripe_account_id/);          // only safe identifiers
    expect(sql).toMatch(/connect_bank_last4/);
  });
  test('stripeConnectService never persists routing/account numbers', () => {
    const src = read('src/services/stripeConnectService.js');
    expect(src).not.toMatch(/routing_number/);
    expect(src).not.toMatch(/account_number/);
  });
});

describe('regression: buyer charge + Stripe Tax architecture unchanged', () => {
  const ps = read('src/services/paymentService.js');
  test('buyer PaymentIntents carry NO Connect split (platform stays merchant of record)', () => {
    const createBlocks = ps.split('paymentIntents.create').slice(1).join('paymentIntents.create');
    expect(createBlocks).not.toMatch(/transfer_data/);
    expect(createBlocks).not.toMatch(/on_behalf_of/);
    expect(createBlocks).not.toMatch(/application_fee/);
  });
  test('webhook dispatch handles the required Connect events without touching PaymentIntent branches', () => {
    expect(ps).toMatch(/event\.type === 'account\.updated'/);
    expect(ps).toMatch(/'transfer\.created' \|\| event\.type === 'transfer\.reversed'/);
    expect(ps).toMatch(/'payout\.paid' \|\| event\.type === 'payout\.failed'/);
    expect(ps).toMatch(/event\.type === 'payment_intent\.succeeded'/); // existing branch intact
  });
});

describe('wiring: transfer is Admin-approval-only, idempotent, retry-safe', () => {
  const eng = read('src/services/settlementEngine.js');
  test('transfer uses a stable per-auction idempotency key and sets processing (not falsely released)', () => {
    expect(eng).toMatch(/idempotencyKey: 'settlement-transfer:' \+ auctionId/);
    expect(eng).toMatch(/payout_status = 'processing'/);
  });
  test('a failed transfer rolls back and never marks the settlement paid', () => {
    expect(eng).toMatch(/catch \(e\) \{\s*await client\.query\('ROLLBACK'\)[\s\S]*throw new PaySellerError\('Stripe transfer failed/);
  });
  test('pay-seller route is gated by BOTH settlements-enabled and connect-enabled', () => {
    const route = read('src/routes/adminSettlements.js');
    expect(route).toMatch(/\/pay-seller'[\s\S]*requireSettlementsEnabled, requireConnectEnabled/);
  });
});
