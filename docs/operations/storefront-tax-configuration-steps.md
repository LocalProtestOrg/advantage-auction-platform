# Storefront sales tax: configuration steps from the CPA's written determination

**Updated 2026-11-16:** Advantage.Bid is a New Jersey business operating out of New Jersey, and the first controlled
test is a New Jersey sale, so **New Jersey is configured first** (it was "Texas first" when this was prepared). The
owner's preferred model has two rules: `platform` where Advantage.Bid is legally responsible for collecting, and
`seller_direct` where it is not. The `seller` rule is being retired for new transactions (risk of the same tax being
remitted twice): do not enter it for a new state. Questions for the CPA:
`docs/operations/storefront-sales-tax-decision-checklist.md`.

Prepared 2026-11-09. Use ONLY after the CPA's written determination is in hand and the owner approves each entry. Nothing
here has been entered. Production today: **0 tax rules**, so the sales tax safeguard (live since 2026-11-09, d38a2da,
migration 227) refuses every storefront order in every state.

## How the safeguard decides (deployed behavior, verified by tests for all 50 states and D.C.)

- **Which state:** local pickup = the state of the item's pickup location; shipping = the buyer's ship-to state (the item's
  location is sent as the origin). A New Jersey rule never covers a sale shipped to another state.
- **One rule per state** (Admin > Tax Jurisdictions, `https://bid.advantage.bid/admin/tax-jurisdictions.html`). Each rule
  records the CPA's answer for that state, the legal basis (who advised and when) and the effective date. Different states
  can have different answers.

| Rule (as shown in Admin) | Stored value | Checkout behavior |
|---|---|---|
| Collected at checkout; Advantage.Bid remits | `platform` | Tax calculated and charged; Advantage.Bid keeps and files it. Refused if the payment processor is not collecting in that state (no active registration). |
| Collected at checkout; the seller remits (**being retired for new transactions; do not enter**) | `seller` | Tax calculated and charged; paid to the seller with the payout; the seller files it. Refused if the processor is not collecting in that state. |
| Not collected at checkout; the seller handles its own tax | `seller_direct` | No tax charged; refused if tax is nevertheless calculated (a registration exists that the rule does not expect). |
| (no rule) | none | Every order refused, taxed or not. |

- A $0 result is accepted under a "collected" rule only for an administrator-approved buyer exemption or a sale the
  processor says is not taxable there. Refunds return the tax to the buyer and reverse the tax record; a refund after a
  seller-remitted payout recovers the tax with the proceeds.

## Steps (New Jersey first; repeat per state the CPA covers)

1. **Record the determination.** Keep the CPA's letter with the date. For each state it covers, note: who collects
   (Advantage.Bid, or the seller outside checkout), the permit or registration needed, and
   the effective date.
2. **Registrations first (only for "collected at checkout").** A registration is platform-wide: it also starts tax on
   that state's auction invoices (Stripe Tax is on for auctions), so the CPA's determination must cover auctions too. If Advantage.Bid collects in a state
   (rule `platform`), it needs whatever registration the CPA says that state requires (New Jersey: the CPA confirms what
   Advantage.Bid holds or must obtain; Texas, later: Comptroller sales and use tax permit) and then:
   Stripe Dashboard (live) > Tax > Registrations > Add registration > United States > the state > the permit's start
   date. Check Tax > Settings: head office (origin) address (the New Jersey operating address, not the Adrian, Michigan
   mailing address) and default product tax code (general tangible goods);
   prices are tax-exclusive.
3. **Enter the rule** (owner approval): Admin > Tax Jurisdictions > state > the rule from the table > legal basis
   (for example "CPA [name], letter dated [date]: [the CPA's determination for New Jersey]") > effective date
   (the registration's start date) > Save. Every change is recorded in the audit log.
4. **Seller notice (if Advantage.Bid collects).** Ask the CPA whether New Jersey requires a notice or certification to
   sellers that the marketplace collects on their behalf (checklist question C17). If one is required, send it to the
   pilot seller before the first sale (and to each later seller in that state). For Texas, later, the Comptroller
   describes a certification by the marketplace provider (checklist section F).
5. **Verify before the pilot.** With the pilot on for the pilot buyer account only, review an order for a pilot
   seller item with shipping to the New Jersey test address (do not pay): the review screen must show the New Jersey
   tax line as calculated (rule `platform`) or no tax (rule `seller_direct`). A refusal message means the registration or rule does not match: stop and check
   steps 2 and 3.
6. **Interstate shipping.** The pilot test order ships to a New Jersey address only (nothing is physically sent). Before any seller ships to another state, enter
   that destination state's rule (and registration) the same way. Until then, orders shipped there are refused
   automatically, which is safe.

## Undo

- Remove a rule (Admin > Tax Jurisdictions > Remove): every order in that state is refused again at once.
- A registration stays in Stripe until removed there; with "not collected at checkout" rules, any calculated tax is
  refused rather than silently charged.
