#!/usr/bin/env node
/* prod-seed-past-auctions.js — PRODUCTION-guarded. Seeds a CURATED LIBRARY of 6 polished
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

const OLD_CURATED = ['5b000000-0000-4000-8000-000000000010', '5b000000-0000-4000-8000-000000000020'];

// Inline SVG "catalog tile" data-URI. Category-specific (gradient + category label),
// deterministic, and UNIQUE per lot (each renders its own item title + "LOT n"), so a
// tile can never mismatch its subject and no two lots share an image. CSP is disabled
// app-wide, so data: image URIs render in <img>. No external stock dependency.
function svgEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function wrapText(s, max) { const out = []; let line = ''; for (const w of String(s).split(' ')) { if ((line + ' ' + w).trim().length > max) { if (line) out.push(line.trim()); line = w; } else line += ' ' + w; } if (line.trim()) out.push(line.trim()); return out.slice(0, 3); }
function tile(label, title, c1, c2, lotNo) {
  const lines = wrapText(title, 22);
  const tspans = lines.map((ln, i) => `<tspan x='40' dy='${i === 0 ? 0 : 44}'>${svgEsc(ln)}</tspan>`).join('');
  const lotTag = lotNo ? `<text x='604' y='62' text-anchor='end' fill='#cbd5e1' font-family='Arial, sans-serif' font-size='18' letter-spacing='1'>LOT ${svgEsc(String(lotNo))}</text>` : '';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480'>`
    + `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>`
    + `<rect width='640' height='480' fill='url(#g)'/>`
    + `<rect x='14' y='14' width='612' height='452' fill='none' stroke='rgba(255,255,255,0.18)' stroke-width='2'/>`
    + `<text x='40' y='66' fill='#e2e8f0' font-family='Georgia, serif' font-size='20' letter-spacing='3'>ADVANTAGE.BID</text>`
    + lotTag
    + `<text x='40' y='220' fill='#ffffff' font-family='Georgia, serif' font-size='34' font-weight='700'>${tspans}</text>`
    + `<text x='40' y='430' fill='#cbd5e1' font-family='Arial, sans-serif' font-size='19' letter-spacing='1'>${svgEsc(label)}</text>`
    + `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
const COVER = (title) => tile(title, 'Sample Auction Results', '#0f172a', '#1d4ed8', '');

// Deterministic pseudo-random in [0,1) from an integer seed (stable across runs).
function prng(s) { const x = Math.sin(s * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

// category -> size/pickup + sold-value range (cents) + tile gradient [c1,c2]
const CAT = {
  'Jewelry':              { s: 'A', pk: 'A', lo: 18000,  hi: 950000,  c: ['#1e1b4b', '#6d28d9'] },
  'Watches':              { s: 'A', pk: 'A', lo: 25000,  hi: 750000,  c: ['#0f172a', '#334155'] },
  'Fine Art':             { s: 'B', pk: 'B', lo: 30000,  hi: 1800000, c: ['#1e293b', '#9a3412'] },
  'Sculpture':            { s: 'B', pk: 'B', lo: 35000,  hi: 900000,  c: ['#1f2937', '#57534e'] },
  'Antiques':             { s: 'B', pk: 'B', lo: 9000,   hi: 320000,  c: ['#292524', '#78716c'] },
  'Furniture':            { s: 'C', pk: 'C', lo: 15000,  hi: 620000,  c: ['#1c1917', '#92400e'] },
  'Home Decor':           { s: 'B', pk: 'B', lo: 5000,   hi: 280000,  c: ['#0f172a', '#155e75'] },
  'Clocks & Timepieces':  { s: 'A', pk: 'B', lo: 8000,   hi: 240000,  c: ['#111827', '#3730a3'] },
  'Pottery & Ceramics':   { s: 'B', pk: 'B', lo: 7000,   hi: 180000,  c: ['#1e293b', '#166534'] },
  'Coins & Currency':     { s: 'A', pk: 'A', lo: 9000,   hi: 480000,  c: ['#1f2937', '#a16207'] },
  'Collectibles':         { s: 'A', pk: 'B', lo: 5000,   hi: 360000,  c: ['#18181b', '#3f3f46'] },
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
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint.'); return 2; }
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
         'Sample auction results shown to demonstrate the Advantage.Bid selling experience. Demonstration data; not a record of an actual sale.', COVER(th.title)]);
      for (let i = 1; i <= th.count; i++) {
        g += 1;
        const base = th.items[(i - 1) % th.items.length];
        const meta = CAT[base[1]];
        const desc = DESC[Math.floor(prng(g) * DESC.length)];
        const era = ERA[Math.floor(prng(g + 7) * ERA.length)];
        const title = (desc + base[0] + era).slice(0, 140);
        const sold = Math.round((meta.lo + Math.floor(prng(g + 1) * (meta.hi - meta.lo))) / 500) * 500;
        const bids = 3 + Math.floor(prng(g + 2) * 28);
        const img = tile(base[1], title, meta.c[0], meta.c[1], i);
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
        await c.query(`DELETE FROM lot_images WHERE lot_id=$1`, [lid]);
        await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) VALUES ($1,$2,0)`, [lid, img]);
      }
    }

    // Verify
    const v = (await c.query(`SELECT COUNT(*)::int closed_nonarch FROM auctions WHERE state='closed' AND is_archived=false`)).rows[0];
    const cur = (await c.query(`SELECT COUNT(*)::int n FROM auctions WHERE id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    const lc = (await c.query(`SELECT COUNT(*)::int n, MIN(cnt) mn, MAX(cnt) mx FROM (SELECT auction_id, COUNT(*) cnt FROM lots WHERE auction_id = ANY($1::uuid[]) GROUP BY auction_id) s`, [curatedIds])).rows[0];
    const tot = (await c.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE winning_amount_cents IS NOT NULL)::int sold, COUNT(*) FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int realbuyer, COALESCE(SUM(bid_count),0)::int bids FROM lots WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0];
    const pay = (await c.query(`SELECT COUNT(*)::int n FROM payments WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    const inv = (await c.query(`SELECT COUNT(*)::int n FROM invoices WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0].n;
    // Image integrity: every lot has a category tile, all data: URIs (no external stock /
    // placeholders), and images are UNIQUE within each auction (no duplicates).
    const imgChk = (await c.query(
      `SELECT COUNT(*) FILTER (WHERE thumbnail_url NOT LIKE 'data:image/svg%')::int nondatatile,
              COUNT(*) FILTER (WHERE thumbnail_url IS NULL OR thumbnail_url = '')::int missing
         FROM lots WHERE auction_id = ANY($1::uuid[])`, [curatedIds])).rows[0];
    const dup = (await c.query(
      `SELECT COALESCE(SUM(GREATEST(c-1,0)),0)::int dupes FROM (
         SELECT auction_id, thumbnail_url, COUNT(*) c FROM lots WHERE auction_id = ANY($1::uuid[])
         GROUP BY auction_id, thumbnail_url HAVING COUNT(*) > 1) s`, [curatedIds])).rows[0].dupes;
    console.log('Curated auctions: ' + cur + ' (expect 6) | per-auction lots min=' + lc.mn + ' max=' + lc.mx);
    console.log('Total curated lots: ' + tot.n + ' sold=' + tot.sold + ' total_bids=' + tot.bids + ' real-buyers=' + tot.realbuyer + ' (expect 0)');
    console.log('Images: non-data-tile=' + imgChk.nondatatile + ' missing=' + imgChk.missing + ' duplicate-within-auction=' + dup + ' (expect 0/0/0)');
    console.log('payments=' + pay + ' invoices=' + inv + ' (expect 0/0) | closed non-archived auctions total: ' + v.closed_nonarch);
    const pass = cur === 6 && lc.mn >= 35 && lc.mx <= 45 && tot.n >= 230 && tot.sold === tot.n && tot.realbuyer === 0 && pay === 0 && inv === 0 && v.closed_nonarch === 6
      && imgChk.nondatatile === 0 && imgChk.missing === 0 && dup === 0;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL', e.message); console.error(e.stack); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
