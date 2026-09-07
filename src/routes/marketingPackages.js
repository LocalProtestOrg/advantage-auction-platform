'use strict';

/**
 * /api/marketing-packages — SELLER-facing package catalog, prepaid Stripe checkout, and reporting.
 * Sellers see ONLY seller-safe data: what they purchased, what was delivered, campaign status, and
 * performance where measurable. They NEVER see internal economics, ceilings, policy, Growth Pool,
 * substitution economics, provider mechanics, or Director reasoning.
 */

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleMiddleware');
const db = require('../db');
const registry = require('../services/packageRegistryService');
const purchases = require('../services/marketingPackagePurchaseService');
const obligations = require('../services/marketingObligationEngine');
const marketingConfig = require('../services/marketingConfigService');

router.use(auth, role(['seller', 'admin']));

// Catalog: active package versions (seller view) + additional promotion presets.
router.get('/', async (req, res, next) => {
  try {
    const active = await registry.listActive();
    const promos = {};
    for (const k of ['boost', 'reach', 'spotlight']) promos[k] = await marketingConfig.getInt('marketing.pkg.addl.' + k + '.price_cents', 0);
    return res.json({ success: true, data: { packages: active.map(registry.sellerView), additional_promotions: promos } });
  } catch (err) { next(err); }
});

// Prepaid Stripe checkout for a paid package.
router.post('/checkout', async (req, res, next) => {
  try {
    const out = await purchases.createPackageCheckout(req.user.id, { packageKey: (req.body || {}).package_key, auctionId: (req.body || {}).auction_id, origin: req.headers.origin });
    return res.json({ success: true, data: out });
  } catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Prepaid Stripe checkout for an additional promotion.
router.post('/additional-promotion/checkout', async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await purchases.createAdditionalPromotionCheckout(req.user.id, { promotionKey: b.promotion_key, auctionId: b.auction_id, packagePurchaseId: b.package_purchase_id, customAmountCents: b.custom_amount_cents, origin: req.headers.origin });
    return res.json({ success: true, data: out });
  } catch (err) { if (err && err.status) return res.status(err.status).json({ success: false, message: err.message }); next(err); }
});

// Seller-safe view of one purchase snapshot (NO economics).
function sellerPurchaseView(p) {
  return {
    id: p.id, package_key: p.package_key, package_version: p.package_version, status: p.status,
    amount_paid_cents: p.amount_paid_cents, purchased_at: p.purchased_at, auction_id: p.auction_id,
    what_you_purchased: p.seller_copy, guaranteed: (p.guaranteed_deliverables || []).map((d) => d.label).filter(Boolean),
    non_refundable: true,
  };
}
// Seller-safe obligation view: what Advantage.Bid promoted/delivered + status. Hides internal machinery.
function sellerObligationView(o) {
  const delivered = ['completed', 'live', 'substituted', 'made_good'].indexOf(o.state) !== -1;
  return { item: o.label, category: o.category, status: delivered ? 'delivered' : (o.state === 'scheduled' ? 'scheduled' : 'in_progress'), channel: o.channel };
}

router.get('/mine', async (req, res, next) => {
  try {
    const rows = (await db.query(`SELECT * FROM marketing_package_purchases WHERE seller_user_id = $1 ORDER BY purchased_at DESC`, [req.user.id])).rows;
    const promos = (await db.query(`SELECT id, promotion_key, amount_paid_cents, status, purchased_at, auction_id FROM marketing_additional_promotions WHERE seller_user_id = $1 ORDER BY purchased_at DESC`, [req.user.id])).rows;
    return res.json({ success: true, data: { purchases: rows.map(sellerPurchaseView), additional_promotions: promos } });
  } catch (err) { next(err); }
});

// Seller reporting for one purchase (own only): delivery status + measurable performance (no attribution invented).
router.get('/mine/:purchaseId/report', async (req, res, next) => {
  try {
    const p = (await db.query(`SELECT * FROM marketing_package_purchases WHERE id = $1 AND seller_user_id = $2`, [req.params.purchaseId, req.user.id])).rows[0];
    if (!p) return res.status(404).json({ success: false, message: 'Not found' });
    const obs = await obligations.listForPurchase('package', p.id);
    const completion = await obligations.evaluateCompletion('package', p.id);
    return res.json({ success: true, data: {
      purchase: sellerPurchaseView(p),
      delivered: obs.map(sellerObligationView),
      campaign_status: completion.complete ? 'complete' : 'in_progress',
      // measurable auction signals (only where data exists; never invented attribution)
      note: 'Performance reflects measurable platform activity; some channels report as delivered without per-channel attribution.',
    } });
  } catch (err) { next(err); }
});

module.exports = router;
