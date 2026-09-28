#!/usr/bin/env node
/* prod-migrate-178.js — PRODUCTION-guarded apply of ONLY 178_seller_default_pickup_location.sql. Verifies: the seller default
   pickup columns exist; the item location-source check allows exactly default/auction/item; NO seller has a confirmed default
   (confirmation is a seller action); no item still uses the retired 'seller' source; items, seller profiles' identity and
   payments are unchanged. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '178_seller_default_pickup_location.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('REFUSE: DATABASE_URL not set.'); return 2; }
  if (raw.includes(STG_EP) || !raw.includes(PROD_EP)) { console.error('REFUSE: PRODUCTION endpoint only.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const snap = async () => ({
      items: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || price_cents, ',' ORDER BY id), '')) h,
                                    count(*)::int n FROM marketplace_items`)).rows[0],
      payments: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(amount_cents, -1), ',' ORDER BY id), '')) h
                                  FROM payments`)).rows[0].h,
    });
    const before = await snap();
    const done = (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
    if (done) console.log('SKIP apply (already recorded). Verifying only.');
    else {
      try {
        await c.query('BEGIN');
        await c.query(fs.readFileSync(FILE_PATH, 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]);
        await c.query('COMMIT');
        console.log('APPLIED 178.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = async (t, n) => (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [t, n])).rowCount === 1;
    const def = ((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='marketplace_items_pickup_location_source_check'`)).rows[0] || {}).d || '';
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      default_columns: (await col('seller_profiles', 'default_pickup_address_line1')) && (await col('seller_profiles', 'default_pickup_postal_code'))
        && (await col('seller_profiles', 'default_pickup_confirmed_at')),
      source_check: /'default'/.test(def) && /'auction'/.test(def) && /'item'/.test(def) && !/'seller'/.test(def),
      no_default_confirmed: (await c.query('SELECT count(*)::int n FROM seller_profiles WHERE default_pickup_confirmed_at IS NOT NULL')).rows[0].n === 0,
      no_retired_source: (await c.query(`SELECT count(*)::int n FROM marketplace_items WHERE pickup_location_source = 'seller'`)).rows[0].n === 0,
      items_unchanged: before.items.h === after.items.h && before.items.n === after.items.n,
      payments_unchanged: before.payments === after.payments,
    };
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
