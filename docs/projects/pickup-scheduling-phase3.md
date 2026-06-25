# Pickup Scheduling & Release System — Phase 3 (Staging)

**Status:** Implemented and validated on **staging only**. **Do NOT deploy to production** without approval.
**Date:** 2026-06-24
**Branch:** `feat/phase2-invoice-system`.
**Guardrails honored:** no Stripe/payments/buyer-premium/sales-tax/settlement/payout/invoice-numbering/invoice-PDF/receipt/financial changes; **no database schema change** (read-only SELECT additions only).

---

## 1. Investigation findings

**Pickup scheduling.** `pickup_schedules` (1/auction, JSONB), `pickup_assignments` (1 row **per lot**, unique `lot_id`), `slots_capacity` (A/B/C sub-slots). `pickupScheduleService.generateSchedule()` splits the auction window into per-category sub-slots; `assignPickupOnPayment()` fills the next open slot. **Trigger: on payment success** (`paymentService.recordPaymentSuccess`), not at close. A multi-lot buyer gets **one assignment per lot** (can land in different slots). **The existing scheduler keys off `pickup_category`, not size, and does not consider item size.**

**Lot size fields.** `lots.size_category` (CHECK A/B/C), `lots.pickup_category` (A/B/C, **no enforced CHECK** in the live DB), `dimensions` (JSONB), `weight` (TEXT), `pickup_group` (unused), `shipping_notes`.

**Which field drives scheduling — the key finding.** Two overlapping A/B/C fields, and they diverge in real data (prod, 312 lots):
- **`size_category`**: 93% populated, **all clean A/B/C** (CHECK enforced). This is what Lot Studio's "Pickup Size" selector semantically means and what the buyer-facing tier should use.
- **`pickup_category`**: ~86% populated but **dirty** — contains `large`,`medium`,`small`,`M`,`S` in addition to A/B/C (no CHECK). This is what the **existing slot scheduler** reads; dirty values silently fall out of A/B/C bucketing.
- When both are set they agree only ~89% of the time.

**Decision (approved):** drive Phase 3's buyer-facing pickup tiers off **`size_category`** (clean, spec-aligned), as a **computed overlay** — no schema change, and the legacy `pickup_category` slot-assignment system is **left untouched** ("modify only if necessary"). Future consolidation/cleanup recommended (§5).

**Buyer assignment today.** Slot-based, per lot, on payment, keyed on `pickup_category`. Not size-aware. Multi-lot ≠ one appointment.

**Public catalog.** Auction page (`auction-view.html`) had a "Pickup Information" tab with **hardcoded** times (A 09:00–11:00 / C 11:00–12:30, B missing). Lot page (`lot.html`) showed **no** pickup info. Public APIs already return `auction.pickup_window_start/end` and `lot.size_category`; the lot detail API did **not** return the parent auction's window.

**Pickup release packet.** Already shows the auction window + a tier/size line (which I now upgrade to the full Phase 3 model).

---

## 2. Architecture (computed overlay — no schema change)

Pure helpers, shared logic in two runtimes:
- **`src/lib/pickupTiers.js`** (server) and **`public/widgets/shared/pickup-tiers.js`** (client): `splitWindow(start,end)` → 3 **equal** windows A/B/C (never hardcoded); `normTier(size)`; `timeLabel`/`itemLabel`; `assignedTier(sizes)` (largest item wins: any C→C, else any B→B, else A); `fmtTime`/`windowLabel`.
- **Clock times are formatted in UTC** for deterministic, viewer-independent display (pickup windows store the intended wall-clock; `auctions.timezone` is essentially unpopulated — see §5). Same clock on the packet and public pages.

**Step 2/3 — public auction page:** `populatePickupTab()` now shows Pickup Date, Pickup Window, and computed **Pickup Time A/B/C — Small/Medium/Large Items**, plus the required disclosure: *"Pickup times are assigned according to the largest item purchased. Small items are released first…"*

**Step 4 — public lot page:** shows **Pickup Time A/B/C — Small/Medium/Large** from `lot.size_category` (+ the computed window when the auction window is set); **"Pickup Time: Not specified"** when size is unset (never inferred). The lot detail API (`GET /api/lots/:id`) gained **read-only** `auction_pickup_window_start/end` (subselect; no schema change).

**Step 5 — buyer assignment (computed):** the buyer's assigned pickup time = `assignedTier(all their won lots' size_category)` → Pickup Time A/B/C. Computed at packet build (and trivially derivable anywhere) — **no modification to the existing payment-time slot assignment**, honoring "modify only if necessary."

**Step 6 — pickup release packet:** each sheet now shows **Assigned Pickup Time** (buyer-level, largest item, + window) and, in the item checklist, **each lot's individual pickup time**; multi-lot buyers get a line listing every lot + its pickup time. Release checklist, signatures, payment status, and totals are retained. Invoice PDFs untouched.

**Step 7 — Lot Studio:** an **"Add Packing Material Note"** button near the description in `lot-builder.html` appends exactly *"Please bring appropriate packing material for safe transport."* — user-initiated, **idempotent** (refuses if already present), append-only (never overwrites).

---

## 3. Files changed
- NEW `src/lib/pickupTiers.js`, NEW `public/widgets/shared/pickup-tiers.js` (pure helpers).
- `src/services/pickupPacketService.js` — per-buyer assigned tier + per-lot tiers + auction tier windows; sheet renders Assigned Pickup Time + per-lot times.
- `src/routes/lots.js` — read-only `auction_pickup_window_start/end` on `GET /:lotId`.
- `public/auction-view.html` — computed Pickup Time A/B/C + disclosure (replaces hardcoded times); includes helper.
- `public/lot.html` — lot pickup-time line; includes helper.
- `public/lot-builder.html` — Add Packing Material Note button + idempotent handler.
- `scripts/stg-validate-phase3.js`, `scripts/field-distribution.js` (diagnostics).

---

## 4. Validation results (staging)

**In-process (staging DB) — PASS:** window split = **A 9:00–11:00, B 11:00–1:00, C 1:00–3:00** (equal thirds, computed); multi-lot buyer (lots A + B) → **Assigned Pickup Time B** (largest item wins); per-lot tier correct (C lot → "Pickup Time C"); `assignedTier([A,A,C])=C`; packet renders valid PDF.

**Live (deployed staging) — PASS:**
- `/widgets/shared/pickup-tiers.js` served **200** (exposes `PickupTiers`).
- Lot API `GET /api/lots/:id` returns `size_category:"C"` + `auction_pickup_window_start/end` (09:00–15:00Z → 9 AM–3 PM) ✓.
- `auction-view.html` served includes the helper + the disclosure text ("assigned according to the largest item") + computed Pickup Time rows ✓.
- `lot.html` served includes the helper + the `lot-pickup-time` element + "Not specified" fallback ✓.
- `lot-builder.html` served includes the `btn-packing-note` button + the exact note text ✓.
- Pickup packet (admin) downloads **200**, valid `%PDF`, 5 sheets, `%%EOF` ✓.

_Visual confirmation recommended_ (the auction "Pickup Information" tab renders for a registered buyer; PDFKit text isn't machine-scannable). Manual UAT: registered buyer sees A/B/C times + disclosure; A/B/C lots show the right tier; unset → "Not specified"; Lot Studio button appends once and never duplicates.

---

## 5. Future recommendations
1. **Field consolidation / data integrity (high value):** two overlapping A/B/C fields with `pickup_category` holding dirty values. Recommend: enforce a CHECK on `pickup_category`, clean the dirty rows (`large`→`C`, `small`→`A`, etc.), and ideally **unify on a single field** (drive both the buyer-facing tier and the slot scheduler off the same clean column). Today Phase 3 (display) uses `size_category`; the legacy scheduler uses `pickup_category` — they can disagree.
2. **Server-side `size_category` requirement:** `lotValidation` is a stub (not enforced). Recommend requiring `size_category` on lot submission so "Not specified" becomes rare.
3. **Auction timezone capture:** `auctions.timezone` is essentially unpopulated, so pickup clock times are formatted in UTC for determinism. Recommend capturing/populating the auction's timezone (Lot Studio) and formatting in it.
4. **Unify the two pickup-time notions:** the new computed size-based "Assigned Pickup Time" vs the legacy payment-time slot assignment (pickup_category) should converge — ideally generate slot assignments from `size_category` at close.
5. **Step 8 handling flags (research only — NOT implemented):** Oversized Item, Forklift Required, Two-Person Lift, Fragile, Glass/Mirror, Bring Blankets, Bring Tie Downs, Bring Appliance Dolly. **Recommendation: yes, as future Lot Studio handling flags** — but as a small set of explicit **boolean flags** (not free text), stored on `lots` (a `handling_flags` JSONB or columns), surfaced on the lot page + packet, and printable on the release sheet. They are operationally valuable (staff safety + buyer prep) and complement the size tier (size = when; handling = how). Implement only after the size_category/pickup_category consolidation above, to avoid compounding the field sprawl.

**Stop after staging validation. No production deployment without approval.**
