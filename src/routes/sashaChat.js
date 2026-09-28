'use strict';

/**
 * /api/sasha/chat — Sasha website chat (used by /widgets/sasha.html, served from bid.advantage.bid).
 *
 * Browser safety: every call must carry X-Sasha-Client (a custom header, so no other site can post here without a
 * CORS preflight, which this route never grants) and, when the browser sends Origin, it must be this site. Session
 * identity comes from optionalAuth (Bearer or the aap_session cookie) — never from the request body.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const optionalAuth = require('../middleware/optionalAuthMiddleware');
const chat = require('../services/sasha/chatChannel');

const router = express.Router();
const ALLOWED_ORIGINS = new Set([
  (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, ''),
  'https://bid.advantage.bid', 'https://advantage-auction-platform-production.up.railway.app', 'http://localhost:3000',
]);
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait a moment and try again.' } });

function guard(req, res, next) {
  if (req.get('X-Sasha-Client') !== '1') return res.status(403).json({ success: false, message: 'Not allowed.' });
  const origin = req.get('Origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ success: false, message: 'Not allowed.' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  return next();
}
const site = (v) => (v === 'www' ? 'www' : 'bid');
const uid = (req) => (req.user && req.user.id) || null;
const fail = (res, e) => {
  if (e && e.userFacing) return res.status(e.status || 400).json({ success: false, message: e.message });
  console.error('[sasha-chat] error:', e && e.message);
  return res.status(500).json({ success: false, message: 'Something went wrong. Please try again, or email info@advantage.bid.' });
};

router.use(express.json({ limit: '16kb' }), chatLimiter, guard, optionalAuth);

router.post('/start', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await chat.start({ site: site(b.site), token: typeof b.token === 'string' ? b.token.slice(0, 100) : null, userId: uid(req) });
    return res.json({ success: true, data: out });
  } catch (e) { return fail(res, e); }
});

router.post('/send', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await chat.send({ token: String(b.token || '').slice(0, 100), text: b.text, userId: uid(req), site: site(b.site || req.query.site) });
    return res.json({ success: true, data: out });
  } catch (e) { return fail(res, e); }
});

router.post('/poll', async (req, res) => {
  try {
    const b = req.body || {};
    const out = await chat.poll({ token: String(b.token || '').slice(0, 100), after: b.after || null, userId: uid(req) });
    return res.json({ success: true, data: out });
  } catch (e) { return fail(res, e); }
});

module.exports = router;
module.exports._guard = guard;
