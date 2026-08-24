#!/usr/bin/env node
/* demo-environment.js — create/restore the PERMANENT sales-demo environment.
 *
 *   node scripts/demo-environment.js seed    # create shells if missing + (re)build canonical lots/bids
 *   node scripts/demo-environment.js reset   # restore canonical lots/bids/prices (shells must exist)
 *   node scripts/demo-environment.js status  # print what exists
 *
 * SAFETY:
 *   - Every record is is_demo=true. The auction is state='active', marketplace_status='hidden'
 *     (excluded from the public marketplace), and end_time is ~1 year out (never auto-closes, so it
 *     never creates seller_payouts / settlements / Stripe transfers / tax transactions).
 *   - The demo seller user has NO password (password_hash stays NULL) so it cannot be logged into
 *     until an admin deliberately sets one out-of-band. No credentials live in code.
 *   - Seeding is direct SQL, so NO publish notifications / transactional emails fire.
 *   - Destructive statements are scoped to the fixed demo IDs AND guarded on is_demo. Nothing here can
 *     touch a real seller, auction, buyer, bid, or payout.
 *   - Fully idempotent: re-running is the reset.
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Produce a valid-format bcrypt hash of a RANDOM, immediately-discarded secret. The demo accounts thus
// have a well-formed password_hash (satisfies NOT NULL) but NO known/usable password: no credential
// exists in code, and the account cannot be logged into until an admin deliberately resets it.
function unusablePasswordHash() {
  return bcrypt.hashSync('demo-disabled-' + crypto.randomBytes(24).toString('hex'), 10);
}

// Deterministic demo IDs (valid v4-shaped UUIDs) so the toolbox can link to stable URLs.
const ID = {
  user:    '00000000-0000-4000-a000-0000000d0001',
  profile: '00000000-0000-4000-a000-0000000d0002',
  auction: '00000000-0000-4000-a000-0000000d0003',
  buyer1:  '00000000-0000-4000-a000-0000000d0004',
  buyer2:  '00000000-0000-4000-a000-0000000d0005',
  buyer3:  '00000000-0000-4000-a000-0000000d0006',
};
const BUYER_PREMIUM_BPS = 1500; // 15% - shows a professional seller's configured buyer premium
const PLATFORM_FEE_BPS  = 400;  // 4% default professional platform fee

// Catalog: [lot#, title, category(image slug), size(A/B/C), startingUSD, currentUSD, bids, condition, era, maker]
const LOTS = [
  [1,  'Victorian Mahogany Sideboard', 'furniture', 'C', 50, 340, 7, 'Good', 'Victorian', ''],
  [2,  'Oil Painting, Coastal Landscape (signed)', 'artwork', 'B', 25, 210, 6, 'Very Good', '20th c.', 'Signed (illegible)'],
  [3,  '14k Gold and Sapphire Ring', 'jewelry', 'A', 40, 275, 9, 'Excellent', 'Mid-century', ''],
  [4,  'Sterling Silver Tea Service, 5 pc', 'silver', 'B', 60, 430, 8, 'Very Good', 'Early 20th c.', ''],
  [5,  'Cast Iron Mechanical Bank', 'collectible', 'A', 15, 120, 5, 'Good', 'Antique', ''],
  [6,  'Pair of Brass Table Lamps', 'decor', 'B', 20, 95, 4, 'Good', 'Vintage', ''],
  [7,  'Craftsman Rolling Tool Chest', 'tools', 'C', 30, 165, 5, 'Good', 'Modern', 'Craftsman'],
  [8,  'Set of 8 Cut-Crystal Goblets', 'household', 'A', 15, 70, 3, 'Excellent', 'Vintage', ''],
  [9,  'Antique Regulator Wall Clock', 'specialty', 'B', 45, 260, 6, 'Working', 'Antique', ''],
  [10, 'Persian Hand-Knotted Area Rug', 'decor', 'C', 75, 520, 10, 'Very Good', 'Vintage', ''],
  [11, 'Mid-Century Walnut Armchair', 'furniture', 'B', 30, 185, 6, 'Good', 'Mid-century', ''],
  [12, 'Watercolor, Still Life (framed)', 'artwork', 'A', 15, 85, 4, 'Good', '20th c.', ''],
  [13, 'Diamond Stud Earrings, 0.5 ctw', 'jewelry', 'A', 50, 310, 8, 'Excellent', 'Contemporary', ''],
  [14, 'Sterling Silver Flatware, 42 pc', 'silver', 'B', 80, 460, 7, 'Very Good', 'Early 20th c.', ''],
  [15, 'Vintage Fountain Pen Collection', 'collectible', 'A', 20, 140, 6, 'Good', 'Vintage', ''],
  [16, 'Porcelain Figurine Group', 'decor', 'A', 10, 55, 3, 'Excellent', 'Vintage', ''],
  [17, 'Woodworking Hand Plane Set', 'tools', 'B', 20, 110, 5, 'Good', 'Antique', ''],
  [18, 'Grandmother Clock, Mahogany Case', 'specialty', 'C', 60, 395, 7, 'Working', 'Early 20th c.', ''],
];

function cents(usd) { return Math.round(usd * 100); }

async function ensureShells(db) {
  // Demo seller user (no password: not loginable until an admin sets one deliberately).
  await db.query(
    `INSERT INTO users (id, email, role, is_active, is_demo, full_name, password_hash)
     VALUES ($1, 'sales-demo-seller@advantage.bid', 'seller', true, true, 'Heritage & Home Estate Services (DEMO)', $2)
     ON CONFLICT (id) DO UPDATE SET is_demo = true, role = 'seller'`, [ID.user, unusablePasswordHash()]);
  // Demo buyers (own the seeded bids; also no usable password).
  for (const [i, bid] of [ID.buyer1, ID.buyer2, ID.buyer3].entries()) {
    await db.query(
      `INSERT INTO users (id, email, role, is_active, is_demo, full_name, password_hash)
       VALUES ($1, $2, 'buyer', true, true, $3, $4)
       ON CONFLICT (id) DO UPDATE SET is_demo = true`,
      [bid, `sales-demo-buyer${i + 1}@advantage.bid`, `Demo Bidder ${i + 1}`, unusablePasswordHash()]);
  }
  // Demo professional seller profile (estate_sale_company). Company branding lives in metadata.
  await db.query(
    `INSERT INTO seller_profiles (id, user_id, seller_type, is_demo, platform_fee_bps, show_branding_to_buyers, metadata)
     VALUES ($1, $2, 'estate_sale_company', true, $3, true, $4)
     ON CONFLICT (id) DO UPDATE SET is_demo = true, seller_type = 'estate_sale_company',
       platform_fee_bps = EXCLUDED.platform_fee_bps, metadata = EXCLUDED.metadata`,
    [ID.profile, ID.user, PLATFORM_FEE_BPS, JSON.stringify({
      business_name: 'Heritage & Home Estate Services (DEMO)',
      display_name: 'Heritage & Home Estate Services',
      description: 'A full-service estate-sale company handling downsizing, estate liquidations, and online auctions. This is a demonstration company for Advantage.Bid sales presentations.',
      service_area: 'Greater Region (demo)',
      public_phone: '(555) 010-0100',
      website: null,           // intentionally NO independent website (Golden Prospect story)
      demo: true,
    })]);
  // Demo auction: active, hidden from marketplace, far-future end (never auto-closes).
  await db.query(
    `INSERT INTO auctions
       (id, seller_id, title, subtitle, description, state, is_demo, marketplace_status, is_archived,
        start_time, end_time, city, address_state, zip, pickup_window_start, pickup_window_end,
        buyer_premium_bps, public_auction_type)
     VALUES ($1,$2,$3,$4,$5,'active',true,'hidden',false,
        now() - interval '2 days', now() + interval '365 days',
        'Maplewood','OH','44060', now() + interval '368 days', now() + interval '370 days',
        $6,'estate')
     ON CONFLICT (id) DO UPDATE SET
        state='active', is_demo=true, marketplace_status='hidden', is_archived=false,
        end_time = now() + interval '365 days', buyer_premium_bps = EXCLUDED.buyer_premium_bps,
        title = EXCLUDED.title, description = EXCLUDED.description, updated_at = now()`,
    [ID.auction, ID.profile,
     'The Maplewood Estate Collection',
     'A curated single-owner estate - furniture, art, jewelry, silver, and collectibles',
     'The complete contents of a well-appointed Maplewood estate, offered by Heritage & Home Estate Services. Bidding is open online; pickup is local by appointment. This is a demonstration auction used for Advantage.Bid sales presentations.',
     BUYER_PREMIUM_BPS]);
}

// Guard: confirm the auction row is really the demo (is_demo) before any destructive rebuild.
async function assertDemo(db) {
  const r = await db.query('SELECT is_demo FROM auctions WHERE id = $1', [ID.auction]);
  if (!r.rows[0]) throw new Error('demo auction shell missing - run "seed" first');
  if (r.rows[0].is_demo !== true) throw new Error('REFUSE: target auction is not is_demo');
}

async function rebuildCatalog(db) {
  await assertDemo(db);
  // Scoped to the demo auction id (which we just asserted is_demo). Cascades to lot_images + bids.
  await db.query('DELETE FROM bids WHERE auction_id = $1', [ID.auction]);
  await db.query('DELETE FROM lots WHERE auction_id = $1', [ID.auction]);

  const buyers = [ID.buyer1, ID.buyer2, ID.buyer3];
  let paddle = 101;
  for (const [num, title, cat, size, startUsd, curUsd, nBids, condition, era, maker] of LOTS) {
    const lot = (await db.query(
      `INSERT INTO lots
         (auction_id, lot_number, title, description, size_category, pickup_category, category,
          condition, era, maker_artist, state, starting_bid_cents, current_bid_cents, bid_count, closes_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'open',$10,$11,$12, now() + interval '365 days' + ($2::int * interval '1 minute'))
       RETURNING id`,
      [ID.auction, num, title,
       `${title}. ${condition} condition${era ? ', ' + era : ''}${maker ? ', ' + maker : ''}. Offered from the Maplewood estate. (Demonstration lot.)`,
       size, cat, condition, era, maker || null, cents(startUsd), cents(curUsd), nBids])).rows[0];
    await db.query(
      `INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1, $2, 0)`,
      [lot.id, `/demo/lot-${cat}.svg`]);
    // Seed a short, realistic ascending bid history ending at current price.
    const step = Math.max(cents(5), Math.round((cents(curUsd) - cents(startUsd)) / Math.max(nBids, 1)));
    let amt = cents(startUsd);
    for (let b = 0; b < nBids; b++) {
      amt = (b === nBids - 1) ? cents(curUsd) : Math.min(cents(curUsd), amt + step);
      const buyer = buyers[b % buyers.length];
      await db.query(
        `INSERT INTO bids (lot_id, auction_id, bidder_user_id, amount_cents, is_proxy, paddle_number, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6, now() - ($7::int * interval '1 hour'))`,
        [lot.id, ID.auction, buyer, amt, b % 3 === 0, paddle + (b % buyers.length), (nBids - b)]);
    }
  }
}

async function status(db) {
  const a = (await db.query('SELECT id, title, state, marketplace_status, is_demo, end_time FROM auctions WHERE id = $1', [ID.auction])).rows[0];
  const lots = (await db.query('SELECT count(*)::int AS n FROM lots WHERE auction_id = $1', [ID.auction])).rows[0].n;
  const bids = (await db.query('SELECT count(*)::int AS n FROM bids WHERE auction_id = $1', [ID.auction])).rows[0].n;
  console.log('Demo auction:', a ? JSON.stringify(a) : 'MISSING');
  console.log('Lots:', lots, '| Bids:', bids);
  console.log('Auction URL: /auction-view.html?auctionId=' + ID.auction);
}

(async () => {
  const mode = (process.argv[2] || 'seed').toLowerCase();
  const raw = process.env.DATABASE_URL || '';
  if (!raw) { console.error('DATABASE_URL not set'); process.exit(2); }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const db = await pool.connect();
  try {
    if (mode === 'status') { await status(db); }
    else if (mode === 'seed') { await ensureShells(db); await rebuildCatalog(db); console.log('Demo environment seeded/restored.'); await status(db); }
    else if (mode === 'reset') { await rebuildCatalog(db); console.log('Demo catalog reset to canonical state.'); await status(db); }
    else { console.error('Unknown mode: ' + mode + ' (use seed|reset|status)'); process.exit(2); }
    console.log('IDS ' + JSON.stringify(ID));
  } finally { db.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
