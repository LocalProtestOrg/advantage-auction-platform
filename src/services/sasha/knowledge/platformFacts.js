'use strict';

/**
 * platformFacts — authoritative Advantage.Bid rules for Sasha, read from the SAME code that enforces them.
 *
 * Every number here comes from the module that applies it (bid ladder, anti-sniping, buyer premium, fees, pickup gap,
 * lot minimum, card policy, storefront fee), so when the platform changes, Sasha's answer changes with it — no
 * separate manual to keep in sync. Facts are grouped by topic; each carries its source for the run log.
 *
 * Deliberately NOT stated here (owner decisions pending — see cs_kb_articles with status 'conflict'):
 *   - a standard Professional Seller platform-fee percentage (it is per-seller / per-agreement);
 */

const ladder = require('../../../../public/widgets/shared/bid-increment');
const billing = require('../../billingTermsService');
const sellerTypeRules = require('../../sellerTypeRules');
const { PROFESSIONAL_SELLER_TYPES } = require('../../../constants/sellerTypes');
const { marketplaceCheckoutEnabled } = require('../../../lib/launchGuards');

const pct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 === 0 ? 0 : 2)}%`;
const usd = (c) => '$' + (Number(c) / 100).toFixed(2).replace(/\.00$/, '');
const SITE = 'https://bid.advantage.bid';

function ladderText() {
  const tiers = ladder.LADDER || [];
  const lines = []; let lo = 0;
  for (const [maxC, inc] of tiers) { lines.push(`${usd(lo)}–${usd(maxC)}: ${usd(inc)} increments`); lo = maxC + 1; }
  lines.push(`${usd(lo)} and up: ${usd(ladder.incrementForCents(lo + 1))} increments`);
  return lines;
}

const TOPICS = {
  bidding: () => ({
    source: 'bidService / bid-increment ladder / biddingWindow',
    facts: [
      'Bids are placed in whole dollars. The minimum next bid is the current bid plus the increment for that price (or the starting bid if there are no bids).',
      'Increment ladder (by current price): ' + ladderText().join('; ') + '. An auction can also use a fixed increment set by the seller or Advantage.Bid, and the lot page always shows the exact next minimum bid.',
      'Maximum bids (proxy bidding): you can set a max bid and the system bids for you only as much as needed to keep you in the lead, up to your max.',
      'Soft close / anti-sniping: each lot closes on its own time (lots close in a staggered sequence, about one minute apart). Any bid placed with 2 minutes or less remaining extends THAT lot by 2 minutes, and this can repeat.',
      'You can bid once an auction is published (approved); lots stop taking bids when they close.',
      'To bid you need an account, to accept the current Buyer Terms, to add a debit or credit card, and to register for that auction (acknowledging its pickup terms).',
    ],
  }),
  buyer_premium: () => ({
    source: 'billingTermsService.effectiveBuyerPremiumBps (frozen per auction at publication)',
    facts: [
      `A buyer's premium is a percentage added to the winning bid (hammer price). The rate is set per auction and shown on the auction and lot pages before you bid.`,
      `Individual-seller auctions use a fixed ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)} buyer's premium. Professional-seller auctions use the premium that seller configured (0%–25%); if none is set, ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
      'Example (example only — always check the specific auction): a $100 winning bid with an 18% premium totals $118 before any applicable sales tax.',
      'For a specific auction or lot, look up its actual rate (tool: get_auction_or_lot) rather than assuming 18%.',
      "Do not tell buyers who receives the premium.",
    ],
  }),
  payment: () => ({
    source: 'paymentService / combinedInvoiceService / cardService',
    facts: [
      'Only debit and credit cards are accepted. Prepaid cards are refused.',
      'Adding a card does not charge you: the bank checks the card when it is saved (a temporary authorization may appear and disappear). Advantage.Bid does not charge anything to verify a card.',
      'When an auction closes, each winning buyer gets ONE combined invoice for everything they won in that auction (winning bids + buyer\'s premium + any applicable sales tax), and the card on file is charged automatically.',
      'If the automatic charge fails (for example a decline), the invoice shows "payment required" and you can pay it from your invoices page with the same or another card; reminders are sent.',
      `Invoices: ${SITE}/invoices.html. Payment card: ${SITE}/add-card.html.`,
      'Sales tax, where it applies, is calculated for the place of sale (the pickup location, or the shipping address for shipped items) and shown on the invoice.',
    ],
  }),
  pickup: () => ({
    source: 'sellerTypeRules / auction pickup windows / location privacy rule / published buyer FAQ (buyer-faq.html, how-to-buy.html)',
    facts: [
      'Each auction has a pickup window set by the seller. Winners collect their items during that window at the pickup location.',
      'Advantage.Bid policy: buyers should bring a copy of their payment confirmation when they collect.',
      'Advantage.Bid policy: a buyer may send someone else to collect on their behalf. That person needs a written authorization from the buyer and a copy of the buyer\'s payment confirmation, and the buyer should let Advantage.Bid support know in advance. Advantage.Bid does not publish any other requirement (for example, it has no stated ID requirement) — do not add one.',
      'Anything beyond Advantage.Bid policy (dock access, loading help, parking, what to bring, specific arrival times) is set by each seller and published with that auction\'s pickup details; say so rather than guessing.',
      `For individual (non-professional) sellers, pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Professional sellers set their own pickup timing (never before the auction closes).`,
      'Before payment, listings show only the city and state. The full pickup address is sent to the winning buyer after their payment succeeds (in the payment receipt / pickup email), and it is shown on their paid invoice.',
      'Never give a pickup street address, ZIP code or coordinates to anyone who has not paid for that item (look it up only with get_my_pickup_details for the signed-in buyer).',
    ],
  }),
  selling: () => ({
    source: 'auctionService / sellerTypeRules / seller agreement gate',
    facts: [
      `Professional seller types: ${PROFESSIONAL_SELLER_TYPES.join(', ')}. Everyone else (private, business, other) is an individual seller.`,
      'Sellers create an auction, add lots (title, description, photos, category, size category; dimensions are optional), set dates, pickup window and pickup location, choose 3 featured lots, and submit.',
      'An auction needs at least 30 lots to be submitted/published (Advantage.Bid staff can make exceptions).',
      'Every auction needs its full pickup address (street, city, state, ZIP) before it can be submitted or published. Buyers see only the city and state until they pay.',
      'Individual sellers: final submission is single-use and locks editing; Advantage.Bid reviews and publishes the auction. Verified Professional Sellers can publish their own auctions and keep editing.',
      'Each lot starts at $1 by default unless a different starting bid is set.',
      'Sellers must sign the seller agreement before creating auctions.',
    ],
  }),
  seller_fees: () => ({
    source: 'billingTermsService / settlementPolicy / owner decision 1 (fee reconciliation pending for professional rates)',
    facts: [
      `Individual sellers: no platform fee; a ${pct(billing.DEFAULT_PROCESSING_FEE_BPS)} payment-processing fee on the hammer price is deducted from the payout. The buyer's premium on individual auctions is ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
      `Professional Sellers: the platform fee is set in each seller's Professional Seller agreement (it can differ by seller), plus a ${pct(billing.DEFAULT_PROCESSING_FEE_BPS)} payment-processing fee on the hammer price. Professional Sellers set and keep their own buyer's premium.`,
      'Never quote a standard Professional Seller platform-fee percentage, and never reveal another seller\'s rate. A signed-in Professional Seller can be told their own terms (tool: get_my_seller_terms).',
      'Auction terms are fixed when the auction is first published; later changes never apply retroactively.',
    ],
  }),
  payouts: () => ({
    source: 'Seller agreement §7.3 payout schedule (Owner decision 2026-09-28) / settlementEngine',
    facts: [
      'After an auction closes and buyers pay, Advantage.Bid prepares a settlement for the seller: collected sales minus the applicable fees (sales tax is never part of seller proceeds).',
      'Settlements are reviewed by Advantage.Bid and paid manually, by direct deposit (bank account set up on the payout profile page). Payment is not released while a settlement is on hold or a payment dispute is open.',
      `Sellers can see their settlements at ${SITE}/seller-settlements.html and set up payouts at ${SITE}/payout-profile.html.`,
      'Advantage.Bid processes eligible seller payouts every Thursday. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout. For Storefront fixed-price sales, the weekly cutoff is Wednesday at 11:59 PM, with eligible sales processed on Thursday.',
      'Say payouts are "processed" on Thursday; never promise the funds arrive in the bank that day (bank processing time varies). Payouts can be held while payment, pickup, a dispute, verification or banking details are unresolved; for a specific late or missing payout, hand the conversation to the team.',
    ],
  }),
  storefront: () => ({
    source: 'marketplaceOrderService.STOREFRONT_FEE_BPS / seller agreement §6.9 / launchGuards',
    facts: [
      'Professional Sellers can have a public storefront and list fixed-price items. Unsold auction lots can be moved to the storefront in one click; the item\'s pickup location carries over.',
      `Storefront items use the seller's confirmed storefront pickup location unless the seller sets a different location for an item. Buyers see only city and state before purchase.`,
      marketplaceCheckoutEnabled() ? 'Online checkout ("Buy Now") for storefront items is available.'
        : 'Online checkout ("Buy Now") for storefront items is not available yet. Interested buyers can contact the seller through the storefront.',
      storefrontFeeText(),
      'Keep the storefront fee separate from Professional Seller AUCTION fees (platform fee per agreement + 3% processing on the hammer price); never combine them.',
    ],
  }),
  account: () => ({
    source: 'site navigation',
    facts: [
      `Sign in / create an account: ${SITE}/login.html. Account and dashboard: ${SITE}/app.html.`,
      `Buyers: invoices ${SITE}/invoices.html; add or change a card ${SITE}/add-card.html; notification preferences are in the account settings.`,
      `Sellers: create an auction ${SITE}/seller-create.html; seller dashboard ${SITE}/seller-dashboard.html; storefront ${SITE}/seller-storefront.html; settlements ${SITE}/seller-settlements.html.`,
      'Watchlist/favorites let buyers save lots; Follow lets buyers follow a seller to hear about their new auctions.',
      'SMS notifications are opt-in only.',
    ],
  }),
};

function storefrontFeeText() {
  const bps = require('../../marketplaceOrderService').STOREFRONT_FEE_BPS;
  return `Professional Storefront fixed-price sales have a flat ${bps / 100}% seller fee on the item selling price only. It includes card processing; shipping and sales tax are not part of the fee calculation. It is the same for every Professional Seller.`;
}

const TOPIC_NAMES = Object.keys(TOPICS);

/** Facts for one topic (or all when topic is 'all'). Never throws. */
function getFacts(topic) {
  const names = topic === 'all' || !TOPICS[topic] ? TOPIC_NAMES : [topic];
  const out = {};
  for (const n of names) { try { out[n] = TOPICS[n](); } catch (e) { out[n] = { source: 'unavailable', facts: [] }; } }
  return out;
}

module.exports = { getFacts, TOPIC_NAMES };
