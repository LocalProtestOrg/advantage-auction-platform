# SOP: Seller Onboarding

*Last updated: 2026-05-09 | Pilot phase*

---

## Overview

This SOP covers the steps from first seller contact through auction publication. Advantage Auction (admin) owns the publish step — sellers cannot publish their own auctions.

---

## Step 1 — Create Seller Account

1. Go to `/register` and create an account with the seller's email.
2. After registration, set the user's role to `seller` in the DB (or via a future admin UI):
   ```sql
   UPDATE users SET role = 'seller' WHERE email = '<seller-email>';
   ```
3. A `seller_profiles` row is created automatically on first login to the seller dashboard.

---

## Step 2 — Confirm Seller Profile Exists

Use the admin seller lookup endpoint to verify the profile was created:

```
GET /api/admin/sellers?search=<seller-email>
Authorization: Bearer <admin-token>
```

Expected: `data[0].seller_profile_id` is a valid UUID.

---

## Step 3 — Seller Creates & Submits Auction

Sellers work independently:
- Log in → `/seller-dashboard.html` → **Create Auction**
- Fill in auction details, add lots, choose 3 featured lots
- Submit for final review (locks seller editing)

Auction state transitions: `draft → submitted → under_review`

---

## Step 4 — Admin Reviews Submission

1. Check the admin diagnostics for submitted auctions:
   ```
   GET /api/admin/diagnostics/auctions
   ```
2. Open the auction in admin view (currently DB-level; admin UI TBD).
3. Verify required fields are complete:
   - Title, description, start/end time, pickup window
   - At least 3 lots with title, size category, and starting bid
   - Featured lots selected

---

## Step 5 — Publish Auction

Once review is complete:

```
PATCH /api/admin/auctions/<auction-id>/publish
Authorization: Bearer <admin-token>
Idempotency-Key: <any-uuid>
```

This changes state to `published` and enqueues `NEW_AUCTION` notifications to all followers of this seller.

---

## Step 6 — Confirm and Communicate

1. Verify `GET /api/admin/diagnostics/auctions` shows the auction as `published`.
2. Send the seller a confirmation email (manual during pilot).
3. The seller will see the auction as **Live** on their dashboard.

---

## Rollback / Issues

- If publish fails (409), the auction was already published or in the wrong state. Check `diagnostics/auctions`.
- If the seller cannot log in, verify their `role` in the `users` table.
- Contact: `advantageauction.bid@gmail.com`
