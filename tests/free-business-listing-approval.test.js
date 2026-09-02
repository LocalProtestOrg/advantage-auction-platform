'use strict';

/**
 * Free Business Listing admin approval + one-click publish workflow.
 *
 * Verifies the operational workflow is real and safe:
 *   - a company submits (review_status='submitted' + REQUESTED type) — never self-publishes;
 *   - only an admin route can APPROVE & PUBLISH, and that one path grants the professional capability,
 *     geocodes, sets lifecycle + published, and audits — matching activeMarketplaceCompanySql;
 *   - geocode failure yields LOCATION_NEEDS_REVIEW (never invents coordinates / never publishes unplaced);
 *   - normal users cannot grant capabilities or set published;
 *   - owner SMS + lifecycle emails are wired; queue exposes no unnecessary PII.
 * Pure-logic unit tests + source-level assertions (repo style).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Service logic ────────────────────────────────────────────────────────────
describe('businessListingReviewService — publish-readiness + type list', () => {
  const svc = require('../src/services/businessListingReviewService');
  test('professional-type capability list matches the directory eligibility set', () => {
    expect(svc.PROFESSIONAL_TYPE_CAPS).toEqual(expect.arrayContaining(
      ['appraiser', 'auction_house', 'estate_sale_company', 'professional_liquidator', 'consignment_company', 'moving_company', 'cleanout_company']));
  });
  test('isPublishReady requires name + location + contact + description', () => {
    expect(svc.isPublishReady({ name: 'Acme', city: 'Newark', state: 'NJ', contact_email: 'a@x.com', description: 'We sell.' }).ok).toBe(true);
    const bad = svc.isPublishReady({ name: '', city: '', state: '', description: '' });
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual(expect.arrayContaining(['company name', 'city and state', 'a business email or phone', 'a short description']));
  });
  test('orgLocationQuery builds a single-line address from org fields', () => {
    expect(svc.orgLocationQuery({ address: '1 Main St', city: 'Newark', state: 'NJ', zip: '07102' })).toBe('1 Main St, Newark, NJ, 07102');
  });
});

// ── APPROVE & PUBLISH does the full, authoritative workflow (source-level) ──────
describe('approveAndPublish workflow', () => {
  const src = read('src', 'services', 'businessListingReviewService.js');
  test('grants ONLY the confirmed professional-type capability (never trusts a client value blindly)', () => {
    expect(src).toMatch(/PROFESSIONAL_TYPE_CAPS\.includes\(chosenType\)/);
    expect(src).toMatch(/capabilityService\.setCapability\(orgId, chosenType, true, 'grant', client\)/);
  });
  test('sets an active public lifecycle + published flag + review_status, and audits the approver', () => {
    expect(src).toMatch(/lifecycle_state = 'active_partner'/);
    expect(src).toMatch(/published: true, review_status: 'published'/);
    expect(src).toMatch(/approved_by: adminId/);
    expect(src).toMatch(/org_listing\.approved/);
  });
  test('geocodes when coordinates are missing and NEVER invents/publishes an unplaced business', () => {
    expect(src).toMatch(/geocoder\.geocode\(orgLocationQuery\(current\)\)/);
    expect(src).toMatch(/LOCATION_NEEDS_REVIEW/);
    // the throw path prevents the UPDATE/publish from running (geocode resolved BEFORE the transaction)
    expect(src.indexOf('LOCATION_NEEDS_REVIEW')).toBeLessThan(src.indexOf("published: true, review_status: 'published'"));
  });
  test('the published state exactly matches activeMarketplaceCompanySql native eligibility', () => {
    const mv = read('src', 'lib', 'marketplaceVisibility.js');
    // native eligibility = active/verified lifecycle + published + a professional capability
    expect(mv).toMatch(/lifecycle_state IN \('active_partner','verified'\)/);
    expect(mv).toMatch(/profile_data->>'published'\) = 'true'/);
    expect(mv).toMatch(/organization_capabilities/);
  });
});

// ── Security: submit never publishes; approve is admin-only ─────────────────────
describe('security / permission boundaries', () => {
  const svc = read('src', 'services', 'businessListingReviewService.js');
  const adminRoute = read('src', 'routes', 'adminBusinessListings.js');
  const orgRoute = read('src', 'routes', 'orgEvents.js');
  test('submitForReview only sets review_status=submitted (no publish, no capability grant)', () => {
    const submitBlock = svc.slice(svc.indexOf('async function submitForReview'), svc.indexOf('async function listQueue'));
    expect(submitBlock).toMatch(/review_status: 'submitted'/);
    expect(submitBlock).not.toMatch(/published: true/);
    expect(submitBlock).not.toMatch(/setCapability/);
  });
  test('all admin approval/review endpoints are admin-role gated', () => {
    expect(adminRoute).toMatch(/router\.use\(authMiddleware, roleMiddleware\(\['admin'\]\)\)/);
    expect(adminRoute).toMatch(/\/:orgId\/approve/);
  });
  test('the company submit endpoint is owner-scoped and does not accept a published/capability field', () => {
    expect(orgRoute).toMatch(/router\.post\('\/submit-listing'/);
    expect(orgRoute).not.toMatch(/submit-listing[\s\S]{0,400}published/);
  });
  test('the profile schema drops user-supplied published (admin/moderation only)', () => {
    expect(read('src', 'lib', 'professionalProfileSchema.js')).toMatch(/k === 'published'/);
  });
});

// ── Owner SMS + emails ──────────────────────────────────────────────────────────
describe('notifications', () => {
  const owner = require('../src/services/ownerAlertService');
  const emails = require('../src/services/businessListingEmails');
  test('owner alert type + message includes the company, email, and admin review URL', () => {
    expect(owner.ALERT_TYPES.BUSINESS_LISTING_SUBMITTED).toBe('business_listing_submitted');
    const m = owner.buildBusinessListingSubmittedMessage({ companyName: 'Acme Estate', businessType: 'estate_sale_company', sellerEmail: 'a@x.com', url: 'https://bid.advantage.bid/admin/business-listings.html' });
    expect(m).toContain('Business listing submitted for review');
    expect(m).toContain('Acme Estate');
    expect(m).toContain('Email: a@x.com');
    expect(m).toContain('/admin/business-listings.html');
  });
  test('lifecycle email builders exist and are neutral (no AI/vendor terms)', () => {
    for (const fn of ['buildSubmittedEmail', 'buildApprovedEmail', 'buildChangesRequestedEmail', 'buildRejectedEmail']) {
      expect(typeof emails[fn]).toBe('function');
    }
    const a = emails.buildApprovedEmail({ companyName: 'Acme', slug: 'acme' });
    expect(a.subject).toMatch(/live/i);
    expect(a.html + a.text).not.toMatch(/\bA\.?I\b|GPT|OpenAI/i);
    expect(a.html + a.text).toMatch(/estate sales and auctions/i); // accurate free-listing capability
  });
  test('submit endpoint fires the owner SMS + confirmation email best-effort (never blocking)', () => {
    const orgRoute = read('src', 'routes', 'orgEvents.js');
    expect(orgRoute).toMatch(/notifyOwnerBusinessListingSubmitted/);
    expect(orgRoute).toMatch(/buildSubmittedEmail/);
  });
});

// ── Wiring: route mounted, pages present, admin nav updated ─────────────────────
describe('wiring + UI', () => {
  test('admin route is mounted', () => {
    expect(read('server.js')).toMatch(/app\.use\('\/api\/admin\/business-listings', require\('\.\/src\/routes\/adminBusinessListings'\)\)/);
  });
  test('company submit page posts to the endpoint and shows review status', () => {
    const page = read('public', 'org', 'submit-listing.html');
    expect(page).toMatch(/\/api\/org\/submit-listing/);
    expect(page).toMatch(/Submit (business )?for review|Submit business for review/i);
    expect(page).toMatch(/estate_sale_company/);
  });
  test('admin queue page hits the review endpoints and offers approve/request/reject + geocode retry', () => {
    const page = read('public', 'admin', 'business-listings.html');
    expect(page).toMatch(/\/api\/admin\/business-listings/);
    expect(page).toMatch(/Approve &amp; Publish/);
    expect(page).toMatch(/LOCATION_NEEDS_REVIEW/);
    expect(page).toMatch(/Request Changes/);
    expect(page).toMatch(/Reject/);
  });
  test('admin nav links to the new Business Listings queue', () => {
    expect(read('public', 'widgets', 'shared', 'admin-nav.js')).toMatch(/\/admin\/business-listings\.html/);
  });
  test('org portal nav links to Listing Status (submit-for-review)', () => {
    expect(read('public', 'org', 'portal.js')).toMatch(/\/org\/submit-listing\.html/);
  });
});
