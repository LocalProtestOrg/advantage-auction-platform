'use strict';

/**
 * Professional Seller online-auction AUTO-PUBLISH + informational owner SMS.
 *
 * Verifies the owner-decided governance change: a VERIFIED + ACTIVE + ELIGIBLE Professional Seller
 * publishes their own qualifying auction directly (no routine Admin approval); Individual/Private sellers
 * keep the submission→review path; publicationGate stays authoritative; eligibility is server-side (no
 * client authority; no cross-tenant publish); exactly one informational SMS fires (no duplicate
 * AUCTION_SUBMITTED); SMS is best-effort/non-blocking; a published auction is widget/feed-visible via the
 * existing visibility predicate. Pure-logic unit tests + source-level assertions (repo style).
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Eligibility is server-authoritative (auctionService source) ─────────────────
describe('professionalAutoPublishEligibility', () => {
  const src = read('src', 'services', 'auctionService.js');
  test('derives from authoritative auction→seller_profile→user records (never client input)', () => {
    expect(src).toMatch(/FROM auctions a\s+JOIN seller_profiles sp ON sp\.id = a\.seller_id\s+JOIN users u ON u\.id = sp\.user_id/);
    expect(src).toMatch(/professionalAutoPublishEligibility\(auctionId, userId\)/);
  });
  test('requires ownership, a professional type, an active account, and an unblocked publication gate', () => {
    expect(src).toMatch(/String\(row\.owner_id\) === String\(userId\)/);   // ownership
    expect(src).toMatch(/!isProfessional\(row\.seller_type\)/);            // professional type
    expect(src).toMatch(/row\.is_active === false/);                       // active/not-suspended
    expect(src).toMatch(/verificationService\.publicationGate\(row\.seller_profile_id\)/); // verified
    expect(src).toMatch(/reason: 'verification_required'/);
  });
});

// ── sellerSubmitAuction: publish for eligible pro, submit otherwise; no dup SMS ──
describe('sellerSubmitAuction', () => {
  const src = read('src', 'services', 'auctionService.js');
  test('rejects a non-owner (403) — cross-tenant publish is impossible', () => {
    expect(src).toMatch(/elig\.reason === 'not_owner'.*status = 403/s);
  });
  test('eligible pro path uses the single publishAuction authority + fires ONLY the professional SMS', () => {
    const block = src.slice(src.indexOf('async function sellerSubmitAuction'), src.indexOf('module.exports'));
    expect(block).toMatch(/if \(elig\.eligible\) \{[\s\S]*?await publishAuction\(auctionId, userId\)/);
    expect(block).toMatch(/notifyOwnerProfessionalAuctionPublished\(auctionId\)\.catch\(\(\) => \{\}\)/);
    // the eligible branch must NOT go through updateAuction (which would fire AUCTION_SUBMITTED)
    const eligBranch = block.slice(block.indexOf('if (elig.eligible)'), block.indexOf('// Ineligible'));
    expect(eligBranch).not.toMatch(/updateAuction/);
    expect(eligBranch).not.toMatch(/notifyOwnerAuctionSubmitted/);
  });
  test('ineligible / individual path uses the existing submit-for-review (updateAuction → AUCTION_SUBMITTED)', () => {
    const block = src.slice(src.indexOf('async function sellerSubmitAuction'), src.indexOf('module.exports'));
    expect(block).toMatch(/updateAuction\(auctionId, userId, \{ state: 'submitted' \}, 'seller'\)/);
    expect(block).toMatch(/auto_published: false/);
  });
  test('the SMS fires AFTER publishAuction succeeds (retry hits already-published first → dedupe)', () => {
    const block = src.slice(src.indexOf('async function sellerSubmitAuction'), src.indexOf('module.exports'));
    expect(block.indexOf('await publishAuction')).toBeLessThan(block.indexOf('notifyOwnerProfessionalAuctionPublished'));
  });
});

// ── publicationGate remains authoritative in the publish path ───────────────────
describe('publicationGate is not bypassed', () => {
  const src = read('src', 'services', 'auctionService.js');
  test('publishAuction still enforces the verification gate + start-time + lots', () => {
    const pub = src.slice(src.indexOf('async function publishAuction'), src.indexOf('async function professionalAutoPublishEligibility'));
    expect(pub).toMatch(/verificationService\.publicationGate\(/);
    expect(pub).toMatch(/VERIFICATION_REQUIRED/);
    expect(pub).toMatch(/START_TIME_REQUIRED/);
    expect(pub).toMatch(/AUCTION_HAS_NO_LOTS/);
  });
});

// ── Route: server-enforced, no client authority ────────────────────────────────
describe('POST /api/auctions/:auctionId/submit', () => {
  const r = read('src', 'routes', 'auctions.js');
  test('is auth-gated + ownership-gated and calls the service with the authenticated user id', () => {
    expect(r).toMatch(/router\.post\('\/:auctionId\/submit', authMiddleware,/);
    expect(r).toMatch(/canMutateAuction\(req\.user\.id, req\.user\.role, auctionId\)/);
    expect(r).toMatch(/sellerSubmitAuction\(auctionId, req\.user\.id\)/);
  });
  test('never reads seller/org/professional/verified/publish flags from the client', () => {
    const block = r.slice(r.indexOf("'/:auctionId/submit'"), r.indexOf('Walkthrough video ownership helper'));
    expect(block).not.toMatch(/req\.body\.(seller|organization|org|verified|professional|publish|state)/);
  });
  test('surfaces publish-validation codes and maps already-published to 409', () => {
    expect(r).toMatch(/err\.status && err\.code/);
    expect(r).toMatch(/ALREADY_PUBLISHED/);
  });
});

// ── Owner informational SMS ─────────────────────────────────────────────────────
describe('PROFESSIONAL_AUCTION_PUBLISHED owner SMS', () => {
  const owner = require('../src/services/ownerAlertService');
  test('alert type exists; message includes company/title/state/lots/email + admin review URL', () => {
    expect(owner.ALERT_TYPES.PROFESSIONAL_AUCTION_PUBLISHED).toBe('professional_auction_published');
    const m = owner.buildProfessionalAuctionPublishedMessage({ companyName: 'Heritage & Home', title: 'Maplewood', state: 'NJ', lots: 146, sellerEmail: 's@x.com', url: 'https://bid.advantage.bid/admin/moderation.html' });
    expect(m).toMatch(/Professional auction published/);
    expect(m).toMatch(/Maplewood/);
    expect(m).toMatch(/Seller: Heritage & Home/);
    expect(m).toMatch(/Email: s@x\.com/);
    expect(m).toMatch(/State: NJ/);
    expect(m).toMatch(/Lots: 146/);
    expect(m).toMatch(/\/admin\/moderation\.html/);
  });
  test('does NOT fabricate a compliance flag count (compliance system not built)', () => {
    const m = owner.buildProfessionalAuctionPublishedMessage({ companyName: 'A', title: 'B', state: 'NJ', lots: 2, sellerEmail: 'e@x.com', url: 'u' });
    expect(m).not.toMatch(/compliance|flag/i);
  });
  test('notify is best-effort (try/catch) and inert without OWNER_ALERT_PHONE_E164', () => {
    const src = read('src', 'services', 'ownerAlertService.js');
    expect(src).toMatch(/async function notifyOwnerProfessionalAuctionPublished/);
    expect(src).toMatch(/if \(!ownerAlertConfigured\(\)\) return sendOwnerAlert\(ALERT_TYPES\.PROFESSIONAL_AUCTION_PUBLISHED, ''\)/);
    // caller (auctionService) never lets an SMS error block publication
    expect(read('src', 'services', 'auctionService.js')).toMatch(/notifyOwnerProfessionalAuctionPublished\(auctionId\)\.catch\(\(\) => \{\}\)/);
  });
});

// ── Widget/feed visibility (existing predicate — no second sync) ────────────────
describe('auto-published auction is widget/feed visible via existing visibility logic', () => {
  test('published+syndicated auctions match activeNativeAuctionSql (default marketplace_status=syndicated)', () => {
    expect(read('db', 'migrations', '078_partner_foundation.sql')).toMatch(/marketplace_status\s+TEXT NOT NULL DEFAULT 'syndicated'/);
    expect(read('src', 'lib', 'marketplaceVisibility.js')).toMatch(/state IN \('published','active'\).*marketplace_status = 'syndicated'/s);
    // the widget feed uses that same predicate (no separate sync)
    expect(read('src', 'services', 'widgetService.js')).toMatch(/activeNativeAuctionSql/);
  });
});

// ── UX copy + governance doc ────────────────────────────────────────────────────
describe('seller UX + governance doc', () => {
  test('dashboard submit posts to /submit; pros see Publish, individuals keep Submit for review', () => {
    const d = read('public', 'seller-dashboard.html');
    expect(d).toMatch(/\/api\/auctions\/' \+ auctionId \+ '\/submit'/);
    expect(d).toMatch(/isProfessionalSeller\(\) \? 'Publish Auction' : 'Submit for AAC Review'/);
    expect(d).toMatch(/Your auction is now live on Advantage\.Bid/);
    expect(d).toMatch(/Submit .* to Advantage for review/); // individual copy preserved
  });
  test('CLAUDE.md governance reflects the new verified-pro self-publish rule', () => {
    const c = read('CLAUDE.md');
    expect(c).toMatch(/Professional Sellers may publish their own qualifying auctions directly/);
    expect(c).toMatch(/retains full post-publication moderation/i);
    expect(c).not.toMatch(/^- Advantage publishes auctions, not sellers$/m); // old blanket rule removed
  });
});

// ── Regression guards ───────────────────────────────────────────────────────────
describe('regression', () => {
  test('individual submit still fires AUCTION_SUBMITTED via updateAuction (unchanged)', () => {
    expect(read('src', 'services', 'auctionService.js')).toMatch(/if \(enteredSubmitted\) \{\s*ownerAlertService\.notifyOwnerAuctionSubmitted\(auctionId\)/);
  });
  test('admin publication path is unchanged (publishAuction still called from admin route)', () => {
    expect(read('src', 'routes', 'admin.js')).toMatch(/auctionService\.publishAuction\(auctionId, req\.user\.id,/); // now passes admin override options (actorRole+reason)
  });
});
