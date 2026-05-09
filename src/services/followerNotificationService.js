'use strict';

const db  = require('../db');
const log = require('../lib/logger');

// Called after a successful publishAuction() commit.
// Queues a NEW_AUCTION notification for every follower who has email enabled.
// Failure here must never propagate — callers wrap in .catch().
async function enqueueNewAuctionNotifications(auction) {
  const { id: auctionId, seller_id: sellerId, title } = auction;

  // Resolve lot count for the payload (best-effort; zero if query fails).
  let lotCount = 0;
  try {
    const lotRes = await db.query(
      `SELECT COUNT(*)::int AS count FROM lots WHERE auction_id = $1`,
      [auctionId]
    );
    lotCount = lotRes.rows[0]?.count ?? 0;
  } catch {
    // Non-fatal — lot_count will be 0 in the notification payload.
  }

  // Fetch followers whose email delivery is enabled.
  // LEFT JOIN so users with no preferences row inherit the default (true).
  const followersRes = await db.query(
    `SELECT sf.user_id
       FROM seller_followers sf
       LEFT JOIN notification_preferences np ON np.user_id = sf.user_id
      WHERE sf.seller_id = $1
        AND COALESCE(np.email_enabled, true) = true`,
    [sellerId]
  );

  if (!followersRes.rows.length) return;

  const userIds = followersRes.rows.map(r => r.user_id);
  const payload = JSON.stringify({
    auction_id:  auctionId,
    seller_id:   sellerId,
    title:       title || 'New Auction',
    lot_count:   lotCount,
    auction_url: `/auction-view.html?auctionId=${auctionId}`,
  });

  await db.query(
    `INSERT INTO notifications_queue (user_id, type, payload)
     SELECT unnest($1::uuid[]), 'NEW_AUCTION', $2::jsonb`,
    [userIds, payload]
  );

  log.info('followers', `Queued NEW_AUCTION for ${userIds.length} follower(s)`, {
    auctionId,
    sellerId,
    followerCount: userIds.length,
  });
}

module.exports = { enqueueNewAuctionNotifications };
