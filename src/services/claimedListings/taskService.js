'use strict';

/**
 * listing_tasks — where the Claimed Listing programme hands work to a PERSON.
 *
 * No automatic reply to a human, ever: a real reply, a help request, a removal, a dispute, a wrong
 * contact, a Tier A call, a stalled activation or Professional Seller interest becomes a task. Replies,
 * help requests and disputes carry a one-business-day SLA. Tasks are idempotent on `dedupeKey`.
 */

const db = require('../../db');

const TYPES = ['reply_received', 'claim_help_request', 'remove_listing', 'wrong_contact_research', 'tier_a_call',
  'activation_stalled', 'pro_interest', 'dispute', 'review_ambiguous_identity', 'review_data_quality',
  'profile_change_review', 'legal_escalation'];
const ONE_BUSINESS_DAY = new Set(['reply_received', 'claim_help_request', 'dispute', 'legal_escalation']);
const TWO_BUSINESS_DAYS = new Set(['remove_listing', 'wrong_contact_research', 'profile_change_review']);

/** `n` business days after `from` (Mon-Fri). Pure. */
function addBusinessDays(from, n) {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d;
}

function slaFor(type, now = new Date()) {
  if (ONE_BUSINESS_DAY.has(type)) return addBusinessDays(now, 1);
  if (TWO_BUSINESS_DAYS.has(type)) return addBusinessDays(now, 2);
  return addBusinessDays(now, 5);
}

async function open({ type, companyId = null, organizationId = null, summary = null, payload = {}, priority = 'normal',
  dueAt = null, dedupeKey = null, assignedUserId = null }, runner = db) {
  if (!TYPES.includes(type)) throw new Error('unknown task type: ' + type);
  const r = await runner.query(
    `INSERT INTO listing_tasks (company_id, organization_id, task_type, priority, due_at, assigned_user_id, summary, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [companyId, organizationId, type, priority, dueAt || slaFor(type), assignedUserId, summary, JSON.stringify(payload || {}), dedupeKey]);
  return r.rows[0] || null;
}

async function list({ status = 'open', type = null, organizationId = null, limit = 200 } = {}, runner = db) {
  const r = await runner.query(
    `SELECT t.*, o.name AS organization_name, u.full_name AS assigned_name
       FROM listing_tasks t LEFT JOIN organizations o ON o.id = t.organization_id LEFT JOIN users u ON u.id = t.assigned_user_id
      WHERE ($1::text = 'all' OR ($1 = 'open' AND t.status IN ('open','in_progress')) OR t.status = $1)
        AND ($2::text IS NULL OR t.task_type = $2) AND ($3::uuid IS NULL OR t.organization_id = $3)
      ORDER BY t.due_at ASC NULLS LAST, t.created_at ASC LIMIT $4`, [status, type, organizationId, limit]);
  return r.rows;
}

async function resolve(taskId, { status = 'done', resolution = null, actorId }, runner = db) {
  if (!['done', 'dismissed', 'in_progress'].includes(status)) throw new Error('invalid task status');
  const r = await runner.query(
    `UPDATE listing_tasks SET status = $2, resolution = COALESCE($3, resolution),
        resolved_by = CASE WHEN $2 IN ('done','dismissed') THEN $4::uuid ELSE resolved_by END,
        resolved_at = CASE WHEN $2 IN ('done','dismissed') THEN now() ELSE resolved_at END,
        assigned_user_id = COALESCE(assigned_user_id, $4::uuid), updated_at = now()
      WHERE id = $1 RETURNING *`, [taskId, status, resolution, actorId]);
  return r.rows[0] || null;
}

module.exports = { TYPES, addBusinessDays, slaFor, open, list, resolve };
