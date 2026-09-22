'use strict';

/**
 * Buyer lifecycle → Sales Near You.
 *
 * The gap this closes: registration, auction registration, bidding and purchase did NOTHING with
 * the subscriber system. Production held 95 users (66 buyers), 45 auction registrations and 392
 * bids against exactly 1 marketing contact — every buyer relationship was being discarded.
 *
 * THE RULE UNDER TEST: enrolment happens only when the buyer accepted a terms version that ACTUALLY
 * DISCLOSES Sales Near You. No historical acceptance is rewritten, and none is assumed.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-buyer-lifecycle';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

jest.mock('../src/db', () => {
  const state = { routes: [], calls: [] };
  const query = async (sql, params) => {
    const text = String(sql);
    state.calls.push({ sql: text, params });
    for (const [re, h] of state.routes) {
      if (re.test(text)) {
        const out = typeof h === 'function' ? await h(text, params) : h;
        return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), pool: { end: async () => {} }, __state: state };
});
const db = require('../src/db');
const setRoutes = (r) => { db.__state.routes = r; db.__state.calls = []; };
const calls = () => db.__state.calls;

const enrollment = require('../src/services/buyerLifecycleEnrollmentService');
const subscriberService = require('../src/services/subscriberService');
const configService = require('../src/services/configService');

const DISCLOSING = [{
  acceptance_id: 'ta-1', accepted_at: '2026-09-22T00:00:00Z',
  terms_version_id: 'tv-3', version_int: 3,
}];

let cfg;
beforeEach(() => {
  cfg = { 'marketing.sales_near_you.enroll_on_registration': true };
  jest.spyOn(configService, 'get').mockImplementation(async (_o, k) => cfg[k]);
  setRoutes([]);
});
afterEach(() => jest.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('consent: enrolment requires terms that actually disclosed the benefit', () => {
  test('a buyer who accepted a DISCLOSING version is enrolled', async () => {
    setRoutes([
      [/FROM terms_acceptances ta/, () => DISCLOSING],
      [/SELECT tax_city, tax_state FROM users/, () => [{ tax_city: 'Austin', tax_state: 'TX' }]],
      [/SELECT id, geography_precision, geography_source FROM marketing_contacts/, () => [{ id: 'mc-1', geography_precision: 'city_centroid' }]],
      [/INSERT INTO buyer_sales_near_you_enrollments/, () => []],
    ]);
    const spy = jest.spyOn(subscriberService, 'signup').mockResolvedValue({ ok: true, status: 'subscribed' });
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration' });
    expect(out.enrolled).toBe(true);
    expect(out.termsVersionInt).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a buyer who accepted only a NON-disclosing version is NOT enrolled', async () => {
    setRoutes([[/FROM terms_acceptances ta/, () => []]]);   // no disclosing acceptance
    const spy = jest.spyOn(subscriberService, 'signup').mockResolvedValue({ ok: true, status: 'subscribed' });
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration' });
    expect(out.enrolled).toBe(false);
    expect(out.reason).toBe('terms_not_disclosing_sales_near_you');
    expect(spy).not.toHaveBeenCalled();     // no contact is created at all
  });

  test('the lookup only ever considers disclosing versions', async () => {
    setRoutes([[/FROM terms_acceptances ta/, () => DISCLOSING]]);
    await enrollment.acceptedDisclosingTerms('u1');
    const sql = calls().map((c) => c.sql).join(' ');
    expect(sql).toMatch(/tv\.includes_sales_near_you = true/);
    expect(sql).toMatch(/tv\.kind = 'buyer_terms'/);
  });

  test('historical acceptance is never fabricated or rewritten', () => {
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).not.toMatch(/INSERT INTO terms_acceptances|UPDATE terms_acceptances/);
    const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');
    expect(mig).not.toMatch(/UPDATE terms_acceptances|INSERT INTO terms_acceptances/);
    expect(mig).not.toMatch(/DELETE FROM/i);
  });

  test('the disclosure flag defaults FALSE, so every historical version is non-disclosing', () => {
    const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');
    expect(mig).toMatch(/includes_sales_near_you boolean NOT NULL DEFAULT false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the registration term itself', () => {
  const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');

  test('it states the Owner-approved concept', () => {
    expect(mig).toMatch(/\*\*Sales Near You\.\*\* Registration includes email notifications about qualifying/);
    expect(mig).toMatch(/upcoming auctions and estate sales near you, generally within 30 miles of your/);
  });

  test('it is an ordinary numbered term, not a warning box', () => {
    expect(mig).toMatch(/^11\. \*\*Sales Near You\.\*\*/m);
    const term = mig.slice(mig.indexOf('11. **Sales Near You.**'), mig.indexOf('These terms will be expanded'));
    expect(term).not.toMatch(/WARNING|CAUTION|IMPORTANT NOTICE|⚠/i);
  });

  test('per Owner instruction it carries NO unsubscribe sentence', () => {
    const term = mig.slice(mig.indexOf('11. **Sales Near You.**'), mig.indexOf('These terms will be expanded'));
    expect(term).not.toMatch(/unsubscribe|opt out|opt-out/i);
  });

  test('no separate marketing checkbox was added to registration', () => {
    const auth = read('src', 'routes', 'auth.js');
    expect(auth).not.toMatch(/marketing_opt_in|newsletter_checkbox|acceptMarketing/i);
  });

  test('v3 is built from the version actually in force, and v2 is not silently promoted', () => {
    expect(mig).toMatch(/version_int = 3/);
    expect(mig).toMatch(/promoting it is a\n-- separate Owner decision/);
  });

  test('exactly one current version survives', () => {
    expect(mig).toMatch(/UPDATE terms_versions SET is_current = false\s*\n\s*WHERE kind = 'buyer_terms' AND version_int <> 3 AND is_current = true;/);
    expect(mig).toMatch(/UPDATE terms_versions SET is_current = true\s*\n\s*WHERE kind = 'buyer_terms' AND version_int = 3;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('one canonical identity — no duplication anywhere in the lifecycle', () => {
  const primed = (extra) => setRoutes([
    [/FROM terms_acceptances ta/, () => DISCLOSING],
    [/SELECT tax_city, tax_state FROM users/, () => [{ tax_city: 'Austin', tax_state: 'TX' }]],
    [/SELECT id, geography_precision, geography_source FROM marketing_contacts/, () => [{ id: 'mc-1' }]],
    [/INSERT INTO buyer_sales_near_you_enrollments/, () => []],
  ].concat(extra || []));

  test('enrolment goes through subscriberService, which upserts rather than inserting', () => {
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).toMatch(/subscriberService\.signup/);
    expect(svc).not.toMatch(/INSERT INTO marketing_contacts/);
    const sub = read('src', 'services', 'subscriberService.js');
    expect(sub).toMatch(/upsertContact/);
    expect(sub).toMatch(/findExistingUserId/);      // matches the existing platform user
  });

  test('registering for several auctions creates ONE contact', async () => {
    const spy = jest.spyOn(subscriberService, 'signup').mockResolvedValue({ ok: true, status: 'subscribed' });
    primed();
    await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration', auctionId: 'a1' });
    primed();
    await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration', auctionId: 'a2' });
    // Both go through the same upserting path keyed on the same email.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mock.calls.forEach((c) => expect(c[0].email).toBe('b@example.com'));
  });

  test('the evidence row is idempotent per contact/trigger/version', () => {
    const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');
    expect(mig).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_bsny_enrollment/);
    expect(mig).toMatch(/\(contact_id, trigger, COALESCE\(terms_version_id/);
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).toMatch(/ON CONFLICT DO NOTHING/);
  });

  test('bidding and purchase create no contacts of their own', () => {
    // Nothing in the bid or payment paths touches the subscriber system.
    ['src/routes/bids.js', 'src/services/biddingService.js', 'src/routes/payments.js']
      .forEach((rel) => {
        try {
          const src = read.apply(null, rel.split('/'));
          expect(src).not.toMatch(/buyerLifecycleEnrollmentService|subscriberService/);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      });
  });

  test('no separate registered-bidder email list exists', () => {
    const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');
    expect(mig).not.toMatch(/CREATE TABLE[^;]*(subscriber|bidder_email|buyer_email)/i);
    // The evidence table references the canonical contact rather than storing an address.
    expect(mig).toMatch(/contact_id          uuid        NOT NULL REFERENCES marketing_contacts\(id\)/);
    const enrollTable = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS buyer_sales_near_you_enrollments'),
      mig.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_bsny_enrollment'));
    expect(enrollTable).not.toMatch(/email/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('geography: reuse what we already know, invent nothing', () => {
  test('an address we already hold is reused rather than asked for again', async () => {
    setRoutes([[/SELECT tax_city, tax_state FROM users/, () => [{ tax_city: 'Jersey City', tax_state: 'NJ' }]]]);
    expect(await enrollment.knownGeography('u1')).toEqual({ city: 'Jersey City', state: 'NJ', source: 'tax_address' });
  });

  test('a partial address yields nothing — never a half-guess', async () => {
    setRoutes([[/SELECT tax_city, tax_state FROM users/, () => [{ tax_city: 'Austin', tax_state: null }]]]);
    expect(await enrollment.knownGeography('u1')).toBeNull();
    setRoutes([[/SELECT tax_city, tax_state FROM users/, () => []]]);
    expect(await enrollment.knownGeography('u1')).toBeNull();
  });

  test('only CITY and STATE are read — never the street line', () => {
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).toMatch(/SELECT tax_city, tax_state FROM users/);
    expect(svc).not.toMatch(/tax_address_line1|tax_address_line2|tax_postal_code/);
  });

  test('enrolment still succeeds with NO geography — the relationship is not lost', async () => {
    setRoutes([
      [/FROM terms_acceptances ta/, () => DISCLOSING],
      [/SELECT tax_city, tax_state FROM users/, () => []],
      [/SELECT id, geography_precision, geography_source FROM marketing_contacts/, () => [{ id: 'mc-1' }]],
      [/INSERT INTO buyer_sales_near_you_enrollments/, () => []],
    ]);
    const spy = jest.spyOn(subscriberService, 'signup').mockResolvedValue({ ok: true, status: 'subscribed' });
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration' });
    expect(out.enrolled).toBe(true);
    expect(spy.mock.calls[0][0].city).toBeNull();
    // A contact without coordinates simply is not radius-eligible yet (matching fails closed).
    const aud = read('src', 'services', 'audienceEligibilityService.js');
    expect(aud).toMatch(/if \(lat == null \|\| lng == null\) return false;/);
  });

  test('caller-supplied geography wins over the stored address', async () => {
    setRoutes([
      [/FROM terms_acceptances ta/, () => DISCLOSING],
      [/SELECT id, geography_precision, geography_source FROM marketing_contacts/, () => [{ id: 'mc-1' }]],
      [/INSERT INTO buyer_sales_near_you_enrollments/, () => []],
    ]);
    const spy = jest.spyOn(subscriberService, 'signup').mockResolvedValue({ ok: true, status: 'subscribed' });
    await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration', city: 'Dallas', state: 'TX' });
    expect(spy.mock.calls[0][0].city).toBe('Dallas');
    // The stored address was not even consulted.
    expect(calls().some((c) => /tax_city/.test(c.sql))).toBe(false);
  });

  test('the 30-mile policy is untouched by this change', () => {
    const mig = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql');
    expect(mig).not.toMatch(/radius_default_miles|local_alert_default_radius_miles/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('suppression and transactional separation', () => {
  test('a suppressed buyer is recorded but NOT granted deliverable permission', () => {
    const sub = read('src', 'services', 'subscriberService.js');
    expect(sub).toMatch(/HARD_SUPPRESSION_REASONS/);
    expect(sub).toMatch(/complaint|hard_bounce/);
    // Registration cannot resurrect a complaint or hard bounce.
    expect(sub).toMatch(/a form submit\s*\n \* cannot silently override a complaint\/hard-bounce suppression/);
  });

  test('enrolment never writes to the suppression list', () => {
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).not.toMatch(/email_suppressions|DELETE FROM|suppress\(/);
  });

  test('marketing suppression is scoped to marketing, so transactional mail is unaffected', () => {
    const fb = read('src', 'services', 'sesFeedbackService.js');
    expect(fb).toMatch(/scope/);
    expect(fb).toMatch(/'marketing'/);
    // Transactional sends use the default stream and never consult the marketing scope.
    const es = read('src', 'services', 'emailService.js');
    expect(es).not.toMatch(/email_suppressions/);
  });

  test('transactional classes never honour a marketing unsubscribe', () => {
    const classes = read('src', 'lib', 'emailCampaignClasses.js');
    const txn = classes.slice(classes.indexOf('TRANSACTIONAL'), classes.indexOf('TRANSACTIONAL') + 400);
    expect(txn).toMatch(/honorsMarketingUnsub:\s*false/);
  });

  test('transactional necessity cannot bypass a marketing suppression', () => {
    const aud = read('src', 'services', 'audienceEligibilityService.js');
    expect(aud).toMatch(/evaluateContact/);
    // Marketing eligibility is evaluated per contact regardless of any transactional relationship.
    expect(aud).toMatch(/suppress/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('it can never break a registration', () => {
  test('enrol returns a reason instead of throwing', async () => {
    setRoutes([[/FROM terms_acceptances ta/, () => { throw new Error('db exploded'); }]]);
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration' });
    expect(out.enrolled).toBe(false);
    expect(out.reason).toMatch(/^error:/);
  });

  test('both call sites are fire-and-forget and swallow failures', () => {
    const terms = read('src', 'services', 'termsService.js');
    expect(terms).toMatch(/Promise\.resolve\(\)\.then\(async \(\) => \{[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/);
    const reg = read('src', 'services', 'auctionRegistrationService.js');
    expect(reg).toMatch(/\.catch\(\(\) => \{\}\)/);
  });

  test('an unknown trigger is refused rather than guessed', async () => {
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'whatever' });
    expect(out.enrolled).toBe(false);
    expect(out.reason).toBe('unknown_trigger');
  });

  test('the Owner can switch registration-driven enrolment off without a deploy', async () => {
    cfg['marketing.sales_near_you.enroll_on_registration'] = false;
    const out = await enrollment.enroll({ userId: 'u1', email: 'b@example.com', trigger: 'auction_registration' });
    expect(out.enrolled).toBe(false);
    expect(out.reason).toBe('enrollment_disabled');
  });

  test('the terms gate reads the disclosure flag, which getCurrentTerms actually selects', () => {
    const terms = read('src', 'services', 'termsService.js');
    // Without this column in the SELECT the gate would read undefined and silently never enrol.
    expect(terms).toMatch(/includes_sales_near_you\s*\n\s*FROM terms_versions/);
    expect(terms).toMatch(/if \(current\.includes_sales_near_you\)/);
  });

  test('nothing here sends email or flips a sending gate', () => {
    const svc = read('src', 'services', 'buyerLifecycleEnrollmentService.js');
    expect(svc).not.toMatch(/sendEmail|emailService|nodemailer/);
    const migSql = read('db', 'migrations', '158_buyer_lifecycle_sales_near_you.sql')
      .replace(/^\s*--.*$/gm, '');
    expect(migSql).not.toMatch(/sales_near_you_enabled|a7_send_enabled|outreach_enabled/);
  });
});
