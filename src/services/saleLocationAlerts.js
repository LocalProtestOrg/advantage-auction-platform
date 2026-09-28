'use strict';

/**
 * saleLocationAlerts — a sale was blocked because its pickup location is incomplete (src/lib/saleLocation.js).
 * This is an action-required event (the seller/admin must add the address before anyone can be charged), never a
 * routine payment event. Audited every time; the admin is texted once per auction / item (durable dedup by entity id).
 * Never throws: reporting must not change the buyer-facing answer.
 */

const db = require('../db');
const auditService = require('./auditService');

async function reportMissingSaleLocation({ entityType, entityId, auctionId = null, paymentId = null, missing = [], sellerId = null }) {
  try {
    await auditService.logEvent(db, { eventType: 'tax.sale_location_missing', entityType, entityId, auctionId, paymentId,
      actorId: null, metadata: { missing, seller_id: sellerId || undefined } });
  } catch (e) { console.error('[sale-location] audit failed', { entityType, entityId, error: e.message }); }
  try {
    const isAuction = entityType === 'auction';
    await require('./ownerAlertService').notifyAdminActionRequired({
      actionType: 'sale_location_missing', entityType, entityId,
      headline: isAuction ? 'Auction pickup address incomplete - buyers cannot be charged yet'
        : 'Storefront item pickup location incomplete - checkout blocked',
      context: 'Missing: ' + (missing.join(', ') || 'pickup address'),
      adminPath: isAuction ? '/admin/moderation.html' : '/admin/marketplace-orders.html',
    });
  } catch (e) { console.error('[sale-location] alert failed', { entityType, entityId, error: e.message }); }
}

module.exports = { reportMissingSaleLocation };
