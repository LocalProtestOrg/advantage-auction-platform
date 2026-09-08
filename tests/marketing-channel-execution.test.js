'use strict';

/**
 * Phase 3O Wave 2 — Channel Execution Engine. Deterministic shadow certification for every Wave 2 executor:
 * owned placement (calendar/collision/evidence-gated completion), Premium shared edition (4/6/2 + ordering +
 * overflow), Signature dedicated send (scope ladder + 300 floor after exclusions + frequency + resilience), SES
 * bounce/complaint ingestion + eligibility exclusion, provider-neutral social (Premium 1 / Signature 3 + retry +
 * proof + shadow), Additional Promotion (BOOST/REACH/SPOTLIGHT/CUSTOM children through ordinary executors),
 * performance aggregation (DELIVERED/MEASURED/INFLUENCED/UNAVAILABLE + shadow excluded + economics excluded),
 * and Director input resolution + bounded decision persistence. No real send/publish/spend; all gates OFF.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// Config gates OFF (a7/meta) + default numeric config. Keeps everything in SHADOW.
jest.mock('../src/services/marketingConfigService', () => ({
  getBool: async (key, fallback) => {
    if (key === 'marketing.a7_send_enabled') return false;
    if (key === 'marketing.destinations.meta_enabled') return false;
    if (key === 'marketing.a9_publish_enabled') return false;
    return fallback === undefined ? false : fallback;
  },
  getInt: async (key, fallback) => fallback,
}));

// db is only touched by the SES path (db.connect) and by any service that defaults to db without a runner.
const sesStore = { events: [], suppressions: [], deliverability: {} };
jest.mock('../src/db', () => {
  const client = {
    query: async (sql, params = []) => {
      const s = String(sql);
      if (/BEGIN|COMMIT|ROLLBACK/.test(s)) return { rows: [] };
      if (/SELECT 1 FROM ses_feedback_events WHERE provider_event_id/.test(s)) {
        const dup = sesStore.events.find((e) => e.provider_event_id === params[0]);
        return { rows: dup ? [{ 1: 1 }] : [], rowCount: dup ? 1 : 0 };
      }
      if (/INSERT INTO ses_feedback_events/.test(s)) { sesStore.events.push({ event_type: params[0], provider_event_id: params[3] }); return { rows: [] }; }
      if (/INSERT INTO email_suppressions/.test(s)) {
        const email = params[0];      // suppressMarketing binds [normalized, reason, provider, evidenceRef]
        if (!sesStore.suppressions.find((x) => x.normalized_email === email)) sesStore.suppressions.push({ normalized_email: email, reason: params[1] });
        return { rows: [] };
      }
      if (/email_deliverability/.test(s) && /INSERT|UPDATE/.test(s)) { return { rows: [] }; }
      if (/SELECT soft_bounce_count FROM email_deliverability/.test(s)) {
        const d = sesStore.deliverability[params[0]]; return { rows: d ? [d] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
});

const { makeStore, makeRunner } = require('./helpers/marketingMemRunner');

// ─────────────────────────────────────────────────────────────────────────────
describe('Wave 2 — pure logic', () => {
  const shared = require('../src/services/sharedEmailExecutor');
  const social = require('../src/services/socialAdapter');
  const dispatch = require('../src/services/channelDispatch');
  const addl = require('../src/services/additionalPromotionExecutor');
  const owned = require('../src/services/ownedPlacementExecutor');
  const dedicated = require('../src/services/dedicatedEmailExecutor');

  test('shared: closing-date ordering, purchase-time tie-break', () => {
    const ord = shared.orderCandidates([
      { auction_id: 'c', closing_at: '2026-10-05', purchased_at: '2026-09-01' },
      { auction_id: 'a', closing_at: '2026-10-01', purchased_at: '2026-09-03' },
      { auction_id: 'b1', closing_at: '2026-10-03', purchased_at: '2026-09-05' },
      { auction_id: 'b2', closing_at: '2026-10-03', purchased_at: '2026-09-02' }, // earlier purchase wins the tie
    ]);
    expect(ord.map((x) => x.auction_id)).toEqual(['a', 'b2', 'b1', 'c']);
  });
  test('shared: constants 4/6/2', () => {
    expect(shared.TARGET_CARDS).toBe(4); expect(shared.MAX_CARDS).toBe(6); expect(shared.MAX_EDITIONS_PER_MARKET_WEEK).toBe(2);
  });
  test('owned: configurable defaults preserved (module 4d, hero 2d)', () => {
    expect(owned.resolveConfig('homepage_module_run').days).toBe(4);
    expect(owned.resolveConfig('homepage_hero_days').days).toBe(2);
    expect(owned.resolveConfig('homepage_module_run', { days: 6 }).days).toBe(6); // admin override honored
  });
  test('dedicated: scope ladder order + defaults (floor 300)', () => {
    expect(dedicated.SCOPES).toEqual(['LOCAL', 'REGIONAL', 'CATEGORY_SHIPPABLE', 'NATIONWIDE']);
    expect(dedicated.DEFAULTS.floor).toBe(300);
  });
  test('social: wave plans (Premium 1, Signature 3)', () => {
    expect(social.WAVE_PLANS.PREMIUM).toEqual(['ANY']);
    expect(social.WAVE_PLANS.SIGNATURE).toEqual(['LAUNCH', 'MID', 'FINAL']);
  });
  test('social: copy carries clean canonical link + factual manifest', () => {
    const c = social.buildCopy({ auction_id: 'A1', title: 'Estate', lot_count: 40, closing_at: '2026-10-01' }, 'FINAL');
    expect(c.url).toBe('https://bid.advantage.bid/auction/A1');
    expect(c.link_clean).toBe(true);
    expect(c.factual_manifest.map((x) => x.claim)).toEqual(expect.arrayContaining(['title', 'lot_count', 'closing_at']));
  });
  test('dispatch: routes feature_keys to the right channel', () => {
    expect(dispatch.channelOf('homepage_hero_days')).toBe('OWNED');
    expect(dispatch.channelOf('shared_edition_inclusion')).toBe('SHARED_EMAIL');
    expect(dispatch.channelOf('dedicated_send')).toBe('DEDICATED_EMAIL');
    expect(dispatch.channelOf('social_post_organic')).toBe('SOCIAL');
    expect(dispatch.channelOf('paid_local_promotion')).toBe('PAID');
    expect(dispatch.channelOf('creative_lot_specific')).toBe('CREATIVE');
  });
  test('additional promotion: children compose from recipes (BOOST/REACH/SPOTLIGHT)', () => {
    expect(addl.composeChildren('BOOST').children).toEqual(expect.arrayContaining(addl.ADDITIONAL_WAVE_CHILDREN));
    const reach = addl.composeChildren('REACH').children;
    expect(reach).toEqual(expect.arrayContaining(['email_touch_additional', 'homepage_module_run', 'paid_local_promotion']));
    const spot = addl.composeChildren('SPOTLIGHT').children;
    expect(spot).toEqual(expect.arrayContaining(['creative_lot_specific', 'lot_level_promotion', 'reach_expansion_shippable']));
  });
  test('CUSTOM: children come ONLY from the snapshotted bundle (never invented)', () => {
    const c = addl.composeChildren('CUSTOM', { bundle_children: [{ feature_key: 'homepage_hero_days' }, { feature_key: 'social_post_organic' }] });
    expect(c.from_bundle).toBe(true);
    expect(c.children).toEqual(['homepage_hero_days', 'social_post_organic']);
    expect(addl.composeChildren('CUSTOM', {}).children).toEqual([]); // no bundle => nothing invented
  });
  test('CUSTOM: prepaid + pre-payment disclosure + snapshot required', () => {
    expect(addl.verifyPrepaidSnapshot({ promotion_key: 'CUSTOM', amount_paid_cents: 9900, status: 'paid' }).reason).toBe('custom_bundle_not_snapshotted');
    expect(addl.verifyPrepaidSnapshot({ promotion_key: 'CUSTOM', amount_paid_cents: 9900, status: 'paid', bundle_children: [{ feature_key: 'x' }] }).reason).toBe('custom_bundle_not_disclosed_pre_payment');
    expect(addl.verifyPrepaidSnapshot({ promotion_key: 'CUSTOM', amount_paid_cents: 9900, status: 'paid', bundle_children: [{ feature_key: 'x' }], bundle_shown_at: '2026-09-01' }).ok).toBe(true);
    expect(addl.verifyPrepaidSnapshot({ promotion_key: 'BOOST', amount_paid_cents: 0, status: 'paid' }).reason).toBe('no_prepayment');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Owned placement executor', () => {
  const owned = require('../src/services/ownedPlacementExecutor');
  const obEngine = require('../src/services/marketingObligationEngine');
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('hero (capacity 1): overlapping second reservation is auto-shifted (collision resolved, never refused)', async () => {
    const ob1 = { id: 'o1', feature_key: 'homepage_hero_days', parameters: {} };
    const ob2 = { id: 'o2', feature_key: 'homepage_hero_days', parameters: {} };
    const r1 = await owned.reserve(ob1, { auctionId: 'A1', startAt: '2026-10-01T00:00:00Z' }, runner);
    const r2 = await owned.reserve(ob2, { auctionId: 'A2', startAt: '2026-10-01T00:00:00Z' }, runner);
    expect(r1.shifted_days).toBe(0);
    expect(r2.shifted_days).toBeGreaterThanOrEqual(2); // shifted past the 2-day hero hold — not denied
  });
  test('a RESERVATION ALONE never completes; qualifying evidence is required', async () => {
    const ob = { id: 'o1', feature_key: 'homepage_module_run', parameters: {} };
    const res = await owned.reserve(ob, { auctionId: 'A1', startAt: '2026-10-01T00:00:00Z' }, runner);
    await owned.activate(res.id, '2026-10-01T00:00:00Z', runner);
    let gate = await owned.evidenceComplete(ob, runner);
    expect(gate.ok).toBe(false); // reserved + activated, but no served duration/impressions yet
    // Serve the full 4 days + impressions.
    await owned.recordExposure(res.id, { impressions: 1200, clicks: 30, atIso: '2026-10-05T00:00:00Z' }, runner);
    gate = await owned.evidenceComplete(ob, runner);
    expect(gate.ok).toBe(true);
    expect(gate.evidence.impressions).toBe(1200);
  });
  test('reconcile completes only evidenced placements', async () => {
    const spy = jest.spyOn(obEngine, 'transition').mockResolvedValue({});
    const ob = { id: 'o1', feature_key: 'featured_badge_priority', parameters: {} };
    const res = await owned.reserve(ob, { auctionId: 'A1', startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-06T00:00:00Z' }, runner);
    await owned.activate(res.id, '2026-10-01T00:00:00Z', runner);
    await owned.recordExposure(res.id, { impressions: 500, clicks: 5, atIso: '2026-10-02T00:00:00Z' }, runner);
    const out = await owned.reconcile([ob], runner);
    expect(out[0].completed).toBe(true);
    expect(spy).toHaveBeenCalledWith('o1', 'COMPLETED', expect.anything(), null, runner);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Premium shared-edition executor', () => {
  const shared = require('../src/services/sharedEmailExecutor');
  let store, runner;
  const eligible = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@x.com`, permission_basis: 'platform_relationship', permission_scope: { all: true } }));
  const cand = (id, close, buy) => ({ auction_id: id, obligation_id: 'ob_' + id, closing_at: close, purchased_at: buy });
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('4-auction edition: target met, equal cards, shadow, completes nothing', async () => {
    const out = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z',
      candidates: [cand('a', '2026-10-01'), cand('b', '2026-10-02'), cand('c', '2026-10-03'), cand('d', '2026-10-04')],
      audienceContacts: eligible(50, 'nj') }, runner);
    expect(out.created).toBe(true); expect(out.card_count).toBe(4);
    expect(out.cards.every((c) => c.equal_size)).toBe(true);
    expect(out.shadow).toBe(true); expect(out.completes_real_obligation).toBe(false);
    expect(out.audience.eligible).toBe(50);
  });
  test('1-auction edition still uses shared format (never a dedicated claim)', async () => {
    const out = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z', candidates: [cand('solo', '2026-10-01')], audienceContacts: eligible(10, 'x') }, runner);
    expect(out.card_count).toBe(1); expect(out.format).toBe('shared');
  });
  test('6 fit; 7+ overflow to the next edition', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => cand('a' + i, `2026-10-0${(i % 7) + 1}`, `2026-09-0${i + 1}`));
    const out = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z', candidates: seven, audienceContacts: eligible(5, 'x') }, runner);
    expect(out.card_count).toBe(6); expect(out.overflow.length).toBe(1);
  });
  test('max 2 editions per market/week; third is refused as a NEW edition (cap, not package refusal)', async () => {
    for (let i = 0; i < 2; i++) await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z', candidates: [cand('e' + i, '2026-10-01')], audienceContacts: [] }, runner);
    const third = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z', candidates: [cand('e9', '2026-10-01')], audienceContacts: [] }, runner);
    expect(third.created).toBe(false); expect(third.reason).toBe('market_week_edition_cap');
    expect(third.overflow.length).toBe(1); // deferred, not dropped
  });
  test('suppressed/ineligible contacts excluded from the resolved audience (floor is AFTER exclusions)', async () => {
    store.suppressions.push({ normalized_email: 'bad@x.com', reason: 'complaint' });
    const contacts = [{ email: 'bad@x.com', permission_basis: 'platform_relationship' }, ...eligible(3, 'ok')];
    const out = await shared.assembleEdition({ market: 'NJ', referenceDate: '2026-09-20T00:00:00Z', candidates: [cand('a', '2026-10-01')], audienceContacts: contacts }, runner);
    expect(out.audience.eligible).toBe(3); expect(out.audience.excluded).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Signature dedicated-send executor', () => {
  const dedicated = require('../src/services/dedicatedEmailExecutor');
  const obEngine = require('../src/services/marketingObligationEngine');
  let store, runner;
  const pool = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@x.com`, permission_basis: 'explicit_opt_in', permission_scope: { all: true } }));
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); jest.spyOn(obEngine, 'block').mockResolvedValue({}); });
  afterEach(() => jest.restoreAllMocks());

  test('LOCAL qualifies (>=300) → stops at LOCAL', async () => {
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: pool(320, 'l'), REGIONAL: pool(900, 'r') } }, runner);
    expect(out.ok).toBe(true); expect(out.chosen_scope).toBe('LOCAL'); expect(out.recipient_count).toBe(320);
    expect(out.evaluated.length).toBe(1); // never widened past the qualifying scope
  });
  test('LOCAL fails, REGIONAL qualifies', async () => {
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: pool(120, 'l'), REGIONAL: pool(450, 'r') } }, runner);
    expect(out.chosen_scope).toBe('REGIONAL'); expect(out.evaluated.length).toBe(2);
  });
  test('CATEGORY_SHIPPABLE qualifies when LOCAL+REGIONAL short', async () => {
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: pool(50, 'l'), REGIONAL: pool(100, 'r'), CATEGORY_SHIPPABLE: pool(500, 'c') } }, runner);
    expect(out.chosen_scope).toBe('CATEGORY_SHIPPABLE');
  });
  test('NATIONWIDE qualifies as last resort', async () => {
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: pool(10, 'l'), REGIONAL: pool(20, 'r'), CATEGORY_SHIPPABLE: pool(30, 'c'), NATIONWIDE: pool(400, 'n') } }, runner);
    expect(out.chosen_scope).toBe('NATIONWIDE');
  });
  test('no scope reaches 300 → resilience, no send, obligation blocked (never manufactured)', async () => {
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: pool(50, 'l'), REGIONAL: pool(80, 'r'), CATEGORY_SHIPPABLE: pool(120, 'c'), NATIONWIDE: pool(200, 'n') } }, runner);
    expect(out.ok).toBe(false); expect(out.reason).toBe('no_scope_qualifies');
    expect(out.ladder).toBeTruthy();
    expect(obEngine.block).toHaveBeenCalled();
    expect(out.send.status).toBe('no_scope');
  });
  test('floor applied AFTER exclusions: 320 candidates but 30 suppressed → 290 < 300 fails LOCAL', async () => {
    const p = pool(320, 'l'); for (let i = 0; i < 30; i++) store.suppressions.push({ normalized_email: `l${i}@x.com`, reason: 'hard_bounce' });
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T00:00:00Z',
      audiencePools: { LOCAL: p } }, runner);
    expect(out.chosen_scope === 'LOCAL').toBe(false); // 290 after exclusions < floor
  });
  test('global daily cap blocks a 4th same-day send', async () => {
    for (let i = 0; i < 3; i++) store.dedicated.push({ status: 'sent_shadow', sent_at: '2026-10-01T09:00:00Z' });
    const out = await dedicated.execute({ id: 'o1' }, { auctionId: 'A1', market: 'NJ', referenceDate: '2026-10-01T12:00:00Z',
      audiencePools: { LOCAL: pool(400, 'l') } }, runner);
    expect(out.ok).toBe(false); expect(out.guards.perDayOk).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SES bounce/complaint ingestion + eligibility exclusion', () => {
  const ses = require('../src/services/sesFeedbackService');
  const eligibility = require('../src/services/audienceEligibilityService');
  beforeEach(() => { sesStore.events = []; sesStore.suppressions = []; sesStore.deliverability = {}; });

  test('hard bounce → terminal suppression', async () => {
    const res = await ses.ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'hb@x.com', providerEventId: 'e1' });
    expect(res.action).toBe('suppressed_hard_bounce');
    expect(sesStore.suppressions.find((x) => x.normalized_email === 'hb@x.com')).toBeTruthy();
  });
  test('complaint → suppression', async () => {
    const res = await ses.ingestEvent({ eventType: 'Complaint', email: 'cx@x.com', providerEventId: 'e2' });
    expect(res.action).toBe('suppressed_complaint');
  });
  test('duplicate provider event is idempotent', async () => {
    await ses.ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'd@x.com', providerEventId: 'dup1' });
    const again = await ses.ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Permanent', email: 'd@x.com', providerEventId: 'dup1' });
    expect(again.idempotent).toBe(true);
  });
  test('soft/transient bounce accumulates (not immediately suppressed)', async () => {
    const res = await ses.ingestEvent({ eventType: 'Bounce', bounceSubtype: 'Transient', email: 's@x.com', providerEventId: 'e3' });
    expect(['soft_bounce_recorded', 'suppressed_soft_threshold']).toContain(res.action);
  });
  test('suppression AFFECTS future eligibility', async () => {
    await ses.ingestEvent({ eventType: 'Complaint', email: 'future@x.com', providerEventId: 'e4' });
    const runner = makeRunner({ ...makeStore(), suppressions: sesStore.suppressions });
    const v = await eligibility.evaluateContact({ contact: { email: 'future@x.com', permission_basis: 'platform_relationship' }, marketingClass: 'dedicated_auction' }, runner);
    expect(v.eligible).toBe(false); expect(v.reason).toBe('SUPPRESSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Provider-neutral social adapter', () => {
  const social = require('../src/services/socialAdapter');
  let store, runner;
  const auction = { auction_id: 'A1', title: 'Estate', lot_count: 40, closing_at: '2026-10-01' };
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('Premium = 1 organic post (shadow proof, no real completion)', async () => {
    const out = await social.execute({ id: 'o1' }, { auction, identity: 'PREMIUM', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(out.results.length).toBe(1);
    expect(out.results[0].proof.post_id).toMatch(/^mock_/);
    expect(out.completes_real_obligation).toBe(false);
  });
  test('Signature = 3 posts LAUNCH/MID/FINAL with permalinks', async () => {
    const out = await social.execute({ id: 'o2' }, { auction, identity: 'SIGNATURE', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(out.waves).toEqual(['LAUNCH', 'MID', 'FINAL']);
    expect(out.results.every((r) => r.proof && r.proof.permalink)).toBe(true);
  });
  test('idempotent: re-publishing a wave returns the stored proof (no duplicate)', async () => {
    await social.publishWave({ id: 'o3' }, { auction, wave: 'ANY', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    const again = await social.publishWave({ id: 'o3' }, { auction, wave: 'ANY', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(again.idempotent_replay).toBe(true);
    expect(store.social.filter((j) => j.status === 'published_shadow').length).toBe(1);
  });
  test('provider inactive → blocked via resilience, never falsely completed', async () => {
    jest.spyOn(social, 'resolveProvider').mockResolvedValue({ name: 'mock', active: false, shadow: true, publish: async () => ({ ok: false }) });
    const obEngine = require('../src/services/marketingObligationEngine');
    jest.spyOn(obEngine, 'block').mockResolvedValue({});
    const out = await social.publishWave({ id: 'o4' }, { auction, wave: 'ANY', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(out.ok).toBe(false); expect(out.reason).toBe('provider_inactive'); expect(out.ladder).toBeTruthy();
    jest.restoreAllMocks();
  });
  test('failed publish routes to resilience (retry path)', async () => {
    jest.spyOn(social, 'resolveProvider').mockResolvedValue({ name: 'flaky', active: true, shadow: true, publish: async () => ({ ok: false, error: 'network' }) });
    const out = await social.publishWave({ id: 'o5' }, { auction, wave: 'ANY', referenceAt: '2026-09-20T00:00:00Z' }, runner);
    expect(out.ok).toBe(false); expect(out.reason).toBe('publish_failed'); expect(out.ladder).toBeTruthy();
    jest.restoreAllMocks();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Additional Promotion executor', () => {
  const addl = require('../src/services/additionalPromotionExecutor');
  const obEngine = require('../src/services/marketingObligationEngine');
  const channelDispatch = require('../src/services/channelDispatch');
  let store, runner, dispatched;
  beforeEach(() => {
    store = makeStore(); runner = makeRunner(store); dispatched = [];
    let seq = 0;
    jest.spyOn(obEngine, 'listForPurchase').mockImplementation(async () => store._obs || []);
    jest.spyOn(obEngine, 'createFromSnapshot').mockImplementation(async ({ guaranteed }) => {
      store._obs = guaranteed.map((g) => ({ id: 'ob' + (++seq), feature_key: g.key })); return store._obs;
    });
    jest.spyOn(channelDispatch, 'dispatch').mockImplementation(async (ob) => { dispatched.push(ob.feature_key); return { channel: 'X', result: { ok: true } }; });
  });
  afterEach(() => jest.restoreAllMocks());

  test.each(['BOOST', 'REACH', 'SPOTLIGHT'])('%s executes every child through ordinary executors; reconciliation covers all', async (identity) => {
    store._obs = null;
    const out = await addl.execute({ id: 'p1', promotion_key: identity, amount_paid_cents: 9900, status: 'paid' }, { auctionId: 'A1' }, runner);
    expect(out.ok).toBe(true);
    expect(out.executed.length).toBe(out.children.length);
    expect(out.reconciliation.covered).toBe(true);
    expect(dispatched.length).toBe(out.children.length); // no manual bucket — all dispatched
  });
  test('CUSTOM: pre-payment bundle → snapshot → children → reconciliation', async () => {
    store._obs = null;
    const promo = { id: 'p2', promotion_key: 'CUSTOM', amount_paid_cents: 24900, status: 'paid',
      bundle_children: [{ feature_key: 'homepage_hero_days' }, { feature_key: 'social_post_organic' }], bundle_shown_at: '2026-09-01' };
    const out = await addl.execute(promo, { auctionId: 'A1' }, runner);
    expect(out.ok).toBe(true); expect(out.from_bundle).toBe(true);
    expect(out.children).toEqual(['homepage_hero_days', 'social_post_organic']);
    expect(out.reconciliation.covered).toBe(true);
  });
  test('unpaid promotion does not fulfil', async () => {
    const out = await addl.execute({ id: 'p3', promotion_key: 'BOOST', amount_paid_cents: 0, status: 'paid' }, {}, runner);
    expect(out.ok).toBe(false); expect(out.reason).toBe('no_prepayment');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Performance aggregation', () => {
  const perf = require('../src/services/performanceAggregationService');
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('classifies DELIVERED / MEASURED / INFLUENCED / UNAVAILABLE; shadow excluded from seller metrics', async () => {
    // Real placement evidence (MEASURED).
    store.placementEvidence.push({ obligation_id: 'ob1', shadow: false, impressions: 900, clicks: 12, first_seen_at: '2026-10-01' });
    // Real dedicated send (DELIVERED) with unknown opens (UNAVAILABLE).
    store.dedicated.push({ obligation_id: 'ob2', shadow: false, recipient_count: 410, opens: null, clicks: 7, status: 'sent_shadow' });
    // SHADOW social — must NOT surface to the seller as delivered.
    store.social.push({ obligation_id: 'ob3', status: 'published_shadow', shadow: true });
    const obligations = [{ id: 'ob1', feature_key: 'homepage_module_run' }, { id: 'ob2', feature_key: 'dedicated_send' }, { id: 'ob3', feature_key: 'social_post_organic' }];
    const out = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'p1', obligations,
      auctionFacts: { bids: 47, watchers: 120 } }, runner);
    expect(out.metrics.homepage_module_run.classification).toBe('MEASURED');
    expect(out.metrics.dedicated_send.classification).toBe('DELIVERED');
    expect(out.metrics.social_post_organic).toBeUndefined();           // shadow excluded
    expect(out.internal_certification.shadow_only.some((x) => x.source === 'social_shadow')).toBe(true);
    expect(out.influenced.bids.classification).toBe('INFLUENCED');      // correlational, never causal
    // opens recorded as ATTRIBUTION_UNAVAILABLE
    expect(store.perfFacts.some((f) => /opens/.test(f.metric) && f.classification === 'ATTRIBUTION_UNAVAILABLE')).toBe(true);
  });
  test('no confidential internals leak into the metric map', async () => {
    store.placementEvidence.push({ obligation_id: 'ob1', shadow: false, impressions: 10, clicks: 1, first_seen_at: '2026-10-01' });
    const out = await perf.aggregate({ purchaseKind: 'package', purchaseId: 'p1', obligations: [{ id: 'ob1', feature_key: 'homepage_module_run' }] }, runner);
    const blob = JSON.stringify(out.metrics) + JSON.stringify(out.influenced);
    expect(blob).not.toMatch(/authority|60|policy|growth|profit|cost|bps|substitut|director/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Director input resolver + bounded decisions', () => {
  const resolver = require('../src/services/directorInputResolver');
  const directorDecision = require('../src/services/directorDecisionService');
  let store, runner;
  beforeEach(() => { store = makeStore(); runner = makeRunner(store); });

  test('persistDecision records an ALLOWED bounded decision', async () => {
    const spy = jest.spyOn(directorDecision, 'record').mockResolvedValue({ id: 'd1', kind: 'SCHEDULE' });
    const out = await resolver.persistDecision({ kind: 'SCHEDULE', purchaseId: null, inputs: { a: 1 }, outputs: {} }, runner);
    expect(out.ok).toBe(true); expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  test('persistDecision REJECTS a prohibited kind (no refund/reprice/refuse)', async () => {
    for (const bad of ['REFUND', 'REPRICE', 'REFUSE_CAPACITY', 'MANUFACTURE_AUDIENCE']) {
      const out = await resolver.persistDecision({ kind: bad, inputs: {} }, runner);
      expect(out.ok).toBe(false); expect(out.rejected).toBe(true);
    }
  });
  test('resolveInputs degrades gracefully with no data (empty environment)', async () => {
    const out = await resolver.resolveInputs('missing', runner);
    expect(out.purchase).toBeNull();
    expect(out.audience_pools).toEqual({ registered_non_bidder: 0, watcher_no_bid: 0, local_event_interest: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Confidential seller-output exclusion (renderer)', () => {
  const renderer = require('../src/services/sellerReportRenderer');
  test('seller payload structurally omits internal economics/authority/policy', () => {
    const out = renderer.render(
      { package_key: 'premium', amount_paid_cents: 24900, guaranteed_deliverables: [{ label: 'Homepage module' }] },
      [{ feature_key: 'homepage_module_run', label: 'Homepage module', state: 'completed', category: 'guaranteed' }],
      { homepage_module_run: { classification: 'MEASURED', value: 900 } });
    const blob = JSON.stringify(out);
    expect(blob).not.toMatch(/authority|growth|60\/40|policy_version|direct_fulfillment|bps|profit/i);
    expect(out.performance[0].classification).toBe('MEASURED');
  });
});
