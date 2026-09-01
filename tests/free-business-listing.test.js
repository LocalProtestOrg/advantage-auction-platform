'use strict';

/**
 * Free Business Listing self-service onboarding + Professional Seller upsell.
 *
 * Verifies the funnel is safe and the products stay separate:
 *   - free listing = free Railway org (free plan: events, no featured, no auction/payout capability);
 *   - creating/claiming never creates a BD membership and never grants transactional seller privileges;
 *   - claim reuses the existing authoritative claim lifecycle (0 caps until admin verification — no
 *     name-based takeover); a created org gets free-plan capabilities immediately;
 *   - the upsell points to /professional-sellers.html (never a BD checkout);
 *   - welcome email is deduped to the one-time create/claim transition;
 *   - pages are public; economics/other flows unchanged.
 * Source-level assertions (repo style) + focused unit tests.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-min-32-chars-aaaaaaaaaaaaaaaa';

// ── Free plan truth (migrations) ───────────────────────────────────────────────
describe('free organization plan (authoritative limits)', () => {
  const mig076 = read('db', 'migrations', '076_organizations_and_events.sql');
  const mig078 = read('db', 'migrations', '078_partner_foundation.sql');
  test('free plan: 3 active events, 10 images, no featured', () => {
    expect(mig076).toMatch(/\('free',\s*10,\s*3,\s*FALSE\)/);
    expect(mig076).toMatch(/plan_tier\s+TEXT NOT NULL DEFAULT 'free'/);
  });
  test('free plan grants organizations/events/widgets — NOT auctions/payouts', () => {
    expect(mig078).toMatch(/\('free','organizations'\),\('free','events'\),\('free','widgets'\)/);
    // free must not carry transactional seller capabilities
    expect(mig078).not.toMatch(/\('free','auctions'\)/);
    expect(mig078).not.toMatch(/\('free','imports'\)/);
  });
});

// ── Claim safety (reuses lifecycle; no name takeover; 0 caps) ───────────────────
describe('claim lifecycle is authoritative and safe', () => {
  const life = read('src', 'services', 'organizationLifecycleService.js');
  const claimRoute = read('src', 'routes', 'orgClaim.js');
  test('claim only claimable states, never steals an owned org, grants NO capabilities', () => {
    expect(life).toMatch(/\['prospect', 'directory_listing', 'inactive'\]\.includes\(org\.lifecycle_state\)/);
    expect(life).toMatch(/ALREADY_CLAIMED/);
    expect(life).toMatch(/NO capabilities granted at claim/i);
  });
  test('claim search exposes public-safe fields only (no contact PII in results)', () => {
    expect(claimRoute).toMatch(/SELECT id, name, city, state, website_url FROM organizations/);
    // the search SELECT must not return contact PII columns
    expect(claimRoute).not.toMatch(/SELECT[^;]*contact_email/i);
    expect(claimRoute).not.toMatch(/SELECT[^;]*contact_phone/i);
  });
});

// ── Create path (auto-onboard) grants free plan, not seller privilege ───────────
describe('create path grants the free plan only', () => {
  const orgEvents = read('src', 'routes', 'orgEvents.js');
  const orgsSvc = read('src', 'services', 'organizationsService.js');
  test('POST /api/org/profile auto-onboards the org (no separate account system)', () => {
    expect(orgEvents).toMatch(/if \(!org\) org = await orgsService\.onboardOrganization\(req\.user\.id, b\)/);
  });
  test('onboardOrganization grants ONLY the plan capabilities (no auctions/payouts)', () => {
    expect(orgsSvc).toMatch(/grantPlanCapabilities\(org\.id, org\.plan_tier/);
    expect(orgsSvc).not.toMatch(/INSERT INTO seller_profiles/); // creating a free org never creates a seller_profile
  });
});

// ── Welcome email dedupe + content ─────────────────────────────────────────────
describe('free-listing welcome email', () => {
  const emails = require('../src/services/businessListingEmails');
  const orgEvents = read('src', 'routes', 'orgEvents.js');
  const claimRoute = read('src', 'routes', 'orgClaim.js');
  test('builder: names what they can manage + mentions optional Pro upgrade; no AI/vendor terms', () => {
    const m = emails.buildWelcomeEmail({ companyName: 'Heritage & Home', claimed: false });
    expect(m.subject).toMatch(/business listing/i);
    expect(m.html).toContain('Heritage &amp; Home');
    expect(m.html + m.text).toMatch(/professional-sellers\.html/);
    expect(m.html + m.text).toMatch(/never required/i);            // Pro is optional, not required
    expect(m.html + m.text).not.toMatch(/\bA\.?I\b|GPT|OpenAI/i);
  });
  test('sent once — only on the create transition and the successful claim transition', () => {
    expect(orgEvents).toMatch(/if \(created\) \{[\s\S]*?buildWelcomeEmail\(\{ companyName: org\.name, claimed: false \}\)/);
    expect(claimRoute).toMatch(/buildWelcomeEmail\(\{ companyName: org\.name, claimed: true \}\)/);
  });
});

// ── Public landing page ─────────────────────────────────────────────────────────
describe('free-business-listing.html landing', () => {
  const page = read('public', 'free-business-listing.html');
  test('states $0 / no monthly membership and accurate free-plan limits', () => {
    expect(page).toMatch(/\$0/);
    expect(page).toMatch(/no monthly membership/i);
    expect(page).toMatch(/3 active/i);        // accurate cap, not "unlimited"
    expect(page).not.toMatch(/unlimited events/i);
    expect(page).toMatch(/Featured[\s\S]{0,60}not[\s\S]{0,30}included/i); // featured not included
  });
  test('keeps products separate and never sends into a BD membership checkout', () => {
    expect(page).toMatch(/Professional Seller/);
    expect(page).toMatch(/\/professional-sellers\.html/);
    expect(page).toMatch(/\/get-listed\.html/);
    expect(page).not.toMatch(/\/checkout\/\d/);
    expect(page).not.toMatch(/sell-with-advantage/);
  });
});

// ── Front-door: search / claim / create ─────────────────────────────────────────
describe('get-listed.html front-door', () => {
  const page = read('public', 'get-listed.html');
  test('searches existing businesses and claims via the authoritative API', () => {
    expect(page).toMatch(/\/api\/org\/claim\/search/);
    expect(page).toMatch(/\/api\/org\/claim\//);
  });
  test('offers create-new (routes to the existing portal editor) and reuses an existing org (no duplicate)', () => {
    expect(page).toMatch(/\/org\/profile\.html\?new=1/);
    expect(page).toMatch(/\/api\/org\/profile/);   // detects an org the user already manages
    expect(page).toMatch(/already manage/i);
  });
  test('explains claim → verification-gated publishing (no takeover), and no BD checkout', () => {
    expect(page).toMatch(/verif/i);
    expect(page).not.toMatch(/\/checkout\/\d/);
  });
});

// ── Portal upsell ───────────────────────────────────────────────────────────────
describe('portal Professional Seller upsell', () => {
  const portal = read('public', 'org', 'portal.js');
  test('header links to the Pro page (tasteful, not a BD checkout)', () => {
    expect(portal).toMatch(/\/professional-sellers\.html/);
    expect(portal).not.toMatch(/\/checkout\/\d/);
  });
});

// ── Pages are public ─────────────────────────────────────────────────────────────
describe('htmlAuthGate — acquisition pages are public', () => {
  const gate = require('../src/middleware/htmlAuthGate');
  test('landing + front-door are passthrough; the org portal stays gated', () => {
    expect(gate.requirement('/free-business-listing.html')).toBeNull();
    expect(gate.requirement('/get-listed.html')).toBeNull();
    // /org/ portal remains behind auth (any signed-in role)
    expect(gate.requirement('/org/profile.html')).toEqual(expect.arrayContaining(['buyer', 'seller', 'admin']));
  });
});

// ── Event-import authorization NOT introduced by this funnel ─────────────────────
describe('claiming/creating does NOT authorize website/feed event ingestion', () => {
  test('no ingestion-authorization writes were added to the funnel', () => {
    const claimRoute = read('src', 'routes', 'orgClaim.js');
    const orgEvents = read('src', 'routes', 'orgEvents.js');
    const life = read('src', 'services', 'organizationLifecycleService.js');
    [claimRoute, orgEvents, life].forEach((s) => {
      expect(s).not.toMatch(/event_authoriz|feed_authoriz|ingest.*authoriz|website_ingest/i);
    });
  });
});
