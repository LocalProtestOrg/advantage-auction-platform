# Storefront purchases: Buyer Terms and seller-policy framework (DRAFT FOR LEGAL REVIEW)

Status: **not approved, not published.** Prepared 2026-11-02 at the owner's direction for counsel. This document describes
structure and what the platform already enforces. It contains **no proposed legal wording**: every place where contract
language is needed is marked `[COUNSEL TO DRAFT]`. Live storefront checkout stays off (`MARKETPLACE_CHECKOUT_ENABLED`) until
counsel approves the Buyer Terms and the owner authorizes activation.

## 1. Documents that govern a storefront purchase
| # | Document | Author | Where it lives | Recorded on each order |
|---|---|---|---|---|
| 1 | Advantage.Bid Buyer Terms (generalized to cover auctions AND fixed-price storefront purchases) | Advantage.Bid, counsel-approved | `terms_versions` (kind `buyer_terms`, one current version) | `marketplace_orders.buyer_terms_version_id` / `buyer_terms_version_int` (migration 214) |
| 2 | Platform policies the Buyer Terms incorporate (privacy, refund, pickup) | Advantage.Bid | `legal_document_versions` (`privacy_policy`, `refund_policy`, `pickup_policy`) | `[DECISION]` whether these are also versioned per order (today only the Buyer Terms version is) |
| 3 | Seller Store Terms & Conditions | the Professional Seller | `seller_policy_versions` kind `store_terms`, versioned, never rewritten (migration 203) | `policy_snapshot.store_terms` (version + text hash) |
| 4 | Seller Shipping & Pickup Policy | the Professional Seller | `seller_policy_versions` kind `shipping_pickup` | `policy_snapshot.shipping_pickup` |
| 5 | The listing itself (price, quantity, condition, shipping/pickup offer) | the seller | `marketplace_items` | `item_snapshot` incl. `shipping_terms` (units, rule, charge) |

## 2. Precedence (proposed structure, wording `[COUNSEL TO DRAFT]`)
1. Applicable law, including consumer-protection law, which neither Advantage.Bid nor a seller can waive.
2. The Advantage.Bid Buyer Terms and the platform policies they incorporate.
3. The seller's Store Terms and Shipping & Pickup Policy, **only where they do not conflict with 1 or 2**.
4. The listing details captured at purchase.

## 3. What a seller policy can never override (platform-reserved areas)
The platform already enforces each of these in code, whatever a seller's policy says:
| Area | Enforced by |
|---|---|
| Payment: cards only, prepaid refused, the platform charges the buyer | `marketplaceOrderService` (PaymentIntent, prepaid check) |
| Security and privacy: address hidden until payment, seller isolation | order views, `sellerBranding`, ownership checks |
| Compliance: seller verification, agreement, payout readiness before any sale | `sellerSaleEligibility.assertSellerCanSell` |
| Refunds: administrator-controlled only; the seller cannot refund or block one | `refundOrder` (admin route only) |
| Disputes and chargebacks: handled by Advantage.Bid; disputed orders are held from payout | settlement eligibility (`payment_disputes`) |
| Sales tax: calculated and collected by Advantage.Bid | Stripe Tax, `taxResponsibility` |
| Fees: 5% / 9% of item price by channel (Seller Agreement v4 §6.9), not shown as a seller term | storefront fee in `marketplaceOrderService` / `billingTermsService` |
`[COUNSEL TO DRAFT]`: the clause stating that conflicting seller terms are void to the extent of the conflict.

## 4. Display before purchase (already built)
- The review screen shows the seller's published Store Terms and Shipping & Pickup Policy (when seller branding is shown),
  and the buyer must acknowledge them (`policies_acknowledged`).
- If the seller publishes a new version between review and order, the order is refused (`POLICIES_CHANGED`) and the buyer
  reviews again; the same applies to price and shipping changes (`PRICE_CHANGED`).
- `[GAP for Release 2]`: the review screen links the platform Buyer Terms, but the storefront order does not yet require a
  separate acceptance of the current Buyer Terms version. Counsel to advise whether a per-order acknowledgement is needed;
  the version in force is recorded either way.

## 5. Questions for counsel
1. Is Advantage.Bid the seller of record, an agent of the seller, or a marketplace only? (affects returns, warranties, tax)
2. Must the Buyer Terms be accepted per order, or is account-level acceptance of the current version sufficient?
3. Required disclosures for fixed-price online sales (returns, cancellation, delivery timing, state-specific rules).
4. Seller-defined return policies: minimum floor Advantage.Bid requires, if any.
5. Shipping risk of loss and damage in transit: platform position vs. seller policy.
6. Whether the platform refund, pickup and privacy policies must be versioned per order like the Buyer Terms.
7. Chargeback liability allocation between Advantage.Bid and the seller (see Seller Agreement storefront terms).
