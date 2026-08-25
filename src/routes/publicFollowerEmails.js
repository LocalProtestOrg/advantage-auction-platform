'use strict';

/**
 * /api/public/follower-emails — public, no-auth unsubscribe for Professional Seller follower marketing
 * emails. Honors a signed one-click token (RFC 8058 List-Unsubscribe-Post) so a recipient can opt out
 * WITHOUT logging in and WITHOUT exposing any contact data. Two scopes:
 *   • default ("seller") → unfollow that company (removes the seller_followers row).
 *   • scope=all          → stop ALL follower marketing emails (notification_preferences.follower_emails_enabled=false).
 * The token encodes only opaque UUIDs (userId, sellerId); a valid signature is required.
 */

const express = require('express');
const router = express.Router();
const db = require('../db');
const emailToken = require('../lib/followerEmailToken');

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} · Advantage.Bid</title></head>
    <body style="margin:0;background:#f4f6f9;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#111">
    <div style="max-width:520px;margin:40px auto;padding:0 16px">
      <div style="background:#0f172a;border-radius:12px 12px 0 0;padding:18px 22px"><span style="color:#fff;font-weight:800;font-size:18px">Advantage<span style="color:#5b8cff">.Bid</span></span></div>
      <div style="background:#fff;border:1px solid #e6eaef;border-top:0;border-radius:0 0 12px 12px;padding:24px">${body}</div>
    </div></body></html>`;
}

async function applyUnsubscribe(token, scope) {
  const parsed = emailToken.verify(token);
  if (!parsed) return { ok: false, reason: 'invalid' };
  const { userId, sellerId } = parsed;
  if (scope === 'all') {
    await db.query(
      `INSERT INTO notification_preferences (user_id, follower_emails_enabled)
       VALUES ($1, false)
       ON CONFLICT (user_id) DO UPDATE SET follower_emails_enabled = false, updated_at = now()`,
      [userId]);
    return { ok: true, scope: 'all' };
  }
  // default: unfollow this specific seller
  await db.query('DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2', [userId, sellerId]);
  // Best-effort friendly company name (never required, never leaks recipient data).
  let company = null;
  try {
    company = (await db.query('SELECT display_name FROM seller_profiles WHERE id = $1', [sellerId])).rows[0]?.display_name || null;
  } catch (_) {}
  return { ok: true, scope: 'seller', company };
}

// One-click (RFC 8058) — the mail client POSTs here; perform the unsubscribe and return 200.
router.post('/unsubscribe', express.urlencoded({ extended: false }), async (req, res) => {
  const token = req.query.token || (req.body && req.body.token);
  const scope = (req.query.scope || (req.body && req.body.scope)) === 'all' ? 'all' : 'seller';
  const r = await applyUnsubscribe(token, scope).catch(() => ({ ok: false, reason: 'error' }));
  res.status(r.ok ? 200 : 400).json({ success: r.ok });
});

// Human landing page (clicked link).
router.get('/unsubscribe', async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'seller';
  const r = await applyUnsubscribe(req.query.token, scope).catch(() => ({ ok: false, reason: 'error' }));
  if (!r.ok) {
    return res.status(400).send(page('Link expired', `<h1 style="margin:0 0 10px;font-size:19px">This unsubscribe link is invalid or expired</h1>
      <p style="font-size:14.5px;color:#374151;line-height:1.5">You can manage what you receive from your Advantage.Bid account, or simply unfollow the company from its page.</p>`));
  }
  if (r.scope === 'all') {
    return res.send(page('Unsubscribed', `<h1 style="margin:0 0 10px;font-size:19px">You've been unsubscribed</h1>
      <p style="font-size:14.5px;color:#374151;line-height:1.5">You will no longer receive follower announcement emails from companies you follow on Advantage.Bid. You can re-enable these anytime from your account.</p>`));
  }
  const who = r.company ? r.company : 'this company';
  const tok = encodeURIComponent(req.query.token || '');
  return res.send(page('Unsubscribed', `<h1 style="margin:0 0 10px;font-size:19px">You've unsubscribed from ${who.replace(/[<>&]/g, '')}</h1>
    <p style="font-size:14.5px;color:#374151;line-height:1.5">You'll no longer receive follower announcements from this company. You can follow them again anytime from their page on Advantage.Bid.</p>
    <p style="font-size:13px;color:#6b7280;margin-top:14px">Prefer to stop <strong>all</strong> follower announcement emails?
      <a href="/api/public/follower-emails/unsubscribe?token=${tok}&scope=all" style="color:#2563eb">Unsubscribe from all</a>.</p>`));
});

router.applyUnsubscribe = applyUnsubscribe;   // exported for unit tests
module.exports = router;
