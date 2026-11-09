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
3. **First seller ready** (the owner's own shop, per docs/operations/first-live-transaction-runbook.md): Professional
   Seller account, business verification approved, Seller Agreement v4 signed, live Stripe Connect onboarding complete
   (transfers and payouts active), storefront published, a low-priced test item.
4. **Pilot:** set `MARKETPLACE_CHECKOUT_PILOT_SELLER_IDS=<that seller company id>` and
   `MARKETPLACE_CHECKOUT_PILOT_USER_IDS=<the owner's buyer account id>`. Only that buyer can buy from that seller.
5. **Controlled live purchase:** buy the test item (a real card), check the order, the seller notice, the 9% (or 5% from the
   seller's own website) commission, the recorded card fee (within minutes), the seller order page; refund it in full
   from Admin; check the Stripe refund and the order.
6. **Payout dry run:** after a second real purchase that is picked up, prepare the week and pay the seller from Admin
   (a real Connect transfer); confirm it in Stripe.
7. **Open:** set `MARKETPLACE_CHECKOUT_ENABLED=true` (all verified sellers, all signed-in buyers). Remove the pilot lists.

## Rollback

- Instant: unset `MARKETPLACE_CHECKOUT_ENABLED` (and the pilot lists). Checkout stops; browsing, orders already paid,
  fulfillment, refunds and payouts keep working.
- Code: revert the merge on main and push. Migration 220 is additive and ignored by the previous code.
- Full restore: the backup branch from step 1 (never needed for a switch-off).

## Post-deployment verification

Health OK; checkout still off for everyone (item pages show Contact Seller); `/api/marketplace/config` reports
checkout off; payout profile asks for the password on a destination change; record counts unchanged.
