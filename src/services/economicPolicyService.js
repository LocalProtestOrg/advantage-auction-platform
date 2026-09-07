'use strict';

/**
 * economicPolicyService — CONFIDENTIAL versioned economic-policy registry. Stores the internal
 * direct-fulfillment ceiling (60% = 6000 bps at launch) with effective dates and immutable history. The
 * seller MUST NEVER see any of this. A purchase freezes the applicable policy version + derives its
 * internal authority ceiling from ACTUAL amount paid × snapshotted bps. Future policy changes create a NEW
 * version (never rewrite history). Mirrors — and coexists with — the existing marketing.direct_spend_max_bps
 * config (mig 126) without disturbing the live internal ledger.
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

class EconomicPolicyError extends Error {
  constructor(message, status = 400, code = 'ECON_POLICY_ERROR') { super(message); this.status = status; this.code = code; }
}

// The active policy at a point in time (latest active, effective_from <= at, not yet ended).
async function activePolicy(at, runner) {
  const r = runner || db;
  const when = at ? new Date(at) : new Date();
  const row = (await r.query(
    `SELECT * FROM marketing_economic_policies
      WHERE is_active = true AND effective_from <= $1 AND (effective_to IS NULL OR effective_to > $1)
      ORDER BY effective_from DESC LIMIT 1`, [when])).rows[0];
  return row || null;
}

async function getByVersion(policyVersion, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_economic_policies WHERE policy_version = $1`, [policyVersion])).rows[0] || null;
}

async function list(runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_economic_policies ORDER BY effective_from DESC`)).rows;
}

// Pure: derive the internal authority ceiling from actual amount paid × bps. Never seller-facing.
function deriveAuthorityCents(amountPaidCents, directFulfillmentBps) {
  const amt = Math.max(0, Math.trunc(Number(amountPaidCents) || 0));
  const bps = Math.max(0, Math.min(10000, Math.trunc(Number(directFulfillmentBps) || 0)));
  return Math.floor(amt * bps / 10000);
}

// Create a NEW policy version (never mutates history). Audited (confidential metadata).
async function createPolicy({ policy_version, direct_fulfillment_bps, effective_from, notes }, actorId, runner) {
  const r = runner || db;
  const bps = Math.trunc(Number(direct_fulfillment_bps));
  if (!policy_version) throw new EconomicPolicyError('policy_version required', 400, 'MISSING_VERSION');
  if (!Number.isFinite(bps) || bps < 0 || bps > 10000) throw new EconomicPolicyError('direct_fulfillment_bps must be 0..10000', 400, 'INVALID_BPS');
  const row = (await r.query(
    `INSERT INTO marketing_economic_policies (policy_version, direct_fulfillment_bps, effective_from, notes, created_by)
     VALUES ($1,$2,COALESCE($3, now()),$4,$5) RETURNING *`,
    [policy_version, bps, effective_from || null, notes || null, actorId || null])).rows[0];
  await writeAuditLog({ event_type: 'marketing_economic_policy_created', entity_type: 'marketing_economic_policy', entity_id: row.id,
    actor_id: actorId || null, metadata: { policy_version, direct_fulfillment_bps: bps } });
  return row;
}

// Resolve the frozen policy inputs for a purchase: prefer the version named on the package version, else the
// active policy. Returns { policy_version, direct_fulfillment_bps }.
async function resolveForPurchase(preferredVersion, at, runner) {
  let p = preferredVersion ? await getByVersion(preferredVersion, runner) : null;
  if (!p || p.is_active === false) p = await activePolicy(at, runner);
  if (!p) throw new EconomicPolicyError('No active economic policy', 500, 'NO_POLICY');
  return { policy_version: p.policy_version, direct_fulfillment_bps: p.direct_fulfillment_bps };
}

module.exports = { activePolicy, getByVersion, list, deriveAuthorityCents, createPolicy, resolveForPurchase, EconomicPolicyError };
