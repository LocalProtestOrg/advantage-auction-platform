# SOP: Refunds

*Last updated: 2026-05-09 | Pilot phase*

---

## Overview

Refunds are issued by an admin via the platform's refund endpoint. Full and partial refunds are supported. Stripe processes the reversal; the platform records the outcome.

---

## Step 1 — Identify the Payment

Find the `payment_id` for the lot in question:

```sql
SELECT p.id, p.lot_id, p.amount_cents, p.status, p.payment_intent_id
  FROM payments p
  JOIN lots l ON l.id = p.lot_id
 WHERE l.auction_id = '<auction-id>'
   AND p.status IN ('paid', 'partially_refunded');
```

---

## Step 2 — Determine Refund Type

| Scenario | Refund Type |
|---|---|
| Buyer never received item / full cancellation | Full refund |
| Partial damage / agreed partial credit | Partial refund |
| Duplicate charge | Full refund |

---

## Step 3 — Issue Refund

**An `Idempotency-Key` header is REQUIRED.** Generate a UUID per refund attempt
(e.g., `uuidgen` or `python -c "import uuid; print(uuid.uuid4())"`). The same
key is forwarded to Stripe so any network retry within 24h collapses to the
same Stripe refund — no double-disbursement risk.

If you omit the header the request is rejected with HTTP 400.

**Full refund:**
```
POST /api/admin/payments/<payment-id>/refund
Authorization: Bearer <admin-token>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "refund_amount_cents": <full-amount-in-cents> }
```

**Partial refund:** same shape, with `refund_amount_cents` set to the partial amount.

A successful response returns:
```
{
  "success": true,
  "data": {
    "payment_id": "...",
    "status": "refunded" | "partially_refunded",
    "refund_amount_cents": <this attempt's amount>,
    "stripe_refund_id": "re_...",
    "refunded_at": "<timestamp>",
    "refunded_amount_cents_total": <cumulative refunded across all attempts>
  }
}
```

**Error responses to be aware of:**
- `400 Missing Idempotency-Key header` — add the header.
- `409 Refund already in progress for this payment` — another refund attempt
  for this payment started within the last 30 seconds and hasn't finished.
  Wait and retry, or check `audit_log` for a `payment.refund_started` row.
- `422 Refund total would exceed payment amount (already refunded X of Y; requested additional Z)`
  — cumulative refund cap would be breached. Use the message to recompute the
  remaining refundable amount.

---

## Step 4 — Verify in Stripe

1. Log in to the [Stripe Dashboard](https://dashboard.stripe.com).
2. Search for the `payment_intent_id` from Step 1.
3. Confirm a refund is shown on the charge.

---

## Step 5 — Communicate to Buyer

Send the buyer a manual notification (email) confirming the refund amount and expected timeline (3–10 business days for credit cards).

---

## Refund Constraints

- Only `paid` and `partially_refunded` payments can be refunded.
- Partial refund amount cannot exceed the original payment.
- Once `refunded`, no further refunds are possible on that payment row.
- If a refund partially fails, check Stripe directly and reconcile manually.

---

## Notes

- The platform does NOT automatically notify buyers on refund — do it manually during pilot.
- Contact: `advantageauction.bid@gmail.com`
