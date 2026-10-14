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
  bidding: (p = {}) => ({
    source: 'bidService / bid-increment ladder / biddingWindow',
    facts: [
      'Bids are placed in whole dollars. The minimum next bid is the current bid plus the increment for that price (or the starting bid if there are no bids).',
      'Increment ladder (by current price): ' + ladderText().join('; ') + '. An auction run by a Professional Seller (or Advantage.Bid) can use a fixed increment instead, and the lot page always shows the exact next minimum bid.',
      'Every bid works as a maximum bid (bidService: a bid amount is treated as a max bid equal to that amount): the system bids only as much as needed to keep the bidder in the lead, up to the amount entered, so a bidder may win for less than the amount they entered but never pays more than it (plus the buyer\'s premium and any applicable tax). The bid is still binding up to that amount.',
      'Maximum bids (proxy bidding): you can set a max bid and the system bids for you only as much as needed to keep you in the lead, up to your max. The winning bid is usually one increment above the next-highest bid or maximum (never above your max), and the buyer\'s premium and any applicable sales tax are added on top of the winning bid. Prefer explaining without made-up numbers; if you give an example, use the increment ladder above and mention the buyer\'s premium. Never state a specific next bid, current price or amount for a real lot unless get_auction_or_lot just returned it (it returns next_minimum_bid); otherwise say the lot page shows the exact next minimum bid.',
      'Soft close / anti-sniping: each lot closes on its own time (lots close in a staggered sequence, about one minute apart). Any bid placed with 2 minutes or less remaining extends THAT lot by 2 minutes, and this can repeat. The trigger is always 2 minutes or less, whatever time the caller mentions (a bid with one minute left, or 30 seconds left, extends that lot by 2 minutes). Say it as the rule, for example "any bid placed in the last two minutes extends that lot by two minutes", never as "one minute or less".',
      'You can bid once an auction is published (approved); lots stop taking bids when they close.',
      'Bidder privacy (owner decision 2026-10-12): your identity isn\'t publicly displayed to other bidders while you\'re bidding. Never say bidding is anonymous: Advantage.Bid knows who each bidder is, and authorized parties may have access to information needed to administer an auction or transaction. Never reveal anything about another bidder.',
      `To bid you need an account, to accept the current Buyer Terms, to add a debit or credit card, ${p.phoneRequiredToBid ? 'to verify your mobile number, ' : ''}and to register for that auction (acknowledging its pickup terms).`,
      'Bids are binding (Terms of Service section 10): placing a bid is an irrevocable offer to buy the lot at that amount plus the buyer\'s premium, taxes and any applicable fees, and a bidder cannot cancel, retract, lower or change a bid after submitting it. Sasha cannot cancel bids, but never say Advantage.Bid or its staff cannot: Advantage.Bid may reject or cancel bids in its sole discretion (for example error, fraud or a platform malfunction), so if a caller believes a bid was placed because of a platform problem, take a message for the team to review it, without promising any outcome.',
    ],
  }),
  buyer_premium: () => ({
    source: 'billingTermsService.effectiveBuyerPremiumBps (frozen per auction at publication)',
    facts: [
      `A buyer's premium is a percentage added to the winning bid (hammer price). The rate is set per auction and shown on the auction and lot pages before you bid.`,
      `Individual-seller auctions use a fixed ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)} buyer's premium. Professional Sellers set their own buyer's premium for their auctions under their seller agreement and platform permissions, so it varies by seller and auction (owner policy 2026-10-14).`,
      `Professional Seller buyer's premium: never state a minimum, maximum, typical range, standard or default rate (never "18% to 25%", never "up to 25%"). For a specific auction, give that auction's published premium from get_auction_or_lot. If you cannot verify it, tell the caller the rate is shown in that auction's terms on the Advantage.Bid website, or offer to take a message for the team.`,
      `Example (example only; always check the specific auction): a $100 winning bid with an ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)} premium totals ${usd(10000 + billing.DEFAULT_BUYER_PREMIUM_BPS)} before any applicable sales tax.`,
      `For a specific auction or lot, look up its actual rate (tool: get_auction_or_lot) rather than assuming ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
      "Do not tell buyers who receives the premium.",
      `For INDIVIDUAL Sellers (owner decision 2026-10-12): you may explain that the ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)} buyer's premium is a buyer-facing Advantage.Bid fee, paid by the buyer on top of the winning bid, and that it does not come out of the Individual Seller's proceeds (their payout is based on hammer prices). Never apply this to Professional Sellers: they set their own buyer's premium and keep it, under their own Professional Seller rules and agreement.`,
    ],
  }),
  payment: () => ({
    source: 'paymentService / combinedInvoiceService / cardService',
    facts: [
      'Only debit and credit cards are accepted. Prepaid cards are refused.',
      'Adding a card does not charge you: the bank checks the card when it is saved (a temporary authorization may appear and disappear). Advantage.Bid does not charge anything to verify a card.',
      'When an auction closes, each winning buyer gets ONE combined invoice for everything they won in that auction (winning bids + buyer\'s premium + any applicable sales tax), and the card on file is charged automatically. Buyers do not review or approve the total before that automatic charge; the invoice shows the breakdown, including any sales tax. So if a caller asks whether they will see the total or the tax before paying: before bidding they can see the lot price and the auction\'s buyer\'s premium rate; the invoice with any sales tax is created and charged automatically when the auction closes, and they can view it afterwards on their Invoices page. Never say they will see or approve the exact amount before it is charged.',
      'If the automatic charge fails (for example a decline), the invoice shows "payment required" and you can pay it from your invoices page with the same or another card; reminders are sent.',
      `Invoices: ${SITE}/invoices.html. Payment card: ${SITE}/add-card.html.`,
      'Sales tax, where it applies, is calculated for the place of sale (the pickup location, or the shipping address for shipped items) and shown on the invoice.',
      'Tax questions: you are not a tax advisor. You may explain how Advantage.Bid handles tax on its invoices (above). Never state general tax or legal conclusions, such as whether new or used items are taxable, why a particular item was taxed, whether a seller must register, collect, file or "manage" sales tax, or whether income is taxable. For those, say you don\'t want to give them incorrect information, suggest a tax professional, and offer to take a message if they need Advantage.Bid to review a specific invoice.',
      'Sales tax license, permit or registration questions (for example "Do I need a sales tax license to sell?"): never answer yes or no. Say you\'re not a tax advisor and don\'t want to give them incorrect information, and suggest they check with a tax professional. You may add only that sales tax is never part of seller proceeds. Never say Advantage.Bid collects, remits or "handles" tax for the seller, at checkout or otherwise.',
      'What buyers pay: the winning bid, plus that auction\'s buyer\'s premium, plus any applicable sales tax. Buyers never pay the payment-processing fee: that is a SELLER fee deducted from seller proceeds, for Individual and Professional Sellers alike. Other buyer fees apply only in specific situations listed in Terms of Service Schedule A (for example an approved alternative pickup, a failed or reversed payment, a chargeback, or items left behind); do not present them as standard fees.',
      'Tax-exempt buyers (Terms of Service section 17 / account page): a buyer can upload a sales tax exemption certificate under Sales Tax Exemption on their account page. Uploading alone does not make purchases exempt: Advantage.Bid reviews it first, and an approved exemption applies to applicable purchases going forward. Sasha cannot remove tax from an invoice.',
    ],
  }),
  buyer_policies: () => ({
    source: 'Terms of Service sections 9, 10, 17, 25 and Schedule A (terms.html)',
    facts: [
      'Condition (Terms of Service section 9): all items are sold as is, where is, with all faults, with no guarantee unless expressly stated in writing. Advantage.Bid does not provide warranties on items. Buyers should review the lot description and photos before bidding and inspect items at pickup.',
      'Refunds (Terms of Service section 25): all sales are final except as expressly allowed by Advantage.Bid. A refund may be considered only where Advantage.Bid determines there was a material misrepresentation in the lot description. No refund is issued for ordinary wear, condition visible in the photos, change of mind, failure to inspect, failure to pick up, inability to transport, mistaken bidding or delayed notifications. Requests must be made promptly, within the period in the auction terms or invoice, or if none is stated, before leaving the pickup location. Never promise a refund: take a message for the team to review a specific case.',
      'Shipping (Terms of Service section 23; owner decision 2026-10-12): shipping is available only when the auction or lot listing expressly offers it, so it depends on the individual listing; items without shipping are collected at pickup. When shipping is offered, shipping and handling costs are the buyer\'s responsibility unless the listing says otherwise. Never make a blanket promise such as "ships nationwide" and never imply every item can be shipped. Tell the caller to check that item\'s listing, or use current listing data from your tools when you have it. Do not say who packs, ships or arranges shipping beyond what the listing says.',
      'Item condition: never say how condition is usually disclosed or what photos typically show. Point to that lot\'s own description and photos, and the as-is rule above.',
      'Payment disputes (Terms of Service section 19): the Terms ask buyers to contact Advantage.Bid before starting a chargeback or payment dispute, so the team can look into it. If a caller mentions a chargeback, stay calm, take a message for the team about their issue, and give no advice about disputes or how they compare with other options.',
      'Advantage.Bid does not currently offer price matching. No Advantage.Bid source describes buyer insurance, purchase protection plans or extended warranties: if asked, say you don\'t have any information on that and offer to take a message for the team; do not claim they exist and do not invent a replacement.',
    ],
  }),
  pickup: () => ({
    source: 'Terms of Service sections 20, 22, 24 (terms.html) / buyer FAQ (buyer-faq.html, how-to-buy.html) / sellerTypeRules / location privacy rule',
    facts: [
      'Each auction has a pickup window set by the seller and shown with that auction. Winners collect their items during that window at the pickup location. When a buyer asks when pickup is, include that for Individual Seller auctions pickup begins at least 48 hours after the auction closes (Professional Sellers set their own timing).',
      'What to bring (Advantage.Bid policy, owner decision 2026-10-12): every buyer should bring valid legal identification and a copy of their payment confirmation to pickup. Whether and how ID is actually checked is up to the seller or pickup operator running that pickup, so never say ID definitely will or definitely will not be checked. The seller or pickup operator may also ask for the credit card used for the purchase or auction-specific documentation (Terms of Service section 20).',
      'Someone else collecting (buyer FAQ; Terms of Service section 20): allowed. REQUIRED: a written authorization from the buyer and a copy of the buyer\'s payment confirmation, and the buyer should contact Advantage.Bid support in advance. The person collecting should bring their own valid legal identification.',
      'Seller type for a pickup: use the seller category that get_my_pickup_details returns ("Individual Seller" or "Professional Seller") and its pickup_rule. Never guess or state a seller type that a tool did not return.',
      'Pickup instructions and appointments: after payment, the buyer receives the pickup information and instructions for that purchase. Whether an appointment is required, offered or scheduled depends on that auction\'s or event\'s pickup instructions, so never say appointments are always automatic, always optional or merely a courtesy. When a tool returns the buyer\'s actual pickup details or time slots, use those instead of a general answer.',
      'Loading and removal (Terms of Service section 20): the buyer is responsible for pickup, removal, loading, packing, tools, equipment, labor and transportation. Advantage.Bid and sellers are not required to provide tools, packing materials, loading assistance, labor or moving equipment, so bring enough help for large or heavy items.',
      'INDIVIDUAL Seller auctions (owner decision 2026-10-12): the published pickup date and pickup window are part of the terms of the purchase and are final. Buyers are responsible for reviewing the pickup information before bidding and for collecting their items during the published pickup period. Missing it does not by itself give a right to another pickup time, a cancellation, a refund or a reversal of the purchase, and it does not mean the items were unavailable or not received. A recommended arrival time within the window never creates a right to pick up outside the published window. Professional Seller auctions follow that seller\'s published pickup terms.',
      'Buyer having trouble making pickup: say naturally that the published pickup time is the agreed pickup period (final for Individual Seller auctions), and offer to ask the seller whether they are able to help. For a VERIFIED buyer with a PAID purchase, use contact_seller_about_pickup (it sends the seller a request; it is never an extension or an entitlement). Share the buyer\'s name and callback number with the seller only if the buyer explicitly agrees. If the caller is not verified, verify first; if the tool cannot be used, take a message for the Advantage.Bid team (request_callback). Never promise that the seller will accommodate, extend pickup, be available later, waive a fee or give a refund, and never promise a response time. If a seller agrees to something different, that is the seller\'s voluntary accommodation, not a change to the pickup terms.',
      'Missed pickup (Terms of Service section 22): items not collected during the published pickup window may be treated as abandoned and forfeited without a refund. Under the Terms, Advantage.Bid or the seller may, but is not obligated to, offer an alternative pickup time, and an alternative pickup fee may apply; for Individual Seller auctions the published window is final. Do not add anything about who decides beyond this.',
      'Inspection (Terms of Service section 24): inspect items before leaving the pickup location; leaving with an item counts as accepting it.',
      'Anything beyond these Advantage.Bid policies is set by each seller and published with that auction\'s pickup details. Tell the customer to check that auction\'s published pickup details; do not guess or give examples of what a seller might require.',
      `For individual (non-professional) sellers, pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Professional sellers set their own pickup timing (never before the auction closes). State it as the rule only: no Advantage.Bid source gives a reason for it, so never give one (it is not about giving buyers time to pay; winning buyers' cards are charged automatically at close).`,
      'Which purchase an item belongs to: never assume. Match the item the caller names to the items_won listed on each invoice (get_my_invoices), or to get_my_bids. If it is on an unpaid invoice, say the full pickup address is shared after payment, give the amount due, and offer the secure payment link. Read pickup times exactly as the _local value; never round them.',
      'Before payment, listings show only the city and state. The full pickup address is sent to the winning buyer by email after their payment succeeds (the pickup email from Advantage.Bid). It is not printed on the invoice or shown on the auction page. A signed-in buyer who has paid can also ask Sasha for it.',
      'Never give a pickup street address, ZIP code or coordinates to anyone who has not paid for that item (look it up only with get_my_pickup_details for the signed-in buyer).',
    ],
  }),
  selling: () => ({
    source: 'auctionService.MIN_LOTS_FOR_SUBMISSION / routes/lots.js professional-only lot settings / sellerTypeRules / seller agreement gate',
    facts: [
      `SELLER TYPES: the rules differ, so know which one you are answering for. Professional Sellers are ${PROFESSIONAL_SELLER_TYPES.join(', ')} (businesses that run sales, approved by Advantage.Bid). Everyone else (private individuals, other businesses) is an Individual Seller.`,
      `BOTH seller types: create an auction, add lots (title, description, photos, category and size category), set dates, pickup window and pickup location, choose 3 featured lots. The seller agreement must be signed first. Every auction needs its full pickup address before submission; buyers see only city and state until they pay.`,
      `MINIMUM LOTS: every auction needs at least ${MIN_LOTS} lots to be submitted or published (withdrawn lots don't count). State it simply as the rule. Combining items into one lot LOWERS the number of lots, so grouping never helps anyone reach ${MIN_LOTS}: never present it as a way to meet or close the gap to the minimum. Grouping is only a listing tip for items that naturally belong together (for example a matching set of dishes or a set of chairs). Do not mention exceptions, waivers, workarounds or staff approval at all (not even to say there are none or that you cannot make one), and never suggest contacting staff about it. Do not suggest any way around the minimum either (no consigning through another company, no combining with someone else, no "there's no way around it").`,
      'NO SALE GUARANTEE (both seller types): never agree that everything sells, that a particular item will sell, or that it will reach any price, even when the caller says it as a fact ("Everything always sells, right?"). Say that no item is guaranteed to sell or to sell for any particular price; a lot sells only if someone bids on it. For an Individual Seller you may add that their lots start at $1 with no reserve. Do not apply Individual Seller rules to a seller whose type you don\'t know.',
      'DIMENSIONS: measurements are optional, but highly recommended for anything where size matters (furniture, rugs, artwork, mirrors, appliances): they help buyers bid with confidence and plan pickup, and make the listing stronger. The size category is always required.',
      'CREATING LOTS IS EASY (both seller types): a seller can start a lot simply by taking photos of the item with their phone (up to 20 photos per lot). The Smart Description tool can then suggest a title, a short description and a category from the photos, which the seller reviews and adjusts before saving, and photo enhancement can automatically clean up the background, crop and brighten the photos. Each lot is created individually (there is no one-photo-per-lot bulk upload). Never call these tools AI, and never say they write the whole listing without the seller reviewing it.',
      `INDIVIDUAL Sellers only: every lot starts at $1 and bidding follows the standard Advantage.Bid increment ladder. Individual sellers do NOT set starting bids, reserves or custom bid increments. The buyer's premium is a fixed ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}. Pickup must begin at least ${sellerTypeRules.NON_PRO_MIN_PICKUP_GAP_HOURS} hours after the auction closes. Final submission is single-use and locks editing; Advantage.Bid reviews and publishes the auction.`,
      'LISTING REVIEW (owner decision 2026-10-12): Advantage.Bid does not manually review, verify, authenticate, inspect or approve every individual lot. Individual Seller auctions go through Advantage.Bid\'s review before publishing as part of their workflow; Professional Sellers publish and manage their own listings and inventory, subject to platform rules and Advantage.Bid\'s moderation rights. Never imply that a listing is endorsed, authenticated, inspected or guaranteed by Advantage.Bid, and never state a review time.',
      `PROFESSIONAL Sellers only: once their business is verified they can publish their own qualifying auctions and keep editing. They can set per-lot starting bids, reserves and custom bid increments, set their own buyer's premium and keep it, and set their own pickup timing (never before the auction closes).`,
      'STOREFRONTS (owner decision 2026-10-12): online Storefronts, with fixed-price inventory and Buy Now, are a Professional Seller feature only. Individual Sellers do not have Storefronts and cannot sell fixed-price items; say simply that Storefronts are a Professional Seller feature.',
      'SHIPPING for sellers (owner policy 2026-10-12): Professional Sellers may choose whether their listings offer shipping and are responsible for fulfilling it. Individual Sellers do not offer shipping unless Advantage.Bid specifically enables or approves it for that seller or listing. Never say who packs, ships or arranges shipping beyond this.',
    ],
  }),
  seller_benefits: (p) => ({
    source: 'marketplaceVisibility / public feeds + BD widgets / shareMeta + sitemap / Smart Description + image processing / bidService / combined invoicing + Stripe / settlementEngine + payout profile / sellerTypeRules / widgetService / storefrontService / launchGuards',
    facts: [
      'WHY SELL WITH ADVANTAGE.BID, BOTH seller types (only these; never invent guarantees, traffic numbers or sales results):',
      'Easy listing: start each lot by taking photos with a phone; Smart Description suggests the title, description and category, and photos can be cleaned up automatically.',
      `Marketing and exposure: every published auction is automatically listed on the Advantage.Bid marketplace (browse, map, ending-soon and featured listings) and on Advantage.Bid's public website through live listings, with search-engine-friendly auction and lot pages. ${p.endingSoonReminder === false ? '' : 'Bidders who watch a lot get an ending-soon reminder, and '}${p.endingSoonReminder === false ? 'O' : 'o'}utbid bidders are emailed so they come back to bid.`,
      'Competitive online bidding: bidders compete in real time and can set a maximum bid that bids for them automatically; a bid in the last two minutes extends that lot by two more minutes (soft close), so interested bidders always get a chance to respond; and lots close one at a time, about a minute apart.',
      'INDIVIDUAL Sellers and price: never say or imply that bidding protects their prices, sets a minimum price, guarantees a sale amount, or works like a reserve. Their lots start at $1 with no reserve and sell to the highest bidder when the lot closes. Reserves and starting bids are Professional Seller controls only. If an Individual Seller worries an item could sell for very little, be honest and kind: there is no minimum, and a lot sells to the highest bidder even if that is $1. Do not reassure them with competition, marketing, the soft close or "items find their price" (no "you won\'t leave money on the table", no "there\'s no risk of it going lower, bidding only goes up"); you may suggest they think about which items they want to include.',
      'Payments handled for you: winning buyers are invoiced and their card on file is charged automatically when the auction closes, so the seller never has to chase or collect payments.',
      'Getting paid: after pickup, Advantage.Bid prepares the settlement and pays by direct deposit (a mailed check is also available); payouts are processed weekly on Thursdays.',
      'Pickup is organized: after paying, each buyer receives the pickup information and instructions for their purchase, and the full address is shared only after a buyer has paid.',
      `INDIVIDUAL Sellers in particular: no commission and nothing to pay upfront to list, only a ${pct(p.processingBps)} processing fee on what sells; lots start at $1 with no reserves to set, so there is nothing to price; Advantage.Bid reviews the auction before publishing it.`,
      `PROFESSIONAL Sellers in particular (lead with the seller's own business benefit): once verified they publish their own auctions without waiting for review and keep editing; they control their own starting bids, reserves, bid increments, buyer's premium (which they keep) and pickup timing; they get a public business storefront page with fixed-price items, including moving unsold lots there in one click; and they can add their live auctions to their own website with an embeddable auction widget, so the same auctions appear on their site and on the Advantage.Bid marketplace at the same time. Their platform fee is set in their own agreement: never quote a standard percentage. Storefront items support Buy Now (fixed-price purchase) as a platform capability.`,
      'Do NOT mention: neighborhood "Sales Near You" emails, paid promotion packages, social media posting or ads (not offered to callers as a standard benefit), or any number of bidders, visitors or sales.',
    ],
  }),
  seller_fees: (p) => ({
    source: 'billingTermsService / settlementPolicy / owner decision 1 (fee reconciliation pending for professional rates)',
    facts: [
      `Individual sellers: no platform fee; the standard ${pct(p.processingBps)} payment-processing fee on the hammer price is deducted from the payout. The buyer's premium on individual auctions is ${pct(billing.DEFAULT_BUYER_PREMIUM_BPS)}.`,
      `Professional Sellers: the platform fee is set in each seller's Professional Seller agreement (it can differ by seller), plus a ${pct(p.processingBps)} payment-processing fee on the hammer price (for a Selected Auction Partner, processing is passed through at actual cost instead). Professional Sellers set and keep their own buyer's premium.`,
      'Fee wording: never give reasons for how a fee or price is set (for example volume or business size) and never say a fee applies "regardless" or "always": these are the standard fees, and Selected Auction Partners have their own published processing terms.',
      'Never quote a standard or default Professional Seller platform-fee percentage, and never reveal another seller\'s rate. If a prospective Professional Seller asks what their platform fee would be, explain naturally that Professional Seller pricing is established for each seller in their agreement, and offer to take a message so the Advantage.Bid team can follow up. A verified existing Professional Seller can be told their own terms (tool: get_my_seller_terms), using only what it returns.',
      'Auction terms are fixed when the auction is first published; later changes never apply retroactively.',
      'Sales tax and sellers: sales tax is never part of seller proceeds. Whether a seller needs a sales tax license, permit or registration, or must collect, file or remit tax, is a tax question: never answer it yes or no and never say Advantage.Bid handles it for them. Say you\'re not a tax advisor and suggest a tax professional.',
    ],
  }),
  payouts: () => ({
    source: 'Seller agreement §7.3 payout schedule (Owner decision 2026-09-28) / settlementEngine',
    facts: [
      'After an auction closes and buyers pay, Advantage.Bid prepares a settlement for the seller: collected sales minus the applicable fees (sales tax is never part of seller proceeds).',
      'HOW SELLERS GET PAID (mention this whenever you explain payouts, without waiting to be asked): by direct deposit (ACH) to their bank account, set up once on the payout profile page through a secure bank connection by Stripe (Advantage.Bid never sees the full account number). A mailed check is also available if the seller prefers. Settlements are reviewed by Advantage.Bid before payment, and payment is not released while a settlement is on hold or a payment dispute is open.',
      `Sellers can see their settlements at ${SITE}/seller-settlements.html and set up payouts at ${SITE}/payout-profile.html.`,
      'Advantage.Bid processes eligible seller payouts every Thursday. Auction sales become eligible for the first Thursday after pickup or fulfillment is completed and the transaction is otherwise eligible for payout. For Storefront fixed-price sales, the weekly cutoff is Wednesday at 11:59 PM, with eligible sales processed on Thursday.',
      'Say payouts are "processed" on Thursday; never promise the funds arrive in the bank that day (bank processing time varies), and never characterize how fast money arrives ("usually quick", "a day or two"). When asked whether money will arrive on a given day, say: processed on the first Thursday after the sale becomes eligible (after pickup is completed), paid by direct deposit or a mailed check, and the bank\'s timing varies, so you can\'t promise the day. Payouts can be held while payment, pickup, a dispute, verification or banking details are unresolved; for a specific late or missing payout, hand the conversation to the team.',
    ],
  }),
  storefront: (p) => ({
    source: 'marketplaceOrderService.STOREFRONT_FEE_BPS / seller agreement §6.9 / launchGuards',
    facts: [
      'Storefronts are a Professional Seller feature only; Individual Sellers do not have Storefronts.',
      'How a storefront purchase is paid for: do not describe it (storefront checkout is being finalized). Never say storefront purchases are charged to the card on file like auction purchases, never walk a caller through storefront checkout, and never offer a payment link for a storefront item (payment links are only for unpaid auction invoices). If asked how to pay for a storefront item, say the item\'s listing shows how it can be purchased, or they can contact the seller through the storefront.',
      'Professional Sellers can have a public storefront and list fixed-price items. Unsold auction lots can be moved to the storefront in one click; the item\'s pickup location carries over.',
      `Storefront items use the seller's confirmed storefront pickup location unless the seller sets a different location for an item. Buyers see only city and state before purchase.`,
      'Buy Now (owner decision 2026-10-12): Buy Now is an Advantage.Bid platform capability for Professional Seller storefront and marketplace fixed-price items, according to the listing and the seller\'s configuration. You may explain that the capability exists. Never tell a caller that a particular item can be bought online right now unless current listing or tool data shows it; otherwise tell them to check that item\'s listing, or to contact the seller through the storefront.',
      storefrontFeeText(),
      `Keep the storefront fee separate from Professional Seller AUCTION fees (platform fee per agreement + ${pct(p.processingBps)} processing on the hammer price); never combine them.`,
    ],
  }),
  account: (p = {}) => ({
    source: 'site navigation',
    facts: [
      `Sign in / create an account: ${SITE}/login.html. Account and dashboard: ${SITE}/app.html.`,
      'Signing up: say they can create an account on the Advantage.Bid website (Sign in / create an account). Do not list what the signup form asks for or what they can do right after signing up beyond the bidding requirements above.',
      'Creating an Advantage.Bid account is free (owner decision 2026-10-12). Purchases are not: winning bids are invoiced for the hammer price, the buyer\'s premium, applicable sales tax and any transaction-specific amounts.',
      'Forgot password (live flow): on the sign-in page choose "Forgot your password?", enter the account email and choose "Send reset link". An email titled "Reset your Advantage.Bid password" arrives with a link that works once and expires after 60 minutes; the link opens a page to choose a new password of at least 8 characters ("Update password"). The page never says whether an account exists for that email. Sasha cannot reset or change passwords.',
      `Buyers: invoices ${SITE}/invoices.html; add or change a card ${SITE}/add-card.html.`,
      p.auctionTextAlerts ? 'Notification preferences, including opting in to auction text alerts, are in the account settings.' : 'Email notification preferences are in the account settings. There is no text-alert setting to turn on right now.',
      `Sellers: create an auction ${SITE}/seller-create.html; seller dashboard ${SITE}/seller-dashboard.html; storefront ${SITE}/seller-storefront.html; settlements ${SITE}/seller-settlements.html.`,
      'Changing account details (email address, name, phone number): you can\'t make account changes on a call. Say that plainly and offer to take a message for the Advantage.Bid team. Never give a reason (no "for security reasons") and never describe a review, check or process the team follows.',
      'Watchlist/favorites let buyers save lots; Follow lets buyers follow a seller to hear about their new auctions. Do not describe icons, buttons, where options appear or what else these pages show; just say they can save lots to their watchlist on the Advantage.Bid website. Never say where the option is or what it looks like (no "on the lot page", "right there on the page", a heart, star or button).',
      ...(p.endingSoonReminder === false ? [] : ['Ending-soon reminder: a buyer who has saved a lot to their watchlist, or bid on it, gets one email reminder shortly before that lot closes.']),
      p.auctionTextAlerts ? 'Outbid alerts: a bidder who is outbid gets an email, and a text only if they have opted in to auction text alerts in their notification preferences.'
        : 'Outbid alerts: a bidder who is outbid gets an email. Auction text alerts are not being sent at this time, so do not tell anyone they will get outbid or reminder texts, and do not suggest turning text alerts on. If asked how to get text alerts, or how to turn them back on after replying STOP: say auction text alerts are not being sent right now, and outbid and reminder emails continue.',
      p.auctionTextAlerts ? 'SMS notifications are opt-in only.' : 'Auction text alerts are not available right now, so there is nothing to sign up for, opt in to, turn on or turn back on (not in account settings or anywhere else). If someone asks to sign up for texts, say auction text alerts aren\'t available right now and outbid and reminder emails continue. Never sign anyone up for texts by phone.',
      'Texts and STOP: replying STOP to an Advantage.Bid text stops alert texts to that number. Do not describe other uses of text messages beyond these rules, and never tell someone how to turn texts back on unless auction text alerts are available. If a caller asks about verification codes after replying STOP, offer to send the code by email instead.',
    ],
  }),
  contact: () => {
    const c = require('../../../lib/companyContact');
    return {
      source: 'src/lib/companyContact.js (owner decision 2026-10-12: public office hours)',
      facts: [
        `Advantage.Bid regular office and support hours: ${c.OFFICE_HOURS}. Phone ${c.PHONE_DISPLAY}; email ${c.SUPPORT_EMAIL}.`,
        'Staff are available during those hours. Never imply that staff are available at other times, and never invent other hours. You (Sasha) may answer calls at other times; that is not staff availability, so never say help is available "anytime, day or night".',
        'There is no live transfer to a person on a call; you can take a message for the team. Do not say anything about an office location, visiting in person or other contact channels beyond these facts. If asked about an office or visiting, say you don\'t have an office address to share, and give the phone number, email and hours above. Don\'t characterize how Advantage.Bid operates (no "we handle everything by phone and email", no "we\'re online only").',
      ],
    };
  },
  programs: () => ({
    source: 'auction-partner.html / promote-estate-sale.html + estateSalePromotionService / appraiser-membership.html + www.advantage.bid directory',
    facts: [
      'Advantage.Bid Auction Partner Program (always use this name; if the caller calls it something else, such as "Founding Partner", do not repeat their term: just say "That\'s our Advantage.Bid Auction Partner Program"; a participating company is a Selected Auction Partner): an invitation-only program for selected established estate sale companies and professional liquidators who want to add online auctions to their business. Published terms: a 0% Advantage.Bid auction platform fee on qualifying auctions during the one-year program term; the partner sets and keeps their buyer\'s premium; payment processing is passed through at actual cost with no Advantage.Bid markup; their auctions are listed on the Advantage.Bid marketplace and can also appear on their own website. Explain it only when asked. Do not pitch it, do not promise an invitation or eligibility, and do not quote other terms. If a business is interested, offer to take a message for the Advantage.Bid team (request_callback).',
      'Estate Sale Promotion: Advantage.Bid does not currently offer a paid Estate Sale Promotion (owner decision 2026-10-12). Do not describe, promote or quote any price for it; if asked, say it is not currently offered.',
      'Discounts (verified 2026-10-12): Advantage.Bid does not currently offer discounts, promo codes or fee waivers; say "currently" and never suggest one exists. The invitation-only Advantage.Bid Auction Partner Program has its own published terms (see above). Individual Sellers pay no listing fee at all.',
      'Services not currently offered (verified 2026-10-12): Advantage.Bid does not currently offer in-home or on-site photography, item pickup or storage for sellers, or price matching. Say "currently"; sellers photograph and list their own items.',
      'Directory: the Advantage.Bid website (www.advantage.bid) has a directory of businesses and professionals where people can find estate sale companies, auction companies and appraisers. Sellers do not list items in the directory. Appraisers can join with an Appraiser Membership ($19.99 per year), which lists their practice in the appraiser directory. Advantage.Bid itself does not provide appraisals.',
      'Do not state anything about Advantage.Bid\'s history, founding date, years in business, size, staff or statistics (bidders, visitors, sales). If asked, say you don\'t have that information to share and offer to take a message for the team.',
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
  // Live switches that change what is true for customers (read the same config the enforcing code reads).
  let phoneRequiredToBid = false; let endingSoonReminder;
  try { phoneRequiredToBid = !!(await require('../../accountPhoneService').config()).required; } catch (_e) { /* not required */ }
  try { endingSoonReminder = await require('../../marketingConfigService').getBool('marketing.watcher_ending_soon.enabled', false); } catch (_e) { endingSoonReminder = false; }
  let auctionTextAlerts = false;
  try { auctionTextAlerts = !!(await require('../../smsConsentService').settings()).enabled; } catch (_e) { /* off */ }
  return getFacts(topic, { processingBps, phoneRequiredToBid, endingSoonReminder, auctionTextAlerts });
}

module.exports = { getFacts, getCurrentFacts, TOPIC_NAMES };
