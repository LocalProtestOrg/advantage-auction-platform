#!/usr/bin/env node
/* provision-rep-profile.js — provision/approve a Sales rep OUTREACH IDENTITY (Admin action).
 * Owner-directed values only; the outreach email must be on the approved @advantage.bid domain.
 *   railway run node scripts/provision-rep-profile.js "<login_email>" "<Display Name>" "<outreach@advantage.bid>"
 * Default (no args) provisions Kym Witt per the owner's instruction. Idempotent (upsert). */
const { Pool } = require('pg');
const outreach = require('../src/services/salesOutreachService');

const LOGIN = process.argv[2] || 'kymmielauren@gmail.com';
const NAME = process.argv[3] || 'Kym Witt';
const EMAIL = process.argv[4] || 'kymmie@advantage.bid';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const u = (await c.query('SELECT id, staff_role, staff_active FROM users WHERE lower(email)=lower($1)', [LOGIN])).rows[0];
    if (!u) { console.log('USER_NOT_FOUND for ' + LOGIN); return; }
    const prof = await outreach.upsertRepProfile(
      { userId: u.id, displayName: NAME, outreachEmail: EMAIL, enabled: true }, null, { query: (t, p) => c.query(t, p) });
    console.log('PROVISIONED=' + JSON.stringify({ user: LOGIN, staff_role: u.staff_role, staff_active: u.staff_active,
      display_name: prof.display_name, outreach_email: prof.outreach_email, outreach_enabled: prof.outreach_enabled }));
  } catch (e) { console.log('ERR ' + (e.code || '') + ' ' + e.message); }
  finally { c.release(); await pool.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
