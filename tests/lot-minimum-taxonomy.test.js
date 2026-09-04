'use strict';

/**
 * 30-lot auction minimum + controlled lot taxonomy foundation.
 * Preserves centralized pricing, Pro auto-publish, compliance, marketing 3A/3B (T-48h + >50% clothing).
 */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

const cats = require('../src/constants/lotCategories');

// ── Controlled taxonomy ─────────────────────────────────────────────────────────
describe('controlled lot taxonomy', () => {
  test('Clothing/Apparel is an authoritative category; clothing key classifies as clothing', () => {
    expect(cats.VALID_KEYS.has('clothing')).toBe(true);
    expect(cats.CATEGORIES.find((c) => c.key === 'clothing').label).toMatch(/Clothing/);
    expect(cats.isClothingKey('clothing')).toBe(true);
  });
  test('clothing/apparel free-text normalizes to the clothing key', () => {
    ['clothing', 'Clothing & Apparel', 'Clothing & Accessories', 'apparel', "Men's Apparel", 'Vintage Clothes'].forEach((c) =>
      expect(cats.normalizeToCategoryKey(c)).toBe('clothing'));
  });
  test('jewelry / watches / handbags are NOT clothing', () => {
    expect(cats.normalizeToCategoryKey('Jewelry & Watches')).toBe('jewelry');
    expect(cats.normalizeToCategoryKey('watches')).toBe('jewelry');
    expect(cats.normalizeToCategoryKey('handbags')).toBe('handbags');
    expect(cats.isClothingKey('jewelry')).toBe(false);
    expect(cats.isClothingKey('handbags')).toBe(false);
  });
  test('unknown/legacy free-text yields null (preserved, not force-classified)', () => {
    expect(cats.normalizeToCategoryKey('gizmos')).toBeNull();
    expect(cats.normalizeToCategoryKey('')).toBeNull();
    expect(cats.normalizeToCategoryKey(null)).toBeNull();
  });
});

// ── 30-lot minimum enforcement (behavioral, mocked db) ──────────────────────────
describe('30-lot minimum — server-authoritative gate', () => {
  jest.resetModules();
  jest.doMock('../src/db/index', () => ({ query: jest.fn(), connect: jest.fn() }));
  jest.doMock('../src/db', () => ({ query: jest.fn(), connect: jest.fn() }));
  const db = require('../src/db/index');
  const svc = require('../src/services/auctionService');
  beforeEach(() => { db.query.mockReset(); });

  test('minimum is 30 and countValidLots excludes withdrawn', async () => {
    expect(svc.MIN_LOTS_FOR_SUBMISSION).toBe(30);
    db.query.mockResolvedValueOnce({ rows: [{ c: 17 }] });
    expect(await svc.countValidLots('a1')).toBe(17);
    expect(db.query.mock.calls[0][0]).toMatch(/state <> 'withdrawn'/);
  });
  test('seller at 29 valid lots → MINIMUM_LOTS_NOT_MET (422) with progress detail', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ c: 29 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'seller' })).rejects.toMatchObject({
      code: 'MINIMUM_LOTS_NOT_MET', status: 422, valid_lots: 29, required: 30,
    });
  });
  test('seller at 30 → passes; 31 → passes', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ c: 30 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'seller' })).resolves.toMatchObject({ overridden: false, validLots: 30 });
    db.query.mockResolvedValueOnce({ rows: [{ c: 31 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'seller' })).resolves.toMatchObject({ overridden: false });
  });
  test('normal seller CANNOT override below 30 even with a reason', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ c: 5 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'seller', overrideReason: 'please' })).rejects.toMatchObject({ code: 'MINIMUM_LOTS_NOT_MET' });
  });
  test('admin override requires a reason: reason → overrides (audited); no reason → still blocked', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ c: 5 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'admin', overrideReason: 'consignor VIP single-lot estate' }))
      .resolves.toMatchObject({ overridden: true, validLots: 5 });
    db.query.mockResolvedValueOnce({ rows: [{ c: 5 }] });
    await expect(svc.enforceMinimumLots('a1', { actorRole: 'admin' })).rejects.toMatchObject({ code: 'MINIMUM_LOTS_NOT_MET' });
  });
});

// ── Enforcement points (source) ─────────────────────────────────────────────────
describe('enforcement covers every submit/publish path', () => {
  const a = read('src', 'services', 'auctionService.js');
  test('updateAuction gates the submit/publish transition (Individual submit + PATCH state)', () => {
    expect(a).toMatch(/if \(submitOrPublish\) \{[\s\S]*enforceMinimumLots/);
  });
  test('publishAuction gates publish (admin direct-publish + Pro auto-publish) with admin override', () => {
    const pub = a.slice(a.indexOf('async function publishAuction'), a.indexOf('async function professionalAutoPublishEligibility'));
    expect(pub).toMatch(/MIN_LOTS_FOR_SUBMISSION/);
    expect(pub).toMatch(/options\.actorRole === 'admin'/);
    expect(pub).toMatch(/MINIMUM_LOTS_NOT_MET/);
  });
  test('override is explicit, reason-required, and audited (minimum_lots_overridden)', () => {
    expect(a).toMatch(/minimum_lots_overridden/);
  });
  test('admin publish route passes actorRole+overrideReason (RBAC role([admin]))', () => {
    const adm = read('src', 'routes', 'admin.js');
    expect(adm).toMatch(/actorRole: 'admin', overrideReason:/);
    expect(adm).toMatch(/publish', auth, role\(\['admin'\]\)/);
  });
  test('submit + PATCH routes map MINIMUM_LOTS_NOT_MET to 422', () => {
    const r = read('src', 'routes', 'auctions.js');
    expect(r).toMatch(/MINIMUM_LOTS_NOT_MET/);
    // submit route uses the generic status+code mapper; PATCH has an explicit branch
    expect(r).toMatch(/err\.status && err\.code|code: err\.code, message: err\.message/);
  });
});

// ── Marketing eligibility integration (controlled key + legacy fallback) ─────────
describe('marketing clothing eligibility consumes controlled category_key', () => {
  const svc = read('src', 'services', 'marketingEligibilityService.js');
  test('prefers category_key = clothing, falls back to free-text for legacy (NULL key)', () => {
    expect(svc).toMatch(/lower\(coalesce\(category_key,''\)\) = 'clothing'/);
    expect(svc).toMatch(/category_key IS NULL AND \(/);
    expect(svc).toMatch(/LIKE '%apparel%'/);
  });
  test('still uses valid-lot denominator (state <> withdrawn) and end_time cutoff', () => {
    expect(svc).toMatch(/state <> 'withdrawn'/);
    expect(svc).toMatch(/end_time/);
  });
  test('>50% rule intact (15/30 eligible, 16/30 ineligible)', () => {
    const elig = require('../src/lib/marketingEligibility');
    expect(elig.isClothingEligible(30, 15)).toBe(true);
    expect(elig.isClothingEligible(30, 16)).toBe(false);
  });
});

// ── lotService populates the controlled key; migration additive/compatible ───────
describe('lot write + migration', () => {
  test('lotService normalizes category → category_key on create + edit', () => {
    const l = read('src', 'services', 'lotService.js');
    expect(l).toMatch(/category_key/);
    expect(l).toMatch(/normalizeToCategoryKey/);
  });
  test('migration 128 adds nullable category_key (no bulk rewrite; legacy preserved)', () => {
    const mig = read('db', 'migrations', '128_lot_category_key.sql');
    expect(mig).toMatch(/ALTER TABLE lots ADD COLUMN IF NOT EXISTS category_key TEXT/);
    expect(mig).not.toMatch(/UPDATE lots SET category/i); // no bulk historical rewrite
  });
  test('seller lot editor exposes the controlled Clothing/Apparel option', () => {
    expect(read('public', 'lot-builder.html')).toMatch(/Clothing &amp; Apparel/);
  });
});

// ── Disclosure ───────────────────────────────────────────────────────────────────
describe('seller disclosure of the 30-lot minimum', () => {
  test('auction builder + catalog builder disclose the minimum', () => {
    expect(read('public', 'seller-create.html')).toMatch(/minimum of <b>30 lots<\/b>|30 lots/);
    expect(read('public', 'lot-builder.html')).toMatch(/at least <b>30 lots<\/b>|30 lots/);
  });
});
