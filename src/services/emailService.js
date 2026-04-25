'use strict';

/**
 * emailService — thin Nodemailer wrapper used by the notification worker.
 *
 * Configuration comes entirely from environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
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
  EMAIL_FROM = 'noreply@advantageauction.bid',
} = process.env;

function buildTransporter() {
  return nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   parseInt(SMTP_PORT || '587', 10),
    secure: false,
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
 * @returns {Promise<object>}   Nodemailer info object
 * @throws on SMTP failure
 */
async function sendEmail({ to, subject, html }) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // SMTP not configured — log and skip without throwing so the worker
    // can still mark the row sent during local development.
    console.warn('[email] SMTP not configured — skipping delivery to', to);
    return { skipped: true };
  }

  const transporter = buildTransporter();
  const info = await transporter.sendMail({
    from:    EMAIL_FROM,
    to,
    subject,
    html,
  });

  console.log(`[email] Sent "${subject}" to ${to} — messageId: ${info.messageId}`);
  return info;
}

module.exports = { sendEmail };
