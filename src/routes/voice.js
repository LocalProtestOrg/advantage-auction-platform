'use strict';

/**
 * /api/voice — Twilio Voice webhooks for Phone Sasha (migration 191). Every request must carry a valid
 * X-Twilio-Signature; anything else gets 403. With no Twilio credentials configured the routes answer 503.
 *
 *   POST /incoming   a call arrives → "not available" (line off, or caller not on the staff test list) or the menu
 *   POST /menu       the caller's key press → connect to Sasha with the reason, or re-prompt once; busy / budget → message
 *   POST /after      the relay session ended → goodbye (or a short apology if it failed). Never a transfer or <Dial>.
 *
 * The WebSocket side (/api/voice/relay) lives in services/sasha/phone/relayServer.js.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const phoneSettings = require('../services/sasha/phone/phoneSettings');
const line = require('../services/sasha/phone/voiceLine');
const signature = require('../lib/twilioSignature');
const { normalizeUsPhone, last4 } = require('../lib/phoneNumber');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
router.use(limiter, express.urlencoded({ extended: false, limit: '32kb' }));

function base() { return require('../lib/publicUrls').publicBaseUrl().replace(/\/+$/, ''); }
const twiml = (res, xml) => res.status(200).type('text/xml').send(xml);

function guard(deps = {}) {
  return (req, res, next) => {
    if (!process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_ACCOUNT_SID) return res.status(503).type('text/plain').send('Not configured');
    if (!signature.validExpressRequest(req, deps)) return res.status(403).type('text/plain').send('Forbidden');
    return next();
  };
}

async function logRefusal(reason, from) {
  const n = normalizeUsPhone(from);
  console.log(`[voice] call not connected: ${reason}${n.e164 ? ' (caller ending ' + last4(n.e164) + ')' : ''}`);
  await require('../lib/auditLog').writeAuditLog({ event_type: 'sasha.phone_call_not_connected', entity_type: 'phone_call', entity_id: '00000000-0000-0000-0000-000000000000',
    actor_id: null, metadata: { reason, caller_last4: n.e164 ? last4(n.e164) : null } }).catch(() => {});
}

function incoming(deps = {}) {
  return async (req, res) => {
    phoneSettings.clear();
    const s = await phoneSettings.load();
    const lineOn = await phoneSettings.relayLineOn();
    const callerAllowed = lineOn && s.access_mode !== 'public' ? await require('../services/sasha/phone/testCallers').isAllowed(req.body.From) : true;
    const d = line.decideIncoming({ lineOn, accessMode: s.access_mode, callerAllowed });
    if (d.action !== 'menu') { await logRefusal(d.reason, req.body.From); return twiml(res, line.sayAndHangup(line.MESSAGES.unavailable, s.voice)); }
    return twiml(res, line.menuTwiml(s, { actionUrl: base() + '/api/voice/menu?attempt=1' }));
  };
}

function menu(deps = {}) {
  return async (req, res) => {
    const s = await phoneSettings.load();
    if (!(await phoneSettings.relayLineOn())) { await logRefusal('line_off', req.body.From); return twiml(res, line.sayAndHangup(line.MESSAGES.unavailable, s.voice)); }
    // Re-check the test list on every step (the menu URL could be replayed for another call).
    if (s.access_mode !== 'public' && !(await require('../services/sasha/phone/testCallers').isAllowed(req.body.From))) {
      await logRefusal('not_on_test_list', req.body.From); return twiml(res, line.sayAndHangup(line.MESSAGES.unavailable, s.voice));
    }
    const attempt = Number(req.query.attempt) || 1;
    let reason = line.REASONS[String(req.body.Digits || '').trim()] || null;
    if (!reason && attempt < 2) return twiml(res, line.menuTwiml(s, { actionUrl: base() + '/api/voice/menu?attempt=2', retry: true }));
    if (!reason) reason = 'other';   // no choice after two tries: Sasha finds out what they need
    const active = Number((await db.query(`SELECT count(*)::int n FROM cs_calls WHERE status = 'in_progress' AND is_simulated = false`)).rows[0].n);
    if (active >= s.max_concurrent_calls) { await logRefusal('all_lines_busy', req.body.From); return twiml(res, line.sayAndHangup(line.MESSAGES.busy, s.voice)); }
    const spent = await (deps.spentToday || (() => require('../services/sasha/engine').spentTodayUsdForChannel('phone')))();
    if (spent >= s.daily_budget_usd) { await logRefusal('daily_budget_reached', req.body.From); return twiml(res, line.sayAndHangup(line.MESSAGES.busy, s.voice)); }
    const callSid = String(req.body.CallSid || '');
    if (!/^CA[0-9a-f]{32}$/i.test(callSid)) return twiml(res, line.sayAndHangup(line.MESSAGES.failed, s.voice));
    const ticket = line.issueTicket({ callSid, reason });
    const wsUrl = base().replace(/^https?:/, 'wss:') + '/api/voice/relay?t=' + encodeURIComponent(ticket);
    return twiml(res, line.connectTwiml(s, { wsUrl, actionUrl: base() + '/api/voice/after', reason }));
  };
}

function after() {
  return async (req, res) => {
    const s = await phoneSettings.load();
    if (req.body.SessionStatus === 'failed') console.error('[voice] relay session failed', String(req.body.ErrorCode || ''), String(req.body.ErrorMessage || '').slice(0, 200));
    return twiml(res, line.afterTwiml(s, { handoffData: req.body.HandoffData, sessionStatus: req.body.SessionStatus }));
  };
}

router.post('/incoming', guard(), incoming());
router.post('/menu', guard(), menu());
router.post('/after', guard(), after());

module.exports = router;
module.exports._handlers = { guard, incoming, menu, after };
