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

**Full refund:**
```
POST /api/admin/payments/<payment-id>/refund
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "type": "full" }
```

**Partial refund:**
```
POST /api/admin/payments/<payment-id>/refund
Authorization: Bearer <admin-token>
Content-Type: application/json

{ "type": "partial", "amount_cents": <amount> }
```

A successful response returns `{ "success": true, "data": { "status": "refunded" | "partially_refunded" } }`.

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
