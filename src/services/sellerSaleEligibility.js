'use strict';

/**
 * sellerSaleEligibility — may this seller company receive a storefront (fixed-price) order right now? (roadmap §13.A)
 *
 * Yes only when ALL hold, re-read from the database at the moment of the check:
 *   - the company is a Professional Seller (canonical sellerTypeRules.isProfessional);
 *   - its owner account is active (users.is_active is not false; a suspended owner suspends the company's sales);
 *   - it has passed Advantage.Bid business verification where verification is required — the SAME
 *     verificationService.publicationGate that gates a Professional Seller's first auction (no second system);
 *   - its seller agreement is in place: the SAME agreementService.dashboardAccess gate as the seller dashboard (signed,
 *     waived by Advantage.Bid, or a long-standing seller with earlier auctions);
 *   - it can be paid: the owner's payout account is connected and can receive transfers and pay them out (the same
 *     readiness the settlement "Pay Seller" step requires), so a buyer's money is never taken for a seller who cannot
 *     be paid (2026-11-02).
 * Enforced on the server for every quote, order and payment (marketplaceOrderService); never by the item page.
 */

const db = require('../db');
const { isProfessional } = require('./sellerTypeRules');

function err(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

async function assertSellerCanSell(sellerProfileId, runner = db) {
  const sp = (await runner.query(
    `SELECT sp.id, sp.user_id, sp.seller_type, u.is_active AS owner_active
       FROM seller_profiles sp LEFT JOIN users u ON u.id = sp.user_id WHERE sp.id = $1`, [sellerProfileId])).rows[0];
  if (!sp || !isProfessional(sp.seller_type)) throw err(409, 'NOT_PROFESSIONAL', 'This item is not purchasable.');
  // A suspended and a not-yet-verified seller get the SAME answer, so a buyer cannot learn a seller's account status.
  const refuse = () => err(409, 'SELLER_NOT_ACCEPTING_ORDERS', 'This seller is not accepting orders right now.');
  if (sp.owner_active === false) throw refuse();
  const gate = await require('./verificationService').publicationGate(sp.id);
  if (gate.blocked) throw refuse();
  const agreement = await require('./agreementService').dashboardAccess(sp.id);
  if (!agreement || !agreement.access) throw refuse();
  if (!payoutReady(await require('./payoutPreferenceService').getSellerPayoutPreference(sp.user_id))) throw refuse();
  return true;
}

// The seller's connected payout account can receive a transfer and pay it out (settlementEngine.connectPayoutReady).
function payoutReady(pref) {
  return !!(pref && pref.stripe_account_id && require('../lib/payoutProfile').isAchComplete(pref));
}

module.exports = { assertSellerCanSell, payoutReady };
