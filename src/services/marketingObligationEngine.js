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
  let contract; try { contract = require('./phase3oContract'); } catch (_) { contract = null; }
  const add = async (d, category) => {
    if (!d || !d.key) return;
    // Enrich from the Phase 3O feature catalogue (authoritative): feature_key, ladder_id, wave, channel.
    const feat = contract ? contract.featureByKey(d.key) : null;
    const channel = (feat && String(feat.channel || '').toLowerCase()) || d.channel || 'listing';
    const ins = (await r.query(
      `INSERT INTO marketing_obligations (purchase_kind, purchase_id, auction_id, obligation_key, feature_key, label, category, channel, ladder_id, wave, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned')
       ON CONFLICT (purchase_kind, purchase_id, obligation_key) DO NOTHING
       RETURNING *`,
      [purchaseKind, purchaseId, auctionId || null, d.key, (feat && feat.feature_key) || d.key, d.label || (feat && feat.seller_label) || d.key,
       category, channel, (feat && feat.ladder) || 'none', (feat && feat.wave) || 'ANY'])).rows[0];
    if (ins) { rows.push(ins); await appendEvent(r, ins.id, null, 'planned', { reason: 'created from snapshot', evidence: { feature_key: ins.feature_key } }); }
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

// Append an immutable state-history event (never rewritten).
async function appendEvent(r, obligationId, fromState, toState, { rung, reason, evidence, shadow, actor } = {}) {
  await r.query(
    `INSERT INTO marketing_obligation_events (obligation_id, from_state, to_state, rung, reason, evidence, shadow, actor)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [obligationId, fromState || null, toState, rung || null, reason || null, JSON.stringify(evidence || {}), !!shadow, actor || 'runtime']).catch(() => {});
}

// Transition an obligation with proof + append-only history. TERMINAL states (completed/substituted/
// made_good) are immutable — a transition OUT of them is rejected. `shadow:true` marks certification-only
// evidence (never counts as real seller fulfillment).
async function transition(obligationId, newState, { proof, notes, campaignId, rung, reason, shadow } = {}, actorId, runner) {
  const r = runner || db;
  if (VALID_STATES.indexOf(newState) === -1) throw new Error('invalid obligation state: ' + newState);
  const cur = (await r.query(`SELECT state FROM marketing_obligations WHERE id = $1`, [obligationId])).rows[0];
  if (!cur) throw new Error('obligation not found');
  if (TERMINAL_OK.indexOf(cur.state) !== -1) throw new Error('terminal obligation is immutable: ' + cur.state);
  const isTerminal = TERMINAL_OK.indexOf(newState) !== -1;
  const row = (await r.query(
    `UPDATE marketing_obligations
        SET state = $2, previous_state = state, proof = COALESCE($3::jsonb, proof), notes = COALESCE($4, notes),
            campaign_id = COALESCE($5, campaign_id), terminal_at = CASE WHEN $6 THEN now() ELSE terminal_at END, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [obligationId, newState, proof ? JSON.stringify(proof) : null, notes || null, campaignId || null, isTerminal])).rows[0];
  await appendEvent(r, obligationId, cur.state, newState, { rung, reason, evidence: proof, shadow, actor: actorId || 'runtime' });
  await writeAuditLog({ event_type: 'marketing_obligation_' + newState, entity_type: 'marketing_obligation', entity_id: obligationId,
    actor_id: actorId || null, metadata: { obligation_key: row.obligation_key, state: newState, has_proof: !!proof, shadow: !!shadow } });
  return row;
}

// BLOCKED: an auto-re-checkable precondition is unavailable. Records reason, previous state, retry cadence,
// deadline, attempt count. The monitor re-checks automatically; it must not silently age past the window.
async function block(obligationId, { reason, retryAfter, deadline } = {}, runner) {
  const r = runner || db;
  const cur = (await r.query(`SELECT state FROM marketing_obligations WHERE id=$1`, [obligationId])).rows[0];
  if (!cur) throw new Error('obligation not found');
  if (TERMINAL_OK.indexOf(cur.state) !== -1) throw new Error('terminal obligation is immutable');
  const row = (await r.query(
    `UPDATE marketing_obligations
        SET state='blocked', previous_state=state, blocked_reason=$2, retry_after=$3, deadline_at=COALESCE($4, deadline_at),
            attempts=attempts+1, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [obligationId, reason || 'precondition unavailable', retryAfter || new Date(Date.now() + 3600000), deadline || null])).rows[0];
  await appendEvent(r, obligationId, cur.state, 'blocked', { reason, evidence: { retry_after: retryAfter, deadline } });
  return row;
}

// NEEDS_OWNER: the automatic fulfillment ladder is exhausted (or an Owner-reserved decision). Carries full
// options + reason + deadline; fires the CERTIFIED Admin Action Required SMS. Never auto-ages into completion.
async function needsOwner(obligationId, { reason, options, deadline, auctionId } = {}, runner) {
  const r = runner || db;
  const cur = (await r.query(`SELECT state, auction_id, purchase_id, purchase_kind FROM marketing_obligations WHERE id=$1`, [obligationId])).rows[0];
  if (!cur) throw new Error('obligation not found');
  if (TERMINAL_OK.indexOf(cur.state) !== -1) throw new Error('terminal obligation is immutable');
  const row = (await r.query(
    `UPDATE marketing_obligations
        SET state='needs_owner', previous_state=state, needs_owner_reason=$2, needs_owner_options=$3::jsonb, deadline_at=COALESCE($4, deadline_at), updated_at=now()
      WHERE id=$1 RETURNING *`,
    [obligationId, reason || 'automation exhausted', JSON.stringify(options || []), deadline || null])).rows[0];
  await appendEvent(r, obligationId, cur.state, 'needs_owner', { reason, evidence: { options: options || [] } });
  // Certified multi-recipient Owner SMS — a TRUE package exception requiring Owner/Admin intervention.
  try {
    const oa = require('./ownerAlertService');
    await oa.notifyAdminActionRequired({
      actionType: 'marketing_package_exception',
      entityType: 'marketing_obligation', entityId: obligationId,
      headline: 'Marketing package needs your decision',
      context: (reason || 'A guaranteed marketing item needs an Owner decision.').slice(0, 90),
      adminPath: '/admin/marketing-packages.html', adminId: cur.purchase_id, adminParam: 'purchase',
      actionLabel: 'Resolve',
    });
  } catch (e) { console.error('[obligation] needs_owner SMS failed:', e.message); }
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

module.exports = { createFromSnapshot, listForPurchase, transition, block, needsOwner, appendEvent, substitute, evaluateCompletion, TERMINAL_OK, VALID_STATES };
