# Storefront sales tax: decision checklist (owner + CPA)

Prepared 2026-11-09. Purpose: settle exactly what must be true before the first taxable storefront sale. This is not tax
advice and assumes nothing about where Advantage.Bid must register; each item is a question to confirm with the CPA.

## How the platform works today (facts from the code and production)

- Stripe Tax is ON in production. It calculates tax **only for states where Advantage.Bid's own Stripe account has an
  active tax registration**. Where there is none, the calculated tax is $0 and nothing is collected.
  (Stripe test mode: a Texas pickup order calculated $0 because the test account has no registrations.)
- Tax is calculated from the pickup location (pickup) or the ship-to address (shipping). Shipping and tax are never part
  of the seller's commission.
- When an order HAS tax, the platform requires a rule for that state saying who remits it (Admin > Storefront Tax Rules,
  table `marketplace_tax_jurisdictions`, with the legal basis recorded). Production has **no rules yet**, so any taxed order
  is refused with "Online purchase is not available for this location yet."
  - Rule `platform`: Advantage.Bid keeps the tax and files it.
  - Rule `seller`: the tax collected is paid to the seller with their payout (`tax_to_seller_cents`) and the seller files it.
- The first seller (Lewis & Maese) has 9 items, all picked up in **Texas**.

## Questions to settle with the CPA

1. **Is Advantage.Bid a "marketplace facilitator / provider" that must collect Texas sales tax on Lewis & Maese's sales?**
   (Depends on Texas rules and thresholds for marketplace providers. Do not assume yes or no.)
2. If **yes** (Advantage.Bid collects and remits):
   - Register with the Texas Comptroller (sales and use tax permit), then add the Texas registration in Stripe Tax.
   - Enter the rule: Texas = `platform`, legal basis = the CPA's advice and date.
   - Decide who files and how often (Stripe Tax reports what was collected; filing is separate).
3. If **no** (the seller is responsible):
   - Confirm Lewis & Maese hold their own Texas sales tax permit and that they want the tax collected at checkout.
   - Stripe Tax can only calculate Texas tax if Advantage.Bid's Stripe account has a Texas registration entry, so decide:
     - (a) add a Texas registration in Stripe Tax for calculation and enter the rule Texas = `seller` (the collected tax is
       passed to the seller in the payout); confirm with the CPA that collecting on the seller's behalf this way is
       acceptable; or
     - (b) collect no tax at checkout (Stripe Tax returns $0) and the seller accounts for tax themselves; confirm this is
       acceptable for their sales.
4. **Pickup sales sourcing:** confirm that tax on a pickup sale is based on the pickup location (Texas), as the platform
   does.
5. **Exempt buyers / resale certificates:** the platform does not take resale or exemption certificates at checkout.
   Confirm that is acceptable for launch (exempt buyers would be refunded the tax manually), or that it is needed first.
6. **Shipping to other states:** if a seller ships out of state, the ship-to state decides. Until each state's rule and
   registration are settled, keep sellers on pickup (or Texas-only shipping); out-of-state shipments with tax are refused
   automatically (no rule), which is safe.
7. **Advantage.Bid's home state (Michigan):** confirm whether Advantage.Bid itself must register in Michigan for any
   storefront sales (only relevant when a seller or buyer location is in Michigan).
8. **Records:** Stripe Tax transaction records are created per order (and reversed on refunds). Confirm the CPA can work
   from Stripe Tax reports plus the Admin storefront order export.

## What to enter once decided (an administrator, in the app)

- Stripe Dashboard > Tax > Registrations: the registrations the CPA confirms (owner, live account).
- Admin > Storefront Tax Rules: one row per state (`platform` or `seller`, legal basis, effective date).
- Nothing else changes in the code. A state without a rule stays safely closed to taxed orders.
