#!/usr/bin/env node
/* seed-demo-storefront.js — configure the Heritage & Home (DEMO) Professional Storefront + a demo closed
 * UNSOLD lot (for the one-button conversion demo) + a demo Marketplace item. All records is_demo=true and
 * scoped to fixed demo UUIDs; idempotent (upserts). Demo-safe content only — nothing fabricated as real.
 *   railway run node scripts/seed-demo-storefront.js */
const { Pool } = require('pg');
const ID = {
  profile: '00000000-0000-4000-a000-0000000d0002',
  user:    '00000000-0000-4000-a000-0000000d0001',
  pastAuction: '00000000-0000-4000-a000-0000000d0007',
  unsoldLot:   '00000000-0000-4000-a000-0000000d0008',
  directItem:  '00000000-0000-4000-a000-0000000d0009',
};
const STOREFRONT = {
  tagline: 'Full-service estate sales, liquidations & online auctions',
  about: 'Heritage & Home Estate Services is a full-service estate-sale company (DEMO) handling downsizing, estate liquidations, and online auctions. We help families through transitions with care, and reach more buyers by bringing sales online. This is a demonstration storefront used to showcase Advantage.Bid Professional Storefronts.',
  services: ['Estate Sales', 'Online Auctions', 'Estate Liquidation', 'Downsizing', 'Appraisals', 'Cleanouts', 'Consignment'],
  years_in_business: '20+',
  about_facts: ['Family-owned (demo)', 'Insured & bonded (demo)', 'Serving the region since 2004 (demo)'],
  hours: 'Mon–Fri 9:00–5:00 · Sat by appointment',
  public_phone: '(555) 010-0100',
  service_area: 'Greater Region (demo)',
  socials: {},
  testimonials: [
    { text: 'They handled my parents’ estate with care and professionalism from start to finish. (Demo testimonial)', name: 'A. Sample', location: 'Maplewood, OH' },
    { text: 'The online auction reached far more buyers than a weekend sale ever could. (Demo testimonial)', name: 'J. Demo', location: 'Cleveland, OH' },
    { text: 'Everything was organized, priced fairly, and the payout was quick. (Demo testimonial)', name: 'R. Example' },
  ],
  section_visibility: { about: true, services: true, events: true, auctions: true, marketplace: true, past: true, gallery: true, testimonials: true, team: false, service_area: true, contact: true },
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL.replace('-pooler', ''), ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const sp = (await c.query('SELECT id, is_demo FROM seller_profiles WHERE id=$1', [ID.profile])).rows[0];
    if (!sp) { console.log('DEMO_PROFILE_MISSING — run scripts/demo-environment.js seed first.'); return; }
    if (!sp.is_demo) { console.log('REFUSE: target profile is not is_demo.'); return; }

    await c.query(
      `UPDATE seller_profiles SET storefront_slug='heritage-home-estate-services', storefront_published=true, storefront=$2::jsonb WHERE id=$1`,
      [ID.profile, JSON.stringify(STOREFRONT)]);
    console.log('STOREFRONT configured + published (slug=heritage-home-estate-services)');

    // Demo closed auction (a past sale) owned by the demo seller.
    await c.query(
      `INSERT INTO auctions (id, seller_id, title, subtitle, public_auction_type, city, address_state, zip, state,
                             start_time, end_time, is_demo, marketplace_status, is_archived, buyer_premium_bps)
       VALUES ($1,$2,'Autumn Estate Auction (DEMO)','A curated demo estate auction','estate','Maplewood','OH','44060','closed',
               now() - interval '10 days', now() - interval '3 days', true, 'hidden', false, 1500)
       ON CONFLICT (id) DO UPDATE SET state='closed', is_demo=true, end_time=now() - interval '3 days'`,
      [ID.pastAuction, ID.profile]);

    // Demo CLOSED, UNSOLD lot (no winner) — eligible for one-button Marketplace conversion.
    await c.query(
      `INSERT INTO lots (id, auction_id, lot_number, title, description, category, condition, size_category,
                         state, is_withdrawn, starting_bid_cents, reserve_cents, current_bid_cents, bid_count,
                         shippable, shipping_cost_cents, pickup_group, thumbnail_url, closes_at)
       VALUES ($1,$2,1,'Antique Brass Table Lamp (DEMO)','A demonstration lot that closed without selling — perfect for the one-click Marketplace move.','Lighting','Good','B',
               'closed', false, 5000, 8000, 0, 0, true, 1500, 'B_group', NULL, now() - interval '3 days')
       ON CONFLICT (id) DO UPDATE SET state='closed', winning_buyer_user_id=NULL, bid_count=0, reserve_cents=8000, starting_bid_cents=5000`,
      [ID.unsoldLot, ID.pastAuction]);
    // Ensure it is truly unsold (no winner/payment) for the demo.
    await c.query('UPDATE lots SET winning_buyer_user_id=NULL, winning_amount_cents=NULL WHERE id=$1', [ID.unsoldLot]);
    await c.query("DELETE FROM payments WHERE lot_id=$1", [ID.unsoldLot]);
    console.log('DEMO past auction + unsold lot seeded (unsold lot=' + ID.unsoldLot + ')');

    // Demo DIRECT marketplace item so "Shop Available Items" is populated on the demo storefront.
    await c.query(
      `INSERT INTO marketplace_items (id, seller_id, title, description, category, condition, price_cents,
                                      images, thumbnail_url, city, state, shippable, shipping_cost_cents, pickup_group,
                                      status, is_demo, conversion_reason)
       VALUES ($1,$2,'Mid-Century Walnut Sideboard (DEMO)','A demonstration fixed-price Marketplace item available now from Heritage & Home.','Furniture','Very Good',45000,
               '[]'::jsonb, NULL, 'Maplewood','OH', true, 6500, 'A_group', 'active', true, 'direct')
       ON CONFLICT (id) DO UPDATE SET price_cents=45000, status='active', is_demo=true`,
      [ID.directItem, ID.profile]);
    console.log('DEMO direct marketplace item seeded');

    const url = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '') + '/pro/heritage-home-estate-services';
    console.log('DEMO_STOREFRONT_URL=' + url);
  } finally { c.release(); await pool.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
