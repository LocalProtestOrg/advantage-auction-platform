'use strict';

/**
 * audienceIntelligenceService — turns a business objective into a provider targeting specification
 * that Meta has actually confirmed it will accept, and remembers what each one taught us.
 *
 * WHY VALIDATION IS MANDATORY, not decorative. Live discovery against the Advantage.Bid account
 * proved that a plausible English phrase is worthless on its own:
 *
 *   · Searching "Estate sale" returns REAL ESTATE interests. The words match; the audience does not.
 *   · "Estate liquidation" [6003460205425] IS returned by interest search, yet targetingvalidation
 *     reports valid=false for this account and a reach estimate errors outright.
 *   · An invented id (9999999999999) is correctly reported invalid by targetingvalidation — but a
 *     reach estimate silently returns 0–0 instead of failing.
 *
 * So the order is always: SEARCH → VALIDATE (authoritative) → ESTIMATE. A reach estimate is never
 * treated as proof that an id exists, and search results are never treated as usable targeting.
 * Validation is re-run on an age policy rather than trusted forever, because Meta retires options.
 *
 * SENSITIVE INFERENCE IS REFUSED. A hypothesis may be about a life situation in the abstract
 * ("people who have a house full of things to sell"), but Advantage.Bid never targets on, stores, or
 * addresses a person by a sensitive personal status. The guardrail below refuses such a strategy
 * outright rather than letting it reach a provider.
 *
 * BUDGET IS SHARED, NEVER MULTIPLIED. Audience variants split one campaign's already-authorized
 * budget. Testing three audiences costs exactly what testing one costs.
 */

const db = require('../../db');
const configService = require('../configService');
const meta = require('./metaAdsProvider');

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Targeting that Advantage.Bid will not use, whatever the provider happens to permit.
 * These are matched against the hypothesis, the rationale and any targeting label — an audience we
 * cannot describe honestly in an advertisement is one we should not buy.
 */
const SENSITIVE_PATTERNS = Object.freeze([
  { re: /\bdivorc|\bseparation\b|\bbreak[- ]?up\b/i, why: 'marital breakdown is a sensitive personal status' },
  { re: /\bwidow|\bbereave|\bdeceased\b|\bdeath of\b|\bfuneral\b|\bpassed away\b/i, why: 'bereavement is a sensitive personal status' },
  { re: /\bforeclos|\bbankrupt|\beviction\b|\bdebt collection\b|\brepossess/i, why: 'financial distress is a sensitive personal status' },
  { re: /\billness\b|\bdiagnos|\bcancer\b|\bdementia\b|\bhospice\b|\bdisab/i, why: 'health status is a sensitive personal attribute' },
  { re: /\brace\b|\bethnic|\breligio|\bsexual orientation\b|\bimmigration status\b/i, why: 'protected characteristic' },
  { re: /\belderly\b|\bsenile\b|\bvulnerable\b/i, why: 'targeting framed on vulnerability' },
]);

/** Seller acquisition is a business decision; minors may not be targeted for it. */
const MIN_AGE = 25;

const HOUSTON_METRO = Object.freeze({ key: '2527622', name: 'Houston', region: 'Texas', country: 'US', radius: 25, distance_unit: 'mile' });

// ── provider discovery (read-only) ────────────────────────────────────────────────────────────

async function graph(pathname) {
  const token = process.env.META_ADS_MANAGE_TOKEN || process.env.META_ADS_READ_TOKEN;
  if (!token) return { ok: false, reason: 'no provider credential present' };
  try {
    const r = await fetch(GRAPH + pathname, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j && j.error) return { ok: false, reason: meta.redact(j.error.message), code: j.error.code };
    return { ok: true, data: j };
  } catch (e) { return { ok: false, reason: meta.redact(e.message) }; }
}

/** Resolve a place name to provider geo keys. Never guess a key. */
async function discoverGeo(query, { limit = 8 } = {}) {
  const r = await graph('/search?type=adgeolocation&q=' + encodeURIComponent(query)
    + '&location_types=' + encodeURIComponent('["city","region","dma"]') + '&limit=' + limit);
  if (!r.ok) return r;
  return { ok: true, results: (r.data.data || []).map((g) => ({
    key: g.key, type: g.type, name: g.name, region: g.region, country_code: g.country_code })) };
}

/** Search detailed-targeting options. Results are CANDIDATES only — nothing here is usable yet. */
async function searchInterests(term, { limit = 8 } = {}) {
  const r = await graph('/search?type=adinterest&q=' + encodeURIComponent(term) + '&limit=' + limit);
  if (!r.ok) return r;
  return { ok: true, candidates: (r.data.data || []).map((i) => ({
    id: i.id, name: i.name, topic: i.topic || null,
    audience_size_lower_bound: i.audience_size_lower_bound || null,
    audience_size_upper_bound: i.audience_size_upper_bound || null,
    validated: false })) };
}

/**
 * THE authoritative gate. Ask the provider whether each id is usable by THIS ad account.
 * Anything not explicitly `valid: true` is unusable — invented, retired, or unavailable here.
 */
async function validateTargeting(list, { account } = {}) {
  if (!Array.isArray(list) || !list.length) return { ok: true, results: [], all_valid: true };
  const resolved = account || (await meta.resolveAdAccount()).account;
  if (!resolved) return { ok: false, reason: 'no canonical ad account resolved' };
  const guard = await meta.assertNotExcluded(resolved);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const r = await graph('/' + resolved + '/targetingvalidation?targeting_list=' + encodeURIComponent(JSON.stringify(
    list.map((t) => ({ type: t.type, id: String(t.id) })))));
  if (!r.ok) return r;
  const results = (r.data.data || []).map((v) => ({
    id: v.id, type: v.type, name: v.name || null, path: v.path || null,
    description: v.description || null,
    audience_size_lower_bound: v.audience_size_lower_bound || null,
    audience_size_upper_bound: v.audience_size_upper_bound || null,
    valid: v.valid === true,
  }));
  return { ok: true, results, all_valid: results.length > 0 && results.every((x) => x.valid) };
}

/** Reach estimate. Only meaningful AFTER validation — an invented id estimates as 0 without error. */
async function estimateReach(targetingSpec, { optimizationGoal = 'OFFSITE_CONVERSIONS', account } = {}) {
  const resolved = account || (await meta.resolveAdAccount()).account;
  if (!resolved) return { ok: false, reason: 'no canonical ad account resolved' };
  const guard = await meta.assertNotExcluded(resolved);
  if (!guard.ok) return { ok: false, reason: guard.reason };
  const r = await graph('/' + resolved + '/delivery_estimate?optimization_goal=' + optimizationGoal
    + '&targeting_spec=' + encodeURIComponent(JSON.stringify(targetingSpec)));
  if (!r.ok) return r;
  const d = (r.data.data || [])[0] || {};
  return { ok: true, lower: d.estimate_mau_lower_bound || null, upper: d.estimate_mau_upper_bound || null,
    ready: d.estimate_ready === true };
}

// ── policy ────────────────────────────────────────────────────────────────────────────────────

/**
 * Refuse a strategy that targets or implies a sensitive personal status, or that would reach minors.
 * Checked before anything is stored and again before anything is activated.
 */
function policyCheck({ hypothesis = '', rationale = '', targetingSpec = {}, labels = [] } = {}) {
  const violations = [];
  const haystack = [hypothesis, rationale, ...labels,
    JSON.stringify(targetingSpec && targetingSpec.flexible_spec ? targetingSpec.flexible_spec : {})].join(' \n ');
  for (const p of SENSITIVE_PATTERNS) if (p.re.test(haystack)) violations.push(p.why);
  const age = targetingSpec && Number(targetingSpec.age_min);
  if (targetingSpec && targetingSpec.age_min !== undefined && !(age >= 18)) {
    violations.push('seller acquisition may not target people under 18');
  }
  return { ok: violations.length === 0, violations: Array.from(new Set(violations)) };
}

// ── strategy registry ─────────────────────────────────────────────────────────────────────────

/**
 * Record (or refresh) a strategy. A strategy is stored with the provider's own verdict attached and
 * can never be marked active while any id is unvalidated — the database enforces that too.
 */
async function upsertStrategy(input, runner = db) {
  const { strategyKey, funnel, hypothesis, rationale = null, geography = HOUSTON_METRO,
    inclusions = [], exclusions = [], optimizationGoal = 'OFFSITE_CONVERSIONS',
    audienceMode = 'detailed', provenance = 'director_hypothesis' } = input;

  const labels = inclusions.concat(exclusions).map((t) => t.name || '').filter(Boolean);
  const spec = buildTargetingSpec({ geography, inclusions, exclusions, audienceMode });
  const policy = policyCheck({ hypothesis, rationale, targetingSpec: spec, labels });

  // Validate every provider id before the strategy is usable.
  let validation = { ok: true, results: [], all_valid: inclusions.length === 0 };
  if (inclusions.length || exclusions.length) {
    validation = await validateTargeting(inclusions.concat(exclusions));
  }
  let state = 'UNVALIDATED';
  if (!validation.ok) state = 'PROVIDER_UNAVAILABLE';
  else if (inclusions.length === 0 && exclusions.length === 0) state = 'VALID';   // geo-only / Advantage+
  else if (validation.all_valid) state = 'VALID';
  else if (validation.results.some((r) => r.valid)) state = 'PARTIAL';
  else state = 'INVALID';

  let reach = { lower: null, upper: null };
  if (state === 'VALID' && policy.ok) {
    const e = await estimateReach(spec, { optimizationGoal });
    if (e.ok) reach = { lower: e.lower, upper: e.upper };
  }

  const learning = policy.ok ? (state === 'VALID' ? 'NO_DATA' : (state === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'NO_DATA'))
    : 'POLICY_BLOCKED';

  const row = (await runner.query(
    `INSERT INTO marketing_audience_strategies
       (strategy_key, funnel, hypothesis, rationale, targeting_spec, geography, inclusions, exclusions,
        optimization_goal, audience_mode, validation_state, validation_detail, last_validated_at,
        estimated_reach_lower, estimated_reach_upper, reach_estimated_at, learning_state,
        policy_status, policy_detail, provenance)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,now(),$13::bigint,$14::bigint,
             CASE WHEN $13::bigint IS NULL THEN NULL ELSE now() END,$15,$16,$17,$18)
     ON CONFLICT (strategy_key) DO UPDATE SET
       hypothesis=EXCLUDED.hypothesis, rationale=EXCLUDED.rationale,
       targeting_spec=EXCLUDED.targeting_spec, geography=EXCLUDED.geography,
       inclusions=EXCLUDED.inclusions, exclusions=EXCLUDED.exclusions,
       optimization_goal=EXCLUDED.optimization_goal, audience_mode=EXCLUDED.audience_mode,
       validation_state=EXCLUDED.validation_state, validation_detail=EXCLUDED.validation_detail,
       last_validated_at=now(), estimated_reach_lower=EXCLUDED.estimated_reach_lower,
       estimated_reach_upper=EXCLUDED.estimated_reach_upper, reach_estimated_at=EXCLUDED.reach_estimated_at,
       policy_status=EXCLUDED.policy_status, policy_detail=EXCLUDED.policy_detail,
       -- An already-running strategy keeps its learning state; only a policy block overrides it.
       learning_state=CASE WHEN EXCLUDED.policy_status='BLOCKED' THEN 'POLICY_BLOCKED'
                           ELSE marketing_audience_strategies.learning_state END,
       active=CASE WHEN EXCLUDED.validation_state='VALID' AND EXCLUDED.policy_status='OK'
                   THEN marketing_audience_strategies.active ELSE false END,
       updated_at=now()
     RETURNING *`,
    [strategyKey, funnel, hypothesis, rationale, JSON.stringify(spec), JSON.stringify(geography),
     JSON.stringify(inclusions), JSON.stringify(exclusions), optimizationGoal, audienceMode,
     state, JSON.stringify({ results: validation.results || [], reason: validation.reason || null }),
     reach.lower, reach.upper, learning, policy.ok ? 'OK' : 'BLOCKED',
     policy.ok ? null : policy.violations.join('; '), provenance])).rows[0];
  return { ok: true, strategy: row, policy, validation_state: state };
}

/** The provider specification for a strategy. Ids only; labels are carried for humans, never sent alone. */
function buildTargetingSpec({ geography = HOUSTON_METRO, inclusions = [], exclusions = [], audienceMode = 'detailed' } = {}) {
  const spec = {
    // A multi-location market (e.g. the Tri-State service area) carries its own provider-resolved
    // geo_locations; a single-city market (Houston) keeps the original one-city radius form.
    geo_locations: geography.geo_locations
      ? JSON.parse(JSON.stringify(geography.geo_locations))
      : { cities: [{ key: geography.key, radius: geography.radius || 25, distance_unit: geography.distance_unit || 'mile' }] },
    age_min: MIN_AGE,
  };
  if (audienceMode === 'advantage_plus' || audienceMode === 'broad') {
    // Advantage+ audience: the provider expands beyond any detailed targeting we supply.
    if (audienceMode === 'advantage_plus') spec.targeting_automation = { advantage_audience: 1 };
    return spec;
  }
  const byType = (list, type) => list.filter((t) => t.type === type).map((t) => ({ id: String(t.id) }));
  const inc = {};
  for (const t of ['interests', 'behaviors', 'demographics', 'life_events', 'industries']) {
    const v = byType(inclusions, t);
    if (v.length) inc[t] = v;
  }
  if (Object.keys(inc).length) spec.flexible_spec = [inc];
  // Meta REQUIRES an explicit decision here whenever detailed targeting is present: "you need to
  // enable or disable the Advantage audience feature". 0 means use the audience we validated rather
  // than letting the provider expand beyond it — which is the whole point of a detailed strategy.
  spec.targeting_automation = { advantage_audience: 0 };
  const exc = {};
  for (const t of ['interests', 'behaviors']) {
    const v = byType(exclusions, t);
    if (v.length) exc[t] = v;
  }
  if (Object.keys(exc).length) spec.exclusions = exc;
  return spec;
}

// ── experiments: variants share one campaign's budget ─────────────────────────────────────────

/**
 * Split an ALREADY AUTHORIZED campaign budget across audience arms.
 * Refuses if the arms would sum above the campaign — testing more audiences must never cost more.
 */
async function planExperiment({ experimentKey, campaignKey, arms = [], hypothesis = null }, runner = db) {
  const c = (await runner.query(
    'SELECT campaign_key, funnel, budget_cents, state FROM marketing_paid_campaigns WHERE campaign_key = $1',
    [campaignKey])).rows[0];
  if (!c) return { ok: false, reason: 'no campaign ' + campaignKey };
  if (!arms.length) return { ok: false, reason: 'an experiment needs at least one arm' };

  const total = arms.reduce((a, x) => a + Number(x.allocatedCents || 0), 0);
  if (total > Number(c.budget_cents)) {
    return { ok: false, reason: `arms total $${(total / 100).toFixed(2)} but the campaign is authorized for only $${(c.budget_cents / 100).toFixed(2)} — audience testing shares the campaign budget, it never adds to it` };
  }

  // Every arm must name a strategy that the provider has validated and policy allows.
  const resolved = [];
  for (const a of arms) {
    const s = (await runner.query(
      'SELECT id, strategy_key, funnel, validation_state, policy_status FROM marketing_audience_strategies WHERE strategy_key = $1',
      [a.strategyKey])).rows[0];
    if (!s) return { ok: false, reason: 'unknown strategy ' + a.strategyKey };
    if (s.validation_state !== 'VALID') return { ok: false, reason: 'strategy ' + a.strategyKey + ' is ' + s.validation_state + ' — it has not been confirmed by the provider' };
    if (s.policy_status !== 'OK') return { ok: false, reason: 'strategy ' + a.strategyKey + ' is blocked by policy' };
    if (s.funnel !== c.funnel) return { ok: false, reason: 'strategy ' + a.strategyKey + ' is for the ' + s.funnel + ' funnel, not ' + c.funnel };
    resolved.push({ strategy: s, arm: a });
  }

  const exp = (await runner.query(
    `INSERT INTO marketing_audience_experiments (experiment_key, campaign_key, funnel, campaign_budget_cents, hypothesis)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (experiment_key) DO UPDATE SET campaign_budget_cents=EXCLUDED.campaign_budget_cents,
       hypothesis=EXCLUDED.hypothesis, updated_at=now()
     RETURNING *`, [experimentKey, campaignKey, c.funnel, c.budget_cents, hypothesis])).rows[0];

  for (const { strategy, arm } of resolved) {
    await runner.query(
      `INSERT INTO marketing_audience_experiment_arms (experiment_id, strategy_id, arm_label, allocated_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (experiment_id, arm_label) DO UPDATE SET
         strategy_id=EXCLUDED.strategy_id, allocated_cents=EXCLUDED.allocated_cents`,
      [exp.id, strategy.id, arm.label, Math.round(Number(arm.allocatedCents))]);
  }
  return { ok: true, experiment: exp, allocated_cents: total, campaign_budget_cents: Number(c.budget_cents),
    unallocated_cents: Number(c.budget_cents) - total };
}

// ── learning ──────────────────────────────────────────────────────────────────────────────────

/**
 * Judge an arm's evidence. Deliberately conservative: nothing is called better or worse than
 * anything else until there is enough of it, so a fifty-visit fluke never retires an audience.
 */
async function assessArm(arm, { minVisits, minConversions, targetCpaCents = null } = {}) {
  const visits = Number(arm.landing_visits || 0);
  const conv = Number(arm.qualified_conversions || arm.registrations || 0);
  const spend = Number(arm.spend_cents || 0);
  const sufficient = visits >= minVisits || conv >= minConversions;
  const cpa = conv > 0 ? Math.round(spend / conv) : null;

  if (spend === 0 && visits === 0) return { state: 'NO_DATA', decision: 'HOLD', sample_sufficient: false, reason: 'nothing delivered yet', cpa_cents: cpa };
  if (!sufficient) {
    return { state: 'INSUFFICIENT_DATA', decision: 'CONTINUE', sample_sufficient: false,
      reason: `${visits} landing visits and ${conv} conversions — below the ${minVisits} visit / ${minConversions} conversion floor, so no comparison is drawn yet`,
      cpa_cents: cpa };
  }
  if (conv === 0) {
    return { state: 'UNDERPERFORMING', decision: 'PAUSE', sample_sufficient: true,
      reason: `${visits} landing visits and no conversions — the audience arrives but does not convert`, cpa_cents: cpa };
  }
  if (targetCpaCents && cpa > targetCpaCents * 2) {
    return { state: 'UNDERPERFORMING', decision: 'REDUCE', sample_sufficient: true,
      reason: `cost per conversion $${(cpa / 100).toFixed(2)} is more than twice the $${(targetCpaCents / 100).toFixed(2)} target`, cpa_cents: cpa };
  }
  if (targetCpaCents && cpa <= targetCpaCents) {
    return { state: 'PROMISING', decision: 'CONTINUE', sample_sufficient: true,
      reason: `${conv} conversions at $${(cpa / 100).toFixed(2)} each, at or below the $${(targetCpaCents / 100).toFixed(2)} target`, cpa_cents: cpa };
  }
  return { state: 'PROMISING', decision: 'CONTINUE', sample_sufficient: true,
    reason: `${conv} conversions from ${visits} landing visits`, cpa_cents: cpa };
}

/** Persist what was decided and why, so the same audience is not rediscovered next week. */
async function recordLearning({ strategyId, strategyKey, funnel, assessment, evidence = {} }, runner = db) {
  await runner.query(
    `INSERT INTO marketing_audience_learnings
       (strategy_id, strategy_key, funnel, observed_state, decision, reason, evidence, sample_sufficient)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [strategyId || null, strategyKey, funnel, assessment.state, assessment.decision, assessment.reason,
     JSON.stringify(evidence), assessment.sample_sufficient === true]);
  if (strategyId) {
    await runner.query(
      `UPDATE marketing_audience_strategies SET learning_state=$2, updated_at=now() WHERE id=$1`,
      [strategyId, assessment.state]);
  }
  return { ok: true };
}

/** What the Director already knows about a strategy — consulted BEFORE proposing it again. */
async function priorLearning(strategyKey, runner = db) {
  const { rows } = await runner.query(
    `SELECT observed_state, decision, reason, sample_sufficient, recorded_at
       FROM marketing_audience_learnings WHERE strategy_key = $1
      ORDER BY recorded_at DESC LIMIT 10`, [strategyKey]);
  const retired = rows.find((r) => r.decision === 'RETIRE');
  return { history: rows, retired: !!retired, should_retest: !!retired && false };
}

async function thresholds() {
  const [v, c] = await Promise.all([
    configService.get(null, 'marketing.audience.min_landing_visits_for_signal'),
    configService.get(null, 'marketing.audience.min_conversions_for_signal'),
  ]);
  return { minVisits: Number(v) || 100, minConversions: Number(c) || 5 };
}

module.exports = {
  SENSITIVE_PATTERNS, MIN_AGE, HOUSTON_METRO,
  discoverGeo, searchInterests, validateTargeting, estimateReach,
  policyCheck, buildTargetingSpec, upsertStrategy,
  planExperiment, assessArm, recordLearning, priorLearning, thresholds,
};
