const db = require('../db');

// TODO: Facebook Ads integration — replace stub metrics with Facebook Campaign Insights API calls
// TODO: AI-generated ad creatives — pull creative_snapshot from marketing_jobs and return to caller
// TODO: Automated geographic targeting — compute effective radius from package + auction zip
// TODO: Seller dashboard widgets — expose an aggregated summary method for multi-auction views

class MarketingReportService {
  async createMarketingJob({ auctionId, sellerUserId, packageType, budget, targetRadiusMiles }) {
    const { rows } = await db.query(
      `INSERT INTO marketing_jobs
         (auction_id, seller_user_id, package_type, budget, target_radius_miles)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [auctionId, sellerUserId, packageType, budget ?? null, targetRadiusMiles ?? 30]
    );
    return rows[0];
  }

  async getMarketingJobByAuctionId(auctionId) {
    const { rows } = await db.query(
      `SELECT id,
              package_type,
              status,
              budget,
              target_radius_miles,
              views_count,
              clicks_count,
              reach_count,
              watchlist_adds,
              bidder_conversions,
              top_lot_count,
              campaign_started_at,
              campaign_ended_at,
              created_at,
              updated_at
         FROM marketing_jobs
        WHERE auction_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [auctionId]
    );
    return rows[0] || null;
  }

  async updateMarketingMetrics(jobId, metrics) {
    const allowed = [
      'views_count',
      'clicks_count',
      'reach_count',
      'watchlist_adds',
      'bidder_conversions',
      'top_lot_count',
      'campaign_started_at',
      'campaign_ended_at',
      'status',
    ];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(metrics)) {
      if (allowed.includes(key)) {
        setClauses.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push(`updated_at = now()`);
    values.push(jobId);

    const { rows } = await db.query(
      `UPDATE marketing_jobs
          SET ${setClauses.join(', ')}
        WHERE id = $${idx}
       RETURNING *`,
      values
    );
    return rows[0] || null;
  }
}

module.exports = new MarketingReportService();
