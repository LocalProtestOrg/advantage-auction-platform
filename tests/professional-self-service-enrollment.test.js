'use strict';

/**
 * Professional Seller self-service acquisition + onboarding.
 *
 * Verifies the safety-critical properties of the new funnel:
 *   - /api/sellers/apply-professional accepts real professional types but NEVER grants trust
 *     (publication stays gated by verification_required_before_publication);
 *   - invalid types are rejected, not silently downgraded;
 *   - organization association uses the seller's OWN org (no name-based takeover);
 *   - the individual /enroll path, buyer registration, and economics are unchanged;
 *   - the public landing page presents accurate economics (flat 11% Storefront; no legacy
 *     "no platform fee"/"~3%" as the professional-auction fee; no BD checkout) and never
 *     exposes the writable demo-seller account;
 *   - the acquisition pages are public (not auth-gated).
 * Mix of source-level assertions (repo style) + focused unit tests with mocked db/audit.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Constants ────────────────────────────────────────────────────────────────
describe('professional seller taxonomy', () => {
  const { PROFESSIONAL_SELLER_TYPES, SELLER_TYPE_LABELS } = require('../src/constants/sellerTypes');
  test('the three professional types exist with friendly labels', () => {
    expect(PROFESSIONAL_SELLER_TYPES).toEqual(
      expect.arrayContaining(['auction_house', 'estate_sale_company', 'professional_liquidator']));
    expect(SELLER_TYPE_LABELS.auction_house).toBe('Auction House');
    expect(SELLER_TYPE_LABELS.estate_sale_company).toBe('Estate Sale Company');
    expect(SELLER_TYPE_LABELS.professional_liquidator).toBe('Professional Liquidator');
  });
});

// ── Verification gate (the trust boundary) ─────────────────────────────────────
describe('requireVerificationForProfessional keeps publication gated', () => {
  jest.resetModules();
  jest.doMock('../src/lib/auditLog', () => ({ writeAuditLog: jest.fn().mockResolvedValue(undefined) }));
  jest.doMock('../src/db', () => ({ query: jest.fn() }));
  const verification = require('../src/services/verificationService');

  test('a professional type sets verification_required_before_publication', async () => {
    const runner = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const r = await verification.requireVerificationForProfessional('sp-1', 'auction_house', 'u-1', runner);
    expect(r.applied).toBe(true);
    const sql = runner.query.mock.calls[0][0];
    expect(sql).toMatch(/verification_required_before_publication = true/);
  });
  test('an individual type is a no-op (never gates individuals)', async () => {
    const runner = { query: jest.fn() };
    const r = await verification.requireVerificationForProfessional('sp-2', 'private', 'u-1', runner);
    expect(r.applied).toBe(false);
    expect(runner.query).not.toHaveBeenCalled();
  });
});

// ── Welcome email ──────────────────────────────────────────────────────────────
describe('professional welcome email', () => {
  const emails = require('../src/services/professionalSellerEmails');
  test('confirms enrollment + names the remaining gated steps; no AI/vendor terms', () => {
    const m = emails.buildApplicationEmail({ companyName: 'Heritage & Home', sellerTypeLabel: 'Estate Sale Company' });
    expect(m.subject).toMatch(/Professional Seller/i);
    expect(m.html).toContain('Heritage &amp; Home');
    expect(m.html + m.text).toMatch(/verif/i);         // business verification step
    expect(m.html + m.text).toMatch(/agreement/i);     // agreement step
    expect(m.html + m.text).toMatch(/payout|Stripe Connect/i); // payout step
    expect(m.html + m.text).not.toMatch(/\bA\.?I\b|artificial intelligence|GPT|OpenAI/i);
  });
});

// ── Route safety (source-level) ────────────────────────────────────────────────
describe('POST /api/sellers/apply-professional — safety properties', () => {
  const src = read('src', 'routes', 'sellers.js');
  test('endpoint exists and is auth-gated', () => {
    expect(src).toMatch(/router\.post\('\/apply-professional', auth,/);
  });
  test('rejects non-professional/invalid types (never silently downgrades)', () => {
    expect(src).toMatch(/if \(!PROFESSIONAL_SELLER_TYPES\.includes\(sellerType\)\)/);
    expect(src).toMatch(/INVALID_PROFESSIONAL_TYPE/);
  });
  test('engages the publication verification gate for the professional type', () => {
    expect(src).toMatch(/requireVerificationForProfessional\(sellerProfileId, sellerType/);
    expect(src).toMatch(/verification_required: true/);
  });
  test('associates the seller\'s OWN org (no name-based takeover of imported shells)', () => {
    expect(src).toMatch(/getPrimaryOrgForUser\(req\.user\.id\)/);
    expect(src).toMatch(/onboardOrganization\(req\.user\.id/);
    expect(src).toMatch(/linked_seller_profile_id/);
    // never a fuzzy/name match-and-claim in this path
    expect(src).not.toMatch(/match_key|ILIKE|fuzzy|claimByName/);
  });
  test('individual /enroll path is unchanged (still forces self-serve types to private)', () => {
    expect(src).toMatch(/if \(!SELF_SERVE_SELLER_TYPES\.includes\(sellerType\)\) sellerType = 'private'/);
    expect(src).toMatch(/const SELF_SERVE_SELLER_TYPES = \['private', 'business', 'other'\]/);
  });
});

// ── Public landing page copy + safety ───────────────────────────────────────────
describe('professional-sellers.html landing', () => {
  const page = read('public', 'professional-sellers.html');
  test('states the certified flat 11% Storefront fee, NOT 8% + 3%', () => {
    expect(page).toMatch(/Flat 11%/);
    expect(page).not.toMatch(/8%\s*\+\s*3%/);
  });
  test('does not perpetuate the legacy auction-fee conflicts', () => {
    expect(page).not.toMatch(/no seller platform fee/i);
    expect(page).not.toMatch(/~?3% payment processing/i);
    expect(page).not.toMatch(/no minimum lot/i);
  });
  test('never routes professional selling through a BD membership checkout', () => {
    expect(page).not.toMatch(/\/checkout\/\d/);
    expect(page).not.toMatch(/sell-with-advantage/);
    expect(page).toMatch(/\/become-professional-seller\.html/);
  });
  test('offers optional read-only demos but never the writable demo-seller account', () => {
    expect(page).toMatch(/pro\/heritage-home-estate-services/);
    expect(page).toMatch(/0000000d0003/);
    expect(page).not.toMatch(/sales-demo-seller/);
  });
  test('payout copy uses "processed" (not guaranteed receipt) and Thursday cadence', () => {
    expect(page).toMatch(/process/i);
    expect(page).toMatch(/Thursday/);
  });
});

describe('become-professional-seller.html onboarding form', () => {
  const page = read('public', 'become-professional-seller.html');
  test('posts to the professional enrollment endpoint with a professional type', () => {
    expect(page).toMatch(/\/api\/sellers\/apply-professional/);
    ['auction_house', 'estate_sale_company', 'professional_liquidator'].forEach((t) => expect(page).toContain(t));
  });
  test('is resumable (routes to agreement or dashboard) and never a BD checkout', () => {
    expect(page).toMatch(/\/sign-agreement\.html\?onboarding=1/);
    expect(page).toMatch(/\/app\.html/);
    expect(page).not.toMatch(/\/checkout\/\d/);
  });
});

// ── Acquisition pages are public (not auth-gated) ───────────────────────────────
describe('htmlAuthGate — acquisition pages are public', () => {
  const gate = require('../src/middleware/htmlAuthGate');
  test('landing + onboarding pages are passthrough (null requirement)', () => {
    expect(gate.requirement('/professional-sellers.html')).toBeNull();
    expect(gate.requirement('/become-professional-seller.html')).toBeNull();
  });
  test('the seller dashboard remains seller-gated (unchanged)', () => {
    expect(gate.requirement('/seller-dashboard.html')).toEqual(expect.arrayContaining(['seller']));
  });
});
