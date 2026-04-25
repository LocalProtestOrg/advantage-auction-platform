'use strict';

/**
 * smsService — thin Twilio wrapper used by the notification worker.
 *
 * Configuration via environment variables:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER
 *
 * sendSMS() throws on delivery failure so the worker can handle retries.
 * If Twilio credentials are absent it throws immediately (caller decides retry behaviour).
 */

require('dotenv').config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
} = process.env;

/**
 * Send a single SMS via Twilio.
 *
 * @param {object} opts
 * @param {string} opts.to      - E.164 recipient number, e.g. '+15551234567'
 * @param {string} opts.message - Plain-text body (max 160 chars recommended)
 * @throws if Twilio is not configured or delivery fails
 */
async function sendSMS({ to, message }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('Twilio not configured — TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER missing');
  }

  const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const result = await twilio.messages.create({
    from: TWILIO_FROM_NUMBER,
    to,
    body: message,
  });

  console.log(`[sms] Sent to ${to} — sid: ${result.sid}`);
  return result;
}

module.exports = { sendSMS };
