# Storefront sales tax: decision checklist (owner + CPA), Texas detail

Prepared 2026-11-09 (Texas detail added the same day). Purpose: settle exactly what must be true before the first real
storefront sale. Updated 2026-11-10: the pilot seller is the owner's new personal Professional Seller account (pickup
location state to be confirmed at signup; Texas is detailed below because Advantage.Bid's sellers are mostly in Texas).
**This is not tax advice.** It assumes nothing about whether
Advantage.Bid or the seller is responsible; every responsibility item is a question for the CPA. Texas facts below are
quoted from the Texas Comptroller's own pages (links at the end) and should be confirmed by the CPA against the statute.

## A. What the platform does today (facts from the code and production)

- Stripe Tax is ON in production. It calculates tax **only where Advantage.Bid's own Stripe account has an active tax
  registration**. Without a Texas registration, a Texas order calculates **$0 tax**.
- **Sales tax safeguard LIVE (d38a2da, 2026-11-09, migration 227):** every storefront order is refused in a state
  without a rule in Admin > Tax Jurisdictions, taxed or not. A rule saying tax is collected at checkout is refused unless
  the processor is actually collecting there (an active registration). Production has **no rules**, so nothing can sell
  until the CPA's determination is configured. The three rules:
  - "Collected at checkout; Advantage.Bid remits" (`platform`): Advantage.Bid keeps the tax and files it.
  - "Collected at checkout; the seller remits" (`seller`): the tax is paid to the seller with the payout.
  - "Not collected at checkout; the seller handles its own tax" (`seller_direct`).
- **A Stripe Tax registration is platform-wide and also applies to auction invoices** (Stripe Tax is on for auctions and
  calculates $0 today only because there are no registrations). Registering a state starts tax on that state's auction
  invoices as well. The CPA's determination must cover auctions too.
- Pickup orders are taxed at the item's pickup location (the pilot seller's confirmed pickup address); shipped orders at the
  ship-to state. Shipping and tax are never part of the
  5% / 9% commission base.
- Buyer exemptions: an administrator-approved buyer tax exemption is honored at checkout (the same exemption record auctions
  use); there is no self-service certificate upload at checkout.
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

0. **Which state:** the pilot seller's pickup state (and any ship-to state used in a test). If it is not Texas, answer the
   questions below for that state.
0a. **Auctions:** if Advantage.Bid registers in a state, Texas auction invoices start calculating tax too. Is that
   correct for auction sales, and who remits it there?
1. **Is Advantage.Bid "engaged in business in Texas"** (office, property, staff or representatives in Texas; Texas
   pickups coordinated by Advantage.Bid staff)? If yes, items 2 and 3 apply from the first sale, regardless of any
   threshold.
2. **Is Advantage.Bid a Texas "marketplace provider"** for storefront sales (it processes the payment)?
3. If 1 and 2 are yes: Advantage.Bid must hold a Texas sales and use tax permit, collect state and local tax on the pilot seller's
   storefront sales, file returns, and certify to the pilot seller that it collects on their behalf.
   **Does Advantage.Bid already hold a Texas permit (for example, from auction sales)?**
4. If Advantage.Bid is a remote marketplace provider below the threshold: is it required to collect, and **may** it
   collect voluntarily (register, collect and certify)? If it does not collect, the pilot seller collects and remits the tax
   on their own sales; decide how (5).
5. If the seller collects: Stripe Tax cannot calculate Texas tax without a Texas registration on Advantage.Bid's account.
   Options: (a) register for calculation and set the Texas rule to `seller` (tax passed to the seller with the payout),
   if the CPA confirms this is acceptable; or (b) collect nothing at checkout and the seller accounts for the tax itself.
   Option (b) is the rule "Not collected at checkout; the seller handles its own tax" and needs the CPA's explicit
   confirmation.
6. **Rate for the pickup location:** confirm that local tax is sourced to the pickup location (the pilot seller's confirmed pickup
   address) and that Stripe Tax's Texas calculation matches the Comptroller's rate locator for that address.
7. **The pilot seller:** whether the owner's personal seller business needs its own sales tax permit for its state and files returns (in every option).
8. **Certification wording:** if Advantage.Bid collects, add the marketplace-provider certification to the seller-facing
   terms or send it to the pilot seller in writing (it can be part of an agreement).
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
4. Certification to the pilot seller (if Advantage.Bid collects).
5. **Check before the pilot:** with the pilot switched on for the pilot buyer account only, open a pilot seller test
   item and review the order (the review screen shows the tax line before paying). The tax line must match the rule:
   tax at the pickup address's rate when collected, none when not collected at checkout. A refusal message means the
   registration and the rule do not match: stop and check them.

## Sources (Texas Comptroller)

- Marketplace providers and sellers: https://comptroller.texas.gov/taxes/sales/marketplace-providers-sellers.php
- Remote sellers and marketplace FAQ: https://comptroller.texas.gov/taxes/sales/remote-sellers-marketplace-faq.php
- Remote sellers: https://comptroller.texas.gov/taxes/sales/remote-sellers.php
- Local sales and use tax collection (Publication 94-105): https://comptroller.texas.gov/taxes/publications/94-105.php
- Engaged in business (Publication 94-108): https://comptroller.texas.gov/taxes/publications/94-108.php
