'use strict';

/**
 * Public first-party newsletter signup — STUPID EASY collection surface. Mounted at /api/public/subscribers.
 *
 * Collection only: this NEVER sends email and NEVER activates A7. Public-safe, rate-limited, honeypot-
 * protected, server-validated, idempotent. Responses never disclose whether an email already belongs to a
 * user/subscriber (uniform success). Records explicit permission evidence + geography + source attribution.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { feedbackLimiter } = require('../middleware/rateLimit');
const configService = require('../services/configService');
const subscriberService = require('../services/subscriberService');

const oneLine = (v, max = 200) => String(v == null ? '' : v).replace(/[\r\n\t\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

// Allowed placement labels (source attribution). Anything else collapses to 'other'.
const PLACEMENTS = new Set(['footer', 'all_events', 'auctions_listing', 'estate_sales_listing', 'auction_detail',
  'estate_sale_detail', 'marketplace', 'professional_directory', 'blog', 'help_center', 'seller_page', 'other']);

function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  return crypto.createHash('sha256').update('sub:' + ip).digest('hex').slice(0, 32);
}

const SUCCESS = { success: true, message: "You're in! We'll keep you posted about auctions and estate sales near you." };

router.post('/', feedbackLimiter, express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    // Master kill switch (collection can be paused without a deploy). Fail safe = accept-and-drop silently.
    const enabled = await configService.get(null, 'marketing.subscribe.enabled');
    if (enabled === false) return res.json(SUCCESS);

    const b = req.body || {};
    // Honeypot: real users never fill this hidden field. Bots do → accept silently, drop.
    if (oneLine(b.company_url, 100)) return res.json(SUCCESS);

    const email = oneLine(b.email, 200).toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

    const name = oneLine(b.name, 160);
    const city = oneLine(b.city, 120) || null;
    const state = oneLine(b.state, 40) || null;
    let zip = oneLine(b.zip, 12) || null;
    if (zip && !ZIP_RE.test(zip)) zip = null;    // ignore malformed ZIP rather than reject the signup

    let placement = String(b.placement || b.source || 'other').toLowerCase();
    if (!PLACEMENTS.has(placement)) placement = 'other';

    const result = await subscriberService.signup({
      email, name, city, state, zip, placement,
      pagePath: oneLine(b.page_path || (b.context && b.context.page_url), 500) || null,
      referrer: oneLine(req.get('referer'), 300) || null,
      sourceDomain: oneLine(req.get('origin') || req.hostname, 120) || null,
      ipHash: ipHash(req),
    });

    if (!result.ok) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    // Uniform success regardless of subscribed/received/existing — no disclosure.
    return res.json(SUCCESS);
  } catch (e) { next(e); }
});

module.exports = router;
