'use strict';

/**
 * Public marketing-email endpoints — unsubscribe (RFC 8058 one-click) + click attribution. Mounted at
 * /api/public/marketing-email. No auth (token-signed). Unlike the follower unsubscribe (which writes
 * seller_followers / notification_preferences), a MARKETING unsubscribe writes the terminal marketing
 * suppression (email_suppressions, scope 'marketing') AND records a permission withdrawal on the contact,
 * so every marketing class honors it. History is preserved (append-only permission events).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const marketingToken = require('../lib/marketingEmailToken');
const { normalizeEmail } = require('../lib/emailNormalize');
const contacts = require('../services/marketingContactService');
const analytics = require('../services/analyticsService');

const APP_BASE = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
const ALLOWED_HOSTS = new Set(['bid.advantage.bid', 'advantage.bid', 'advantageauction.bid', 'www.advantage.bid']);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#0f172a">
  <h1 style="font-size:20px">Advantage.Bid</h1>${body}</body></html>`;
}

// Terminal marketing suppression + permission withdrawal (idempotent). Preserves history.
async function applyUnsubscribe(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO email_suppressions (email, normalized_email, reason, source, scope, updated_at)
       VALUES ($1,$1,'unsubscribe','marketing_email','marketing', now())
       ON CONFLICT (normalized_email) DO UPDATE SET reason = 'unsubscribe', source = 'marketing_email', updated_at = now()`,
      [normalized]);
    const c = (await client.query('SELECT id FROM marketing_contacts WHERE normalized_email = $1', [normalized])).rows[0];
    if (c) {
      await contacts.grantPermission(c.id, { basis: 'withdrawn', evidence: 'marketing email unsubscribe', sourceType: 'marketing_email' }, client);
      await client.query(
        `INSERT INTO marketing_email_events (contact_id, normalized_email, event_type, detail)
         VALUES ($1,$2,'unsubscribed',$3::jsonb)`,
        [c.id, normalized, JSON.stringify({ via: 'one_click' })]).catch(() => {});
    }
    await client.query('COMMIT');
    return true;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// RFC 8058 one-click POST (target of the List-Unsubscribe header).
router.post('/unsubscribe', express.urlencoded({ extended: false }), express.json(), async (req, res, next) => {
  try {
    const token = req.query.token || (req.body && req.body.token);
    const claims = marketingToken.verify(token);
    if (!claims) return res.status(400).json({ success: false, message: 'Invalid unsubscribe link.' });
    await applyUnsubscribe(claims.email);
    return res.json({ success: true });
  } catch (e) { next(e); }
});

// Human landing page.
router.get('/unsubscribe', async (req, res, next) => {
  try {
    const claims = marketingToken.verify(req.query.token);
    if (!claims) return res.status(400).send(page('Unsubscribe', '<p>This unsubscribe link is invalid or has expired.</p>'));
    await applyUnsubscribe(claims.email);
    return res.send(page('Unsubscribed', "<p>You've been unsubscribed from Advantage.Bid marketing emails. You'll still receive important account and transaction messages.</p>"));
  } catch (e) { next(e); }
});

// Click attribution → record + safe redirect (no open redirect; no recipient PII in the URL).
router.get('/click', async (req, res) => {
  const claims = marketingToken.verify(req.query.token);
  let dest = APP_BASE + '/';
  try {
    const raw = req.query.dest ? decodeURIComponent(String(req.query.dest)) : '';
    if (raw) {
      const u = new URL(raw, APP_BASE);
      if (ALLOWED_HOSTS.has(u.hostname)) dest = u.toString();
    }
  } catch (_) { /* fall back to home */ }
  // Fire-and-forget analytics; never block the redirect (and never leak the email).
  try {
    analytics.insertEvent({
      event_type: 'local_event_alert_click', page_url: dest,
      metadata: { campaign: claims && claims.campaign, event: claims && claims.event },
    }, req.ip);
  } catch (_) { /* best-effort */ }
  return res.redirect(302, dest);
});

module.exports = router;
module.exports.applyUnsubscribe = applyUnsubscribe;
