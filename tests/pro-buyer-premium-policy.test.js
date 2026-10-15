'use strict';

/**
 * Professional Seller buyer's premium (owner policy approved 2026-10-15):
 *   - Professional Sellers choose it explicitly: any whole percentage 0%–100% (no platform-wide 25% ceiling);
 *   - no silent 18% default: a Professional auction is not published (or submitted) without a chosen premium
 *     (on the auction, or the seller's own default terms);
 *   - the premium is fixed once an auction is published (preserved on every published auction);
 *   - Individual Sellers unchanged (fixed 18%); historical / legacy resolution unchanged.
 */
jest.mock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
const db = require('../src/db');
const fs = require('fs');
const auctionService = require('../src/services/auctionService');
const billing = require('../src/services/billingTermsService');
beforeEach(() => jest.clearAllMocks());

describe('the 0%–100% whole-percentage rule', () => {
  test('accepted: 0%, 18%, 30%, 100%', () => {
    for (const bp of [0, 1800, 3000, 10000, '2500']) expect(() => auctionService.assertProfessionalPremiumBps(bp)).not.toThrow();
  });
  test('refused: above 100%, negative, fractional percentages, non-numbers', () => {
    // null never reaches it: callers treat null as "not provided".
    for (const bp of [10100, -100, 1750, 1801, 'abc', undefined, 12.5]) {
      expect(() => auctionService.assertProfessionalPremiumBps(bp)).toThrow(/whole percentage from 0% to 100%/);
    }
  });
  test('the Professional self-service and admin paths both use it (no 25% ceiling left)', () => {
    const src = fs.readFileSync('src/services/auctionService.js', 'utf8');
    expect(src).not.toMatch(/bp > 2500/);
    expect(src).not.toMatch(/between 0% and 25%/);
    expect((src.match(/assertProfessionalPremiumBps\((updates\.buyer_premium_bps|bp)\)/g) || []).length).toBe(2);
    expect(src).toMatch(/!isProfessional\(sellerType\) && bp !== 1800/);   // Individual override still refused
  });
});

describe('a Professional auction needs a chosen premium before publication', () => {
  const row = (r) => db.query.mockResolvedValueOnce({ rows: [r] });
  test('no auction rate and no seller default → BUYER_PREMIUM_REQUIRED (422)', async () => {
    row({ seller_type: 'auction_house', buyer_premium_bps: null, seller_pct: null });
    await expect(auctionService.assertProfessionalPremiumChosen('a1')).rejects.toMatchObject({ code: 'BUYER_PREMIUM_REQUIRED', status: 422 });
  });
  test('an auction rate (including 0%) or the seller\'s own default counts as chosen', async () => {
    for (const r of [{ buyer_premium_bps: 3000, seller_pct: null }, { buyer_premium_bps: 0, seller_pct: null }, { buyer_premium_bps: null, seller_pct: '20.00' }]) {
      row({ seller_type: 'estate_sale_company', ...r });
      await expect(auctionService.assertProfessionalPremiumChosen('a1')).resolves.toBeUndefined();
    }
  });
  test('Individual Seller auctions are unaffected (fixed 18%)', async () => {
    row({ seller_type: 'private', buyer_premium_bps: null, seller_pct: null });
    await expect(auctionService.assertProfessionalPremiumChosen('a1')).resolves.toBeUndefined();
  });
  test('publishAuction checks it before the auction changes state or its pricing is frozen; submission checks it first', () => {
    const src = fs.readFileSync('src/services/auctionService.js', 'utf8');
    const pub = src.slice(src.indexOf('async function publishAuction('), src.indexOf('PRICING SNAPSHOT'));
    expect(pub.indexOf('await assertProfessionalPremiumChosen(auctionId, client);')).toBeGreaterThan(-1);
    expect(pub.indexOf('await assertProfessionalPremiumChosen(auctionId, client);')).toBeLessThan(pub.indexOf("SET state = 'published'"));
    const sub = src.slice(src.indexOf('async function sellerSubmitAuction('), src.indexOf('async function sellerSubmitAuction(') + 900);
    expect(sub.indexOf('await assertProfessionalPremiumChosen(auctionId);')).toBeLessThan(sub.indexOf('publishAuction(auctionId, userId)'));
  });
  test('publishAuction refuses a Professional auction with no chosen premium and rolls back (nothing published)', async () => {
    const calls = [];
    const client = { release: jest.fn(), query: jest.fn(async (sql) => {
      calls.push(String(sql));
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: 'a1', state: 'draft', seller_id: 'sp1', start_time: new Date(), street_address: '1 Main', city: 'Houston', address_state: 'TX', zip: '77001' }] };
      if (/count\(\*\)::int AS c FROM lots/.test(sql)) return { rows: [{ c: 40 }] };
      if (/AS seller_pct/.test(sql)) return { rows: [{ seller_type: 'auction_house', buyer_premium_bps: null, seller_pct: null }] };
      return { rows: [] };
    }) };
    db.connect.mockResolvedValue(client);
    jest.spyOn(require('../src/services/auctionPartnerAgreementService'), 'publishGuard').mockResolvedValue(null);
    await expect(auctionService.publishAuction('a1', 'admin-1', { actorRole: 'admin' })).rejects.toMatchObject({ code: 'BUYER_PREMIUM_REQUIRED' });
    expect(calls.some((s) => /SET state = 'published'/.test(s))).toBe(false);
    expect(calls).toContain('ROLLBACK');
  });
});

describe('preserved on published auctions and history', () => {
  test('the premium cannot change once published (anyone, admin included); bidding fields stay locked while active', () => {
    const src = fs.readFileSync('src/services/auctionService.js', 'utf8');
    expect(src).toMatch(/if \(\['published', 'closed'\]\.includes\(curState\) && updates\.buyer_premium_bps !== undefined\) \{\s*const e = new Error\("The buyer's premium is fixed once an auction is published\."\);\s*e\.code = 'BUYER_PREMIUM_LOCKED'/);
    expect(src).toMatch(/const ACTIVE_LOCKED = \['increment_ladder', 'bid_increment_cents', 'buyer_premium_bps'/);
  });
  test('the frozen snapshot and legacy resolution are unchanged (historical invoices and settlements keep their numbers)', () => {
    expect(billing.effectiveBuyerPremiumBps('auction_house', {})).toBe(1800);                 // legacy unfrozen Pro auctions (2 demo, archived) unchanged
    expect(billing.effectiveBuyerPremiumBps('auction_house', { auctionBps: 3000 })).toBe(3000);
    expect(billing.effectiveBuyerPremiumBps('private', { auctionBps: 3000 })).toBe(1800);      // Individual fixed
    expect(billing.lotBuyerPremiumCents(10000, 3000)).toBe(3000);
  });
});

describe('seller default terms', () => {
  test('a default premium must be a whole percentage 0–100 (or unset); nothing is written when refused', async () => {
    const svc = require('../src/services/sellerTermsService');
    for (const bad of [101, -1, 17.5, 'x']) {
      const client = { release: jest.fn(), query: jest.fn(async (sql) => (/FOR UPDATE/.test(sql) ? { rows: [] } : { rows: [] })) };
      db.connect.mockResolvedValueOnce(client);
      await expect(svc.setTerms('sp1', { buyer_premium_pct: bad }, 'admin-1')).rejects.toMatchObject({ code: 'INVALID_BUYER_PREMIUM' });
      expect(client.query.mock.calls.some(([s]) => /INSERT INTO seller_terms/.test(s))).toBe(false);
    }
  });
});

test('the seller form allows 0–100 in whole numbers, marks it required, and no longer suggests 18%', () => {
  const html = fs.readFileSync('public/seller-create.html', 'utf8');
  expect(html).toMatch(/<input type="number" id="buyer-premium-pct" min="0" max="100" step="1" inputmode="numeric" \/>/);
  expect(html).not.toMatch(/id="buyer-premium-pct"[^>]*placeholder="18"/);
  expect(html).toMatch(/cannot change after publication/);
});
