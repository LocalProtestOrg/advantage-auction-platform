# Storefront sales tax: responsibility matrix and open questions (DRAFT FOR CPA REVIEW)

Status: prepared 2026-11-02 for professional tax review. **No state rule is configured and none is assumed.** Tax remittance
automation and live purchasing stay off until the treatment is verified and approved by the owner.

## 1. What the platform does (built, migration 214)
| Step | Behaviour |
|---|---|
| Calculation | Stripe Tax (existing `taxCalculationService`), only when `STRIPE_TAX_ENABLED`; approved buyer exemptions give $0 (admin-approved only) |
| Sourcing | Pickup: the item's pickup location. Shipping: the buyer's shipping address (ship-from = pickup location) |
| Collection | Advantage.Bid charges the buyer item + shipping + tax |
| Who remits | Per state, from `marketplace_tax_jurisdictions` (Admin > Storefront Tax Rules), each rule records the advice relied on, effective date, audited |
| No rule for a taxed state | The order is refused before payment (`TAX_RESPONSIBILITY_UNSET`) and stock is released |
| Recorded per order | `tax_cents`, `tax_jurisdiction`, `tax_remitter` (`platform` / `seller` / `none`), Stripe Tax calculation, transaction and reversal ids |
| Seller-remitted tax | Paid to the seller with that order's proceeds (`storefront_payout_lines.tax_to_seller_cents`) |
| Platform-remitted tax | Never paid to the seller; held for remittance |
| Revenue | Tax is never in the commission base (5% website / 9% marketplace, on the item price only) and never platform revenue |
| Refunds | Full refund reverses the Stripe Tax transaction; partial refund attempts a partial reversal, else flags review; a refund after payout is recovered from the seller's next payout (capped at what the seller received, which includes seller-remitted tax) |

## 2. Matrix to be completed by the CPA (one row per state with sales tax)
| State | Marketplace facilitator law applies to Advantage.Bid? | Threshold met / date | Remitter | Seller registration needed? | Pickup sourcing rule | Shipping taxable? | Source / advisor / date |
|---|---|---|---|---|---|---|---|
| TX (L&M's location) | `[CPA]` | `[CPA]` | `[CPA]` | `[CPA]` | `[CPA]` | `[CPA]` | `[CPA]` |
| … each other state | | | | | | | |

The table above is entered into Admin > Storefront Tax Rules only once the CPA confirms it; the platform will not sell into a
taxed state without a row.

## 3. Open questions
1. Does Advantage.Bid meet the marketplace-facilitator definition (it processes payment) and, per state, the sales or
   transaction thresholds? From which date?
2. Where Advantage.Bid is the facilitator, is the seller still required to register or report those sales?
3. Pickup orders: is the pickup location the correct sourcing point in each state (origin vs. destination rules)?
4. Taxability of shipping charges per state, and of the 5% / 9% storefront commission (not charged to buyers today).
5. Remittance mechanics for platform-remitted tax: Stripe Tax filing, a filing service, or the CPA; account and timing.
6. Tax information to sellers: what report is required (per-payout tax lines exist; a seller-facing tax statement is not built).
7. Refund after the seller remitted the tax themselves: the recovery from the seller includes that tax; confirm that is correct.
8. Exemption certificates: the existing buyer-exemption approval flow applies to storefront orders; confirm it is sufficient.
9. 1099-K / information reporting: handled by Stripe Connect for connected accounts; confirm no additional platform filing.

## 4. Owner decision also needed (not tax law)
- On a refund after payout, Advantage.Bid refunds the buyer in full but recovers only what the seller received; the storefront commission
  and card processing are absorbed by Advantage.Bid unless the owner decides otherwise.
