#!/usr/bin/env node
/* validate-086.js — READ-ONLY validation of migration 086 on whichever DB
   DATABASE_URL points to. No writes. Prints PASS/FAIL per required item.
   Run via: railway run --service <svc> node scripts/validate-086.js */
const { Pool } = require('pg');
const PROD_EP = 'ep-proud-leaf-an8pzkib'; const STG_EP = 'ep-royal-dawn-anarou3f';
(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('DATABASE_URL not set'); process.exit(2); }
  const env = raw.includes(PROD_EP) ? 'PRODUCTION' : raw.includes(STG_EP) ? 'STAGING' : 'UNKNOWN';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const checks = [];
  const chk = (label, pass) => checks.push([label, !!pass]);
  try {
    chk('schema_migrations ledger entry (086_settlement_foundation.sql)',
      (await c.query(`SELECT 1 FROM schema_migrations WHERE filename='086_settlement_foundation.sql'`)).rowCount > 0);
    chk('table settlement_adjustments exists',
      (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name='settlement_adjustments'`)).rowCount > 0);
    chk('table settlement_snapshots exists',
      (await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name='settlement_snapshots'`)).rowCount > 0);
    const want = ['settlement_status','settlement_version','approved_at','approved_by_user_id','on_hold_reason',
                  'paid_at','paid_by_user_id','payment_method_used','final_amount_paid_cents'];
    const have = new Set((await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='seller_payouts'`)).rows.map(r => r.column_name));
    const missing = want.filter(x => !have.has(x));
    chk('seller_payouts additive columns (9)' + (missing.length ? ' MISSING:' + missing.join(',') : ''), missing.length === 0);
    chk('settlement_status CHECK constraint (chk_seller_payouts_settlement_status)',
      (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_seller_payouts_settlement_status'`)).rowCount > 0);
    chk('payment_method_used CHECK constraint (chk_seller_payouts_payment_method_used)',
      (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_seller_payouts_payment_method_used'`)).rowCount > 0);
    chk('unique versioning constraint UNIQUE(auction_id,version) on settlement_snapshots',
      (await c.query(`SELECT 1 FROM pg_constraint WHERE conrelid='settlement_snapshots'::regclass AND contype='u'`)).rowCount > 0);
    chk('immutable final-snapshot partial unique index (uq_settlement_snapshot_final)',
      (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname='uq_settlement_snapshot_final'`)).rowCount > 0);
    // Default for settlement_status is the workflow start state.
    const def = (await c.query(`SELECT column_default FROM information_schema.columns WHERE table_name='seller_payouts' AND column_name='settlement_status'`)).rows[0];
    chk("settlement_status default = 'pending_review'", def && /pending_review/.test(def.column_default || ''));

    const allPass = checks.every(x => x[1]);
    console.log('ENDPOINT: ' + env);
    checks.forEach(([l, p]) => console.log((p ? 'PASS' : 'FAIL') + '  ' + l));
    console.log('RESULT: ' + (allPass ? 'PASS' : 'FAIL'));
    process.exit(allPass ? 0 : 1);
  } finally { c.release(); await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
