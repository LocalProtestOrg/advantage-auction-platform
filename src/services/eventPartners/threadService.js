'use strict';

/**
 * threadService — the machine-readable conversation state the Phase 2 requirement demanded.
 *
 * The routing idea in one line: every outbound Event Partner message carries a Reply-To of
 * `partner+<reply_key>@reply.advantage.bid`, so an inbound reply resolves to a company, a thread and
 * an authorization WITHOUT a human reading it and without guessing from the From address.
 *
 * That `+<reply_key>` suffix is exactly what an inbound-parse provider surfaces as MailboxHash, which
 * is why the addressing scheme and the provider choice fit together. The visible identity of the mail
 * stays `events@advantage.bid`; only the reply path lives on the machine-managed subdomain, so the
 * apex MX and info@advantage.bid are never involved.
 *
 * `reply_key` is 96 bits of randomness rendered as lowercase hex — safe in an email local part, not
 * enumerable, and carrying no company information. It is an addressing token, NOT a credential: it
 * identifies a conversation and grants nothing. Authorization still requires the Phase 1 token.
 */

const crypto = require('crypto');
const db = require('../../db');
const { withTransaction } = require('../../utils/withTransaction');
const { normalizeEmail } = require('../../lib/emailNormalize');
const configService = require('../configService');

function err(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; e.expose = true; return e;
}
const q = (client) => (client || db);

const REPLY_DOMAIN = (process.env.EVENT_PARTNER_REPLY_DOMAIN || 'reply.advantage.bid').toLowerCase();
const REPLY_MAILBOX = (process.env.EVENT_PARTNER_REPLY_MAILBOX || 'partner').toLowerCase();
// The visible sender. Configurable so the Owner can verify the identity before it is ever used.
const PARTNER_FROM = (process.env.EVENT_PARTNER_FROM_EMAIL || 'events@advantage.bid').toLowerCase();

const REPLY_KEY_RE = /^[0-9a-f]{24}$/;

/** Mint an addressing token for a new conversation. */
function mintReplyKey() {
  return crypto.randomBytes(12).toString('hex');
}

/** The Reply-To address for a thread. Never the apex domain. */
function replyAddressFor(replyKey) {
  return `${REPLY_MAILBOX}+${replyKey}@${REPLY_DOMAIN}`;
}

/**
 * Recover the reply key from whatever the provider gave us. Tries the provider's parsed MailboxHash
 * first, then the `+suffix` of any recipient address, then common threading headers as a last resort.
 * Returns null rather than guessing.
 */
function extractReplyKey(input) {
  input = input || {};
  const candidates = [];
  if (input.mailboxHash) candidates.push(String(input.mailboxHash));
  const addresses = []
    .concat(input.to || [], input.toFull || [], input.recipient || [], input.deliveredTo || []);
  for (const a of addresses) {
    const addr = typeof a === 'string' ? a : (a && (a.Email || a.email));
    if (!addr) continue;
    const m = String(addr).toLowerCase().match(/\+([0-9a-f]{24})@/);
    if (m) candidates.push(m[1]);
  }
  for (const hdr of [input.inReplyTo, input.references]) {
    if (!hdr) continue;
    const m = String(hdr).toLowerCase().match(/\b([0-9a-f]{24})\b/);
    if (m) candidates.push(m[1]);
  }
  const hit = candidates.find((c) => REPLY_KEY_RE.test(String(c).toLowerCase()));
  return hit ? String(hit).toLowerCase() : null;
}

// ── Threads ─────────────────────────────────────────────────────────────────────────────────────

/** Create a thread for an authorization (or a self-service request) and return it with its address. */
async function createThread(input, client) {
  input = input || {};
  const replyKey = mintReplyKey();
  const email = input.companyEmail || null;
  const { rows } = await q(client).query(
    `INSERT INTO event_partner_threads
       (reply_key, authorization_id, organization_id, request_id, company_email, company_email_normalized, subject, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [replyKey, input.authorizationId || null, input.organizationId || null, input.requestId || null,
     email, email ? normalizeEmail(email) : null, input.subject || null, input.status || 'open']);
  const thread = rows[0];
  thread.reply_address = replyAddressFor(thread.reply_key);
  return thread;
}

async function getByReplyKey(replyKey, client) {
  if (!REPLY_KEY_RE.test(String(replyKey || '').toLowerCase())) return null;
  const { rows } = await q(client).query(
    `SELECT t.*, a.status AS authorization_status, a.authorized_domain, a.company_name
       FROM event_partner_threads t
       LEFT JOIN authorized_event_sources a ON a.id = t.authorization_id
      WHERE t.reply_key = $1`, [String(replyKey).toLowerCase()]);
  return rows[0] || null;
}

async function getById(id, client) {
  const { rows } = await q(client).query(
    `SELECT t.*, a.status AS authorization_status, a.authorized_domain, a.company_name
       FROM event_partner_threads t
       LEFT JOIN authorized_event_sources a ON a.id = t.authorization_id
      WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Last-resort association when no reply key survived (a company composed a fresh email rather than
 * replying). Matches on the sender address against a thread we already have. Deliberately NOT a
 * match on company name or domain similarity — a wrong association would attribute one company's
 * words to another.
 */
async function findByParticipant(fromEmail, client) {
  const norm = normalizeEmail(fromEmail);
  if (!norm) return null;
  const { rows } = await q(client).query(
    `SELECT t.*, a.status AS authorization_status, a.authorized_domain, a.company_name
       FROM event_partner_threads t
       LEFT JOIN authorized_event_sources a ON a.id = t.authorization_id
      WHERE t.company_email_normalized = $1
      ORDER BY t.updated_at DESC LIMIT 1`, [norm]);
  return rows[0] || null;
}

/** An orphan thread holds a reply we could not attribute, so evidence is never discarded. */
async function createOrphanThread(fromEmail, subject, client) {
  const replyKey = mintReplyKey();
  const { rows } = await q(client).query(
    `INSERT INTO event_partner_threads
       (reply_key, company_email, company_email_normalized, subject, status)
     VALUES ($1,$2,$3,$4,'awaiting_human') RETURNING *`,
    [replyKey, fromEmail || null, normalizeEmail(fromEmail), subject || null]);
  return rows[0];
}

async function setStatus(threadId, status, client) {
  const { rows } = await q(client).query(
    'UPDATE event_partner_threads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [threadId, status]);
  return rows[0] || null;
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────────

/**
 * Append a message. Idempotent on (provider, provider_message_id): a provider webhook retry — which
 * every provider does — returns the existing row instead of creating a second one, so a retry can
 * never re-trigger an automated action.
 *
 * Bodies are retained only until `retain_until`; the classification, the headers we depend on and the
 * evidence fingerprint outlive them.
 */
async function appendMessage(input, client) {
  input = input || {};
  if (!input.threadId) throw err(400, 'THREAD_REQUIRED', 'A thread is required.');
  const retentionDays = Number(await configService.get(null, 'event_partners.raw_message_retention_days')) || 90;
  const retainUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

  if (input.providerMessageId) {
    const existing = (await q(client).query(
      'SELECT * FROM event_partner_messages WHERE provider = $1 AND provider_message_id = $2',
      [input.provider || 'internal', input.providerMessageId])).rows[0];
    if (existing) return { message: existing, duplicate: true };
  }

  const { rows } = await q(client).query(
    `INSERT INTO event_partner_messages
       (thread_id, direction, provider, provider_message_id, message_id_header, in_reply_to,
        from_email, from_name, to_email, subject, text_body, html_body, headers, spam_score,
        classification, classification_source, classification_confidence, classification_signals,
        classified_by, classified_at, action_taken, raw_evidence_sha256, retain_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23)
     RETURNING *`,
    [input.threadId, input.direction, input.provider || 'internal', input.providerMessageId || null,
     input.messageIdHeader || null, input.inReplyTo || null,
     input.fromEmail || null, input.fromName || null, input.toEmail || null, input.subject || null,
     input.textBody || null, input.htmlBody || null, JSON.stringify(input.headers || {}),
     input.spamScore != null ? input.spamScore : null,
     input.classification || null, input.classificationSource || null,
     input.classificationConfidence != null ? input.classificationConfidence : null,
     JSON.stringify(input.classificationSignals || {}),
     input.classifiedBy || null, input.classification ? new Date() : null,
     input.actionTaken || null, input.rawEvidenceSha256 || null, retainUntil]);
  const message = rows[0];

  // Keep the thread counters and timestamps usable without scanning messages.
  const isInbound = input.direction === 'inbound';
  await q(client).query(
    `UPDATE event_partner_threads
        SET inbound_count  = inbound_count  + CASE WHEN $2 THEN 1 ELSE 0 END,
            outbound_count = outbound_count + CASE WHEN $2 THEN 0 ELSE 1 END,
            last_inbound_at  = CASE WHEN $2 THEN now() ELSE last_inbound_at END,
            last_outbound_at = CASE WHEN $2 THEN last_outbound_at ELSE now() END,
            last_classification = COALESCE($3, last_classification),
            updated_at = now()
      WHERE id = $1`, [input.threadId, isInbound, input.classification || null]);

  return { message, duplicate: false };
}

async function listMessages(threadId, client) {
  const { rows } = await q(client).query(
    `SELECT id, direction, provider, from_email, to_email, subject, classification,
            classification_source, classification_confidence, action_taken, spam_score,
            redacted_at, received_at
       FROM event_partner_messages WHERE thread_id = $1 ORDER BY received_at ASC LIMIT 200`, [threadId]);
  return rows;
}

/**
 * Retention sweep: clear bodies past their window, keeping the classification, headers and evidence
 * fingerprint. Returns the number of messages redacted.
 */
async function runRetentionSweep(client) {
  const { rowCount } = await q(client).query(
    `UPDATE event_partner_messages
        SET text_body = NULL, html_body = NULL, redacted_at = now()
      WHERE redacted_at IS NULL AND retain_until IS NOT NULL AND retain_until < now()`);
  return rowCount;
}

module.exports = {
  REPLY_DOMAIN, REPLY_MAILBOX, PARTNER_FROM, REPLY_KEY_RE,
  mintReplyKey, replyAddressFor, extractReplyKey,
  createThread, getByReplyKey, getById, findByParticipant, createOrphanThread, setStatus,
  appendMessage, listMessages, runRetentionSweep,
};
