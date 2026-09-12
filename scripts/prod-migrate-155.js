#!/usr/bin/env node
/* prod-migrate-155.js — PRODUCTION-guarded apply of ONLY 155_webhook_verification_quarantine.sql.
   Additive + idempotent: the fail-safe quarantine for provider callbacks whose authenticity could not
   be established, so an unverified callback can never apply suppression, complaint, bounce,
   deliverability or consent state.

   Run AFTER 154 and BEFORE deploying the application.

   Verification proves the safety properties, not merely that the SQL ran. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '155_webhook_verification_quarantine.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const before = (await c.query(
      `SELECT (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM ses_feedback_events) feedback_events`)).rows[0];

    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); console.log('APPLIED 155 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }

    const after = (await c.query(
      `SELECT (SELECT count(*)::int FROM webhook_callback_quarantine) held,
              (SELECT count(*)::int FROM webhook_callback_quarantine WHERE status='verified_processed') processed,
              (SELECT count(*)::int FROM email_suppressions) suppressions,
              (SELECT count(*)::int FROM ses_feedback_events) feedback_events`)).rows[0];
    const cfg = {};
    (await c.query(`SELECT key, value FROM platform_config WHERE key LIKE 'webhooks.quarantine%'`)).rows
      .forEach((r) => { cfg[r.key] = r.value; });
    const idx = (await c.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='webhook_callback_quarantine' ORDER BY 1`)).rows.map((r) => r.indexname);
    const chk = (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_webhook_quarantine_processed'`)).rowCount;

    const checks = {
      table_created_empty: after.held === 0 && after.processed === 0,
      unique_payload_index: idx.includes('uq_webhook_quarantine_payload'),
      due_index: idx.includes('idx_webhook_quarantine_due'),
      exactly_once_constraint: chk === 1,
      retry_enabled: cfg['webhooks.quarantine_retry_enabled'] === true,
      max_attempts_set: Number(cfg['webhooks.quarantine_max_attempts']) > 0,
      backoff_set: Number(cfg['webhooks.quarantine_backoff_seconds']) > 0,
      // The migration must not touch a single recipient-state row.
      suppressions_unchanged: after.suppressions === before.suppressions,
      feedback_events_unchanged: after.feedback_events === before.feedback_events,
      ledger: await ledgerHas(c),
    };
    console.log('Before:', JSON.stringify(before));
    console.log('After: ', JSON.stringify(after));
    console.log('Config:', JSON.stringify(cfg));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.error('FAILED CHECKS:', failed.join(', '));
    console.log('RESULT: ' + (failed.length ? 'FAIL' : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
