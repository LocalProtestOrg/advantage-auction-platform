'use strict';

/**
 * directorDecisionService — persists the Marketing Director's BOUNDED decisions (Phase 3O §6/§14). Only the
 * allowed decision set is accepted; prohibited decisions (refund, package refusal on capacity, hiding,
 * repricing, entitlement alteration, suppression override, manufactured audience, economic-policy mutation)
 * are structurally rejected. Each decision carries an inputs_hash (snapshot + config + readiness + health)
 * for replay, the remaining internal authority, an INTERNAL evidence_line (never seller-rendered), and its
 * outputs. Records are append-only.
 */

const crypto = require('crypto');
const db = require('../db');

const ALLOWED = ['PLAN', 'SELECT_DISCRETIONARY', 'SCHEDULE', 'SCOPE_AUDIENCE', 'ADJUST', 'RUNG_ADVANCE', 'UPSELL_PROMPT', 'ESCALATE'];
// Explicitly prohibited — even if a caller asks, these can never be recorded (defense in depth).
const PROHIBITED = ['REFUND', 'REFUSE_CAPACITY', 'HIDE', 'REPRICE', 'ALTER_ENTITLEMENT', 'OVERRIDE_SUPPRESSION', 'MANUFACTURE_AUDIENCE', 'MUTATE_POLICY'];

class DirectorDecisionError extends Error { constructor(m, code) { super(m); this.status = 422; this.code = code || 'INVALID_DECISION'; } }

function isAllowed(kind) { return ALLOWED.indexOf(String(kind || '').toUpperCase()) !== -1; }

// Deterministic replay hash of the authoritative inputs.
function inputsHash(inputs) {
  return crypto.createHash('sha256').update(JSON.stringify(inputs || {})).digest('hex').slice(0, 32);
}

// Record a bounded decision. Rejects prohibited/unknown kinds. Returns the persisted row.
async function record({ kind, purchaseId, obligationIds, inputs, authorityCentsRemaining, evidenceLine, outputs }, runner) {
  const r = runner || db;
  const k = String(kind || '').toUpperCase();
  if (PROHIBITED.indexOf(k) !== -1) throw new DirectorDecisionError('Prohibited Director decision: ' + k, 'PROHIBITED');
  if (!isAllowed(k)) throw new DirectorDecisionError('Unknown/unbounded Director decision: ' + k, 'UNBOUNDED');
  if (!purchaseId) throw new DirectorDecisionError('purchaseId required', 'MISSING_PURCHASE');
  const decisionId = 'dd_' + crypto.randomBytes(8).toString('hex');
  const hash = inputsHash(inputs);
  const row = (await r.query(
    `INSERT INTO marketing_director_decisions (decision_id, kind, purchase_id, obligation_ids, inputs_hash, authority_cents_remaining, evidence_line, outputs)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb)
     ON CONFLICT (decision_id) DO NOTHING RETURNING *`,
    [decisionId, k, String(purchaseId), JSON.stringify(obligationIds || []), hash, Math.max(0, Math.trunc(Number(authorityCentsRemaining) || 0)),
     (evidenceLine || 'director decision').slice(0, 500), JSON.stringify(outputs || {})])).rows[0];
  return row;
}

async function listForPurchase(purchaseId, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_director_decisions WHERE purchase_id=$1 ORDER BY created_at ASC`, [purchaseId])).rows;
}

module.exports = { ALLOWED, PROHIBITED, isAllowed, inputsHash, record, listForPurchase, DirectorDecisionError };
