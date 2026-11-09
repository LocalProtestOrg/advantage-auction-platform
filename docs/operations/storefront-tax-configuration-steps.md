# Storefront sales tax: configuration steps from the CPA's written determination

Prepared 2026-11-09. Use ONLY after the CPA's written determination is in hand and the owner approves each entry. Nothing
here has been entered. Production today: **0 tax rules**, so the sales tax safeguard (live since 2026-11-09, d38a2da,
migration 227) refuses every storefront order in every state.

## How the safeguard decides (deployed behavior, verified by tests for all 50 states and D.C.)

- **Which state:** local pickup = the state of the item's pickup location; shipping = the buyer's ship-to state (the item's
  location is sent as the origin). A Texas rule never covers a sale shipped to another state.
- **One rule per state** (Admin > Tax Jurisdictions, `https://bid.advantage.bid/admin/tax-jurisdictions.html`). Each rule
  records the CPA's answer for that state, the legal basis (who advised and when) and the effective date. Different states
  can have different answers.

| Rule (as shown in Admin) | Stored value | Checkout behavior |
|---|---|---|
| Collected at checkout; Advantage.Bid remits | `platform` | Tax calculated and charged; Advantage.Bid keeps and files it. Refused if the payment processor is not collecting in that state (no active registration). |
| Collected at checkout; the seller remits | `seller` | Tax calculated and charged; paid to the seller with the payout; the seller files it. Refused if the processor is not collecting in that state. |
| Not collected at checkout; the seller handles its own tax | `seller_direct` | No tax charged; refused if tax is nevertheless calculated (a registration exists that the rule does not expect). |
| (no rule) | none | Every order refused, taxed or not. |

- A $0 result is accepted under a "collected" rule only for an administrator-approved buyer exemption or a sale the
  processor says is not taxable there. Refunds return the tax to the buyer and reverse the tax record; a refund after a
  seller-remitted payout recovers the tax with the proceeds.

## Steps (Texas first; repeat per state the CPA covers)

1. **Record the determination.** Keep the CPA's letter with the date. For each state it covers, note: who collects
   (Advantage.Bid, the seller through checkout, or the seller outside checkout), the permit or registration needed, and
   the effective date.
2. **Registrations first (only for "collected at checkout").** If Advantage.Bid collects in a state (either collected
   rule), it needs that state's permit (Texas: Comptroller sales and use tax permit, issued to Advantage.Bid) and then:
   Stripe Dashboard (live) > Tax > Registrations > Add registration > United States > the state > the permit's start
   date. Check Tax > Settings: head office (origin) address and default product tax code (general tangible goods);
   prices are tax-exclusive.
3. **Enter the rule** (owner approval): Admin > Tax Jurisdictions > state > the rule from the table > legal basis
   (for example "CPA [name], letter dated [date]: Advantage.Bid is the marketplace provider for Texas") > effective date
   (the registration's start date) > Save. Every change is recorded in the audit log.
4. **Seller notice (if Advantage.Bid collects as marketplace provider).** Texas requires the marketplace provider to
   certify to its sellers that it collects on their behalf; it can be part of an agreement or a written notice
   (Comptroller page in the tax checklist). Send it to Lewis & Maese before the first sale.
5. **Verify before the pilot.** With the pilot on for the owner's buyer account only, review an order for a Lewis &
   Maese item (do not pay): the review screen must show the Texas tax line at the Houston rate (if collected) or no tax
   (if "not collected at checkout"). A refusal message means the registration or rule does not match: stop and check
   steps 2 and 3.
6. **Interstate shipping.** Lewis & Maese's items are pickup only today. Before any seller ships to another state, enter
   that destination state's rule (and registration) the same way. Until then, orders shipped there are refused
   automatically, which is safe.

## Undo

- Remove a rule (Admin > Tax Jurisdictions > Remove): every order in that state is refused again at once.
- A registration stays in Stripe until removed there; with "not collected at checkout" rules, any calculated tax is
  refused rather than silently charged.
