'use strict';

/**
 * Autonomous Growth Lab (Phase 4B) — experiment safety + durable learning. Pure-control coverage +
 * a functional harness for the Growth Pool reservation lifecycle + migration/source guards. Controlled,
 * non-external: nothing publishes/sends/spends/connects.
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const prereg = require('../src/lib/experimentPrereg');
const design = require('../src/lib/experimentDesign');
const decision = require('../src/lib/experimentDecision');
const portfolio = require('../src/lib/experimentPortfolio');
const attribution = require('../src/lib/attribution');
const ideaGate = require('../src/lib/marketingIdeaGate');
const diagnosis = require('../src/lib/auctionDiagnosis');

// ── Pre-registration ─────────────────────────────────────────────────────────────
describe('pre-registration freeze + deterministic hash', () => {
  test('hash is deterministic regardless of key order', () => {
    const a = prereg.hash(prereg.freeze({ hypothesis: 'h', primary_objective: 'buyer', primary_metric: 'm', analysis_window_days: 14 }));
    const b = prereg.hash(prereg.freeze({ primary_metric: 'm', analysis_window_days: 14, hypothesis: 'h', primary_objective: 'buyer' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  test('missing required fields are detected', () => {
    expect(prereg.missingRequired(prereg.freeze({ hypothesis: 'h' }))).toEqual(expect.arrayContaining(['primary_objective', 'primary_metric', 'analysis_window_days']));
  });
});

// ── MDE / required exposure ────────────────────────────────────────────────────
describe('MDE + required-exposure gate', () => {
  test('adequately powered vs underpowered vs insufficient baseline/audience', () => {
    expect(design.assess({ primaryMetric: 'conv', baselineRate: 0.1, minimumDetectableEffect: 0.05, availableExposure: 100000 }).status).toBe('adequately_powered');
    expect(design.assess({ primaryMetric: 'conv', baselineRate: 0.1, minimumDetectableEffect: 0.02, availableExposure: 50 }).status).toBe('underpowered_experiment');
    expect(design.assess({ primaryMetric: 'conv', baselineRate: null, minimumDetectableEffect: 0.05, availableExposure: 100 }).status).toBe('insufficient_baseline');
    expect(design.assess({ primaryMetric: null }).status).toBe('insufficient_baseline');
    expect(design.assess({ primaryMetric: 'x', baselineRate: 0.1, minimumDetectableEffect: 0.05, availableExposure: 0 }).status).toBe('insufficient_audience');
  });
  test('cannot shrink the sample merely to fit a budget (required exposure is intrinsic to MDE/baseline)', () => {
    const r = design.assess({ primaryMetric: 'conv', baselineRate: 0.1, minimumDetectableEffect: 0.02, availableExposure: 50 });
    expect(r.required_exposure).toBeGreaterThan(50);
  });
  test('EMAIL invariant: underpowered email may NEVER enlarge audience by weakening rules', () => {
    expect(design.emailAudienceExpansionAllowed({})).toBe(true);
    ['weakensPermission', 'weakensSuppression', 'weakensGeography', 'weakensEligibility', 'weakensDeliverability'].forEach((k) => {
      expect(design.emailAudienceExpansionAllowed({ [k]: true })).toBe(false);
    });
  });
});

// ── Attribution ─────────────────────────────────────────────────────────────────
describe('attribution credibility rules', () => {
  test('correlational cannot produce causal verdict or scale; tracked cannot scale alone; quasi/experimental scale', () => {
    expect(attribution.canProduceCausalVerdict('correlational')).toBe(false);
    expect(attribution.canScaleUp('correlational')).toBe(false);
    expect(attribution.canScaleUp('tracked')).toBe(false);
    expect(attribution.canInformReplication('tracked')).toBe(true);
    expect(attribution.canScaleUp('quasi_experimental')).toBe(true);
    expect(attribution.canScaleUp('experimental')).toBe(true);
  });
});

// ── Sunk-cost-immune continue/stop + stopping engine ─────────────────────────────
describe('continue/stop is sunk-cost immune + stopping engine', () => {
  test('cumulative/sunk spend as an input THROWS', () => {
    ['cumulativeSpend', 'spent_to_date', 'sunkCost', 'total_spend', 'already_spent'].forEach((k) => {
      expect(() => decision.continueStopDecision({ [k]: 1 })).toThrow(/sunk|cumulative/i);
    });
  });
  test('continue within design; stop on guardrail/window/precondition/futility', () => {
    expect(decision.continueStopDecision({ windowRemainingDays: 5, guardrailStatus: 'ok' }).decision).toBe('continue');
    expect(decision.continueStopDecision({ guardrailStatus: 'breach' }).reason).toBe('guardrail_breach');
    expect(decision.continueStopDecision({ windowRemainingDays: 0 }).reason).toBe('analysis_window_reached');
    expect(decision.continueStopDecision({ windowRemainingDays: 5, futilityReachable: false }).reason).toBe('futility_mde_unreachable');
  });
  test('stopping engine: reasons + class-level + no_conclusion_yet at window close with thin data', () => {
    expect(decision.evaluateStop({ reservationExhausted: true }).reasons).toContain('reservation_exhausted');
    expect(decision.evaluateStop({ guardrailBreach: true, classLevel: true }).classLevel).toBe(true);
    expect(decision.evaluateStop({ windowReached: true, insufficientData: true }).verdictAtClose).toBe('no_conclusion_yet');
  });
});

// ── Portfolio bands + rung ladder ────────────────────────────────────────────────
describe('portfolio bands + rung ladder + no utilization KPI', () => {
  test('first positive pilot → replicate (NOT budget increase); negative stops; inconclusive holds', () => {
    expect(portfolio.nextRung({ rung: 1, verdict: 'positive' }).action).toBe('replicate');
    expect(portfolio.nextRung({ rung: 1, verdict: 'negative' }).action).toBe('stop');
    expect(portfolio.nextRung({ rung: 1, verdict: 'inconclusive' }).action).toBe('hold');
  });
  test('replicate→extend requires scale-worthy attribution; correlational cannot skip', () => {
    expect(portfolio.nextRung({ rung: 2, verdict: 'positive', attributionGrade: 'experimental' }).action).toBe('extend');
    expect(portfolio.nextRung({ rung: 2, verdict: 'positive', attributionGrade: 'correlational' }).action).toBe('hold');
  });
  test('repeated negatives retire the family; proven decays → demote; NO utilization KPI allowed', () => {
    expect(portfolio.retireFamily({ consecutiveNegatives: 2 })).toBe(true);
    expect(portfolio.demoteIfDecayed({ rung: 4, decayed: true }).action).toBe('demote');
    ['authority_utilization_pct', 'budget_used_percent', '% of budget'].forEach((n) => expect(portfolio.isForbiddenUtilizationKpi(n)).toBe(true));
  });
});

// ── Idea → hypothesis promotion + retry control ──────────────────────────────────
describe('idea → hypothesis promotion gate + retry control', () => {
  const full = { named_constraint: 'reach', mechanism: 'more qualified exposure', primary_objective: 'buyer', primary_metric: 'registrations', guardrails: ['unsub_rate'], minimum_detectable_effect: 0.02, required_exposure: 5000, decision_thresholds: { win: 0.02 }, analysis_window_days: 14, estimated_cost: 20000, risk_class: 'low', invalidating_conditions: ['seasonality'] };
  test('a complete contract promotes; missing fields or bad objective block', () => {
    expect(ideaGate.canPromote(full).ok).toBe(true);
    expect(ideaGate.canPromote({ ...full, mechanism: '' }).ok).toBe(false);
    expect(ideaGate.canPromote({ ...full, primary_objective: 'random' }).objectiveValid).toBe(false);
  });
  test('retry of a retired family requires a changed invalidating condition; family key is deterministic', () => {
    expect(ideaGate.retryAllowed({ retired: true, changedInvalidatingCondition: false }).allowed).toBe(false);
    expect(ideaGate.retryAllowed({ retired: true, changedInvalidatingCondition: true }).allowed).toBe(true);
    expect(ideaGate.familyKey(full)).toBe(ideaGate.familyKey({ ...full, mechanism: 'MORE QUALIFIED EXPOSURE' }));
  });
});

// ── Auction diagnosis foundation ─────────────────────────────────────────────────
describe('auction diagnosis foundation', () => {
  test('marketing-correctable vs non-marketing vs INSUFFICIENT_EVIDENCE', () => {
    expect(diagnosis.diagnose({ sample: 2 }).constraint).toBe('INSUFFICIENT_EVIDENCE');
    expect(diagnosis.diagnose({ sample: 20, qualifiedExposure: 0, exposureFloor: 10 }).constraint).toBe('insufficient_qualified_exposure');
    expect(diagnosis.diagnose({ sample: 20, buyersOutsideRadius: true, reachRadiusMiles: 30 }).category).toBe('marketing_correctable');
    expect(diagnosis.diagnose({ sample: 20, registrationDropoff: 0.9 }).marketing_correctable).toBe(false);
    expect(diagnosis.diagnose({ sample: 20, reserveAboveMarket: true }).constraint).toBe('reserve_expectation_gap');
  });
  test('only a marketing-correctable named constraint justifies discretionary Growth spend', () => {
    expect(diagnosis.justifiesGrowthSpend(diagnosis.diagnose({ sample: 20, qualifiedExposure: 0, exposureFloor: 10 }))).toBe(true);
    expect(diagnosis.justifiesGrowthSpend(diagnosis.diagnose({ sample: 2 }))).toBe(false);
    expect(diagnosis.justifiesGrowthSpend(diagnosis.diagnose({ sample: 20, reserveAboveMarket: true }))).toBe(false);
  });
});

// ── Growth Pool reservation lifecycle (functional harness) ───────────────────────
function makeHarness() {
  const st = { pool: { balance_cents: 0, reserved_cents: 0 }, res: {}, glKeys: new Set(), month: {} };
  let id = 0;
  const client = {
    async query(sql, params = []) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT id, amount_cents FROM growth_pool_reservations WHERE idempotency_key/.test(sql)) { const r = Object.values(st.res).find((x) => x.idempotency_key === params[0]); return { rows: r ? [{ id: r.id, amount_cents: r.amount_cents }] : [] }; }
      if (/SELECT \* FROM growth_pool WHERE id = 1 FOR UPDATE/.test(sql)) return { rows: [st.pool] };
      if (/INSERT INTO growth_monthly_authority/.test(sql)) { const m = params[0]; if (!st.month[m]) st.month[m] = { month: m, additional_authority_cents: params[1], owner_granted_cents: 0, spent_beyond_pool_cents: 0 }; return { rows: [] }; }
      if (/SELECT \* FROM growth_monthly_authority WHERE month = \$1 FOR UPDATE/.test(sql)) return { rows: [st.month[params[0]]] };
      if (/SELECT \* FROM growth_monthly_authority WHERE month = \$1/.test(sql)) return { rows: [st.month[params[0]]] };
      if (/UPDATE growth_pool SET reserved_cents = reserved_cents \+ \$1/.test(sql)) { st.pool.reserved_cents += params[0]; return { rows: [] }; }
      if (/UPDATE growth_pool SET reserved_cents = reserved_cents - \$1, balance_cents = balance_cents - \$2/.test(sql)) { st.pool.reserved_cents -= params[0]; st.pool.balance_cents -= params[1]; return { rows: [] }; }
      if (/UPDATE growth_pool SET reserved_cents = reserved_cents - \$1, updated_at/.test(sql)) { st.pool.reserved_cents -= params[0]; return { rows: [] }; }
      if (/INSERT INTO growth_pool_reservations \(experiment_id/.test(sql)) { const rid = 'r' + (++id); st.res[rid] = { id: rid, experiment_id: params[0], amount_cents: params[1], spent_cents: 0, month: params[2], idempotency_key: params[3], status: 'active' }; return { rows: [{ id: rid }] }; }
      if (/SELECT \* FROM growth_pool_reservations WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [st.res[params[0]]] };
      if (/UPDATE growth_pool_reservations SET spent_cents = \$2/.test(sql)) { const r = st.res[params[0]]; r.spent_cents = params[1]; if (r.spent_cents >= r.amount_cents) r.status = 'spent'; return { rows: [] }; }
      if (/UPDATE growth_pool_reservations SET status = 'released'/.test(sql)) { st.res[params[0]].status = 'released'; return { rows: [] }; }
      if (/UPDATE growth_monthly_authority SET spent_beyond_pool_cents = spent_beyond_pool_cents \+ \$2/.test(sql)) { st.month[params[0]].spent_beyond_pool_cents += params[1]; return { rows: [] }; }
      if (/SELECT id FROM growth_pool_ledger WHERE idempotency_key = \$1/.test(sql)) { const has = st.glKeys.has(params[0]); return { rows: has ? [{ id: 'x' }] : [] }; }
      if (/INSERT INTO growth_pool_ledger/.test(sql)) { const key = params[params.length - 2]; st.glKeys.add(key); return { rows: [{ id: 'g' + (++id) }] }; }
      throw new Error('Unhandled SQL: ' + sql.slice(0, 80));
    },
    release() {},
  };
  return { st, db: { connect: async () => client, query: (s, p) => client.query(s, p) } };
}

describe('Growth Pool reservation lifecycle (atomic, idempotent, ceiling-safe)', () => {
  let svc, h;
  beforeEach(() => {
    jest.resetModules();
    h = makeHarness();
    h.st.pool.balance_cents = 40000; // $400 accumulated pool
    jest.doMock('../src/db', () => h.db);
    jest.doMock('../src/services/marketingConfigService', () => ({ growthMonthlyAdditionalAuthorityCents: async () => 100000 }));
    svc = require('../src/services/growthReservationService');
  });
  afterEach(() => { jest.dontMock('../src/db'); jest.dontMock('../src/services/marketingConfigService'); });

  test('reserve holds authority; available = pool + monthly − reserved', async () => {
    const r = await svc.growthReserve({ amountCents: 30000, idempotencyKey: 'k1', month: '2026-09-01' });
    expect(r.ok).toBe(true);
    expect(h.st.pool.reserved_cents).toBe(30000);
  });
  test('reserve refuses beyond available authority (pool $400 + $1000 monthly = $1400)', async () => {
    const r = await svc.growthReserve({ amountCents: 140001, idempotencyKey: 'k2', month: '2026-09-01' });
    expect(r.ok).toBe(false); expect(r.reason).toBe('exceeds_available_authority'); expect(r.escalate).toBe(true);
  });
  test('double reservation with the same key is idempotent (cannot reserve the same authority twice)', async () => {
    const a = await svc.growthReserve({ amountCents: 10000, idempotencyKey: 'kdup', month: '2026-09-01' });
    const b = await svc.growthReserve({ amountCents: 10000, idempotencyKey: 'kdup', month: '2026-09-01' });
    expect(b.idempotent).toBe(true); expect(b.reservationId).toBe(a.reservationId);
    expect(h.st.pool.reserved_cents).toBe(10000); // not 20000
  });
  test('spend against a reservation cannot exceed it; partial spend + release the rest', async () => {
    const r = await svc.growthReserve({ amountCents: 20000, idempotencyKey: 'ks', month: '2026-09-01' });
    const over = await svc.growthSpend({ reservationId: r.reservationId, amountCents: 30000, idempotencyKey: 'sp0' });
    expect(over.ok).toBe(false); expect(over.reason).toBe('exceeds_reservation');
    const s = await svc.growthSpend({ reservationId: r.reservationId, amountCents: 8000, idempotencyKey: 'sp1' });
    expect(s.ok).toBe(true); expect(s.from_pool_cents).toBe(8000);
    const rel = await svc.growthRelease({ reservationId: r.reservationId, idempotencyKey: 'rl1' });
    expect(rel.ok).toBe(true); expect(rel.released_cents).toBe(12000);
    expect(h.st.pool.reserved_cents).toBe(0); // fully unwound
  });
});

// ── Migration 130 additive + no duplication ──────────────────────────────────────
describe('migration 130 — additive, extends 4A', () => {
  const mig = read('db', 'migrations', '130_growth_lab_4b.sql');
  test('extends marketing_experiments (prereg/conditions/verdict/band) — not a new table', () => {
    expect(mig).toMatch(/ALTER TABLE marketing_experiments ADD COLUMN IF NOT EXISTS preregistration/);
    expect(mig).toMatch(/prereg_hash/); expect(mig).toMatch(/execution_started_at/);
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS marketing_experiments\b/);
  });
  test('extends growth_pool (reserved_cents) + adds reservations, learnings, signal sources', () => {
    expect(mig).toMatch(/ALTER TABLE growth_pool ADD COLUMN IF NOT EXISTS reserved_cents/);
    expect(mig).toMatch(/RESERVATION','RESERVATION_RELEASE/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS growth_pool_reservations/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_learnings/);
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS marketing_signal_sources/);
    expect(mig).not.toMatch(/CREATE TABLE IF NOT EXISTS growth_pool\b/);   // no second pool
  });
  test('objective-specific windows + band ceilings + email invariant seeded; no utilization KPI', () => {
    expect(mig).toMatch(/marketing\.windows\.professional_seller_days/);
    expect(mig).toMatch(/marketing\.portfolio\.exploratory_max_share_bps/);
    expect(mig).toMatch(/marketing\.email\.audience_rules_locked/);
    expect(mig).not.toMatch(/utilization/i);
  });
});

// ── Learning scope enforcement (source) ──────────────────────────────────────────
describe('learning memory scope enforcement', () => {
  test('retrieveFacts SQL matches scope (Houston finding not returned for NYC); transferable = hypothesis prior', () => {
    const s = read('src', 'services', 'marketingLearningService.js');
    expect(s).toMatch(/scope = 'general'/);
    expect(s).toMatch(/scope = 'market_specific'\s+AND market_id IS NOT DISTINCT FROM \$1/);
    expect(s).toMatch(/hypothesis_prior/);
    expect(s).toMatch(/verdict IN \('positive','negative'\)/); // negatives persisted + retrievable
  });
});
