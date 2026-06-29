#!/usr/bin/env node
'use strict';

/**
 * One-shot Postmark transactional-email validation send.
 *
 * Purpose:
 *   Send a single, well-formed transactional email through the existing
 *   src/services/emailService.js Postmark integration so Postmark has
 *   evidence the platform is a legitimate transactional marketplace
 *   using operational email flows properly. Also serves as a reusable
 *   smoke-test utility for future deliverability validation.
 *
 * Safety properties:
 *   * Uses the existing emailService — no duplicate transport logic,
 *     no raw Postmark API calls.
 *   * Reads the Postmark token only via the service's process.env.SMTP_PASS.
 *     This script never reads the token directly and never writes it to
 *     any log.
 *   * Refuses to run if SMTP_PASS is unset.
 *   * Refuses to run if EMAIL_FROM is unset (no implicit fallback to
 *     SMTP_FROM / SMTP_USER / hardcoded default — every invocation must
 *     declare the sender explicitly).
 *   * Refuses to run if POSTMARK_VALIDATION_RECIPIENT is unset.
 *   * Validates basic email syntax for both sender and recipient.
 *   * Refuses to run twice without --force, via a single-use sentinel
 *     file. Prevents accidental re-sends from shell-history replay.
 *   * Logs only: environment summary, sender, recipient, start/finish
 *     timestamps, MessageID, and Postmark error code/message on failure.
 *
 * Usage (on the staging server):
 *   EMAIL_FROM=info@advantage.bid \
 *   POSTMARK_VALIDATION_RECIPIENT=advantageauction.bid@gmail.com \
 *   node scripts/send-postmark-validation-email.js
 *
 *   # To re-send (e.g., if the first attempt was rejected and a fix
 *   # has been applied in Postmark), pass --force:
 *   EMAIL_FROM=info@advantage.bid \
 *   POSTMARK_VALIDATION_RECIPIENT=advantageauction.bid@gmail.com \
 *   node scripts/send-postmark-validation-email.js --force
 *
 * Exit codes:
 *   0  success — MessageID printed
 *   1  precondition failed (env unset, malformed address, sentinel exists)
 *   2  Postmark API rejected the send — see error code/message in output
 *   3  unexpected error
 *
 * See docs/sop-postmark-validation.md for the full operator runbook,
 * DKIM status note, and troubleshooting reference.
 */

require('dotenv').config();
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SENTINEL = path.join(os.tmpdir(), 'advantage-postmark-validation.sent');

// Permissive RFC 5322-ish check — enough to catch fat-finger typos
// without rejecting legitimate addresses. Postmark itself does
// authoritative validation server-side.
const EMAIL_SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Hardcoded message contents (per operator spec) ──────────────────────────
const SUBJECT   = 'Advantage Auction Platform Transactional Email Test';
const TEXT_BODY = [
  'This is a transactional infrastructure validation email for the Advantage',
  'Auction Platform pilot environment.',
  '',
  'It is sent through the platform\'s production Postmark transport',
  '(src/services/emailService.js) as part of operational readiness validation.',
  '',
  'No action is required from the recipient.',
  '',
  '— Advantage Auction Platform operations',
].join('\n');

const HTML_BODY = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
    <h2 style="margin-top: 0; color: #0a0a0a;">Transactional Email Test</h2>
    <p>This is a transactional infrastructure validation email for the
       <strong>Advantage Auction Platform</strong> pilot environment.</p>
    <p>It is sent through the platform's production Postmark transport
       (<code>src/services/emailService.js</code>) as part of operational
       readiness validation.</p>
    <p>No action is required from the recipient.</p>
    <p style="color: #6b6b6b; font-size: 0.9em; margin-top: 32px;">
      &mdash; Advantage Auction Platform operations
    </p>
  </body>
</html>`;

// ── Preflight ───────────────────────────────────────────────────────────────
function fail(code, msg) {
  console.error(`[postmark-validation] ${msg}`);
  process.exit(code);
}

const args  = process.argv.slice(2);
const force = args.includes('--force');

// SMTP_PASS check (no value logged — only presence)
if (!process.env.SMTP_PASS) {
  fail(1, 'SMTP_PASS is not set in the environment. Postmark token required. Refusing to send.');
}

// EMAIL_FROM check (strict — no fallback to SMTP_FROM / SMTP_USER / default)
const EMAIL_FROM = process.env.EMAIL_FROM;
if (!EMAIL_FROM) {
  fail(1, 'EMAIL_FROM is not set. Every invocation must declare the sender explicitly. Example: EMAIL_FROM=info@advantage.bid');
}
if (!EMAIL_SYNTAX.test(EMAIL_FROM)) {
  fail(1, `EMAIL_FROM "${EMAIL_FROM}" does not look like a valid email address. Refusing to send.`);
}

// Recipient check (strict — must be supplied via env)
const RECIPIENT = process.env.POSTMARK_VALIDATION_RECIPIENT;
if (!RECIPIENT) {
  fail(1, 'POSTMARK_VALIDATION_RECIPIENT is not set. The recipient address must be supplied explicitly. Example: POSTMARK_VALIDATION_RECIPIENT=ops@example.com');
}
if (!EMAIL_SYNTAX.test(RECIPIENT)) {
  fail(1, `POSTMARK_VALIDATION_RECIPIENT "${RECIPIENT}" does not look like a valid email address. Refusing to send.`);
}

// Sentinel check (prevents accidental re-send via shell-history replay)
if (fs.existsSync(SENTINEL) && !force) {
  const sentAt = fs.statSync(SENTINEL).mtime.toISOString();
  fail(
    1,
    `Sentinel exists (${SENTINEL}) from a prior send at ${sentAt}. ` +
    `Re-run with --force if a second send is intentional.`
  );
}

// ── Identity / environment summary (no secrets) ─────────────────────────────
const startTimestamp = new Date();
console.log('[postmark-validation] preflight passed');
console.log('  Started at       :', startTimestamp.toISOString());
console.log('  NODE_ENV         :', process.env.NODE_ENV || '(unset)');
console.log('  EMAIL_FROM       :', EMAIL_FROM);
console.log('  EMAIL_REPLY_TO   :', process.env.EMAIL_REPLY_TO || '(default: advantageauction.bid@gmail.com)');
console.log('  SMTP_PASS set    :', `yes (length=${process.env.SMTP_PASS.length})`);
console.log('  Recipient        :', RECIPIENT);
console.log('  Subject          :', SUBJECT);
console.log('  Force flag       :', force ? 'yes' : 'no');
console.log('');

// ── Send via existing emailService (no duplicate transport) ─────────────────
const { sendEmail } = require('../src/services/emailService');

(async () => {
  console.log('[postmark-validation] sending …');
  const sendStart = Date.now();
  let result;
  try {
    result = await sendEmail({
      to:      RECIPIENT,
      subject: SUBJECT,
      html:    HTML_BODY,
      text:    TEXT_BODY,
    });
  } catch (err) {
    // emailService throws on Postmark non-2xx with err.statusCode and a
    // descriptive message that includes the Postmark error code.
    const elapsedMs = Date.now() - sendStart;
    console.error('');
    console.error('[postmark-validation] FAILED — Postmark did not accept the send.');
    console.error('  Elapsed (ms)   :', elapsedMs);
    console.error('  HTTP status    :', err.statusCode || '(unknown)');
    console.error('  Message        :', err.message);
    console.error('  Finished at    :', new Date().toISOString());
    console.error('');
    console.error('See docs/sop-postmark-validation.md → "Troubleshooting reference"');
    console.error('for the most common failure modes.');
    process.exit(2);
  }

  const finishTimestamp = new Date();
  const elapsedMs       = finishTimestamp.getTime() - sendStart;

  if (result && result.skipped) {
    // Defensive — preflight should have caught SMTP_PASS absence.
    fail(1, 'emailService reported skipped delivery (token unset?). No send occurred.');
  }

  // Write the sentinel so a second invocation refuses unless --force.
  try {
    fs.writeFileSync(SENTINEL, JSON.stringify({
      sent_at:   finishTimestamp.toISOString(),
      messageId: result.messageId,
      recipient: RECIPIENT,
      sender:    EMAIL_FROM,
      node_env:  process.env.NODE_ENV || null,
    }, null, 2));
  } catch (writeErr) {
    console.warn('[postmark-validation] (warning) could not write sentinel:', writeErr.message);
  }

  console.log('');
  console.log('[postmark-validation] SUCCESS');
  console.log('  Postmark accepted  : yes (HTTP 200)');
  console.log('  MessageID          :', result.messageId);
  console.log('  Recipient          :', RECIPIENT);
  console.log('  Sender             :', EMAIL_FROM);
  console.log('  Started at         :', startTimestamp.toISOString());
  console.log('  Finished at        :', finishTimestamp.toISOString());
  console.log('  Elapsed (ms)       :', elapsedMs);
  console.log('  Sentinel written   :', SENTINEL);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Postmark Dashboard → Activity → search this MessageID;');
  console.log('     confirm status is "Sent" (or progresses to "Delivered").');
  console.log('  2. Check the recipient inbox; capture timing if relevant.');
  console.log('  3. If sharing evidence with Postmark support, the MessageID');
  console.log('     above is the canonical reference.');
})().catch((err) => {
  console.error('[postmark-validation] unexpected error:', err && err.message ? err.message : err);
  process.exit(3);
});
