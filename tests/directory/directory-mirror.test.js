'use strict';

/**
 * Phase 3B — Directory Mirror Tier-1 integration tests.
 * Scratch-only (isolated Neon branch, 077-080 applied). Uses synthetic normalized listings
 * (no live BD calls). Skips unless DIRECTORY_SCRATCH=1 and a non-prod DATABASE_URL are set.
 */

const SCRATCH_OK = !!process.env.DIRECTORY_SCRATCH && !/ep-proud-leaf/.test(process.env.DATABASE_URL || '');
if (!SCRATCH_OK) {
  // eslint-disable-next-line no-console
  console.warn('[directory-mirror] SKIPPED — scratch env not configured (DIRECTORY_SCRATCH=1 + non-prod DATABASE_URL).');
}
const suite = SCRATCH_OK ? describe : describe.skip;

const db = require('../../src/db');
const bd = require('../../src/services/bdDirectoryService');
const importer = require('../../src/services/directoryImportService');
const lifecycle = require('../../src/services/organizationLifecycleService');
const capabilityService = require('../../src/services/capabilityService');
const orgs = require('../../src/services/organizationsService');

let USER;
const L = (o) => Object.assign({ bdListingId: null, name: null, listingType: 'Company', city: null, state: null, zip: null, lat: null, lng: null, website: null, description: null, contactEmail: null, contactPhone: null, googlePlaceId: null, professionId: null, subscriptionName: null }, o);
const orgByBd = async (id) => (await db.query('SELECT * FROM organizations WHERE bd_listing_id=$1', [id])).rows[0];

beforeAll(async () => {
  if (!SCRATCH_OK) return;
  expect((await db.query("SELECT count(*)::int c FROM information_schema.columns WHERE table_name='organizations' AND column_name IN ('description','lat','lng','google_place_id','bd_metadata')")).rows[0].c).toBe(5);
  USER = (await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1')).rows[0].id;
});
afterAll(async () => { if (!SCRATCH_OK) return; await db.pool.end(); });

suite('normalize (sanitize + map, no logo)', () => {
  test('maps BD fields, strips control chars, uppercases state, omits logo', () => {
    const n = bd.normalize({ user_id: ' BDX-9 ', company: 'Beta Co', state_code: 'ny', city: 'New York', lat: '40.7', lon: '-74.0', about_me: 'a desc', goolge_place_id: 'GP-BETA', email: 'b@x.com', listing_type: 'Company', zip_code: '10001', website: 'http://b', phone_number: '555' });
    expect(n.bdListingId).toBe('BDX-9');
    expect(n.name).toBe('Beta Co');
    expect(n.state).toBe('NY');
    expect(n.lat).toBe(40.7); expect(n.lng).toBe(-74.0);
    expect(n.googlePlaceId).toBe('GP-BETA');
    expect(n.contactEmail).toBe('b@x.com');
    expect('logoUrl' in n).toBe(false); // logos deferred
  });
});

suite('import: create shell + logo deferred', () => {
  test('creates an inactive shell with mirrored fields, NO logo, 0 capabilities', async () => {
    const l = L({ bdListingId: 'BDX-1', name: 'Alpha Auctions', city: 'Houston', state: 'TX', lat: 29.76, lng: -95.36, website: 'https://alpha.example', description: 'Alpha desc', contactEmail: 'a@alpha.example', googlePlaceId: 'GP-ALPHA', professionId: '12' });
    const res = await importer.apply([l]);
    expect(res.created).toBe(1);
    const org = await orgByBd('BDX-1');
    expect(org.lifecycle_state).toBe('inactive');
    expect(org.source).toBe('bd_import');
    expect(org.google_place_id).toBe('GP-ALPHA');
    expect(Number(org.lat)).toBeCloseTo(29.76);
    expect(org.description).toBe('Alpha desc');
    expect(org.logo_url).toBeNull();            // logo deferred
    expect(org.bd_metadata.profession_id).toBe('12');
    expect((await capabilityService.getEffectiveCapabilities(org.id)).size).toBe(0);
  });
});

suite('import: idempotency + dedup', () => {
  test('re-import same bd_listing_id → update, not duplicate', async () => {
    const l = L({ bdListingId: 'BDX-1', name: 'Alpha Auctions', state: 'TX' });
    const res = await importer.apply([l]);
    expect(res.created).toBe(0); expect(res.updated).toBe(1);
    expect((await db.query("SELECT count(*)::int c FROM organizations WHERE bd_listing_id='BDX-1'")).rows[0].c).toBe(1);
  });
  test('dedup by google_place_id (different bd_listing_id, same place) → link', async () => {
    const l = L({ bdListingId: 'BDX-1-DUP', name: 'Alpha Auctions Dup', state: 'TX', googlePlaceId: 'GP-ALPHA' });
    const res = await importer.apply([l]);
    expect(res.created).toBe(0); expect(res.linked).toBe(1);
    expect(await orgByBd('BDX-1-DUP')).toBeUndefined(); // no new org created
  });
  test('dedup by match_key (single candidate) → link', async () => {
    const l = L({ bdListingId: 'BDX-2', name: 'Gamma Estate Sales', state: 'NY' });
    expect((await importer.apply([l])).created).toBe(1); // first create
    const l2 = L({ bdListingId: 'BDX-2-ALT', name: 'Gamma Estate Sales', state: 'NY' }); // same name+state, no place id
    const res = await importer.apply([l2]);
    expect(res.linked).toBe(1); expect(res.created).toBe(0);
  });
});

suite('import: claimed orgs are never overwritten', () => {
  test('after claim, re-import skips', async () => {
    const org = await orgByBd('BDX-1');
    await lifecycle.claim(USER, org.id);
    expect((await orgs.getOwner(org.id)).id).toBe(USER);
    const res = await importer.apply([L({ bdListingId: 'BDX-1', name: 'Alpha Auctions', description: 'HACKED' })]);
    expect(res.skipped).toBe(1);
    expect((await orgByBd('BDX-1')).description).not.toBe('HACKED'); // claimed org untouched
  });
});

suite('plan (dry-run) classifies without writing', () => {
  test('new vs update vs link', async () => {
    const p = await importer.plan([
      L({ bdListingId: 'BDX-NEW', name: 'Delta Liquidators', state: 'CA' }),  // new
      L({ bdListingId: 'BDX-1', name: 'Alpha Auctions' }),                     // existing (update)
    ]);
    expect(p.create).toBe(1);
    expect(p.update).toBe(1);
    expect(await orgByBd('BDX-NEW')).toBeUndefined(); // dry-run wrote nothing
  });
});
