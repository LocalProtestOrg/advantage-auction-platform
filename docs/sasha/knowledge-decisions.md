# Sasha knowledge decisions: Owner rulings on the knowledge-audit contradictions

These are the authoritative answers Sasha may rely on, recorded one decision at a time.
- Nothing here changes production code, settlement, legal documents or public pages by itself. Each follow-up change needs its own approval.
- Legacy terms on previously published auctions are never changed retroactively.

## Decision 1: Seller fees for auctions (approved 2026-09-27)

**Fee schedule (keep what the code already does)**
- **Individual sellers** (private, business, other, untyped):
  - 0% platform fee;
  - 3% payment-processing fee on the hammer price, deducted from the payout;
  - Advantage.Bid receives the 18% buyer's premium.
- **Professional sellers** (auction_house, estate_sale_company, professional_liquidator):
  - platform fee defaults to 4% and is adjustable per seller;
  - 3% payment-processing fee on the hammer price;
  - the seller sets and keeps their own buyer's premium.

**Legacy auctions:** auctions already published under the legacy model keep their legacy settlement terms. There is no retroactive recalculation.

**Public language (a separate, approved-later page change)**
- Remove "at launch" from fee statements.
- State the individual fee precisely: 3% of the hammer price.

**Professional fees, public:** do NOT advertise a standard percentage. Say that fees are established in each Professional Seller agreement.

**What Sasha may say**
- Individual seller fees: yes.
- Professional fees: only that they are set in the seller's agreement.
- A specific professional seller's rates: only to that seller, after proper identity verification (for example, logged-in chat).

## Decision 2: Buyer's premium (approved 2026-09-27)

**Policy (keep what the code already does)**
- **Individual-seller auctions:** a fixed 18% buyer's premium, kept by Advantage.Bid.
- **Professional-seller auctions:** the seller configures a premium between 0% and 25%. It defaults to 18% when not configured, and the professional seller keeps it.

**Historical terms:** historical auction and invoice terms are preserved.

**Public, buyer-facing wording**
- Stay neutral about who receives the premium.
- Always show the actual premium for the specific auction or lot.

**Worked example:** a $100 winning bid plus an 18% premium equals $118, before any applicable sales tax. Always label it as an example, not a promise that every auction charges 18%.

**What Sasha may say**
- The general explanation above.
- The rate for a specific lot or auction, read from live data only.
- Nothing about who receives the premium, when talking to buyers.

## Public-content corrections applied for Decisions 1 and 2

Branch content/fee-premium-accuracy.
- Seller pages: faq, how-it-works, how-sellers-get-paid (including meta, Open Graph and Twitter descriptions), seller-faq, seller-pilot, start-selling, and seller-create (professional hint).
- Buyer pages: buyer-faq and how-to-buy.
