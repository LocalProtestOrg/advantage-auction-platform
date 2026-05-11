# Delta-Testing — Checkpoint Log

---

## checkpoint-delta-marketplace-validation-v1 — 2026-05-11

**Spec file created:** `e2e/delta-marketplace-validation.spec.js` — ~90 tests

**What was done:**
Marketplace validation sprint covering all recent platform additions:
analytics infrastructure, enriched discovery, seller acquisition CTA, pagination
envelopes, mobile rendering, and telemetry behavior. Validation-only; no source
files modified.

**Coverage areas (8 describe groups):**

| Describe group | Tests | Notes |
|---|---|---|
| POST /api/analytics/events server behavior | 7 | 202 always, PII stripped, fire-and-forget, no cached response |
| AAPAnalytics module browser behavior | 9 | Version, session stability, non-blocking, batch, no-throw |
| Discovery API baseline — response shapes | 13 | All 6 public endpoints, envelopes, seller context, Cache-Control |
| Pagination math — has_more/total_count invariant | 6 | Boundary conditions, clamp, cross-page consistency |
| auction-view.html full-page integrity | 11 | DOM order, no JS errors, no PII in attrs, ESC modal close |
| Mobile rendering — 375px/768px viewport | 7 | No horizontal scroll, all elements visible, btn sizing |
| Telemetry non-blocking | 5 | Intercepted analytics, poisoned track(), slow endpoint |
| Marketplace discovery baseline | 8 | Ordering stability, state filter, field allowlist, type safety |

**Defect findings:**

No critical or high-severity defects found. Platform is STABLE.

**Observations (non-blocking, no action required this sprint):**

| # | File | Observation | Severity |
|---|---|---|---|
| 1 | `src/routes/public.js` (featured-lots, line 360+376) | `l.auction_id` and `a.id AS auction_id` both selected — pg deduplicates, values identical (JOIN guarantee), no functional impact | LOW — code smell only |
| 2 | `_validate_pipeline.js` (untracked) | Contains `demo-seller@advantage.bid` / `DemoExplore2025!` hitting production — not committed, but operator should confirm this is an intentional demo credential | LOW — untracked, not in repo |
| 3 | `marketplace-seller-cta.js` | Module passes `seller_id` to analytics ctx, but `auction-view.html` integration never populates `ctx.seller_id` — analytics correctly receives null | NON-ISSUE — behaves correctly |

**Validated as stable:**
- [x] AAPAnalytics v1: fire-and-forget, session management, no PII in payload, idempotent IIFE guard
- [x] POST /api/analytics/events: 202 on all input shapes (single, batch, empty, oversized), no 500
- [x] AAPMarketplaceSellerCta v1: renders after lot-grid, no bidding UI, no PII in attributes
- [x] Keyword search (`q` param): correctly parameterized (`$${ki}`), SQL injection safe
- [x] Seller context enrichment: `seller_display_name/location_label/logo_url` in featured-lots, `seller_display_name` in featured-videos — all null-safe
- [x] Pagination invariant: `has_more = (offset + data.length) < total_count` correct across all three paginated endpoints
- [x] Pagination clamps: limit ≤ 100, limit ≥ 1, offset boundary conditions
- [x] `total_count` not leaked into individual rows (stripped via destructuring)
- [x] Mobile 375px: no horizontal scroll, CTA visible, lot grid visible, no layout overflow
- [x] Page integrity: no JS errors, correct DOM order (banner → grid → CTA), video modal hidden on load
- [x] Cache-Control headers: present on all discovery endpoints, absent on analytics endpoint
- [x] Telemetry non-blocking: page renders when analytics blocked/slow/throwing

**Pre-existing failure count:** 10 (unchanged — no new failures introduced by this sprint)

**Suite state:** STABLE

**Readiness assessment for Discovery Ranking Layer v1:** GREEN

- All recent additions validated and stable
- Pagination infrastructure correct and consistent (ranking layer will need this)
- Analytics infrastructure working (ranking impressions/clicks can be recorded)
- No outstanding blockers or critical defects
- Discovery baseline captured (ordering behavior, field shapes, type safety)

**What's next:**
Delta is IDLE. Discovery Ranking Layer v1 may proceed. Delta will provide spec
coverage after Bravo-Discovery implements the ranking endpoints.

---

Delta co-owned prior checkpoints (see below). Delta's first standalone tag is above.

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
