# Storefront sales tax: Texas decision checklist (owner + CPA)

Prepared 2026-11-09 (Texas detail added the same day). Purpose: settle exactly what must be true before the first real
storefront sale (Lewis & Maese, Houston, pickup only). **This is not tax advice.** It assumes nothing about whether
Advantage.Bid or the seller is responsible; every responsibility item is a question for the CPA. Texas facts below are
quoted from the Texas Comptroller's own pages (links at the end) and should be confirmed by the CPA against the statute.

## A. What the platform does today (facts from the code and production)

- Stripe Tax is ON in production. It calculates tax **only where Advantage.Bid's own Stripe account has an active tax
  registration**. Without a Texas registration, a Texas order calculates **$0 tax**.
- **Important (production as of 2026-11-09, commit 330ea1c):** an order with $0 tax needs no tax rule, so it is
  **accepted with no tax collected**. A Lewis & Maese purchase would go through untaxed. **Do not start the pilot until
  section C is decided and section D is done.**
- **Safeguard built, not deployed (branch `feat/storefront-tax-safeguard`, migration 227):** every storefront order is
  refused in a state without a rule, taxed or not; a rule saying tax is collected at checkout is refused unless the
  processor is actually collecting there (an active registration); a third rule, "not collected at checkout; the seller
  handles its own tax", covers that CPA answer. With it deployed, the untaxed sale above cannot happen. Deploy order:
  migration 227 first, then the code.
- When tax is calculated, the order needs a state rule saying who remits it (Admin > Storefront Tax Rules, table
  `marketplace_tax_jurisdictions`, with the legal basis recorded). Production has **no rules**. A taxed order in a state
  without a rule is refused before payment ("Online purchase is not available for this location yet").
  - Rule `platform`: Advantage.Bid keeps the tax and files it.
  - Rule `seller`: the tax collected is paid to the seller with the payout (`tax_to_seller_cents`) and the seller files it.
- Pickup orders are taxed at the item's pickup location (Lewis & Maese: Houston). Shipping and tax are never part of the
  5% / 9% commission base.
- No exemption or resale certificates are taken at checkout.
- The live Stripe registrations could not be read from here (the live key is sealed in Railway). The owner checks them in
  the Stripe Dashboard (section D).

## B. Texas facts (Texas Comptroller pages, to be confirmed by the CPA)

1. **Marketplace provider.** A marketplace provider is "a person who owns or operates a marketplace and directly or
   indirectly processes sales or payments for marketplace sellers" (Tax Code section 151.0242(a)(2), as quoted by the
   Comptroller). Advantage.Bid operates the storefront marketplace and charges the buyer's card on its own account, so it
   appears to fit; the CPA must confirm.
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

## C. Questions to answer (CPA), in order

1. **Is Advantage.Bid "engaged in business in Texas"** (office, property, staff or representatives in Texas; Texas
   pickups coordinated by Advantage.Bid staff)? If yes, items 2 and 3 apply from the first sale, regardless of any
   threshold.
2. **Is Advantage.Bid a Texas "marketplace provider"** for storefront sales (it processes the payment)?
3. If 1 and 2 are yes: Advantage.Bid must hold a Texas sales and use tax permit, collect state and local tax on Lewis &
   Maese's storefront sales, file returns, and certify to Lewis & Maese that it collects on their behalf.
   **Does Advantage.Bid already hold a Texas permit (for example, from auction sales)?**
4. If Advantage.Bid is a remote marketplace provider below the threshold: is it required to collect, and **may** it
   collect voluntarily (register, collect and certify)? If it does not collect, Lewis & Maese collect and remit the tax
   on their own sales; decide how (5).
5. If the seller collects: Stripe Tax cannot calculate Texas tax without a Texas registration on Advantage.Bid's account.
   Options: (a) register for calculation and set the Texas rule to `seller` (tax passed to the seller with the payout),
   if the CPA confirms this is acceptable; or (b) collect nothing at checkout and the seller accounts for the tax itself.
   Option (b) needs the CPA's explicit confirmation, because it is what happens today by default.
6. **Rate for a Houston pickup:** confirm that local tax is sourced to the pickup location (Lewis & Maese's Houston
   address) and that Stripe Tax's Texas calculation matches the Comptroller's rate locator for that address.
7. **Lewis & Maese:** confirm they hold a Texas sales tax permit and file returns (needed in every option).
8. **Certification wording:** if Advantage.Bid collects, add the marketplace-provider certification to the seller-facing
   terms or send it to Lewis & Maese in writing (it can be part of an agreement).
9. **Exempt buyers:** acceptable for the pilot that no resale or exemption certificate is taken at checkout (an exempt
   buyer would be refunded the tax manually)?
10. **Records:** can the CPA work from Stripe Tax reports plus the Admin storefront order list (each order records the
    tax, the jurisdiction and who remits it)?
11. **Advantage.Bid's home state (Michigan):** any registration needed for Michigan storefront sales later (not for the
    Texas pilot)?

## D. What to configure once decided

Only after the CPA's answers; each step needs the owner's approval.

1. Texas Comptroller: sales and use tax permit for Advantage.Bid (if required or chosen).
2. **Stripe Dashboard (live) > Tax > Registrations:** add Texas with the permit's start date. Check **Tax > Settings**:
   origin (head office) address and default product tax code (general tangible goods). Prices are tax-exclusive (tax is
   added on top at checkout).
3. **Admin > Storefront Tax Rules:** add Texas = `platform` (or `seller`), the legal basis (CPA name and date) and the
   effective date.
4. Certification to Lewis & Maese (if Advantage.Bid collects).
5. **Check before the pilot:** with the pilot switched on for the owner's buyer account only, open the Lewis & Maese test
   item and review the order (the review screen shows the tax line before paying). Texas tax must appear at the Houston
   rate. If it shows $0 or no tax line, stop: the registration is not active.

## Sources (Texas Comptroller)

- Marketplace providers and sellers: https://comptroller.texas.gov/taxes/sales/marketplace-providers-sellers.php
- Remote sellers and marketplace FAQ: https://comptroller.texas.gov/taxes/sales/remote-sellers-marketplace-faq.php
- Remote sellers: https://comptroller.texas.gov/taxes/sales/remote-sellers.php
- Local sales and use tax collection (Publication 94-105): https://comptroller.texas.gov/taxes/publications/94-105.php
- Engaged in business (Publication 94-108): https://comptroller.texas.gov/taxes/publications/94-108.php
