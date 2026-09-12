'use strict';

/**
 * /api/public/event-partner — the public, no-account authorization flow.
 *
 * The company clicks one link and confirms. It does not sign in, choose a password, fill in a profile,
 * configure a feed, enter event information, or learn anything about our internal architecture.
 *
 * Security properties:
 *   - GET is READ-ONLY. Rendering the confirmation page never grants anything, so a link preview, a
 *     security scanner or a mail client prefetch cannot authorize on the company's behalf. This is
 *     exactly why the grant is a POST.
 *   - POST is the grant, and it is single-use and atomic in the service layer.
 *   - CSRF: the flow carries no cookie or session, so a cross-site POST gains an attacker nothing they
 *     could not do by opening the link themselves. We still require an explicit typed confirmation
 *     field AND a same-origin/known-origin Origin header, so an off-site form cannot silently submit.
 *   - Rate-limited, so the token space cannot be probed.
 *   - The master gate event_partners.enabled must be ON. It ships OFF, so deploying this route
 *     authorizes nothing until the Owner turns it on.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const configService = require('../services/configService');
const authorization = require('../services/eventPartners/authorizationService');
const { asyncRoute, svcErr } = require('../utils/apiError');

// Origins allowed to submit the confirmation form. The page is served from our own origins only.
const ALLOWED_ORIGINS = (process.env.EVENT_PARTNER_ALLOWED_ORIGINS
  || 'https://bid.advantage.bid,https://advantage.bid,https://www.advantage.bid,http://localhost:3000,http://localhost:3001')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Deliberately tight: a real company opens this link a handful of times, never hundreds.
const partnerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
});

/** The programme must be switched on by the Owner before any link works. */
async function requireEnabled() {
  const on = await configService.get(null, 'event_partners.enabled');
  if (on !== true) throw svcErr(404, 'NOT_AVAILABLE', 'This link is not available.');
}

router.use(partnerLimiter);

// ── GET /authorize/:token — render-data for the confirmation page. Never changes state. ─────────
router.get('/authorize/:token', asyncRoute(async (req, res) => {
  await requireEnabled();
  const view = await authorization.previewToken(req.params.token);
  res.set('Cache-Control', 'no-store');
  if (!view.ok) {
    // Honest, non-leaking messages: the holder of the link learns only what they already know.
    const map = {
      invalid: [404, 'INVALID_LINK', 'This authorization link is not valid.'],
      expired: [410, 'EXPIRED', 'This authorization link has expired. We can send a new one.'],
      already_used: [409, 'ALREADY_USED', 'This authorization link has already been used.'],
      already_authorized: [409, 'ALREADY_AUTHORIZED', 'Event promotion is already authorized for this company.'],
      not_available: [404, 'NOT_AVAILABLE', 'This authorization link is no longer available.'],
    };
    const [status, code, message] = map[view.reason] || map.invalid;
    return res.status(status).json({ success: false, code, message, company_name: view.companyName || undefined });
  }
  res.json({
    success: true,
    data: {
      company_name: view.companyName,
      authorized_domain: view.domain,
      expires_at: view.expiresAt,
      statement: view.statement,   // the exact words that will be recorded as evidence
    },
  });
}));

// ── POST /authorize/:token — the grant. Single-use, atomic, fully evidenced. ────────────────────
router.post('/authorize/:token', express.json({ limit: '8kb' }), asyncRoute(async (req, res) => {
  await requireEnabled();

  // CSRF: reject a cross-site submission outright. A missing Origin (some privacy tooling strips it)
  // is allowed through because the explicit confirmation field below is still required and the token
  // itself is the credential — but a PRESENT and FOREIGN Origin is always refused.
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
    throw svcErr(403, 'BAD_ORIGIN', 'This request could not be verified.');
  }

  const body = req.body || {};
  // An explicit, typed confirmation — never a bare POST, never a default-true checkbox.
  if (body.confirm !== true) throw svcErr(400, 'CONFIRMATION_REQUIRED', 'Please confirm to authorize.');

  const row = await authorization.authorizeWithToken(req.params.token, {
    agreed: true,
    ip: req.headers['x-forwarded-for'] || req.ip || '',
    userAgent: req.headers['user-agent'] || '',
    origin: origin || null,
  });

  res.set('Cache-Control', 'no-store');
  res.status(201).json({
    success: true,
    data: {
      company_name: row.company_name,
      authorized_domain: row.authorized_domain,
      authorized_at: row.authorized_at,
      // Deliberately nothing else: no ids, no internal state names, no next-step obligations.
    },
  });
}));

module.exports = router;
