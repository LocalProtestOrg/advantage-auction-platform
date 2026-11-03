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
2. `railway run node scripts/prod-migrate-211-215.js --check`, then `--dry-run`, then apply (one transaction; rolls back on any failure).
3. Push `main`; verify health, the storefront, the widget (in-frame item view) and the admin Storefront Payouts page (read-only).
4. Seller Agreement with the 5% / 9% commission (owner approval of the text first): `railway run node
   scripts/prod-publish-seller-agreement-version.js` (dry run), then `--apply --reason="Storefront commission 5% / 9%"`.
   This adds version 4 for FUTURE agreements only; versions 1-3 and every signed agreement stay exactly as they are.
Rollback: redeploy the previous deployment; the migrations are additive except the 212 index swap (reverse statements in each header).

## Before enabling live purchasing (Release 2 gates)
1. **Buyer Terms** generalized for storefront purchases, approved by counsel and published as the current version
   (framework: `docs/legal/storefront-buyer-terms-framework-draft.md`; the v4 draft is not approved).
2. **Sales tax**: CPA completes `docs/legal/storefront-tax-responsibility-matrix.md`; the confirmed rows are entered in
   Admin > Storefront Tax Rules; one live storefront tax calculation verified. Remittance automation stays off until approved.
3. **Shipping**: sellers who offer set-price shipping on multi-quantity items choose per item or per order.
4. **Race test on a real database**: create a Neon branch, then `RACE_DATABASE_URL=<branch> CONFIRM_DISPOSABLE=yes node scripts/checkout-race-test.js 40 7` must print PASS.
5. A real verified seller with a signed agreement and a connected payout account (Connect status ready).
6. One authorized live test purchase, then refund it; check the receipt, seller notice, admin notice, stock, tax and settlement.
7. Explicit owner authorization; then set `MARKETPLACE_CHECKOUT_ENABLED=true` (and, at launch, `SELL_ONLINE_PAGE_ENABLED=true`,
   the Brilliant Directories redirect `www.advantage.bid/sell-online` to `https://bid.advantage.bid/sell-online` and the
   Sell Online menu link).

## Operating
- Storefront Payouts (Admin, Operations): records appear after the Thursday preparation; review, Pay Seller (type the amount),
  Hold, Release, Void (its orders return for a later payout). A refund, dispute or hold after preparation blocks payment until
  the record is voided and prepared again.
- Stock history: `marketplace_stock_events` (reserved, released, sold, refunded, seller_adjusted).
- Refunds: administrator refund (Storefront Orders) returns money and takes units off the sold count; units are not restocked
  automatically.
