'use strict';

/**
 * Shared inbound email on Amazon SES (migration 172): security, parsing, campaign routing, STOP handling,
 * suppression hand-off, duplicates, holding while switched off, failure recovery, loop safety and the
 * oversight notice to info@advantage.bid. No network: S3, SNS verification and the programmes are stubbed.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:advantage-bid-inbound';
const BUCKET = 'advantage-bid-inbound-mail';
Object.assign(process.env, {
  SES_INBOUND_TOPIC_ARN: TOPIC, SES_INBOUND_BUCKET: BUCKET, SES_INBOUND_PREFIX: 'inbound/',
  SES_FEEDBACK_WEBHOOK_SECRET: 'test-only-webhook-secret',
});

jest.mock('../../src/db', () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })) }));
const db = require('../../src/db');
const sesInbound = require('../../src/services/inboundMail/sesInbound');
const oversight = require('../../src/services/inboundMail/oversightNotifier');
const classifier = require('../../src/services/eventPartners/replyClassifier');

const LKEY = 'l' + 'a'.repeat(24);
const PKEY = 'b'.repeat(24);
const listingAddr = 'listings+' + LKEY + '@reply.advantage.bid';
const partnerAddr = 'partner+' + PKEY + '@reply.advantage.bid';

function sns(overrides = {}, receiptOverrides = {}, mailOverrides = {}) {
  const message = {
    notificationType: 'Received',
    mail: Object.assign({ messageId: 'o5f7a9b1c3d5e7f9a1b3c5d7', source: 'owner@abcestates.com' }, mailOverrides),
    receipt: Object.assign({
      recipients: [listingAddr],
      spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' }, spfVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'PASS' },
      action: { type: 'S3', bucketName: BUCKET, objectKey: 'inbound/o5f7a9b1c3d5e7f9a1b3c5d7', topicArn: TOPIC },
    }, receiptOverrides),
  };
  return Object.assign({ Type: 'Notification', MessageId: 'sns-1', TopicArn: TOPIC, Message: JSON.stringify(message),
    Timestamp: '2026-09-27T20:00:00.000Z', SignatureVersion: '1', Signature: 'sig', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/c.pem' }, overrides);
}

function mime({ from = 'Mary Owner <owner@abcestates.com>', to = listingAddr, subject = 'Re: Your Advantage.Bid listing', body = 'STOP', headers = '' } = {}) {
  return Buffer.from([
    'From: ' + from, 'To: ' + to, 'Subject: ' + subject, 'Message-ID: <reply-1@abcestates.com>',
    'In-Reply-To: <out-1@advantage.bid>', 'Date: Sun, 27 Sep 2026 20:00:00 +0000', 'MIME-Version: 1.0',
    headers || null, 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '',
    body, '', '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>' + body + '</p>', '--b1--', '',
  ].filter((l) => l !== null).join('\r\n'));
}

// ── validation ──────────────────────────────────────────────────────────────────────────────────
describe('notification validation (only our topic, bucket, prefix and reply domain)', () => {
  test('a well-formed SES receipt notification is accepted', () => {
    const v = sesInbound.validateNotification(sns());
    expect(v.ok).toBe(true);
    expect(v.receipt).toMatchObject({ sesMessageId: 'o5f7a9b1c3d5e7f9a1b3c5d7', bucket: BUCKET, recipients: [listingAddr], mailFrom: 'owner@abcestates.com' });
    expect(v.receipt.verdicts).toEqual({ spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' });
  });
  test.each([
    ['another topic', sns({ TopicArn: 'arn:aws:sns:us-east-1:999999999999:someone-else' }), 'topic not allowed'],
    ['another bucket', sns({}, { action: { type: 'S3', bucketName: 'attacker-bucket', objectKey: 'inbound/x1234567' } }), 'bucket not allowed'],
    ['a key outside the prefix', sns({}, { action: { type: 'S3', bucketName: BUCKET, objectKey: 'other/x' } }), 'object key not allowed'],
    ['path traversal', sns({}, { action: { type: 'S3', bucketName: BUCKET, objectKey: 'inbound/../secret' } }), 'object key not allowed'],
    ['a non-S3 action', sns({}, { action: { type: 'SNS' } }), 'receipt action is not S3'],
    ['no reply-domain recipient', sns({}, { recipients: ['someone@advantage.bid'] }), 'no recipient on the reply domain'],
    ['a missing SES id', sns({}, {}, { messageId: '' }), 'missing SES message id'],
  ])('refuses %s', (_n, payload, reason) => {
    expect(sesInbound.validateNotification(payload)).toMatchObject({ ok: false, reason });
  });
  test('a non-Received notification (for example the AMAZON_SES_SETUP_NOTIFICATION) is ignorable', () => {
    const p = sns({ Message: JSON.stringify({ notificationType: 'AMAZON_SES_SETUP_NOTIFICATION' }) });
    expect(sesInbound.validateNotification(p)).toMatchObject({ ok: false, ignorable: true });
  });
});

// ── parsing + routing ───────────────────────────────────────────────────────────────────────────
describe('parsing a real message into the programme shape', () => {
  test('headers, sender, recipients and the plain-text body are extracted', async () => {
    const receipt = sesInbound.validateNotification(sns()).receipt;
    const n = await sesInbound.normalize(mime({ body: 'Please remove me. STOP' }), receipt);
    expect(n).toMatchObject({ provider: 'ses', providerMessageId: 'o5f7a9b1c3d5e7f9a1b3c5d7', fromEmail: 'owner@abcestates.com',
      fromName: 'Mary Owner', subject: 'Re: Your Advantage.Bid listing', to: [listingAddr] });
    expect(n.textBody).toMatch(/Please remove me\. STOP/);
    expect(n.inReplyTo).toBe('<out-1@advantage.bid>');
    expect(n.headers['content-type']).toMatch(/^multipart\/alternative/);
  });
  test('the real classifier reads a parsed STOP as STOP_UNSUBSCRIBE and an auto-reply as OUT_OF_OFFICE', async () => {
    const receipt = sesInbound.validateNotification(sns()).receipt;
    const stop = await sesInbound.normalize(mime({ body: 'STOP' }), receipt);
    expect(classifier.classify(stop).classification).toBe('STOP_UNSUBSCRIBE');
    const ooo = await sesInbound.normalize(mime({ body: 'I am away until Monday.', headers: 'Auto-Submitted: auto-replied' }), receipt);
    expect(classifier.classify(ooo).classification).toBe('OUT_OF_OFFICE');
  });
  test('the reply key in the recipient address decides the campaign; nothing is guessed', () => {
    expect(sesInbound.routeFor([listingAddr])).toBe('claimed_listing');
    expect(sesInbound.routeFor([partnerAddr])).toBe('event_partner');
    expect(sesInbound.routeFor(['listings@reply.advantage.bid'])).toBe('unmatched');
  });
  test('loop safety: mail from our own domains, or carrying our oversight header, is never processed as a reply', () => {
    expect(sesInbound.isOwnMail({ fromEmail: 'notifications@advantage.bid', headers: {} })).toBeTruthy();
    expect(sesInbound.isOwnMail({ fromEmail: 'x@reply.advantage.bid', headers: {} })).toBeTruthy();
    expect(sesInbound.isOwnMail({ fromEmail: 'owner@abcestates.com', headers: { 'x-advantage-oversight': '1' } })).toBeTruthy();
    expect(sesInbound.isOwnMail({ fromEmail: 'owner@abcestates.com', headers: {} })).toBeNull();
  });
});

// ── the pipeline, against an in-memory receipts row ─────────────────────────────────────────────
function harness({ switches = { claimed_listing: true, event_partner: false }, attempts = 0, status = 'received', recipients = [listingAddr], verdicts = { spam: 'PASS', virus: 'PASS' } } = {}) {
  const row = { id: 'r1', ses_message_id: 'o5f7a9b1c3d5e7f9a1b3c5d7', bucket: BUCKET, object_key: 'inbound/o5f7', recipients, mail_from: 'owner@abcestates.com',
    verdicts, status, attempts, notified_at: null, outcome: {} };
  const q = jest.fn(async (sql, p) => {
    const s = String(sql);
    if (/UPDATE inbound_email_receipts SET status = 'processing'/.test(s)) {
      if (!['received', 'held_disabled', 'failed'].includes(row.status)) return { rows: [], rowCount: 0 };
      row.status = 'processing'; row.attempts += 1; return { rows: [Object.assign({}, row)], rowCount: 1 };
    }
    if (/FROM platform_config/.test(s)) {
      return { rows: [{ key: 'claimed_listings.inbound_enabled', value: switches.claimed_listing }, { key: 'event_partners.inbound_enabled', value: switches.event_partner }] };
    }
    if (/UPDATE inbound_email_receipts\s+SET status = \$2::text/.test(s)) {
      row.status = p[1]; row.outcome = Object.assign(row.outcome, JSON.parse(p[2])); row.last_error = p[4]; row.next_attempt_at = p[5];
      if (p[1] === 'held_disabled') row.attempts = Math.max(row.attempts - 1, 0);
      return { rows: [], rowCount: 1 };
    }
    if (/SET notified_at = now\(\)/.test(s)) {
      if (row.notified_at) return { rows: [], rowCount: 0 };
      row.notified_at = new Date(); return { rows: [{ id: row.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const programmes = {
    claimed_listing: { ingest: jest.fn(async () => ({ ok: true, duplicate: false, classification: 'STOP_UNSUBSCRIBE', action: 'suppressed_stop_request', organizationId: 'o1', organizationName: 'ABC Estates' })) },
    event_partner: { ingest: jest.fn(async () => ({ ok: true, duplicate: false, classification: 'QUESTION', action: 'escalated_unknown', threadId: null })) },
  };
  const notify = jest.fn(async () => ({ messageId: 'n' }));
  const fetchRaw = jest.fn(async () => mime({ body: 'STOP' }));
  const deps = { db: { query: q }, programmes, oversight: { notify }, fetchRaw };
  return { row, q, programmes, notify, fetchRaw, deps };
}

describe('processing: routing, STOP, holds, duplicates', () => {
  test('a STOP reply to Claimed Listing outreach reaches the listing programme verified and digest-keyed, and notifies once', async () => {
    const h = harness();
    const out = await sesInbound.processReceipt('r1', h.deps);
    expect(out.status).toBe('processed');
    expect(h.programmes.claimed_listing.ingest).toHaveBeenCalledTimes(1);
    const [normalized, meta] = h.programmes.claimed_listing.ingest.mock.calls[0];
    expect(normalized.textBody).toMatch(/STOP/);
    expect(meta).toMatchObject({ signatureStatus: 'verified', provider: 'ses' });
    expect(meta.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(h.row.outcome).toMatchObject({ programme: 'claimed_listing', classification: 'STOP_UNSUBSCRIBE', company: 'ABC Estates' });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({ kind: 'opt_out', programme: 'claimed_listing', company: 'ABC Estates' });
    // Processing the same receipt again does nothing: it is no longer claimable.
    expect(await sesInbound.processReceipt('r1', h.deps)).toMatchObject({ skipped: true });
    expect(h.programmes.claimed_listing.ingest).toHaveBeenCalledTimes(1);
  });
  test('an Event Partner reply goes to the Event Partner programme', async () => {
    const h = harness({ recipients: [partnerAddr], switches: { claimed_listing: false, event_partner: true } });
    await sesInbound.processReceipt('r1', h.deps);
    expect(h.programmes.event_partner.ingest).toHaveBeenCalledTimes(1);
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0][0]).toMatchObject({ kind: 'reply', programme: 'event_partner' });
  });
  test('while the programme switch is OFF the message is HELD: not fetched, not parsed, not applied, attempts not used', async () => {
    const h = harness({ switches: { claimed_listing: false, event_partner: false } });
    const out = await sesInbound.processReceipt('r1', h.deps);
    expect(out.status).toBe('held_disabled');
    expect(h.fetchRaw).not.toHaveBeenCalled();
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.row.attempts).toBe(0);
    expect(h.row.next_attempt_at).toBeInstanceOf(Date);
  });
  test('a duplicate from the programme (already ingested) is recorded as duplicate and never notifies', async () => {
    const h = harness();
    h.programmes.claimed_listing.ingest.mockResolvedValueOnce({ ok: true, duplicate: true });
    const out = await sesInbound.processReceipt('r1', h.deps);
    expect(out.status).toBe('duplicate');
    expect(h.notify).not.toHaveBeenCalled();
  });
  test('auto-replies and bounces are handled silently (no oversight notice)', async () => {
    for (const r of [{ classification: 'OUT_OF_OFFICE', action: 'ignored_auto_reply' }, { classification: 'HARD_BOUNCE', action: 'suppressed_hard_bounce' }]) {
      const h = harness();
      h.programmes.claimed_listing.ingest.mockResolvedValueOnce(Object.assign({ ok: true, duplicate: false }, r));
      await sesInbound.processReceipt('r1', h.deps);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });
  test('a legal concern notifies as legal', async () => {
    const h = harness();
    h.programmes.claimed_listing.ingest.mockResolvedValueOnce({ ok: true, duplicate: false, classification: 'LEGAL_RIGHTS', action: 'escalated_legal', organizationName: 'ABC' });
    await sesInbound.processReceipt('r1', h.deps);
    expect(h.notify.mock.calls[0][0].kind).toBe('legal');
  });
  test('the programme switch turned off mid-flight holds the message rather than losing it', async () => {
    const h = harness();
    h.programmes.claimed_listing.ingest.mockRejectedValueOnce(Object.assign(new Error('off'), { code: 'INBOUND_DISABLED' }));
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('held_disabled');
  });
  test('no reply key while Event Partner inbound is off: a person reviews it (with its text)', async () => {
    const h = harness({ recipients: ['listings@reply.advantage.bid'] });
    const out = await sesInbound.processReceipt('r1', h.deps);
    expect(out.status).toBe('needs_review');
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0][0]).toMatchObject({ kind: 'needs_review', programme: 'unmatched' });
  });
  test('mail from our own domain is ignored (no loop)', async () => {
    const h = harness();
    h.fetchRaw.mockResolvedValueOnce(mime({ from: 'notifications@advantage.bid' }));
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('ignored');
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('unsafe mail', () => {
  test('a virus verdict of FAIL is quarantined without ever being fetched or parsed', async () => {
    const h = harness({ verdicts: { spam: 'PASS', virus: 'FAIL' } });
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('quarantined');
    expect(h.fetchRaw).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0][0]).toMatchObject({ kind: 'quarantined' });
    expect(h.notify.mock.calls[0][0].normalized).toBeUndefined();
  });
  test('a spam verdict of FAIL goes to a person instead of automation', async () => {
    const h = harness({ verdicts: { spam: 'FAIL', virus: 'PASS' } });
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('needs_review');
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    expect(h.notify.mock.calls[0][0].kind).toBe('needs_review');
  });
});

describe('failure recovery', () => {
  test('a failed S3 fetch is retried later with backoff, and nothing is applied', async () => {
    const h = harness();
    h.fetchRaw.mockRejectedValueOnce(new Error('S3 timeout'));
    const out = await sesInbound.processReceipt('r1', h.deps);
    expect(out.status).toBe('failed');
    expect(h.row.last_error).toMatch(/S3 timeout/);
    expect(h.row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(h.programmes.claimed_listing.ingest).not.toHaveBeenCalled();
    // Next pass succeeds.
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('processed');
  });
  test('after the last attempt it goes to a person, once', async () => {
    const h = harness({ status: 'failed', attempts: sesInbound.MAX_ATTEMPTS - 1 });
    h.fetchRaw.mockRejectedValueOnce(new Error('still failing'));
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('needs_review');
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0].kind).toBe('failed');
  });
  test('a programme error is retried (the programme ingest is idempotent)', async () => {
    const h = harness();
    h.programmes.claimed_listing.ingest.mockRejectedValueOnce(new Error('database busy'));
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('failed');
    expect((await sesInbound.processReceipt('r1', h.deps)).status).toBe('processed');
  });
  test('backoff grows and is capped', () => {
    expect(sesInbound.backoffSeconds(1)).toBe(300);
    expect(sesInbound.backoffSeconds(2)).toBe(600);
    expect(sesInbound.backoffSeconds(20)).toBe(6 * 60 * 60);
  });
});

describe('duplicate notifications from SNS', () => {
  test('recording is idempotent on the SES message id', async () => {
    const q = jest.fn(async (sql) => (/INSERT INTO inbound_email_receipts/.test(sql) ? { rows: [] } : { rows: [{ id: 'existing' }] }));
    const out = await sesInbound.record(sesInbound.validateNotification(sns()).receipt, { query: q });
    expect(out).toEqual({ id: 'existing', duplicate: true });
    expect(String(q.mock.calls[0][0])).toMatch(/ON CONFLICT \(ses_message_id\) DO NOTHING/);
  });
  test('a retried notification is acknowledged and not processed twice', async () => {
    const q = jest.fn(async (sql) => (/INSERT INTO inbound_email_receipts/.test(sql) ? { rows: [] } : { rows: [{ id: 'existing' }] }));
    const out = await sesInbound.handleVerifiedNotification(sns(), { db: { query: q }, sync: true });
    expect(out).toMatchObject({ accepted: true, duplicate: true });
  });
});

// ── oversight notice ────────────────────────────────────────────────────────────────────────────
describe('oversight notice to info@advantage.bid', () => {
  test('decision table: quiet for auto-replies, bounces and duplicates', () => {
    expect(oversight.decide({ classification: 'OUT_OF_OFFICE' }).notify).toBe(false);
    expect(oversight.decide({ classification: 'SOFT_BOUNCE' }).notify).toBe(false);
    expect(oversight.decide({ classification: 'QUESTION', duplicate: true }).notify).toBe(false);
    expect(oversight.decide({ classification: 'STOP_UNSUBSCRIBE' })).toEqual({ notify: true, kind: 'opt_out' });
    expect(oversight.decide({ classification: 'LEGAL_RIGHTS' })).toEqual({ notify: true, kind: 'legal' });
    expect(oversight.decide({ classification: 'QUESTION' })).toEqual({ notify: true, kind: 'reply' });
  });
  test('only the new text is included; quoted history, our links and sensitive numbers are removed', () => {
    const s = oversight.safeExcerpt([
      'Yes, call me. Card 4111 1111 1111 1111, SSN 123-45-6789.',
      'Claim link https://bid.advantage.bid/claim/abcDEF123',
      '',
      'On Mon, Sep 21, 2026 at 9:30 AM Kym <listings@advantage.bid> wrote:',
      '> People in Houston use Advantage.Bid ...',
    ].join('\n'));
    expect(s).toMatch(/Yes, call me\./);
    expect(s).not.toMatch(/4111|123-45-6789|claim\/abcDEF|People in Houston/);
    expect(oversight.safeExcerpt('x'.repeat(5000)).length).toBeLessThan(2100);
  });
  test('the notice names the campaign, company and handling, and is marked so nothing auto-responds to it', async () => {
    const sendEmail = jest.fn(async () => ({ messageId: 'm' }));
    await oversight.notify({ kind: 'opt_out', programme: 'claimed_listing', company: 'ABC Estates', classification: 'STOP_UNSUBSCRIBE', receiptId: 'r1',
      normalized: { fromEmail: 'owner@abcestates.com', subject: 'Re: listing', textBody: 'STOP' } }, { emailService: { sendEmail } });
    const m = sendEmail.mock.calls[0][0];
    expect(m.to).toBe('info@advantage.bid');
    expect(m.subject).toBe('[Claimed Listing outreach] Opt-out processed automatically: ABC Estates');
    expect(m.text).toMatch(/Company: ABC Estates/);
    expect(m.text).toMatch(/suppressed across campaigns/);
    expect(m.text).toMatch(/Message:\nSTOP/);
    expect(m.headers).toEqual({ 'Auto-Submitted': 'auto-generated', 'X-Advantage-Oversight': '1' });
    expect(m.html).not.toMatch(/<script/i);
  });
  test('a quarantined message is described without its content', () => {
    const c = oversight.compose({ kind: 'quarantined', programme: 'claimed_listing', fromEmail: 'x@y.com', reason: 'scan failed',
      normalized: { textBody: 'secret payload' } });
    expect(c.text).not.toMatch(/secret payload/);
  });
});

// ── the webhook route ───────────────────────────────────────────────────────────────────────────
describe('webhook security', () => {
  let server; let base; let signature; let quarantine;
  beforeAll(async () => {
    signature = require('../../src/lib/webhookSignature');
    quarantine = require('../../src/services/webhookQuarantineService');
    const express = require('express');
    const app = express();
    app.use('/api/webhooks/email', require('../../src/routes/webhooksEmail'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = 'http://127.0.0.1:' + server.address().port + '/api/webhooks/email/ses-inbound';
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  afterEach(() => jest.restoreAllMocks());
  const post = (payload, token = 'test-only-webhook-secret') => fetch(base + (token ? '?token=' + token : ''), {
    method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });

  test('refuses without the webhook secret', async () => {
    expect((await post(sns(), 'wrong')).status).toBe(401);
    expect((await post(sns(), null)).status).toBe(401);
  });
  test('refuses an unsigned message and a message from another SNS topic', async () => {
    const unsigned = sns(); delete unsigned.Signature;
    expect((await post(unsigned)).status).toBe(403);
    expect((await post(sns({ TopicArn: 'arn:aws:sns:us-east-1:999999999999:other' }))).status).toBe(403);
  });
  test('refuses a forged signature', async () => {
    jest.spyOn(signature, 'verifySns').mockResolvedValue({ ok: false, status: 'rejected_signature', reason: 'bad' });
    const handle = jest.spyOn(sesInbound, 'handleVerifiedNotification');
    expect((await post(sns())).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });
  test('when verification is unavailable the callback is quarantined and nothing is applied', async () => {
    jest.spyOn(signature, 'verifySns').mockResolvedValue({ ok: false, status: 'verify_unavailable', reason: 'cert fetch failed' });
    const q = jest.spyOn(quarantine, 'quarantine').mockResolvedValue({ quarantined: true, id: 'q1' });
    const handle = jest.spyOn(sesInbound, 'handleVerifiedNotification');
    expect((await post(sns())).status).toBe(202);
    expect(q.mock.calls[0][0]).toMatchObject({ provider: 'ses_inbound', signatureStatus: 'verify_unavailable' });
    expect(handle).not.toHaveBeenCalled();
  });
  test('a subscription confirmation is logged for the operator, never auto-confirmed', async () => {
    jest.spyOn(signature, 'verifySns').mockResolvedValue({ ok: true, status: 'verified' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const handle = jest.spyOn(sesInbound, 'handleVerifiedNotification');
    const res = await post(sns({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t', Token: 't' }));
    expect(res.status).toBe(200);
    expect(log.mock.calls.some((c) => /SubscribeURL: https:\/\/sns\.us-east-1\.amazonaws\.com/.test(c[0]))).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
  test('a verified notification is handed to the pipeline; a recording failure asks SNS to retry', async () => {
    jest.spyOn(signature, 'verifySns').mockResolvedValue({ ok: true, status: 'verified' });
    const handle = jest.spyOn(sesInbound, 'handleVerifiedNotification').mockResolvedValueOnce({ accepted: true, id: 'r1' });
    expect((await post(sns())).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
    handle.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post(sns())).status).toBe(500);
  });
  test('the response never reveals the company, campaign or classification', async () => {
    jest.spyOn(signature, 'verifySns').mockResolvedValue({ ok: true, status: 'verified' });
    jest.spyOn(sesInbound, 'handleVerifiedNotification').mockResolvedValue({ accepted: true, id: 'r1', programme: 'claimed_listing' });
    expect(await (await post(sns())).json()).toEqual({ ok: true });
  });
});

describe('wiring', () => {
  test('held callbacks that later verify are routed to the inbound pipeline, not the feedback parser', () => {
    const w = read('src/workers/webhookQuarantineWorker.js');
    expect(w).toMatch(/if \(sesInbound\.isInboundNotification\(payload\)\)[\s\S]*?handleVerifiedNotification/);
    expect(sesInbound.isInboundNotification(sns())).toBe(true);
    expect(sesInbound.isInboundNotification({ Type: 'Notification', TopicArn: 'x', Message: JSON.stringify({ eventType: 'Bounce' }) })).toBe(false);
  });
  test('the worker retries held and failed receipts', () => {
    expect(read('src/workers/claimedListingWorker.js')).toMatch(/sesInbound\.retryPending\(\{ limit: 20 \}\)/);
  });
  test('Postmark is gone from the runtime inbound path', () => {
    for (const f of ['src/routes/webhooksEmail.js', 'src/services/eventPartners/inboundEmailService.js', 'src/lib/webhookSignature.js', 'src/services/inboundMail/sesInbound.js']) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect([f, /postmark/i.test(code)]).toEqual([f, false]);
    }
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'scripts', 'send-postmark-validation-email.js'))).toBe(false);
  });
  test('migration 172 is additive and keys receipts on the SES message id', () => {
    const m = read('db/migrations/172_ses_inbound_email.sql');
    expect(m).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_receipts_ses_message ON inbound_email_receipts \(ses_message_id\)/);
    expect(m).not.toMatch(/\b(DROP|ALTER TABLE|UPDATE|DELETE)\b/i);
  });
});
