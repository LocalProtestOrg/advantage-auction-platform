
const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const idempotency = require('../middleware/idempotency');
const auctionService = require('../services/auctionService');
const paymentService = require('../services/paymentService');
const videoService   = require('../services/walkthroughVideoService');
const { sendFinalSellerReport } = require('../services/pdfGenerationService');
const { enqueueNewAuctionNotifications } = require('../services/followerNotificationService');
const { writeAuditLog } = require('../lib/auditLog');
const db = require('../db');

// GET /api/admin/audit-log
// OPS-4: read-only audit timeline. Used by the moderation UI to render a
// timeline of admin actions on a specific auction (or filtered by entity).
// Joins users to surface the actor's email; falls back gracefully when
// actor_id is NULL (system-generated events from the state-transition
// scheduler).
//   auction_id    — most common filter (events for one auction)
//   entity_type   — narrow to a specific entity class (e.g., 'seller_profile')
//   entity_id     — narrow to a specific entity row
//   limit         — default 100, max 500
//   offset        — default 0
router.get('/audit-log', auth, role(['admin']), async (req, res, next) => {
  try {
    const where  = [];
    const params = [];
    if (req.query.auction_id) {
      params.push(req.query.auction_id);
      where.push(`al.auction_id = $${params.length}`);
    }
    if (req.query.entity_type) {
      params.push(req.query.entity_type);
      where.push(`al.entity_type = $${params.length}`);
    }
    if (req.query.entity_id) {
      params.push(req.query.entity_id);
      where.push(`al.entity_id = $${params.length}`);
    }
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);
    const sql = `
      SELECT al.id, al.event_type, al.entity_type, al.entity_id,
             al.auction_id, al.lot_id, al.payment_id,
             al.actor_id, al.metadata, al.created_at,
             u.email AS actor_email
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.actor_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await db.query(sql, params);
    return res.json({ success: true, data: result.rows, count: result.rows.length, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/auctions
// OPS-1: server-side auction filter + search for the moderation UI. The
// diagnostics endpoint is hard-capped at 15 rows; this endpoint accepts
// state, search, seller_email, recently_updated, and pagination so the
// operator can locate any auction without scrolling all 34+ records.
//   state             — comma-separated list (e.g., 'submitted,active')
//   search            — case-insensitive title/subtitle ILIKE
//   seller_email      — exact match (case-insensitive)
//   submitted_only    — boolean; equivalent to state=submitted
//   recently_updated  — boolean; auctions updated within last 7 days
//   limit             — default 50, max 200
//   offset            — default 0
router.get('/auctions', auth, role(['admin']), async (req, res, next) => {
  try {
    const where  = [];
    const params = [];

    if (req.query.submitted_only === 'true') {
      params.push('submitted');
      where.push(`a.state = $${params.length}`);
    } else if (req.query.state) {
      const states = String(req.query.state).split(',').map(s => s.trim()).filter(Boolean);
      if (states.length) {
        params.push(states);
        where.push(`a.state = ANY($${params.length}::text[])`);
      }
    }

    if (req.query.search) {
      params.push('%' + String(req.query.search) + '%');
      where.push(`(a.title ILIKE $${params.length} OR COALESCE(a.subtitle, '') ILIKE $${params.length})`);
    }

    if (req.query.seller_email) {
      params.push(String(req.query.seller_email).trim());
      where.push(`LOWER(u.email) = LOWER($${params.length})`);
    }

    if (req.query.recently_updated === 'true') {
      where.push(`a.updated_at > NOW() - INTERVAL '7 days'`);
    }

    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    params.push(limit, offset);

    const sql = `
      SELECT a.id, a.title, a.state, a.created_at, a.updated_at,
             COUNT(l.id)::int AS lot_count,
             u.email           AS seller_email,
             sp.seller_type    AS seller_type
        FROM auctions a
        LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
        LEFT JOIN users u            ON u.id  = sp.user_id
        LEFT JOIN lots l             ON l.auction_id = a.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       GROUP BY a.id, u.email, sp.seller_type
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const result = await db.query(sql, params);
    return res.json({ success: true, data: result.rows, count: result.rows.length, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/auctions/:auctionId
// OP-A: admin full-auction-detail fetch. The seller-side getAuctionById in
// auctionService joins on user_id which 0-rows for admin (no seller_profile),
// so this endpoint reads the row directly with admin role guard.
router.get('/auctions/:auctionId', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const { rows } = await db.query('SELECT * FROM auctions WHERE id = $1', [auctionId]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Auction not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/auctions/:auctionId
// OP-A: admin auction editing. Wires through auctionService.updateAuction
// with actorRole='admin', which bypasses the seller-ownership SQL guard
// (admin has no seller_profile so the ownership SELECT would otherwise
// return 0 rows). Field whitelist is unchanged — see updateAuction for the
// complete editable surface (title, schedule, addresses, pickup windows,
// shipping, images). State transitions still apply: admin can set any state.
router.patch('/auctions/:auctionId', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const auctionService = require('../services/auctionService');
    const { auctionId } = req.params;
    const updated = await auctionService.updateAuction(auctionId, req.user.id, req.body, 'admin');
    if (!updated) {
      return res.status(404).json({ success: false, message: 'No valid fields or auction not found' });
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[admin] PATCH /auctions/:id error:', err.message);
    return next(err);
  }
});

// POST /api/admin/sellers/:sellerId/suspend
// OPS-3: suspend a seller's user account. Sets users.is_active = false so the
// next login attempt is rejected by the auth route (return 403 with a clear
// message). Body accepts { reason: string? }; the reason is captured in the
// audit_log metadata for operational accountability.
router.post('/sellers/:sellerId/suspend', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    const reason       = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : null;
    const cur = await db.query(
      `SELECT sp.id, sp.user_id, u.email, u.is_active
         FROM seller_profiles sp
         JOIN users u ON u.id = sp.user_id
        WHERE sp.id = $1`,
      [sellerId]
    );
    if (!cur.rows[0]) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    if (cur.rows[0].is_active === false) {
      return res.status(409).json({ success: false, message: 'Seller is already suspended' });
    }
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [cur.rows[0].user_id]);
    const { writeAuditLog } = require('../lib/auditLog');
    await writeAuditLog({
      event_type:  'seller_suspended',
      entity_type: 'seller_profile',
      entity_id:   sellerId,
      actor_id:    req.user.id,
      metadata:    { user_id: cur.rows[0].user_id, email: cur.rows[0].email, reason },
    });
    return res.json({ success: true, data: { seller_profile_id: sellerId, is_active: false, reason } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/sellers/:sellerId/unsuspend
// OPS-3: reverse a previous suspension. Sets users.is_active = true. Body
// accepts { reason: string? } for the audit trail.
router.post('/sellers/:sellerId/unsuspend', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    const reason       = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : null;
    const cur = await db.query(
      `SELECT sp.id, sp.user_id, u.email, u.is_active
         FROM seller_profiles sp
         JOIN users u ON u.id = sp.user_id
        WHERE sp.id = $1`,
      [sellerId]
    );
    if (!cur.rows[0]) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    if (cur.rows[0].is_active !== false) {
      return res.status(409).json({ success: false, message: 'Seller is not suspended' });
    }
    await db.query(`UPDATE users SET is_active = true WHERE id = $1`, [cur.rows[0].user_id]);
    const { writeAuditLog } = require('../lib/auditLog');
    await writeAuditLog({
      event_type:  'seller_unsuspended',
      entity_type: 'seller_profile',
      entity_id:   sellerId,
      actor_id:    req.user.id,
      metadata:    { user_id: cur.rows[0].user_id, email: cur.rows[0].email, reason },
    });
    return res.json({ success: true, data: { seller_profile_id: sellerId, is_active: true, reason } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/sellers/:sellerId/capabilities
// OPS-2: closes Defect 2 partially — capability map is now writable.
// Body accepts an arbitrary key/value object that is MERGED into the existing
// seller_profiles.capabilities JSONB (keys not in the request are left
// untouched). Audit log entry per change records before/after.
// Frontend-side gating (e.g., UX-blocker-3's reserve hide) still uses
// seller_type, not capabilities — wiring the data path here is the
// prerequisite for future frontend gates that read capabilities.
router.post('/sellers/:sellerId/capabilities', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const { sellerId }    = req.params;
    const updates         = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!updates) {
      return res.status(400).json({ success: false, message: 'Body must be an object of capability key/value pairs' });
    }
    const cur = await db.query(
      `SELECT id, user_id, capabilities FROM seller_profiles WHERE id = $1`,
      [sellerId]
    );
    if (!cur.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    const before = cur.rows[0].capabilities || {};
    const after  = { ...before, ...updates };
    const out    = await db.query(
      `UPDATE seller_profiles SET capabilities = $1::jsonb WHERE id = $2
       RETURNING id, user_id, seller_type, capabilities`,
      [JSON.stringify(after), sellerId]
    );
    const { writeAuditLog } = require('../lib/auditLog');
    await writeAuditLog({
      event_type:  'seller_capabilities_changed',
      entity_type: 'seller_profile',
      entity_id:   sellerId,
      actor_id:    req.user.id,
      metadata:    { before, after, changed_keys: Object.keys(updates) },
    });
    return res.json({ success: true, data: out.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/auctions/:auctionId/publish
router.post('/auctions/:auctionId/publish', auth, role(['admin']), idempotency, (req, res) => {
  res.status(501).json({
    message: 'Not implemented',
    responseShape: { id: 'uuid', state: 'published' }
  });
});

// PATCH /api/admin/auctions/:auctionId/publish
router.patch('/auctions/:auctionId/publish', auth, role(['admin']), idempotency, async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await auctionService.publishAuction(auctionId, req.user.id);

    // Fan-out NEW_AUCTION notifications to seller followers after commit.
    // Guarded: failure here must never affect the publish response.
    enqueueNewAuctionNotifications(result).catch(err => {
      const log = require('../lib/logger');
      log.warn('followers', 'NEW_AUCTION enqueue failed', { auctionId, error: err.message });
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message === 'Auction is already published') {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.message === 'Cannot publish a closed auction') {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// POST /api/admin/auctions/:auctionId/close
router.post('/auctions/:auctionId/close', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await auctionService.closeAuction(auctionId, req.user.id);
    return res.json({
      success: true,
      message: 'Auction closed successfully.',
      data: result
    });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message === 'Auction is already closed') {
      return res.status(409).json({ success: false, message: err.message });
    }
    if (err.message === 'Only published auctions can be closed') {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// POST /api/admin/auctions/:auctionId/return-to-draft
// GOV-RET: send a submitted/under_review auction back to the seller for
// revisions with a written reason. The auction reverts to 'draft' state
// (re-enabling all seller editing — the same edit-lock rule that gates
// 'draft' applies). The reason is persisted to auctions.revision_note so
// the seller dashboard can render it as a banner alongside the draft, and
// revision_count is incremented so AUD-EXP and the dashboard can tell a
// fresh draft apart from a revision cycle.
//
// Only 'submitted' and 'under_review' are valid source states. Active and
// published auctions cannot be returned to draft — that would silently
// drop live bidding state. Operators must close-then-rebuild instead.
router.post('/auctions/:auctionId/return-to-draft', auth, role(['admin']), idempotency, async (req, res, next) => {
  const { auctionId } = req.params;
  const reason = (req.body && typeof req.body.reason === 'string') ? req.body.reason.trim() : '';
  if (!reason) {
    return res.status(400).json({ success: false, message: 'A revision reason is required.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock the auction row and verify the source state. Joining seller_profiles
    // here gives us the seller's user_id for the follow-up notification queue
    // insert without a second round-trip.
    const cur = await client.query(
      `SELECT a.id, a.state, a.title, sp.user_id AS seller_user_id
         FROM auctions a
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE a.id = $1
        FOR UPDATE OF a`,
      [auctionId]
    );
    if (!cur.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Auction not found.' });
    }
    const fromState = cur.rows[0].state;
    if (fromState !== 'submitted' && fromState !== 'under_review') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `Only submitted or under_review auctions can be returned to draft. Current state: ${fromState}.`,
      });
    }

    await client.query(
      `UPDATE auctions
          SET state          = 'draft',
              revision_note  = $1,
              revision_count = revision_count + 1,
              updated_at     = NOW()
        WHERE id = $2`,
      [reason, auctionId]
    );

    // Queue the seller-facing notification inside the transaction so the
    // notification queue write rolls back with the state change if anything
    // downstream throws.
    await client.query(
      `INSERT INTO notifications_queue (user_id, type, payload)
       VALUES ($1, 'AUCTION_RETURNED_TO_DRAFT', $2::jsonb)`,
      [
        cur.rows[0].seller_user_id,
        JSON.stringify({
          auction_id: auctionId,
          title:      cur.rows[0].title,
          reason,
        }),
      ]
    );

    await client.query('COMMIT');

    // Audit write is non-blocking by design (see writeAuditLog). Runs after
    // commit so an audit failure cannot roll back the seller-visible state
    // change.
    writeAuditLog({
      event_type:  'auction_returned_to_draft',
      entity_type: 'auction',
      entity_id:   auctionId,
      auction_id:  auctionId,
      actor_id:    req.user.id,
      metadata:    { from_state: fromState, reason },
    }).catch(() => {});

    return res.json({ success: true, message: 'Auction returned to draft. Seller has been notified.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/admin/auctions/:auctionId/send-final-report
// MANUAL ONLY — human-gated. Never called automatically by the auction lifecycle.
router.post('/auctions/:auctionId/send-final-report', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const result = await sendFinalSellerReport(auctionId);
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (err.message.startsWith('sendFinalSellerReport: not yet implemented')) {
      return res.status(501).json({ success: false, message: 'Final report delivery is not yet implemented. The endpoint is wired and protected.' });
    }
    next(err);
  }
});

// POST /api/admin/payments/:paymentId/refund
// Full or partial refund of a paid payment. Admin-only.
// Body: { refund_amount_cents: number }
router.post('/payments/:paymentId/refund', auth, role(['admin']), async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { refund_amount_cents } = req.body;

    if (refund_amount_cents == null || typeof refund_amount_cents !== 'number' || refund_amount_cents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'refund_amount_cents is required and must be a positive number',
      });
    }

    const result = await paymentService.processRefund(req.user.id, paymentId, refund_amount_cents);
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Payment not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    if (
      err.message.startsWith('Cannot refund') ||
      err.message.startsWith('Refund amount')
    ) {
      return res.status(422).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// POST /api/admin/payments/:paymentId/record-success
router.post('/payments/:paymentId/record-success', auth, role(['admin']), async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const { payment_provider_id } = req.body;
    const result = await paymentService.recordPaymentSuccess(
      paymentId,
      payment_provider_id || 'manual'
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err.message === 'Payment not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    next(err);
  }
});

// ── GET /api/admin/diagnostics/auctions ──────────────────────────────────────
// Pilot operational visibility: auction states and open lot counts.
router.get('/diagnostics/auctions', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statesRes, openLotsRes, recentRes] = await Promise.all([
      db.query(`SELECT state, COUNT(*)::int AS count FROM auctions GROUP BY state ORDER BY state`),
      db.query(`SELECT COUNT(*)::int AS count FROM lots WHERE state = 'open'`),
      db.query(`
        SELECT a.id, a.title, a.state, a.created_at,
               COUNT(l.id)::int AS lot_count,
               u.email           AS seller_email,
               sp.seller_type    AS seller_type
          FROM auctions a
          LEFT JOIN seller_profiles sp ON sp.id = a.seller_id
          LEFT JOIN users u            ON u.id  = sp.user_id
          LEFT JOIN lots l             ON l.auction_id = a.id
         GROUP BY a.id, u.email, sp.seller_type
         ORDER BY a.created_at DESC
         LIMIT 15
      `),
    ]);
    return res.json({
      success: true,
      data: {
        auction_states:  statesRes.rows,
        open_lots:       openLotsRes.rows[0].count,
        recent_auctions: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/diagnostics/payments ──────────────────────────────────────
// Pilot operational visibility: payment statuses and recent activity.
router.get('/diagnostics/payments', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statusRes, recentRes] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM payments GROUP BY status ORDER BY status`),
      db.query(`
        SELECT p.id, p.amount_cents, p.status, p.created_at,
               l.title AS lot_title
          FROM payments p
          LEFT JOIN lots l ON l.id = p.lot_id
         ORDER BY p.created_at DESC
         LIMIT 15
      `),
    ]);
    return res.json({
      success: true,
      data: {
        by_status:       statusRes.rows,
        recent_payments: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/diagnostics/notifications ──────────────────────────────────
// Pilot operational visibility: notification delivery status and queue depth.
router.get('/diagnostics/notifications', auth, role(['admin']), async (req, res, next) => {
  try {
    const [statusRes, queueRes, recentRes] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM notifications GROUP BY status ORDER BY status`),
      db.query(`SELECT COUNT(*)::int AS count FROM notifications_queue`),
      db.query(`
        SELECT id, notification_type, channel, status, sent_at, failed_reason, retry_count, created_at
          FROM notifications
         ORDER BY created_at DESC
         LIMIT 10
      `),
    ]);
    return res.json({
      success: true,
      data: {
        by_status:            statusRes.rows,
        queue_depth:          queueRes.rows[0].count,
        recent_notifications: recentRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/email/test ────────────────────────────────────────────────
// Sends a single test email via the configured SMTP transporter.
// Used during pilot readiness validation — confirms SMTP auth and outbound delivery.
// Does NOT queue a notification row or touch the notifications_queue table.
router.post('/email/test', auth, role(['admin']), async (req, res, next) => {
  try {
    const { to } = req.body;
    if (!to || typeof to !== 'string' || !to.includes('@')) {
      return res.status(400).json({ success: false, message: 'to must be a valid email address' });
    }

    const { sendEmail } = require('../services/emailService');
    const result = await sendEmail({
      to,
      subject: 'Advantage Auction — SMTP delivery test',
      html: `
        <p>This is an automated SMTP delivery test from the Advantage Auction Platform.</p>
        <p>If you received this email, outbound delivery is working correctly.</p>
        <ul>
          <li><strong>To:</strong> ${to}</li>
          <li><strong>Sent at:</strong> ${new Date().toISOString()}</li>
          <li><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</li>
        </ul>
        <p>Check email headers for SPF and DKIM pass status.</p>
      `.trim(),
      text: `Advantage Auction SMTP test — sent at ${new Date().toISOString()}. If you received this, outbound delivery is working.`,
    });

    if (result.skipped) {
      return res.status(503).json({
        success: false,
        message: 'SMTP not configured — SMTP_HOST, SMTP_USER, and SMTP_PASS must be set',
        email_configured: false,
      });
    }

    return res.json({
      success: true,
      message: `Test email sent to ${to}`,
      message_id: result.messageId,
      email_configured: true,
    });
  } catch (err) {
    // Surface SMTP errors directly — this is an admin diagnostic endpoint,
    // generic 500 conceals the actionable error (e.g. "Connection timeout").
    return res.status(502).json({
      success: false,
      message: 'SMTP delivery failed',
      smtp_error: err.message,
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT,
    });
  }
});

// GET /api/admin/sellers?search=<email>
// Returns matching seller profiles with user email, type, capabilities, and auction count.
router.get('/sellers', auth, role(['admin']), async (req, res, next) => {
  try {
    const search = (req.query.search || '').trim();
    const rows = await db.query(
      // is_active surfaces seller suspension status (added by migration 046)
      `SELECT sp.id              AS seller_profile_id,
              sp.seller_type,
              sp.capabilities,
              sp.created_at      AS profile_created_at,
              u.id               AS user_id,
              u.email,
              u.role,
              u.is_active,
              u.created_at       AS user_created_at,
              COUNT(a.id)::int   AS auction_count
         FROM seller_profiles sp
         JOIN users u ON u.id = sp.user_id
    LEFT JOIN auctions a ON a.seller_id = sp.id
        WHERE ($1 = '' OR u.email ILIKE $2)
     GROUP BY sp.id, u.id
     ORDER BY sp.created_at DESC
        LIMIT 50`,
      [search, `%${search}%`]
    );
    return res.json({ success: true, data: rows.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payouts?status=<pending|released|all>
// Returns seller_payouts rows with seller email for operational visibility.
router.get('/payouts', auth, role(['admin']), async (req, res, next) => {
  try {
    const status = req.query.status || 'all';
    const validStatuses = ['pending', 'released', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'status must be pending, released, or all' });
    }

    const rows = await db.query(
      `SELECT sp.id                  AS payout_id,
              sp.auction_id,
              sp.seller_user_id,
              sp.gross_revenue_cents,
              sp.platform_fee_cents,
              sp.seller_payout_cents,
              sp.payout_method,
              sp.payout_status,
              sp.payout_reference,
              sp.created_at,
              sp.updated_at,
              u.email                AS seller_email,
              a.title                AS auction_title
         FROM seller_payouts sp
         JOIN users u ON u.id = sp.seller_user_id
    LEFT JOIN auctions a ON a.id = sp.auction_id
        WHERE ($1 = 'all' OR sp.payout_status = $1)
     ORDER BY sp.created_at DESC
        LIMIT 100`,
      [status]
    );
    return res.json({ success: true, data: rows.rows });
  } catch (err) {
    next(err);
  }
});

// ── Walkthrough video moderation ─────────────────────────────────────────────

// GET /api/admin/videos — all videos with optional ?status=pending_review|approved|rejected
router.get('/videos', auth, role(['admin']), async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const rows = await videoService.listAllVideos(req.query.status, limit);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/videos/pending — moderation queue (oldest first)
router.get('/videos/pending', auth, role(['admin']), async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await videoService.getPendingVideos(limit);
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// POST /api/admin/videos/:videoId/approve
// Sets review_status='approved'. Does NOT auto-publish (visible_public stays false).
router.post('/videos/:videoId/approve', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const adminUserId = req.user.id;
    const row = await videoService.approveVideo(videoId, adminUserId);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// POST /api/admin/videos/:videoId/reject
// Body: { reason? }
router.post('/videos/:videoId/reject', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { reason } = req.body || {};
    const adminUserId = req.user.id;
    const row = await videoService.rejectVideo(videoId, adminUserId, reason || null);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/videos/:videoId/visibility
// Body: { visible: true|false }  — only works after approval
router.patch('/videos/:videoId/visibility', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ success: false, message: 'visible must be a boolean' });
    }
    const row = await videoService.setPublicVisibility(videoId, visible);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found or not yet approved' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/videos/:videoId/featured
// Body: { featured: true|false }  — only works after approval
router.patch('/videos/:videoId/featured', auth, role(['admin']), async (req, res, next) => {
  try {
    const { videoId } = req.params;
    const { featured } = req.body || {};
    if (typeof featured !== 'boolean') {
      return res.status(400).json({ success: false, message: 'featured must be a boolean' });
    }
    const row = await videoService.setFeaturedForMarketing(videoId, featured);
    if (!row) return res.status(404).json({ success: false, message: 'Video not found or not yet approved' });
    return res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/auctions/:auctionId/discovery
// Updates marketplace discovery fields: priority, lat, lng.
// All body fields are optional — only supplied fields are updated.
// Body: { priority?: integer 0–10000, lat?: float, lng?: float }
router.patch('/auctions/:auctionId/discovery', auth, role(['admin']), async (req, res, next) => {
  try {
    const { auctionId } = req.params;
    const { priority, lat, lng } = req.body || {};

    const updates = [];
    const params  = [];

    if (priority !== undefined) {
      if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 10000) {
        return res.status(400).json({ success: false, message: 'priority must be a non-negative integer (0–10000)' });
      }
      params.push(priority);
      updates.push(`marketplace_priority = $${params.length}`);
    }

    if (lat !== undefined) {
      const latF = parseFloat(lat);
      if (isNaN(latF) || latF < -90 || latF > 90) {
        return res.status(400).json({ success: false, message: 'lat must be a number between -90 and 90' });
      }
      params.push(latF);
      updates.push(`lat = $${params.length}`);
    }

    if (lng !== undefined) {
      const lngF = parseFloat(lng);
      if (isNaN(lngF) || lngF < -180 || lngF > 180) {
        return res.status(400).json({ success: false, message: 'lng must be a number between -180 and 180' });
      }
      params.push(lngF);
      updates.push(`lng = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one of priority, lat, lng is required' });
    }

    params.push(auctionId);
    const { rows } = await db.query(
      `UPDATE auctions
          SET ${updates.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING id, title, state, marketplace_priority, lat, lng`,
      params
    );

    if (!rows.length) return res.status(404).json({ success: false, message: 'Auction not found' });
    return res.json({ success: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── Config sub-router ─────────────────────────────────────────────────────────
// Handles /api/admin/config/platform, /widgets, /packages
// Auth + role enforcement is applied inside adminConfig.js
router.use('/config', require('./adminConfig').router);

module.exports = router;
