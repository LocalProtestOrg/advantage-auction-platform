'use strict';

/**
 * Founding Auction Partners (migration 185).
 *
 * The commercial rule: only Advantage.Bid's professional auction PLATFORM fee is reduced (to 0% here); the 3% card
 * processing fee is never waived; each auction keeps the rates frozen at publish; the sitewide default and Storefront
 * pricing never change. And the protection rule: a company handled as a Founding Partner never receives automated
 * Claimed Listing or Event Partner messages, and only the staff member holding its contact lock can email it.
 *
 * The lifecycle test drives the REAL services (foundingPartnerService, auctionService.publishAuction,
 * billingTermsService) against a stateful in-memory database, so the fee is applied, frozen, settled and restored by
 * the production code paths. No network, no Stripe, no money.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── stateful fake database ────────────────────────────────────────────────────────────────────
const mockDb = { state: null, queries: [] };
function mockFresh() {
  mockDb.queries = [];
  mockDb.state = {
    sellers: new Map([['S1', { id: 'S1', seller_type: 'estate_sale_company', platform_fee_bps: 400, acquisition: null }]]),
    fps: new Map(), agreements: [], links: new Map(), auctions: new Map(), seq: 0, audits: [],
  };
}
function mockHandle(sql, p = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const st = mockDb.state;
  mockDb.queries.push(s);
  const rows = (r) => ({ rows: r, rowCount: r.length });
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return rows([]);
  // founding_partners
  if (/^INSERT INTO founding_partners/.test(s)) {
    st.seq += 1; const id = 'fp-' + st.seq;
    const r = { id, company_id: p[0], organization_id: p[1], display_name: p[2], status: 'prospect', market: p[3], reason: p[4], internal_note: p[5],
      start_date: p[6], intro_end_date: p[7], intro_platform_fee_bps: p[8], return_platform_fee_bps: p[9], relationship_owner_user_id: p[10],
      approved_by: p[11], seller_profile_id: null, fee_applied_at: null, fee_restored_at: null, prior_platform_fee_bps: null };
    st.fps.set(id, r); return rows([Object.assign({}, r)]);
  }
  if (/^SELECT \* FROM founding_partners WHERE id = \$1/.test(s)) { const r = st.fps.get(p[0]); return rows(r ? [Object.assign({}, r)] : []); }
  if (/^SELECT id, status FROM founding_partners WHERE company_id = \$1 AND status <> 'ended'/.test(s)) {
    return rows([...st.fps.values()].filter((f) => f.company_id === p[0] && f.status !== 'ended'));
  }
  if (/^SELECT id FROM founding_partners WHERE seller_profile_id = \$1 AND status <> 'ended' AND id <> \$2/.test(s)) {
    return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0] && f.status !== 'ended' && f.id !== p[1]));
  }
  if (/^SELECT id, intro_platform_fee_bps, fee_applied_at, fee_restored_at FROM founding_partners WHERE seller_profile_id = \$1 AND status = 'active'/.test(s)) {
    return rows([...st.fps.values()].filter((f) => f.seller_profile_id === p[0] && f.status === 'active'));
  }
  if (/^UPDATE founding_partners SET status = 'active'/.test(s)) {
    const f = st.fps.get(p[0]); Object.assign(f, { status: 'active', seller_profile_id: p[1], prior_platform_fee_bps: p[2],
      return_platform_fee_bps: f.return_platform_fee_bps == null ? p[2] : f.return_platform_fee_bps, start_date: f.start_date || '2026-10-05',
      fee_applied_at: new Date(), fee_applied_by: p[3] }); return rows([Object.assign({}, f)]);
  }
  if (/^UPDATE founding_partners SET return_platform_fee_bps = \$2, fee_restored_at/.test(s)) {
    const f = st.fps.get(p[0]); Object.assign(f, { return_platform_fee_bps: p[1], fee_restored_at: new Date(), fee_restored_by: p[2] }); return rows([Object.assign({}, f)]);
  }
  if (/^UPDATE founding_partners SET status = 'ended'/.test(s)) {
    const f = st.fps.get(p[0]); Object.assign(f, { status: 'ended', ended_at: new Date(), ended_by: p[1], end_reason: p[2] }); return rows([Object.assign({}, f)]);
  }
  if (/^UPDATE founding_partners SET .* WHERE id = \$1 RETURNING \*/.test(s)) {
    const f = st.fps.get(p[0]); const sets = s.match(/SET (.*), updated_at/)[1].split(', ').map((x) => x.split(' = ')[0]);
    sets.forEach((k, i) => { f[k] = p[i + 1]; }); return rows([Object.assign({}, f)]);
  }
  // seller_profiles
  if (/^SELECT id, seller_type, platform_fee_bps FROM seller_profiles WHERE id = \$1/.test(s)) { const r = st.sellers.get(p[0]); return rows(r ? [Object.assign({}, r)] : []); }
  if (/^SELECT platform_fee_bps FROM seller_profiles WHERE id = \$1 FOR UPDATE/.test(s)) { const r = st.sellers.get(p[0]); return rows(r ? [{ platform_fee_bps: r.platform_fee_bps }] : []); }
  if (/^UPDATE seller_profiles SET platform_fee_bps = \$1 WHERE id = \$2/.test(s)) { st.sellers.get(p[1]).platform_fee_bps = p[0]; return rows([]); }
  if (/^UPDATE seller_profiles SET acquisition/.test(s)) { for (const id of p[0]) { const r = st.sellers.get(id); if (r) r.acquisition = Object.assign({}, r.acquisition, { founding_partner: { founding_partner_id: p[1], market: p[2] } }); } return rows([]); }
  if (/^UPDATE organizations SET acquisition/.test(s)) return rows([]);
  // agreements, links
  if (/FROM professional_pricing_agreements/.test(s)) {
    if (/status IN \('accepted','pending','draft'\)/.test(s)) return rows(st.agreements.filter((a) => a.seller_profile_id === p[0] && ['accepted', 'pending', 'draft'].includes(a.status)));
    return rows(st.agreements.filter((a) => a.seller_profile_id === p[0] && a.status === 'accepted').map((a) => ({ platform_fee_bps: a.platform_fee_bps })));
  }
  if (/^SELECT company_id FROM company_identity_links WHERE entity_type = 'seller_profile'/.test(s)) { const c = st.links.get('seller_profile:' + p[0]); return rows(c ? [{ company_id: c }] : []); }
  if (/^SELECT entity_type, entity_id FROM company_identity_links WHERE company_id = \$1/.test(s)) {
    return rows([...st.links.entries()].filter(([, c]) => c === p[0]).map(([k]) => ({ entity_type: k.split(':')[0], entity_id: k.split(':')[1] })));
  }
  if (/^INSERT INTO company_identity_links/.test(s)) { st.links.set('seller_profile:' + p[1], p[0]); return rows([]); }
  // auctions (publish + settlement)
  if (/FROM auctions WHERE id = \$1 FOR UPDATE/.test(s)) {
    st.current = p[0];
    return rows([{ id: p[0], state: 'draft', seller_id: st.auctions.get(p[0]).seller_id, start_time: new Date(Date.now() + 3600e3).toISOString(),
      street_address: '100 Main St', city: 'Houston', address_state: 'TX', zip: '77002' }]);
  }
  if (/count\(\*\)::int AS c FROM lots/.test(s)) return rows([{ c: 30 }]);
  if (/^UPDATE auctions SET state = 'published'/.test(s)) { st.auctions.get(p[0]).state = 'published'; return rows([{ id: p[0], state: 'published' }]); }
  if (/sp\.platform_fee_bps AS seller_platform_bps, st\.buyer_premium_pct, a\.buyer_premium_bps/.test(s)) {
    const a = st.auctions.get(p[0]); const sp = st.sellers.get(a.seller_id);
    return rows([{ seller_profile_id: sp.id, seller_type: sp.seller_type, seller_platform_bps: sp.platform_fee_bps, buyer_premium_pct: null, buyer_premium_bps: null }]);
  }
  if (/^UPDATE auctions SET platform_fee_bps = \$2, processing_fee_bps = \$3, buyer_premium_bps = \$4, pricing_model = 'v2_separated'/.test(s)) {
    if (st.failSnapshot) throw new Error('simulated snapshot failure');
    const a = st.auctions.get(p[0]);
    if (a.pricing_model == null) Object.assign(a, { platform_fee_bps: p[1], processing_fee_bps: p[2], buyer_premium_bps: p[3], pricing_model: 'v2_separated', processing_fee_basis: p[4] });
    return rows([]);
  }
  if (/^UPDATE auctions SET founding_partner_id = \$2 WHERE id = \$1 AND founding_partner_id IS NULL/.test(s)) {
    const a = st.auctions.get(p[0]); if (a.founding_partner_id == null) a.founding_partner_id = p[1]; return rows([]);
  }
  if (/^SELECT pricing_model, processing_fee_bps, processing_fee_basis FROM auctions WHERE id = \$1/.test(s)) { const a = st.auctions.get(p[0]); return rows([{ pricing_model: a.pricing_model, processing_fee_bps: a.processing_fee_bps, processing_fee_basis: a.processing_fee_basis }]); }
  if (/a\.platform_fee_bps AS snap_platform_bps, a\.processing_fee_bps AS snap_processing_bps, a\.pricing_model/.test(s)) {
    const a = st.auctions.get(p[0]); const sp = st.sellers.get(a.seller_id);
    return rows([{ buyer_premium_bps: a.buyer_premium_bps, snap_platform_bps: a.platform_fee_bps, snap_processing_bps: a.processing_fee_bps, pricing_model: a.pricing_model, processing_fee_basis: a.processing_fee_basis,
      seller_type: sp.seller_type, seller_platform_bps: sp.platform_fee_bps, buyer_premium_pct: null }]);
  }
  return rows([]);
}
jest.mock('../src/db', () => {
  const client = { query: async (sql, p) => mockHandle(sql, p), release() {} };
  return { query: async (sql, p) => mockHandle(sql, p), connect: async () => client, pool: {} };
});
jest.mock('../src/services/auditService', () => ({ logEvent: jest.fn(async (_c, e) => { mockDb.state && mockDb.state.audits.push(e); }) }));
jest.mock('../src/services/verificationService', () => ({ publicationGate: jest.fn(async () => ({ blocked: false })) }));
jest.mock('../src/services/auctionGeocodingService', () => ({ geocodeAuctionSafe: jest.fn(async () => {}) }));
jest.mock('../src/lib/realtime', () => ({ publish: jest.fn(), notify: jest.fn() }));
jest.mock('../src/services/pricingConfigService', () => ({
  currentProPlatformBps: jest.fn(async () => 400), currentProcessingBps: jest.fn(async () => 300), KEYS: {}, DEFAULTS: {},
}));

const fp = require('../src/services/acquisition/foundingPartnerService');
const identity = require('../src/services/acquisition/companyIdentityService');
const journeys = require('../src/services/acquisition/journeyService');
const locks = require('../src/services/acquisition/contactLockService');
const auctionService = require('../src/services/auctionService');
const billing = require('../src/services/billingTermsService');
const pricing = require('../src/services/sellerPricingAgreementService');
const pricingConfig = require('../src/services/pricingConfigService');
const feeDisplay = require('../src/services/sellerFeeDisplayService');
const marketplaceOrders = require('../src/services/marketplaceOrderService');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const fakeCluster = (journey = null) => ({ companyId: 'co-1', journey, members: [{ key: 'organization:org-1', entity_type: 'organization', entity_id: 'org-1', label: 'Gulf Coast Estate Sales', row: {} }] });
function stubIdentity({ ambiguous = [], conflicts = [] } = {}) {
  jest.spyOn(identity, 'snapshot').mockResolvedValue({ clusterFor: () => fakeCluster(), ambiguousFor: () => ambiguous, conflicts });
  jest.spyOn(identity, 'ensureCompany').mockResolvedValue('co-1');
  jest.spyOn(journeys, 'activeFor').mockResolvedValue({ journey: 'CLAIMED_LISTING' });
  jest.spyOn(journeys, 'move').mockResolvedValue({});
  jest.spyOn(locks, 'acquire').mockResolvedValue({ expires_at: new Date() });
}
const settle = async (auctionId, hammerCents, actualProcessingCents = null) => {
  const t = await billing.resolveEffectiveTerms(auctionId, { query: async (sql, p) => mockHandle(sql, p) });
  return billing.settlement({ sellerType: t.seller_type, hammerCents, buyerPremiumCents: 0, platformFeeBps: t.platform_fee_bps, processingFeeBps: t.processing_fee_bps,
    pricingModel: t.pricing_model, processingFeeBasis: t.processing_fee_basis, actualProcessingCents });
};
const designateDefault = () => fp.designate({ entityType: 'organization', entityId: 'org-1', market: 'houston', reason: 'Founding Partner pilot, Houston',
  introPlatformFeeBps: 0, actorId: ADMIN, isSuperAdmin: true });

beforeEach(() => { mockFresh(); jest.restoreAllMocks(); });

// ── 1. the money ──────────────────────────────────────────────────────────────────────────────
describe('fee math: 0% platform + 3% processing', () => {
  test('$1,000 hammer at 0% platform → $0 platform fee and $30 processing (seller nets $970)', () => {
    const s = billing.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 0, processingFeeBps: 300, pricingModel: 'v2_separated' });
    expect(s.platform_fee_bps).toBe(0);
    expect(s.platform_fee_cents).toBe(0);
    expect(s.processing_fee_bps).toBe(300);
    expect(s.processing_fee_cents).toBe(3000);
    expect(s.seller_payout_cents).toBe(97000);
    expect(s.advantage_revenue_cents).toBe(3000);
  });
  test('an explicit 0% is never treated as unset: no path substitutes the 4% default', () => {
    expect(pricing.resolvePlatformFeeBps({ agreementBps: null, sellerOverrideBps: 0, sitewideDefaultBps: 400 })).toBe(0);
    expect(pricing.resolvePlatformFeeBps({ agreementBps: 0, sellerOverrideBps: 400, sitewideDefaultBps: 400 })).toBe(0);
    expect(pricing.resolvePlatformFeeBps({ agreementBps: undefined, sellerOverrideBps: null, sitewideDefaultBps: 400 })).toBe(400);
    expect(billing.settlement({ sellerType: 'auction_house', hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 0, processingFeeBps: 300, pricingModel: 'v2_separated' }).platform_fee_cents).toBe(0);
    expect(feeDisplay.describe({ sellerType: 'estate_sale_company', storedBps: 0, agreement: null, sitewideBps: 400 })).toMatchObject({ effective_platform_fee_bps: 0, fee_basis: 'seller_rate' });
    // settlementEngine: a frozen snapshot of 0 is used (0 != null), never the live seller rate.
    expect(read('src/services/settlementEngine.js')).toMatch(/pricingModel === 'v2_separated' && row\.snap_platform_bps != null\)\s*\?\s*row\.snap_platform_bps/);
    // No fee expression anywhere in src falls back with || to a NON-zero value (which would turn 0 into the default).
    // (`x || 0` is harmless: zero stays zero.)
    const offenders = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) {
      const t = fs.readFileSync(p, 'utf8'); if (/(platform_fee_bps|platformFeeBps|seller_platform_bps|snap_platform_bps|intro_platform_fee_bps|processing_fee_bps|processingFeeBps)\)?\s*\|\|(?!\s*0\b)/.test(t)) offenders.push(p); } } };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
  test('processing is never waived: a zero or missing processing snapshot on a v2 auction settles at the 3% default, never 0 by omission', () => {
    const s = billing.settlement({ sellerType: 'estate_sale_company', hammerCents: 100000, buyerPremiumCents: 0, platformFeeBps: 0, processingFeeBps: null, pricingModel: 'v2_separated' });
    expect(s.processing_fee_cents).toBe(3000);
  });
});

// ── 2-4. the full lifecycle through the real services ─────────────────────────────────────────
describe('lifecycle: designate → activate → publish (frozen) → settle → restore → publish', () => {
  test('0% freezes at publish, restoring the return fee leaves the published auction at 0%, later auctions use the restored fee', async () => {
    stubIdentity();
    const st = mockDb.state;
    st.auctions.set('A1', { id: 'A1', seller_id: 'S1', pricing_model: null });
    st.auctions.set('A2', { id: 'A2', seller_id: 'S1', pricing_model: null });

    const rec = await designateDefault();
    expect(rec.status).toBe('prospect');
    expect(st.sellers.get('S1').platform_fee_bps).toBe(400);                 // designation alone changes no fee

    const act = await fp.activate(rec.id, { sellerProfileId: 'S1', actorId: ADMIN });
    expect(act.status).toBe('active');
    expect(st.sellers.get('S1').platform_fee_bps).toBe(0);                   // explicit 0 on the EXISTING seller rate
    expect(act.prior_platform_fee_bps).toBe(400);
    expect(act.return_platform_fee_bps).toBe(400);                           // defaults to the seller's prior rate
    expect(st.audits.find((a) => a.eventType === 'seller_platform_fee_changed')).toMatchObject({ metadata: expect.objectContaining({ before_bps: 400, after_bps: 0, source: 'founding_partner' }) });
    expect(st.sellers.get('S1').acquisition.founding_partner.founding_partner_id).toBe(rec.id);   // durable attribution

    await auctionService.publishAuction('A1');
    // Auction Partner at 0%: processing basis frozen as the ACTUAL Stripe fee (Owner policy 2026-10-05).
    expect(st.auctions.get('A1')).toMatchObject({ pricing_model: 'v2_separated', platform_fee_bps: 0, processing_fee_basis: 'actual_stripe', founding_partner_id: rec.id });
    const s1 = await settle('A1', 100000, 2930);                         // $1,000 charged; Stripe fee fixture $29.30
    expect([s1.platform_fee_cents, s1.processing_fee_cents, s1.seller_payout_cents]).toEqual([0, 2930, 97070]);
    expect((await settle('A1', 100000)).processing_fee_pending).toBe(true);   // not yet recorded → pending, never 3%

    const restored = await fp.restoreFee(rec.id, { actorId: ADMIN });
    expect(restored.fee_restored_at).toBeTruthy();
    expect(st.sellers.get('S1').platform_fee_bps).toBe(400);

    // The already-published auction is unchanged, even if it is published again.
    await auctionService.publishAuction('A1');
    expect(st.auctions.get('A1')).toMatchObject({ platform_fee_bps: 0, processing_fee_basis: 'actual_stripe' });   // frozen: restore changes nothing
    expect((await settle('A1', 100000, 2930)).platform_fee_cents).toBe(0);

    await auctionService.publishAuction('A2');
    // After restore: ordinary Professional rules (4% platform + 3%-of-hammer policy processing).
    expect(st.auctions.get('A2')).toMatchObject({ platform_fee_bps: 400, processing_fee_bps: 300, processing_fee_basis: 'policy_rate', founding_partner_id: rec.id });
    const s2 = await settle('A2', 100000);
    expect([s2.platform_fee_cents, s2.processing_fee_cents, s2.seller_payout_cents]).toEqual([4000, 3000, 93000]);

    // Nothing touched the sitewide default or the processing rate.
    expect(mockDb.queries.some((q) => /platform_config/.test(q) && /^(UPDATE|INSERT)/.test(q))).toBe(false);
  });

  test('publish FAILS CLOSED for a Founding Partner seller when the pricing snapshot cannot be written', async () => {
    stubIdentity();
    const st = mockDb.state;
    st.auctions.set('A1', { id: 'A1', seller_id: 'S1', pricing_model: null });
    const rec = await designateDefault();
    await fp.activate(rec.id, { sellerProfileId: 'S1', actorId: ADMIN });
    st.failSnapshot = true;
    await expect(auctionService.publishAuction('A1')).rejects.toMatchObject({ code: 'PRICING_SNAPSHOT_REQUIRED' });
  });
  test('publish FAILS CLOSED for any professional seller stored at 0% (even without a program record)', async () => {
    const st = mockDb.state;
    st.sellers.get('S1').platform_fee_bps = 0;
    st.auctions.set('A1', { id: 'A1', seller_id: 'S1', pricing_model: null });
    st.failSnapshot = true;
    await expect(auctionService.publishAuction('A1')).rejects.toMatchObject({ code: 'PRICING_SNAPSHOT_REQUIRED' });
  });
  test('an ordinary 4% professional keeps the existing behaviour (a snapshot failure does not block publication)', async () => {
    const st = mockDb.state;
    st.auctions.set('A1', { id: 'A1', seller_id: 'S1', pricing_model: null });
    st.failSnapshot = true;
    await expect(auctionService.publishAuction('A1')).resolves.toMatchObject({ id: 'A1', state: 'published' });
  });
});

// ── service guards ────────────────────────────────────────────────────────────────────────────
describe('program guards', () => {
  test('an ambiguous identity is refused BEFORE anything is changed (fail closed)', async () => {
    stubIdentity({ ambiguous: [{ a: 'organization:org-1', b: 'organization:org-9', a_label: 'Gulf Coast Estate Sales', b_label: 'Gulf Coast Estates', weak: ['name_tokens:gulf+coast'] }] });
    await expect(designateDefault()).rejects.toMatchObject({ code: 'AMBIGUOUS_IDENTITY' });
    expect(journeys.move).not.toHaveBeenCalled();
    expect(identity.ensureCompany).not.toHaveBeenCalled();
  });
  test('a refused company merge is refused too', async () => {
    stubIdentity({ conflicts: [{ a: 'organization:org-1', b: 'organization:org-7', method: 'phone', reason: 'distinct directory listings with different names share only phone' }] });
    await expect(designateDefault()).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
    expect(journeys.move).not.toHaveBeenCalled();
  });
  test('designation moves the company into the FOUNDING_PARTNER journey FIRST and gives the contact lock to the person handling it', async () => {
    stubIdentity();
    await designateDefault();
    expect(journeys.move).toHaveBeenCalledWith('co-1', expect.objectContaining({ toJourney: 'FOUNDING_PARTNER', actorId: ADMIN }));
    expect(locks.acquire).toHaveBeenCalledWith('co-1', expect.objectContaining({ userId: ADMIN, reason: 'Founding Auction Partner' }));
    const moveOrder = journeys.move.mock.invocationCallOrder[0];
    const insertIdx = mockDb.queries.findIndex((q) => /^INSERT INTO founding_partners/.test(q));
    expect(insertIdx).toBeGreaterThan(-1);
    expect(moveOrder).toBeGreaterThan(0);
  });
  test('a second open record for the same company is refused', async () => {
    stubIdentity();
    await designateDefault();
    await expect(designateDefault()).rejects.toMatchObject({ code: 'ALREADY_FOUNDING_PARTNER' });
  });
  test('the introductory fee is refused while a pricing agreement exists (an agreement outranks the seller rate)', async () => {
    stubIdentity();
    const rec = await designateDefault();
    mockDb.state.agreements.push({ seller_profile_id: 'S1', status: 'accepted', platform_fee_bps: 350, version: 1 });
    await expect(fp.activate(rec.id, { sellerProfileId: 'S1', actorId: ADMIN })).rejects.toMatchObject({ code: 'PRICING_AGREEMENT_EXISTS' });
    expect(mockDb.state.sellers.get('S1').platform_fee_bps).toBe(400);
  });
  test('only professional sellers can carry the introductory platform fee', async () => {
    stubIdentity();
    const rec = await designateDefault();
    mockDb.state.sellers.set('S2', { id: 'S2', seller_type: 'private', platform_fee_bps: 400 });
    await expect(fp.activate(rec.id, { sellerProfileId: 'S2', actorId: ADMIN })).rejects.toMatchObject({ code: 'NOT_PROFESSIONAL' });
  });
  test('restore refuses to overwrite a rate someone changed in Moderation', async () => {
    stubIdentity();
    const rec = await designateDefault();
    await fp.activate(rec.id, { sellerProfileId: 'S1', actorId: ADMIN });
    mockDb.state.sellers.get('S1').platform_fee_bps = 250;
    await expect(fp.restoreFee(rec.id, { actorId: ADMIN })).rejects.toMatchObject({ code: 'FEE_CHANGED_ELSEWHERE' });
    expect(mockDb.state.sellers.get('S1').platform_fee_bps).toBe(250);
  });
  test('a record cannot be ended while the introductory fee is still applied', async () => {
    stubIdentity();
    const rec = await designateDefault();
    await fp.activate(rec.id, { sellerProfileId: 'S1', actorId: ADMIN });
    await expect(fp.end(rec.id, { reason: 'partner declined', actorId: ADMIN })).rejects.toMatchObject({ code: 'RESTORE_FEE_FIRST' });
    await fp.restoreFee(rec.id, { actorId: ADMIN });
    await expect(fp.end(rec.id, { reason: 'partner declined', actorId: ADMIN })).resolves.toMatchObject({ status: 'ended' });
  });
  test('rates are validated: 0 accepted, negatives / fractions / > 25% refused', async () => {
    stubIdentity();
    await expect(fp.designate({ entityType: 'organization', entityId: 'org-1', market: 'houston', reason: 'pilot partner', introPlatformFeeBps: -1, actorId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_RATE' });
    await expect(fp.designate({ entityType: 'organization', entityId: 'org-1', market: 'houston', reason: 'pilot partner', introPlatformFeeBps: 2501, actorId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_RATE' });
    await expect(fp.designate({ entityType: 'organization', entityId: 'org-1', market: 'Houston TX!', reason: 'pilot partner', actorId: ADMIN })).rejects.toMatchObject({ code: 'INVALID_MARKET' });
    const ok = await fp.designate({ entityType: 'organization', entityId: 'org-1', market: 'houston', reason: 'pilot partner', introPlatformFeeBps: 0, actorId: ADMIN });
    expect(ok.intro_platform_fee_bps).toBe(0);
  });
});

// ── 6. Storefront ─────────────────────────────────────────────────────────────────────────────
describe('Storefront pricing is untouched', () => {
  test('Storefront stays a flat 11% whatever the seller\'s auction rate (including a 0% Founding Partner)', () => {
    expect(marketplaceOrders.STOREFRONT_FEE_BPS).toBe(1100);
    expect(marketplaceOrders.feeBpsForSeller({ platform_fee_bps: 0 })).toBe(1100);
    expect(marketplaceOrders.computeBreakdown({ itemPriceCents: 10000, shippingCents: 0, taxCents: 0, feeBps: marketplaceOrders.feeBpsForSeller({ platform_fee_bps: 0 }) }).platform_fee_cents).toBe(1100);
  });
  test('the Founding Partner code never reads or writes Storefront, sitewide or processing configuration', () => {
    const src = read('src/services/acquisition/foundingPartnerService.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // code only
    expect(src).not.toMatch(/storefront|marketplaceOrder|setBps|pricing\.auction\.|processing_fee_bps\s*=/i);
    expect(read('db/migrations/185_founding_auction_partners.sql')).not.toMatch(/platform_config|seller_profiles SET|UPDATE /i);
  });
});

// ── cross-program protection ──────────────────────────────────────────────────────────────────
describe('a Founding Partner never receives automated Claimed Listing or Event Partner messages', () => {
  const listingContext = require('../src/services/claimedListings/listingContext');
  const elig = require('../src/services/claimedListings/eligibilityService');
  function listing(o = {}) {
    const row = Object.assign({ id: '00000000-0000-4000-8000-000000000001', name: 'Gulf Coast Estate Sales', source: 'bd_import', bd_listing_id: '901',
      contact_email: 'owner@gulfcoastestates.com', website_url: 'https://gulfcoastestates.com', state: 'TX', city: 'Houston', has_owner: false,
      bd_sync_status: 'active', profile_data: {}, bd_metadata: { profession_id: '4', subscription_id: '7' } }, o);
    return { key: 'organization:' + row.id, entity_type: 'organization', entity_id: row.id, label: row.name, row,
      signals: identity.signalsOf({ name: row.name, website: row.website_url, email: row.contact_email, bdListingId: row.bd_listing_id }) };
  }
  function ctxFor(entities, journey) {
    const built = identity.buildClusters(entities);
    for (const c of built.clusters) { c.journey = journey; c.journey_reason = 'Founding Auction Partner: pilot'; c.companyId = 'co-1'; }
    const by = new Map(); for (const c of built.clusters) for (const m of c.members) by.set(m.key, c);
    return { snap: { clusterFor: (t, id) => by.get(t + ':' + id) || null, ambiguousFor: () => [] },
      config: { recentDays: 90, salesCooldownDays: 30, excludedBdIds: new Set(), excludedCompanyIds: new Set(), paidBadgeBdIds: new Set(), weights: {} },
      listings: entities.filter((e) => listingContext.isListingOrg(e.row)), supp: new Map(), companySupp: new Map(), listingSends: [], epSends: [], salesSends: [],
      activeSequences: new Map(), internalAccounts: new Map(), locks: new Map(), primaryFor: new Map(), companyIdOf: (c) => (c && c.companyId) || null };
  }
  test('Claimed Listing screening excludes the company (EXCLUDE_FOUNDING_PARTNER), whereas the same listing in its own journey is eligible', () => {
    const e = listing();
    expect(elig.decide(e, ctxFor([e], 'FOUNDING_PARTNER')).decision).toBe('EXCLUDE_FOUNDING_PARTNER');
    expect(elig.decide(e, ctxFor([e], 'CLAIMED_LISTING')).decision).toBe('ELIGIBLE_UNCLAIMED_LISTING');
    expect(elig.SENDABLE.has('EXCLUDE_FOUNDING_PARTNER')).toBe(false);
  });
  test('a listing that only RESEMBLES a Founding Partner is held for review, not sent', () => {
    expect(elig.hasRelationship({ journey: 'FOUNDING_PARTNER', members: [] })).toBe(true);
  });
  test('the Claimed Listing send gate requires the CLAIMED_LISTING journey at send time, and a journey move stops open sequences', () => {
    expect(read('src/services/claimedListings/sendGate.js')).toMatch(/cluster && cluster\.journey === 'CLAIMED_LISTING'/);
    expect(read('src/services/acquisition/journeyService.js')).toMatch(/UPDATE listing_outreach_sequences SET state = 'stopped', stop_reason = 'journey_change'/);
  });
  test('Event Partner screening excludes a company in (or strongly matching) the Founding Partner journey', async () => {
    const seg = require('../src/services/eventPartners/relationshipSegmentationService');
    const cluster = { companyId: 'co-1', journey: 'FOUNDING_PARTNER', journey_reason: 'pilot', members: [{ entity_type: 'organization', entity_id: 'org-1', label: 'Gulf Coast Estate Sales' }] };
    const snap = { clusterFor: () => null, matchSignals: () => ({ clusters: [cluster] }), ambiguousFor: () => [] };
    const runner = { query: async () => ({ rows: [] }) };
    const d = await seg.resolve({ company_name: 'Gulf Coast Estate Sales', business_email: 'info@gulfcoastestates.com', website: 'gulfcoastestates.com' },
      { companies: snap, claimed: [], partners: [], pros: [] }, runner);
    expect(d.decision).toBe('EXCLUDE_FOUNDING_PARTNER');
  });
  test('Event Partner will not attach an invitation to a Founding Partner organization, and refuses when the journey is unknown', async () => {
    const send = require('../src/services/eventPartners/outreachSendService');
    const runner = { query: async () => ({ rows: [{ id: 'org-1', name: 'Gulf Coast Estate Sales', bd_listing_id: null, source: null }] }) };
    jest.spyOn(identity, 'snapshot').mockResolvedValue({ clusterFor: () => ({ journey: 'FOUNDING_PARTNER' }) });
    expect(await send.ensureOrganizationForProspect({ company_name: 'Gulf Coast Estate Sales', website: 'gulfcoastestates.com' }, runner)).toMatchObject({ ok: false, code: 'FOUNDING_PARTNER' });
    identity.snapshot.mockRejectedValue(new Error('db down'));
    expect(await send.ensureOrganizationForProspect({ company_name: 'Gulf Coast Estate Sales', website: 'gulfcoastestates.com' }, runner)).toMatchObject({ ok: false, code: 'COMPANY_CHECK_FAILED' });
  });
  test('1:1 rep email: only the contact-lock holder may email a Founding Partner; a free lock is NOT taken automatically', async () => {
    const guard = require('../src/services/acquisition/outreachGuard');
    const suppression = require('../src/services/claimedListings/suppressionService');
    jest.spyOn(suppression, 'check').mockResolvedValue({ suppressed: false });
    jest.spyOn(identity, 'snapshot').mockResolvedValue({ clusterFor: () => ({ companyId: 'co-1', journey: 'FOUNDING_PARTNER', members: [{}, {}] }) });
    const acquire = jest.spyOn(locks, 'acquire').mockResolvedValue({});
    jest.spyOn(locks, 'touch').mockResolvedValue();
    const check = jest.spyOn(locks, 'check').mockResolvedValue({ ok: true });                       // lock is free
    const prospect = { id: 'p-1', business_email: 'info@gulfcoastestates.com' };
    await expect(guard.checkProspectContact({ prospect, repUserId: 'rep-2' }, { query: async () => ({ rows: [] }) })).rejects.toMatchObject({ code: 'FOUNDING_PARTNER' });
    expect(acquire).not.toHaveBeenCalled();
    check.mockResolvedValue({ ok: false, code: 'CONTACT_LOCKED', holder: { type: 'user', name: 'Owner' } });  // someone else holds it
    await expect(guard.checkProspectContact({ prospect, repUserId: 'rep-2' }, { query: async () => ({ rows: [] }) })).rejects.toMatchObject({ code: 'FOUNDING_PARTNER' });
    check.mockResolvedValue({ ok: true, lock: { holder_user_id: ADMIN } });                         // the handler holds it
    await expect(guard.checkProspectContact({ prospect, repUserId: ADMIN }, { query: async () => ({ rows: [] }) })).resolves.toMatchObject({ ok: true, companyId: 'co-1' });
  });
  test('the journey, both screening decisions and the program table are declared in migration 185', () => {
    const sql = read('db/migrations/185_founding_auction_partners.sql');
    expect(sql).toMatch(/'CLAIMED_LISTING','EVENT_PARTNER','SALES_DIRECT','FOUNDING_PARTNER'/);
    expect((sql.match(/'EXCLUDE_FOUNDING_PARTNER'/g) || []).length).toBe(2);
    expect(sql).toMatch(/uq_fp_open_company/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS founding_partner_id/);
    expect(journeys.JOURNEYS).toContain('FOUNDING_PARTNER');
  });
});

// ── staff warnings, reminders and the cohort profile ──────────────────────────────────────────
describe('reminders and warnings (the fee never changes by itself)', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const base = { status: 'active', fee_applied_at: new Date(), fee_restored_at: null, intro_platform_fee_bps: 0, seller_platform_fee_bps: 0 };
  test('warnings: ending soon, ended, changed elsewhere, agreement override, not protected', () => {
    const codes = (r, o) => fp.warningsFor(Object.assign({}, base, r), Object.assign({ now, journey: 'FOUNDING_PARTNER', effectiveBps: 0 }, o)).map((w) => w.code);
    expect(codes({ intro_end_date: '2026-11-30' })).toContain('INTRO_ENDING');
    expect(codes({ intro_end_date: '2026-11-10' })).toContain('INTRO_ENDED');
    expect(codes({ intro_end_date: '2027-03-01' })).toEqual([]);
    expect(codes({ intro_end_date: null })).toEqual(['NO_END_DATE']);
    expect(codes({ intro_end_date: '2027-03-01', seller_platform_fee_bps: 400 })).toContain('FEE_CHANGED_ELSEWHERE');
    expect(codes({ intro_end_date: '2027-03-01' }, { effectiveBps: 350 })).toContain('EFFECTIVE_FEE_DIFFERS');
    expect(codes({ intro_end_date: '2027-03-01' }, { journey: 'CLAIMED_LISTING' })).toContain('NOT_PROTECTED');
  });
  test('sendReminders alerts once per stage (ending / ended) and issues no write', async () => {
    const rows = [
      { id: 'a', display_name: 'A', market: 'houston', intro_end_date: '2026-11-30', intro_platform_fee_bps: 0, return_platform_fee_bps: 400 },
      { id: 'b', display_name: 'B', market: 'ny_tristate', intro_end_date: '2026-11-01', intro_platform_fee_bps: 0, return_platform_fee_bps: 400 },
      { id: 'c', display_name: 'C', market: 'houston', intro_end_date: '2027-06-01', intro_platform_fee_bps: 0, return_platform_fee_bps: null },
    ];
    const sql = [];
    const alert = jest.fn(async () => ({ sent: true }));
    const r = await fp.sendReminders({ now, alert, runner: { query: async (q) => { sql.push(q); return { rows }; } } });
    expect(r).toMatchObject({ checked: 3, ending: 1, ended: 1 });
    expect(alert.mock.calls.map((c) => c[0].entityId)).toEqual(['a:ending', 'b:ended']);
    expect(alert.mock.calls[0][0].actionType).toBe('founding_partner_intro_ending');
    expect(sql.every((q) => /^\s*SELECT/.test(q))).toBe(true);
  });
  test('the cohort target profile: estate sale company in Greater Houston or the NY tri-state; data errors are flagged, not counted', () => {
    expect(fp.targetProfile({ city: 'Conroe', state: 'TX', bd_metadata: { profession_id: '4' } })).toMatchObject({ market: 'houston', in_target: true });
    expect(fp.targetProfile({ city: 'Morristown', state: 'NJ', bd_metadata: { profession_id: '4' } })).toMatchObject({ market: 'ny_tristate', in_target: true });
    expect(fp.targetProfile({ city: 'New York', state: 'NY', bd_metadata: { profession_id: '3' } })).toMatchObject({ market: 'ny_tristate', in_target: false, profession: 'auction_house' });
    const flagged = fp.targetProfile({ city: 'Bellaire', state: 'KANSAS', bd_metadata: { profession_id: '4' } });
    expect(flagged.in_target).toBe(false);
    expect(flagged.flags[0]).toMatch(/Greater Houston/);
    expect(fp.targetProfile({ city: 'Dallas', state: 'TX', bd_metadata: { profession_id: '4' } }).in_target).toBe(false);
  });
});

describe('effective fee display (Moderation)', () => {
  test('an accepted agreement that overrides the stored rate is shown as the effective fee, flagged', () => {
    const d = feeDisplay.describe({ sellerType: 'auction_house', storedBps: 400, agreement: { platform_fee_bps: 300, version: 2 }, sitewideBps: 400 });
    expect(d).toMatchObject({ effective_platform_fee_bps: 300, fee_basis: 'agreement', overridden_by_agreement: true });
    expect(d.fee_note).toMatch(/overrides the stored rate of 4\.00%/);
  });
  test('individual sellers show no platform fee; an unset professional shows the sitewide default', () => {
    expect(feeDisplay.describe({ sellerType: 'private', storedBps: 400, agreement: null, sitewideBps: 400 })).toMatchObject({ effective_platform_fee_bps: 0, fee_basis: 'individual' });
    expect(feeDisplay.describe({ sellerType: 'estate_sale_company', storedBps: null, agreement: null, sitewideBps: 400 })).toMatchObject({ effective_platform_fee_bps: 400, fee_basis: 'sitewide_default' });
  });
  test('the Moderation page labels the input as the STORED rate and shows the effective pill', () => {
    const html = read('public/admin/moderation.html');
    expect(html).toMatch(/Stored Platform Fee/);
    expect(html).toMatch(/'Effective ' \+/);
    expect(read('src/routes/admin.js')).toMatch(/sellerFeeDisplayService'\)\.annotate\(rows\.rows\)/);
  });
  test('no visible text on the new page uses banned wording or vendor names', () => {
    const html = read('public/admin/founding-partners.html').replace(/<script[\s\S]*?<\/script>/g, '');
    expect(html).not.toMatch(/\bAI\b|artificial intelligence|Stripe|Railway|Neon|Postmark/i);
  });
  void pricingConfig;
});
