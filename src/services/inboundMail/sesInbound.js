'use strict';

/**
 * sesInbound — the shared inbound email pipeline on Amazon SES (replaces the unavailable Postmark provider).
 *
 *   reply.advantage.bid MX -> SES receipt rule (spam + virus scan)
 *     -> S3 action: the whole message is stored (no size limit that matters for replies)
 *     -> SNS notification (signed) -> POST /api/webhooks/email/ses-inbound
 *     -> this service: record -> fetch from S3 -> parse -> route by reply key -> programme ingest
 *        (Claimed Listing or Event Partner, which classify, suppress, stop sequences, open tasks, escalate)
 *     -> oversight notice to info@advantage.bid
 *
 * Guarantees:
 *   - Authenticity: the route accepts only SNS-signed notifications from OUR inbound topic (TopicArn pinned);
 *     here the S3 location must be our bucket and prefix, and recipients must be on the reply domain.
 *   - Exactly-once: one inbound_email_receipts row per SES message id; an atomic claim before processing;
 *     both programme ingests are idempotent on the message digest and provider message id.
 *   - Nothing is lost: the row is written before SNS is acknowledged; while a programme's inbound switch is
 *     OFF the message is HELD (not processed) and picked up once it is turned on; failures retry with
 *     backoff and then go to a person.
 *   - No loops: nothing here ever replies to a sender. Mail from our own domains, or carrying our oversight
 *     header, is ignored. Oversight notices are marked Auto-Submitted so auto-responders stay quiet.
 *   - Unsafe mail: a virus verdict of FAIL is quarantined and never parsed into a programme; a spam verdict
 *     of FAIL goes to a person (with its text) instead of automation.
 */

const crypto = require('crypto');
const db = require('../../db');
const { normalizeEmail } = require('../../lib/emailNormalize');
const oversight = require('./oversightNotifier');

const MAX_RAW_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;
const HOLD_RECHECK_SECONDS = 600;
const STALE_PROCESSING_MINUTES = 15;
const SES_SETUP_OBJECT = 'AMAZON_SES_SETUP_NOTIFICATION';

function config() {
  return {
    topicArn: process.env.SES_INBOUND_TOPIC_ARN || null,
    bucket: process.env.SES_INBOUND_BUCKET || null,
    prefix: process.env.SES_INBOUND_PREFIX || 'inbound/',
    region: process.env.SES_INBOUND_REGION || 'us-east-1',
    replyDomain: String(process.env.INBOUND_REPLY_DOMAIN || process.env.LISTING_REPLY_DOMAIN
      || process.env.EVENT_PARTNER_REPLY_DOMAIN || 'reply.advantage.bid').toLowerCase(),
    ownDomains: ['advantage.bid'],
  };
}

function backoffSeconds(attempts) {
  return Math.min(BASE_BACKOFF_SECONDS * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF_SECONDS);
}

// ── notification validation ─────────────────────────────────────────────────────────────────────

/** Is this SNS envelope an SES "Received" notification? (Used to route held callbacks correctly.) */
function isInboundNotification(snsPayload) {
  if (!snsPayload || snsPayload.Type !== 'Notification') return false;
  const cfg = config();
  if (cfg.topicArn && snsPayload.TopicArn === cfg.topicArn) return true;
  try { return JSON.parse(snsPayload.Message || '{}').notificationType === 'Received'; } catch (_) { return false; }
}

/**
 * Validate the SES receipt notification inside a VERIFIED SNS envelope and extract what we store.
 * Returns { ok: true, receipt } or { ok: false, reason, ignorable }.
 */
function validateNotification(snsPayload, cfg = config()) {
  if (!cfg.topicArn || !cfg.bucket) return { ok: false, reason: 'inbound not configured' };
  if (!snsPayload || snsPayload.TopicArn !== cfg.topicArn) return { ok: false, reason: 'topic not allowed' };
  let n;
  try { n = JSON.parse(snsPayload.Message || ''); } catch (_) { return { ok: false, reason: 'message is not JSON' }; }
  // Anything other than a receipt notification is unexpected on this topic: refused and reported, never
  // silently acknowledged.
  if (!n || n.notificationType !== 'Received') return { ok: false, reason: 'unexpected notification type: ' + String((n && n.notificationType) || 'none').slice(0, 60) };
  const receipt = n.receipt || {}; const mail = n.mail || {}; const action = receipt.action || {};
  if (action.type !== 'S3') return { ok: false, reason: 'receipt action is not S3' };
  if (action.bucketName !== cfg.bucket) return { ok: false, reason: 'bucket not allowed' };
  const key = String(action.objectKey || '');
  if (!key || !key.startsWith(cfg.prefix) || key.includes('..')) return { ok: false, reason: 'object key not allowed' };
  const recipients = (receipt.recipients || []).map((r) => String(r || '').toLowerCase())
    .filter((r) => r.endsWith('@' + cfg.replyDomain));
  // SES sends one setup notification when a rule's S3 action is saved, and stores a test object under the
  // prefix. Only that exact object, arriving through everything checked above (signed, our topic, our
  // bucket, our prefix) and addressed to nobody on the reply domain, is recognised and skipped quietly. A real
  // reply always has a reply-domain recipient, so it can never be mistaken for one.
  if (key === cfg.prefix + SES_SETUP_OBJECT && !recipients.length) {
    return { ok: false, reason: 'SES setup notification', ignorable: true, setup: true };
  }
  if (!mail.messageId || !/^[A-Za-z0-9._-]{8,200}$/.test(mail.messageId)) return { ok: false, reason: 'missing SES message id' };
  if (!recipients.length) return { ok: false, reason: 'no recipient on the reply domain' };
  const v = (x) => (x && x.status) || null;
  return {
    ok: true,
    receipt: {
      sesMessageId: mail.messageId, snsMessageId: snsPayload.MessageId || null, topicArn: snsPayload.TopicArn,
      bucket: action.bucketName, objectKey: key, recipients,
      mailFrom: normalizeEmail(mail.source || '') || null,
      verdicts: { spam: v(receipt.spamVerdict), virus: v(receipt.virusVerdict), spf: v(receipt.spfVerdict),
        dkim: v(receipt.dkimVerdict), dmarc: v(receipt.dmarcVerdict) },
    },
  };
}

// ── fetch + parse ───────────────────────────────────────────────────────────────────────────────

let _s3 = null;
function s3Client() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  // Dedicated IAM user advantage-bid-inbound-mail: s3:GetObject on <bucket>/inbound/* only.
  const id = process.env.SES_INBOUND_ACCESS_KEY_ID || process.env.SES_INBOUND_AWS_ACCESS_KEY_ID;
  const secret = process.env.SES_INBOUND_SECRET_ACCESS_KEY || process.env.SES_INBOUND_AWS_SECRET_ACCESS_KEY;
  if (!id || !secret) throw Object.assign(new Error('inbound S3 credentials are not configured'), { code: 'S3_NOT_CONFIGURED' });
  _s3 = new S3Client({ region: config().region, credentials: { accessKeyId: id, secretAccessKey: secret } });
  return _s3;
}

/** Download the stored message. Read-only; the key has already been checked against bucket + prefix. */
async function fetchRaw({ bucket, objectKey }, deps = {}) {
  const client = deps.s3 || s3Client();
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (out.ContentLength && out.ContentLength > MAX_RAW_BYTES) throw Object.assign(new Error('message too large'), { code: 'TOO_LARGE', permanent: true });
  const bytes = Buffer.from(await out.Body.transformToByteArray());
  if (bytes.length > MAX_RAW_BYTES) throw Object.assign(new Error('message too large'), { code: 'TOO_LARGE', permanent: true });
  return bytes;
}

function headerText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(headerText).join(', ');
  if (v.text) return v.text;
  if (v.value !== undefined) {
    const params = v.params ? Object.entries(v.params).map(([k, x]) => '; ' + k + '=' + x).join('') : '';
    return String(v.value) + params;
  }
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function stripHtml(html) {
  return String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

/**
 * Parse a raw RFC 5322 message into the shape both programme ingests already use (the same fields the
 * old provider adapter produced), so classification and routing code is unchanged.
 */
async function normalize(raw, receipt) {
  const { simpleParser } = require('mailparser');
  const p = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const headers = {};
  if (p.headers && typeof p.headers.forEach === 'function') {
    p.headers.forEach((value, key) => { headers[key] = headerText(value); });
  }
  const from = (p.from && p.from.value && p.from.value[0]) || {};
  const refs = Array.isArray(p.references) ? p.references.join(' ') : (p.references || null);
  const text = p.text || (p.html ? stripHtml(p.html) : '');
  return {
    provider: 'ses',
    providerMessageId: receipt.sesMessageId,
    messageIdHeader: p.messageId || headers['message-id'] || null,
    inReplyTo: p.inReplyTo || headers['in-reply-to'] || null,
    references: refs,
    mailboxHash: null,
    to: receipt.recipients.slice(),
    toEmail: receipt.recipients[0] || null,
    fromEmail: normalizeEmail(from.address || receipt.mailFrom || '') || from.address || null,
    fromName: from.name || null,
    subject: p.subject || null,
    textBody: String(text || '').slice(0, 100000),
    htmlBody: p.html ? String(p.html).slice(0, 200000) : null,
    headers,
    spamScore: receipt.verdicts && receipt.verdicts.spam === 'FAIL' ? 10 : 0,
    bounceType: null,
    // Attachment METADATA only (Sasha never opens attachments; the file stays in the private bucket).
    attachments: (p.attachments || []).slice(0, 20).map((a) => ({ filename: a.filename || null, contentType: a.contentType || null, size: a.size || null })),
  };
}

// ── routing ─────────────────────────────────────────────────────────────────────────────────────

const LISTING_KEY_RE = /\+(l[0-9a-f]{24})@/i;
const PARTNER_KEY_RE = /\+([0-9a-f]{24})@/i;

/** Which programme a message belongs to, from the reply key in the recipient address (never guessed). */
function routeFor(recipients, cfg = config()) {
  // Sasha: the dedicated company-inbox address (info@advantage.bid is forwarded here as a copy).
  const companyInbox = ('inbox@' + cfg.replyDomain).toLowerCase();
  for (const r of recipients || []) if (String(r).trim().toLowerCase() === companyInbox) return 'company_inbox';
  for (const r of recipients || []) if (LISTING_KEY_RE.test(r)) return 'claimed_listing';
  for (const r of recipients || []) if (PARTNER_KEY_RE.test(r)) return 'event_partner';
  return 'unmatched';
}

/** Mail we must never process as a reply: our own domains (loops) or our own oversight notices. */
function isOwnMail(normalized, cfg = config()) {
  const dom = String(normalized.fromEmail || '').split('@')[1] || '';
  if (cfg.ownDomains.some((d) => dom === d || dom.endsWith('.' + d))) return 'sent from an Advantage.Bid address';
  const h = normalized.headers || {};
  if (h['x-advantage-oversight']) return 'an Advantage.Bid oversight notice';
  return null;
}

/**
 * The programme switches plus two controls for supervised tests (neither is set in normal operation):
 *   inbound.allowed_senders            JSON array of addresses. While non-empty, ONLY mail from these senders
 *                                      (envelope AND From header) is processed; everything else stays held,
 *                                      unopened. Unset or [] = no restriction.
 *   inbound.oversight_notices_enabled  false = no notice to the oversight inbox (recorded on the receipt).
 *                                      Unset = notices on.
 */
async function switches(runner = db) {
  const rows = (await runner.query(
    `SELECT key, value FROM platform_config WHERE key IN ('claimed_listings.inbound_enabled', 'event_partners.inbound_enabled',
       'inbound.allowed_senders', 'inbound.oversight_notices_enabled', 'sasha.enabled', 'sasha.email_inbound_enabled')`)).rows;
  const m = {}; for (const r of rows) m[r.key] = r.value;
  const allowed = Array.isArray(m['inbound.allowed_senders'])
    ? m['inbound.allowed_senders'].map((a) => normalizeEmail(String(a || ''))).filter(Boolean) : [];
  return {
    claimed_listing: m['claimed_listings.inbound_enabled'] === true,
    event_partner: m['event_partners.inbound_enabled'] === true,
    company_inbox: m['sasha.enabled'] === true && m['sasha.email_inbound_enabled'] === true,
    allowedSenders: allowed,
    noticesEnabled: m['inbound.oversight_notices_enabled'] !== false,
  };
}

function senderAllowed(on, address) {
  if (!on.allowedSenders || !on.allowedSenders.length) return true;
  const a = normalizeEmail(String(address || ''));
  return !!a && on.allowedSenders.includes(a);
}

// ── record + process ────────────────────────────────────────────────────────────────────────────

/**
 * Record a verified notification. Idempotent on the SES message id: an SNS retry returns the existing row.
 * Returns { id, duplicate }.
 */
async function record(receipt, runner = db) {
  const ins = (await runner.query(
    `INSERT INTO inbound_email_receipts (ses_message_id, sns_message_id, topic_arn, bucket, object_key, recipients, mail_from, verdicts, programme, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())
     ON CONFLICT (ses_message_id) DO NOTHING RETURNING id`,
    [receipt.sesMessageId, receipt.snsMessageId, receipt.topicArn, receipt.bucket, receipt.objectKey, receipt.recipients,
      receipt.mailFrom, JSON.stringify(receipt.verdicts || {}), routeFor(receipt.recipients)])).rows[0];
  if (ins) return { id: ins.id, duplicate: false };
  const existing = (await runner.query(`SELECT id FROM inbound_email_receipts WHERE ses_message_id = $1`, [receipt.sesMessageId])).rows[0];
  return { id: existing && existing.id, duplicate: true };
}

/** Atomically claim a receipt for processing. Only one worker or request can hold it. */
async function claim(id, runner = db) {
  return (await runner.query(
    `UPDATE inbound_email_receipts SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND (status IN ('received', 'held_disabled', 'failed')
            OR (status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes'))
      RETURNING *`, [id])).rows[0] || null;
}

async function finish(id, status, fields = {}, runner = db) {
  await runner.query(
    `UPDATE inbound_email_receipts
        SET status = $2::text, outcome = outcome || $3::jsonb,
            attempts = CASE WHEN $2::text = 'held_disabled' THEN GREATEST(attempts - 1, 0) ELSE attempts END, raw_sha256 = COALESCE($4, raw_sha256), last_error = $5,
            next_attempt_at = $6, processed_at = CASE WHEN $2::text IN ('processed','duplicate','quarantined','ignored','needs_review') THEN now() ELSE processed_at END,
            updated_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(fields.outcome || {}), fields.rawSha256 || null, fields.error || null, fields.nextAttemptAt || null]);
}

async function markNotified(id, runner = db) {
  const r = await runner.query(`UPDATE inbound_email_receipts SET notified_at = now() WHERE id = $1 AND notified_at IS NULL RETURNING id`, [id]);
  return r.rowCount > 0;
}

function programmeServices() {
  return {
    claimed_listing: require('../claimedListings/inboundService'),
    event_partner: require('../eventPartners/inboundEmailService'),
  };
}

async function companyForThread(threadId, runner = db) {
  if (!threadId) return null;
  const r = (await runner.query(
    `SELECT COALESCE(o.name, t.company_email) AS name FROM event_partner_threads t LEFT JOIN organizations o ON o.id = t.organization_id WHERE t.id = $1`,
    [threadId]).catch(() => ({ rows: [] }))).rows[0];
  return (r && r.name) || null;
}

/**
 * Process one receipt end to end. Safe to call repeatedly: the claim makes it single-flight and every
 * downstream step is idempotent. `deps` lets tests replace S3, the parser inputs and the programmes.
 */
async function processReceipt(id, deps = {}) {
  const runner = deps.db || db;
  const row = await claim(id, runner);
  if (!row) return { id, skipped: true };
  const receipt = {
    sesMessageId: row.ses_message_id, bucket: row.bucket, objectKey: row.object_key, recipients: row.recipients || [],
    mailFrom: row.mail_from, verdicts: row.verdicts || {},
  };
  const programme = routeFor(receipt.recipients);
  const on = await switches(runner);
  const notifier = deps.oversight || oversight;
  // One oversight notice at most per receipt, and none while notices are switched off for a test.
  const maybeNotify = async (args) => {
    if (!on.noticesEnabled) {
      await runner.query(`UPDATE inbound_email_receipts SET outcome = outcome || $2::jsonb, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify({ notice: 'not sent: oversight notices switched off' })]);
      return false;
    }
    if (!(await markNotified(id, runner))) return false;
    await notifier.notify(args).catch((e) => console.error('[inbound] oversight notice failed:', e.message));
    return true;
  };
  const hold = async (why, rawSha256) => {
    await finish(id, 'held_disabled', { outcome: { programme, held: why }, rawSha256,
      nextAttemptAt: new Date(Date.now() + HOLD_RECHECK_SECONDS * 1000) }, runner);
    return { id, status: 'held_disabled', programme, held: why };
  };

  // HOLD while the programme that would handle it is switched off. Nothing is parsed or applied.
  const handles = programme === 'unmatched' ? (on.event_partner || on.claimed_listing) : on[programme];
  if (!handles) return hold('inbound switch off');
  // Supervised test: only the allow-listed sender is processed; anything else stays held, unopened.
  if (!senderAllowed(on, receipt.mailFrom)) return hold('sender not on the test allow-list');

  // A virus verdict of FAIL is never opened by the application.
  if (receipt.verdicts.virus === 'FAIL') {
    await finish(id, 'quarantined', { outcome: { programme, reason: 'virus verdict FAIL' } }, runner);
    await maybeNotify({ kind: 'quarantined', programme, receiptId: id, fromEmail: receipt.mailFrom, reason: 'The attachment scan failed, so the message was not opened.' });
    return { id, status: 'quarantined', programme };
  }

  let raw; let normalized;
  try {
    raw = deps.fetchRaw ? await deps.fetchRaw(receipt) : await fetchRaw(receipt);
    normalized = await normalize(raw, receipt);
  } catch (e) {
    return fail(id, row.attempts, e, programme, receipt, runner, maybeNotify);
  }
  const digest = crypto.createHash('sha256').update(raw).digest('hex');

  // Supervised test: the From header must be allow-listed too, not only the envelope sender.
  if (!senderAllowed(on, normalized.fromEmail)) return hold('sender not on the test allow-list', digest);

  const own = isOwnMail(normalized);
  if (own) {
    await finish(id, 'ignored', { outcome: { programme, reason: own }, rawSha256: digest }, runner);
    return { id, status: 'ignored', reason: own };
  }

  // Spam-flagged mail goes to a person, with its text, instead of automation.
  if (receipt.verdicts.spam === 'FAIL') {
    await finish(id, 'needs_review', { outcome: { programme, reason: 'spam verdict FAIL' }, rawSha256: digest }, runner);
    if (programme !== 'company_inbox') {   // company-inbox mail is a copy: the original is already in info@
      await maybeNotify({ kind: 'needs_review', programme, receiptId: id, normalized, reason: 'Marked as likely spam, so nothing was done automatically. Please check it.' });
    }
    return { id, status: 'needs_review', programme };
  }

  const svc = deps.programmes || programmeServices();
  const meta = { digest, signatureStatus: 'verified', provider: 'ses' };
  let result; let target = programme;
  if (programme === 'company_inbox') {
    // Sasha customer service — isolated from Claimed Listing / Event Partner. No oversight copy: info@ already has it.
    let r;
    try {
      r = await (deps.sashaEmail || require('../sasha/emailChannel')).handleInbound(normalized, { id });
    } catch (e) {
      if (e && e.code === 'INBOUND_DISABLED') return hold('inbound switch off', digest);
      return fail(id, row.attempts, e, programme, receipt, runner, async () => false, digest);
    }
    const st = r.status === 'ignored' ? 'ignored' : r.status === 'duplicate' ? 'duplicate' : 'processed';
    await finish(id, st, { outcome: { programme, sasha: r.status, reason: r.reason || null, reply: r.reply || null,
      conversation_id: r.conversation_id || null }, rawSha256: digest }, runner);
    return { id, status: st, programme, outcome: r };
  }
  try {
    if (programme === 'claimed_listing') result = await svc.claimed_listing.ingest(normalized, meta);
    else if (programme === 'event_partner' || (programme === 'unmatched' && on.event_partner)) {
      target = 'event_partner';
      result = await svc.event_partner.ingest(normalized, meta);
    } else {
      // No reply key and Event Partner inbound is off: a person decides.
      await finish(id, 'needs_review', { outcome: { programme, reason: 'no reply key' }, rawSha256: digest }, runner);
      await maybeNotify({ kind: 'needs_review', programme, receiptId: id, normalized, reason: 'This reply could not be matched to a campaign. Please check it.' });
      return { id, status: 'needs_review', programme };
    }
  } catch (e) {
    if (e && e.code === 'INBOUND_DISABLED') return hold('inbound switch off', digest);
    return fail(id, row.attempts, e, programme, receipt, runner, maybeNotify, digest);
  }

  const company = target === 'claimed_listing' ? (result.organizationName || null) : await companyForThread(result.threadId, runner);
  const outcome = { programme: target, classification: result.classification || null, action: result.action || null,
    duplicate: !!result.duplicate, company, organization_id: result.organizationId || null,
    thread_id: result.threadId || null, message_id: result.messageId || null };
  await finish(id, result.duplicate ? 'duplicate' : 'processed', { outcome, rawSha256: digest }, runner);

  const decision = oversight.decide(outcome);
  if (decision.notify) {
    await maybeNotify({ kind: decision.kind, programme: target, receiptId: id, normalized, company,
      classification: outcome.classification, action: outcome.action });
  }
  return { id, status: result.duplicate ? 'duplicate' : 'processed', programme: target, outcome };
}

async function fail(id, attempts, e, programme, receipt, runner, maybeNotify, digest) {
  const permanent = !!(e && e.permanent);
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
  const msg = String((e && e.message) || e).slice(0, 500);
  if (exhausted) {
    await finish(id, 'needs_review', { outcome: { programme, reason: 'could not be processed' }, error: msg, rawSha256: digest }, runner);
    await maybeNotify({ kind: 'failed', programme, receiptId: id, fromEmail: receipt.mailFrom,
      reason: 'The message could not be processed automatically after ' + attempts + ' attempt(s). It is kept safely for review.' });
    return { id, status: 'needs_review', error: msg };
  }
  await finish(id, 'failed', { error: msg, rawSha256: digest, nextAttemptAt: new Date(Date.now() + backoffSeconds(attempts) * 1000) }, runner);
  return { id, status: 'failed', error: msg };
}

/**
 * Entry point for a VERIFIED SNS envelope (from the route, or from the quarantine worker once a held
 * callback verifies). Records, then processes. Returns quickly-usable status for the HTTP answer.
 */
async function handleVerifiedNotification(snsPayload, deps = {}) {
  const v = validateNotification(snsPayload);
  if (!v.ok) return { accepted: false, ignorable: !!v.ignorable, reason: v.reason };
  const rec = await record(v.receipt, deps.db || db);
  if (rec.duplicate) return { accepted: true, duplicate: true, id: rec.id };
  const run = () => processReceipt(rec.id, deps).catch((e) => console.error('[inbound] processing failed:', e.message));
  if (deps.sync) return Object.assign({ accepted: true, id: rec.id }, await run());
  setImmediate(run);   // acknowledged first; the durable row guarantees the retry path
  return { accepted: true, id: rec.id };
}

/** Pick up held, failed and stale receipts. Called by the worker. */
async function retryPending({ limit = 20 } = {}, deps = {}) {
  const runner = deps.db || db;
  const ready = (await runner.query(`SELECT to_regclass('public.inbound_email_receipts') AS t`).catch(() => ({ rows: [{}] }))).rows[0];
  if (!ready || !ready.t) return { ran: false };
  const rows = (await runner.query(
    `SELECT id FROM inbound_email_receipts
      WHERE (status IN ('received', 'held_disabled', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
         OR (status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes')
      ORDER BY received_at ASC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)])).rows;
  const results = [];
  for (const r of rows) results.push(await processReceipt(r.id, deps));
  return { ran: true, considered: rows.length, results };
}

module.exports = {
  config, isInboundNotification, validateNotification, fetchRaw, normalize, routeFor, isOwnMail, switches,
  record, claim, processReceipt, handleVerifiedNotification, retryPending, backoffSeconds, MAX_ATTEMPTS,
};
