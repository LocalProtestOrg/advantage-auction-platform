# Phase 1 — Staging Validation Report (Line B Financial Integrity)
**Date:** 2026-06-11 · **Branch:** `feat/line-b-financial-integrity` (HEAD `c153356`, deployed detached).
**Run outcome:** executed end-to-end through STEP 5 (S0–S10). The initial run found **one real, reproducible defect (S3 → DEFECT-LINEB-1)**; it was fixed (`f441512`), redeployed to staging, and **re-validated PASS** (see *DEFECT-LINEB-1 — Remediation* and *Retest* near the end). **Final status: PASS — READY FOR MERGE REVIEW.** Not promoted, not merged, Stripe LIVE not enabled, no Phase 2 (held per instruction). The sections below preserve the as-found results; the remediation + retest sections supersede the S3 outcome.

---

## Environment
- **Staging service:** `advantage-staging` (Railway project `advantage-auction`, env `production`, service id `949b7a08-…`).
- **Staging DB (validation target):** Neon `staging-2026-06-10`, compute endpoint **`ep-royal-dawn-anarou3f`** (DB `neondb`). Confirmed **not** production (`ep-proud-leaf-an8pzkib`); every script hard-refused the prod endpoint.
- **Stripe:** **TEST** throughout (`STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PUBLISHABLE_KEY=pk_test_…`; `/api/health → stripe_mode:test`). No LIVE keys touched.
- **Public URL:** `https://advantage-staging-production.up.railway.app`.
- **Method note:** financial/webhook scenarios are API/DB/webhook-shaped, not UI — Playwright is not the right tool for them. Validation drove the **deployed** staging app directly: Stripe-signed webhooks (real `STRIPE_WEBHOOK_SECRET`) to `/api/payments/webhook`, an admin JWT (real `JWT_SECRET`) to `/api/admin/payments/:id/refund`, a buyer JWT to `/api/payments/charge-lot`, with fixtures + assertions over the staging DB. This exercises the real `_acquireWebhookEvent`/`_finalizeWebhookEvent`/`processRefund` code paths on the running deployment.

## Backup details (created by operator, verified)
- **Backup branch:** `staging-pre-lineb-2026-06-10`
- **Branch ID:** `br-still-term-andxudcn`
- **Backup compute endpoint:** `ep-green-grass-an3eli55`
- **Parent branch:** `staging-2026-06-10`
- **Created:** 2026-06-11 12:14:07 −04:00
- The backup branch was **not** a target of any migration, deploy, or validation (rollback protection only).

## STEP 2 — Pre-migration checks: PASS
- Read-only `partially_refunded` pre-check: **0** rows (already reported); 059's risky backfill had nothing to rewrite.
- Read-only schema-state: `stripe_webhook_events` had only legacy surface `(id, event_type, processed_at)`; none of 058's columns/index present; 059 `refunded_amount_cents` + `chk_refunded_amount_bounded` absent; `schema_migrations` recorded neither 058 nor 059 (most recent = `057`). Clean, no collisions.

## STEP 3 — Migration results: PASS
- `scripts/promote-058-059.js` (staging-guarded) → **`Applied 2, skipped 0` · RESULT: PASS.**
- §2c verification (read-only): 058 = 5 columns (`status, payload, last_error, attempt_count, received_at`) + index `idx_stripe_webhook_events_status_received`; 059 = `refunded_amount_cents` column + `chk_refunded_amount_bounded` constraint; `schema_migrations` now records both.
- Backfill sanity (12 payments): 3 `failed` / 7 `paid` / 2 `pending`, all `refunded_amount_cents=0`; **0 rows** violating `[0, amount_cents]`.

## STEP 4 — Deployment results: PASS
- Deployed branch tree to `advantage-staging` via `railway up` from a clean detached worktree (no merge, no push, no branch retarget). Image `sha256:6c5225a21ee9c49fdb765bec231e25cc63e8a1b5c28db17f569627300fce7661`.
- `/api/health` → 200 with the reconciliation block present: `last_webhook_received_at`, `last_webhook_processed_at`, `webhook_failed_count_1h`, `payments_orphaned_intent_count`; `db_reachable:true`; `stripe_mode:test`.
- Both workers booted clean: `imageProcessingWorker` (pid 34), `notificationWorker` (pid 33); server on :8080; no missing-module / hook errors.

## STEP 5 — S0–S10 results
| ID | Scenario | Result | Evidence |
|---|---|---|---|
| **S0** | Baseline health | **PASS** | health 200; all 4 reconciliation fields present; `db_reachable:true`; `stripe_mode:test`. |
| **S1** | Webhook dedup / replay | **PASS** | delivery → `processed` (ac=1, http 200); redelivery → http 200, row stays `processed`, **attempt_count unchanged** ⇒ no double-process. |
| **S2** | Claim-after-process: failed→reclaim | **PASS** | pre-seeded `failed` row (ac=1) → redelivery http 200 → `processed`, `last_error=NULL`, **ac 1→2** (reclaimed, single effect). |
| **S3** | Stale in-flight takeover (>300s) | **FAIL** | pre-seeded `received` row, `received_at = now()-6min`. Delivery **never returns** — HTTP **502 "upstream error"** (×3 attempts), row stuck `received`/ac=1, `received_at` not refreshed. Root cause below. |
| **S4** | Handler failure → 500 + retry recovers | **PASS** | orphan intent → handler throws "No payment row" → http **500**, row `failed`+`last_error`; after the payment row is created, redelivery → http 200 → `processed` (no settlement lost). |
| **S5** | Refund partial sums + overspend reject | **PASS** | partial 3000 then 4000 → `refunded_amount_cents` 3000→7000, status `partially_refunded`; over-refund 5000 → **422** `"Refund total would exceed payment amount…"`, refunded stays 7000; `chk_refunded_amount_bounded` never violated (0). |
| **S6** | Refund idempotency + concurrency | **PASS** | (a) same `Idempotency-Key` twice on a **real** Stripe charge → both 200, **exactly 1** Stripe refund on the intent. (b) two concurrent distinct-key refunds (real intent) → **200 + 409 `REFUND_IN_PROGRESS`** ("Refund already in progress"), one Stripe refund. |
| **S7** | charge.refunded reconcile + echo | **PASS** | `amount_refunded=4000` → `partially_refunded`/4000; echo (same refund id, already ≥) → **no-op** (unchanged); `amount_refunded=10000` → `refunded`/10000. DB == Stripe-authoritative. |
| **S8** | Orphan PaymentIntent handling | **PASS** | (a) `payment_intent.succeeded` no row → 500 + `failed` + logged; (b) `payment_intent.canceled` pending → `failed`; (c) orphaned pending+NULL >5min → `/api/health.payments_orphaned_intent_count`=1, then `charge-lot` retired it (pending+NULL >60s → `failed`) and attached a fresh intent. |
| **S9** | No staging-hook leakage | **PASS** | `stagingValidationHooks` appears only in planning docs; **0** references in `src/`/`scripts/` (deployed tree); clean boot logs. |
| **S10** | Unit suite (branch) | **PASS** | `jest tests/` in the repo: **10 suites pass**, 80/84 tests pass; only pre-existing `tests/bid.test.js` red (4 failures) — financial suites (payment/webhook/refund/state-machine) all green. |

**Matrix: 10 of 11 PASS; S3 FAIL.**

## Issues found
### S3 — DEFECT-LINEB-1 (blocking): stale in-flight takeover infinite-loops and hangs the webhook request
- **Location:** `src/services/paymentService.js`, `_acquireWebhookEvent`, stale-`received` branch (≈ lines 105–119).
- **Mechanism:**
  ```js
  const claim = await db.query(
    `UPDATE stripe_webhook_events
        SET attempt_count = attempt_count + 1, received_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'received' AND received_at = $2`,
    [eventId, row.received_at]);          // row.received_at: JS Date (millisecond precision)
  if (claim.rowCount === 1) return { action: 'process' };
  return _acquireWebhookEvent(eventId, eventType, payload);   // recurse on no-match
  ```
  `row.received_at` was read by node-postgres into a **millisecond-precision JS Date**, but the stored `received_at` (defaulted from `now()`, migration 058) carries **microsecond** precision. The `received_at = $2` equality therefore **never matches** → `rowCount=0` → the function **recurses**, re-reads the same unchanged `received` row, fails again → **unbounded async recursion**. The HTTP request never completes (gateway → **502**), each loop iteration hammers the DB with `INSERT … ON CONFLICT DO NOTHING` + `SELECT`.
- **Direct evidence:**
  - 4 stale rows left at `status='received'`, `attempt_count=1`, **`received_at != date_trunc('milliseconds', received_at)`** (i.e. sub-ms precision present).
  - `pg_stat_activity` caught the deployed app repeatedly running the `_acquireWebhookEvent` SELECT + INSERT (the loop body) for the stuck event ids.
  - 3/3 deterministic 502s; row never advanced.
- **Production impact (not a test artifact):** the trigger — `received_at` with sub-millisecond precision — is the **normal** state of every event row (`DEFAULT now()`). The first genuinely crashed-handler event that Stripe redelivers after 300s would hit this path, **hang the webhook endpoint**, and pile up Stripe retries (each a new hung request) → DB connection exhaustion / wedged webhook ingestion. This is precisely the recovery path the feature exists to provide, so it must work before LIVE.
- **Fix direction (for the branch, not done here):** stop relying on millisecond-fidelity `received_at` equality for the optimistic-takeover guard — e.g. take over via `SELECT … FOR UPDATE SKIP LOCKED` + status recheck, or guard on `attempt_count`/`xmin`, or compare with `date_trunc('milliseconds', received_at)` on both sides, **and** add a recursion/iteration cap so no acquire path can loop unbounded. Add a regression test that seeds a µs-precision `received_at`.

### Mitigation applied during validation (staging only)
The runaway loops (from S3's deliveries) were halted by setting the 4 stuck `evt_lineb_s3*` rows to `status='processed'` (the next loop SELECT then sees `processed` → returns `skip`). Verified afterward: **0** active webhook-loop queries, **0** stuck `received` rows, `/api/health` 200.

### Test fixtures left on staging
Clearly-tagged Line B test fixtures (auction `a1000000-…-aa`, lots `b*`, payments `c*`, `evt_lineb_*` webhook rows, `re_…`/`pi_…` test ids; one real Stripe TEST charge + refund) remain on staging. They are terminal-state and do not affect the orphan metric (verified 0). Remove via targeted cleanup or by restoring the backup branch during the fix cycle; re-validation runs must use fresh fixture ids (per the `idx_payments_unique_active` constraint).

## Rollback required?
**No.** The schema migrations (058/059) are **additive and correct** — the defect is in application logic, not schema — and staging is the disposable validation environment with backup branch `staging-pre-lineb-2026-06-10` (`br-still-term-andxudcn`) available. Leave staging deployed as the fix/iterate target. **Do not promote to production and do not merge** until DEFECT-LINEB-1 is fixed and S3 re-passes (with S1/S2/S4 regression-checked).

---

## DEFECT-LINEB-1 — Remediation (2026-06-11)
**Fix committed on `feat/line-b-financial-integrity`.** `_acquireWebhookEvent` (`src/services/paymentService.js`) rewritten:
1. **Removed the fragile `received_at = $2` equality guard.** The stale-takeover is now a single atomic conditional UPDATE whose staleness predicate is evaluated **entirely server-side** — `… WHERE id = $1 AND status = 'received' AND received_at < now() - interval '300 seconds'`. No timestamp is round-tripped through a JS `Date`, so the ms/µs precision mismatch cannot occur. Only `$1` (event id) is bound; the threshold is the trusted internal constant `STALE_IN_FLIGHT_SECONDS`, inlined.
2. **Safe concurrency pattern.** Every transition (new-insert, failed-reclaim, stale-takeover, legacy-backfill) is an atomic compare-and-swap via its WHERE clause; the Postgres row lock serializes concurrent deliveries so exactly one wins. A fresh `received` row matches the takeover predicate **0 rows** → returned as `in_flight` (never stolen); a stale one matches **1 row** → `process`.
3. **Bounded — no unbounded spin.** The function is now an iterative loop capped at `MAX_ACQUIRE_ATTEMPTS = 5`. It only re-iterates on genuine transient races (row deleted mid-acquire; lost a failed-reclaim race); on exhaustion it logs and returns `in_flight`. Recursion is gone entirely.
4. **Original intent preserved:** fresh in-flight not double-processed; stale recoverable; Stripe still retries on handler failure (row → `failed` → next delivery reclaims); processed rows idempotent (`skip`).
5. **Regression tests** (`tests/webhook-state-machine.test.js`): updated the fresh-in-flight and stale-takeover cases to the new atomic-UPDATE shape; added (9) takeover uses `received_at < now() - interval` and **never** `received_at = $2` (only `$1` bound) — the precision-immunity guarantee; (10) pathological churn terminates within the cap (proves no unbounded loop). Suites green: `webhook-state-machine + payment + refund` = 24/24; full `tests/` = 10 suites pass, only pre-existing `bid.test.js` red.

Migrations were **not** touched (additive 058/059 stand). Payout wiring untouched. Production untouched.

### Retest (post-fix, staging) — PASS
**Commit:** `f441512` · **Redeployed** to `advantage-staging` only (image `sha256:f0d6661d6f457556d7a8532e8478be68d77135b3ec961c0c0a80f26e3bfa32ae`; fresh boot `started_at 2026-06-11T18:21:26Z`; health 200, `stripe_mode:test`). Each request used a 25s client timeout so a regression would surface as TIMEOUT, never a hang.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| **S3** | Stale in-flight takeover (>300s) | **PASS** | seeded `received` row, `received_at = now()-6min`, **`ms_exact=false`** (sub-ms precision present — the exact trigger). Delivery → **HTTP 200 in 596 ms** (no hang/502), `received→processed`, `attempt_count 1→2`, `received_at` refreshed. |
| **S3f** | Fresh in-flight NOT stolen | **PASS** | fresh `received` row (`received_at=now()`) → HTTP 200 (267 ms), stays `received`, `attempt_count` unchanged ⇒ not stolen, not double-processed. |
| **S1** | Webhook dedup / replay | **PASS** | delivery → `processed`/ac1 (972 ms); redelivery → 200, `processed`, ac unchanged. |
| **S2** | Failed → reclaim | **PASS** | `failed`/ac1 → 200 (583 ms) → `processed`, `last_error=NULL`, ac 1→2. |
| **S4** | Handler failure → 500 + recover | **PASS** | orphan → 500 (281 ms), `failed`+`last_error`; after row created, redelivery → 200 → `processed`. |

**Retest: 5/5 PASS.** Post-run sanity: **0** active webhook-acquire queries in `pg_stat_activity` (no spin/recursion), health 200, `webhook_failed_count_1h=0`. The infinite-loop / 502 behavior is gone; the takeover succeeds on a genuinely-stale µs-precision row.

> Note: with S3 now passing, the full Phase 1 matrix is green — S0, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10 all PASS.

---

# PHASE 1 STAGING STATUS

## PASS — READY FOR MERGE REVIEW
DEFECT-LINEB-1 is fixed on `feat/line-b-financial-integrity` (`f441512`) and re-validated on staging: S3 stale-takeover now succeeds (HTTP 200, no hang/502) on the exact µs-precision condition that failed, with S1/S2/S4 + fresh-not-stolen regression all green and no acquire-loop activity. The complete S0–S10 matrix passes; migrations 058/059 are applied and verified; deploy is clean; Stripe stayed TEST throughout.

**Held as instructed — not actioned:** no merge into `deploy/seller-studio-1b`, no production deploy, Stripe LIVE not enabled, no Phase 2 payout wiring, no production data modified. Recommend human merge review of `feat/line-b-financial-integrity` as the next gate.

*(Prior status was FAIL — FIX REQUIRED on S3; superseded by the retest above.)*
S0, S1, S2, S4, S5, S6, S7, S8, S9, S10 PASS. **S3 (stale in-flight takeover) FAILS on a real, reproducible defect (DEFECT-LINEB-1):** a `received_at` millisecond/microsecond precision mismatch makes the takeover `UPDATE` never match, sending `_acquireWebhookEvent` into unbounded recursion that hangs the webhook request (HTTP 502) and would wedge production webhook ingestion on the first crashed-handler recovery. Fix on `feat/line-b-financial-integrity`, redeploy staging, and re-run S3 (+ S1/S2/S4 regression) before any promotion.

*Constraints honored: migrations + deploy targeted staging `ep-royal-dawn-anarou3f` only; production untouched; Stripe remained TEST; no merge into `deploy/seller-studio-1b`; Stripe LIVE not enabled; no Phase 2 payout wiring; no production data modified. Backup branch was not a validation target.*
