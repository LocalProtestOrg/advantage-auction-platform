'use strict';

/**
 * Staff / test caller allowlist for Phone Sasha's controlled-testing phase (migration 191).
 *
 * While sasha.phone.access_mode is 'staff_only', a live call reaches the routing menu and Sasha ONLY when the caller ID
 * matches an active row here; everyone else hears a short "not available" message and the call ends. This is an access
 * gate for testing, never authentication: caller ID can be spoofed, so a listed caller is still an unverified caller to
 * Sasha and must pass the normal account verification before any account information.
 *
 * Numbers are entered by a Super Admin in the admin page and stored as a salted hash plus the last 4 digits only. The
 * full number is never stored, logged or returned.
 */

const db = require('../../../db');
const { normalizeUsPhone, identifierHash, last4 } = require('../../../lib/phoneNumber');

class TestCallerError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; } }

async function list() {
  return (await db.query(`SELECT id, phone_last4, label, created_at FROM cs_phone_test_callers WHERE removed_at IS NULL ORDER BY created_at`)).rows;
}

async function add(rawNumber, { label = null, actorId = null } = {}) {
  const n = normalizeUsPhone(rawNumber);
  if (n.status !== 'ok' || n.fictional) throw new TestCallerError('INVALID_PHONE', 'Enter a valid US phone number, including the area code.');
  const hash = identifierHash(n.e164);
  const existing = (await db.query(`SELECT id FROM cs_phone_test_callers WHERE phone_hash = $1 AND removed_at IS NULL`, [hash])).rows[0];
  if (existing) return { id: existing.id, phone_last4: last4(n.e164), already: true };
  const row = (await db.query(`INSERT INTO cs_phone_test_callers (phone_hash, phone_last4, label, added_by) VALUES ($1,$2,$3,$4) RETURNING id, phone_last4, label, created_at`,
    [hash, last4(n.e164), label ? String(label).trim().slice(0, 60) || null : null, actorId])).rows[0];
  await require('../../../lib/auditLog').writeAuditLog({ event_type: 'sasha.phone_test_caller_added', entity_type: 'cs_phone_test_caller', entity_id: row.id, actor_id: actorId,
    metadata: { phone_last4: row.phone_last4, label: row.label } }).catch(() => {});
  return row;
}

async function remove(id, { actorId = null } = {}) {
  const r = await db.query(`UPDATE cs_phone_test_callers SET removed_at = now(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL RETURNING id, phone_last4`, [id, actorId]);
  if (!r.rowCount) throw new TestCallerError('NOT_FOUND', 'That test caller was not found.', 404);
  await require('../../../lib/auditLog').writeAuditLog({ event_type: 'sasha.phone_test_caller_removed', entity_type: 'cs_phone_test_caller', entity_id: id, actor_id: actorId,
    metadata: { phone_last4: r.rows[0].phone_last4 } }).catch(() => {});
  return { removed: true };
}

async function isAllowed(callerNumber) {
  const n = normalizeUsPhone(callerNumber);
  if (n.status !== 'ok') return false;
  return (await db.query(`SELECT 1 FROM cs_phone_test_callers WHERE phone_hash = $1 AND removed_at IS NULL`, [identifierHash(n.e164)])).rowCount > 0;
}

module.exports = { list, add, remove, isAllowed, TestCallerError };
