---
id: seller-fees
status: draft (content approved by Owner decision 1; awaiting article approval in the Knowledge page)
audience: sellers
sources: src/services/billingTermsService.js; platform_config pricing.*; Owner decision 1 (2026-09-27)
live_data: a professional seller's own rates come from their account, and only after identity verification
---
# What does it cost to sell at auction?

**Individual sellers**
- There's no platform fee and no commission.
- When an item sells, a 3% payment processing fee on the hammer price (the winning bid) is deducted from your payout.
- There are no listing, photo or setup fees.
- The buyer pays the buyer's premium on top of the winning bid.

**Professional sellers** (auction houses, estate sale companies, professional liquidators)
- Your platform fee is set in your Professional Seller agreement.
- A 3% payment processing fee applies to the hammer price.
- You set your own buyer's premium and keep it.

Do not quote a standard professional fee percentage. A professional seller's own rates may be shared only with that seller, once their identity is verified.

## Professional Storefront

> status: draft (added 2026-09-30; the Owner approves it in Admin, Sasha Settings & Knowledge). Source: seller agreement §6.9, `marketplaceOrderService.STOREFRONT_FEE_BPS`.

- Professional Storefront fixed-price sales have a flat 11% seller fee on the item selling price.
- The 11% includes card processing. Shipping and sales tax are not part of the calculation.
- It is the same for every Professional Seller and is separate from auction fees.

Keep storefront and auction fees apart. Never quote a standard professional auction percentage.
