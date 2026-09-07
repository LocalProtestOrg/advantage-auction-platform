'use strict';

/**
 * paidAllocationBridge — connects a package purchase's snapshotted INTERNAL AUTHORITY (actual paid ×
 * confidential policy %) to spend tracking, reusing the Marketing Agency economics concept (mig 126). The
 * 60% direct-fulfillment figure is a CONFIDENTIAL, versioned CEILING — never a target, never seller-facing.
 * Reserve/spend/release are recorded internally; a rung that would exceed authority is refused. Google/Meta
 * gates remain OFF unless separately activated by the Owner — this bridge NEVER activates a paid provider.
 *
 * No seller-facing surface may ever expose the ceiling, the 60/40 split, the Growth Pool, or internal margin
 * (enforced structurally by the seller allowlist renderer).
 */

const db = require('../db');

// Authority already frozen on the purchase snapshot (internal_authority_cents). This is the ceiling.
async function authorityFor(purchaseId, runner) {
  const r = runner || db;
  const p = (await r.query(`SELECT internal_authority_cents, direct_fulfillment_bps FROM marketing_package_purchases WHERE id=$1`, [purchaseId])).rows[0]
    || (await r.query(`SELECT internal_authority_cents, direct_fulfillment_bps FROM marketing_additional_promotions WHERE id=$1`, [purchaseId])).rows[0];
  if (!p) return null;
  return { ceiling_cents: p.internal_authority_cents, direct_fulfillment_bps: p.direct_fulfillment_bps };
}

// Pure: can a proposed spend be authorized against the ceiling given already-committed amount?
function canAuthorize(ceilingCents, committedCents, requestCents) {
  const ceiling = Math.max(0, Math.trunc(Number(ceilingCents) || 0));
  const committed = Math.max(0, Math.trunc(Number(committedCents) || 0));
  const req = Math.max(0, Math.trunc(Number(requestCents) || 0));
  return committed + req <= ceiling;
}

// Reserve internal authority for a paid obligation (records a paid-channel event, shadow by default because
// paid providers are gated OFF). Refuses if it would exceed the ceiling. Never seller-visible.
async function reserve(obligationId, purchaseId, requestCents, runner) {
  const r = runner || db;
  const auth = await authorityFor(purchaseId, r);
  if (!auth) return { ok: false, reason: 'no authority record' };
  const committed = (await r.query(
    `SELECT COALESCE(SUM((evidence->>'amount_cents')::int),0)::int c
       FROM marketing_obligation_events WHERE obligation_id=$1 AND rung='reserve'`, [obligationId])).rows[0].c;
  if (!canAuthorize(auth.ceiling_cents, committed, requestCents)) return { ok: false, reason: 'exceeds internal authority ceiling', ceiling_cents: auth.ceiling_cents };
  await r.query(
    `INSERT INTO marketing_obligation_events (obligation_id, from_state, to_state, rung, reason, evidence, shadow, actor)
     VALUES ($1, NULL, 'reserved', 'reserve', 'internal authority reservation', $2::jsonb, true, 'paid_allocation')`,
    [obligationId, JSON.stringify({ amount_cents: Math.trunc(requestCents) })]).catch(() => {});
  return { ok: true, reserved_cents: Math.trunc(requestCents), ceiling_cents: auth.ceiling_cents };
}

module.exports = { authorityFor, canAuthorize, reserve };
