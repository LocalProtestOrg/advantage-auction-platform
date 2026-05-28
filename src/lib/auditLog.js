'use strict';

/**
 * Shared audit log writer.
 *
 * Every admin action that mutates state should call this. The audit_log table
 * (migration 013) holds an append-only event stream indexed by auction_id
 * and created_at for fast operator timeline queries.
 *
 * Failures here MUST NOT abort the calling transaction. The caller is the
 * source of truth; if we cannot log, we surface a warning and move on.
 * Audit gaps are recoverable; broken business operations are not.
 *
 * Usage:
 *   const { writeAuditLog } = require('../lib/auditLog');
 *   await writeAuditLog({
 *     event_type:  'capability_changed',
 *     entity_type: 'seller_profile',
 *     entity_id:   sellerProfileId,
 *     actor_id:    req.user.id,
 *     metadata:    { before: {...}, after: {...} },
 *   });
 */
const db = require('../db/index');

async function writeAuditLog({
  event_type,
  entity_type,
  entity_id,
  auction_id = null,
  lot_id     = null,
  payment_id = null,
  actor_id   = null,
  metadata   = null,
  client     = null,           // optional pg client for transactional writes
}) {
  if (!event_type || !entity_type || !entity_id) {
    console.warn('[audit] skipped — missing required fields', { event_type, entity_type, entity_id });
    return null;
  }
  const sql = `
    INSERT INTO audit_log (event_type, entity_type, entity_id, auction_id, lot_id, payment_id, actor_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    RETURNING id, created_at
  `;
  const params = [
    event_type, entity_type, entity_id,
    auction_id, lot_id, payment_id, actor_id,
    metadata ? JSON.stringify(metadata) : null,
  ];
  try {
    const runner = client || db;
    const result = await runner.query(sql, params);
    return result.rows[0];
  } catch (err) {
    console.error('[audit] write failed', { event_type, entity_type, entity_id, error: err.message });
    return null;
  }
}

module.exports = { writeAuditLog };
