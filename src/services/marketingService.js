const db = require('../db');
const { triggerMarketingWorkflow } = require('./marketingWorkflow');

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

    const result = await db.query(
      `INSERT INTO marketing_jobs (auction_id, seller_user_id, package_type, budget, target_radius_miles)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [auctionId, sellerUserId, package_type, budget ?? null, target_radius_miles ?? 30]
    );

    const job = result.rows[0];
    triggerMarketingWorkflow(job);
    return job;
  }
}

module.exports = new MarketingService();
