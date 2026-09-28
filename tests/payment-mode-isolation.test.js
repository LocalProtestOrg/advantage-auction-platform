'use strict';

/**
 * TEST/LIVE isolation + key-mode safety (pre-LIVE payment readiness, migration 173).
 *   - the mode is derived from the key prefix; secret/publishable mismatch fails payment endpoints closed (503);
 *   - every provider reference is stamped with its mode; lookups use only CURRENT-mode records, so after the
 *     switch to LIVE keys buyers add a card again and sellers set up direct deposit again, automatically;
 *   - a stored customer / connected account from the other mode is replaced (old id kept as superseded);
 *   - webhook events from the other mode are acknowledged but ignored; both webhook secrets are accepted.
 */

const mockStripe = {
  customers: { retrieve: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})) },
  paymentMethods: { list: jest.fn() },
  paymentIntents: { create: jest.fn(), retrieve: jest.fn() },
  v2: { core: { accounts: { create: jest.fn() } } },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));

const db = require('../src/db');
const mode = require('../src/lib/stripeMode');

const ENV0 = { ...process.env };
function keys(secret, pub) {
  process.env.STRIPE_SECRET_KEY = secret;
  if (pub === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY; else process.env.STRIPE_PUBLISHABLE_KEY = pub;
}
afterAll(() => { process.env = ENV0; });
beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); keys('sk_test_unit', 'pk_test_unit'); });

describe('stripeMode helper', () => {
  test('mode is derived from the key prefix (restricted keys too); anything else is not live', () => {
    expect(mode.secretKeyMode('sk_live_x')).toBe('live');
    expect(mode.secretKeyMode('rk_live_x')).toBe('live');
    expect(mode.secretKeyMode('sk_test_x')).toBe('test');
    expect(mode.secretKeyMode('rk_test_x')).toBe('test');
    expect(mode.secretKeyMode('')).toBeNull();
    expect(mode.publishableKeyMode('pk_live_x')).toBe('live');
    expect(mode.publishableKeyMode('pk_test_x')).toBe('test');
    keys('rk_live_x', 'pk_live_x'); expect(mode.isLiveMode()).toBe(true);
    keys('garbage', undefined); expect(mode.isLiveMode()).toBe(false);
  });

  test('a secret/publishable mismatch is reported and logged loudly without key material', () => {
    keys('sk_live_SECRETVALUE', 'pk_test_PUBVALUE');
    const c = mode.modeConsistency();
    expect(c).toMatchObject({ ok: false, secretMode: 'live', publishableMode: 'test' });
    const logger = { error: jest.fn(), log: jest.fn() };
    mode.logStartupModeCheck(process.env, logger);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/MISMATCH/);
    expect(logger.error.mock.calls[0][0]).not.toMatch(/SECRETVALUE|PUBVALUE/);
    keys('sk_live_a', 'pk_live_b'); expect(mode.modeConsistency().ok).toBe(true);
    keys('sk_live_a', undefined);   expect(mode.modeConsistency().ok).toBe(true); // missing pk is not a mismatch
  });

  test('payment endpoints fail closed (503, neutral wording) on a mismatch, pass through otherwise', () => {
    const res = { status: jest.fn(function () { return this; }), json: jest.fn() };
    const next = jest.fn();
    keys('sk_live_a', 'pk_test_b');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mode.requireConsistentStripeMode({ originalUrl: '/api/payments/charge-lot' }, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, code: 'PAYMENTS_UNAVAILABLE' });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/stripe/i);
    expect(next).not.toHaveBeenCalled();
    keys('sk_test_a', 'pk_test_b');
    mode.requireConsistentStripeMode({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    console.error.mockRestore();
  });

  test('the payment routes are guarded by the fail-closed middleware', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'payments.js'), 'utf8');
    for (const r of ["'/setup-intent'", "'/card-on-file', auth, requireConsistentStripeMode", "'/charge-lot'", "'/charge-combined'", "'/checkout/:paymentId'", "'/checkout/:paymentId/confirm'"]) {
      const line = src.split('\n').find((l) => l.includes('router.') && l.includes(r));
      expect(line).toMatch(/requireConsistentStripeMode/);
    }
  });

  test('webhook events are acted on only in the matching mode', () => {
    keys('sk_live_a', 'pk_live_a');
    expect(mode.eventMatchesMode({ livemode: true })).toBe(true);
    expect(mode.eventMatchesMode({ livemode: false })).toBe(false);
    keys('sk_test_a', 'pk_test_a');
    expect(mode.eventMatchesMode({ livemode: true })).toBe(false);
    expect(mode.eventMatchesMode({ livemode: false })).toBe(true);
    expect(mode.eventMatchesMode({})).toBe(true);                     // legacy payloads without the flag
  });

  test('payout preferences hide other-mode connected accounts and bank references (copy, not mutation)', () => {
    const row = {
      stripe_account_id: 'acct_test', stripe_account_livemode: false, connect_status: 'ready',
      connect_transfers_active: true, connect_payouts_enabled: true,
      stripe_bank_account_ref: 'pm_bank_test', stripe_bank_account_livemode: false, ach_account_last4: '6789',
      payout_method: 'ach', check_payee_name: 'Kept',
    };
    const masked = mode.maskPayoutPrefForMode(row, true);
    expect(masked).toMatchObject({ stripe_account_id: null, connect_transfers_active: false, connect_payouts_enabled: false,
      stripe_bank_account_ref: null, ach_account_last4: null, stripe_mode_mismatch: true, check_payee_name: 'Kept' });
    expect(row.stripe_account_id).toBe('acct_test');                                  // stored row untouched
    expect(mode.maskPayoutPrefForMode(row, false)).toEqual(row);                      // same mode → unchanged
    const liveRow = { ...row, stripe_account_id: 'acct_live', stripe_account_livemode: true };
    expect(mode.maskPayoutPrefForMode(liveRow, true).stripe_account_id).toBe('acct_live');
  });
});

describe('buyers: card on file is per mode', () => {
  const cardService = require('../src/services/cardService');

  test('hasCardOnFile requires a current-mode customer AND a current-mode verified card', async () => {
    keys('sk_live_a', 'pk_live_a');
    db.query.mockResolvedValueOnce({ rows: [{ ok: false }] });
    expect(await cardService.hasCardOnFile('u1')).toBe(false);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/COALESCE\(u\.stripe_customer_livemode, false\) = \$2/);
    expect(sql).toMatch(/cv\.livemode = \$2/);
    expect(params).toEqual(['u1', true]);
  });

  test('under LIVE keys a stored TEST customer is replaced (old id kept as superseded), never retrieved', async () => {
    keys('sk_live_a', 'pk_live_a');
    db.query.mockImplementation(async (sql) => {
      if (/SELECT email, stripe_customer_id, stripe_customer_livemode/.test(sql)) return { rows: [{ email: 'b@x.test', stripe_customer_id: 'cus_TEST', stripe_customer_livemode: false }] };
      return { rows: [], rowCount: 1 };
    });
    mockStripe.customers.create.mockResolvedValueOnce({ id: 'cus_LIVE' });
    expect(await cardService.ensureStripeCustomer('u1')).toBe('cus_LIVE');
    expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
    const upd = db.query.mock.calls.find(([s]) => /UPDATE users/.test(s));
    expect(upd[0]).toMatch(/superseded_stripe_customer_id = CASE/);
    expect(upd[1]).toEqual(['cus_LIVE', true, 'u1']);
  });

  test('a same-mode customer is reused', async () => {
    keys('sk_live_a', 'pk_live_a');
    db.query.mockResolvedValue({ rows: [{ email: 'b@x.test', stripe_customer_id: 'cus_LIVE', stripe_customer_livemode: true }] });
    mockStripe.customers.retrieve.mockResolvedValueOnce({ id: 'cus_LIVE' });
    expect(await cardService.ensureStripeCustomer('u1')).toBe('cus_LIVE');
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });

  test('a saved card is stamped with the current mode', async () => {
    keys('sk_live_a', 'pk_live_a');
    db.query.mockImplementation(async (sql) => {
      if (/SELECT email, stripe_customer_id/.test(sql)) return { rows: [{ email: 'b@x.test', stripe_customer_id: 'cus_LIVE', stripe_customer_livemode: true }] };
      if (/INSERT INTO card_verifications/.test(sql)) return { rows: [{ id: 'cv1' }] };
      return { rows: [] };
    });
    mockStripe.customers.retrieve.mockResolvedValueOnce({ id: 'cus_LIVE' });
    mockStripe.paymentMethods.list.mockResolvedValueOnce({ data: [{ id: 'pm_1', card: { brand: 'visa', last4: '4242', funding: 'credit' } }] });
    await cardService.recordCardOnFile('u1');
    const ins = db.query.mock.calls.find(([s]) => /INSERT INTO card_verifications/.test(s));
    expect(ins[0]).toMatch(/livemode\)/);
    expect(ins[1]).toEqual(['u1', 'pm_1', true]);
  });

  test('the card summary shows no card for an other-mode customer without calling the provider', async () => {
    keys('sk_live_a', 'pk_live_a');
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_TEST', stripe_customer_livemode: false }] });
    expect(await cardService.getCardSummary('u1')).toEqual({ has_card: false });
    expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
  });

  test('off-session charging ignores a TEST customer/card under LIVE keys (buyer treated as no card)', async () => {
    keys('sk_live_a', 'pk_live_a');
    const paymentService = require('../src/services/paymentService');
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_TEST', stripe_customer_livemode: false }] });
    const ctx = await paymentService._loadCombinedChargeContext('u1');
    expect(ctx).toEqual({ stripeCustomerId: null, verifiedPmId: null, defaultPmId: null });
    expect(paymentService._resolveCombinedChargeContext(ctx)).toEqual({ skipped: 'no_card' });
    expect(db.query).toHaveBeenCalledTimes(1);           // the TEST card rows are never even read
    expect(mockStripe.customers.retrieve).not.toHaveBeenCalled();
  });

  test('off-session charging reads only current-mode cards', async () => {
    keys('sk_live_a', 'pk_live_a');
    const paymentService = require('../src/services/paymentService');
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_LIVE', stripe_customer_livemode: true }] })
            .mockResolvedValueOnce({ rows: [{ stripe_payment_method_id: 'pm_LIVE' }] });
    const ctx = await paymentService._loadCombinedChargeContext('u1');
    expect(ctx).toMatchObject({ stripeCustomerId: 'cus_LIVE', verifiedPmId: 'pm_LIVE' });
    expect(db.query.mock.calls[1][0]).toMatch(/livemode = \$2/);
    expect(db.query.mock.calls[1][1]).toEqual(['u1', true]);
  });

  test('admin card-on-file indicators count only current-mode records', () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['adminBuyers.js', 'adminUsers.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
      const n = (src.match(/cv\.livemode = \$\{liveSql\(\)\}/g) || []).length;
      const all = (src.match(/FROM card_verifications cv/g) || []).length;
      expect(n).toBe(all);
    }
  });
});

describe('sellers: direct deposit is per mode', () => {
  test('ensureConnectAccount creates a NEW account when the stored one is from the other mode', async () => {
    keys('sk_live_a', 'pk_live_a');
    const connect = require('../src/services/stripeConnectService');
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM seller_payout_preferences/.test(sql)) return { rows: [{ seller_user_id: 's1', stripe_account_id: 'acct_TEST', stripe_account_livemode: false, connect_transfers_active: true, connect_payouts_enabled: true }] };
      if (/SELECT email FROM users/.test(sql)) return { rows: [{ email: 's@x.test' }] };
      return { rows: [], rowCount: 1 };
    });
    mockStripe.v2.core.accounts.create.mockResolvedValueOnce({ id: 'acct_LIVE' });
    expect(await connect.ensureConnectAccount('s1')).toBe('acct_LIVE');
    const up = db.query.mock.calls.find(([s]) => /INSERT INTO seller_payout_preferences/.test(s));
    expect(up[0]).toMatch(/superseded_stripe_account_id = CASE/);
    expect(up[0]).toMatch(/connect_transfers_active=false/);
    expect(up[1]).toEqual(['s1', 'acct_LIVE', true]);
  });

  test('a same-mode account is reused (never a second account)', async () => {
    keys('sk_test_a', 'pk_test_a');
    const connect = require('../src/services/stripeConnectService');
    db.query.mockResolvedValue({ rows: [{ seller_user_id: 's1', stripe_account_id: 'acct_TEST', stripe_account_livemode: false }] });
    expect(await connect.ensureConnectAccount('s1')).toBe('acct_TEST');
    expect(mockStripe.v2.core.accounts.create).not.toHaveBeenCalled();
  });

  test('settlement readers never see a TEST account under LIVE keys (so no TEST id is used for a transfer)', async () => {
    keys('sk_live_a', 'pk_live_a');
    const { getSellerPayoutPreference } = require('../src/services/payoutPreferenceService');
    db.query.mockResolvedValueOnce({ rows: [{ seller_user_id: 's1', payout_method: 'ach', stripe_account_id: 'acct_TEST', stripe_account_livemode: false, connect_transfers_active: true, connect_payouts_enabled: true }] });
    const pref = await getSellerPayoutPreference('s1');
    expect(pref.stripe_account_id).toBeNull();
    expect(pref.connect_transfers_active).toBe(false);
  });
});

describe('webhook: mode filter + two signing secrets', () => {
  test('an event from the other mode is acknowledged but never recorded or dispatched', async () => {
    keys('sk_live_a', 'pk_live_a');
    const paymentService = require('../src/services/paymentService');
    const spy = jest.spyOn(paymentService, '_dispatchWebhookEvent');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await paymentService.handleWebhookEvent({ id: 'evt_test_1', type: 'payment_intent.succeeded', livemode: false, data: { object: {} } });
    expect(out).toEqual({ ignored: 'mode_mismatch' });
    expect(db.query).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    console.warn.mockRestore();
  });

  test('signatures verify against the platform secret OR the optional connected-accounts secret', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-only';
    const { verifyWebhookEvent } = require('../src/routes/payments');
    const env = { STRIPE_SECRET_KEY: 'sk_test_a', STRIPE_WEBHOOK_SECRET: 'whsec_platform', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect' };
    mockStripe.webhooks.constructEvent.mockImplementation((body, sig, secret) => {
      if (secret === 'whsec_connect') return { id: 'evt_c', account: 'acct_1' };
      throw new Error('bad sig');
    });
    expect(verifyWebhookEvent('{}', 'sig', env)).toEqual({ id: 'evt_c', account: 'acct_1' });
    expect(mockStripe.webhooks.constructEvent.mock.calls.map((c) => c[2])).toEqual(['whsec_platform', 'whsec_connect']);
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    expect(() => verifyWebhookEvent('{}', 'sig', env)).toThrow('bad sig');
    expect(() => verifyWebhookEvent('{}', 'sig', { STRIPE_SECRET_KEY: 'sk_test_a' })).toThrow(/not configured/);
  });
});
