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
  EMAIL_REPLY_TO = 'advantageauction.bid@gmail.com',
} = process.env;

// EMAIL_FROM falls back to SMTP_FROM then SMTP_USER so a sender identity is
// always present. NOTE: under SES, SMTP_USER is the SMTP *username* (not an
// email), so EMAIL_FROM (or SMTP_FROM) MUST be a verified @advantage.bid sender.
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_FROM || SMTP_USER || 'noreply@advantageauction.bid';

// One-time guard: warn if the resolved From is not a plausible email address
// (e.g. EMAIL_FROM/SMTP_FROM unset and the SES username fell through).
if (EMAIL_FROM && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(EMAIL_FROM)) {
  console.warn(`[email] EMAIL_FROM does not look like an email address ("${EMAIL_FROM}") - set EMAIL_FROM to a verified @advantage.bid sender; SES rejects an invalid/unverified From.`);
}

function isConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

// Lazy singleton transport - reused across sends.
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const port   = parseInt(SMTP_PORT || '587', 10);
  const secure = SMTP_SECURE === 'true' || SMTP_SECURE === '1' || port === 465;
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Pool connections so a burst at auction close doesn't pay a fresh STARTTLS
    // handshake per message and respects SES connection limits deliberately.
    pool: true,
    maxConnections: 5,
    maxMessages:    100,
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     30_000,
  });
  return _transporter;
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
async function sendEmail({ to, subject, html, text, attachments, replyTo }) {
  if (!isConfigured()) {
    console.warn('[email] SMTP/SES not configured - skipping delivery to', to);
    return { skipped: true };
  }

  try {
    const info = await getTransporter().sendMail({
      from:    EMAIL_FROM,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      // Per-message reply-to (e.g. a feedback submitter's address) overrides the default.
      replyTo: replyTo || EMAIL_REPLY_TO,
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

module.exports = { sendEmail };
