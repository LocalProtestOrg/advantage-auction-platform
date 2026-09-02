const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const requireSellerAgreement = require('../middleware/requireSellerAgreement');
const db = require('../db');
const { brandedColSql, isProfessional } = require('../lib/sellerBranding');
const agreementService = require('../services/agreementService');
const organizationsService = require('../services/organizationsService');
const verificationService = require('../services/verificationService');
const professionalSellerEmails = require('../services/professionalSellerEmails');
const { sendEmail } = require('../services/emailService');
const { PROFESSIONAL_SELLER_TYPES, SELLER_TYPE_LABELS } = require('../constants/sellerTypes');
const widgetService = require('../services/widgetService');

// Self-service seller enablement (the individual /enroll path) is restricted to non-professional
// seller types. Professional types (auction_house, estate_sale_company, professional_liquidator) are
// enrolled through the SEPARATE /apply-professional path below, which sets the professional type but
// keeps publication gated behind admin business verification (never self-claimed as trusted).
const SELF_SERVE_SELLER_TYPES = ['private', 'business', 'other'];

// GET /api/sellers/me
// Returns the seller profile for the authenticated user. seller_type is
// included so the lot studio frontend can client-side gate fields that are
// only appropriate for business sellers (e.g., reserve pricing). This is a
// stopgap until full capability-based gating lands; private/other sellers
// must not see fields they cannot actually use.
router.get('/me', auth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, user_id, seller_type, show_branding_to_buyers FROM seller_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    const row = result.rows[0];
    // Whether the "Display company branding to buyers" preference is eligible for this seller.
    // Only professional/business types can ever brand to buyers; private/other/unknown never can.
    row.branding_eligible = isProfessional(row.seller_type);
    return res.json({ success: true, data: row });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/sellers/me/branding — professional sellers set the "Display company branding to buyers"
// preference. Server-authoritative: private/other/unknown types can never enable branding (403), so
// the preference can never expose an anonymous seller's identity.
router.patch('/me/branding', auth, async (req, res, next) => {
  try {
    const sp = (await db.query('SELECT id, seller_type FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    if (!sp) return res.status(404).json({ success: false, message: 'Seller profile not found' });
    if (!isProfessional(sp.seller_type)) {
      return res.status(403).json({ success: false, code: 'BRANDING_NOT_ELIGIBLE',
        message: 'Company branding is available only to professional seller accounts. Private sellers always remain anonymous to buyers.' });
    }
    const enabled = req.body && req.body.show_branding_to_buyers === true;
    const upd = await db.query(
      'UPDATE seller_profiles SET show_branding_to_buyers = $2, updated_at = now() WHERE id = $1 RETURNING id, seller_type, show_branding_to_buyers',
      [sp.id, enabled]
    );
    return res.json({ success: true, data: upd.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/sellers/enroll
// Self-service buyer → seller enablement. The simplest possible flow:
//   Buyer account → complete seller profile → (sign agreement next) → dashboard.
// There is NO application, NO approval queue, NO waiting period, and NO identity
// verification here. Identity verification is an admin-only capability triggered
// later for risk indicators — never a gate on onboarding.
//
// This endpoint:
//   1. Creates the seller_profile for the authenticated user (idempotent — a
//      user who already has one just gets their current status back).
//   2. Promotes the user's role buyer → seller so the seller dashboard tooling
//      (lot studio AI, marketing, payout prefs) works. Buyers retain purchasing
//      ability (charge-lot now allows 'seller').
//   3. Auto-sends the current seller agreement so the very next step is signing.
//   4. Returns a fresh JWT carrying role='seller' so the client can use seller
//      features immediately without forcing a re-login.
// The seller DASHBOARD remains gated by requireSellerAgreement until the agreement
// is signed — so "enabled immediately" means immediately after acceptance.
router.post('/enroll', auth, async (req, res, next) => {
  const client = await db.connect();
  try {
    // The JWT is valid, but confirm the user still exists. A stale token for a removed
    // account would otherwise fail deeper (FK violation) as a confusing generic 500.
    const userRow = (await client.query('SELECT id, role FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!userRow) {
      return res.status(401).json({ success: false, message: 'Your session is no longer valid. Please sign in again.' });
    }

    const body = req.body || {};
    const displayName = (body.display_name || body.legal_name || body.full_name || '').toString().trim() || null;
    const phone       = (body.phone || '').toString().trim() || null;
    let sellerType    = (body.seller_type || 'private').toString().trim().toLowerCase();
    if (!SELF_SERVE_SELLER_TYPES.includes(sellerType)) sellerType = 'private';

    // The seller_profile create + role promotion happen atomically: either the seller
    // is fully enabled, or nothing is written (no partial/duplicate records).
    await client.query('BEGIN');

    // Idempotent: reuse an existing profile; never create a duplicate.
    const existing = (await client.query('SELECT id FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];

    // Phone is required + must be valid for NEW enrollments (idempotent re-enroll skips this).
    if (!existing) {
      if (!phone) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'A phone number is required to enable selling.' });
      }
      if (phone.replace(/\D/g, '').length < 10) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Please enter a valid phone number.' });
      }
    }

    let sellerProfileId;
    if (existing) {
      sellerProfileId = existing.id;
    } else {
      sellerProfileId = (await client.query(
        `INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, sellerType, displayName]
      )).rows[0].id;
    }

    // Promote buyer → seller (admins keep their role). Backfill contact fields only
    // when currently empty — never overwrite existing account information.
    await client.query(
      `UPDATE users
          SET role = CASE WHEN role = 'buyer' THEN 'seller' ELSE role END,
              full_name = COALESCE(full_name, $2),
              phone     = COALESCE(phone, $3)
        WHERE id = $1`,
      [req.user.id, displayName, phone]
    );
    const newRole = (await client.query('SELECT role FROM users WHERE id = $1', [req.user.id])).rows[0].role;
    await client.query('COMMIT');

    // Post-commit side effects are best-effort: the seller is already enabled, so a
    // hiccup here must not surface as a failure. Always return a fresh seller JWT.
    const token = jwt.sign({ id: req.user.id, role: newRole }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
    let onboarding = null;
    try {
      await agreementService.autoSendAgreement(sellerProfileId, req.user.id);
      onboarding = await agreementService.getOnboardingStatus(req.user.id);
    } catch (_) { /* enablement already committed; agreement send / status is best-effort */ }

    return res.status(existing ? 200 : 201).json({
      success: true,
      token,
      data: { seller_profile_id: sellerProfileId, role: newRole, onboarding },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/sellers/apply-professional
// Self-service PROFESSIONAL Seller enrollment. Unlike /enroll (individual), this accepts a professional
// seller_type (auction_house | estate_sale_company | professional_liquidator) and sets it on the profile,
// BUT it never grants trust: it immediately engages the SAME publication gate used everywhere
// (verification_required_before_publication) so the first sale cannot go live until Advantage.Bid verifies
// the business. It also creates/links the seller's own Railway organization (never claims another company's
// imported directory shell by name — that is the separate claim flow). Dashboard access still requires the
// signed agreement; payouts still require Stripe Connect. Fully idempotent + resumable.
router.post('/apply-professional', auth, async (req, res, next) => {
  const client = await db.connect();
  try {
    const userRow = (await client.query('SELECT id, role, email, full_name, phone FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (!userRow) {
      return res.status(401).json({ success: false, message: 'Your session is no longer valid. Please sign in again.' });
    }

    const body = req.body || {};
    const sellerType = (body.seller_type || '').toString().trim().toLowerCase();
    // Server-authoritative: only real professional types are accepted here. Anything else is rejected
    // (never silently downgraded) so the caller knows the professional path needs a valid type.
    if (!PROFESSIONAL_SELLER_TYPES.includes(sellerType)) {
      return res.status(400).json({ success: false, code: 'INVALID_PROFESSIONAL_TYPE',
        message: 'Please choose a valid professional seller type (auction house, estate sale company, or professional liquidator).' });
    }
    const companyName = (body.company_name || body.display_name || '').toString().trim();
    const legalName   = (body.legal_name || body.full_name || '').toString().trim() || null;
    const phone       = (body.phone || '').toString().trim() || null;
    const state       = (body.state || '').toString().trim().toUpperCase().slice(0, 8) || null;
    if (!companyName) {
      return res.status(400).json({ success: false, code: 'COMPANY_REQUIRED', message: 'A company or business name is required.' });
    }

    await client.query('BEGIN');
    const existing = (await client.query('SELECT id FROM seller_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    if (!existing) {
      if (!phone) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'A phone number is required to enroll.' }); }
      if (phone.replace(/\D/g, '').length < 10) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Please enter a valid phone number.' }); }
    }

    let sellerProfileId;
    if (existing) {
      sellerProfileId = existing.id;
      // Upgrade an existing (e.g. individual) profile to the professional type; fill display_name if empty.
      await client.query(
        `UPDATE seller_profiles SET seller_type = $2,
                display_name = COALESCE(NULLIF(display_name, ''), $3), updated_at = now()
          WHERE id = $1`, [sellerProfileId, sellerType, companyName]);
    } else {
      sellerProfileId = (await client.query(
        `INSERT INTO seller_profiles (user_id, seller_type, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, sellerType, companyName])).rows[0].id;
    }

    // SAFETY GATE (non-negotiable): a professional's first sale cannot publish until an admin verifies the
    // business. Selecting "Auction House" on a form therefore grants NO privileged publish capability.
    await verificationService.requireVerificationForProfessional(sellerProfileId, sellerType, req.user.id, client);

    // Promote buyer → seller (admins keep their role); backfill contact fields only when empty.
    await client.query(
      `UPDATE users SET role = CASE WHEN role = 'buyer' THEN 'seller' ELSE role END,
              full_name = COALESCE(full_name, $2), phone = COALESCE(phone, $3) WHERE id = $1`,
      [req.user.id, legalName, phone]);
    const newRole = (await client.query('SELECT role FROM users WHERE id = $1', [req.user.id])).rows[0].role;
    await client.query('COMMIT');

    // Post-commit side effects are best-effort (enrollment already committed).
    const token = jwt.sign({ id: req.user.id, role: newRole }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '24h' });
    let organizationId = null, organizationLinked = false;
    try {
      // One org per user: reuse the seller's existing org, else create THEIR OWN org (source 'onboarding').
      // We deliberately do NOT match/claim an imported BD directory shell by name — that would let someone
      // take over a business just by typing its name. Associating an imported listing is the separate,
      // ownership-verified claim flow.
      let org = await organizationsService.getPrimaryOrgForUser(req.user.id);
      if (!org) {
        org = await organizationsService.onboardOrganization(req.user.id, {
          name: companyName, type: sellerType, contactEmail: userRow.email || undefined,
          contactPhone: phone || undefined, state: state || undefined,
        });
      }
      if (org) {
        organizationId = org.id;
        // Link org ↔ seller_profile, honoring the one-org-per-seller_profile unique index.
        const linkRes = await db.query(
          `UPDATE organizations SET linked_seller_profile_id = $2, linked_seller_at = COALESCE(linked_seller_at, now())
            WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM organizations WHERE linked_seller_profile_id = $2 AND id <> $1)
            RETURNING id`, [org.id, sellerProfileId]);
        organizationLinked = linkRes.rowCount > 0;
      }
    } catch (e) { console.error('[apply-professional] org link best-effort failed:', e.message); }

    let onboarding = null;
    try {
      await agreementService.autoSendAgreement(sellerProfileId, req.user.id);
      onboarding = await agreementService.getOnboardingStatus(req.user.id);
    } catch (_) { /* best-effort */ }

    try {
      if (userRow.email) {
        const m = professionalSellerEmails.buildApplicationEmail({ companyName, sellerTypeLabel: SELLER_TYPE_LABELS[sellerType] });
        await sendEmail({ to: userRow.email, ...m });
      }
    } catch (e) { console.error('[apply-professional] welcome email best-effort failed:', e.message); }

    return res.status(existing ? 200 : 201).json({
      success: true,
      token,
      data: {
        seller_profile_id: sellerProfileId,
        seller_type: sellerType,
        role: newRole,
        verification_required: true,           // publication gated until admin business verification
        organization_id: organizationId,
        organization_linked: organizationLinked,
        onboarding,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ── Professional Seller white-label Website Auction Widget ─────────────────────
// GET /api/sellers/me/widget — the caller's OWN widget config (tenant-scoped: the org is derived from
// req.user's owned membership, NEVER a client-supplied id). Eligible = a Professional Seller whose org is
// linked to their own professional seller_profile. Returns the opaque public key + copyable embed code +
// preview URL. Returns eligible:false (not an error) when the caller isn't a professional seller yet.
router.get('/me/widget', auth, async (req, res, next) => {
  try {
    const elig = await widgetService.eligibilityForUser(req.user.id);
    if (!elig.eligible) return res.json({ success: true, eligible: false, reason: elig.reason });
    const key = await widgetService.ensureWidgetKey(elig.org.id);
    const a = await widgetService.listPublicAuctions(elig.sellerProfileId);
    const base = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
    return res.json({
      success: true, eligible: true, key, company_name: elig.org.name,
      embed_code: widgetService.buildEmbedCode(key, base),
      preview_url: base + '/embed/auctions.html?key=' + encodeURIComponent(key),
      auction_count: a.current.length + a.upcoming.length,
    });
  } catch (err) { next(err); }
});

// POST /api/sellers/me/widget/rotate — rotate the key (revokes the old embed). Owner-scoped like GET.
router.post('/me/widget/rotate', auth, async (req, res, next) => {
  try {
    const elig = await widgetService.eligibilityForUser(req.user.id);
    if (!elig.eligible) return res.status(403).json({ success: false, code: 'WIDGET_NOT_ELIGIBLE', message: 'A Professional Seller account is required to manage the website widget.' });
    const key = await widgetService.rotateWidgetKey(elig.org.id);
    const base = (process.env.APP_BASE_URL || 'https://bid.advantage.bid').replace(/\/+$/, '');
    return res.json({ success: true, key, embed_code: widgetService.buildEmbedCode(key, base), preview_url: base + '/embed/auctions.html?key=' + encodeURIComponent(key) });
  } catch (err) { next(err); }
});

// GET /api/sellers/me/dashboard
// Returns all auctions for the authenticated seller with aggregated marketing metrics.
// Gated: a seller must hold dashboard access (signed agreement / waived / grandfathered).
router.get('/me/dashboard', auth, requireSellerAgreement, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         a.id,
         a.title,
         a.state,
         a.end_time,
         a.created_at,
         a.revision_note,
         a.revision_count,
         a.rejection_reason,
         a.rejected_at,
         mj.package_type,
         mj.status           AS marketing_status,
         COALESCE(mj.views_count,        0) AS views_count,
         COALESCE(mj.clicks_count,       0) AS clicks_count,
         COALESCE(mj.reach_count,        0) AS reach_count,
         COALESCE(mj.watchlist_adds,     0) AS watchlist_adds,
         COALESCE(mj.bidder_conversions, 0) AS bidder_conversions
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
       LEFT JOIN LATERAL (
         SELECT package_type, status, views_count, clicks_count,
                reach_count, watchlist_adds, bidder_conversions
         FROM marketing_jobs
         WHERE auction_id = a.id
         ORDER BY created_at DESC
         LIMIT 1
       ) mj ON true
       WHERE sp.user_id = $1
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );

    const summary = {
      active_count:           rows.filter(r => r.state === 'published').length,
      closed_count:           rows.filter(r => r.state === 'closed').length,
      total_views:            rows.reduce((s, r) => s + Number(r.views_count), 0),
      total_clicks:           rows.reduce((s, r) => s + Number(r.clicks_count), 0),
      total_watchlist_adds:   rows.reduce((s, r) => s + Number(r.watchlist_adds), 0),
      total_bidder_conversions: rows.reduce((s, r) => s + Number(r.bidder_conversions), 0),
    };

    return res.json({ success: true, data: { summary, auctions: rows } });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/me/audience
// Returns lightweight audience summary for the authenticated seller.
// Combines follower metrics and active-lot watcher counts in three parallel queries.
router.get('/me/audience', auth, async (req, res, next) => {
  try {
    const spRes = await db.query(
      'SELECT id FROM seller_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!spRes.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller profile not found' });
    }
    const sellerId = spRes.rows[0].id;

    const [follRes, watchRes, lotsRes] = await Promise.all([
      // Followers total + 7-day growth in one pass
      db.query(
        `SELECT COUNT(*)::int AS followers_total,
                COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END)::int AS followers_7d
           FROM seller_followers
          WHERE seller_id = $1`,
        [sellerId]
      ),
      // Unique buyers watching any open lot across the seller's live auctions
      db.query(
        `SELECT COUNT(DISTINCT w.user_id)::int AS count
           FROM watchlists w
           JOIN lots l    ON l.id    = w.lot_id
           JOIN auctions a ON a.id   = l.auction_id
          WHERE a.seller_id = $1
            AND l.state      = 'open'
            AND a.state      IN ('published', 'active')`,
        [sellerId]
      ),
      // Open lots in live auctions
      db.query(
        `SELECT COUNT(*)::int AS count
           FROM lots l
           JOIN auctions a ON a.id = l.auction_id
          WHERE a.seller_id = $1
            AND l.state      = 'open'
            AND a.state      IN ('published', 'active')`,
        [sellerId]
      ),
    ]);

    return res.json({
      success: true,
      data: {
        followers_total:  follRes.rows[0].followers_total,
        followers_7d:     follRes.rows[0].followers_7d,
        active_watchers:  watchRes.rows[0].count,
        active_lot_count: lotsRes.rows[0].count,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Seller Followers ──────────────────────────────────────────────────────────
// GET /api/sellers/following — list sellers the authenticated buyer follows.
// Must be declared before /:sellerId routes to avoid "following" matching as a param.
router.get('/following', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      // Buyer-facing: NEVER expose personal seller contact (no email/phone). Seller name is shown only
      // for a professional seller with branding enabled (buyer-privacy policy); otherwise NULL and the
      // buyer UI falls back to a generic label. Private/other/unknown are always anonymous.
      `SELECT sf.seller_id,
              sf.created_at AS followed_at,
              ${brandedColSql('sp.display_name')} AS seller_display_name,
              sp.seller_type,
              COUNT(a.id)::int AS active_auction_count
         FROM seller_followers sf
         JOIN seller_profiles sp ON sp.id = sf.seller_id
         LEFT JOIN auctions a     ON a.seller_id = sp.id
                                 AND a.state IN ('published', 'active')
        WHERE sf.user_id = $1
        GROUP BY sf.seller_id, sf.created_at, sp.display_name, sp.seller_type, sp.show_branding_to_buyers
        ORDER BY sf.created_at DESC`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/:sellerId/followers/count — public; follower count for a seller.
router.get('/:sellerId/followers/count', async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count FROM seller_followers WHERE seller_id = $1`,
      [sellerId]
    );
    return res.json({ success: true, data: { seller_id: sellerId, count: rows[0].count } });
  } catch (err) {
    next(err);
  }
});

// POST /api/sellers/:sellerId/follow — buyer follows a seller. Idempotent.
router.post('/:sellerId/follow', auth, async (req, res, next) => {
  try {
    const { sellerId } = req.params;

    // Verify the seller profile exists before inserting.
    const check = await db.query(
      'SELECT id FROM seller_profiles WHERE id = $1',
      [sellerId]
    );
    if (!check.rows[0]) {
      return res.status(404).json({ success: false, message: 'Seller not found' });
    }

    await db.query(
      `INSERT INTO seller_followers (user_id, seller_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, seller_id) DO NOTHING`,
      [req.user.id, sellerId]
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sellers/:sellerId/follow — buyer unfollows a seller. Idempotent.
router.delete('/:sellerId/follow', auth, async (req, res, next) => {
  try {
    const { sellerId } = req.params;
    await db.query(
      `DELETE FROM seller_followers WHERE user_id = $1 AND seller_id = $2`,
      [req.user.id, sellerId]
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/me/walkthrough-videos
// OPS-5: returns the walkthrough videos for every auction this seller owns,
// surfacing review_status + rejection_reason so the seller dashboard can show
// review progress. Videos default to pending_review on upload (per migration
// 038), require admin approval, and visibility flags are off by default until
// admin sets them. This endpoint is the seller's window into that workflow.
router.get('/me/walkthrough-videos', auth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT v.id, v.auction_id, v.title, v.caption, v.review_status,
              v.approved_at, v.rejection_reason,
              v.visible_public, v.featured_for_marketing,
              v.created_at, v.updated_at,
              a.title AS auction_title, a.state AS auction_state
         FROM auction_walkthrough_videos v
         JOIN auctions a ON a.id = v.auction_id
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE sp.user_id = $1
        ORDER BY v.created_at DESC`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/sellers/me/audit?auction_id=&limit=&offset=
// AUD-EXP: seller-visible audit history for a single auction the seller
// owns. Filters by a strict allow-list of event types — sellers must see
// the major lifecycle and moderation events that affect them, but must
// NOT see internal admin telemetry (capability changes, suspensions,
// other sellers' events, raw mutation diffs that may include data the
// seller has no claim to inspect).
//
// Allow-listed event types:
//   auction_submitted         — seller submitted the auction
//   auction_returned_to_draft — admin sent it back with revisions
//   auction_rejected          — admin terminally rejected
//   auction.published         — auction went live
//   auction.closed            — auction closed
//   lot_auto_closed           — individual lot finalized at closes_at
// Everything else is filtered out server-side.
//
// Ownership is enforced by joining audit_log → auctions → seller_profiles
// → users in a single query; an auction_id query param that the seller
// does not own returns an empty list (never a 403, to avoid disclosing
// the existence of someone else's auction id).
router.get('/me/audit', auth, async (req, res, next) => {
  try {
    const auctionId = req.query.auction_id ? String(req.query.auction_id) : null;
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const allowedEvents = [
      'auction_submitted',
      'auction_returned_to_draft',
      'auction_rejected',
      'auction.published',
      'auction.closed',
      'lot_auto_closed',
    ];

    const params = [req.user.id, allowedEvents];
    let extraWhere = '';
    if (auctionId) {
      params.push(auctionId);
      extraWhere = ` AND al.auction_id = $${params.length}`;
    }
    params.push(limit, offset);

    const { rows } = await db.query(
      `SELECT al.id, al.event_type, al.entity_type, al.entity_id,
              al.auction_id, al.lot_id, al.metadata, al.created_at,
              CASE WHEN al.actor_id = $1 THEN 'you'
                   WHEN al.actor_id IS NULL THEN 'system'
                   ELSE 'advantage'
              END AS actor_label
         FROM audit_log al
         JOIN auctions a        ON a.id  = al.auction_id
         JOIN seller_profiles sp ON sp.id = a.seller_id
        WHERE sp.user_id      = $1
          AND al.event_type = ANY($2::text[])
          ${extraWhere}
        ORDER BY al.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({ success: true, data: rows, count: rows.length, limit, offset });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
