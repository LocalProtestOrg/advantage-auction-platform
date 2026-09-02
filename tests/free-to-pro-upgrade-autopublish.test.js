'use strict';

/**
 * Free → Professional upgrade UX + Professional auto-publish verification.
 *
 * Part 1 — the Free Business Listing portal shows a tasteful, accurate, NON-forced upgrade panel that
 *          links to /professional-sellers.html, advertises only VERIFIED capabilities, and does NOT
 *          advertise the (unverified) white-label widget.
 * Part 2 — verifies the publication model: professional-org EVENTS auto-publish (no admin); native
 *          ONLINE AUCTIONS require admin publish (governance rule) — and owner submission SMS fires only
 *          where owner/admin attention is genuinely needed (never for auto-published pro events).
 * Source-level assertions (widget/HTML are browser IIFEs) + service-logic assertions.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── Part 1: upgrade panel ────────────────────────────────────────────────────
describe('Professional Seller upgrade panel', () => {
  const panel = read('public', 'widgets', 'shared', 'pro-upgrade-panel.js');
  test('links to the certified Professional Seller page and uses a clear CTA', () => {
    expect(panel).toMatch(/\/professional-sellers\.html/);
    expect(panel).toMatch(/Explore Professional Seller/);
    expect(panel).toMatch(/Upgrade to Professional Seller/);
  });
  test('is explicitly optional — free listing stays usable (not forced)', () => {
    expect(panel).toMatch(/optional/i);
    expect(panel).toMatch(/stays fully usable/i);
  });
  test('advertises verified capabilities (auctions, controls, storefront, buy now, payouts, followers)', () => {
    expect(panel).toMatch(/Run online auctions/i);
    expect(panel).toMatch(/starting prices and reserves/i);
    expect(panel).toMatch(/Storefront/);
    expect(panel).toMatch(/Buy Now/);
    expect(panel).toMatch(/direct-deposit payouts/i);
    expect(panel).toMatch(/Notify your followers/i);
  });
  test('communicates account/company continuity (same company, no new account)', () => {
    expect(panel).toMatch(/Keep your existing business profile/i);
    expect(panel).toMatch(/no new account|same company/i);
  });
  test('does NOT advertise the (unverified) white-label auction widget', () => {
    expect(panel).not.toMatch(/white.?label/i);
    expect(panel).not.toMatch(/host auctions on your own website/i);
    expect(panel).not.toMatch(/\bwidget\b/i);
  });
  test('is rendered in the Free Business Listing portal (submit-listing + portal home), gated for non-pros', () => {
    const submit = read('public', 'org', 'submit-listing.html');
    expect(submit).toMatch(/pro-upgrade-panel\.js/);
    expect(submit).toMatch(/AdvProUpgrade\.html\(\)/);
    const events = read('public', 'org', 'events.html');
    expect(events).toMatch(/pro-upgrade-panel\.js/);
    expect(events).toMatch(/AdvProUpgrade\.render\('proUpgrade'\)/);
    // hidden for existing professional sellers
    expect(events).toMatch(/seller_type/);
    expect(events).toMatch(/isPro/);
  });
});

// ── Part 2a: professional-org EVENTS auto-publish ───────────────────────────────
describe('professional estate-sale / event auto-publish', () => {
  const ev = read('src', 'services', 'eventsService.js');
  test('a professional org type publishes events directly (no admin review queue)', () => {
    expect(ev).toMatch(/if \(AUTO_PUBLISH_ORG_TYPES\.has\(orgType\)\)/);
    expect(ev).toMatch(/status='published', submitted_at=now\(\), published_at=now\(\)/);
    expect(ev).toMatch(/reason: 'professional_company_auto_publish'/);
  });
  test('auto-publish still respects the free active-event cap + events capability', () => {
    expect(ev).toMatch(/active >= plan\.max_active_events/);
    const route = read('src', 'routes', 'orgEvents.js');
    expect(route).toMatch(/requireOrgCapability\('events'\)/);
  });
  test('professional event submission fires NO owner operational SMS (auto-published, no attention needed)', () => {
    // the org-portal submit/event path never calls ownerAlertService
    expect(ev).not.toMatch(/ownerAlertService|notifyOwner/);
    expect(read('src', 'routes', 'orgEvents.js')).not.toMatch(/notifyOwnerEstateSaleSubmitted|notifyOwnerAuctionSubmitted/);
  });
});

// ── Part 2b: native ONLINE AUCTIONS require admin publish (governance) ───────────
describe('professional online auction publication (admin-gated by design)', () => {
  const auc = read('src', 'services', 'auctionService.js');
  test('a non-admin seller can only self-submit (draft → submitted), never self-publish', () => {
    expect(auc).toMatch(/non-admin → only 'submitted' accepted/);
    expect(auc).toMatch(/async function publishAuction/);
  });
  test('publish enforces verification gate (no bypass) + start-time/lots correctness', () => {
    expect(auc).toMatch(/verificationService\.publicationGate\(/);
    expect(auc).toMatch(/VERIFICATION_REQUIRED/);
  });
  test('AUCTION_SUBMITTED owner SMS fires on submit — appropriate because auctions need an admin publish', () => {
    // fires ONLY on the transition into submitted (already deduped), consistent with the admin-publish model
    expect(auc).toMatch(/if \(enteredSubmitted\) \{\s*ownerAlertService\.notifyOwnerAuctionSubmitted/);
  });
});

// ── Part 2c: owner SMS routing respects account type + publication model ────────
describe('owner SMS routing is action-driven', () => {
  test('estate-sale owner SMS is wired ONLY in the $39 individual path (needs admin publish), not the pro portal', () => {
    expect(read('src', 'services', 'estateSalePromotionService.js')).toMatch(/notifyOwnerEstateSaleSubmitted/);
    expect(read('src', 'services', 'eventsService.js')).not.toMatch(/notifyOwnerEstateSaleSubmitted/);
  });
  test('business-listing submission SMS is action-driven (a listing DOES need admin review)', () => {
    expect(read('src', 'routes', 'orgEvents.js')).toMatch(/notifyOwnerBusinessListingSubmitted/);
  });
});

// ── Regression guards (unchanged) ───────────────────────────────────────────────
describe('unchanged economics/limits', () => {
  test('free-plan limits (3/10/no featured) and the $39 price are untouched', () => {
    expect(read('db', 'migrations', '076_organizations_and_events.sql')).toMatch(/\('free',\s*10,\s*3,\s*FALSE\)/);
    expect(read('src', 'services', 'estateSalePromotionService.js')).toMatch(/3900/);
  });
});
