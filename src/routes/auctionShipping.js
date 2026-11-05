'use strict';

/**
 * Auction shipping, Phase 1 routes (spec docs/projects/auction-shipping-spec.md). OFF unless AUCTION_SHIPPING_ENABLED=true:
 * with the flag off every route except GET /config answers 404, so nothing changes for anyone.
 *
 *   GET    /api/auction-shipping/config                         { enabled } (public; the seller and buyer pages read it)
 *   GET    /api/auction-shipping/seller/status                  the signed-in seller's eligibility, limit, education, profiles
 *   POST   /api/auction-shipping/seller/acknowledge             one-time payout and fraud education acknowledgment
 *   GET    /api/auction-shipping/seller/profiles                own shipping profiles
 *   POST   /api/auction-shipping/seller/profiles                create
 *   PATCH  /api/auction-shipping/seller/profiles/:profileId     edit (own only)
 *   DELETE /api/auction-shipping/seller/profiles/:profileId     archive (own only; refused while an open lot ships with it)
 *   GET    /api/auction-shipping/lots/:lotId                    the lot's shipping settings (owner or admin)
 *   PUT    /api/auction-shipping/lots/:lotId                    set or clear the lot's shipping (owner; admin override audited)
 *   GET    /api/auction-shipping/admin/sellers/:sellerProfileId          admin view
 *   POST   /api/auction-shipping/admin/sellers/:sellerProfileId/approve  approve an Individual Seller (reason; optional limit)
 *   POST   /api/auction-shipping/admin/sellers/:sellerProfileId/revoke   revoke (reason)
 *   PUT    /api/auction-shipping/admin/sellers/:sellerProfileId/limit    per-shipment limit (reason; null = $500 default)
 * Phase 3 scaffolding (migration 219; auctionShipmentService):
 *   POST   /api/auction-shipping/shipments                       create a buyer's shipment (seller of the auction or admin)
 *   GET    /api/auction-shipping/shipments/:id                   seller, buyer or admin
 *   POST   /api/auction-shipping/shipments/:id/ship              carrier + tracking (+ signature above $500) (seller or admin)
 *   POST   /api/auction-shipping/shipments/:id/confirm-delivery  buyer (own) or admin (note required)
 *   POST   /api/auction-shipping/admin/shipments/:id/override    { kind: signature | limit, reason } (admin)
 *   GET    /api/auction-shipping/admin/auctions/:auctionId/payout-hold   the shipped-lot payout hold for an auction (admin)
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const { auctionShippingEnabled } = require('../lib/auctionShippingPolicy');
const svc = require('../services/auctionShippingService');
const shipments = require('../services/auctionShipmentService');

router.get('/config', (req, res) => res.json({ success: true, data: { enabled: auctionShippingEnabled() } }));

router.use((req, res, next) => {
  if (!auctionShippingEnabled()) return res.status(404).json({ success: false, code: 'AUCTION_SHIPPING_DISABLED', message: 'Not found' });
  return next();
});

const run = (fn) => async (req, res, next) => {
  try { return res.json({ success: true, data: await fn(req) }); }
  catch (e) {
    if (e instanceof svc.ShippingError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    if (e instanceof shipments.ShipmentError) return res.status(e.status).json({ success: false, code: e.code, message: e.message, violations: e.violations });
    return next(e);
  }
};
const user = (req) => ({ id: req.user.id, role: req.user.role });

router.get('/seller/status', auth, run((req) => svc.getSellerStatus(req.user.id)));
router.post('/seller/acknowledge', auth, run((req) => svc.acknowledgeEducation(req.user.id, req.body || {})));
router.get('/seller/profiles', auth, run((req) => svc.listProfiles(req.user.id)));
router.post('/seller/profiles', auth, run((req) => svc.createProfile(req.user.id, req.body || {})));
router.patch('/seller/profiles/:profileId', auth, run((req) => svc.updateProfile(req.user.id, req.params.profileId, req.body || {})));
router.delete('/seller/profiles/:profileId', auth, run((req) => svc.archiveProfile(req.user.id, req.params.profileId)));

router.get('/lots/:lotId', auth, run((req) => svc.getLotSettings(user(req), req.params.lotId)));
router.put('/lots/:lotId', auth, run((req) => svc.setLotShipping(user(req), req.params.lotId, req.body || {})));

router.get('/admin/sellers/:sellerProfileId', auth, role(['admin']), run((req) => svc.adminGetSeller(req.params.sellerProfileId)));
router.post('/admin/sellers/:sellerProfileId/approve', auth, role(['admin']), run((req) => svc.adminApprove(req.user.id, req.params.sellerProfileId, req.body || {})));
router.post('/admin/sellers/:sellerProfileId/revoke', auth, role(['admin']), run((req) => svc.adminRevoke(req.user.id, req.params.sellerProfileId, req.body || {})));
router.put('/admin/sellers/:sellerProfileId/limit', auth, role(['admin']), run((req) => svc.adminSetLimit(req.user.id, req.params.sellerProfileId, req.body || {})));

router.post('/shipments', auth, run((req) => shipments.createShipment(user(req), req.body || {})));
router.get('/shipments/:shipmentId', auth, run((req) => shipments.getShipment(user(req), req.params.shipmentId)));
router.post('/shipments/:shipmentId/ship', auth, run((req) => shipments.markShipped(user(req), req.params.shipmentId, req.body || {})));
router.post('/shipments/:shipmentId/confirm-delivery', auth, run((req) => shipments.confirmDelivery(user(req), req.params.shipmentId, req.body || {})));
router.post('/admin/shipments/:shipmentId/override', auth, role(['admin']), run((req) => shipments.adminOverride(user(req), req.params.shipmentId, req.body || {})));
router.get('/admin/auctions/:auctionId/payout-hold', auth, role(['admin']), run((req) => shipments.payoutHoldForAuction(req.params.auctionId)));

module.exports = router;
