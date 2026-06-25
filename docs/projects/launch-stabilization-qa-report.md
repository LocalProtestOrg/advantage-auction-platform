# Launch Stabilization — End-to-End QA Report

**Type:** Discovery-only QA. **No code was changed and no bugs were fixed** (awaiting explicit approval per directive).

> ## ✅ RESOLUTION UPDATE — 2026-06-25
> **H1, H2, M2, L1 are RESOLVED and LIVE IN PRODUCTION.**
> - **Production commit SHA:** `28bffd9`
> - **Production rollback tag:** `pre-launch-qa-fixes-2026-06-25` → `bf06ef8`
> - **Staging validation:** PASSED (full jest suite 234/234; live staging checks for H1/H2/M2/L1).
> - **Production smoke validation:** PASSED (health 200; H1 packet PDF 200/`%PDF`; H2 missing-tier 422 + valid-tier 201 normalized; M2 paid-resend 409; L1 final-report 409 with settlements OFF).
> - **Config confirmed unchanged:** Stripe TEST · Buyer Premium OFF · Sales Tax OFF · Seller Settlements OFF (`SELLER_SETTLEMENTS_ENABLED` not set).
> The per-item "current state" sections below are retained as the original discovery record; each now carries a **RESOLVED** line. Remaining items (M1, M3–M5, L2–L5) are unchanged and still open.
**Date:** 2026-06-25
**Method:** Code-level review + read-only API liveness checks, in the order Admin → Seller → Buyer → Cross-system, plus a security/authz pass.
**Assumed prod state (confirmed consistent with code):** Stripe TEST · Buyer Premium OFF · Sales Tax OFF · Seller Settlements OFF · Pickup Phase 3 LIVE · Auction Timezone LIVE · Timezone-aware entry LIVE.

## Environment & the reported 401 / socket-disconnect
- **No local dev server is running** — `localhost:3000/8080/5000/4000` all refused (`000`). Staging (`advantage-staging-production.up.railway.app`) and prod (`auctions.advantage.bid`) APIs are **up (200)**.
- **401 is by design:** `authMiddleware` (src/middleware/authMiddleware.js:11-23) returns **401** for a missing/invalid/expired Bearer token. Expected for unauthenticated calls to protected endpoints.
- **Socket disconnect is NOT a consequence of a REST 401.** Socket.io auth is **optional** (server.js:103-114): on connection it tries `jwt.verify(socket.handshake.auth.token)`; a bad/expired token is **caught** and the socket simply stays **anonymous** (no disconnect, no throw). So the REST-API auth path and the socket connection are independent.
- **Most likely root cause of the symptom:** testing a client against a **dev server that isn't running** (confirmed: nothing on localhost) — a down server yields connection failures for both REST and socket from one cause; alternatively a client-side "redirect to /login on 401" tears down the socket page-side. **Recommendation:** point the client at staging/prod (both up) or start the local server; this is an environment issue, not a server bug.

---

## Severity summary
| Sev | Count | Headline items |
|---|---|---|
| Critical | 0 | None (TEST mode; premium/tax/settlement off; no real-money path active) |
| High | 2 | Packet pickup-time header not timezone-aware; lot validation is a no-op stub |
| Medium | 5 | pickup_category↔size_category divergence; "payment required" email on paid invoice; no <$1 card verification; emails best-effort not queued; multi-lot per-lot charges |
| Low | 5 | send-final-report live emits payout figures; dirty pickup_category data; missing reg/bid-confirm emails; admin tz-mid-edit; address-mask regex edges |

---

## HIGH

### H1 — Pickup packet date/time header renders in SERVER timezone, not the auction timezone
- **STATUS: ✅ RESOLVED (2026-06-25)** — prod `28bffd9`; rollback `pre-launch-qa-fixes-2026-06-25`→`bf06ef8`; staging + prod smoke PASSED. `pickupPacketService` header now formats in the auction timezone (fallback America/New_York), matching the A/B/C tier rows.
- **SEVERITY:** High
- **AREA:** Cross-system / Pickup packet (timezone consistency)
- **REPRO:** 1) Auction with `timezone='America/Chicago'`, pickup window stored as 9 AM–3 PM Central. 2) Admin downloads the pickup packet. 3) Compare the sheet's "Pickup date/time" header to the "Assigned Pickup Time" and per-lot tier windows.
- **EXPECTED:** All pickup times on the packet display in the auction timezone (Central).
- **ACTUAL:** The A/B/C tier windows use `pt.windowLabel(..., a.timezone)` (tz-aware), but the header `inv.pickup`/`auction.pickup` come from `pickupWindowLabel()` → `fmtDateTime()` which calls `toLocaleString('en-US', {...})` **with no `timeZone` option** (src/services/pickupPacketService.js:39-46, 48-52). That renders in the **Node process timezone** (Railway ≈ UTC), so the header time can differ from the tz-aware tier rows and from the public pages.
- **FIX (not applied):** Pass `a.timezone` into `fmtDateTime`/`pickupWindowLabel` (same `timeZone` option already used by `pickupTiers.fmtTime`), with `America/New_York` fallback.
- **RISK:** Staff/buyers read a wrong pickup time on the release document (the core launch flow), causing missed/early arrivals and pickup-line confusion.

### H2 — Lot validation is a no-op stub; `size_category` (and title/image) never enforced server-side
- **STATUS: ✅ RESOLVED (2026-06-25)** — prod `28bffd9`; rollback `pre-launch-qa-fixes-2026-06-25`→`bf06ef8`; staging + prod smoke PASSED. `lotValidation` now enforces title + A/B/C tier; POST/PUT `/api/lots` normalize the tier from `size_category`/`pickup_category`, return 422 on missing/invalid, and persist `size_category` consistently (no backfill of existing rows — that remains a separate task).
- **SEVERITY:** High
- **AREA:** Seller / Lot Studio + data quality
- **REPRO:** 1) Create a lot via `POST /api/lots` (or Lot Studio) with no `size_category`. 2) It saves. 3) View the lot/packet.
- **EXPECTED:** `size_category` required (it drives the entire Phase 3 pickup-tier UX); title/image validated.
- **ACTUAL:** `src/validation/lotValidation.js:2-7` always returns `{valid:true, errors:[]}` — a stub. No server-side requirement for size, title, or images. Lots with null size render **"Pickup Time: Not specified"** on the lot page and packet.
- **FIX (not applied):** Implement `validateLotPayload` (require non-empty title and `size_category ∈ {A,B,C}`; enforce in `POST/PUT /api/lots`).
- **RISK:** Lots ship to launch with no pickup tier → buyers/staff have no arrival guidance; degrades the value of Phase 3 pickup scheduling. Currently ~21 prod / 68 staging lots already have null `size_category`.

---

## MEDIUM

### M1 — Two pickup A/B/C fields diverge: legacy slot scheduler (`pickup_category`) vs Phase 3 display (`size_category`)
- **SEVERITY:** Medium (latent; would be High if slot scheduling is activated)
- **AREA:** Cross-system / Pickup scheduling
- **REPRO:** 1) Lot with `size_category='A'` but `pickup_category='C'` (they agree only ~89% of the time in prod). 2) Admin generates a pickup schedule (`pickupScheduleService.generateSchedule`) → slot assigned by **pickup_category** (C). 3) Buyer pays → `assignPickupOnPayment` puts them in a **C** slot (pickupScheduleService.js, reads `lot.pickup_category`). 4) Public pages + packet show **Pickup Time A** (from `size_category`).
- **EXPECTED:** One source of truth for a lot's pickup tier.
- **ACTUAL:** Display/packet/assigned-time use `size_category` (src/lib/pickupTiers.js + pickupPacketService); the legacy slot system uses `pickup_category`. `pickup_category` also holds dirty values (`large`,`medium`,`small`,`M`,`S`) with no CHECK constraint. **Mitigation today:** `generateSchedule` is not auto-called at close and `assignPickupOnPayment` returns null without a schedule, so slots are dormant and the packet falls back to the auction window + computed tiers — the divergence is latent unless an admin generates a schedule.
- **FIX (not applied):** Unify on `size_category` (drive the slot scheduler from it too), add a CHECK + data cleanup on `pickup_category`, or formally retire the legacy slot system.
- **RISK:** If slot scheduling is ever turned on, buyers are told one pickup time but assigned a different slot.

### M2 — Admin "Resend invoice" sends a "payment required" email even for PAID invoices
- **STATUS: ✅ RESOLVED (2026-06-25)** — prod `28bffd9`; rollback `pre-launch-qa-fixes-2026-06-25`→`bf06ef8`; staging + prod smoke PASSED. `resend-invoice-email` now returns **409** on a paid invoice with a clear message directing the operator to "Resend receipt"; unpaid resend still works.
- **SEVERITY:** Medium
- **AREA:** Admin / Invoice ops
- **REPRO:** 1) Open a PAID invoice in the Auction Invoices module. 2) Trigger `POST /api/admin/invoices/:id/resend-invoice-email`.
- **EXPECTED:** Either resend the paid receipt, or refuse on a paid invoice.
- **ACTUAL:** `resend-invoice-email` (admin.js:810-816) calls `receiptService.sendUnpaidInvoiceEmail` (receiptService.js:222) which always builds the **"Invoice … — payment required"** email with no paid-status guard. (The sibling `resend-receipt` correctly 409s when not paid — admin.js:828-831 — but `resend-invoice-email` has no inverse guard.)
- **FIX (not applied):** In `sendUnpaidInvoiceEmail`/the route, short-circuit if the invoice is paid (return 409 or route to the receipt).
- **RISK:** A paid buyer receives a "payment required" notice → support confusion, possible duplicate-payment attempts.

### M3 — No <$1 card verification charge (business rule unmet)
- **SEVERITY:** Medium
- **AREA:** Buyer / Card on file
- **REPRO:** Add/replace a card → only a Stripe SetupIntent runs; no temporary sub-$1 verification charge.
- **EXPECTED:** CLAUDE.md rule: "Buyer card verification uses a temporary random charge under $1 at signup and card change."
- **ACTUAL:** `cardVerificationService.startVerification` is a `throw "Not implemented"` stub; card-on-file is SetupIntent-only.
- **FIX (not applied):** Implement the sub-$1 verification (or get explicit product sign-off to waive it). Gate behind Stripe TEST for now.
- **RISK:** Bad cards surface only at post-close charge time; business-rule/compliance gap.

### M4 — Invoice/receipt emails are best-effort direct SES (not queued); close-time fan-out
- **SEVERITY:** Medium
- **AREA:** Cross-system / Email reliability
- **REPRO:** Close an auction with many winners → one unpaid-invoice email per winner fires fire-and-forget; if SES throttles/fails, the row is logged (`audit_log` `invoice.email_*`) but **not retried**.
- **EXPECTED:** Reliable delivery with retry/backoff.
- **ACTUAL:** Receipts/invoice emails send directly via `emailService` (no `notifications_queue`); failures logged, no retry (documented in Phase 2D report).
- **FIX (not applied):** Move invoice/receipt emails into the retrying `notifications_queue` worker.
- **RISK:** Silent non-delivery of payment-required / receipt emails at scale.

### M5 — Multi-lot buyer charged per-lot (N PaymentIntents / N invoices / N packet sheets)
- **SEVERITY:** Medium
- **AREA:** Buyer / Cross-system (payments)
- **REPRO:** One buyer wins 5 lots → must pay 5 separate charges; gets 5 invoices and 5 packet sheets (one assigned pickup time shown, but separate charges).
- **EXPECTED:** Optionally one consolidated invoice/charge per buyer-per-auction.
- **ACTUAL:** `createPaymentIntent` is per-lot; invoices keyed `(lot_id,buyer_user_id)`; packet renders one sheet per invoice.
- **FIX (not applied):** Consolidated per-buyer-per-auction invoice + single PaymentIntent (larger change; design first).
- **RISK:** Higher decline/abandonment, more support load, fragmented buyer experience.

---

## LOW

### L1 — `send-final-report` is live and emails a seller a flat-10% payout breakdown despite "Settlements OFF"
- **STATUS: ✅ RESOLVED (2026-06-25)** — prod `28bffd9`; rollback `pre-launch-qa-fixes-2026-06-25`→`bf06ef8`; staging + prod smoke PASSED. `send-final-report` now gated behind `sellerSettlementsEnabled()`; returns **409** "Seller settlements are not active yet" unless `SELLER_SETTLEMENTS_ENABLED==='true'` (not set in prod), so no payout email can be sent while settlements are OFF.
- **SEVERITY:** Low (admin-manual, human-gated)
- **AREA:** Admin / Seller settlement
- **ACTUAL:** admin.js:672-686 calls the real `sendFinalSellerReport` (pdfGenerationService) which builds + emails an auction report incl. gross/platform-fee/seller-payout (flat 10% from reportingService). It is not a stub. **FIX/RISK:** Ensure operators know this is live; if "settlements off" must mean "no payout figures emailed," gate or hide the button. Risk: an admin emails a seller payout numbers prematurely.

### L2 — `pickup_category` has dirty values with no CHECK constraint
- **SEVERITY:** Low (data integrity)
- **ACTUAL:** prod `pickup_category` contains `large/medium/small/M/S` besides A/B/C; no CHECK enforced (migration 010 had a CHECK but the live column accepts these). **FIX:** add CHECK + normalize. **RISK:** feeds M1; silent mis-bucketing if slot scheduler activated.

### L3 — Missing registration-confirmation and bid-confirmation emails
- **SEVERITY:** Low
- **ACTUAL:** Per the financial audit, registration confirmation and bid confirmation emails are not wired (PAYMENT_CONFIRMED legacy mock superseded by the working receipt). **FIX:** add transactional emails. **RISK:** buyers lack confirmations; minor trust/support impact.

### L4 — Admin "change timezone mid-edit" reinterprets shown wall-clock
- **SEVERITY:** Low
- **ACTUAL:** In moderation edit, changing the timezone field reinterprets the displayed datetime in the new tz on save (intended, documented). **FIX:** add a hint to re-verify times after changing tz. **RISK:** operator accidentally shifts stored times.

### L5 — Address house-number masking is a leading-digit regex
- **SEVERITY:** Low
- **ACTUAL:** auctions.js summary strips leading digits (`replace(/^\s*\d+\s*/, '')`, line 209) to hide the house number pre-payment. Edge cases ("123-125 Main", "12B Main", unit-first formats) may garble or partially leak. **FIX:** structured address fields or a more robust mask. **RISK:** minor pre-payment privacy edge.

---

## What's solid (verified correct)
- **Admin authz:** every route in `admin.js` has `auth, role(['admin'])` (no gaps found).
- **IDOR-safe:** buyer invoice list/PDF check ownership → 403 (invoices.js:64, 84); `charge-lot` enforces winner-only (paymentService.js:234); admin-only packet/reconciliation (verified 401/403 in prior prod runs).
- **Refunds:** overspend guard + DB CHECK + idempotency-key required + 30s concurrency guard.
- **Reconciliation repair:** promotes to paid **only** with a real paid payment (invoiceReconciliationService.js:108-125) — never fabricates paid; duplicates/missing-buyer-lot are report-only.
- **Bidding gates:** withdrawn→403, not-open→422, auction-start gate (lots.js:171-178); soft-close/proxy logic present.
- **Realized-price privacy & address masking** enforced server-side.
- **Timezone-aware entry + display** correct on public pages and packet **tier rows** (the gap is only the packet **header** — H1).
- **Money:** integer cents throughout; premium/tax persist as 0 end-to-end; seller payout unchanged (flat 10%).

---

## Recommended fix order (if approved)
1. **H1** packet header timezone (small, high-impact pickup correctness).
2. **H2** enforce `size_category`/title server-side (small; prevents "Not specified" lots).
3. **M2** guard "resend invoice" on paid invoices (small).
4. **M1/L2** unify pickup tier field + clean/CHECK `pickup_category` (medium; do before any slot-scheduling activation).
5. **M4** queue invoice/receipt emails (medium reliability).
6. **M3, M5, L1, L3–L5** product-gated / larger — schedule per launch priorities.

**No fixes have been applied. Awaiting your approval to address any of the above (each can be done staging-first, no production change without sign-off).**
