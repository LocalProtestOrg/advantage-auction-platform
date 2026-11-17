'use strict';

/**
 * taxHolds - what happens when the sales tax safeguard holds an auction payment, or lets one through without tax in
 * report mode. Records an administrator alert (one per auction and state), audits it, and texts the owner once. Never
 * throws: the payment path decides what happens to the payment; this only makes sure a person knows.
 */

const alerts = require('./taxAlerts');

const WHY = {
  TAX_CONFIGURATION_REQUIRED: 'there is no sales tax rule for this state',
  TAX_NOT_COLLECTING: 'the rule says Advantage.Bid collects sales tax in this state, but tax is not being collected there (no active registration in the tax calculation settings)',
  TAX_CONFIGURATION_CONFLICT: 'the rule says no tax is collected at checkout in this state, but tax was calculated (a registration exists)',
};

async function recordAuctionHold({ auctionId, paymentId, buyerUserId, state, code }) {
  try {
    const key = `payment_hold:${auctionId}:${state || '??'}:${code}`;
    const r = await alerts.raise({ key, type: 'payment_hold', severity: 'critical',
      message: `Auction payments are on hold in ${state || 'an unknown state'}: ${WHY[code] || code}. No buyer has been charged. Complete the configuration, or record an exception, then the buyers can pay.`,
      detail: { auction_id: auctionId, state, code, last_payment_id: paymentId, last_buyer_user_id: buyerUserId } });
    if (r && r.created) {
      await require('../auditService').logEvent(require('../../db'), { eventType: 'tax.auction_payment_held', entityType: 'auction', entityId: auctionId,
        actorId: null, metadata: { state, code, payment_id: paymentId } }).catch(() => {});
      await require('../ownerAlertService').notifyAdminActionRequired({ actionType: 'tax_payment_hold', entityType: 'auction_tax_hold',
        entityId: `${auctionId}:${state}:${code}`, headline: 'Auction payments on hold for sales tax setup', context: state ? 'State: ' + state : '',
        adminPath: '/admin/tax.html', actionLabel: 'Review' }).catch(() => {});
    }
  } catch (e) { console.error('[tax-holds] could not record the hold', e.message); }
}

async function reportUntaxedAuctionSale({ auctionId, paymentId, state, remitter }) {
  try {
    await alerts.raise({ key: `auction_untaxed:${auctionId}:${state || '??'}:${remitter}`, type: 'auction_untaxed', severity: 'warning',
      message: remitter === 'exception'
        ? `An auction in ${state} is being paid without sales tax under an administrator exception. Review the tax position with the accountant.`
        : `An auction in ${state || 'an unknown state'} is being paid without sales tax because the state has no tax rule (report mode). Add a rule for the state.`,
      detail: { auction_id: auctionId, state, remitter, last_payment_id: paymentId } });
  } catch (e) { console.error('[tax-holds] could not record the report', e.message); }
}

module.exports = { recordAuctionHold, reportUntaxedAuctionSale, WHY };
