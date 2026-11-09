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

1. **Owner checks in the live Stripe Dashboard** (the app cannot read the live keys):
   - Tax: the states where the account is registered to collect sales tax (Stripe Tax only taxes where registered).
   - Webhook endpoint `https://bid.advantage.bid/api/payments/webhook` receives `payment_intent.succeeded`,
     `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`,
     `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`; the Connect endpoint receives
     `account.updated` (or the same endpoint with Connect events).
2. **Tax rules:** for every state where tax will be charged, an administrator enters who remits it (Admin > Storefront
   Tax Rules, with the professional advice as the legal basis). A taxed order in a state without a rule is refused.
3. **First seller ready: Lewis & Maese** (seller company `118458af-6b07-4806-86a4-b927d2b0cbed`, slug lewis-and-maese;
   read-only check 2026-11-09: active, verified, storefront published, 9 live Texas items $180 to $2,400, signed agreement
   v3 only, no payout account, Store Terms only in draft):
   1. **Seller Agreement v4.** Lewis & Maese sign in and open `https://bid.advantage.bid/sign-agreement.html?current=1`
      (the current version is issued in the app, no email), read and sign. Alternative: Admin > Agreements, send v4 (this
      emails them the signing link; a deliberate one-off send, the owner's choice). Their v3 signature stays on record.
   2. **Direct deposit (Stripe Connect, live).** Signed in, Payout Profile (`/payout-profile.html`), Set Up Direct Deposit:
      Stripe's own pages collect the business details, identity and bank account. When they return, the page shows
      "Direct Deposit Ready" once Stripe activates transfers and payouts. First-time setup needs no password; any later
      change of bank needs their password (payout safeguards).
   3. **Store policies (required: checkout refuses a seller without both, 2026-11-09).** Publish their Store Terms (their
      return and refund rules; Seller Storefront > Policies; their draft does not cover returns yet). Their published
      Shipping & Pickup Policy (v1) is written for auction winners ("if you are the winning bidder") and has no pickup
      location, hours or arrangement, only "Any Item(s) left after 30 days will be forfeited": they should publish a
      storefront version stating where, when and how buyers collect, the pickup deadline and what happens to uncollected
      items (the forfeiture wording is flagged for attorney review). Buyers acknowledge both at checkout.
   4. **A test item** for the controlled purchase (their cheapest live item is $180): ideally a low-priced real item.
      Stripe keeps its card fee when a payment is refunded (about 2.9% + 30 cents), which Advantage.Bid absorbs.
4. **Purchase terms:** publish the approved Fixed-Price Purchase Terms (docs/legal/storefront-purchase-terms-addendum-draft.md,
   after counsel review and the owner's choice of how to publish them) before any real buyer pays. Confirm the checkout's
   short "Before you pay" summary (public/item.html, #purchaseRules) matches the published wording.
5. **Pilot:** set `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=118458af-6b07-4806-86a4-b927d2b0cbed` (Lewis & Maese) and
   `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<the owner's own buyer account id>`. Only that buyer can buy, and only from Lewis & Maese.
6. **Controlled live purchase:** buy the test item (a real card), check the order, the seller notice, the 9% (or 5% from the
   seller's own website) commission, the recorded card fee (within minutes), the seller order page; refund it in full
   from Admin; check the Stripe refund and the order.
7. **Payout dry run:** after a second real purchase that is picked up and whose 48-hour reporting period has ended, prepare the week and pay the seller from Admin
   (a real Connect transfer); confirm it in Stripe.
8. **Open:** set `MARKETPLACE_CHECKOUT_ENABLED=true` (all verified sellers, all signed-in buyers). Remove the pilot lists.

## Rollback

- Instant: unset `MARKETPLACE_CHECKOUT_ENABLED` (and the pilot lists). Checkout stops; browsing, orders already paid,
  fulfillment, refunds and payouts keep working.
- Code: revert the merge on main and push. Migration 220 is additive and ignored by the previous code.
- Full restore: the backup branch from step 1 (never needed for a switch-off).

## Post-deployment verification

Health OK; checkout still off for everyone (item pages show Contact Seller); `/api/marketplace/config` reports
checkout off; payout profile asks for the password on a destination change; record counts unchanged.
