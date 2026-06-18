#!/usr/bin/env node
/* stg-seed-past-auctions.js — STAGING-guarded. Seeds a CURATED LIBRARY of 6 polished
 * demo PAST (closed, non-archived) auctions (~233 lots total) for the public Past
 * Auctions surface + homepage trust section. Clearly labeled as sample results.
 *
 * SAFETY / DESIGN:
 *  - 6 auctions, fixed UUIDs 5b00000{1..6}-0000-4000-8000-000000000000; lots
 *    5b00000{k}-...-0000000000{NN}. state='closed', is_archived=false.
 *  - Lots marked SOLD (winning_amount_cents, realistic bid_count); deterministic
 *    generation => idempotent re-runs produce identical data.
 *  - NO payments, NO invoices, NO real buyers (winning_buyer_user_id NULL).
 *  - Replaces the prior small 2-auction demo set (deletes 5b000000-…010/020).
 *  - DOES NOT blanket-archive other closed auctions (Phase 6 policy): existing
 *    test/junk on prod is already archived; real future closed auctions must NOT be
 *    auto-archived. This seed only manages its own curated 5b00000{1..6} rows.
 *  - Realized-price privacy (#20.1) unchanged. Touches no Stripe/payment/payout/terms.
 */
const { Pool } = require('pg');

const IMG = (id) => `https://images.unsplash.com/${id}?w=900&h=675&fit=crop&q=80`;
const OLD_CURATED = ['5b000000-0000-4000-8000-000000000010', '5b000000-0000-4000-8000-000000000020'];

// Deterministic pseudo-random in [0,1) from an integer seed (stable across runs).
function prng(s) { const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

// category -> size/pickup + sold-value range (cents) + image pool
const CAT = {
  'Jewelry':              { s: 'A', pk: 'A', lo: 18000,  hi: 950000,  imgs: ['photo-1605100804763-247f67b3557e','photo-1515562141207-7a88fb7ce338','photo-1611652022419-a9419f74343d','photo-1535632066927-ab7c9ab60908'] },
  'Watches':              { s: 'A', pk: 'A', lo: 25000,  hi: 750000,  imgs: ['photo-1523170335258-f5ed11844a49','photo-1524805444758-089113d48a6d'] },
  'Fine Art':             { s: 'B', pk: 'B', lo: 30000,  hi: 1800000, imgs: ['photo-1578321272176-b7bbc0679853','photo-1549887534-1541e9326642','photo-1577083552431-6e5fd75a9160','photo-1531913764164-f85c52e6e654'] },
  'Sculpture':            { s: 'B', pk: 'B', lo: 35000,  hi: 900000,  imgs: ['photo-1578926375605-eaf7559b1458','photo-1564399580075-5dfe19c205f3'] },
  'Antiques':             { s: 'B', pk: 'B', lo: 9000,   hi: 320000,  imgs: ['photo-1610701596007-11502861dcfa','photo-1578500494198-246f612d3b3d','photo-1495856458515-0637185db551'] },
  'Furniture':            { s: 'C', pk: 'C', lo: 15000,  hi: 620000,  imgs: ['photo-1518455027359-f3f8164ba6bd','photo-1586023492125-27b2c045efd7','photo-1503602642458-232111445657','photo-1555041469-a586c61ea9bc'] },
  'Home Decor':           { s: 'B', pk: 'B', lo: 5000,   hi: 280000,  imgs: ['photo-1543198126-c3e1c0a9d6d2','photo-1543159006-2e0c69cfe5b1','photo-1600166898405-da9535204843','photo-1513519245088-0e12902e35ca'] },
  'Clocks & Timepieces':  { s: 'A', pk: 'B', lo: 8000,   hi: 240000,  imgs: ['photo-1495856458515-0637185db551','photo-1509048191080-d2984bad6ae5'] },
  'Pottery & Ceramics':   { s: 'B', pk: 'B', lo: 7000,   hi: 180000,  imgs: ['photo-1578500494198-246f612d3b3d','photo-1610701596007-11502861dcfa'] },
  'Coins & Currency':     { s: 'A', pk: 'A', lo: 9000,   hi: 480000,  imgs: ['photo-1621416894569-0f39ed31d247','photo-1610375461246-83df859d849d'] },
  'Collectibles':         { s: 'A', pk: 'B', lo: 5000,   hi: 360000,  imgs: ['photo-1605792657660-596af9009e82','photo-1606166187734-a4cb74079037'] },
};
const DESC = ['', 'Antique ', 'Vintage ', 'Estate ', 'Mid-Century ', 'Pair of ', 'Set of Four ', '19th Century ', 'Early 20th Century ', 'Signed '];
const ERA = ['', ', c. 1900', ', c. 1925', ', c. 1950', ', c. 1965', ', mid-20th century', ', Victorian era'];

// theme item pools: [title, category]
const THEMES = [
  { n: 1, title: 'Estate Jewelry & Fine Watches', subtitle: 'Sample Auction Results', cover: 'photo-1605100804763-247f67b3557e', closeISO: '2026-01-18', count: 40,
    items: [['Diamond Solitaire Ring','Jewelry'],['Sapphire & Diamond Ring','Jewelry'],['Emerald Halo Ring','Jewelry'],['Gold Tennis Bracelet','Jewelry'],['Cultured Pearl Strand Necklace','Jewelry'],['Diamond Stud Earrings','Jewelry'],['Ruby Pendant Necklace','Jewelry'],['Cocktail Ring','Jewelry'],['Gold Signet Ring','Jewelry'],['Cameo Brooch','Jewelry'],['Charm Bracelet','Jewelry'],['Gemstone Drop Earrings','Jewelry'],['Swiss Automatic Wristwatch','Watches'],['Gold Pocket Watch','Watches'],['Stainless Chronograph Watch','Watches'],['Diamond Eternity Band','Jewelry']] },
  { n: 2, title: 'Fine Art & Antiques', subtitle: 'Example Auction Results', cover: 'photo-1577083552431-6e5fd75a9160', closeISO: '2026-02-15', count: 38,
    items: [['Oil Painting, Pastoral Landscape','Fine Art'],['Portrait Oil on Canvas','Fine Art'],['Watercolor Seascape','Fine Art'],['Framed Lithograph','Fine Art'],['Still Life Oil Painting','Fine Art'],['Abstract Mixed Media Work','Fine Art'],['Pastel Drawing','Fine Art'],['Bronze Figural Sculpture','Sculpture'],['Carved Marble Bust','Sculpture'],['Antique Engraved Map','Antiques'],['Copper Engraving','Fine Art'],['Hand-Colored Etching','Fine Art'],['Carved Giltwood Frame','Antiques'],['Brass Inkstand','Antiques'],['Inlaid Writing Box','Antiques'],['Bronze Animalier Figure','Sculpture']] },
  { n: 3, title: 'Mid-Century Modern Furniture & Decor', subtitle: 'Sample Auction Results', cover: 'photo-1586023492125-27b2c045efd7', closeISO: '2026-03-14', count: 41,
    items: [['Lounge Chair & Ottoman','Furniture'],['Walnut Credenza','Furniture'],['Teak Dining Table','Furniture'],['Sculptural Floor Lamp','Home Decor'],['Low Sideboard','Furniture'],['Nesting Tables','Furniture'],['Upholstered Armchair','Furniture'],['Rolling Bar Cart','Furniture'],['Writing Desk','Furniture'],['Open Bookcase','Furniture'],['Pendant Ceiling Lamp','Home Decor'],['Ceramic Table Lamp','Home Decor'],['Sunburst Wall Clock','Clocks & Timepieces'],['Atomic Magazine Rack','Home Decor'],['Tufted Lounge Sofa','Furniture'],['Brass Floor Lamp','Home Decor']] },
  { n: 4, title: 'Luxury Home Furnishings', subtitle: 'Example Auction Results', cover: 'photo-1555041469-a586c61ea9bc', closeISO: '2026-04-19', count: 37,
    items: [['Leather Chesterfield Sofa','Furniture'],['Marble-Top Console Table','Furniture'],['Crystal Chandelier','Home Decor'],['Hand-Knotted Persian Rug','Home Decor'],['Upholstered Wingback Chair','Furniture'],['Mahogany Dining Set','Furniture'],['Carved Giltwood Mirror','Home Decor'],['Marble Coffee Table','Furniture'],['Velvet Settee','Furniture'],['Brass & Glass Etagere','Furniture'],['Porcelain Table Lamp Pair','Home Decor'],['Silk Area Rug','Home Decor'],['Inlaid Demilune Table','Furniture'],['Tall Display Cabinet','Furniture'],['Bronze Mantel Garniture','Home Decor'],['Tooled Leather Club Chair','Furniture']] },
  { n: 5, title: 'Collector Estate & Curiosities', subtitle: 'Sample Auction Results', cover: 'photo-1605792657660-596af9009e82', closeISO: '2026-05-17', count: 39,
    items: [['Morgan Silver Dollar Set','Coins & Currency'],['Gold Coin','Coins & Currency'],['Porcelain Advertising Sign','Collectibles'],['Military Medal Group','Collectibles'],['Antique Folding Knife','Collectibles'],['Stamp Album Collection','Collectibles'],['Vintage Folding Camera','Collectibles'],['Lithographed Tin Toy','Collectibles'],['Fountain Pen','Collectibles'],['Brass Scientific Instrument','Antiques'],['Terrestrial Globe','Antiques'],['Cast-Iron Mechanical Bank','Collectibles'],['Pocket Watch Collection','Watches'],['Vintage Postcard Lot','Collectibles'],['Carved Walking Cane','Antiques'],['Silver Proof Set','Coins & Currency']] },
  { n: 6, title: 'Decorative Arts & Designer Accessories', subtitle: 'Example Auction Results', cover: 'photo-1543198126-c3e1c0a9d6d2', closeISO: '2026-06-07', count: 38,
    items: [['Murano Art Glass Vase','Home Decor'],['Bronze Tabletop Sculpture','Sculpture'],['Porcelain Figurine','Pottery & Ceramics'],['Cut-Crystal Decanter Set','Home Decor'],['Designer Table Lamp','Home Decor'],['Art Glass Centerpiece Bowl','Home Decor'],['Cloisonné Vase','Pottery & Ceramics'],['Silver Candelabra','Antiques'],['Molded Glass Bowl','Home Decor'],['Hand-Painted Ceramic Charger','Pottery & Ceramics'],['Enameled Keepsake Box','Antiques'],['Beveled Wall Mirror','Home Decor'],['Majolica Jardiniere','Pottery & Ceramics'],['Gilt Bronze Candlesticks','Antiques'],['Studio Pottery Vessel','Pottery & Ceramics'],['Crystal Table Clock','Clocks & Timepieces']] },
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: PRODUCTION endpoint. STAGING-only.'); return 2; }
  if (!raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: not the STAGING endpoint.'); return 2; }
  const SELLER_SP = '5a000000-0000-4000-8000-000000000002';
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    if (!(await c.query('SELECT 1 FROM seller_profiles WHERE id=$1', [SELLER_SP])).rowCount) {
      console.error('FAIL: demo seller ' + SELLER_SP + ' not found (run Summer Showcase seed first).'); return 1;
    }
    // Replace prior small demo set.
    await c.query(`DELETE FROM lot_images WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = ANY($1::uuid[]))`, [OLD_CURATED]);
    await c.query(`DELETE FROM lots WHERE auction_id = ANY($1::uuid[])`, [OLD_CURATED]);
    await c.query(`DELETE FROM auctions WHERE id = ANY($1::uuid[])`, [OLD_CURATED]);

    let g = 0; const curatedIds = [];
    for (const th of THEMES) {
      const aid = `5b00000${th.n}-0000-4000-8000-000000000000`;
      curatedIds.push(aid);
      const startISO = th.closeISO + ' 15:00:00+00';
      const endISO = th.closeISO + ' 23:00:00+00';
      await c.query(
        `INSERT INTO auctions (id, seller_id, title, subtitle, description, state, city, address_state, zip, lat, lng,
           shipping_available, start_time, end_time, cover_image_url, banner_image_url, is_archived)
         VALUES ($1,$2,$3,$4,$5,'closed','Knoxville','TN','37902',35.9606,-83.9207,false,
                 TIMESTAMPTZ '${startISO}', TIMESTAMPTZ '${endISO}', $6,$6,false)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, subtitle=EXCLUDED.subtitle, description=EXCLUDED.description,
           state='closed', is_archived=false, end_time=EXCLUDED.end_time, cover_image_url=EXCLUDED.cover_image_url, banner_image_url=EXCLUDED.banner_image_url`,
        [aid, SELLER_SP, th.title, th.subtitle,
         'Sample auction results shown to demonstrate the Advantage.Bid selling experience. Demonstration data; not a record of an actual sale.', IMG(th.cover)]);
      for (let i = 1; i <= th.count; i++) {
        g += 1;
        const base = th.items[(i - 1) % th.items.length];
        const meta = CAT[base[1]];
        const desc = DESC[Math.floor(prng(g) * DESC.length)];
        const era = ERA[Math.floor(prng(g + 7) * ERA.length)];
        const title = (desc + base[0] + era).slice(0, 140);
        const sold = Math.round((meta.lo + Math.floor(prng(g + 1) * (meta.hi - meta.lo))) / 500) * 500;
        const bids = 3 + Math.floor(prng(g + 2) * 28);
        const img = IMG(meta.imgs[Math.floor(prng(g + 3) * meta.imgs.length)]);
        const lid = `5b00000${th.n}-0000-4000-8000-${String(i).padStart(12, '0')}`;
        await c.query(
          `INSERT INTO lots (id, auction_id, lot_number, title, description, category, size_category, pickup_category,
             condition, era, starting_bid_cents, bid_increment_cents, current_bid_cents, bid_count,
             winning_amount_cents, winning_buyer_user_id, state, is_featured, shippable, thumbnail_url, images_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Very good','20th century',$9,NULL,$10,$11,$10,NULL,'closed',$12,false,$13,1)
           ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, category=EXCLUDED.category, current_bid_cents=EXCLUDED.current_bid_cents,
             winning_amount_cents=EXCLUDED.winning_amount_cents, bid_count=EXCLUDED.bid_count, state='closed', thumbnail_url=EXCLUDED.thumbnail_url`,
          [lid, aid, i, title, 'Sold through Advantage.Bid. Sample lot shown for demonstration of past auction results.',
           base[1], meta.s, meta.pk, Math.max(100, Math.round(sold * 0.3 / 500) * 500), sold, bids, i <= 3, img]);
        await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) SELECT $1,$2,0 WHERE NOT EXISTS (SELECT 1 FROM lot_images WHERE lot_id=$1)`, [lid, img]);
      }
    }

    // Verify
    const v = (await c.query(`SELECT COUNT(*)::int closed_nonarch FROM auctions WHERE state='closed' AND is_archived=false`)).rows[0];
    const cur = (await c.query(`SELECT COUNT(*)::int n FROM auctions WHERE id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    const lc = (await c.query(`SELECT COUNT(*)::int n, MIN(cnt) mn, MAX(cnt) mx FROM (SELECT auction_id, COUNT(*) cnt FROM lots WHERE auction_id = ANY($1::uuid[]) GROUP BY auction_id) s`, [curatedIds])).rows[0];
    const tot = (await c.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE winning_amount_cents IS NOT NULL)::int sold, COUNT(*) FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int realbuyer, COALESCE(SUM(bid_count),0)::int bids FROM lots WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0];
    const pay = (await c.query(`SELECT COUNT(*)::int n FROM payments WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    const inv = (await c.query(`SELECT COUNT(*)::int n FROM invoices WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    console.log('Curated auctions: ' + cur + ' (expect 6) | per-auction lots min=' + lc.mn + ' max=' + lc.mx);
    console.log('Total curated lots: ' + tot.n + ' sold=' + tot.sold + ' total_bids=' + tot.bids + ' real-buyers=' + tot.realbuyer + ' (expect 0)');
    console.log('payments=' + pay + ' invoices=' + inv + ' (expect 0/0) | closed non-archived auctions total: ' + v.closed_nonarch);
    const pass = cur === 6 && lc.mn >= 35 && lc.mx <= 45 && tot.n >= 230 && tot.sold === tot.n && tot.realbuyer === 0 && pay === 0 && inv === 0 && v.closed_nonarch === 6;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL', e.message); console.error(e.stack); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
