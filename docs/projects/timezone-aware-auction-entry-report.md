# Timezone-Aware Auction/Pickup Entry — Staging Report

**Status:** Implemented and validated on **staging only**. **No production deployment** without approval.
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system`.
**Guardrails honored:** no Stripe/payments/buyer-premium/sales-tax/settlement/payout/invoice-numbering/invoice-PDF changes; **no schema change**; **no new dependency** (native `Intl`); no pickup-scheduler rewrite.

## Step 1 — Investigation findings
1. **Conversion** is `seller-create.html` `getIso()` (was `new Date(v).toISOString()`), used for auction start/end, preview start/end, pickup window start/end.
2. **Browser-tz based — yes** (`new Date("YYYY-MM-DDTHH:mm")` interprets the naive value in the browser's tz).
3. **Forms:** `seller-create.html` (create) and `admin/moderation.html` (edit).
4. **Admin edit** used the same browser-tz save (`new Date(...).toISOString()`) and displayed the UTC wall-clock in inputs (`dtLocal`) — a latent round-trip skew; it has a `timezone` field.
5. **Server** stores the ISO instant as `timestamptz`; it does not reinterpret. So correctness must be produced client-side.
6. **Safest interpretation:** native `Intl` DST-correct offset algorithm (double-pass) — **no dependency**. (Therefore no stop required.)

## Step 2/3 — Implementation
**Shared helper** (no dependency, DST-correct, mirrored server/client):
- `src/lib/timezoneUtils.js` and `public/widgets/shared/timezone-utils.js`:
  - `localToUtcIso(localStr, tz)` → UTC ISO, interpreting the wall-clock in `tz` (default America/New_York). Double-pass offset via `Intl.DateTimeFormat.formatToParts` handles DST boundaries.
  - `utcIsoToLocalInput(iso, tz)` → `YYYY-MM-DDTHH:mm` wall-clock in `tz` (for datetime-local values).
- **Independent of the runtime/browser timezone** — derives purely from the IANA `tz` argument.

**Applied to:**
- **`seller-create.html`** — `getIso(id)` now uses `localToUtcIso(value, selectedAuctionTz)` for auction start/end, preview start/end, and pickup window start/end. Default America/New_York.
- **`admin/moderation.html`** — datetime-local inputs are now **rendered** in the auction tz (`utcIsoToLocalInput`) and **saved** by interpreting in the auction tz (`localToUtcIso` using the form's timezone field), so admin edits round-trip correctly (no browser-tz skew). Round-trip safe for the common case (edit times without changing tz); changing the tz reinterprets the shown wall-clock in the new tz, which is the sensible behavior.

## Step 4 — UI clarity
Helper text under the Auction Time Zone selector: *"All auction, preview, and pickup times entered on this form are interpreted in this auction time zone. Buyers also see pickup times in this zone."*

## Step 5 — Validation (staging) — PASS
**Conversion logic (Node, isomorphic with the browser helper):**
- 9:00 AM entry → stored UTC: **NY 13:00Z, Central 14:00Z, Mountain 15:00Z, Pacific 16:00Z**; each displays back as **9:00 AM** in its zone; round-trip `utcIsoToLocalInput` is exact.
- **DST:** January NY (EST) → 14:00Z, displays 9:00 AM (vs July EDT 13:00Z) — DST handled.
- **Browser-tz independence:** identical results under runtime `TZ=America/Los_Angeles` and `TZ=UTC` (NY 9 AM → 13:00Z in both).

**End-to-end round-trip via the real packet service (staging DB):** for each tz, `localToUtcIso(9:00/15:00)` stored on the fixture auction → `getPacketData` tier windows display **9:00 AM – 11:00 AM … 1:00 PM – 3:00 PM** in that tz; DST January case shows 9:00 AM. PASS.

**Deployed staging (live):** `timezone-utils.js` served (contains `localToUtcIso`/`window.TimezoneUtils`); `seller-create.html` uses `localToUtcIso` + helper text; `admin/moderation.html` includes the helper + uses `localToUtcIso`.

**Display surfaces unchanged behavior:** public auction page, public lot page, and pickup packet continue to display in the auction tz (from the prior timezone-display work) — now fed correct UTC instants from tz-aware entry. No payment/invoice/Stripe/tax/premium/settlement behavior touched.

## Known gaps / notes
- **Existing auctions** keep their previously-stored instants (entered under the old browser-tz logic); display still falls back to America/New_York for null timezone. No backfill performed (recommended separately).
- The admin "change timezone mid-edit" case reinterprets the displayed wall-clock in the newly-selected tz on save (intended), so an admin who only wants to relabel the tz without moving the clock should re-verify the times after changing it.

**Stop after staging validation. No production deployment without approval.**
