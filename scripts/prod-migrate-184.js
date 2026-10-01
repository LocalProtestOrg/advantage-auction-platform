#!/usr/bin/env node
/* prod-migrate-184.js — PRODUCTION-guarded apply of ONLY 184_imap_poller_lease.sql (adds lease_owner / lease_until to
   imap_mailbox_state). Verifies the two columns exist, both IMAP switches are unchanged (ON), and no other platform_config
   value and no Sasha message changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '184_imap_poller_lease.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      config: (await c.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config`)).rows[0].h,
      cs: (await c.query(`SELECT md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) h FROM cs_messages`)).rows[0].h,
    });
    const before = await snap();
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount) console.log('SKIP (already recorded).');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED', FILE);
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED', e.message); return 1; }
    }
    const after = await snap();
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'imap_mailbox_state' AND column_name IN ('lease_owner', 'lease_until')`)).rows.length;
    const sw = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key IN ('sasha.imap_read_enabled', 'sasha.imap_process_enabled')`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      lease_columns: cols === 2,
      imap_switches_unchanged: sw['sasha.imap_read_enabled'] === true && sw['sasha.imap_process_enabled'] === true,
      other_config_unchanged: before.config === after.config,
      cs_messages_unchanged: before.cs === after.cs,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
