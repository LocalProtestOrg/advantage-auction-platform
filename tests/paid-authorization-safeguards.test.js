'use strict';

/**
 * Paid advertising safeguards (owner decision 2026-11-06, migration 223): explicit owner authorizations, the build
 * reserving its own budget, auto-stop by default, and an emergency stop that also reaches provider-active campaigns our
 * records consider finished.
 *
 * Real Postgres (PGlite) running the REAL migrations 222 and 223 on minimal versions of the tables these services
 * touch, with the real paidAuthorizationService, metaDeliveryService, paidExecutionService and configService. The Meta
 * provider, spend governance and the budget ledger are stand-ins: no provider is contacted and no money moves.
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function startPg() {
  const worker = new Worker(path.join(__dirname, 'sasha-phone', 'pgWorker.js'));
  worker.unref();
  const pending = new Map(); let n = 0;
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m); });
  const send = (msg) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
  return { exec: (sql) => send({ op: 'exec', sql }), query: (sql, params) => send({ op: 'query', sql, params }), close: () => worker.terminate() };
}
function mockAdapter() {
  const query = async (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [], rowCount: 0 };
    const r = await global.__PG.query(sql, params || []);
    return { rows: r.rows, rowCount: r.affectedRows != null && !/^\s*select/i.test(sql) ? r.affectedRows : r.rows.length };
  };
  return { query, connect: async () => ({ query, release: () => {} }), pool: { end: async () => {} } };
}
jest.mock('../src/db', () => mockAdapter());
jest.mock('../src/db/index', () => mockAdapter());
jest.mock('../src/services/ownerNotifyService', () => ({ notify: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/services/paidGrowth/metaAdsProvider', () => ({
  createCampaign: jest.fn(async () => ({ ok: true, provider_campaign_id: 'C-1' })),
  createAdSet: jest.fn(async () => ({ ok: true, provider_adset_id: 'S-1' })),
  createAdCreative: jest.fn(async () => ({ ok: true, provider_creative_id: 'K-1' })),
  createAd: jest.fn(async () => ({ ok: true, provider_ad_id: 'A-1' })),
  uploadImage: jest.fn(async () => ({ ok: true, image_hash: 'H-new' })),
  setStatus: jest.fn(async () => ({ ok: true, status: 'ACTIVE' })),
  pause: jest.fn(async () => ({ ok: true, status: 'PAUSED' })),
  stop: jest.fn(async () => ({ ok: true })),
  getObject: jest.fn(async () => ({ ok: true, object: { status: 'PAUSED', effective_status: 'PAUSED' } })),
  resolveAdAccount: jest.fn(async () => ({ ok: true, account: 'act_1' })),
  permissions: jest.fn(async () => ({ ok: true, ads_read: true, ads_management: true })),
}));
jest.mock('../src/services/paidGrowth/paidSpendGovernance', () => ({
  assertNewSpendAllowed: jest.fn(async () => ({ ok: true })),
  overview: jest.fn(async () => ({ position: null, campaigns: [] })),
}));
jest.mock('../src/services/paidBudgetLedger', () => ({
  ceilings: jest.fn(async () => ({ monthly_cents: 100000, campaign_cents: 40000, daily_cents: 5000 })),
  reserve: jest.fn(async ({ amountCents, idempotencyKey }) => ({ ok: true, replayed: false, reservation: { amount_cents: amountCents, idempotency_key: idempotencyKey } })),
  release: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../src/services/measurement/measurementReadinessService', () => ({
  evaluate: jest.fn(async () => ({ measurement_ready: true, rules: { minimum_for_meta: { ready: true, not_verified: [] } } })),
}));

const meta = require('../src/services/paidGrowth/metaAdsProvider');
const ledger = require('../src/services/paidBudgetLedger');
const authz = require('../src/services/paidGrowth/paidAuthorizationService');
const delivery = require('../src/services/paidGrowth/metaDeliveryService');
const execution = require('../src/services/paidGrowth/paidExecutionService');

jest.setTimeout(60000);
let pg; let OWNER; let ADMIN; let CREATIVE; let OTHER_CREATIVE;
const q = async (sql, params) => (await pg.query(sql, params)).rows;
const DAY = 86400000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

const SCHEMA = `
CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT, role TEXT, is_active BOOLEAN DEFAULT true);
CREATE TABLE platform_config (key TEXT PRIMARY KEY, value JSONB NOT NULL, category TEXT NOT NULL DEFAULT 'general', description TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE seller_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
CREATE TABLE auctions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), seller_id UUID);
CREATE TABLE marketing_production_creative (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), asset_key TEXT UNIQUE, filename TEXT, relative_path TEXT, sha256 TEXT,
  category TEXT, production_eligible BOOLEAN, ineligible_reason TEXT, factual_requirements JSONB);
CREATE TABLE marketing_paid_markets (market_key TEXT PRIMARY KEY);
CREATE TABLE marketing_paid_campaigns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_key TEXT NOT NULL UNIQUE, channel TEXT NOT NULL DEFAULT 'meta_ads',
  objective TEXT DEFAULT 'OUTCOME_LEADS', funnel TEXT DEFAULT 'individual_seller', market TEXT, market_key TEXT, destination_url TEXT, creative_id UUID,
  budget_cents INTEGER NOT NULL DEFAULT 0, daily_budget_cents INTEGER, state TEXT NOT NULL DEFAULT 'PLANNED', blocked_reason TEXT, provider_account_ref TEXT,
  provider_campaign_id TEXT, idempotency_key TEXT, last_error TEXT, evidence JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT now(),
  activated_at TIMESTAMPTZ, paused_at TIMESTAMPTZ, stopped_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE marketing_creative_packages (package_key TEXT PRIMARY KEY, funnel TEXT, production_creative_id UUID, approval_state TEXT, policy_status TEXT, active BOOLEAN,
  approval_scope JSONB, primary_text TEXT, headline TEXT, description TEXT, cta_type TEXT, destination_url TEXT, version INT DEFAULT 1, fingerprint TEXT);
CREATE TABLE marketing_audience_experiments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_key TEXT UNIQUE, campaign_key TEXT, funnel TEXT, state TEXT, updated_at TIMESTAMPTZ);
CREATE TABLE marketing_audience_strategies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), strategy_key TEXT, targeting_spec JSONB, validation_state TEXT, policy_status TEXT,
  optimization_goal TEXT, funnel TEXT);
CREATE TABLE marketing_audience_experiment_arms (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), experiment_id UUID, strategy_id UUID, arm_label TEXT, allocated_cents INT, provider_adset_id TEXT);
CREATE TABLE marketing_provider_objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider TEXT NOT NULL DEFAULT 'meta', account_ref TEXT NOT NULL, object_type TEXT NOT NULL,
  provider_id TEXT, parent_provider_id TEXT, campaign_key TEXT, experiment_arm_id UUID, package_key TEXT, idempotency_key TEXT NOT NULL UNIQUE, provider_status TEXT,
  intended_status TEXT NOT NULL DEFAULT 'PAUSED', certification_artifact BOOLEAN NOT NULL DEFAULT false, last_error TEXT, evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(), last_reconciled_at TIMESTAMPTZ);
CREATE TABLE marketing_provider_images (provider TEXT, account_ref TEXT, production_creative_id UUID, asset_sha256 TEXT, provider_image_hash TEXT, provider_url TEXT,
  UNIQUE (provider, account_ref, asset_sha256));
CREATE TABLE marketing_paid_budget_ledger (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), month DATE, campaign_key TEXT, kind TEXT, amount_cents INT, idempotency_key TEXT, note TEXT,
  created_at TIMESTAMPTZ DEFAULT now());
`;

async function seedCampaign(key, { budget = 2500, creative = CREATIVE, state = 'PLANNED', provider = null } = {}) {
  await q(`INSERT INTO marketing_paid_campaigns (campaign_key, market_key, creative_id, budget_cents, state, provider_campaign_id, destination_url)
           VALUES ($1, 'ny_tristate', $2, $3, $4, $5, 'https://bid.advantage.bid/assisted-service.html')`, [key, creative, budget, state, provider]);
}
async function seedExperiment(campaignKey, expKey, { pkgKey = 'PKG-OK', arms = [['A', 2500]] } = {}) {
  const e = (await q(`INSERT INTO marketing_audience_experiments (experiment_key, campaign_key, funnel, state) VALUES ($1, $2, 'individual_seller', 'PLANNED') RETURNING id`, [expKey, campaignKey]))[0];
  const s = (await q(`INSERT INTO marketing_audience_strategies (strategy_key, targeting_spec, validation_state, policy_status, funnel)
                      VALUES ('S-' || $1, '{}'::jsonb, 'VALID', 'OK', 'individual_seller') RETURNING id`, [expKey]))[0];
  for (const [label, cents] of arms) await q(`INSERT INTO marketing_audience_experiment_arms (experiment_id, strategy_id, arm_label, allocated_cents) VALUES ($1, $2, $3, $4)`, [e.id, s.id, label, cents]);
  return Object.fromEntries(arms.map(([label]) => [label, pkgKey]));
}
async function authorize(campaignKey, over = {}) {
  const out = await authz.create({ campaign_key: campaignKey, channel: 'meta_ads', market_key: 'ny_tristate', amount_cents: 2500,
    starts_at: iso(-DAY), ends_at: iso(10 * DAY), creative_id: CREATIVE, ...over }, { actor: OWNER });
  if (!out.ok) throw new Error('authorize failed: ' + out.reason);
  return out.authorization;
}

beforeAll(async () => {
  pg = startPg(); global.__PG = pg;
  await pg.exec(SCHEMA);
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '222_platform_owner_and_config_audit.sql'), 'utf8'));
  await pg.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '223_paid_campaign_authorizations.sql'), 'utf8'));
  OWNER = (await q(`INSERT INTO users (email, role, is_platform_owner) VALUES ('owner@x.test', 'admin', true) RETURNING id, role`))[0];
  ADMIN = (await q(`INSERT INTO users (email, role) VALUES ('admin@x.test', 'admin') RETURNING id, role`))[0];
  CREATIVE = (await q(`INSERT INTO marketing_production_creative (asset_key, filename, sha256, category, production_eligible) VALUES ('ASSET-OK', 'ok.png', 'sha-ok', 'individual-seller', true) RETURNING id`))[0].id;
  OTHER_CREATIVE = (await q(`INSERT INTO marketing_production_creative (asset_key, filename, sha256, category, production_eligible) VALUES ('ASSET-OTHER', 'other.png', 'sha-other', 'individual-seller', true) RETURNING id`))[0].id;
  await q(`INSERT INTO marketing_production_creative (asset_key, filename, sha256, category, production_eligible) VALUES ('ASSET-DNU', 'no.png', 'sha-no', 'do-not-use', false)`);
  await q(`INSERT INTO marketing_paid_markets (market_key) VALUES ('ny_tristate')`);
  for (const [k, img] of [['PKG-OK', CREATIVE], ['PKG-OTHER', OTHER_CREATIVE]]) {
    await q(`INSERT INTO marketing_creative_packages (package_key, funnel, production_creative_id, approval_state, policy_status, active, primary_text, headline, cta_type, destination_url)
             VALUES ($1, 'individual_seller', $2, 'OWNER_APPROVED', 'OK', true, 'words', 'Headline', 'LEARN_MORE', 'https://bid.advantage.bid/assisted-service.html')`, [k, img]);
  }
  for (const [id, sha] of [[CREATIVE, 'sha-ok'], [OTHER_CREATIVE, 'sha-other']]) {
    await q(`INSERT INTO marketing_provider_images (provider, account_ref, production_creative_id, asset_sha256, provider_image_hash) VALUES ('meta', 'act_1', $1, $2, 'H-' || $2)`, [id, sha]);
  }
});
afterAll(async () => { if (pg) await pg.close(); });
beforeEach(() => { jest.clearAllMocks(); });

describe('migration 223', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '223_paid_campaign_authorizations.sql'), 'utf8');
  test('additive: a new table, nullable attribution columns, one open authorization per campaign, a written reverse', () => {
    expect(sql.replace(/^--.*$/gm, '')).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\b/i);
    expect(sql).toMatch(/uq_mpa_one_open_per_campaign ON marketing_paid_authorizations \(campaign_key\) WHERE status = 'authorized'/);
    expect(sql).toMatch(/creative_id\s+UUID NOT NULL/);
    expect(sql).toMatch(/-- Reverse:/);
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prod-migrate-223.js'), 'utf8');
    expect(runner).toMatch(/REFUSE: PRODUCTION endpoint only/); expect(runner).toMatch(/campaigns_unchanged/); expect(runner).toMatch(/ledger_unchanged/);
  });
});

describe('creating an authorization', () => {
  test('only the platform owner can authorize', async () => {
    const r = await authz.create({ campaign_key: 'c-admin', amount_cents: 1000, starts_at: iso(0), ends_at: iso(DAY), creative_id: CREATIVE }, { actor: ADMIN });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/platform owner/) });
    expect(await q(`SELECT 1 FROM marketing_paid_authorizations WHERE campaign_key = 'c-admin'`)).toHaveLength(0);
  });
  test('it must name an eligible creative, fit the per-campaign ceiling, and have a future window', async () => {
    const base = { campaign_key: 'c-v', amount_cents: 1000, starts_at: iso(0), ends_at: iso(DAY), creative_id: CREATIVE };
    expect((await authz.create({ ...base, creative_id: undefined }, { actor: OWNER })).reason).toMatch(/creative/);
    expect((await authz.create({ ...base, creative_id: undefined, creative_asset_key: 'ASSET-DNU' }, { actor: OWNER })).reason).toMatch(/not production-eligible/);
    expect((await authz.create({ ...base, amount_cents: 50000 }, { actor: OWNER })).reason).toMatch(/per-campaign ceiling/);
    expect((await authz.create({ ...base, ends_at: iso(-DAY), starts_at: iso(-2 * DAY) }, { actor: OWNER })).reason).toMatch(/already ended/);
    expect((await authz.create({ ...base, package_key: 'PKG-OTHER' }, { actor: OWNER })).reason).toMatch(/different image/);
  });
  test('the owner can authorize once per campaign and is notified', async () => {
    const notify = require('../src/services/ownerNotifyService').notify;
    const a = await authorize('c-once');
    expect(a).toMatchObject({ status: 'authorized', amount_cents: 2500, creative_asset_key: 'ASSET-OK', authorized_by: OWNER.id });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/Paid advertising authorized: c-once up to \$25\.00/) }), expect.anything());
    expect((await authz.create({ campaign_key: 'c-once', amount_cents: 100, starts_at: iso(0), ends_at: iso(DAY), creative_id: CREATIVE }, { actor: OWNER })).reason)
      .toMatch(/already has an open authorization/);
  });
});

describe('assertCovers refuses anything the owner did not authorize', () => {
  test('no authorization', async () => {
    expect(await authz.assertCovers({ campaignKey: 'c-none', amountCents: 100, creativeIds: [CREATIVE] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no open owner authorization/) });
  });
  test('expired', async () => {
    const a = await authorize('c-exp');
    await q(`UPDATE marketing_paid_authorizations SET expires_at = now() - interval '1 minute', authorized_at = now() - interval '2 days' WHERE id = $1`, [a.id]);
    expect((await authz.assertCovers({ campaignKey: 'c-exp', amountCents: 100, creativeIds: [CREATIVE] })).ok).toBe(false);
    expect((await q('SELECT status FROM marketing_paid_authorizations WHERE id = $1', [a.id]))[0].status).toBe('expired');
  });
  test('over the amount', async () => {
    await authorize('c-amt');
    expect(await authz.assertCovers({ campaignKey: 'c-amt', amountCents: 2501, creativeIds: [CREATIVE] })).toMatchObject({ ok: false, reason: expect.stringMatching(/exceeds the owner authorization of \$25\.00/) });
    expect((await authz.assertCovers({ campaignKey: 'c-amt', amountCents: 2500, creativeIds: [CREATIVE] })).ok).toBe(true);
  });
  test('wrong creative or package', async () => {
    await authorize('c-cre', { package_key: 'PKG-OK' });
    expect((await authz.assertCovers({ campaignKey: 'c-cre', amountCents: 100, creativeIds: [OTHER_CREATIVE] })).reason).toMatch(/creative differs/);
    expect((await authz.assertCovers({ campaignKey: 'c-cre', amountCents: 100, creativeIds: [] })).reason).toMatch(/no creative named/);
    expect((await authz.assertCovers({ campaignKey: 'c-cre', amountCents: 100, creativeIds: [CREATIVE], packageKeys: ['PKG-OTHER'] })).reason).toMatch(/package differs/);
  });
  test('a schedule ending after the authorized end', async () => {
    await authorize('c-win');
    expect((await authz.assertCovers({ campaignKey: 'c-win', amountCents: 100, creativeIds: [CREATIVE], window: { startTime: iso(0), endTime: iso(20 * DAY) } })).reason)
      .toMatch(/must end by the authorized end/);
  });
  test('revoked', async () => {
    const a = await authorize('c-rev');
    expect((await authz.revoke(a.id, { actor: ADMIN })).ok).toBe(false);
    expect((await authz.revoke(a.id, { actor: OWNER })).ok).toBe(true);
    expect((await authz.assertCovers({ campaignKey: 'c-rev', amountCents: 100, creativeIds: [CREATIVE] })).ok).toBe(false);
  });
});

describe('buildExperimentHierarchy', () => {
  test('without an authorization nothing is reserved and the provider is never called', async () => {
    await seedCampaign('c-build-none');
    const pkgs = await seedExperiment('c-build-none', 'EXP-NONE');
    const r = await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-NONE', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/owner authorization refused: no open owner authorization/) });
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(meta.createCampaign).not.toHaveBeenCalled();
  });
  test('a package using a different creative than the authorized one is refused', async () => {
    await seedCampaign('c-build-cre');
    const pkgs = await seedExperiment('c-build-cre', 'EXP-CRE', { pkgKey: 'PKG-OTHER' });
    await authorize('c-build-cre');
    const r = await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-CRE', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs });
    expect(r.reason).toMatch(/creative differs/);
    expect(meta.createCampaign).not.toHaveBeenCalled();
  });
  test('arms allocating more than the authorization are refused', async () => {
    await seedCampaign('c-build-amt', { budget: 3000 });
    const pkgs = await seedExperiment('c-build-amt', 'EXP-AMT', { arms: [['A', 1500], ['B', 1500]] });
    await authorize('c-build-amt');
    const r = await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-AMT', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs });
    expect(r.reason).toMatch(/exceeds the owner authorization/);
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
  test('with an authorization: reserves the budget itself BEFORE the provider, schedules the end, links the campaign, auto-stop on', async () => {
    await seedCampaign('c-build-ok');
    const pkgs = await seedExperiment('c-build-ok', 'EXP-OK');
    const a = await authorize('c-build-ok');
    const order = [];
    ledger.reserve.mockImplementationOnce(async (x) => { order.push('reserve'); return { ok: true, replayed: false, reservation: x }; });
    meta.createCampaign.mockImplementationOnce(async () => { order.push('provider'); return { ok: true, provider_campaign_id: 'C-OK' }; });
    const r = await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-OK', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs });
    expect(r.ok).toBe(true);
    expect(order).toEqual(['reserve', 'provider']);
    expect(ledger.reserve).toHaveBeenCalledWith(expect.objectContaining({ campaignKey: 'c-build-ok', amountCents: 2500, idempotencyKey: 'campaign:c-build-ok' }));
    const adset = meta.createAdSet.mock.calls[0][0];
    expect(new Date(adset.endTime).getTime()).toBe(new Date(a.ends_at).getTime());
    const c = (await q(`SELECT authorization_id, evidence FROM marketing_paid_campaigns WHERE campaign_key = 'c-build-ok'`))[0];
    expect(c.authorization_id).toBe(a.id);
    expect(c.evidence.auto_stop_at_authorization).toBe(true);
    // An existing reservation that already covers the campaign is not reserved twice.
    await q(`INSERT INTO marketing_paid_budget_ledger (campaign_key, kind, amount_cents, idempotency_key) VALUES ('c-build-ok', 'commit', 2500, 'campaign:c-build-ok')`);
    ledger.reserve.mockClear();
    expect((await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-OK', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs })).ok).toBe(true);
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
  test('a provider failure before any object exists hands the reservation back', async () => {
    await seedCampaign('c-build-fail');
    const pkgs = await seedExperiment('c-build-fail', 'EXP-FAIL');
    await authorize('c-build-fail');
    meta.createCampaign.mockImplementationOnce(async () => ({ ok: false, reason: 'provider said no' }));
    const r = await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-FAIL', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs });
    expect(r).toMatchObject({ ok: false, reason: 'campaign: provider said no' });
    expect(ledger.release).toHaveBeenCalledWith(expect.objectContaining({ campaignKey: 'c-build-fail', amountCents: 2500, idempotencyKey: 'campaign:c-build-fail:release' }));
  });
  test('an explicit auto_stop_at_authorization false recorded by the owner is respected (default only)', async () => {
    await seedCampaign('c-build-flag');
    await q(`UPDATE marketing_paid_campaigns SET evidence = '{"auto_stop_at_authorization": false}'::jsonb WHERE campaign_key = 'c-build-flag'`);
    const pkgs = await seedExperiment('c-build-flag', 'EXP-FLAG');
    await authorize('c-build-flag');
    expect((await delivery.buildExperimentHierarchy({ experimentKey: 'EXP-FLAG', account: 'act_1', dailyCeilingCentsForExperiment: 500, packageKeyByArm: pkgs })).ok).toBe(true);
    expect((await q(`SELECT evidence FROM marketing_paid_campaigns WHERE campaign_key = 'c-build-flag'`))[0].evidence.auto_stop_at_authorization).toBe(false);
  });
  test('the destination can carry the promoted auction for attribution', () => {
    const u = new URL(delivery.buildDestination({ destinationUrl: 'https://bid.advantage.bid/auction.html?id=1', funnel: 'buyer', campaignKey: 'k',
      auctionId: '00000000-0000-4000-8000-000000000001' }));
    expect(u.searchParams.get('adv_auction')).toBe('00000000-0000-4000-8000-000000000001');
    expect(new URL(delivery.buildDestination({ destinationUrl: 'https://bid.advantage.bid/', funnel: 'buyer', campaignKey: 'k' })).searchParams.has('adv_auction')).toBe(false);
  });
});

describe('activateExperiment', () => {
  test('activates under the authorization and consumes it; a second activation needs a new one', async () => {
    const r = await delivery.activateExperiment({ experimentKey: 'EXP-OK', account: 'act_1' });
    expect(r.ok).toBe(true);
    const a = (await q(`SELECT status, consumed_at FROM marketing_paid_authorizations WHERE campaign_key = 'c-build-ok'`))[0];
    expect(a.status).toBe('consumed');
    expect(a.consumed_at).not.toBeNull();
    meta.setStatus.mockClear();
    const again = await delivery.activateExperiment({ experimentKey: 'EXP-OK', account: 'act_1' });
    expect(again).toMatchObject({ ok: false, reason: expect.stringMatching(/no open owner authorization/) });
    expect(meta.setStatus).not.toHaveBeenCalled();
  });
  test('an ad set without an end inside the window is refused (older builds)', async () => {
    await seedCampaign('c-old');
    await seedExperiment('c-old', 'EXP-OLD');
    await authorize('c-old');
    await q(`INSERT INTO marketing_provider_objects (account_ref, object_type, provider_id, campaign_key, package_key, idempotency_key, evidence)
             VALUES ('act_1', 'adset', 'S-OLD', 'c-old', NULL, 'live:adset:EXP-OLD:A', '{"daily_budget_cents": 500}'::jsonb),
                    ('act_1', 'ad', 'A-OLD', 'c-old', 'PKG-OK', 'live:ad:EXP-OLD:A', '{}'::jsonb)`);
    const r = await delivery.activateExperiment({ experimentKey: 'EXP-OLD', account: 'act_1' });
    expect(r.reason).toMatch(/no end inside the authorized window/);
    expect(meta.setStatus).not.toHaveBeenCalled();
  });
  test('setStatus(ACTIVE) itself checks the owner authorization (backstop for scripts)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paidGrowth', 'metaAdsProvider.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function setStatus'), src.indexOf('const pause ='));
    expect(fn.indexOf('assertCovers')).toBeGreaterThan(fn.indexOf("if (status === 'ACTIVE')"));
    expect(fn.indexOf('assertCovers')).toBeLessThan(fn.indexOf("call('/' + objectId"));
  });
});

describe('createCampaign (paidExecutionService)', () => {
  beforeAll(async () => {
    for (const [k, v] of [['marketing.paid.global_kill', 'false'], ['marketing.paid.execution_enabled', 'true'], ['marketing.destinations.meta_ads_enabled', 'true'], ['marketing.paid_growth.mode', '"live"']]) {
      await q(`INSERT INTO platform_config (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    }
  });
  test('refuses without an authorization: no reservation, no provider call', async () => {
    await seedCampaign('c-create-none');
    const r = await execution.createCampaign({ campaignKey: 'c-create-none' });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/owner authorization refused/) });
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(meta.createCampaign).not.toHaveBeenCalled();
  });
  test('refuses a budget above the authorization and a different creative', async () => {
    await seedCampaign('c-create-big', { budget: 5000 });
    await authorize('c-create-big');
    expect((await execution.createCampaign({ campaignKey: 'c-create-big' })).reason).toMatch(/exceeds the owner authorization/);
    await seedCampaign('c-create-other', { creative: OTHER_CREATIVE });
    await authorize('c-create-other');
    expect((await execution.createCampaign({ campaignKey: 'c-create-other' })).reason).toMatch(/creative differs/);
    expect(meta.createCampaign).not.toHaveBeenCalled();
  });
  test('creates PAUSED (READY) under a covering authorization', async () => {
    await seedCampaign('c-create-ok');
    const a = await authorize('c-create-ok');
    const r = await execution.createCampaign({ campaignKey: 'c-create-ok' });
    expect(r.ok).toBe(true);
    expect(r.campaign.state).toBe('READY');
    expect(r.campaign.authorization_id).toBe(a.id);
  });
});

describe('emergency stop', () => {
  test('any admin can engage it; it pauses local ACTIVE campaigns AND provider-active campaigns our records call finished', async () => {
    await seedCampaign('k-active', { state: 'ACTIVE', provider: 'P-ACTIVE' });
    await seedCampaign('k-exhausted', { state: 'BUDGET_EXHAUSTED', provider: 'P-EXHAUSTED' });
    await seedCampaign('k-completed', { state: 'COMPLETED', provider: 'P-COMPLETED' });
    await seedCampaign('k-unreadable', { state: 'PAUSED', provider: 'P-UNREADABLE' });
    await seedCampaign('k-noprovider', { state: 'STOPPED' });
    meta.getObject.mockImplementation(async (type, id) => {
      if (id === 'P-EXHAUSTED') return { ok: true, object: { status: 'ACTIVE', effective_status: 'ACTIVE' } };
      if (id === 'P-UNREADABLE') return { ok: false, reason: 'timeout' };
      return { ok: true, object: { status: 'PAUSED', effective_status: 'PAUSED' } };
    });
    const out = await execution.emergencyKill({ reason: 'test stop', actor: ADMIN });
    expect(out.kill).toBe(true);
    const paused = meta.pause.mock.calls.map((c) => c[0]);
    expect(paused).toEqual(expect.arrayContaining(['P-ACTIVE', 'P-EXHAUSTED', 'P-UNREADABLE']));
    expect(paused).not.toContain('P-COMPLETED');
    expect(out.provider_sweep.find((x) => x.campaign_key === 'k-exhausted')).toMatchObject({ action: 'pause', ok: true, provider_status: 'ACTIVE' });
    expect(meta.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ACTIVE' }));
    // Historical rows are not rewritten by the sweep.
    expect((await q(`SELECT state FROM marketing_paid_campaigns WHERE campaign_key = 'k-exhausted'`))[0].state).toBe('BUDGET_EXHAUSTED');
    // The switch is ON, audited as the admin's safety stop.
    expect((await q(`SELECT value FROM platform_config WHERE key = 'marketing.paid.global_kill'`))[0].value).toBe(true);
    const audit = (await q(`SELECT * FROM platform_setting_audit WHERE config_key = 'marketing.paid.global_kill' ORDER BY created_at DESC LIMIT 1`))[0];
    expect(audit).toMatchObject({ actor_user_id: ADMIN.id, actor_label: 'safety_stop', new_value: true });
    meta.getObject.mockReset();
  });
  test('clearing it is the platform owner\'s decision', async () => {
    await expect(execution.clearKill({ actor: ADMIN })).rejects.toMatchObject({ status: 403 });
    expect((await q(`SELECT value FROM platform_config WHERE key = 'marketing.paid.global_kill'`))[0].value).toBe(true);
    await execution.clearKill({ actor: OWNER });
    expect((await q(`SELECT value FROM platform_config WHERE key = 'marketing.paid.global_kill'`))[0].value).toBe(false);
  });
  test('the automatic ceiling-breach stop still works with no signed-in user', async () => {
    const out = await execution.emergencyKill({ reason: 'automatic: paid spend ceiling breach' });
    expect(out.kill).toBe(true);
    const audit = (await q(`SELECT * FROM platform_setting_audit WHERE config_key = 'marketing.paid.global_kill' ORDER BY created_at DESC LIMIT 1`))[0];
    expect(audit).toMatchObject({ actor_kind: 'system', actor_label: 'automatic: paid spend ceiling breach' });
  });
});

describe('admin routes', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminMarketingAgency.js'), 'utf8');
  const line = (p) => route.split('\n').find((l) => l.includes("router.post('" + p + "'"));
  test('starting or unblocking spend is platform owner only; stopping stays open to every Super Admin', () => {
    for (const p of ['/authorizations', '/authorizations/:id/revoke', '/campaigns/:key/create', '/kill/clear', '/spend/settings', '/creative/:assetKey/approval']) expect(line(p)).toMatch(/ownerOnly/);
    for (const p of ['/kill', '/campaigns/:key/pause', '/campaigns/:key/stop']) expect(line(p)).toMatch(/superOnly/);
    expect(route).toMatch(/const ownerOnly = \(req, res, next\) => \(rbac\.isSuperAdmin\(req\.user\) \? requirePlatformOwner\(req, res, next\)/);
  });
});
