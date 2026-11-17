# Live Stripe webhook verification (owner, Stripe Dashboard, live mode)

The app cannot read the live keys, so the owner checks these in the Stripe Dashboard. Nothing here changes any setting
unless a step says "add". Production has received webhooks before (last on 2026-09-28, auction payments), so an endpoint
exists; the check is that it carries every event storefront orders need.

## What production already proves (read-only check, 2026-11-09)

The live secret key and webhook signing secret are sealed in Railway (not readable outside the running app), so the
endpoint list itself cannot be read from here. The app's own ledger of verified events (`stripe_webhook_events`, recorded
only after the signature check passes) shows **live-mode** deliveries of `payment_intent.succeeded` (48),
`charge.refunded` (13) and `account.updated` (1), the latest on 2026-09-28 (auction payments). So the endpoint delivered and
the signing secret matched as of that date. Never received in live mode: `charge.dispute.*`, `transfer.created`,
`transfer.reversed`, `payment_intent.canceled`. Those subscriptions can only be confirmed in the Dashboard (section 1).

## 1. Platform endpoint

Stripe Dashboard (Live) > Developers > Webhooks (Event destinations). Open the endpoint whose URL is
`https://bid.advantage.bid/api/payments/webhook`.

Confirm it is **Enabled** and includes these events (add any that are missing):

| Event | What the app does with it |
|---|---|
| `payment_intent.succeeded` | Marks the order paid if the browser step did not (idempotent); fills in the card fee |
| `payment_intent.payment_failed` | Records nothing (the buyer can retry) |
| `payment_intent.canceled` | Releases the reserved item |
| `charge.refunded` | Reconciles a refund made in the Stripe Dashboard to the order |
| `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` | Records the dispute, holds the seller payout, releases only when closed |
| `transfer.created`, `transfer.reversed` | Seller payout transfer status |
| `account.updated` | Seller Connect status (see section 3) |

Also handled (keep them if already selected; not needed for storefront sales): `payout.paid`, `payout.failed`,
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted` (memberships and promotions). This is the complete list the
app acts on (read from the webhook handler, 2026-11-09); an event outside it is acknowledged and ignored.

**Owner checklist (live mode):**
1. [ ] Endpoint `https://bid.advantage.bid/api/payments/webhook` is Enabled.
2. [ ] Payment events selected: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`.
3. [ ] Refund event selected: `charge.refunded`.
4. [ ] Dispute events selected: `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`.
5. [ ] Transfer events selected: `transfer.created`, `transfer.reversed`.
6. [ ] `account.updated` selected here or on a Connect endpoint (section 3).
7. [ ] Recent deliveries show HTTP 200 (none since 2026-09-28 is normal: no live activity since).
8. [ ] "Send test event" (`payment_intent.succeeded`) is delivered (the app answers 500 for a sample with no order: that
       proves delivery and the signature; section 4).

Then check **Recent deliveries**: the latest deliveries should show HTTP 200. Any 400 means the signing secret in Railway
(`STRIPE_WEBHOOK_SECRET`) does not match this endpoint's secret.

## 2. Signing secret

On the endpoint page, "Signing secret" (starts `whsec_`). It must equal the production variable `STRIPE_WEBHOOK_SECRET` in
Railway (sealed; the owner compares it there). Do not paste it anywhere else.

## 3. Connected accounts (seller payouts)

Seller payout accounts are Stripe **Accounts v2** recipients. Their status changes reach the app either through
`account.updated` on a Connect-enabled endpoint (secret in `STRIPE_CONNECT_WEBHOOK_SECRET`) or, if the account only sends
v2 events, through the seller's payout page, which re-reads the status from Stripe every time it is opened.
Check: Developers > Webhooks, is there an endpoint "listening to events on Connected accounts"? If not, no action is
required for launch; the seller opens their payout page after finishing onboarding and the status updates.

### 3a. Accounts v2 notifications (added 2026-11-17)

Seller payout accounts created from November 2026 are Accounts v2 recipients. Their status changes are NOT sent as
`account.updated`; they are sent as event notifications (thin payload), which need their own event destination. Until it
exists the app still works: the seller's payout page re-reads the status whenever it is opened, and a transfer to an account
that the processor has disabled is refused by the processor. The destination makes the recorded status update by itself.

Owner steps (Stripe Dashboard, LIVE mode; source: docs.stripe.com/webhooks, "Create an event destination"):

1. Developers > Webhooks (Workbench > Webhooks). Leave the existing destination as it is.
2. Create an event destination. Events from: **Your account**. Payload: **Thin**.
3. Select these five events:
   `v2.core.account[requirements].updated`, `v2.core.account[configuration.recipient].capability_status_updated`,
   `v2.core.account[configuration.recipient].updated`, `v2.core.account.updated`, `v2.core.account.closed`.
4. Destination type: Webhook endpoint. Endpoint URL: `https://bid.advantage.bid/api/payments/webhook` (the same address as
   the existing destination; a thin destination is a separate destination by design, not a duplicate).
5. Reveal the signing secret (`whsec_...`) and add it in Railway (production service) as a NEW variable named
   `STRIPE_ACCOUNTS_V2_WEBHOOK_SECRET`. Do not change `STRIPE_WEBHOOK_SECRET`. Paste the secret nowhere else.
6. After the redeploy, open the Timeless Treasures payout page once, or wait for the next account change, and check the
   destination's Event deliveries tab for HTTP 200.

The app verifies each notification's signature, ignores any event outside the five above, ignores an account it has no
record of, and never trusts the notification's content: it re-reads the account from the processor
(`stripeConnectService.applyAccountV2Event`; tests: `tests/stripe-accounts-v2-events.test.js`).

## 4. A live check without a sale

Stripe Dashboard > the endpoint > "Send test event" sends a sample `payment_intent.succeeded`. The app answers 500 for a
sample (there is no matching order); that is expected and proves delivery and the signature. A real check happens at the
controlled first purchase (activation step 5 in docs/operations/storefront-launch-release.md).
