'use strict';

/**
 * Phase 4B — professional provisioning. Pure decision logic + source-level guarantees for the scope
 * lock (event access only; never BD billing / subscriptions / duplicate org or user), plus the nav +
 * /me wiring that surfaces My Events / Create Event. No live DB (that is the prod verification step).
 *
 * Maps the required cases: 1/2 (first + repeat login = idempotent), 3 (existing user reused), 5 (org
 * matched by bd_listing_id), 6/7 (membership creation), 8 (owner role), 9/10 (events cap → Create/My
 * Events), 11 (buying preserved), 12 (ineligible gets nothing), 18/19 (no dup user/org), 20 (no
 * private-seller coercion). Lifecycle change cases (13–15) are covered by the idempotent capability
 * toggle + source assertions; live e2e is verified against production for Lewis & Maese.
 */

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const svc = require('../src/services/professionalProvisioningService');
const Nav = require('../public/widgets/shared/member-nav-config.js');
const ids = (arr) => arr.map((i) => i.id);

describe('ownership decision (pure) — never steal, always idempotent', () => {
  test('unowned org → create; same user → exists; other user → conflict', () => {
    expect(svc.decideMembership(null, 'u1')).toBe('create');
    expect(svc.decideMembership(undefined, 'u1')).toBe('create');
    expect(svc.decideMembership('u1', 'u1')).toBe('exists');        // repeat run = no-op (idempotent)
    expect(svc.decideMembership('u2', 'u1')).toBe('conflict');      // owned by another → refuse (no dup, no steal)
  });
});

describe('provisioning scope lock — grants ONLY marketplace event access', () => {
  const s = read('src', 'services', 'professionalProvisioningService.js');
  // Strip comments so "must NOT contain" assertions test the CODE, not the descriptive header.
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('grants exactly the events capability (system grant; provenance in the audit trail)', () => {
    expect(s).toContain("EVENT_CAPABILITY = 'events'");
    expect(s).toMatch(/setCapability\([^)]*EVENT_CAPABILITY,\s*true,\s*'grant'/); // source constrained to plan|grant|override
    expect(s).toMatch(/source:\s*'bd_professional'/); // provenance recorded in the audit metadata
  });
  test('creates owner membership idempotently on the EXISTING org (never a new organization)', () => {
    expect(s).toMatch(/INSERT INTO organization_members[\s\S]*'owner', 'active'/);
    expect(s).toMatch(/ON CONFLICT \(organization_id, user_id\) DO UPDATE SET role = 'owner', status = 'active'/);
    expect(s).not.toMatch(/INSERT INTO organizations/); // NEVER creates a duplicate org
  });
  test('resolves the org by bd_listing_id among imported shells only', () => {
    expect(s).toMatch(/bd_listing_id = \$1 AND source = 'bd_import'/);
  });
  test('never touches BD billing / subscriptions / seller subscription', () => {
    expect(code).not.toMatch(/subscription|stripe|billing|invoice|price|charge/i);
  });
  test('preserves the account: never changes the user role, never coerces a private seller', () => {
    expect(code).not.toMatch(/UPDATE users SET role|users\.role/i); // user role never changed (membership role is separate)
    expect(code).not.toMatch(/seller_profiles|seller_type|become-seller|sellers\/enroll/i); // buyer stays; no seller coercion
  });
  test('only sets a display name when the account has none (fixes the bridge placeholder)', () => {
    expect(s).toMatch(/full_name IS NULL OR full_name = ''/);
  });
  test('refuses to steal an org owned by another account', () => {
    expect(s).toMatch(/PROVISION_CONFLICT/);
    expect(s).toMatch(/already owned by another/i);
  });
  test('every provisioning is audited', () => {
    expect(s).toMatch(/auditService\.logEvent/);
    expect(s).toContain('organization.professional_provisioned');
  });
});

describe('backfill script — dry-run by default, Lewis & Maese first, reversible', () => {
  const b = read('scripts', 'provision-bd-professionals.js');
  test('defaults to dry-run; only writes with --apply', () => {
    expect(b).toMatch(/APPLY = process\.argv\.includes\('--apply'\)/);
    expect(b).toMatch(/DRY-RUN/);
  });
  test('name-prefix safety check prevents linking the wrong company', () => {
    expect(b).toMatch(/expectNameStartsWith/);
  });
  test('no blanket bulk apply (candidates listing is read-only)', () => {
    expect(b).not.toMatch(/for \(const .* of candidates\)[\s\S]*provision\(/);
  });
});

describe('dashboard nav — provisioned professionals get My Events / Create Event', () => {
  const PRO = { role: 'buyer', mode: 'buying', isEventOrganizer: true };

  test('My Events + Create Event appear for event organizers, with the org-workspace hrefs', () => {
    const v = Nav.visibleNavFor(PRO);
    const my = v.find((i) => i.id === 'events');
    const create = v.find((i) => i.id === 'createEvent');
    expect(my).toBeTruthy();
    expect(my.label).toBe('My Events');
    expect(my.href).toBe('/org/events.html');
    expect(create.label).toBe('Create Event');
    expect(create.href).toBe('/org/event-new.html');
    expect(my.external).toBe(true);
  });
  test('buying capability is preserved alongside event management (one account)', () => {
    const v = ids(Nav.visibleNavFor(PRO));
    for (const buyer of ['home', 'watchlist', 'auctions', 'purchases', 'account']) expect(v).toContain(buyer);
    expect(v).toContain('events'); // plus event management
  });
  test('non-organizers never see event items', () => {
    expect(ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying' }))).not.toContain('events');
    expect(ids(Nav.visibleNavFor({ role: 'buyer', mode: 'buying' }))).not.toContain('createEvent');
  });
  test('My Events is reachable on mobile (rail hidden ≤860px)', () => {
    expect(ids(Nav.primaryMobileNav(PRO))).toContain('events');
  });
  test('composes with the Business Administration return link', () => {
    const v = ids(Nav.visibleNavFor(Object.assign({ isBdMember: true, businessAdminUrl: 'https://www.advantage.bid/business-administration' }, PRO)));
    expect(v).toContain('events');
    expect(v).toContain('bizadmin');
  });
});

describe('professional-company events auto-publish (skip the review queue)', () => {
  const ev = read('src', 'services', 'eventsService.js');
  const code = ev.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  test('professional org types are recognized for direct publish', () => {
    expect(code).toMatch(/AUTO_PUBLISH_ORG_TYPES = new Set\(\[/);
    for (const t of ['auction_company', 'auction_house', 'estate_sale_company', 'professional_liquidator']) expect(ev).toContain(t);
  });
  test('submit() publishes directly for professional companies (member → published, no review)', () => {
    expect(code).toMatch(/if \(AUTO_PUBLISH_ORG_TYPES\.has\(orgType\)\)/);
    expect(code).toMatch(/SET status='published', submitted_at=now\(\), published_at=now\(\)/);
    expect(code).toMatch(/professional_company_auto_publish/);
  });
  test('non-professional organizers still go to review (submitted), and homeowner estate sales stay excluded', () => {
    expect(code).toMatch(/SET status='submitted'/);           // the review path still exists
    expect(code).toMatch(/ESTATE_SALE_PROMOTION_REQUIRED/);   // estate sales excluded upstream (paid, reviewed)
  });
});

describe('profile-editor containment — BD-managed businesses do not see the duplicate Railway profile editor', () => {
  const portal = read('public', 'org', 'portal.js');
  test('hides the Professional Profile tab for BD-managed business types only (appraisers keep it)', () => {
    expect(portal).toMatch(/_containProfileEditor/);
    expect(portal).toMatch(/bd_member/);
    expect(portal).toMatch(/_bdManagedBusinessTypes/);
    for (const t of ['auction_company', 'estate_sale_company', 'professional_liquidator']) expect(portal).toContain(t);
    expect(portal).toMatch(/removeChild/);                    // hides the tab
    expect(portal).toMatch(/active === 'profile'.*location\.replace/); // bounces off the hidden editor
  });
  test('does not delete the profile route or data (containment only)', () => {
    expect(portal).toContain('/org/profile.html'); // route still referenced (not removed)
    expect(portal).not.toMatch(/DELETE|drop|remove profile data/i);
  });
});

describe('/me exposes event_organizer (server-authoritative: org member + events capability)', () => {
  const auth = read('src', 'routes', 'auth.js');
  test('event_organizer derives from active org membership AND an enabled events capability', () => {
    expect(auth).toMatch(/EXISTS \(SELECT 1 FROM organization_members m[\s\S]*organization_capabilities c[\s\S]*c\.capability = 'events' AND c\.enabled = true\) AS event_organizer/);
    expect(auth).toContain('event_organizer: rows[0].event_organizer === true');
  });
});
