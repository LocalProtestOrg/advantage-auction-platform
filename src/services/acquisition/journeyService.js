'use strict';

/**
 * journeyService — exactly one acquisition journey per company.
 *
 * Journeys: CLAIMED_LISTING (directory listings), EVENT_PARTNER (authorization invited or beyond),
 * SALES_DIRECT (rep-led). A professional seller has no acquisition journey: it is a customer.
 *
 * The effective journey is the persisted active assignment when one exists, otherwise the journey the
 * company's records imply (companyIdentityService.deriveJourney). Assignment is idempotent; the partial
 * unique index uq_one_active_journey makes two active journeys impossible.
 *
 * Releasing or moving a journey is a Super Admin action (listings.manage_journey), requires a written
 * reason, and is audited.
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');

const JOURNEYS = ['CLAIMED_LISTING', 'EVENT_PARTNER', 'SALES_DIRECT'];

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

async function activeFor(companyId, runner = db) {
  if (!companyId) return null;
  return (await runner.query(
    `SELECT * FROM acquisition_journey_assignments WHERE company_id = $1 AND status = 'active'`, [companyId])).rows[0] || null;
}

/** Assign a journey when the company has none active. Returns { assigned, existing }. */
async function assign(companyId, journey, { reason, actorId = null } = {}, runner = db) {
  if (!JOURNEYS.includes(journey)) throw err(400, 'JOURNEY_INVALID', 'Unknown journey.');
  if (!reason) throw err(400, 'REASON_REQUIRED', 'A reason is required.');
  const r = await runner.query(
    `INSERT INTO acquisition_journey_assignments (company_id, journey, reason, assigned_by)
     SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM acquisition_journey_assignments WHERE company_id = $1 AND status = 'active')
     RETURNING *`, [companyId, journey, reason, actorId]);
  return { assigned: r.rows[0] || null, existing: r.rows[0] ? null : await activeFor(companyId, runner) };
}

/**
 * Release the active journey and optionally assign another. Super Admin only (the route enforces the
 * permission; this function enforces the reason and the audit). Atomic.
 */
async function move(companyId, { toJourney = null, reason, actorId } = {}) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An acting administrator is required.');
  if (!reason || String(reason).trim().length < 5) throw err(400, 'REASON_REQUIRED', 'A written reason is required.');
  if (toJourney && !JOURNEYS.includes(toJourney)) throw err(400, 'JOURNEY_INVALID', 'Unknown journey.');
  return withTransaction(async (client) => {
    const cur = (await client.query(
      `SELECT * FROM acquisition_journey_assignments WHERE company_id = $1 AND status = 'active' FOR UPDATE`, [companyId])).rows[0] || null;
    if (cur) {
      await client.query(
        `UPDATE acquisition_journey_assignments SET status = 'released', released_at = now(), released_by = $2, release_reason = $3 WHERE id = $1`,
        [cur.id, actorId, String(reason).trim()]);
    }
    let next = null;
    if (toJourney) {
      next = (await client.query(
        `INSERT INTO acquisition_journey_assignments (company_id, journey, reason, assigned_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [companyId, toJourney, String(reason).trim(), actorId])).rows[0];
    }
    // A journey change stops any automated listing sequence for the company immediately.
    await client.query(
      `UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = 'journey_change', next_send_at = NULL, updated_at = now()
        WHERE company_id = $1 AND state IN ('queued','active','paused','dormant')`, [companyId]);
    await auditService.logEvent(client, {
      eventType: 'acquisition.journey_changed', entityType: 'company_identity', entityId: companyId, actorId,
      metadata: { from: cur ? cur.journey : null, to: toJourney, reason: String(reason).trim() },
    });
    return { released: cur, assigned: next };
  });
}

/**
 * Effective journey for a cluster from companyIdentityService.snapshot(). Pure.
 */
function effective(cluster) {
  if (!cluster) return { journey: null, source: 'none', reason: 'no company record' };
  return { journey: cluster.journey || null, source: cluster.journey_source || 'derived', reason: cluster.journey_reason || null };
}

module.exports = { JOURNEYS, activeFor, assign, move, effective };
