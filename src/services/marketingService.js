const db = require('../db');
const { triggerMarketingWorkflow } = require('./marketingWorkflow');
const marketingEligibilityService = require('./marketingEligibilityService');

// MarketingService skeleton
class MarketingService {
  async selectCampaignForAuction(auctionId, campaignId) {
    // TODO: Fetch campaign details, store marketing_selection JSON with tier, fee, deliverables_snapshot on auction
    throw new Error('Not implemented');
  }

  async updateDeliveryStatus(auctionId, status) {
    // TODO: Update marketing_selection.delivery_status to 'not_started'|'in_progress'|'delivered'
    throw new Error('Not implemented');
  }

  async getMarketingJobForAuction(auctionId) {
    const result = await db.query(
      `SELECT id, package_type, status, created_at
       FROM marketing_jobs
       WHERE auction_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [auctionId]
    );
    return result.rows[0] || null;
  }

  async createMarketingJob(callerUserId, auctionId, { package_type, budget, target_radius_miles }, isAdmin = false) {
    if (!package_type) {
      throw new Error('package_type is required');
    }

    // Admins can create jobs for any auction and record the auction's actual seller.
    // Sellers may only create jobs for auctions they own.
    let sellerUserId;
    if (isAdmin) {
      // Canonical ownership: auctions.seller_id → seller_profiles.user_id.
      const auctionRes = await db.query(
        `SELECT sp.user_id AS seller_user_id
           FROM auctions a
           JOIN seller_profiles sp ON sp.id = a.seller_id
          WHERE a.id = $1`,
        [auctionId]
      );
      if (!auctionRes.rows[0]) throw new Error('Auction not found');
      sellerUserId = auctionRes.rows[0].seller_user_id;
    } else {
      // Canonical ownership check: caller must be the seller via seller_id chain.
      const auctionRes = await db.query(
        `SELECT a.id
           FROM auctions a
           JOIN seller_profiles sp ON sp.id = a.seller_id
          WHERE a.id = $1 AND sp.user_id = $2`,
        [auctionId, callerUserId]
      );
      if (!auctionRes.rows[0]) throw new Error('Auction not found or not owned by seller');
      sellerUserId = callerUserId;
    }

    // Server-authoritative eligibility gate (cannot be bypassed by a stale UI): the 48-hour cutoff + the
    // clothing/apparel >50% rule, evaluated from the CURRENT catalog. Enforced for sellers; admins retain
    // override authority. The eligibility snapshot is recorded on the job for auditability (not billing).
    const eligibility = await marketingEligibilityService.evaluateAuction(auctionId);
    if (!isAdmin && !eligibility.available) {
      const e = new Error(
        eligibility.reason === 'too_much_clothing'
          ? "Marketing packages aren't available for auctions where more than half of the catalog is clothing/apparel."
          : eligibility.reason === 'past_cutoff'
            ? 'Marketing packages are available until 48 hours before the auction closes.'
            : 'Marketing packages are not available for this auction right now.');
      e.code = 'MARKETING_UNAVAILABLE';
      throw e;
    }
    const snap = eligibility.snapshot || {};

    // Resolve the confirmed package price (Concept A — seller charge) from the authoritative packages
    // table so we can freeze the INTERNAL allocation snapshot (Concept B). Look up by id or name.
    const pkgRes = await db.query(
      `SELECT id, price_cents FROM marketing_packages
        WHERE is_active = true AND (id::text = $1 OR name = $1) ORDER BY display_order LIMIT 1`,
      [String(package_type)]);
    const pkg = pkgRes.rows[0] || null;

    const result = await db.query(
      `INSERT INTO marketing_jobs (auction_id, seller_user_id, package_type, budget, target_radius_miles, package_id,
         elig_total_lots, elig_clothing_lots, elig_clothing_pct_bps, elig_rule_version, elig_evaluated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING *`,
      [auctionId, sellerUserId, package_type, budget ?? null, target_radius_miles ?? 30, pkg ? pkg.id : null,
       snap.total_valid_lots ?? null, snap.clothing_lots ?? null, snap.clothing_pct_bps ?? null, snap.rule_version ?? null]
    );

    const job = result.rows[0];

    // Freeze the internal marketing allocation snapshot at package confirmation (direct_max + growth base).
    // This is Advantage.Bid's INTERNAL accounting only — it never charges the seller and never creates a
    // seller-facing balance. (The seller-facing package CHARGE / collection is a separate, owner-gated
    // decision — see VS-AUDIT-1 — and is intentionally NOT performed here.) Best-effort + idempotent.
    if (pkg && pkg.price_cents != null) {
      try {
        const marketingLedger = require('./marketingLedgerService');
        await marketingLedger.freezeAllocation({ marketingJobId: job.id, auctionId, packagePriceCents: pkg.price_cents });
      } catch (e) { console.error('[marketing] allocation freeze failed (non-fatal):', e.message); }
    }

    triggerMarketingWorkflow(job);
    return job;
  }
}

module.exports = new MarketingService();
