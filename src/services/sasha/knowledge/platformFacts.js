'use strict';

/**
 * platformFacts — authoritative Advantage.Bid rules for Sasha, read from the SAME code that enforces them.
 *
 * Every number here comes from the module that applies it (bid ladder, anti-sniping, buyer premium, fees, pickup gap,
 * lot minimum, card policy, storefront fee), so when the platform changes, Sasha's answer changes with it — no
 * separate manual to keep in sync. Facts are grouped by topic; each carries its source for the run log.
 *
 * Deliberately NOT stated here:
 *   - a standard Professional Seller platform-fee percentage (it is per-seller / per-agreement);
 */

const ladder = require('../../../../public/widgets/shared/bid-increment');
const billing = require('../../billingTermsService');
const sellerTypeRules = require('../../sellerTypeRules');
const { PROFESSIONAL_SELLER_TYPES } = require('../../../constants/sellerTypes');
const { marketplaceCheckoutEnabled } = require('../../../lib/launchGuards');
const MIN_LOTS = require('../../auctionService').MIN_LOTS_FOR_SUBMISSION;

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
      'Increment ladder (by current price): ' + ladderText().join('; ') + '. An auction run by a Professional Seller (or Advantage.Bid) can use a fixed increment instead, and the lot page always shows the exact next minimum bid.',
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
      'Example (example only; always check the specific auction): a $100 winning bid with an 18% premium totals $118 before any applicable sales tax.',
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
    source: 'Terms of Service sections 20, 22, 24 (terms.html) / buyer FAQ (buyer-faq.html, how-to-buy.html) / sellerTypeRules / location privacy rule',
    facts: [
      'Each auction has a pickup window set by the seller. Winners collect their items during that window at the pickup location.',
      'What to bring (buyer FAQ; Terms of Service section 20): bring a copy of your payment confirmation. At pickup, buyers may be asked to show their paid invoice, a valid government-issued photo ID, the credit card used for the purchase, and any auction-specific documentation. Say that these MAY be requested (the Terms do not say they are always checked).',
      'Someone else collecting (buyer FAQ; Terms of Service section 20): allowed. That person needs a written authorization from the buyer and a copy of the buyer\'s payment confirmation, and the buyer should contact Advantage.Bid support in advance. The Terms list proof of authorization among the things that may be checked at pickup.',
      'Loading and removal (Terms of Service section 20): the buyer is responsible for pickup, removal, loading, packing, tools, equipment, labor and transportation. Advantage.Bid and sellers are not required to provide tools, packing materials, loading assistance, labor or moving equipment, so bring enough help for large or heavy items.',
      'Missed pickup (Terms of Service section 22): items not collected during the published pickup window may be treated as abandoned and forfeited without a refund. An alternative pickup time is not guaranteed, and an alternative pickup fee may apply.',
      'Inspection (Terms of Service section 24): inspect items before leaving the pickup location; leaving with an item counts as accepting it.',
      'Anything beyond these Advantage.Bid policies is set by each seller and published with that auction\'s pickup details. Tell the customer to check that auction\'s published pickup details; do not guess or give examples of what a seller might require.',
      `For individual (non-professional) sellers, pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Professional sellers set their own pickup timing (never before the auction closes).`,
      'Before payment, listings show only the city and state. The full pickup address is sent to the winning buyer after their payment succeeds (in the payment receipt / pickup email), and it is shown on their paid invoice.',
      'Never give a pickup street address, ZIP code or coordinates to anyone who has not paid for that item (look it up only with get_my_pickup_details for the signed-in buyer).',
    ],
  }),
  selling: () => ({
    source: 'auctionService.MIN_LOTS_FOR_SUBMISSION / routes/lots.js professional-only lot settings / sellerTypeRules / seller agreement gate',
    facts: [
      `SELLER TYPES: the rules differ, so know which one you are answering for. Professional Sellers are ${PROFESSIONAL_SELLER_TYPES.join(', ')} (businesses that run sales, approved by Advantage.Bid). Everyone else (private individuals, other businesses) is an Individual Seller.`,
      `BOTH seller types: create an auction, add lots (title, description, photos, category, size category; dimensions are optional), set dates, pickup window and pickup location, choose 3 featured lots. Every auction needs at least ${MIN_LOTS} lots to be submitted or published (withdrawn lots don't count; smaller pieces can be grouped into one lot). State it simply as the rule. Do not mention exceptions, waivers, workarounds or staff approval at all (not even to say there are none), and never suggest contacting staff about it. Every auction needs its full pickup address before submission; buyers see only city and state until they pay. The seller agreement must be signed first.`,
      `INDIVIDUAL Sellers only: every lot starts at $1 and bidding follows the standard Advantage.Bid increment ladder. Individual sellers do NOT set starting bids, reserves or custom bid increments. The buyer's premium is a fixed ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}. Pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Final submission is single-use and locks editing; Advantage.Bid reviews and publishes the auction.`,
      `PROFESSIONAL Sellers only: once their business is verified they can publish their own qualifying auctions and keep editing. They can set per-lot starting bids, reserves and custom bid increments, set their own buyer's premium (0–25%) and keep it, and set their own pickup timing (never before the auction closes).`,
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
