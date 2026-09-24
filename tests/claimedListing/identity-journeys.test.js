'use strict';

/**
 * Claimed Listing — company identity and the one-journey rule (migration 169).
 *
 * The properties that matter: a directory listing and a sales prospect for the same business are ONE
 * company; free mailboxes, hosting platforms, franchise brands and call centres never make two
 * businesses one; a weak name resemblance is never merged; a directory-listed company is never cold-
 * invited into Event Partner; and two active journeys for one company are impossible.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

jest.mock('../../src/db', () => ({ query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
const identity = require('../../src/services/acquisition/companyIdentityService');
const seg = require('../../src/services/eventPartners/relationshipSegmentationService');

let seq = 0;
function org(o) {
  seq += 1;
  const row = Object.assign({ id: 'org-' + seq, name: 'Org ' + seq, source: 'bd_import', bd_listing_id: String(1000 + seq), has_owner: false }, o);
  return { key: 'organization:' + row.id, entity_type: 'organization', entity_id: row.id, label: row.name, row,
    signals: identity.signalsOf({ name: row.name, website: row.website_url, email: row.contact_email, phone: row.contact_phone,
      googlePlaceId: row.google_place_id, bdListingId: row.bd_listing_id }) };
}
function prospect(p) {
  seq += 1;
  const row = Object.assign({ id: 'p-' + seq, company_name: 'Prospect ' + seq }, p);
  return { key: 'sales_prospect:' + row.id, entity_type: 'sales_prospect', entity_id: row.id, label: row.company_name, row,
    signals: identity.signalsOf({ name: row.company_name, website: row.website, email: row.business_email, phone: row.business_phone }) };
}
function ep(a) {
  seq += 1;
  const row = Object.assign({ id: 'ep-' + seq, status: 'invited' }, a);
  return { key: 'authorized_event_source:' + row.id, entity_type: 'authorized_event_source', entity_id: row.id, label: row.company_name, row,
    linkedOrganizationId: row.organization_id || null,
    signals: identity.signalsOf({ name: row.company_name, website: row.authorized_domain, email: row.invited_email }) };
}
const clusterOf = (built, e) => built.clusters.find((c) => c.members.some((m) => m.key === e.key));

describe('identity signals', () => {
  test('free mailboxes, hosting platforms and provider mailboxes are never company identity', () => {
    for (const d of ['gmail.com', 'facebook.com', 'fb.com', 'hibid.com', 'estatesales.net', 'wixsite.com', 'swbell.net', 'example.com']) {
      expect(identity.isIdentityDomain(d)).toBe(false);
    }
    expect(identity.isIdentityDomain('smithestates.com')).toBe(true);
  });
  test('a generic industry name is not an exact-name identity', () => {
    const s = identity.signalsOf({ name: 'Estate Sales LLC' });
    expect(identity.strongKeys(s).find(([m]) => m === 'exact_name')).toBeUndefined();
  });
});

describe('clustering', () => {
  test('a BD shell with website x.com and a prospect emailing info@x.com resolve to ONE company', () => {
    const shell = org({ name: 'Smith Estate Services', website_url: 'https://www.smithestates.com' });
    const p = prospect({ company_name: 'Smith Estates', business_email: 'info@smithestates.com' });
    const built = identity.buildClusters([shell, p]);
    expect(clusterOf(built, shell)).toBe(clusterOf(built, p));
    expect(identity.deriveJourney(clusterOf(built, p).members).journey).toBe('CLAIMED_LISTING');
  });

  test('two directory listings with different names that share only an address are NOT merged (refused, reported)', () => {
    const a = org({ name: 'Proxibid', contact_email: 'info@schultzauctioneers.com' });
    const b = org({ name: 'Schultz Auctioneers', website_url: 'https://schultzauctioneers.com' });
    const built = identity.buildClusters([a, b]);
    expect(clusterOf(built, a)).not.toBe(clusterOf(built, b));
    expect(built.conflicts.length).toBeGreaterThan(0);
  });

  test('a franchise domain shared by many differently named locations links none of them', () => {
    const names = ['Caring Transitions of Monmouth', 'Caring Transitions of Naples', 'Caring Transitions of Waipahu', 'Caring Transitions Desert Cities'];
    const locs = names.map((n) => org({ name: n, contact_email: 'franchise@caringtransitions.com' }));
    const built = identity.buildClusters(locs);
    expect(new Set(locs.map((l) => clusterOf(built, l))).size).toBe(4);
    expect(built.sharedIdentifiers.map((s) => s.key)).toContain('dom:caringtransitions.com');
  });

  test('a weak name resemblance is reported for review and NEVER merged', () => {
    const a = org({ name: 'Yellow Bird Estate Sales' });
    const b = prospect({ company_name: 'Yellow Bird Estate Sale' });
    const c = prospect({ company_name: 'Bayside Tag Sales' });
    const built = identity.buildClusters([a, b, c]);
    expect(clusterOf(built, a)).not.toBe(clusterOf(built, b));
    expect(built.ambiguous.some((x) => [x.a, x.b].includes(b.key))).toBe(true);
  });

  test('persisted companies are never merged automatically', () => {
    const a = org({ name: 'Alpha Estates', contact_phone: '713-555-0100' });
    const b = org({ name: 'Beta Estates', contact_phone: '713-555-0100', bd_listing_id: null, source: 'onboarding' });
    const built = identity.buildClusters([a, b], new Map([[a.key, 'co-1'], [b.key, 'co-2']]));
    expect(clusterOf(built, a)).not.toBe(clusterOf(built, b));
    expect(built.conflicts.some((c) => /different companies/.test(c.reason))).toBe(true);
  });
});

describe('journeys', () => {
  test('directory listing → CLAIMED_LISTING; EP invited → EVENT_PARTNER; professional seller → none', () => {
    const shell = org({ name: 'Delta Estate Co' });
    expect(identity.deriveJourney([shell]).journey).toBe('CLAIMED_LISTING');
    const inv = ep({ company_name: 'Delta Estate Co', organization_id: shell.entity_id, status: 'invited' });
    expect(identity.deriveJourney([shell, inv]).journey).toBe('EVENT_PARTNER');
    const pro = { entity_type: 'seller_profile', entity_id: 'sp1', row: {}, signals: {} };
    expect(identity.deriveJourney([shell, pro]).journey).toBeNull();
  });

  test('two active journeys for one company are impossible (partial unique index)', () => {
    const m = read('db/migrations/169_company_identity_and_journeys.sql');
    expect(m).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_journey ON acquisition_journey_assignments \(company_id\) WHERE status = 'active'/);
  });

  test('moving a journey is audited, needs a written reason, and stops any live listing sequence', () => {
    const src = read('src/services/acquisition/journeyService.js');
    expect(src).toMatch(/A written reason is required/);
    expect(src).toMatch(/'acquisition\.journey_changed'/);
    expect(src).toMatch(/stop_reason = 'journey_change'/);
    const route = read('src/routes/adminClaimedListings.js');
    expect(route).toMatch(/router\.post\('\/company\/:orgId\/journey', idParam\('orgId'\), journeyPerm/);
  });
});

describe('Event Partner never cold-invites a directory-listed company', () => {
  function snapWith(entities) {
    const built = identity.buildClusters(entities);
    for (const c of built.clusters) { c.journey = identity.deriveJourney(c.members).journey; c.journey_source = 'derived'; }
    const by = new Map(); for (const c of built.clusters) for (const m of c.members) by.set(m.key, c);
    return {
      entities, clusters: built.clusters,
      clusterFor: (t, id) => by.get(t + ':' + id) || null,
      ambiguousFor: () => [],
      matchSignals(signals) {
        const hits = entities.filter((e) => { const r = identity.compare(signals, e.signals); return r && r.method; });
        return { clusters: [...new Set(hits.map((h) => by.get(h.key)))], hits };
      },
    };
  }
  const runner = { query: async (sql) => (/event_partner_suppressions|email_suppressions|event_partner_cohort_members/.test(sql) ? { rows: [] } : { rows: [] }) };

  test('a prospect that resolves to a directory listing gets EXCLUDE_LISTING_JOURNEY', async () => {
    const shell = org({ name: 'Harbor Estate Sales', website_url: 'https://harborestates.com' });
    const p = prospect({ company_name: 'Harbor Estate Sales Inc', business_email: 'hello@harborestates.com', website: 'harborestates.com' });
    const d = await seg.resolve(Object.assign({ id: p.entity_id }, p.row), { companies: snapWith([shell, p]), claimed: [], partners: [], pros: [] }, runner);
    expect(d.decision).toBe('EXCLUDE_LISTING_JOURNEY');
  });

  test('a company already in Event Partner is not re-labelled as a listing', async () => {
    const shell = org({ name: 'Crest Auctions', website_url: 'https://crestauctions.com' });
    const inv = ep({ company_name: 'Crest Auctions', organization_id: shell.entity_id, authorized_domain: 'crestauctions.com', status: 'authorized' });
    const p = prospect({ company_name: 'Crest Auctions', business_email: 'office@crestauctions.com', website: 'crestauctions.com' });
    const d = await seg.resolve(Object.assign({ id: p.entity_id }, p.row), { companies: snapWith([shell, inv, p]), claimed: [], partners: [], pros: [] }, runner);
    expect(d.decision).not.toBe('EXCLUDE_LISTING_JOURNEY');
  });

  test('if the company map cannot be built, the prospect is held (fail closed)', async () => {
    const broken = { clusterFor() { throw new Error('boom'); }, matchSignals() { throw new Error('boom'); }, ambiguousFor: () => [] };
    const p = prospect({ company_name: 'Quill Estates', business_email: 'a@quillestates.com', website: 'quillestates.com' });
    const d = await seg.resolve(Object.assign({ id: p.entity_id }, p.row), { companies: broken, claimed: [], partners: [], pros: [] }, runner);
    expect(d.decision).toBe('REVIEW_OTHER_RELATIONSHIP');
  });

  test('the EP send path refuses to attach an invitation to a listing organization', async () => {
    const out = require('../../src/services/eventPartners/outreachSendService');
    const fake = { query: async (sql) => {
      if (/FROM organizations\s+WHERE lower\(regexp_replace/.test(sql)) return { rows: [{ id: 'o-listing', name: 'Harbor Estate Sales', bd_listing_id: '77', source: 'bd_import' }] };
      return { rows: [] };
    } };
    const r = await out.ensureOrganizationForProspect({ company_name: 'Harbor Estate Sales', website: 'harborestates.com' }, fake);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('LISTING_JOURNEY');
  });

  test('the new decision is part of the persisted vocabulary', () => {
    expect(seg.DECISIONS.LISTING_JOURNEY).toBe('EXCLUDE_LISTING_JOURNEY');
    expect(read('db/migrations/169_company_identity_and_journeys.sql')).toMatch(/'REVIEW_OTHER_RELATIONSHIP','EXCLUDE_LISTING_JOURNEY'\)\)/);
  });
});

describe('the backfill is a dry run unless explicitly confirmed', () => {
  test('the script refuses --apply without the confirmation phrase', () => {
    const s = read('scripts/company-identity-backfill.js');
    expect(s).toMatch(/--apply requires --confirm=LINK-COMPANIES/);
    expect(s).toMatch(/identity\.backfill\(\{ apply, runner: db \}\)/);
  });
  test('the dry run writes nothing', async () => {
    const writes = [];
    const fake = { query: async (sql) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql); return { rows: [] }; }, connect: async () => { throw new Error('no connect in dry run'); } };
    const r = await identity.backfill({ apply: false, runner: fake });
    expect(r.dry_run).toBe(true);
    expect(writes).toEqual([]);
    expect(r.written).toEqual({ companies: 0, links: 0, journeys: 0, reviews: 0 });
  });
});
