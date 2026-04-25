const db = require('../db');
const { generateAuctionReport } = require('./reportingService');

async function buildAuctionReportPdfData(auctionId) {
  // Run both fetches in parallel — auction meta and full report
  const [auctionRes, report] = await Promise.all([
    db.query('SELECT title, status FROM auctions WHERE id = $1', [auctionId]),
    generateAuctionReport(auctionId)
  ]);

  if (!auctionRes.rows[0]) {
    throw new Error('Auction not found');
  }
  const { title, status } = auctionRes.rows[0];

  return {
    auction: {
      auction_id: auctionId,
      title,
      status
    },
    summary: {
      total_lots:          report.total_lots,
      sold_lots:           report.sold_lots,
      unsold_lots:         report.unsold_lots,
      gross_revenue_cents: report.gross_revenue_cents,
      platform_fee_cents:  report.platform_fee_cents,
      seller_payout_cents: report.seller_payout_cents,
      highest_sale_cents:  report.highest_sale_cents,
      unique_buyers_count: report.unique_buyers_count
    },
    lots: report.lots.map(lot => ({
      lot_id:             lot.lot_id,
      title:              lot.title,
      bid_count:          lot.bid_count,
      bidding_extended:   lot.bidding_extended,
      gross_amount_cents: lot.gross_amount_cents,
      fee_amount_cents:   lot.fee_amount_cents,
      net_amount_cents:   lot.net_amount_cents,
      winner_user_id:     lot.winner_user_id
    }))
  };
}

module.exports = { buildAuctionReportPdfData };
