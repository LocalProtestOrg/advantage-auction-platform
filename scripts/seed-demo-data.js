'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// ---------------------------------------------------------------------------
// Fixed UUIDs — every value must stay constant across re-runs for idempotency
// ---------------------------------------------------------------------------
const IDS = {
  BUYER_USER:  'dd000000-0000-4000-8000-000000000001',
  SELLER_USER: 'dd000000-0000-4000-8000-000000000002',
  SELLER_SP:   'dd000000-0000-4000-8000-000000000003', // seller_profile
  AUCTION_1:   'dd000000-0000-4000-8000-000000000010', // Fine Jewelry & Watches
  AUCTION_2:   'dd000000-0000-4000-8000-000000000020', // Mid-Century Modern Furniture
  AUCTION_3:   'dd000000-0000-4000-8000-000000000030', // Vintage Electronics
  // Auction 1 lots
  A1L1: 'dd000000-0000-4000-8000-000000000011', // 14K Gold & Diamond Pendant (buyer won → paid)
  A1L2: 'dd000000-0000-4000-8000-000000000012', // Art Deco Pearl Bracelet (buyer won → paid)
  A1L3: 'dd000000-0000-4000-8000-000000000013', // Vintage Omega Constellation Watch (unsold)
  A1L4: 'dd000000-0000-4000-8000-000000000014', // Sapphire & White Gold Earrings (unsold)
  // Auction 2 lots
  A2L1: 'dd000000-0000-4000-8000-000000000021', // Eames-Era Lounge Chair (buyer won → pending)
  A2L2: 'dd000000-0000-4000-8000-000000000022', // Walnut Credenza (unsold)
  A2L3: 'dd000000-0000-4000-8000-000000000023', // Vintage Arco Floor Lamp (unsold)
  // Auction 3 lots
  A3L1: 'dd000000-0000-4000-8000-000000000031', // Leica M6 35mm Camera (unsold)
  A3L2: 'dd000000-0000-4000-8000-000000000032', // IBM Selectric II Typewriter (unsold)
  // Payments
  PMT1: 'dd000000-0000-4000-8000-000000000041', // A1L1 paid
  PMT2: 'dd000000-0000-4000-8000-000000000042', // A1L2 paid
  PMT3: 'dd000000-0000-4000-8000-000000000043', // A2L1 pending
  // Invoices
  INV1: 'dd000000-0000-4000-8000-000000000051', // A1L1 invoice status='paid'
  INV2: 'dd000000-0000-4000-8000-000000000052', // A1L2 invoice status='paid'
  INV3: 'dd000000-0000-4000-8000-000000000053', // A2L1 invoice status='issued'
};

const DEMO_PASSWORD = 'DemoExplore2025!';

// ---------------------------------------------------------------------------
// Lot image URLs (Unsplash)
// ---------------------------------------------------------------------------
const LOT_IMAGES = {
  [IDS.A1L1]: 'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=800&h=600&fit=crop&q=80',
  [IDS.A1L2]: 'https://images.unsplash.com/photo-1602173574767-37ac01994b2a?w=800&h=600&fit=crop&q=80',
  [IDS.A1L3]: 'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?w=800&h=600&fit=crop&q=80',
  [IDS.A1L4]: 'https://images.unsplash.com/photo-1535556116002-6281ff3e9f36?w=800&h=600&fit=crop&q=80',
  [IDS.A2L1]: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=600&fit=crop&q=80',
  [IDS.A2L2]: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&h=600&fit=crop&q=80',
  [IDS.A2L3]: 'https://images.unsplash.com/photo-1543159006-2e0c69cfe5b1?w=800&h=600&fit=crop&q=80',
  [IDS.A3L1]: 'https://images.unsplash.com/photo-1461360228754-6e81c478b882?w=800&h=600&fit=crop&q=80',
  [IDS.A3L2]: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&h=600&fit=crop&q=80',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
  console.log(`[demo-seed] ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    log('Connecting to database...');
    await pool.query('SELECT 1'); // smoke-test the connection
    log('Database connection OK');

    // -----------------------------------------------------------------------
    // Step 1: Hash password
    // -----------------------------------------------------------------------
    log('Hashing demo password...');
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    log('Password hash ready');

    // -----------------------------------------------------------------------
    // Step 2: Insert demo-buyer user
    // -----------------------------------------------------------------------
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, $3, 'buyer')
       ON CONFLICT (email) DO NOTHING`,
      [IDS.BUYER_USER, 'demo-buyer@advantage.bid', passwordHash]
    );
    log('Created demo-buyer account (or already existed)');

    // -----------------------------------------------------------------------
    // Step 3: Insert demo-seller user
    // -----------------------------------------------------------------------
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role)
       VALUES ($1, $2, $3, 'seller')
       ON CONFLICT (email) DO NOTHING`,
      [IDS.SELLER_USER, 'demo-seller@advantage.bid', passwordHash]
    );
    log('Created demo-seller account (or already existed)');

    // -----------------------------------------------------------------------
    // Step 4: Insert seller_profile for demo-seller
    // -----------------------------------------------------------------------
    // Look up the actual user id for demo-seller (in case of email conflict the
    // fixed UUID may differ from the row that already existed).
    const sellerUserRow = await pool.query(
      `SELECT id FROM users WHERE email = $1`,
      ['demo-seller@advantage.bid']
    );
    const sellerUserId = sellerUserRow.rows[0].id;

    await pool.query(
      `INSERT INTO seller_profiles (id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [IDS.SELLER_SP, sellerUserId]
    );
    log('Created seller_profile for demo-seller (or already existed)');

    // -----------------------------------------------------------------------
    // Step 5: Insert auctions
    // -----------------------------------------------------------------------

    // Auction 1 — Estate Fine Jewelry & Watch Collection
    await pool.query(
      `INSERT INTO auctions (id, seller_id, title, description, state, start_time, end_time)
       VALUES ($1, $2, $3, $4, 'closed',
               NOW() - INTERVAL '60 days',
               NOW() - INTERVAL '57 days')
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.AUCTION_1,
        IDS.SELLER_SP,
        'Estate Fine Jewelry & Watch Collection',
        'A curated collection of fine jewelry and timepieces from a private estate.',
      ]
    );
    log('Created Auction 1 — Estate Fine Jewelry & Watch Collection (or already existed)');

    // Auction 2 — Mid-Century Modern Furniture + Decor
    await pool.query(
      `INSERT INTO auctions (id, seller_id, title, description, state, start_time, end_time)
       VALUES ($1, $2, $3, $4, 'closed',
               NOW() - INTERVAL '35 days',
               NOW() - INTERVAL '32 days')
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.AUCTION_2,
        IDS.SELLER_SP,
        'Mid-Century Modern Furniture + Decor',
        'Authenticated mid-century pieces sourced from a designer estate in Palm Springs.',
      ]
    );
    log('Created Auction 2 — Mid-Century Modern Furniture + Decor (or already existed)');

    // Auction 3 — Vintage Electronics & Collector Items
    await pool.query(
      `INSERT INTO auctions (id, seller_id, title, description, state, start_time, end_time)
       VALUES ($1, $2, $3, $4, 'closed',
               NOW() - INTERVAL '90 days',
               NOW() - INTERVAL '87 days')
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.AUCTION_3,
        IDS.SELLER_SP,
        'Vintage Electronics & Collector Items',
        'Functional vintage electronics and typewriters for collectors and enthusiasts.',
      ]
    );
    log('Created Auction 3 — Vintage Electronics & Collector Items (or already existed)');

    // -----------------------------------------------------------------------
    // Step 6: Insert lots
    // -----------------------------------------------------------------------

    // --- Auction 1 lots ---

    // A1L1: 14K Gold & Diamond Pendant Necklace (buyer won → paid)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 1, 5000, 1000, 'S',
               87500, $5, 87500)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A1L1,
        IDS.AUCTION_1,
        '14K Gold & Diamond Pendant Necklace',
        'Elegant 14K yellow gold pendant set with a round brilliant-cut diamond. Total carat weight approximately 0.45ct. Includes 18" chain. Hallmarked.',
        IDS.BUYER_USER,
      ]
    );
    log('Created lot A1L1 — 14K Gold & Diamond Pendant Necklace (or already existed)');

    // A1L2: Art Deco Pearl Bracelet, c. 1930 (buyer won → paid)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 2, 2500, 500, 'S',
               42000, $5, 42000)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A1L2,
        IDS.AUCTION_1,
        'Art Deco Pearl Bracelet, c. 1930',
        'Genuine freshwater pearl bracelet with platinum Art Deco clasp, circa 1930. Three strands, 7.5" length. All pearls intact, clasp functions perfectly.',
        IDS.BUYER_USER,
      ]
    );
    log('Created lot A1L2 — Art Deco Pearl Bracelet (or already existed)');

    // A1L3: Vintage Omega Constellation Watch, 1960s (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 3, 10000, 2500, 'S',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A1L3,
        IDS.AUCTION_1,
        'Vintage Omega Constellation Watch, 1960s',
        'Stainless steel Omega Constellation with original pie-pan dial, circa 1965. Automatic movement serviced 2023. Case diameter 34mm. Light wear consistent with age.',
      ]
    );
    log('Created lot A1L3 — Vintage Omega Constellation Watch (or already existed)');

    // A1L4: Sapphire & White Gold Drop Earrings (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 4, 5000, 1000, 'S',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A1L4,
        IDS.AUCTION_1,
        'Sapphire & White Gold Drop Earrings',
        '18K white gold drop earrings each set with an oval blue sapphire (approx. 1.2ct each) surrounded by pavé diamonds. Post and clip back. Estate piece, excellent condition.',
      ]
    );
    log('Created lot A1L4 — Sapphire & White Gold Drop Earrings (or already existed)');

    // --- Auction 2 lots ---

    // A2L1: Eames-Era Lounge Chair & Ottoman (buyer won → pending)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 1, 10000, 2500, 'L',
               185000, $5, 185000)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A2L1,
        IDS.AUCTION_2,
        'Eames-Era Lounge Chair & Ottoman',
        'Herman Miller Eames lounge chair and ottoman in original rosewood veneer with black leather upholstery, circa 1970s. All original labels present. Minor patina consistent with age; structurally sound.',
        IDS.BUYER_USER,
      ]
    );
    log('Created lot A2L1 — Eames-Era Lounge Chair & Ottoman (or already existed)');

    // A2L2: Walnut Credenza with Sliding Doors, c. 1962 (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 2, 5000, 1000, 'L',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A2L2,
        IDS.AUCTION_2,
        'Walnut Credenza with Sliding Doors, c. 1962',
        'Six-foot solid walnut credenza with four sliding tambour doors revealing interior shelving and a single drawer. Tapered hairpin legs. Palm Springs provenance. Original finish.',
      ]
    );
    log('Created lot A2L2 — Walnut Credenza (or already existed)');

    // A2L3: Arco Floor Lamp, Vintage Original (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 3, 3000, 500, 'M',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A2L3,
        IDS.AUCTION_2,
        'Arco Floor Lamp, Vintage Original',
        'Vintage Arco-style floor lamp with white Carrara marble base and arching chrome stem. Original aluminum shade. Rewired to current code. Height 95", reach 79".',
      ]
    );
    log('Created lot A2L3 — Arco Floor Lamp (or already existed)');

    // --- Auction 3 lots ---

    // A3L1: Leica M6 35mm Film Camera with 50mm Lens (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 1, 10000, 2500, 'S',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A3L1,
        IDS.AUCTION_3,
        'Leica M6 35mm Film Camera with 50mm Lens',
        'Leica M6 classic rangefinder camera body in chrome finish with original Leica Summicron-M 50mm f/2 lens. Shutter fires on all speeds. Light seals replaced 2022. Comes with original box, caps, and strap.',
      ]
    );
    log('Created lot A3L1 — Leica M6 35mm Film Camera (or already existed)');

    // A3L2: IBM Selectric II Electric Typewriter, 1973 (unsold)
    await pool.query(
      `INSERT INTO lots (id, auction_id, title, description, state, lot_number,
                         starting_bid_cents, bid_increment_cents, pickup_category,
                         current_bid_cents, winning_buyer_user_id, winning_amount_cents)
       VALUES ($1, $2, $3, $4, 'closed', 2, 2500, 500, 'M',
               NULL, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        IDS.A3L2,
        IDS.AUCTION_3,
        'IBM Selectric II Electric Typewriter, 1973',
        'IBM Selectric II in slate grey, manufactured 1973. Fully serviced and operational. Includes three type balls (Courier, Prestige Elite, Script). Original dust cover included. Minimal external wear.',
      ]
    );
    log('Created lot A3L2 — IBM Selectric II Electric Typewriter (or already existed)');

    // -----------------------------------------------------------------------
    // Step 7: Insert lot images (WHERE NOT EXISTS — handles tables without
    //          a unique constraint on lot_id)
    // -----------------------------------------------------------------------
    const lotImageEntries = Object.entries(LOT_IMAGES);
    for (const [lotId, imageUrl] of lotImageEntries) {
      await pool.query(
        `INSERT INTO lot_images (lot_id, image_url, sort_order)
         SELECT $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM lot_images WHERE lot_id = $1
         )`,
        [lotId, imageUrl, 0]
      );
    }
    log(`Inserted lot images for ${lotImageEntries.length} lots (skipped any already present)`);

    // -----------------------------------------------------------------------
    // Step 8: Insert payments
    // -----------------------------------------------------------------------

    // PMT1 — A1L1, status=paid
    await pool.query(
      `INSERT INTO payments (id, auction_id, lot_id, buyer_user_id, amount_cents,
                              status, payment_intent_id, payment_provider_id,
                              charged_at, last_attempted_at)
       VALUES ($1, $2, $3, $4, 87500,
               'paid', 'pi_demo_a1l1_jewelry', 'pi_demo_a1l1_jewelry',
               NOW() - INTERVAL '56 days', NOW() - INTERVAL '56 days')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.PMT1, IDS.AUCTION_1, IDS.A1L1, IDS.BUYER_USER]
    );
    log('Created payment PMT1 (A1L1, paid) (or already existed)');

    // PMT2 — A1L2, status=paid
    await pool.query(
      `INSERT INTO payments (id, auction_id, lot_id, buyer_user_id, amount_cents,
                              status, payment_intent_id, payment_provider_id,
                              charged_at, last_attempted_at)
       VALUES ($1, $2, $3, $4, 42000,
               'paid', 'pi_demo_a1l2_bracelet', 'pi_demo_a1l2_bracelet',
               NOW() - INTERVAL '56 days', NOW() - INTERVAL '56 days')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.PMT2, IDS.AUCTION_1, IDS.A1L2, IDS.BUYER_USER]
    );
    log('Created payment PMT2 (A1L2, paid) (or already existed)');

    // PMT3 — A2L1, status=pending
    await pool.query(
      `INSERT INTO payments (id, auction_id, lot_id, buyer_user_id, amount_cents,
                              status, payment_intent_id, payment_provider_id,
                              charged_at, last_attempted_at)
       VALUES ($1, $2, $3, $4, 185000,
               'pending', 'pi_demo_a2l1_chair', NULL,
               NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [IDS.PMT3, IDS.AUCTION_2, IDS.A2L1, IDS.BUYER_USER]
    );
    log('Created payment PMT3 (A2L1, pending) (or already existed)');

    // -----------------------------------------------------------------------
    // Step 9: Insert invoices
    // -----------------------------------------------------------------------

    // INV1 — for PMT1, status=paid
    await pool.query(
      `INSERT INTO invoices (id, payment_id, buyer_user_id, auction_id, lot_id,
                              amount_cents, status)
       VALUES ($1, $2, $3, $4, $5, 87500, 'paid')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.INV1, IDS.PMT1, IDS.BUYER_USER, IDS.AUCTION_1, IDS.A1L1]
    );
    log('Created invoice INV1 (A1L1, paid) (or already existed)');

    // INV2 — for PMT2, status=paid
    await pool.query(
      `INSERT INTO invoices (id, payment_id, buyer_user_id, auction_id, lot_id,
                              amount_cents, status)
       VALUES ($1, $2, $3, $4, $5, 42000, 'paid')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.INV2, IDS.PMT2, IDS.BUYER_USER, IDS.AUCTION_1, IDS.A1L2]
    );
    log('Created invoice INV2 (A1L2, paid) (or already existed)');

    // INV3 — for PMT3, status=issued
    await pool.query(
      `INSERT INTO invoices (id, payment_id, buyer_user_id, auction_id, lot_id,
                              amount_cents, status)
       VALUES ($1, $2, $3, $4, $5, 185000, 'issued')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.INV3, IDS.PMT3, IDS.BUYER_USER, IDS.AUCTION_2, IDS.A2L1]
    );
    log('Created invoice INV3 (A2L1, issued) (or already existed)');

    // -----------------------------------------------------------------------
    // Final summary
    // -----------------------------------------------------------------------
    console.log('');
    console.log('='.repeat(60));
    console.log('[demo-seed] Demo seed complete. 3 auctions, 9 lots, 3 invoices ready.');
    console.log('');
    console.log('[demo-seed] Demo credentials:');
    console.log('  Buyer  → demo-buyer@advantage.bid  / DemoExplore2025!');
    console.log('  Seller → demo-seller@advantage.bid / DemoExplore2025!');
    console.log('='.repeat(60));
    console.log('');

  } catch (err) {
    console.error('[demo-seed] ERROR — seed failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
