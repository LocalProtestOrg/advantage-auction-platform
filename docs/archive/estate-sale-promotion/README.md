# Archived: Individual "Estate Sale Promotion" ($39 one-time)

## What it was
A one-time $39 Stripe Checkout purchase that let a private homeowner promote a single estate sale
as a native event (Phase 2B). It was built in commit `4e52997` (2026-08-04), followed by `9cc6107`
(UX polish) and `b8bc139` (ON CONFLICT fix), as a Stripe TEST / product-owner-review feature.

Customer pages (archived here, no longer served from `public/`):
- `promote-estate-sale.html` (public landing + checkout CTA)
- `estate-sale-welcome.html` (post-checkout success page)
- `create-estate-sale.html` (homeowner listing form)
- `my-estate-sales.html` (homeowner dashboard)

## Why it was disabled
Owner decision 2026-10-12: the offering was never owner-approved, and production purchases are zero.

## What remains in code (intentionally)
- `src/services/estateSalePromotionService.js` (service; `createCheckoutSession` refuses while disabled)
- `src/routes/estateSale.js` (mounted at `/api/estate-sale`): `GET /promotion` stays readable for
  historical records; `POST /checkout-session`, `POST /events` and `POST /events/:id/submit` return
  `410 { error: 'NOT_AVAILABLE', message: 'This offering is not available.' }`
- `src/services/estateSaleEmails.js` (receipt/moderation emails; no new purchases can trigger a receipt)
- Migration `105_one_time_purchases.sql` and the `one_time_purchases` table (no data removed)
- Webhook routing in `src/services/paymentService.js` (`product_type === 'estate_sale_promotion'`),
  kept so any historical Checkout session event is still processed safely
- Owner alert labels in `src/services/ownerAlertService.js`
- `scripts/stripe/setup-estate-sale-promotion.js` (TEST-mode setup script; do not run)

Side effect: `src/services/eventsService.js` routes homeowner (non-professional) `estate_sale` event
submission to this promotion, so homeowner estate-sale submission is currently unavailable.
Professional organizations are unaffected.

## Re-enabling (deliberate decision only)
The gate is the hard-coded constant `ESTATE_SALE_PROMOTION_ENABLED = false` in
`src/lib/launchGuards.js` (exposed as `estateSalePromotionEnabled()`). It is not an env flag: no
environment variable can re-open purchase. Re-enabling requires owner approval, flipping the constant,
restoring the pages from this folder to `public/`, and updating
`tests/estate-sale-promotion-disabled.test.js`.

## Production follow-up (owner / ops)
Remove the production Stripe price and the `STRIPE_ESTATE_SALE_PRICE_ID` environment variable from
production. Purchase is already refused in code regardless of that variable.
