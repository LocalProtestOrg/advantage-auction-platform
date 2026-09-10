#!/usr/bin/env node
/* prod-migrate-149.js — PRODUCTION-guarded apply of ONLY 149_creative_physical_intelligence_and_measurement.sql.
   Additive + idempotent: creative feedback/attribute/message tables, negative-signature polarity, v2 calibration
   provenance columns, first-party attribution, conversion ledger, assisted-service inquiries, paid-growth shadow tables,
   config keys with every provider/spend gate OFF. Verifies tables, and that no publish / ad / measurement gate is ON. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '149_creative_physical_intelligence_and_measurement.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const TABLES = ['marketing_creative_feedback_records', 'marketing_creative_feedback_attributes', 'marketing_creative_feedback_messages', 'marketing_attribution_touches', 'marketing_attribution_profiles',
  'marketing_conversion_events', 'assisted_service_inquiries', 'marketing_paid_cost_facts', 'marketing_provider_reconciliations', 'marketing_paid_growth_proposals', 'marketing_paid_campaign_states', 'marketing_paid_director_actions'];
const OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.social.reply_draft_enabled',
  'marketing.measurement.meta_pixel_enabled', 'marketing.measurement.meta_capi_enabled', 'marketing.measurement.google_conversions_enabled'];
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
    if (await ledgerHas(c)) console.log('SKIP apply (already recorded; idempotent). Verifying only.');
    else {
      const sql = fs.readFileSync(FILE_PATH, 'utf8');
      await c.query('BEGIN');
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 149 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const t = (await c.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_name = ANY($1)`, [TABLES])).rows[0].n;
    const cols = (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='marketing_creative_calibrations' AND column_name IN ('media_decision','scene_plan','logo_qa','negative_signature_check')`)).rows[0].n;
    const pol = (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='marketing_creative_layout_signatures' AND column_name='polarity'`)).rows[0].n;
    const gates = (await c.query(`SELECT key, value FROM platform_config WHERE key = ANY($1)`, [OFF])).rows;
    const on = gates.filter((g) => g.value === true || g.value === 'true');
    const ceiling = (await c.query(`SELECT value FROM platform_config WHERE key='marketing.paid_growth.monthly_ceiling_usd'`)).rows[0];
    const mode = (await c.query(`SELECT value FROM platform_config WHERE key='marketing.paid_growth.mode'`)).rows[0];
    console.log('Verify:', JSON.stringify({ tables: t, of: TABLES.length, calibration_cols: cols, polarity: pol, gates_checked: gates.length, gates_on: on.map((g) => g.key), ceiling: ceiling && ceiling.value, mode: mode && mode.value, ledger: await ledgerHas(c) }));
    const pass = t === TABLES.length && cols === 4 && pol === 1 && on.length === 0 && mode && mode.value === 'shadow';
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
