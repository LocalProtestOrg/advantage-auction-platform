'use strict';

/**
 * emailService — Postmark HTTP transport wrapper used by the notification worker.
 *
 * Configuration comes from environment variables:
 *   SMTP_PASS      — Postmark Server API Token (used as X-Postmark-Server-Token)
 *   EMAIL_FROM     — sender address; falls back to SMTP_FROM then SMTP_USER
 *   EMAIL_REPLY_TO — reply-to address
 *
 * SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER are preserved in Railway for
 * rollback safety but are not used by this transport.
 *
 * sendEmail() throws on delivery failure so callers can handle retries.
 */

require('dotenv').config();
const https = require('https');

const {
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  EMAIL_REPLY_TO = 'advantageauction.bid@gmail.com',
} = process.env;

// EMAIL_FROM falls back to SMTP_FROM then SMTP_USER so the authenticated
// sender identity is always used when EMAIL_FROM is not explicitly set.
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_FROM || SMTP_USER || 'noreply@advantageauction.bid';

/**
 * Send a single transactional email via Postmark HTTP API (port 443).
 *
 * @param {object} opts
 * @param {string} opts.to      - recipient address
 * @param {string} opts.subject - email subject line
 * @param {string} opts.html    - HTML body
 * @param {string} [opts.text]  - Plaintext fallback (strongly recommended)
 * @returns {Promise<object>}   { messageId } on success, { skipped: true } if unconfigured
 * @throws on delivery failure
 */
async function sendEmail({ to, subject, html, text }) {
  if (!SMTP_PASS) {
    console.warn('[email] Postmark token not configured — skipping delivery to', to);
    return { skipped: true };
  }

  const payload = JSON.stringify({
    From:          EMAIL_FROM,
    To:            to,
    Subject:       subject,
    HtmlBody:      html,
    ...(text ? { TextBody: text } : {}),
    ReplyTo:       EMAIL_REPLY_TO,
    MessageStream: 'outbound',
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.postmarkapp.com',
      port:     443,
      path:     '/email',
      method:   'POST',
      headers: {
        'Content-Type':              'application/json',
        'Accept':                    'application/json',
        'X-Postmark-Server-Token':   SMTP_PASS,
        'Content-Length':            Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }

        if (res.statusCode === 200) {
          console.log(`[email] Sent "${subject}" to ${to} — messageId: ${parsed.MessageID}`);
          resolve({ messageId: parsed.MessageID });
        } else {
          const msg = `Postmark API error ${res.statusCode} (code ${parsed.ErrorCode}): ${parsed.Message || body}`;
          console.error(`[email] Delivery failed for ${to} — status ${res.statusCode}, Postmark code ${parsed.ErrorCode}: ${parsed.Message}`);
          const err = new Error(msg);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error('Postmark API request timeout after 30s'));
    });

    req.on('error', (err) => {
      console.error(`[email] Postmark HTTP request error for ${to}:`, err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

module.exports = { sendEmail };
