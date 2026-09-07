'use strict';

/**
 * marketingObligationEngine — turns an immutable purchase snapshot into machine-trackable fulfillment
 * OBLIGATIONS and governs their lifecycle. Completion is verified by comparing the snapshot's GUARANTEED
 * deliverables against obligation state — a package is NEVER "complete" merely because a campaign object
 * exists. Discretionary tools are tracked as best-effort and never block completion. Non-refundable: there
 * is no credit/refund path; unfulfillable guaranteed work is substituted / made-good / escalated.
 *
 * Lifecycle: planned → creative_ready → scheduled → live → completed
 * Also: substituted | made_good | blocked | needs_owner
 */

const db = require('../db');
const { writeAuditLog } = require('../lib/auditLog');

const TERMINAL_OK = ['completed', 'substituted', 'made_good'];
const VALID_STATES = ['planned', 'creative_ready', 'scheduled', 'live', 'completed', 'substituted', 'made_good', 'blocked', 'needs_owner'];

// Idempotently create obligations from a purchase snapshot. Guaranteed deliverables + discretionary tools
// both become tracked obligations (category distinguishes them). Safe to call more than once (unique key).
async function createFromSnapshot({ purchaseKind, purchaseId, auctionId, guaranteed, discretionary }, runner) {
  const r = runner || db;
  const rows = [];
  const add = async (d, category) => {
    if (!d || !d.key) return;
    const ins = (await r.query(
      `INSERT INTO marketing_obligations (purchase_kind, purchase_id, auction_id, obligation_key, label, category, channel, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'planned')
       ON CONFLICT (purchase_kind, purchase_id, obligation_key) DO NOTHING
       RETURNING *`,
      [purchaseKind, purchaseId, auctionId || null, d.key, d.label || d.key, category, d.channel || 'listing'])).rows[0];
    if (ins) rows.push(ins);
  };
  for (const d of (guaranteed || [])) await add(d, 'guaranteed');
  for (const d of (discretionary || [])) await add(d, 'discretionary');
  return rows;
}

async function listForPurchase(purchaseKind, purchaseId, runner) {
  const r = runner || db;
  return (await r.query(
    `SELECT * FROM marketing_obligations WHERE purchase_kind = $1 AND purchase_id = $2 ORDER BY category, obligation_key`,
    [purchaseKind, purchaseId])).rows;
}

// Transition an obligation with proof. Records an audit entry. Never throws on unknown proof shape.
async function transition(obligationId, newState, { proof, notes, campaignId } = {}, actorId, runner) {
  const r = runner || db;
  if (VALID_STATES.indexOf(newState) === -1) throw new Error('invalid obligation state: ' + newState);
  const row = (await r.query(
    `UPDATE marketing_obligations
        SET state = $2, proof = COALESCE($3::jsonb, proof), notes = COALESCE($4, notes),
            campaign_id = COALESCE($5, campaign_id), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [obligationId, newState, proof ? JSON.stringify(proof) : null, notes || null, campaignId || null])).rows[0];
  if (!row) throw new Error('obligation not found');
  await writeAuditLog({ event_type: 'marketing_obligation_' + newState, entity_type: 'marketing_obligation', entity_id: obligationId,
    actor_id: actorId || null, metadata: { obligation_key: row.obligation_key, state: newState, has_proof: !!proof } });
  return row;
}

// Record a substitution: the original is marked 'substituted' and a NEW obligation of comparable/greater
// value is created linked via substitution_of. Non-refundable resilience — value is preserved, not credited.
async function substitute(originalId, replacement, { reason } = {}, actorId, runner) {
  const r = runner || db;
  const orig = (await r.query(`SELECT * FROM marketing_obligations WHERE id = $1`, [originalId])).rows[0];
  if (!orig) throw new Error('obligation not found');
  await r.query(`UPDATE marketing_obligations SET state='substituted', notes = COALESCE($2, notes), updated_at=now() WHERE id=$1`,
    [originalId, reason || 'substituted for comparable/greater value']);
  const sub = (await r.query(
    `INSERT INTO marketing_obligations (purchase_kind, purchase_id, auction_id, obligation_key, label, category, channel, state, substitution_of, proof)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'planned',$8,$9::jsonb) RETURNING *`,
    [orig.purchase_kind, orig.purchase_id, orig.auction_id, replacement.key || (orig.obligation_key + '_sub'),
     replacement.label || ('Substitute for ' + (orig.label || orig.obligation_key)), orig.category,
     replacement.channel || orig.channel, originalId, JSON.stringify({ reason: reason || null })])).rows[0];
  await writeAuditLog({ event_type: 'marketing_obligation_substituted', entity_type: 'marketing_obligation', entity_id: originalId,
    actor_id: actorId || null, metadata: { replacement_id: sub.id, reason: reason || null } });
  return sub;
}

// Completion check: EVERY guaranteed obligation must be in a terminal-OK state. Discretionary is ignored.
// Returns { complete, guaranteed_total, guaranteed_done, blocked, needs_owner, pending }.
async function evaluateCompletion(purchaseKind, purchaseId, runner) {
  const obligations = await listForPurchase(purchaseKind, purchaseId, runner);
  const guaranteed = obligations.filter((o) => o.category === 'guaranteed');
  const done = guaranteed.filter((o) => TERMINAL_OK.indexOf(o.state) !== -1);
  const blocked = guaranteed.filter((o) => o.state === 'blocked');
  const needsOwner = guaranteed.filter((o) => o.state === 'needs_owner');
  return {
    complete: guaranteed.length > 0 && done.length === guaranteed.length,
    guaranteed_total: guaranteed.length,
    guaranteed_done: done.length,
    blocked: blocked.length,
    needs_owner: needsOwner.length,
    pending: guaranteed.length - done.length,
  };
}

module.exports = { createFromSnapshot, listForPurchase, transition, substitute, evaluateCompletion, TERMINAL_OK, VALID_STATES };
