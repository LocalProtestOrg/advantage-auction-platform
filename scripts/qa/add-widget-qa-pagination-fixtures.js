'use strict';
/**
 * Top-up bulk QA fixtures so each preset spans multiple pages (page size = 12).
 * Brings marked auctions AND marked events up to TARGET each (default 26 → 3 pages: 12+12+2;
 * all-events → 52 → 5 pages). SAME marker (widget_visual_qa_2026_07) as the showcase fixtures, so
 * the existing cleanup script (scripts/qa/cleanup-widget-qa-fixtures.js) removes these too.
 *
 * Safe by the same design as create-widget-qa-fixtures.js: no lots (non-biddable), end dates well in
 * the future (no scheduler close → no emails/payouts/settlements), direct INSERT (no notifications),
 * city/state only (no private street addresses), marker in admin_notes.qa_marker / events.review_reason
 * (NOT attribution_source, which renders publicly). Idempotent: only inserts the shortfall to TARGET.
 */
const REPO = 'C:/Users/tyler/OneDrive/Documents/Projects/advantage-auction-platform';
const { Pool } = require(REPO + '/node_modules/pg');
const crypto = require('crypto');

const MARKER = 'widget_visual_qa_2026_07';
const TARGET = parseInt(process.argv[2], 10) || 26;   // per preset (auctions, events)
const SELLER_BUSINESS = 'e8e94268-10fb-485a-8f2a-82aedde49929'; // business (branded)
const SELLER_PRIVATE  = 'aa000000-0000-4000-8000-000000000201'; // private (anonymized)
const ORG_A = 'a9a2f8c6-5929-4335-a453-ffef96270e5c'; // Advantage Auction Company
const ORG_B = 'ab303fcb-b693-4a20-aa42-b22d1c5598f4'; // AAC
const IMG = 'https://bid.advantage.bid/img/social-card.png';
const TZ = 'America/Detroit';
const D = (days) => new Date(Date.now() + days * 86400000);

// City pool (name, state, lat, lng, zip) — varied for location/sort testing.
const CITIES = [
  ['Adrian', 'MI', 41.8975, -84.0372, '49221'], ['Tecumseh', 'MI', 42.0084, -83.9447, '49286'],
  ['Ann Arbor', 'MI', 42.2808, -83.7430, '48104'], ['Detroit', 'MI', 42.3314, -83.0458, '48226'],
  ['Toledo', 'OH', 41.6528, -83.5379, '43604'], ['Jackson', 'MI', 42.2459, -84.4013, '49201'],
  ['Lansing', 'MI', 42.7325, -84.5555, '48933'], ['Chicago', 'IL', 41.8819, -87.6278, '60601'],
  ['Grand Rapids', 'MI', 42.9634, -85.6681, '49503'], ['Fort Wayne', 'IN', 41.0793, -85.1394, '46802'],
  ['Columbus', 'OH', 39.9612, -82.9988, '43215'], ['Houston', 'TX', 29.7589, -95.3677, '77002'],
];
const A_KINDS = ['Estate Auction', 'Antiques Auction', 'Household Auction', 'Coin & Jewelry Auction',
  'Tools & Equipment Auction', 'Fine Art Auction', 'Mid-Century Auction', 'Collectibles Auction'];
const E_KINDS = ['Whole-Home Estate Sale', 'Downsizing Sale', 'Moving Sale', 'Collector\'s Estate Sale',
  'Vintage Estate Sale', 'Antique Estate Sale', 'Multi-Family Estate Sale', 'Luxury Estate Sale'];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const host = (process.env.DATABASE_URL || '').split('@')[1] || '';
  if (!/proud-leaf/.test(host)) { console.error('Refusing: not the prod endpoint (' + host.split('/')[0] + ')'); process.exit(1); }
  const c = await pool.connect();
  try {
    const haveA = Number((await c.query("SELECT count(*) c FROM auctions WHERE admin_notes->>'qa_marker' = $1", [MARKER])).rows[0].c);
    const haveE = Number((await c.query('SELECT count(*) c FROM events WHERE review_reason = $1', [MARKER])).rows[0].c);
    const addA = Math.max(0, TARGET - haveA), addE = Math.max(0, TARGET - haveE);
    console.log(`Have ${haveA} auctions / ${haveE} events. Target ${TARGET} each → adding ${addA} auctions, ${addE} events.`);
    if (!addA && !addE) { console.log('Already at target. Nothing to add.'); process.exit(0); }

    await c.query('BEGIN');
    for (let i = 0; i < addA; i++) {
      const [city, st, lat, lng, zip] = CITIES[i % CITIES.length];
      const seller = (i % 4 === 0) ? SELLER_PRIVATE : SELLER_BUSINESS;   // ~1 in 4 private (anonymized)
      const img = (i % 3 === 0) ? null : IMG;                            // ~1 in 3 imageless (fallback)
      const state = (i % 2 === 0) ? 'active' : 'published';
      const n = haveA + i + 1;
      const title = `TEST — ${city} ${A_KINDS[i % A_KINDS.length]} #${n}`;
      await c.query(
        `INSERT INTO auctions (id, seller_id, title, description, city, address_state, zip, lat, lng, timezone,
           start_time, end_time, state, marketplace_status, is_archived, is_featured, public_auction_type,
           cover_image_url, admin_notes, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'syndicated',false,$14,'estate',$15,$16,1,now(),now())`,
        [crypto.randomUUID(), seller, title, 'Temporary pagination-QA fixture. Not a real sale.',
         city, st, zip, lat, lng, TZ, D(state === 'active' ? -1 : 2 + (i % 6)), D(8 + (i % 21)), state,
         (i % 9 === 0), img, JSON.stringify({ qa_marker: MARKER, note: 'Temporary widget pagination-QA fixture — safe to delete.' })]);
    }
    for (let i = 0; i < addE; i++) {
      const [city, st, lat, lng, zip] = CITIES[i % CITIES.length];
      const org = (i % 2 === 0) ? ORG_A : ORG_B;
      const img = (i % 3 === 1) ? null : IMG;
      const n = haveE + i + 1;
      const id = crypto.randomUUID();
      const title = `TEST — ${city} ${E_KINDS[i % E_KINDS.length]} #${n}`;
      const slug = 'test-' + city.toLowerCase().replace(/[^a-z]+/g, '-') + '-estate-sale-' + id.slice(0, 8);
      await c.query(
        `INSERT INTO events (id, organization_id, title, description, city, state, zip, lat, lng, timezone,
           start_at, end_at, status, source, category_slug, market_slug, is_featured, venue_name,
           review_reason, slug, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'published','admin','estate_sales','houston',$13,$14,$15,$16,now())`,
        [id, org, title, 'Temporary pagination-QA fixture. Not a real sale.', city, st, zip, lat, lng, TZ,
         D(2 + (i % 20)), D(4 + (i % 22)), (i % 9 === 0), city + ' (test venue)', MARKER, slug]);
      if (img) await c.query('INSERT INTO event_images (event_id, url, is_cover, position) VALUES ($1,$2,true,0)', [id, img]);
    }
    await c.query('COMMIT');

    const totA = Number((await c.query("SELECT count(*) c FROM auctions WHERE admin_notes->>'qa_marker' = $1", [MARKER])).rows[0].c);
    const totE = Number((await c.query('SELECT count(*) c FROM events WHERE review_reason = $1', [MARKER])).rows[0].c);
    const pages = (n) => Math.max(1, Math.ceil(n / 12));
    console.log(`DONE. Marked totals — auctions: ${totA} (${pages(totA)} pages), events: ${totE} (${pages(totE)} pages), all-events: ${totA + totE} (${pages(totA + totE)} pages).`);
  } catch (e) { await c.query('ROLLBACK'); console.error('ERROR (rolled back):', e.message); process.exit(1); }
  finally { c.release(); await pool.end(); }
})();
