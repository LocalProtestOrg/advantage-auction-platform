'use strict';

/**
 * H-1 follow-up — Professional Seller first-sale business-verification gate.
 *
 * Rule: every Professional Seller (auction_house / estate_sale_company / professional_liquidator) must be
 * approved by Advantage.Bid before their FIRST sale can go public. A professional MAY create the account,
 * build a dashboard/auction/catalog, and prepare the first sale before approval — only making it publicly
 * sellable is gated. Individuals are never subject to this. Reuses the EXISTING verification publication
 * gate (verification_required_before_publication + verificationService.publicationGate) — no second system.
 *
 * The 10 required assertions are labelled [#n].
 */
const fs = require('fs');

jest.mock('../src/db/index', () => ({ query: jest.fn() }));
jest.mock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'm' }) }));
jest.mock('../src/services/cloudinaryService', () => ({ uploadBuffer: jest.fn().mockResolvedValue({ public_id: 'x', format: 'pdf', bytes: 1 }) }));
jest.mock('cloudinary', () => ({ v2: { utils: { private_download_url: jest.fn(() => 'https://signed') } } }));

const db = require('../src/db/index');
const { writeAuditLog } = require('../src/lib/auditLog');
const v = require('../src/services/verificationService');

function route(routes) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql).toLowerCase();
    for (const [kw, rows] of routes) if (s.includes(kw)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  });
}
beforeEach(() => { db.query.mockReset(); writeAuditLog.mockClear(); });

// ── Provisioning: professional types auto-require verification ──────────────────
describe('Professional provisioning auto-requires verification', () => {
  test('[#1] new Auction House → verification required automatically', async () => {
    route([['update seller_profiles', [{ id: 'sp1' }]]]);
    const r = await v.requireVerificationForProfessional('sp1', 'auction_house', 'admin1');
    expect(r).toEqual({ applied: true, changed: true });
    // The UPDATE set the flag to true.
    const updateCall = db.query.mock.calls.find(c => /update seller_profiles/i.test(c[0]));
    expect(updateCall[0]).toMatch(/verification_required_before_publication = true/i);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  test('[#2] new Estate Sale Company → verification required automatically', async () => {
    route([['update seller_profiles', [{ id: 'sp2' }]]]);
    expect(await v.requireVerificationForProfessional('sp2', 'estate_sale_company')).toEqual({ applied: true, changed: true });
  });

  test('[#3] new Professional Liquidator → verification required automatically', async () => {
    route([['update seller_profiles', [{ id: 'sp3' }]]]);
    expect(await v.requireVerificationForProfessional('sp3', 'professional_liquidator')).toEqual({ applied: true, changed: true });
  });

  test('[#4] Individual seller → professional verification requirement is NOT applied', async () => {
    for (const t of ['private', 'business', 'other', null, undefined]) {
      db.query.mockReset(); writeAuditLog.mockClear();
      const r = await v.requireVerificationForProfessional('sp-ind', t);
      expect(r).toEqual({ applied: false, changed: false });
      expect(db.query).not.toHaveBeenCalled();     // never touches the row
      expect(writeAuditLog).not.toHaveBeenCalled();
    }
  });

  test('idempotent: already-flagged professional makes no change (UPDATE affects 0 rows)', async () => {
    route([['update seller_profiles', []]]); // IS DISTINCT FROM true matched nothing
    expect(await v.requireVerificationForProfessional('sp1', 'auction_house')).toEqual({ applied: true, changed: false });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

// ── Build freely before approval; only publishing is gated ──────────────────────
describe('Unapproved professional can build; only first sale is gated', () => {
  const auctionServiceSrc = fs.readFileSync(require.resolve('../src/services/auctionService'), 'utf8');
  const lotsSrc = fs.readFileSync(require.resolve('../src/services/lotService'), 'utf8');

  test('[#5] creating/editing an auction is NOT gated — the gate lives only in the publish path', () => {
    // publicationGate lives ONLY in the publish path (publishAuction enforces it; the Professional
    // auto-publish eligibility check reads it to route publish-vs-submit) — NEVER in the build/edit
    // (updateAuction) path. So building and editing are never blocked by verification.
    const updateBody = auctionServiceSrc.slice(auctionServiceSrc.indexOf('async function updateAuction'), auctionServiceSrc.indexOf('async function assessAuctionDeletable'));
    expect(updateBody).not.toMatch(/publicationGate/);
    expect(auctionServiceSrc.slice(auctionServiceSrc.indexOf('async function publishAuction'))).toMatch(/publicationGate/);
    // A non-admin seller can only move draft → submitted; every other state write is dropped.
    expect(auctionServiceSrc).toMatch(/updates\.state === 'submitted'/);
    expect(auctionServiceSrc).toMatch(/All other non-admin state requests silently dropped/);
  });

  test('[#6] building the catalog (lots) is NOT gated by verification', () => {
    expect(lotsSrc).not.toMatch(/publicationGate/);
  });
});

// ── The publication gate itself ─────────────────────────────────────────────────
describe('Publication gate blocks the first public sale until approved', () => {
  test('[#7] unapproved professional cannot make the first sale public (publish blocked)', async () => {
    route([
      ['verification_required_before_publication', [{ verification_required_before_publication: true }]],
      ["status='approved'", []],
    ]);
    expect(await v.publicationGate('sp1')).toEqual({ blocked: true, reason: 'verification_required' });
  });

  test('[#8] approved professional can publish (gate open)', async () => {
    route([
      ['verification_required_before_publication', [{ verification_required_before_publication: true }]],
      ["status='approved'", [{ '?column?': 1 }]],
    ]);
    expect(await v.publicationGate('sp1')).toEqual({ blocked: false, reason: 'verified' });
  });
});

// ── Seller-facing status ────────────────────────────────────────────────────────
describe('Seller-facing verification status', () => {
  test('[#9] blocked seller receives a clear, non-alarming status message', async () => {
    route([
      ['verification_required_before_publication', [{ verification_required_before_publication: true }]],
      ["status='approved'", []],
    ]);
    const status = await v.sellerPublicationStatus('sp1');
    expect(status.blocked).toBe(true);
    expect(status.message).toBeTruthy();
    // Non-alarming + informative: names Advantage.Bid, business verification, and that work is saved.
    expect(status.message).toMatch(/Advantage\.Bid/);
    expect(status.message).toMatch(/verify your business/i);
    expect(status.message).toMatch(/saved/i);
    expect(status.message).not.toMatch(/error|fail|denied/i);
  });

  test('a not-required (individual / approved) seller gets no message', async () => {
    route([['verification_required_before_publication', [{ verification_required_before_publication: false }]]]);
    const status = await v.sellerPublicationStatus('sp-ind');
    expect(status.blocked).toBe(false);
    expect(status.message).toBeNull();
  });
});

// ── No bypass ───────────────────────────────────────────────────────────────────
describe('No bypass through an alternate publish endpoint', () => {
  const adminSrc = fs.readFileSync(require.resolve('../src/routes/admin'), 'utf8');
  const auctionsRouteSrc = fs.readFileSync(require.resolve('../src/routes/auctions'), 'utf8');

  test('[#10] the only publish endpoints are admin-gated and run the verification gate', () => {
    // Publish routes exist ONLY under the admin router, each behind role(['admin']).
    const adminPublish = adminSrc.match(/\/auctions\/:auctionId\/publish['"],\s*auth,\s*role\(\['admin'\]\)/g) || [];
    expect(adminPublish.length).toBeGreaterThanOrEqual(1);
    // The seller-facing auctions router has NO publish ROUTE (sellers never publish; comments don't count).
    expect(auctionsRouteSrc).not.toMatch(/router\.(post|patch|put)\([^)]*publish/i);
    // publishAuction (the single publish transition) enforces the gate.
    const auctionServiceSrc = fs.readFileSync(require.resolve('../src/services/auctionService'), 'utf8');
    const publishIdx = auctionServiceSrc.indexOf('async function publishAuction');
    expect(publishIdx).toBeGreaterThan(-1);
    expect(auctionServiceSrc.indexOf('publicationGate')).toBeGreaterThan(publishIdx);
  });
});
