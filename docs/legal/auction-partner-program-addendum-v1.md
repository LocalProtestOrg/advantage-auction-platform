# Auction Partner Program Addendum (v1, DRAFT for Owner / counsel review)

**Status:** draft wording, 2026-10-05. Not yet published as an agreement version and not yet accepted by any seller.
It supplements the Professional Seller terms of the Advantage.Bid Seller Agreement for a seller admitted to the
Auction Partner Program. Where this Addendum conflicts with the Seller Agreement for a Qualifying Auction, this Addendum
controls. Everything not addressed here is governed by the Seller Agreement unchanged.

Implementation reference: `src/services/actualProcessingService.js`, `settlementEngine.computeSettlementTotals`,
migration 186 (`auctions.processing_fee_basis`).

---

**1. Qualifying Auctions.** A "Qualifying Auction" is an auction of the Auction Partner that Advantage.Bid publishes while
the Auction Partner's program terms are in effect. The terms in force when an auction is published apply to that auction
for its whole life, even if the Auction Partner's program terms later change or end.

**2. Platform fee.** Advantage.Bid charges **0%** Advantage.Bid auction platform/software fee on Qualifying Auctions.
This replaces, for Qualifying Auctions only, the Professional Seller platform/software fee described in the Seller
Agreement. It does not apply to Professional Storefront sales, which keep their own separate fee.

**3. Buyer's premium.** The Auction Partner keeps the buyer's premium it sets for a Qualifying Auction, under the
existing Professional Seller rules.

**4. Payment processing.** Payment processing remains the Auction Partner's responsibility. For each Qualifying Auction,
the payment-processing charges that Advantage.Bid's payment processor actually assesses on the buyer payments collected
for that auction are deducted from the Auction Partner's proceeds. These charges are assessed on the full amount each
buyer pays, which may include the hammer price, the buyer's premium and applicable sales tax, and can vary by
transaction (for example, by card type or card origin). Advantage.Bid does **not** mark up these charges for Qualifying
Auctions. Where the processor returns any part of a charge on a refund, only the net amount actually retained by the
processor is deducted. This section replaces, for Qualifying Auctions only, the percentage processing fee described in
the Seller Agreement.

**5. Taxes.** Applicable sales taxes are collected from buyers and handled separately. They are not part of the Auction
Partner's proceeds.

**6. Settlement and payouts.** Settlement of a Qualifying Auction is completed once the actual payment-processing
charges for its buyer payments have been recorded. Advantage.Bid processes eligible seller payouts every Thursday. A
Qualifying Auction's proceeds become eligible for the first Thursday after pickup or fulfillment is completed and the
transaction is otherwise eligible for payout under the Seller Agreement. Processing on Thursday does not guarantee
the date funds arrive in the Auction Partner's bank account, which depends on banking timing.

**7. Other terms.** Refunds, disputes, holds, adjustments and every other matter are governed by the Seller Agreement.

---

**Wording rules (do not change without Owner approval):** do not state a fixed processing percentage as a contractual
guarantee; do not describe the program as "free"; describe it as a 0% Advantage.Bid auction platform/software fee with
payment processing remaining the seller's responsibility.
