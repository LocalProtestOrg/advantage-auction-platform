'use strict';

/**
 * GET /pay/:token — Phone Sasha payment link landing (payLinkService.open). The link never signs anyone in: without a
 * session it sends the buyer to the normal sign-in page and back; with the right account it hands off to the existing
 * Invoices → Pay Now flow. Every invalid case looks the same. Responses are never cached and send no referrer.
 */

const express = require('express');
const { resolveSession, identityFrom } = require('../lib/sessionAuth');
const payLinks = require('../services/payLinkService');
const { strictLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${title} - Advantage.Bid</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1f2937;padding:16px}
.c{max-width:520px;margin:12vh auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:24px}h1{font-size:1.25rem;margin:0 0 .6rem}
p{line-height:1.5;color:#475569}a.b{display:inline-block;margin-top:.6rem;background:#1d4ed8;color:#fff;text-decoration:none;padding:.6rem 1rem;border-radius:8px;font-weight:700}</style>
</head><body><div class="c">${body}</div></body></html>`;

router.get('/:token', strictLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Robots-Tag', 'noindex, nofollow');
  try {
    const who = identityFrom(resolveSession(req).decoded);
    const r = await payLinks.open(String(req.params.token || ''), who ? who.id : null);
    if (r.action === 'login' || r.action === 'redirect') return res.redirect(302, r.location);
    if (r.action === 'wrong_account') {
      return res.status(403).send(page('Different account', '<h1>This payment link is for a different account</h1><p>Sign out, then sign in with the Advantage.Bid account that requested this link. You can also pay any time from Invoices in that account.</p><a class="b" href="/logout">Sign out</a>'));
    }
    return res.status(410).send(page('Link expired', '<h1>This payment link has expired</h1><p>For your security, payment links work once and expire after 30 minutes. You can pay any unpaid invoice from your account.</p><a class="b" href="/invoices.html">Go to Invoices</a>'));
  } catch (e) {
    console.error('[pay-link] open failed', e.message);
    return res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please sign in and open Invoices to pay.</p><a class="b" href="/invoices.html">Go to Invoices</a>'));
  }
});

module.exports = router;
