'use strict';

/**
 * crmActivityService — append-only CRM/communication timeline (Phase 3C.1).
 * Tracking-first: records outreach via ANY channel (email/phone/sms/meeting/mail/note/other).
 * The unified timeline unions organization_activity (human/outreach) with audit_log (platform).
 */

const db = require('../db');

async function log(orgId, opts = {}) {
  const {
    activityType = 'note', channel = null, direction = 'internal',
    actorId = null, subject = null, body = null, metadata = {}, occurredAt = null,
  } = opts;
  const { rows } = await db.query(
    `INSERT INTO organization_activity (organization_id, activity_type, channel, direction, actor_id, subject, body, metadata, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9, now())) RETURNING *`,
    [orgId, activityType, channel, direction, actorId, subject, body, JSON.stringify(metadata || {}), occurredAt]);
  if (activityType === 'outreach') {
    await db.query('UPDATE organizations SET last_contacted_at = now() WHERE id = $1', [orgId]);
  }
  return rows[0];
}

/** Unified reverse-chronological timeline: CRM activity + platform audit events. */
async function timeline(orgId, limit = 100) {
  const { rows } = await db.query(`
    SELECT 'activity' AS kind, activity_type AS type, channel, direction, actor_id, subject, body, occurred_at AS at
      FROM organization_activity WHERE organization_id = $1
    UNION ALL
    SELECT 'audit' AS kind, event_type AS type, NULL, 'internal', actor_id, NULL, NULL, created_at AS at
      FROM audit_log WHERE entity_type = 'organization' AND entity_id = $1
    ORDER BY at DESC LIMIT $2`, [orgId, limit]);
  return rows;
}

module.exports = { log, timeline };
