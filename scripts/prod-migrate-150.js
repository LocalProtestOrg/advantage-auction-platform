#!/usr/bin/env node
/* prod-migrate-150.js — PRODUCTION-guarded apply of ONLY 150_meta_measurement_connection.sql.
   Additive + idempotent: conversion-ledger provider_event_id column + Meta connection config keys (all null / OFF).
   Verifies the column, the keys, and that every paid / publish / measurement gate is still OFF. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '150_meta_measurement_connection.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const KEYS = ['marketing.measurement.meta_dataset_identity', 'marketing.measurement.meta_ad_account_id', 'marketing.measurement.meta_ad_account_identity', 'marketing.measurement.meta_cost_ingestion_enabled', 'marketing.measurement.meta_verification'];
const OFF = ['marketing.a9_publish_enabled', 'marketing.destinations.meta_enabled', 'marketing.destinations.meta_ads_enabled', 'marketing.destinations.google_ads_enabled', 'marketing.social.reply_draft_enabled',
  'marketing.measurement.meta_pixel_enabled', 'marketing.measurement.meta_capi_enabled', 'marketing.measurement.google_conversions_enabled', 'marketing.measurement.meta_cost_ingestion_enabled'];
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 150 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const col = (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='marketing_conversion_events' AND column_name='provider_event_id'`)).rows[0].n;
    const keys = (await c.query(`SELECT count(*)::int n FROM platform_config WHERE key = ANY($1)`, [KEYS])).rows[0].n;
    const on = (await c.query(`SELECT key FROM platform_config WHERE key = ANY($1) AND (value = 'true'::jsonb OR value = '"true"'::jsonb)`, [OFF])).rows.map((r) => r.key);
    const mode = (await c.query(`SELECT value FROM platform_config WHERE key='marketing.paid_growth.mode'`)).rows[0];
    console.log('Verify:', JSON.stringify({ provider_event_id_column: col, keys, of: KEYS.length, gates_on: on, mode: mode && mode.value, ledger: await ledgerHas(c) }));
    const pass = col === 1 && keys === KEYS.length && on.length === 0 && mode && mode.value === 'shadow';
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
