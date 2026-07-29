'use strict';
/**
 * Widget Visual QA fixtures — TEMPORARY, clearly-marked marketplace records so the owner can see the
 * three feed presets populated. SAFE BY DESIGN:
 *  - Auctions have NO lots → nothing is biddable; end_times are 7–30 days out → the scheduler won't
 *    close them during QA, so NO closeout emails / payouts / settlements fire.
 *  - Direct INSERTs only (no publishAuction/enroll services) → NO follower fan-out / notifications.
 *  - Every record carries the marker widget_visual_qa_2026_07 (auctions.admin_notes->>'qa_marker'
 *    [jsonb], events.attribution_source [text]) so cleanup is exact.
 *  - No real customer/seller records touched; no private street addresses; branded seller identity only
 *    for professional sellers (private seller stays anonymous via the platform's server-side rule).
 * Idempotent: refuses to double-insert if marked fixtures already exist.
 */
const REPO = 'C:/Users/tyler/OneDrive/Documents/Projects/advantage-auction-platform';
const { Pool } = require(REPO + '/node_modules/pg');
const crypto = require('crypto');

const MARKER = 'widget_visual_qa_2026_07';
const SELLER_BUSINESS = 'e8e94268-10fb-485a-8f2a-82aedde49929'; // "Advantage Estate Services" (business, branded)
const SELLER_PRIVATE  = 'aa000000-0000-4000-8000-000000000201'; // "Advantage Estate Auctions" (private → anonymized)
const ORG_A = 'a9a2f8c6-5929-4335-a453-ffef96270e5c'; // "Advantage Auction Company" (verified)
const ORG_B = 'ab303fcb-b693-4a20-aa42-b22d1c5598f4'; // "AAC"
const IMG = 'https://bid.advantage.bid/img/social-card.png'; // platform's own branded placeholder
const TZ = 'America/Detroit';
const D = (days) => new Date(Date.now() + days * 86400000);
const C = { adrian: [41.8975, -84.0372, 'Adrian', 'MI', '49221'], tecumseh: [42.0084, -83.9447, 'Tecumseh', 'MI', '49286'],
  annarbor: [42.2808, -83.7430, 'Ann Arbor', 'MI', '48104'], detroit: [42.3314, -83.0458, 'Detroit', 'MI', '48226'],
  chicago: [41.8819, -87.6278, 'Chicago', 'IL', '60601'], houston: [29.7589, -95.3677, 'Houston', 'TX', '77002'] };

// [title, cityKey, seller, state, startDays, endDays, image, featured]
const AUCTIONS = [
  ['TEST — Downtown Adrian Estate Auction', 'adrian', SELLER_BUSINESS, 'active', -1, 9, IMG, true],
  ['TEST — Tecumseh Furniture & Décor Auction', 'tecumseh', SELLER_PRIVATE, 'active', -1, 12, null, false],
  ['TEST — Ann Arbor Collectibles Auction', 'annarbor', SELLER_BUSINESS, 'published', 3, 18, IMG, false],
  ['TEST — Detroit Equipment & Tools Auction', 'detroit', SELLER_PRIVATE, 'active', -1, 7, IMG, false],
  ['TEST — Chicago Decorative Arts Auction', 'chicago', SELLER_BUSINESS, 'published', 5, 25, null, false],
  ['TEST — Houston Home Furnishings & Fine Estate Liquidation Collection', 'houston', SELLER_BUSINESS, 'active', -1, 30, IMG, true],
];
// [title, cityKey, org, startDays, endDays, image, featured]
const EVENTS = [
  ['TEST — Adrian Whole-Home Estate Sale', 'adrian', ORG_A, 2, 4, IMG, true],
  ['TEST — Tecumseh Downsizing Sale', 'tecumseh', ORG_B, 6, 7, null, false],
  ['TEST — Ann Arbor Mid-Century Estate Sale', 'annarbor', ORG_A, 10, 12, IMG, false],
  ['TEST — Detroit Historic Home Estate Sale of Fine Antiques, Collectibles & Household Goods', 'detroit', ORG_B, 14, 16, IMG, false],
  ["TEST — Chicago Collector's Estate Sale", 'chicago', ORG_A, 20, 22, null, false],
  ['TEST — Houston Luxury Estate Sale', 'houston', ORG_B, 28, 30, IMG, true],
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const host = (process.env.DATABASE_URL || '').split('@')[1] || '';
  if (!/proud-leaf/.test(host)) { console.error('Refusing: not the prod endpoint (' + host.split('/')[0] + ')'); process.exit(1); }
  const c = await pool.connect();
  const manifest = [];
  try {
    const existing = (await c.query(
      "SELECT (SELECT count(*) FROM auctions WHERE admin_notes->>'qa_marker' = $1) a, (SELECT count(*) FROM events WHERE attribution_source = $1) e", [MARKER])).rows[0];
    if (Number(existing.a) + Number(existing.e) > 0) {
      console.log('SKIP: marked fixtures already exist (' + existing.a + ' auctions, ' + existing.e + ' events). Clean up first to re-create.');
      process.exit(0);
    }
    await c.query('BEGIN');
    for (const [title, ck, seller, state, sd, ed, img, feat] of AUCTIONS) {
      const [lat, lng, city, st, zip] = C[ck];
      const id = crypto.randomUUID();
      await c.query(
        `INSERT INTO auctions (id, seller_id, title, description, city, address_state, zip, lat, lng, timezone,
           start_time, end_time, state, marketplace_status, is_archived, is_featured, public_auction_type,
           cover_image_url, admin_notes, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'syndicated',false,$14,'estate',$15,$16,1,now(),now())`,
        [id, seller, title, 'Temporary visual-QA fixture. Not a real sale.', city, st, zip, lat, lng, TZ,
         D(sd), D(ed), state, feat, img, JSON.stringify({ qa_marker: MARKER, note: 'Temporary widget visual-QA fixture — safe to delete.' })]);
      manifest.push({ type: 'auction', id, slug: null, title, location: city + ', ' + st + ' ' + zip, status: state,
        start: D(sd).toISOString(), end: D(ed).toISOString(), image: img ? 'branded placeholder' : 'none (fallback)',
        seller: seller === SELLER_PRIVATE ? 'private (anonymized)' : 'Advantage Estate Services (business, branded)', marker: MARKER });
    }
    for (const [title, ck, org, sd, ed, img, feat] of EVENTS) {
      const [lat, lng, city, st, zip] = C[ck];
      const id = crypto.randomUUID();
      const slug = 'test-' + city.toLowerCase().replace(/[^a-z]+/g, '-') + '-estate-sale-' + id.slice(0, 8);
      await c.query(
        `INSERT INTO events (id, organization_id, title, description, city, state, zip, lat, lng, timezone,
           start_at, end_at, status, source, category_slug, market_slug, is_featured, venue_name,
           attribution_source, slug, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published','admin','estate_sales','houston',$13,$14,$15,$16,now())`,
        [id, org, title, 'Temporary visual-QA fixture. Not a real sale.', city, st, zip, lat, lng, TZ,
         D(sd), D(ed), feat, city + ' (test venue)', MARKER, slug]);
      if (img) await c.query('INSERT INTO event_images (event_id, url, is_cover, position) VALUES ($1,$2,true,0)', [id, img]);
      manifest.push({ type: 'estate_sale', id, slug, title, location: city + ', ' + st + ' ' + zip, status: 'published',
        start: D(sd).toISOString(), end: D(ed).toISOString(), image: img ? 'branded placeholder' : 'none (fallback)',
        org: org === ORG_A ? 'Advantage Auction Company' : 'AAC', marker: MARKER });
    }
    await c.query('COMMIT');
    console.log('CREATED ' + manifest.length + ' fixtures (6 auctions + 6 estate sales).');
    console.log(JSON.stringify(manifest, null, 2));
  } catch (e) { await c.query('ROLLBACK'); console.error('ERROR (rolled back):', e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
})();
