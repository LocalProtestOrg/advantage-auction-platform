'use strict';

/**
 * Professional Seller Storefronts + auction→Marketplace one-button lifecycle.
 * Covers eligibility, idempotency, source-history preservation, price rule, storefront sanitization,
 * SEO/noindex, and RBAC/privacy source guards.
 */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('../src/db', () => ({ query: jest.fn() }));
let mockClient = null;
jest.mock('../src/utils/withTransaction', () => ({ withTransaction: (fn) => fn(mockClient) }));

const db = require('../src/db');
const items = require('../src/services/marketplaceItemService');
const storefront = require('../src/services/storefrontService');

const PRO = { id: 'seller-1', user_id: 'user-1', seller_type: 'estate_sale_company', is_demo: false, unsold_price_policy: 'reserve_or_start' };
const INDIV = { ...PRO, seller_type: 'private' };
const LOT = { id: 'lot-1', auction_id: 'auc-1', seller_id: 'seller-1', state: 'closed', is_withdrawn: false,
  winning_buyer_user_id: null, reserve_cents: 8000, starting_bid_cents: 5000, current_bid_cents: 0, bid_count: 0,
  title: 'Antique Lamp', description: 'Nice', category: 'Lighting', condition: 'Good', thumbnail_url: null,
  shippable: true, shipping_cost_cents: 1500, shipping_notes: null, pickup_group: 'B_group',
  city: 'Maplewood', a_state: 'OH', zip: '44060', auction_demo: false, auction_state: 'closed', lot_number_display: '12' };

function client(routes, rec) {
  return { query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, ' ').trim(); if (rec) rec.push({ sql: flat, params });
    for (const [re, res] of routes) if (re.test(flat)) return typeof res === 'function' ? res(params) : res;
    return { rows: [], rowCount: 0 };
  } };
}
const convRoutes = (over = {}) => ([
  [/FROM seller_profiles WHERE user_id/, { rows: [over.seller === null ? undefined : (over.seller || PRO)].filter(Boolean) }],
  [/SELECT \* FROM marketplace_items WHERE source_lot_id/, { rows: over.existing || [] }],
  [/FROM lots l JOIN auctions a/, { rows: over.lot === null ? [] : [over.lot || LOT] }],
  [/FROM payments WHERE lot_id/, { rows: over.paid || [] }],
  [/FROM lot_images WHERE lot_id/, { rows: over.images || [] }],
  [/INSERT INTO marketplace_items/, (p) => ({ rows: [{ id: 'item-1', source_lot_id: 'lot-1', price_cents: p[7], status: 'draft', conversion_reason: p[19] }] })],
]);
beforeEach(() => { db.query.mockReset(); mockClient = null; });

describe('auction→Marketplace conversion — eligibility', () => {
  test('non-professional seller denied', async () => {
    mockClient = client(convRoutes({ seller: INDIV }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'NOT_PROFESSIONAL' });
  });
  test('a SOLD lot (has winner) is denied', async () => {
    mockClient = client(convRoutes({ lot: { ...LOT, winning_buyer_user_id: 'buyer-9' } }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'ALREADY_SOLD' });
  });
  test('an OPEN (not closed) lot is denied', async () => {
    mockClient = client(convRoutes({ lot: { ...LOT, state: 'open' } }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'NOT_CLOSED' });
  });
  test('a lot with an active payment is denied', async () => {
    mockClient = client(convRoutes({ paid: [{ x: 1 }] }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'HAS_PAYMENT' });
  });
  test("a lot not owned by the seller is not found", async () => {
    mockClient = client(convRoutes({ lot: null }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
  });
});

describe('auction→Marketplace conversion — success + safety', () => {
  // Post to the Market (owner rule 2026-10-30): a DRAFT whose Sale Price is only what the seller sets. The reserve
  // (8000), starting bid (5000) and bids are never carried over.
  test('eligible unsold lot is posted as a draft: carries data, links source, NO auction price', async () => {
    const rec = [];
    mockClient = client(convRoutes(), rec);
    const r = await items.convertLotToListing('lot-1', 'user-1', {});
    expect(r.created).toBe(true);
    expect(r.needs_price).toBe(true);
    const ins = rec.find((c) => /INSERT INTO marketplace_items/.test(c.sql));
    expect(ins.sql).toMatch(/'draft'/);
    expect(ins.params[2]).toBe('lot-1');       // source_lot_id linkage
    expect(ins.params[7]).toBeNull();          // no Sale Price until the seller sets one
    expect(ins.params).not.toContain(8000);    // never the reserve
    expect(ins.params).not.toContain(5000);    // never the starting bid
    expect(ins.params).toContain('Antique Lamp'); // title carried
    expect(ins.params).toContain('12');           // original lot number kept as an internal reference
    expect(ins.params).toContain('lighting');     // category from the lot's own words
    // NEVER mutates the source lot/auction history
    expect(rec.some((c) => /UPDATE lots/.test(c.sql))).toBe(false);
    expect(rec.some((c) => /UPDATE auctions/.test(c.sql))).toBe(false);
  });
  test('idempotent: an already-converted lot returns the existing listing (no duplicate insert)', async () => {
    const rec = [];
    mockClient = client(convRoutes({ existing: [{ id: 'item-existing', source_lot_id: 'lot-1', seller_id: 'seller-1' }] }), rec);
    const r = await items.convertLotToListing('lot-1', 'user-1', {});
    expect(r.created).toBe(false);
    expect(r.item.id).toBe('item-existing');
    expect(rec.some((c) => /INSERT INTO marketplace_items/.test(c.sql))).toBe(false);
  });
  test('the Sale Price the seller sets is used; auction prices never are', async () => {
    const rec = [];
    mockClient = client(convRoutes(), rec);
    const r = await items.convertLotToListing('lot-1', 'user-1', { priceCents: 12500 });
    expect(r.needs_price).toBeUndefined();
    const ins = rec.find((c) => /INSERT INTO marketplace_items/.test(c.sql));
    expect(ins.params[7]).toBe(12500);
    expect(items.defaultPrice).toBeUndefined();   // the reserve-based default is gone
  });
  test('an auction that has not fully closed cannot be posted yet', async () => {
    mockClient = client(convRoutes({ lot: { ...LOT, auction_state: 'active' } }));
    await expect(items.convertLotToListing('lot-1', 'user-1', {})).rejects.toMatchObject({ code: 'AUCTION_NOT_CLOSED' });
  });
});

describe('storefront config sanitization + slug + SEO', () => {
  test('strips HTML/JS, validates socials, keeps section visibility', () => {
    const c = storefront.sanitizeConfig({ tagline: '<b>Hi</b>', about: 'A<script>x</script>B', services: ['Estate Sales', '<img>Auctions'], socials: { facebook: 'https://fb/x', evil: 'javascript:1' }, section_visibility: { team: false } });
    expect(c.tagline).toBe('Hi'); expect(c.about).not.toMatch(/<script>/);
    expect(c.services).toEqual(['Estate Sales', 'Auctions']);
    expect(c.socials).toEqual({ facebook: 'https://fb/x' });
    expect(c.section_visibility.team).toBe(false); expect(c.section_visibility.auctions).toBe(true);
  });
  test('slugify produces a clean url slug', () => {
    expect(storefront.slugify('Heritage & Home Estate Services!')).toBe('heritage-home-estate-services');
  });
  test('ssrMeta returns noindex for a demo storefront and index for a real one', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 's1', storefront_slug: 'demo-co', storefront_published: true, is_demo: true, seller_type: 'estate_sale_company', display_name: 'Demo Co', storefront: { tagline: 'x' }, metadata: {} }] });
    const m1 = await storefront.ssrMeta('demo-co');
    expect(m1.noindex).toBe(true); expect(m1.jsonld['@type']).toBe('LocalBusiness');
    db.query.mockResolvedValueOnce({ rows: [{ id: 's2', storefront_slug: 'real-co', storefront_published: true, is_demo: false, seller_type: 'auction_house', display_name: 'Real Auctions', storefront: {}, metadata: {} }] });
    const m2 = await storefront.ssrMeta('real-co');
    expect(m2.noindex).toBe(false); expect(m2.jsonld['@type']).toBe('Organization');
  });
});

describe('marketplace visibility integration', () => {
  test('active, non-demo predicate feeds the canonical Marketplace family count', () => {
    const { activeMarketplaceItemSql } = require('../src/lib/marketplaceVisibility');
    expect(activeMarketplaceItemSql('m')).toMatch(/status = 'active' AND m\.is_demo IS NOT TRUE/);
  });
});

describe('RBAC + privacy source guards', () => {
  test('seller storefront management routes require auth; public routes are read-only', () => {
    const s = read('src/routes/sellerStorefront.js');
    expect(s).toMatch(/router\.use\(auth\)/);
    // ownership from the session (seller checkpoint context), never the body
    expect(s).toMatch(/convertLotToListing\(req\.params\.lotId, req\.sellerCtx/);
    expect(s).not.toMatch(/req\.body[^;\n]*seller_?id/i);
    const pub = read('src/routes/publicStorefront.js');
    expect(pub).not.toMatch(/req\.user/); // public routes never trust/require a user
  });
  test('ownership is always derived server-side (never a client seller id)', () => {
    const svc = read('src/services/marketplaceItemService.js');
    expect(svc).toMatch(/sellerForUser\(actingUserId/);
    expect(svc).toMatch(/a\.seller_id = \$2/); // lot scoped to the resolved seller
  });
  test('no public/unauthenticated route exposes seller_inquiries contact PII to third parties', () => {
    // Public route only INSERTs inquiries + does count(*) rate-limit checks; it never SELECTs inquiry
    // PII rows back out (only the authenticated seller inbox does, in sellerStorefront.js).
    const pub = read('src/routes/publicStorefront.js');
    expect(pub).not.toMatch(/SELECT\s+(?!count\()[^;]*FROM seller_inquiries/i);
  });
  test('SSR /pro route sets noindex for draft/demo and injects JSON-LD', () => {
    const server = read('server.js');
    expect(server).toMatch(/app\.get\('\/pro\/:slug'/);
    expect(server).toMatch(/robots.*noindex/);
    expect(server).toMatch(/application\/ld\+json/);
  });
});
