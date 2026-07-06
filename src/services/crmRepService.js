'use strict';

/**
 * crmRepService — multi-representative ownership of Organizations (Phase 3C.1).
 * Many reps per org; at most one primary (enforced by a partial unique index).
 */

const db = require('../db');

async function assign(orgId, userId, opts = {}) {
  const { role = 'rep', isPrimary = false, assignedBy = null } = opts;
  if (isPrimary) await db.query('UPDATE organization_reps SET is_primary = false WHERE organization_id = $1', [orgId]);
  const { rows } = await db.query(
    `INSERT INTO organization_reps (organization_id, user_id, role, is_primary, assigned_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary RETURNING *`,
    [orgId, userId, role, isPrimary, assignedBy]);
  return rows[0];
}

async function remove(orgId, userId) {
  await db.query('DELETE FROM organization_reps WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
}

async function list(orgId) {
  const { rows } = await db.query(
    `SELECT r.user_id, r.role, r.is_primary, r.created_at, u.email
       FROM organization_reps r JOIN users u ON u.id = r.user_id
      WHERE r.organization_id = $1 ORDER BY r.is_primary DESC, r.created_at ASC`, [orgId]);
  return rows;
}

module.exports = { assign, remove, list };
