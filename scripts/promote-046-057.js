#!/usr/bin/env node
/* PRODUCTION promotion — apply ONLY migrations 046..057, in order, fail-fast, idempotent.
 * Run: railway run --service advantage-auction-platform --environment production node scripts/promote-046-057.js
 * - Refuses any endpoint that is not production (ep-proud-leaf-an8pzkib).
 * - Uses the DIRECT endpoint (strips -pooler) for reliable DDL.
 * - Transaction per file; STOPS immediately on first error (no further migrations). */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const TARGETS = [
  '046_add_users_is_active.sql',
  '047_add_auction_revision_columns.sql',
  '048_add_auction_returned_to_draft_notification.sql',
  '049_add_auction_rejection_columns.sql',
  '050_add_auction_rejected_notification.sql',
  '051_expand_seller_type.sql',
  '052_create_lot_ai_verifications.sql',
  '053_create_agreement_templates.sql',
  '054_create_seller_terms.sql',
  '055_create_seller_identity.sql',
  '056_create_agreements.sql',
  '057_agreements_phase_b.sql',
];

const raw = process.env.DATABASE_URL || '';
if (!raw.includes('ep-proud-leaf-an8pzkib')) {
  console.error('REFUSING: DATABASE_URL is not the production endpoint (ep-proud-leaf-an8pzkib).');
  process.exit(2);
}
const direct = raw.replace('-pooler', ''); // PgBouncer transaction-mode is unreliable for DDL
console.log('Target: PRODUCTION (direct endpoint) — applying 046..057 only\n');

const pool = new Pool({ connectionString: direct, ssl: { rejectUnauthorized: false } });
const DIR = path.join(__dirname, '..', 'db', 'migrations');

(async () => {
  const c = await pool.connect();
  let ok = 0, skip = 0, failed = null;
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const applied = new Set((await c.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename));

    for (const f of TARGETS) {
      if (applied.has(f)) { console.log('SKIP  ' + f); skip++; continue; }
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('OK    ' + f);
        ok++;
      } catch (e) {
        await c.query('ROLLBACK');
        console.error('FAIL  ' + f + '  ::  ' + e.message);
        console.error('STOPPING IMMEDIATELY (fail-fast). No further migrations applied.');
        failed = f;
        process.exitCode = 1;
        break;
      }
    }
    console.log(`\nApplied ${ok}, skipped ${skip} of ${TARGETS.length}.` + (failed ? ` FAILED at ${failed}.` : ''));
  } finally {
    c.release();
    await pool.end();
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
