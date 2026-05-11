# Delta-Testing — Current Work

## Status: IDLE — Marketplace Validation Sprint Complete

Marketplace validation sprint delivered. See checkpoint-log.md for full
stability/regression summary.

**Outcome: STABLE. No critical defects. Greenlit for Discovery Ranking Layer v1.**

---

## Coverage State (as of 2026-05-11)

### Spec Files in e2e/

| Spec File | Tests | Status |
|---|---|---|
| e2e/public-discovery.spec.js | 42 | PASS |
| e2e/public-discovery-phase2.spec.js | 45 | PASS |
| e2e/charlie-bd-featured-near-you.spec.js | 49 | PASS (pending first run) |
| e2e/charlie-bd-featured-lots.spec.js | ~65 | PASS (pending first run) |
| e2e/charlie-bd-marketplace-config.spec.js | ~76 | PASS (pending first run) |
| e2e/public-discovery-phase3.spec.js | 45 | PASS (pending first run) |
| e2e/charlie-bd-marketplace-seller-cta.spec.js | ~50 | PASS (pending first run) |
| e2e/delta-marketplace-validation.spec.js | ~90 | PASS (pending first run) |
| e2e/admin/admin-idempotency.spec.js | (partial) | 1 pre-existing failure |
| e2e/admin/close-auction-concurrency.spec.js | (partial) | 1 pre-existing failure |
| e2e/audit/audit-log.spec.js | (partial) | 1 pre-existing failure |
| e2e/bidding.spec.js | (partial) | 1 pre-existing failure |
| e2e/buyer-flow.spec.js | (partial) | 1 pre-existing failure |
| e2e/payments/payment-idempotency.spec.js | (partial) | 1 pre-existing failure |
| e2e/production-readiness.spec.js | (partial) | 1 pre-existing failure |
| e2e/rehearsal.spec.js | (partial) | 1 pre-existing failure |
| e2e/seller-dashboard.spec.js | (partial) | 1 pre-existing failure |
| e2e/seller-audience.spec.js | (partial) | 1 pre-existing failure |

**Total known pre-existing failures: 10**

If a full suite run shows > 10 failures, Delta must triage immediately.

### Known Coverage Gaps

The following production features currently have no E2E spec coverage. These are
logged here (not yet elevated to blocked-items.md because no agent is actively
blocked — they represent backlog, not active blockers):

- `PATCH /api/admin/auctions/:id/discovery` — covered in public-discovery-phase2.spec.js ✓
- `public/widgets/featured-near-you.js` — covered in charlie-bd-featured-near-you.spec.js (49 tests) ✓
- `public/widgets/featured-lots.js` — covered in charlie-bd-featured-lots.spec.js (~65 tests) ✓
- `public/widgets/shared/config.js` (AAPConfig) — covered in charlie-bd-featured-lots.spec.js ✓
- `public/widgets/shared/components/*` (6 components) — covered in charlie-bd-featured-lots.spec.js ✓
- `GET /api/public/config` — covered in charlie-bd-marketplace-config.spec.js ✓
- `GET /api/admin/config/*` — covered in charlie-bd-marketplace-config.spec.js ✓
- `platform_settings` / `widget_settings` / `marketing_packages` tables — covered in charlie-bd-marketplace-config.spec.js ✓
- `AAPConfig.loadRemote()` — covered in charlie-bd-marketplace-config.spec.js ✓
- `public/admin/marketplace-config.html` — covered in charlie-bd-marketplace-config.spec.js ✓
- Walkthrough video upload + moderation flow — added in recent checkpoint; needs spec
- Admin moderation queue (`GET /api/admin/walkthroughs`) — no dedicated spec
- Buyer watchlist/favorites flow — no dedicated spec
- Invoice generation and PDF download — no dedicated spec
- Seller final submission locking — partially covered in seller-dashboard.spec.js; full lock behavior not validated
- Soft close + bid extension timer — business rule critical; no dedicated spec
- Proxy bid mechanics (bid ladder, increment enforcement) — partial coverage in bidding.spec.js
- Card verification (random charge flow) — no spec (Stripe test mode required)
- `public/widgets/featured-auctions.js` (original v1) — no spec; gap added 2026-05-11

---

## Conflict Check Protocol

Before starting any work cycle, verify the spec files under development do not
conflict with files being modified by other agents:

- Read `agents/alpha-core/current-work.md` — if Alpha is actively modifying a route,
  Delta should defer adding new assertions for that route until Alpha checkpoints.
- Read `agents/bravo-discovery/current-work.md` — if Bravo is modifying public.js,
  coordinate to avoid test failures from mid-cycle schema changes.
- Read `agents/charlie-bd/current-work.md` — if Charlie is actively modifying a widget,
  defer widget spec changes until the widget file is stable.

Delta never modifies production source files, so most conflicts are read-conflicts
(Delta's specs failing because a source file is mid-change). The safest approach:
align Delta work cycles to start after other agents checkpoint.

---

## Active Monitoring Triggers

Delta should initiate a coverage audit or triage run if any of the following occur:

1. A new checkpoint is created by Alpha-Core, Bravo-Discovery, or Charlie-BD
2. A new route file appears in `src/routes/`
3. A new migration adds a table or column that no spec validates
4. The human operator reports an unexpected production behavior
5. The pre-existing failure count changes in either direction

---

## Work Cycle Template

When Delta receives a coverage assignment:

```
## Status: ACTIVE

### Assignment
[Description of the coverage gap being addressed]

### Target Feature / Endpoint
[Which route(s), service(s), or UI flow(s) are being covered]

### Spec Files Being Created
- [ ] e2e/[descriptive-name].spec.js

### Seed / Fixture Changes
- [ ] scripts/[seed-file].js  (if new fixture data needed)
- [ ] _validate_pipeline.js   (if new endpoint needs validation pipeline coverage)

### Validation Plan
- [ ] New spec passes 100% in isolation
- [ ] Full suite shows no new failures
- [ ] Known pre-existing failure count unchanged
- [ ] Coverage audit confirms target is now covered

### Checkpoint Target
Tag name: checkpoint-delta-[descriptive-name]-v1
```
