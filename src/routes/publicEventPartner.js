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
const selfService = require('../services/eventPartners/selfServiceService');
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

// ── Self-service: the public Free Event Promotion request (the lightweight trust ladder) ───────
//
// The form asks for four things and nothing else: company name, website, requester name, requester
// email. No account, no password, no feed configuration, no DNS, no seller application.
//
// A request NEVER authorizes anything. At most it becomes eligible for the deterministic single-use
// authorization link. The reply tells the company what happens next in plain language and deliberately
// reveals nothing about our internal matching, risk signals or directory records.
router.post('/request', express.json({ limit: '8kb' }), asyncRoute(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
    throw svcErr(403, 'BAD_ORIGIN', 'This request could not be verified.');
  }
  const b = req.body || {};
  const out = await selfService.submit({
    companyName: b.company_name, companyWebsite: b.company_website,
    requesterName: b.requester_name, requesterEmail: b.requester_email,
    ip: req.headers['x-forwarded-for'] || req.ip || '',
    userAgent: req.headers['user-agent'] || '',
  });

  // One message per rung of the ladder. Path E is told the same thing as Path D on purpose: a
  // conflicting request must not learn that it collided with an existing partner.
  const COMPANY = out.request.company_name;
  const messages = {
    a_domain_match: {
      state: 'ready',
      headline: "You're all set to authorize",
      message: 'We recognised your company email address. The next step is one click to authorize free event promotion.',
    },
    c_trusted_relationship: {
      state: 'ready',
      headline: "You're all set to authorize",
      message: 'We already recognise your Advantage.Bid account for this company. The next step is one click to authorize free event promotion.',
    },
    b_official_contact: {
      state: 'awaiting_company_confirmation',
      headline: 'One quick confirmation',
      message: 'We see that the email address you entered is not associated with ' + COMPANY
        + "'s website. For your protection, we've sent a quick verification link to the contact email published on "
        + COMPANY + "'s website. Please have the person responsible for that email open the message and confirm the request. That's all we need.",
    },
    d_admin_review: {
      state: 'in_review',
      headline: "We're reviewing your request",
      message: 'Thanks — we could not automatically match your email address to ' + COMPANY
        + "'s website, so a member of our team will take a quick look and follow up with you. Nothing further is needed from you right now.",
    },
    e_blocked: {
      state: 'in_review',
      headline: "We're reviewing your request",
      message: 'Thanks — a member of our team will take a quick look at this request and follow up with you. Nothing further is needed from you right now.',
    },
  };
  const view = messages[out.decision.path] || messages.d_admin_review;

  res.set('Cache-Control', 'no-store');
  res.status(201).json({
    success: true,
    data: {
      state: view.state, headline: view.headline, message: view.message,
      company_name: COMPANY,
      // Intentionally absent: the request id, the trust path, the matched organization, the risk
      // signals, the official contact address, and the confirmation token.
    },
  });
}));

// ── GET /verify-contact/:token — Path B confirmation, read-only preview ─────────────────────────
router.get('/verify-contact/:token', asyncRoute(async (req, res) => {
  await requireEnabled();
  const t = req.params.token;
  res.set('Cache-Control', 'no-store');
  // A preview never consumes the token; only the POST does.
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(t || ''))) {
    throw svcErr(404, 'INVALID_LINK', 'This confirmation link is not valid.');
  }
  res.json({ success: true, data: { requires_confirmation: true } });
}));

// ── POST /verify-contact/:token — Path B confirmation, single-use consume ───────────────────────
// Somebody at the company's OWN published address confirmed the request. This still does not
// authorize: it only makes the request eligible for the deterministic authorization link.
router.post('/verify-contact/:token', express.json({ limit: '8kb' }), asyncRoute(async (req, res) => {
  await requireEnabled();
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
    throw svcErr(403, 'BAD_ORIGIN', 'This request could not be verified.');
  }
  if ((req.body || {}).confirm !== true) throw svcErr(400, 'CONFIRMATION_REQUIRED', 'Please confirm to continue.');
  const request = await selfService.confirmOfficialContact(req.params.token, {
    ip: req.headers['x-forwarded-for'] || req.ip || '',
  });
  res.set('Cache-Control', 'no-store');
  res.status(200).json({
    success: true,
    data: { company_name: request.company_name, state: 'verified',
      message: 'Thank you — that is all we needed. We will follow up with the authorization link.' },
  });
}));

module.exports = router;
