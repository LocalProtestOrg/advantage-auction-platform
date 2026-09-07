'use strict';

/**
 * smsService — thin Twilio wrapper used by the notification worker + owner operational alerts.
 *
 * Configuration via environment variables:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_MESSAGING_SERVICE_SID   (A2P-preferred sender — used when present)
 *   TWILIO_FROM_NUMBER             (fallback sender when no Messaging Service is configured)
 *
 * A2P 10DLC: when a registered Messaging Service SID is configured, sending via `messagingServiceSid`
 * is the correct production path (the A2P campaign + the sender number live under the Messaging Service).
 * We PREFER it and fall back to the raw `from` number only when a Messaging Service is not configured.
 *
 * sendSMS() throws on delivery failure so the caller can handle retries. If Twilio is not configured it
 * throws immediately. Never logs the auth token or message body; logs the recipient + provider SID only.
 */

require('dotenv').config();

// Read at call time (not destructured at module load) so tests / late-provisioned env are honored.
function twilioConfig() {
  return {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    from: process.env.TWILIO_FROM_NUMBER,
  };
}

// True only when credentials AND at least one sender (Messaging Service OR from number) are configured.
function isConfigured() {
  const c = twilioConfig();
  return !!(c.sid && c.token && (c.messagingServiceSid || c.from));
}

/**
 * Send a single SMS via Twilio.
 *
 * @param {object} opts
 * @param {string} opts.to      - E.164 recipient number, e.g. '+15551234567'
 * @param {string} opts.message - Plain-text body (max 160 chars recommended)
 * @throws if Twilio is not configured or delivery fails
 * @returns {{sid:string, status:string}} provider result
 */
async function sendSMS({ to, message }) {
  const c = twilioConfig();
  if (!c.sid || !c.token || (!c.messagingServiceSid && !c.from)) {
    throw new Error('Twilio not configured — need TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN and a sender (TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER)');
  }

  const twilio = require('twilio')(c.sid, c.token);

  // Prefer the registered A2P Messaging Service; fall back to the dedicated sender number.
  const params = { to, body: message };
  if (c.messagingServiceSid) params.messagingServiceSid = c.messagingServiceSid;
  else params.from = c.from;

  const result = await twilio.messages.create(params);

  console.log(`[sms] Sent to ${to} via ${c.messagingServiceSid ? 'messaging-service' : 'from-number'} — sid: ${result.sid}, status: ${result.status}`);
  return result;
}

module.exports = { sendSMS, isConfigured, twilioConfig };
