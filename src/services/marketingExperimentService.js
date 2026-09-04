'use strict';

/**
 * marketingExperimentService — the experimentation framework (hypothesis contract). The Agency ORIGINATES
 * and evaluates its own hypotheses; ideas are NOT hard-coded. An experiment within existing authority +
 * policy needs no Owner approval; only a change to AUTHORITY does. A budgeted experiment is "within
 * authority" only if proposed by a spend-capable agent (A1/A8) — actual spend is still gated by the
 * Growth Pool + monthly authority at run time (marketingLedgerService), never bypassed here.
 */
const db = require('../db');
const agents = require('../constants/marketingAgents');

async function propose(p = {}) {
  if (!p.hypothesis || !String(p.hypothesis).trim()) { const e = new Error('A hypothesis is required.'); e.code = 'INVALID'; throw e; }
  const agent = String(p.proposedByAgent || '').toUpperCase();
  if (!agents.agentCan(agent, 'propose_experiment') && !agents.agentCan(agent, 'propose_paid')) {
    const e = new Error('Agent ' + agent + ' is not authorized to propose experiments.'); e.code = 'FORBIDDEN'; throw e;
  }
  const budget = Math.max(0, Math.trunc(Number(p.budgetCents) || 0));
  // Within authority: unfunded → always; funded → only a spend-capable agent (A1/A8). Otherwise it needs
  // Owner approval before it may run (within_authority=false).
  const withinAuthority = budget === 0 || agents.canSpend(agent);
  const r = await db.query(
    `INSERT INTO marketing_experiments
       (hypothesis, objective, campaign_class, audience, market_id, channels, proposed_by_agent, rationale,
        primary_metric, secondary_metrics, expected_outcome, budget_cents, starts_at, review_at, within_authority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [p.hypothesis, p.objective || null, p.campaignClass || null, p.audience || null, p.marketId || null,
     JSON.stringify(p.channels || []), agent, p.rationale || null, p.primaryMetric || null,
     JSON.stringify(p.secondaryMetrics || []), p.expectedOutcome || null, budget, p.startsAt || null,
     p.reviewAt || null, withinAuthority]);
  return r.rows[0];
}

// Record a decision (expand/repeat/modify/pause/abandon) + observations + evidence strength. Auditable.
async function decide(id, { decision, observations = null, confidence = null } = {}) {
  const ok = ['expand', 'repeat', 'modify', 'pause', 'abandon'];
  if (ok.indexOf(decision) === -1) { const e = new Error('Invalid decision.'); e.code = 'INVALID'; throw e; }
  const status = decision === 'abandon' ? 'abandoned' : 'decided';
  const r = await db.query(
    `UPDATE marketing_experiments SET decision = $2, observations = $3, confidence = $4, status = $5, updated_at = now()
      WHERE id = $1 RETURNING *`, [id, decision, observations, confidence, status]);
  return r.rows[0] || null;
}

module.exports = { propose, decide };
