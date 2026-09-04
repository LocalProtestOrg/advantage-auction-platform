'use strict';

/**
 * marketingLearningService — durable, queryable experiment learning. Stores positive, negative, AND
 * inconclusive results equally. Scope is ENFORCED on retrieval: a market_specific finding is never returned
 * as a fact for a different market (it may only be offered as a HYPOTHESIS prior). Findings can be superseded.
 */
const db = require('../db');

async function record(p = {}) {
  const r = await db.query(
    `INSERT INTO marketing_learnings
       (statement, scope, market_id, category, segment, verdict, confidence, attribution_grade,
        supporting_experiment_ids, contradicting_experiment_ids, invalidating_conditions, valid_as_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now())) RETURNING *`,
    [p.statement, p.scope, p.marketId || null, p.category || null, p.segment || null, p.verdict, p.confidence || null,
     p.attributionGrade || null, JSON.stringify(p.supporting || []), JSON.stringify(p.contradicting || []),
     JSON.stringify(p.invalidatingConditions || []), p.validAsOf || null]);
  return r.rows[0];
}

async function supersede(oldId, newId) {
  await db.query('UPDATE marketing_learnings SET superseded_by = $2 WHERE id = $1', [oldId, newId]);
}

// Facts that legitimately apply to the given scope: general always; scoped only when the key MATCHES.
async function retrieveFacts({ marketId = null, category = null, segment = null } = {}, runner = db) {
  const { rows } = await runner.query(
    `SELECT * FROM marketing_learnings
      WHERE superseded_by IS NULL AND verdict IN ('positive','negative') AND (
        scope = 'general'
        OR (scope = 'market_specific'  AND market_id IS NOT DISTINCT FROM $1)
        OR (scope = 'category_specific' AND category IS NOT DISTINCT FROM $2)
        OR (scope = 'segment_specific' AND segment  IS NOT DISTINCT FROM $3)
      )`, [marketId, category, segment]);
  return rows;
}

// Scoped findings from OTHER scopes surfaced as HYPOTHESIS PRIORS (stronger prior, NOT a transferred fact).
async function transferableHypotheses({ marketId = null } = {}, runner = db) {
  const { rows } = await runner.query(
    `SELECT id, statement, scope, market_id, verdict, confidence FROM marketing_learnings
      WHERE superseded_by IS NULL AND scope = 'market_specific' AND verdict = 'positive'
        AND market_id IS DISTINCT FROM $1`, [marketId]);
  return rows.map((r) => ({ ...r, as: 'hypothesis_prior', note: 'scoped finding from another market — a prior, not a fact' }));
}

module.exports = { record, supersede, retrieveFacts, transferableHypotheses };
