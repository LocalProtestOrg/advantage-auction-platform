#!/usr/bin/env node
/* prod-migrate-177.js — PRODUCTION-guarded apply of ONLY 177_marketplace_item_pickup_location.sql. Verifies: the pickup
   columns and source check exist; every item that received a pickup location got it from its OWN originating auction
   (source 'auction', matching that auction's address) and no item received one any other way; item count, price and
   status are unchanged; payments are unchanged. Reports items still missing a pickup location (they cannot go live). */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '177_marketplace_item_pickup_location.sql';
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
        console.log('APPLIED 177.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const col = async (n) => (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='marketplace_items' AND column_name=$1`, [n])).rowCount === 1;
    const withLoc = (await c.query(`SELECT count(*)::int n FROM marketplace_items WHERE pickup_address_line1 IS NOT NULL`)).rows[0].n;
    const fromOwnAuction = (await c.query(
      `SELECT count(*)::int n FROM marketplace_items mi JOIN auctions a ON a.id = mi.source_auction_id
        WHERE mi.pickup_address_line1 IS NOT NULL AND mi.pickup_location_source = 'auction'
          AND mi.pickup_address_line1 = btrim(a.street_address) AND mi.pickup_postal_code = btrim(a.zip)`)).rows[0].n;
    const missing = (await c.query(
      `SELECT status, count(*)::int n FROM marketplace_items WHERE pickup_address_line1 IS NULL GROUP BY 1 ORDER BY 1`)).rows;
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      pickup_columns: (await col('pickup_address_line1')) && (await col('pickup_city')) && (await col('pickup_state'))
        && (await col('pickup_postal_code')) && (await col('pickup_country')) && (await col('pickup_location_source')),
      every_backfill_from_own_auction: withLoc === fromOwnAuction,
      items_unchanged: before.items.h === after.items.h && before.items.n === after.items.n,
      payments_unchanged: before.payments === after.payments,
    };
    console.log(`Items with a pickup location: ${withLoc} (all from their own auction: ${fromOwnAuction}).`);
    console.log('Items still without a pickup location (cannot go live until the seller adds one):', JSON.stringify(missing));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
