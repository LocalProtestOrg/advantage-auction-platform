'use strict';

/**
 * /api/admin/founding-partners — Founding Auction Partner records (migration 185).
 *
 * Permissions: listings.view to read; listings.manage_journey (Super Admin) to designate, activate, restore the fee,
 * edit, end or take the contact lock, because each of these moves a company's journey or a seller's fee.
 * Nothing here sends a message or contacts a company.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requirePermission = require('../middleware/requirePermission');
const db = require('../db');
const fp = require('../services/acquisition/foundingPartnerService');
const locks = require('../services/acquisition/contactLockService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[admin-founding-partners]', e.message);
    res.status(status).json({ success: false, code: e.code || 'FAILED', message: e.expose || status < 500 ? e.message : 'Request failed.', details: e.details || undefined });
  }
};
const idParam = (req, res, next) => (UUID_RE.test(req.params.id) ? next() : res.status(404).json({ success: false, message: 'Not found.' }));
const manage = requirePermission('listings.manage_journey');
const isSuper = (req) => !!(req.staff && req.staff.is_super_admin);

router.use(auth, requirePermission('listings.view'));

router.get('/', wrap(async (req, res) => {
  const rows = await fp.list({ includeEnded: req.query.include_ended !== '0' });
  const pricing = (await db.query(
    `SELECT key, value FROM platform_config WHERE key IN ('pricing.auction.processing_fee_bps','pricing.auction.professional.platform_fee_bps','pricing.storefront.seller_fee_bps')`)).rows
    .reduce((m, r) => { m[r.key] = r.value; return m; }, {});
  res.json({ success: true, data: rows, pricing, remind_days: fp.REMIND_DAYS });
}));

router.get('/cohorts', wrap(async (req, res) => {
  const rows = (await db.query(
    `SELECT c.id, c.name, c.status, (SELECT count(*)::int FROM listing_outreach_cohort_members m WHERE m.cohort_id = c.id AND m.status NOT IN ('excluded','skipped','stopped')) AS pending
       FROM listing_outreach_cohorts c ORDER BY c.created_at`)).rows;
  res.json({ success: true, data: rows });
}));

router.get('/cohorts/:id/review', idParam, wrap(async (req, res) => {
  res.json({ success: true, data: await fp.cohortReview(req.params.id) });
}));

// Find a company record to designate: directory organizations, professional seller accounts and sales prospects.
router.get('/lookup', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, data: [] });
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const [orgs, sellers, prospects] = await Promise.all([
    db.query(`SELECT 'organization' AS entity_type, id::text AS entity_id, name AS label, concat_ws(', ', city, state) AS detail
                FROM organizations WHERE name ILIKE $1 OR website_url ILIKE $1 ORDER BY name LIMIT 12`, [like]),
    db.query(`SELECT 'seller_profile' AS entity_type, sp.id::text AS entity_id, COALESCE(sp.display_name, u.email) AS label,
                     concat_ws(' · ', sp.seller_type, u.email) AS detail
                FROM seller_profiles sp JOIN users u ON u.id = sp.user_id
               WHERE u.email ILIKE $1 OR sp.display_name ILIKE $1 ORDER BY sp.created_at DESC LIMIT 8`, [like]),
    db.query(`SELECT 'sales_prospect' AS entity_type, id::text AS entity_id, company_name AS label, concat_ws(', ', city, state) AS detail
                FROM sales_prospects WHERE company_name ILIKE $1 OR website ILIKE $1 ORDER BY company_name LIMIT 8`, [like]),
  ]);
  res.json({ success: true, data: [...orgs.rows, ...sellers.rows, ...prospects.rows] });
}));

router.post('/', manage, wrap(async (req, res) => {
  const b = req.body || {};
  const row = await fp.designate({
    entityType: b.entity_type, entityId: b.entity_id, market: b.market, reason: b.reason, internalNote: b.internal_note,
    startDate: b.start_date, introEndDate: b.intro_end_date, introPlatformFeeBps: b.intro_platform_fee_bps,
    returnPlatformFeeBps: b.return_platform_fee_bps, relationshipOwnerUserId: b.relationship_owner_user_id || null,
    actorId: req.user.id, isSuperAdmin: isSuper(req),
  });
  res.status(201).json({ success: true, data: row });
}));

router.post('/:id/activate', idParam, manage, wrap(async (req, res) => {
  // The seller account may be given by its id or by the account email.
  let sellerProfileId = String((req.body || {}).seller || (req.body || {}).seller_profile_id || '').trim();
  if (sellerProfileId && !UUID_RE.test(sellerProfileId)) {
    const hit = (await db.query(`SELECT sp.id FROM seller_profiles sp JOIN users u ON u.id = sp.user_id WHERE lower(u.email) = lower($1)`, [sellerProfileId])).rows;
    if (hit.length !== 1) return res.status(404).json({ success: false, code: 'SELLER_NOT_FOUND', message: hit.length ? 'More than one seller account uses that email; use the seller id.' : 'No seller account uses that email.' });
    sellerProfileId = hit[0].id;
  }
  res.json({ success: true, data: await fp.activate(req.params.id, { sellerProfileId: sellerProfileId || null, actorId: req.user.id }) });
}));

router.post('/:id/restore-fee', idParam, manage, wrap(async (req, res) => {
  res.json({ success: true, data: await fp.restoreFee(req.params.id, { actorId: req.user.id, returnPlatformFeeBps: (req.body || {}).return_platform_fee_bps }) });
}));

router.patch('/:id', idParam, manage, wrap(async (req, res) => {
  const allowed = ['market', 'reason', 'internal_note', 'start_date', 'intro_end_date', 'intro_platform_fee_bps', 'return_platform_fee_bps', 'relationship_owner_user_id'];
  const fields = {}; for (const k of allowed) if (req.body && k in req.body) fields[k] = req.body[k];
  res.json({ success: true, data: await fp.update(req.params.id, fields, { actorId: req.user.id }) });
}));

router.post('/:id/end', idParam, manage, wrap(async (req, res) => {
  res.json({ success: true, data: await fp.end(req.params.id, { reason: (req.body || {}).reason, actorId: req.user.id }) });
}));

// The person handling the partnership takes (or renews) the company contact lock, so only they can email it.
router.post('/:id/lock', idParam, manage, wrap(async (req, res) => {
  const rec = (await db.query(`SELECT company_id FROM founding_partners WHERE id = $1`, [req.params.id])).rows[0];
  if (!rec) return res.status(404).json({ success: false, message: 'Not found.' });
  const row = await locks.acquire(rec.company_id, { userId: req.user.id, reason: 'Founding Auction Partner', reassign: !!(req.body || {}).reassign, isSuperAdmin: isSuper(req) });
  res.json({ success: true, data: { expires_at: row.expires_at } });
}));

module.exports = router;
