'use strict';

/**
 * Claimed Listing — nothing can send by accident.
 * Templates, the nine send gates, the scheduler with the switch off, idempotency, SES failures and
 * health auto-pause, reply routing (no automatic reply to a person, ever), suppression, purpose-bound
 * unsubscribe tokens, and duplicate-contact protection for 1:1 rep email.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-claimed-listing';
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) }));
const db = require('../../src/db');
const templates = require('../../src/services/claimedListings/templates');
const sendGate = require('../../src/services/claimedListings/sendGate');
const sequences = require('../../src/services/claimedListings/sequenceService');
const suppression = require('../../src/services/claimedListings/suppressionService');
const inbound = require('../../src/services/claimedListings/inboundService');
const unsub = require('../../src/lib/listingUnsubscribeToken');
const marketingToken = require('../../src/lib/marketingEmailToken');
const epThreads = require('../../src/services/eventPartners/threadService');
const locks = require('../../src/services/acquisition/contactLockService');

/** A fake runner answering by regex; records every statement. */
function fake(routes = []) {
  const calls = [];
  const query = async (sql, params) => {
    const text = String(sql); calls.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    for (const [re, h] of routes) if (re.test(text)) { const out = typeof h === 'function' ? await h(text, params) : h; return Array.isArray(out) ? { rows: out, rowCount: out.length } : out; }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), calls };
}

const VARS = {
  greeting: 'Hello', company: 'Smith Estates', area: 'the Houston area', city: 'Houston', state: 'TX', phone: '713-555-0100',
  website_or_none_listed: 'none listed', no_website: true, listing_url: 'https://www.advantage.bid/smith-estates',
  claim_link: 'https://bid.advantage.bid/claim/abc', listing_options_link: 'https://bid.advantage.bid/claim/abc#options',
  unsubscribe_link: 'https://bid.advantage.bid/api/public/listing-outreach/unsubscribe?t=x', recipient_email: 'o@smith.com',
  postal_address: 'PO Box 1, Houston TX 77001', third_bullet: 'post your upcoming estate sales and auctions so local buyers can find them',
  rep_first_name: 'Kym', rep_full_name: 'Kym Witt',
};
const tplRow = (key) => ({ template_key: key, version: 1, subject: templates.CATALOGUE[key].subject, preheader: templates.CATALOGUE[key].preheader,
  body_text: templates.CATALOGUE[key].text, stream: templates.CATALOGUE[key].stream });

describe('templates', () => {
  test('the blueprint sequence renders: E1, E2 (both variants), E3, E4, the self-request note', () => {
    for (const k of ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3', 'E4_REFRESH']) {
      const r = templates.render(tplRow(k), VARS);
      expect(r.subject).not.toMatch(/\{\{/);
      expect(r.text).toMatch(/Advantage\.Bid, PO Box 1, Houston TX 77001/);         // postal address footer
      expect(r.text).toMatch(/Don't email me about this listing: https:\/\/bid\.advantage\.bid\/api\/public\/listing-outreach\/unsubscribe/);
    }
    expect(templates.render(tplRow('CL_SELF_REQUEST'), { company: 'Smith Estates', claim_link: 'https://bid.advantage.bid/claim/abc' }).text).toMatch(/ignore this email/);
  });
  test('no em dashes, no images, no tracking pixel, no forms anywhere in the copy', () => {
    for (const [k, t] of Object.entries(templates.CATALOGUE)) {
      expect([k, t.subject + t.text + (t.preheader || '')].join()).not.toMatch(/—/);
      const html = templates.htmlFromText(t.text, t.preheader);
      expect(html).not.toMatch(/<img|<form|<script|pixel/i);
    }
  });
  test('Professional Seller and fees are never mentioned in outreach or activation emails', () => {
    for (const k of ['E1', 'E2_NOCLICK', 'E2_CLICKED', 'E3', 'E4_REFRESH', 'A1', 'A2', 'A3', 'A4']) {
      // "no monthly fee" is the blueprint's own reassurance; no product pitch, no percentage, no price.
      expect(templates.CATALOGUE[k].text).not.toMatch(/Professional Seller|\d+\s*%|\$\s*\d/i);
    }
  });
  test('fail closed: a missing postal address, a missing variable, a foreign link or an em dash aborts the render', () => {
    expect(() => templates.render(tplRow('E1'), Object.assign({}, VARS, { postal_address: '' }))).toThrow(/footer incomplete/);
    expect(() => templates.render(tplRow('E1'), Object.assign({}, VARS, { city: '' }))).toThrow(/missing template variables: city/);
    expect(() => templates.render(tplRow('E1'), Object.assign({}, VARS, { claim_link: 'https://evil.example/claim' }))).toThrow(/outside Advantage\.Bid/);
    expect(() => templates.render(tplRow('E1'), Object.assign({}, VARS, { company: 'Smith — Estates' }))).toThrow(/em dash/);
  });
  test('approved versions are immutable (database trigger) and only drafts can be approved', () => {
    const m = read('db/migrations/170_claimed_listing_system.sql');
    expect(m).toMatch(/approved listing template % v% is immutable; create a new version/);
    expect(read('src/services/claimedListings/templates.js')).toMatch(/WHERE id = \$1 AND status = 'draft' RETURNING \*/);
  });
});

describe('the send gate', () => {
  test('send window: Tue-Thu 09:30-11:30 in the recipient\'s own time zone', () => {
    const tueHouston1000 = new Date('2026-09-29T15:00:00Z');   // 10:00 CDT, Tuesday
    expect(sendGate.inWindow(tueHouston1000, 'TX').ok).toBe(true);
    expect(sendGate.inWindow(tueHouston1000, 'CA').ok).toBe(false);   // 08:00 in Los Angeles
    expect(sendGate.inWindow(new Date('2026-09-28T15:00:00Z'), 'TX').ok).toBe(false);   // Monday
    expect(sendGate.inWindow(new Date('2026-10-01T16:40:00Z'), 'TX').ok).toBe(false);   // Thu 11:40
  });
  test('with the programme switch off, nothing is allowed and every lock reports', async () => {
    const r = fake([[/FROM platform_config WHERE key LIKE 'claimed_listings/, [{ key: 'claimed_listings.sending_enabled', value: false }, { key: 'company.postal_address', value: '' }]]]);
    const g = await sendGate.evaluate({ organizationId: '00000000-0000-4000-8000-000000000001', cohortId: null, recipientEmail: 'a@b.com' }, r, { ctx: { listings: [], snap: { clusterFor: () => null } } });
    expect(g.allowed).toBe(false);
    for (const name of ['program', 'cohort', 'eligibility', 'journey', 'config']) expect(g.blocked_by).toContain(name);
    expect(g.checks.find((c) => c.name === 'config').detail).toMatch(/postal address/);
  });
  test('any evaluation error blocks (fail closed)', async () => {
    const broken = { query: async () => { throw new Error('db down'); } };
    const g = await sendGate.evaluate({ organizationId: 'x', cohortId: null, recipientEmail: 'a@b.com' }, broken);
    expect(g.allowed).toBe(false);
  });
  test('stream health: below 50 deliveries any complaint pauses; above, the rate thresholds apply', async () => {
    const h1 = await sendGate.streamHealth(fake([[/ses_feedback_events/, [{ delivered: 10, hard_bounces: 0, complaints: 1 }]]]), {});
    expect(h1.ok).toBe(false);
    const h2 = await sendGate.streamHealth(fake([[/ses_feedback_events/, [{ delivered: 100, hard_bounces: 2, complaints: 0 }]]]), {});
    expect(h2.ok).toBe(true);
    const h3 = await sendGate.streamHealth(fake([[/ses_feedback_events/, [{ delivered: 100, hard_bounces: 4, complaints: 0 }]]]), {});
    expect(h3.ok).toBe(false);
  });
});

describe('the scheduler', () => {
  test('with sending disabled a tick queues nothing, issues nothing and sends nothing', async () => {
    const r = fake([[/claimed_listings\.sending_enabled/, [{ value: false }]]]);
    const out = await sequences.tick({}, r);
    expect(out).toMatchObject({ sending_enabled: false, queued: 0, attempted: 0, sent: 0 });
    expect(r.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.sql))).toEqual([]);
  });
  test('three emails per cycle, one refresh, then permanent stop', async () => {
    expect(await sequences.dueStep({ cycle_no: 1, step: 0 })).toEqual({ stepNo: 1, stepKey: 'E1' });
    expect(await sequences.dueStep({ cycle_no: 1, step: 1, variant: 'clicked' })).toEqual({ stepNo: 2, stepKey: 'E2_CLICKED' });
    expect(await sequences.dueStep({ cycle_no: 1, step: 1 })).toEqual({ stepNo: 2, stepKey: 'E2_NOCLICK' });
    expect(await sequences.dueStep({ cycle_no: 1, step: 2 })).toEqual({ stepNo: 3, stepKey: 'E3' });
    expect(await sequences.dueStep({ cycle_no: 1, step: 3 })).toBeNull();
    expect(await sequences.dueStep({ cycle_no: 2, step: 0 })).toEqual({ stepNo: 4, stepKey: 'E4_REFRESH' });
    expect(await sequences.dueStep({ cycle_no: 2, step: 4 })).toBeNull();
    const m = read('db/migrations/170_claimed_listing_system.sql');
    expect(m).toMatch(/cycle_no\s+smallint NOT NULL DEFAULT 1 CHECK \(cycle_no IN \(1,2\)\)/);
  });
  test('a cohort is approved only by a Super Admin with every required template approved and a rep assigned', () => {
    const src = read('src/services/claimedListings/sequenceService.js');
    expect(src).toMatch(/Bind approved versions of:/);
    expect(src).toMatch(/Every bound template must be an approved version/);
    expect(src).toMatch(/Assign the signing representative first/);
    const route = read('src/routes/adminClaimedListings.js');
    expect(route).toMatch(/router\.post\('\/cohorts\/:id\/approve', idParam\('id'\), approve,/);
    expect(read('db/migrations/170_claimed_listing_system.sql')).toMatch(/autonomous_allowed boolean NOT NULL DEFAULT false/);
  });
  test('the shadow run sends nothing and issues no claim link', () => {
    const s = read('src/services/claimedListings/outreachSender.js');
    const shadow = s.slice(s.indexOf('if (shadow) {'), s.indexOf("if (!gate.allowed) return"));
    expect(shadow).not.toMatch(/sendEmail|issueToken|INSERT INTO/);
    expect(shadow).toMatch(/SHADOW-TOKEN/);
  });
  test('idempotency: the (listing, cycle, step) slot is claimed before any token or send', () => {
    const s = read('src/services/claimedListings/outreachSender.js');
    const i = s.indexOf("const idem = org.id + ':' + sequence.cycle_no + ':' + stepNo;");
    expect(i).toBeGreaterThan(0);
    expect(s.indexOf('claimLinks.issueToken(org.id')).toBeGreaterThan(i);
    expect(s.indexOf('emailService.sendEmail({')).toBeGreaterThan(i);
    expect(s).toMatch(/if \(!slot\) return \{ sent: false, gate, reason: 'already sent or in flight \(idempotent\)' \};/);
    expect(read('db/migrations/170_claimed_listing_system.sql')).toMatch(/idempotency_key\s+text UNIQUE/);
  });
  test('the sender uses the listing stream, a reply key, RFC 8058 one-click unsubscribe, and fails closed on a provider error', () => {
    const s = read('src/services/claimedListings/outreachSender.js');
    expect(s).toMatch(/mailStream: 'claimed_listing'/);
    expect(s).toMatch(/'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
    expect(s).toMatch(/replyTo: replyAddressFor\(slot\.reply_key\)/);
    expect(s).toMatch(/SET status = 'failed', error = \$2/);
    const seqSrc = read('src/services/claimedListings/sequenceService.js');
    expect(seqSrc).toMatch(/retry_count = retry_count \+ 1, next_send_at = now\(\) \+/);   // retried with backoff, never skipped
  });
});

describe('SES failures', () => {
  const feedback = require('../../src/services/claimedListings/feedbackService');
  const MSG = { id: 'm1', organization_id: 'o1', company_id: null, sequence_id: 's1', recipient_email_normalized: 'owner@smith.com', error: null };
  test('a hard bounce suppresses the address and stops the sequence', async () => {
    const r = fake([[/FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences/, [MSG]], [/ses_feedback_events/, [{ delivered: 0, hard_bounces: 1, complaints: 0 }]]]);
    await feedback.onFeedback({ eventType: 'Bounce', bounceSubtype: 'General', sesMessageId: 'abc' }, r);
    expect(r.calls.some((c) => /INSERT INTO listing_outreach_suppressions/.test(c.sql) && c.params.includes('hard_bounce'))).toBe(true);
    expect(r.calls.some((c) => /UPDATE listing_outreach_sequences s SET state = 'stopped'/.test(c.sql))).toBe(true);
  });
  test('a first soft bounce retries once in 24 hours; a second is treated as hard', async () => {
    const r1 = fake([[/FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences/, [MSG]]]);
    await feedback.onFeedback({ eventType: 'Bounce', bounceSubtype: 'Transient', sesMessageId: 'abc' }, r1);
    expect(r1.calls.some((c) => /error = 'soft_bounce_once'/.test(c.sql))).toBe(true);
    expect(r1.calls.some((c) => /next_send_at = now\(\) \+ interval '24 hours'/.test(c.sql))).toBe(true);
    expect(r1.calls.some((c) => /INSERT INTO listing_outreach_suppressions/.test(c.sql))).toBe(false);
    const r2 = fake([[/FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences/, [Object.assign({}, MSG, { error: 'soft_bounce_once' })]], [/ses_feedback_events/, [{ delivered: 0, hard_bounces: 0, complaints: 0 }]]]);
    await feedback.onFeedback({ eventType: 'Bounce', bounceSubtype: 'Transient', sesMessageId: 'abc' }, r2);
    expect(r2.calls.some((c) => /INSERT INTO listing_outreach_suppressions/.test(c.sql))).toBe(true);
  });
  test('a complaint auto-pauses the programme and alerts the Owner', async () => {
    const r = fake([[/FROM listing_outreach_messages m LEFT JOIN listing_outreach_sequences/, [MSG]], [/ses_feedback_events/, [{ delivered: 5, hard_bounces: 0, complaints: 1 }]]]);
    await feedback.onFeedback({ eventType: 'Complaint', sesMessageId: 'abc' }, r);
    expect(r.calls.some((c) => /SET value = 'false'::jsonb, updated_at = now\(\) WHERE key = 'claimed_listings\.sending_enabled'/.test(c.sql))).toBe(true);
    expect(r.calls.some((c) => /WHERE key = 'claimed_listings\.paused_reason'/.test(c.sql))).toBe(true);
  });
  test('SES feedback on the listing stream reaches the programme without changing the global decision', () => {
    const svc = read('src/services/sesFeedbackService.js');
    expect(svc).toMatch(/if \(evt\.mailStream === 'claimed_listing' && result && result\.ok && !result\.idempotent\)/);
    expect(read('src/lib/sesNotificationParser.js')).toMatch(/'advantage-bid-claimed-listing': 'claimed_listing'/);
  });
});

describe('reply routing: no automatic reply to a person, ever', () => {
  test('a listing reply key is never confused with an Event Partner key, and vice versa', () => {
    const key = 'l' + 'a'.repeat(24);
    expect(inbound.extractListingKey({ to: ['listings+' + key + '@reply.advantage.bid'] })).toBe(key);
    expect(inbound.extractListingKey({ to: ['partner+' + 'b'.repeat(24) + '@reply.advantage.bid'] })).toBeNull();
    expect(epThreads.extractReplyKey({ to: ['listings+' + key + '@reply.advantage.bid'] })).toBeNull();
  });
  test('inbound is off by default and an unverified callback is refused', async () => {
    await expect(inbound.ingest({}, { signatureStatus: 'rejected_signature' })).rejects.toMatchObject({ code: 'UNVERIFIED_CALLBACK' });
    db.query.mockImplementation(async (sql) => (/claimed_listings\.inbound_enabled/.test(sql) ? { rows: [{ value: false }] } : { rows: [] }));
    await expect(inbound.ingest({}, { signatureStatus: 'verified' })).rejects.toMatchObject({ code: 'INBOUND_DISABLED' });
  });
  test('only STOP, bounces and auto-replies are handled without a person; everything else stops automation and opens a task', () => {
    const s = read('src/services/claimedListings/inboundService.js');
    expect(s).toMatch(/case 'OUT_OF_OFFICE':\s*action = 'ignored_auto_reply';/);
    expect(s).toMatch(/case 'STOP_UNSUBSCRIBE':[\s\S]*?reason: 'stop_request'/);
    expect(s).toMatch(/default: \{[\s\S]*?await stopAll\('human_reply'\)[\s\S]*?type: legal \? 'legal_escalation' : 'reply_received'/);
    expect(s).not.toMatch(/sendEmail\(\{\s*to: (from|normalized\.fromEmail|out\.recipient)/);   // never writes back to the sender
    expect(s).toMatch(/to: process\.env\.OUTREACH_BCC \|\| 'info@advantage\.bid'/);            // only the internal heads-up
  });
  test('listing replies are stored in the listing tables, never in event_partner_messages', () => {
    const s = read('src/services/claimedListings/inboundService.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(s).not.toMatch(/event_partner_messages/);
    const hook = read('src/routes/webhooksEmail.js');
    expect(hook).toMatch(/if \(listingInbound\.extractListingKey\(normalized\)\)/);
  });
});

describe('suppression and unsubscribe', () => {
  test('a STOP anywhere stops everything: all three lists are read; a lookup error counts as suppressed', async () => {
    const r = fake([[/FROM email_suppressions/, [{ src: 'event_partner', reason: 'stop_request' }]]]);
    expect(await suppression.check({ email: 'x@y.com' }, r)).toMatchObject({ suppressed: true, source: 'event_partner' });
    expect(r.calls[0].sql).toMatch(/email_suppressions[\s\S]*listing_outreach_suppressions[\s\S]*event_partner_suppressions/);
    const broken = { query: async () => { throw new Error('down'); } };
    expect(await suppression.check({ email: 'x@y.com' }, broken)).toMatchObject({ suppressed: true, source: 'lookup_failed' });
  });
  test('unsubscribe tokens are purpose-bound: a listing token is not a marketing token and vice versa', () => {
    const t = unsub.sign({ email: 'owner@smith.com', organizationId: 'o1' });
    expect(unsub.verify(t)).toEqual({ email: 'owner@smith.com', organizationId: 'o1' });
    expect(marketingToken.verify(t)).toBeNull();
    expect(unsub.verify(marketingToken.sign({ email: 'owner@smith.com' }))).toBeNull();
    expect(unsub.verify(t.slice(0, -2) + 'xx')).toBeNull();
  });
  test('a GET of the unsubscribe link never unsubscribes (scanners), a POST does', () => {
    const r = read('src/routes/publicListings.js');
    const get = r.slice(r.indexOf("router.get('/listing-outreach/unsubscribe'"));
    expect(get).not.toMatch(/applyUnsubscribe/);
    expect(r).toMatch(/router\.post\('\/listing-outreach\/unsubscribe'[\s\S]*?applyUnsubscribe/);
  });
});

describe('duplicate contact', () => {
  test('a person\'s lock blocks the system and other reps; the system lock blocks reps', async () => {
    const held = (row) => fake([[/FROM company_contact_locks l/, [row]]]);
    expect((await locks.check('co1', { type: 'user', userId: 'rep2' }, held({ holder_type: 'user', holder_user_id: 'rep1', holder_name: 'Kym' }))).ok).toBe(false);
    expect((await locks.check('co1', { type: 'system', sequenceId: 's1' }, held({ holder_type: 'user', holder_user_id: 'rep1' }))).ok).toBe(false);
    expect((await locks.check('co1', { type: 'user', userId: 'rep1' }, held({ holder_type: 'system', sequence_id: 's1' }))).ok).toBe(false);
    expect((await locks.check('co1', { type: 'user', userId: 'rep1' }, held({ holder_type: 'user', holder_user_id: 'rep1' }))).ok).toBe(true);
    expect((await locks.check('co1', { type: 'user', userId: 'rep1' }, { query: async () => { throw new Error('down'); } })).ok).toBe(false);
  });
  test('taking the lock pauses an automated sequence; only a Super Admin may take a person\'s lock', () => {
    const s = read('src/services/acquisition/contactLockService.js');
    expect(s).toMatch(/SET state = 'paused', stop_reason = 'rep_took_lock'/);
    expect(s).toMatch(/if \(!\(reassign && isSuperAdmin\)\) throw err\(409, 'CONTACT_LOCKED'/);
  });
  test('1:1 rep email is refused for a suppressed address, and carries a one-click unsubscribe', async () => {
    const outreach = require('../../src/services/salesOutreachService');
    db.query.mockImplementation(async (sql) => {
      const t = String(sql).replace(/\s+/g, ' ');
      if (/FROM sales_prospects sp LEFT JOIN/.test(t)) return { rows: [{ id: 'p1', company_name: 'ABC', business_email: 'contact@abc.com', assigned_rep_user_id: 'rep1', contact_status: 'new_lead' }] };
      if (/FROM sales_rep_profiles p JOIN users u/.test(t)) return { rows: [{ user_id: 'rep1', display_name: 'Kym Witt', outreach_email: 'kym@advantage.bid', outreach_enabled: true, staff_active: true }] };
      if (/FROM email_suppressions/.test(t)) return { rows: [{ src: 'listing', reason: 'unsubscribe' }] };
      return { rows: [] };
    });
    const sendEmail = jest.fn(async () => ({ messageId: 'x' }));
    await expect(outreach.sendOutreach({ prospectId: 'p1', actingStaff: { id: 'rep1' }, subject: 'Hi', message: 'Hello' }, { sendEmail })).rejects.toMatchObject({ code: 'SUPPRESSED' });
    expect(sendEmail).not.toHaveBeenCalled();
    const src = read('src/services/salesOutreachService.js');
    expect(src).toMatch(/'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'/);
    expect(src).toMatch(/const APP_FROM_DISPLAY_SUFFIX = ' \| Advantage\.Bid';/);
    db.query.mockImplementation(async () => ({ rows: [] }));
  });
  test('1:1 rep email is refused while an automated listing sequence is active or someone else holds the lock', () => {
    const g = read('src/services/acquisition/outreachGuard.js');
    expect(g).toMatch(/LISTING_SEQUENCE_ACTIVE/);
    expect(g).toMatch(/is working this company/);
  });
});
