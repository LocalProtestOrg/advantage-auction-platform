# Seller-caused refunds: card processing cost recovery (DRAFT CLAUSE FOR COUNSEL REVIEW)

Status: **draft, not approved, not in any published Seller Agreement version** (version 4 does not contain it). Prepared
2026-11-03 from the owner's policy direction. Recovery is built but switched off
(`STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED`); it must stay off until counsel approves the wording, the clause is published
in a Seller Agreement version, and the owner turns it on.

## Owner policy direction (2026-11-03)
- Recover the **actual, nonrefundable payment-processing cost** from the seller only when a refund is attributable to the
  seller's failure (for example, not handing over or shipping the item, or a material misrepresentation of it), subject to
  applicable law and approved seller terms.
- Never charge sellers automatically for every refund, and never more than the documented eligible cost.
- The reason is recorded and reviewable by an administrator.

## How the platform supports it (built)
- An administrator refund records the reason and who caused it (`seller`, `buyer`, `platform`, `other`), with the
  administrator and time; audited.
- The documented cost is the card fee the payment processor actually charged for that order (recorded from the processor
  after payment, `marketplace_orders.processing_fee_cents`); the processor does not return it on a refund.
- With the switch off (current): Admin > Storefront Orders shows "Card cost eligible for recovery" for a seller-caused refund;
  nothing is deducted.
- With the switch on: that exact amount is recorded once per order and deducted from the seller's next weekly payout (shown on
  the payout record); never for a buyer-, platform- or unclear-cause refund.

## Proposed clause for a future Seller Agreement version (section 6.9 or 7, wording for counsel to revise)
> **Seller-caused refunds.** If Advantage refunds a buyer, in whole or in part, because the Seller did not make an item
> available for pickup or delivery as listed, or because the item was materially different from its listing description, the
> Seller will reimburse Advantage for the payment-processing fees that Advantage paid on that order and that the payment
> processor does not return, as recorded by Advantage for that order. Advantage may deduct that amount from the Seller's
> next payout and will show it on the Seller's payout statement. This reimbursement does not apply to refunds caused by the
> buyer, by Advantage, or for reasons that cannot reasonably be attributed to the Seller, and is in addition to any amount
> recovered under Section [refund after payout].

## Questions for counsel
1. Is a processing-cost reimbursement enforceable as drafted in the seller's state(s) and under the Seller Agreement's
   governing law (Michigan)? Any notice or dispute step required before deduction?
2. Does "materially different from its listing description" need a defined standard, or a reference to the dispute process?
3. Should the seller be notified and given a chance to contest before the deduction (recommended: yes, e.g. 7 days)?
4. Interaction with chargebacks (dispute fees) and with the existing refund-after-payout recovery.
5. Must existing signers accept a new version before this applies (the platform's versioning supports requiring it)?
