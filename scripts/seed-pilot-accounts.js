'use strict';

/**
 * Pilot rehearsal accounts — 5 sellers + 5 buyers.
 *
 * Idempotent: ON CONFLICT DO NOTHING on every insert.
 * Safe to re-run against production.
 *
 * Run:  node scripts/seed-pilot-accounts.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcrypt');

// ── Fixed UUIDs (aa namespace = pilot accounts) ───────────────────────────────
// Seller user IDs
const S_USERS = [
  'aa000000-0000-4000-8000-000000000101',
  'aa000000-0000-4000-8000-000000000102',
  'aa000000-0000-4000-8000-000000000103',
  'aa000000-0000-4000-8000-000000000104',
  'aa000000-0000-4000-8000-000000000105',
];
// Seller profile IDs (one per seller user)
const S_PROFILES = [
  'aa000000-0000-4000-8000-000000000201',
  'aa000000-0000-4000-8000-000000000202',
  'aa000000-0000-4000-8000-000000000203',
  'aa000000-0000-4000-8000-000000000204',
  'aa000000-0000-4000-8000-000000000205',
];
// Buyer user IDs
const B_USERS = [
  'aa000000-0000-4000-8000-000000000301',
  'aa000000-0000-4000-8000-000000000302',
  'aa000000-0000-4000-8000-000000000303',
  'aa000000-0000-4000-8000-000000000304',
  'aa000000-0000-4000-8000-000000000305',
];

const SELLER_EMAILS = [
  'pilot-seller1@advantage.bid',
  'pilot-seller2@advantage.bid',
  'pilot-seller3@advantage.bid',
  'pilot-seller4@advantage.bid',
  'pilot-seller5@advantage.bid',
];
const BUYER_EMAILS = [
  'pilot-buyer1@advantage.bid',
  'pilot-buyer2@advantage.bid',
  'pilot-buyer3@advantage.bid',
  'pilot-buyer4@advantage.bid',
  'pilot-buyer5@advantage.bid',
];

const PASSWORD = 'PilotTest2026!';

function log(msg) { console.log('[pilot-seed] ' + msg); }

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    log('Hashing password…');
    const hash = await bcrypt.hash(PASSWORD, 10);

    // ── Sellers ───────────────────────────────────────────────────────────────
    log('Creating seller users…');
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, role)
         VALUES ($1, $2, $3, 'seller')
         ON CONFLICT (email) DO NOTHING`,
        [S_USERS[i], SELLER_EMAILS[i], hash]
      );
      await pool.query(
        `INSERT INTO seller_profiles (id, user_id, seller_type)
         VALUES ($1, $2, 'private')
         ON CONFLICT (user_id) DO NOTHING`,
        [S_PROFILES[i], S_USERS[i]]
      );
      log(`  ${SELLER_EMAILS[i]} (user=${S_USERS[i]}, profile=${S_PROFILES[i]})`);
    }

    // ── Buyers ────────────────────────────────────────────────────────────────
    log('Creating buyer users…');
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, role)
         VALUES ($1, $2, $3, 'buyer')
         ON CONFLICT (email) DO NOTHING`,
        [B_USERS[i], BUYER_EMAILS[i], hash]
      );
      log(`  ${BUYER_EMAILS[i]} (user=${B_USERS[i]})`);
    }

    // ── Verify ────────────────────────────────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, sp.id AS seller_profile_id
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id
       WHERE u.email = ANY($1)
       ORDER BY u.role DESC, u.email`,
      [[...SELLER_EMAILS, ...BUYER_EMAILS]]
    );

    log('\nVerification:');
    for (const r of rows) {
      const sp = r.seller_profile_id ? ` profile=${r.seller_profile_id}` : '';
      log(`  ${r.email} | role=${r.role}${sp}`);
    }

    if (rows.length !== 10) {
      log(`WARNING: expected 10 rows, got ${rows.length}`);
      process.exitCode = 1;
    } else {
      log('\nSeed complete — 10 pilot accounts confirmed.');
    }
  } finally {
    await pool.end();
  }
}

run().catch(e => {
  console.error('[pilot-seed] FATAL:', e.message);
  process.exitCode = 1;
});
