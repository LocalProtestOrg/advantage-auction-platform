'use strict';

/**
 * Paid-growth spend governance (migration 163).
 *
 * The monthly $1,000 is the Owner's real authority. These tests prove the accounting (actual,
 * authorized-but-unspent, exposure, uncommitted — each dollar once), the pacing (a daily budget is a
 * target, the month wins), the provider spend sync (idempotent, restatement-safe, attributed), the
 * fail-closed freshness gate, and that markets share ONE ceiling — NYC creates no money.
 *
 * Reservation behaviour is exercised against an in-memory database that serializes transactions
 * exactly as the month row's SELECT … FOR UPDATE does in Postgres.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── in-memory database ────────────────────────────────────────────────────────────────────────

function createFakeDb() {
  const state = {
    months: new Map(), ledger: [], syncs: [], campaigns: new Map(), markets: new Map(), config: new Map(),
  };
  let lock = Promise.resolve();
  let seq = 0;
  const clone = () => ({ months: new Map([...state.months].map(([k, v]) => [k, { ...v }])), ledger: state.ledger.slice() });

  function run(sql, p = [], tx) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id, amount_cents, month FROM marketing_paid_budget_ledger WHERE idempotency_key/.test(s) || /^SELECT id FROM marketing_paid_budget_ledger WHERE idempotency_key/.test(s)) {
      return state.ledger.filter((e) => e.idempotency_key === p[0]);
    }
    if (/^INSERT INTO marketing_paid_budget_months/.test(s)) {
      if (!state.months.has(p[0])) state.months.set(p[0], { ceiling_cents: p[1], committed_cents: 0, actual_cents: 0 });
      return [];
    }
    if (/FROM marketing_paid_budget_months WHERE month = \$1/.test(s) && /^SELECT/.test(s)) {
      const m = state.months.get(p[0]);
      return m ? [{ ...m }] : [];
    }
    if (/^UPDATE marketing_paid_budget_months SET ceiling_cents/.test(s)) { state.months.get(p[0]).ceiling_cents = p[1]; return []; }
    if (/^UPDATE marketing_paid_budget_months SET committed_cents = committed_cents \+/.test(s)) {
      const m = state.months.get(p[0]);
      if (m.committed_cents + p[1] > m.ceiling_cents) throw new Error('violates check constraint "chk_mpbm_within_ceiling"');
      m.committed_cents += p[1]; return [];
    }
    if (/^UPDATE marketing_paid_budget_months SET committed_cents = committed_cents -/.test(s)) { state.months.get(p[0]).committed_cents -= p[1]; return []; }
    if (/^UPDATE marketing_paid_budget_months SET actual_cents/.test(s)) { state.months.get(p[0]).actual_cents += p[1]; return []; }
    if (/FROM marketing_paid_spend_syncs/.test(s) && /^SELECT/.test(s)) {
      return state.syncs.filter((x) => x.ok).sort((a, b) => b.finished_at - a.finished_at).slice(0, 1);
    }
    if (/^INSERT INTO marketing_paid_spend_syncs/.test(s)) {
      const row = { id: 'sync-' + (++seq), finished_at: new Date(), ok: p[3], reconciliation_state: p[12] };
      state.syncs.push(row); return [row];
    }
    if (/^SELECT market_key FROM marketing_paid_campaigns WHERE campaign_key/.test(s)) {
      const c = state.campaigns.get(p[0]); return c ? [{ market_key: c.market_key }] : [];
    }
    if (/FROM marketing_paid_markets WHERE market_key/.test(s)) { const m = state.markets.get(p[0]); return m ? [{ market_key: p[0], ...m }] : []; }
    if (/^SELECT campaign_key FROM marketing_paid_campaigns WHERE market_key/.test(s)) {
      return [...state.campaigns].filter(([, c]) => c.market_key === p[0]).map(([k]) => ({ campaign_key: k }));
    }
    if (/GROUP BY campaign_key, kind, month$/.test(s)) {
      const agg = new Map();
      for (const e of state.ledger) {
        const k = e.campaign_key + '|' + e.kind + '|' + e.month;
        agg.set(k, { campaign_key: e.campaign_key, kind: e.kind, month: e.month, amount_cents: (agg.get(k) || { amount_cents: 0 }).amount_cents + e.amount_cents });
      }
      return [...agg.values()];
    }
    if (/^INSERT INTO marketing_paid_budget_ledger/.test(s)) {
      if (state.ledger.some((e) => e.idempotency_key === p[3])) throw new Error('duplicate key value violates unique constraint');
      const kind = /'commit'/.test(s) ? 'commit' : /'release'/.test(s) ? 'release' : 'actual';
      const row = { id: 'l' + (++seq), month: p[0], campaign_key: p[1], kind, amount_cents: p[2], idempotency_key: p[3],
        provider_campaign_id: p[5] || null, fact_date: p[6] || null };
      state.ledger.push(row); return [{ id: row.id }];
    }
    if (/^SELECT provider_campaign_id, fact_date::text AS fact_date, campaign_key, sum\(amount_cents\)/.test(s)) {
      const agg = new Map();
      for (const e of state.ledger.filter((x) => x.kind === 'actual' && x.provider_campaign_id && x.fact_date >= p[0] && x.fact_date <= p[1])) {
        const k = e.provider_campaign_id + '|' + e.fact_date;
        const cur = agg.get(k) || { provider_campaign_id: e.provider_campaign_id, fact_date: e.fact_date, campaign_key: e.campaign_key, amount_cents: 0 };
        cur.amount_cents += e.amount_cents; agg.set(k, cur);
      }
      return [...agg.values()];
    }
    if (/^SELECT month::text AS month FROM marketing_paid_budget_ledger WHERE campaign_key/.test(s)) {
      return state.ledger.filter((e) => e.campaign_key === p[0] && e.kind === 'commit').slice(-1).map((e) => ({ month: e.month }));
    }
    if (/^SELECT value FROM platform_config WHERE key/.test(s)) {
      return state.config.has(p[0]) ? [{ value: state.config.get(p[0]) }] : [];
    }
    if (/FROM marketing_paid_campaigns WHERE provider_campaign_id IS NOT NULL/.test(s)) return [];
    throw new Error('fake db: unhandled SQL: ' + s.slice(0, 120));
  }

  const api = {
    state,
    query: async (sql, p) => ({ rows: run(sql, p) }),
    connect: async () => {
      let release;
      let snapshot = null;
      const client = {
        query: async (sql, p) => {
          const s = sql.trim();
          if (s === 'BEGIN') {
            // One transaction at a time: the behaviour SELECT … FOR UPDATE gives the month row.
            const prev = lock;
            let done;
            lock = new Promise((r) => { done = r; });
            await prev;
            release = done;
            snapshot = clone();
            return { rows: [] };
          }
          if (s === 'COMMIT') { snapshot = null; if (release) release(); release = null; return { rows: [] }; }
          if (s === 'ROLLBACK') {
            if (snapshot) { state.months = snapshot.months; state.ledger = snapshot.ledger; }
            snapshot = null; if (release) release(); release = null; return { rows: [] };
          }
          return { rows: run(sql, p) };
        },
        release: () => { if (release) release(); release = null; },
      };
      return client;
    },
    pool: { end: async () => {} },
  };
  return api;
}

const mockDb = createFakeDb();
const mockConfig = new Map([
  ['marketing.paid_growth.monthly_ceiling_usd', 1000],
  ['marketing.paid_growth.campaign_ceiling_usd', 400],
  ['marketing.paid_growth.daily_ceiling_usd', 50],
  ['marketing.paid.pacing.timezone', 'America/New_York'],
  ['marketing.paid.spend_sync.decision_max_age_minutes', 15],
]);
const mockMeta = { resolveAdAccount: jest.fn(), call: jest.fn(), redact: (t) => String(t) };
const mockPull = jest.fn();

jest.mock('../src/db', () => mockDb);
jest.mock('../src/services/configService', () => ({
  get: async (_org, key) => (mockConfig.has(key) ? mockConfig.get(key) : null),
  setPlatformConfig: async (key, value) => { mockConfig.set(key, value); },
}));
jest.mock('../src/services/paidGrowth/metaAdsProvider', () => mockMeta);
jest.mock('../src/services/measurement/paidCostIngestionService', () => ({ pullMeta: (...a) => mockPull(...a) }));

const ledger = require('../src/services/paidBudgetLedger');
const gov = require('../src/services/paidGrowth/paidSpendGovernance');

const SEPT = '2026-09-01';

function resetDb() {
  const s = mockDb.state;
  s.months = new Map(); s.ledger = []; s.syncs = []; s.campaigns = new Map(); s.markets = new Map();
  s.markets.set('houston', { status: 'ACTIVE', launch_authorized: true, geo_validation: 'VALID', allocation_cents: null });
  s.markets.set('nyc', { status: 'PREPARED', launch_authorized: false, geo_validation: 'VALID', allocation_cents: null });
  s.campaigns.set('is-hou', { market_key: 'houston' });
  s.campaigns.set('ps-hou', { market_key: 'houston' });
  s.campaigns.set('is-nyc', { market_key: 'nyc' });
}
function freshSync(state = 'IN_SYNC', minutesAgo = 1) {
  mockDb.state.syncs.push({ id: 'fresh', ok: true, finished_at: new Date(Date.now() - minutesAgo * 60000), reconciliation_state: state });
}
/** Today's Houston experiment: two $135 authorizations with provider spend recorded. */
function seedHouston({ isSpent = 4491, psSpent = 4004 } = {}) {
  const s = mockDb.state;
  s.months.set(SEPT, { ceiling_cents: 100000, committed_cents: 27000, actual_cents: isSpent + psSpent });
  s.ledger.push({ campaign_key: 'is-hou', kind: 'commit', month: SEPT, amount_cents: 13500, idempotency_key: 'campaign:is-hou' });
  s.ledger.push({ campaign_key: 'ps-hou', kind: 'commit', month: SEPT, amount_cents: 13500, idempotency_key: 'campaign:ps-hou' });
  s.ledger.push({ campaign_key: 'is-hou', kind: 'actual', month: SEPT, amount_cents: isSpent, idempotency_key: 'seed-actual-is', provider_campaign_id: '111', fact_date: '2026-09-23' });
  s.ledger.push({ campaign_key: 'ps-hou', kind: 'actual', month: SEPT, amount_cents: psSpent, idempotency_key: 'seed-actual-ps', provider_campaign_id: '222', fact_date: '2026-09-23' });
}

beforeEach(() => { resetDb(); jest.clearAllMocks(); });

// ── 1. Month calendar and boundaries ──────────────────────────────────────────────────────────

describe('month calendar (account timezone)', () => {
  test.each([
    ['2027-02-10T15:00:00Z', 28, 10, 19],
    ['2028-02-10T15:00:00Z', 29, 10, 20],
    ['2026-09-23T15:00:00Z', 30, 23, 8],
    ['2026-10-15T15:00:00Z', 31, 15, 17],
  ])('%s → %i-day month, day %i, %i days remaining (today included)', (now, dim, day, remaining) => {
    const ctx = gov.monthContext(new Date(now), 'America/New_York');
    expect(ctx.days_in_month).toBe(dim);
    expect(ctx.current_day).toBe(day);
    expect(ctx.days_remaining).toBe(remaining);
  });

  test('the month boundary follows the ad account, not UTC', () => {
    // 03:59Z on Oct 1 is still 23:59 on Sept 30 in New York — Meta attributes that spend to September.
    const late = gov.monthContext(new Date('2026-10-01T03:59:00Z'));
    expect(late.month).toBe('2026-09-01');
    expect(late.days_remaining).toBe(1);
    const next = gov.monthContext(new Date('2026-10-01T04:00:00Z'));
    expect(next.month).toBe('2026-10-01');
    expect(next.days_remaining).toBe(31);
    expect(ledger.monthKeyForDay('2026-09-30')).toBe('2026-09-01');
  });

  test('the last day of the month still leaves exactly one spendable day', () => {
    const ctx = gov.monthContext(new Date('2026-09-30T20:00:00Z'));
    expect(ctx.days_remaining).toBe(1);
  });
});

// ── 2. Accounting: actual vs committed vs exposure ────────────────────────────────────────────

describe('committed vs actual accounting — each dollar once', () => {
  const E = (campaign_key, kind, amount_cents, month = SEPT) => ({ campaign_key, kind, month, amount_cents });

  test('a $135 authorization with $40 spent is $135 of exposure, not $175 and not $40', () => {
    const x = ledger.exposureFromEntries([E('a', 'commit', 13500), E('a', 'actual', 4000)], SEPT);
    expect(x.actual_cents).toBe(4000);
    expect(x.unspent_exposure_cents).toBe(9500);
    expect(x.exposure_cents).toBe(13500);
  });

  test("one campaign's overshoot cannot hide behind another's unspent authorization", () => {
    const x = ledger.exposureFromEntries([E('a', 'commit', 13500), E('a', 'actual', 14000), E('b', 'commit', 13500)], SEPT);
    // month-level max(committed 27000, actual 14000) would have said 27000
    expect(x.exposure_cents).toBe(27500);
  });

  test('spend from a campaign we never authorized still counts', () => {
    const x = ledger.exposureFromEntries([E('a', 'commit', 10000), E('unmapped:999', 'actual', 2500)], SEPT);
    expect(x.exposure_cents).toBe(12500);
  });

  test('a stopped campaign releases its unspent authority and exposes only what it spent', () => {
    const x = ledger.exposureFromEntries([E('a', 'commit', 13500), E('a', 'actual', 3000), E('a', 'release', 10500)], SEPT);
    expect(x.exposure_cents).toBe(3000);
  });

  test("a past month's exposure is only what was spent in it", () => {
    const x = ledger.exposureFromEntries([E('a', 'commit', 13500, SEPT), E('a', 'actual', 3000, SEPT)], SEPT, { includeOpen: false });
    expect(x.exposure_cents).toBe(3000);
  });

  test('an authorization carried across the month boundary is counted once, in the new month, as unspent', () => {
    const entries = [E('a', 'commit', 13500, SEPT), E('a', 'actual', 10000, SEPT), E('a', 'actual', 1000, '2026-10-01')];
    const oct = ledger.exposureFromEntries(entries, '2026-10-01');
    expect(oct.actual_cents).toBe(1000);
    expect(oct.unspent_exposure_cents).toBe(2500);
    expect(oct.exposure_cents).toBe(3500);
  });
});

// ── 3. Pacing with the live Houston experiment ────────────────────────────────────────────────

describe('monthly pacing — the month wins over any nominal daily figure', () => {
  const ctx = gov.monthContext(new Date('2026-09-23T15:00:00Z'));
  const houston = [
    { campaign_key: 'is-hou', authorized_cents: 13500, lifetime_actual_cents: 4491, month_actual_cents: 4491 },
    { campaign_key: 'ps-hou', authorized_cents: 13500, lifetime_actual_cents: 4004, month_actual_cents: 4004 },
  ];
  const p = gov.computePosition({ ctx, ceilingCents: 100000, campaigns: houston, todaySpendCents: 5896,
    yesterdaySpendCents: 2599, configuredDailyBudgetCents: 5000, safetyFactor: 0.75, overdelivery: 1.75 });

  test('actual, unspent, exposure and uncommitted are distinct and never double counted', () => {
    expect(p.actual_spend_cents).toBe(8495);
    expect(p.authorized_unspent_cents).toBe(9009 + 9496);
    expect(p.total_exposure_cents).toBe(27000);
    expect(p.uncommitted_authority_cents).toBe(73000);
    expect(p.remaining_monthly_authority_cents).toBe(100000 - 8495);
  });

  test('safe daily pacing = (ceiling − actual) ÷ days remaining', () => {
    expect(p.days_remaining).toBe(8);
    expect(p.safe_daily_pacing_target_cents).toBe(Math.floor(91505 / 8));
  });

  test('recommended daily budgets sit under the safe pace by the safety factor', () => {
    expect(p.recommended_max_daily_budget_cents).toBe(Math.floor(Math.floor(91505 / 8) * 0.75));
    expect(p.recommended_max_daily_budget_cents).toBeLessThan(p.safe_daily_pacing_target_cents);
  });

  test("the provider's documented single-day overspend is shown, not hidden", () => {
    expect(p.worst_case_single_day_cents).toBe(8750);
  });

  test('projection never exceeds what the campaign caps allow', () => {
    expect(p.projected_month_end_spend_cents).toBeLessThanOrEqual(p.projected_month_end_exposure_cents);
    expect(p.projected_month_end_exposure_cents).toBe(27000);
  });

  test('$50 every day of a 31-day month would break the ceiling — the pacing target says so', () => {
    const oct = gov.computePosition({ ctx: gov.monthContext(new Date('2026-10-01T15:00:00Z')), ceilingCents: 100000 });
    expect(oct.safe_daily_pacing_target_cents).toBe(3225);
    expect(oct.safe_daily_pacing_target_cents * 31).toBeLessThanOrEqual(100000);
    expect(oct.recommended_max_daily_budget_cents).toBeLessThan(5000);
  });

  test('a configured safety factor above 1 is rejected (it would plan budgets above the safe pace)', async () => {
    mockConfig.set('marketing.paid.pacing.daily_budget_safety_factor', 1.4);
    expect((await gov.settings()).safety_factor).toBe(0.75);
    mockConfig.delete('marketing.paid.pacing.daily_budget_safety_factor');
  });
});

// ── 4. Reconciliation states ──────────────────────────────────────────────────────────────────

describe('reconciliation states', () => {
  const ctx = gov.monthContext(new Date('2026-09-23T15:00:00Z'));
  const base = (over = {}) => gov.computePosition({ ctx, ceilingCents: 100000, configuredDailyBudgetCents: 5000,
    campaigns: [{ campaign_key: 'a', authorized_cents: 13500, lifetime_actual_cents: 4000, month_actual_cents: 4000 }], ...over });
  const now = new Date();

  test('IN_SYNC when provider and ledger agree and the read is fresh', () => {
    expect(gov.classify({ position: base(), providerMonthCents: 4000, internalMonthCents: 4000, lastSuccessAt: now, now }).state).toBe('IN_SYNC');
  });
  test('the morning defect — provider $83.50 vs ledger $0 — is PROVIDER_AHEAD, never silent', () => {
    expect(gov.classify({ position: base(), providerMonthCents: 8350, internalMonthCents: 0, lastSuccessAt: now, now }).state).toBe('PROVIDER_AHEAD');
  });
  test('INTERNAL_AHEAD when the provider restates downward', () => {
    expect(gov.classify({ position: base(), providerMonthCents: 3000, internalMonthCents: 4000, lastSuccessAt: now, now }).state).toBe('INTERNAL_AHEAD');
  });
  test('STALE_PROVIDER_DATA when no recent read exists', () => {
    const old = new Date(Date.now() - 5 * 3600000);
    expect(gov.classify({ position: base(), lastSuccessAt: old, now, maxAgeMinutes: 120 }).state).toBe('STALE_PROVIDER_DATA');
    expect(gov.classify({ position: base(), lastSuccessAt: null, now }).state).toBe('STALE_PROVIDER_DATA');
  });
  test('IMPORT_LAG when live campaigns have not been re-read on schedule', () => {
    const lagged = new Date(Date.now() - 90 * 60000);
    expect(gov.classify({ position: base(), lastSuccessAt: lagged, now, intervalMinutes: 60, maxAgeMinutes: 120, anyActive: true }).state).toBe('IMPORT_LAG');
  });
  test('BUDGET_RISK when spend runs above even the provider maximum for the configured budgets', () => {
    const r = gov.classify({ position: base({ todaySpendCents: 9500 }), lastSuccessAt: now, now });
    expect(r.state).toBe('BUDGET_RISK');
    expect(r.flags.map((f) => f.code)).toContain('PACE_ABOVE_PROVIDER_MAXIMUM');
  });
  test('BUDGET_RISK when a provider campaign we did not authorize is spending', () => {
    const r = gov.classify({ position: base({ unmappedMonthActualCents: 1500 }), lastSuccessAt: now, now });
    expect(r.flags.map((f) => f.code)).toContain('UNAUTHORIZED_PROVIDER_SPEND');
    expect(r.state).toBe('BUDGET_RISK');
  });
  test('CEILING_BREACH when a campaign spends past its authorization', () => {
    const r = gov.classify({ position: base(), lastSuccessAt: now, now,
      campaignOverAuthorization: [{ campaign_key: 'a', authorized_cents: 13500, lifetime_actual_cents: 14000 }] });
    expect(r.state).toBe('CEILING_BREACH');
  });
  test('CEILING_BREACH outranks every other state', () => {
    const p = base({ campaigns: [{ campaign_key: 'a', authorized_cents: 0, lifetime_actual_cents: 100500, month_actual_cents: 100500 }] });
    expect(gov.classify({ position: p, providerMonthCents: 200000, internalMonthCents: 100500, lastSuccessAt: null, now }).state).toBe('CEILING_BREACH');
  });
  test('nominal budgets above the recommendation are flagged as a warning, not a limit', () => {
    const r = gov.classify({ position: base({ configuredDailyBudgetCents: 90000 }), lastSuccessAt: now, now });
    expect(r.flags.map((f) => f.code)).toContain('NOMINAL_BUDGETS_ABOVE_RECOMMENDED');
  });
});

// ── 5. Actual spend ingestion into the ledger ─────────────────────────────────────────────────

describe('provider actual spend → budget ledger', () => {
  const W = { since: '2026-09-20', until: '2026-09-23' };
  const day = (cid, key, d, cents) => ({ provider_campaign_id: cid, campaign_key: key, fact_date: d, spend_cents: cents });

  test('first ingestion records each campaign-day, attributed to its campaign', () => {
    const plan = ledger.planActualAdjustments([day('111', 'is-hou', '2026-09-22', 1522), day('111', 'is-hou', '2026-09-23', 2969)], [], W);
    expect(plan).toHaveLength(2);
    expect(plan.every((a) => a.campaign_key === 'is-hou' && a.month === SEPT)).toBe(true);
    expect(plan.reduce((t, a) => t + a.delta_cents, 0)).toBe(4491);
  });

  test('replaying the same provider figures writes nothing', () => {
    const recorded = [{ provider_campaign_id: '111', fact_date: '2026-09-22', amount_cents: 1522 }];
    expect(ledger.planActualAdjustments([day('111', 'is-hou', '2026-09-22', 1522)], recorded, W)).toHaveLength(0);
  });

  test('a provider restatement writes exactly one correcting delta, with a key unique to the change', () => {
    const recorded = [{ provider_campaign_id: '111', fact_date: '2026-09-23', amount_cents: 2969 }];
    const plan = ledger.planActualAdjustments([day('111', 'is-hou', '2026-09-23', 3100)], recorded, W);
    expect(plan).toEqual([expect.objectContaining({ delta_cents: 131, idempotency_key: 'actual:meta:111:2026-09-23:2969->3100' })]);
  });

  test('duplicate provider rows for the same campaign-day are summed, never recorded twice', () => {
    const plan = ledger.planActualAdjustments([day('111', 'is-hou', '2026-09-23', 1000), day('111', 'is-hou', '2026-09-23', 500)], [], W);
    expect(plan).toHaveLength(1);
    expect(plan[0].delta_cents).toBe(1500);
  });

  test('a day the provider no longer reports is restated to zero — only inside the read window', () => {
    const recorded = [{ provider_campaign_id: '111', fact_date: '2026-09-21', amount_cents: 700 },
      { provider_campaign_id: '111', fact_date: '2026-09-10', amount_cents: 900 }];
    const plan = ledger.planActualAdjustments([], recorded, W);
    expect(plan).toEqual([expect.objectContaining({ fact_date: '2026-09-21', delta_cents: -700 })]);
  });

  test('spend from an unknown provider campaign is kept, marked unmapped', () => {
    const plan = ledger.planActualAdjustments([day('999', null, '2026-09-23', 250)], [], W);
    expect(plan[0].campaign_key).toBe('unmapped:999');
  });

  test('a campaign-day is attributed to the month it happened in, across the boundary', () => {
    const plan = ledger.planActualAdjustments([day('111', 'is-hou', '2026-09-30', 100), day('111', 'is-hou', '2026-10-01', 200)], [], { since: '2026-09-28', until: '2026-10-01' });
    expect(plan.map((a) => a.month)).toEqual(['2026-09-01', '2026-10-01']);
  });

  test('syncActualDays is idempotent end to end and keeps the month total equal to the provider', async () => {
    mockDb.state.months.set(SEPT, { ceiling_cents: 100000, committed_cents: 0, actual_cents: 0 });
    const days = [day('111', 'is-hou', '2026-09-22', 1522), day('222', 'ps-hou', '2026-09-22', 1059)];
    const a = await ledger.syncActualDays({ providerDays: days, window: W });
    const b = await ledger.syncActualDays({ providerDays: days, window: W });
    expect(a.entries).toBe(2);
    expect(b.entries).toBe(0);
    expect(mockDb.state.months.get(SEPT).actual_cents).toBe(2581);
    const restated = await ledger.syncActualDays({ providerDays: [day('111', 'is-hou', '2026-09-22', 1600), day('222', 'ps-hou', '2026-09-22', 1059)], window: W });
    expect(restated.entries).toBe(1);
    expect(mockDb.state.months.get(SEPT).actual_cents).toBe(2659);
  });

  test('two concurrent syncs of the same figures cannot double count', async () => {
    mockDb.state.months.set(SEPT, { ceiling_cents: 100000, committed_cents: 0, actual_cents: 0 });
    const days = [day('111', 'is-hou', '2026-09-23', 5000)];
    const [x, y] = await Promise.all([ledger.syncActualDays({ providerDays: days, window: W }), ledger.syncActualDays({ providerDays: days, window: W })]);
    expect(x.entries + y.entries).toBe(1);
    expect(mockDb.state.months.get(SEPT).actual_cents).toBe(5000);
  });

  test('the ingestion is wired: governance feeds provider days into the ledger', () => {
    const g = code('src/services/paidGrowth/paidSpendGovernance.js');
    expect(g).toMatch(/pullMeta\(\{ since: window\.since, until: window\.until \}/);
    expect(g).toMatch(/ledger\.syncActualDays\(\{ providerDays, window \}\)/);
    expect(g).toMatch(/updateArms\(/);
  });

  test('the worker re-reads spend on a schedule while campaigns are live', () => {
    const w = code('src/workers/marketingRefreshWorker.js');
    expect(w).toMatch(/governance\.syncSpend\(/);
    expect(w).toMatch(/s\.interval_minutes/);
  });
});

// ── 6. Arm attribution and measurement ────────────────────────────────────────────────────────

describe('experiment arm measurement', () => {
  const activated = '2026-09-22T22:53:43Z';
  test('visits inside the provider review window after activation are not people', () => {
    expect(gov.classifyTouch({ touched_at: '2026-09-22T22:53:11Z', click_type: 'fbclid', referrer_host: 'm.facebook.com' }, { activatedAt: activated })).toBe('provider_review_window');
    expect(gov.classifyTouch({ touched_at: '2026-09-22T22:57:50Z', click_type: 'fbclid', referrer_host: 'm.facebook.com' }, { activatedAt: activated })).toBe('provider_review_window');
    expect(gov.classifyTouch({ touched_at: '2026-09-23T04:15:38Z', click_type: 'fbclid', referrer_host: 'm.facebook.com' }, { activatedAt: activated })).toBe('visit');
  });
  test('an arrival with neither a click id nor a referrer is not counted as a paid visit', () => {
    expect(gov.classifyTouch({ touched_at: '2026-09-23T10:41:41Z', click_type: null, referrer_host: null }, { activatedAt: activated })).toBe('no_click_id');
  });
  test('crawler user agents are classified at capture, and the raw agent is never stored', () => {
    const attribution = require('../src/services/attributionService');
    expect(attribution.classifyUserAgent('facebookexternalhit/1.1')).toBe('crawler');
    expect(attribution.classifyUserAgent('Mozilla/5.0 HeadlessChrome/120')).toBe('crawler');
    expect(attribution.classifyUserAgent('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400]')).toBe('in_app_meta');
    expect(attribution.classifyUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537')).toBe('browser');
    const route = code('src/routes/analytics.js');
    expect(route).toMatch(/userAgentClass: attribution\.classifyUserAgent\(req\.get\('user-agent'\)\)/);
    expect(read('db/migrations/163_paid_spend_governance.sql')).not.toMatch(/ADD COLUMN IF NOT EXISTS user_agent text/);
  });
  test('arm outcomes use first-party conversions and exclude internal ones', () => {
    const g = code('src/services/paidGrowth/paidSpendGovernance.js');
    expect(g).toMatch(/WHERE is_internal = false AND attribution->'last_touch'->>'id' = ANY/);
    expect(g).toMatch(/UPDATE marketing_audience_experiment_arms/);
  });
  test('ledger rows are the base: a reserved campaign not yet at the provider still carries exposure', () => {
    const { rows, unmappedMonthCents } = gov.campaignRows({
      ledgerCampaigns: [{ campaign_key: 'reserved-only', authorized_cents: 5000, lifetime_actual_cents: 0, month_actual_cents: 0 },
        { campaign_key: 'unmapped:9', authorized_cents: 0, lifetime_actual_cents: 300, month_actual_cents: 300 }],
      providerCampaigns: [] });
    expect(rows.map((r) => r.campaign_key)).toEqual(['reserved-only']);
    expect(unmappedMonthCents).toBe(300);
  });
});

// ── 7. The hard ceiling: reservations ─────────────────────────────────────────────────────────

describe('reservations — fresh spend, launched market, one shared ceiling', () => {
  test('no provider spend reading on record → refuse (never authorize against an unchecked $0)', async () => {
    seedHouston();
    const r = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 1000, idempotencyKey: 'x', month: SEPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no provider spend reading/);
  });

  test('stale provider spend → refuse', async () => {
    seedHouston(); freshSync('IN_SYNC', 90);
    const r = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 1000, idempotencyKey: 'x', month: SEPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/last read 90 min ago/);
  });

  test.each(['BUDGET_RISK', 'CEILING_BREACH', 'STALE_PROVIDER_DATA'])('a %s reconciliation blocks new authority', async (state) => {
    seedHouston(); freshSync(state);
    const r = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 1000, idempotencyKey: 'x', month: SEPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(state);
  });

  test('uncommitted authority is ceiling − (actual + unspent), with the live experiment counted once', async () => {
    seedHouston(); freshSync();
    expect((await ledger.reserve({ campaignKey: 'is-hou', amountCents: 73001, idempotencyKey: 'too-much', month: SEPT })).ok).toBe(false);
    const ok = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 40000 - 1, idempotencyKey: 'fits', month: SEPT });
    expect(ok.ok).toBe(true);
  });

  test('a retried reservation replays instead of committing twice', async () => {
    seedHouston(); freshSync();
    const a = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 5000, idempotencyKey: 'same', month: SEPT });
    const b = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 5000, idempotencyKey: 'same', month: SEPT });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(mockDb.state.months.get(SEPT).committed_cents).toBe(27000 + 5000);
  });

  test('concurrent reservations cannot both spend the same remaining authority', async () => {
    seedHouston(); freshSync();
    const [x, y] = await Promise.all([
      ledger.reserve({ campaignKey: 'is-hou', amountCents: 40000, idempotencyKey: 'c1', month: SEPT }),
      ledger.reserve({ campaignKey: 'ps-hou', amountCents: 40000, idempotencyKey: 'c2', month: SEPT }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);   // 73000 uncommitted: only one $400 fits
  });

  test('the per-campaign ceiling ($400) still applies', async () => {
    seedHouston(); freshSync();
    const r = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 40001, idempotencyKey: 'big', month: SEPT });
    expect(r.reason).toMatch(/per-campaign ceiling/);
  });

  test('NYC cannot receive authority while it is PREPARED and not launch-authorized', async () => {
    seedHouston(); freshSync();
    const r = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 1000, idempotencyKey: 'nyc1', month: SEPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/market nyc is PREPARED and not launch-authorized/);
  });

  test('Houston + NYC share ONE $1,000 — launching NYC creates no new authority', async () => {
    seedHouston(); freshSync();
    mockDb.state.markets.set('nyc', { status: 'ACTIVE', launch_authorized: true, geo_validation: 'VALID', allocation_cents: null });
    mockDb.state.campaigns.set('ps-nyc', { market_key: 'nyc' });
    const n1 = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 40000, idempotencyKey: 'n1', month: SEPT });
    const n2 = await ledger.reserve({ campaignKey: 'ps-nyc', amountCents: 33000, idempotencyKey: 'n2', month: SEPT });
    expect(n1.ok && n2.ok).toBe(true);                               // 27000 + 40000 + 33000 = 100000
    const h = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 1, idempotencyKey: 'h1', month: SEPT });
    const n3 = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 1, idempotencyKey: 'n3', month: SEPT });
    expect(h.ok).toBe(false);
    expect(n3.ok).toBe(false);
  });

  test('a market allocation can only narrow the global ceiling, never widen it', async () => {
    seedHouston(); freshSync();
    mockDb.state.markets.set('nyc', { status: 'ACTIVE', launch_authorized: true, geo_validation: 'VALID', allocation_cents: 20000 });
    const a1 = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 25000, idempotencyKey: 'a1', month: SEPT });
    expect(a1.reason).toMatch(/allocation/);
    mockDb.state.markets.set('nyc', { status: 'ACTIVE', launch_authorized: true, geo_validation: 'VALID', allocation_cents: 500000 });
    const r = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 40000, idempotencyKey: 'a2', month: SEPT });
    expect(r.ok).toBe(true);
    const r2 = await ledger.reserve({ campaignKey: 'is-nyc', amountCents: 34000, idempotencyKey: 'a3', month: SEPT });
    expect(r2.ok).toBe(false);                                       // 27000 + 40000 + 34000 > 100000
    expect(r2.reason).toMatch(/monthly authority remains uncommitted/);
  });

  test('a campaign with no market cannot be given money', async () => {
    seedHouston(); freshSync();
    mockDb.state.campaigns.set('orphan', { market_key: null });
    expect((await ledger.reserve({ campaignKey: 'orphan', amountCents: 100, idempotencyKey: 'o', month: SEPT })).reason).toMatch(/no market/);
  });

  test('the database CHECK remains the last line of defence', async () => {
    seedHouston(); freshSync();
    mockDb.state.months.get(SEPT).committed_cents = 99990;   // simulate a code bug upstream
    const r = await ledger.reserve({ campaignKey: 'is-hou', amountCents: 100, idempotencyKey: 'chk', month: SEPT });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/monthly ceiling would be exceeded/);
  });

  test('release returns authority to the month it was committed in', async () => {
    seedHouston();
    const r = await ledger.release({ campaignKey: 'is-hou', amountCents: 9009, idempotencyKey: 'rel' });
    expect(r.ok).toBe(true);
    expect(mockDb.state.months.get(SEPT).committed_cents).toBe(27000 - 9009);
  });
});

// ── 8. Fail closed when the provider cannot be read ───────────────────────────────────────────

describe('fresh-spend safety check', () => {
  test('provider unavailable → the decision fails closed and the failure is recorded', async () => {
    mockMeta.resolveAdAccount.mockResolvedValue({ ok: true, account: 'act_1722514625516256' });
    mockPull.mockResolvedValue({ pulled: false, reason: 'PROVIDER_ERROR', detail: 'network unreachable' });
    const r = await gov.ensureFreshSpend({ trigger: 'test' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failing closed/);
    expect(mockDb.state.syncs.some((s) => s.ok === false)).toBe(true);
  });

  test('ad account unresolvable → fails closed', async () => {
    mockMeta.resolveAdAccount.mockResolvedValue({ ok: false, reason: 'excluded' });
    const r = await gov.assertNewSpendAllowed({ campaignKey: 'is-hou', amountCents: 100 });
    expect(r.ok).toBe(false);
  });

  test('a recent good reading is reused rather than hammering the provider', async () => {
    freshSync('IN_SYNC', 2);
    const r = await gov.ensureFreshSpend({ trigger: 'test' });
    expect(r.ok).toBe(true);
    expect(r.refreshed).toBe(false);
    expect(mockPull).not.toHaveBeenCalled();
  });

  test('a recent reading that reported BUDGET_RISK still blocks', async () => {
    freshSync('BUDGET_RISK', 2);
    expect((await gov.ensureFreshSpend({})).ok).toBe(false);
  });

  test('every path that adds paid delivery passes the governance gate first', () => {
    const exec = code('src/services/paidGrowth/paidExecutionService.js');
    const create = exec.slice(exec.indexOf('async function createCampaign'), exec.indexOf('async function pauseCampaign'));
    expect(create.indexOf('assertNewSpendAllowed')).toBeGreaterThan(-1);
    expect(create.indexOf('assertNewSpendAllowed')).toBeLessThan(create.indexOf('ledger.reserve'));
    const delivery = code('src/services/paidGrowth/metaDeliveryService.js');
    expect(delivery.slice(delivery.indexOf('async function activateExperiment'))).toMatch(/assertNewSpendAllowed/);
    expect(delivery.slice(delivery.indexOf('async function buildExperimentHierarchy'), delivery.indexOf('async function activateExperiment')))
      .toMatch(/recommended_max_daily_budget_cents/);
    const provider = code('src/services/paidGrowth/metaAdsProvider.js');
    const setStatus = provider.slice(provider.indexOf('async function setStatus'), provider.indexOf('const pause ='));
    expect(setStatus).toMatch(/if \(status === 'ACTIVE'\)[\s\S]*assertNewSpendAllowed/);
  });

  test('a ceiling breach pauses delivery through the existing emergency stop', () => {
    const g = code('src/services/paidGrowth/paidSpendGovernance.js');
    const fn = g.slice(g.indexOf('async function safetyActions'), g.indexOf('async function ensureFreshSpend'));
    expect(fn).toMatch(/verdict\.state === 'CEILING_BREACH'/);
    expect(fn).toMatch(/emergencyKill\(/);
  });
});

// ── 9. The Owner's ceilings and the live campaigns are unchanged ──────────────────────────────

describe('Owner authority is preserved', () => {
  const sql = read('db/migrations/163_paid_spend_governance.sql');

  test('no geography carries its own ceiling — only the global monthly key exists', () => {
    expect(sql).not.toMatch(/ceiling_cents\s+integer/);
    const l = code('src/services/paidBudgetLedger.js');
    const ceil = l.slice(l.indexOf('async function ceilings'), l.indexOf('async function status'));
    expect(ceil).toMatch(/marketing\.paid_growth\.monthly_ceiling_usd/);
    expect(ceil).not.toMatch(/market_key|marketing_paid_markets|allocation/);
  });

  test('the migration changes no ceiling, no campaign authorization and no provider budget', () => {
    expect(sql).not.toMatch(/monthly_ceiling_usd|campaign_ceiling_usd|daily_ceiling_usd/);
    expect(sql).not.toMatch(/UPDATE marketing_paid_budget_months/);
    expect(sql).not.toMatch(/UPDATE marketing_paid_campaigns SET (budget_cents|state)/);
    expect(sql).toMatch(/UPDATE marketing_paid_campaigns SET market_key = 'houston'/);
  });

  test('NYC is seeded PREPARED and un-authorized, and a market cannot be ACTIVE without authority', () => {
    expect(sql).toMatch(/VALUES \('nyc', 'New York City', 'PREPARED', false/);
    expect(sql).toMatch(/CHECK \(\s*status <> 'ACTIVE' OR \(launch_authorized = true AND geo_validation = 'VALID'\)\)/);
  });

  test('the first experiment authorizations ($135 each) are unchanged', () => {
    const s = read('scripts/activate-first-experiment.js');
    expect((s.match(/max_cents: 13500/g) || []).length).toBe(2);
    expect(s).toMatch(/combined_max_cents: 27000/);
  });

  test('the NYC preparation script never creates provider objects or authorizes launch', () => {
    const s = code('scripts/prepare-nyc-market.js');
    expect(s).not.toMatch(/createCampaign|createAdSet|createAd\b|createAdCreative|setStatus|uploadImage/);
    expect(s).toMatch(/WHERE market_key = \$1 AND status = 'PREPARED' AND launch_authorized = false/);
    expect(s).not.toMatch(/launch_authorized = true/);
    expect(s).toMatch(/g\.type === 'city'/);
  });

  test('spend settings the Owner can edit never include a ceiling', () => {
    const r = code('src/routes/adminMarketingAgency.js');
    const block = r.slice(r.indexOf('const SPEND_SETTINGS'), r.indexOf("router.post('/spend/settings'"));
    expect(block).not.toMatch(/ceiling/);
    expect(r).toMatch(/router\.post\('\/spend\/settings', superOnly/);
    expect(r).toMatch(/router\.post\('\/spend\/sync', superOnly/);
  });

  test('the Owner page never calls a nominal daily budget a hard limit', () => {
    const page = read('public/admin/marketing-agency.html');
    expect(page).toMatch(/pacing targets, not hard limits/);
    expect(page).not.toMatch(/Per day max/);
    for (const label of ['Monthly budget ceiling', 'Actual Meta spend', 'Authorized but unspent', 'Total current exposure',
      'Remaining uncommitted authority', 'Days remaining', 'Safe daily pacing target', 'Projected month-end spend']) {
      expect(page).toContain(label);
    }
  });
});

// ── 10. The Owner's own subscription is excluded from acquisition ─────────────────────────────

describe('internal (Owner) records leave acquisition reporting but are never deleted', () => {
  const sql = read('db/migrations/163_paid_spend_governance.sql');

  test('the Owner subscription is reclassified by id, not deleted, and no address appears in code', () => {
    expect(sql).toMatch(/SET is_internal = true, internal_reason = 'owner_account'/);
    expect(sql).toMatch(/WHERE id = '28904056-bf01-4438-86c0-167a72da1b02'/);
    expect(sql).not.toMatch(/DELETE FROM marketing_contacts/);
    expect(sql).not.toMatch(/@/);
  });

  test('acquisition, growth, CAC and paid-performance queries exclude internal records', () => {
    expect(code('src/services/measurement/outcomeAttributionService.js')).toMatch(/WHERE is_internal = false AND \$\{CK\} IS NOT NULL/);
    expect(code('src/services/measurement/outcomeAttributionService.js')).toMatch(/WHERE is_internal = false AND \(\$1::date IS NULL/);
    expect(code('src/services/paidGrowth/paidGrowthReport.js')).toMatch(/WHERE is_internal = false AND occurred_at >= \$1/);
    expect(code('src/services/baselineReportService.js')).toMatch(/is_demo=false AND is_internal=false AND permission_basis/);
    expect(code('src/services/marketDiagnosisService.js')).toMatch(/is_demo=false AND is_internal=false`/);
    expect(code('src/routes/adminSubscribers.js')).toMatch(/mc\.is_demo = false AND mc\.is_internal = false/);
    expect(code('src/services/directorInputResolver.js')).toMatch(/is_internal = false/);
  });

  test('new conversions by admin / staff accounts or internal subscribers are marked internal', async () => {
    const conv = require('../src/services/conversionService');
    const runner = { query: async (sql, p) => {
      if (/FROM users/.test(sql)) return { rows: p[0] === 'owner' ? [{ role: 'admin', staff_role: 'super_admin' }] : [{ role: 'seller', staff_role: null }] };
      if (/FROM marketing_contacts WHERE is_internal = true/.test(sql)) return { rows: p[0] === 'ownerhash' ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    } };
    expect(await conv.isInternal(runner, { userId: 'owner' })).toBe(true);
    expect(await conv.isInternal(runner, { userId: 'someone' })).toBe(false);
    expect(await conv.isInternal(runner, { subjectType: 'subscriber_email_sha256', subjectId: 'ownerhash' })).toBe(true);
    expect(await conv.isInternal(runner, { subjectType: 'subscriber_email_sha256', subjectId: 'otherhash' })).toBe(false);
  });
});
