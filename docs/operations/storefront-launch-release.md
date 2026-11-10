# Professional Storefront launch release (owner approval required before merge, migration or activation)

Branch `feat/storefront-launch` = production baseline `3b3ac8a` plus:

| Change | Why |
|---|---|
| Payout safeguards ported from PR #86 (without auction shipping) | A suspended seller is never paid without an audited override; payout-destination changes are audited, emailed and need the password or an emailed one-time code; a payout within 7 days of a change waits for an audited review; Connect changes are audited; a storefront payout hold is never released while a dispute is open |
| Migration 220 `account_verification_codes` | The emailed one-time code for accounts without a password (directory sign-in) |
| Fix: admin "Pay Seller" read on a second database connection inside its transaction | Found by the Stripe test-mode certification (hung on a single-connection database) |
| Fix: the actual card fee was never recorded | Stripe attaches it seconds after payment; now filled by the payment webhook and a five-minute backfill |
| Opt-in Stripe test-mode certification test | Real PaymentIntents, refunds, dispute, Connect transfer (9/9 pass) |

Not included: auction shipping and the shipped-order delivery delay (PR #86, migrations 218-219), Buyer Terms v4.
Verified 2026-11-09: the only migration is 220; no auction-shipping file, route, migration or switch is in the diff.

Related documents: docs/legal/storefront-purchase-terms-addendum-draft.md, docs/operations/storefront-sales-tax-decision-checklist.md,
docs/operations/stripe-live-webhook-verification.md.

## What already exists in production (from Release 1, PR #84 and the baseline)

Storefront inventory and publishing, dual distribution (seller website widget + Advantage.Bid marketplace + /shop),
multi-quantity stock with holds, 5% / 9% channel commission fixed per order by a signed website pass, checkout with
saved terms and seller policies, prepaid cards refused, sale notifications (seller email, owner text, Admin/Finance
email), seller order management and fulfillment with tracking, refunds (including after payout, recovered from the next
payout), dispute holds, weekly payouts (Wednesday 11:59 PM Eastern cutoff, admin Pay Seller by Stripe Connect transfer),
commission corrections, per-state tax responsibility rules. Production switches: settlements ON, Connect ON, Stripe
Tax ON, **checkout OFF**.

## Deploy (each step needs the owner's go-ahead)

1. Backup: Neon branch `prod-pre-storefront-launch` from production; verify counts match.
2. Migration 220: `scripts/prod-migrate-220.js --check`, `--dry-run`, then apply.
3. Merge to main and push (checkout stays OFF; nothing changes for buyers). Verify health and the deployment.

## Activation sequence (after the owner's decisions; each step needs the owner's go-ahead)

**Pilot seller (owner decision 2026-11-10):** the owner's new personal Professional Seller account, registered through
the normal signup, with a separate pilot buyer account (docs/operations/pilot-seller-onboarding.md). Lewis & Maese are
not used for any live test and none of their records are changed.

1. **Owner checks in the live Stripe Dashboard** (the live keys are sealed; the app cannot list them): the webhook
   endpoint carries the payment, refund, dispute and transfer events (docs/operations/stripe-live-webhook-verification.md).
2. **Sales tax** (docs/operations/storefront-tax-configuration-steps.md): from the CPA's written determination, which must
   cover the pilot seller's pickup state and the effect on auction invoices (a Stripe Tax registration applies to
   auctions too), add any registration and enter the state's rule in Admin > Tax Jurisdictions. Without a rule, the
   sales tax safeguard (d38a2da) refuses every order in that state.
3. **Legal** (docs/legal/storefront-terms-review-packet.md, section 7): after attorney review and the owner's approval,
   post Terms of Service section 3A, the Schedule A note and the Privacy Policy amendment, then publish Buyer Terms
   Version 4 (with the Sales Near You flag). Confirm the checkout's "Before you pay" summary matches.
4. **Pilot seller ready:** onboarding steps 1 to 13 of the pilot guide, including the administrator's business
   verification approval (the only administrator step). Both administrator emails verified.
5. **Pilot switch:** `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=<pilot seller company id>` and
   `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<pilot buyer account id>`. Only that buyer can buy, and only from that seller.
6. **Controlled live tests:** docs/operations/storefront-first-sale-test-plan.md (9% sale and full refund, multi-quantity
   5% website sale, pickup and reporting period, payout, optional shipping).
7. **Open:** `MARKETPLACE_CHECKOUT_ENABLED=true` and remove the pilot lists, only on the owner's explicit approval.

## Rollback

- Instant: unset `MARKETPLACE_CHECKOUT_ENABLED` (and the pilot lists). Checkout stops; browsing, orders already paid,
  fulfillment, refunds and payouts keep working.
- Code: revert the merge on main and push. Migration 220 is additive and ignored by the previous code.
- Full restore: the backup branch from step 1 (never needed for a switch-off).

## Post-deployment verification

Health OK; checkout still off for everyone (item pages show Contact Seller); `/api/marketplace/config` reports
checkout off; payout profile asks for the password on a destination change; record counts unchanged.
