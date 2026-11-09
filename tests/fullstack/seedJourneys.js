'use strict';

/**
 * Extra seed helpers for the watchdog's isolated user journeys (tests/browser/site-journeys.browser.test.js).
 * Everything is written to the in-memory test database of tests/fullstack/stack.js only. Builds on seed.js.
 */

const seed = require('./seed');

const day = 24 * 60 * 60 * 1000;

/** A live auction (started, ending tomorrow) with one open lot, owned by `sellerProfileId`. */
async function liveAuctionWithLot(stack, { sellerProfileId, title = 'Watchdog Estate Auction', lotTitle = 'Walnut Writing Desk' }) {
  const a = (await stack.query(
    `INSERT INTO auctions (seller_id, title, description, state, start_time, end_time, city, address_state, zip, marketplace_status)
     VALUES ($1, $2, 'Furniture and decor from a test estate.', 'active', now() - interval '1 hour', now() + interval '1 day', 'Houston', 'TX', '77002', 'syndicated')
     RETURNING id`, [sellerProfileId, title])).rows[0];
  const l = (await stack.query(
    `INSERT INTO lots (auction_id, title, description, state, closes_at, lot_number, starting_bid_cents, current_bid_cents, category, size_category)
     VALUES ($1, $2, 'A solid walnut writing desk with three drawers.', 'open', $3, 1, 100, 0, 'Furniture', 'B') RETURNING id`,
    [a.id, lotTitle, new Date(Date.now() + day)])).rows[0];
  return { auctionId: a.id, lotId: l.id };
}

/** Make a buyer eligible to bid in an auction: current buyer terms accepted, registered, a verified test-mode card. */
async function buyerReadyToBid(stack, { userId, auctionId, paddle = 101 }) {
  let tv = (await stack.query(`SELECT id FROM terms_versions WHERE kind = 'buyer_terms' AND is_current = true`)).rows[0];
  if (!tv) tv = (await stack.query(`INSERT INTO terms_versions (kind, version_int, title, body_markdown, is_current) VALUES ('buyer_terms', 1, 'Buyer Terms', 'Test terms.', true) RETURNING id`)).rows[0];
  await stack.query('INSERT INTO terms_acceptances (user_id, terms_version_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, tv.id]);
  await stack.query(`INSERT INTO auction_buyers (auction_id, user_id, paddle_number, status) VALUES ($1, $2, $3, 'active')`, [auctionId, userId, paddle]);
  await stack.query(`UPDATE users SET stripe_customer_id = 'cus_fullstack_test', stripe_customer_livemode = false WHERE id = $1`, [userId]);
  await stack.query(`INSERT INTO card_verifications (user_id, status, livemode) VALUES ($1, 'verified', false)`, [userId]);
}

/** A Professional Seller with a published storefront (slug), a confirmed pickup location and the agreement gate waived. */
async function publishedStorefront(stack, { email = 'shop-owner@fullstack.test', slug = 'watchdog-antiques', name = 'Watchdog Antiques' } = {}) {
  const userId = await seed.user(stack, { email, role: 'seller', fullName: 'Shea Shopkeeper' });
  const sellerProfileId = await seed.sellerProfile(stack, { userId, sellerType: 'auction_house', displayName: name, extra: {
    storefront_slug: slug, storefront_published: true, agreement_waived_at: new Date(),
    default_pickup_address_line1: '100 Main St', default_pickup_city: 'Houston', default_pickup_state: 'TX', default_pickup_postal_code: '77002',
    default_pickup_confirmed_at: new Date(),
  } });
  await seed.signedStorefrontAgreement(stack, sellerProfileId);   // storefront publishing needs the current agreement version
  await seed.publishedStorePolicies(stack, sellerProfileId, userId);   // an online purchase needs both store policies (2026-11-09)
  // Every storefront order needs an approved tax rule for its state (sales tax safeguard, 2026-11-09). This isolated test
  // environment collects no tax, so Texas gets the TEST rule "not collected at checkout" unless a test set its own.
  await stack.query(`INSERT INTO marketplace_tax_jurisdictions (state, remitter, legal_basis, effective_from)
    VALUES ('TX', 'seller_direct', 'TEST ONLY: isolated test environment', DATE '2020-01-01') ON CONFLICT (state) DO NOTHING`);
  return { userId, sellerProfileId, slug, email };
}

/** A published (active) fixed-price item in that storefront. */
async function publishedItem(stack, { sellerProfileId, title = 'Brass Ship Lantern', priceCents = 12500, inventoryNumber = 'WD-1001' }) {
  return (await stack.query(
    `INSERT INTO marketplace_items (seller_id, title, description, category, condition, price_cents, status, city, state, zip, pickup_location_source, inventory_number)
     VALUES ($1, $2, 'A heavy brass lantern with its original glass.', 'Antiques', 'Light wear', $3, 'active', 'Houston', 'TX', '77002', 'default', $4) RETURNING id`,
    [sellerProfileId, title, priceCents, inventoryNumber])).rows[0].id;
}

module.exports = { liveAuctionWithLot, buyerReadyToBid, publishedStorefront, publishedItem };
