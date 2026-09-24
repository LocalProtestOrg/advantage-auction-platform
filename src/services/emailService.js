'use strict';

/**
 * emailService - transactional email transport via Amazon SES (SMTP, nodemailer).
 *
 * Configuration (Railway env):
 *   SMTP_HOST      - SES SMTP endpoint, e.g. email-smtp.us-east-1.amazonaws.com
 *   SMTP_PORT      - 587 (STARTTLS); 465 for implicit TLS
 *   SMTP_SECURE    - 'true' only for port 465; otherwise false (STARTTLS on 587)
 *   SMTP_USER      - SES SMTP username
 *   SMTP_PASS      - SES SMTP password
 *   EMAIL_FROM     - sender address; falls back to SMTP_FROM then SMTP_USER
 *   EMAIL_REPLY_TO - reply-to address
 *
 * Public contract is unchanged from the prior Postmark wrapper:
 *   sendEmail({ to, subject, html, text })
 *     → { messageId } on success
 *     → { skipped: true } when email is not configured (no throw)
 *     → throws on delivery failure (the notification worker retries)
 * No caller changes, no template changes.
 *
 * (Replaces the prior Postmark HTTP transport - the Postmark account was rejected.)
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  SMTP_PORT,
  SMTP_SECURE,
  EMAIL_REPLY_TO,
} = process.env;

// EMAIL_FROM falls back to SMTP_FROM then SMTP_USER so a sender identity is
// always present. NOTE: under SES, SMTP_USER is the SMTP *username* (not an
// email), so EMAIL_FROM (or SMTP_FROM) MUST be a verified @advantage.bid sender.
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_FROM || SMTP_USER || 'noreply@advantageauction.bid';

// Reply-To honors the EMAIL_REPLY_TO env var (set it to support@advantage.bid). When
// unset it falls back to the branded From address — never a hardcoded personal inbox.
const EFFECTIVE_REPLY_TO = EMAIL_REPLY_TO || EMAIL_FROM;

// One-time guard: warn if the resolved From is not a plausible email address
// (e.g. EMAIL_FROM/SMTP_FROM unset and the SES username fell through).
if (EMAIL_FROM && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL_FROM)) {
  console.warn(`[email] EMAIL_FROM does not look like an email address ("${EMAIL_FROM}") - set EMAIL_FROM to a verified @advantage.bid sender; SES rejects an invalid/unverified From.`);
}

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

// Optional dedicated marketing SES configuration set (reputation/event isolation). Unset = no header,
// so behavior is unchanged until the Owner creates one and sets the env var.
const SES_MARKETING_CONFIGURATION_SET = process.env.SES_MARKETING_CONFIGURATION_SET || null;

// Dedicated Event Partner SES configuration set. Separate from marketing so the programme's delivery
// and complaint telemetry is attributable to it alone, and so its sending reputation can never damage
// bid notifications, invoices or password resets. Unset = no header, and the stream falls back to
// ordinary transactional behaviour rather than borrowing another stream's reputation.
const SES_EVENT_PARTNER_CONFIGURATION_SET = process.env.SES_EVENT_PARTNER_CONFIGURATION_SET || null;

// Dedicated Claimed Listing SES configuration set (migration 170). The listing programme's reputation and
// bounce/complaint telemetry are its own. Unset = no header; the listing send gate refuses to send at all
// while it is unset, so this stream never borrows another stream's reputation.
const SES_CLAIMED_LISTING_CONFIGURATION_SET = process.env.SES_CLAIMED_LISTING_CONFIGURATION_SET || null;

// The configuration set for a given mail stream. Unknown streams get none — never a default that
// would silently attribute mail to the wrong programme.
function configurationSetForStream(mailStream) {
  if (mailStream === 'marketing') return SES_MARKETING_CONFIGURATION_SET;
  if (mailStream === 'event_partner') return SES_EVENT_PARTNER_CONFIGURATION_SET;
  if (mailStream === 'claimed_listing') return SES_CLAIMED_LISTING_CONFIGURATION_SET;
  return null;
}

// Lazy singleton transports. TRANSACTIONAL isolation: marketing uses its OWN pooled connection set so a
// marketing burst can never starve the transactional pool (auth/bids/invoices keep their connections).
let _transporter = null;         // transactional (default) — unchanged
let _marketingTransporter = null;
function buildTransport(maxConnections) {
  const port   = parseInt(SMTP_PORT || '587', 10);
  const secure = SMTP_SECURE === 'true' || SMTP_SECURE === '1' || port === 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Pool connections so a burst at auction close doesn't pay a fresh STARTTLS
    // handshake per message and respects SES connection limits deliberately.
    pool: true,
    maxConnections,
    maxMessages:    100,
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     30_000,
  });
}
function getTransporter() {
  if (!_transporter) _transporter = buildTransport(5);
  return _transporter;
}
// Separate, smaller marketing pool — deliberately capped so bulk marketing yields to transactional mail.
function getMarketingTransporter() {
  if (!_marketingTransporter) _marketingTransporter = buildTransport(2);
  return _marketingTransporter;
}

/**
 * Send a single transactional email via Amazon SES (SMTP).
 *
 * @param {object} opts
 * @param {string} opts.to      - recipient address
 * @param {string} opts.subject - subject line
 * @param {string} opts.html    - HTML body
 * @param {string} [opts.text]  - plaintext fallback (recommended)
 * @param {Array}  [opts.attachments] - nodemailer attachments, e.g.
 *        [{ filename, content: <Buffer>, contentType: 'application/pdf' }]
 * @returns {Promise<object>} { messageId } on success, { skipped: true } if unconfigured
 * @throws on delivery failure
 */
async function sendEmail({ to, subject, html, text, attachments, replyTo, headers, fromName, bcc, mailStream, fromAddress }) {
  if (!isConfigured()) {
    console.warn('[email] SMTP/SES not configured - skipping delivery to', to);
    return { skipped: true };
  }

  try {
    // The technical From address ALWAYS stays the verified EMAIL_FROM sender (SPF/DKIM/DMARC alignment
    // is preserved). `fromName` only sets the friendly display name — e.g. "Kym Witt — Advantage.Bid"
    // <notifications@advantage.bid> — so a rep's identity is visible without a per-mailbox SES identity.
    // A programme may send from its OWN address on the verified domain (e.g. events@advantage.bid
    // for Event Partner outreach) so its reputation and its replies stay separate from platform
    // notifications. Only an address on the SAME verified domain is honoured — anything else would
    // break SPF/DKIM alignment, so it silently falls back to the verified default sender.
    const verifiedDomain = String(EMAIL_FROM || '').split('@')[1] || '';
    const requestedFrom = String(fromAddress || '').trim().toLowerCase();
    const senderAddress = (requestedFrom && verifiedDomain && requestedFrom.endsWith('@' + verifiedDomain))
      ? requestedFrom : EMAIL_FROM;
    const from = fromName ? `${String(fromName).replace(/["\r\n<>]/g, '').trim()} <${senderAddress}>` : senderAddress;
    // Event Partner mail is bulk-ish, low-volume outreach: it shares the marketing POOL (so it can
    // never starve the transactional pool) while carrying its OWN configuration set for telemetry.
    const isMarketing = mailStream === 'marketing';
    const isEventPartner = mailStream === 'event_partner';
    const usesMarketingPool = isMarketing || isEventPartner;
    const configurationSet = configurationSetForStream(mailStream);
    // Marketing uses its own pool; when an SES marketing configuration set is configured, tag the message
    // so bounces/complaints/deliveries publish to the marketing event destination (reputation isolation).
    const mergedHeaders = Object.assign({},
      (headers && typeof headers === 'object' ? headers : {}),
      (configurationSet ? { 'X-SES-CONFIGURATION-SET': configurationSet } : {}));
    // Claimed Listing outreach is bulk-ish too: it uses the marketing pool so it can never starve
    // transactional mail, while carrying its own configuration set.
    const transporter = (isMarketing || mailStream === 'claimed_listing') ? getMarketingTransporter() : getTransporter();
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(bcc ? { bcc } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      // Custom SMTP headers (e.g. List-Unsubscribe / List-Unsubscribe-Post for one-click unsubscribe).
      ...(Object.keys(mergedHeaders).length ? { headers: mergedHeaders } : {}),
      // Per-message reply-to (e.g. the assigned sales rep's approved @advantage.bid address).
      replyTo: replyTo || EFFECTIVE_REPLY_TO,
    });
    console.log(`[email] Sent "${subject}" to ${to} - messageId: ${info.messageId}`);
    return { messageId: info.messageId };
  } catch (err) {
    console.error(`[email] Delivery failed for ${to} - ${err.message}`);
    // Preserve an analog of the prior Postmark err.statusCode for callers/logs.
    if (err.responseCode) err.statusCode = err.responseCode;
    throw err;
  }
}

module.exports = {
  sendEmail, isConfigured, EMAIL_FROM,
  marketingConfigurationSet: () => SES_MARKETING_CONFIGURATION_SET,
  eventPartnerConfigurationSet: () => SES_EVENT_PARTNER_CONFIGURATION_SET,
  claimedListingConfigurationSet: () => SES_CLAIMED_LISTING_CONFIGURATION_SET,
  configurationSetForStream,
};
