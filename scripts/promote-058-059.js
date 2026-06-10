#!/usr/bin/env node
/*
 * promote-058-059.js — STAGING-ONLY apply tool for Line B Phase 1 migrations.
 *
 * Applies, in order:
 *   1. db/migrations/058_extend_stripe_webhook_events.sql
 *   2. db/migrations/059_add_payments_refunded_amount.sql
 *
 * This is an executable STAGING tool, NOT a production migration run.
 *
 * Safety:
 *   - Refuses unless DATABASE_URL is the STAGING Neon endpoint (ep-royal-dawn-anarou3f).
 *   - Explicitly refuses the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).
 *   - Uses the DIRECT (non-pooler) endpoint for DDL.
 *   - Filename-based idempotency via schema_migrations (same convention as
 *     scripts/run-migrations.js); already-recorded migrations are SKIPPED.
 *   - Fail-fast: stops on first error, rolls back that migration's transaction.
 *   - Never prints DATABASE_URL or any secret. Touches only 058/059 schema
 *     changes + schema_migrations bookkeeping.
 *
 * Run (only when intentionally applying staging migrations):
 *   railway run --service advantage-staging --environment production node scripts/promote-058-059.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS = [
  '058_extend_stripe_webhook_events.sql',
  '059_add_payments_refunded_amount.sql',
];
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const raw = process.env.DATABASE_URL || '';

// (2) Explicitly refuse production.
if (raw.includes('ep-proud-leaf-an8pzkib')) {
  console.error('REFUSING: DATABASE_URL points to the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).');
  console.error('         This script is STAGING-ONLY. Aborting with no changes.');
  process.exit(2);
}
// (1) Require staging.
if (!raw.includes('ep-royal-dawn-anarou3f')) {
  console.error('REFUSING: DATABASE_URL is not the STAGING endpoint (ep-royal-dawn-anarou3f).');
  console.error('         Refusing to run. Aborting with no changes.');
  process.exit(2);
}

// (3) Direct (non-pooler) endpoint — PgBouncer transaction-mode is unreliable for DDL.
const directConnString = raw.replace('-pooler', '');
const pool = new Pool({ connectionString: directConnString, ssl: { rejectUnauthorized: false } });

function line() { console.log('-'.repeat(60)); }

async function ensureTrackingTable(client) {
  // Matches scripts/run-migrations.js exactly (filename-based tracking).
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

(async () => {
  const client = await pool.connect();
  let applied = 0, skipped = 0, failedAt = null;
  try {
    // Target confirmation (no secrets / no DATABASE_URL printed).
    const who = await client.query('SELECT current_database() AS db, current_user AS usr');
    line();
    console.log('Target DB confirmed : STAGING (ep-royal-dawn-anarou3f)');
    console.log(`  database          : ${who.rows[0].db}`);
    console.log(`  user              : ${who.rows[0].usr}`);
    console.log(`  endpoint mode     : direct (pooler stripped)`);
    line();

    // (8) Migration files found.
    console.log('Migration files:');
    for (const f of MIGRATIONS) {
      const p = path.join(MIGRATIONS_DIR, f);
      if (!fs.existsSync(p)) {
        console.error(`  MISSING ${f} — expected at ${path.relative(process.cwd(), p)}`);
        console.error('FAIL: migration file not found. Aborting with no changes.');
        process.exit(1);
      }
      console.log(`  found   ${f}`);
    }
    line();

    // (5) Idempotency — read already-applied filenames.
    await ensureTrackingTable(client);
    const appliedSet = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map(r => r.filename)
    );

    // (4)(6) Apply in order, fail-fast, transaction per file.
    console.log('Applying migrations (058 then 059):');
    for (const f of MIGRATIONS) {
      if (appliedSet.has(f)) {
        console.log(`  SKIP  ${f} (already recorded in schema_migrations)`);
        skipped++;
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`  OK    ${f}`);
        applied++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failedAt = f;
        console.error(`  FAIL  ${f}`);
        console.error(`        ${err.message}`);
        console.error('Fail-fast: transaction rolled back; no further migrations applied.');
        break;
      }
    }
    line();
    console.log(`Applied ${applied}, skipped ${skipped} of ${MIGRATIONS.length}.` + (failedAt ? `  FAILED at ${failedAt}.` : ''));
    line();

    if (failedAt) {
      console.error('RESULT: FAIL');
      process.exitCode = 1;
      return;
    }

    // (7) Verification.
    console.log('Verification:');
    const cols058 = ['status', 'payload', 'last_error', 'attempt_count', 'received_at'];
    const have058 = new Set(
      (await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='stripe_webhook_events' AND column_name = ANY($1)",
        [cols058]
      )).rows.map(r => r.column_name)
    );
    const sw_status_ok = have058.has('status');
    console.log(`  058 stripe_webhook_events.status present : ${sw_status_ok ? 'YES' : 'NO'}`);
    console.log(`      058 columns present                  : ${cols058.filter(c => have058.has(c)).join(', ') || '(none)'}`);

    const refundCol = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='refunded_amount_cents'"
    );
    const refunded_ok = refundCol.rowCount === 1;
    console.log(`  059 payments.refunded_amount_cents present: ${refunded_ok ? 'YES' : 'NO'}`);

    const recorded = new Set(
      (await client.query('SELECT filename FROM schema_migrations WHERE filename = ANY($1)', [MIGRATIONS])).rows.map(r => r.filename)
    );
    const tracked_ok = MIGRATIONS.every(f => recorded.has(f));
    console.log(`  schema_migrations contains 058 + 059     : ${tracked_ok ? 'YES' : 'NO'}`);

    line();
    const pass = sw_status_ok && refunded_ok && tracked_ok;
    console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
