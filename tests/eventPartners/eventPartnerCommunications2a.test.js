'use strict';

/**
 * Event Partner Communications — Phase 2A regression suite (migration 154).
 *
 * The promises under test: a classification can never become an authorization; only stopping actions
 * happen automatically; a forged provider callback is refused and recorded; replays are idempotent;
 * the trust ladder is lightweight but cannot be walked around; the double lock genuinely refuses;
 * suppression stays separate from authorization; A15 still cannot reach a company; and the public
 * acquisition page is discoverable without ever being offered as a seller-product alternative.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ep-2a';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/**
 * Several assertions below check that a guarantee holds IN CODE. Reading the whole file would trip
 * over the prose that documents the guarantee — a header comment saying "authorizeWithToken is never
 * called from here" contains the very string being forbidden. So those assertions read the file with
 * comments removed: SQL `--`, JS `//` and block comments, and HTML comments.
 */
const stripComments = (src) => String(src)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
  .replace(/^\s*--.*$/gm, '');
const readCode = (...p) => stripComments(read(...p));

jest.mock('../../src/db', () => {
  const state = { routes: [], calls: [] };
  const query = async (sql, params) => {
    const text = String(sql);
    state.calls.push({ sql: text, params });
    for (const [re, handler] of state.routes) {
      if (re.test(text)) {
        const out = typeof handler === 'function' ? await handler(text, params) : handler;
        return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }), pool: { end: async () => {} }, __state: state };
});
const db = require('../../src/db');
const setRoutes = (routes) => { db.__state.routes = routes; db.__state.calls = []; };
const calls = () => db.__state.calls;

const classifier = require('../../src/services/eventPartners/replyClassifier');
const signature = require('../../src/lib/webhookSignature');
const threads = require('../../src/services/eventPartners/threadService');
const inbound = require('../../src/services/eventPartners/inboundEmailService');
const cohorts = require('../../src/services/eventPartners/cohortService');
const selfService = require('../../src/services/eventPartners/selfServiceService');
const suppression = require('../../src/services/eventPartners/partnerSuppressionService');
const agents = require('../../src/constants/marketingAgents');
const configService = require('../../src/services/configService');

let cfg = {};
beforeEach(() => {
  cfg = {};
  jest.spyOn(configService, 'get').mockImplementation(async (_o, k) => cfg[k]);
  setRoutes([]);
});
afterEach(() => { jest.restoreAllMocks(); });

const msg = (o) => Object.assign({ subject: '', textBody: '', headers: {}, fromEmail: 'mary@abcestates.com' }, o || {});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('a classification can never become an authorization', () => {
  test('the action vocabulary contains no authorizing, domain-changing or activating verb', () => {
    classifier.FORBIDDEN_ACTIONS.forEach((bad) => expect(classifier.ACTIONS).not.toContain(bad));
    expect(classifier.ACTIONS).toContain('resend_authorization_link');
    expect(classifier.ACTIONS).not.toContain('authorize');
  });

  test('"Sure, go ahead" yields a LINK, never a grant', () => {
    const v = classifier.classify(msg({ textBody: 'Sure, go ahead.' }));
    expect(v.classification).toBe('YES_AFFIRMATIVE');
    expect(v.action).toBe('resend_authorization_link');
  });

  test.each([
    'yes please', 'sounds good', 'you have permission', 'permission granted',
    'please proceed', 'sign us up', 'we are interested', 'authorize',
  ])('affirmative phrasing "%s" still only produces a link', (text) => {
    const v = classifier.classify(msg({ textBody: text }));
    expect(v.action).toBe('resend_authorization_link');
    expect(classifier.FORBIDDEN_ACTIONS).not.toContain(v.action);
  });

  test('no input of any class can produce a forbidden action', () => {
    const samples = [
      'yes', 'no thanks', 'stop', 'unsubscribe me', 'our attorney will be in touch',
      'our website is https://other.com', 'how much does this cost?', 'I am out of the office',
      'wrong person, please contact bob', '', 'asdf qwer zxcv',
    ];
    samples.forEach((t) => {
      const v = classifier.classify(msg({ textBody: t }));
      expect(classifier.ACTIONS).toContain(v.action);
      expect(classifier.FORBIDDEN_ACTIONS).not.toContain(v.action);
    });
  });

  test('the inbound service never calls the authorization grant', () => {
    const src = readCode('src', 'services', 'eventPartners', 'inboundEmailService.js');
    expect(src).not.toMatch(/authorizeWithToken|recordOfflineAuthorization/);
    // It may only transition to the terminal 'declined' state — a stopping direction.
    const transitions = src.match(/transition\(client, row, '([a-z_]+)'/g) || [];
    expect(transitions.length).toBeGreaterThan(0);
    transitions.forEach((t) => expect(t).toMatch(/'declined'/));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('deterministic signals beat body text', () => {
  test('a hard DSN suppresses; a transient DSN does not', () => {
    const hard = classifier.classify(msg({
      fromEmail: 'MAILER-DAEMON@example.com',
      headers: { 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' },
      textBody: 'Status: 5.1.1 user unknown',
    }));
    expect(hard.classification).toBe('HARD_BOUNCE');
    expect(hard.action).toBe('deliverability_hard');

    const soft = classifier.classify(msg({
      headers: { 'Content-Type': 'multipart/report; report-type=delivery-status' },
      textBody: 'Status: 4.2.2 mailbox full',
    }));
    expect(soft.classification).toBe('SOFT_BOUNCE');
    expect(soft.action).toBe('deliverability_soft');
  });

  test('an ungradeable delivery report is treated as TRANSIENT — never suppress on a guess', () => {
    const v = classifier.classify(msg({
      headers: { 'Content-Type': 'multipart/report; report-type=delivery-status' },
      textBody: 'something went wrong',
    }));
    expect(v.classification).toBe('SOFT_BOUNCE');
  });

  test.each([
    [{ 'Auto-Submitted': 'auto-replied' }, ''],
    [{ Precedence: 'auto_reply' }, ''],
    [{ 'X-Autoreply': 'yes' }, ''],
    [{}, 'Automatic reply: I am away'],
  ])('an auto-responder is ignored, not treated as a reply (%#)', (headers, subject) => {
    const v = classifier.classify(msg({ headers, subject, textBody: 'I am out of the office until Monday. Yes!' }));
    expect(v.classification).toBe('OUT_OF_OFFICE');
    expect(v.action).toBe('ignore');
  });

  test('Auto-Submitted: no is a real human reply, not an auto-responder', () => {
    const v = classifier.classify(msg({ headers: { 'Auto-Submitted': 'no' }, textBody: 'yes please' }));
    expect(v.classification).toBe('YES_AFFIRMATIVE');
  });

  test('an explicit opt-out suppresses; an innocent use of the word "stop" does not', () => {
    expect(classifier.classify(msg({ textBody: 'STOP' })).classification).toBe('STOP_UNSUBSCRIBE');
    expect(classifier.classify(msg({ textBody: 'please remove me from your list' })).classification).toBe('STOP_UNSUBSCRIBE');
    expect(classifier.classify(msg({ oneClickUnsubscribe: true })).classification).toBe('STOP_UNSUBSCRIBE');
    // Must NOT suppress.
    const innocent = classifier.classify(msg({ textBody: 'Yes — please stop by our showroom any time!' }));
    expect(innocent.classification).not.toBe('STOP_UNSUBSCRIBE');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('classification precedence is the safety property', () => {
  test('a legal concern outranks an apparent yes', () => {
    const v = classifier.classify(msg({ textBody: 'Yes, but our attorney wants to review the terms first.' }));
    expect(v.classification).toBe('LEGAL_RIGHTS');
    expect(v.action).toBe('escalate');
    expect(v.requiresHuman).toBe(true);
  });

  test('a decline outranks an affirmative word', () => {
    const v = classifier.classify(msg({ textBody: 'Yes I got your email, but we are not interested.' }));
    expect(v.classification).toBe('DECLINE');
    expect(v.action).toBe('stop_outreach');
  });

  test('a stop request outranks everything except a bounce', () => {
    const v = classifier.classify(msg({ textBody: 'Sounds good but please remove me from your list' }));
    expect(v.classification).toBe('STOP_UNSUBSCRIBE');
  });

  test('an already-authorized company is told nothing further is needed', () => {
    const v = classifier.classify(msg({ textBody: 'yes go ahead' }), { authorizationStatus: 'collecting' });
    expect(v.classification).toBe('ALREADY_AUTHORIZED');
    expect(v.action).toBe('confirm_already_authorized');
  });

  test('a corrected website is only ever PROPOSED, and always to a human', () => {
    const v = classifier.classify(
      msg({ textBody: 'Our website is actually https://www.abcestatesales.net not the other one' }),
      { authorizedDomain: 'abcestates.com' });
    expect(v.classification).toBe('CORRECTED_WEBSITE');
    expect(v.action).toBe('propose_domain_change');
    expect(v.requiresHuman).toBe(true);
    expect(v.extracted.urls.join(' ')).toMatch(/abcestatesales\.net/);
  });

  test('a URL that matches the already-authorized domain is not a correction', () => {
    const v = classifier.classify(
      msg({ textBody: 'Our website is https://www.abcestates.com — correct.' }),
      { authorizedDomain: 'abcestates.com' });
    expect(v.classification).not.toBe('CORRECTED_WEBSITE');
  });

  test('an interested reply that also asks something still flags a human', () => {
    const v = classifier.classify(msg({ textBody: 'Yes, interested. How much does it cost?' }));
    expect(v.classification).toBe('YES_AFFIRMATIVE');
    expect(v.action).toBe('resend_authorization_link');
    expect(v.requiresHuman).toBe(true);
  });

  test('an unreadable reply changes nothing and goes to a human', () => {
    const v = classifier.classify(msg({ textBody: 'asdf qwer' }));
    expect(v.classification).toBe('UNKNOWN');
    expect(v.action).toBe('escalate');
    expect(v.requiresHuman).toBe(true);
  });

  test('our own domain is never extracted as a corrected website', () => {
    expect(classifier.extractUrls('see https://bid.advantage.bid/x and https://other.com')).toEqual(['https://other.com']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('provider callback authenticity', () => {
  test('the canonical SNS string-to-sign is built exactly as AWS specifies, skipping absent fields', () => {
    const s = signature.buildStringToSign({
      Type: 'Notification', MessageId: 'm1', TopicArn: 'arn:x', Message: 'hello', Timestamp: 'T',
    });
    expect(s).toBe('Message\nhello\nMessageId\nm1\nTimestamp\nT\nTopicArn\narn:x\nType\nNotification\n');
    expect(s).not.toMatch(/Subject/);
  });

  test('only an AWS-owned .pem URL is ever fetched', () => {
    expect(signature.isAwsCertUrl('https://sns.us-east-1.amazonaws.com/x.pem')).toBe(true);
    ['http://sns.us-east-1.amazonaws.com/x.pem', 'https://evil.com/x.pem',
     'https://sns.us-east-1.amazonaws.com.evil.com/x.pem', 'https://sns.us-east-1.amazonaws.com/x.txt']
      .forEach((u) => expect(signature.isAwsCertUrl(u)).toBe(false));
  });

  test('a genuine signature verifies, and a tampered message does not', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // A self-signed certificate is not constructible here, so inject the public key as the "cert".
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    const base = { Type: 'Notification', MessageId: 'm1', TopicArn: 'arn:aws:sns:us-east-1:1:t',
      Message: '{"notificationType":"Bounce"}', Timestamp: '2026-09-12T00:00:00.000Z',
      SignatureVersion: '1', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem' };
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(signature.buildStringToSign(base), 'utf8');
    base.Signature = sign.sign(privateKey, 'base64');

    signature._certCache.clear();
    const good = await signature.verifySns(base, { fetchImpl: async () => pem });
    expect(good).toMatchObject({ ok: true, status: 'verified' });

    signature._certCache.clear();
    const tampered = Object.assign({}, base, { Message: '{"notificationType":"Complaint"}' });
    const bad = await signature.verifySns(tampered, { fetchImpl: async () => pem });
    expect(bad).toMatchObject({ ok: false, status: 'rejected_signature' });
  });

  test('a missing signature or a non-AWS cert host is a REJECTION, not an unavailability', async () => {
    await expect(signature.verifySns({ Type: 'Notification', MessageId: 'm' }))
      .resolves.toMatchObject({ status: 'rejected_signature' });
    await expect(signature.verifySns({
      Type: 'Notification', MessageId: 'm', Message: 'x', Timestamp: 't', TopicArn: 'a',
      Signature: 'AAAA', SigningCertURL: 'https://evil.example.com/x.pem',
    })).resolves.toMatchObject({ status: 'rejected_signature' });
  });

  test('an unreachable certificate is verify_unavailable — an infra fault, never "verified"', async () => {
    signature._certCache.clear();
    const out = await signature.verifySns({
      Type: 'Notification', MessageId: 'm', Message: 'x', Timestamp: 't', TopicArn: 'a',
      Signature: 'AAAA', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/x.pem',
    }, { fetchImpl: async () => { throw new Error('network down'); } });
    expect(out.status).toBe('verify_unavailable');
    expect(out.ok).toBe(false);
  });

  test('the Postmark secret is required and compared in constant time', () => {
    const opts = { expectedSecret: 'sekrit-value' };
    expect(signature.verifyPostmark({ query: { token: 'sekrit-value' }, headers: {} }, opts).ok).toBe(true);
    expect(signature.verifyPostmark({ query: {}, headers: { 'x-webhook-secret': 'sekrit-value' } }, opts).ok).toBe(true);
    const basic = 'Basic ' + Buffer.from('user:sekrit-value').toString('base64');
    expect(signature.verifyPostmark({ query: {}, headers: { authorization: basic } }, opts).ok).toBe(true);
    expect(signature.verifyPostmark({ query: { token: 'wrong' }, headers: {} }, opts).status).toBe('rejected_secret');
    expect(signature.verifyPostmark({ query: {}, headers: {} }, opts).status).toBe('rejected_secret');
    // No configured secret means nothing is ever accepted.
    expect(signature.verifyPostmark({ query: { token: 'x' }, headers: {} }, {}).status).toBe('rejected_secret');
  });

  test('the source allowlist can refuse a caller that has the secret', () => {
    const opts = { expectedSecret: 's', allowedIps: ['3.134.'], remoteIp: '9.9.9.9' };
    expect(signature.verifyPostmark({ query: { token: 's' }, headers: {} }, opts).status).toBe('rejected_source');
    expect(signature.verifyPostmark({ query: { token: 's' }, headers: {} },
      Object.assign({}, opts, { remoteIp: '3.134.1.2' })).ok).toBe(true);
  });

  test('the payload digest is stable and content-sensitive', () => {
    const a = signature.payloadDigest('{"a":1}');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(signature.payloadDigest('{"a":1}')).toBe(a);
    expect(signature.payloadDigest('{"a":2}')).not.toBe(a);
  });

  test('the SES receiver refuses an SNS-shaped payload with no signature', () => {
    const src = read('src', 'routes', 'sesFeedback.js');
    expect(src).toMatch(/REJECTED SNS-shaped payload with no Signature/);
    expect(src).toMatch(/rejected_signature/);
    expect(src).toMatch(/return res\.status\(403\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('conversation addressing', () => {
  test('a reply key is 96 bits of hex and safe in an email local part', () => {
    const k = threads.mintReplyKey();
    expect(k).toMatch(/^[0-9a-f]{24}$/);
    const addr = threads.replyAddressFor(k);
    expect(addr).toBe('partner+' + k + '@reply.advantage.bid');
    // Never the apex domain — that belongs to the existing mailboxes.
    expect(addr).not.toMatch(/@advantage\.bid$/);
  });

  test('reply keys do not repeat', () => {
    const many = new Set(Array.from({ length: 300 }, () => threads.mintReplyKey()));
    expect(many.size).toBe(300);
  });

  test('the key is recovered from MailboxHash, from a +suffix address, or from threading headers', () => {
    const k = threads.mintReplyKey();
    expect(threads.extractReplyKey({ mailboxHash: k })).toBe(k);
    expect(threads.extractReplyKey({ to: ['partner+' + k + '@reply.advantage.bid'] })).toBe(k);
    expect(threads.extractReplyKey({ toFull: [{ Email: 'PARTNER+' + k.toUpperCase() + '@reply.advantage.bid' }] })).toBe(k);
    expect(threads.extractReplyKey({ inReplyTo: '<' + k + '@bid.advantage.bid>' })).toBe(k);
  });

  test('a malformed or absent key returns null rather than guessing', () => {
    expect(threads.extractReplyKey({})).toBeNull();
    expect(threads.extractReplyKey({ mailboxHash: 'nope' })).toBeNull();
    expect(threads.extractReplyKey({ to: ['someone@example.com'] })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('inbound ingestion', () => {
  const postmark = {
    MessageID: 'pm-1', Subject: 'Re: your email', FromFull: { Email: 'mary@abcestates.com', Name: 'Mary' },
    ToFull: [{ Email: 'partner+aaaaaaaaaaaaaaaaaaaaaaaa@reply.advantage.bid', MailboxHash: 'aaaaaaaaaaaaaaaaaaaaaaaa' }],
    TextBody: 'Yes please, go ahead.', SpamScore: 0.4,
    Headers: [{ Name: 'Message-ID', Value: '<x@abcestates.com>' }],
  };

  test('the Postmark payload is normalized into the shape the classifier expects', () => {
    const n = inbound.fromPostmark(postmark);
    expect(n.provider).toBe('postmark');
    expect(n.providerMessageId).toBe('pm-1');
    expect(n.mailboxHash).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(n.fromEmail).toBe('mary@abcestates.com');
    expect(n.headers['Message-ID']).toBe('<x@abcestates.com>');
    expect(n.spamScore).toBe(0.4);
  });

  test('ingestion refuses while the inbound gate is OFF', async () => {
    cfg['event_partners.inbound_enabled'] = false;
    await expect(inbound.ingest(inbound.fromPostmark(postmark), { digest: 'd1', signatureStatus: 'verified' }))
      .rejects.toMatchObject({ code: 'INBOUND_DISABLED' });
  });

  test('an unverified callback can never reach the conversation store', async () => {
    cfg['event_partners.inbound_enabled'] = true;
    for (const status of ['rejected_signature', 'rejected_secret', 'rejected_source']) {
      await expect(inbound.ingest(inbound.fromPostmark(postmark), { digest: 'd', signatureStatus: status }))
        .rejects.toMatchObject({ code: 'UNVERIFIED_CALLBACK' });
    }
    expect(calls().some((c) => /INSERT INTO event_partner_messages/.test(c.sql))).toBe(false);
  });

  test('a replayed payload is idempotent and does nothing twice', async () => {
    cfg['event_partners.inbound_enabled'] = true;
    setRoutes([
      // The ON CONFLICT DO NOTHING returns no row → already seen.
      [/INSERT INTO event_partner_webhook_deliveries/, () => []],
    ]);
    const out = await inbound.ingest(inbound.fromPostmark(postmark), { digest: 'dup', signatureStatus: 'verified' });
    expect(out).toMatchObject({ ok: true, duplicate: true, reason: 'payload_replay' });
    expect(calls().some((c) => /INSERT INTO event_partner_messages/.test(c.sql))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the lightweight trust ladder', () => {
  test('Path A: a company-domain address needs no ceremony', () => {
    expect(selfService.domainMatches('mary@abcestates.com', 'abcestates.com')).toBe(true);
    expect(selfService.domainMatches('mary@sales.abcestates.com', 'abcestates.com')).toBe(true);
  });

  test('a free mailbox never satisfies Path A, however similar it looks', () => {
    expect(selfService.domainMatches('abcestates@gmail.com', 'abcestates.com')).toBe(false);
    expect(selfService.domainMatches('mary@outlook.com', 'abcestates.com')).toBe(false);
  });

  test('a lookalike domain does not match', () => {
    expect(selfService.domainMatches('mary@notabcestates.com', 'abcestates.com')).toBe(false);
    expect(selfService.domainMatches('mary@abcestates.com.evil.net', 'abcestates.com')).toBe(false);
  });

  test('Path B official contact must be ON the company domain and not a free mailbox', async () => {
    expect(await selfService.findOfficialContact(null, 'abcestates.com',
      { contact_email: 'info@abcestates.com' })).toMatchObject({ email: 'info@abcestates.com' });
    expect(await selfService.findOfficialContact(null, 'abcestates.com',
      { contact_email: 'abcestates@gmail.com' })).toBeNull();
    expect(await selfService.findOfficialContact(null, 'abcestates.com',
      { contact_email: 'info@somewhereelse.com' })).toBeNull();
    expect(await selfService.findOfficialContact(null, 'abcestates.com', null)).toBeNull();
  });

  test('Path A is chosen for a matching company address', async () => {
    setRoutes([
      [/FROM authorized_event_sources\s+a\s+WHERE a\.authorized_domain/, () => []],
      [/FROM organizations\s+o\s+WHERE lower\(regexp_replace/, () => []],
      [/count\(DISTINCT requester_email_normalized\)/, () => [{ n: 0 }]],
      [/count\(DISTINCT requested_domain\)/, () => [{ n: 0 }]],
      [/FROM users u/, () => []],
      [/SELECT id, name, slug, lifecycle_state, contact_email/, () => []],
    ]);
    const d = await selfService.evaluate(
      { companyWebsite: 'abcestates.com', requesterEmail: 'mary@abcestates.com' }, db);
    expect(d.path).toBe('a_domain_match');
    expect(d.nextStatus).toBe('verified');
    expect(d.verifiedVia).toBe('domain_match');
  });

  test('Path B is chosen for a personal address when the company publishes a contact', async () => {
    setRoutes([
      [/FROM authorized_event_sources\s+a\s+WHERE a\.authorized_domain/, () => []],
      [/FROM organizations\s+o\s+WHERE lower\(regexp_replace/, () => []],
      [/count\(DISTINCT requester_email_normalized\)/, () => [{ n: 0 }]],
      [/count\(DISTINCT requested_domain\)/, () => [{ n: 0 }]],
      [/FROM users u/, () => []],
      [/SELECT id, name, slug, lifecycle_state, contact_email/, () => [
        { id: 'org-1', name: 'ABC Estate Sales', contact_email: 'info@abcestates.com' }]],
    ]);
    const d = await selfService.evaluate(
      { companyWebsite: 'abcestates.com', requesterEmail: 'marysmith@gmail.com' }, db);
    expect(d.path).toBe('b_official_contact');
    expect(d.nextStatus).toBe('awaiting_company_confirmation');
    // The confirmation goes to the company's OWN published address, never the requester's.
    expect(d.officialContact.email).toBe('info@abcestates.com');
  });

  test('Path D is chosen when nothing is findable — never a DNS record', async () => {
    setRoutes([
      [/FROM authorized_event_sources\s+a\s+WHERE a\.authorized_domain/, () => []],
      [/FROM organizations\s+o\s+WHERE lower\(regexp_replace/, () => []],
      [/count\(DISTINCT requester_email_normalized\)/, () => [{ n: 0 }]],
      [/count\(DISTINCT requested_domain\)/, () => [{ n: 0 }]],
      [/FROM users u/, () => []],
      [/SELECT id, name, slug, lifecycle_state, contact_email/, () => []],
    ]);
    const d = await selfService.evaluate(
      { companyWebsite: 'abcestates.com', requesterEmail: 'marysmith@gmail.com' }, db);
    expect(d.path).toBe('d_admin_review');
    expect(d.nextStatus).toBe('needs_admin');
  });

  test('Path E blocks a domain already authorized by another live partner', async () => {
    setRoutes([
      [/FROM authorized_event_sources\s+a\s+WHERE a\.authorized_domain/, () => [
        { id: 'auth-x', organization_id: 'org-x', company_name: 'Someone Else', status: 'collecting' }]],
      [/FROM organizations\s+o\s+WHERE lower\(regexp_replace/, () => []],
      [/count\(DISTINCT requester_email_normalized\)/, () => [{ n: 0 }]],
      [/count\(DISTINCT requested_domain\)/, () => [{ n: 0 }]],
      [/FROM users u/, () => []],
      [/SELECT id, name, slug, lifecycle_state, contact_email/, () => []],
    ]);
    const d = await selfService.evaluate(
      // Even a perfect domain match cannot walk past an existing live authorization.
      { companyWebsite: 'abcestates.com', requesterEmail: 'mary@abcestates.com' }, db);
    expect(d.path).toBe('e_blocked');
    expect(d.nextStatus).toBe('needs_admin');
    expect(d.blockingRisks.map((r) => r.code)).toContain('domain_already_authorized');
  });

  test('Path E blocks a domain owned by an already-claimed organization', async () => {
    setRoutes([
      [/FROM authorized_event_sources\s+a\s+WHERE a\.authorized_domain/, () => []],
      [/FROM organizations\s+o\s+WHERE lower\(regexp_replace/, () => [
        { id: 'org-1', name: 'ABC Estate Sales', lifecycle_state: 'verified', owners: 1 }]],
      [/count\(DISTINCT requester_email_normalized\)/, () => [{ n: 0 }]],
      [/count\(DISTINCT requested_domain\)/, () => [{ n: 0 }]],
      [/FROM users u/, () => []],
      [/SELECT id, name, slug, lifecycle_state, contact_email/, () => []],
    ]);
    const d = await selfService.evaluate(
      { companyWebsite: 'abcestates.com', requesterEmail: 'mary@abcestates.com' }, db);
    expect(d.path).toBe('e_blocked');
  });

  test('the self-service form refuses while its gate is OFF', async () => {
    cfg['event_partners.self_service_enabled'] = false;
    await expect(selfService.submit({ companyName: 'ABC', companyWebsite: 'abcestates.com', requesterEmail: 'a@abcestates.com' }))
      .rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  });

  test('an unparseable website or email is refused before any lookup', async () => {
    cfg['event_partners.self_service_enabled'] = true;
    await expect(selfService.evaluate({ companyWebsite: 'not a domain', requesterEmail: 'a@b.com' }, db))
      .rejects.toMatchObject({ code: 'INVALID_WEBSITE' });
    await expect(selfService.evaluate({ companyWebsite: 'abcestates.com', requesterEmail: 'nope' }, db))
      .rejects.toMatchObject({ code: 'INVALID_EMAIL' });
  });

  test('no technical domain-control ceremony appears anywhere in the flow', () => {
    const src = readCode('src', 'services', 'eventPartners', 'selfServiceService.js');
    expect(src).not.toMatch(/TXT record|dns\.resolveTxt|well-known|verification file|upload.*file/i);
    // Nor anywhere else in the request path.
    expect(readCode('src', 'routes', 'publicEventPartner.js')).not.toMatch(/resolveTxt|well-known/i);
    const page = read('public', 'free-event-promotion.html');
    expect(page).toMatch(/No DNS records, no file uploads/);
  });

  test('a request never authorizes — the service never calls the grant', () => {
    const src = read('src', 'services', 'eventPartners', 'selfServiceService.js');
    expect(src).not.toMatch(/authorizeWithToken|recordOfflineAuthorization/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the double lock genuinely refuses', () => {
  const cohortRow = (o) => Object.assign({
    id: 'coh-1', name: 'Pilot', status: 'approved', template_status: 'approved',
    template_id: 'tpl-1', max_sends: 25, sends_used: 0,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }, o || {});

  const routesFor = (cohort, member, sentToday) => setRoutes([
    [/FROM event_partner_cohorts c/, () => (cohort ? [cohort] : [])],
    [/FROM event_partner_cohort_members\s+WHERE cohort_id/, () => (member ? [member] : [])],
    [/FROM event_partner_suppressions WHERE normalized_email/, () => []],
    [/FROM email_suppressions WHERE normalized_email/, () => []],
    [/count\(\*\)::int n FROM event_partner_cohort_members/, () => [{ n: sentToday == null ? 0 : sentToday }]],
  ]);

  test('with every lock satisfied EXCEPT the Owner gate, a send is still refused', async () => {
    cfg['event_partners.outreach_enabled'] = false;
    routesFor(cohortRow(), { id: 'm1', status: 'eligible' });
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.allowed).toBe(false);
    expect(out.blockedBy).toContain('outreach_disabled');
  });

  test('with the gate ON, a recipient outside the cohort is still refused', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    routesFor(cohortRow(), null);
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'stranger@elsewhere.com' }, db);
    expect(out.allowed).toBe(false);
    expect(out.blockedBy).toContain('recipient_not_in_cohort');
  });

  test('an unapproved template refuses even inside an approved cohort', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    routesFor(cohortRow({ template_status: 'draft' }), { id: 'm1', status: 'eligible' });
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.allowed).toBe(false);
    expect(out.blockedBy).toContain('template_not_approved');
  });

  test('an expired cohort approval refuses', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    routesFor(cohortRow({ expires_at: new Date(Date.now() - 1000).toISOString() }), { id: 'm1', status: 'eligible' });
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.blockedBy).toContain('cohort_expired');
  });

  test('a suppressed recipient refuses at SEND time, not queue time', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    setRoutes([
      [/FROM event_partner_cohorts c/, () => [cohortRow()]],
      [/FROM event_partner_cohort_members\s+WHERE cohort_id/, () => [{ id: 'm1', status: 'eligible' }]],
      [/FROM event_partner_suppressions WHERE normalized_email/, () => [{ reason: 'stop_request' }]],
      [/count\(\*\)::int n FROM event_partner_cohort_members/, () => [{ n: 0 }]],
    ]);
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.allowed).toBe(false);
    expect(out.blockedBy.join(' ')).toMatch(/suppressed:event_partner:stop_request/);
  });

  test('a GLOBAL marketing unsubscribe also refuses partner outreach', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    setRoutes([
      [/FROM event_partner_cohorts c/, () => [cohortRow()]],
      [/FROM event_partner_cohort_members\s+WHERE cohort_id/, () => [{ id: 'm1', status: 'eligible' }]],
      [/FROM event_partner_suppressions WHERE normalized_email/, () => []],
      [/FROM email_suppressions WHERE normalized_email/, () => [{ reason: 'unsubscribe', scope: 'marketing' }]],
      [/count\(\*\)::int n FROM event_partner_cohort_members/, () => [{ n: 0 }]],
    ]);
    const out = await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.blockedBy.join(' ')).toMatch(/suppressed:marketing:unsubscribe/);
  });

  test('the daily ceiling and the cohort cap both refuse', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    cfg['event_partners.daily_send_ceiling'] = 25;
    routesFor(cohortRow(), { id: 'm1', status: 'eligible' }, 25);
    expect((await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db)).blockedBy)
      .toContain('daily_ceiling_reached');
    routesFor(cohortRow({ sends_used: 25, max_sends: 25 }), { id: 'm1', status: 'eligible' }, 0);
    expect((await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db)).blockedBy)
      .toContain('cohort_send_cap_reached');
  });

  test('a recipient already sent to is not sent to again', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    routesFor(cohortRow(), { id: 'm1', status: 'sent' });
    expect((await cohorts.evaluateSend({ cohortId: 'coh-1', recipientEmail: 'mary@abcestates.com' }, db)).blockedBy)
      .toContain('already_sent');
  });

  test('no cohort at all refuses', async () => {
    cfg['event_partners.outreach_enabled'] = true;
    routesFor(null, null);
    const out = await cohorts.evaluateSend({ recipientEmail: 'mary@abcestates.com' }, db);
    expect(out.allowed).toBe(false);
    expect(out.blockedBy).toContain('no_cohort');
  });

  test('membership is frozen once a cohort is approved', async () => {
    setRoutes([[/SELECT \* FROM event_partner_cohorts WHERE id = \$1 FOR UPDATE/, () => [cohortRow()]]]);
    await expect(cohorts.addMember('coh-1', { recipientEmail: 'new@abcestates.com', actorId: 'u1' }))
      .rejects.toMatchObject({ code: 'COHORT_LOCKED' });
  });

  test('a cohort cannot be approved without an APPROVED template version', async () => {
    setRoutes([
      [/SELECT \* FROM event_partner_cohorts WHERE id = \$1 FOR UPDATE/, () => [cohortRow({ status: 'draft' })]],
      [/SELECT \* FROM event_partner_templates WHERE id = \$1/, () => [{ id: 'tpl-1', status: 'draft', template_key: 'k', version: 1 }]],
    ]);
    await expect(cohorts.approveCohort('coh-1', { templateId: 'tpl-1', actorId: 'u1' }))
      .rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED' });
    await expect(cohorts.approveCohort('coh-1', { actorId: 'u1' }))
      .rejects.toMatchObject({ code: 'TEMPLATE_REQUIRED' });
  });

  test('evaluateSend is honest that it never sends, and contains no transport', () => {
    const src = read('src', 'services', 'eventPartners', 'cohortService.js');
    expect(src).toMatch(/evaluateSend never sends/);
    expect(src).not.toMatch(/emailService|sendEmail|nodemailer|sendCampaignLive/);
  });

  test('nothing in the whole Phase 2A surface can transmit an email', () => {
    ['replyClassifier.js', 'threadService.js', 'inboundEmailService.js', 'cohortService.js',
     'escalationService.js', 'selfServiceService.js', 'partnerSuppressionService.js'].forEach((f) => {
      const src = read('src', 'services', 'eventPartners', f);
      expect(src).not.toMatch(/emailService|sendEmail\(|nodemailer|createTransport|sendCampaignLive/);
    });
    expect(read('src', 'routes', 'webhooksEmail.js')).not.toMatch(/emailService|sendEmail|nodemailer/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('suppression stays separate from authorization', () => {
  test('an invalid address is treated as suppressed rather than mailable', async () => {
    const out = await suppression.isSuppressed('not-an-email');
    expect(out.suppressed).toBe(true);
    expect(out.scope).toBe('invalid');
  });

  test('a clean address is not suppressed', async () => {
    setRoutes([
      [/FROM event_partner_suppressions WHERE normalized_email/, () => []],
      [/FROM email_suppressions WHERE normalized_email/, () => []],
    ]);
    expect((await suppression.isSuppressed('mary@abcestates.com')).suppressed).toBe(false);
  });

  test('suppressing never touches the authorization registry', async () => {
    setRoutes([[/INSERT INTO event_partner_suppressions/, () => [{ normalized_email: 'mary@abcestates.com' }]]]);
    await suppression.suppress({ email: 'mary@abcestates.com', reason: 'stop_request' });
    const sql = calls().map((c) => c.sql).join(' ');
    expect(sql).not.toMatch(/authorized_event_sources/);
    expect(sql).not.toMatch(/organization_members|organization_capabilities/);
  });

  test('a STOP reply suppresses outreach but never revokes an authorized source', () => {
    const src = read('src', 'services', 'eventPartners', 'inboundEmailService.js');
    const stopBranch = stripComments(src).slice(
      stripComments(src).indexOf("case 'STOP_UNSUBSCRIBE'"), stripComments(src).indexOf("case 'DECLINE'"));
    expect(stopBranch).toMatch(/suppression\.suppress/);
    expect(stopBranch).not.toMatch(/revoke|revoked/);
  });

  test('the migration states the six separate records and couples none of them', () => {
    const m = read('db', 'migrations', '154_event_partner_communications_2a.sql');
    expect(m).toMatch(/STOP does not revoke an authorized source/);
    expect(m).toMatch(/revocation does not imply an unsubscribe/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('A15 still cannot reach a company', () => {
  const a15 = agents.get('A15');

  test('it gained classification, threading and drafting — and nothing else', () => {
    expect(a15.capabilities.slice().sort()).toEqual([
      'classify_inbound_reply', 'draft_partner_outreach', 'draft_partner_reply',
      'propose_partner_outreach', 'read_partner_metrics', 'record_reply_thread',
    ]);
  });

  test('it cannot publish, spend or review', () => {
    expect([a15.canPublish, a15.canSpend, a15.canReview]).toEqual([false, false, false]);
  });

  test('it holds no send, authorize, claim or customer-service capability', () => {
    ['send_approved_outreach', 'send_templated_reply', 'grant_authorization', 'broaden_authorization',
     'change_authorized_domain', 'activate_collection_source', 'grant_listing_ownership',
     'answer_customer_service', 'answer_seller_inquiry', 'spend', 'publish']
      .forEach((cap) => expect(agents.agentCan('A15', cap)).toBe(false));
  });

  test('no agent in the roster holds any forbidden capability', () => {
    Object.values(agents.AGENTS).forEach((a) => {
      agents.FORBIDDEN_PHASE1_CAPABILITIES.forEach((cap) => expect(a.capabilities).not.toContain(cap));
    });
  });

  test('spend authority is still only the Director and Paid Media', () => {
    expect(Object.values(agents.AGENTS).filter((a) => a.canSpend).map((a) => a.code).sort()).toEqual(['A1', 'A8']);
  });

  test('classification is attributed to the rule engine unless the Owner gate names A15', () => {
    const src = read('src', 'services', 'eventPartners', 'inboundEmailService.js');
    expect(src).toMatch(/classifiedBy: verdict\.source === 'deterministic' \? 'deterministic' : \(classifyByAgent \? 'A15' : 'deterministic'\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('the public acquisition page', () => {
  const page = read('public', 'free-event-promotion.html');

  test('it is indexable and canonical, unlike the token page', () => {
    expect(page).toMatch(/<meta name="robots" content="index, follow/);
    expect(page).toMatch(/rel="canonical" href="https:\/\/bid\.advantage\.bid\/free-event-promotion"/);
    // The token-bearing page stays out of search.
    expect(read('public', 'authorize-event-promotion.html')).toMatch(/noindex, nofollow/);
  });

  test('it is registered in the sitemap at its canonical, extensionless path', () => {
    const server = read('server.js');
    expect(server).toMatch(/'\/free-event-promotion',/);
    expect(server).toMatch(/app\.get\('\/free-event-promotion\.html', \(req, res\) => res\.redirect\(301, '\/free-event-promotion'\)\)/);
  });

  test('it carries the Owner-approved proposition and CTA', () => {
    expect(page).toMatch(/Promote Your Events Completely Free &amp; Automatically/);
    expect(page).toMatch(/Authorize Free Event Promotion/);
    ['No cost', 'No duplicate data entry', 'No software to learn'].forEach((b) => expect(page).toContain(b));
  });

  test('it carries machine-readable structured data for search and AI answers', () => {
    expect(page).toMatch(/application\/ld\+json/);
    expect(page).toMatch(/"@type": "FAQPage"/);
    expect(page).toMatch(/"@type": "Service"/);
    expect(page).toMatch(/"priceCurrency": "USD"/);
    const json = page.slice(page.indexOf('{\n    "@context"'), page.indexOf('</script>'));
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('it asks for only the four permitted fields', () => {
    const names = (page.match(/<input id="([a-z_]+)"/g) || []).map((m) => m.replace(/.*id="|"/g, ''));
    expect(names.sort()).toEqual(['company_name', 'company_website', 'requester_email', 'requester_name']);
    expect(page).not.toMatch(/type="password"/);
  });

  test('it is NOT presented as an alternative to seller onboarding', () => {
    // Absent from the primary navigation.
    expect(read('public', 'widgets', 'shared', 'public-nav.js')).not.toMatch(/free-event-promotion/);
    // Absent from the Start Selling and professional onboarding pages.
    ['start-selling.html', 'professional-sellers.html'].forEach((f) => {
      try { expect(read('public', f)).not.toMatch(/free-event-promotion/); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
    // And it does not itself push the seller product.
    expect(page).not.toMatch(/Start Selling/);
  });

  test('it uses no AI or vendor terminology', () => {
    expect(page).not.toMatch(/\bA\.?I\.?\b|artificial intelligence|machine learning|GPT|OpenAI|LLM/i);
    expect(page).not.toMatch(/Postmark|Amazon SES|Cloudinary|Railway|Neon|nodemailer/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('migration 154 and mail-routing safety', () => {
  const m = read('db', 'migrations', '154_event_partner_communications_2a.sql');

  test('it is additive: no drops, no rewrites, no source creation', () => {
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(m).not.toMatch(/DELETE\s+FROM/i);
    expect(m).not.toMatch(/UPDATE\s+events\s+SET/i);
    expect(m).not.toMatch(/INSERT INTO import_sources/i);
    expect(m).not.toMatch(/UPDATE\s+authorized_event_sources\s+SET\s+status/i);
  });

  test('every new gate ships off or at its safe value', () => {
    ["('event_partners.inbound_enabled',            'false'",
     "('event_partners.self_service_enabled',       'false'",
     "('event_partners.a15_classify_enabled',       'false'",
     "('event_partners.a15_draft_reply_enabled',    'false'"].forEach((l) => expect(m).toContain(l));
    expect(m).toMatch(/\('event_partners\.webhook_signature_required', 'true'/);
    expect(m).toMatch(/\('event_partners\.raw_message_retention_days', '90'/);
  });

  test('A15 is updated without gaining publish, spend or review', () => {
    expect(m).toMatch(/UPDATE marketing_agents/);
    expect(m).toMatch(/can_publish = false, can_spend = false, can_review = false/);
    const seg = m.slice(m.indexOf('UPDATE marketing_agents'), m.indexOf("WHERE code = 'A15'"));
    expect(seg).not.toMatch(/send_approved_outreach|send_templated_reply/);
  });

  test('idempotency and replay protection are enforced by the schema, not by hope', () => {
    expect(m).toMatch(/uq_ep_messages_provider_id/);
    expect(m).toMatch(/uq_ep_webhook_payload/);
    expect(m).toMatch(/UNIQUE \(cohort_id, recipient_email_normalized\)/);
    expect(m).toMatch(/UNIQUE \(template_key, version\)/);
  });

  test('an approved cohort must name its approver and carry an approved template', () => {
    expect(m).toMatch(/chk_ep_cohort_approval_complete/);
  });

  test('nothing in Phase 2A touches the apex MX, info@, or the BD mailbox password', () => {
    const files = [
      'db/migrations/154_event_partner_communications_2a.sql',
      'src/services/eventPartners/threadService.js',
      'src/services/eventPartners/inboundEmailService.js',
      'src/routes/webhooksEmail.js',
      'public/free-event-promotion.html',
    ];
    files.forEach((rel) => {
      // Comments stripped: the migration header legitimately states that the apex MX and
      // info@advantage.bid are untouched, which is the opposite of a violation.
      const src = stripComments(read.apply(null, rel.split('/')));
      expect(src).not.toMatch(/info@advantage\.bid/);
      expect(src).not.toMatch(/imap|pop3|directorysecure|mail\.advantage\.bid/i);
      expect(src).not.toMatch(/BD_MAILBOX_PASSWORD|MAILBOX_PASSWORD/i);
    });
  });

  test('the reply namespace is a subdomain, never the apex', () => {
    expect(threads.REPLY_DOMAIN).toBe('reply.advantage.bid');
    expect(threads.PARTNER_FROM).toBe('events@advantage.bid');
    // The visible identity is the apex address; only the machine reply path is on the subdomain.
    expect(threads.replyAddressFor('a'.repeat(24))).toMatch(/@reply\.advantage\.bid$/);
  });

  test('the inbound webhook is gated off and refuses an unauthenticated caller', () => {
    const src = read('src', 'routes', 'webhooksEmail.js');
    expect(src).toMatch(/event_partners\.inbound_enabled/);
    expect(src).toMatch(/return res\.status\(404\)\.json\(\{ ok: false \}\)/);
    expect(src).toMatch(/recordRejection/);
    expect(src).toMatch(/return res\.status\(403\)\.json\(\{ ok: false \}\)/);
  });
});
