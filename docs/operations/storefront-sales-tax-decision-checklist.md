# Sales tax: decision checklist (owner + CPA), New Jersey first

Prepared 2026-11-09 with Texas detail. **Rewritten 2026-11-16 for New Jersey** on the owner's facts: Advantage.Bid is
legally registered in New Jersey and operates out of New Jersey, so New Jersey is the principal operating location and
the starting point for sales tax compliance. The first controlled live test is a New Jersey sale. The Texas material is
kept as a later section (section F) because Texas sellers exist; Texas is not the pilot.

Purpose: settle exactly what must be true before the first real storefront sale, and before tax is collected on any
auction invoice.

**This is not tax advice.** The owner has made no legal determination. Nothing here states who must collect, at what
threshold or at what rate: every such item is a question for the CPA (section C). Platform behavior in section A is
fact from the code and production; everything about the law is a question.

## A. Business facts and what the platform does today

**Business facts (owner, 2026-11-16).**

- Advantage.Bid is legally registered in New Jersey and operates out of New Jersey.
- "2205 Ogden Hwy, Adrian, MI 49221" is a legitimate **mailing address only**. It is not the principal operating
  location, and it is not, by itself, evidence of a Michigan tax connection. Whether a mailing address has any tax
  effect is a CPA question (C14).
- Seller Agreement section 16.1 names Michigan governing law, and the public Terms name Texas. Those are contract
  clauses under separate legal review (`docs/legal/governing-law-and-address-corrections-draft-2026-11.md`); they do not
  say where Advantage.Bid operates or where tax is owed.

**The tax model the owner prefers (central collection).**

| Rule (stored value) | Meaning | Status |
|---|---|---|
| `platform` | Tax is calculated and charged at checkout; Advantage.Bid keeps it and remits it. Used wherever Advantage.Bid is legally responsible for collecting. | Preferred |
| `seller_direct` | Nothing is collected at checkout; the seller is responsible for its own tax. Used where Advantage.Bid is not required to collect. | Preferred |
| `seller` | Tax charged at checkout and paid to the seller with the payout ("the seller remits through the platform"). | **Being retired for new transactions** (risk of the same tax being remitted twice). Do not enter it for a new state. |

Which rule applies in a state is the CPA's determination, never an engineering default.

**Platform behavior (facts).**

- Stripe Tax is ON in production. It calculates tax **only where Advantage.Bid's own Stripe account has an active tax
  registration**. Without a New Jersey registration, a New Jersey order calculates **$0 tax**.
- **Sales tax safeguard (live since 2026-11-09, d38a2da, migration 227):** every storefront order is refused in a state
  without a rule in Admin > Tax Jurisdictions, taxed or not. A `platform` rule is refused unless the processor is
  actually collecting there (an active registration); a `seller_direct` rule is refused if tax is nevertheless
  calculated. Production has **no rules**, so nothing can sell until the CPA's determination is configured.
- **Auctions are covered by the same per-state rules.** A Stripe Tax registration is account-wide, so registering a
  state starts tax calculation on that state's auction invoices as well as storefront orders (Stripe Tax is on for
  auctions and calculates $0 today only because there are no registrations). The CPA's determination for a state must
  therefore cover auction sales and storefront sales together.
- Sourcing used by the platform: a pickup order is calculated at the item's pickup location; a shipped order at the
  buyer's ship-to address (the item's location is sent as the origin). The CPA confirms this is right for New Jersey.
- Shipping is sent to the tax calculation as a separate shipping charge, so the state's own treatment of shipping
  applies (6a664cf). Shipping and tax are never part of the 5% / 9% commission base.
- Buyer exemptions: an administrator-approved buyer tax exemption is honored at checkout (the same exemption record
  auctions use); there is no self-service certificate upload at checkout.
- A full refund returns the tax to the buyer and records a reversal of the tax transaction.
- The live Stripe registrations cannot be read from here (the live key is sealed in Railway). The owner checks them in
  the Stripe Dashboard (section D).

## B. The New Jersey pilot (what the determination must cover first)

- **Seller:** Timeless Treasures (`/pro/timeless-treasures`), a Professional Seller (Retail Shop, Gallery or Studio),
  pickup location confirmed in **Jersey City, New Jersey**.
- **Test order:** one temporary test listing, $3.00 plus $2.00 flat shipping, bought by an authorized pilot buyer as a
  **shipped order to a New Jersey address**, then **refunded in full** by an administrator. It is not real merchandise:
  nothing is shipped, and no tracking or delivery record is created. Procedure:
  `docs/operations/storefront-first-sale-test-plan.md`.
- So the first rule needed is **New Jersey** (origin and destination are both New Jersey). No other state's rule is
  needed for the pilot. An order to any state without a rule is refused before payment, which is safe.
- The real-money transaction needs the owner's explicit approval. Global checkout stays OFF; only the two pilot
  allow-lists are used.

## C. Questions for the CPA (New Jersey), in order

Each is a question. None is answered here.

1. **Marketplace facilitator.** Advantage.Bid operates the marketplace and charges the buyer's card on its own
   account. Given that Advantage.Bid is a New Jersey business with a physical presence in New Jersey, is it a
   marketplace facilitator under New Jersey law, and is it required to collect and remit New Jersey sales tax on sales
   it facilitates, from the first sale or only above some threshold?
2. **Existing certificate of authority.** Does Advantage.Bid already hold a New Jersey certificate of authority to
   collect sales tax (business registration)? If yes: is it current, and does it cover marketplace sales? If no: what
   must be filed, and from what start date?
3. **Which rule.** For New Jersey, is the correct rule `platform` (Advantage.Bid collects and remits) or
   `seller_direct` (nothing collected at checkout; the seller is responsible)? Is the answer the same for storefront
   sales and for auction sales?
4. **Auctions.** Are sales made through online auctions on the platform treated the same way as fixed-price storefront
   sales in New Jersey, for both Individual Sellers and Professional Sellers? Does a private individual's occasional
   sale change the answer?
5. **Auction buyer premium.** Is the buyer premium part of the taxable amount in New Jersey? Does it matter whether
   Advantage.Bid keeps the premium (Individual Sellers, fixed 18%) or the Professional Seller keeps it?
6. **Shipping.** Is a separately stated shipping charge taxable in New Jersey? Does the answer depend on whether the
   item itself is taxable, or on who ships (the seller ships; Advantage.Bid does not)?
7. **Jersey City Urban Enterprise Zone.** The pilot pickup location is in Jersey City. Does the Urban Enterprise Zone
   program affect the rate or the collection duty for (a) a pickup sale at that location, (b) an item shipped from that
   location, (c) a sale made by a marketplace rather than by the seller directly? Does it depend on the seller's own
   certification in the program?
8. **Clothing and other exempt categories.** Which categories commonly sold here are exempt or taxed differently in New
   Jersey (clothing and footwear, and any others the CPA identifies)? Is the platform's default product tax code
   (general tangible goods) acceptable for the pilot, and what per-category treatment is needed before sellers list
   exempt goods?
9. **Sourcing.** Is a pickup sale sourced to the pickup location and a shipped sale to the delivery address in New
   Jersey, as the platform calculates it?
10. **A test sale that is fully refunded.** The pilot order is paid and then refunded in full before any fulfillment.
    How is it reported: as a sale and a return in the same period, or not at all? Is tax collected and then returned to
    the buyer still reportable? Does the answer change if the sale and the refund fall in different filing periods?
11. **Filing frequency.** What filing frequency and due dates apply to Advantage.Bid in New Jersey, and is a return
    required for a period with no tax due?
12. **Chargebacks.** When a buyer disputes a card payment and the money is taken back by the card issuer, how is the
    tax on that sale treated (already remitted, not yet remitted, and when the dispute is later won)?
13. **Commission.** Is Advantage.Bid's commission or platform fee charged to the seller (5% / 9% storefront commission;
    platform fee and payment-processing fee on auctions) itself subject to New Jersey sales tax?
14. **Mailing address in Michigan.** Does keeping a mailing address in Adrian, Michigan (mail only, no operations)
    create any registration or filing duty in Michigan? (The owner's position is that it is a mailing address only;
    the CPA confirms the tax effect.)
15. **1099-K.** Who is responsible for 1099-K reporting on seller proceeds: the payment processor, Advantage.Bid, or
    both? Stripe Connect collects and verifies taxpayer identity; Advantage.Bid stores no complete taxpayer numbers.
    Is anything further required of Advantage.Bid?
16. **The seller's own duties.** Does Timeless Treasures need its own New Jersey registration and returns if
    Advantage.Bid collects (rule `platform`)? Under `seller_direct`, what must the seller be told?
17. **Seller notice or certification.** If Advantage.Bid collects, does New Jersey require a notice or certification to
    sellers that the marketplace collects on their behalf, and may it be part of the seller terms?
18. **Exempt buyers.** Is it acceptable for the pilot that no resale or exemption certificate is taken at checkout (an
    exempt buyer would be refunded the tax by an administrator)?
19. **Records.** Can the CPA work from Stripe Tax reports plus the Admin order lists (each order records the tax, the
    jurisdiction and who remits it)?
20. **Other states.** Sellers and buyers are nationwide. In what order should other states be determined, and which
    need a determination before a New Jersey seller ships to them? (Texas: section F.)

## D. What to configure once decided

Only after the CPA's written answers; each step needs the owner's approval. Detailed steps:
`docs/operations/storefront-tax-configuration-steps.md`.

1. New Jersey registration for Advantage.Bid, if the CPA says it is required or already held (C1, C2).
2. **If the rule is `platform`:** Stripe Dashboard (live) > Tax > Registrations: add New Jersey with the start date the
   CPA gives. Check **Tax > Settings**: the origin (head office) address should be Advantage.Bid's New Jersey operating
   address, not the Adrian, Michigan mailing address, and the default product tax code (general tangible goods).
   Prices are tax-exclusive (tax is added on top at checkout).
3. **Admin > Tax Jurisdictions:** add New Jersey = `platform` or `seller_direct`, the legal basis (CPA name and date)
   and the effective date. Do not enter `seller`.
4. Notice or certification to the pilot seller, if the CPA says one is required (C17).
5. **Check before the pilot:** with the pilot switched on for the pilot buyer account only, open the pilot item and
   review the order (the review screen shows the tax line before paying). The tax line must match the rule: tax as
   calculated for the New Jersey ship-to address under `platform`; no tax under `seller_direct`. A refusal message
   means the registration and the rule do not match: stop and check them.

## E. Open items for the New Jersey pilot (2026-11-16)

- [ ] CPA's written determination for New Jersey (section C).
- [ ] New Jersey rule entered in Admin > Tax Jurisdictions (`platform` also needs the New Jersey registration in
      Stripe Tax).
- [ ] Owner's approval of the real-money test and of the two pilot lists.

The full launch checklist is `docs/projects/development-todo.md` section 1.

## F. Later: Texas (not the pilot)

Texas sellers exist on the platform, so Texas will need its own determination before any Texas storefront sale, and
before a registration changes Texas auction invoices. The facts below are quoted from the Texas Comptroller's own pages
(links at the end) as of 2026-11-09 and must be confirmed by the CPA against the statute. They are reference material,
not conclusions about Advantage.Bid.

1. **Marketplace provider.** A marketplace provider is "a person who owns or operates a marketplace and directly or
   indirectly processes sales or payments for marketplace sellers" (Tax Code section 151.0242(a)(2), as quoted by the
   Comptroller). Whether Advantage.Bid fits is a CPA question.
2. **Who collects.** "Marketplace providers engaged in business in Texas must collect, report and remit state and local
   sales and use tax on all sales made through a marketplace."
3. **Remote provider threshold.** A marketplace provider that is a remote seller "does not need to be permitted and start
   collecting and remitting tax until all sales through their marketplace exceed the $500,000 threshold, or they are
   otherwise engaged in business in Texas." (Another Comptroller page measures remote sellers by total Texas revenue in
   the preceding 12 calendar months; the CPA should confirm the exact measure.)
4. **Engaged in business** includes, among other things, "maintaining an office or property in the state" and having
   representatives in Texas who take orders or make sales or deliveries.
5. **Certification.** Marketplace providers "are required to certify to marketplace sellers that they will collect sales
   and use tax on their behalf." No special form is required; it "can be part of the terms of use or any other agreement."
   If no certification is issued, the seller "should collect sales and use tax until you receive a certification."
6. **The seller still has duties.** A seller with a Texas permit is not responsible for collecting on marketplace sales the
   provider certified, but is "still responsible for having a Texas tax permit and filing your sales and use tax returns
   timely." Both keep records for at least four years.
7. **Local tax.** Texas local sales tax depends on where the sale is consummated (generally the seller's place of business
   or the location the item is fulfilled from). The single local use tax rate "is not available to marketplace
   providers." The Comptroller's rate locator gives the rate by address.

**Texas questions for the CPA (later).**

1. Is Advantage.Bid, a New Jersey business, "engaged in business in Texas" (any office, property, staff or
   representatives in Texas; Texas pickups coordinated on its behalf)?
2. Is Advantage.Bid a Texas "marketplace provider" for storefront sales and for auction sales?
3. If it is a remote marketplace provider below the threshold: is it required to collect, and may it collect
   voluntarily? Which rule follows: `platform` or `seller_direct`?
4. Does Advantage.Bid already hold a Texas permit (for example, from earlier auction sales)?
5. Is local tax sourced to the pickup location, and does the Stripe Tax calculation match the Comptroller's rate
   locator for that address?
6. What certification wording is needed for Texas sellers if Advantage.Bid collects?

The earlier Texas option of registering for calculation and passing the tax to the seller with the payout (rule
`seller`) is no longer offered for new transactions (see section A).

## Sources

New Jersey: no source is quoted here. The CPA supplies the New Jersey authority for each answer (New Jersey Division
of Taxation), and it is recorded as the legal basis on the rule.

Texas Comptroller (section F):

- Marketplace providers and sellers: https://comptroller.texas.gov/taxes/sales/marketplace-providers-sellers.php
- Remote sellers and marketplace FAQ: https://comptroller.texas.gov/taxes/sales/remote-sellers-marketplace-faq.php
- Remote sellers: https://comptroller.texas.gov/taxes/sales/remote-sellers.php
- Local sales and use tax collection (Publication 94-105): https://comptroller.texas.gov/taxes/publications/94-105.php
- Engaged in business (Publication 94-108): https://comptroller.texas.gov/taxes/publications/94-108.php
