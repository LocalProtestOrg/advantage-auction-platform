'use strict';

/**
 * Public Claimed Listing endpoints (no auth):
 *
 *   GET  /api/public/listings/:orgId/claim-context   masked context for /claim-listing.html?org= (never a full address)
 *   POST /api/public/listings/:orgId/claim-link      "Send my claim link" to the address ON the listing (rate limited;
 *                                                     sends only when the Owner switch is on and the template is approved)
 *   POST /api/public/listings/:orgId/claim-help      "I can't access that email" / ownership dispute → staff task
 *   GET  /api/public/listings/by-bd/:bdListingId     { orgId } for the directory "Claim this listing" button; 404 when
 *                                                     claimed or hidden
 *   GET|POST /api/public/listing-outreach/unsubscribe RFC 8058 one-click; writes the shared B2B suppression
 */

const express = require('express');
const router = express.Router();
const { normalLimiter, strictLimiter } = require('../middleware/rateLimit');
const claims = require('../services/claimedListings/claimLinkService');
const unsub = require('../lib/listingUnsubscribeToken');
const suppression = require('../services/claimedListings/suppressionService');
const events = require('../services/claimedListings/claimEvents');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
const json = express.json({ limit: '16kb' });
const fail = (res, e) => res.status(e.status || 500).json({ success: false, code: e.code || 'FAILED', message: e.expose ? e.message : 'Please try again.' });

router.get('/listings/by-bd/:bdListingId', normalLimiter, async (req, res) => {
  if (!/^\d{1,12}$/.test(String(req.params.bdListingId))) return res.status(404).json({ success: false });
  try {
    const r = await claims.byBdListingId(req.params.bdListingId);
    if (!r) return res.status(404).json({ success: false });
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ orgId: r.orgId });
  } catch (e) { return res.status(404).json({ success: false }); }
});

router.get('/listings/:orgId/claim-context', normalLimiter, async (req, res) => {
  if (!UUID_RE.test(req.params.orgId)) return res.status(404).json({ success: false, message: 'Listing not found.' });
  try {
    const ctx = await claims.claimContext(req.params.orgId);
    if (!ctx) return res.status(404).json({ success: false, message: 'Listing not found.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, listing: ctx });
  } catch (e) { return fail(res, e); }
});

router.post('/listings/:orgId/claim-link', strictLimiter, json, async (req, res) => {
  if (!UUID_RE.test(req.params.orgId)) return res.status(404).json({ success: false, message: 'Listing not found.' });
  try {
    const r = await claims.selfRequest(req.params.orgId, { ip: ipOf(req) });
    return res.json({ success: true, masked_email: r.masked_email });
  } catch (e) { return fail(res, e); }
});

router.post('/listings/:orgId/claim-help', strictLimiter, json, async (req, res) => {
  if (!UUID_RE.test(req.params.orgId)) return res.status(404).json({ success: false, message: 'Listing not found.' });
  const b = req.body || {};
  if (String(b.website || '').trim()) return res.json({ success: true });   // honeypot
  try {
    await claims.helpRequest(req.params.orgId, { name: b.name, role: b.role, phone: b.phone, email: b.email, message: b.message }, { ip: ipOf(req) });
    return res.json({ success: true });
  } catch (e) { return fail(res, e); }
});

// ── one-click unsubscribe ──────────────────────────────────────────────────────────────────────
async function applyUnsubscribe(claimsTok, via) {
  await suppression.suppress({ email: claimsTok.email, reason: 'unsubscribe', source: 'listing_unsubscribe_' + via, organizationId: claimsTok.organizationId || null });
  await events.record('unsubscribed', { organizationId: claimsTok.organizationId || null, meta: { via }, idempotencyKey: 'unsub:' + claimsTok.email + ':' + (claimsTok.organizationId || 'none') });
}
function page(body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + '<title>Advantage.Bid</title></head><body style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#0f172a">'
    + '<h1 style="font-size:20px">Advantage.Bid</h1>' + body + '</body></html>';
}
// POST: the RFC 8058 one-click target (mail clients) and the confirm button on the page below.
router.post('/listing-outreach/unsubscribe', normalLimiter, express.urlencoded({ extended: false }), json, async (req, res) => {
  const c = unsub.verify(req.query.t || (req.body && req.body.t));
  const fromPage = req.body && req.body.confirm === '1';
  if (!c) return fromPage ? res.status(400).type('html').send(page('<p>This link is invalid.</p>')) : res.status(400).json({ success: false, message: 'Invalid unsubscribe link.' });
  try {
    await applyUnsubscribe(c, fromPage ? 'link' : 'one_click');
    return fromPage ? res.type('html').send(page("<p>Done. We won't email you about this listing again.</p><p style=\"color:#475569;font-size:14px\">Questions? Call (551) 655-7050 or email info@advantage.bid.</p>"))
      : res.json({ success: true });
  } catch (e) { return fromPage ? res.status(500).type('html').send(page('<p>Something went wrong. Please try again.</p>')) : res.status(500).json({ success: false }); }
});
// GET: a confirmation page. A GET never unsubscribes, so a mail scanner opening the link changes nothing.
router.get('/listing-outreach/unsubscribe', normalLimiter, async (req, res) => {
  const c = unsub.verify(req.query.t);
  if (!c) return res.status(400).type('html').send(page('<p>This link is invalid.</p>'));
  const t = String(req.query.t).replace(/[^A-Za-z0-9._-]/g, '');
  return res.type('html').send(page('<p>Stop emails from Advantage.Bid about this listing?</p>'
    + '<form method="POST" action="/api/public/listing-outreach/unsubscribe?t=' + t + '"><input type="hidden" name="confirm" value="1">'
    + '<button type="submit" style="padding:12px 18px;font-size:16px;font-weight:700;border:0;border-radius:8px;background:#1d4ed8;color:#fff;cursor:pointer">Yes, stop these emails</button></form>'));
});

module.exports = router;
