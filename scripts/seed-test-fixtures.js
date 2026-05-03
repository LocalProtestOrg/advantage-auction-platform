/**
 * Idempotent seed script for E2E test fixtures.
 * Run once after migrations to set up stable test data.
 * Safe to re-run: all inserts use ON CONFLICT DO NOTHING.
 *
 * Creates:
 *   - nonwinner@test.com buyer account
 *   - Bidding Test Fixture Auction (published, fixed UUID)
 *   - Bidding Test Fixture Lot (active, fixed UUID) inside that auction
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const FIXTURE_AUCTION_ID = 'f0000000-0000-4000-8000-000000000001';
const FIXTURE_LOT_ID     = 'f0000000-0000-4000-8000-000000000002';

// seller_profile from the seed DB (seller1@example.com)
const SELLER_PROFILE_ID  = '876f6172-96a4-4eeb-912e-1bb9ba760e58';
// admin user (created_by_user_id for the fixture auction)
const ADMIN_USER_ID      = '3d4a318a-5538-48f1-82f5-cae483e01725';

async function run() {
  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'advantage_auction',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'admin123',
  });

  try {
    const hash = await bcrypt.hash('password123', 10);

    // 1. nonwinner@test.com
    await pool.query(
      `INSERT INTO users (email, password_hash, role, is_active)
       VALUES ('nonwinner@test.com', $1, 'buyer', true)
       ON CONFLICT (email) DO NOTHING`,
      [hash]
    );
    console.log('[seed] nonwinner@test.com ready');

    // 2. Fixture auction (published so lots can be bid on)
    await pool.query(
      `INSERT INTO auctions (id, seller_profile_id, created_by_user_id, title, status)
       VALUES ($1, $2, $3, 'Bidding Test Fixture Auction', 'published')
       ON CONFLICT (id) DO NOTHING`,
      [FIXTURE_AUCTION_ID, SELLER_PROFILE_ID, ADMIN_USER_ID]
    );
    console.log('[seed] Fixture auction ready:', FIXTURE_AUCTION_ID);

    // 3. Active lot inside the fixture auction
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, status, pickup_category)
       VALUES ($1, $2, 'Bidding Test Fixture Lot', 'active', 'A')
       ON CONFLICT (id) DO NOTHING`,
      [FIXTURE_LOT_ID, FIXTURE_AUCTION_ID]
    );
    console.log('[seed] Active fixture lot ready:', FIXTURE_LOT_ID);

    console.log('\nAll fixtures ready. Add to .env:');
    console.log(`TEST_ACTIVE_LOT_ID=${FIXTURE_LOT_ID}`);
    console.log(`TEST_LOT_ID=7f44ab4b-52a6-4be2-8008-1f9be6c586c6`);
    console.log(`TEST_AUCTION_ID=565f9db4-1154-496d-bce8-f8cfb828d5f3`);
  } finally {
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
