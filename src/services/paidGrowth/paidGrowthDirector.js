'use strict';

/**
 * paidGrowthDirector — the Paid Growth Director in SHADOW MODE (docs/marketing/phase3p2/config/paid-growth-policy.json).
 *
 * It recommends; it never acts on a provider and never spends. Every proposal uses the ten-field shape
 * (MARKET · AUDIENCE · CAMPAIGN · OBJECTIVE · CHANNEL · BUDGET · MEASUREMENT_WINDOW · SUCCESS_SIGNAL · STOP_CONDITION ·
 * SCALE_CONDITION), names its first-party success signal and the measurement it depends on, and cannot activate while
 * any dependency is short of VERIFIED, while the Director is in shadow mode, while the channel's Owner gate is OFF, or
 * without Owner approval. The monthly authority is a CEILING, not a target: the Director may recommend $0 — and does,
 * whenever the readiness audit's minimum set is not VERIFIED ("measurement not ready").
 *
 * Signal states (NO_DATA · INSUFFICIENT_DATA · EARLY_SIGNAL · MEANINGFUL_SIGNAL · WINNER · LOSER) follow the policy's
 * thresholds and anti-overreaction rules: no LOSER before 100 sessions or $150 unless a safety/policy flag; no WINNER
 * without MEANINGFUL_SIGNAL held across two consecutive checkpoints; CTR alone never decides; platform-reported
 * conversions are provisional until reconciled (only first-party conversions enter these facts).
 */
const db = require('../../db');
const POLICY = require('../../../docs/marketing/phase3p2/config/paid-growth-policy.json');
const defs = require('../../lib/conversionDefinitions');

const T = {
  NO_DATA: { spend_cents: 1000, impressions: 500 },
  INSUFFICIENT: { clicks: 30, sessions: 30, conversions: 3 },
  EARLY: { sessions: 30, hi: 2, lo: 0.5 },
  MEANINGFUL: { sessions: 100, conversions: 10, p: 0.10, bayes: 0.80 },
  LOSER: { sessions: 100, spend_cents: 15000, cpa_multiple: 2 },
  WINNER: { consecutive_meaningful: 2 },
};
const WINDOW_CAP_FRACTION = 0.4;           // per campaign window, of the monthly ceiling (unless a WINNER justifies more)
const EXPERIMENT_RESERVE = 0.1;            // of an active month, unless total spend < $200
const EXPERIMENT_RESERVE_MIN_TOTAL_CENTS = 20000;
const PROPOSAL_FIELDS = ['market', 'audience', 'campaign', 'objective', 'channel', 'budget_cents', 'measurement_window_days', 'success_signal', 'stop_condition', 'scale_condition'];
const CHANNEL_GATES = { meta_ads: 'marketing.destinations.meta_ads_enabled', google_ads: 'marketing.destinations.google_ads_enabled' };
const CHANNEL_MEASUREMENT = { meta_ads: 'minimum_for_meta', google_ads: 'minimum_for_google' };

// ── statistics (deterministic, dependency-free) ──
function normCdf(z) { // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/** Two-proportion z-test: campaign rate vs pooled baseline. Returns { z, p (two-sided), lift }. */
function twoProportion(c1, n1, c0, n0) {
  if (!(n1 > 0 && n0 > 0)) return { z: 0, p: 1, lift: null };
  const p1 = c1 / n1, p0 = c0 / n0, pp = (c1 + c0) / (n1 + n0);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n0));
  if (!(se > 0)) return { z: 0, p: 1, lift: p0 > 0 ? p1 / p0 : null };
  const z = (p1 - p0) / se;
  return { z, p: 2 * (1 - normCdf(Math.abs(z))), lift: p0 > 0 ? p1 / p0 : null };
}
/** P(campaign rate > baseline rate) under Beta(1+c, 1+n−c) posteriors, normal approximation. */
function probBetter(c1, n1, c0, n0) {
  const a1 = 1 + c1, b1 = 1 + n1 - c1, a0 = 1 + c0, b0 = 1 + n0 - c0;
  const m1 = a1 / (a1 + b1), m0 = a0 / (a0 + b0);
  const v1 = (a1 * b1) / ((a1 + b1) ** 2 * (a1 + b1 + 1)), v0 = (a0 * b0) / ((a0 + b0) ** 2 * (a0 + b0 + 1));
  return normCdf((m1 - m0) / Math.sqrt(v1 + v0));
}

/**
 * classify(facts) → { state, reasons, direction, stats }
 * facts: { spend_cents, impressions, clicks, sessions, conversions (first-party success-signal count),
 *          baseline: { sessions, conversions } (pooled), target_cpa_cents, safety_flags: [], prior_meaningful_consecutive }
 */
function classify(f) {
  const reasons = [];
  const sessions = f.sessions || 0, conv = f.conversions || 0, spend = f.spend_cents || 0;
  const base = f.baseline || {};
  const cpa = conv > 0 ? spend / conv : (spend > 0 ? Infinity : null);
  const target = f.target_cpa_cents || null;
  const stats = Object.assign(twoProportion(conv, sessions, base.conversions || 0, base.sessions || 0), { prob_better: probBetter(conv, sessions, base.conversions || 0, base.sessions || 0), cpa_cents: Number.isFinite(cpa) ? Math.round(cpa) : null });
  if ((f.safety_flags || []).length) return { state: 'LOSER', reasons: ['policy/safety/quality flag: ' + f.safety_flags.join(', ') + ' (a flag may end a campaign before the 100-session / $150 floor)'], direction: 'negative', stats };
  if (spend < T.NO_DATA.spend_cents || (f.impressions || 0) < T.NO_DATA.impressions) return { state: 'NO_DATA', reasons: ['spend under $10 or fewer than 500 impressions — wait and check delivery'], direction: null, stats };
  const floorReached = sessions >= T.LOSER.sessions || spend >= T.LOSER.spend_cents;
  const rate = sessions > 0 ? conv / sessions : 0, baseRate = base.sessions > 0 ? base.conversions / base.sessions : null;
  const ratio = baseRate ? rate / baseRate : null;
  const early = sessions >= T.EARLY.sessions && ratio != null && (ratio >= T.EARLY.hi || ratio <= T.EARLY.lo);
  const improving = early && ratio >= T.EARLY.hi;
  const volume = sessions >= T.MEANINGFUL.sessions || conv >= T.MEANINGFUL.conversions;
  const significant = stats.p < T.MEANINGFUL.p || stats.prob_better >= T.MEANINGFUL.bayes || stats.prob_better <= 1 - T.MEANINGFUL.bayes;
  const meaningful = volume && baseRate != null && significant;
  const direction = ratio == null ? null : (rate >= baseRate ? 'positive' : 'negative');
  // LOSER only once the floor is reached (anti-overreaction), CPA > 2× target, and no early sign of improvement.
  if (floorReached && target && cpa > T.LOSER.cpa_multiple * target && !improving) {
    return { state: 'LOSER', reasons: [`${sessions} sessions / $${(spend / 100).toFixed(2)} spent with cost per first-party outcome ${Number.isFinite(cpa) ? '$' + (cpa / 100).toFixed(2) : 'with no outcome yet'} — more than twice the $${(target / 100).toFixed(2)} target`], direction: 'negative', stats };
  }
  if ((f.clicks || 0) < T.INSUFFICIENT.clicks || sessions < T.INSUFFICIENT.sessions) {
    if (conv < T.INSUFFICIENT.conversions) return { state: 'INSUFFICIENT_DATA', reasons: ['fewer than 30 clicks or sessions and fewer than 3 first-party outcomes — continue to the next checkpoint'], direction, stats };
  }
  if (meaningful) {
    const consecutive = (f.prior_meaningful_consecutive || 0) + 1;
    if (direction === 'positive' && target && cpa <= target && consecutive >= T.WINNER.consecutive_meaningful) {
      return { state: 'WINNER', reasons: [`meaningful signal held across ${consecutive} consecutive checkpoints; cost per outcome $${(cpa / 100).toFixed(2)} at or below the $${(target / 100).toFixed(2)} target`], direction, stats, consecutive };
    }
    reasons.push(`${sessions} sessions / ${conv} first-party outcomes; difference from the pooled baseline p=${stats.p.toFixed(3)}, probability better ${(stats.prob_better * 100).toFixed(0)}%`);
    if (direction === 'positive' && consecutive < T.WINNER.consecutive_meaningful) reasons.push('a WINNER call needs this signal at a second consecutive checkpoint');
    return { state: 'MEANINGFUL_SIGNAL', reasons, direction, stats, consecutive };
  }
  if (early) return { state: 'EARLY_SIGNAL', reasons: [`${sessions} sessions with an outcome rate ${ratio.toFixed(2)}× the pooled baseline — noted, not yet significant; no scaling decision`], direction, stats };
  return { state: 'INSUFFICIENT_DATA', reasons: ['no difference from the baseline large enough to act on yet'], direction, stats };
}

/** Bounded action for a state transition (policy bounded_actions). Shadow mode: recorded, never executed. */
function actionFor(prev, next, cls) {
  switch (next) {
    case 'LOSER': return { action: 'PAUSE_LOSER', note: 'pause, reallocate within the month, record the learning' };
    case 'WINNER': return { action: 'SCALE_WINNER', note: 'scale within the window cap; anything above the cap goes to the Owner as a proposal' };
    case 'MEANINGFUL_SIGNAL': return cls.direction === 'positive' ? { action: 'SHIFT_BUDGET', note: 'shift up to half of the window budget toward it; test alternatives against it' } : { action: 'TEST_ALTERNATIVE', note: 'below baseline — test a different creative, audience or geography' };
    case 'EARLY_SIGNAL': return { action: 'HOLD', note: 'note it; at most a fifth of the window budget may move; no scaling decision' };
    default: return { action: 'HOLD', note: next === 'NO_DATA' ? 'wait; check delivery' : 'continue to the next checkpoint' };
  }
}

/** Continuous checkpoints (never calendar-only). Returns the thresholds newly crossed between two fact snapshots. */
function checkpointsCrossed(before = {}, after = {}, lastStateChangeAt = null, now = Date.now()) {
  const b = (k) => Number(before[k] || 0), a = (k) => Number(after[k] || 0);
  const out = [];
  if ((b('spend_cents') < 2500 && a('spend_cents') >= 2500) || (b('impressions') < 2000 && a('impressions') >= 2000)) out.push('delivery_sanity ($25 or 2,000 impressions)');
  if (b('clicks') < 30 && a('clicks') >= 30) out.push('landing_quality (30 clicks)');
  if ((b('sessions') < 100 && a('sessions') >= 100) || (b('spend_cents') < 15000 && a('spend_cents') >= 15000)) out.push('state_decision (100 sessions or $150)');
  if (a('conversions') > b('conversions')) out.push('first_party_conversion (downstream review)');
  if (lastStateChangeAt && now - new Date(lastStateChangeAt).getTime() >= 72 * 3600 * 1000 && !before.regression_rechecked) out.push('regression_recheck (72h after a state change)');
  return out;
}

// ── proposals ──
function validateProposal(p, { ceilingCents, winner = false } = {}) {
  const errors = [];
  for (const k of PROPOSAL_FIELDS) if (p[k] === undefined || p[k] === null || p[k] === '') errors.push('missing ' + k);
  if (p.success_signal && !defs.SUCCESS_SIGNALS.includes(p.success_signal)) errors.push('success signal must be a first-party outcome (' + p.success_signal + ' is not)');
  if (!Array.isArray(p.measurement_dependencies) || !p.measurement_dependencies.length) errors.push('a proposal must name the measurement it depends on');
  if (ceilingCents != null && p.budget_cents > ceilingCents) errors.push('budget exceeds the monthly ceiling');
  if (ceilingCents != null && !winner && p.budget_cents > Math.floor(ceilingCents * WINDOW_CAP_FRACTION)) errors.push(`budget exceeds the per-window cap of $${Math.floor(ceilingCents * WINDOW_CAP_FRACTION / 100)} (only a WINNER state may justify more)`);
  if (require('../assistedServiceService').pricingViolations([p.campaign, p.audience, p.rationale].filter(Boolean).join(' ')).length) errors.push('assisted-service pricing is never stated in a campaign');
  return { ok: errors.length === 0, errors };
}

/** Month-level caps: total ≤ ceiling; experiment reserve kept unless total < $200. Pure. */
function enforceCaps(proposals, ceilingCents) {
  const total = proposals.reduce((a, p) => a + (p.budget_cents || 0), 0);
  const issues = [];
  if (total > ceilingCents) issues.push(`recommended $${total / 100} exceeds the $${ceilingCents / 100} ceiling`);
  const experiments = proposals.filter((p) => p.objective === 'creative_audience_experiment' || /experiment/i.test(p.campaign || '')).reduce((a, p) => a + (p.budget_cents || 0), 0);
  if (total >= EXPERIMENT_RESERVE_MIN_TOTAL_CENTS && experiments < Math.round(total * EXPERIMENT_RESERVE)) issues.push('at least a tenth of an active month is reserved for experiments');
  return { ok: issues.length === 0, total_cents: total, issues };
}

/** Can this proposal be activated? Shadow mode, an OFF channel gate, unverified measurement or missing Owner approval all say no. */
function canActivate(p, { readiness, gates = {}, mode = 'shadow' } = {}) {
  const reasons = [];
  if (mode !== 'live') reasons.push('the Director is in shadow mode (proposals only)');
  if (p.state !== 'OWNER_APPROVED') reasons.push('activation needs Owner approval');
  const gateKey = CHANNEL_GATES[p.channel];
  if (gateKey && gates[gateKey] !== true) reasons.push(p.channel + ' is OFF (Owner-controlled channel readiness)');
  const byKey = Object.fromEntries(((readiness && readiness.items) || []).map((i) => [i.key, i.status]));
  const deps = (p.measurement_dependencies || []).filter((k) => byKey[k] !== 'VERIFIED');
  if (!readiness) reasons.push('no measurement readiness evaluation');
  else if (deps.length) reasons.push('measurement not VERIFIED: ' + deps.map((k) => k + ' ' + (byKey[k] || 'MISSING')).join(', '));
  return { ok: reasons.length === 0, reasons };
}

const DEFAULT_TARGET_CPA_CENTS = { seller_registered: 6000, assisted_service_inquiry: 8000, auction_draft_created: 10000, buyer_registered: 1500, email_signup: 500, bid: 2000 };

/**
 * propose({ readiness, ceilingUsd, markets, assisted, month }) → { month, recommended_spend_cents, measurement_ready, proposals, notes }
 * Pure: the caller supplies readiness + config. With the minimum set not VERIFIED every budget is $0.
 */
function propose({ readiness, ceilingUsd = 1000, markets = POLICY.strategic_markets.initial, assisted = [], month, evidence = {} } = {}) {
  const ceilingCents = Math.round(Number(ceilingUsd) * 100);
  const ready = !!(readiness && readiness.measurement_ready);
  const baseDeps = ['first_party_attribution', 'utm_capture', 'behavioral_events', 'conversion_definitions', 'cost_ingestion', 'consent', 'director_facts'];
  const unmeasurable = ready ? [] : ((readiness && readiness.rules && readiness.rules.minimum_for_any_paid_activation.not_verified) || ['measurement readiness not evaluated']);
  const assistedMarkets = new Set((assisted || []).filter((a) => a.available).map((a) => a.market));
  const out = [];
  for (const market of markets) {
    const short = /houston/i.test(market) ? 'Houston' : (/nyc|new york/i.test(market) ? 'NYC' : market);
    out.push({ market, audience: `people in the ${short} area with things to sell (estate, downsizing, collections)`, campaign: `${short} individual seller acquisition`, objective: 'seller_acquisition', channel: 'meta_ads',
      success_signal: 'seller_registered', platform_proxy: 'landing-page click-through to the seller signup page', measurement_window_days: 21,
      stop_condition: 'LOSER state: 100 sessions or $150 with cost per seller registration above twice the target, or any safety flag',
      scale_condition: 'WINNER state: a meaningful signal at two consecutive checkpoints with cost per registration at or below target',
      measurement_dependencies: baseDeps.concat(['meta_pixel', 'meta_capi', 'meta_click_id']) });
    if (assistedMarkets.has(market)) out.push({ market, audience: `${short}-area households and executors who would rather have the sale run for them`, campaign: `${short} assisted service availability`, objective: 'seller_acquisition', channel: 'meta_ads',
      success_signal: 'assisted_service_inquiry', platform_proxy: 'click-through to the assisted-service page', measurement_window_days: 28,
      stop_condition: 'LOSER state, or inquiries outside the service area above half of all inquiries', scale_condition: 'WINNER state with evaluated inquiries converting to consigned sales',
      measurement_dependencies: baseDeps.concat(['meta_pixel', 'meta_capi', 'meta_click_id']) });
    out.push({ market, audience: `${short}-area buyers interested in estate sales and online auctions`, campaign: `${short} buyer growth`, objective: 'buyer_acquisition', channel: 'meta_ads',
      success_signal: 'buyer_registered', platform_proxy: 'click-through to live auctions', measurement_window_days: 14,
      stop_condition: 'LOSER state (100 sessions or $150, cost per registration above twice target)', scale_condition: 'WINNER state across two checkpoints',
      measurement_dependencies: baseDeps.concat(['meta_pixel', 'meta_capi', 'meta_click_id']) });
  }
  // Evidence-weighted budgets only when measurement is ready; otherwise every proposal carries $0.
  const events = evidence.upcoming_events_by_market || {};
  for (const p of out) {
    p.target_cpa_cents = DEFAULT_TARGET_CPA_CENTS[p.success_signal] || null;
    if (!ready) { p.budget_cents = 0; p.rationale = 'measurement not ready — ' + unmeasurable.join(', ') + '. Recommended spend is $0 until the minimum measurement set is verified.'; continue; }
    const windowCap = Math.floor(ceilingCents * WINDOW_CAP_FRACTION);
    const hasInventory = p.objective !== 'buyer_acquisition' || (events[p.market] || 0) > 0;
    p.budget_cents = hasInventory ? Math.min(windowCap, 15000) : 0;   // a bounded first test: enough to reach the $150 state-decision checkpoint
    p.rationale = hasInventory ? 'bounded first test sized to reach one state-decision checkpoint; nothing scales without two meaningful checkpoints' : 'no live inventory in this market for buyers to act on — $0 until there is';
  }
  const caps = enforceCaps(out, ceilingCents);
  if (!caps.ok && caps.total_cents > ceilingCents) {   // never exceed the ceiling: trim from the end
    let over = caps.total_cents - ceilingCents;
    for (let i = out.length - 1; i >= 0 && over > 0; i -= 1) { const cut = Math.min(out[i].budget_cents, over); out[i].budget_cents -= cut; over -= cut; }
  }
  for (const p of out) { p.measurement_ready = ready; p.unmeasurable = unmeasurable; p.validation = validateProposal(p, { ceilingCents }); }
  const total = out.reduce((a, p) => a + p.budget_cents, 0);
  return { month, mode: 'shadow', ceiling_cents: ceilingCents, recommended_spend_cents: total, measurement_ready: ready, proposals: out,
    notes: ready ? [] : ['Measurement not ready: the Director recommends $0 and every proposal says why.'] };
}

// ── persistence (shadow) ──
async function cfg(r, key) { const x = await r.query(`SELECT value FROM platform_config WHERE key=$1`, [key]); return x.rows[0] ? x.rows[0].value : null; }

async function runShadow({ month = new Date().toISOString().slice(0, 7) + '-01', persist = true } = {}, runner) {
  const r = runner || db;
  const readiness = await require('../measurement/measurementReadinessService').evaluate(r);
  const ceilingUsd = Number(await cfg(r, 'marketing.paid_growth.monthly_ceiling_usd')) || 1000;
  const mode = await cfg(r, 'marketing.paid_growth.mode');
  const assisted = (await cfg(r, 'marketing.assisted_service.markets')) || [];
  const plan = propose({ readiness, ceilingUsd, assisted, month });
  plan.mode = mode === 'live' ? 'live' : 'shadow';
  if (persist) {
    await r.query(`UPDATE marketing_paid_growth_proposals SET state='SUPERSEDED' WHERE month=$1 AND state='PROPOSED'`, [month]);
    for (const p of plan.proposals) {
      await r.query(`INSERT INTO marketing_paid_growth_proposals (month, market, audience, campaign, objective, channel, budget_cents, measurement_window_days, success_signal, platform_proxy, stop_condition, scale_condition, measurement_dependencies, measurement_ready, unmeasurable, rationale, evidence, state, mode)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16,$17::jsonb,'PROPOSED',$18)`,
        [month, p.market, p.audience, p.campaign, p.objective, p.channel, p.budget_cents, p.measurement_window_days, p.success_signal, p.platform_proxy, p.stop_condition, p.scale_condition,
         JSON.stringify(p.measurement_dependencies), p.measurement_ready, JSON.stringify(p.unmeasurable), p.rationale, JSON.stringify({ readiness_counts: readiness.counts, target_cpa_cents: p.target_cpa_cents }), plan.mode]);
    }
    await r.query(`INSERT INTO marketing_paid_director_actions (campaign_key, action, state_before, state_after, evidence, executed, mode) VALUES (NULL,'PROPOSE',NULL,NULL,$1::jsonb,false,$2)`,
      [JSON.stringify({ month, recommended_spend_cents: plan.recommended_spend_cents, measurement_ready: plan.measurement_ready, proposals: plan.proposals.length, readiness_counts: readiness.counts }), plan.mode]);
  }
  return Object.assign(plan, { readiness_counts: readiness.counts, readiness_rules: readiness.rules });
}

/** Evaluate every campaign with cost or sessions; record state changes + bounded actions (never executed in shadow). */
async function evaluateCampaigns({ from = null, to = null } = {}, runner) {
  const r = runner || db;
  const facts = await require('../measurement/outcomeAttributionService').campaignFacts({ from, to }, r);
  const pooled = facts.reduce((a, f) => ({ sessions: a.sessions + f.sessions, conversions: a.conversions + f.first_party_conversions }), { sessions: 0, conversions: 0 });
  const out = [];
  for (const f of facts) {
    const st = (await r.query(`SELECT * FROM marketing_paid_campaign_states WHERE campaign_key=$1`, [f.campaign_key])).rows[0] || null;
    // A live campaign is linked to the proposal it came from (campaign state → proposal_id); an unlinked campaign is
    // judged on all first-party success signals.
    const prop = st && st.proposal_id ? (await r.query(`SELECT success_signal, evidence FROM marketing_paid_growth_proposals WHERE id=$1`, [st.proposal_id])).rows[0] || null : null;
    const signal = prop ? prop.success_signal : null;
    const conv = signal ? (f.conversions[signal] || 0) : f.first_party_conversions;
    const input = { spend_cents: f.spend_cents, impressions: f.impressions, clicks: f.clicks, sessions: f.sessions, conversions: conv,
      baseline: { sessions: Math.max(0, pooled.sessions - f.sessions), conversions: Math.max(0, pooled.conversions - f.first_party_conversions) },
      target_cpa_cents: (prop && prop.evidence && prop.evidence.target_cpa_cents) || DEFAULT_TARGET_CPA_CENTS[signal] || null,
      safety_flags: [], prior_meaningful_consecutive: st ? st.meaningful_checkpoints : 0 };
    const before = st ? st.facts : {};
    const crossed = checkpointsCrossed(before, input, st && st.last_state_change_at);
    if (st && !crossed.length) { out.push({ campaign_key: f.campaign_key, state: st.signal_state, evaluated: false, reason: 'no checkpoint crossed' }); continue; }
    const cls = classify(input);
    const prev = st ? st.signal_state : 'NO_DATA';
    const meaningfulCount = cls.state === 'MEANINGFUL_SIGNAL' || cls.state === 'WINNER' ? (cls.consecutive || 1) : 0;
    await r.query(`INSERT INTO marketing_paid_campaign_states (campaign_key, signal_state, meaningful_checkpoints, checkpoints, facts, last_state_change_at, last_evaluated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb, now(), now())
        ON CONFLICT (campaign_key) DO UPDATE SET signal_state=EXCLUDED.signal_state, meaningful_checkpoints=EXCLUDED.meaningful_checkpoints,
          checkpoints = marketing_paid_campaign_states.checkpoints || EXCLUDED.checkpoints, facts=EXCLUDED.facts,
          last_state_change_at = CASE WHEN marketing_paid_campaign_states.signal_state <> EXCLUDED.signal_state THEN now() ELSE marketing_paid_campaign_states.last_state_change_at END,
          last_evaluated_at = now()`,
      [f.campaign_key, cls.state, meaningfulCount, JSON.stringify([{ at: new Date().toISOString(), crossed, state: cls.state }]), JSON.stringify(input)]);
    if (prev !== cls.state) {
      const act = actionFor(prev, cls.state, cls);
      await r.query(`INSERT INTO marketing_paid_director_actions (campaign_key, action, state_before, state_after, evidence, executed, mode) VALUES ($1,$2,$3,$4,$5::jsonb,false,'shadow')`,
        [f.campaign_key, act.action, prev, cls.state, JSON.stringify({ reasons: cls.reasons, stats: cls.stats, facts: input, crossed, note: act.note })]);
    }
    out.push({ campaign_key: f.campaign_key, state: cls.state, prev, reasons: cls.reasons, evaluated: true, crossed });
  }
  return out;
}

module.exports = { classify, actionFor, checkpointsCrossed, validateProposal, enforceCaps, canActivate, propose, runShadow, evaluateCampaigns, twoProportion, probBetter, T, PROPOSAL_FIELDS, WINDOW_CAP_FRACTION, DEFAULT_TARGET_CPA_CENTS };
