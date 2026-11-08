---
id: seller-fees
status: draft (content approved by Owner decision 1 and the owner approval of 2026-11-06; awaiting article approval in the Knowledge page)
audience: sellers
sources: src/services/billingTermsService.js; src/services/storefrontChannelService.js (FEE_BPS); platform_config pricing.*; Owner decision 1 (2026-09-27); owner approval 2026-11-06
live_data: a professional seller's own rates come from their account, and only after identity verification
---
# What does it cost to sell at auction?

**Individual sellers**
- There's no platform fee and no commission.
- When an item sells, a 3% payment processing fee on the hammer price (the winning bid) is deducted from your payout.
- There are no listing, photo or setup fees.
- The buyer pays the buyer's premium on top of the winning bid.

**Professional sellers** (auction houses, estate sale companies, professional liquidators, retail shops, galleries and studios)
**Just 7% Total Seller Fees.** Our Professional Seller auction fees are just 7% total, consisting of a 4% Advantage.Bid platform fee and a 3% payment processing fee. No monthly subscription fees. No listing fees.
- Both parts apply to the hammer price (the winning bid).
- The 3% payment processing fee is Advantage.Bid's standard fee. It is not presented as the exact amount card processors charge Advantage.Bid; actual processor costs vary.
- Negotiated agreements are honored: your own Professional Seller agreement governs and can differ.
- You set your own buyer's premium and keep it.

(Approved public wording, owner 2026-11-07. The 7% is the sum of the two code values in `billingTermsService`, never a separate setting.)

Sasha may state these standard rates when asked, always adding that the seller's own agreement governs. A professional seller's own rates may be shared only with that seller, once their identity is verified. Never reveal another seller's rates.

## Professional Storefront

> status: draft (updated 2026-11-07 for Seller Agreement v4). Source: `storefrontChannelService.FEE_BPS`, seller agreement section 6.9.

- Professional Storefront fixed-price sales are separate from auction fees and have an all-in commission on the item selling price only: 5% when the sale comes through the seller's own website using the Advantage.Bid embedded storefront, and 9% when it comes through the Advantage.Bid marketplace.
- Both rates include card processing. No monthly or listing fees. Shipping and sales tax are not part of the calculation.
- A seller's own agreement governs. Storefront fees are separate from auction fees.
- Online checkout (Buy Now) for storefront items is not enabled yet. Never say storefront items can be bought online now.

Keep storefront and auction fees apart.
