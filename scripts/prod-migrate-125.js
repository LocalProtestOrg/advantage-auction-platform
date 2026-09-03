#!/usr/bin/env node
/* prod-migrate-125.js — PRODUCTION-guarded apply of ONLY 125_centralized_pricing.sql.
   Additive: publish-time pricing snapshot on auctions, separate processing columns on seller_payouts,
   centralized pricing config seed, and legacy protection (freezes existing live/historical auctions).
   Idempotent. Never recalculates historical seller_payouts. */
const fs = require('fs'); const path = require('path'); const { Pool } = require('pg');
const FILE = '125_centralized_pricing.sql';
const FILE_PATH = path.join(__dirname, '..', 'db', 'migrations', FILE);
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
const ledgerHas = async (c) => (await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [FILE])).rowCount > 0;
const verify = async (c) => (await c.query(`
  SELECT
    (SELECT count(*)::int FROM information_schema.columns
       WHERE table_name='auctions' AND column_name IN ('platform_fee_bps','processing_fee_bps','pricing_model','pricing_snapshot_at')) AS auction_cols,
    (SELECT count(*)::int FROM information_schema.columns
       WHERE table_name='seller_payouts' AND column_name IN ('processing_fee_bps','processing_fee_cents')) AS payout_cols,
    (SELECT count(*)::int FROM platform_config WHERE key LIKE 'pricing.%') AS pricing_keys,
    (SELECT count(*)::int FROM auctions
       WHERE (state IN ('published','active','closed') OR is_archived IS TRUE) AND pricing_model IS NULL) AS unfrozen_live,
    (SELECT value::text FROM platform_config WHERE key='pricing.auction.professional.platform_fee_bps') AS platform_bps,
    (SELECT value::text FROM platform_config WHERE key='pricing.auction.processing_fee_bps') AS processing_bps,
    (SELECT count(*)::int FROM platform_config WHERE key LIKE 'pricing.%' AND value::text = '700') AS combined_total_keys
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
      try { await c.query(sql); await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [FILE]); await c.query('COMMIT'); console.log('APPLIED 125 and recorded its ledger row.'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('APPLY FAILED:', e.message); return 1; }
    }
    const recorded = await ledgerHas(c); const v = await verify(c);
    console.log('Verify:', JSON.stringify(v), 'ledger:', recorded);
    const pass = recorded && v.auction_cols === 4 && v.payout_cols === 2 && v.pricing_keys >= 7
      && v.unfrozen_live === 0 && v.platform_bps === '400' && v.processing_bps === '300' && v.combined_total_keys === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } finally { c.release(); await pool.end(); }
})().then((code) => process.exit(code || 0)).catch((e) => { console.error(e); process.exit(1); });
