'use strict';

/**
 * Claimed Listing eligibility (first hit wins) and deterministic scoring.
 * Every rule, its order, cross-programme exclusions (Event Partner, 1:1 rep email, Professional Seller),
 * duplicate-contact protection and fail-closed behaviour.
 */

jest.mock('../../src/db', () => ({ query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
const identity = require('../../src/services/acquisition/companyIdentityService');
const elig = require('../../src/services/claimedListings/eligibilityService');
const scoring = require('../../src/services/claimedListings/scoringService');
const listingContext = require('../../src/services/claimedListings/listingContext');
const D = elig.DECISIONS;

let n = 0;
function listing(o = {}) {
  n += 1;
  const row = Object.assign({ id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), name: 'Listing ' + n + ' Estates', source: 'bd_import',
    bd_listing_id: String(500 + n), contact_email: 'owner' + n + '@listing' + n + '.com', website_url: 'https://listing' + n + '.com',
    state: 'TX', city: 'Houston', lat: 29.76, lng: -95.37, has_owner: false, bd_sync_status: 'active', profile_data: {}, bd_metadata: { profession_id: '4' } }, o);
  return { key: 'organization:' + row.id, entity_type: 'organization', entity_id: row.id, label: row.name, row,
    signals: identity.signalsOf({ name: row.name, website: row.website_url, email: row.contact_email, phone: row.contact_phone, bdListingId: row.bd_listing_id }) };
}
function member(type, row) {
  n += 1;
  const id = row.id || type + '-' + n;
  return { key: type + ':' + id, entity_type: type, entity_id: id, label: row.company_name || row.name || id, row: Object.assign({ id }, row),
    signals: identity.signalsOf({ name: row.company_name || row.name, website: row.website, email: row.business_email || row.email, phone: row.business_phone }) };
}

/** A listing context built from explicit facts (what listingContext.load assembles from the database). */
function ctxFor(entities, extra = {}) {
  const built = identity.buildClusters(entities);
  for (const c of built.clusters) { c.journey = extra.journeyOverride || identity.deriveJourney(c.members).journey; c.companyId = extra.companyId || null; }
  const by = new Map(); for (const c of built.clusters) for (const m of c.members) by.set(m.key, c);
  const listings = entities.filter((e) => e.entity_type === 'organization' && listingContext.isListingOrg(e.row));
  const byEmail = new Map();
  for (const e of listings) { const k = String(e.row.contact_email || '').toLowerCase(); if (!k) continue; if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(e); }
  const primaryFor = new Map();
  for (const [k, list] of byEmail) {
    const sorted = list.slice().sort((a, b) => Number(a.row.bd_listing_id) - Number(b.row.bd_listing_id));
    primaryFor.set(k, { primary: sorted[0].entity_id, count: list.length, distinct_names: new Set(list.map((x) => x.signals.normalized_name)).size });
  }
  return Object.assign({
    snap: { entities, clusters: built.clusters, clusterFor: (t, id) => by.get(t + ':' + id) || null,
      ambiguousFor: (t, id) => built.ambiguous.filter((a) => a.a === t + ':' + id || a.b === t + ':' + id) },
    config: { recentDays: 90, salesCooldownDays: 30, excludedBdIds: new Set(extra.excluded || []), excludedCompanyIds: new Set(), paidBadgeBdIds: new Set(extra.paid || []), weights: {} },
    listings, supp: new Map(extra.supp || []), companySupp: new Map(extra.companySupp || []), listingSends: extra.listingSends || [], epSends: extra.epSends || [],
    salesSends: extra.salesSends || [], activeSequences: new Map(), internalAccounts: new Map(extra.internal || []), locks: new Map(extra.locks || []),
    primaryFor, companyIdOf: (c) => (c && c.companyId) || null,
  }, extra.ctx || {});
}
const decide = (e, ctx) => elig.decide(e, ctx).decision;

describe('eligibility rules', () => {
  test('a clean unclaimed listing is ELIGIBLE (free mailboxes allowed: the invite goes to the published address)', () => {
    const e = listing({ contact_email: 'smithsales@gmail.com' });
    expect(decide(e, ctxFor([e]))).toBe(D.ELIGIBLE);
  });
  test('1 suppression from ANY B2B programme wins over everything', () => {
    const e = listing({ has_owner: true });
    for (const src of ['global', 'listing', 'event_partner']) {
      expect(decide(e, ctxFor([e], { supp: [[e.row.contact_email, { src, reason: 'stop_request' }]] }))).toBe(D.SUPPRESSED);
    }
  });
  test('a linked prospect marked Do Not Contact suppresses the listing', () => {
    const e = listing({ website_url: 'https://dnc-estates.com' });
    const p = member('sales_prospect', { company_name: 'DNC Estates', business_email: 'x@dnc-estates.com', contact_status: 'do_not_contact' });
    expect(decide(e, ctxFor([e, p]))).toBe(D.SUPPRESSED);
  });
  test('2 no usable address: missing, no-reply, or a social-network relay', () => {
    for (const email of [null, 'not-an-email', 'noreply@acme-estates.com', 'page.123@fb.com', 'x@facebook.com']) {
      const e = listing({ contact_email: email });
      expect(decide(e, ctxFor([e]))).toBe(D.NO_CONTACT);
    }
  });
  test('3 recent outreach is judged per COMPANY across programmes', () => {
    const e = listing({ website_url: 'https://rose-estates.com', contact_email: 'owner@rose-estates.com' });
    const p = member('sales_prospect', { company_name: 'Rose Estates', business_email: 'info@rose-estates.com' });
    expect(decide(e, ctxFor([e, p], { epSends: [{ organization_id: null, recipient_email_normalized: 'info@rose-estates.com' }] }))).toBe(D.RECENT);
    expect(decide(e, ctxFor([e, p], { salesSends: [{ prospect_id: p.entity_id, recipient_email: 'info@rose-estates.com' }] }))).toBe(D.RECENT);
    expect(decide(e, ctxFor([e, p], { listingSends: [{ organization_id: e.entity_id, sequence_id: 'other' }] }))).toBe(D.RECENT);
  });
  test('4 a claimed listing moves to the activation track, never outreach', () => {
    const e = listing({ has_owner: true });
    expect(decide(e, ctxFor([e]))).toBe(D.CLAIMED);
  });
  test('5 Event Partner journey and 6 Professional Seller are excluded', () => {
    const e = listing();
    expect(decide(e, ctxFor([e], { journeyOverride: 'EVENT_PARTNER' }))).toBe(D.EVENT_PARTNER);
    const pro = listing({ linked_seller_profile_id: 'sp-1' });
    expect(decide(pro, ctxFor([pro]))).toBe(D.PRO_SELLER);
  });
  test('7 out of scope: removed from the directory, non-US, exclusion list, removal requested', () => {
    const removed = listing({ bd_sync_status: 'removed' });
    expect(decide(removed, ctxFor([removed]))).toBe(D.OUT_OF_SCOPE);
    const foreign = listing({ state: 'Ontario' });
    expect(decide(foreign, ctxFor([foreign]))).toBe(D.OUT_OF_SCOPE);
    const national = listing();
    expect(decide(national, ctxFor([national], { excluded: [national.row.bd_listing_id] }))).toBe(D.OUT_OF_SCOPE);
    const asked = listing({ profile_data: { removal_requested_at: '2026-09-24' } });
    expect(decide(asked, ctxFor([asked]))).toBe(D.OUT_OF_SCOPE);
  });
  test('truncated or spelled-out US states are still US', () => {
    for (const s of ['TX', 'Texas', 'TEXAS', 'LOUISIAN', 'new york']) expect(listingContext.usStateCode(s)).toBeTruthy();
    expect(listingContext.usStateCode('Ontario')).toBeNull();
  });
  test('9 someone is already working the company: a rep, a staff account, or a person holding the lock', () => {
    const e = listing({ website_url: 'https://worked-estates.com' });
    const p = member('sales_prospect', { company_name: 'Worked Estates', website: 'worked-estates.com', assigned_rep_user_id: 'rep1', contact_status: 'interested' });
    expect(decide(e, ctxFor([e, p]))).toBe(D.OTHER);
    const s = listing();
    expect(decide(s, ctxFor([s], { internal: [[s.row.contact_email, { role: 'admin' }]] }))).toBe(D.OTHER);
    const l = listing();
    expect(decide(l, ctxFor([l], { companyId: 'co-9', locks: [['co-9', { holder_type: 'user', holder_name: 'Kym' }]] }))).toBe(D.OTHER);
  });
  test('10 data quality: domain mismatch, shared address, paid badge never bought', () => {
    const mismatch = listing({ website_url: 'https://proxibid-listing.com', contact_email: 'sales@schultz-auctioneers.com' });
    expect(decide(mismatch, ctxFor([mismatch]))).toBe(D.DATA_QUALITY);
    const a = listing({ name: 'Black Rock Galleries', contact_email: 'brg@gmail.com' });
    const b = listing({ name: 'Black Rock Galleries East', contact_email: 'brg@gmail.com' });
    const ctx = ctxFor([a, b]);
    expect(decide(a, ctx)).toBe(D.ELIGIBLE);            // the primary listing only
    expect(decide(b, ctx)).toBe(D.DATA_QUALITY);
    const many = [1, 2, 3, 4].map((i) => listing({ name: 'Unrelated Shop ' + ['Alpha', 'Bravo', 'Charlie', 'Delta'][i - 1], contact_email: 'scraped@swbell.net' }));
    const cm = ctxFor(many);
    for (const m of many) expect(decide(m, cm)).toBe(D.DATA_QUALITY);   // not any one business's address
    const badge = listing();
    expect(decide(badge, ctxFor([badge], { paid: [badge.row.bd_listing_id] }))).toBe(D.DATA_QUALITY);
  });
  test('first hit wins: suppression outranks a claim, a claim outranks data quality', () => {
    const e = listing({ has_owner: true, website_url: 'https://a-one.com', contact_email: 'x@b-two.com' });
    expect(decide(e, ctxFor([e], { supp: [['x@b-two.com', { src: 'global', reason: 'complaint' }]] }))).toBe(D.SUPPRESSED);
    expect(decide(e, ctxFor([e]))).toBe(D.CLAIMED);
  });
  test('a lookup error never produces ELIGIBLE: screen throws, the send-time re-screen reports an error', async () => {
    const broken = { query: async () => { throw new Error('db down'); }, connect: async () => { throw new Error('db down'); } };
    await expect(elig.screen({ runner: broken, persist: false })).rejects.toThrow();
    const r = await elig.rescreen('00000000-0000-4000-8000-000000000001', broken);
    expect(r.decision).toBeNull();
    expect(r.error).toBe(true);
    expect(elig.SENDABLE.has(r.decision)).toBe(false);
  });
});

describe('scoring', () => {
  test('Houston or the New York area scores the strategic-market points; elsewhere scores zero', () => {
    expect(scoring.strategicMarket({ lat: 29.76, lng: -95.37 })).toBe('houston');
    expect(scoring.strategicMarket({ lat: 40.886, lng: -74.04 })).toBe('ny_tristate');
    expect(scoring.strategicMarket({ lat: 33.45, lng: -112.07 })).toBeNull();
    expect(scoring.strategicMarket({ state: 'TX', city: 'Katy' })).toBe('houston');
    expect(scoring.strategicMarket({ state: 'NY', city: 'Albany' })).toBeNull();   // no coordinates: never guessed
  });
  test('deterministic, explainable, tiered; missing data scores zero', () => {
    const e = listing({ website_url: null });
    const ctx = ctxFor([e]);
    const s1 = scoring.scoreListing(e, ctx, new Map());
    const s2 = scoring.scoreListing(e, ctx, new Map());
    expect(s1).toEqual(s2);
    expect(s1.factors.strategic_market.points).toBe(25);
    expect(s1.factors.business_type.value).toBe('estate_sale_company');
    expect(s1.factors.web_presence.points).toBe(10);
    expect(s1.factors.operating.points).toBe(0);
    expect(s1.factors.reputation.points).toBe(0);
    expect(s1.score).toBe(50);
    expect(s1.tier).toBe('B');
    expect(scoring.tierFor(60)).toBe('A');
    expect(scoring.tierFor(39)).toBe('C');
  });
  test('a corporate email counts only with a real MX record', () => {
    const e = listing({ contact_email: 'owner@realco-estates.com' });
    const ctx = ctxFor([e]);
    expect(scoring.scoreListing(e, ctx, new Map([['realco-estates.com', true]])).factors.corporate_email.points).toBe(5);
    expect(scoring.scoreListing(e, ctx, new Map([['realco-estates.com', false]])).factors.corporate_email.points).toBe(0);
  });
});
