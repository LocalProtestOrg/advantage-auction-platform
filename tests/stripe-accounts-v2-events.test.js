'use strict';

/**
 * Accounts v2 event notifications for seller Direct Deposit accounts (owner 2026-11-17).
 * The signature is checked with the REAL payment SDK (no mock) so the verification path is the one production runs.
 * The database and the outside account lookup are stubbed; nothing here reaches a network.
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const Stripe = require('stripe');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-only';
const SECRET_PLATFORM = 'whsec_test_platform_endpoint';
const SECRET_V2 = 'whsec_test_accounts_v2_destination';
const env = { STRIPE_SECRET_KEY: 'sk_test_unit', STRIPE_WEBHOOK_SECRET: SECRET_PLATFORM, STRIPE_ACCOUNTS_V2_WEBHOOK_SECRET: SECRET_V2 };
const signer = Stripe('sk_test_unit');
const sign = (payload, secret, timestamp) => signer.webhooks.generateTestHeaderString({ payload, secret, ...(timestamp ? { timestamp } : {}) });

const note = (over = {}) => ({ id: 'evt_test_v2_1', object: 'v2.core.event', type: 'v2.core.account[requirements].updated', livemode: false,
  created: '2026-11-17T17:00:00.000Z', related_object: { id: 'acct_1TESTaccount', type: 'v2.core.account', url: '/v2/core/accounts/acct_1TESTaccount' }, ...over });
const snapshot = { id: 'evt_test_v1_1', object: 'event', type: 'payment_intent.succeeded', livemode: false, data: { object: { id: 'pi_1', metadata: {} } } };

const { verifyWebhookEvent } = require('../src/routes/payments');
const connect = require('../src/services/stripeConnectService');

beforeEach(() => { db.query.mockReset(); });

describe('signature verification', () => {
  test('a notification signed with the Accounts v2 destination secret is accepted', () => {
    const body = JSON.stringify(note());
    expect(verifyWebhookEvent(Buffer.from(body), sign(body, SECRET_V2), env)).toMatchObject({ id: 'evt_test_v2_1', object: 'v2.core.event' });
  });
  test('a notification signed with the platform endpoint secret is accepted too', () => {
    const body = JSON.stringify(note());
    expect(verifyWebhookEvent(Buffer.from(body), sign(body, SECRET_PLATFORM), env).type).toBe('v2.core.account[requirements].updated');
  });
  test('a notification with a wrong signature, an altered body, no signature or an old timestamp is refused', () => {
    const body = JSON.stringify(note());
    expect(() => verifyWebhookEvent(Buffer.from(body), sign(body, 'whsec_someone_else'), env)).toThrow();
    const tampered = body.replace('acct_1TESTaccount', 'acct_1ATTACKER00000');
    expect(() => verifyWebhookEvent(Buffer.from(tampered), sign(body, SECRET_V2), env)).toThrow();
    expect(() => verifyWebhookEvent(Buffer.from(body), undefined, env)).toThrow();
    expect(() => verifyWebhookEvent(Buffer.from(body), sign(body, SECRET_V2, Math.floor(Date.now() / 1000) - 3600), env)).toThrow();
  });
  test('with no secret configured nothing is accepted', () => {
    const body = JSON.stringify(note());
    expect(() => verifyWebhookEvent(Buffer.from(body), sign(body, SECRET_V2), { STRIPE_SECRET_KEY: 'sk_test_unit' })).toThrow(/not configured/);
  });
  test('ordinary payment events still verify exactly as before, and a bad signature on one is still refused', () => {
    const body = JSON.stringify(snapshot);
    expect(verifyWebhookEvent(Buffer.from(body), sign(body, SECRET_PLATFORM), env)).toEqual(snapshot);
    expect(() => verifyWebhookEvent(Buffer.from(body), sign(body, 'whsec_someone_else'), env)).toThrow();
  });
});

describe('what a notification does', () => {
  test('the listed event names are the documented Accounts v2 names', () => {
    expect(connect.ACCOUNT_V2_EVENTS).toEqual(['v2.core.account[requirements].updated', 'v2.core.account[configuration.recipient].capability_status_updated',
      'v2.core.account[configuration.recipient].updated', 'v2.core.account.updated', 'v2.core.account.closed']);
  });
  test('an event type outside the list, or one that names no usable account, makes no database or outside call', async () => {
    expect(await connect.applyAccountV2Event(note({ type: 'v2.core.account_person.updated' }))).toEqual({ updated: 0, ignored: 'event_type' });
    expect(await connect.applyAccountV2Event(note({ related_object: null }))).toEqual({ updated: 0, ignored: 'no_account' });
    expect(await connect.applyAccountV2Event(note({ related_object: { id: 'acct_1 OR 1=1', type: 'v2.core.account' } }))).toEqual({ updated: 0, ignored: 'no_account' });
    expect(await connect.applyAccountV2Event(note({ related_object: { id: 'acct_1TESTaccount', type: 'v2.core.account_person' } }))).toEqual({ updated: 0, ignored: 'no_account' });
    expect(db.query).not.toHaveBeenCalled();
  });
  test('an account no seller has on record is ignored without asking the payment processor', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await connect.applyAccountV2Event(note())).toEqual({ updated: 0, ignored: 'unknown_account' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual(['acct_1TESTaccount']);
  });
});

describe('the webhook pipeline', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'paymentService.js'), 'utf8');
  test('a notification is routed before any payment handling, which reads event.data', () => {
    const dispatch = src.slice(src.indexOf('async _dispatchWebhookEvent(event)'));
    expect(dispatch.indexOf("event.object === 'v2.core.event'")).toBeGreaterThan(-1);
    expect(dispatch.indexOf("event.object === 'v2.core.event'")).toBeLessThan(dispatch.indexOf('event.data.object'));
  });
  test('a notification still passes the LIVE/TEST isolation and the idempotent event ledger', () => {
    const handle = src.slice(src.indexOf('async handleWebhookEvent(event)'), src.indexOf('async _dispatchWebhookEvent(event)'));
    expect(handle).toMatch(/eventMatchesMode\(event\)/);
    expect(handle).toMatch(/_acquireWebhookEvent\(event\.id, event\.type, event\)/);
    const { eventMatchesMode } = require('../src/lib/stripeMode');
    expect(eventMatchesMode(note({ livemode: false }), { STRIPE_SECRET_KEY: 'sk_live_x' })).toBe(false);   // a TEST notification is ignored under LIVE keys
    expect(eventMatchesMode(note({ livemode: true }), { STRIPE_SECRET_KEY: 'sk_live_x' })).toBe(true);
  });
});

describe('pre-flight payment mode (no credential needed)', () => {
  const helper = require('../scripts/lib/preflightStripeMode');
  const health = (body) => async () => ({ json: async () => body });
  test('a visible key decides the mode exactly as the application does, and the health report is not consulted', async () => {
    const f = jest.fn();
    expect(await helper.resolve({ env: { STRIPE_SECRET_KEY: 'sk_test_x' }, base: 'https://example.test', fetchImpl: f })).toEqual({ live: false, source: 'key' });
    expect(await helper.resolve({ env: { STRIPE_SECRET_KEY: 'rk_live_x' }, base: 'https://example.test', fetchImpl: f })).toEqual({ live: true, source: 'key' });
    expect(f).not.toHaveBeenCalled();
  });
  test('with no key visible the mode is what production reports', async () => {
    expect(await helper.resolve({ env: {}, base: 'https://example.test/', fetchImpl: health({ stripe_mode: 'live', stripe_keys_consistent: true }) })).toEqual({ live: true, source: 'health' });
    expect(await helper.resolve({ env: {}, base: 'https://example.test', fetchImpl: health({ stripe_mode: 'test', stripe_keys_consistent: true }) })).toEqual({ live: false, source: 'health' });
  });
  test('an unreadable, inconsistent or missing report leaves the mode unknown (never assumed LIVE)', async () => {
    const unknown = { live: null, source: 'unknown' };
    expect(await helper.resolve({ env: {}, base: 'https://example.test', fetchImpl: async () => { throw new Error('down'); } })).toEqual(unknown);
    expect(await helper.resolve({ env: {}, base: 'https://example.test', fetchImpl: health({ stripe_mode: 'live', stripe_keys_consistent: false }) })).toEqual(unknown);
    expect(await helper.resolve({ env: {}, base: 'https://example.test', fetchImpl: health({ stripe_mode: 'weird' }) })).toEqual(unknown);
    expect(await helper.resolve({ env: {}, base: null })).toEqual(unknown);
  });
  test('applying a LIVE report shows a LIVE payout account and still hides a TEST one; unknown changes nothing', () => {
    const real = require('../src/lib/stripeMode');
    const livePref = { stripe_account_id: 'acct_live', stripe_account_livemode: true, connect_transfers_active: true, connect_payouts_enabled: true };
    const testPref = { ...livePref, stripe_account_id: 'acct_test', stripe_account_livemode: false };
    const fake = { maskPayoutPrefForMode: real.maskPayoutPrefForMode };
    expect(helper.apply({ live: null, source: 'unknown' }, fake)).toBe(false);
    expect(helper.apply({ live: true, source: 'key' }, fake)).toBe(false);
    expect(fake.maskPayoutPrefForMode).toBe(real.maskPayoutPrefForMode);
    expect(helper.apply({ live: true, source: 'health' }, fake)).toBe(true);
    expect(fake.maskPayoutPrefForMode(livePref)).toMatchObject({ stripe_account_id: 'acct_live', connect_transfers_active: true });
    expect(fake.maskPayoutPrefForMode(testPref)).toMatchObject({ stripe_account_id: null, connect_transfers_active: false, stripe_mode_mismatch: true });
  });
  test('the helper prints nothing', () => {
    const text = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'lib', 'preflightStripeMode.js'), 'utf8');
    expect(text).not.toMatch(/console\./);
  });
});
