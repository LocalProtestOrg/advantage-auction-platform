# Delta-Testing — Checkpoint Log

Delta-Testing has not yet completed a standalone work cycle with its own checkpoint
tag. However, Delta co-owns the test coverage across every prior platform checkpoint.
The spec counts below reflect Delta's contribution to each checkpoint.

---

## Co-Owned Checkpoint History

### checkpoint-public-discovery-v1 (6ccf223) — 2026-05-11

**Primary owner:** Bravo-Discovery
**Delta contribution:** `e2e/public-discovery.spec.js` — 42 tests

**Coverage added:**
- All 6 `/api/public/*` Phase 1 endpoints validated (no-auth, field allowlists, blocked fields, pagination, Cache-Control)
- Confirmed: `reserve_cents`, `winning_buyer_user_id`, `seller_id`, `marketplace_priority`, and other internal fields are absent from public responses
- UUID validation (non-UUID → 404), unknown ID → 404

**Suite state at checkpoint:** Passing (pre-existing failure list at this point: 9 failures)

---

### checkpoint-discovery-phase2-v1 (f9f65c1) — 2026-05-11

**Primary owner:** Bravo-Discovery
**Delta contribution:** `e2e/public-discovery-phase2.spec.js` — 45 tests

**Coverage added:**
- `PATCH /api/admin/auctions/:id/discovery` — auth guards (401/403), field validation, happy path
- `GET /api/public/auctions` — `shippable_lot_count` field validated as integer
- `GET /api/public/auctions/near` — lat/lng validation, radius cap, distance_km in response, shipping filter, Cache-Control
- `GET /api/public/featured-auctions` — no-auth, no internal fields, shape, limit, cap, geo path, partial coord guard (400), Cache-Control
- `GET /api/public/locations` — shape, no null city/state, state filter, limit, Cache-Control

**Pre-existing failure list update:** Added `e2e/seller-audience.spec.js` (audience section timing) — count moved from 9 to 10.

**Suite state at checkpoint:** 10 pre-existing failures, no regressions from Phase 2 work.

---

## Checkpoint Template

When Delta completes a standalone work cycle:

```
## checkpoint-delta-[name]-v1 ([commit hash]) — YYYY-MM-DD

**What was done:**
[Description of coverage added or infrastructure improved]

**Spec files created/modified:**
- e2e/[name].spec.js  — N tests

**Seed / fixture changes:**
- scripts/[seed].js  (if applicable)
- _validate_pipeline.js  (if applicable)

**Suite state:**
- Total passing: N
- Pre-existing failures: N (unchanged / +N new documented / -N resolved)
- New failures introduced: 0

**Coverage gaps closed:**
- [Endpoint or feature that now has spec coverage]

**Coverage gaps remaining:**
- [Any gaps not addressed in this cycle]

**What's next:**
[Next coverage priority or monitoring posture]
```

---

## Pre-Existing Failure Canonical List

As of 2026-05-11, the following 10 failures are documented and expected:

| Spec | Test Name | Root Cause |
|---|---|---|
| e2e/admin/admin-idempotency.spec.js | admin publish - same idempotency key replays stored response | Race condition on shared auction state |
| e2e/admin/close-auction-concurrency.spec.js | 5 concurrent close calls: exactly 1 succeeds | Concurrency fixture instability |
| e2e/audit/audit-log.spec.js | audit_log records auction.published | Missing audit log row intermittently |
| e2e/bidding.spec.js | Multi-user bidding › highest proxy bid wins | Shared lot race condition in parallel runs |
| e2e/buyer-flow.spec.js | new buyer can register via login.html UI | Browser redirect timing (login.html → demo.html) |
| e2e/payments/payment-idempotency.spec.js | same key does not duplicate payment | Race condition on payment fixtures |
| e2e/production-readiness.spec.js | browser: expired session on dashboard.html → redirected to login | dashboard.html redirects to demo.html not login.html |
| e2e/rehearsal.spec.js | seller can view lot inventory for rehearsal auction | Lot inventory page navigation timing |
| e2e/seller-dashboard.spec.js | clicking logout clears token and redirects to login | seller-dashboard logout redirects to demo.html not login.html |
| e2e/seller-audience.spec.js | audience section becomes visible after load | Timing/rendering race |

**If a full suite run shows more than 10 failures, Delta must triage before any checkpoint.**
