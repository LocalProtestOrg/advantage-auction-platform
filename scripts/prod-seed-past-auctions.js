#!/usr/bin/env node
/* prod-seed-past-auctions.js — PRODUCTION-guarded. Seeds a CURATED set of polished demo
 * PAST (closed, non-archived) auctions for the public Past Auctions surface, and
 * archives every OTHER closed auction so only the curated set is publicly visible.
 *
 * SAFETY / DESIGN:
 *  - Curated auctions: state='closed', is_archived=false, representative lots marked
 *    SOLD (winning_amount_cents set, lot.state='closed', realistic bid_count).
 *  - NO payments, NO invoices, NO real buyer data (winning_buyer_user_id is NULL).
 *  - Realized prices remain gated by the existing #20.1 rule (anonymous see "closed",
 *    logged-in see "Sold for $X") — this seed changes no privacy logic.
 *  - Curation: all closed auctions NOT in the curated set are set is_archived=true so
 *    the public ?state=closed feed shows ONLY these polished demos (no test/junk).
 *  - Idempotent (fixed UUIDs). Does NOT touch Stripe/payments/payouts/premium/terms.
 */
const { Pool } = require('pg');

const SELLER_SP = '5a000000-0000-4000-8000-000000000002'; // reuse "Advantage Showcase" demo seller
const A1 = '5b000000-0000-4000-8000-000000000010';
const A2 = '5b000000-0000-4000-8000-000000000020';
const CURATED = [A1, A2];
const IMG = (id) => `https://images.unsplash.com/${id}?w=900&h=675&fit=crop&q=80`;
const lid = (a, n) => a.slice(0, -2) + (parseInt(a.slice(-2), 16) + n).toString(16).padStart(2, '0');

const AUCTIONS = [
  { id: A1, title: 'Spring Estate Collection', subtitle: 'Sample past auction results',
    startISO: '2026-05-01 15:00:00+00', endISO: '2026-05-04 23:00:00+00', cover: 'photo-1513519245088-0e12902e35ca',
    lots: [
      { t: 'Antique Mahogany Sideboard', cat: 'Furniture', s: 'C', pk: 'C', start: 15000, sold: 42000, bids: 11, img: 'photo-1518455027359-f3f8164ba6bd' },
      { t: 'Pair of Crystal Table Lamps', cat: 'Home Decor', s: 'B', pk: 'B', start: 5000, sold: 18500, bids: 8, img: 'photo-1543198126-c3e1c0a9d6d2' },
      { t: 'Sterling Silver Flatware Service', cat: 'Antiques', s: 'B', pk: 'B', start: 20000, sold: 61000, bids: 14, img: 'photo-1610701596007-11502861dcfa' },
      { t: 'Framed Watercolor Landscape', cat: 'Fine Art', s: 'B', pk: 'B', start: 8000, sold: 23000, bids: 9, img: 'photo-1578321272176-b7bbc0679853' },
      { t: 'Vintage Mantel Clock', cat: 'Clocks & Timepieces', s: 'A', pk: 'B', start: 6000, sold: 14500, bids: 7, img: 'photo-1495856458515-0637185db551' },
    ] },
  { id: A2, title: 'Modern Design & Decor', subtitle: 'Sample past auction results',
    startISO: '2026-05-20 15:00:00+00', endISO: '2026-05-23 23:00:00+00', cover: 'photo-1555041469-a586c61ea9bc',
    lots: [
      { t: 'Mid-Century Lounge Chair', cat: 'Furniture', s: 'C', pk: 'C', start: 12000, sold: 38000, bids: 13, img: 'photo-1586023492125-27b2c045efd7' },
      { t: 'Brass Arc Floor Lamp', cat: 'Home Decor', s: 'B', pk: 'B', start: 4000, sold: 12500, bids: 6, img: 'photo-1543159006-2e0c69cfe5b1' },
      { t: 'Abstract Oil on Canvas', cat: 'Fine Art', s: 'B', pk: 'B', start: 10000, sold: 47000, bids: 16, img: 'photo-1549887534-1541e9326642' },
      { t: 'Set of Six Walnut Dining Chairs', cat: 'Furniture', s: 'C', pk: 'C', start: 9000, sold: 27500, bids: 10, img: 'photo-1503602642458-232111445657' },
    ] },
];

(async () => {
  const raw = process.env.DATABASE_URL || '';
  if (raw.includes('ep-royal-dawn-anarou3f')) { console.error('REFUSE: STAGING endpoint. PRODUCTION-only.'); return 2; }
  if (!raw.includes('ep-proud-leaf-an8pzkib')) { console.error('REFUSE: not the PRODUCTION endpoint.'); return 2; }
  const pool = new Pool({ connectionString: raw.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const sp = (await c.query('SELECT id FROM seller_profiles WHERE id = $1', [SELLER_SP])).rows[0];
    if (!sp) { console.error('FAIL: demo seller profile ' + SELLER_SP + ' not found (run the Summer Showcase seed first).'); return 1; }

    for (const a of AUCTIONS) {
      await c.query(
        `INSERT INTO auctions (id, seller_id, title, subtitle, description, state, city, address_state, zip, lat, lng,
           shipping_available, start_time, end_time, cover_image_url, banner_image_url, is_archived)
         VALUES ($1,$2,$3,$4,$5,'closed','Knoxville','TN','37902',35.9606,-83.9207,false,
                 TIMESTAMPTZ '${a.startISO}', TIMESTAMPTZ '${a.endISO}', $6,$6,false)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, subtitle=EXCLUDED.subtitle, description=EXCLUDED.description,
           state='closed', is_archived=false, cover_image_url=EXCLUDED.cover_image_url, banner_image_url=EXCLUDED.banner_image_url`,
        [a.id, SELLER_SP, a.title, a.subtitle,
         'Illustrative past auction shown to demonstrate the Advantage.Bid selling experience. Results are sample data.',
         IMG(a.cover)]);
      let n = 0;
      for (const L of a.lots) {
        n += 1; const id = lid(a.id, n);
        await c.query(
          `INSERT INTO lots (id, auction_id, lot_number, title, description, category, size_category, pickup_category,
             condition, era, starting_bid_cents, bid_increment_cents, current_bid_cents, bid_count,
             winning_amount_cents, winning_buyer_user_id, state, is_featured, shippable, thumbnail_url, images_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,$12,NULL,'closed',false,false,$14,1)
           ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, category=EXCLUDED.category, starting_bid_cents=EXCLUDED.starting_bid_cents,
             current_bid_cents=EXCLUDED.current_bid_cents, winning_amount_cents=EXCLUDED.winning_amount_cents, bid_count=EXCLUDED.bid_count,
             state='closed', thumbnail_url=EXCLUDED.thumbnail_url`,
          [id, a.id, n, L.t, 'Sold through Advantage.Bid. Sample lot for demonstration of past auction results.',
           L.cat, L.s, L.pk, 'Very good', '20th century', L.start, L.sold, L.bids, IMG(L.img)]);
        await c.query(`INSERT INTO lot_images (lot_id, image_url, sort_order) SELECT $1,$2,0 WHERE NOT EXISTS (SELECT 1 FROM lot_images WHERE lot_id=$1)`, [id, IMG(L.img)]);
      }
    }

    // Curate: archive every OTHER closed auction so only the curated demos are public.
    const archived = await c.query(
      `UPDATE auctions SET is_archived=true, updated_at=now()
        WHERE state='closed' AND is_archived=false AND id <> ALL($1::uuid[]) RETURNING id, title`, [CURATED]);

    // Verify
    const v = (await c.query(
      `SELECT COUNT(*)::int closed_nonarch FROM auctions WHERE state='closed' AND is_archived=false`)).rows[0];
    const pay = (await c.query(`SELECT COUNT(*)::int n FROM payments WHERE auction_id = ANY($1::uuid[])`, [CURATED])).rows[0].n;
    const inv = (await c.query(`SELECT COUNT(*)::int n FROM invoices WHERE auction_id = ANY($1::uuid[])`, [CURATED])).rows[0].n;
    const lots = (await c.query(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE state='closed' AND winning_amount_cents IS NOT NULL)::int sold, COUNT(*) FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int realbuyer FROM lots WHERE auction_id = ANY($1::uuid[])`, [CURATED])).rows[0];
    console.log('Archived ' + archived.rowCount + ' non-curated closed auction(s).');
    console.log('Curated past auctions: ' + CURATED.length + ' | lots=' + lots.n + ' sold=' + lots.sold + ' real-buyers=' + lots.realbuyer + ' (expect 0)');
    console.log('Closed non-archived auctions total now: ' + v.closed_nonarch + ' (expect ' + CURATED.length + ')');
    console.log('payments=' + pay + ' invoices=' + inv + ' for curated (expect 0/0)');
    const pass = v.closed_nonarch === CURATED.length && pay === 0 && inv === 0 && lots.realbuyer === 0 && lots.sold === lots.n;
    console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'));
    return pass ? 0 : 1;
  } catch (e) { console.error('FATAL', e.message); console.error(e.stack); return 1; }
  finally { c.release(); await pool.end(); }
})().then(code => process.exit(code || 0)).catch(e => { console.error('FATAL', e.message); process.exit(1); });
