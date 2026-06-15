const express = require('express');
const router  = express.Router();

const auctionService            = require('../services/auctionService');
const lotService                = require('../services/lotService');
const authMiddleware            = require('../middleware/authMiddleware');
const { generateAuctionReport } = require('../services/reportingService');
const { buildReportPdf }        = require('../services/pdfGenerationService');
const { sendEmail }             = require('../services/emailService');
const db                        = require('../db/index');
const { canMutateAuction, canDeleteAuction, lockErrorMessage } = require('./lots');
const registrationService = require('../services/auctionRegistrationService'); // #20

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// ── GET /  — Public auction list (non-draft auctions) ───────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, state, start_time, end_time
       FROM auctions
       WHERE state != 'draft'
       ORDER BY end_time DESC NULLS LAST`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /  — Create auction ─────────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  try {
    const {
      sellerProfileId, title, subtitle, description, state, startTime, endTime,
      streetAddress, city, addressState, zip,
      previewStart, previewEnd, pickupWindowStart, pickupWindowEnd,
      shippingAvailable, bannerImageUrl, coverImageUrl,
    } = req.body;

    if (!sellerProfileId || !title) {
      return res.status(400).json({ success: false, message: 'sellerProfileId and title are required' });
    }

    // Verify the seller profile belongs to the authenticated user (admin bypasses)
    if (req.user.role !== 'admin') {
      const spRes = await db.query(
        'SELECT id FROM seller_profiles WHERE id = $1 AND user_id = $2',
        [sellerProfileId, req.user.id]
      );
      if (!spRes.rows[0]) {
        return res.status(403).json({ success: false, message: 'Seller profile not found or not authorized' });
      }
    }

    const auction = await auctionService.createAuction({
      sellerId: sellerProfileId,
      title, subtitle, description,
      state: state || 'draft',
      startTime, endTime,
      streetAddress, city, addressState, zip,
      previewStart, previewEnd,
      pickupWindowStart, pickupWindowEnd,
      shippingAvailable, bannerImageUrl, coverImageUrl,
      // Phase C: actor context + optional admin override of the schedule rule.
      actorRole:     req.user.role,
      actorUserId:   req.user.id,
      overrideReason: req.body.override_reason,
    });

    return res.status(201).json({ success: true, data: auction });
  } catch (err) {
    // Phase C: seller-type schedule violation → 422 with the explanation.
    if (err && err.code === 'SCHEDULE_RULE_VIOLATION') {
      return res.status(422).json({
        success: false,
        code: err.code,
        message: (err.violations && err.violations[0] && err.violations[0].message) || err.message,
        violations: err.violations || [],
        adminOverrideAvailable: !!err.adminOverrideAvailable,
      });
    }
    console.error('[auctions] createAuction failed:', { userId: req.user.id, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /my  — Seller's own auctions ────────────────────────────────────────
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const auctions = await auctionService.getSellerAuctions(req.user.id);
    return res.json({ success: true, data: auctions });
  } catch (err) {
    console.error('[auctions] getSellerAuctions failed:', { userId: req.user.id, error: err.message });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/report/pdf  — Download PDF report ───────────────────────
router.get('/:auctionId/report/pdf', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { buffer } = await buildReportPdf(auctionId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="auction-report-${auctionId}.pdf"`);
    return res.send(buffer);
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    console.error('PDF Report Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/report  — JSON report ───────────────────────────────────
router.get('/:auctionId/report', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const report = await generateAuctionReport(auctionId);
    return res.json({ success: true, data: report });
  } catch (err) {
    if (err.message === 'Auction not found') {
      return res.status(404).json({ success: false, message: err.message });
    }
    console.error('Report Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /:auctionId/lots  — Add lot to auction ──────────────────────────────
router.post('/:auctionId/lots', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const {
      title, description, starting_price, pickup_category, category,
      condition, material, era, maker_artist, weight, dimensions, shippable,
    } = req.body;
    const lotData = {
      title, description,
      startingPrice: starting_price,
      pickupCategory: pickup_category,
      category, condition, material, era,
      makerArtist: maker_artist,
      weight, dimensions, shippable,
    };
    let lot;
    if (req.user.role === 'admin') {
      lot = await lotService.adminCreateLot(auctionId, lotData);
    } else {
      lot = await lotService.createLot(auctionId, req.user.id, lotData);
    }
    return res.status(201).json({ success: true, data: lot });
  } catch (err) {
    const status = err.message === 'Unauthorized or auction not found' ? 403 : 400;
    return res.status(status).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/summary  — Public auction summary (buyer-facing) ─────────
// No auth required — safe to call from unauthenticated buyer pages.
router.get('/:auctionId/summary', async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.subtitle, a.description, a.state, a.seller_id,
              a.city, a.address_state, a.zip, a.street_address, a.start_time, a.end_time,
              a.pickup_window_start, a.pickup_window_end,
              a.banner_image_url, a.cover_image_url, a.shipping_available,
              COUNT(sf.id)::int AS follower_count
         FROM auctions a
         LEFT JOIN seller_followers sf ON sf.seller_id = a.seller_id
        WHERE a.id = $1
          AND a.is_archived IS NOT TRUE   -- #22: archived auctions are not public
        GROUP BY a.id`,
      [auctionId]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    const row = rows[0];
    // Buyer-facing EFFECTIVE buyer premium (auction override → seller default → 18%).
    // BP only — never the internal AAC/seller split. (Buyer Premium Phase 1 surface.)
    try { row.buyer_premium_bps = (await require('../services/billingTermsService').resolveEffectiveTerms(auctionId)).buyer_premium_bps; }
    catch (e) { row.buyer_premium_bps = 1800; }
    // Privacy: full address stays hidden until payment is verified. Expose STREET
    // NAME only (strip the house number); never send the precise number pre-payment.
    row.pickup_street = row.street_address ? String(row.street_address).replace(/^\s*\d+\s*/, '').trim() : null;
    delete row.street_address;
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[auctions] summary error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/public-video  — Approved public walkthrough (no auth) ────
// Only returns videos that are approved AND explicitly made public by admin.
// Returns null if no qualifying video exists.
router.get('/:auctionId/public-video', async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { rows } = await db.query(
      `SELECT id, video_url, title, caption, featured_for_marketing, approved_at
         FROM auction_walkthrough_videos
        WHERE auction_id    = $1
          AND review_status = 'approved'
          AND visible_public = true
        ORDER BY approved_at DESC
        LIMIT 1`,
      [auctionId]
    );
    return res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId  — Single auction (seller-owned) ────────────────────────
router.get('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const auction = await auctionService.getAuctionById(auctionId, req.user.id);
    if (!auction) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }
    return res.json({ success: true, data: auction });
  } catch (err) {
    console.error('Get Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /:auctionId  — Update auction fields ───────────────────────────────
// Edit-lock note: the gate evaluates the auction's CURRENT state, not the
// proposed transition. So a private seller PATCHing { state: 'submitted' }
// on a draft auction passes (draft → allowed). PATCHing any field on a
// submitted auction is blocked (state lock). Admin always bypasses.
// Business sellers bypass for non-draft auctions per governance spec.
router.patch('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const gate = await canMutateAuction(req.user.id, req.user.role, auctionId);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, message: lockErrorMessage(gate.reason) });
    }
    const updated = await auctionService.updateAuction(
      auctionId, req.user.id, req.body, req.user.role,
      { overrideReason: req.body.override_reason }   // honored for admins only (server-enforced)
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: 'No valid fields or auction not found' });
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    // Phase C: seller-type schedule violation → 422 with the explanation.
    if (err && err.code === 'SCHEDULE_RULE_VIOLATION') {
      return res.status(422).json({
        success: false,
        code: err.code,
        message: (err.violations && err.violations[0] && err.violations[0].message) || err.message,
        violations: err.violations || [],
        adminOverrideAvailable: !!err.adminOverrideAvailable,
      });
    }
    console.error('Update Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── Walkthrough video ownership helper ───────────────────────────────────────
async function userOwnsAuctionForVideo(userId, role, auctionId) {
  if (role === 'admin') return true;
  const { rows } = await db.query(
    `SELECT a.id FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE a.id = $1 AND sp.user_id = $2`,
    [auctionId, userId]
  );
  return rows.length > 0;
}

// ── POST /:auctionId/walkthrough-video ────────────────────────────────────────
// Body: { video_url, title?, caption? }
// review_status defaults to pending_review — admin must approve before any public use.
// visible_public and featured_for_marketing default false and are admin-only.
router.post('/:auctionId/walkthrough-video', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const { video_url, title, caption } = req.body;
    if (!video_url || typeof video_url !== 'string') {
      return res.status(400).json({ success: false, message: 'video_url is required' });
    }
    if (!await userOwnsAuctionForVideo(req.user.id, req.user.role, auctionId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Verify auction exists and get its title for the notification
    const auctionRes = await db.query('SELECT title FROM auctions WHERE id = $1', [auctionId]);
    if (!auctionRes.rows[0]) {
      return res.status(404).json({ success: false, message: 'Auction not found' });
    }

    const { rows } = await db.query(
      `INSERT INTO auction_walkthrough_videos
         (auction_id, video_url, title, caption, review_status, visible_public, featured_for_marketing)
       VALUES ($1, $2, $3, $4, 'pending_review', false, false)
       RETURNING *`,
      [auctionId, video_url, title || null, caption || null]
    );

    const adminEmail = process.env.ADMIN_EMAIL || 'advantageauction.bid@gmail.com';
    const siteUrl    = process.env.SITE_URL    || 'https://advantage-auction-platform-production.up.railway.app';
    const auctionTitle = auctionRes.rows[0].title;
    sendEmail({
      to:      adminEmail,
      subject: 'New auction walkthrough video awaiting review',
      html: `<p>A walkthrough video has been submitted for auction:</p>
             <p><strong>${auctionTitle}</strong> (ID: ${auctionId})</p>
             <p>Video URL: <a href="${video_url}">${video_url}</a></p>
             <p>Review status: <strong>pending_review</strong> — visible_public and featured_for_marketing are both false.</p>
             <p><a href="${siteUrl}/admin">Review in admin panel</a></p>`,
      text: `New auction walkthrough video awaiting review.\n\nAuction: ${auctionTitle} (${auctionId})\nVideo: ${video_url}\n\nvisible_public = false\nfeatured_for_marketing = false`,
    }).catch(err => console.warn('[auctions] walkthrough video email failed:', err.message));

    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[auctions] walkthrough-video POST failed:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:auctionId/walkthrough-video ─────────────────────────────────────────
// Returns the most recent walkthrough video for this auction.
// Sellers see their own videos regardless of review status.
// Public-facing callers should filter on visible_public themselves.
router.get('/:auctionId/walkthrough-video', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    if (!await userOwnsAuctionForVideo(req.user.id, req.user.role, auctionId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const { rows } = await db.query(
      `SELECT * FROM auction_walkthrough_videos
        WHERE auction_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [auctionId]
    );
    return res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /:auctionId/walkthrough-video/:videoId ────────────────────────────
// Sellers can remove their own pending/rejected videos. Approved videos require admin.
router.delete('/:auctionId/walkthrough-video/:videoId', authMiddleware, async (req, res) => {
  try {
    const { auctionId, videoId } = req.params;
    if (!isUuid(auctionId) || !isUuid(videoId)) {
      return res.status(400).json({ success: false, message: 'Invalid ID' });
    }
    if (!await userOwnsAuctionForVideo(req.user.id, req.user.role, auctionId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Non-admin sellers cannot delete an approved video
    const check = await db.query(
      'SELECT review_status FROM auction_walkthrough_videos WHERE id = $1 AND auction_id = $2',
      [videoId, auctionId]
    );
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Video not found' });
    if (req.user.role !== 'admin' && check.rows[0].review_status === 'approved') {
      return res.status(403).json({ success: false, message: 'Contact Advantage to remove an approved video' });
    }

    await db.query('DELETE FROM auction_walkthrough_videos WHERE id = $1', [videoId]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /:auctionId  — Delete auction ─────────────────────────────────────
// Delete-lock note: stricter than the edit-mutation gate. Even business
// sellers cannot delete a non-draft auction — only admin can remove
// submitted/published auctions. This protects the audit/review record from
// being wiped out by sellers with expanded edit rights.
router.delete('/:auctionId', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) {
      return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    }
    const gate = await canDeleteAuction(req.user.id, req.user.role, auctionId);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, message: lockErrorMessage(gate.reason) });
    }
    const deleted = await auctionService.deleteAuction(auctionId, req.user.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Auction not found or not owned by user' });
    }
    return res.json({ success: true, data: deleted });
  } catch (err) {
    // ADMIN-CTRL Phase 1A: money-guard rejection → 409 with an actionable message.
    if (err && err.code === 'DELETE_BLOCKED') {
      return res.status(409).json({ success: false, code: 'DELETE_BLOCKED', message: err.message, blockers: err.blockers || [] });
    }
    console.error('Delete Auction Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── #20 Auction (bidder) registration ───────────────────────────────────────
// POST /api/auctions/:auctionId/register — logged-in buyer registers to bid.
// Requires accepted current terms + pickup acknowledgement. Idempotent.
router.post('/:auctionId/register', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    const result = await registrationService.registerForAuction(req.user.id, auctionId, {
      pickupAcknowledged: req.body && req.body.pickup_acknowledged === true,
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof registrationService.RegistrationError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code });
    }
    console.error('[auctions] register failed:', err.message);
    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// GET /api/auctions/:auctionId/registration-status — the caller's gate state.
router.get('/:auctionId/registration-status', authMiddleware, async (req, res) => {
  try {
    const { auctionId } = req.params;
    if (!isUuid(auctionId)) return res.status(400).json({ success: false, message: 'Invalid auction ID' });
    const status = await registrationService.getRegistrationStatus(req.user.id, auctionId);
    return res.json({ success: true, data: status });
  } catch (err) {
    console.error('[auctions] registration-status failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load registration status' });
  }
});

module.exports = router;
