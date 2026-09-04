'use strict';

/**
 * Admin subscriber / first-party audience management. Mounted at /api/admin/subscribers.
 * RBAC: existing roles only (requirePermission('members.view'); admins pass as super admin).
 *
 * READ + PLANNING only. There is NO mass-send here — A7 remains disabled. The geographic preview counts
 * eligible subscribers around an event/location (email radius is INDEPENDENT of the paid 30-mile rule).
 */
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const audience = require('../services/audienceEligibilityService');

router.use(auth, requirePermission('members.view'));

function clampInt(v, def, min, max) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }

// GET /api/admin/subscribers — search + filter.
router.get('/', async (req, res, next) => {
  try {
    const where = ['mc.is_demo = false'];
    const params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('$$', '$' + params.length)); };
    if (req.query.q) add("(mc.full_name ILIKE '%'||$$||'%' OR mc.normalized_email ILIKE '%'||$$||'%')", String(req.query.q).slice(0, 120));
    if (req.query.state) add('upper(mc.address_state) = upper($$)', String(req.query.state).slice(0, 40));
    if (req.query.city) add('lower(mc.city) = lower($$)', String(req.query.city).slice(0, 120));
    if (req.query.permission) add('mc.permission_basis = $$', String(req.query.permission).slice(0, 40));
    if (req.query.source) add('EXISTS (SELECT 1 FROM marketing_contact_sources s WHERE s.contact_id = mc.id AND s.signup_placement = $$)', String(req.query.source).slice(0, 40));
    if (req.query.suppression === 'suppressed') where.push('EXISTS (SELECT 1 FROM email_suppressions es WHERE es.normalized_email = mc.normalized_email)');
    if (req.query.suppression === 'clean') where.push('NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.normalized_email = mc.normalized_email)');

    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit); const li = params.length;
    params.push(offset); const oi = params.length;

    const { rows } = await db.query(
      `SELECT mc.id, mc.normalized_email, mc.full_name, mc.city, mc.address_state, mc.zip,
              mc.geography_precision, mc.geography_source, mc.permission_basis, mc.permission_established_at,
              mc.user_id, mc.created_at,
              (SELECT string_agg(DISTINCT s.signup_placement, ', ') FROM marketing_contact_sources s WHERE s.contact_id = mc.id) AS sources,
              EXISTS (SELECT 1 FROM email_suppressions es WHERE es.normalized_email = mc.normalized_email) AS suppressed,
              EXISTS (SELECT 1 FROM email_deliverability d WHERE d.normalized_email = mc.normalized_email AND (d.hard_bounced OR d.complaint)) AS undeliverable,
              (SELECT count(*)::int FROM seller_followers sf WHERE sf.user_id = mc.user_id) AS seller_follows,
              count(*) OVER() AS total_count
         FROM marketing_contacts mc
        WHERE ${where.join(' AND ')}
        ORDER BY mc.created_at DESC
        LIMIT $${li} OFFSET $${oi}`, params);
    const total = rows[0] ? Number(rows[0].total_count) : 0;
    res.json({ success: true, total, limit, offset, subscribers: rows.map((r) => { delete r.total_count; return r; }) });
  } catch (e) { next(e); }
});

// GET /api/admin/subscribers/preview — geographic audience preview (planning only, no send).
// Params: auction_id | (lat & lng) with radius_miles; OR state; OR city; OR nationwide.
router.get('/preview', async (req, res, next) => {
  try {
    let lat = req.query.lat != null ? Number(req.query.lat) : null;
    let lng = req.query.lng != null ? Number(req.query.lng) : null;
    const radiusMiles = req.query.radius_miles != null ? Number(req.query.radius_miles) : null;

    if (req.query.auction_id) {
      const a = (await db.query('SELECT lat, lng, title FROM auctions WHERE id = $1', [String(req.query.auction_id)])).rows[0];
      if (!a) return res.status(404).json({ success: false, message: 'Auction not found' });
      if (a.lat == null || a.lng == null) return res.json({ success: true, resolvable: false, message: 'This auction has no coordinates yet; radius preview is unavailable.', event_title: a.title });
      lat = Number(a.lat); lng = Number(a.lng);
    }

    const out = await audience.previewAudience({
      lat, lng, radiusMiles,
      state: req.query.state ? String(req.query.state) : null,
      city: req.query.city ? String(req.query.city) : null,
    });
    res.json({ success: true, resolvable: true, ...out, note: 'Preview only. Email radius is independent of the paid 30-mile advertising rule. No email is sent.' });
  } catch (e) { next(e); }
});

// GET /api/admin/subscribers/growth/by-source — first-party growth QUALITY foundation (§13). Joins
// subscribers → matched platform users → downstream marketplace participation, grouped by signup
// placement, so A14 can later evaluate "which placements create bidders/buyers?" not just raw signups.
router.get('/growth/by-source', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_placement AS placement,
              count(DISTINCT mc.id)::int AS signups,
              count(DISTINCT mc.user_id) FILTER (WHERE mc.user_id IS NOT NULL)::int AS matched_users,
              count(DISTINCT b.bidder_user_id)::int AS bidders,
              count(DISTINCT l.winning_buyer_user_id)::int AS buyers
         FROM marketing_contact_sources s
         JOIN marketing_contacts mc ON mc.id = s.contact_id AND mc.is_demo = false
         LEFT JOIN bids b ON b.bidder_user_id = mc.user_id
         LEFT JOIN lots l ON l.winning_buyer_user_id = mc.user_id AND l.state = 'closed'
        WHERE s.source_type = 'newsletter_signup'
        GROUP BY s.signup_placement
        ORDER BY signups DESC`);
    res.json({ success: true, by_source: rows, note: 'Quality signal foundation: downstream participation by placement. Not a vanity signup count.' });
  } catch (e) { next(e); }
});

module.exports = router;
