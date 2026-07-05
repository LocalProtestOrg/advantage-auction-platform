'use strict';

/**
 * Milestone 1 (Phase 1 — Platform Foundation) — Tenant Foundation Tier-1 integration tests.
 *
 * Runs ONLY against an isolated Neon scratch branch with migrations 076 + 077 applied.
 * Skips cleanly (so `npm test`/CI stay green) unless TENANT_SCRATCH=1 and a non-prod
 * DATABASE_URL are set; a production-looking DATABASE_URL also forces a skip.
 */

const SCRATCH_OK = !!process.env.TENANT_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[tenant-foundation] SKIPPED — scratch env not configured '
    + '(requires TENANT_SCRATCH=1 and an isolated non-prod DATABASE_URL).');
}
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const tenant = require('../../src/lib/tenantContext');

let platform;
beforeAll(async () => {
  if (!SCRATCH_OK) return;
  const reg = await db.query("SELECT to_regclass('public.organization_capabilities') AS t");
  expect(reg.rows[0].t).toBeTruthy(); // aborts unless 077 is applied (scratch, not prod)
  tenant._reset();
  platform = await tenant.getPlatformTenant();
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('1. Migration 077 schema + seeds', () => {
  test('capability catalog seeded (12)', async () => {
    expect((await db.query('SELECT count(*)::int c FROM capabilities')).rows[0].c).toBe(12);
  });
  test('tenant columns exist on organizations / seller_profiles / auctions', async () => {
    const cols = await db.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name='organizations'   AND column_name IN ('is_platform_tenant','primary_domain','custom_domains'))
         OR (table_name='seller_profiles' AND column_name='organization_id')
         OR (table_name='auctions'        AND column_name='organization_id')`);
    const set = new Set(cols.rows.map((r) => r.table_name + '.' + r.column_name));
    ['organizations.is_platform_tenant', 'organizations.primary_domain', 'organizations.custom_domains',
      'seller_profiles.organization_id', 'auctions.organization_id'].forEach((c) => expect(set.has(c)).toBe(true));
  });
});

suite('2. Advantage = Organization / Partner #1', () => {
  test('exactly one platform tenant, named Advantage Auction Company', async () => {
    const { rows } = await db.query('SELECT slug, name FROM organizations WHERE is_platform_tenant = true');
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('advantage-auction-company');
    expect(rows[0].name).toBe('Advantage Auction Company');
  });
  test('platform tenant granted ALL 12 capabilities', async () => {
    const caps = await tenant.getCapabilities(platform.id);
    expect(caps.size).toBe(12);
    expect(caps.has('auctions')).toBe(true);
    expect(caps.has('white_label')).toBe(true);
  });
});

suite('3. Backfill — all sellers + auctions belong to Advantage', () => {
  test('no seller_profiles left untenanted', async () => {
    expect((await db.query('SELECT count(*)::int c FROM seller_profiles WHERE organization_id IS NULL')).rows[0].c).toBe(0);
  });
  test('no auctions left untenanted', async () => {
    expect((await db.query('SELECT count(*)::int c FROM auctions WHERE organization_id IS NULL')).rows[0].c).toBe(0);
  });
  test('auctions all tenant to the platform tenant', async () => {
    expect((await db.query('SELECT count(*)::int c FROM auctions WHERE organization_id <> $1', [platform.id])).rows[0].c).toBe(0);
  });
});

suite('4. tenantContext + capability resolution', () => {
  test('getPlatformTenant returns the platform tenant', () => {
    expect(platform.is_platform_tenant).toBe(true);
  });
  test('hasCapability: true for granted, false for unknown', async () => {
    expect(await tenant.hasCapability(platform.id, 'auctions')).toBe(true);
    expect(await tenant.hasCapability(platform.id, 'nonexistent_cap')).toBe(false);
  });
});
