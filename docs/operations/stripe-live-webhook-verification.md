# Live Stripe webhook verification (owner, Stripe Dashboard, live mode)

The app cannot read the live keys, so the owner checks these in the Stripe Dashboard. Nothing here changes any setting
unless a step says "add". Production has received webhooks before (last on 2026-09-28, auction payments), so an endpoint
exists; the check is that it carries every event storefront orders need.

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

## 4. A live check without a sale

Stripe Dashboard > the endpoint > "Send test event" sends a sample `payment_intent.succeeded`. The app answers 500 for a
sample (there is no matching order); that is expected and proves delivery and the signature. A real check happens at the
controlled first purchase (activation step 5 in docs/operations/storefront-launch-release.md).
