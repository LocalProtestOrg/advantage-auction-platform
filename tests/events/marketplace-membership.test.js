'use strict';

/**
 * Marketplace Events — membership foundation (Increment 2) source-level guards.
 *
 * These assert the FOUR-tier membership model (Gold Retailer / Silver Retailer / Individual /
 * Appraiser) and its server-side enforcement invariants without a live DB, mirroring the
 * source-guard style of marketplace-privacy.test.js. DB-backed behavior is covered by the
 * scratch-branch integration suite. If enforcement is ever weakened (e.g. an Appraiser gains
 * listings, or NULL stops meaning "unlimited"), these fail.
 *
 * Owner decisions locked 2026-07-20 — see docs/projects/marketplace-events-implementation-plan.md §0.
 */

const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '093_marketplace_events_foundation.sql'), 'utf8');
const service = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'services', 'eventsService.js'), 'utf8');

describe('migration 093 seeds the four membership tiers', () => {
  const tiers = {
    // plan_tier: [max_event_images, max_active_events, max_listings_per_month, search_placement_tier]
    gold_retailer:   ['NULL', 'NULL', 'NULL', '1'],
    silver_retailer: ['125',  'NULL', '1',    '2'],
    individual:      ['125',  '1',    'NULL', '3'],
    appraiser:       ['0',    '0',    '0',    '3'],
  };
  for (const [tier, [img, active, monthly, place]] of Object.entries(tiers)) {
    test(`${tier} row present with correct limits`, () => {
      const re = new RegExp(
        `\\('${tier}',\\s*${img},\\s*${active},\\s*${monthly},\\s*${place},`);
      expect(migration).toMatch(re);
    });
  }

  test('Appraiser grants zero listings and zero photos (0, not NULL)', () => {
    expect(migration).toMatch(/\('appraiser',\s*0,\s*0,\s*0,/);
  });

  test('Gold is unlimited on all three quotas (NULL)', () => {
    expect(migration).toMatch(/\('gold_retailer',\s*NULL,\s*NULL,\s*NULL,/);
  });

  test('limit columns are made nullable so NULL can mean "unlimited"', () => {
    expect(migration).toMatch(/ALTER COLUMN max_event_images\s+DROP NOT NULL/);
    expect(migration).toMatch(/ALTER COLUMN max_active_events\s+DROP NOT NULL/);
  });

  test('membership perk capabilities are seeded', () => {
    for (const cap of ['weekly_email_promo', 'company_badge', 'company_profile', 'lead_generation']) {
      expect(migration).toContain(`'${cap}'`);
    }
  });

  test('event_type is constrained to the six Marketplace Event types', () => {
    for (const t of ['estate_sale', 'in_person_auction', 'tag_sale', 'moving_sale', 'business_liquidation', 'other']) {
      expect(migration).toContain(`'${t}'`);
    }
  });

  test('address-privacy + two-tier geocoding columns exist (behavior wired later)', () => {
    for (const col of ['address_privacy_mode', 'address_reveal_hours_before', 'internal_lat', 'internal_lng', 'location_fingerprint']) {
      expect(migration).toContain(col);
    }
  });
});

describe('eventsService enforces the membership rules server-side', () => {
  test('NULL means unlimited via atLimit(count, limit)', () => {
    expect(service).toMatch(/atLimit\s*=\s*\(count,\s*limit\)\s*=>\s*limit\s*!=\s*null\s*&&\s*count\s*>=\s*limit/);
  });

  test('a 0 listing cap (Appraiser) blocks event creation', () => {
    expect(service).toMatch(/planAllowsListings\s*=\s*\(plan\)\s*=>\s*plan\.max_active_events\s*!==\s*0\s*&&\s*plan\.max_listings_per_month\s*!==\s*0/);
    expect(service).toContain('PLAN_NO_EVENT_LISTINGS');
    // guarded inside createDraft, before the INSERT
    const create = service.slice(service.indexOf('async function createDraft'), service.indexOf('async function updateDraft'));
    expect(create).toContain('planAllowsListings');
    expect(create).toContain('PLAN_NO_EVENT_LISTINGS');
  });

  test('submit enforces both active-cap and monthly-cap, each NULL-aware', () => {
    const submit = service.slice(service.indexOf('async function submit'), service.indexOf('async function archiveByOwner'));
    expect(submit).toMatch(/plan\.max_active_events\s*!=\s*null/);
    expect(submit).toMatch(/plan\.max_listings_per_month\s*!=\s*null/);
    expect(submit).toContain('ACTIVE_EVENT_LIMIT');
    expect(submit).toContain('MONTHLY_LISTING_LIMIT');
  });

  test('monthly counter is scoped to the current calendar month and excludes the event itself', () => {
    expect(service).toMatch(/submitted_at\s*>=\s*date_trunc\('month',\s*now\(\)\)/);
    expect(service).toMatch(/id\s*<>\s*\$2/);
  });

  test('image cap is NULL-aware (Gold unlimited; no 10-at-a-time BD limit reproduced)', () => {
    const addImage = service.slice(service.indexOf('async function addImage'), service.indexOf('async function removeImage'));
    expect(addImage).toMatch(/atLimit\(cnt\[0\]\.c,\s*plan\.max_event_images\)/);
  });

  test('getPlanForOrg selects the new tier columns', () => {
    expect(service).toContain('max_listings_per_month');
    expect(service).toContain('search_placement_tier');
  });

  test('event_type + contact fields are in the create/update allowlist', () => {
    expect(service).toMatch(/eventType:\s*'event_type'/);
    expect(service).toMatch(/contactEmail:\s*'contact_email'/);
    expect(service).toMatch(/contactPhone:\s*'contact_phone'/);
  });
});
