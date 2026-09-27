'use strict';

/**
 * outreachHoldService — a manual hold on Claimed Listing outreach for one listing, pending contact verification.
 *
 * Used when the contact details on a listing look wrong (for example an email address and website that belong to
 * other businesses). The hold is NOT a suppression and NOT an unsubscribe: the listing, its directory record and any
 * prospect record are untouched, and nothing is sent to anyone. While held, the eligibility screen returns
 * REVIEW_DATA_QUALITY for the listing, so it is never proposed for a cohort, cannot be put back into one, and fails
 * the send-time eligibility gate of any cohort it is already in.
 *
 * Stored in organizations.profile_data.outreach_hold (the directory sync never writes profile_data). Placing a hold is
 * a listings.work action; releasing it is a Super Admin action (listings.manage_journey) that records who verified
 * the contact and how. Both are audited and logged on the company timeline.
 */

const db = require('../../db');
const auditService = require('../auditService');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

/** The hold on a listing row (reads profile_data), or null when there is no active hold. Pure. */
function activeHold(org) {
  const h = org && org.profile_data && org.profile_data.outreach_hold;
  return h && h.held === true ? h : null;
}

async function note(runner, organizationId, actorId, subject, body, meta) {
  await runner.query(
    `INSERT INTO organization_activity (organization_id, activity_type, channel, direction, actor_id, subject, body, metadata)
     VALUES ($1,'note','note','internal',$2,$3,$4,$5::jsonb)`,
    [organizationId, actorId, subject, body, JSON.stringify(Object.assign({ via: 'outreach_hold' }, meta || {}))]);
}

/** Place (or refresh) a hold. Idempotent. Pauses any live sequence for the listing. */
async function place(organizationId, { actorId = null, reason, requestedBy = null }, runner = db) {
  const why = String(reason || '').trim();
  if (why.length < 10) throw err(400, 'REASON_REQUIRED', 'Say why outreach to this listing is on hold.');
  const hold = { held: true, reason: why.slice(0, 500), placed_at: new Date().toISOString(), placed_by: actorId, requested_by: requestedBy,
    release_requires: 'an administrator verifies the contact details and releases the hold' };
  const r = (await runner.query(
    `UPDATE organizations SET profile_data = COALESCE(profile_data,'{}'::jsonb) || jsonb_build_object('outreach_hold', $2::jsonb)
      WHERE id = $1 RETURNING id, name`, [organizationId, JSON.stringify(hold)])).rows[0];
  if (!r) throw err(404, 'NOT_FOUND', 'Listing not found.');
  const paused = await runner.query(
    `UPDATE listing_outreach_sequences SET state = 'paused', stop_reason = 'outreach_hold', updated_at = now()
      WHERE organization_id = $1 AND state IN ('queued','active')`, [organizationId]);
  await note(runner, organizationId, actorId, 'Outreach hold placed', why.slice(0, 2000), { requested_by: requestedBy });
  await auditService.logEvent(runner, { eventType: 'claimed_listing.outreach_hold_placed', entityType: 'organization', entityId: organizationId, actorId,
    metadata: { reason: why.slice(0, 500), requested_by: requestedBy, sequences_paused: paused.rowCount } });
  await require('./eligibilityService').rescreen(organizationId, runner);
  return { organization_id: r.id, name: r.name, hold };
}

/** Release a hold after the contact details were verified (Super Admin). Does not queue or send anything. */
async function release(organizationId, { actorId, verification }, runner = db) {
  if (!actorId) throw err(401, 'ACTOR_REQUIRED', 'An administrator must release the hold.');
  const how = String(verification || '').trim();
  if (how.length < 10) throw err(400, 'VERIFICATION_REQUIRED', 'Record how the contact details were verified.');
  const o = (await runner.query(`SELECT id, name, profile_data FROM organizations WHERE id = $1`, [organizationId])).rows[0];
  if (!o) throw err(404, 'NOT_FOUND', 'Listing not found.');
  const h = activeHold(o);
  if (!h) throw err(409, 'NO_HOLD', 'This listing has no outreach hold.');
  const released = Object.assign({}, h, { held: false, released_at: new Date().toISOString(), released_by: actorId, verification: how.slice(0, 500) });
  await runner.query(`UPDATE organizations SET profile_data = COALESCE(profile_data,'{}'::jsonb) || jsonb_build_object('outreach_hold', $2::jsonb) WHERE id = $1`,
    [organizationId, JSON.stringify(released)]);
  await note(runner, organizationId, actorId, 'Outreach hold released', how.slice(0, 2000));
  await auditService.logEvent(runner, { eventType: 'claimed_listing.outreach_hold_released', entityType: 'organization', entityId: organizationId, actorId,
    metadata: { verification: how.slice(0, 500), held_since: h.placed_at, hold_reason: h.reason } });
  await require('./eligibilityService').rescreen(organizationId, runner);
  return { organization_id: o.id, name: o.name, hold: released };
}

module.exports = { activeHold, place, release };
