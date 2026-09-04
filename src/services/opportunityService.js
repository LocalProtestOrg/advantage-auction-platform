'use strict';

/**
 * opportunityService — deterministic opportunity DETECTION + feasibility (Gate 1) + influenceability /
 * auction diagnosis (Gate 2) + explainable lexicographic RANKING + durable DECISION records.
 *
 * An opportunity = a DETECTED FACT + a REASON it may be actionable — never agent opinion. Declines are
 * first-class records with a specific reason (never a generic "not eligible"). Ranking uses ordered tiers,
 * NOT a weighted black-box score, and persists WHY one ranked above another.
 */
const db = require('../db');
const audiences = require('../lib/behavioralAudiences');
const membership = require('./audienceMembershipService');

const DECLINE_REASONS = [
  'no_matching_inventory', 'audience_too_small', 'insufficient_evidence', 'underpowered',
  'already_converted', 'fatigue', 'no_eligible_channel', 'collision', 'attribution_inadequate',
  'not_a_marketing_constraint', 'outranked', 'channel_unavailable',
];

const DECISIONS = ['pursue', 'decline', 'wait', 'prepare', 'escalate', 'stop', 'scale', 'modify'];

// ── Lexicographic ranking tiers (higher = ranked first) ──
const TIME_ORDER = { urgent: 5, high: 4, medium: 3, low: 2, none: 1 };
const OBJECTIVE_PRIORITY = { // current objective priority (config-owned ordering)
  seller_acquisition: 6, professional_seller_acquisition: 5, buyer_activation: 4,
  buyer_reengagement: 3, subscriber_growth: 2, brand: 1,
};
const VALUE_BAND = { high: 3, medium: 2, low: 1 };
const MIN_VIABLE_AUDIENCE = 1;   // minimum viable size (config-tunable); onsite can act on a single visitor

function num(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

// ── Feasibility gate (Gate 1). Returns { feasible, decline_reason } ──
function feasibility(opp, ctx = {}) {
  if (!opp) return { feasible: false, decline_reason: 'insufficient_evidence' };
  // Real thing + measurable outcome must exist.
  if (!opp.objective || !opp.subject_ref) return { feasible: false, decline_reason: 'insufficient_evidence' };
  // Audience size vs minimum viable size (when the opportunity targets an audience).
  const size = num(opp.size_estimate, 0);
  if (opp.requires_audience && size < (ctx.minViable || MIN_VIABLE_AUDIENCE)) return { feasible: false, decline_reason: 'audience_too_small' };
  // Channel availability (onsite is the only enabled channel this phase; others gated).
  if (opp.required_channel && ctx.enabledChannels && !ctx.enabledChannels.includes(opp.required_channel)) {
    return { feasible: false, decline_reason: 'channel_unavailable' };
  }
  // Influenceability (Gate 2 result carried on the opp).
  if (opp.influenceability === 'not_a_marketing_constraint') return { feasible: false, decline_reason: 'not_a_marketing_constraint' };
  return { feasible: true, decline_reason: null };
}

// ── Influenceability / auction diagnosis (Gate 2) ──
// Pure classifier over counts; thresholds are explicit and explainable.
function diagnoseAuction({ views = 0, registrations = 0, bids = 0, lots = 0 } = {}) {
  if (lots === 0) return { influenceability: 'not_a_marketing_constraint', diagnosis: 'no_inventory', recommendation: 'seller_acquisition' };
  if (views < 20) return { influenceability: 'marketing_influenceable', diagnosis: 'low_discovery', recommendation: 'buyer_discovery_marketing' };
  if (views >= 20 && registrations < Math.max(2, views * 0.02)) return { influenceability: 'not_a_marketing_constraint', diagnosis: 'good_traffic_low_registration', recommendation: 'product_ux_review' };
  if (registrations >= 2 && bids < registrations * 0.3) return { influenceability: 'not_a_marketing_constraint', diagnosis: 'good_registration_low_bidding', recommendation: 'inventory_reserve_reassurance' };
  return { influenceability: 'unknown', diagnosis: 'insufficient_evidence', recommendation: null };
}

// ── Ranking (lexicographic; explainable) ──
function tierValues(o) {
  return [
    TIME_ORDER[o.time_criticality] || 1,
    OBJECTIVE_PRIORITY[o.objective] || 0,
    VALUE_BAND[o.value_band] || 1,
    num(o.evidence_quality, 1),        // 1..4
    -num(o.cost, 0),                   // lower cost ranks higher
    num(o.learning_value, 0),          // higher learning ranks higher
  ];
}
const TIER_NAMES = ['time_criticality', 'objective_priority', 'value_band', 'evidence_quality', 'cost', 'learning_value'];

function rankOpportunities(opps) {
  const list = (opps || []).slice();
  list.sort((a, b) => {
    const av = tierValues(a); const bv = tierValues(b);
    for (let i = 0; i < av.length; i++) { if (av[i] !== bv[i]) return bv[i] - av[i]; }
    return 0;
  });
  // Explain each vs the next-ranked: the first differing tier.
  for (let i = 0; i < list.length; i++) {
    if (i === list.length - 1) { list[i].rank_index = i + 1; list[i].ranking_reason = 'lowest-ranked survivor'; continue; }
    const av = tierValues(list[i]); const bv = tierValues(list[i + 1]);
    let diff = -1;
    for (let t = 0; t < av.length; t++) { if (av[t] !== bv[t]) { diff = t; break; } }
    list[i].rank_index = i + 1;
    list[i].ranking_reason = diff >= 0
      ? `ranked above next by ${TIER_NAMES[diff]} (${av[diff]} vs ${bv[diff]})`
      : 'tie on all tiers';
  }
  return list;
}

// ── DB-backed detection over REAL data (audiences + auctions) ──
async function detect(runner) {
  const r = runner || db;
  const counts = await membership.counts(r);
  const out = [];
  // Audience-backed opportunities (only when there are real members).
  for (const def of audiences.all()) {
    const size = counts[def.audience_key] || 0;
    if (size <= 0) continue;
    out.push({
      opportunity_type: 'audience_' + def.family, objective: objectiveFor(def),
      subject_ref: def.audience_key, requires_audience: true, required_channel: 'onsite',
      size_estimate: size, time_criticality: def.family === 'seller' ? 'medium' : 'low',
      value_band: def.family === 'seller' ? 'high' : 'medium',
      evidence_quality: 2, cost: 0, learning_value: 1,
      influenceability: 'marketing_influenceable',
      evidence: { audience_key: def.audience_key, purpose: def.purpose, member_count: size },
    });
  }
  return out;
}

function objectiveFor(def) {
  if (def.family === 'seller') return 'seller_acquisition';
  if (def.family === 'professional') return 'professional_seller_acquisition';
  if (def.family === 'interest') return 'buyer_activation';
  return def.audience_key.indexOf('dormant') >= 0 ? 'buyer_reengagement' : 'buyer_activation';
}

// Persist detected + feasibility-checked + ranked opportunities. Declines are recorded, not discarded.
async function detectAndPersist(runner) {
  const r = runner || db;
  const detected = await detect(r);
  const ctx = { enabledChannels: ['onsite'], minViable: MIN_VIABLE_AUDIENCE };
  const survivors = []; const declined = [];
  for (const o of detected) {
    const f = feasibility(o, ctx);
    if (f.feasible) survivors.push(o); else { o.decline_reason = f.decline_reason; declined.push(o); }
  }
  const ranked = rankOpportunities(survivors);
  const persisted = [];
  for (const o of ranked) {
    const row = (await r.query(
      `INSERT INTO marketing_opportunities
         (opportunity_type, objective, subject_ref, evidence, size_estimate, time_criticality,
          influenceability, status, rank_index, ranking_reason)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'ranked',$8,$9) RETURNING id`,
      [o.opportunity_type, o.objective, o.subject_ref, JSON.stringify(o.evidence || {}), o.size_estimate,
        o.time_criticality, o.influenceability, o.rank_index, o.ranking_reason])).rows[0];
    persisted.push(Object.assign({ id: row.id }, o));
  }
  for (const o of declined) {
    await r.query(
      `INSERT INTO marketing_opportunities
         (opportunity_type, objective, subject_ref, evidence, size_estimate, time_criticality,
          influenceability, status, decline_reason)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'declined',$8)`,
      [o.opportunity_type, o.objective, o.subject_ref, JSON.stringify(o.evidence || {}), o.size_estimate,
        o.time_criticality, o.influenceability, o.decline_reason]);
  }
  return { detected: detected.length, ranked: persisted.length, declined: declined.length, opportunities: persisted };
}

// Create a durable Director decision (append-only). Declines require a valid reason.
async function createDecision({ opportunityId = null, decision, decisionReason = null, objective = null, audienceKey = null,
  channel = null, evidence = null, hypothesis = null, outcomeDefinition = null, stopCondition = null,
  scaleCondition = null, exclusions = null, createdBy = 'A1', experimentId = null } = {}, runner) {
  const r = runner || db;
  if (!DECISIONS.includes(decision)) throw new Error('invalid decision: ' + decision);
  if (decision === 'decline' && !DECLINE_REASONS.includes(decisionReason)) throw new Error('decline requires a valid decline_reason');
  const { rows } = await r.query(
    `INSERT INTO marketing_decisions
       (opportunity_id, decision, decision_reason, objective, audience_key, channel, evidence, hypothesis,
        outcome_definition, stop_condition, scale_condition, exclusions, created_by, experiment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [opportunityId, decision, decisionReason, objective, audienceKey, channel, evidence ? JSON.stringify(evidence) : null,
      hypothesis, outcomeDefinition, stopCondition, scaleCondition, exclusions, createdBy, experimentId]);
  if (opportunityId) await r.query(`UPDATE marketing_opportunities SET status = 'decided' WHERE id = $1`, [opportunityId]);
  return rows[0];
}

module.exports = {
  DECLINE_REASONS, DECISIONS, feasibility, diagnoseAuction, rankOpportunities, detect, detectAndPersist,
  createDecision, objectiveFor, MIN_VIABLE_AUDIENCE,
};
