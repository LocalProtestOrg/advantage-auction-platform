'use strict';
// ACCOUNT/BUYER OPS — Admin all-users management. Role-secured (admin),
// audit-logged. NEVER exposes card data (boolean + safe brand/last4 only),
// NEVER deletes history. Mounted at /api/admin/users.
const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const role    = require('../middleware/roleMiddleware');
const db      = require('../db');
const { writeAuditLog } = require('../lib/auditLog');
const { buildUserSearch, clampInt } = require('../services/searchService');

router.use(auth, role(['admin']));

// GET /api/admin/users — unified search across ALL roles (email/name/phone
// partial; role + status filters). Returns list-card fields + indicators.
router.get('/', async (req, res, next) => {
  try {
    const { where, params } = buildUserSearch(req.query);
    const limit  = clampInt(req.query.limit, 25, 1, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit);  const li = params.length;
    params.push(offset); const oi = params.length;
    const { rows } = await db.query(`
      SELECT u.id, u.email, u.full_name, u.phone, u.role, u.is_active, u.created_at,
             (u.stripe_customer_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM card_verifications cv WHERE cv.user_id = u.id AND cv.status='verified')) AS card_on_file,
             sp.display_name AS seller_name,
             (SELECT COUNT(*)::int FROM bids b WHERE b.bidder_user_id = u.id)            AS bids_placed,
             (SELECT COUNT(*)::int FROM auction_buyers ab WHERE ab.user_id = u.id)       AS registrations,
             (SELECT COUNT(*)::int FROM lots l WHERE l.winning_buyer_user_id = u.id AND l.state='closed') AS lots_won,
             (SELECT COUNT(*)::int FROM payments p WHERE p.buyer_user_id = u.id AND p.refunded_amount_cents > 0) AS refunds,
             COUNT(*) OVER() AS total_count
        FROM users u
        LEFT JOIN seller_profiles sp ON sp.user_id = u.id
       WHERE ${where.join(' AND ')}
       GROUP BY u.id, sp.display_name
       ORDER BY u.created_at DESC
       LIMIT $${li} OFFSET $${oi}
    `, params);
    const total_count = rows.length ? parseInt(rows[0].total_count, 10) : 0;
    const data = rows.map(({ total_count: _t, ...r }) => r);
    return res.json({ success: true, data, total_count, has_more: offset + data.length < total_count, offset, limit });
  } catch (err) { next(err); }
});

// GET /api/admin/users/:id — full account detail (no card data beyond boolean).
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const u = (await db.query(
      `SELECT id, email, full_name, phone, role, is_active, created_at, (stripe_customer_id IS NOT NULL) AS has_stripe_customer
         FROM users WHERE id=$1`, [id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'User not found' });

    const seller_profile = (await db.query(
      `SELECT id, display_name, seller_type, location_label FROM seller_profiles WHERE user_id=$1`, [id])).rows[0] || null;

    const card_on_file = (await db.query(
      `SELECT (u.stripe_customer_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM card_verifications cv WHERE cv.user_id=u.id AND cv.status='verified')) AS ok
         FROM users u WHERE u.id=$1`, [id])).rows[0].ok;

    const registrations = (await db.query(
      `SELECT ab.auction_id, a.title AS auction_title, a.state AS auction_state, ab.status, ab.paddle_number, ab.pickup_acknowledged, ab.registered_at
         FROM auction_buyers ab JOIN auctions a ON a.id=ab.auction_id WHERE ab.user_id=$1 ORDER BY ab.registered_at DESC`, [id])).rows;

    const bidding_activity = (await db.query(
      `SELECT (SELECT COUNT(DISTINCT lot_id)::int FROM lot_proxy_bids WHERE bidder_user_id=$1) AS lots_bid,
              (SELECT COUNT(*)::int FROM bids WHERE bidder_user_id=$1) AS bids_placed,
              (SELECT COUNT(*)::int FROM lots WHERE current_winner_user_id=$1 AND state='open') AS currently_winning,
              (SELECT COUNT(*)::int FROM lots WHERE winning_buyer_user_id=$1 AND state='closed') AS lots_won`, [id])).rows[0];

    const winning_lots = (await db.query(
      `SELECT l.id, l.lot_number, l.title, l.winning_amount_cents, l.auction_id, a.title AS auction_title
         FROM lots l JOIN auctions a ON a.id=l.auction_id
        WHERE l.winning_buyer_user_id=$1 AND l.state='closed' ORDER BY l.winning_amount_cents DESC NULLS LAST LIMIT 100`, [id])).rows;

    const payments = (await db.query(
      `SELECT id, lot_id, amount_cents, currency, status, charged_at, refunded_at, refunded_amount_cents, created_at
         FROM payments WHERE buyer_user_id=$1 ORDER BY created_at DESC LIMIT 200`, [id])).rows;
    const refunds = payments.filter(p => p.refunded_amount_cents > 0)
      .map(p => ({ payment_id: p.id, lot_id: p.lot_id, refunded_amount_cents: p.refunded_amount_cents, refunded_at: p.refunded_at, status: p.status }));

    const invoices = (await db.query(
      `SELECT i.id, i.amount_cents, i.status, i.lot_id, i.created_at, l.title AS lot_title
         FROM invoices i LEFT JOIN lots l ON l.id=i.lot_id WHERE i.buyer_user_id=$1 ORDER BY i.created_at DESC LIMIT 200`, [id])).rows;

    const watchlist = (await db.query(
      `SELECT w.lot_id, l.title, l.state, l.current_bid_cents, l.closes_at, w.created_at
         FROM watchlists w JOIN lots l ON l.id=w.lot_id WHERE w.user_id=$1 ORDER BY w.created_at DESC LIMIT 200`, [id])).rows;

    let notes = [];
    try {
      notes = (await db.query(
        `SELECT n.id, n.note, n.created_at, n.actor_id, au.email AS actor_email
           FROM user_admin_notes n LEFT JOIN users au ON au.id=n.actor_id
          WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 200`, [id])).rows;
    } catch (e) { /* table absent until migration 068 applied */ }

    return res.json({ success: true, data: {
      id: u.id, email: u.email, full_name: u.full_name, phone: u.phone, role: u.role,
      is_active: u.is_active, created_at: u.created_at, has_stripe_customer: u.has_stripe_customer,
      card_on_file: !!card_on_file, seller_profile, registrations, bidding_activity,
      winning_lots, payments, refunds, invoices, watchlist, admin_notes: notes,
    }});
  } catch (err) { next(err); }
});

// POST /api/admin/users/:id/status  { status: 'active'|'suspended', reason? }
router.post('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const status = (req.body && req.body.status) || '';
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ success: false, message: "status must be 'active' or 'suspended'" });
    const active = status === 'active';
    const before = (await db.query(`SELECT is_active FROM users WHERE id=$1`, [id])).rows[0];
    if (!before) return res.status(404).json({ success: false, message: 'User not found' });
    const { rows } = await db.query(`UPDATE users SET is_active=$2 WHERE id=$1 RETURNING id, email, is_active`, [id, active]);
    await writeAuditLog({
      event_type: active ? 'user.reactivated' : 'user.suspended',
      entity_type: 'user', entity_id: id, actor_id: req.user.id,
      metadata: { email: rows[0].email, previous_is_active: before.is_active, new_is_active: active, reason: (req.body && req.body.reason) || null },
    }).catch(() => {});
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// POST /api/admin/users/:id/notes  { note }
router.post('/:id/notes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note.trim() : '';
    if (!note) return res.status(400).json({ success: false, message: 'note is required' });
    const exists = (await db.query(`SELECT 1 FROM users WHERE id=$1`, [id])).rowCount > 0;
    if (!exists) return res.status(404).json({ success: false, message: 'User not found' });
    const ins = await db.query(
      `INSERT INTO user_admin_notes (user_id, note, actor_id) VALUES ($1,$2,$3) RETURNING id, note, created_at`,
      [id, note.slice(0, 5000), req.user.id]);
    await writeAuditLog({
      event_type: 'user.note_added', entity_type: 'user', entity_id: id, actor_id: req.user.id,
      metadata: { note_id: ins.rows[0].id, note_preview: note.slice(0, 120) },
    }).catch(() => {});
    return res.json({ success: true, data: ins.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/contact  { full_name?, phone? }
router.patch('/:id/contact', async (req, res, next) => {
  try {
    const { id } = req.params;
    const before = (await db.query(`SELECT full_name, phone, email FROM users WHERE id=$1`, [id])).rows[0];
    if (!before) return res.status(404).json({ success: false, message: 'User not found' });
    const sets = [], params = [];
    if (req.body && 'full_name' in req.body) { params.push(req.body.full_name == null ? null : String(req.body.full_name).slice(0, 200)); sets.push(`full_name=$${params.length}`); }
    if (req.body && 'phone' in req.body)     { params.push(req.body.phone == null ? null : String(req.body.phone).slice(0, 40));      sets.push(`phone=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No editable contact fields supplied (full_name, phone)' });
    params.push(id);
    const { rows } = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING id, email, full_name, phone`, params);
    await writeAuditLog({
      event_type: 'user.contact_updated', entity_type: 'user', entity_id: id, actor_id: req.user.id,
      metadata: { before: { full_name: before.full_name, phone: before.phone }, after: { full_name: rows[0].full_name, phone: rows[0].phone } },
    }).catch(() => {});
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
