#!/usr/bin/env node
/* prod-migrate-131.js — PRODUCTION-guarded apply of ONLY 131_email_audience_safety_4c.sql.
   Additive email/audience SAFETY foundation: SES feedback ingestion + deliverability, normalized
   suppression, generic marketing contacts + sources + permission, campaign-recipient idempotency,
   and email/A7/SMS gating config (all OFF). No sending, import, SMS, or external activation.
   Idempotent, non-destructive. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '131_email_audience_safety_4c.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='email_suppressions'
       AND column_name IN ('normalized_email','source','provider','scope','evidence_ref','updated_at')) AS supp_cols,
    (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN
       ('ses_feedback_events','email_deliverability','marketing_contacts','marketing_contact_sources','marketing_campaign_recipients')) AS new_tables,
    (SELECT count(*)::int FROM pg_indexes WHERE indexname='uq_email_suppressions_normalized') AS supp_uq,
    (SELECT count(*)::int FROM email_suppressions WHERE normalized_email IS NULL) AS unbackfilled,
    (SELECT count(*)::int FROM platform_config WHERE key IN
       ('marketing.a7_send_enabled','marketing.admin_sms_enabled','marketing.email.default_geo_strategy',
        'marketing.email.frequency_cap_per_30d','marketing.email.min_spacing_hours',
        'marketing.email.soft_bounce_suppress_threshold','marketing.email.complaint_class_halt_threshold_bps')) AS cfg,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.a7_send_enabled') AS a7_enabled,
    (SELECT (value::text)::boolean FROM platform_config WHERE key='marketing.admin_sms_enabled') AS sms_enabled
`)).rows[0];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP)) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes(PROD_EP)) { console.error('REFUSE: not the PRODUCTION endpoint (' + PROD_EP + ').'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    if (await ledgerHas(c)) { console.log('SKIP apply (already recorded; idempotent). Verifying only.'); }
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 131 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.supp_cols === 6 && v.new_tables === 5 && v.supp_uq === 1
      && v.unbackfilled === 0 && v.cfg === 7 && v.a7_enabled === false && v.sms_enabled === false;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
