'use strict';

/**
 * Phase 3P.2 — first-party measurement + Paid Growth Director (shadow) + Owner report + assisted service.
 * Pure / mocked-DB tests: shared conversion definitions; channel classification + touch capture (raw click ids never
 * stored on a touch); the conversion ledger (idempotent, never throws, every provider gate OFF → gated_off); asset
 * identity (never a Lewis & Maese asset, never an invented id); Meta CAPI / Google decisions; cost ingestion +
 * reconciliation; Director signal states and anti-overreaction rules (no LOSER before 100 sessions / $150; WINNER needs
 * two checkpoints); proposals at $0 while measurement is not ready; caps; activation refusals; the Owner report never
 * carries package economics (negative test on its data sources and its output); assisted pricing never stated;
 * the 18-item readiness audit shape; emitters wired; no provider network call anywhere but the gated CAPI sender.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-3p2m';
const fs = require('fs');
const path = require('path');

const defs = require('../src/lib/conversionDefinitions');
const attribution = require('../src/services/attributionService');
const guard = require('../src/services/measurement/assetIdentityGuard');
const meta = require('../src/services/measurement/metaCapiService');
const google = require('../src/services/measurement/googleConversionsService');
const cost = require('../src/services/measurement/paidCostIngestionService');
const recon = require('../src/services/measurement/providerReconciliationService');
const director = require('../src/services/paidGrowth/paidGrowthDirector');
const report = require('../src/services/paidGrowth/paidGrowthReport');
const assisted = require('../src/services/assistedServiceService');
const readinessSvc = require('../src/services/measurement/measurementReadinessService');

const ROOT = path.join(__dirname, '..');
const AUDIT = require('../docs/marketing/phase3p2/config/measurement-readiness-audit.json');

/** Minimal fake db: routes SQL by regex to canned rows; records every call. */
function fakeDb(routes = []) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql: String(sql), params }); for (const [re, rows] of routes) if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : { rows, rowCount: rows.length }; return { rows: [], rowCount: 0 }; } };
}

describe('shared conversion definitions', () => {
  test('every catalogue event is defined once with its Meta / Google mapping; the four core conversions carry both', () => {
    for (const k of ['seller_landing_view', 'seller_signup_started', 'seller_registered', 'auction_draft_created', 'auction_published', 'seller_inquiry', 'assisted_service_inquiry',
      'buyer_landing_view', 'buyer_registered', 'auction_view', 'lot_view', 'watch_lot', 'bid', 'purchase', 'email_signup', 'search']) expect(defs.get(k)).toBeTruthy();
    for (const k of ['buyer_registered', 'seller_inquiry', 'auction_published', 'purchase']) { expect(defs.get(k).meta_event).toBeTruthy(); expect(defs.get(k).google_action).toBeTruthy(); }
    expect(defs.SUCCESS_SIGNALS).toEqual(expect.arrayContaining(['seller_registered', 'buyer_registered', 'purchase', 'assisted_service_inquiry']));
    expect(defs.SUCCESS_SIGNALS).not.toContain('lot_view');   // an intent view is never a paid success signal
  });
});

describe('first-party attribution', () => {
  test('channel classification is deterministic: click ids, paid UTM, email, social, search, referral, direct', () => {
    expect(attribution.classifyChannel({ clickType: 'gclid' })).toBe('paid_search');
    expect(attribution.classifyChannel({ clickType: 'fbclid', utm: { utm_medium: 'paid_social' } })).toBe('paid_social');
    expect(attribution.classifyChannel({ clickType: 'fbclid' })).toBe('organic_social');
    expect(attribution.classifyChannel({ utm: { utm_medium: 'cpc', utm_source: 'facebook' } })).toBe('paid_social');
    expect(attribution.classifyChannel({ utm: { utm_medium: 'email' } })).toBe('email');
    expect(attribution.classifyChannel({ referrerHost: 'www.google.com' })).toBe('organic_search');
    expect(attribution.classifyChannel({ referrerHost: 'www.advantage.bid' })).toBe('direct');
    expect(attribution.classifyChannel({ referrerHost: 'news.example.com' })).toBe('referral');
    expect(attribution.campaignKey({ utm: { utm_source: 'Facebook', utm_campaign: 'Houston_Sellers' } })).toBe('facebook:houston_sellers');
  });
  test('recordTouch: internal navigation is not a touch; a campaign landing stores UTM + click TYPE + hash, never the raw click id', async () => {
    const db0 = fakeDb();
    expect(await attribution.recordTouch({ visitorId: 'v1', landingUrl: 'https://bid.advantage.bid/search.html' }, db0)).toBeNull();
    expect(db0.calls.length).toBe(0);
    const db1 = fakeDb([[/INSERT INTO marketing_attribution_touches/, [{ id: 't1' }]]]);
    const out = await attribution.recordTouch({ visitorId: 'v1', landingUrl: 'https://bid.advantage.bid/become-seller.html?utm_source=facebook&utm_medium=paid_social&utm_campaign=hou&fbclid=RAWCLICK123' }, db1);
    expect(out.channel).toBe('paid_social'); expect(out.campaign_key).toBe('facebook:hou'); expect(out.click_type).toBe('fbclid');
    const ins = db1.calls.find((c) => /marketing_attribution_touches/.test(c.sql));
    expect(JSON.stringify(ins.params)).not.toContain('RAWCLICK123');
    expect(ins.params).toContain(require('crypto').createHash('sha256').update('RAWCLICK123').digest('hex'));
    expect(db1.calls.some((c) => /marketing_attribution_profiles/.test(c.sql))).toBe(true);
  });
  test('snapshot classes: no profile → ATTRIBUTION_UNAVAILABLE; a paid touch inside 90 days → MEASURED', async () => {
    expect((await attribution.snapshot({ visitorId: 'none' }, fakeDb())).class).toBe('ATTRIBUTION_UNAVAILABLE');
    const recent = new Date().toISOString();
    const db = fakeDb([[/FROM marketing_attribution_profiles WHERE visitor_id/, [{ visitor_id: 'v', first_touch_id: 't', last_touch_id: 't', last_paid_touch_id: 't' }]],
      [/FROM marketing_attribution_touches WHERE id/, [{ id: 't', touched_at: recent, channel: 'paid_social', campaign_key: 'facebook:hou' }]]]);
    expect((await attribution.snapshot({ visitorId: 'v' }, db)).class).toBe('MEASURED');
  });
});

describe('conversion ledger', () => {
  const conv = require('../src/services/conversionService');
  const cfgSvc = require('../src/services/configService'); let origGet;
  beforeAll(() => { origGet = cfgSvc.get; cfgSvc.get = async () => null; });   // every provider gate reads as unset/OFF — no real database
  afterAll(() => { cfgSvc.get = origGet; });
  test('records with an idempotency key, the attribution snapshot and a gated_off provider decision; never throws', async () => {
    const db = fakeDb([[/INSERT INTO marketing_conversion_events/, [{ id: 'c1', occurred_at: new Date().toISOString() }]]]);
    const out = await conv.record('buyer_registered', { userId: '00000000-0000-0000-0000-000000000001', subjectType: 'user', subjectId: 'u1' }, db);
    expect(out.id).toBe('c1'); expect(out.dispatch.meta_capi).toBe('gated_off'); expect(out.dispatch.google_ads).toBe('gated_off');
    const ins = db.calls.find((c) => /INSERT INTO marketing_conversion_events/.test(c.sql));
    expect(JSON.parse(ins.params[10]).meta_capi.status).toBe('gated_off');
    expect(ins.params[11]).toMatch(/^[a-f0-9]{64}$/);
    const broken = { query: async () => { throw new Error('db down'); } };
    await expect(conv.record('bid', { userId: 'u' }, broken)).resolves.toBeNull();
    expect(await conv.record('not_a_key', {}, db)).toBeNull();
  });
});

describe('asset identity + provider decisions (all gates OFF this phase)', () => {
  const identity = { id: '123456789012345', name: 'Advantage.Bid Pixel', owner_business: 'Advantage.Bid', verified_at: '2026-09-10T00:00:00Z' };
  test('never an invented id; never a Lewis & Maese asset; identity must name Advantage.Bid and match the configured id', () => {
    expect(guard.check('meta_dataset', null, identity).reason).toBe('NOT_CONFIGURED');
    expect(guard.check('meta_dataset', 'XXXX', identity).reason).toBe('NOT_CONFIGURED');
    expect(guard.check('meta_dataset', '123456789012345', null).reason).toBe('IDENTITY_UNVERIFIED');
    expect(guard.check('meta_dataset', '999', identity).reason).toBe('IDENTITY_MISMATCH');
    expect(guard.check('meta_dataset', '555', { id: '555', name: 'Lewis & Maese Pixel', owner_business: 'Lewis & Maese Antiques', verified_at: 'x' }).reason).toBe('DENIED_CLIENT_ASSET');
    expect(guard.check('meta_dataset', '556', { id: '556', name: 'Some Pixel', owner_business: 'Other Co', verified_at: 'x' }).reason).toBe('NOT_ADVANTAGE_BID');
    expect(guard.check('meta_dataset', '123456789012345', identity).ok).toBe(true);
  });
  test('Meta CAPI: gate → identity → credential presence → consent, in that order; event_id = the first-party conversion id; identifiers hashed', () => {
    expect(meta.decide({ cfg: { enabled: false } }).status).toBe('gated_off');
    expect(meta.decide({ cfg: { enabled: true, datasetId: null } }).status).toBe('not_configured');
    expect(meta.decide({ cfg: { enabled: true, datasetId: '123456789012345', identity }, tokenPresent: false }).status).toBe('token_absent');
    expect(meta.decide({ cfg: { enabled: true, datasetId: '123456789012345', identity }, tokenPresent: true, advertisingConsent: false }).status).toBe('no_consent');
    expect(meta.decide({ cfg: { enabled: true, datasetId: '123456789012345', identity }, tokenPresent: true, advertisingConsent: true }).status).toBe('ready');
    const ev = meta.buildEvent({ id: 'conv-1', conversion_key: 'purchase', user_id: 'u1', value_cents: 12345, occurred_at: '2026-09-10T12:00:00Z' }, { email: 'Buyer@Example.com', fbclid: 'abc', fbclidCapturedAt: '2026-09-09T00:00:00Z' });
    expect(ev.event_name).toBe('Purchase'); expect(ev.event_id).toBe('conv-1'); expect(ev.custom_data.value).toBe(123.45);
    expect(ev.user_data.em[0]).toBe(meta.sha('buyer@example.com')); expect(ev.user_data.fbc).toMatch(/^fb\.1\.\d+\.abc$/);
    expect(JSON.stringify(ev)).not.toMatch(/Buyer@Example/i);
  });
  test('Google: gate → identity → action mapping → click id → consent; order_id dedup', () => {
    expect(google.decide({ cfg: { enabled: false } }).status).toBe('gated_off');
    const gid = { id: '1234567890', name: 'Advantage.Bid Ads', owner_business: 'Advantage.Bid', verified_at: 'x' };
    expect(google.decide({ cfg: { enabled: true, customerId: '1234567890', identity: gid, actions: {} }, conversionKey: 'purchase' }).status).toBe('no_action_mapping');
    expect(google.decide({ cfg: { enabled: true, customerId: '1234567890', identity: gid, actions: { purchase: 'customers/1/conversionActions/2' } }, conversionKey: 'purchase', click: null }).status).toBe('no_click_id');
    const up = google.buildUpload({ id: 'conv-2', conversion_key: 'purchase', value_cents: 5000, occurred_at: '2026-09-10T12:00:00Z' }, { click_type: 'gclid', click_value: 'G1' }, { purchase: 'customers/1/conversionActions/2' });
    expect(up.order_id).toBe('conv-2'); expect(up.gclid).toBe('G1'); expect(up.conversion_date_time).toBe('2026-09-10 12:00:00+00:00');
  });
  test('Meta send() refuses while the Owner gate is OFF (no network call)', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('network must not be called'); });
    const cfgSvc = require('../src/services/configService');
    const orig = cfgSvc.get; cfgSvc.get = async () => null;
    try { const out = await meta.send([{ event_name: 'Purchase' }], { advertisingConsent: true }); expect(out.sent).toBe(false); expect(out.decision.status).toBe('gated_off'); expect(spy).not.toHaveBeenCalled(); }
    finally { cfgSvc.get = orig; spy.mockRestore(); }
  });
});

describe('cost ingestion + reconciliation', () => {
  test('normalise: spend in currency units or cents; campaign_key joins cost to the landing UTM', () => {
    const n = cost.normalise('meta_ads', { campaign_id: '1', campaign_name: 'Hou', utm_campaign: 'hou_sellers', date: '2026-09-10', spend: 12.5, impressions: 900, clicks: 14 });
    expect(n.spend_cents).toBe(1250); expect(n.campaign_key).toBe('facebook:hou_sellers');
    expect(cost.normalise('google_ads', { campaign_id: '9', date: '2026-09-10', spend_cents: 700 }).campaign_key).toBe('google:9');
    expect(cost.normalise('meta_ads', { campaign_id: '1', date: 'bad' })).toBeNull();
    expect(() => cost.normalise('tiktok', { campaign_id: '1', date: '2026-09-10' })).toThrow();
  });
  test('provider pulls are refused while the channel gate is OFF', async () => {
    const cfgSvc = require('../src/services/configService'); const orig = cfgSvc.get; cfgSvc.get = async () => false;
    try { expect((await cost.pull('meta_ads')).reason).toBe('GATED_OFF'); } finally { cfgSvc.get = orig; }
  });
  test('reconciliation records both numbers and a status per key — never an average', () => {
    const d = recon.compare({ purchase: 5, buyer_registered: 3 }, { purchase: 4, bid: 2 });
    expect(d.purchase).toMatchObject({ provider: 5, first_party: 4, status: 'PROVIDER_OVER' });
    expect(d.bid.status).toBe('FIRST_PARTY_ONLY'); expect(d.buyer_registered.status).toBe('PROVIDER_ONLY');
  });
});

describe('Paid Growth Director — signal states + anti-overreaction', () => {
  const base = { baseline: { sessions: 2000, conversions: 60 }, target_cpa_cents: 6000 };
  test('NO_DATA under $10 / 500 impressions; INSUFFICIENT under 30 clicks with < 3 outcomes', () => {
    expect(director.classify({ ...base, spend_cents: 900, impressions: 5000 }).state).toBe('NO_DATA');
    expect(director.classify({ ...base, spend_cents: 2000, impressions: 3000, clicks: 12, sessions: 10, conversions: 0 }).state).toBe('INSUFFICIENT_DATA');
  });
  test('no LOSER before 100 sessions or $150 — even with a terrible cost per outcome; LOSER once the floor is reached', () => {
    const early = director.classify({ ...base, spend_cents: 14900, impressions: 20000, clicks: 120, sessions: 99, conversions: 0 });
    expect(early.state).not.toBe('LOSER');
    expect(director.classify({ ...base, spend_cents: 15000, impressions: 20000, clicks: 120, sessions: 99, conversions: 0 }).state).toBe('LOSER');
    expect(director.classify({ ...base, spend_cents: 9000, impressions: 20000, clicks: 150, sessions: 100, conversions: 0 }).state).toBe('LOSER');
  });
  test('a safety/policy flag may end a campaign before the floor', () => {
    expect(director.classify({ ...base, spend_cents: 2000, impressions: 3000, clicks: 5, sessions: 5, conversions: 0, safety_flags: ['policy_rejection'] }).state).toBe('LOSER');
  });
  test('WINNER needs a meaningful signal at two consecutive checkpoints with CPA at or below target', () => {
    const strong = { ...base, spend_cents: 30000, impressions: 40000, clicks: 400, sessions: 300, conversions: 30 };   // 10% vs 3% baseline; CPA $10
    const first = director.classify({ ...strong, prior_meaningful_consecutive: 0 });
    expect(first.state).toBe('MEANINGFUL_SIGNAL');
    expect(first.reasons.join(' ')).toMatch(/second consecutive checkpoint/);
    expect(director.classify({ ...strong, prior_meaningful_consecutive: 1 }).state).toBe('WINNER');
    expect(director.classify({ ...strong, target_cpa_cents: 500, prior_meaningful_consecutive: 1 }).state).not.toBe('WINNER');
  });
  test('bounded actions per transition; checkpoints are thresholds, not a calendar', () => {
    expect(director.actionFor('MEANINGFUL_SIGNAL', 'LOSER', {}).action).toBe('PAUSE_LOSER');
    expect(director.actionFor('MEANINGFUL_SIGNAL', 'WINNER', {}).action).toBe('SCALE_WINNER');
    expect(director.actionFor('EARLY_SIGNAL', 'MEANINGFUL_SIGNAL', { direction: 'negative' }).action).toBe('TEST_ALTERNATIVE');
    expect(director.checkpointsCrossed({ spend_cents: 2000 }, { spend_cents: 2600 })).toEqual(['delivery_sanity ($25 or 2,000 impressions)']);
    expect(director.checkpointsCrossed({ sessions: 99 }, { sessions: 100 })).toContain('state_decision (100 sessions or $150)');
    expect(director.checkpointsCrossed({ spend_cents: 100 }, { spend_cents: 200 })).toEqual([]);
  });
});

describe('Paid Growth Director — proposals, caps, activation', () => {
  const notReady = { measurement_ready: false, items: AUDIT.items.map((i) => ({ key: i.key, status: i.key === 'cost_ingestion' ? 'PARTIAL' : 'VERIFIED' })), rules: { minimum_for_any_paid_activation: { ready: false, not_verified: ['cost_ingestion:PARTIAL'] } } };
  const ready = { measurement_ready: true, items: AUDIT.items.map((i) => ({ key: i.key, status: 'VERIFIED' })), rules: { minimum_for_any_paid_activation: { ready: true, not_verified: [] } } };
  const assistedMk = [{ market: 'Houston Metro', available: true }, { market: 'NYC Tri-State / NYC Metro', available: true }];
  test('measurement not ready → every proposal $0 with the reason; the ten-field shape is complete', () => {
    const plan = director.propose({ readiness: notReady, ceilingUsd: 1000, assisted: assistedMk, month: '2026-09-01' });
    expect(plan.recommended_spend_cents).toBe(0); expect(plan.measurement_ready).toBe(false);
    expect(plan.proposals.length).toBeGreaterThan(0);
    for (const p of plan.proposals) {
      expect(p.budget_cents).toBe(0); expect(p.rationale).toMatch(/measurement not ready/);
      for (const k of director.PROPOSAL_FIELDS) expect(p[k]).not.toBeUndefined();
      expect(defs.SUCCESS_SIGNALS).toContain(p.success_signal);
    }
    expect(plan.proposals.some((p) => p.success_signal === 'assisted_service_inquiry')).toBe(true);
  });
  test('measurement ready → bounded tests within the ceiling and the per-window cap; buyer spend needs live inventory', () => {
    const plan = director.propose({ readiness: ready, ceilingUsd: 1000, assisted: assistedMk, month: '2026-09-01', evidence: { upcoming_events_by_market: { 'Houston Metro': 3 } } });
    expect(plan.recommended_spend_cents).toBeLessThanOrEqual(100000);
    for (const p of plan.proposals) expect(p.budget_cents).toBeLessThanOrEqual(40000);
    expect(plan.proposals.find((p) => p.market.startsWith('NYC') && p.objective === 'buyer_acquisition').budget_cents).toBe(0);
  });
  test('caps: a proposal over the window cap or with a platform-metric success signal is invalid; month total never exceeds the ceiling', () => {
    const p = { market: 'Houston Metro', audience: 'a', campaign: 'c', objective: 'seller_acquisition', channel: 'meta_ads', budget_cents: 50000, measurement_window_days: 14, success_signal: 'ctr', stop_condition: 's', scale_condition: 's', measurement_dependencies: ['first_party_attribution'] };
    const v = director.validateProposal(p, { ceilingCents: 100000 });
    expect(v.ok).toBe(false); expect(v.errors.join(' ')).toMatch(/first-party outcome/); expect(v.errors.join(' ')).toMatch(/per-window cap/);
    expect(director.enforceCaps([{ budget_cents: 80000 }, { budget_cents: 30000 }], 100000).ok).toBe(false);
    expect(director.validateProposal({ ...p, budget_cents: 100, success_signal: 'seller_registered', campaign: 'Full service for only 40%' }, { ceilingCents: 100000 }).errors.join(' ')).toMatch(/assisted-service pricing/);
  });
  test('activation is refused in shadow mode, with the channel OFF, without Owner approval, or with unverified measurement', () => {
    const p = { channel: 'meta_ads', state: 'PROPOSED', measurement_dependencies: ['first_party_attribution', 'cost_ingestion'] };
    const r1 = director.canActivate(p, { readiness: notReady, gates: {}, mode: 'shadow' });
    expect(r1.ok).toBe(false);
    expect(r1.reasons.join(' ')).toMatch(/shadow mode/); expect(r1.reasons.join(' ')).toMatch(/Owner approval/); expect(r1.reasons.join(' ')).toMatch(/meta_ads is OFF/); expect(r1.reasons.join(' ')).toMatch(/cost_ingestion PARTIAL/);
    expect(director.canActivate({ ...p, state: 'OWNER_APPROVED' }, { readiness: ready, gates: { 'marketing.destinations.meta_ads_enabled': true }, mode: 'live' }).ok).toBe(true);
  });
  test('statistics: two-proportion test and posterior probability behave', () => {
    expect(director.twoProportion(30, 300, 60, 2000).p).toBeLessThan(0.01);
    expect(director.twoProportion(3, 100, 60, 2000).p).toBeGreaterThan(0.5);
    expect(director.probBetter(30, 300, 60, 2000)).toBeGreaterThan(0.99);
  });
});

describe('Owner paid-growth report — package economics structurally excluded', () => {
  test('its data sources never include the Marketing Package ledger; the guarded query refuses package tables', async () => {
    for (const s of report.DATA_SOURCES) expect(report.FORBIDDEN_SOURCES.test(s)).toBe(false);
    const src = fs.readFileSync(path.join(ROOT, 'src/services/paidGrowth/paidGrowthReport.js'), 'utf8');
    const sqlBodies = src.match(/`SELECT[\s\S]*?`/g) || [];
    expect(sqlBodies.length).toBeGreaterThan(0);
    for (const q of sqlBodies) expect(report.FORBIDDEN_SOURCES.test(q)).toBe(false);
  });
  test('assertOwnerSafe rejects package economics and any public percentage figure', () => {
    expect(() => report.assertOwnerSafe({ a: 'Marketing Package 60/40 split' })).toThrow(/excluded/);
    expect(() => report.assertOwnerSafe({ media_margin: 12 })).toThrow(/excluded/);
    expect(() => report.assertOwnerSafe({ t: 'full service at 40%' })).toThrow(/excluded/);
    expect(report.assertOwnerSafe({ t: 'Monthly authority $1,000. Recommended $0.' })).toBe(true);
  });
  test('monthly summary: MONTHLY AUTHORITY / RECOMMENDED / ACTUAL / REMAINING header, allocation breakdowns, plain text, $0 when measurement is not ready', async () => {
    const db = fakeDb([
      [/monthly_ceiling_usd/, [{ value: 1000 }]],
      [/FROM marketing_paid_growth_proposals/, [{ market: 'Houston Metro', audience: 'sellers', campaign: 'Houston individual seller acquisition', objective: 'seller_acquisition', channel: 'meta_ads', budget_cents: 0, success_signal: 'seller_registered', measurement_ready: false, unmeasurable: ['cost_ingestion:PARTIAL'], rationale: 'measurement not ready — cost_ingestion:PARTIAL.', state: 'PROPOSED' }]],
    ]);
    const rep = await report.monthly({ month: '2026-09' }, db);
    expect(Object.keys(rep.header)).toEqual(['MONTHLY_AUTHORITY', 'RECOMMENDED_SPEND', 'ACTUAL_SPEND', 'REMAINING_AUTHORITY']);
    expect(rep.header.MONTHLY_AUTHORITY).toBe('$1,000'); expect(rep.header.RECOMMENDED_SPEND).toBe('$0'); expect(rep.header.REMAINING_AUTHORITY).toBe('$1,000');
    expect(Object.keys(rep.allocation_by)).toEqual(['objective', 'geography', 'audience', 'channel', 'campaign']);
    expect(rep.text).toMatch(/Measurement is not ready/); expect(rep.text).toMatch(/Paid advertising stays off/);
    for (const c of db.calls) expect(report.FORBIDDEN_SOURCES.test(c.sql)).toBe(false);
  });
});

describe('assisted service — availability yes, pricing never', () => {
  test('pricing claims are rejected; approved copy passes', () => {
    for (const bad of ['Full service for $500', 'Only 35 percent', 'We take 40%', 'From $99', 'commission of 30', '$499 flat']) expect(assisted.pricingViolations(bad).length).toBeGreaterThan(0);
    for (const ok of ['Hands-on help available in Houston and the NYC area.', 'Prefer us to run the sale? Ask about assisted service.', assisted.COPY.pricing]) expect(assisted.pricingViolations(ok)).toEqual([]);
  });
  test('the public page states availability and custom pricing only — no figure', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/assisted-service.html'), 'utf8');
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    expect(assisted.pricingViolations(visible)).toEqual([]);
    expect(visible).toMatch(/Pricing is custom and set after we evaluate your sale/);
    expect(visible).toMatch(/Houston and the NYC area/);
    expect(/\bAI\b|artificial intelligence/i.test(visible)).toBe(false);
  });
  test('market resolution and submit validation (contact + consent required); the inquiry is recorded as a conversion', async () => {
    expect(assisted.marketFor({ state: 'TX', city: 'Katy' })).toBe('Houston Metro');
    expect(assisted.marketFor({ state: 'NJ', city: 'Hoboken' })).toBe('NYC Tri-State / NYC Metro');
    expect(assisted.marketFor({ state: 'CA', city: 'Fresno' })).toBeNull();
    const db = fakeDb([[/INSERT INTO assisted_service_inquiries/, [{ id: 'q1', created_at: new Date().toISOString() }]]]);
    expect((await assisted.submit({ name: 'A' }, {}, db)).code).toBe('CONTACT_REQUIRED');
    expect((await assisted.submit({ email: 'a@example.com' }, {}, db)).code).toBe('CONSENT_REQUIRED');
    const emit = jest.spyOn(require('../src/services/conversionService'), 'emit').mockImplementation(() => {});
    const ok = await assisted.submit({ email: 'a@example.com', state: 'TX', city: 'Houston', contact_consent: true, message: 'Estate contents' }, { ip: '1.2.3.4' }, db);
    expect(ok).toMatchObject({ ok: true, id: 'q1', market: 'Houston Metro' });
    expect(emit).toHaveBeenCalledWith('assisted_service_inquiry', expect.objectContaining({ subjectId: 'q1', market: 'Houston Metro' }));
    emit.mockRestore();
    const ins = db.calls.find((c) => /INSERT INTO assisted_service_inquiries/.test(c.sql));
    expect(ins.params).not.toContain('1.2.3.4');   // the IP is stored only as a hash
  });
});

describe('measurement readiness audit (18 items)', () => {
  test('evaluates exactly the audit\'s eighteen keys with VERIFIED / PARTIAL / MISSING and evidence; the minimum set is not ready while cost ingestion is PARTIAL', async () => {
    const out = await readinessSvc.evaluate(fakeDb([[/to_regclass/, [{ t: 'x' }]]]));
    expect(out.items.map((i) => i.key)).toEqual(AUDIT.items.map((i) => i.key));
    for (const i of out.items) { expect(['VERIFIED', 'PARTIAL', 'MISSING']).toContain(i.status); expect(i.evidence.length).toBeGreaterThan(0); }
    const by = Object.fromEntries(out.items.map((i) => [i.key, i.status]));
    expect(by.first_party_attribution).toBe('VERIFIED'); expect(by.utm_capture).toBe('VERIFIED'); expect(by.behavioral_events).toBe('VERIFIED');
    expect(by.conversion_definitions).toBe('VERIFIED'); expect(by.identity_stitching).toBe('VERIFIED'); expect(by.anon_to_known).toBe('VERIFIED');
    expect(by.meta_pixel).toBe('PARTIAL'); expect(by.meta_capi).toBe('PARTIAL'); expect(by.cost_ingestion).toBe('PARTIAL');
    expect(out.measurement_ready).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/EAA[A-Za-z0-9]{20,}/);   // never a token value
  });
  test('every server-side conversion emitter is wired in its source file', () => {
    for (const [key, file] of Object.entries(readinessSvc.EMITTERS)) expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain("emit('" + key + "'");
  });
});

describe('publish / spend isolation', () => {
  test('no measurement or paid-growth module makes a network call except the gated Meta CAPI sender', () => {
    const dirs = ['src/services/measurement', 'src/services/paidGrowth'];
    const hits = [];
    for (const d of dirs) for (const f of fs.readdirSync(path.join(ROOT, d))) { const s = fs.readFileSync(path.join(ROOT, d, f), 'utf8'); if (/\bfetch\(|https?\.request\(|axios/.test(s)) hits.push(f); }
    expect(hits).toEqual(['metaCapiService.js']);
  });
  test('the migration seeds every measurement / paid gate OFF and the Director in shadow mode', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'db/migrations/149_creative_physical_intelligence_and_measurement.sql'), 'utf8');
    for (const k of ['meta_pixel_enabled', 'meta_capi_enabled', 'google_conversions_enabled']) expect(sql).toMatch(new RegExp("'marketing\\.measurement\\." + k + "', 'false'"));
    expect(sql).toMatch(/'marketing\.paid_growth\.mode', '"shadow"'/);
    expect(sql).not.toMatch(/40\s?%/);
  });
});

describe('routes (ephemeral server)', () => {
  const express = require('express');
  let server, base;
  const attributionSvc = require('../src/services/attributionService');
  const assistedSvc = require('../src/services/assistedServiceService');
  const spies = [];
  beforeAll(async () => {
    spies.push(jest.spyOn(attributionSvc, 'recordTouch').mockResolvedValue({ id: 't' }));
    spies.push(jest.spyOn(assistedSvc, 'markets').mockResolvedValue([{ market: 'Houston Metro', available: true, capabilities: ['sale management'] }, { market: 'Nowhere', available: false, capabilities: [] }]));
    spies.push(jest.spyOn(assistedSvc, 'submit').mockResolvedValue({ ok: true, id: 'q1', market: 'Houston Metro' }));
    const cfgSvc = require('../src/services/configService'); spies.push(jest.spyOn(cfgSvc, 'get').mockResolvedValue(null));
    const app = express(); app.use(express.json());
    app.use('/api/analytics', require('../src/routes/analytics'));
    app.use('/api/public/assisted-service', require('../src/routes/publicAssistedService'));
    app.use('/api/public/measurement-config', require('../src/routes/publicMeasurement'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
  });
  afterAll(async () => { spies.forEach((s) => s.mockRestore()); await new Promise((r) => server.close(r)); });

  test('POST /api/analytics/touch answers 202 immediately and records a touch; malformed bodies are ignored', async () => {
    const r = await fetch(base + '/api/analytics/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitor_id: 'v9', session_id: 's9', landing_url: 'https://bid.advantage.bid/?utm_source=facebook&utm_campaign=x', referrer: 'https://l.facebook.com/' }) });
    expect(r.status).toBe(202);
    await new Promise((x) => setTimeout(x, 20));
    expect(attributionSvc.recordTouch).toHaveBeenCalledWith(expect.objectContaining({ visitorId: 'v9', sessionId: 's9' }));
    const n = attributionSvc.recordTouch.mock.calls.length;
    const bad = await fetch(base + '/api/analytics/touch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ landing_url: 5 }) });
    expect(bad.status).toBe(202); expect(attributionSvc.recordTouch.mock.calls.length).toBe(n);
  });
  test('assisted service: availability lists only available markets with custom pricing; the inquiry honeypot is silent', async () => {
    const a = await (await fetch(base + '/api/public/assisted-service/availability')).json();
    expect(a.data.markets.map((m) => m.market)).toEqual(['Houston Metro']); expect(a.data.pricing).toMatch(/custom/);
    const hp = await (await fetch(base + '/api/public/assisted-service/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_url: 'bot', email: 'x@y.z' }) })).json();
    expect(hp.success).toBe(true); expect(assistedSvc.submit).not.toHaveBeenCalled();
    const ok = await (await fetch(base + '/api/public/assisted-service/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', contact_consent: true }) })).json();
    expect(ok.success).toBe(true); expect(assistedSvc.submit).toHaveBeenCalledTimes(1);
  });
  test('measurement config: every provider disabled while the gates are OFF — no id is ever returned', async () => {
    const c = await (await fetch(base + '/api/public/measurement-config')).json();
    expect(c.meta_pixel).toEqual({ enabled: false }); expect(c.google_tag).toEqual({ enabled: false });
  });
});
