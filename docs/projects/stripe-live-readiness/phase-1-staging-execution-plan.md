# Phase 1 — Staging Validation Execution Plan (Line B Financial Integrity)
**Type:** execution plan (planning only — nothing run). **Date:** 2026-06-10.
**Branch under test:** `feat/line-b-financial-integrity` (commits `f3fbba9`, `470c544`; docs `812db18`).
**Target:** staging service `advantage-staging`, Neon endpoint **`ep-royal-dawn-anarou3f`**, Stripe **TEST**.
**Migrations under test:** `058_extend_stripe_webhook_events.sql`, `059_add_payments_refunded_amount.sql` (additive; **migrations BEFORE code**).

> Important note on test method: the synthetic injectors (`stagingValidationHooks`) were **removed** during reconciliation for production safety. Crash-window / claim-after-process scenarios are therefore validated by **DB-state manipulation + webhook redelivery** (exercising the real `_acquireWebhookEvent`/`_finalizeWebhookEvent` transitions), **not** by code-level fault injection. Thresholds from the reconciled code: `STALE_IN_FLIGHT_SECONDS = 300`; stale-orphan pending retirement at `payment_intent_id IS NULL AND created_at < now()-60s`; orphan health metric at `… < now()-5min`.

---

## 1. Staging database backup procedure
No Neon CLI installed → **Neon Console** is primary.
1. Neon Console → project (endpoint `ep-royal-dawn-anarou3f`) → **Branches** → **New Branch** → parent = the current staging branch, **from current point (head/now)** → name `staging-pre-lineb-2026-06-10` → Create. **Record the restore timestamp.**
2. (API alternative) `curl -X POST "https://console.neon.tech/api/v2/projects/<PROJECT_ID>/branches" -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" -d '{"branch":{"name":"staging-pre-lineb-2026-06-10","parent_id":"<STAGING_BRANCH_ID>"}}'`
3. **Pre-migration data snapshot** (evidence + the 059 backfill caveat): record counts before touching anything —
   ```sql
   SELECT count(*) FROM stripe_webhook_events;
   SELECT count(*) FROM payments;
   SELECT count(*) AS partially_refunded FROM payments WHERE status='partially_refunded';   -- MUST review if > 0
   SELECT count(*) AS already_refunded   FROM payments WHERE status='refunded';
   ```
   If `partially_refunded > 0`: document those rows; `059`'s backfill marks them **fully** refunded → plan a Stripe `amount_refunded` reconciliation per `docs/sop-refunds.md` before applying.

## 2. Migration execution order
Author a **staging-guarded** apply script `scripts/promote-058-059.js` (model on `scripts/promote-046-057.js`): refuse unless `DATABASE_URL` contains `ep-royal-dawn-anarou3f`; use the **direct** endpoint (`raw.replace('-pooler','')`); apply **058 then 059**; fail-fast; record each in `schema_migrations`.
```bash
# 2a. Pre-check (gate on partially_refunded — see §1.3)
# 2b. Apply (058 then 059), BEFORE any code deploy:
railway run --service advantage-staging --environment production node scripts/promote-058-059.js   # expect: Applied 2, skipped 0
```
**2c. Verify schema (read-only):**
```sql
-- 058
SELECT column_name FROM information_schema.columns
 WHERE table_name='stripe_webhook_events'
   AND column_name IN ('status','payload','last_error','attempt_count','received_at');   -- expect 5
SELECT indexname FROM pg_indexes WHERE indexname='idx_stripe_webhook_events_status_received';  -- expect 1
-- 059
SELECT column_name FROM information_schema.columns
 WHERE table_name='payments' AND column_name='refunded_amount_cents';                     -- expect 1
SELECT conname FROM pg_constraint WHERE conname='chk_refunded_amount_bounded';            -- expect 1
-- backfill sanity
SELECT status, count(*), min(refunded_amount_cents), max(refunded_amount_cents)
  FROM payments GROUP BY status;
```
**Gate:** all four object checks return the expected counts before deploying code.

## 3. Deployment procedure
The feature branch is **not** the staging-tracked branch (`deploy/seller-studio-1b`), and we must **not** merge or push it. Deploy the working tree directly:
1. Create a clean checkout/worktree of the branch (avoids shipping unrelated untracked files):
   `git worktree add ../aap-staging-deploy feat/line-b-financial-integrity`
2. From that worktree: `railway up --service advantage-staging --environment production` (uploads the branch tree as the deploy source — no merge, no push, no branch retarget).
3. Watch deploy → **SUCCESS**; confirm both workers (`notificationWorker`, `imageProcessingWorker`) boot.
4. `GET https://<staging-domain>/api/health` → 200 with the **reconciliation block** present: `last_webhook_received_at`, `last_webhook_processed_at`, `webhook_failed_count_1h`, `payments_orphaned_intent_count`.
5. Remove the worktree after validation: `git worktree remove ../aap-staging-deploy`.
> Alternative (heavier): temporarily set `advantage-staging`'s deploy branch to `feat/line-b-financial-integrity` in Railway, push the branch, auto-deploy, then revert — only if `railway up` is unavailable. (Requires a push; avoid unless necessary.)

## 4. Validation sequence (Stripe TEST)
**Tooling:** Stripe CLI (`stripe login`; `stripe listen --forward-to https://<staging>/api/payments/webhook`; `stripe trigger …`), an **admin JWT** for the refund endpoint, `psql`/read-only scripts against `ep-royal-dawn-anarou3f`, and `/api/health`. Use **controlled** buyer/seller fixtures and test cards only.

| ID | Scenario (outcome) | Exact trigger | Verify |
|---|---|---|---|
| **S0** | Baseline health (9) | `GET /api/health` | reconciliation fields present, `db_reachable:true`, `stripe_mode:test` |
| **S1** | Webhook dedup / replay (C/D) | `stripe trigger payment_intent.succeeded` (with a fixture payment row matching the intent); redeliver same event id from Stripe dashboard | first delivery → `stripe_webhook_events.status='processed'`; redelivery → skipped (no double effect); `attempt_count` unchanged or as designed |
| **S2** | Claim-after-process — failed→reclaim (1/2/E) | After a processed event, `UPDATE stripe_webhook_events SET status='failed', last_error='manual-test' WHERE id=<evt>`; redeliver that event | row reacquired → reprocessed → `status='processed'`, `last_error=NULL`; payment effect correct; **no lost settlement** |
| **S3** | Stale in-flight takeover (1/2) | `UPDATE stripe_webhook_events SET status='received', received_at = now() - interval '6 minutes' WHERE id=<evt>` (>300s); redeliver | takeover path runs (`attempt_count++`, `received_at` refreshed) → `status='processed'` |
| **S4** | Webhook handler failure → 500 retry (E) | Deliver `payment_intent.succeeded` whose handler raises (e.g., transiently break a dependency, or target a row that forces an error path) | route returns **500**; `status='failed'`+`last_error`; Stripe retries; later delivery reprocesses to `processed` |
| **S5** | Refund full + partial accounting (4/7) | Admin `POST /api/admin/payments/:id/refund` with `Idempotency-Key` and `refund_amount_cents` < amount; then another partial; then an over-amount | partials **sum** in `refunded_amount_cents`; over-refund → error **“Refund total would exceed”**; `chk_refunded_amount_bounded` never violated |
| **S6** | Refund idempotency (6) | Repeat S5's exact call with the **same** `Idempotency-Key`; and fire two concurrent refunds | same key → **one** Stripe refund (idempotent); concurrent → one succeeds, other → **`REFUND_IN_PROGRESS` 409** |
| **S7** | charge.refunded reconcile (5) | `stripe trigger charge.refunded` (or refund in Stripe dashboard) for a paid payment | `_handleChargeRefunded` sets DB to Stripe-authoritative `amount_refunded`; echo of our own refund = no-op; `refunded_amount_cents` matches Stripe |
| **S8** | Orphan PaymentIntent (3) | (a) `payment_intent.succeeded` with **no** matching DB row → reconcile path; (b) `payment_intent.canceled` for a pending row; (c) leave a `pending`+`intent_id NULL` payment >5min | (a) reconciled/logged per design; (b) row → `status='failed'`; (c) `/api/health.payments_orphaned_intent_count` ≥ 1; a subsequent `createPaymentIntent` retires pending+NULL rows older than 60s |
| **S9** | No staging-hook leakage | `grep -rn stagingValidationHooks` in the deployed tree; app boot logs | empty; app boots with no missing-module error |
| **S10** | Unit suite | `npx jest tests/` on the branch | 3 financial suites pass; only pre-existing `bid.test.js` red |

## 5. Rollback sequence (staging only)
1. **Code:** Railway → `advantage-staging` → Deployments → redeploy the prior `deploy/seller-studio-1b` deployment (or `railway up` from a `deploy/seller-studio-1b` checkout).
2. **Migrations (additive; drop CONSTRAINT before COLUMN):**
   ```sql
   -- 059
   ALTER TABLE payments DROP CONSTRAINT IF EXISTS chk_refunded_amount_bounded;
   ALTER TABLE payments DROP COLUMN IF EXISTS refunded_amount_cents;
   -- 058
   DROP INDEX IF EXISTS idx_stripe_webhook_events_status_received;
   ALTER TABLE stripe_webhook_events
     DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS payload,
     DROP COLUMN IF EXISTS last_error, DROP COLUMN IF EXISTS attempt_count,
     DROP COLUMN IF EXISTS received_at;
   ```
   Also remove the `058`/`059` rows from `schema_migrations` if dropping, so a later apply re-runs cleanly.
3. **Deepest:** restore Neon branch `staging-pre-lineb-2026-06-10` (or PITR to the §1 timestamp).
4. **Caveat:** `059`'s backfill (partially_refunded → fully refunded) is **not auto-reversible** — restore from the backup branch if true partial state matters. Old code tolerates the additive columns, so usually only a **code** rollback is needed.

## 6. Pass/Fail criteria
| ID | PASS | FAIL |
|---|---|---|
| S0 | health 200; all 4 reconciliation fields present | missing fields / 500 |
| S1 | exactly one effect; redelivery skipped; row `processed` | double effect or row stuck `received` |
| S2 | failed row reacquired → `processed`, effect applied once | row stays `failed`; effect lost or duplicated |
| S3 | stale row taken over → `processed`; `attempt_count` incremented | stuck `received`; no takeover |
| S4 | 500 returned; row `failed`+`last_error`; later delivery → `processed` | 200 swallow; event lost; no retry |
| S5 | partials sum; over-refund rejected with exact message; constraint intact | over-refund allowed; sum wrong; constraint violation |
| S6 | one Stripe refund per key; concurrent → one 409 | duplicate Stripe refund; both succeed |
| S7 | DB == Stripe `amount_refunded`; self-echo no-op | DB diverges from Stripe; double-count |
| S8 | (a) reconciled, (b) `failed`, (c) metric ≥1 + retirement works | orphan unhandled; pending never retired; metric null/0 |
| S9 | no hook refs; clean boot | any `stagingValidationHooks` reference / boot error |
| S10 | 3 new suites green | any new-suite failure |
**Overall gate:** S0–S10 all PASS → reconciliation validated; proceed (in a later phase) to production promotion. Any FAIL → fix on the branch, re-run.

## 7. Expected evidence to collect
- **Backup:** Neon branch name + restore timestamp; pre-migration counts (§1.3).
- **Migration:** `promote-058-059.js` output (`Applied 2`), the §2c schema-verification query outputs.
- **Deploy:** Railway deployment id + commit + SUCCESS; `/api/health` JSON (reconciliation block).
- **Per scenario:** the Stripe **event id** / **refund id**; the relevant `stripe_webhook_events` row (`id,status,attempt_count,last_error,received_at,processed_at`) and `payments` row (`status,amount_cents,refunded_amount_cents,payment_intent_id`) **before/after**; app log lines (`[webhook] …`, `[refund] …`); HTTP status codes (200/409/500); `/api/health.payments_orphaned_intent_count` readings.
- **Suite:** `jest` summary (suites/tests pass-fail).
- **Hook check:** `grep` output (empty).
- Store all under a dated validation log (e.g., `docs/projects/stripe-live-readiness/phase-1-staging-evidence-2026-06-10.md`).

---

## Constraints / stop
This is **planning only** — no code change, no deploy, no migration execution, no commit. Execution is gated on your go-ahead and must use only owner-controlled fixtures + Stripe TEST. Do **not** proceed to Phase 2 (payout wiring) until S0–S10 pass on staging.

*References: branch `feat/line-b-financial-integrity`, `db/migrations/058`,`059`, `phase-1-implementation-checklist.md`, `phase-1-reconciliation-report.md`, `scripts/promote-046-057.js` (script model), `docs/sop-refunds.md`.*
