# Professional Seller storefronts: readiness assessment (2026-10-15)

Read-only assessment of the existing storefront commerce foundation (no rebuild). Production state: 2 Professional
sellers, both demo; `MARKETPLACE_CHECKOUT_ENABLED` gates Buy Now.

## Complete

- **Storefront page.** Settings live in `seller_profiles.storefront` with `storefront_slug` and `storefront_published` (migration 119).
  - Seller text is sanitized, and only Professional Sellers can edit.
  - The public `/pro/:slug` page (`public/storefront.html`, server-rendered SEO) shows auctions, past auctions, items, events and followers.
  - It has a rate-limited contact inquiry form.
- **Inventory, one of one.** `marketplace_items` has statuses draft, active, pending_purchase, sold and removed, plus a pickup location.
  - Items are created by one-click conversion of an unsold lot, a direct listing, or a batch conversion of up to 100 unsold lots.
  - Public item data is an allow-list that shows city and state only.
- **Buy Now checkout.**
  - The order and the item claim happen in one locked transaction with a 30-minute hold.
  - The database allows only one live order per item and one order per PaymentIntent.
  - Card confirmation is server-side, and prepaid cards are refused.
  - A payment that succeeds after its hold was lost is refunded automatically.
  - Expired holds are swept every 5 minutes.
  - Refunds (full, partial, made outside the app) reverse the tax and are flagged for admin review.
  - Order status moves through fulfillment steps and payout eligibility.
  - An earlier hardening commit (a41b924) fixed the double-sell and hold risks.
- **Fees and tax.** A flat 11% of the item price, disclosed in agreement §6.9. Stripe Tax uses the pickup location or ship-to address.
- **Seller and buyer pages:** `seller-storefront.html`, `seller-orders.html`, `item.html` and `marketplace-purchases.html`.
- **Tests:** about 130 across the checkout-hardening, orders, storefront, retail-UX, eligibility, Professional-only and white-label widget suites.

## Missing or partial

1. **Seller-site widget for storefront items.** The white-label widget shows auctions only (`/api/public/widget/auctions`).
2. **Buyer search.**
   - Searching covers auction lots only.
   - The marketplace feed has no fixed-price preset, so items are counted but can't be browsed or searched.
   - The storefront page has no search, filter or sort.
3. **Bulk import.** There is no CSV or spreadsheet import for items; only unsold-lot conversion exists.
4. **Integrity gaps.**
   - `updateItem` lets a seller change the status or price of an item that is on hold or sold, with no lock.
   - A second buyer gets a 500 error instead of a clean "not available" response.
   - Public item and storefront reads don't check Professional status or that the storefront is published.
5. **Retail payouts.** `payout_eligible` is set, but no money moves; retail orders are outside the payout process.
6. **Moderation.** There is no admin item review, takedown or report button.
7. **Shipping.** Carrier and tracking are free text, and the shipping charge is one flat amount. The `shippingAllowed` policy helper isn't built.
8. **Single-unit stock only.** There are no quantity or SKU fields, so multi-unit stock isn't supported. Defer this unless a seller needs it.
9. **Production configuration to verify:**
   - the checkout flag;
   - Stripe Tax head office and registrations (the test-mode head office is missing);
   - the webhook events.

## Shortest safe path (recommended order)

| # | Step | Size | Deploy |
|---|---|---|---|
| 1 | Integrity fixes: lock status and price while an order is live; clean 409 response; Professional-and-published visibility check; remove the stale comment. | S | Safe anytime |
| 2 | Production configuration check: flag, Stripe Tax, webhooks; run `scripts/accept-marketplace-checkout.js` in test mode. | S | Read-only |
| 3 | Moderation: admin item list with an audited takedown, plus a report button. | M | Before checkout opens |
| 4 | Retail payouts: eligible orders, after a hold window, flow into the existing manual settlement; seller proceeds report. | M | Before checkout opens (financial; owner approval) |
| 5 | Buyer search: a `marketplace` preset on the feed using the canonical visibility SQL; text, category, price, shippable and sort filters; search on the storefront page. | M | Read-only, any time |
| 6 | Storefront items widget: `/api/public/widget/items?key=`, using the existing key-to-organization scoping. | M | Read-only, any time |
| 7 | Bulk CSV import: upload, preview, validation, drafts by default, a per-row idempotency key, and a template. | M | Creates drafts only |
| 8 | Shipping policy helper and a seller reminder about off-platform sales. | S | |
| 9 | Pilot: enable Buy Now for one real Professional seller with a live key after steps 1–4. | — | Owner approval |
