#!/usr/bin/env node
/* seed-staff-rbac.js — establish initial staff identities. Idempotent; never overwrites an existing
 * identity blindly (only sets staff fields).
 *
 *   - Owner accounts (role='admin') are marked staff_role='super_admin' so they appear as Super
 *     Admins in Staff & Permissions. Their unrestricted access already comes from role='admin'.
 *   - Kym Witt (kymmielauren@gmail.com) is created/attached as staff_role='marketing' with a benign
 *     marketplace role='buyer'. If she is a brand-new identity, a one-time temp password is printed
 *     ONCE (never written to any file); an existing account's password is left untouched.
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const SUPER_ADMINS = ['tylerwitt2015@gmail.com', 'admin@advantage.bid'];
const KYM_EMAIL = 'kymmielauren@gmail.com';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  const report = { super_admins: [], kym: null };
  try {
    // 1. Mark existing owner/admin accounts as super_admin staff (only if they exist; never create).
    for (const email of SUPER_ADMINS) {
      const u = (await db.query('SELECT id, role FROM users WHERE lower(email) = lower($1)', [email])).rows[0];
      if (!u) { report.super_admins.push({ email, status: 'NOT FOUND (skipped)' }); continue; }
      await db.query('UPDATE users SET staff_role = $2, staff_active = true WHERE id = $1', [u.id, 'super_admin']);
      report.super_admins.push({ email, id: u.id, role: u.role, staff_role: 'super_admin' });
    }

    // 2. Kym Witt — Marketing / Sales.
    const existing = (await db.query('SELECT id, role FROM users WHERE lower(email) = lower($1)', [KYM_EMAIL])).rows[0];
    if (existing) {
      await db.query(
        `UPDATE users SET staff_role = 'marketing', staff_active = true,
            full_name = COALESCE(full_name, 'Kym Witt') WHERE id = $1`, [existing.id]);
      report.kym = { email: KYM_EMAIL, id: existing.id, status: 'existing account attached to Marketing role', temp_password: null, marketplace_role: existing.role };
    } else {
      const tempPassword = 'Kym-' + crypto.randomBytes(12).toString('base64url') + '-Ab9';
      const hash = bcrypt.hashSync(tempPassword, 10);
      const id = (await db.query(
        `INSERT INTO users (email, role, is_active, password_hash, full_name, staff_role, staff_active)
         VALUES ($1, 'buyer', true, $2, 'Kym Witt', 'marketing', true) RETURNING id`,
        [KYM_EMAIL, hash])).rows[0].id;
      report.kym = { email: KYM_EMAIL, id, status: 'created', temp_password: tempPassword, marketplace_role: 'buyer' };
    }
  } finally { db.release(); await pool.end(); }
  console.log('STAFF_SEED=' + JSON.stringify(report));
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
