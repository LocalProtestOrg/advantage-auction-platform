'use strict';

/**
 * Event Partner relationship segmentation.
 *
 * The property that matters most: a company Advantage.Bid already has a relationship with must
 * never receive a cold "authorize us" invitation — and identity has to be recognised across
 * whichever identifier the two records happen to share, not just email.
 *
 * The asymmetry is deliberate and is asserted here: a STRONG signal excludes outright, while a mere
 * name resemblance returns REVIEW_AMBIGUOUS_IDENTITY, which does not send. A false exclusion costs
 * one prospect; a false inclusion emails an existing customer.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readCode = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const seg = require('../src/services/eventPartners/relationshipSegmentationService');

// ── identity normalisation ────────────────────────────────────────────────────────────────────

describe('company identity is normalised before it is compared', () => {
  test('names normalise past punctuation, case and ampersands', () => {
    expect(seg.normalizeName('Smith Estate Sales, LLC')).toBe('smithestatesalesllc');
    expect(seg.normalizeName('Lewis & Maese')).toBe('lewisandmaese');
    expect(seg.normalizeName('Lewis and Maese')).toBe('lewisandmaese');
  });

  test('root domain survives scheme, www, paths and url-encoding', () => {
    expect(seg.rootDomain('https://www.smithestates.com/sales?x=1')).toBe('smithestates.com');
    expect(seg.rootDomain('https%3A%2F%2Flmauctionco.com%2F')).toBe('lmauctionco.com');
    expect(seg.rootDomain('shop.smithestates.com')).toBe('smithestates.com');
    expect(seg.rootDomain('not-a-domain')).toBeNull();
  });

  test('email domain is extracted, and free mailboxes are not company identifiers', () => {
    expect(seg.emailDomain('info@smithestates.com')).toBe('smithestates.com');
    expect(seg.isCorporateDomain('smithestates.com')).toBe(true);
    for (const d of ['gmail.com', 'yahoo.com', 'aol.com', 'comcast.net', 'outlook.com']) {
      expect(seg.isCorporateDomain(d)).toBe(false);
    }
  });

  test('phones normalise to ten digits, tolerating formatting and a country code', () => {
    expect(seg.normalizePhone('(713) 555-0142')).toBe('7135550142');
    expect(seg.normalizePhone('+1 713 555 0142')).toBe('7135550142');
    expect(seg.normalizePhone('555-0142')).toBeNull();
  });

  test('generic industry words carry no identity', () => {
    expect(seg.nameTokens('The Auction Company LLC')).toEqual([]);
    expect(seg.nameTokens('Smith Estate Sales')).toEqual(['smith']);
  });
});

// ── the Owner's worked example ────────────────────────────────────────────────────────────────

describe("the Owner's example: same company, different mailbox", () => {
  const prospect = seg.identityOf({
    name: 'Smith Estate Sales LLC', website: 'https://smithestates.com',
    email: 'info@smithestates.com', phone: '(713) 555-0142' });
  const claimed = seg.identityOf({
    name: 'Smith Estate Sales', website: 'https://smithestates.com',
    email: 'jane@gmail.com', phone: null });

  test('the shared website domain is a strong match even though the emails differ', () => {
    const cmp = seg.compareIdentity(prospect, claimed);
    expect(cmp.strong.length).toBeGreaterThan(0);
    expect(cmp.strong.join(' ')).toMatch(/domain:smithestates\.com/);
  });

  test('the claimed listing holder being on gmail does not create a false domain match', () => {
    const other = seg.identityOf({ name: 'Unrelated Co', website: null, email: 'bob@gmail.com', phone: null });
    const cmp = seg.compareIdentity(seg.identityOf({ name: 'X', website: null, email: 'a@gmail.com', phone: null }), other);
    expect(cmp.strong).toEqual([]);
  });

  test('a shared phone number alone is a strong match', () => {
    const a = seg.identityOf({ name: 'A Co', website: 'https://a.com', email: 'a@a.com', phone: '713-555-0142' });
    const b = seg.identityOf({ name: 'Totally Different', website: 'https://b.com', email: 'b@b.com', phone: '(713) 555 0142' });
    expect(seg.compareIdentity(a, b).strong.join(' ')).toMatch(/phone:7135550142/);
  });

  test('an exact normalised name is a strong match', () => {
    const a = seg.identityOf({ name: 'Lewis & Maese', website: null, email: null, phone: null });
    const b = seg.identityOf({ name: 'Lewis and Maese', website: null, email: null, phone: null });
    expect(seg.compareIdentity(a, b).strong).toContain('name_exact');
  });
});

// ── fail closed on resemblance ────────────────────────────────────────────────────────────────

describe('a resemblance is never a send', () => {
  test('two distinctive words in common is WEAK, not strong', () => {
    const a = seg.identityOf({ name: 'Hamilton Brothers Auction', website: 'https://hba.com', email: 'x@hba.com', phone: null });
    const b = seg.identityOf({ name: 'Hamilton Brothers Estate Sales', website: 'https://hbes.com', email: 'y@hbes.com', phone: null });
    const cmp = seg.compareIdentity(a, b);
    expect(cmp.strong).toEqual([]);
    expect(cmp.weak.join(' ')).toMatch(/hamilton/);
  });

  test('sharing only generic industry words matches nothing at all', () => {
    const a = seg.identityOf({ name: 'Premier Auction Company', website: 'https://one.com', email: 'a@one.com', phone: null });
    const b = seg.identityOf({ name: 'Family Auction Company', website: 'https://two.com', email: 'b@two.com', phone: null });
    const cmp = seg.compareIdentity(a, b);
    expect(cmp.strong).toEqual([]);
    expect(cmp.weak).toEqual([]);
  });

  test('the decision vocabulary includes a review state that does not send', () => {
    expect(seg.DECISIONS.AMBIGUOUS).toBe('REVIEW_AMBIGUOUS_IDENTITY');
    expect(seg.DECISIONS.OTHER_RELATIONSHIP).toBe('REVIEW_OTHER_RELATIONSHIP');
    const sql = readRaw('db/migrations/162_event_partner_segmentation.sql');
    expect(sql).toMatch(/REVIEW_AMBIGUOUS_IDENTITY/);
    expect(sql).toMatch(/chk_epe_decision/);
  });

  test('only ELIGIBLE_UNAFFILIATED is ever sent to', () => {
    const code = readCode('src/services/eventPartners/outreachSendService.js');
    expect(code).toMatch(/decision\.decision !== segmentation\.DECISIONS\.ELIGIBLE/);
  });
});

// ── exclusion coverage ────────────────────────────────────────────────────────────────────────

describe('every relationship that forbids cold outreach is screened', () => {
  const code = readCode('src/services/eventPartners/relationshipSegmentationService.js');

  test('claimed listings are read from organizations that an account actually holds', () => {
    const fn = code.slice(code.indexOf('async function claimedListings'), code.indexOf('async function professionalSellers'));
    expect(fn).toMatch(/EXISTS \(SELECT 1 FROM organization_members/);
  });

  test('professional sellers and existing event partners are screened too', () => {
    expect(code).toMatch(/seller_type IN \('auction_house','estate_sale_company','professional_liquidator'\)/);
    expect(code).toMatch(/FROM authorized_event_sources/);
  });

  test('suppression is checked on both the partner list and the global list', () => {
    expect(code).toMatch(/FROM event_partner_suppressions WHERE normalized_email/);
    expect(code).toMatch(/FROM email_suppressions WHERE normalized_email/);
  });

  test('a company contacted recently is not contacted again', () => {
    expect(code).toMatch(/event_partners\.recent_outreach_days/);
    expect(code).toMatch(/status = 'sent' AND sent_at > now\(\)/);
  });

  test('a personal mailbox is not treated as a published business contact', () => {
    expect(code).toMatch(/DECISIONS\.NO_CONTACT/);
    expect(code).toMatch(/personal\/free mailbox/);
  });

  test('exclusion checks run before anything is written or sent', () => {
    const send = readCode('src/services/eventPartners/outreachSendService.js');
    const segIdx = send.indexOf('segmentation.resolve');
    const gateIdx = send.indexOf('cohortService.evaluateSend');
    const orgIdx = send.indexOf('await ensureOrganizationForProspect(');
    const sendIdx = send.indexOf('emailService.sendEmail');
    expect(segIdx).toBeGreaterThan(-1);
    expect(segIdx).toBeLessThan(gateIdx);
    expect(gateIdx).toBeLessThan(orgIdx);
    expect(orgIdx).toBeLessThan(sendIdx);
  });

  test('a dry run writes nothing', () => {
    const send = readCode('src/services/eventPartners/outreachSendService.js');
    const dryIdx = send.indexOf('if (dryRun)');
    const orgIdx = send.indexOf('await ensureOrganizationForProspect(');
    expect(dryIdx).toBeLessThan(orgIdx);
  });
});

// ── send containment ──────────────────────────────────────────────────────────────────────────

describe('the cohort ceiling is a hard stop', () => {
  const code = readCode('src/services/eventPartners/outreachSendService.js');

  test('the ceiling is the smaller of the request and the cohort, checked before every send', () => {
    expect(code).toMatch(/Math\.min\(Number\(max\) \|\| 0, Number\(cohort\.max_sends\) \|\| 0\)/);
    expect(code).toMatch(/if \(sent >= ceiling\)/);
  });

  test('the first cohort ceiling is ten', () => {
    const sql = readRaw('db/migrations/162_event_partner_segmentation.sql');
    expect(sql).toMatch(/'event_partners\.first_cohort_max', '10'/);
  });

  test('a prospect organization is created unpublished so outreach never publishes a directory listing', () => {
    expect(code).toMatch(/published: false/);
    expect(code).toMatch(/event_partner_outreach_prospect/);
  });

  test('a send is only recorded once the provider accepted it', () => {
    expect(code).toMatch(/if \(outcome\.provider_accepted\)/);
    expect(code).toMatch(/SET status='sent', sent_at=now\(\)/);
  });
});

// ── outreach copy ─────────────────────────────────────────────────────────────────────────────

describe('the invitation says only what is true', () => {
  const script = readRaw('scripts/event-partner-first-cohort.js');

  test('it makes no traffic, revenue or performance claim', () => {
    expect(script).not.toMatch(/thousands of|millions of|guarantee|increase your sales|drive traffic/i);
  });

  test('it states the offer, the attribution and that no account is needed', () => {
    expect(script).toMatch(/at no cost to you/);
    expect(script).toMatch(/named as the host/);
    expect(script).toMatch(/no Advantage\.Bid account is required/);
    expect(script).toMatch(/Authorize Event Promotion/);
  });

  test('it offers a way to decline', () => {
    expect(script).toMatch(/reply to this message and we will not contact you again/);
  });

  test('it does not imply an existing relationship', () => {
    expect(script).not.toMatch(/your account|as you know|following up on our|as discussed/i);
  });

  test('it exposes no internal automation vocabulary', () => {
    expect(script).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|automated system|our algorithm/i);
  });

  test('the authorization link points at the canonical public page', () => {
    const code = readCode('src/services/eventPartners/outreachSendService.js');
    expect(code).toMatch(/https:\/\/bid\.advantage\.bid/);
    expect(code).toMatch(/authorize-event-promotion\.html\?token=/);
  });
});

// ── deliverability posture ────────────────────────────────────────────────────────────────────

describe('deliverability', () => {
  test('a programme sender is only honoured on the verified domain', () => {
    const code = readCode('src/services/emailService.js');
    expect(code).toMatch(/requestedFrom\.endsWith\('@' \+ verifiedDomain\)/);
    expect(code).toMatch(/: EMAIL_FROM;/);
  });

  test('Event Partner mail carries its own configuration set', () => {
    const code = readCode('src/services/emailService.js');
    expect(code).toMatch(/mailStream === 'event_partner'/);
    expect(code).toMatch(/SES_EVENT_PARTNER_CONFIGURATION_SET/);
  });

  test('Postmark is not introduced anywhere in this path', () => {
    for (const f of ['src/services/eventPartners/outreachSendService.js',
      'src/services/eventPartners/relationshipSegmentationService.js',
      'scripts/event-partner-first-cohort.js']) {
      expect(readRaw(f)).not.toMatch(/postmark/i);
    }
  });
});
