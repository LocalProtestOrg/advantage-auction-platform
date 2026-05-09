# SOP: Payout Release

*Last updated: 2026-05-09 | Pilot phase*

---

## Overview

Seller payouts are tracked in the `seller_payouts` table and released manually during pilot. Automated ACH/check disbursement is not yet implemented.

---

## Step 1 — Identify Pending Payouts

```
GET /api/admin/payouts?status=pending
Authorization: Bearer <admin-token>
```

Fields returned: `payout_id`, `auction_id`, `seller_email`, `auction_title`, `gross_revenue_cents`, `platform_fee_cents`, `seller_payout_cents`, `payout_method`, `payout_status`.

---

## Step 2 — Verify Auction is Fully Paid

Before releasing a payout, confirm all winning lots have been paid:

```sql
SELECT l.id, l.title, p.status, p.amount_cents
  FROM lots l
  LEFT JOIN payments p ON p.lot_id = l.id AND p.status = 'paid'
 WHERE l.auction_id = '<auction-id>';
```

All winning lots should have a `paid` payment row. Disputed or unpaid lots should be resolved first.

---

## Step 3 — Calculate and Confirm Payout Amount

Confirm `seller_payout_cents` matches the expected amount:
- `gross_revenue_cents` = sum of all paid payments
- `platform_fee_cents` = buyer premium collected
- `seller_payout_cents` = gross minus platform fee

If numbers look off, audit with:
```sql
SELECT SUM(amount_cents) FROM payments WHERE lot_id IN (SELECT id FROM lots WHERE auction_id = '<auction-id>') AND status = 'paid';
```

---

## Step 4 — Disburse Payment

During pilot, disbursements are made manually outside the platform (bank transfer, check, etc.) using the seller's payout preferences on file:

```sql
SELECT * FROM seller_payout_preferences WHERE seller_user_id = (
  SELECT user_id FROM seller_profiles WHERE id = '<seller-profile-id>'
);
```

---

## Step 5 — Mark as Released

Update the payout row to reflect disbursement:

```sql
UPDATE seller_payouts
   SET payout_status    = 'released',
       payout_reference = '<check-number-or-bank-ref>',
       updated_at       = now()
 WHERE id = '<payout-id>';
```

---

## Step 6 — Confirm

Re-run Step 1 with `?status=pending` to confirm the payout no longer appears.

---

## Notes

- Never release a payout if there are open refund requests on the auction.
- Keep a record of the `payout_reference` for reconciliation.
- Contact: `advantageauction.bid@gmail.com`
