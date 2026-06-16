const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const authMiddleware = require('../middleware/authMiddleware');
const optionalAuth = require('../middleware/optionalAuthMiddleware');
const { redactRealizedPrice } = require('../lib/realizedPrice'); // #20.1
const { annotateViewerBidState } = require('../lib/viewerBidState'); // #2/#10
const { auctionBiddingOpen } = require('../lib/biddingWindow'); // auction start gate
const registrationService = require('../services/auctionRegistrationService'); // #20
const db = require('../db');
const { getBidsByLot, createBid, resolveIncrementOverride, resolveAuctionIncrementOverride, effectiveIncrement, nextMinBidCents } = require('../services/bidService');
const imageProcessingService      = require('../services/imageProcessingService');
const { writeAuditLog }           = require('../lib/auditLog');
const { isProfessional }          = require('../services/sellerTypeRules');

// ── Phase C.2: professional-only lot settings (starting bid, reserve) ─────────
// Server-authoritative gate. Admin may configure anything (override). Otherwise
// ONLY professional seller types (auction_house / estate_sale_company /
// professional_liquidator) may set starting_bid / reserve; non-professional and
// untyped sellers have these IGNORED here (stored null → existing $1 fallback /
// no reserve). Frontend hiding is UX only; this is the enforcement.
async function proSettingsAllowedForAuction(userRole, auctionId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT sp.seller_type FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1`,
    [auctionId]
  );
  return rows[0] ? isProfessional(rows[0].seller_type) : false;
}

async function proSettingsAllowedForLot(userRole, lotId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT sp.seller_type FROM lots l
       JOIN auctions a        ON a.id  = l.auction_id
       JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE l.id = $1`,
    [lotId]
  );
  return rows[0] ? isProfessional(rows[0].seller_type) : false;
}

// ── Ownership helpers (admin bypasses both checks) ───────────────────────────

async function userOwnsAuction(userId, userRole, auctionId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT 1 FROM auctions a
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE a.id = $1 AND sp.user_id = $2`,
    [auctionId, userId]
  );
  return rows.length > 0;
}

async function userOwnsLot(userId, userRole, lotId) {
  if (userRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT 1 FROM lots l
     JOIN auctions a ON a.id = l.auction_id
     JOIN seller_profiles sp ON sp.id = a.seller_id
     WHERE l.id = $1 AND sp.user_id = $2`,
    [lotId, userId]
  );
  return rows.length > 0;
}

// ── Governance: edit-lock for submitted auctions ─────────────────────────────
//
// Private/other sellers lose mutation rights on an auction once it transitions
// out of 'draft' state. Editing returns only when an admin moves it back to
// 'draft'. Admin always bypasses. Business sellers (auction houses, estate
// sale companies) are exempt from the lock — they may receive expanded
// editing permissions per the broader capability roadmap. This is the
// surgical implementation; a full capability/RBAC system is deferred.
//
// Returns { allowed: boolean, reason: string }. Reasons: 'admin',
// 'draft', 'business_seller_bypass', 'auction_locked_after_submission',
// 'auction_not_found', 'lot_not_found'.
async function canMutateAuction(userId, userRole, auctionId) {
  if (userRole === 'admin') return { allowed: true, reason: 'admin' };
  const { rows } = await db.query(
    `SELECT a.state, sp.seller_type
       FROM auctions a
       LEFT JOIN seller_profiles sp ON sp.user_id = $2
      WHERE a.id = $1`,
    [auctionId, userId]
  );
  if (!rows[0]) return { allowed: false, reason: 'auction_not_found' };
  const { state, seller_type } = rows[0];
  if (state === 'draft')               return { allowed: true,  reason: 'draft' };
  if (seller_type === 'business')      return { allowed: true,  reason: 'business_seller_bypass' };
  return { allowed: false, reason: 'auction_locked_after_submission' };
}

async function canMutateLot(userId, userRole, lotId) {
  if (userRole === 'admin') return { allowed: true, reason: 'admin' };
  const { rows } = await db.query(`SELECT auction_id FROM lots WHERE id = $1`, [lotId]);
  if (!rows[0]) return { allowed: false, reason: 'lot_not_found' };
  return canMutateAuction(userId, userRole, rows[0].auction_id);
}

// Deletion is treated more strictly than ordinary edit-mutation: even
// business sellers cannot delete a non-draft auction. Once an auction has
// been submitted, only Advantage (admin) can remove it. This protects the
// audit/review record even for sellers who have expanded edit rights.
async function canDeleteAuction(userId, userRole, auctionId) {
  if (userRole === 'admin') return { allowed: true, reason: 'admin' };
  const { rows } = await db.query(
    `SELECT state FROM auctions WHERE id = $1`,
    [auctionId]
  );
  if (!rows[0]) return { allowed: false, reason: 'auction_not_found' };
  if (rows[0].state === 'draft') return { allowed: true, reason: 'draft' };
  return { allowed: false, reason: 'auction_locked_after_submission' };
}

// Maps internal lock reasons to user-facing 403 messages. Keep terse and
// actionable — sellers should understand what to do (contact Advantage).
function lockErrorMessage(reason) {
  if (reason === 'auction_locked_after_submission') {
    return 'This auction is awaiting Advantage review. Contact Advantage to request changes.';
  }
  if (reason === 'auction_not_found') return 'Auction not found';
  if (reason === 'lot_not_found')     return 'Lot not found';
  return 'Access denied';
}

// ── Input validators ─────────────────────────────────────────────────────────

// Validate dimensions payload. Accepts only { text: "..." } where text is a
// non-empty trimmed string up to 200 chars. Returns the normalized object on
// success or null on any malformed input — callers should treat null as
// "do not write" (POST → store NULL; PUT → COALESCE preserves existing).
function validateDimensions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.text !== 'string') return null;
  const trimmed = input.text.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return { text: trimmed };
}

// ── Bid sub-routes (must come before /:lotId to avoid shadowing) ─────────────

// GET /api/lots/:lotId/bids
router.get('/:lotId/bids', authMiddleware, async (req, res) => {
  try {
    const bids = await getBidsByLot(req.params.lotId);
    res.json({ success: true, data: bids });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/lots/:lotId/bids
// Bidding only allowed on active lots — draft and closed lots are rejected.
// Also rejects bids on lots whose scheduled close time has already passed.
router.post('/:lotId/bids', authMiddleware, async (req, res) => {
  try {
    const lotRes = await db.query(
      `SELECT l.state, l.closes_at, l.auction_id,
              a.state AS auction_state, a.start_time AS auction_start_time
         FROM lots l
         JOIN auctions a ON a.id = l.auction_id
        WHERE l.id = $1`,
      [req.params.lotId]);
    const lot    = lotRes.rows[0];
    if (!lot)                       return res.status(404).json({ success: false, message: 'Lot not found' });
    if (lot.state === 'withdrawn')  return res.status(403).json({ success: false, message: 'Lot is not open for bidding' });
    if (lot.state !== 'open')       return res.status(422).json({ success: false, message: 'Lot is not accepting bids' });
    // Auction-level start gate (see src/lib/biddingWindow.js): registration opens at
    // state='published' (scheduled), but the auction is only biddable once it has
    // started (active + start_time passed). Without this guard a registered buyer with
    // a card could bid on a not-yet-started auction (e.g. an upcoming/"Coming Soon"
    // auction whose lots are already 'open').
    if (!auctionBiddingOpen(lot.auction_state, lot.auction_start_time)) {
      return res.status(422).json({ success: false, message: 'Bidding has not opened for this auction yet' });
    }
    // Time-based close enforcement: a lot with a closes_at in the past has
    // ended even if no scheduler has flipped state to 'closed'. Without this
    // guard, lots whose end time has passed would silently keep accepting bids
    // (observed on staging 2026-05-28 against the Whitfield Estate lots whose
    // closes_at was 12 days in the past).
    if (lot.closes_at && new Date() > new Date(lot.closes_at)) {
      return res.status(422).json({ success: false, message: 'Lot has closed and is no longer accepting bids' });
    }

    // #20: server-side bidding gate — active account + accepted current terms +
    // active auction registration. (Card-on-file is STEP 4, not enforced yet.)
    const gate = await registrationService.assertCanBid(req.user.id, lot.auction_id);
    if (!gate.ok) {
      return res.status(gate.status).json({ success: false, message: gate.message, code: gate.code });
    }

    const { amount, maxBid, max_bid_cents } = req.body;
    const result = await createBid(req.params.lotId, req.user.id, { amount, maxBid, max_bid_cents });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/lots/my-bids — lots the authenticated buyer has bid on, with their
// per-viewer status (#6 My Bids). Declared BEFORE /:lotId so it isn't shadowed.
router.get('/my-bids', authMiddleware, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT l.id, l.auction_id, l.lot_number, l.title, l.state,
              l.current_bid_cents, l.winning_amount_cents, l.bid_count,
              l.closes_at, l.extended_until, l.thumbnail_url,
              l.current_winner_user_id, l.winning_buyer_user_id,
              pb.max_amount_cents AS viewer_max
         FROM lot_proxy_bids pb
         JOIN lots l ON l.id = pb.lot_id
        WHERE pb.bidder_user_id = $1
          AND l.state != 'withdrawn'
          AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.id = l.auction_id AND a.is_archived IS TRUE)
        ORDER BY (l.state = 'open') DESC, l.closes_at ASC NULLS LAST`,
      [req.user.id]
    );
    // Authed viewer (they bid on these) → realized prices visible; annotate strips
    // winner UUIDs and adds viewer_is_high_bidder / viewer_has_bid / viewer_max_bid_cents.
    const data = result.rows.map(r => redactRealizedPrice(annotateViewerBidState(r, req.user.id, r.viewer_max), true));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── Lot CRUD ─────────────────────────────────────────────────────────────────

// POST /api/lots
router.post('/', auth, async (req, res, next) => {
  try {
    const { auctionId, title, description, size_category, pickup_category, bid_increment_cents, starting_bid_cents, reserve_cents, reserve_visible, dimensions } = req.body;
    // Edit-lock gate — refuse mutation if parent auction is past 'draft' for
    // a private/other seller. Admin and business sellers bypass.
    const gate = await canMutateAuction(req.user.id, req.user.role, auctionId);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, message: lockErrorMessage(gate.reason) });
    }
    // Phase C.2: professional-only settings. Non-professional sellers have
    // starting_bid + reserve ignored → null (existing $1 fallback / no reserve).
    const proAllowed        = await proSettingsAllowedForAuction(req.user.role, auctionId);
    const effStartingBid    = proAllowed ? (starting_bid_cents || null) : null;
    const effReserveCents   = proAllowed ? (reserve_cents || null)      : null;
    const effReserveVisible = proAllowed ? (reserve_visible === true)   : false;
    const dimsValidated = validateDimensions(dimensions); // null if invalid → stored as NULL
    const result = await db.query(
      `INSERT INTO lots (auction_id, title, description, size_category, pickup_category, bid_increment_cents, starting_bid_cents, reserve_cents, reserve_visible, dimensions, lot_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
               (SELECT COALESCE(MAX(lot_number), 0) + 1 FROM lots WHERE auction_id = $1))
       RETURNING *`,
      [auctionId, title, description, size_category || null, pickup_category || null, bid_increment_cents || null, effStartingBid, effReserveCents, effReserveVisible, dimsValidated ? JSON.stringify(dimsValidated) : null]
    );
    // INT-2: audit lot creation. Non-blocking — helper swallows errors.
    const created = result.rows[0];
    writeAuditLog({
      event_type:  'lot_added',
      entity_type: 'lot',
      entity_id:   created.id,
      auction_id:  auctionId,
      lot_id:      created.id,
      actor_id:    req.user.id,
      metadata:    { lot_number: created.lot_number, title: created.title, actor_role: req.user.role },
    }).catch(() => {});
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/auction/:auctionId/seller  (must come before /:auctionId)
// Seller-facing: returns all non-withdrawn lots with first image URL. Auth + ownership required.
router.get('/auction/:auctionId/seller', auth, async (req, res, next) => {
  try {
    if (!await userOwnsAuction(req.user.id, req.user.role, req.params.auctionId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const result = await db.query(
      `SELECT l.*,
         (SELECT image_url FROM lot_images WHERE lot_id = l.id ORDER BY sort_order ASC LIMIT 1) AS first_image_url
       FROM lots l
       WHERE l.auction_id = $1
         AND l.state != 'withdrawn'
       ORDER BY l.created_at ASC`,
      [req.params.auctionId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/auction/:auctionId  (must come before /:lotId)
// Withdrawn lots are excluded — this endpoint is buyer-facing and public.
// winning_buyer_user_id and current_winner_user_id are selected ONLY to derive
// viewer_is_high_bidder (annotateViewerBidState), then STRIPPED before the response;
// winning_amount_cents is the final hammer price (public) and is kept for display.
router.get('/auction/:auctionId', optionalAuth, async (req, res, next) => {
  try {
    // #22: archived auctions are not browsable publicly.
    const arch = (await db.query('SELECT is_archived FROM auctions WHERE id = $1', [req.params.auctionId])).rows[0];
    if (arch && arch.is_archived) return res.status(404).json({ success: false, message: 'Auction not available' });

    const result = await db.query(
      `SELECT id, auction_id, lot_number, title, description,
              category, size_category, pickup_category,
              condition, material, era, maker_artist, weight, dimensions,
              shippable, shipping_cost_cents, shipping_notes,
              starting_bid_cents, bid_increment_cents, current_bid_cents, bid_count,
              winning_amount_cents, current_winner_user_id, winning_buyer_user_id,
              state, is_withdrawn, is_featured,
              closes_at, extended_until, extension_count,
              thumbnail_url, images_count,
              created_at, updated_at
       FROM lots
       WHERE auction_id = $1
         AND state != 'withdrawn'
       ORDER BY created_at ASC`,
      [req.params.auctionId]
    );

    // #17/#16/#3: surface server-authoritative bid math so the lot cards' "Next
    // minimum bid" agrees EXACTLY with bidService validation. The increment now
    // follows the platform ladder banded by EACH lot's current price (a flat
    // override at lot/auction/house level still wins when configured), so we
    // resolve the auction/house override once and band every lot individually.
    const lots = result.rows;
    if (lots.length) {
      let auctionOverride = null;
      try {
        auctionOverride = await resolveAuctionIncrementOverride(db, req.params.auctionId);
      } catch (e) {
        console.error('[lots] list increment override failed for auction', req.params.auctionId, e.message);
      }
      for (const lot of lots) {
        const override = lot.bid_increment_cents != null ? lot.bid_increment_cents : auctionOverride;
        const starting = lot.starting_bid_cents || 100;
        const current  = lot.current_bid_cents  || 0;
        lot.effective_bid_increment_cents = effectiveIncrement(current, override);
        lot.next_min_bid_cents = nextMinBidCents(starting, current, override);
      }
    }

    // #2/#10: annotate per-viewer bid state (strips winner UUIDs) BEFORE the
    // #20.1 realized-price gate. Fetch the viewer's OWN proxy maximums for these
    // lots in one query (their data only — privacy-safe).
    const isAuthed = !!req.user;
    const viewerId = req.user && req.user.id;
    const viewerMax = {};
    if (viewerId && lots.length) {
      try {
        const pm = await db.query(
          `SELECT lot_id, max_amount_cents FROM lot_proxy_bids
            WHERE bidder_user_id = $1 AND lot_id = ANY($2::uuid[])`,
          [viewerId, lots.map(l => l.id)]
        );
        for (const r of pm.rows) viewerMax[r.lot_id] = r.max_amount_cents;
      } catch (e) { console.error('[lots] viewer proxy-max fetch failed', e.message); }
    }
    res.json({ success: true, data: lots.map(l => redactRealizedPrice(annotateViewerBidState(l, viewerId, viewerMax[l.id]), isAuthed)) });
  } catch (err) {
    next(err);
  }
});

// ── Image sub-routes (must come before /:lotId to avoid shadowing) ───────────

// POST /api/lots/:lotId/images
router.post('/:lotId/images', auth, async (req, res, next) => {
  try {
    const { images } = req.body;
    const rawFlag = req.body.enhancement_enabled;
    // Strict normalization: only boolean true or string "true" is enabled.
    // Missing (undefined) defaults to true for backward compatibility.
    const batchEnhancement = rawFlag === undefined ? true : (rawFlag === true || rawFlag === 'true');

    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, message: 'Images array required' });
    }

    // Store enhancement_enabled per image row — all images in this batch share the flag.
    // $1 = lot_id, $2…$(n+1) = image URLs, $(n+2) = enhancement_enabled flag
    const flagParamIdx = images.length + 2;
    const values = images.map((url, i) => `($1, $${i + 2}, ${i}, $${flagParamIdx})`).join(',');
    const params = [req.params.lotId, ...images, batchEnhancement];

    const inserted = await db.query(
      `INSERT INTO lot_images (lot_id, image_url, sort_order, enhancement_enabled)
       VALUES ${values} RETURNING image_url, enhancement_enabled`,
      params
    );

    // Enqueue per inserted row — respects the stored enhancement_enabled value
    for (const row of inserted.rows) {
      if (row.enhancement_enabled && typeof row.image_url === 'string' && row.image_url.includes('res.cloudinary.com')) {
        imageProcessingService.createProcessingJob({
          lotTempId:        req.params.lotId,
          originalImageUrl: row.image_url,
          enhancementType:  'white_background',
        }).catch(err => console.warn('[lots] image-processing enqueue failed:', err.message));
      }
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId/images
// Enriches each row with processed_image_url, processing_status, and best_image_url.
// best_image_url = processed_image_url when complete, otherwise original image_url.
router.get('/:lotId/images', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT
         li.*,
         j.processed_image_url,
         j.status                                               AS processing_status,
         CASE
           WHEN j.status = 'complete' AND j.processed_image_url IS NOT NULL
           THEN j.processed_image_url
           ELSE li.image_url
         END                                                    AS best_image_url
       FROM lot_images li
       LEFT JOIN LATERAL (
         SELECT processed_image_url, status
         FROM image_processing_jobs
         WHERE lot_temp_id        = li.lot_id::TEXT
           AND original_image_url = li.image_url
         ORDER BY created_at DESC
         LIMIT 1
       ) j ON TRUE
       WHERE li.lot_id = $1
       ORDER BY li.sort_order ASC`,
      [req.params.lotId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/lots/:lotId  (soft delete — ownership + zero-bid guard)
router.delete('/:lotId', auth, async (req, res, next) => {
  try {
    if (!await userOwnsLot(req.user.id, req.user.role, req.params.lotId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Edit-lock gate — refuse delete if parent auction is past 'draft' for
    // a private/other seller.
    const gate = await canMutateLot(req.user.id, req.user.role, req.params.lotId);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, message: lockErrorMessage(gate.reason) });
    }
    // INT-2: pull auction_id + lot_number alongside the bid_count guard so we
    // can scope the audit_log entry to the parent auction (audit timeline
    // filters on auction_id) without a second round-trip.
    const check = await db.query(
      'SELECT bid_count, auction_id, lot_number, title FROM lots WHERE id = $1',
      [req.params.lotId]
    );
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Lot not found' });
    if (check.rows[0].bid_count > 0) {
      return res.status(409).json({ success: false, message: 'Cannot remove a lot that has received bids' });
    }
    await db.query(
      `UPDATE lots SET is_withdrawn = true, state = 'withdrawn', updated_at = NOW() WHERE id = $1`,
      [req.params.lotId]
    );
    // INT-2: audit lot withdrawal. actor_role distinguishes seller self-
    // withdraw from admin removal — both are legitimate but the operational
    // signal is different.
    writeAuditLog({
      event_type:  'lot_withdrawn',
      entity_type: 'lot',
      entity_id:   req.params.lotId,
      auction_id:  check.rows[0].auction_id,
      lot_id:      req.params.lotId,
      actor_id:    req.user.id,
      metadata:    {
        lot_number: check.rows[0].lot_number,
        title:      check.rows[0].title,
        actor_role: req.user.role,
      },
    }).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/lots/:lotId
router.put('/:lotId', auth, async (req, res, next) => {
  try {
    if (!await userOwnsLot(req.user.id, req.user.role, req.params.lotId)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    // Edit-lock gate — refuse edit if parent auction is past 'draft' for
    // a private/other seller.
    const gate = await canMutateLot(req.user.id, req.user.role, req.params.lotId);
    if (!gate.allowed) {
      return res.status(403).json({ success: false, message: lockErrorMessage(gate.reason) });
    }
    const {
      title, description, category, size_category, pickup_category,
      bid_increment_cents, starting_bid_cents, reserve_cents, reserve_visible,
      condition, material, era, maker_artist, weight,
      dimensions, shippable, closes_at,
    } = req.body;
    // Phase C.2: professional-only settings gate (admin bypasses). Non-pro
    // sellers have starting_bid + reserve ignored. reserve_* use COALESCE below
    // so a non-pro edit (or a pro omitting them) preserves existing values
    // (never destroys an admin-set reserve); only a pro-supplied value writes.
    const proAllowed        = await proSettingsAllowedForLot(req.user.role, req.params.lotId);
    const effStartingBid    = proAllowed ? (starting_bid_cents || null) : null;
    const effReserveCents   = proAllowed ? (reserve_cents != null ? reserve_cents : null) : null;
    const effReserveVisible = proAllowed ? (typeof reserve_visible === 'boolean' ? reserve_visible : null) : null;
    // INT-2: snapshot the columns that this UPDATE writes so we can compute
    // a diff for the audit_log entry after the UPDATE succeeds. auction_id
    // is included so we can scope the audit entry to the parent auction
    // without a second query. Failure here is best-effort.
    let beforeLot = null;
    try {
      const beforeRes = await db.query(
        `SELECT auction_id, title, description, category, size_category,
                pickup_category, bid_increment_cents, starting_bid_cents,
                condition, material, era, maker_artist, weight, dimensions,
                shippable, closes_at
           FROM lots
          WHERE id = $1`,
        [req.params.lotId]
      );
      beforeLot = beforeRes.rows[0] || null;
    } catch (_) { /* audit snapshot is best-effort */ }
    const result = await db.query(
      `UPDATE lots
       SET title               = $1,
           description         = $2,
           category            = $3,
           size_category       = $4,
           pickup_category     = $5,
           bid_increment_cents = $6,
           starting_bid_cents  = $7,
           condition           = $8,
           material            = $9,
           era                 = $10,
           maker_artist        = $11,
           weight              = $12,
           dimensions          = COALESCE($13::jsonb, dimensions),
           shippable           = COALESCE($14, shippable),
           closes_at           = COALESCE($15::timestamptz, closes_at),
           reserve_cents       = COALESCE($16, reserve_cents),
           reserve_visible     = COALESCE($17, reserve_visible),
           updated_at          = NOW()
       WHERE id = $18
       RETURNING *`,
      [
        title,
        description     || null,
        category        || null,
        size_category   || null,
        pickup_category || null,
        bid_increment_cents  || null,
        effStartingBid,          // Phase C.2: null for non-professional sellers
        condition       || null,
        material        || null,
        era             || null,
        maker_artist    || null,
        weight          || null,
        // Validate dimensions against the same { text: "..." } shape POST
        // uses. Invalid input → null → COALESCE preserves the existing value.
        (function () {
          const v = validateDimensions(dimensions);
          return v ? JSON.stringify(v) : null;
        })(),
        shippable != null ? shippable : null,
        closes_at       || null,
        effReserveCents,         // Phase C.2: COALESCE preserves existing when null
        effReserveVisible,       // Phase C.2: COALESCE preserves existing when null
        req.params.lotId,
      ]
    );
    // INT-2: audit lot edit. Diff is scoped to fields the request actually
    // touched (req.body keys), so unchanged columns aren't logged as
    // "from X to X" noise.
    const after = result.rows[0];
    if (after) {
      try {
        const changed = {};
        const touched = ['title','description','category','size_category','pickup_category',
                         'bid_increment_cents','starting_bid_cents','condition','material',
                         'era','maker_artist','weight','dimensions','shippable','closes_at'];
        for (const k of touched) {
          if (req.body[k] === undefined) continue;
          const fromVal = beforeLot ? beforeLot[k] : null;
          const toVal   = after[k];
          if (JSON.stringify(fromVal) !== JSON.stringify(toVal)) {
            changed[k] = { from: fromVal, to: toVal };
          }
        }
        writeAuditLog({
          event_type:  'lot_updated',
          entity_type: 'lot',
          entity_id:   req.params.lotId,
          auction_id:  after.auction_id,
          lot_id:      req.params.lotId,
          actor_id:    req.user.id,
          metadata:    { lot_number: after.lot_number, changed_fields: changed, actor_role: req.user.role },
        }).catch(() => {});
      } catch (_) { /* audit is non-blocking */ }
    }
    res.json({ success: true, data: after });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId/winner-status
// Auth required. Returns whether the requesting user won this lot and the winning amount.
// Never exposes winning_buyer_user_id to the client — identity check is server-side only.
router.get('/:lotId/winner-status', authMiddleware, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT state, winning_buyer_user_id, winning_amount_cents FROM lots WHERE id = $1`,
      [req.params.lotId]
    );
    const lot = result.rows[0];
    if (!lot) return res.status(404).json({ success: false, message: 'Lot not found' });
    const isWinner = lot.state === 'closed' && lot.winning_buyer_user_id === req.user.id;
    res.json({ success: true, data: { is_winner: isWinner, winning_amount_cents: lot.winning_amount_cents } });
  } catch (err) {
    next(err);
  }
});

// GET /api/lots/:lotId
// Withdrawn lots return 404 — this endpoint is buyer-facing and public.
// winning_buyer_user_id and current_winner_user_id are selected ONLY to derive
// viewer_is_high_bidder (annotateViewerBidState), then STRIPPED before the response;
// winning_amount_cents is the final hammer price (public) and is kept for display.
router.get('/:lotId', optionalAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, auction_id, lot_number, title, description,
              category, size_category, pickup_category,
              condition, material, era, maker_artist, weight, dimensions,
              shippable, shipping_cost_cents, shipping_notes,
              starting_bid_cents, bid_increment_cents, current_bid_cents, bid_count,
              winning_amount_cents, current_winner_user_id, winning_buyer_user_id,
              state, is_withdrawn, is_featured,
              closes_at, extended_until, extension_count,
              thumbnail_url, images_count,
              created_at, updated_at
       FROM lots
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.id = lots.auction_id AND a.is_archived IS TRUE)`,
      [req.params.lotId]
    );
    const lot = result.rows[0] || null;
    if (!lot || lot.state === 'withdrawn') {
      return res.status(404).json({ success: false, message: 'Lot not found' });
    }

    // Server-authoritative bid math (#16): the lot page's "Next minimum bid"
    // must agree EXACTLY with bidService's validation. Both derive the increment
    // from resolveBidIncrement (lot → auction → house default $5) and apply the
    // same floor: minimum next bid = max(starting_bid, current_bid + increment).
    // We expose the resolved values so the client never computes a divergent
    // number. This does not change validation behavior — it only surfaces it.
    try {
      const override = await resolveIncrementOverride(db, lot);
      const starting = lot.starting_bid_cents || 100;
      const current  = lot.current_bid_cents  || 0;
      lot.effective_bid_increment_cents = effectiveIncrement(current, override);
      lot.next_min_bid_cents = nextMinBidCents(starting, current, override);
    } catch (e) {
      // Non-fatal: fall back so the page still renders. Logged, not surfaced.
      console.error('[lots] increment resolve failed for', lot.id, e.message);
      const override = lot.bid_increment_cents != null ? lot.bid_increment_cents : null;
      lot.effective_bid_increment_cents = effectiveIncrement(lot.current_bid_cents || 0, override);
      lot.next_min_bid_cents = nextMinBidCents(lot.starting_bid_cents || 100, lot.current_bid_cents || 0, override);
    }

    let viewerMaxCents = null;
    if (req.user) {
      try {
        const pm = await db.query(
          `SELECT max_amount_cents FROM lot_proxy_bids WHERE lot_id = $1 AND bidder_user_id = $2`,
          [lot.id, req.user.id]
        );
        viewerMaxCents = pm.rows[0] ? pm.rows[0].max_amount_cents : null;
      } catch (e) { console.error('[lots] viewer proxy-max fetch failed', e.message); }
    }
    res.json({ success: true, data: redactRealizedPrice(annotateViewerBidState(lot, req.user && req.user.id, viewerMaxCents), !!req.user) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.canMutateAuction  = canMutateAuction;
module.exports.canMutateLot      = canMutateLot;
module.exports.canDeleteAuction  = canDeleteAuction;
module.exports.lockErrorMessage  = lockErrorMessage;
