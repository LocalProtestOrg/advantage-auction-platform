#!/usr/bin/env node
/* prod-migrate-179.js — PRODUCTION-guarded apply of ONLY 179_invoice_refund_status.sql. Verifies: combined invoices allow the
   two refund states; after the backfill no invoice linked to a refunded payment still says "paid"; payments are unchanged
   (the migration moves no money); only invoices linked to refunded payments changed. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '179_invoice_refund_status.sql';
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
      payments: (await c.query(`SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || amount_cents || ':' || coalesce(refunded_amount_cents, 0), ',' ORDER BY id), '')) h FROM payments`)).rows[0].h,
      // invoices NOT linked to a refunded payment must not change
      other_invoices: (await c.query(`SELECT md5(coalesce(string_agg(i.id::text || ':' || i.status, ',' ORDER BY i.id), '')) h FROM invoices i
        LEFT JOIN payments p ON p.id = i.payment_id WHERE p.status IS NULL OR p.status NOT IN ('refunded','partially_refunded')`)).rows[0].h,
      other_bai: (await c.query(`SELECT md5(coalesce(string_agg(b.id::text || ':' || b.status, ',' ORDER BY b.id), '')) h FROM buyer_auction_invoices b
        LEFT JOIN payments p ON p.id = b.payment_id WHERE p.status IS NULL OR p.status NOT IN ('refunded','partially_refunded')`)).rows[0].h,
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
        console.log('APPLIED 179.');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const after = await snap();
    const def = ((await c.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='buyer_auction_invoices_status_check'`)).rows[0] || {}).d || '';
    const stale = (await c.query(`SELECT
        (SELECT count(*)::int FROM invoices i JOIN payments p ON p.id = i.payment_id WHERE p.status IN ('refunded','partially_refunded') AND i.status = 'paid') +
        (SELECT count(*)::int FROM buyer_auction_invoices b JOIN payments p ON p.id = b.payment_id WHERE p.status IN ('refunded','partially_refunded') AND b.status = 'paid') AS n`)).rows[0].n;
    const synced = (await c.query(`SELECT
        (SELECT count(*)::int FROM invoices WHERE status IN ('refunded','partially_refunded')) AS invoices,
        (SELECT count(*)::int FROM buyer_auction_invoices WHERE status IN ('refunded','partially_refunded')) AS combined`)).rows[0];
    const checks = {
      recorded: (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0,
      check_allows_refund_states: /'refunded'/.test(def) && /'partially_refunded'/.test(def) && /'void'/.test(def),
      no_paid_invoice_for_refunded_payment: stale === 0,
      payments_unchanged: before.payments === after.payments,
      other_invoices_unchanged: before.other_invoices === after.other_invoices && before.other_bai === after.other_bai,
    };
    console.log('Invoices now in a refund state:', JSON.stringify(synced));
    console.log('Verify:', JSON.stringify(checks, null, 2));
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    console.log('RESULT: ' + (failed.length ? 'FAIL ' + failed.join(',') : 'PASS'));
    return failed.length ? 1 : 0;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });
