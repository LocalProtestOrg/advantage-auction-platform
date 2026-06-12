#!/usr/bin/env node
/*
 * prod-migrate-core.js — PRODUCTION-guarded, single-migration apply runner for the
 * launch-day-buyer-ux promotion (058–064). NOT a general migration runner.
 *
 * Safety:
 *   - REQUIRES the production endpoint (ep-proud-leaf-an8pzkib) in DATABASE_URL.
 *   - REFUSES the staging endpoint (ep-royal-dawn-anarou3f).
 *   - Applies ONLY the one migration passed to applyOne(num). Never calls
 *     run-migrations.js, never iterates the migrations dir.
 *   - Idempotent: if schema_migrations already records the file, SKIP the apply
 *     (still runs verification).
 *   - 059 runs a read-only partially_refunded pre-check and STOPS if count > 0
 *     unless ALLOW_PARTIAL_REFUNDED=1 (see docs/sop-refunds.md).
 *   - DDL on the DIRECT endpoint (strips -pooler). Transaction per migration.
 *   - Never prints DATABASE_URL or any secret.
 *
 * Use (only when intentionally promoting to production, after backup):
 *   railway run --service advantage-auction-platform --environment production node scripts/prod-migrate-058.js
 *   ... 059 (with ALLOW_PARTIAL_REFUNDED=1 only if the pre-check was reviewed) ...
 *   ... 060 061 062 063 064 in order ...
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// Only these may be applied by this runner. file + post-apply verification.
const MIGS = {
  '058': {
    file: '058_extend_stripe_webhook_events.sql',
    verify: async (c) => {
      const cols = (await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='stripe_webhook_events'
            AND column_name = ANY($1)`, [['status','payload','last_error','attempt_count','received_at']]
      )).rows.map(r => r.column_name);
      const idx = (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname='idx_stripe_webhook_events_status_received'`)).rowCount;
      return { ok: cols.length === 5 && idx === 1, detail: `cols=${cols.length}/5 idx=${idx}` };
    },
  },
  '059': {
    file: '059_add_payments_refunded_amount.sql',
    preCheck: async (c) => {
      const n = (await c.query(`SELECT count(*)::int n FROM payments WHERE status='partially_refunded'`)).rows[0].n;
      if (n > 0 && process.env.ALLOW_PARTIAL_REFUNDED !== '1') {
        return { stop: true, message: `partially_refunded = ${n} (> 0). 059 marks partial->full refunded. ` +
          `Reconcile vs Stripe per docs/sop-refunds.md, then re-run with ALLOW_PARTIAL_REFUNDED=1.` };
      }
      return { stop: false, message: `partially_refunded = ${n} (ok)` };
    },
    verify: async (c) => {
      const col = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='payments' AND column_name='refunded_amount_cents'`)).rowCount;
      const con = (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_refunded_amount_bounded'`)).rowCount;
      const viol = (await c.query(`SELECT count(*)::int n FROM payments WHERE refunded_amount_cents < 0 OR refunded_amount_cents > amount_cents`)).rows[0].n;
      return { ok: col === 1 && con === 1 && viol === 0, detail: `col=${col} constraint=${con} violations=${viol}` };
    },
  },
  '060': {
    file: '060_add_users_password_hash.sql',
    verify: async (c) => {
      const col = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_hash'`)).rowCount;
      return { ok: col === 1, detail: `users.password_hash present=${col} (no-op on prod; ledger recorded)` };
    },
  },
  '061': {
    file: '061_create_terms.sql',
    verify: async (c) => {
      const tv = (await c.query(`SELECT to_regclass('public.terms_versions') AS t`)).rows[0].t;
      const ta = (await c.query(`SELECT to_regclass('public.terms_acceptances') AS t`)).rows[0].t;
      const cur = (await c.query(`SELECT version_int FROM terms_versions WHERE kind='buyer_terms' AND is_current=true`)).rows[0];
      return { ok: !!tv && !!ta && cur && cur.version_int === 1, detail: `terms_versions=${tv} terms_acceptances=${ta} current_v=${cur && cur.version_int}` };
    },
  },
  '062': {
    file: '062_extend_auction_buyers_registration.sql',
    verify: async (c) => {
      const cols = (await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='auction_buyers' AND column_name = ANY($1)`,
        [['terms_acceptance_id','pickup_acknowledged','status']]
      )).rows.map(r => r.column_name);
      const idx = (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname='idx_auction_buyers_unique_reg'`)).rowCount;
      const con = (await c.query(`SELECT 1 FROM pg_constraint WHERE conname='chk_auction_buyers_status'`)).rowCount;
      return { ok: cols.length === 3 && idx === 1 && con === 1, detail: `cols=${cols.length}/3 uniqueIdx=${idx} statusChk=${con}` };
    },
  },
  '063': {
    file: '063_add_stripe_customer_and_pm.sql',
    verify: async (c) => {
      const u = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='stripe_customer_id'`)).rowCount;
      const cv = (await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='card_verifications' AND column_name='stripe_payment_method_id'`)).rowCount;
      return { ok: u === 1 && cv === 1, detail: `users.stripe_customer_id=${u} card_verifications.stripe_payment_method_id=${cv}` };
    },
  },
  '064': {
    file: '064_add_auction_archive.sql',
    verify: async (c) => {
      const cols = (await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='auctions' AND column_name = ANY($1)`,
        [['is_archived','archived_at','archived_by','archive_reason']]
      )).rows.map(r => r.column_name);
      const idx = (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname='idx_auctions_is_archived'`)).rowCount;
      return { ok: cols.length === 4 && idx === 1, detail: `cols=${cols.length}/4 idx=${idx}` };
    },
  },
};

function line() { console.log('-'.repeat(60)); }

async function applyOne(num) {
  const mig = MIGS[num];
  if (!mig) { console.error(`REFUSE: '${num}' is not an approved migration (058–064 only).`); return 2; }

  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: DATABASE_URL is the STAGING endpoint. This script is PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: DATABASE_URL is not the PRODUCTION endpoint (ep-proud-leaf-an8pzkib).'); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const who = (await c.query('SELECT current_database() AS db')).rows[0].db;
    line();
    console.log(`PRODUCTION migrate: ${mig.file}`);
    console.log(`  database : ${who}  | endpoint: direct (pooler stripped)`);
    line();

    const filePath = path.join(MIGRATIONS_DIR, mig.file);
    if (!fs.existsSync(filePath)) { console.error(`FAIL: migration file not found: ${mig.file}`); return 1; }

    const before = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [mig.file])).rowCount > 0;
    console.log(`schema_migrations BEFORE: ${before ? 'already recorded' : 'not recorded'}`);

    if (mig.preCheck) {
      const pc = await mig.preCheck(c);
      console.log(`pre-check: ${pc.message}`);
      if (pc.stop) { console.error('STOP (pre-check gate). No changes made.'); return 2; }
    }

    if (before) {
      console.log('SKIP apply (already recorded; idempotent). Running verification only.');
    } else {
      const sql = fs.readFileSync(filePath, 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [mig.file]);
        await c.query('COMMIT');
        console.log('APPLIED + recorded.');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        console.error('FAIL during apply (rolled back):', e.message);
        return 1;
      }
    }

    const after = (await c.query(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [mig.file])).rowCount > 0;
    const v = await mig.verify(c);
    line();
    console.log(`schema_migrations AFTER : ${after ? 'recorded' : 'NOT recorded'}`);
    console.log(`schema objects          : ${v.detail}`);
    const pass = after && v.ok;
    console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`);
    line();
    return pass ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    return 1;
  } finally {
    c.release();
    await pool.end();
  }
}

module.exports = { applyOne, MIGS };
