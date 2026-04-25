const db = require('../db');
const { generateAuctionReport } = require('./reportingService');
const { getSellerPayoutPreference } = require('./payoutPreferenceService');

async function createSellerPayoutRecord(auctionId) {
  // Skip if a record already exists for this auction (idempotent)
  const existing = await db.query(
    'SELECT id FROM seller_payouts WHERE auction_id = $1',
    [auctionId]
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  // Resolve seller_user_id from the auction
  const auctionRes = await db.query(
    'SELECT created_by_user_id FROM auctions WHERE id = $1',
    [auctionId]
  );
  if (!auctionRes.rows[0]) {
    throw new Error('Auction not found');
  }
  const sellerUserId = auctionRes.rows[0].created_by_user_id;

  // Pull payout figures and preference in parallel
  const [report, pref] = await Promise.all([
    generateAuctionReport(auctionId),
    getSellerPayoutPreference(sellerUserId)
  ]);

  if (pref) {
    console.log(`[payout] payout preference found for seller_user_id=${sellerUserId}: ${pref.payout_method}`);
  } else {
    console.log(`[payout] no payout preference found for seller_user_id=${sellerUserId}`);
  }

  const result = await db.query(
    `INSERT INTO seller_payouts
       (auction_id, seller_user_id, gross_revenue_cents, platform_fee_cents, seller_payout_cents, payout_method)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (auction_id) DO NOTHING
     RETURNING *`,
    [
      auctionId,
      sellerUserId,
      report.gross_revenue_cents,
      report.platform_fee_cents,
      report.seller_payout_cents,
      pref ? pref.payout_method : null
    ]
  );

  // ON CONFLICT DO NOTHING returns no row if a concurrent insert won the race
  return result.rows[0] || existing.rows[0];
}

module.exports = { createSellerPayoutRecord };
