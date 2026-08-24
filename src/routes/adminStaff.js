'use strict';

/**
 * /api/admin/staff — internal Staff & Permissions administration. Super-Admin-only for mutations.
 *
 * Enforcement is permission-based (rbac.js) and server-side. Safeguards prevent lockout and
 * self-escalation:
 *   - The last effective Super Admin can never be deactivated or demoted.
 *   - Only staff.manage holders (Super Admins) can create staff or change roles/status — a lower
 *     staff member cannot self-escalate (they get 403 from requirePermission).
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const { loadStaffContext } = require('../middleware/requirePermission');
const db = require('../db');
const rbac = require('../lib/rbac');
const { writeAuditLog } = require('../lib/auditLog');

router.use(auth);

// GET /me — the caller's own staff identity + effective permissions. Any authenticated user (used by
// the admin nav to decide which links to show). Never exposes other users' data.
router.get('/me', async (req, res, next) => {
  try {
    const ctx = await loadStaffContext(req);
    if (!ctx) return res.status(401).json({ success: false, message: 'Authentication required' });
    return res.json({ success: true, data: {
      id: ctx.id, role: ctx.role, staff_role: ctx.staff_role, staff_active: ctx.staff_active,
      is_super_admin: ctx.is_super_admin, permissions: ctx.permissions,
    } });
  } catch (err) { next(err); }
});

// GET /roles — the role catalog (labels + permission bundles) for the UI. Requires staff.view.
router.get('/roles', requirePermission('staff.view'), (req, res) => {
  res.json({ success: true, data: { roles: rbac.ROLES, permissions: rbac.PERMISSIONS, role_keys: rbac.STAFF_ROLE_KEYS } });
});

// GET / — list internal staff (users with a staff_role, plus role='admin' owners). Requires staff.view.
router.get('/', requirePermission('staff.view'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, full_name, role, staff_role, staff_active, last_login_at, created_at
         FROM users
        WHERE staff_role IS NOT NULL OR role = 'admin'
        ORDER BY (staff_role = 'super_admin' OR role = 'admin') DESC, email ASC`);
    const data = rows.map(u => ({
      ...u,
      is_super_admin: rbac.isSuperAdmin(u),
      staff_role_label: u.staff_role ? (rbac.ROLES[u.staff_role] || {}).label || u.staff_role
        : (u.role === 'admin' ? 'Super Admin / Owner' : null),
    }));
    return res.json({ success: true, data });
  } catch (err) { next(err); }
});

// Count effective Super Admins that remain if we exclude a given user id (for lockout protection).
async function otherActiveSuperAdmins(excludeId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users
      WHERE id <> $1 AND is_active IS NOT FALSE
        AND ((role = 'admin') OR (staff_role = 'super_admin' AND staff_active IS NOT FALSE))`, [excludeId]);
  return rows[0].n;
}

// POST / — create (or attach staff role to an existing) staff account. Requires staff.manage.
// Never overwrites an existing identity blindly: if the email exists, it only sets staff fields.
router.post('/', requirePermission('staff.manage'), async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const staffRole = (req.body.staff_role || '').trim();
    const fullName = (req.body.full_name || '').trim() || null;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    if (!rbac.STAFF_ROLE_KEYS.includes(staffRole)) {
      return res.status(400).json({ success: false, message: 'staff_role must be one of: ' + rbac.STAFF_ROLE_KEYS.join(', ') });
    }
    // Super Admin staff are also marketplace role='admin' (true unrestricted). Other staff keep a
    // benign 'buyer' marketplace role — their access comes solely from staff_role.
    const marketRole = staffRole === 'super_admin' ? 'admin' : 'buyer';
    const existing = (await db.query('SELECT id, role FROM users WHERE lower(email) = $1', [email])).rows[0];
    let userId, created = false, tempPassword = null;
    if (existing) {
      userId = existing.id;
      await db.query(
        `UPDATE users SET staff_role = $2, staff_active = true, full_name = COALESCE($3, full_name),
             role = CASE WHEN $4 = 'admin' THEN 'admin' ELSE role END
           WHERE id = $1`,
        [userId, staffRole, fullName, marketRole]);
    } else {
      // New identity: unusable random password (no plaintext in code). A temp password is returned
      // ONCE so the Owner can hand it off; the staff member should change it (or use Forgot Password).
      tempPassword = 'Staff-' + crypto.randomBytes(12).toString('base64url') + '-Ab9';
      const hash = await bcrypt.hashSync(tempPassword, 10);
      userId = (await db.query(
        `INSERT INTO users (email, role, is_active, password_hash, full_name, staff_role, staff_active)
         VALUES ($1, $2, true, $3, $4, $5, true) RETURNING id`,
        [email, marketRole, hash, fullName, staffRole])).rows[0].id;
      created = true;
    }
    await writeAuditLog({
      event_type: 'staff_account_created', entity_type: 'user', entity_id: userId, actor_id: req.user.id,
      metadata: { email, staff_role: staffRole, created },
    });
    return res.status(created ? 201 : 200).json({
      success: true,
      data: { id: userId, email, staff_role: staffRole, created },
      temp_password: tempPassword, // present only for a newly-created identity; shown once
    });
  } catch (err) { next(err); }
});

// PATCH /:id — change a staff member's role and/or active status. Requires staff.manage.
router.patch('/:id', requirePermission('staff.manage'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const target = (await db.query('SELECT id, email, role, staff_role, staff_active FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ success: false, message: 'Staff account not found' });

    const nextRole = req.body.staff_role !== undefined ? String(req.body.staff_role || '').trim() : undefined;
    const nextActive = req.body.staff_active !== undefined ? !!req.body.staff_active : undefined;
    if (nextRole !== undefined && nextRole !== '' && !rbac.STAFF_ROLE_KEYS.includes(nextRole)) {
      return res.status(400).json({ success: false, message: 'invalid staff_role' });
    }

    // Lockout protection: if the target is currently an effective Super Admin and this change would
    // remove that (deactivate, or demote away from super_admin/admin), refuse when they are the last.
    const targetIsSuper = rbac.isSuperAdmin(target);
    const willLoseSuper = targetIsSuper && (
      nextActive === false || (nextRole !== undefined && nextRole !== 'super_admin')
    );
    if (willLoseSuper) {
      const others = await otherActiveSuperAdmins(id);
      if (others < 1) {
        return res.status(409).json({ success: false, message: 'Refusing to remove the last active Super Admin.' });
      }
    }

    const fields = [], vals = [];
    if (nextRole !== undefined) {
      fields.push('staff_role = $' + (vals.push(nextRole === '' ? null : nextRole)));
      // Keep marketplace role consistent: promotion to super_admin => role='admin'.
      if (nextRole === 'super_admin') fields.push("role = 'admin'");
    }
    if (nextActive !== undefined) fields.push('staff_active = $' + (vals.push(nextActive)));
    if (!fields.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    vals.push(id);
    const updated = (await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${vals.length}
         RETURNING id, email, role, staff_role, staff_active`, vals)).rows[0];
    await writeAuditLog({
      event_type: 'staff_role_changed', entity_type: 'user', entity_id: id, actor_id: req.user.id,
      metadata: { before: { staff_role: target.staff_role, staff_active: target.staff_active },
                  after: { staff_role: updated.staff_role, staff_active: updated.staff_active } },
    });
    return res.json({ success: true, data: { ...updated, is_super_admin: rbac.isSuperAdmin(updated) } });
  } catch (err) { next(err); }
});

// POST /:id/reset-password — issue a new temporary password (shown once). Requires staff.manage.
router.post('/:id/reset-password', requirePermission('staff.manage'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const target = (await db.query('SELECT id, email, staff_role FROM users WHERE id = $1', [id])).rows[0];
    if (!target) return res.status(404).json({ success: false, message: 'Staff account not found' });
    const tempPassword = 'Staff-' + crypto.randomBytes(12).toString('base64url') + '-Ab9';
    const hash = await bcrypt.hashSync(tempPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    await writeAuditLog({
      event_type: 'staff_password_reset', entity_type: 'user', entity_id: id, actor_id: req.user.id,
      metadata: { email: target.email },
    });
    return res.json({ success: true, data: { id, email: target.email }, temp_password: tempPassword });
  } catch (err) { next(err); }
});

module.exports = router;
