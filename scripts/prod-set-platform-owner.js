#!/usr/bin/env node
/* prod-set-platform-owner.js — PRODUCTION-guarded designation of the platform owner (users.is_platform_owner,
   migration 222). The platform owner is the only account that may change sensitive platform settings (pricing,
   paid advertising authority and ceilings, kill switches, Sasha, seller activation, outreach programmes, owner notice
   addresses) and the only account that may authorize paid advertising spend.

   Refuses anything but an ACTIVE account with role 'admin'. Refuses when another account is already the owner unless
   --replace is given (then that account is cleared in the same transaction, so there is never more than one owner).
   Without --apply it only reports what it would do. Writes an audit_log row. Prints no password, token or phone data.

   Usage: railway run node scripts/prod-set-platform-owner.js --email=<owner email> [--replace] [--apply] */
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const arg = (name) => { const a = process.argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : null; };
const APPLY = process.argv.includes('--apply');
const REPLACE = process.argv.includes('--replace');
(async () => {
  const email = String(arg('email') || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('REFUSE: --email=<owner email> is required.'); return 2; }
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const col = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_platform_owner'`)).rows[0];
    if (!col) { console.error('REFUSE: migration 222 is not applied (users.is_platform_owner missing).'); return 1; }
    const matches = (await c.query(
      `SELECT id, email, role, staff_role, is_active, is_platform_owner FROM users WHERE lower(btrim(email)) = $1`, [email])).rows;
    if (matches.length !== 1) { console.error('REFUSE: expected exactly one account for that email, found ' + matches.length + '.'); return 1; }
    const u = matches[0];
    console.log('Account:', JSON.stringify({ id: u.id, email: u.email, role: u.role, staff_role: u.staff_role, is_active: u.is_active, is_platform_owner: u.is_platform_owner }));
    if (u.role !== 'admin') { console.error('REFUSE: only an admin account can be the platform owner.'); return 1; }
    if (u.is_active === false) { console.error('REFUSE: the account is not active.'); return 1; }
    const others = (await c.query(`SELECT id, email FROM users WHERE is_platform_owner AND id <> $1`, [u.id])).rows;
    if (others.length && !REPLACE) {
      console.error('REFUSE: another account is already the platform owner (' + others.map((o) => o.email).join(', ') + '). Use --replace to move the designation.');
      return 1;
    }
    if (u.is_platform_owner && !others.length) { console.log('RESULT: already the platform owner. Nothing to do.'); return 0; }
    if (!APPLY) { console.log('DRY RUN: would designate ' + u.email + (others.length ? ' and clear ' + others.map((o) => o.email).join(', ') : '') + '. Re-run with --apply.'); return 0; }
    await c.query('BEGIN');
    try {
      if (others.length) await c.query(`UPDATE users SET is_platform_owner = false WHERE is_platform_owner AND id <> $1`, [u.id]);
      await c.query(`UPDATE users SET is_platform_owner = true WHERE id = $1`, [u.id]);
      await c.query(`INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, metadata) VALUES ('platform_owner.designated', 'user', $1, NULL, $2::jsonb)`,
        [u.id, JSON.stringify({ via: 'scripts/prod-set-platform-owner.js', cleared: others.map((o) => o.id) })]);
      const n = Number((await c.query('SELECT count(*)::int n FROM users WHERE is_platform_owner')).rows[0].n);
      if (n !== 1) throw new Error('expected exactly one platform owner after the change, found ' + n);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }
    console.log('RESULT: PASS. ' + u.email + ' is the platform owner.');
    return 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e.message); process.exit(1); });
