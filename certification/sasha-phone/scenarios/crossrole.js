'use strict';

/** Cross-role confusion: buyer vs Individual Seller vs Professional Seller vs storefront rules. */
module.exports = [
  {
    id: 'cross.premium-who-pays', category: 'cross-role', risk: 'high', route: 'seller', context: 'Individual seller confuses buyer premium',
    phrasings: [["I'm selling my own stuff.", "So you take 18% from what I make?"], ['Personal items. Does the buyer premium come out of my money?'], ["Individual seller. What's the total you keep from my sales?"]],
    must: ["the buyer's premium is paid by the buyer on top of the bid; the individual seller only has the {{processing_fee}} processing fee deducted"],
    prohibited: ['saying the seller pays the buyer premium', 'applying Individual Seller premium economics to Professional Sellers'], truthTopics: ['seller_fees', 'buyer_premium'],
    acceptable: 'Owner decision 2026-10-12: she may say the 18% premium is a buyer-facing Advantage.Bid fee that does not come out of the Individual Seller\'s proceeds.',
  },
  {
    id: 'cross.pro-vs-ind-controls', category: 'cross-role', risk: 'high', route: 'seller', context: 'Mixed questions about both seller types',
    phrasings: ["What's the difference between an individual seller and a professional seller?", 'If I become a professional seller can I set reserves?', 'Can an individual set their own buyer premium?', 'Who decides when pickup is, me or you?'],
    must: ['clearly separates individual (no reserves/starting bids, fixed {{individual_bp}} premium, {{pickup_gap_hours}}-hour pickup gap, review before publishing) from professional (own controls, own premium, own pickup timing, self-publish once verified)'],
    prohibited: ['giving individuals professional controls'], truthTopics: ['selling', 'seller_fees'],
  },
  {
    id: 'cross.buyer-asks-seller-fee', category: 'cross-role', risk: 'medium', route: 'buyer', context: 'Buyer asks about fees',
    phrasings: ['Do buyers pay any fees?', "Is the 3 percent fee something I pay as a buyer?", 'Are there hidden fees for buyers?'],
    must: ["buyers pay the winning bid plus the auction's buyer's premium and any applicable sales tax", 'the processing fee is a seller fee, not a buyer fee'],
    prohibited: ['inventing buyer fees'], truthTopics: ['buyer_premium', 'payment', 'seller_fees'],
    acceptable: 'Mentioning that situational fees in Terms Schedule A (alternative pickup, failed payment, etc.) can apply is correct if framed as situational.',
  },
  {
    id: 'cross.storefront-vs-auction', category: 'cross-role', risk: 'high', route: 'seller', context: 'Storefront vs auction fees and checkout',
    phrasings: [['I am an auction house.', 'Is the fee on storefront items the same as auctions?'], ['Can a buyer pay for a storefront item through you?'], ['Individual seller: can I list fixed-price items?']],
    must: ['storefront is a professional-seller feature with its own flat {{storefront_fee}} fee; auction fees are separate', 'Buy Now is a platform capability for storefront items; she never says a particular item can be bought online right now without current data'],
    prohibited: ['mixing storefront and auction fees', 'offering a storefront or fixed-price selling to Individual Sellers (Professional Sellers only)', 'describing storefront payment as charged to the card on file like auctions'], truthTopics: ['storefront', 'seller_fees', 'selling'],
  },
  {
    id: 'cross.pickup-rule-roles', category: 'cross-role', risk: 'medium', route: 'seller', context: 'Pickup timing by seller type',
    phrasings: [['I run an estate sale company.', 'Do we have to wait 48 hours before pickup?'], ['Personal items.', 'Can buyers pick up right after the auction ends?']],
    must: ['individual sellers: pickup at least {{pickup_gap_hours}} hours after close', 'professional sellers set their own pickup timing (never before close)'],
    prohibited: ['applying the 48-hour rule to professionals'], truthTopics: ['selling', 'pickup'],
  },
];
