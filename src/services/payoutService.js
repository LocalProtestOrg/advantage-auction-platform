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
  // Canonical ownership chain: auctions.seller_id → seller_profiles.user_id.
  const auctionRes = await db.query(
    `SELECT sp.user_id AS seller_user_id
       FROM auctions a
       JOIN seller_profiles sp ON sp.id = a.seller_id
      WHERE a.id = $1`,
    [auctionId]
  );
  if (!auctionRes.rows[0]) {
    throw new Error('Auction not found');
  }
  const sellerUserId = auctionRes.rows[0].seller_user_id;

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
       (auction_id, seller_user_id, gross_revenue_cents, platform_fee_cents,
        processing_fee_bps, processing_fee_cents, seller_payout_cents, payout_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (auction_id) DO NOTHING
     RETURNING *`,
    [
      auctionId,
      sellerUserId,
      // generateAuctionReport nests these figures under report.summary. Processing is kept SEPARATE
      // from the platform fee (0 for legacy auctions; 3% snapshot for v2).
      report.summary.gross_revenue_cents,
      report.summary.platform_fee_cents,
      report.summary.processing_fee_bps || 0,
      report.summary.processing_fee_cents || 0,
      report.summary.seller_payout_cents,
      pref ? pref.payout_method : null
    ]
  );

  // ON CONFLICT DO NOTHING returns no row if a concurrent insert won the race
  const payout = result.rows[0] || existing.rows[0];

  // Owner operational SMS (ADMIN ACTION REQUIRED): a seller settlement/payout has been created and is now
  // 'pending_review' — waiting for an admin to review + release (manual settlement is intentional). Fire
  // ONLY when we actually created the row this call (result.rows[0]) so it's exactly once per payout. Best-
  // effort; never blocks payout creation. (This path is dormant until SELLER_SETTLEMENTS_ENABLED wires
  // payout creation into auction close; the authoritative hook is in place for when it goes live.)
  if (result.rows[0]) {
    (async () => {
      try {
        const oa = require('./ownerAlertService');
        const em = (await db.query('SELECT email FROM users WHERE id = $1', [sellerUserId])).rows[0];
        await oa.notifyAdminActionRequired({
          actionType: oa.ALERT_TYPES.PAYOUT_RELEASE_PENDING,
          entityType: 'seller_payout',
          entityId: payout.id,
          headline: 'Seller payout pending review/release',
          context: 'A seller settlement is ready for admin review.',
          email: em && em.email,
          adminPath: '/admin/settlement-review.html', adminId: auctionId, adminParam: 'auction',
          actionLabel: 'Review',
        });
      } catch (e) { console.error('[payout] owner-alert best-effort failed:', e.message); }
    })().catch(() => {});
  }
  return payout;
}

module.exports = { createSellerPayoutRecord };
