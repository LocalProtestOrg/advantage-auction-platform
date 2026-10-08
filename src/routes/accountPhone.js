'use strict';

/**
 * /api/account — the signed-in customer's own phone verification and optional text-alert preferences.
 *   GET  /phone                    verification status (last 4 digits only)
 *   POST /phone/start              { phone, current_password? } → 4-digit code to that number
 *   POST /phone/confirm            { code }
 *   GET  /sms-preferences          per-type opt-in state + presentation: the exact consent wording to render, versioned
 *   PUT  /sms-preferences          { outbid?: bool, watched_closing?: bool, consent_version, shown_last4 }
 *                                  (opt-in needs a verified phone and the version + last 4 digits the page displayed;
 *                                  opt-out always works)
 * Self-scoped only (req.user.id); nothing here reads or changes another account.
 */

const express = require('express');
const auth = require('../middleware/authMiddleware');
const { strictLimiter } = require('../middleware/rateLimit');
const phone = require('../services/accountPhoneService');
const consent = require('../services/smsConsentService');

const router = express.Router();
router.use(express.json({ limit: '8kb' }), auth);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const fail = (res, e) => {
  if (e && e.status && e.code) return res.status(e.status).json({ success: false, code: e.code, message: e.message, attempts_left: e.attempts_left });
  console.error('[account-phone]', e && e.message);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
};

router.get('/phone', async (req, res) => { try { res.json({ success: true, data: await phone.status(req.user.id) }); } catch (e) { fail(res, e); } });
router.post('/phone/start', strictLimiter, async (req, res) => {
  try { res.json({ success: true, data: await phone.start(req.user.id, { phone: req.body && req.body.phone, currentPassword: req.body && req.body.current_password, ip: req.ip }) }); }
  catch (e) { fail(res, e); }
});
router.post('/phone/confirm', strictLimiter, async (req, res) => {
  try { res.json({ success: true, data: await phone.confirm(req.user.id, { code: String((req.body && req.body.code) || '').trim() }) }); } catch (e) { fail(res, e); }
});

router.get('/sms-preferences', async (req, res) => {
  try {
    const s = await consent.settings();
    const st = await phone.status(req.user.id);
    const suppressed = st.verified && st.phone_last4 ? await isNumberSuppressed(req.user.id) : false;
    res.json({ success: true, data: { preferences: await consent.get(req.user.id), offered: s.offer_opt_in, phone_verified: st.verified, phone_last4: st.phone_last4,
      number_opted_out: suppressed, presentation: consent.presentation('notification_settings', st.verified ? st.phone_last4 : null) } });
  } catch (e) { fail(res, e); }
});
router.put('/sms-preferences', async (req, res) => {
  try {
    const b = req.body || {}; const results = {};
    for (const t of consent.TYPES) if (typeof b[t] === 'boolean') {
      results[t] = await consent.set(req.user.id, t, b[t], { source: 'notification_settings', ip: req.ip,
        consentVersion: typeof b.consent_version === 'string' ? b.consent_version : null, shownLast4: typeof b.shown_last4 === 'string' ? b.shown_last4 : null });
    }
    if (!Object.keys(results).length) return res.status(400).json({ success: false, message: 'Nothing to change.' });
    res.json({ success: true, data: { preferences: await consent.get(req.user.id) } });
  } catch (e) { fail(res, e); }
});

async function isNumberSuppressed(userId) {
  const u = (await require('../db').query('SELECT phone_verified_e164 FROM users WHERE id = $1', [userId])).rows[0];
  return !!(u && u.phone_verified_e164 && await require('../services/smsSuppressionService').isSuppressed(u.phone_verified_e164));
}

module.exports = router;
