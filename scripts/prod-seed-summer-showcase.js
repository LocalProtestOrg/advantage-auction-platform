#!/usr/bin/env node
/* prod-seed-summer-showcase.js — PRODUCTION-guarded. Seeds the clearly-labeled
 * "Coming Soon / Demo Showcase" upcoming auction on production so bid.advantage.bid
 * (the auction platform / upcoming-auctions page) has a polished representative
 * catalog. Idempotent (fixed UUIDs, ON CONFLICT). Mirror of stg-seed-summer-showcase.js.
 *
 * RUN ONLY AS PART OF THE APPROVED PROD DEPLOY (see
 * docs/daily-fixes-2026-06-16-production-readiness-and-deployment-plan.md). Invoke:
 *   railway run --service advantage-auction-platform --environment production \
 *     node scripts/prod-seed-summer-showcase.js
 *
 * SAFETY / DESIGN:
 *  - Auction state = 'published' with a FUTURE start_time (2026-07-15) so it renders
 *    as an "Upcoming" auction card and its detail page shows the full catalog.
 *  - Lots use the normal state = 'open' (a published/upcoming auction's lots are 'open'
 *    in this system). Bidding is blocked SERVER-SIDE by the auction-level start gate in
 *    the bid endpoint (src/routes/lots.js): a bid is rejected with HTTP 422 unless the
 *    auction is state='active' AND start_time has passed. The scheduler promotes
 *    published->active at start_time, so this auction becomes biddable on 2026-07-15
 *    and not a moment before. (Requires the bid-guard commit 7cd5e75 to be deployed.)
 *  - NO bids, NO bidders, NO payments, NO invoices, NO winners, NO sold prices.
 *    starting_bid_cents are auction CONFIG only (not realized prices).
 *  - Does NOT touch Stripe, payments, buyer premium, or terms.
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const IDS = {
  USER:    '5a000000-0000-4000-8000-000000000001', // showcase demo seller user
  SP:      '5a000000-0000-4000-8000-000000000002', // seller_profile
  AUCTION: '5a000000-0000-4000-8000-000000000010',
};
// 8 lots, fixed UUIDs ...011 .. ...018
const lot = (n) => `5a000000-0000-4000-8000-0000000000${(0x10 + n).toString(16)}`;

const IMG = (id) => `https://images.unsplash.com/${id}?w=900&h=675&fit=crop&q=80`;

// Representative catalog across antiques / art / collectibles / jewelry / furniture /
// decorative / estate. category strings match the platform's canonical taxonomy.
const LOTS = [
  { n: 1, title: 'Antique Mahogany Roll-Top Desk',            category: 'Furniture',            size: 'C', pickup: 'C', start: 25000, featured: true,
    era: 'c. 1900', condition: 'Very good, original finish', img: 'photo-1518455027359-f3f8164ba6bd',
    description: 'Late Victorian solid mahogany roll-top desk with tambour cover, fitted interior of pigeonholes and small drawers, and a writing surface. Original brass hardware. Structurally sound with light wear consistent with age.' },
  { n: 2, title: 'Pair of Chinese Export Porcelain Vases',    category: 'Pottery & Ceramics',   size: 'B', pickup: 'B', start: 7500,  featured: false,
    era: '20th century', condition: 'Excellent, no chips or cracks', img: 'photo-1578500494198-246f612d3b3d',
    description: 'Matched pair of blue and white Chinese export porcelain vases decorated with landscape and floral motifs. Both intact with no restoration. Approximately 14 inches tall.' },
  { n: 3, title: 'Sterling Silver Tea & Coffee Service',       category: 'Antiques',             size: 'B', pickup: 'B', start: 15000, featured: false,
    era: 'Early 20th century', condition: 'Good, lightly polished', img: 'photo-1610701596007-11502861dcfa',
    description: 'Five-piece sterling silver tea and coffee service including teapot, coffeepot, covered sugar, creamer, and waste bowl. Hallmarked. Total weight approximately 80 troy ounces.' },
  { n: 4, title: 'Original Framed Oil Landscape Painting',     category: 'Fine Art',             size: 'B', pickup: 'B', start: 10000, featured: true,
    era: 'Mid 20th century', condition: 'Very good, original frame', img: 'photo-1578321272176-b7bbc0679853',
    description: 'Original oil-on-canvas pastoral landscape in a giltwood frame, signed lower right. Canvas clean and taut with no visible losses. Frame shows minor age wear.' },
  { n: 5, title: 'Vintage Diamond & Platinum Cocktail Ring',   category: 'Jewelry',              size: 'A', pickup: 'A', start: 50000, featured: true,
    era: 'Mid 20th century', condition: 'Excellent', img: 'photo-1605100804763-247f67b3557e',
    description: 'Platinum cocktail ring centered on an old-European-cut diamond flanked by tapered baguettes. Estimated center stone approximately 1.0ct. Sizable. Estate piece in excellent condition.' },
  { n: 6, title: 'Mid-Century Brass Table Lamp',               category: 'Home Decor',           size: 'A', pickup: 'B', start: 5000,  featured: false,
    era: 'c. 1960', condition: 'Good, rewired', img: 'photo-1543198126-c3e1c0a9d6d2',
    description: 'Sculptural mid-century brass table lamp with original patina, rewired to current code with a new socket and cord. Linen drum shade included. Working condition.' },
  { n: 7, title: 'Persian Hand-Knotted Wool Area Rug',         category: 'Home Decor',           size: 'C', pickup: 'C', start: 20000, featured: false,
    era: '20th century', condition: 'Good, even pile', img: 'photo-1600166898405-da9535204843',
    description: 'Hand-knotted Persian wool area rug with a classic medallion design in red, navy, and ivory. Even pile with no major repairs. Approximately 8 by 10 feet.' },
  { n: 8, title: 'French Gilt Bronze Mantel Clock',            category: 'Clocks & Timepieces',  size: 'A', pickup: 'B', start: 12000, featured: false,
    era: '19th century', condition: 'Running, serviced', img: 'photo-1495856458515-0637185db551',
    description: 'French gilt bronze mantel clock with an enamel dial and Roman numerals, eight-day movement recently serviced and running. Includes pendulum and key.' },
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint detected (PRODUCTION-only script).'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint. Aborting.'); return 2; }

  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await pool.query('SELECT 1');
    const hash = await bcrypt.hash('ShowcaseDemo2026!', 10);

    // 1) demo seller user + profile
    await c.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1,$2,$3,'seller')
       ON CONFLICT (email) DO NOTHING`,
      [IDS.USER, 'showcase-demo@advantage.bid', hash]);
    const u = (await c.query(`SELECT id FROM users WHERE email=$1`, ['showcase-demo@advantage.bid'])).rows[0].id;
    await c.query(
      `INSERT INTO seller_profiles (id, user_id, display_name, location_label)
       VALUES ($1,$2,'Advantage Showcase','Knoxville, TN')
       ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, location_label=EXCLUDED.location_label`,
      [IDS.SP, u]);

    // 2) the showcase auction — published + future start = "Upcoming"
    await c.query(
      `INSERT INTO auctions
         (id, seller_id, title, subtitle, description, auction_terms, state,
          city, address_state, zip, lat, lng, shipping_available,
          start_time, end_time, preview_start, preview_end,
          pickup_window_start, pickup_window_end,
          cover_image_url, banner_image_url, is_archived)
       VALUES
         ($1,$2,
          'Summer Showcase Auction',
          'Coming Soon - Demo Showcase',
          $3, $4, 'published',
          'Knoxville','TN','37902', 35.9606, -83.9207, false,
          TIMESTAMPTZ '2026-07-15 16:00:00+00', TIMESTAMPTZ '2026-07-31 23:00:00+00',
          TIMESTAMPTZ '2026-07-13 16:00:00+00', TIMESTAMPTZ '2026-07-15 16:00:00+00',
          TIMESTAMPTZ '2026-08-03 15:00:00+00', TIMESTAMPTZ '2026-08-05 23:00:00+00',
          $5, $5, false)
       ON CONFLICT (id) DO UPDATE SET
          subtitle=EXCLUDED.subtitle, description=EXCLUDED.description,
          state=EXCLUDED.state, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time,
          cover_image_url=EXCLUDED.cover_image_url, banner_image_url=EXCLUDED.banner_image_url`,
      [IDS.AUCTION, IDS.SP,
       'This is a demonstration showcase of the Advantage.Bid marketplace experience. Bidding is not yet open. The catalog below is representative of the antiques, fine art, jewelry, furniture, and estate items typically offered. Bidding opens July 15, 2026.',
       'Demonstration auction. Standard Advantage.Bid buyer terms will apply when bidding opens. Pickup is by appointment after the auction closes.',
       IMG('photo-1513519245088-0e12902e35ca')]);

    // 3) the lots — state='open' (normal for an upcoming auction). Bidding stays
    //    blocked by the server-side auction start gate until 2026-07-15.
    for (const L of LOTS) {
      const id = lot(L.n);
      await c.query(
        `INSERT INTO lots
           (id, auction_id, lot_number, title, description, category, size_category,
            pickup_category, condition, era, starting_bid_cents, bid_increment_cents,
            current_bid_cents, bid_count, state, is_featured, shippable,
            thumbnail_url, images_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL,0,'open',$12,false,$13,1)
         ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title, description=EXCLUDED.description, category=EXCLUDED.category,
           size_category=EXCLUDED.size_category, pickup_category=EXCLUDED.pickup_category,
           starting_bid_cents=EXCLUDED.starting_bid_cents, state='open',
           is_featured=EXCLUDED.is_featured, thumbnail_url=EXCLUDED.thumbnail_url`,
        [id, IDS.AUCTION, L.n, L.title, L.description, L.category, L.size,
         L.pickup, L.condition, L.era, L.start, L.featured, IMG(L.img)]);
      await c.query(
        `INSERT INTO lot_images (lot_id, image_url, sort_order)
         SELECT $1,$2,0 WHERE NOT EXISTS (SELECT 1 FROM lot_images WHERE lot_id=$1)`,
        [id, IMG(L.img)]);
    }

    // 4) verification
    const a = (await c.query(
      `SELECT state, start_time > NOW() AS is_future, end_time FROM auctions WHERE id=$1`, [IDS.AUCTION])).rows[0];
    const lc = (await c.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE state='open')::int open,
       COUNT(*) FILTER (WHERE bid_count>0 OR current_bid_cents IS NOT NULL OR winning_buyer_user_id IS NOT NULL)::int withbids
       FROM lots WHERE auction_id=$1`, [IDS.AUCTION])).rows[0];
    const bids = (await c.query(`SELECT COUNT(*)::int n FROM bids b JOIN lots l ON l.id=b.lot_id WHERE l.auction_id=$1`, [IDS.AUCTION])).rows[0].n;

    console.log('Auction state=' + a.state + '  upcoming(start in future)=' + a.is_future + '  end=' + a.end_time.toISOString());
    console.log('Lots total=' + lc.n + '  open=' + lc.open + '  with_bids_or_winner=' + lc.withbids + '  bid rows=' + bids);
    console.log('Bidding is blocked server-side until start_time (auction is published, not active).');
    const pass = a.state === 'published' && a.is_future === true && lc.n === LOTS.length && lc.open === LOTS.length && lc.withbids === 0 && bids === 0;
    console.log('RESULT: ' + (pass ? 'PASS (upcoming, all lots open, no bids/winners; bidding gated by server start guard)' : 'FAIL'));
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL', e.message); console.error(e.stack); return 1; }
  finally { c.release(); await pool.end(); }
})().then(c => process.exit(c || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
