# Seller-growth outreach revisions: DRAFT FOR OWNER APPROVAL

**Status:** DRAFT. Nothing here is applied to templates, pages or the database. Nothing is approved or sent.
**Date:** 2026-09-27. Code at ce363a5.
**Standing rules:** benefits first ([[feedback_pro_seller_benefit_first]]); dual distribution by design; claim only what is live.

## What the copy may claim (verified 2026-09-27)

| Claim | Status | Evidence |
|---|---|---|
| Online auctions under the company's name, shown on its own website AND on the Advantage.Bid marketplace | LIVE for professional accounts | white-label widget (token-scoped), marketplace publication rules |
| A company page on Advantage.Bid for companies without a website | LIVE, two forms: (1) the free directory listing they claim; (2) with a professional account, a storefront page at `bid.advantage.bid/pro/<company-name>`. The web address is created from the company name and can be changed by the seller; publishing is self-service | `server.js` `/pro/:slug`; demo `https://bid.advantage.bid/pro/heritage-home-estate-services` |
| Fixed-price items on the storefront, including unsold auction lots moved over in one step | LIVE, one item at a time; buyers **contact the seller** to buy | `seller-storefront.html`; `item.html` shows "Contact Seller" because checkout is off |
| Online checkout ("Buy Now") for storefront items | **NOT LIVE** (`MARKETPLACE_CHECKOUT_ENABLED` unset, Stripe TEST) | do not claim |
| Post estate sales free; they show on the company page and local Advantage.Bid pages; up to three active at a time | LIVE (company listing plan) | template A3 |
| Auction what is left after an estate sale | LIVE for professional accounts | auctions |
| $39 Estate Sale Promotion | LIVE but for **individual homeowners only**, not companies | `promote-estate-sale.html`; do not pitch to companies |
| Spreadsheet import, bulk photos, SKU search, bulk edits | **PLANNED** | `docs/roadmap/storefront-inventory-management.md`; do not claim |

## Constraints the revisions respect

- Email tests forbid "Professional Seller", any percentage and any dollar amount in E1 to A4 (`tests/claimedListing/outreach-safety.test.js`).
- Email tests also forbid em dashes.
- Every email keeps `{{footer}}` and `{{claim_link}}` and uses only existing variables.
- E1 must keep the sentence "your {{city}} location ... taken from public".
- The claim page must keep "This is my company, continue", "we never ask for payment details to claim a listing" and "written by Advantage.Bid from public business information".
- The database holds v1 DRAFT copies seeded from `src/services/claimedListings/templates.js`. Editing the file does not change them. Once approved, apply each change through the Toolbox draft editor **and** the file, so the tests keep matching.
- A claimed free listing does not include auctions or the storefront; those come with a professional account. So the emails present them as "also available", never as part of claiming.

---

## R1. E1 (first email): replace the opening line and the "Once it's yours" block

Current opening: "Advantage.Bid is an online marketplace where people in {{area}} look for estate sales and auctions. Our business directory includes a listing for {{company}}:"

Proposed:

```
People in {{area}} use Advantage.Bid to find estate sales and auctions, and our business directory includes a listing for {{company}}:
```

Proposed block, replacing the current "Once it's yours" list:

```
Once it's yours, you can:
- correct anything that is out of date
- add your logo and a description in your own words
- {{third_bullet}}

When you want them, Advantage.Bid can also help {{company}} sell more:
- Online auctions under your own company name. Each auction shows on your website and on the Advantage.Bid marketplace, so it reaches your customers and new buyers. No website? Your Advantage.Bid company page works as your home online.
- More from every estate: auction what is left after a sale, and offer items at a fixed price on your company storefront, where buyers contact you directly.
- An easier yes for clients: offer an estate sale, an online auction, or both.

None of that is needed to claim the listing.
```

Why: this leads with the seller's brand, more ways to sell, and winning estate contracts. It keeps marketplace distribution as part of every auction, not an option. It makes no fee, checkout, percentage or guarantee claims.

## R2. E2_NOCLICK: one added line after the `{{/no_website}}` block

```
If {{company}} does have a website, your online auctions can show there under your name too, and the same auctions reach buyers on Advantage.Bid.
```

Note: rendering this line only when a website is listed needs a `{{#has_website}}` section, which does not exist today. Either add that variable (a small code change, with tests) or show the line to everyone as written.

## R3. A3 (after claiming: "Have a sale coming up?"): one added paragraph after the first

```
Have contents left after the sale? You can auction them online under your company name, on your website and on Advantage.Bid, or offer them at a fixed price on your storefront.
```

## R4. A1 (after claiming: checklist): one added line at the end, before the sign-off

```
When you are ready, I can show you how online auctions and a company storefront could work for {{company}}. Call me at (551) 655-7050.
```
(A phone number rather than "reply", because reply handling is not live yet; see the pilot checklist.)

## R5. Claim page "What is Advantage.Bid?" (`src/routes/claimListing.js:50` and `public/claim-listing.html:32`)

Current: "An online marketplace where people find local estate sales and auctions, and where sellers run them."

Proposed:

```
Advantage.Bid helps estate sale companies and auction houses grow: post your sales, run online auctions under your own name on your website and our marketplace, and offer leftover items at a fixed price. Claiming your listing is free and is the first step.
```

## Leave unchanged
E2_CLICKED, E3, E4_REFRESH, CL_SELF_REQUEST and A2 cover only the claim itself (the link, corrections and next steps). Adding a pitch there adds risk without benefit.

---

## R6. Live page accuracy fixes (outside the emails; need approval before deploying)

1. **`public/professional-sellers.html` lines 262 to 264.**
   - The heading "Professional Storefront (Buy Now)" and the phrase "charged only when an item sells through Advantage.Bid checkout" describe checkout, which is off. The same page says buyers contact the seller.
   - Proposed heading: "Professional Storefront".
   - Proposed body: "Fixed-price items and unsold auction lots on your own storefront page. Buyers contact you to purchase today; when online checkout is switched on, a flat 11% selling fee (including card processing) applies to the item price only, not shipping or tax. No listing fees."
   - Keep the fee disclosure; it is the approved storefront rate.
2. **`public/widgets/shared/pro-upgrade-panel.js` lines 13 to 15.** These advertise "fixed-price Buy Now selling", "sell through checkout" and "Integrated checkout and direct-deposit payouts (Stripe Connect)". Proposed:
   - "Branded Professional Storefront: your own storefront page for fixed-price items and unsold auction lots."
   - "Storefront inventory and inquiries: list items, add photos, and answer buyer inquiries."
   - Remove the checkout and payouts line until checkout is live. It also exposes a vendor name.
3. **`public/seller-pilot.html`:** "nationwide" becomes "online" (a standing rule from [[project_seller_programs_page_governance]]).

## R7. Sales Toolbox playbook (`public/admin/sales.html`)
The playbook already carries benefits-first pitches and dual distribution. Proposed addition, one value-list entry:

```
More ways to sell: fixed-price items and unsold auction lots on your storefront page (buyers contact you). Estate sale companies can post sales free and auction what is left.
```

It must not mention spreadsheet import, bulk tools or online checkout until they are live. `tests/sales-benefits-first.test.js` must stay green.

## Approval checklist for the Owner
- [ ] R1 E1
- [ ] R2 E2_NOCLICK (and whether to add `has_website`)
- [ ] R3 A3
- [ ] R4 A1
- [ ] R5 claim page
- [ ] R6 live page fixes (1 to 3)
- [ ] R7 Toolbox line
