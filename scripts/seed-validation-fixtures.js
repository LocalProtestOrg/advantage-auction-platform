'use strict';

/**
 * Deterministic validation-only fixture accounts.
 *
 * Creates two accounts used exclusively for automated validation scripts.
 * Both use fixed UUIDs (ee000000-* namespace) and are idempotent — safe to
 * run repeatedly against production.
 *
 * Accounts created:
 *   validation-admin@advantage.bid  — role: admin
 *   validation-buyer@advantage.bid  — role: buyer
 *
 * These accounts have no seller_profile and are not used for any auction
 * operations. They exist only to exercise auth guards in validation scripts.
 *
 * Run:  node scripts/seed-validation-fixtures.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

const VALIDATION_ADMIN_ID    = 'ee000000-0000-4000-8000-000000000001';
const VALIDATION_BUYER_ID    = 'ee000000-0000-4000-8000-000000000002';
const VALIDATION_ADMIN_EMAIL = 'validation-admin@advantage.bid';
const VALIDATION_BUYER_EMAIL = 'validation-buyer@advantage.bid';
const VALIDATION_ADMIN_PASS  = 'ValidationAdmin2025!';
const VALIDATION_BUYER_PASS  = 'ValidationBuyer2025!';

function log(msg) { console.log('[validation-seed] ' + msg); }

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    log('Hashing passwords…');
    const [adminHash, buyerHash] = await Promise.all([
      bcrypt.hash(VALIDATION_ADMIN_PASS, 10),
      bcrypt.hash(VALIDATION_BUYER_PASS, 10),
    ]);

    // Validation admin — role: admin
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (email) DO NOTHING`,
      [VALIDATION_ADMIN_ID, VALIDATION_ADMIN_EMAIL, adminHash]
    );
    log('validation-admin@advantage.bid ready (role=admin, id=' + VALIDATION_ADMIN_ID + ')');

    // Validation buyer — role: buyer
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, $3, 'buyer')
       ON CONFLICT (email) DO NOTHING`,
      [VALIDATION_BUYER_ID, VALIDATION_BUYER_EMAIL, buyerHash]
    );
    log('validation-buyer@advantage.bid ready (role=buyer, id=' + VALIDATION_BUYER_ID + ')');

    // Confirm both rows exist and have the expected roles
    const { rows } = await pool.query(
      `SELECT id, email, role FROM users WHERE email = ANY($1) ORDER BY email`,
      [[VALIDATION_ADMIN_EMAIL, VALIDATION_BUYER_EMAIL]]
    );
    log('Verification:');
    for (const r of rows) {
      log('  ' + r.email + ' | role=' + r.role + ' | id=' + r.id);
    }

    if (rows.length !== 2) {
      log('WARNING: expected 2 rows, got ' + rows.length);
      process.exitCode = 1;
    } else {
      log('Seed complete — both validation accounts confirmed.');
    }
  } finally {
    await pool.end();
  }
}

run().catch(e => {
  console.error('[validation-seed] FATAL:', e.message);
  process.exitCode = 1;
});
