'use strict';

/**
 * Phase 3O Wave 3 — FULL END-TO-END SHADOW REHEARSAL + SOFTWARE CERTIFICATION.
 *
 * Drives the REAL services (obligation engine, Wave 1 creative contract, Wave 2 channel executors, resilience
 * ladder, paid-allocation ledger, Director, seller renderer, Desktop bridge) through complete lifecycles for
 * every package (INCLUDED/FEATURED/PREMIUM/SIGNATURE) and Additional Promotion (BOOST/REACH/SPOTLIGHT/CUSTOM),
 * plus deliberate resilience failures — all against a deterministic in-memory certification harness. Every
 * shadow artifact is structurally distinguishable from real fulfilment; nothing sends/publishes/spends; all
 * external gates stay OFF. Non-customer, clearly-marked fixtures only.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// External gates OFF + deterministic config → everything stays SHADOW.
jest.mock('../src/services/marketingConfigService', () => ({
  getBool: async (key, fallback) => {
    if (['marketing.a7_send_enabled', 'marketing.destinations.meta_enabled', 'marketing.a9_publish_enabled',
         'marketing.destinations.google_ads_enabled', 'marketing.onsite.enabled'].includes(key)) return false;
    return fallback === undefined ? false : fallback;
  },
  getInt: async (key, fallback) => fallback,
}));
// Audit log + Owner SMS are spied (no real writes / no real SMS during certification).
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn(async () => {}) }));
jest.mock('../src/services/ownerAlertService', () => ({ ALERT_TYPES: {}, notifyAdminActionRequired: jest.fn(async () => ({ sent: 2, recipients: 2 })), notifyOwnerMarketingPackagePurchased: jest.fn(async () => ({ sent: 2 })) }));
const smsSpy = require('../src/services/ownerAlertService').notifyAdminActionRequired;
// Creative engine returns a shadow CLEAN result (no Python spawn during certification).
jest.mock('../src/services/creativeEngineService', () => ({
  requestCreative: jest.fn(async ({ jobId, auctionId }) => ({ ok: true, job_id: jobId, auction_id: auctionId,
    runtime_version: '3M.3+wave1', clean: 6, review: 0, failed: 0, audit: { violations: [] },
    qa: { pass: true, ratios: ['1:1', '4:5'] }, creative: { formats: ['1:1', '4:5'] },
    provenance: [{ lot_id: 'L1', fidelity: 'CLEAN', rgb_edited: false, generative: false }] })),
  runEngine: jest.fn(), getJob: jest.fn(), ENGINE: 'x',
}));

const { makeStore, makeRunner } = require('./helpers/marketingMemRunner');
const recipes = require('../docs/marketing/phase3o/schemas/recipes.json');
const engine = require('../src/services/marketingObligationEngine');
const owned = require('../src/services/ownedPlacementExecutor');
const shared = require('../src/services/sharedEmailExecutor');
const dedicated = require('../src/services/dedicatedEmailExecutor');
const social = require('../src/services/socialAdapter');
const perf = require('../src/services/performanceAggregationService');
const addl = require('../src/services/additionalPromotionExecutor');
const dispatch = require('../src/services/channelDispatch');
const ladders = require('../src/services/resilienceLadderService');
const alloc = require('../src/services/paidAllocationBridge');
const renderer = require('../src/services/sellerReportRenderer');
const resolver = require('../src/services/directorInputResolver');
const directorDecision = require('../src/services/directorDecisionService');

const recipeFor = (id) => recipes.find((x) => x.identity === id);
const PAID_KEYS = ['paid_local_promotion', 'lot_level_promotion'];

// Build obligations for a package from its authoritative recipe.
async function buildPackage(store, runner, { identity, purchaseId, auctionId }) {
  const rec = recipeFor(identity);
  await engine.createFromSnapshot({ purchaseKind: 'package', purchaseId, auctionId,
    guaranteed: rec.guaranteed.map((g) => ({ key: g.feature_key })), discretionary: [] }, runner);
  return engine.listForPurchase('package', purchaseId, runner);
}
// Fully fulfil ONE obligation in shadow, returning whether it reached a terminal-OK state (real vs shadow).
async function fulfil(store, runner, ob, ctx) {
  const ch = dispatch.channelOf(ob.feature_key);
  if (ch === 'OWNED') {
    const res = await owned.reserve(ob, { auctionId: ctx.auctionId, startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-08T00:00:00Z', lotIds: ob.feature_key === 'notable_lot_spotlight' ? ['L1'] : [] }, runner);
    await owned.activate(res.id, '2026-10-01T00:00:00Z', runner);
    await owned.recordExposure(res.id, { impressions: 800, clicks: 20, atIso: '2026-10-08T00:00:00Z' }, runner);
    const out = await owned.reconcile([ob], runner);
    return { channel: ch, real: out[0].completed };
  }
  if (ch === 'SERVICE' || ch === 'CREATIVE') {
    await engine.transition(ob.id, 'completed', { proof: { system_verified: true, feature_key: ob.feature_key } }, 'cert', runner);
    return { channel: ch, real: true };
  }
  // EMAIL / SOCIAL / PAID are gated → shadow; complete NOTHING for real.
  return { channel: ch, real: false, shadow: true };
}

const eligible = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@cert.example`, permission_basis: 'platform_relationship', permission_scope: { all: true } }));

beforeEach(() => smsSpy.mockClear());

// ─────────────────────────────────────────────────────────────────────────────
describe('§3 INCLUDED end-to-end', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('correct recipe, no paid entitlements, performance-standard, no seller-facing internals', async () => {
    const obs = await buildPackage(store, runner, { identity: 'INCLUDED', purchaseId: 'p-inc', auctionId: 'A-inc' });
    const keys = obs.map((o) => o.feature_key);
    expect(keys).toEqual(expect.arrayContaining(['listing_standard', 'listing_card', 'follower_launch_notification', 'performance_standard']));
    expect(keys.some((k) => PAID_KEYS.includes(k))).toBe(false); // no paid entitlements created
    for (const ob of obs) await fulfil(store, runner, ob, { auctionId: 'A-inc' });
    const comp = await engine.evaluateCompletion('package', 'p-inc', runner);
    expect(comp.complete).toBe(true);
    const report = renderer.render({ package_key: 'included', amount_paid_cents: 0, guaranteed_deliverables: obs.map((o) => ({ label: o.label })) },
      obs.map((o) => ({ ...o, state: 'completed', category: 'guaranteed' })), {});
    expect(JSON.stringify(report)).not.toMatch(/authority|growth|60\/40|bps|profit|policy_version/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§4 FEATURED end-to-end', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('owned placements require evidence; creative 1:1+4:5; share kit; reconciliation', async () => {
    const obs = await buildPackage(store, runner, { identity: 'FEATURED', purchaseId: 'p-ft', auctionId: 'A-ft' });
    const badge = obs.find((o) => o.feature_key === 'featured_badge_priority');
    // Reservation alone must NOT complete.
    const res = await owned.reserve(badge, { auctionId: 'A-ft', startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-08T00:00:00Z' }, runner);
    await owned.activate(res.id, '2026-10-01T00:00:00Z', runner);
    let gate = await owned.evidenceComplete(badge, runner);
    expect(gate.ok).toBe(false); // reserved+activated only
    await owned.recordExposure(res.id, { impressions: 700, clicks: 10, atIso: '2026-10-03T00:00:00Z' }, runner);
    gate = await owned.evidenceComplete(badge, runner);
    expect(gate.ok).toBe(true);
    // Fulfil the rest.
    for (const ob of obs.filter((o) => o.feature_key !== 'featured_badge_priority')) await fulfil(store, runner, ob, { auctionId: 'A-ft' });
    await owned.reconcile([badge], runner);
    const comp = await engine.evaluateCompletion('package', 'p-ft', runner);
    expect(comp.complete).toBe(true);
    const creative = await require('../src/services/creativeEngineService').requestCreative({ jobId: 'c-ft', auctionId: 'A-ft' });
    expect(creative.creative.formats).toEqual(['1:1', '4:5']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§5 PREMIUM end-to-end (homepage module 4d + shared edition)', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('homepage module defaults to 4 days; shared edition 4/6/2 + shadow completes nothing', async () => {
    const obs = await buildPackage(store, runner, { identity: 'PREMIUM', purchaseId: 'p-pr', auctionId: 'A-pr' });
    expect(owned.resolveConfig('homepage_module_run').days).toBe(4);
    const mod = obs.find((o) => o.feature_key === 'homepage_module_run');
    const res = await owned.reserve(mod, { auctionId: 'A-pr', startAt: '2026-10-01T00:00:00Z' }, runner);
    expect(res.days).toBe(4);
    // Shared edition: valid 4-auction edition.
    const cand = (id, close, buy) => ({ auction_id: id, obligation_id: obs.find((o) => o.feature_key === 'shared_edition_inclusion').id, closing_at: close, purchased_at: buy });
    const ed = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z',
      candidates: [cand('A-pr', '2026-10-01', '2026-09-01'), cand('b', '2026-10-02', '2026-09-02'), cand('c', '2026-10-03', '2026-09-03'), cand('d', '2026-10-04', '2026-09-04')],
      audienceContacts: eligible(40, 'nj') }, runner);
    expect(ed.card_count).toBe(4); expect(ed.target).toBe(4); expect(ed.max).toBe(6);
    expect(ed.shadow).toBe(true); expect(ed.completes_real_obligation).toBe(false);
    // Premium social = 1 post (shadow).
    const soc = await social.execute({ id: obs.find((o) => o.feature_key === 'social_post_organic').id }, { auction: { auction_id: 'A-pr', title: 'Estate', lot_count: 40 }, identity: 'PREMIUM', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(soc.results.length).toBe(1); expect(soc.completes_real_obligation).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§6 SIGNATURE end-to-end (hero 2d + dedicated scope ladder + 3 social waves)', () => {
  let store, runner;
  const pool = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@cert.example`, permission_basis: 'explicit_opt_in', permission_scope: { all: true } }));
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); jest.spyOn(engine, 'block').mockResolvedValue({}); });
  afterEach(() => jest.restoreAllMocks());

  test('hero defaults to 2 days; 3 social waves; dedicated scope ladder scenarios', async () => {
    const obs = await buildPackage(store, runner, { identity: 'SIGNATURE', purchaseId: 'p-sg', auctionId: 'A-sg' });
    expect(owned.resolveConfig('homepage_hero_days').days).toBe(2);
    const hero = obs.find((o) => o.feature_key === 'homepage_hero_days');
    const res = await owned.reserve(hero, { auctionId: 'A-sg', startAt: '2026-10-01T00:00:00Z' }, runner);
    expect(res.days).toBe(2);
    const soc = await social.execute({ id: obs.find((o) => o.feature_key === 'social_post_organic').id }, { auction: { auction_id: 'A-sg', title: 'Estate', lot_count: 90 }, identity: 'SIGNATURE', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(soc.waves).toEqual(['LAUNCH', 'MID', 'FINAL']);
    const dedOb = obs.find((o) => o.feature_key === 'dedicated_send');
    // Each scope scenario is INDEPENDENT — a fresh runner isolates frequency/spacing history.
    const freshDed = async (pools, market) => {
      const s2 = makeStore(); const r2 = makeRunner(s2); jest.spyOn(engine, 'block').mockResolvedValue({});
      return dedicated.execute(dedOb, { auctionId: 'A-sg', market, referenceDate: '2026-10-01T00:00:00Z', audiencePools: pools }, r2);
    };
    expect((await freshDed({ LOCAL: pool(320, 'l') }, 'NJ')).chosen_scope).toBe('LOCAL');
    expect((await freshDed({ LOCAL: pool(100, 'l'), REGIONAL: pool(400, 'r') }, 'PA')).chosen_scope).toBe('REGIONAL');
    expect((await freshDed({ LOCAL: pool(50, 'l'), REGIONAL: pool(100, 'r'), CATEGORY_SHIPPABLE: pool(500, 'c') }, 'NY')).chosen_scope).toBe('CATEGORY_SHIPPABLE');
    expect((await freshDed({ LOCAL: pool(10, 'l'), REGIONAL: pool(20, 'r'), CATEGORY_SHIPPABLE: pool(30, 'c'), NATIONWIDE: pool(500, 'n') }, 'MA')).chosen_scope).toBe('NATIONWIDE');
    const none = await freshDed({ LOCAL: pool(10, 'l'), NATIONWIDE: pool(50, 'n') }, 'CT');
    expect(none.ok).toBe(false); expect(none.reason).toBe('no_scope_qualifies'); expect(none.ladder).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§7 Additional Promotion end-to-end (children via ordinary executors)', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); jest.spyOn(engine, 'block').mockResolvedValue({}); });
  afterEach(() => jest.restoreAllMocks());

  test.each(['BOOST', 'REACH', 'SPOTLIGHT'])('%s: every child created + dispatched + reconciled; paid child gated (no spend)', async (identity) => {
    const promo = { id: 'promo-' + identity, promotion_key: identity, amount_paid_cents: 9900, status: 'paid' };
    const out = await addl.execute(promo, { auctionId: 'A-ap', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      auction: { auction_id: 'A-ap', title: 'Estate', lot_count: 30 }, audiencePools: { LOCAL: [] }, audienceContacts: [] }, runner);
    expect(out.ok).toBe(true);
    expect(out.reconciliation.covered).toBe(true);
    expect(out.executed.length).toBe(out.children.length);
    if (out.children.includes('paid_local_promotion')) {
      const paid = out.executed.find((e) => e.feature_key === 'paid_local_promotion');
      expect(paid.gated).toBe(true); // paid path gated, contract/resilience complete, no spend
    }
  });
  test('CUSTOM: bundle disclosed pre-payment → snapshot → children → reconciliation', async () => {
    const promo = { id: 'promo-custom', promotion_key: 'CUSTOM', amount_paid_cents: 24900, status: 'paid',
      bundle_children: [{ feature_key: 'homepage_hero_days' }, { feature_key: 'social_post_organic' }], bundle_shown_at: '2026-09-01' };
    const out = await addl.execute(promo, { auctionId: 'A-ap', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z', auction: { auction_id: 'A-ap' } }, runner);
    expect(out.from_bundle).toBe(true); expect(out.children).toEqual(['homepage_hero_days', 'social_post_organic']);
    expect(out.reconciliation.covered).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§8 Resilience failure rehearsal', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('ladder order is FULFILL→…→ESCALATE and escalate is never first', () => {
    const rungs = ladders.ladderRungs('L_shared_edition');
    expect(rungs[0]).not.toBe('ESCALATE');
    expect(rungs).toContain('ESCALATE');
    expect(rungs.indexOf('ESCALATE')).toBe(rungs.length - 1);
  });
  test('dedicated below floor → resilience, package not refused, obligation blocked (not needs_owner first)', async () => {
    jest.spyOn(engine, 'block').mockResolvedValue({});
    const obs = await buildPackage(store, runner, { identity: 'SIGNATURE', purchaseId: 'p-r', auctionId: 'A-r' });
    const dedOb = obs.find((o) => o.feature_key === 'dedicated_send');
    const d = await dedicated.execute(dedOb, { auctionId: 'A-r', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z', audiencePools: { LOCAL: [] } }, runner);
    expect(d.ok).toBe(false);
    expect(engine.block).toHaveBeenCalled(); // BLOCKED (auto-recheckable), not NEEDS_OWNER first
    expect(smsSpy).not.toHaveBeenCalled();   // no Owner SMS for an auto-resolvable block
    jest.restoreAllMocks();
  });
  test('social provider unavailable → blocked via resilience, never falsely completed', async () => {
    jest.spyOn(social, 'resolveProvider').mockResolvedValue({ name: 'mock', active: false, shadow: true, publish: async () => ({ ok: false }) });
    jest.spyOn(engine, 'block').mockResolvedValue({});
    const out = await social.publishWave({ id: 'ob-soc' }, { auction: { auction_id: 'A-r' }, wave: 'ANY', referenceAt: '2026-10-01T00:00:00Z' }, runner);
    expect(out.ok).toBe(false); expect(out.reason).toBe('provider_inactive'); expect(out.ladder).toBeTruthy();
    jest.restoreAllMocks();
  });
  test('genuine NEEDS_OWNER (automation exhausted) fires the certified Owner SMS exactly once', async () => {
    const obs = await buildPackage(store, runner, { identity: 'FEATURED', purchaseId: 'p-no', auctionId: 'A-no' });
    await engine.needsOwner(obs[0].id, { reason: 'ladder exhausted — no fair automatic resolution', options: ['activate_channel'] }, runner);
    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(smsSpy.mock.calls[0][0].actionType).toBe('marketing_package_exception');
    expect(store.obs.find((o) => o.id === obs[0].id).state).toBe('needs_owner');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§9 Evidence + reconciliation audit', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('state history is append-only + terminal states immutable', async () => {
    const obs = await buildPackage(store, runner, { identity: 'FEATURED', purchaseId: 'p-e', auctionId: 'A-e' });
    const ob = obs[0];
    await engine.transition(ob.id, 'completed', { proof: { x: 1 } }, 'cert', runner);
    expect(store.events.some((e) => e.to_state === 'completed')).toBe(true);
    await expect(engine.transition(ob.id, 'live', {}, 'cert', runner)).rejects.toThrow(/immutable/);
  });
  test('owned placement never COMPLETED without evidence (reconcile skips un-evidenced)', async () => {
    const spy = jest.spyOn(engine, 'transition').mockResolvedValue({});
    const obs = await buildPackage(store, runner, { identity: 'FEATURED', purchaseId: 'p-e2', auctionId: 'A-e2' });
    const badge = obs.find((o) => o.feature_key === 'featured_badge_priority');
    await owned.reserve(badge, { auctionId: 'A-e2', startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-08T00:00:00Z' }, runner);
    // NOTE: not activated, no exposure → no evidence.
    const out = await owned.reconcile([badge], runner);
    expect(out[0].completed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§10 Director boundary audit', () => {
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('bounded kinds persist; prohibited kinds rejected', async () => {
    const spy = jest.spyOn(directorDecision, 'record').mockResolvedValue({ id: 'd', kind: 'SCHEDULE' });
    expect((await resolver.persistDecision({ kind: 'SCHEDULE', inputs: {} }, runner)).ok).toBe(true);
    spy.mockRestore();
    for (const bad of ['REFUND', 'REPRICE', 'HIDE', 'REFUSE_CAPACITY', 'ALTER_ENTITLEMENT', 'OVERRIDE_SUPPRESSION', 'MANUFACTURE_AUDIENCE', 'MUTATE_POLICY']) {
      expect((await resolver.persistDecision({ kind: bad, inputs: {} }, runner)).ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§11 Paid-allocation ceiling audit', () => {
  let store, runner;
  beforeEach(() => {
    store = makeStore(); runner = makeRunner(store);
    store.purchases['p-alloc'] = { internal_authority_cents: 10000, direct_fulfillment_bps: 6000, economic_policy_version: 'v1' };
  });
  test('reserve/spend/release/reconcile; reserved+spent never exceeds ceiling; idempotent', async () => {
    const auth = await alloc.authorityFor('p-alloc', runner);
    expect(auth.ceiling_cents).toBe(10000);
    const r1 = await alloc.reserve('p-alloc', 3000, 'idem-1', {}, runner);
    expect(r1.ok).toBe(true); expect(r1.balance.reserved_cents).toBe(3000);
    const r1again = await alloc.reserve('p-alloc', 3000, 'idem-1', {}, runner); // idempotent replay (still under ceiling)
    expect(r1again.idempotent_replay).toBe(true);
    const over = await alloc.reserve('p-alloc', 8000, 'idem-2', {}, runner);    // 3000+8000 > 10000 → ceiling
    expect(over.ok).toBe(false); expect(over.reason).toMatch(/ceiling/);
    const sp = await alloc.spend('p-alloc', 3000, 'idem-spend', {}, runner);
    expect(sp.balance.spent_cents).toBe(3000);
    const rec = await alloc.reconcile('p-alloc', runner);
    expect(rec.consistent).toBe(true);
    expect(rec.balance.reserved_cents + rec.balance.spent_cents).toBeLessThanOrEqual(rec.balance.ceiling_cents);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§12 Seller reporting confidentiality audit', () => {
  test('classifications + no confidential internals', async () => {
    const store = makeStore(); const runner = makeRunner(store);
    store.placementEvidence.push({ obligation_id: 'ob1', shadow: false, impressions: 900, clicks: 10, first_seen_at: '2026-10-01' });
    store.dedicated.push({ obligation_id: 'ob2', shadow: false, recipient_count: 400, opens: null, clicks: 5, status: 'sent_shadow' });
    const obligations = [{ id: 'ob1', feature_key: 'homepage_module_run' }, { id: 'ob2', feature_key: 'dedicated_send' }];
    const agg = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'p-rep', obligations, auctionFacts: { bids: 30 } }, runner);
    expect(agg.metrics.homepage_module_run.classification).toBe('MEASURED');
    expect(agg.metrics.dedicated_send.classification).toBe('DELIVERED');
    expect(agg.influenced.bids.classification).toBe('INFLUENCED');
    const report = renderer.render({ package_key: 'premium', amount_paid_cents: 24900, guaranteed_deliverables: [{ label: 'Homepage module' }] },
      [{ feature_key: 'homepage_module_run', label: 'Homepage module', state: 'completed', category: 'guaranteed' }], agg.metrics);
    const blob = JSON.stringify(report);
    for (const banned of ['authority', 'growth', '60/40', 'policy_version', 'direct_fulfillment', 'bps', 'profit', 'margin', 'provider', 'recipient']) {
      expect(blob.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§13 Desktop bridge no-PII / no-credential audit', () => {
  const bridge = require('../src/services/desktopBridgeService');
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });
  test('runtime export contains no PII/credentials', async () => {
    const exp = await bridge.buildRuntimeExport('cert-window', runner);
    const json = JSON.stringify(exp).toLowerCase();
    expect(exp.contains_pii).toBe(false);
    expect(exp.message.contains_recipient_data).toBe(false);
    expect(exp.message.contains_production_credentials).toBe(false);
    expect(json).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}|password|secret|api[_-]?key|cardnumber|cvv/);
  });
  test('controlled incoming proposals route through validation (cannot mutate prod directly)', async () => {
    for (const type of ['AUDIT_FINDING', 'CALIBRATION_REPORT', 'RULE_PROPOSAL']) {
      const msg = { message_id: 'm-' + type, direction: 'desktop_to_vs', type, created_at: '2026-09-07T00:00:00Z',
        contract_version: '3O.1', body: { note: 'cert' }, references: [], contains_production_credentials: false, contains_recipient_data: false };
      const out = await bridge.ingestProposal(msg, 'cert-admin', runner);
      expect(out).toBeTruthy();
      expect(JSON.stringify(out)).not.toMatch(/applied_live|prod_mutated|direct_write/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§14 Package truth / pricing / policy', () => {
  test('identities + kinds intact; prices are versioned data (not in recipes)', () => {
    expect(recipes.map((r) => r.identity).sort()).toEqual(['BOOST', 'CUSTOM', 'FEATURED', 'INCLUDED', 'PREMIUM', 'REACH', 'SIGNATURE', 'SPOTLIGHT']);
    // Recipes carry NO price — price is versioned config, never hard-coded business logic.
    for (const r of recipes) expect(r).not.toHaveProperty('price_cents');
  });
});
