'use strict';

/**
 * emailService — thin Nodemailer wrapper used by the notification worker.
 *
 * Configuration comes entirely from environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *   SMTP_SECURE  — set to "true" for port-465 SSL; omit or "false" for port-587 STARTTLS
 *   EMAIL_FROM   — sender address; falls back to SMTP_FROM then SMTP_USER
 *   EMAIL_REPLY_TO — reply-to address
 *
 * sendEmail() throws on delivery failure so callers can handle retries.
 */

require('dotenv').config();
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  SMTP_FROM,
  EMAIL_REPLY_TO = 'advantageauction.bid@gmail.com',
} = process.env;

// EMAIL_FROM falls back to SMTP_FROM then SMTP_USER so the authenticated
// sender identity is always used when EMAIL_FROM is not explicitly set.
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_FROM || SMTP_USER || 'noreply@advantageauction.bid';

// Port 465 uses implicit SSL (secure: true); port 587 uses STARTTLS (secure: false).
// SMTP_SECURE env var overrides the port-based default for non-standard configs.
const port   = parseInt(SMTP_PORT || '587', 10);
const secure = SMTP_SECURE === 'true' || SMTP_SECURE === '1' || port === 465;

function buildTransporter() {
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port,
    secure,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * Send a single transactional email.
 *
 * @param {object} opts
 * @param {string} opts.to      - recipient address
 * @param {string} opts.subject - email subject line
 * @param {string} opts.html    - HTML body
 * @param {string} [opts.text]  - Plaintext fallback (strongly recommended)
 * @returns {Promise<object>}   Nodemailer info object
 * @throws on SMTP failure
 */
async function sendEmail({ to, subject, html, text }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // SMTP not configured — log and skip without throwing so the worker
    // can still mark the row sent during local development.
    console.warn('[email] SMTP not configured — skipping delivery to', to);
    return { skipped: true };
  }

  const transporter = buildTransporter();
  const info = await transporter.sendMail({
    from:    EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  });

  console.log(`[email] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);
  return info;
}

module.exports = { sendEmail };
