'use strict';

/**
 * POST /api/sms/inbound — inbound text messages from Twilio (STOP / START / HELP syncing, migration 190).
 *
 *   - Every request must carry a valid X-Twilio-Signature for our auth token; anything else is refused (403). With no
 *     Twilio credentials configured the route answers 503 and does nothing.
 *   - Idempotent: each Twilio MessageSid is processed once (sms_inbound_events.provider_message_id is UNIQUE).
 *   - STOP-family keywords: the number goes on the do-not-text list and BOTH optional alert types are turned off for
 *     every account tied to it. START-family: the number comes off the list; optional alerts stay off until the
 *     customer opts in again on the website. HELP / INFO: recorded only; nothing changes, no consent is created.
 *   - Twilio's own opt-out handling sends the STOP / START / HELP replies, so this route answers with empty TwiML
 *     (no second reply).
 *   - The message body is never stored or logged: only the matched keyword, a salted hash and the last 4 digits.
 *
 * Nothing is sent from here, and nothing here can opt anyone IN to alerts.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const consent = require('../services/smsConsentService');
const { normalizeUsPhone, identifierHash, last4 } = require('../lib/phoneNumber');

const router = express.Router();
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

/** The URLs Twilio may have signed: the canonical public base, and the host the request actually arrived on. */
function candidateUrls(req) {
  const path = req.originalUrl;
  const urls = new Set();
  try { urls.add(require('../lib/publicUrls').publicBaseUrl().replace(/\/+$/, '') + path); } catch (_e) { /* ignore */ }
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) urls.add('https://' + host + path);
  return [...urls];
}

function validSignature(req, deps = {}) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sig = req.get('x-twilio-signature');
  if (!token || !sig) return false;
  const validate = deps.validateRequest || require('twilio').validateRequest;
  return candidateUrls(req).some((u) => { try { return validate(token, sig, u, req.body || {}); } catch (_e) { return false; } });
}

/** Process one verified inbound message. Exported for tests. */
async function processInbound(params) {
  const sid = String(params.MessageSid || params.SmsSid || '').trim();
  if (!/^[A-Za-z0-9]{10,64}$/.test(sid)) return { status: 'ignored', reason: 'no message id' };
  const from = normalizeUsPhone(params.From);
  const c = consent.classify(params.Body, params.OptOutType || null);
  // Claim the message id first: a retry of the same message does nothing.
  const claimed = await db.query(`INSERT INTO sms_inbound_events (provider_message_id, from_hash, from_last4, keyword, action)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_message_id) DO NOTHING RETURNING id`,
  [sid, from.e164 ? identifierHash(from.e164) : null, from.e164 ? last4(from.e164) : null, c.keyword, c.action]);
  if (!claimed.rowCount) return { status: 'duplicate' };
  if (!from.e164 || c.action === 'other' || c.action === 'help') return { status: 'recorded', action: c.action };
  let r;
  try { r = await consent.handleInboundKeyword(from.e164, params.Body, { optOutType: params.OptOutType || null }); }
  catch (e) { await db.query(`DELETE FROM sms_inbound_events WHERE id = $1`, [claimed.rows[0].id]).catch(() => {}); throw e; }   // let Twilio's retry redo it
  await db.query(`UPDATE sms_inbound_events SET accounts_affected = $2, alerts_turned_off = $3 WHERE id = $1`, [claimed.rows[0].id, r.accounts || 0, r.changed || 0]);
  return { status: 'processed', action: r.action, accounts: r.accounts || 0, changed: r.changed || 0 };
}

function handler(deps = {}) {
  return async (req, res) => {
    if (!process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID) return res.status(503).type('text/plain').send('Not configured');
    if (!validSignature(req, deps)) return res.status(403).type('text/plain').send('Forbidden');
    try {
      const r = await processInbound(req.body || {});
      if (r.status === 'processed' || r.status === 'recorded') console.log(`[sms-inbound] ${r.action || 'other'} accounts=${r.accounts || 0} alerts_off=${r.changed || 0}`);
      return res.status(200).type('text/xml').send(EMPTY_TWIML);
    } catch (e) {
      console.error('[sms-inbound] failed', e.message);
      return res.status(500).type('text/plain').send('Error');   // Twilio retries; the message id makes the retry safe
    }
  };
}

router.post('/inbound', limiter, express.urlencoded({ extended: false, limit: '16kb' }), handler());

module.exports = router;
module.exports.processInbound = processInbound;
module.exports.handler = handler;
module.exports.candidateUrls = candidateUrls;
