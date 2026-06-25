# Auction Timezone Capture & Pickup Display — Staging Report

**Status:** Implemented and validated on **staging only**. **No production deployment** without approval.
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system`.
**Guardrails honored:** no Stripe/payments/buyer-premium/sales-tax/settlement/payout/invoice-numbering/invoice-PDF changes; **no schema change** (the `timezone` column already existed); no pickup-scheduler rewrite.

## Step 1 — Investigation findings
1. **`auctions.timezone` exists** — TEXT, nullable, no default (migration 001). **No new column needed.**
2. **Set only via admin PATCH** (auctionService update whitelist included `timezone`). `createAuction` did **not** accept it.
3. **Forms:** admin `moderation.html` had a timezone text input; the seller creation form (`seller-create.html`, the page that posts `pickupWindowStart/End`) had **none**.
4. **Public auction APIs** did not return `timezone`.
5. **Lot API** did not return it.
6. **pickupPacketService** did not select it.
7. **No timezone formatting existed** — pickup times were forced UTC; **no app-wide default constant**.
8. **Default:** none existed → **America/New_York** adopted.

## Step 2 — Capture (Auction Time Zone field)
- `public/seller-create.html`: new **"Auction Time Zone"** selector beside the pickup window — options America/New_York (default) · Chicago · Denver · Los_Angeles — sent as `timezone` in `POST /api/auctions`.
- `auctionService.createAuction`: now accepts + stores `timezone` (default `America/New_York`). Admin edit of `timezone` (moderation.html) already existed and is unchanged.

## Step 3 — Display in the auction timezone
Shared helpers `src/lib/pickupTiers.js` + `public/widgets/shared/pickup-tiers.js`: `fmtTime(d, tz)` / `windowLabel(w, tz)` now format in the auction's timezone, with `DEFAULT_TZ = 'America/New_York'` fallback. Applied to:
- **Pickup release packet** (assigned pickup time + per-lot times + tier windows) — `getPacketData` selects `timezone` and formats with it.
- **Public auction page** (`auction-view.html`) — Pickup window + Pickup Time A/B/C formatted in the auction tz, with a friendly tz label (Eastern/Central/…). `GET /api/auctions/:id/summary` now returns `timezone` (read-only).
- **Public lot page** (`lot.html`) — lot Pickup Time window formatted in the auction tz. `GET /api/lots/:id` now returns `auction_timezone` (read-only subselect).
- **Never browser-local** — pickup times read the same regardless of viewer.

## Step 4 — Data safety
No mass update. Existing auctions with NULL timezone **render as America/New_York** (fallback in `fmtTime`). **Backfill recommendation:** once auction timezones are confirmed (most are US-Eastern), optionally backfill `auctions.timezone='America/New_York'` where null — to be approved separately; not done here.

## Step 5 — Validation (staging)
**In-process (staging DB) — PASS** (fixture window 13:00–19:00Z = 9 AM–3 PM Eastern):
- timezone **America/New_York** → Pickup Time A = **9:00 AM – 11:00 AM** ✓
- timezone **America/Chicago** → A = **8:00 AM – 10:00 AM** (1 hr earlier, same instant) ✓
- timezone **NULL** → fallback Eastern → A = **9:00 AM – 11:00 AM** ✓
- `createAuction({timezone:'America/Denver'})` stored **America/Denver** ✓

**Live (deployed staging) — PASS:**
- `seller-create.html` includes the Auction Time Zone selector ✓.
- `GET /api/lots/:id` returns `auction_timezone:"America/New_York"`; `GET /api/auctions/:id/summary` returns `timezone:"America/New_York"` ✓.
- `auction-view.html` carries the tz formatting + friendly-label code; `pickup-tiers.js` exposes `DEFAULT_TZ` ✓.
- Pickup packet (admin) downloads **200**, valid `%PDF` ✓.
- (Guardrails re-confirmed in the Phase 3 prod run: invoice PDF unchanged, public auctions load, premium/tax 0 — no financial/Stripe/settlement behavior changed here.)

## Known gaps / recommendations
- **Entry-side tz:** the pickup-window `datetime-local` inputs are still interpreted in the *browser's* tz when converted to an instant; for a seller entering in a different tz than the selected auction tz, the stored instant can be off. DISPLAY is now correct in the auction tz; making ENTRY tz-aware (interpret the naive datetime in the selected auction tz) is a recommended follow-up.
- **Backfill** null timezones (see Step 4).
- Carried from Phase 3: unify `size_category`/`pickup_category`; converge the legacy slot scheduler with the computed model.

**Stop after staging validation. No production deployment without approval.**
