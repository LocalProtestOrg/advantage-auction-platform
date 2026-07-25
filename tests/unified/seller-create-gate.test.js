'use strict';

/**
 * Launch blocker: the Create Auction form must not be viewable or submittable until the member has a
 * seller profile AND holds current Seller Agreement access. Backend is authoritative; frontend gates
 * the form (no red "contact support", no partially-usable fields).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

describe('backend authorization — POST /api/auctions (server-authoritative, no partial records)', () => {
  const src = read('src', 'routes', 'auctions.js');
  const post = src.slice(src.indexOf("router.post('/'"), src.indexOf('createAuction({'));
  test('verifies the seller profile belongs to the user (403 if not)', () => {
    expect(post).toContain('SELECT id FROM seller_profiles WHERE id = $1 AND user_id = $2');
    expect(post).toContain('not authorized');
  });
  test('enforces the Seller Agreement gate before creating (403 AGREEMENT_REQUIRED)', () => {
    expect(post).toContain('agreementService.dashboardAccess');
    expect(post).toContain('AGREEMENT_REQUIRED');
  });
  test('both checks run BEFORE auctionService.createAuction (no partial auction on rejection)', () => {
    const ownerIdx = src.indexOf('seller_profiles WHERE id = $1 AND user_id = $2');
    const gateIdx = src.indexOf('agreementService.dashboardAccess');
    const createIdx = src.indexOf('auctionService.createAuction({');
    expect(ownerIdx).toBeGreaterThan(0);
    expect(ownerIdx).toBeLessThan(createIdx);
    expect(gateIdx).toBeLessThan(createIdx);
  });
});

describe('frontend gate — seller-create.html shows onboarding, not the form, for States 1 & 2', () => {
  const html = read('public', 'seller-create.html');
  test('the form card is hidden by default and only revealed for authorized sellers', () => {
    expect(html).toContain('id="create-card" style="display:none"');
    expect(html).toContain('function revealCreateForm');
  });
  test('gate decision uses the authoritative onboarding-status endpoint', () => {
    expect(html).toContain("/api/agreements/onboarding-status");
    expect(html).toMatch(/is_seller === false\)\s*\{\s*showSellerGate\('not_seller'\)/);
    expect(html).toMatch(/dashboard_access === false\)\s*\{\s*showSellerGate\('needs_agreement'\)/);
  });
  test('State 1 → "Become a Seller"; State 2 → "Complete Seller Setup" (agreement)', () => {
    expect(html).toContain('Become a Seller');
    expect(html).toContain('/become-seller.html?next=');
    expect(html).toContain('Complete Seller Setup');
    expect(html).toContain('/sign-agreement.html?onboarding=1');
  });
  test('the legacy red "Seller profile not found. Contact support." state is gone', () => {
    expect(html).not.toContain('Seller profile not found. Contact support.');
  });
  test('logged-out visitors are routed to login, not shown the form', () => {
    expect(html).toMatch(/if \(!token\)\s*\{\s*location\.href = '\/login\.html\?next='/);
  });
  test('a clear path back to the member dashboard is provided', () => {
    expect(html).toContain('Back to my dashboard');
    expect(html).toContain('href="/app.html"');
  });
});
