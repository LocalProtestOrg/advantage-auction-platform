# Storefront commerce: release and activation runbook

Branch `feat/storefront-commerce` (2026-11-02). Online purchasing stays OFF (`MARKETPLACE_CHECKOUT_ENABLED` unset) until the
owner authorizes activation. Nothing here moves money except an administrator's Pay Seller.

## What is in the branch
| Area | What it does | Switch |
|---|---|---|
| Storefront Branding | Logo (`seller_profiles.logo_url`) and banner photo (config `hero_image`) uploaded to the image store; URL option kept | always on |
| Website widget | Items open inside the seller's site (`/embed/storefront.html?item=`), Back to Storefront, browser back; seller-scoped item API | always on |
| Photo gallery | `public/widgets/shared/image-gallery.js` on item pages and in the widget | always on |
| Retail Shop, Gallery or Studio | professional seller type `retail_gallery_studio` (migration 211) | always on |
| Multi-quantity | stock reserved per order, released once, sold once; stock history (migration 212) | used by checkout |
| Sale gates | professional, active, verified (where required), agreement in place, payout account ready | every quote, order, payment |
| Storefront payouts | weekly records (Wednesday 11:59 PM Eastern cutoff), admin Pay Seller (migration 213) | `SELLER_SETTLEMENTS_ENABLED` + checkout on; pay also needs `STRIPE_CONNECT_ENABLED` |
| Paid-sale notice | admin/finance email (verified, active) + owner text | with checkout |
| Sell Online page | `/sell-online`, staged | `SELL_ONLINE_PAGE_ENABLED=true` |
| Multi-unit shipping | seller chooses "per item" or "per order" (`shipping_quantity_rule`, migration 214); unset = more than one cannot be shipped | always on |
| Agreement at first publish | drafts and the dashboard need no signature; publishing (single, bulk, relist) needs a signed or waived Seller Agreement, sent automatically | always on |
| Sales tax responsibility | Admin > Storefront Tax Rules, one rule per state (remitter + the advice relied on); a taxed order in a state without a rule is refused | with Stripe Tax |
| Refund after payout | recorded once, deducted from the seller's next payout, released if that payout is voided | with payouts |
| Buyer Terms version per order | `marketplace_orders.buyer_terms_version_int` | with checkout |
| Auction website widget | auctions, catalogs, lots and photos inside the auctioneer's own website (`/embed/auctions.html` + `.js`, key-scoped feeds `/api/public/widget/auctions/:id/lots`, `/lots/:id`); bidding opens Advantage.Bid in a new tab | always on |
| Website Widgets panel | both widgets (auctions, storefront) with Copy Embed Code, Copy Widget Link, Preview Widget, install steps (`widgets/shared/website-widgets.js`); member menu "Website Widgets" | always on |
| Smart Catalog Tools for items | suggestions (title, description, category) from the first photo, same service as auction lots; Save as Draft | always on (needs the description service key) |
| Agreement version for storefront | storefront publishing and sales need a signed version stating the 5% / 9% commission (migration 216); earlier signatures kept | always on |
| Refund responsibility | admin refund records who caused it; seller-caused card cost shown as eligible; deduction only with `STOREFRONT_SELLER_FAULT_RECOVERY_ENABLED=true` (off) | record always; deduction off |
| Commission by sales channel | 5% website sale / 9% marketplace sale on the item price (migration 215, `storefrontChannelService`); fixed on each order with how it was decided; actual card fee recorded per order | with checkout |

## Sales channel: how an order's commission is decided (owner decision 2026-11-03)
- **Website sale (5%)**: the browser loaded `/embed/storefront.html` as a frame on a site that is not Advantage.Bid
  (`Sec-Fetch-Dest: iframe`, `Sec-Fetch-Site: cross-site`, set by the browser, not by page scripts). Only then the
  server signs a website pass into the page; Buy Now passes it to the item page in the `#fragment`; the order verifies it
  (signature, 24-hour expiry, same seller) and binds it to the first buyer.
- **Marketplace sale (9%)**: everything else, including direct or shared links, search engines, the `/pro/<slug>`
  storefront link, Advantage.Bid pages, a widget shown on advantage.bid/www.advantage.bid, a copied pass used by another
  buyer, an expired, altered or other seller's pass. `?ref=widget` only changes the "Return to the seller" button.
- Returning shopper: the same browser within 24 hours of the website visit keeps the website rate for that seller.
  Checkout recovery ("Try again", another card): the same order, same rate.
- Review: Admin > Storefront Orders shows the channel, the rate, the website host and the actual processing cost;
  `marketplace_orders.sales_channel_basis` records why (`website_pass`, `no_pass`, `pass_expired`, `pass_invalid`,
  `pass_other_seller`, `pass_other_buyer`); a pass that fails its signature is also written to the audit log.
- Browsers without Fetch Metadata (very old Safari) never get a pass: those sales count as marketplace sales.
- Economics and refund consequences: `docs/operations/storefront-commission-economics.md`.

## Deploy (owner approval)
1. Neon backup branch (console), counts recorded.
2. `railway run node scripts/prod-migrate-211-216.js --check`, then `--dry-run`, then apply (one transaction; rolls back on any failure).
3. Push `main`; verify health, the storefront, the widget (in-frame item view) and the admin Storefront Payouts page (read-only).
4. Seller Agreement with the 5% / 9% commission (owner approval of the text first): `railway run node
   scripts/prod-publish-seller-agreement-version.js` (dry run), then `--apply --reason="Storefront commission 5% / 9%"`.
   This adds version 4 for FUTURE agreements only; versions 1-3 and every signed agreement stay exactly as they are.
   Do this right after step 3: from migration 216 on, a seller who signed only versions 1-3 (today: Lewis & Maese) cannot
   publish NEW storefront items until they sign version 4, and version 4 must exist to be sent. Their auctions, dashboard
   and drafts are not affected; existing live items stay live. The first time they publish, version 4 is sent to them
   automatically (or send it from Admin > Agreements).
Rollback: redeploy the previous deployment; the migrations are additive except the 212 index swap (reverse statements in each header).

## Before enabling live purchasing (Release 2 gates)
1. **Buyer Terms** generalized for storefront purchases, approved by counsel and published as the current version
   (framework: `docs/legal/storefront-buyer-terms-framework-draft.md`; the v4 draft is not approved).
2. **Sales tax**: CPA completes `docs/legal/storefront-tax-responsibility-matrix.md`; the confirmed rows are entered in
   Admin > Storefront Tax Rules; one live storefront tax calculation verified. Remittance automation stays off until approved.
3. **Shipping**: sellers who offer set-price shipping on multi-quantity items choose per item or per order.
4. **Race test on a real database**: create a Neon branch, then `RACE_DATABASE_URL=<branch> CONFIRM_DISPOSABLE=yes node scripts/checkout-race-test.js 40 7` must print PASS.
   **Done 2026-11-04: PASS** on a disposable branch of production (`race-test-disposable-2026-11-04`), 40 buyers against
   1, 7 and 39 units: never oversold, never sold twice, duplicate payments charged once, declined cards sell nothing and keep
   the hold, expired holds return every unit exactly once (two sweepers at once), two administrators refunding the same order
   at once send one refund. It found one defect, fixed on `feat/release2-payments`: refunding one buyer of a sold-out
   multi-unit item failed after the refund was sent (the item has other paid orders and stays sold); a refund that cannot be
   recorded is now also flagged for review. The test turns off every outside service (no email or text is sent).
5. A real verified seller with a signed agreement and a connected payout account (Connect status ready).
6. One authorized live test purchase, then refund it; check the receipt, seller notice, admin notice, stock, tax and settlement.
7. Explicit owner authorization; then set `MARKETPLACE_CHECKOUT_ENABLED=true` (and, at launch, `SELL_ONLINE_PAGE_ENABLED=true`,
   the Brilliant Directories redirect `www.advantage.bid/sell-online` to `https://bid.advantage.bid/sell-online` and the
   Sell Online menu link).

## Release 2: controlled live purchase, then activation (each step needs the owner's explicit go)
**Controlled pilot (built, off).** With `MARKETPLACE_CHECKOUT_ENABLED` still off, checkout works only when BOTH
`MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS` (seller_profiles ids) and `MARKETPLACE_CHECKOUT_PILOT_USER_IDS` (buyer user ids) list the
seller and the signed-in buyer. Everyone else, signed-out visitors and the website widgets see checkout as off (the same
"not currently available" answer). The hold sweeper and weekly payout preparation run while a pilot is set.

1. Prerequisites: 40-buyer race test PASS on a disposable Neon branch; counsel-approved Buyer Terms published as the current
   version; CPA-confirmed tax rules entered (Admin > Storefront Tax Rules) for the pilot seller's state; Seller Agreement v4
   signed by the pilot seller; the pilot seller's payout account connected in LIVE mode (today no Professional Seller has
   one; the only connected account is an Individual Seller's, test mode); `SELLER_SETTLEMENTS_ENABLED` / `STRIPE_CONNECT_ENABLED`
   as they are.
2. Owner sets the two pilot lists to one seller (e.g. the owner's own professional account) and one buyer account the owner
   controls. Nothing else changes; check from a private window that an ordinary visitor sees no Buy Now.
3. Owner buys one low-priced item with a real card: check the receipt, the seller and admin notices, stock (reserved, sold),
   the order's channel and 5% / 9% commission, tax and its remitter, the actual processing fee recorded, and the item page.
4. Owner refunds it in Admin > Storefront Orders (record who caused it): check the refund, stock returned, tax reversal,
   the order history and that the weekly payout excludes it (or records a recovery if already paid).
5. Optionally the weekly payout for a non-refunded pilot sale: Admin > Storefront Payouts, Pay Seller (the owner approves).
6. Clear the pilot lists. Activation: `MARKETPLACE_CHECKOUT_ENABLED=true`; then (separately) `SELL_ONLINE_PAGE_ENABLED=true`
   and the Brilliant Directories redirect and menu link (`docs/operations/sell-online-launch-instructions.md`).
**Rollback** at any point: unset `MARKETPLACE_CHECKOUT_ENABLED` and the pilot lists (checkout closes at once; existing orders,
refunds and payouts keep working through Admin).

## Release 2 deploy (migration 217, commission corrections)
1. `railway run node scripts/prod-migrate-217.js --check`, then `--dry-run`, then apply (2026-11-04: --check and --dry-run PASS).
   A new empty, append-only table and `storefront_payouts.adjustment_cents` (default 0); no existing row changes.
2. Push `main` (the refund fix, commission corrections, credential checks, Sell Online and phone-header fixes).

## Operating
- Commission corrections (Seller Agreement §6.9, version 4): Admin > Storefront Orders > Correct commission, after the seller
  asked for a review and the error is verified. Enter the date the seller asked and the reason (shown to the seller). The
  order keeps its original channel and fee; the difference (credit or charge) goes on the seller's next payout statement.
  More than 60 days after the payout needs the explicit override, which stays on the record. A wrong correction is corrected
  by a further correction; nothing is edited or deleted.
- Storefront Payouts (Admin, Operations): records appear after the Thursday preparation; review, Pay Seller (type the amount),
  Hold, Release, Void (its orders return for a later payout). A refund, dispute or hold after preparation blocks payment until
  the record is voided and prepared again.
- Stock history: `marketplace_stock_events` (reserved, released, sold, refunded, seller_adjusted).
- Refunds: administrator refund (Storefront Orders) returns money and takes units off the sold count; units are not restocked
  automatically.
