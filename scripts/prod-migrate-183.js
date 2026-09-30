#!/usr/bin/env node
/* prod-migrate-183.js — PRODUCTION-guarded apply of ONLY 183_sasha_imap_ingestion.sql. Verifies: both IMAP tables exist;
   cs_messages.content_fingerprint + its unique partial index exist; both new switches exist and are OFF; the existing
   inbound Message-ID index is intact; no other platform_config value and no existing cs_messages row changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '183_sasha_imap_ingestion.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      config: (await c.query(`SELECT md5(coalesce(string_agg(key || '=' || value::text, ',' ORDER BY key), '')) h FROM platform_config WHERE key NOT IN ('sasha.imap_read_enabled','sasha.imap_process_enabled')`)).rows[0].h,
      cs: (await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) h FROM cs_messages`)).rows[0],
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
    const tables = (await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('imap_inbound_messages','imap_mailbox_state')`)).rows[0].n;
    const col = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='cs_messages' AND column_name='content_fingerprint'`)).rowCount;
    const idx = (await c.query(`SELECT indexname FROM pg_indexes WHERE tablename='cs_messages' AND indexname IN ('uq_cs_messages_inbound_fingerprint','uq_cs_messages_inbound_msgid')`)).rows.map((r) => r.indexname);
    const sw = Object.fromEntries((await c.query(`SELECT key, value FROM platform_config WHERE key IN ('sasha.imap_read_enabled','sasha.imap_process_enabled')`)).rows.map((r) => [r.key, r.value]));
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount === 1,
      two_tables: tables === 2,
      fingerprint_column: col === 1,
      fingerprint_index: idx.includes('uq_cs_messages_inbound_fingerprint'),
      message_id_index_intact: idx.includes('uq_cs_messages_inbound_msgid'),
      imap_read_off: sw['sasha.imap_read_enabled'] === false,
      imap_process_off: sw['sasha.imap_process_enabled'] === false,
      other_config_unchanged: before.config === after.config,
      cs_messages_unchanged: before.cs.h === after.cs.h,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
