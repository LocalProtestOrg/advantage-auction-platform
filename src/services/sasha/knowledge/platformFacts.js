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
      `Example (example only; always check the specific auction): a $100 winning bid with an ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)} premium totals ${usd(10000 + billing.DEFAULT_BUYER_PREMIUM_BPS)} before any applicable sales tax.`,
      `For a specific auction or lot, look up its actual rate (tool: get_auction_or_lot) rather than assuming ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
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
      'What to bring. REQUIRED (buyer FAQ): a copy of your payment confirmation. MAY BE REQUESTED at pickup (Terms of Service section 20; not required in every case): a valid government-issued photo ID, the credit card used for the purchase, and any applicable auction-specific documentation. Phrase these as things the buyer may be asked for, never as items every buyer must bring.',
      'Someone else collecting (buyer FAQ; Terms of Service section 20): allowed. REQUIRED: a written authorization from the buyer and a copy of the buyer\'s payment confirmation, and the buyer should contact Advantage.Bid support in advance. The person collecting may also be asked for the MAY BE REQUESTED items above.',
      'Loading and removal (Terms of Service section 20): the buyer is responsible for pickup, removal, loading, packing, tools, equipment, labor and transportation. Advantage.Bid and sellers are not required to provide tools, packing materials, loading assistance, labor or moving equipment, so bring enough help for large or heavy items.',
      'Missed pickup (Terms of Service section 22): items not collected during the published pickup window may be treated as abandoned and forfeited without a refund. An alternative pickup time is not guaranteed, and an alternative pickup fee may apply.',
      'Inspection (Terms of Service section 24): inspect items before leaving the pickup location; leaving with an item counts as accepting it.',
      'Anything beyond these Advantage.Bid policies is set by each seller and published with that auction\'s pickup details. Tell the customer to check that auction\'s published pickup details; do not guess or give examples of what a seller might require.',
      `For individual (non-professional) sellers, pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Professional sellers set their own pickup timing (never before the auction closes).`,
      'Before payment, listings show only the city and state. The full pickup address is sent to the winning buyer by email after their payment succeeds (the pickup email from Advantage.Bid). It is not printed on the invoice or shown on the auction page. A signed-in buyer who has paid can also ask Sasha for it.',
      'Never give a pickup street address, ZIP code or coordinates to anyone who has not paid for that item (look it up only with get_my_pickup_details for the signed-in buyer).',
    ],
  }),
  selling: () => ({
    source: 'auctionService.MIN_LOTS_FOR_SUBMISSION / routes/lots.js professional-only lot settings / sellerTypeRules / seller agreement gate',
    facts: [
      `SELLER TYPES: the rules differ, so know which one you are answering for. Professional Sellers are ${PROFESSIONAL_SELLER_TYPES.join(', ')} (businesses that run sales, approved by Advantage.Bid). Everyone else (private individuals, other businesses) is an Individual Seller.`,
      `BOTH seller types: create an auction, add lots (title, description, photos, category and size category), set dates, pickup window and pickup location, choose 3 featured lots. The seller agreement must be signed first. Every auction needs its full pickup address before submission; buyers see only city and state until they pay.`,
      `MINIMUM LOTS: every auction needs at least ${MIN_LOTS} lots to be submitted or published (withdrawn lots don't count). State it simply as the rule. Items that naturally belong together can sensibly be offered as one lot (for example a matching set of dishes or a set of chairs), but never suggest combining unrelated items just to reach ${MIN_LOTS}. Do not mention exceptions, waivers, workarounds or staff approval at all (not even to say there are none), and never suggest contacting staff about it.`,
      'DIMENSIONS: measurements are optional, but highly recommended for anything where size matters (furniture, rugs, artwork, mirrors, appliances): they help buyers bid with confidence and plan pickup, and make the listing stronger. The size category is always required.',
      'CREATING LOTS IS EASY (both seller types): a seller can start a lot simply by taking photos of the item with their phone (up to 20 photos per lot). The Smart Description tool can then suggest a title, a short description and a category from the photos, which the seller reviews and adjusts before saving, and photo enhancement can automatically clean up the background, crop and brighten the photos. Each lot is created individually (there is no one-photo-per-lot bulk upload). Never call these tools AI, and never say they write the whole listing without the seller reviewing it.',
      `INDIVIDUAL Sellers only: every lot starts at $1 and bidding follows the standard Advantage.Bid increment ladder. Individual sellers do NOT set starting bids, reserves or custom bid increments. The buyer's premium is a fixed ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}. Pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Final submission is single-use and locks editing; Advantage.Bid reviews and publishes the auction.`,
      `PROFESSIONAL Sellers only: once their business is verified they can publish their own qualifying auctions and keep editing. They can set per-lot starting bids, reserves and custom bid increments, set their own buyer's premium (0–25%) and keep it, and set their own pickup timing (never before the auction closes).`,
    ],
  }),
  seller_benefits: (p) => ({
    source: 'marketplaceVisibility / public feeds + BD widgets / shareMeta + sitemap / Smart Description + image processing / bidService / combined invoicing + Stripe / settlementEngine + payout profile / sellerTypeRules / widgetService / storefrontService / launchGuards',
    facts: [
      'WHY SELL WITH ADVANTAGE.BID, BOTH seller types (only these; never invent guarantees, traffic numbers or sales results):',
      'Easy listing: start each lot by taking photos with a phone; Smart Description suggests the title, description and category, and photos can be cleaned up automatically.',
      `Marketing and exposure: every published auction is automatically listed on the Advantage.Bid marketplace (browse, map, ending-soon and featured listings) and on Advantage.Bid's public website through live listings, with search-engine-friendly auction and lot pages. Bidders who watch a lot get an ending-soon reminder, and outbid bidders are emailed so they come back to bid.`,
      'Competitive online bidding: bidders compete in real time and can set a maximum bid that bids for them automatically; a bid in the last two minutes extends that lot by two more minutes (soft close), so interested bidders always get a chance to respond; and lots close one at a time, about a minute apart.',
      'INDIVIDUAL Sellers and price: never say or imply that bidding protects their prices, sets a minimum price, guarantees a sale amount, or works like a reserve. Their lots start at $1 with no reserve and sell to the highest bidder when the lot closes. Reserves and starting bids are Professional Seller controls only.',
      'Payments handled for you: winning buyers are invoiced and their card on file is charged automatically when the auction closes, so the seller never has to chase or collect payments.',
      'Getting paid: after pickup, Advantage.Bid prepares the settlement and pays by direct deposit (a mailed check is also available); payouts are processed weekly on Thursdays.',
      'Pickup is organized: buyers get pickup appointments automatically when the auction closes, and the full address is shared only after a buyer has paid.',
      `INDIVIDUAL Sellers in particular: no commission and nothing to pay upfront to list, only a ${pct(p.processingBps)} processing fee on what sells; lots start at $1 with no reserves to set, so there is nothing to price; Advantage.Bid reviews the auction before publishing it.`,
      `PROFESSIONAL Sellers in particular (lead with the seller's own business benefit): once verified they publish their own auctions without waiting for review and keep editing; they control their own starting bids, reserves, bid increments, buyer's premium (which they keep) and pickup timing; they get a public business storefront page with fixed-price items, including moving unsold lots there in one click; and they can add their live auctions to their own website with an embeddable auction widget, so the same auctions appear on their site and on the Advantage.Bid marketplace at the same time. Their platform fee is set in their own agreement: never quote a standard percentage. ${marketplaceCheckoutEnabled() ? 'Storefront items can be bought online with Buy Now.' : 'Online Buy Now checkout for storefront items is not available yet; buyers contact the seller.'}`,
      'Do NOT mention: neighborhood "Sales Near You" emails, paid promotion packages, social media posting or ads (not offered to callers as a standard benefit), or any number of bidders, visitors or sales.',
    ],
  }),
  seller_fees: (p) => ({
    source: 'billingTermsService / settlementPolicy / owner decision 1 (fee reconciliation pending for professional rates)',
    facts: [
      `Individual sellers: no platform fee; a ${pct(p.processingBps)} payment-processing fee on the hammer price is deducted from the payout. The buyer's premium on individual auctions is ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
      `Professional Sellers: the platform fee is set in each seller's Professional Seller agreement (it can differ by seller), plus a ${pct(p.processingBps)} payment-processing fee on the hammer price. Professional Sellers set and keep their own buyer's premium.`,
      'Never quote a standard Professional Seller platform-fee percentage, and never reveal another seller\'s rate. A signed-in Professional Seller can be told their own terms (tool: get_my_seller_terms).',
      'Auction terms are fixed when the auction is first published; later changes never apply retroactively.',
    ],
  }),
  payouts: () => ({
    source: 'Seller agreement §7.3 payout schedule (Owner decision 2026-09-28) / settlementEngine',
    facts: [
      'After an auction closes and buyers pay, Advantage.Bid prepares a settlement for the seller: collected sales minus the applicable fees (sales tax is never part of seller proceeds).',
      'HOW SELLERS GET PAID (mention this whenever you explain payouts, without waiting to be asked): by direct deposit (ACH) to their bank account, set up once on the payout profile page through a secure bank connection by Stripe (Advantage.Bid never sees the full account number). A mailed check is also available if the seller prefers. Settlements are reviewed by Advantage.Bid before payment, and payment is not released while a settlement is on hold or a payment dispute is open.',
      `Sellers can see their settlements at ${SITE}/seller-settlements.html and set up payouts at ${SITE}/payout-profile.html.`,
      'Advantage.Bid processes eligible seller payouts every Thursday. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout. For Storefront fixed-price sales, the weekly cutoff is Wednesday at 11:59 PM, with eligible sales processed on Thursday.',
      'Say payouts are "processed" on Thursday; never promise the funds arrive in the bank that day (bank processing time varies). Payouts can be held while payment, pickup, a dispute, verification or banking details are unresolved; for a specific late or missing payout, hand the conversation to the team.',
    ],
  }),
  storefront: (p) => ({
    source: 'marketplaceOrderService.STOREFRONT_FEE_BPS / seller agreement §6.9 / launchGuards',
    facts: [
      'Professional Sellers can have a public storefront and list fixed-price items. Unsold auction lots can be moved to the storefront in one click; the item\'s pickup location carries over.',
      `Storefront items use the seller's confirmed storefront pickup location unless the seller sets a different location for an item. Buyers see only city and state before purchase.`,
      marketplaceCheckoutEnabled() ? 'Online checkout ("Buy Now") for storefront items is available.'
        : 'Online checkout ("Buy Now") for storefront items is not available yet. Interested buyers can contact the seller through the storefront.',
      storefrontFeeText(),
      `Keep the storefront fee separate from Professional Seller AUCTION fees (platform fee per agreement + ${pct(p.processingBps)} processing on the hammer price); never combine them.`,
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
/**
 * Pricing that new auctions actually use. The payment-processing fee is admin-editable and frozen onto each auction at
 * publication from pricingConfig.currentProcessingBps(), so Sasha reads it from there (getCurrentFacts). The individual
 * buyer's premium and the storefront fee are enforced from code constants, which the facts already read.
 */
const CODE_PRICING = { processingBps: billing.DEFAULT_PROCESSING_FEE_BPS };

function getFacts(topic, pricing = CODE_PRICING) {
  const names = topic === 'all' || !TOPICS[topic] ? TOPIC_NAMES : [topic];
  const out = {};
  for (const n of names) { try { out[n] = TOPICS[n](pricing); } catch (e) { out[n] = { source: 'unavailable', facts: [] }; } }
  return out;
}

/** Same facts with the CURRENT admin pricing (falls back to the code defaults if pricing cannot be read). */
async function getCurrentFacts(topic) {
  let processingBps = CODE_PRICING.processingBps;
  try { processingBps = await require('../../pricingConfigService').currentProcessingBps(); } catch (_e) { /* code default */ }
  return getFacts(topic, { processingBps });
}

module.exports = { getFacts, getCurrentFacts, TOPIC_NAMES };
