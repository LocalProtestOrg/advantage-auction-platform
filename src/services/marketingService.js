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
}

module.exports = new MarketingService();
