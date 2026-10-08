'use strict';

/**
 * One-time texts Phone Sasha sends to a VERIFIED caller at the verified number on their account (send_text and
 * send_payment_link). These are texts the caller asked for; they never create or imply text-alert consent, and a number
 * that replied STOP (sms_suppressions) is never texted.
 *
 *   simulated call → the message goes to the simulated handset (deps.handset) only; nothing leaves the server.
 *   real call      → NOT ENABLED in this release. It will require the phone channel switch, a provider, and an A2P
 *                    campaign that covers customer-care texts. Until then it refuses and Sasha offers another way.
 */

const phoneSettings = require('./phoneSettings');

async function send(call, { to, body }, deps = {}) {
  // A number that replied STOP gets nothing from Advantage.Bid, simulated or real (Sasha offers email instead).
  if (await require('../../smsSuppressionService').isSuppressed(to)) return { sent: false, reason: 'number_opted_out' };
  if (call.is_simulated) {
    if (Array.isArray(deps.handset)) deps.handset.push({ to_last4: String(to).slice(-4), body, at: new Date().toISOString(), kind: 'text' });
    return { sent: true, simulated: true };
  }
  const s = await phoneSettings.load();
  if (!s.enabled || s.provider === 'none' || process.env.SASHA_PHONE_SMS_ENABLED !== 'true') return { sent: false, reason: 'texting not enabled' };
  if (!require('../../../lib/phoneNumber').isTextable(to)) return { sent: false, reason: 'not a textable number' };
  try { await require('../../smsService').sendSMS({ to, message: body }); return { sent: true }; }
  catch (e) {
    if (await require('../../smsSuppressionService').handleSendError(e, to)) return { sent: false, reason: 'number_opted_out' };
    console.error('[sasha-phone] sms failed', e.message); return { sent: false, reason: 'send failed' };
  }
}

module.exports = { send };
