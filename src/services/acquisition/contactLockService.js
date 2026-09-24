'use strict';

/**
 * contactLockService — one active contact owner per company, shared by every programme.
 *
 * A rep must hold the company lock before logging outbound contact or sending a manual email for that
 * company. The automated listing sequence holds a `system` lock while it is active; a rep taking the
 * lock pauses the sequence. A user lock lapses after 14 idle days. Only a Super Admin may take a lock
 * another person holds (reassign), and that is audited.
 *
 * Fail closed: a lock lookup error means "held" (callers must not contact).
 */

const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const auditService = require('../auditService');

const USER_LOCK_DAYS = 14;
const SYSTEM_LOCK_DAYS = 400;   // a system lock lives as long as its sequence; released when the sequence stops

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e; }

/** Current live lock (expired locks are treated as free). */
async function current(companyId, runner = db) {
  if (!companyId) return null;
  return (await runner.query(
    `SELECT l.*, u.full_name AS holder_name, u.email AS holder_email FROM company_contact_locks l
       LEFT JOIN users u ON u.id = l.holder_user_id
      WHERE l.company_id = $1 AND l.expires_at > now()`, [companyId])).rows[0] || null;
}

/**
 * May `actor` contact this company now?
 *   { ok: true }                          free, or held by this actor
 *   { ok: false, code, holder }           held by someone else (or unknown: fail closed)
 * `actor` = { type: 'user', userId } | { type: 'system', sequenceId }
 */
async function check(companyId, actor, runner = db) {
  if (!companyId) return { ok: true, reason: 'no company record' };
  try {
    const l = await current(companyId, runner);
    if (!l) return { ok: true };
    if (actor.type === 'user' && l.holder_type === 'user' && l.holder_user_id === actor.userId) return { ok: true, lock: l };
    if (actor.type === 'system' && l.holder_type === 'system' && (!actor.sequenceId || l.sequence_id === actor.sequenceId)) return { ok: true, lock: l };
    return { ok: false, code: 'CONTACT_LOCKED', holder: { type: l.holder_type, name: l.holder_name || null, since: l.acquired_at } };
  } catch (e) {
    return { ok: false, code: 'LOCK_CHECK_FAILED', error: e.message };
  }
}

/**
 * Take the lock for a user. Free or expired → taken. Held by the same user → refreshed. Held by the
 * system → taken and the sequence is PAUSED (a person is now handling the company). Held by another
 * person → refused unless `reassign` by a Super Admin (audited).
 */
async function acquire(companyId, { userId, reason = null, reassign = false, isSuperAdmin = false } = {}) {
  if (!companyId) throw err(400, 'COMPANY_REQUIRED', 'A company is required.');
  if (!userId) throw err(401, 'ACTOR_REQUIRED', 'A signed-in staff member is required.');
  return withTransaction(async (client) => {
    const l = (await client.query(`SELECT * FROM company_contact_locks WHERE company_id = $1 FOR UPDATE`, [companyId])).rows[0];
    const live = l && new Date(l.expires_at).getTime() > Date.now();
    if (live && l.holder_type === 'user' && l.holder_user_id !== userId) {
      if (!(reassign && isSuperAdmin)) throw err(409, 'CONTACT_LOCKED', 'Another team member is working this company.');
    }
    if (live && l.holder_type === 'system' && l.sequence_id) {
      await client.query(
        `UPDATE listing_outreach_sequences SET state = 'paused', stop_reason = 'rep_took_lock', updated_at = now()
          WHERE id = $1 AND state IN ('queued','active')`, [l.sequence_id]);
    }
    const row = (await client.query(
      `INSERT INTO company_contact_locks (company_id, holder_type, holder_user_id, sequence_id, reason, acquired_at, last_activity_at, expires_at)
       VALUES ($1,'user',$2,NULL,$3,now(),now(), now() + ($4 || ' days')::interval)
       ON CONFLICT (company_id) DO UPDATE SET holder_type = 'user', holder_user_id = EXCLUDED.holder_user_id, sequence_id = NULL,
         reason = EXCLUDED.reason,
         acquired_at = CASE WHEN company_contact_locks.holder_user_id = EXCLUDED.holder_user_id AND company_contact_locks.expires_at > now()
                            THEN company_contact_locks.acquired_at ELSE now() END,
         last_activity_at = now(), expires_at = EXCLUDED.expires_at
       RETURNING *`, [companyId, userId, reason, String(USER_LOCK_DAYS)])).rows[0];
    await auditService.logEvent(client, {
      eventType: live && l.holder_user_id && l.holder_user_id !== userId ? 'contact_lock.reassigned' : 'contact_lock.acquired',
      entityType: 'company_identity', entityId: companyId, actorId: userId,
      metadata: { previous: live ? { type: l.holder_type, user: l.holder_user_id, sequence: l.sequence_id } : null, reason },
    });
    return row;
  });
}

/** Record activity by the holder (keeps a user lock alive). */
async function touch(companyId, userId, runner = db) {
  await runner.query(
    `UPDATE company_contact_locks SET last_activity_at = now(), expires_at = now() + ($3 || ' days')::interval
      WHERE company_id = $1 AND holder_type = 'user' AND holder_user_id = $2`, [companyId, userId, String(USER_LOCK_DAYS)]);
}

async function release(companyId, { userId, isSuperAdmin = false } = {}) {
  return withTransaction(async (client) => {
    const l = (await client.query(`SELECT * FROM company_contact_locks WHERE company_id = $1 FOR UPDATE`, [companyId])).rows[0];
    if (!l) return { released: false };
    if (l.holder_type === 'user' && l.holder_user_id !== userId && !isSuperAdmin) throw err(403, 'NOT_LOCK_HOLDER', 'Only the holder or a Super Admin can release this lock.');
    await client.query(`DELETE FROM company_contact_locks WHERE company_id = $1`, [companyId]);
    await auditService.logEvent(client, { eventType: 'contact_lock.released', entityType: 'company_identity', entityId: companyId, actorId: userId || null,
      metadata: { holder_type: l.holder_type, holder_user_id: l.holder_user_id } });
    return { released: true };
  });
}

/** The automated sequence takes a system lock only when the company is free. */
async function acquireSystem(companyId, sequenceId, runner = db) {
  const r = await runner.query(
    `INSERT INTO company_contact_locks (company_id, holder_type, sequence_id, reason, expires_at)
     VALUES ($1,'system',$2,'listing sequence', now() + ($3 || ' days')::interval)
     ON CONFLICT (company_id) DO UPDATE SET holder_type = 'system', holder_user_id = NULL, sequence_id = EXCLUDED.sequence_id,
       reason = EXCLUDED.reason, acquired_at = now(), last_activity_at = now(), expires_at = EXCLUDED.expires_at
     WHERE company_contact_locks.expires_at <= now()
        OR (company_contact_locks.holder_type = 'system' AND company_contact_locks.sequence_id = EXCLUDED.sequence_id)
     RETURNING *`, [companyId, sequenceId, String(SYSTEM_LOCK_DAYS)]);
  return r.rows[0] || null;
}

async function releaseSystem(sequenceId, runner = db) {
  await runner.query(`DELETE FROM company_contact_locks WHERE holder_type = 'system' AND sequence_id = $1`, [sequenceId]);
}

module.exports = { USER_LOCK_DAYS, current, check, acquire, touch, release, acquireSystem, releaseSystem };
