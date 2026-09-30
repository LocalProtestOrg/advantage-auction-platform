'use strict';

/**
 * Paid reporting reads the LIVE ledger and joins on ONE campaign key (mission 4b), and campaigns whose provider
 * delivery has finished leave ACTIVE (mission 4c). No network, no database: a regex-routed fake runner.
 *
 * Production facts this reproduces (read 2026-09-30):
 *   cost facts keyed  facebook:adv_—_2026-10-individual-seller-houston   (provider name "ADV — <key>")
 *   touches keyed     meta:2026-10-individual-seller-houston
 *   ledger/campaigns  2026-10-individual-seller-houston
 *   $294.80 actual in September; mode live; execution enabled; readiness row 'paid' = SHADOW_CERTIFIED (static, 7 Sep)
 */

const fs = require('fs');
const path = require('path');
const { normalizeCampaignKey, providerName } = require('../src/lib/paidCampaignKey');

function fakeRunner(routes) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of routes) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
      return { rows: [] };
    },
  };
}

const HOU_IS = '2026-10-individual-seller-houston';
const HOU_PS = '2026-10-professional-seller-houston';
const TRI = '2026-09-individual-seller-tristate-text-test';

// ── the key ─────────────────────────────────────────────────────────────────────────────────────────
describe('one canonical campaign key', () => {
  test('every stored spelling of a campaign normalises to the bare campaign_key', () => {
    expect(normalizeCampaignKey('facebook:adv_—_' + HOU_IS)).toBe(HOU_IS);
    expect(normalizeCampaignKey('meta:' + HOU_IS)).toBe(HOU_IS);
    expect(normalizeCampaignKey('ADV — ' + HOU_IS)).toBe(HOU_IS);
    expect(normalizeCampaignKey('ADV | ' + HOU_IS)).toBe(HOU_IS);
    expect(normalizeCampaignKey(HOU_IS)).toBe(HOU_IS);
    expect(normalizeCampaignKey('Houston Sellers')).toBe('houston_sellers');
    expect(normalizeCampaignKey('advantage-houston')).toBe('advantage-houston');   // "adv" only as a prefix label
    expect(normalizeCampaignKey(null)).toBeNull();
  });
  test('cost ingestion and touch capture now write the same key', () => {
    const cost = require('../src/services/measurement/paidCostIngestionService');
    const attribution = require('../src/services/attributionService');
    const fromCost = cost.normalise('meta_ads', { campaign_id: '1', campaign_name: 'ADV — ' + HOU_IS, date: '2026-09-22', spend: 10 }).campaign_key;
    const fromTouch = attribution.campaignKey({ utm: { utm_source: 'meta', utm_campaign: HOU_IS }, channel: 'paid_social' });
    expect(fromCost).toBe(HOU_IS);
    expect(fromTouch).toBe(HOU_IS);
  });
  test('names we create carry no em dash (legacy provider names are not renamed)', () => {
    expect(providerName(HOU_IS)).toBe('ADV | ' + HOU_IS);
    expect(providerName('EXP-IS', 'A-broad (IS-BROAD) — x')).not.toMatch(/—/);
    for (const f of ['src/services/paidGrowth/metaDeliveryService.js', 'src/services/paidGrowth/paidExecutionService.js', 'scripts/certify-meta-chain.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src).not.toMatch(/name: 'ADV —/);
    }
  });
});

// ── legacy rows still join ──────────────────────────────────────────────────────────────────────────
describe('campaignFacts joins legacy cost and touch keys on the canonical key', () => {
  const outcome = require('../src/services/measurement/outcomeAttributionService');
  const r = fakeRunner([
    [/FROM marketing_paid_cost_facts/, [{ campaign_key: 'facebook:adv_—_' + HOU_IS, spend_cents: '13500', impressions: '40000', clicks: '900', link_clicks: '700', reach_daily_sum: null }]],
    [/FROM marketing_attribution_touches/, [{ campaign_key: 'meta:' + HOU_IS, sessions: 107, visitors: 90, engaged_sessions: 30, channel: 'paid_social' }]],
    [/FROM marketing_conversion_events/, [{ campaign_key: 'meta:' + HOU_IS, conversion_key: 'seller_registered', cls: 'MEASURED', n: 2, value_cents: '0' }]],
  ]);
  test('spend, sessions and outcomes land on ONE row (no more NO_DATA split)', async () => {
    const facts = await outcome.campaignFacts({}, r);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ campaign_key: HOU_IS, spend_cents: 13500, sessions: 107, engaged_sessions: 30 });
    expect(facts[0].conversions.seller_registered).toBe(2);
  });
  test('a campaign filter matches any legacy spelling', async () => {
    expect(await outcome.campaignFacts({ campaignKey: 'meta:' + HOU_IS }, r)).toHaveLength(1);
    expect(await outcome.campaignFacts({ campaignKey: 'something-else' }, r)).toHaveLength(0);
  });
});

// ── reports read the live position ──────────────────────────────────────────────────────────────────
function liveRoutes({ globalKill = false, mode = 'live', finished = false } = {}) {
  return [
    [/FROM platform_config WHERE key IN/, [
      { key: 'marketing.paid_growth.mode', value: mode }, { key: 'marketing.paid.execution_enabled', value: true },
      { key: 'marketing.paid.global_kill', value: globalKill }, { key: 'marketing.paid_growth.monthly_ceiling_usd', value: 1000 }]],
    [/FROM marketing_paid_budget_months/, [{ ceiling_cents: 100000, actual_cents: 29480 }]],
    [/FROM marketing_paid_budget_ledger\s+WHERE kind = 'actual' AND month/, [{ campaign_key: HOU_IS, cents: '13500' }, { campaign_key: HOU_PS, cents: '13500' }, { campaign_key: TRI, cents: '2480' }]],
    [/FROM marketing_paid_budget_ledger\s+WHERE kind = 'actual' GROUP BY/, [{ campaign_key: HOU_IS, cents: '13500' }, { campaign_key: HOU_PS, cents: '13500' }, { campaign_key: TRI, cents: '2480' }]],
    [/SELECT campaign_key, state, funnel, market_key, budget_cents/, [
      { campaign_key: HOU_IS, state: finished ? 'BUDGET_EXHAUSTED' : 'ACTIVE', funnel: 'individual_seller', budget_cents: 13500 },
      { campaign_key: HOU_PS, state: finished ? 'BUDGET_EXHAUSTED' : 'ACTIVE', funnel: 'professional_seller', budget_cents: 13500 },
      { campaign_key: TRI, state: finished ? 'COMPLETED' : 'ACTIVE', funnel: 'individual_seller', budget_cents: 2500 },
      { campaign_key: '2026-10-buyer-growth-houston', state: 'PLANNED', funnel: 'buyer', budget_cents: 0 }]],
    [/FROM marketing_paid_spend_syncs/, [{ finished_at: '2026-09-30T14:28:00Z', ok: true, reconciliation_state: 'IN_SYNC' }]],
  ];
}

describe('paidLiveStatus', () => {
  const live = require('../src/services/paidGrowth/paidLiveStatus');
  test('LIVE with the real September spend and running campaigns', async () => {
    const s = await live.status({ month: '2026-09' }, fakeRunner(liveRoutes()));
    expect(s.state).toBe('LIVE');
    expect(s.month_actual_cents).toBe(29480);
    expect(s.running_campaigns).toEqual([HOU_IS, HOU_PS, TRI]);
    expect(s.remaining_cents).toBe(100000 - 29480);
  });
  test('the global kill reads PAUSED; shadow config reads SHADOW', async () => {
    expect((await live.status({}, fakeRunner(liveRoutes({ globalKill: true })))).state).toBe('PAUSED');
    expect((await live.status({}, fakeRunner(liveRoutes({ mode: 'shadow' })))).state).toBe('SHADOW');
  });
});

describe('paid-growth monthly report', () => {
  const report = require('../src/services/paidGrowth/paidGrowthReport');
  const routes = () => [
    ...liveRoutes(),
    [/marketing\.paid_growth\.monthly_ceiling_usd'$/, [{ value: 1000 }]],
    [/FROM marketing_paid_growth_proposals/, []],
    [/FROM marketing_paid_cost_facts WHERE fact_date >= \$1 AND fact_date < \$2 GROUP BY/, [
      { provider: 'meta_ads', campaign_key: 'facebook:adv_—_' + HOU_IS, spend_cents: '13500' }]],
    [/FROM marketing_paid_campaign_states/, []],
    [/FROM marketing_paid_director_actions/, []],
  ];
  test('says live, reports the ledger spend, and never "No paid campaign is running" while campaigns run', async () => {
    const rep = await report.monthly({ month: '2026-09' }, fakeRunner(routes()));
    expect(rep.mode).toBe('live');
    expect(rep.paid_status.state).toBe('LIVE');
    expect(rep.header.ACTUAL_SPEND).toBe('$294.8');
    expect(rep.text).not.toMatch(/No paid campaign is running/);
    expect(rep.text).not.toMatch(/stays off until you turn a channel on/);
    expect(rep.text).toMatch(/Paid advertising is live: 3 campaigns running/);
    expect(rep.allocation_by.campaign[HOU_IS].actual_cents).toBe(13500);
    expect(Object.keys(rep.allocation_by.campaign).some((k) => /facebook:|—/.test(k))).toBe(false);
  });
});

jest.mock('../src/services/audienceMembershipService', () => ({ counts: async () => ({}) }));
jest.mock('../src/services/socialLearningService', () => ({ directorSummary: async () => null }));
describe('Director report', () => {
  const director = require('../src/services/directorReportService');
  test('spend comes from the live paid ledger, not 0.00', async () => {
    const out = await director.generate(fakeRunner(liveRoutes()));
    expect(out.standing_figures.paid_ads_spend_this_month_dollars).toBe('294.80');
    expect(Number(out.standing_figures.spend_dollars)).toBeGreaterThanOrEqual(294.8);
    expect(out.paid_ads).toMatchObject({ state: 'LIVE', spent_this_month_dollars: '294.80', monthly_ceiling_dollars: '1000.00' });
  });
});

describe('runtime readiness', () => {
  const readiness = require('../src/services/channelReadinessService');
  const stored = [{ channel_key: 'marketplace', state: 'ACTIVE' }, { channel_key: 'paid', state: 'SHADOW_CERTIFIED', owner_action_required: 'Activate Google/Meta advertising account' }];
  test('adds the live Paid Growth row; the stored package row is labelled, not rewritten', async () => {
    const rows = await readiness.withLivePaidGrowth(stored, fakeRunner(liveRoutes()));
    expect(rows.find((x) => x.channel_key === 'paid')).toMatchObject({ state: 'SHADOW_CERTIFIED', scope: 'marketing_package_fulfillment' });
    expect(rows.find((x) => x.channel_key === 'paid_growth')).toMatchObject({ state: 'ACTIVE', scope: 'paid_growth_campaigns' });
  });
  test('package fulfillment still reads the stored state (no new executable channel)', async () => {
    const st = await readiness.phase3oState('paid', fakeRunner([[/FROM marketing_channel_readiness WHERE channel_key/, [{ state: 'SHADOW_CERTIFIED' }]]]));
    expect(st).toBe('SHADOW_CERTIFIED');
  });
});

// ── 4c: finished campaigns leave ACTIVE ─────────────────────────────────────────────────────────────
describe('campaigns whose provider delivery finished', () => {
  const gov = require('../src/services/paidGrowth/paidSpendGovernance');
  const now = new Date('2026-09-30T15:00:00Z');
  const houston = { campaign_key: HOU_IS, state: 'ACTIVE', provider_campaign_id: '120257087546720405', authorized_cents: 13500, provider_lifetime_cents: 13500, lifetime_actual_cents: 13500 };
  const houstonProv = { id: '120257087546720405', effective_status: 'ACTIVE', spend_cap_cents: 13500, stop_time: null };
  const houstonAdsets = [{ campaign_id: '120257087546720405', effective_status: 'ACTIVE', end_time: null }, { campaign_id: '120257087546720405', effective_status: 'ACTIVE', end_time: null }];
  const tri = { campaign_key: TRI, state: 'ACTIVE', provider_campaign_id: '120257105842800405', authorized_cents: 2500, provider_lifetime_cents: 2480, lifetime_actual_cents: 2480 };
  const triProv = { id: '120257105842800405', effective_status: 'ACTIVE', spend_cap_cents: null, stop_time: null };
  const triAdsets = [{ campaign_id: '120257105842800405', effective_status: 'ACTIVE', end_time: '2026-09-28T14:47:46-0400' }];

  test('Houston: provider spend cap reached, no spend today → BUDGET_EXHAUSTED (even though ad sets still say ACTIVE)', () => {
    const v = gov.deliveryFinished({ campaign: houston, providerCampaign: houstonProv, adsets: houstonAdsets, todaySpendCents: 0, yesterdaySpendCents: 4, now });
    expect(v).toMatchObject({ finished: true, state: 'BUDGET_EXHAUSTED', why: 'provider spend cap reached' });
  });
  test('Tri-State text test: ad set schedule ended, under its authorization → COMPLETED', () => {
    const v = gov.deliveryFinished({ campaign: tri, providerCampaign: triProv, adsets: triAdsets, todaySpendCents: 0, now });
    expect(v).toMatchObject({ finished: true, state: 'COMPLETED', why: 'every ad set schedule ended' });
  });
  test('still spending today → stays ACTIVE', () => {
    expect(gov.deliveryFinished({ campaign: houston, providerCampaign: houstonProv, adsets: houstonAdsets, todaySpendCents: 12, now }).finished).toBe(false);
  });
  test('authorization reached by our ledger but no provider cap: needs a full quiet day', () => {
    const noCap = { ...houstonProv, spend_cap_cents: null };
    expect(gov.deliveryFinished({ campaign: houston, providerCampaign: noCap, adsets: houstonAdsets, todaySpendCents: 0, yesterdaySpendCents: 4, now }).finished).toBe(false);
    expect(gov.deliveryFinished({ campaign: houston, providerCampaign: noCap, adsets: houstonAdsets, todaySpendCents: 0, yesterdaySpendCents: 0, now }).state).toBe('BUDGET_EXHAUSTED');
  });
  test('under budget with an open schedule → stays ACTIVE', () => {
    const running = { ...houston, provider_lifetime_cents: 9000, lifetime_actual_cents: 9000 };
    expect(gov.deliveryFinished({ campaign: running, providerCampaign: houstonProv, adsets: houstonAdsets, todaySpendCents: 0, yesterdaySpendCents: 0, now }).finished).toBe(false);
  });
  test('the sync marks finished campaigns; missing provider campaign facts change nothing (fail closed)', async () => {
    const r = fakeRunner([
      [/SELECT campaign_key, state FROM marketing_paid_campaigns WHERE state IN \('ACTIVE','PAUSED'\)/, [{ campaign_key: HOU_IS, state: 'ACTIVE' }, { campaign_key: TRI, state: 'ACTIVE' }]],
      [/UPDATE marketing_paid_campaigns SET state = \$2/, (_s, p) => [{ campaign_key: p[0] }]],
    ]);
    const prov = { campaigns: [houstonProv, triProv], adsets: [...houstonAdsets, ...triAdsets] };
    const out = await gov.finishCompletedCampaigns({ campaigns: [houston, tri], prov, now }, r);
    expect(out.map((x) => [x.campaign_key, x.state, x.ok])).toEqual([[HOU_IS, 'BUDGET_EXHAUSTED', true], [TRI, 'COMPLETED', true]]);
    const upd = r.calls.filter((c) => /UPDATE marketing_paid_campaigns/.test(c.sql));
    expect(upd).toHaveLength(2);
    expect(upd[0].sql).toMatch(/WHERE campaign_key = \$1 AND state IN \('ACTIVE','PAUSED'\)/);
    const none = fakeRunner([]);
    expect(await gov.finishCompletedCampaigns({ campaigns: [houston], prov: { campaigns: null, adsets: [] }, now }, none)).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });
  test('before migration 181 the CHECK refusal is reported, never thrown out of the sync', async () => {
    const r = fakeRunner([[/SELECT campaign_key, state FROM marketing_paid_campaigns/, [{ campaign_key: HOU_IS, state: 'ACTIVE' }]]]);
    r.query = (orig => async (sql, p) => { if (/UPDATE marketing_paid_campaigns/.test(sql)) throw new Error('violates check constraint "chk_mpcam_state"'); return orig(sql, p); })(r.query.bind(r));
    const out = await gov.finishCompletedCampaigns({ campaigns: [houston], prov: { campaigns: [houstonProv], adsets: houstonAdsets }, now }, r);
    expect(out[0]).toMatchObject({ ok: false, state: 'BUDGET_EXHAUSTED' });
  });
  test('migration 181 widens the state CHECK additively; planning never resets a finished campaign', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '181_paid_campaign_terminal_states.sql'), 'utf8');
    for (const st of ['PLANNED', 'CREATIVE_BLOCKED', 'READY', 'ACTIVE', 'PAUSED', 'STOPPED', 'FAILED', 'COMPLETED', 'BUDGET_EXHAUSTED']) expect(sql).toContain(`'${st}'`);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
    const exec = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'paidGrowth', 'paidExecutionService.js'), 'utf8');
    expect(exec).toMatch(/state IN \('ACTIVE','PAUSED','STOPPED','COMPLETED','BUDGET_EXHAUSTED'\)/);
    expect(gov.FINISHED_STATES).toEqual(['BUDGET_EXHAUSTED', 'COMPLETED']);
  });
});
