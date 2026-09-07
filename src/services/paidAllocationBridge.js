'use strict';

/**
 * paidAllocationBridge — connects a purchase's snapshotted INTERNAL AUTHORITY (actual paid × confidential
 * policy %) to a durable reserve/spend/release/reconcile ledger (mig 142), mirroring the Marketing Agency
 * economics separation (mig 126: no seller identity; internal money only). The 60% direct-fulfillment figure
 * is a CONFIDENTIAL, versioned CEILING — never a target, never seller-facing. reserved+spent can NEVER
 * exceed the ceiling (DB CHECK + conditional updates + idempotent entries). Google/Meta stay OFF; this
 * bridge NEVER activates a paid provider.
 */

const db = require('../db');

// Authority ceiling frozen on the purchase snapshot.
async function authorityFor(purchaseId, runner) {
  const r = runner || db;
  let p = (await r.query(`SELECT internal_authority_cents, direct_fulfillment_bps, economic_policy_version FROM marketing_package_purchases WHERE id=$1`, [purchaseId])).rows[0];
  let kind = 'package';
  if (!p) { p = (await r.query(`SELECT internal_authority_cents, direct_fulfillment_bps, economic_policy_version FROM marketing_additional_promotions WHERE id=$1`, [purchaseId])).rows[0]; kind = 'additional_promotion'; }
  if (!p) return null;
  return { kind, ceiling_cents: p.internal_authority_cents, direct_fulfillment_bps: p.direct_fulfillment_bps, policy_version: p.economic_policy_version };
}

function canAuthorize(ceilingCents, committedCents, requestCents) {
  const ceiling = Math.max(0, Math.trunc(Number(ceilingCents) || 0));
  const committed = Math.max(0, Math.trunc(Number(committedCents) || 0));
  const req = Math.max(0, Math.trunc(Number(requestCents) || 0));
  return committed + req <= ceiling;
}

// Idempotently create the per-purchase balance row from the snapshot ceiling.
async function ensureAllocation(purchaseId, runner) {
  const r = runner || db;
  const auth = await authorityFor(purchaseId, r);
  if (!auth) return null;
  await r.query(
    `INSERT INTO marketing_paid_allocations (purchase_kind, purchase_id, ceiling_cents, policy_version)
     VALUES ($1,$2,$3,$4) ON CONFLICT (purchase_kind, purchase_id) DO NOTHING`,
    [auth.kind, purchaseId, auth.ceiling_cents, auth.policy_version || 'v1']);
  return (await r.query(`SELECT * FROM marketing_paid_allocations WHERE purchase_id=$1`, [purchaseId])).rows[0];
}

async function getBalance(purchaseId, runner) {
  const r = runner || db;
  return (await r.query(`SELECT * FROM marketing_paid_allocations WHERE purchase_id=$1`, [purchaseId])).rows[0] || null;
}

// Reserve authority. Refuses if it would exceed the ceiling. Idempotent per idempotencyKey. Never
// seller-visible. Returns { ok, balance } or { ok:false, reason }.
async function reserve(purchaseId, amountCents, idempotencyKey, { providerRef, campaignRef } = {}, runner) {
  const r = runner || db;
  const bal = await ensureAllocation(purchaseId, r);
  if (!bal) return { ok: false, reason: 'no authority record' };
  if (!canAuthorize(bal.ceiling_cents, bal.reserved_cents + bal.spent_cents, amountCents)) return { ok: false, reason: 'exceeds internal authority ceiling', ceiling_cents: bal.ceiling_cents };
  const ins = await r.query(
    `INSERT INTO marketing_paid_allocation_entries (purchase_kind, purchase_id, entry_type, amount_cents, provider_ref, campaign_ref, idempotency_key)
     VALUES ($1,$2,'RESERVE',$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [bal.purchase_kind, purchaseId, Math.trunc(amountCents), providerRef || null, campaignRef || null, idempotencyKey]);
  if (!ins.rows[0]) return { ok: true, balance: bal, idempotent_replay: true };
  const updated = (await r.query(
    `UPDATE marketing_paid_allocations SET reserved_cents = reserved_cents + $2, updated_at=now()
      WHERE purchase_kind=$1 AND purchase_id=$3 AND reserved_cents + spent_cents + $2 <= ceiling_cents RETURNING *`,
    [bal.purchase_kind, Math.trunc(amountCents), purchaseId])).rows[0];
  return updated ? { ok: true, balance: updated } : { ok: false, reason: 'ceiling race' };
}

// Convert a reservation to actual spend (records provider/campaign reference).
async function spend(purchaseId, amountCents, idempotencyKey, { providerRef, campaignRef } = {}, runner) {
  const r = runner || db;
  const bal = await getBalance(purchaseId, r);
  if (!bal) return { ok: false, reason: 'no allocation' };
  const ins = await r.query(
    `INSERT INTO marketing_paid_allocation_entries (purchase_kind, purchase_id, entry_type, amount_cents, provider_ref, campaign_ref, idempotency_key)
     VALUES ($1,$2,'SPEND',$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [bal.purchase_kind, purchaseId, Math.trunc(amountCents), providerRef || null, campaignRef || null, idempotencyKey]);
  if (!ins.rows[0]) return { ok: true, balance: bal, idempotent_replay: true };
  const updated = (await r.query(
    `UPDATE marketing_paid_allocations SET reserved_cents = GREATEST(0, reserved_cents - $2), spent_cents = spent_cents + $2, updated_at=now()
      WHERE purchase_kind=$1 AND purchase_id=$3 RETURNING *`,
    [bal.purchase_kind, Math.trunc(amountCents), purchaseId])).rows[0];
  return { ok: true, balance: updated };
}

// Release unused reserved authority back to the ceiling (unused-authority behavior).
async function release(purchaseId, amountCents, idempotencyKey, runner) {
  const r = runner || db;
  const bal = await getBalance(purchaseId, r);
  if (!bal) return { ok: false, reason: 'no allocation' };
  const ins = await r.query(
    `INSERT INTO marketing_paid_allocation_entries (purchase_kind, purchase_id, entry_type, amount_cents, idempotency_key)
     VALUES ($1,$2,'RELEASE',$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [bal.purchase_kind, purchaseId, Math.trunc(amountCents), idempotencyKey]);
  if (!ins.rows[0]) return { ok: true, balance: bal, idempotent_replay: true };
  const updated = (await r.query(
    `UPDATE marketing_paid_allocations SET reserved_cents = GREATEST(0, reserved_cents - $2), released_cents = released_cents + $2, updated_at=now()
      WHERE purchase_kind=$1 AND purchase_id=$3 RETURNING *`,
    [bal.purchase_kind, Math.trunc(amountCents), purchaseId])).rows[0];
  return { ok: true, balance: updated };
}

// Reconcile: entries must sum consistently with the balance. Returns a report (internal only).
async function reconcile(purchaseId, runner) {
  const r = runner || db;
  const bal = await getBalance(purchaseId, r);
  if (!bal) return { ok: false, reason: 'no allocation' };
  const sums = (await r.query(
    `SELECT entry_type, COALESCE(SUM(amount_cents),0)::int s FROM marketing_paid_allocation_entries WHERE purchase_id=$1 GROUP BY entry_type`, [purchaseId])).rows;
  const by = Object.fromEntries(sums.map((x) => [x.entry_type, x.s]));
  const consistent = (by.SPEND || 0) === bal.spent_cents && (by.RELEASE || 0) === bal.released_cents
    && (bal.reserved_cents + bal.spent_cents) <= bal.ceiling_cents;
  return { ok: true, consistent, balance: bal, entry_sums: by };
}

module.exports = { authorityFor, canAuthorize, ensureAllocation, getBalance, reserve, spend, release, reconcile };
