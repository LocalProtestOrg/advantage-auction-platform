'use strict';

/**
 * Phase 2 — Partner Foundation Tier-1 integration tests.
 * Runs ONLY against an isolated Neon scratch branch with 076+077+078 applied. Skips
 * cleanly unless PARTNER_SCRATCH=1 and a non-prod DATABASE_URL are set.
 */

const SCRATCH_OK = !!process.env.PARTNER_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[partner-foundation] SKIPPED — scratch env not configured (PARTNER_SCRATCH=1 + non-prod DATABASE_URL).');
}
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const capabilityService = require('../../src/services/capabilityService');
const configService = require('../../src/services/configService');
const legalService = require('../../src/services/legalService');
const marketplaceService = require('../../src/services/marketplaceService');
const orgsService = require('../../src/services/organizationsService');

let USERS = [], ADMIN, AUCTION;
beforeAll(async () => {
  if (!SCRATCH_OK) return;
  expect((await db.query("SELECT to_regclass('public.plan_capabilities') AS t")).rows[0].t).toBeTruthy();
  USERS = (await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 10')).rows.map((r) => r.id);
  expect(USERS.length).toBeGreaterThanOrEqual(6);
  ADMIN = USERS[0];
  const a = await db.query('SELECT id FROM auctions LIMIT 1');
  AUCTION = a.rows[0] ? a.rows[0].id : null;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('A. Capability enforcement', () => {
  test('plan_capabilities seeded (free 3 / standard 5 / premium 9)', async () => {
    const g = async (t) => (await db.query('SELECT count(*)::int c FROM plan_capabilities WHERE plan_tier=$1', [t])).rows[0].c;
    expect([await g('free'), await g('standard'), await g('premium')]).toEqual([3, 5, 9]);
  });
  test('onboarding grants the plan capabilities', async () => {
    const org = await orgsService.onboardOrganization(USERS[1], { name: 'Cap Test Co', contactEmail: 'c@x.com' });
    const caps = await capabilityService.getEffectiveCapabilities(org.id);
    expect(caps.has('events')).toBe(true);
    expect(caps.has('organizations')).toBe(true);
    expect(caps.has('widgets')).toBe(true);
    expect(caps.has('api')).toBe(false); // not in free plan
  });
  test('admin override grants a capability beyond plan', async () => {
    const org = await orgsService.onboardOrganization(USERS[2], { name: 'Override Co', contactEmail: 'o@x.com' });
    expect(await capabilityService.hasCapability(org.id, 'api')).toBe(false);
    await capabilityService.setCapability(org.id, 'api', true, 'override');
    expect(await capabilityService.hasCapability(org.id, 'api')).toBe(true);
  });
});

suite('B. Organization configuration', () => {
  test('platform default, org override, and inheritance', async () => {
    expect(await configService.get(null, 'branding.primary_color')).toBe('#B5273B');
    const org = await orgsService.onboardOrganization(USERS[3], { name: 'Config Co', contactEmail: 'cfg@x.com' });
    await configService.setOrgConfig(org.id, 'branding.primary_color', '#123456', USERS[3]);
    expect(await configService.get(org.id, 'branding.primary_color')).toBe('#123456'); // override
    expect(await configService.get(org.id, 'branding.font')).toBe('Fraunces');          // inherited default
    expect((await configService.getAll(org.id, 'branding'))['branding.primary_color']).toBe('#123456');
  });
});

suite('C. Legal document framework', () => {
  test('version → publish (unpublishes siblings) → fallback → acceptance ledger', async () => {
    const doc = await legalService.upsertDocument(null, 'buyer_terms', 'Platform Buyer Terms');
    const v1 = await legalService.addVersion(doc.id, 'v1 content');
    const v2 = await legalService.addVersion(doc.id, 'v2 content');
    await legalService.publishVersion(v1.id);
    expect((await legalService.getPublished(null, 'buyer_terms')).version).toBe(1);
    await legalService.publishVersion(v2.id);
    const pub = await legalService.getPublished(null, 'buyer_terms');
    expect(pub.version).toBe(2);
    // org without its own doc falls back to the platform default
    const org = await orgsService.onboardOrganization(USERS[4], { name: 'Legal Co', contactEmail: 'l@x.com' });
    expect((await legalService.getPublished(org.id, 'buyer_terms')).version).toBe(2);
    // acceptance ledger (idempotent)
    const acc = await legalService.accept(USERS[5], pub.id, org.id, '1.2.3.4');
    expect(acc.id || acc.already_accepted).toBeTruthy();
    expect((await legalService.accept(USERS[5], pub.id, org.id, '1.2.3.4')).already_accepted).toBe(true);
  });
});

suite('D. Marketplace syndication', () => {
  test('all auctions default to syndicated', async () => {
    expect((await db.query('SELECT count(*)::int c FROM auctions WHERE marketplace_status IS NULL OR is_syndicated IS NULL')).rows[0].c).toBe(0);
  });
  test('admin hide/restore + feature toggle, all audited', async () => {
    if (!AUCTION) { console.warn('no auction in scratch — skipping visibility asserts'); return; }
    let r = await marketplaceService.setVisibility(ADMIN, AUCTION, 'hide', 'test');
    expect(r.marketplace_status).toBe('hidden'); expect(r.is_syndicated).toBe(false);
    r = await marketplaceService.setVisibility(ADMIN, AUCTION, 'restore');
    expect(r.marketplace_status).toBe('syndicated'); expect(r.is_syndicated).toBe(true);
    r = await marketplaceService.setFlag(ADMIN, AUCTION, 'feature', true);
    expect(r.is_featured).toBe(true);
    const audits = (await db.query(
      "SELECT count(*)::int c FROM audit_log WHERE entity_type='auction' AND entity_id=$1 AND event_type LIKE 'marketplace.%'", [AUCTION])).rows[0].c;
    expect(audits).toBeGreaterThanOrEqual(3);
  });
});
