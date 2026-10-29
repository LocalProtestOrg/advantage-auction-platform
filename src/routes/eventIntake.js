'use strict';

/**
 * /api/intake/v1 — a company sends its own events (partner push). Authenticated by a per-company sending key
 * (`Authorization: Bearer abk_…`), rate limited per key, 1 MB body. Inert unless EVENT_INTAKE_ENABLED=true.
 *
 *   POST   /events        schema.org Event JSON (one or a list), { events: [...] } in the simple shape, or an iCal file
 *   GET    /events        the events this company has sent
 *   DELETE /events/:id    withdraw one (archived, never deleted)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { asyncRoute, svcErr } = require('../utils/apiError');
const db = require('../db');
const intake = require('../services/eventDiscovery/intakeService');

router.use((req, res, next) => {
  if (!intake.intakeOn()) return res.status(503).json({ success: false, message: 'Event submission is not available yet.' });
  return next();
});

const keyOf = (req) => { const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || ''); return m ? m[1] : ''; };
// Before authentication: per client address (stops key guessing and lookup floods).
const perIp = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' } });
// After authentication: per KEY (its id), so nobody can use up another company's allowance by guessing its prefix.
const perMinute = rateLimit({ windowMs: 60 * 1000, max: intake.LIMITS.perMinute, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'k:' + req.intake.key.id, message: { success: false, message: 'Too many requests. Please slow down.' } });
const perDay = rateLimit({ windowMs: 24 * 3600 * 1000, max: intake.LIMITS.perDay, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'd:' + req.intake.key.id, message: { success: false, message: 'Daily submission limit reached.' } });

router.use(perIp, asyncRoute(async (req, res, next) => {
  const who = await intake.authenticate(db, keyOf(req));
  if (!who) return res.status(401).json({ success: false, message: 'A valid sending key is required.' });
  req.intake = who;
  return next();
}), perMinute, perDay);

router.post('/events', express.json({ limit: '1mb', type: ['application/json', 'application/ld+json'] }), express.text({ limit: '1mb', type: ['text/calendar', 'text/plain'] }),
  asyncRoute(async (req, res) => {
    if (req.body == null || (typeof req.body === 'object' && !Object.keys(req.body).length && !Array.isArray(req.body))) throw svcErr(400, 'EMPTY', 'Send at least one event.');
    const out = await intake.submit(db, req.intake, req.body, req.get('content-type'));
    res.status(out.accepted ? 202 : 400).json({ success: out.accepted > 0, data: out });
  }));

router.get('/events', asyncRoute(async (req, res) => {
  res.json({ success: true, data: await intake.listOwn(db, req.intake.authorization) });
}));

router.delete('/events/:id', asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw svcErr(400, 'BAD_ID', 'Unknown event.');
  res.json({ success: true, data: await intake.withdraw(db, req.intake.authorization, req.params.id) });
}));

module.exports = router;
