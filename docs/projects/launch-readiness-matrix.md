# Launch Readiness Matrix — Advantage.Bid

**Governing objective:** Launch Advantage.Bid.
**Governing question:** *What prevents the first real customer from successfully completing a real auction from beginning to end?*
**Launch context:** single‑tenant (Advantage is the sole operator), **Stripe TEST**. Multi‑tenant Partner self‑service is a *later* gate (RLS review precedes it).

Status: ✅ ready · 🟡 partial · 🔴 broken/missing. Severity: **P0** prevents first real auction · **P1** before Stripe LIVE · **P2** soon after · **P3** enhancement.

_Synthesized from 7 parallel subsystem audits (2026‑07‑06) + direct source verification of contested findings._

## Matrix

| Subsystem | Status | Confidence | Tested | Blocking | Sev | Notes |
|-----------|--------|-----------|--------|----------|-----|-------|
| Seller: enroll → create → lots → images → edit → submit(lock) → moderate | ✅ | High | integration (partial) | no | Wired; edit‑lock enforced server‑side. Submit→lock untested. |
| Seller: **publish** | 🔴 | High | none | **YES** | **P0** | `publishAuction` allows NULL `start_time`/0 lots → auction never activates/closes (dead). `auctionService.js:583` |
| Buyer: register → login → terms → bidder approval → card‑on‑file | ✅ | High | unit | no | Card‑on‑file **enforced** (`assertCanBid`+register, `auctionRegistrationService.js:48,116`). |
| Buyer: bidding, proxy/max, watchlist, my‑bids | ✅ | High | unit (exhaustive) | no | Server‑side gates solid; FOR UPDATE serialized. |
| Buyer: card verification method | 🟡 | High | none | no | SetupIntent only; sub‑$1 temp charge (business rule) is a TODO stub. **Owner decision.** P1 |
| Auction engine: schedule, increments, anti‑snipe/soft‑close, close, winner | ✅ | High | partial | no | Dual close (per‑lot 30s + auction‑level). Winner recorded. Worker forked+restart. |
| Auction engine: **winner notification (per‑lot close)** | 🟡 | High | none | no | `runLotAutoClose` doesn't enqueue WINNING; auction‑level close does (latency + dup risk). P1 |
| Payments: Stripe TEST, PaymentIntents, webhooks, refunds, invoices | ✅ | Med‑High | partial | no | Code sound; sig‑verify + idempotent dedup + auto‑issue invoices on close. **e2e unproven.** |
| Payments: buyer premium, tax, seller payout **execution** | 🔴(stub) | High | none | no | Hardcoded 0 / no transfer. Required before **Stripe LIVE** (separate gate). P1 |
| Pickup: schedule, windows(48h), assign, packet | ✅ | Med | none | no | Wired. |
| Pickup: **completion + no‑show** | 🔴 | High | none | no | `markPickupCompleted` missing; missed‑detection/penalty not wired to a job/billing. P1 |
| Notifications: outbid, won, follower, rejected/returned, password reset, receipt | ✅ | High | unit | no | Working via `notifications_queue → notificationWorker` (SES). |
| Notifications: **registration, pickup‑scheduled, payment‑confirmed(event), payment‑failed, pickup reminders** | 🔴 | Med | none | no | `notificationService._sendEmail` mocked / events never emitted. P1 |
| Admin: moderate, publish(PATCH), invoices, refunds, payouts, audit view | ✅ | High | integration | no | Solid. `POST /publish` is a 501 stub (PATCH works) — P2. |
| Reporting: auction report, PDF, payout, audit log | ✅ | High | partial | no | Payout `summary.*` mismatch **RESOLVED**. `reportPdfService` = buggy dead code (P3 delete). |
| Security: auth, PII masking, data integrity, money‑as‑cents | ✅ | High | partial | no | Strong. Address redacted pre‑payment; numeric paddles; FKs; FOR UPDATE. |
| Security: org isolation (multi‑tenant) | 🟡 | High | none | no | No cross‑seller access today (single‑tenant). Multi‑tenant `organization_id`/RLS = later gate. P3‑now |
| Security: **audit logging coverage** | 🟡 | High | none | no | auction create/state, lot update, bid placement not audited. P1 |

## Open blockers (worklist, strict launch lens)

**P0 (must fix to launch):**
- **LR‑P0‑1 — Dead‑auction on publish without start_time / lots.** `publishAuction`. Guard server‑side. *(Sprint 1)*

**P1 (before Stripe LIVE / launch‑hardening):**
- LR‑P1‑1 Per‑lot close doesn't emit WINNING promptly (+ dup risk). *(Sprint 1 — bundled, cheap+high‑value)*
- LR‑P1‑2 Mocked/missing notifications: registration, pickup‑scheduled, payment‑failed, pickup reminders. *(Sprint 2)*
- LR‑P1‑3 Pickup completion + no‑show worker + penalty→billing. *(Sprint 2)*
- LR‑P1‑4 Audit logging on auction/lot/bid. *(Sprint 2)*
- LR‑P1‑5 Buyer premium + tax activation; seller payout execution. *(Sprint 3 — Stripe‑LIVE gate)*
- LR‑P1‑6 Card verification method (temp charge vs SetupIntent). *(Owner decision)*
- LR‑P1‑7 Payment webhook / refund e2e proof. *(Sprint 1 validation on staging Stripe TEST)*

**P2/P3:** `POST /publish` 501 stub; paddle‑number race; delete `reportPdfService`; stale card comment; dedicated "my wins" endpoint.

## Sprint plan
- **Sprint 1 — "The auction completes end‑to‑end" (P0):** publish guard (start_time + ≥1 lot); WINNING enqueue in `runLotAutoClose` + dedupe in `closeAuction`; integration tests (publish guard + close/winner); **live staging Stripe‑TEST full‑lifecycle validation** (create→publish→bid→close→winner email→invoice→pay→webhook→paid).
- **Sprint 2 — "Notifications & pickup close‑out" (P1):** fix mocked notification path; add registration/payment‑failed/pickup‑reminder/pickup‑scheduled; `markPickupCompleted` + missed‑pickup worker; audit logging on auction/lot/bid.
- **Sprint 3 — "Payments for LIVE" (P1, Stripe‑LIVE gate):** buyer premium + tax activation; seller payout execution; webhook/refund e2e.

## Sprint log
_Sprint 1: in progress._
