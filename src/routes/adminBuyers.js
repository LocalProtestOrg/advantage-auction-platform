'use strict';
// Phase 3 — Admin Buyer Management. Role-secured (admin), audit-logged, and
// NEVER exposes card data (only a boolean card_on_file). Mounted at
// /api/admin/buyers. Works for pure buyers (user-id keyed — not seller-profile
// keyed like the seller suspend endpoints).
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const role    = require('../middleware/roleMiddleware');
const db      = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { buildBuyerSearch, clampInt } = require('../services/searchService');

router.use(auth, role(['admin']));

// GET /api/admin/buyers?q=&active=&limit=&offset= — search/list buyers.
router.get('/', async (req, res, next) => {
  try {
    const { where, params } = buildBuyerSearch(req.query);
    const limit  = clampInt(req.query.limit, 25, 1, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit);  const li = params.length;
    params.push(offset); const oi = params.length;
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.is_active, u.created_at,
             (SELECT COUNT(*)::int FROM auction_buyers ab WHERE ab.user_id = u.id) AS registrations,
             (SELECT COUNT(*)::int FROM bids b WHERE b.bidder_user_id = u.id)       AS bids_placed,
             COUNT(*) OVER() AS total_count
        FROM users u
       WHERE ${where.join(' AND ')}
       ORDER BY u.created_at DESC
       LIMIT $${li} OFFSET $${oi}
    `, params);
    const total_count = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _t, ...r }) => r);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/buyers/:userId — full buyer profile for support.
router.get('/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const u = (await db.query(`SELECT id, email, role, is_active, created_at FROM users WHERE id = $1`, [userId])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'User not found' });

    const registrations = (await db.query(`
      SELECT ab.auction_id, a.title AS auction_title, a.state AS auction_state,
             ab.status, ab.paddle_number, ab.pickup_acknowledged, ab.registered_at
        FROM auction_buyers ab JOIN auctions a ON a.id = ab.auction_id
       WHERE ab.user_id = $1 ORDER BY ab.registered_at DESC`, [userId])).rows;

    const terms = (await db.query(`
      SELECT tv.version_int, tv.is_current, ta.accepted_at
        FROM terms_acceptances ta JOIN terms_versions tv ON tv.id = ta.terms_version_id
       WHERE ta.user_id = $1 AND tv.kind = 'buyer_terms'
       ORDER BY ta.accepted_at DESC LIMIT 1`, [userId])).rows[0] || null;
    const accepted_current = (await db.query(`
      SELECT 1 FROM terms_acceptances ta JOIN terms_versions tv ON tv.id = ta.terms_version_id
       WHERE ta.user_id = $1 AND tv.kind = 'buyer_terms' AND tv.is_current = true LIMIT 1`, [userId])).rowCount > 0;

    // Card-on-file: a boolean ONLY. No card numbers, no Stripe ids, no PAN.
    const card_on_file = (await db.query(`
      SELECT (u.stripe_customer_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM card_verifications cv WHERE cv.user_id = u.id AND cv.status = 'verified')) AS ok
        FROM users u WHERE u.id = $1`, [userId])).rows[0].ok;

    const act = (await db.query(`
      SELECT (SELECT COUNT(DISTINCT lot_id)::int FROM lot_proxy_bids WHERE bidder_user_id = $1) AS lots_bid,
             (SELECT COUNT(*)::int FROM bids WHERE bidder_user_id = $1)                          AS bids_placed,
             (SELECT COUNT(*)::int FROM lots WHERE current_winner_user_id = $1 AND state = 'open')   AS currently_winning,
             (SELECT COUNT(*)::int FROM lots WHERE winning_buyer_user_id = $1 AND state = 'closed')  AS lots_won`, [userId])).rows[0];

    return res.json({ success: true, data: {
      id: u.id, email: u.email, role: u.role, is_active: u.is_active, created_at: u.created_at,
      card_on_file: !!card_on_file,
      terms_acceptance: terms ? { version_int: terms.version_int, accepted_at: terms.accepted_at, is_current_version: terms.is_current } : null,
      accepted_current_terms: accepted_current,
      bidding_activity: act,
      registrations,
    }});
  } catch (err) { next(err); }
});

async function setActive(userId, active, actorId, reason) {
  const { rows } = await db.query(`UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id, email, is_active`, [userId, active]);
  if (!rows.length) return null;
  try {
    await writeAuditLog({
      event_type:  active ? 'buyer.reactivated' : 'buyer.suspended',
      entity_type: 'user', entity_id: userId, actor_id: actorId,
      metadata: { email: rows[0].email, reason: reason || null },
    });
  } catch (e) { console.error('[adminBuyers] audit log failed:', e.message); }
  return rows[0];
}

// POST /api/admin/buyers/:userId/suspend  { reason? }
router.post('/:userId/suspend', async (req, res, next) => {
  try {
    const r = await setActive(req.params.userId, false, req.user.id, req.body && req.body.reason);
    if (!r) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

// POST /api/admin/buyers/:userId/reactivate
router.post('/:userId/reactivate', async (req, res, next) => {
  try {
    const r = await setActive(req.params.userId, true, req.user.id, req.body && req.body.reason);
    if (!r) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

// POST /api/admin/buyers/:userId/registrations/:auctionId/(revoke|reinstate)
async function setRegistration(userId, auctionId, status, actorId, reason) {
  const { rows } = await db.query(
    `UPDATE auction_buyers SET status = $3 WHERE user_id = $1 AND auction_id = $2 RETURNING auction_id, status`,
    [userId, auctionId, status]
  );
  if (!rows.length) return null;
  try {
    await writeAuditLog({
      event_type:  status === 'revoked' ? 'buyer.registration_revoked' : 'buyer.registration_reinstated',
      entity_type: 'auction_buyer', entity_id: userId, auction_id: auctionId, actor_id: actorId,
      metadata: { user_id: userId, auction_id: auctionId, reason: reason || null },
    });
  } catch (e) { console.error('[adminBuyers] audit log failed:', e.message); }
  return rows[0];
}

router.post('/:userId/registrations/:auctionId/revoke', async (req, res, next) => {
  try {
    const r = await setRegistration(req.params.userId, req.params.auctionId, 'revoked', req.user.id, req.body && req.body.reason);
    if (!r) return res.status(404).json({ success: false, message: 'Registration not found' });
    return res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

router.post('/:userId/registrations/:auctionId/reinstate', async (req, res, next) => {
  try {
    const r = await setRegistration(req.params.userId, req.params.auctionId, 'active', req.user.id, req.body && req.body.reason);
    if (!r) return res.status(404).json({ success: false, message: 'Registration not found' });
    return res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

module.exports = router;
