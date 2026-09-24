'use strict';

/**
 * Claimed Listing — platform integrity: migrations are additive and ship OFF, RBAC and financial fields,
 * the Public Language Standard, the canonical visibility rule, attribution, activation, the review of
 * identity changes, SEO/canonical fixes and wiring.
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));

describe('migrations 169 and 170', () => {
  const m169 = read('db/migrations/169_company_identity_and_journeys.sql');
  const m170 = read('db/migrations/170_claimed_listing_system.sql');
  const body = (m) => m.replace(/--.*$/gm, '');
  test('additive and idempotent: no DROP TABLE, no DELETE, no TRUNCATE; IF NOT EXISTS throughout', () => {
    for (const m of [m169, m170]) {
      expect(body(m)).not.toMatch(/DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i);
      expect(body(m)).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    }
  });
  test('no Event Partner row is written and no member commercial data is touched', () => {
    for (const m of [m169, m170]) {
      expect(body(m)).not.toMatch(/INSERT INTO event_partner|UPDATE event_partner/i);
      expect(body(m)).not.toMatch(/professional_pricing_agreements|platform_fee|seller_profiles SET/i);
    }
  });
  test('every switch ships OFF and the postal address is empty (the gate fails closed)', () => {
    for (const k of ['sending_enabled', 'inbound_enabled', 'activation_emails_enabled', 'self_request_enabled']) {
      expect(m170).toMatch(new RegExp("\\('claimed_listings\\." + k + "',\\s*'false'::jsonb"));
    }
    expect(m170).toMatch(/\('company\.postal_address',\s+'""'::jsonb/);
    expect(m170).toMatch(/ON CONFLICT \(key\) DO NOTHING/);   // an existing Owner value is never overwritten
  });
  test('the listing stream joins the SES stream vocabulary; the 41 verified badge listings are held for review', () => {
    expect(m170).toMatch(/'transactional','marketing','event_partner','claimed_listing'/);
    const ids = JSON.parse(m170.match(/'claimed_listings\.paid_badge_bd_listing_ids', '(\[[^']+\])'/)[1]);
    expect(ids.length).toBe(41);
    expect(ids).not.toContain('350');   // Lewis & Maese: a real paid member, preserved
    expect(ids).not.toContain('28');    // Advantage's own listing
  });
});

describe('RBAC', () => {
  const rbac = require('../../src/lib/rbac');
  test('marketing staff can view and work listings; approvals and journeys are Super Admin only', () => {
    const mkt = { staff_role: 'marketing', staff_active: true };
    expect(rbac.hasPermission(mkt, 'listings.view')).toBe(true);
    expect(rbac.hasPermission(mkt, 'listings.work')).toBe(true);
    expect(rbac.hasPermission(mkt, 'listings.approve_cohort')).toBe(false);
    expect(rbac.hasPermission(mkt, 'listings.manage_journey')).toBe(false);
    expect(rbac.hasPermission({ role: 'admin' }, 'listings.manage_journey')).toBe(true);
    expect(rbac.hasPermission({ staff_role: 'finance', staff_active: true }, 'listings.view')).toBe(false);
  });
  test('every admin route is behind listings.view, and write routes behind the narrower permission', () => {
    const r = code('src/routes/adminClaimedListings.js');
    expect(r).toMatch(/router\.use\(auth, requirePermission\('listings\.view'\)\)/);
    for (const [route, perm] of [["'/program'", 'approve'], ["'/templates/:id/approve'", 'approve'], ["'/identity/apply'", 'journeyPerm'],
      ["'/company/:orgId/assisted-claim'", 'journeyPerm'], ["'/profile-changes/:id'", 'journeyPerm'], ["'/company/:orgId/lock'", 'work']]) {
      const re = new RegExp('router\\.post\\(' + route.replace(/[/:]/g, (c) => '\\' + c) + '[^\\n]{0,80}?' + perm + '\\b');
      expect(r).toMatch(re);
    }
    expect(r).toMatch(/START-CLAIMED-LISTING-OUTREACH/);   // turning sending on needs an explicit phrase
  });
  test('no package economics or financial fields reach the Toolbox', () => {
    for (const f of ['src/services/claimedListings/toolboxService.js', 'src/routes/adminClaimedListings.js', 'public/admin/claimed-listings-tab.js']) {
      expect(code(f)).not.toMatch(/platform_fee|fee_bps|pricing_agreement|price_cents|amount_cents|payout|settlement|revenue/i);
    }
  });
});

describe('Public Language Standard', () => {
  const surfaces = ['src/routes/claimListing.js', 'public/claim-listing.html', 'public/admin/claimed-listings-tab.js', 'public/org/listing-checklist.js',
    'src/services/claimedListings/templates.js', 'src/routes/publicListings.js', 'src/services/businessListingEmails.js'];
  test('no AI terminology and no vendor or infrastructure names on any new rendered surface', () => {
    for (const f of surfaces) {
      const s = code(f);
      expect(s).not.toMatch(/\bA\.?I\b|artificial intelligence|machine learning|\bGPT\b|OpenAI|\bLLM\b/);
      expect(s).not.toMatch(/Cloudinary|Railway|\bNeon\b|Postmark|Amazon SES|\bAWS\b|nodemailer/i);
    }
  });
  test('no em dashes in any new rendered copy', () => {
    for (const f of surfaces) expect(code(f)).not.toMatch(/—/);
  });
});

describe('visibility and SEO', () => {
  test('a removal request hides the company everywhere through the ONE canonical predicate (reversible)', () => {
    const v = read('src/lib/marketplaceVisibility.js');
    expect(v).toMatch(/COALESCE\(\$\{alias\}\.profile_data->>'hidden_by_request', 'false'\) <> 'true'/);
    const r = read('src/routes/adminClaimedListings.js');
    expect(r).toMatch(/'hidden_by_request', \$2::boolean/);
  });
  test('the company profile points its canonical at the directory page and uses an absolute image URL', () => {
    const page = read('public/pro.html');
    expect(page).toMatch(/new URL\(u,location\.origin\)\.href/);
    expect(page).toMatch(/cl\.href=p\.listing\.canonical_url/);
    expect(page).toMatch(/Listing created from public information/);
    expect(read('src/routes/public.js')).toMatch(/canonical_url: mpProfileUrl\(org\.bd_profile_path\)/);
  });
});

describe('attribution', () => {
  const acq = require('../../src/services/claimedListings/acquisitionService');
  test('the hard link token → message → sequence → cohort is written once, never overwritten', async () => {
    const calls = [];
    const runner = { query: async (sql, p) => { calls.push({ sql, p });
      if (/FROM organization_claim_tokens WHERE id/.test(sql)) return { rows: [{ id: 't1', issue_channel: 'outreach' }] };
      if (/FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences/.test(sql)) return { rows: [{ id: 'm1', sequence_id: 's1', template_key: 'E1', template_version: 1, cohort_id: 'c1' }] };
      if (/SELECT bd_listing_id, source FROM organizations/.test(sql)) return { rows: [{ bd_listing_id: '77', source: 'bd_import' }] };
      return { rows: [] }; } };
    const rec = await acq.recordClaimAcquisition({ organizationId: 'o1', tokenId: 't1', proofMethod: 'claim_token' }, runner);
    expect(rec).toMatchObject({ journey: 'CLAIMED_LISTING', cohort_id: 'c1', sequence_id: 's1', message_id: 'm1', template_key: 'E1', template_version: 1, issue_channel: 'outreach', proof_method: 'claim_token' });
    expect(calls.find((c) => /UPDATE organizations SET acquisition/.test(c.sql)).sql).toMatch(/AND acquisition IS NULL/);
    expect(code('src/services/claimedListings/acquisitionService.js')).toMatch(/UPDATE seller_profiles SET acquisition = \$2::jsonb WHERE id = \$1 AND acquisition IS NULL/);
  });
  test('listing conversions are first-party only: never dispatched to an advertising platform', () => {
    const defs = require('../../src/lib/conversionDefinitions');
    for (const k of ['claimed_listing_claimed', 'claimed_listing_activated', 'claimed_listing_pro_conversion']) {
      expect(defs.get(k)).toBeTruthy();
      expect(defs.get(k).meta_event).toBeNull();
      expect(defs.get(k).google_action).toBeNull();
      expect(defs.SUCCESS_SIGNALS).not.toContain(k);
    }
  });
  test('claim link visits record the campaign, never the token (the token lives in the path)', () => {
    const s = code('src/services/claimedListings/claimLinkService.js');
    expect(s).toMatch(/landingUrl: 'https:\/\/bid\.advantage\.bid\/claim\?' \+ q/);
  });
  test('staff, admin, demo and test traffic is flagged internal', async () => {
    const events = require('../../src/services/claimedListings/claimEvents');
    expect(await events.isInternal({ email: 'someone@example.com' })).toBe(true);
    expect(await events.isInternal({ email: 'rep@advantage.bid' })).toBe(true);
  });
});

describe('activation', () => {
  const activation = require('../../src/services/claimedListings/activationService');
  const crypto = require('crypto');
  const sha = (s) => crypto.createHash('sha256').update(String(s).trim()).digest('hex');
  test('the five steps come from the real profile; our imported description never counts as the owner\'s', () => {
    const imported = 'x'.repeat(400);
    const org = { logo_url: 'https://img/logo.png', description: imported, profile_data: { service_area: 'Greater Houston', keywords: ['estate sales'] } };
    const prog = { imported_description_sha256: sha(imported), details_confirmed_at: new Date() };
    let s = activation.evaluateSteps(org, prog, null);
    expect(s).toMatchObject({ details_confirmed: true, logo_added: true, description_owner_written: false, service_area_set: true, first_event_published: false });
    s = activation.evaluateSteps(Object.assign({}, org, { profile_data: Object.assign({}, org.profile_data, { bio: 'y'.repeat(320) }) }), prog, new Date());
    expect(s.description_owner_written).toBe(true);
    expect(s.first_event_published).toBe(true);
    expect(activation.evaluateSteps(Object.assign({}, org, { description: 'short' }), { imported_description_sha256: null }, null).description_owner_written).toBe(false);
  });
  test('activation requires a first event within 45 days; reminders A2-A4 are off by default', () => {
    expect(activation.ACTIVATION_WINDOW_DAYS).toBe(45);
    expect(code('src/services/claimedListings/activationService.js')).toMatch(/reminders: 'A2-A4 not sent/);
  });
  test('publication controls are unchanged: the checklist never publishes anything', () => {
    const s = code('src/services/claimedListings/activationService.js');
    expect(s).not.toMatch(/UPDATE events|UPDATE organizations SET profile_data|businessListingReviewService|publishImported/);
  });
});

describe('identity changes on a claimed listing go to review', () => {
  const pc = require('../../src/services/claimedListings/profileChangeService');
  test('name, website domain and contact email changes are detected; a path-only website edit is not', () => {
    const org = { name: 'Smith Estates', website_url: 'https://smithestates.com', contact_email: 'owner@smithestates.com' };
    expect(pc.protectedChanges(org, { name: 'Jones Estates' }).map((c) => c.field)).toEqual(['name']);
    expect(pc.protectedChanges(org, { website_url: 'https://smithestates.com/about' })).toEqual([]);
    expect(pc.protectedChanges(org, { website_url: 'https://evil.example' }).map((c) => c.field)).toEqual(['website_url']);
    expect(pc.protectedChanges(org, { contact_email: 'new@x.com', city: 'Katy' }).map((c) => c.field)).toEqual(['contact_email']);
    expect(pc.protectedChanges(org, { city: 'Katy', logo_url: 'x' })).toEqual([]);
  });
  test('existing members are untouched: only listings claimed through the new flow are intercepted', () => {
    expect(code('src/services/claimedListings/profileChangeService.js')).toMatch(/SELECT 1 FROM listing_activation_progress WHERE organization_id = \$1/);
  });
});

describe('wiring', () => {
  const server = read('server.js');
  test('the claim page is mounted before the HTML gate; the admin API before the catch-all admin router', () => {
    expect(server.indexOf("app.use(require('./src/routes/claimListing'))")).toBeLessThan(server.indexOf("app.use(require('./src/middleware/htmlAuthGate'))"));
    expect(server.indexOf("app.use('/api/admin/claimed-listings'")).toBeLessThan(server.indexOf("app.use('/api/admin', adminRoutes)"));
    expect(server).toMatch(/src\/workers\/claimedListingWorker\.js/);
  });
  test('the worker does nothing before the migration and sends only through the gated sequence', () => {
    const w = code('src/workers/claimedListingWorker.js');
    expect(w).toMatch(/if \(!\(await tableReady\(\)\)\) return;/);
    expect(w).not.toMatch(/sendEmail/);
  });
  test('the signed-in claim route hands off to the shared after-claim step', () => {
    expect(code('src/routes/orgClaim.js')).toMatch(/claimLinkService'\)\.afterClaim\(/);
  });
});
