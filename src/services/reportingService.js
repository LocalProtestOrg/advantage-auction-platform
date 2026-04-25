const db = require('../db');

async function generateAuctionReport(auctionId) {
  const auctionRes = await db.query(
    `SELECT id, title, ends_at FROM auctions WHERE id = $1`,
    [auctionId]
  );
  if (!auctionRes.rows[0]) {
    throw new Error('Auction not found');
  }
  const auction = auctionRes.rows[0];

  // Auction-level summary
  const summaryRes = await db.query(
    `SELECT
       COUNT(*)::int                                                             AS total_lots,
       COUNT(*) FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int           AS sold_lots,
       COUNT(*) FILTER (WHERE winning_buyer_user_id IS NULL)::int               AS unsold_lots,
       COALESCE(SUM(winning_amount_cents) FILTER (WHERE winning_buyer_user_id IS NOT NULL), 0)::int
                                                                                AS total_revenue_cents,
       COALESCE(MAX(winning_amount_cents), 0)::int                              AS highest_sale_cents,
       COUNT(DISTINCT winning_buyer_user_id)
         FILTER (WHERE winning_buyer_user_id IS NOT NULL)::int                  AS unique_buyers_count
     FROM lots
     WHERE auction_id = $1`,
    [auctionId]
  );
  const summary = summaryRes.rows[0];

  // Per-lot detail: bid count, extension_count, winner email, lot number
  const lotsRes = await db.query(
    `SELECT
       l.id                        AS lot_id,
       l.lot_number,
       l.title,
       l.winning_amount_cents,
       l.winning_buyer_user_id     AS winner_user_id,
       l.extension_count,
       u.email                     AS winner_email,
       COUNT(b.id)::int            AS bid_count
     FROM lots l
     LEFT JOIN bids  b ON b.lot_id = l.id
     LEFT JOIN users u ON u.id     = l.winning_buyer_user_id
     WHERE l.auction_id = $1
     GROUP BY l.id, l.lot_number, l.title, l.winning_amount_cents,
              l.winning_buyer_user_id, l.extension_count, u.email
     ORDER BY l.position ASC, l.created_at ASC`,
    [auctionId]
  );

  // Highest-sale lot for summary object
  const highestLotRes = await db.query(
    `SELECT id AS lot_id, lot_number, title, winning_amount_cents
     FROM lots
     WHERE auction_id = $1
       AND winning_amount_cents = (SELECT MAX(winning_amount_cents) FROM lots WHERE auction_id = $1)
     LIMIT 1`,
    [auctionId]
  );
  const highest_sale_lot = highestLotRes.rows[0] || null;

  const PLATFORM_FEE_RATE = 0.10;
  const calcFee = gross => Math.round(gross * PLATFORM_FEE_RATE);

  const lots = lotsRes.rows.map(row => {
    const gross     = row.winning_amount_cents ?? 0;
    const fee       = calcFee(gross);
    const bid_count = row.bid_count;
    const intensity = bid_count > 10 ? 'high' : bid_count > 5 ? 'medium' : 'low';
    return {
      lot_id:               row.lot_id,
      lot_number:           row.lot_number,
      title:                row.title,
      bid_count,
      intensity,
      was_extended:         row.extension_count > 0,
      winning_amount_cents: row.winning_amount_cents,
      winner_user_id:       row.winner_user_id,
      winner_email:         row.winner_email,
      gross_amount_cents:   gross,
      fee_amount_cents:     fee,
      net_amount_cents:     gross - fee,
    };
  });

  const gross_revenue_cents = summary.total_revenue_cents;
  const platform_fee_cents  = calcFee(gross_revenue_cents);
  const seller_payout_cents = gross_revenue_cents - platform_fee_cents;

  return {
    auction_id:           auctionId,
    auction_title:        auction.title,
    auction_ends_at:      auction.ends_at,
    generated_at:         new Date().toISOString(),
    summary: {
      total_lots:          summary.total_lots,
      sold_lots:           summary.sold_lots,
      unsold_lots:         summary.unsold_lots,
      unique_buyers_count: summary.unique_buyers_count,
      highest_sale_cents:  summary.highest_sale_cents,
      highest_sale_lot,
      gross_revenue_cents,
      platform_fee_cents,
      seller_payout_cents,
    },
    lots,
  };
}

module.exports = { generateAuctionReport };
