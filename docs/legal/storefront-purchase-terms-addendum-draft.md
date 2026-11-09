# DRAFT FOR OWNER REVIEW: Fixed-Price Purchases Addendum to the Buyer Terms

Status: **draft, not published** (prepared 2026-11-09). Plain-language draft for the owner and counsel. It describes how
storefront checkout actually works today; where a rule is a business choice that the code does not settle, it is marked
**[DECISION]** with the options. Nothing here may be published until the owner approves the wording. Publishing it
would add it to the Buyer Terms (a new buyer_terms version), which buyers then accept at their next purchase.

---

## Addendum: Buying Fixed-Price Items

These terms apply when you buy an item at a fixed price ("Buy Now") from a Professional Seller's storefront on
Advantage.Bid or on the seller's own website. They add to the Advantage.Bid Buyer Terms. If they conflict, this addendum
controls for fixed-price purchases.

### 1. Who you are buying from
You are buying from the Professional Seller named on the item page. Advantage.Bid runs the marketplace, processes your
payment and keeps the order record. The seller is responsible for the item, its description and its condition, and for
handing it over or shipping it.

### 2. Seller policies
Each seller publishes Store Terms and a Shipping & Pickup Policy. You must review them before you buy; they are part of
your purchase, and the version shown to you is saved with your order. If a seller policy conflicts with this addendum,
this addendum controls.

### 3. Price and payment
The total shown before you pay is the item price, any shipping charge and any sales tax. There is no buyer's premium on
fixed-price purchases. You pay by debit or credit card when you complete checkout; prepaid cards are not accepted. Your
item is reserved for you for 30 minutes while you check out.

### 4. Order confirmation
Your purchase is complete when your payment succeeds and you see the order confirmation. You receive an order number and
a receipt by email.

### 5. Cancellations
**[DECISION]** The system today has no buyer cancellation button; refunds are made by Advantage.Bid. Choose one:
- (A) "Once your payment succeeds, the purchase is final, except as described in sections 7 and 8." (matches today), or
- (B) "You may ask to cancel within [X hours] and before the item is shipped or picked up; contact Advantage.Bid. A
  cancelled order is refunded in full." (handled by staff refunds today; no new feature needed).

### 6. Pickup and shipping
- Pickup: collect the item at the location and within the window in the seller's Shipping & Pickup Policy. The seller
  marks the order picked up. **[DECISION]** what happens if a buyer never collects the item: use the existing Buyer Terms
  wording for abandoned items, or a storefront-specific rule (for example a refund less a fee, or no refund).
- Shipping: when offered, the seller ships to the address you gave at checkout and must enter the carrier and tracking
  number. Shipping charges are shown before you pay.

### 7. Returns
Returns are governed by the seller's Store Terms. If a seller does not accept returns, the sale is final except under
section 8. **[DECISION]** whether Advantage.Bid sets a minimum return right for all storefront sellers (for example "items
not as described may be returned within [X] days"), or leaves returns entirely to each seller.

### 8. Problems with your order
If your item is not received, not as described, damaged, or there is a pickup problem, report it from your order page
(Report a Problem) within **[DECISION: X days]** of pickup or delivery. Reporting a problem places the seller's payout for
that order on hold while Advantage.Bid reviews it. Advantage.Bid decides the outcome after hearing from you and the seller
and may refund you in full or in part. Refunds go back to the card you used.

### 9. Refunds
Refunds are issued by Advantage.Bid to your original card. A full refund includes the item price, shipping and sales
tax. **[DECISION]** whether any processing or restocking fee may be kept on a refund that is not the seller's fault (the
existing Buyer Terms Schedule A has a processing fee; it is not part of storefront checkout today).

### 10. Card disputes (chargebacks)
Please report a problem (section 8) before disputing a charge with your bank; most problems are resolved faster that
way. If you dispute a charge, the seller's payout for that order is held until the dispute is resolved.

### 11. Sales tax
Sales tax is calculated at checkout from the pickup location or the shipping address and shown before you pay. Depending
on the state, Advantage.Bid or the seller collects and remits it.

---

## Notes for the owner (not part of the text)

- Every factual statement above matches the current code: 30-minute hold, prepaid refused, seller policies acknowledged
  and saved with the order, tracking required to mark shipped, Report a Problem holds the payout, refunds by Advantage.Bid
  to the original card, dispute holds the payout, tax by location.
- Section 11 depends on the sales tax decisions (docs/operations/storefront-sales-tax-decision-checklist.md).
- Five decisions are marked. None needs new software for a controlled launch; option 5(B) and any return-window rule
  are handled by staff refunds today.
- Counsel review is still recommended (the Buyer Terms v4 provisions on liability, venue and waivers also apply to these
  purchases once v4 is published).
