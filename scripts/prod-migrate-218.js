#!/usr/bin/env node
/* prod-migrate-218.js - PRODUCTION-guarded apply of 218_auction_shipping_phase1.sql (auction shipping Phase 1): one new,
   empty table (seller_shipping_profiles), new lots columns (shipping_eligible default false, profile, restriction,
   quote required) and seller_profiles shipping approval / limit / acknowledgment columns (all NULL). Additive only:
   changes no existing row's behavior. Nothing reads the new columns unless AUCTION_SHIPPING_ENABLED=true.

   --check    READ-ONLY: 217 applied, 218 not recorded, the new objects absent.
   --dry-run  applies it inside a transaction, runs every verification, then ROLLS BACK (nothing is kept).
   (none)     applies it in one transaction, then verifies; any failure rolls it back.
   Usage: railway run node scripts/prod-migrate-218.js [--check | --dry-run]
   OWNER-GATED: do not run against production without the owner's approval. */
const fs = require('fs'); const path = require('path');
const FILE = '218_auction_shipping_phase1.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');
const LOT_COLS = ['shipping_eligible', 'shipping_profile_id', 'shipping_restriction', 'shipping_quote_required'];
const SP_COLS = ['shipping_approved_at', 'shipping_approved_by', 'shipping_approval_reason', 'shipping_per_shipment_limit_cents',
  'shipping_education_acknowledged_at', 'shipping_education_version'];
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const one = async (sql, p) => (await c.query(sql, p || [])).rows[0];
    const has = async (sql, p) => !!(await one(sql, p));
    const colCount = async (table, cols) => Number((await one(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2::text[])`, [table, cols])).n);
    const pre = {
      migration_217_applied: await has(`SELECT 1 AS x FROM schema_migrations WHERE filename = '217_storefront_commission_adjustments.sql'`),
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      table_present: await has(`SELECT 1 AS x FROM information_schema.tables WHERE table_name = 'seller_shipping_profiles'`),
      lot_columns_present: await colCount('lots', LOT_COLS),
      seller_columns_present: await colCount('seller_profiles', SP_COLS),
      lots: Number((await one('SELECT count(*)::int n FROM lots')).n),
    };
    console.log('Pre-check:', JSON.stringify(pre, null, 2));
    const ok = pre.migration_217_applied && !pre.already_recorded && !pre.table_present && pre.lot_columns_present === 0 && pre.seller_columns_present === 0;
    if (CHECK) { console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)')); return ok ? 0 : 1; }
    if (!ok) { console.error('REFUSE: pre-check failed.'); return 1; }
    const lotSnap = async () => JSON.stringify((await c.query('SELECT count(*)::int n, count(*) FILTER (WHERE shippable)::int shippable FROM lots')).rows);
    const before = await lotSnap();
    const verify = async () => ({
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      profiles_table_empty: Number((await one('SELECT count(*)::int n FROM seller_shipping_profiles')).n) === 0,
      lot_columns: (await colCount('lots', LOT_COLS)) === LOT_COLS.length,
      seller_columns: (await colCount('seller_profiles', SP_COLS)) === SP_COLS.length,
      no_lot_eligible: Number((await one('SELECT count(*)::int n FROM lots WHERE shipping_eligible')).n) === 0,
      no_seller_approved: Number((await one('SELECT count(*)::int n FROM seller_profiles WHERE shipping_approved_at IS NOT NULL OR shipping_education_acknowledged_at IS NOT NULL')).n) === 0,
      eligible_needs_profile_rule: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'lots_shipping_eligible_has_profile'`),
      one_default_index: await has(`SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_seller_shipping_profiles_one_default'`),
      lots_unchanged: before === await lotSnap(),
    });
    let checks;
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '10s'`);
      await c.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', FILE), 'utf8'));
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
      checks = await verify();
      const failed = Object.keys(checks).filter((k) => !checks[k]);
      if (DRY || failed.length) { await c.query('ROLLBACK'); console.log(DRY ? 'DRY RUN: applied and verified inside a transaction, then rolled back.' : 'VERIFY FAILED: rolled back.'); }
      else { await c.query('COMMIT'); console.log('APPLIED', FILE); }
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED (rolled back):', e.message); return 1; }
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(', ') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0), (e) => { console.error(e); process.exit(1); });
