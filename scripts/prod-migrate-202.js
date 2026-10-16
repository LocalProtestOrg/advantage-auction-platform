#!/usr/bin/env node
/* prod-migrate-202.js — PRODUCTION-guarded apply of ONLY 202_taxpayer_id_minimization.sql (owner decision 2026-10-16:
   Advantage.Bid stores no complete EINs; taxpayer ID is collected and verified during payout setup). Adds status columns
   and a CHECK that seller_identity.ein stays empty. Drops nothing.

   --check  READ-ONLY (BEGIN READ ONLY): confirms the migration is not yet recorded and that NO seller_identity row holds an
            EIN (if any did, the migration is refused so that no record is lost — a preservation plan comes first).
   (none)   applies in one transaction, then verifies the constraint and that seller identities, seller profiles, orders,
            payments, invoices, payouts and accounts are unchanged.
   Usage: railway run node scripts/prod-migrate-202.js [--check] */
const fs = require('fs'); const path = require('path');
const FILE = '202_taxpayer_id_minimization.sql';
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const CHECK = process.argv.includes('--check');

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const { Client } = require('pg');
  const c = new Client({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });   // direct endpoint, never the pooler
  await c.connect();
  try {
    const one = async (sql, p) => (await c.query(sql, p || [])).rows[0];
    const has = async (sql, p) => !!(await one(sql, p));
    const h = async (sql) => (await one(sql)).h;
    const pre = async () => ({
      already_recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename = $1', [FILE]),
      identity_rows: Number((await one('SELECT count(*)::int n FROM seller_identity')).n),
      identity_rows_with_ein: Number((await one(`SELECT count(*)::int n FROM seller_identity WHERE ein IS NOT NULL`)).n),
    });
    const snap = async () => ({
      identity: await h(`SELECT md5(coalesce(string_agg(row_to_json(si)::text, ',' ORDER BY seller_profile_id), '')) h FROM (SELECT seller_profile_id, legal_name, company_name,
        dba_name, city, state, postal_code, phone, payout_info_ref, updated_at FROM seller_identity) si`),
      sellers: await h(`SELECT md5(coalesce(string_agg(id::text || ':' || coalesce(user_id::text,'') || ':' || coalesce(seller_type,''), ',' ORDER BY id), '')) h FROM seller_profiles`),
      money: await h(`SELECT md5(((SELECT count(*) FROM marketplace_orders) || ':' || (SELECT count(*) FROM payments) || ':' || (SELECT count(*) FROM buyer_auction_invoices)
        || ':' || (SELECT count(*) FROM seller_payouts) || ':' || (SELECT count(*) FROM users))::text) h`),
    });
    if (CHECK) {
      await c.query('BEGIN READ ONLY'); const p = await pre(); await c.query('ROLLBACK');
      console.log('Pre-check (read-only):', JSON.stringify(p, null, 2));
      const ok = !p.already_recorded && p.identity_rows_with_ein === 0;
      console.log('RESULT: ' + (ok ? 'PASS (safe to apply)' : 'FAIL (see above)'));
      return ok ? 0 : 1;
    }
    const p = await pre();
    if (p.identity_rows_with_ein > 0) { console.error('REFUSE: seller_identity rows hold EINs; a reviewed preservation plan is required first.'); return 1; }
    const before = await snap();
    if (p.already_recorded) console.log('SKIP (already recorded).');
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
    const checks = {
      recorded: await has('SELECT 1 AS x FROM schema_migrations WHERE filename=$1', [FILE]),
      no_full_ein_constraint: await has(`SELECT 1 AS x FROM pg_constraint WHERE conname = 'seller_identity_no_full_ein'`),
      status_column: await has(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'seller_identity' AND column_name = 'taxpayer_id_status'`),
      no_ein_stored: Number((await one('SELECT count(*)::int n FROM seller_identity WHERE ein IS NOT NULL')).n) === 0,
      seller_identities_unchanged: before.identity === after.identity,
      seller_profiles_unchanged: before.sellers === after.sellers,
      orders_payments_invoices_payouts_users_unchanged: before.money === after.money,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { await c.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
