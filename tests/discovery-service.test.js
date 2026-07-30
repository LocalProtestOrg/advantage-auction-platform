'use strict';

// Mock the DB so getFeaturedItems runs against stub inventory (never production).
jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const svc = require('../src/services/discoveryService');
const rank = require('../src/services/discoveryRankingService');
const { makeRows, AUCTIONS } = require('./fixtures/discovery-stub');

beforeEach(() => { db.query.mockReset(); svc._clearCache(); });

describe('lotDiscoveryScoreSQL', () => {
  const sql = rank.lotDiscoveryScoreSQL('l', '0');
  test('blends all approved signals, references only lot columns, jsonb-safe dimensions', () => {
    for (const frag of ['thumbnail_url', 'images_count', 'created_at', 'closes_at', 'bid_count',
      'description', 'category', 'condition', 'shippable', 'pickup_category'])
      expect(sql).toContain('l.' + frag);
    expect(sql).toContain("'{}'::jsonb");          // dimensions compared as jsonb, not text
    expect(sql).not.toMatch(/l\.dimensions <> ''/); // never a text comparison
    expect(sql).toContain('INTERVAL');              // tiered closing urgency
  });
  test('weights are centralized + configurable', () => {
    expect(rank.LOT_RANKING_WEIGHTS.image_primary).toBeGreaterThan(0);
    expect(Object.keys(rank.LOT_RANKING_WEIGHTS).length).toBeGreaterThan(8);
  });
});

describe('eligibilitySql — privacy + eligibility predicates', () => {
  const q = svc.eligibilitySql();
  test('only active + syndicated + non-archived auctions, open + future-closing + imaged lots', () => {
    expect(q).toContain("l.state = 'open'");
    expect(q).toContain('l.is_withdrawn IS NOT TRUE');
    expect(q).toContain('l.closes_at > NOW()');
    expect(q).toMatch(/l\.thumbnail_url IS NOT NULL/);
    expect(q).toContain("a.state = 'active'");
    expect(q).toContain('a.is_archived IS NOT TRUE');
    expect(q).toContain("a.marketplace_status = 'syndicated'");
  });
  test('uses branding-gated seller name; never selects lat/lng/reserve/email', () => {
    expect(q).toContain('AS seller_display_name');
    expect(q).toMatch(/auction_house|estate_sale_company/); // brandedColSql rule inlined
    expect(q).not.toMatch(/\ba\.lat\b|\ba\.lng\b|reserve_cents|\bemail\b|address_encrypted|street_address/);
  });
});

describe('rankAndDiversify — concentration, consecutiveness, dedup, exploration', () => {
  const rows = makeRows(200);
  const out = svc.rankAndDiversify(rows, { cap: 72, seed: 0 });
  test('caps at 72 and contains no duplicate ids', () => {
    expect(out.length).toBe(72);
    expect(new Set(out.map((r) => r.id)).size).toBe(72);
  });
  test('no more than 2 consecutive items from the same auction', () => {
    let run = 1, max = 1;
    for (let i = 1; i < out.length; i++) { run = out[i].auction_id === out[i - 1].auction_id ? run + 1 : 1; max = Math.max(max, run); }
    expect(max).toBeLessThanOrEqual(2);
  });
  test('no single auction exceeds 3 per 12-card page (<=25%)', () => {
    for (let p = 0; p < 6; p++) {
      const page = out.slice(p * 12, p * 12 + 12);
      const counts = {};
      page.forEach((r) => { counts[r.auction_id] = (counts[r.auction_id] || 0) + 1; });
      expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(3);
    }
  });
  test('the over-represented auction does not monopolize the first page', () => {
    const first = out.slice(0, 12).filter((r) => r.auction_id === 'auc-1').length;
    expect(first).toBeLessThanOrEqual(3);
  });
  test('multiple auctions AND multiple sellers represented on page 1', () => {
    const p1 = out.slice(0, 12);
    expect(new Set(p1.map((r) => r.auction_id)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(p1.map((r) => r.seller_id)).size).toBeGreaterThanOrEqual(4);
  });
  test('deterministic for a given seed (page-stable); seed rotates ordering', () => {
    const a = svc.rankAndDiversify(rows, { cap: 72, seed: 0 }).map((r) => r.id);
    const b = svc.rankAndDiversify(rows, { cap: 72, seed: 0 }).map((r) => r.id);
    expect(a).toEqual(b);
    const c = svc.rankAndDiversify(rows, { cap: 72, seed: 5 }).map((r) => r.id);
    expect(c).not.toEqual(a); // controlled rotation across cache windows
  });
  test('exploration surfaces items beyond the strict top-72 ranking', () => {
    const top72Ids = new Set(rows.slice(0, 72).map((r) => r.id));
    const explored = svc.rankAndDiversify(rows, { cap: 72, seed: 0 }).filter((r) => !top72Ids.has(r.id));
    expect(explored.length).toBeGreaterThan(0);
  });
});

describe('shapeItem — generic contract + privacy + branding', () => {
  const rows = makeRows(20);
  const branded = svc.shapeItem(rows.find((r) => r.seller_display_name));
  const anon = svc.shapeItem(rows.find((r) => !r.seller_display_name));
  test('generic discovery-item shape with canonical lot URL', () => {
    expect(branded.itemType).toBe('auction_lot');
    expect(branded.canonicalUrl).toMatch(/\/lot\.html\?lotId=/);
    expect(branded.pricing.mode).toBe('auction');
    expect(branded.primaryImage.alt).toBeTruthy();
  });
  test('branded (professional) seller shows name + auction title', () => {
    expect(branded.seller.brandingVisible).toBe(true);
    expect(branded.seller.displayName).toBeTruthy();
    expect(branded.auction.title).toBeTruthy();
  });
  test('anonymous (private) seller: no name, and NO auction title leak', () => {
    expect(anon.seller.brandingVisible).toBe(false);
    expect(anon.seller.displayName).toBeNull();
    expect(anon.auction.title).toBeNull();          // auction name withheld to avoid identity leak
    expect(anon.auction.canonicalUrl).toBeTruthy(); // link still fine
  });
  test('never emits lat/lng/address/reserve/email/seller_id', () => {
    const json = JSON.stringify(svc.shapeItem(rows[0]));
    expect(json).not.toMatch(/lat|lng|reserve|email|street|address_encrypted|seller_id|watch_count/i);
  });
  test('pricing: no-bid lot shows starting price + null currentBid; bid lot shows currentBid', () => {
    const noBid = svc.shapeItem(makeRows(1).map((r) => ({ ...r, bid_count: 0, current_bid_cents: null }))[0]);
    expect(noBid.pricing.currentBid).toBeNull();
    expect(noBid.pricing.startingPrice).toBeGreaterThan(0);
    expect(noBid.pricing.bidCount).toBe(0);
    const withBid = svc.shapeItem(makeRows(1).map((r) => ({ ...r, bid_count: 4, current_bid_cents: 20000 }))[0]);
    expect(withBid.pricing.currentBid).toBe(200);
  });
});

describe('computeBadges — truthful, data-driven only', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const mk = (o) => makeRows(1, now).map((r) => ({ ...r, ...o }))[0];
  test('ending_soon only within 24h; no_bids_yet only with 0 bids', () => {
    expect(svc.computeBadges(mk({ bid_count: 0 }), 2 * 3600 * 1000)).toContain('ending_soon');
    expect(svc.computeBadges(mk({ bid_count: 0 }), 5 * 24 * 3600 * 1000)).not.toContain('ending_soon');
    expect(svc.computeBadges(mk({ bid_count: 0 }), 9999999)).toContain('no_bids_yet');
    expect(svc.computeBadges(mk({ bid_count: 3 }), 9999999)).not.toContain('no_bids_yet');
  });
  test('shipping vs local pickup reflect real fields', () => {
    expect(svc.computeBadges(mk({ shippable: true, pickup_category: null }), 9e9)).toContain('shipping_available');
    expect(svc.computeBadges(mk({ shippable: false, pickup_category: 'standard' }), 9e9)).toContain('local_pickup');
  });
});

describe('getFeaturedItems — pagination over 6 pages, no cross-page duplicates', () => {
  test('72 eligible → 6 pages of 12, stable, unique across pages', async () => {
    db.query.mockResolvedValue({ rows: makeRows(72) });
    const seen = new Set();
    let totalPagesSeen = 0;
    for (let page = 1; page <= 6; page++) {
      const r = await svc.getFeaturedItems({ page, limit: 12, placement: 'event_feed_footer', sort: 'featured' });
      expect(r.data.length).toBe(12);
      expect(r.pagination.totalPages).toBe(6);
      expect(r.pagination.total).toBe(72);
      totalPagesSeen++;
      r.data.forEach((it) => { expect(seen.has(it.id)).toBe(false); seen.add(it.id); });
    }
    expect(totalPagesSeen).toBe(6);
    expect(seen.size).toBe(72);
  });
  test('placement is capped at 6 pages even if more eligible exist', async () => {
    db.query.mockResolvedValue({ rows: makeRows(200) });
    const r = await svc.getFeaturedItems({ page: 1, placement: 'standalone', sort: 'featured' });
    expect(r.pagination.totalPages).toBe(6);
    expect(r.pagination.total).toBe(72);
    const last = await svc.getFeaturedItems({ page: 6, placement: 'standalone', sort: 'featured' });
    expect(last.pagination.hasNext).toBe(false);
  });
  test('fewer than 12 eligible → one short page, no manufactured empty pages', async () => {
    db.query.mockResolvedValue({ rows: makeRows(5) });
    const r = await svc.getFeaturedItems({ page: 1, placement: 'homepage', sort: 'featured' });
    expect(r.data.length).toBe(5);
    expect(r.pagination.totalPages).toBe(1);
    expect(r.pagination.hasNext).toBe(false);
  });
  test('empty inventory → approved empty envelope (0 pages)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await svc.getFeaturedItems({ page: 1, placement: 'standalone', sort: 'featured' });
    expect(r.data).toEqual([]);
    expect(r.pagination.total).toBe(0);
    expect(r.pagination.totalPages).toBe(0);
  });
});
