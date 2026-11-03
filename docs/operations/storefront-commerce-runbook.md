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

## Deploy (owner approval)
1. Neon backup branch (console), counts recorded.
2. `railway run node scripts/prod-migrate-211-213.js --check`, then `--dry-run`, then apply (one transaction; rolls back on any failure).
3. Push `main`; verify health, the storefront, the widget (in-frame item view) and the admin Storefront Payouts page (read-only).
Rollback: redeploy the previous deployment; the migrations are additive except the 212 index swap (reverse statements in each header).

## Before enabling live purchasing (owner decisions and checks)
1. **Buyer Terms** covering storefront purchases approved and published (the v4 draft is not approved).
2. **Sales tax remitting party** for storefront sales confirmed (CPA); one live storefront tax calculation verified.
3. **Per-unit or per-order shipping** for multi-quantity orders: today shipping is charged once per order.
4. **Agreement rule for long-standing sellers**: the sale gate accepts signed, waived or grandfathered sellers (the dashboard rule).
5. **Race test on a real database**: create a Neon branch, then `RACE_DATABASE_URL=<branch> CONFIRM_DISPOSABLE=yes node scripts/checkout-race-test.js 40 7` must print PASS.
6. A real verified seller with a connected payout account (Connect status ready).
7. One authorized live test purchase, then refund it; check the receipt, seller notice, admin notice, stock and refund.
8. Then set `MARKETPLACE_CHECKOUT_ENABLED=true` (and, at launch, `SELL_ONLINE_PAGE_ENABLED=true`, the Brilliant Directories
   redirect `www.advantage.bid/sell-online` to `https://bid.advantage.bid/sell-online` and the Sell Online menu link).

## Operating
- Storefront Payouts (Admin, Operations): records appear after the Thursday preparation; review, Pay Seller (type the amount),
  Hold, Release, Void (its orders return for a later payout). A refund, dispute or hold after preparation blocks payment until
  the record is voided and prepared again.
- Stock history: `marketplace_stock_events` (reserved, released, sold, refunded, seller_adjusted).
- Refunds: administrator refund (Storefront Orders) returns money and takes units off the sold count; units are not restocked
  automatically.
